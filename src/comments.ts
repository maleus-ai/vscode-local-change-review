import * as vscode from 'vscode';

import type { ReviewStore, ThreadLocation } from './storage';
import type { ReviewSessionData, ReviewThreadData, ThreadStatus } from './types';
import {
  CONTROLLER_ID,
  config,
  fromRange,
  languageIdFor,
  readLines,
  relPath,
  resolveAuthor,
  resolvePath,
  toRange,
} from './util';

export class ReviewComment implements vscode.Comment {
  /** `canEdit <thread status>` — menu `when` clauses match both words. */
  contextValue: string;
  label?: string;
  /** The last persisted text, kept so "Cancel" can restore it after an edit. */
  savedBody: string;

  constructor(
    readonly commentId: string,
    readonly threadId: string,
    readonly sessionId: string,
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    public author: vscode.CommentAuthorInformation,
    public timestamp?: Date,
    threadStatus: ThreadStatus = 'open',
  ) {
    this.savedBody = bodyText(body);
    this.contextValue = `canEdit ${threadStatus}`;
  }
}

export function bodyText(body: string | vscode.MarkdownString): string {
  return typeof body === 'string' ? body : body.value;
}

interface LiveMeta {
  threadId: string;
  sessionId: string;
  signature: string;
}

/**
 * Bridges the stored sessions to VS Code's comment controller: one live
 * `CommentThread` per stored thread of every *visible* session. The built-in
 * Comments panel is fed by the same controller, so it stays in sync for free.
 */
export class ReviewCommentsController implements vscode.Disposable {
  private readonly controller: vscode.CommentController;
  private readonly live = new Map<string, vscode.CommentThread>();
  private readonly meta = new Map<vscode.CommentThread, LiveMeta>();
  private readonly explicitlyHidden = new Set<string>();
  private readonly explicitlyShown = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  private pendingExpand: string | undefined;
  private anchorTimer: NodeJS.Timeout | undefined;

  private readonly rangeDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editorCommentsWidget.rangeBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.commentForeground'),
  });

  /** Fires when what the editor draws changed without the stored sessions changing. */
  private readonly onDidChangeViewEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeView = this.onDidChangeViewEmitter.event;

  constructor(private readonly store: ReviewStore) {
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Local Review');
    this.controller.options = {
      prompt: 'Add a review comment…',
      placeHolder: 'Leave a comment on these lines',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        if (document.uri.scheme !== 'file' || document.lineCount === 0) {
          return [];
        }
        return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
      },
    };

    this.disposables.push(
      this.store.onDidChange(() => this.render()),
      vscode.workspace.onDidChangeTextDocument((e) => this.scheduleAnchorSync(e.document)),
      vscode.workspace.onDidSaveTextDocument((doc) => void this.syncAnchors(doc)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.updateDecorations()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('localReview.highlightCommentedLines') ||
          e.affectsConfiguration('localReview.defaultThreadState')
        ) {
          this.updateDecorations();
        }
      }),
    );
  }

  // --- session visibility ----------------------------------------------------

  /** Sessions whose comments are drawn in the editor: the active one, plus any pinned open. */
  visibleSessions(): ReviewSessionData[] {
    return this.store.allSessions.filter((r) => this.isSessionVisible(r.id));
  }

  isSessionVisible(id: string): boolean {
    if (this.explicitlyShown.has(id)) {
      return true;
    }
    if (this.explicitlyHidden.has(id)) {
      return false;
    }
    return id === this.store.activeSessionId;
  }

  setSessionVisible(id: string, visible: boolean): void {
    this.explicitlyShown.delete(id);
    this.explicitlyHidden.delete(id);
    if (visible !== (id === this.store.activeSessionId)) {
      (visible ? this.explicitlyShown : this.explicitlyHidden).add(id);
    }
    this.render();
    this.onDidChangeViewEmitter.fire();
  }

  // --- rendering -----------------------------------------------------------

  render(): void {
    const sessions = this.visibleSessions();
    const multipleSessions = sessions.length > 1;
    const seen = new Set<string>();

    for (const session of sessions) {
      for (const thread of session.threads) {
        seen.add(thread.id);
        this.syncThread(session, thread, multipleSessions);
      }
    }

    for (const [id, live] of [...this.live]) {
      if (!seen.has(id)) {
        this.meta.delete(live);
        this.live.delete(id);
        live.dispose();
      }
    }
    this.updateDecorations();
  }

  private syncThread(session: ReviewSessionData, data: ReviewThreadData, showSessionName: boolean): void {
    const uri = resolvePath(data.path);
    const range = toRange(data.startLine, data.endLine);
    let live = this.live.get(data.id);

    if (!live) {
      live = this.controller.createCommentThread(uri, range, []);
      this.live.set(data.id, live);
      live.collapsibleState =
        config().get<string>('defaultThreadState', 'collapsed') === 'expanded'
          ? vscode.CommentThreadCollapsibleState.Expanded
          : vscode.CommentThreadCollapsibleState.Collapsed;
    } else if (!live.range || !live.range.isEqual(range)) {
      live.range = range;
    }

    if (this.pendingExpand === data.id) {
      this.pendingExpand = undefined;
      live.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }

    live.canReply = true;
    live.contextValue = data.status;
    live.state =
      data.status === 'resolved'
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
    live.label = showSessionName ? session.name : undefined;

    const signature = threadSignature(data);
    const previous = this.meta.get(live);
    const editing = live.comments.some(
      (c) => c instanceof ReviewComment && c.mode === vscode.CommentMode.Editing,
    );
    if (!editing && previous?.signature !== signature) {
      live.comments = data.comments.map(
        (c) =>
          new ReviewComment(
            c.id,
            data.id,
            session.id,
            new vscode.MarkdownString(c.body),
            vscode.CommentMode.Preview,
            { name: c.author },
            new Date(c.updatedAt ?? c.createdAt),
            data.status,
          ),
      );
    }
    this.meta.set(live, { threadId: data.id, sessionId: session.id, signature });
  }

  private updateDecorations(): void {
    const enabled = config().get<boolean>('highlightCommentedLines', true);
    for (const editor of vscode.window.visibleTextEditors) {
      if (!enabled) {
        editor.setDecorations(this.rangeDecoration, []);
        continue;
      }
      const key = editor.document.uri.toString();
      const ranges: vscode.Range[] = [];
      for (const [id, live] of this.live) {
        if (live.uri.toString() !== key || !live.range) {
          continue;
        }
        const found = this.store.findThread(id);
        if (found?.thread.status === 'resolved') {
          continue;
        }
        ranges.push(live.range);
      }
      editor.setDecorations(this.rangeDecoration, ranges);
    }
  }

  // --- anchor tracking -----------------------------------------------------

  private scheduleAnchorSync(document: vscode.TextDocument): void {
    if (this.anchorTimer) {
      clearTimeout(this.anchorTimer);
    }
    this.anchorTimer = setTimeout(() => void this.syncAnchors(document), 500);
  }

  /**
   * VS Code moves a thread's range as the document is edited; this writes that
   * movement (and the new source lines) back to disk so exports stay truthful.
   */
  private async syncAnchors(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const lines = document.getText().split(/\r?\n/);
    let touched = false;
    for (const [id, live] of this.live) {
      if (live.uri.toString() !== key || !live.range) {
        continue;
      }
      const { startLine, endLine } = fromRange(live.range);
      const snippet = lines.slice(startLine - 1, endLine);
      touched = this.store.updateAnchor(id, startLine, endLine, snippet) || touched;
    }
    if (touched) {
      this.updateDecorations();
      this.onDidChangeViewEmitter.fire();
    }
  }

  // --- lookups -------------------------------------------------------------

  threadIdOf(live: vscode.CommentThread): string | undefined {
    return this.meta.get(live)?.threadId;
  }

  locate(live: vscode.CommentThread): ThreadLocation | undefined {
    const id = this.threadIdOf(live);
    return id ? this.store.findThread(id) : undefined;
  }

  liveThread(threadId: string): vscode.CommentThread | undefined {
    return this.live.get(threadId);
  }

  // --- authoring -----------------------------------------------------------

  /** Ensures there is a session to write into, creating the first one on demand. */
  private async ensureActiveSession(): Promise<ReviewSessionData | undefined> {
    const existing = this.store.activeSession;
    if (existing && existing.status === 'open') {
      return existing;
    }
    if (!this.store.ready) {
      void vscode.window.showWarningMessage('Local Review: open a folder before adding comments.');
      return undefined;
    }
    return this.store.createSession();
  }

  async createThreadFromReply(reply: vscode.CommentReply): Promise<void> {
    const text = reply.text.trim();
    if (!text) {
      return;
    }
    const session = await this.ensureActiveSession();
    if (!session) {
      return;
    }
    const uri = reply.thread.uri;
    const { startLine, endLine } = fromRange(reply.thread.range ?? new vscode.Range(0, 0, 0, 0));
    const lines = (await readLines(uri)) ?? [];
    const created = await this.store.addThread(session.id, {
      path: relPath(uri),
      startLine,
      endLine,
      snippet: lines.slice(startLine - 1, endLine),
      languageId: languageIdFor(uri),
      comments: [{ author: await resolveAuthor(), body: text }],
    });
    // The thread VS Code created for the input widget is throwaway; `render()`
    // has already put a managed one in its place.
    reply.thread.dispose();
    if (created) {
      this.pendingExpand = created.id;
      this.render();
    }
  }

  async replyToThread(reply: vscode.CommentReply): Promise<void> {
    const text = reply.text.trim();
    if (!text) {
      return;
    }
    const threadId = this.threadIdOf(reply.thread);
    if (!threadId) {
      await this.createThreadFromReply(reply);
      return;
    }
    this.store.addComment(threadId, await resolveAuthor(), text);
  }

  /** Opens an empty thread widget over the current selection. */
  async startThreadOnSelection(editor: vscode.TextEditor): Promise<void> {
    if (editor.document.uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('Local Review: only files on disk can be reviewed.');
      return;
    }
    const selection = editor.selection;
    const endLine =
      selection.end.character === 0 && selection.end.line > selection.start.line
        ? selection.end.line - 1
        : selection.end.line;
    const range = new vscode.Range(selection.start.line, 0, endLine, 0);
    const thread = this.controller.createCommentThread(editor.document.uri, range, []);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = true;
  }

  startEditing(comment: ReviewComment): void {
    const live = this.live.get(comment.threadId);
    if (!live) {
      return;
    }
    live.comments = live.comments.map((c) => {
      if (c instanceof ReviewComment && c.commentId === comment.commentId) {
        c.savedBody = bodyText(c.body);
        c.body = c.savedBody;
        c.mode = vscode.CommentMode.Editing;
      }
      return c;
    });
  }

  saveEdit(comment: ReviewComment): void {
    const text = bodyText(comment.body).trim();
    const live = this.live.get(comment.threadId);
    if (!text) {
      this.cancelEdit(comment);
      return;
    }
    comment.mode = vscode.CommentMode.Preview;
    comment.savedBody = text;
    if (live) {
      live.comments = [...live.comments];
    }
    this.store.updateComment(comment.commentId, text);
  }

  cancelEdit(comment: ReviewComment): void {
    const live = this.live.get(comment.threadId);
    comment.body = new vscode.MarkdownString(comment.savedBody);
    comment.mode = vscode.CommentMode.Preview;
    if (live) {
      live.comments = [...live.comments];
    }
  }

  // --- folding & navigation ------------------------------------------------

  setAllCollapsed(collapsed: boolean): void {
    const state = collapsed
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
    for (const live of this.live.values()) {
      live.collapsibleState = state;
    }
  }

  collapse(target: vscode.CommentThread | string): void {
    const live = typeof target === 'string' ? this.live.get(target) : target;
    if (live) {
      live.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    }
  }

  async reveal(threadId: string): Promise<void> {
    const found = this.store.findThread(threadId);
    if (!found) {
      return;
    }
    if (!this.isSessionVisible(found.session.id)) {
      this.setSessionVisible(found.session.id, true);
    }
    const uri = resolvePath(found.thread.path);
    const range = toRange(found.thread.startLine, found.thread.endLine);
    const editor = await vscode.window.showTextDocument(uri, {
      selection: range,
      preview: false,
    });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    const live = this.live.get(threadId);
    if (live) {
      live.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    } else {
      this.pendingExpand = threadId;
      this.render();
    }
  }

  dispose(): void {
    if (this.anchorTimer) {
      clearTimeout(this.anchorTimer);
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.rangeDecoration.dispose();
    this.onDidChangeViewEmitter.dispose();
    this.controller.dispose();
  }
}

function threadSignature(thread: ReviewThreadData): string {
  return `${thread.status}#` + thread.comments.map((c) => `${c.id}:${c.updatedAt ?? c.createdAt}:${c.body.length}`).join('|');
}
