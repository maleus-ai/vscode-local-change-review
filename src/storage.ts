import * as vscode from 'vscode';

import { type ReadLines, reanchorAll } from './core/anchor';
import { ReviewFiles, type StoreState } from './core/files';
import * as ops from './core/operations';
import type { CommentLocation, ThreadLocation } from './core/operations';
import { INDEX_FORMAT_VERSION, type ReviewCommentData, type ReviewSessionData, type ThreadStatus } from './core/types';
import { log } from './log';
import { gitBase, storageUri, toPosix } from './util';

export type { CommentLocation, ThreadLocation } from './core/operations';

/**
 * The editor's view of the review. Holds an in-memory copy purely for
 * rendering; every write is a mutation handed to `ReviewFiles.transaction`,
 * which re-reads from disk under a lock first. That is what lets another writer
 * — an MCP server, a hand edit — share the same files without being clobbered.
 */
export class ReviewStore implements vscode.Disposable {
  private files: ReviewFiles | undefined;
  private state: StoreState = emptyState();
  private watcher: vscode.FileSystemWatcher | undefined;

  /** Content we wrote ourselves, so the watcher doesn't treat the echo as news. */
  private readonly lastWritten = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  get ready(): boolean {
    return this.files !== undefined;
  }

  get storageFolder(): vscode.Uri | undefined {
    return this.files ? vscode.Uri.file(this.files.root) : undefined;
  }

  /** Newest session first. */
  get allSessions(): ReviewSessionData[] {
    return ops.allSessions(this.state);
  }

  get activeSession(): ReviewSessionData | undefined {
    const id = this.state.index.activeSessionId;
    return id ? this.state.sessions.get(id) : undefined;
  }

  get activeSessionId(): string | undefined {
    return this.state.index.activeSessionId;
  }

  getSession(id: string): ReviewSessionData | undefined {
    return this.state.sessions.get(id);
  }

  findThread(threadId: string): ThreadLocation | undefined {
    return ops.findThread(this.state, threadId);
  }

  findComment(commentId: string): CommentLocation | undefined {
    return ops.findComment(this.state, commentId);
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
    this.lastWritten.clear();
    this.state = emptyState();

    const uri = storageUri();
    this.files = uri && uri.scheme === 'file' ? new ReviewFiles(uri.fsPath) : undefined;

    if (this.files && uri) {
      this.reload();
      // Anchored on the workspace folder, not on the storage folder: a watch
      // rooted at a directory that is later deleted and recreated goes deaf,
      // and the storage folder is deleted routinely (clearing old reviews).
      const folder = vscode.workspace.getWorkspaceFolder(uri);
      const relative = folder ? uri.fsPath.slice(folder.uri.fsPath.length + 1) : undefined;
      this.watcher = vscode.workspace.createFileSystemWatcher(
        folder && relative
          ? new vscode.RelativePattern(folder, `${toPosix(relative)}/**/*.json`)
          : new vscode.RelativePattern(uri, '**/*.json'),
      );
      const onExternal = (changed: vscode.Uri) => void this.handleExternalChange(changed);
      this.watcher.onDidChange(onExternal);
      this.watcher.onDidCreate(onExternal);
      this.watcher.onDidDelete(onExternal);
    }
    this.onDidChangeEmitter.fire();
  }

  /**
   * Re-reads from disk and announces any difference.
   *
   * The watcher is an optimisation, not a guarantee — it can miss events, and a
   * missed one would otherwise be permanent. This is cheap enough to run
   * whenever attention returns to the window.
   */
  refreshFromDisk(): void {
    if (!this.files) {
      return;
    }
    const before = snapshot(this.state);
    this.reload();
    if (snapshot(this.state) !== before) {
      log('refreshed from disk: the watcher had missed a change');
      this.onDidChangeEmitter.fire();
    }
  }

  private reload(): void {
    if (!this.files) {
      return;
    }
    this.state = this.files.read();
    ops.reconcileActiveSession(this.state);
    // After a reload our in-memory state no longer corresponds to anything we
    // wrote, so nothing we wrote is still an echo worth suppressing.
    this.lastWritten.clear();
  }

  private async handleExternalChange(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const known = this.lastWritten.get(key);
    if (known !== undefined) {
      // Single-shot. An entry that outlives the event it was meant to swallow
      // goes on claiming our old content is ours, so restoring that content —
      // `git checkout -- .local-review`, or an undo — looks like an echo and is
      // ignored, leaving the panel showing threads that are no longer on disk.
      this.lastWritten.delete(key);
      try {
        const current = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        if (current === known) {
          return;
        }
      } catch {
        // deleted; fall through and reload
      }
    }
    log('watcher: external change -> reload', { file: uri.path.split('/').pop() });
    this.reload();
    this.onDidChangeEmitter.fire();
  }

  /**
   * The single write path: run a mutation against the on-disk state under lock,
   * then refresh the in-memory copy from what was actually committed and record
   * the written content so the watcher does not treat our own echo as news.
   *
   * Everything that writes goes through here. The variants differ only in
   * whether they announce the change and whether a failure is worth a dialog.
   */
  private commit<T>(
    mutate: (state: StoreState) => T,
    options: { notify: (result: T) => boolean; loud: boolean },
  ): T | undefined {
    if (!this.files) {
      if (options.loud) {
        void vscode.window.showWarningMessage('Local Review: open a folder before making changes.');
      }
      return undefined;
    }
    const before = snapshot(this.state);
    try {
      const { result, state, written, removed } = this.files.transaction(mutate);
      this.state = state;
      for (const [file, content] of written) {
        this.lastWritten.set(vscode.Uri.file(file).toString(), content);
      }
      for (const file of removed) {
        this.lastWritten.delete(vscode.Uri.file(file).toString());
      }
      // Fired when the store changed at all, not only when this mutation says
      // so: a transaction re-reads from disk first, so a silent write adopts any
      // external change with it — and would otherwise bury it.
      if (options.notify(result) || snapshot(this.state) !== before) {
        this.onDidChangeEmitter.fire();
      }
      return result;
    } catch (err) {
      log('transaction failed', { error: String(err) });
      if (options.loud) {
        void vscode.window.showErrorMessage(`Local Review: ${String(err)}`);
      }
      return undefined;
    }
  }

  private apply<T>(mutate: (state: StoreState) => T): T | undefined {
    return this.commit(mutate, { notify: () => true, loud: true });
  }

  // --- sessions ------------------------------------------------------------

  async createSession(name?: string): Promise<ReviewSessionData | undefined> {
    const base = await gitBase();
    return this.apply((state) => ops.createSession(state, name, base, true));
  }

  async renameSession(id: string, name: string): Promise<void> {
    this.apply((state) => ops.renameSession(state, id, name));
  }

  setActiveSession(id: string): void {
    this.apply((state) => ops.setActiveSession(state, id));
  }

  setSessionStatus(id: string, status: ReviewSessionData['status']): void {
    this.apply((state) => ops.setSessionStatus(state, id, status));
  }

  async deleteSession(id: string): Promise<void> {
    this.apply((state) => ops.deleteSession(state, id));
  }

  // --- threads & comments --------------------------------------------------

  async addThread(sessionId: string, input: ops.NewThreadInput) {
    return this.apply((state) => ops.addThread(state, sessionId, input));
  }

  addComment(threadId: string, author: string, body: string): ReviewCommentData | undefined {
    return this.apply((state) => ops.addComment(state, threadId, author, body, false));
  }

  updateComment(commentId: string, body: string): void {
    this.apply((state) => ops.updateComment(state, commentId, body));
  }

  deleteComment(commentId: string): void {
    this.apply((state) => ops.deleteComment(state, commentId));
  }

  deleteThread(threadId: string): void {
    this.apply((state) => ops.deleteThread(state, threadId));
  }

  setThreadStatus(threadId: string, status: ThreadStatus): void {
    this.apply((state) => ops.setThreadStatus(state, threadId, status));
  }

  /**
   * Re-anchors a thread after its file was edited. Deliberately does not fire a
   * change event: the editor already shows the moved thread, and re-rendering
   * would tear down a widget the user may be typing in.
   */
  updateAnchor(threadId: string, startLine: number, endLine: number, snippet: string[]): boolean {
    return (
      this.commit((s) => ops.updateAnchor(s, threadId, startLine, endLine, snippet), {
        notify: () => false,
        loud: false,
      }) === true
    );
  }

  /**
   * Re-points every thread at where its captured code now lives. The editor
   * tracks ranges for files that are open; this covers everything else — most
   * importantly files an agent rewrote while they were closed.
   */
  reanchor(readLines: ReadLines, onlyPath?: string): boolean {
    const moved = this.commit((s) => reanchorAll(s, readLines, { onlyPath }), {
      notify: (result) => result === true,
      loud: false,
    });
    if (moved) {
      log('reanchored threads');
    }
    return moved === true;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.watcher?.dispose();
    this.onDidChangeEmitter.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function emptyState(): StoreState {
  return {
    index: { version: INDEX_FORMAT_VERSION },
    sessions: new Map(),
    sources: new Map(),
    readOnly: new Map(),
  };
}

/** Cheap value-identity of the whole store, for detecting a missed change. */
function snapshot(state: StoreState): string {
  return JSON.stringify([state.index, [...state.sessions.values()]]);
}
