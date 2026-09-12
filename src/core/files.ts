import * as fs from 'fs';
import * as path from 'path';

import { newId } from './ids';
import { withLock } from './lock';
import {
  INDEX_FORMAT_VERSION,
  SESSION_FORMAT_VERSION,
  type ReviewCommentData,
  type ReviewIndexData,
  type ReviewSessionData,
  type ReviewThreadData,
} from './types';

export const INDEX_FILE = 'index.json';
export const SESSIONS_DIR = 'sessions';
const LOCK_FILE = '.lock';

export interface StoreState {
  index: ReviewIndexData;
  sessions: Map<string, ReviewSessionData>;
  /** Where each session was loaded from — a session is written back to the file
   *  it came from, never to a path derived from its id. */
  sources: Map<string, string>;
  /** Sessions that must not be rewritten, because doing so would lose data. */
  readOnly: Map<string, ReadOnlyReason>;
}

export interface ReadOnlyReason {
  reason: string;
  /** Two files claim this id. Unlike a session we merely cannot represent, this
   *  one must not be deleted either: unlinking the file we loaded leaves the
   *  other on disk, so the delete silently resurrects different content. */
  duplicate: boolean;
}

export interface TransactionResult<T> {
  result: T;
  state: StoreState;
  /** Absolute path -> content, for suppressing our own file-watcher echo. */
  written: Map<string, string>;
  removed: string[];
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  // Windows can transiently refuse the replace while a scanner or editor holds
  // the target open; POSIX never does.
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* best effort */
        }
        throw err;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
    }
  }
}

/**
 * Owns the on-disk review format. Every write goes through `transaction`, which
 * takes an exclusive lock, re-reads from disk, applies the mutation to *that*
 * state and writes back only what changed — so a second writer (the editor, an
 * MCP server) can never be clobbered by a stale in-memory snapshot.
 */
export class ReviewFiles {
  constructor(readonly root: string) {}

  get lockPath(): string {
    return path.join(this.root, LOCK_FILE);
  }

  get indexPath(): string {
    return path.join(this.root, INDEX_FILE);
  }

  sessionPath(id: string): string {
    return path.join(this.root, SESSIONS_DIR, `${id}.json`);
  }

  read(): StoreState {
    return { index: this.readIndex(), ...this.readSessions() };
  }

  private readIndex(): ReviewIndexData {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as ReviewIndexData;
      // Unknown keys are carried through, as they are for sessions: a file
      // written by a newer version must survive a round trip through this one.
      // Its version is kept for the same reason — stamping ours over a higher
      // one would tell the writer that wrote it that we understood the format.
      const version =
        typeof raw.version === 'number' && raw.version > INDEX_FORMAT_VERSION
          ? raw.version
          : INDEX_FORMAT_VERSION;
      return { ...raw, version, activeSessionId: raw.activeSessionId };
    } catch {
      return { version: INDEX_FORMAT_VERSION };
    }
  }

  private readSessions(): Omit<StoreState, 'index'> {
    const sessions = new Map<string, ReviewSessionData>();
    const sources = new Map<string, string>();
    const readOnly = new Map<string, ReadOnlyReason>();

    const dir = path.join(this.root, SESSIONS_DIR);
    for (const name of readJsonFiles(dir)) {
      const file = path.join(dir, name);
      let raw: Partial<ReviewSessionData>;
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ReviewSessionData>;
      } catch {
        continue; // leave a malformed file alone rather than overwriting someone's data
      }
      const { session, lossless } = normalizeSession(raw, name.replace(/\.json$/, ''));
      if (sessions.has(session.id)) {
        // Two files claim one id — a copied session, say. Writing either would
        // silently destroy whichever we did not load, so write neither.
        readOnly.set(session.id, {
          reason: `also claimed by ${path.basename(sources.get(session.id) ?? '?')} and ${name}`,
          duplicate: true,
        });
        continue;
      }
      sessions.set(session.id, session);
      sources.set(session.id, file);
      if (!lossless) {
        readOnly.set(session.id, {
          reason: `${name} contains entries this version cannot represent`,
          duplicate: false,
        });
      }
    }
    return { sessions, sources, readOnly };
  }

  transaction<T>(mutate: (state: StoreState) => T): TransactionResult<T> {
    if (!fs.existsSync(this.root)) {
      // Nothing stored here yet. Run against an empty state and, if the mutation
      // turns out to want nothing written, create no folder and take no lock —
      // otherwise merely listing sessions would litter every repository the
      // server is pointed at, which a global install does constantly.
      const empty: StoreState = {
        index: { version: INDEX_FORMAT_VERSION },
        sessions: new Map<string, ReviewSessionData>(),
        sources: new Map<string, string>(),
        readOnly: new Map<string, ReadOnlyReason>(),
      };
      const before = serialize(empty.index);
      const result = mutate(empty);
      if (empty.sessions.size === 0 && serialize(empty.index) === before) {
        return { result, state: empty, written: new Map(), removed: [] };
      }
      // It wants to write, so set the store up and do it again properly under
      // the lock. Mutations are pure functions of the state they are handed.
    }
    fs.mkdirSync(path.join(this.root, SESSIONS_DIR), { recursive: true });
    return withLock(this.lockPath, () => {
      const state = this.read();
      const before = new Map<string, string>();
      for (const [id, session] of state.sessions) {
        before.set(id, serialize(session));
      }
      const beforeIndex = serialize(state.index);

      const result = mutate(state);

      // Planned in full before a single byte is written. Refusing half way
      // through left the caller believing nothing had happened while some of
      // the mutation was already on disk — and left the watcher-echo map blind
      // to files we had just written.
      const changed: Array<[string, string]> = [];
      for (const [id, session] of state.sessions) {
        session.threads.sort(compareThreads);
        const content = serialize(session);
        if (before.get(id) !== content) {
          const blocked = state.readOnly.get(id);
          if (blocked) {
            throw new Error(`Local Review: refusing to write session ${id} — ${blocked.reason}`);
          }
          changed.push([id, content]);
        }
      }
      const gone = [...before.keys()].filter((id) => !state.sessions.has(id));
      for (const id of gone) {
        const blocked = state.readOnly.get(id);
        if (blocked?.duplicate) {
          throw new Error(`Local Review: refusing to delete session ${id} — ${blocked.reason}`);
        }
      }

      // Nothing below throws for a reason the caller could have avoided.
      const written = new Map<string, string>();
      const removed: string[] = [];
      for (const [id, content] of changed) {
        // Written back to the file it was read from, so a session whose filename
        // differs from its id is updated in place rather than duplicated.
        const file = state.sources.get(id) ?? this.sessionPath(id);
        atomicWrite(file, content);
        state.sources.set(id, file);
        written.set(file, content);
      }
      for (const id of gone) {
        const file = state.sources.get(id) ?? this.sessionPath(id);
        try {
          fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
        removed.push(file);
      }
      const indexContent = serialize(state.index);
      if (indexContent !== beforeIndex) {
        atomicWrite(this.indexPath, indexContent);
        written.set(this.indexPath, indexContent);
      }
      return { result, state, written, removed };
    });
  }
}

/** Only `.json` files: a leftover `.tmp` must not look like a populated store. */
function readJsonFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function compareThreads(a: ReviewThreadData, b: ReviewThreadData): number {
  return (
    a.path.localeCompare(b.path) || a.startLine - b.startLine || a.createdAt.localeCompare(b.createdAt)
  );
}

const EPOCH = new Date(0).toISOString();

export interface NormalizedSession {
  session: ReviewSessionData;
  /** False when anything could not be kept as written, so the file must not be
   *  rewritten. Dropping an entry is only one way to lose data: coercing an
   *  unrecognised status to `open`, or reading `comments` written as an object
   *  as an empty array, destroys just as much and used to pass as lossless. */
  lossless: boolean;
}

/**
 * Repairs a hand-edited session so one bad field never breaks the view.
 *
 * Unknown keys are carried through rather than stripped — a file written by a
 * newer version must survive a round trip through an older one. Entries that
 * cannot be repaired are reported, and the caller refuses to write that session
 * rather than committing the loss.
 */
export function normalizeSession(
  raw: Partial<ReviewSessionData>,
  fallbackId: string,
): NormalizedSession {
  let lossless = true;
  /** A field that is present but of a shape or value we cannot keep is a loss. */
  const keep = (present: boolean, ok: boolean): void => {
    if (present && !ok) {
      lossless = false;
    }
  };

  keep(raw.threads !== undefined, Array.isArray(raw.threads));
  keep(raw.status !== undefined, raw.status === 'open' || raw.status === 'closed');
  const rawThreads = Array.isArray(raw.threads) ? raw.threads : [];
  const threads = rawThreads.filter((t): t is ReviewThreadData => Boolean(t && t.path));
  if (threads.length !== rawThreads.length) {
    lossless = false;
  }
  const session: ReviewSessionData = {
    ...raw,
    version: raw.version ?? SESSION_FORMAT_VERSION,
    id: raw.id || fallbackId,
    name: raw.name || fallbackId,
    status: raw.status === 'closed' ? 'closed' : 'open',
    createdAt: raw.createdAt || EPOCH,
    closedAt: raw.closedAt,
    base: raw.base,
    threads: threads
      .map((t): ReviewThreadData => {
        keep(t.status !== undefined, t.status === 'open' || t.status === 'resolved');
        keep(t.outdated !== undefined, typeof t.outdated === 'boolean');
        keep(t.snippet !== undefined, Array.isArray(t.snippet));
        keep(t.comments !== undefined, Array.isArray(t.comments));
        keep(t.startLine !== undefined, Number.isFinite(Number(t.startLine)));
        keep(t.endLine !== undefined, Number.isFinite(Number(t.endLine)));
        return {
          ...t,
          id: t.id || newId('thread'),
          path: t.path,
          startLine: Math.max(1, Number(t.startLine) || 1),
          endLine: Math.max(1, Number(t.endLine) || Number(t.startLine) || 1),
          snippet: Array.isArray(t.snippet) ? t.snippet : [],
          languageId: t.languageId,
          status: t.status === 'resolved' ? 'resolved' : 'open',
          outdated: t.outdated === true ? true : undefined,
          createdAt: t.createdAt || EPOCH,
          updatedAt: t.updatedAt || t.createdAt || EPOCH,
          comments: keptComments(t, () => {
            lossless = false;
          }).map((c): ReviewCommentData => {
            keep(c.agent !== undefined, typeof c.agent === 'boolean');
            return {
              ...c,
                id: c.id || newId('comment'),
                author: c.author || 'unknown',
                // Preserved as written: an absent flag means "unknown", and
                // defaulting it to false would relabel an agent's old comments
                // as a person's.
              agent: typeof c.agent === 'boolean' ? c.agent : undefined,
              body: c.body,
              createdAt: c.createdAt || EPOCH,
              updatedAt: c.updatedAt,
            };
          }),
        };
      })
      .sort(compareThreads),
  };
  return { session, lossless };
}

function keptComments(
  thread: ReviewThreadData,
  onLoss: () => void,
): ReviewCommentData[] {
  const raw = Array.isArray(thread.comments) ? thread.comments : [];
  const kept = raw.filter((c): c is ReviewCommentData => Boolean(c && typeof c.body === 'string'));
  if (kept.length !== raw.length) {
    onLoss();
  }
  return kept;
}
