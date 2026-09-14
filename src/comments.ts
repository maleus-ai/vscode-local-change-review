import { createHash } from 'crypto';
import * as vscode from 'vscode';

import { log } from './log';
import { outdatedSnippetNotice, shownSnippet } from './core/export';
import { hardBreaks, splitLines } from './core/format';
import { Identities } from './identities';
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
  /**
   * Markdown rendered above the comment text and never part of it — currently
   * the snippet of a thread that has come unanchored. Kept separate so editing
   * shows the author's own words and saving cannot persist what we added.
   */
  displayPrefix = '';

  constructor(
    readonly commentId: string,
    readonly threadId: string,
    readonly sessionId: string,
    public body: string | vscode.MarkdownString,
    public mode: vscode.CommentMode,
    public author: vscode.CommentAuthorInformation,
    public timestamp?: Date,
    threadStatus: ThreadStatus = 'open',
    rawBody?: string,
  ) {
    this.savedBody = rawBody ?? bodyText(body);
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
  /** Every widget we have created, so none can outlive the map that tracks it. */
  private readonly created = new Set<vscode.CommentThread>();
  /** The one empty widget a user may be typing into; exempt from sweeping. */
  private draft: vscode.CommentThread | undefined;
  private readonly meta = new Map<vscode.CommentThread, LiveMeta>();
  private readonly explicitlyHidden = new Set<string>();
  private readonly explicitlyShown = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  private pendingExpand: string | undefined;
  private anchorTimer: NodeJS.Timeout | undefined;
  private suspended = false;
  private disposed = false;

  private readonly rangeDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('editorCommentsWidget.rangeBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right,
    overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.commentForeground'),
  });

  /** Fires when what the editor draws changed without the stored sessions changing. */
  private readonly onDidChangeViewEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeView = this.onDidChangeViewEmitter.event;

  constructor(
    private readonly store: ReviewStore,
    private readonly identities: Identities,
  ) {
    log('controller: created');
    this.controller = vscode.comments.createCommentController(CONTROLLER_ID, 'Local Review');
    this.controller.options = {
      prompt: 'Add a review comment…',
      placeHolder: 'Leave a comment on these lines',
    };
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document) => {
        const allowed = this.canComment() && document.uri.scheme === 'file' && document.lineCount > 0;
        log('provideCommentingRanges', { file: basename(document.uri), allowed });
        return allowed ? [new vscode.Range(0, 0, document.lineCount - 1, 0)] : [];
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

  /** Whether we should offer to create comments at all right now. */
  canComment(): boolean {
    if (this.suspended || !this.store.ready) {
      return false;
    }
    const mode = config().get<string>('commenting', 'whenSessionActive');
    if (mode === 'never') {
      return false;
    }
    if (mode === 'always') {
      return true;
    }
    return this.store.activeSession?.status === 'open';
  }

  get isSuspended(): boolean {
    return this.suspended;
  }

  /** Suspended: no gutter affordance, no threads in the editor or Comments panel. */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) {
      return;
    }
    this.suspended = suspended;
    this.render();
    this.onDidChangeViewEmitter.fire();
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
    log('render: begin', { live: this.live.size, created: this.created.size, suspended: this.suspended });
    if (this.suspended) {
      this.disposeAllThreads();
      this.updateDecorations();
      return;
    }
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
    this.sweepOrphans();
    this.updateDecorations();
    log('render: end', { live: this.live.size, created: this.created.size });
  }

  /**
   * Retires widgets that are no longer tracked in `live` — an abandoned draft,
   * or anything that slipped out of the map. Without this a stray widget would
   * sit in the editor next to the real thread for the life of the host.
   */
  private sweepOrphans(): void {
    const tracked = new Set(this.live.values());
    for (const thread of [...this.created]) {
      if (tracked.has(thread) || thread === this.draft) {
        continue;
      }
      log('sweep orphan widget');
      this.created.delete(thread);
      this.meta.delete(thread);
      thread.dispose();
    }
  }

  private forget(thread: vscode.CommentThread): void {
    this.created.delete(thread);
    this.meta.delete(thread);
    if (this.draft === thread) {
      this.draft = undefined;
    }
  }

  /** Tears every widget down and draws them again, clearing stale editor zones. */
  rebuild(): void {
    const expanded = new Set(
      [...this.live]
        .filter(([, t]) => t.collapsibleState === vscode.CommentThreadCollapsibleState.Expanded)
        .map(([id]) => id),
    );
    this.disposeAllThreads();
    this.render();
    for (const [id, live] of this.live) {
      if (expanded.has(id)) {
        live.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
      }
    }
  }

  private disposeAllThreads(): void {
    for (const thread of this.created) {
      this.meta.delete(thread);
      thread.dispose();
    }
    this.created.clear();
    this.live.clear();
    this.draft = undefined;
  }

  private buildComments(
    session: ReviewSessionData,
    data: ReviewThreadData,
  ): ReviewComment[] {
    // On the first comment only: the thread is one conversation about one
    // snippet, and repeating it above every reply would bury them.
    const notice = outdatedSnippetNotice(data);
    return data.comments.map((c, index) => {
      const prefix = index === 0 ? (notice ?? '') : '';
      const comment = new ReviewComment(
        c.id,
        data.id,
        session.id,
        new vscode.MarkdownString(prefix + hardBreaks(c.body)),
        vscode.CommentMode.Preview,
        { name: this.identities.displayName(c.author), iconPath: this.identities.forAuthor(c.author) },
        new Date(c.updatedAt ?? c.createdAt),
        data.status,
        c.body,
      );
      comment.displayPrefix = prefix;
      if (c.agent) {
        comment.label = 'Agent';
      }
      return comment;
    });
  }

  private syncThread(session: ReviewSessionData, data: ReviewThreadData, showSessionName: boolean): void {
    const uri = resolvePath(data.path);
    const range = toRange(data.startLine, data.endLine);
    const signature = threadSignature(data);
    const state =
      data.status === 'resolved'
        ? vscode.CommentThreadState.Resolved
        : vscode.CommentThreadState.Unresolved;
    const label = [
      showSessionName ? session.name : undefined,
      data.outdated && data.status !== 'resolved' ? 'outdated' : undefined,
    ]
      .filter(Boolean)
      .join(' · ') || undefined;
    const live = this.live.get(data.id);

    if (!live) {
      // Hand the comments to the constructor. Creating an empty thread and then
      // assigning `comments` makes the editor materialise the widget twice: once
      // as the empty "new comment" draft, then again when the comments land.
      const expand =
        this.pendingExpand === data.id ||
        config().get<string>('defaultThreadState', 'collapsed') === 'expanded';
      if (this.pendingExpand === data.id) {
        this.pendingExpand = undefined;
      }
      log('createCommentThread', {
        id: data.id,
        file: data.path,
        lines: `${data.startLine}-${data.endLine}`,
        comments: data.comments.length,
        expand,
      });
      const created = this.controller.createCommentThread(
        uri,
        range,
        this.buildComments(session, data),
      );
      created.collapsibleState = expand
        ? vscode.CommentThreadCollapsibleState.Expanded
        : vscode.CommentThreadCollapsibleState.Collapsed;
      created.canReply = true;
      created.contextValue = data.status;
      created.state = state;
      if (label !== undefined) {
        created.label = label;
      }
      this.created.add(created);
      this.live.set(data.id, created);
      this.meta.set(created, { threadId: data.id, sessionId: session.id, signature });
      return;
    }

    if (!sameLines(live.range, range)) {
      // Compare lines only. VS Code keeps character offsets on the range it
      // tracks, so `Range.isEqual` is false even when the thread has not moved.
      log('write range', { id: data.id, to: `${data.startLine}-${data.endLine}` });
      live.range = range;
    }
    if (this.pendingExpand === data.id) {
      this.pendingExpand = undefined;
      log('write collapsibleState (pendingExpand)', { id: data.id });
      live.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    }

    // Only write what actually changed; every assignment re-renders the widget.
    if (live.canReply !== true) {
      live.canReply = true;
    }
    if (live.contextValue !== data.status) {
      live.contextValue = data.status;
    }
    if (live.state !== state) {
      live.state = state;
    }
    if (live.label !== label) {
      live.label = label;
    }

    const editing = live.comments.some(
      (c) => c instanceof ReviewComment && c.mode === vscode.CommentMode.Editing,
    );
    const previous = this.meta.get(live)?.signature;
    if (!editing && previous !== signature) {
      log('write comments', { id: data.id, count: data.comments.length });
      live.comments = this.buildComments(session, data);
    }
    this.meta.set(live, {
      threadId: data.id,
      sessionId: session.id,
      // Only ever the signature actually rendered. Recording the new one while
      // skipping the rebuild would make the difference undetectable forever, and
      // a comment left in edit mode never leaves it on its own.
      signature: editing ? (previous ?? '') : signature,
    });
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
    const lines = splitLines(document.getText());
    let touched = false;
    for (const [id, live] of this.live) {
      if (live.uri.toString() !== key || !live.range) {
        continue;
      }
      const { startLine, endLine } = fromRange(live.range);
      const snippet = lines.slice(startLine - 1, endLine);
      touched = this.store.updateAnchor(id, startLine, endLine, snippet) || touched;
    }
    log('syncAnchors', { file: basename(document.uri), touched });
    if (touched) {
      this.updateDecorations();
      this.onDidChangeViewEmitter.fire();
    }
  }

  /** Snapshot for the diagnostics command. */
  stats(): Record<string, unknown> {
    const tracked = new Set(this.live.values());
    return {
      suspended: this.suspended,
      canComment: this.canComment(),
      liveThreads: this.live.size,
      trackedWidgets: this.created.size,
      orphanWidgets: [...this.created].filter((t) => !tracked.has(t) && t !== this.draft).length,
      hasDraft: this.draft !== undefined,
      visibleSessions: this.visibleSessions().map((x) => x.name),
      widgets: [...this.created].map((t) => ({
        threadId: this.meta.get(t)?.threadId ?? null,
        inLiveMap: tracked.has(t),
        isDraft: t === this.draft,
        file: t.uri.path.split('/').pop(),
        lines: t.range ? `${t.range.start.line + 1}-${t.range.end.line + 1}` : null,
        comments: t.comments.length,
        collapsed: t.collapsibleState === vscode.CommentThreadCollapsibleState.Collapsed,
      })),
    };
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
      author: await resolveAuthor(),
      agent: false,
      body: text,
    });
    // The thread behind the input widget is throwaway — ours from a Ctrl+Alt+C
    // draft, or one VS Code made for the gutter "+". `render()` has already put a
    // managed one in its place.
    reply.thread.dispose();
    this.forget(reply.thread);
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
    if (this.suspended) {
      void vscode.window.showWarningMessage('Local Review is suspended. Resume it to add comments.');
      return;
    }
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
    if (this.draft) {
      this.draft.dispose();
      this.forget(this.draft);
    }
    // Empty on purpose: an empty thread IS the editor's "new comment" widget.
    const thread = this.controller.createCommentThread(editor.document.uri, range, []);
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    thread.canReply = true;
    this.created.add(thread);
    this.draft = thread;
  }

  startEditing(comment: ReviewComment): void {
    const live = this.live.get(comment.threadId);
    if (!live) {
      return;
    }
    live.comments = live.comments.map((c) => {
      if (c instanceof ReviewComment && c.commentId === comment.commentId) {
        // `savedBody` is already the persisted text. Recomputing it from what is
        // displayed would fold `displayPrefix` into the comment and then save it.
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
    if (!this.store.findComment(comment.commentId)) {
      // Deleted underneath us, most likely by an agent. Say so rather than
      // dropping the edit silently while the widget still shows it.
      void vscode.window.showWarningMessage(
        'Local Review: that comment no longer exists, so the edit was not saved.',
      );
      this.cancelEdit(comment);
      this.render();
      return;
    }
    comment.mode = vscode.CommentMode.Preview;
    comment.savedBody = text;
    comment.body = new vscode.MarkdownString(comment.displayPrefix + hardBreaks(text));
    if (live) {
      live.comments = [...live.comments];
    }
    this.store.updateComment(comment.commentId, text);
    // Editing is over, so apply anything render skipped while it was in progress.
    this.render();
  }

  cancelEdit(comment: ReviewComment): void {
    const live = this.live.get(comment.threadId);
    comment.body = new vscode.MarkdownString(comment.displayPrefix + hardBreaks(comment.savedBody));
    comment.mode = vscode.CommentMode.Preview;
    if (live) {
      live.comments = [...live.comments];
    }
    this.render();
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
    const live = this.live.get(threadId);
    log('reveal', { id: threadId, hadLiveWidget: live !== undefined });
    if (live) {
      live.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    } else {
      this.pendingExpand = threadId;
      this.render();
    }

    const range = toRange(found.thread.startLine, found.thread.endLine);
    try {
      const editor = await vscode.window.showTextDocument(uri, { selection: range, preview: false });
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      log('reveal: editor shown', { id: threadId });
    } catch {
      // Usually a file an agent deleted or renamed — which is exactly the thread
      // a reviewer clicks to find out what happened, so explain it.
      void vscode.window.showWarningMessage(
        `Local Review: ${found.thread.path} no longer exists. The comment still records the code it was written against.`,
      );
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.anchorTimer) {
      clearTimeout(this.anchorTimer);
    }
    // Retire each widget explicitly; disposing only the controller can leave
    // the rendered threads behind until the editor next repaints.
    this.disposeAllThreads();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.rangeDecoration.dispose();
    this.onDidChangeViewEmitter.dispose();
    this.controller.dispose();
  }
}

function basename(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? uri.path;
}

function sameLines(a: vscode.Range | undefined, b: vscode.Range): boolean {
  return a !== undefined && a.start.line === b.start.line && a.end.line === b.end.line;
}

/**
 * Identity of a thread's rendered content. Hashes comment bodies rather than
 * their length: an external writer (an LLM editing the JSON) changes text
 * without touching `updatedAt`, and a length-based signature would miss it and
 * leave the widget showing stale text.
 */
function threadSignature(thread: ReviewThreadData): string {
  // `outdated` and the snippet are in here because they are rendered into the
  // first comment's body: without them the widget keeps showing the old text
  // long after the thread has come unanchored, or recovered.
  const hash = createHash('sha1').update(thread.status);
  hash.update('\u0000').update(thread.outdated === true ? '1' : '0');
  hash.update('\u0000').update(shownSnippet(thread).join('\n'));
  for (const c of thread.comments) {
    hash.update('\u0000').update(c.id);
    hash.update('\u0000').update(c.updatedAt ?? c.createdAt);
    hash.update('\u0000').update(c.body);
  }
  return hash.digest('base64');
}
