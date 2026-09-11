import * as vscode from 'vscode';

import {
  INDEX_FORMAT_VERSION,
  SESSION_FORMAT_VERSION,
  type ReviewCommentData,
  type ReviewIndexData,
  type ReviewSessionData,
  type ReviewThreadData,
  type ThreadStatus,
} from './types';
import { gitBase, newId, nowIso, sessionId, storageUri } from './util';

const INDEX_FILE = 'index.json';
const SESSIONS_DIR = 'sessions';
/** Pre-0.2.0 name for the same thing; read-only, so older reviews aren't orphaned. */
const LEGACY_SESSIONS_DIR = 'rounds';

export interface ThreadLocation {
  session: ReviewSessionData;
  thread: ReviewThreadData;
}

export interface CommentLocation extends ThreadLocation {
  comment: ReviewCommentData;
  /** 0 for the thread's opening comment, >0 for replies. */
  index: number;
}

/**
 * Owns everything under the storage folder. Sessions are one JSON file each so
 * that an external editor (or an LLM) touching one session never has to rewrite
 * the others; `index.json` only carries the pointer to the active session.
 */
export class ReviewStore implements vscode.Disposable {
  private readonly sessions = new Map<string, ReviewSessionData>();
  private index: ReviewIndexData = { version: INDEX_FORMAT_VERSION };
  private root: vscode.Uri | undefined;
  private watcher: vscode.FileSystemWatcher | undefined;

  /** Serialised content of every file we wrote, so our own writes don't loop back through the watcher. */
  private readonly lastWritten = new Map<string, string>();
  private readonly pendingSaves = new Map<string, NodeJS.Timeout>();

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  get ready(): boolean {
    return this.root !== undefined;
  }

  get storageFolder(): vscode.Uri | undefined {
    return this.root;
  }

  /** Newest session first. */
  get allSessions(): ReviewSessionData[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get activeSession(): ReviewSessionData | undefined {
    const id = this.index.activeSessionId;
    return id ? this.sessions.get(id) : undefined;
  }

  get activeSessionId(): string | undefined {
    return this.index.activeSessionId;
  }

  getSession(id: string): ReviewSessionData | undefined {
    return this.sessions.get(id);
  }

  findThread(threadId: string): ThreadLocation | undefined {
    for (const session of this.sessions.values()) {
      const thread = session.threads.find((t) => t.id === threadId);
      if (thread) {
        return { session, thread };
      }
    }
    return undefined;
  }

  findComment(commentId: string): CommentLocation | undefined {
    for (const session of this.sessions.values()) {
      for (const thread of session.threads) {
        const index = thread.comments.findIndex((c) => c.id === commentId);
        if (index >= 0) {
          return { session, thread, comment: thread.comments[index], index };
        }
      }
    }
    return undefined;
  }

  async initialize(): Promise<void> {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('localReview.storageFolder')) {
          void this.reattach();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.reattach()),
    );
    await this.reattach();
  }

  private async reattach(): Promise<void> {
    this.watcher?.dispose();
    this.watcher = undefined;
    this.sessions.clear();
    this.lastWritten.clear();
    this.index = { version: INDEX_FORMAT_VERSION };
    this.root = storageUri();

    if (this.root) {
      await this.reload();
      const pattern = new vscode.RelativePattern(this.root, '**/*.json');
      this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const onExternal = (uri: vscode.Uri) => void this.handleExternalChange(uri);
      this.watcher.onDidChange(onExternal);
      this.watcher.onDidCreate(onExternal);
      this.watcher.onDidDelete(onExternal);
    }
    this.onDidChangeEmitter.fire();
  }

  private async handleExternalChange(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const known = this.lastWritten.get(key);
    if (known !== undefined) {
      const current = await this.readText(uri);
      if (current === known) {
        return; // our own write echoing back
      }
    }
    await this.reload();
    this.onDidChangeEmitter.fire();
  }

  private async readText(uri: vscode.Uri): Promise<string | undefined> {
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    } catch {
      return undefined;
    }
  }

  private async readDir(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    try {
      return await vscode.workspace.fs.readDirectory(uri);
    } catch {
      return [];
    }
  }

  private async reload(): Promise<void> {
    const root = this.root;
    if (!root) {
      return;
    }
    this.sessions.clear();
    this.lastWritten.clear();

    const indexUri = vscode.Uri.joinPath(root, INDEX_FILE);
    const indexText = await this.readText(indexUri);
    if (indexText !== undefined) {
      try {
        const parsed = JSON.parse(indexText) as ReviewIndexData & { activeRoundId?: string };
        this.index = {
          version: INDEX_FORMAT_VERSION,
          activeSessionId: parsed.activeSessionId ?? parsed.activeRoundId,
        };
        this.lastWritten.set(indexUri.toString(), indexText);
      } catch {
        this.index = { version: INDEX_FORMAT_VERSION };
      }
    } else {
      this.index = { version: INDEX_FORMAT_VERSION };
    }

    let sessionsUri = vscode.Uri.joinPath(root, SESSIONS_DIR);
    let entries = await this.readDir(sessionsUri);
    if (entries.length === 0) {
      const legacyUri = vscode.Uri.joinPath(root, LEGACY_SESSIONS_DIR);
      const legacy = await this.readDir(legacyUri);
      if (legacy.length > 0) {
        sessionsUri = legacyUri;
        entries = legacy;
      }
    }
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.json')) {
        continue;
      }
      const uri = vscode.Uri.joinPath(sessionsUri, name);
      const text = await this.readText(uri);
      if (text === undefined) {
        continue;
      }
      try {
        const session = normalizeSession(JSON.parse(text) as ReviewSessionData, name.replace(/\.json$/, ''));
        this.sessions.set(session.id, session);
        this.lastWritten.set(uri.toString(), text);
      } catch {
        void vscode.window.showWarningMessage(`Local Review: could not parse ${SESSIONS_DIR}/${name}.`);
      }
    }

    if (this.index.activeSessionId && !this.sessions.has(this.index.activeSessionId)) {
      this.index.activeSessionId = undefined;
    }
    if (!this.index.activeSessionId) {
      const fallback = this.allSessions.find((r) => r.status === 'open');
      if (fallback) {
        this.index.activeSessionId = fallback.id;
      }
    }
  }

  // --- writing -------------------------------------------------------------

  private sessionUri(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root!, SESSIONS_DIR, `${id}.json`);
  }

  private scheduleWrite(uri: vscode.Uri, content: string): void {
    const key = uri.toString();
    const existing = this.pendingSaves.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.pendingSaves.set(
      key,
      setTimeout(() => {
        this.pendingSaves.delete(key);
        void this.writeNow(uri, content);
      }, 150),
    );
  }

  private async writeNow(uri: vscode.Uri, content: string): Promise<void> {
    try {
      this.lastWritten.set(uri.toString(), content);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    } catch (err) {
      void vscode.window.showErrorMessage(`Local Review: failed to write ${uri.fsPath}: ${String(err)}`);
    }
  }

  private persistSession(session: ReviewSessionData): void {
    if (!this.root) {
      return;
    }
    session.threads.sort(compareThreads);
    this.scheduleWrite(this.sessionUri(session.id), `${JSON.stringify(session, null, 2)}\n`);
  }

  private persistIndex(): void {
    if (!this.root) {
      return;
    }
    const uri = vscode.Uri.joinPath(this.root, INDEX_FILE);
    this.scheduleWrite(uri, `${JSON.stringify(this.index, null, 2)}\n`);
  }

  /** Flushes debounced writes; called on deactivate. */
  async flush(): Promise<void> {
    const pending = [...this.pendingSaves.entries()];
    this.pendingSaves.clear();
    for (const [, timer] of pending) {
      clearTimeout(timer);
    }
    // Re-persist everything we know about rather than tracking each pending body.
    for (const session of this.sessions.values()) {
      await this.writeNow(this.sessionUri(session.id), `${JSON.stringify(session, null, 2)}\n`);
    }
    if (this.root) {
      await this.writeNow(
        vscode.Uri.joinPath(this.root, INDEX_FILE),
        `${JSON.stringify(this.index, null, 2)}\n`,
      );
    }
  }

  private changed(): void {
    this.onDidChangeEmitter.fire();
  }

  // --- sessions --------------------------------------------------------------

  async createSession(name?: string): Promise<ReviewSessionData> {
    if (!this.root) {
      throw new Error('Open a folder before starting a review session.');
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.root, SESSIONS_DIR));
    let id = sessionId();
    let suffix = 1;
    while (this.sessions.has(id)) {
      id = `${sessionId()}-${++suffix}`;
    }
    const session: ReviewSessionData = {
      version: SESSION_FORMAT_VERSION,
      id,
      name: name?.trim() || `Session ${this.sessions.size + 1}`,
      status: 'open',
      createdAt: nowIso(),
      base: await gitBase(),
      threads: [],
    };
    this.sessions.set(session.id, session);
    this.index.activeSessionId = session.id;
    this.persistSession(session);
    this.persistIndex();
    this.changed();
    return session;
  }

  async renameSession(id: string, name: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      return;
    }
    session.name = name.trim() || session.name;
    this.persistSession(session);
    this.changed();
  }

  setActiveSession(id: string): void {
    if (!this.sessions.has(id)) {
      return;
    }
    this.index.activeSessionId = id;
    this.persistIndex();
    this.changed();
  }

  setSessionStatus(id: string, status: ReviewSessionData['status']): void {
    const session = this.sessions.get(id);
    if (!session || session.status === status) {
      return;
    }
    session.status = status;
    session.closedAt = status === 'closed' ? nowIso() : undefined;
    if (status === 'closed' && this.index.activeSessionId === id) {
      const next = this.allSessions.find((r) => r.status === 'open');
      this.index.activeSessionId = next?.id;
      this.persistIndex();
    }
    if (status === 'open') {
      this.index.activeSessionId = id;
      this.persistIndex();
    }
    this.persistSession(session);
    this.changed();
  }

  async deleteSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session || !this.root) {
      return;
    }
    this.sessions.delete(id);
    const uri = this.sessionUri(id);
    this.lastWritten.delete(uri.toString());
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      // already gone
    }
    if (this.index.activeSessionId === id) {
      this.index.activeSessionId = this.allSessions.find((r) => r.status === 'open')?.id;
    }
    this.persistIndex();
    this.changed();
  }

  // --- threads & comments --------------------------------------------------

  async addThread(
    sessionIdValue: string,
    input: Omit<ReviewThreadData, 'id' | 'status' | 'createdAt' | 'updatedAt' | 'comments'> & {
      comments: Omit<ReviewCommentData, 'id' | 'createdAt'>[];
    },
  ): Promise<ReviewThreadData | undefined> {
    const session = this.sessions.get(sessionIdValue);
    if (!session) {
      return undefined;
    }
    const timestamp = nowIso();
    const thread: ReviewThreadData = {
      id: newId('thread'),
      path: input.path,
      startLine: input.startLine,
      endLine: input.endLine,
      snippet: input.snippet,
      languageId: input.languageId,
      status: 'open',
      createdAt: timestamp,
      updatedAt: timestamp,
      comments: input.comments.map((c) => ({ ...c, id: newId('comment'), createdAt: timestamp })),
    };
    session.threads.push(thread);
    this.persistSession(session);
    this.changed();
    return thread;
  }

  addComment(threadId: string, author: string, body: string): ReviewCommentData | undefined {
    const found = this.findThread(threadId);
    if (!found) {
      return undefined;
    }
    const comment: ReviewCommentData = { id: newId('comment'), author, body, createdAt: nowIso() };
    found.thread.comments.push(comment);
    found.thread.updatedAt = comment.createdAt;
    this.persistSession(found.session);
    this.changed();
    return comment;
  }

  updateComment(commentId: string, body: string): void {
    const found = this.findComment(commentId);
    if (!found || found.comment.body === body) {
      return;
    }
    found.comment.body = body;
    found.comment.updatedAt = nowIso();
    found.thread.updatedAt = found.comment.updatedAt;
    this.persistSession(found.session);
    this.changed();
  }

  /** Deleting a thread's last comment deletes the thread. */
  deleteComment(commentId: string): void {
    const found = this.findComment(commentId);
    if (!found) {
      return;
    }
    found.thread.comments.splice(found.index, 1);
    if (found.thread.comments.length === 0) {
      found.session.threads = found.session.threads.filter((t) => t.id !== found.thread.id);
    } else {
      found.thread.updatedAt = nowIso();
    }
    this.persistSession(found.session);
    this.changed();
  }

  deleteThread(threadId: string): void {
    const found = this.findThread(threadId);
    if (!found) {
      return;
    }
    found.session.threads = found.session.threads.filter((t) => t.id !== threadId);
    this.persistSession(found.session);
    this.changed();
  }

  setThreadStatus(threadId: string, status: ThreadStatus): void {
    const found = this.findThread(threadId);
    if (!found || found.thread.status === status) {
      return;
    }
    found.thread.status = status;
    found.thread.updatedAt = nowIso();
    this.persistSession(found.session);
    this.changed();
  }

  /**
   * Re-anchors a thread after the file it points at was edited. Silent: the
   * editor already shows the moved thread, and firing a change here would tear
   * down the widget the user is typing in.
   */
  updateAnchor(threadId: string, startLine: number, endLine: number, snippet: string[]): boolean {
    const found = this.findThread(threadId);
    if (!found) {
      return false;
    }
    const { thread } = found;
    const sameSnippet =
      thread.snippet.length === snippet.length && thread.snippet.every((l, i) => l === snippet[i]);
    if (thread.startLine === startLine && thread.endLine === endLine && sameSnippet) {
      return false;
    }
    thread.startLine = startLine;
    thread.endLine = endLine;
    thread.snippet = snippet;
    this.persistSession(found.session);
    return true;
  }

  dispose(): void {
    for (const [, timer] of this.pendingSaves) {
      clearTimeout(timer);
    }
    this.pendingSaves.clear();
    this.watcher?.dispose();
    this.onDidChangeEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function compareThreads(a: ReviewThreadData, b: ReviewThreadData): number {
  return a.path.localeCompare(b.path) || a.startLine - b.startLine || a.createdAt.localeCompare(b.createdAt);
}

/** Repairs sessions that were hand-edited, so a missing field never breaks the view. */
function normalizeSession(raw: Partial<ReviewSessionData>, fallbackId: string): ReviewSessionData {
  const threads = Array.isArray(raw.threads) ? raw.threads : [];
  return {
    version: raw.version ?? SESSION_FORMAT_VERSION,
    id: raw.id || fallbackId,
    name: raw.name || fallbackId,
    status: raw.status === 'closed' ? 'closed' : 'open',
    createdAt: raw.createdAt || new Date(0).toISOString(),
    closedAt: raw.closedAt,
    base: raw.base,
    threads: threads
      .filter((t): t is ReviewThreadData => Boolean(t && t.path))
      .map((t): ReviewThreadData => ({
        id: t.id || newId('thread'),
        path: t.path,
        startLine: Math.max(1, Number(t.startLine) || 1),
        endLine: Math.max(1, Number(t.endLine) || Number(t.startLine) || 1),
        snippet: Array.isArray(t.snippet) ? t.snippet : [],
        languageId: t.languageId,
        status: t.status === 'resolved' ? 'resolved' : 'open',
        createdAt: t.createdAt || new Date(0).toISOString(),
        updatedAt: t.updatedAt || t.createdAt || new Date(0).toISOString(),
        comments: (Array.isArray(t.comments) ? t.comments : [])
          .filter((c): c is ReviewCommentData => Boolean(c && typeof c.body === 'string'))
          .map((c): ReviewCommentData => ({
            id: c.id || newId('comment'),
            author: c.author || 'unknown',
            body: c.body,
            createdAt: c.createdAt || new Date(0).toISOString(),
            updatedAt: c.updatedAt,
          })),
      }))
      .sort(compareThreads),
  };
}
