import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

/**
 * How an author is presented: the avatar beside their comments, and the name
 * shown next to it.
 *
 * `CommentAuthorInformation.iconPath` takes a `Uri` and nothing else — no theme
 * icons — so a generated avatar has to be a real file. These are initials on a
 * colour derived from the name, enough to make each comment in a thread read as
 * its own block rather than more of the previous one.
 */
export class Identities {
  private readonly cache = new Map<string, vscode.Uri | undefined>();
  private readonly dir: string;
  /** GitHub login of the account signed in to VS Code, if any. */
  private signedIn: string | undefined;
  /** lowercased login -> what GitHub knows about that account, cached on disk. */
  private profiles: Record<string, GitHubProfile> = {};
  private readonly pending = new Set<string>();
  /** login -> when a failed lookup may be retried. */
  private readonly retryAfter = new Map<string, number>();

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  /** Fires when a profile name arrives and rendered names are now stale. */
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(storage: vscode.Uri) {
    this.dir = path.join(storage.fsPath, 'avatars');
    try {
      const raw = JSON.parse(fs.readFileSync(this.profilesFile, 'utf8')) as Record<string, unknown>;
      for (const [key, value] of Object.entries(raw)) {
        // Tolerate the 0.7.x cache, which stored just the profile name.
        this.profiles[key] =
          typeof value === 'string' ? { login: key, name: value } : (value as GitHubProfile);
      }
    } catch {
      this.profiles = {};
    }
  }

  private get profilesFile(): string {
    return path.join(this.dir, 'profiles.json');
  }

  /**
   * The name to show beside a comment: the GitHub profile name once we have it,
   * otherwise the author recorded on the comment. This never changes what is
   * stored — the author field stays the identity everything else keys off.
   */
  displayName(author: string): string {
    const mode = vscode.workspace
      .getConfiguration('localReview')
      .get<string>('authorName', 'github-login');
    if (mode === 'recorded') {
      return author;
    }
    const login = this.githubLogin(author);
    if (!login) {
      return author;
    }
    const profile = this.profiles[login.toLowerCase()];
    if (!profile) {
      void this.fetchProfile(login);
      return author;
    }
    return mode === 'github-name' ? profile.name || profile.login : profile.login;
  }

  private async fetchProfile(login: string): Promise<void> {
    const key = login.toLowerCase();
    if (this.pending.has(key) || this.profiles[key] !== undefined) {
      return;
    }
    const retry = this.retryAfter.get(key);
    if (retry !== undefined && Date.now() < retry) {
      return;
    }
    this.pending.add(key);
    try {
      const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
        headers: {
          'User-Agent': 'vscode-local-change-review',
          Accept: 'application/vnd.github+json',
        },
      });
      if (response.status === 404) {
        // The account does not exist — a typo in `githubUsers`, or a renamed
        // user. Cache it: retrying achieves nothing and burns the rate limit.
        this.profiles[key] = { login };
        this.persist();
        this.onDidChangeEmitter.fire();
        return;
      }
      if (!response.ok) {
        // Rate limited or a server error: back off rather than hammering, which
        // is what exhausts the remaining budget and breaks the valid logins too.
        this.retryAfter.set(key, Date.now() + 15 * 60_000);
        return;
      }
      const body = (await response.json()) as { login?: string; name?: string | null };
      // Recorded even when the account has no display name set, so it is not
      // re-fetched on every render. `login` comes from the API so its casing is
      // whatever GitHub considers canonical.
      this.profiles[key] = { login: body.login?.trim() || login, name: body.name?.trim() || undefined };
      this.persist();
      this.onDidChangeEmitter.fire();
    } catch {
      // Offline: keep showing the stored author, and stop asking for a while.
      this.retryAfter.set(key, Date.now() + 5 * 60_000);
    } finally {
      this.pending.delete(key);
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(this.profilesFile, JSON.stringify(this.profiles, null, 2), 'utf8');
    } catch {
      // the cache is an optimisation; losing it is harmless
    }
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  /** Resolves the signed-in GitHub account silently. True if it changed. */
  async resolveGitHubAccount(): Promise<boolean> {
    const login = await readGitHubAccount();
    if (login === this.signedIn) {
      return false;
    }
    this.signedIn = login;
    this.cache.clear();
    if (login) {
      // Pull the profile now: the author recorded on a comment is a git
      // user.name, which is as often the profile name ("Yannick Combes") as the
      // login ("shiranuit"). Knowing both lets either one match.
      void this.fetchProfile(login);
    }
    return true;
  }

  invalidate(): void {
    this.cache.clear();
  }

  /** For the diagnostics command: why an author resolved the way it did. */
  describe(): Record<string, unknown> {
    const config = vscode.workspace.getConfiguration('localReview');
    return {
      avatars: config.get('avatars'),
      authorName: config.get('authorName'),
      signedInGitHubAccount: this.signedIn ?? null,
      githubUsers: config.get('githubUsers'),
      knownProfiles: this.profiles,
    };
  }

  forAuthor(author: string): vscode.Uri | undefined {
    const mode = vscode.workspace.getConfiguration('localReview').get<string>('avatars', 'initials');
    if (mode === 'none') {
      return undefined;
    }
    const key = `${mode}:${author}`;
    if (!this.cache.has(key)) {
      const login = mode === 'github' ? this.githubLogin(author) : undefined;
      this.cache.set(
        key,
        login
          ? vscode.Uri.parse(`https://github.com/${encodeURIComponent(login)}.png?size=80`)
          : this.generate(author),
      );
    }
    return this.cache.get(key);
  }

  /**
   * Only returns a login we actually know — an explicit mapping, or the account
   * signed in to VS Code. Guessing would point at a URL that 404s, and a broken
   * image is worse than initials.
   */
  private githubLogin(author: string): string | undefined {
    const configured = vscode.workspace
      .getConfiguration('localReview')
      .get<Record<string, string>>('githubUsers', {});
    for (const [name, login] of Object.entries(configured)) {
      if (name.toLowerCase() === author.toLowerCase() && login.trim()) {
        return login.trim();
      }
    }
    if (!this.signedIn) {
      return undefined;
    }
    const wanted = author.trim().toLowerCase();
    const profile = this.profiles[this.signedIn.toLowerCase()];
    const matches =
      wanted === this.signedIn.toLowerCase() ||
      wanted === profile?.login.trim().toLowerCase() ||
      wanted === profile?.name?.trim().toLowerCase();
    return matches ? this.signedIn : undefined;
  }

  private generate(author: string): vscode.Uri | undefined {
    const content = svg(author);
    // The filename carries a hash of the SVG itself, so changing how avatars are
    // drawn yields a new path. Keying only on the author would keep serving the
    // file written by an older version — and would also risk VS Code reusing the
    // image it already loaded for that unchanged URI.
    const owner = hash(author).toString(36);
    const file = path.join(this.dir, `${owner}-${hash(content).toString(36)}.svg`);
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.writeFileSync(file, content, 'utf8');
        this.prune(owner, path.basename(file));
      }
      return vscode.Uri.file(file);
    } catch {
      return undefined; // no avatar is better than a broken comment widget
    }
  }

  /** Drops avatars this author had under an earlier design. */
  private prune(owner: string, keep: string): void {
    // Matched exactly rather than by prefix: one author's hash can be a prefix of
    // another's, and deleting someone else's avatar would be worse than leaving a
    // stale file behind.
    const mine = new RegExp(`^${owner}(-[a-z0-9]+)?\\.svg$`);
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (name !== keep && mine.test(name)) {
          fs.unlinkSync(path.join(this.dir, name));
        }
      }
    } catch {
      // leftovers are harmless
    }
  }
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h = Math.imul(h ^ value.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

function initials(author: string): string {
  const words = author.split(/[\s._@-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

function svg(author: string): string {
  const hue = hash(author) % 360;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">',
    // Square, not a circle: VS Code renders an avatar image as-is, and a
    // GitHub profile picture is a square PNG. A round fallback beside square
    // photos just looks like two different systems.
    `<rect width="40" height="40" fill="hsl(${hue} 48% 42%)"/>`,
    '<text x="20" y="21" text-anchor="middle" dominant-baseline="central" fill="#fff"',
    ' font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="16" font-weight="600">',
    escapeXml(initials(author)),
    '</text></svg>',
  ].join('');
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

interface GitHubProfile {
  /** Canonical login as GitHub spells it. */
  login: string;
  /** Display name, absent when the account has not set one. */
  name?: string;
}

/**
 * The signed-in GitHub account, without asking for anything.
 *
 * `getAccounts` is the right call here: `getSession` matches on scopes, so an
 * empty scope list finds nothing even when the user is plainly signed in — the
 * existing session belongs to whichever scopes another extension asked for. We
 * only want the account label, never a token, so no scopes are needed at all.
 */
async function readGitHubAccount(): Promise<string | undefined> {
  try {
    const accounts = await vscode.authentication.getAccounts('github');
    if (accounts.length > 0) {
      return accounts[0].label;
    }
  } catch {
    // provider unavailable
  }
  for (const scopes of [['read:user'], []]) {
    try {
      const session = await vscode.authentication.getSession('github', scopes, {
        createIfNone: false,
      });
      if (session) {
        return session.account.label;
      }
    } catch {
      // no session for these scopes
    }
  }
  return undefined;
}
