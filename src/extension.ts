import * as vscode from 'vscode';

import { Identities } from './identities';
import { ReviewComment, ReviewCommentsController } from './comments';
import { ReviewDecorationProvider } from './decorations';
import {
  commentToJson,
  commentToMarkdown,
  fileToJson,
  fileToMarkdown,
  markdownOptions,
  sessionToJson,
  sessionToMarkdown,
  threadToJson,
  threadToMarkdown,
} from './export';
import { disposeLog, initLog, log, showLog } from './log';
import { PullRequestWatcher } from './prwatch';
import { SourceWatcher } from './sourcewatch';
import { ReviewStore, type ThreadLocation } from './storage';
import { ReviewTreeProvider, type TreeNode } from './tree';
import { UnreadTracker } from './unread';
import type { ReviewSessionData } from './types';
import { invalidateAuthorCache, readLinesSync, relPath, resolveAuthor, storageUri } from './util';

const SUSPEND_KEY = 'localReview.suspended';

let activeComments: ReviewCommentsController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLog();
  log('activate', { version: context.extension.packageJSON.version });
  const store = new ReviewStore();
  const identities = new Identities(context.globalStorageUri);
  const comments = new ReviewCommentsController(store, identities);
  activeComments = comments;
  const unread = new UnreadTracker(context.workspaceState);
  const tree = new ReviewTreeProvider(store, comments, identities, unread);
  const prWatcher = new PullRequestWatcher();

  const view = vscode.window.createTreeView('localReview.sessions', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'localReview.switchSession';

  context.subscriptions.push(
    store,
    comments,
    view,
    status,
    prWatcher,
    identities,
    unread,
    vscode.window.registerFileDecorationProvider(new ReviewDecorationProvider()),
  );

  // "19 minutes ago" is only true for a minute, so redraw the rows while the
  // panel is on screen.
  // Re-anchors the threads in one file the moment it changes on disk, whoever
  // changed it. Without this only an open document or a save announced itself,
  // so a thread in a file an agent rewrote went on claiming to be anchored.
  const sourceWatcher = new SourceWatcher((storedPath) => store.reanchor(readLinesSync, storedPath));
  context.subscriptions.push(sourceWatcher);

  const clock = setInterval(() => {
    if (view.visible) {
      // Only a fallback: the watcher covers this, except where a review is
      // spread across more directories than it will watch.
      if (!sourceWatcher.watching) {
        store.reanchor(readLinesSync);
      }
      tree.refresh();
    }
  }, 60_000);
  context.subscriptions.push(new vscode.Disposable(() => clearInterval(clock)));

  let manualSuspend = context.workspaceState.get<boolean>(SUSPEND_KEY, false);
  const suspendReason = (): string | undefined => {
    if (manualSuspend) {
      return 'suspended';
    }
    return prWatcher.isReviewing ? 'suspended during pull request review' : undefined;
  };
  const applySuspension = () => comments.setSuspended(manualSuspend || prWatcher.isReviewing);

  // Read marks are the one piece of state that cannot be rebuilt, and
  // `ReviewFiles.read()` never throws — an unreadable folder, a branch switch
  // that takes `.local-review` away, a session file caught mid-write, or a
  // storage-folder change all read as simply "no sessions". Pruning against
  // that wipes every mark. So prune only against a read we have reason to
  // trust: the store is up, and it has not just gone empty on us.
  let sawSessions = false;
  const refreshUi = () => {
    tree.refresh();
    const sessions = store.allSessions;
    sourceWatcher.update(sessions.flatMap((s) => s.threads.map((t) => t.path)));
    if (sessions.length > 0) {
      sawSessions = true;
    }
    if (store.ready && !(sessions.length === 0 && sawSessions)) {
      unread.prune(new Set(sessions.flatMap((s) => s.threads.map((t) => t.id))));
    }
    const reason = suspendReason();
    void vscode.commands.executeCommand('setContext', 'localReview.hasSessions', sessions.length > 0);
    void vscode.commands.executeCommand('setContext', 'localReview.suspended', comments.isSuspended);
    void vscode.commands.executeCommand('setContext', 'localReview.enabled', comments.canComment());

    const active = store.activeSession;
    view.title = active
      ? `Review Sessions — ${active.name}${reason ? ' (suspended)' : ''}`
      : 'Review Sessions';
    const show = vscode.workspace.getConfiguration('localReview').get<boolean>('showStatusBarItem', true);
    if (!show || (!active && sessions.length === 0)) {
      status.hide();
      return;
    }
    if (reason) {
      status.text = '$(debug-pause) Local Review suspended';
      status.tooltip =
        reason === 'suspended'
          ? 'Local Review is suspended — no comments in the editor. Click to resume.'
          : 'Local Review is suspended while a GitHub pull request review is open, so it does not compete with the Pull Request extension. Click to resume.';
      status.command = 'localReview.resume';
      status.show();
      return;
    }
    if (!active) {
      status.hide();
      return;
    }
    const open = active.threads.filter((t) => t.status === 'open').length;
    status.text = `$(comment-discussion) ${active.name} · ${open}`;
    status.tooltip = `Local Review — active session "${active.name}", ${open} open thread(s). Click to switch sessions.`;
    status.command = 'localReview.switchSession';
    status.show();
  };

  context.subscriptions.push(
    store.onDidChange(refreshUi),
    comments.onDidChangeView(refreshUi),
    prWatcher.onDidChange(() => {
      applySuspension();
      refreshUi();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localReview.author')) {
        // Re-resolved and then repainted: the unread badges are computed against
        // this name, and leaving it empty counts nothing as unread until the
        // next comment is posted.
        void invalidateAuthorCache().then(() => {
          comments.rebuild();
          tree.refresh();
        });
      }
      if (
        e.affectsConfiguration('localReview.avatars') ||
        e.affectsConfiguration('localReview.authorName') ||
        e.affectsConfiguration('localReview.githubUsers')
      ) {
        identities.invalidate();
        comments.rebuild();
        tree.refresh();
      }
      if (
        e.affectsConfiguration('localReview.showStatusBarItem') ||
        e.affectsConfiguration('localReview.commenting')
      ) {
        refreshUi();
      }
    }),
  );

  // --- argument resolution -------------------------------------------------

  const asComment = (arg: unknown): ReviewComment | undefined =>
    arg instanceof ReviewComment ? arg : undefined;

  const asThread = (arg: unknown): vscode.CommentThread | undefined => {
    const candidate = arg as vscode.CommentThread | undefined;
    return candidate && candidate.uri && candidate.range && Array.isArray(candidate.comments)
      ? candidate
      : undefined;
  };

  const asNode = (arg: unknown): TreeNode | undefined => {
    const candidate = arg as TreeNode | undefined;
    return candidate && typeof candidate === 'object' && 'kind' in candidate && 'sessionId' in candidate
      ? candidate
      : undefined;
  };

  /** Thread targeted by a command, wherever it was invoked from. */
  const resolveThread = (arg: unknown): ThreadLocation | undefined => {
    const comment = asComment(arg);
    if (comment) {
      return store.findThread(comment.threadId);
    }
    const node = asNode(arg);
    if (node && (node.kind === 'thread' || node.kind === 'comment')) {
      return store.findThread(node.threadId);
    }
    const live = asThread(arg);
    if (live) {
      return comments.locate(live);
    }
    return undefined;
  };

  const resolveSession = async (
    arg: unknown,
    options: { fallbackToActive?: boolean } = {},
  ): Promise<ReviewSessionData | undefined> => {
    const node = asNode(arg);
    if (node) {
      const session = store.getSession(node.sessionId);
      if (session) {
        return session;
      }
    }
    const thread = resolveThread(arg);
    if (thread) {
      return thread.session;
    }
    const selected = view.selection.find((s) => s.kind === 'session');
    if (selected) {
      const session = store.getSession(selected.sessionId);
      if (session) {
        return session;
      }
    }
    // Only commands that genuinely mean "the one I am working in" fall back to
    // the active session; the rest ask, because guessing a destructive target is
    // worse than one extra click.
    if (options.fallbackToActive !== false) {
      const active = store.activeSession;
      if (active) {
        return active;
      }
    }
    return pickSession(store, 'Select a review session');
  };

  /** The file row a command was invoked on, falling back to the tree selection. */
  const resolveFile = (arg: unknown): { session: ReviewSessionData; path: string } | undefined => {
    const node = asNode(arg) ?? view.selection.find((n) => n.kind === 'file');
    if (!node || node.kind !== 'file') {
      return undefined;
    }
    const session = store.getSession(node.sessionId);
    return session ? { session, path: node.path } : undefined;
  };

  const copy = async (text: string, what: string): Promise<void> => {
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`$(check) Local Review: ${what} copied`, 3000);
  };

  const register = (id: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  // --- sessions --------------------------------------------------------------

  register('localReview.newSession', async () => {
    if (!store.ready) {
      void vscode.window.showWarningMessage('Local Review: open a folder before starting a session.');
      return;
    }
    const suggestion = `Session ${store.allSessions.length + 1}`;
    const name = await vscode.window.showInputBox({
      title: 'Start a new review session',
      prompt: 'Name this session',
      value: suggestion,
      valueSelection: [0, suggestion.length],
    });
    if (name === undefined) {
      return;
    }
    const session = await store.createSession(name);
    if (session) {
      void vscode.window.showInformationMessage(`Local Review: started "${session.name}".`);
    }
  });

  register('localReview.switchSession', async () => {
    const session = await pickSession(store, 'Set the active review session');
    if (session) {
      store.setActiveSession(session.id);
    }
  });

  register('localReview.setActiveSession', async (arg) => {
    const session = await resolveSession(arg);
    if (session) {
      store.setActiveSession(session.id);
    }
  });

  register('localReview.renameSession', async (arg) => {
    const session = await resolveSession(arg);
    if (!session) {
      return;
    }
    const name = await vscode.window.showInputBox({
      title: 'Rename review session',
      value: session.name,
    });
    if (name !== undefined) {
      await store.renameSession(session.id, name);
    }
  });

  register('localReview.closeSession', async (arg) => {
    const session = await resolveSession(arg);
    if (session) {
      store.setSessionStatus(session.id, 'closed');
    }
  });

  register('localReview.reopenSession', async (arg) => {
    const session = await resolveSession(arg);
    if (session) {
      store.setSessionStatus(session.id, 'open');
    }
  });

  register('localReview.deleteSession', async (arg) => {
    const session = await resolveSession(arg, { fallbackToActive: false });
    if (!session) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete "${session.name}" and its ${session.threads.length} thread(s)?`,
      { modal: true },
      'Delete',
    );
    if (answer === 'Delete') {
      await store.deleteSession(session.id);
    }
  });

  register('localReview.showSessionInline', async (arg) => {
    const session = await resolveSession(arg, { fallbackToActive: false });
    if (session) {
      comments.setSessionVisible(session.id, true);
    }
  });

  register('localReview.hideSessionInline', async (arg) => {
    const session = await resolveSession(arg, { fallbackToActive: false });
    if (session) {
      comments.setSessionVisible(session.id, false);
    }
  });

  // --- authoring -----------------------------------------------------------

  register('localReview.createThread', (reply: vscode.CommentReply) => comments.createThreadFromReply(reply));
  register('localReview.replyToThread', (reply: vscode.CommentReply) => comments.replyToThread(reply));

  register('localReview.commentOnSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    await comments.startThreadOnSelection(editor);
  });

  register('localReview.editComment', async (arg) => {
    const comment = asComment(arg);
    if (comment) {
      comments.startEditing(comment);
      return;
    }
    const node = asNode(arg);
    if (node && node.kind === 'comment') {
      const found = store.findComment(node.commentId);
      if (!found) {
        return;
      }
      const body = await vscode.window.showInputBox({
        title: 'Edit review comment',
        value: found.comment.body,
      });
      if (body !== undefined) {
        store.updateComment(node.commentId, body);
      }
    }
  });

  register('localReview.saveComment', (arg) => {
    const comment = asComment(arg);
    if (comment) {
      comments.saveEdit(comment);
    }
  });

  register('localReview.cancelEditComment', (arg) => {
    const comment = asComment(arg);
    if (comment) {
      comments.cancelEdit(comment);
    }
  });

  register('localReview.deleteComment', async (arg) => {
    const comment = asComment(arg);
    const node = asNode(arg);
    const commentId = comment?.commentId ?? (node && node.kind === 'comment' ? node.commentId : undefined);
    if (!commentId) {
      return;
    }
    const found = store.findComment(commentId);
    if (!found) {
      return;
    }
    const last = found.thread.comments.length === 1;
    const answer = await vscode.window.showWarningMessage(
      last ? 'Delete this comment and its thread?' : 'Delete this comment?',
      { modal: true },
      'Delete',
    );
    if (answer === 'Delete') {
      store.deleteComment(commentId);
    }
  });

  register('localReview.deleteThread', async (arg) => {
    const found = resolveThread(arg);
    if (!found) {
      return;
    }
    const answer = await vscode.window.showWarningMessage(
      `Delete this thread and its ${found.thread.comments.length} comment(s)?`,
      { modal: true },
      'Delete',
    );
    if (answer === 'Delete') {
      store.deleteThread(found.thread.id);
    }
  });

  register('localReview.resolveThread', (arg) => {
    const found = resolveThread(arg);
    if (found) {
      store.setThreadStatus(found.thread.id, 'resolved');
      comments.collapse(found.thread.id);
    }
  });

  register('localReview.unresolveThread', (arg) => {
    const found = resolveThread(arg);
    if (found) {
      store.setThreadStatus(found.thread.id, 'open');
    }
  });

  // --- folding & navigation ------------------------------------------------

  register('localReview.collapseThread', (arg) => {
    const live = asThread(arg);
    if (live) {
      comments.collapse(live);
      return;
    }
    const found = resolveThread(arg);
    if (found) {
      comments.collapse(found.thread.id);
    }
  });

  register('localReview.collapseAllThreads', () => comments.setAllCollapsed(true));
  register('localReview.expandAllThreads', () => comments.setAllCollapsed(false));
  register('localReview.reanchor', () => {
    const moved = store.reanchor(readLinesSync);
    vscode.window.setStatusBarMessage(
      moved ? '$(check) Local Review: comments re-anchored' : '$(check) Local Review: anchors already current',
      3000,
    );
  });

  register('localReview.refresh', () => {
    // Re-read first: "it hasn't updated" is usually a missed change, not a
    // mis-drawn widget, and there was previously no way to force a re-read.
    store.refreshFromDisk();
    comments.rebuild();
    refreshUi();
  });
  register('localReview.suspend', async () => {
    manualSuspend = true;
    await context.workspaceState.update(SUSPEND_KEY, true);
    applySuspension();
    refreshUi();
  });

  register('localReview.resume', async () => {
    manualSuspend = false;
    await context.workspaceState.update(SUSPEND_KEY, false);
    applySuspension();
    refreshUi();
    if (!prWatcher.isReviewing) {
      return;
    }
    const answer = await vscode.window.showInformationMessage(
      'Local Review stays suspended while a GitHub pull request review is open, so its comments do not compete with the Pull Request extension.',
      'Comment during PR reviews anyway',
    );
    if (answer) {
      await vscode.workspace
        .getConfiguration('localReview')
        .update('autoSuspendDuringPullRequestReview', false, vscode.ConfigurationTarget.Workspace);
      prWatcher.refresh();
      applySuspension();
      refreshUi();
    }
  });

  register('localReview.diagnostics', async () => {
    const details = {
      version: context.extension.packageJSON.version,
      storageFolder: storageUri()?.fsPath ?? '(no folder open)',
      sessions: store.allSessions.map((x) => ({
        name: x.name,
        id: x.id,
        status: x.status,
        threads: x.threads.length,
        comments: x.threads.reduce((n, t) => n + t.comments.length, 0),
      })),
      activeSession: store.activeSession?.name ?? null,
      pullRequestReviewDetected: prWatcher.isReviewing,
      identities: identities.describe(),
      manualSuspend,
      ...comments.stats(),
    };
    const text = JSON.stringify(details, null, 2);
    const stats = comments.stats();
    const answer = await vscode.window.showInformationMessage(
      `Local Review: ${stats.liveThreads} thread widget(s), ${stats.trackedWidgets} tracked, ` +
        `${stats.orphanWidgets} orphan(ed).`,
      'Copy Details',
    );
    if (answer) {
      await vscode.env.clipboard.writeText(text);
    }
  });

  register('localReview.showCommentsPanel', () =>
    vscode.commands.executeCommand('workbench.panel.comments.view.focus'),
  );

  register('localReview.showLog', () => showLog());

  register('localReview.openThread', async (arg) => {
    log('command: openThread');
    const found = resolveThread(arg);
    if (found) {
      // Opening it is reading it.
      unread.markRead(found.thread);
      tree.refresh();
      await comments.reveal(found.thread.id);
    }
  });

  register('localReview.markRead', (arg) => {
    const found = resolveThread(arg);
    if (found) {
      unread.markRead(found.thread);
    }
  });

  // See the note on copyAllMarkdown: no argument means the title bar, which
  // means every session. Getting this wrong on markAllUnread destroyed read
  // state for a session the user was not even looking at.
  register('localReview.markAllRead', async (arg) => {
    if (arg === undefined) {
      unread.markAllRead(store.allSessions.flatMap((s) => s.threads));
      return;
    }
    const session = await resolveSession(arg);
    if (session) {
      unread.markAllRead(session.threads);
    }
  });

  register('localReview.markAllUnread', async (arg) => {
    if (arg === undefined) {
      unread.markAllUnread(store.allSessions.flatMap((s) => s.threads));
      return;
    }
    const session = await resolveSession(arg);
    if (session) {
      unread.markAllUnread(session.threads);
    }
  });

  register('localReview.openStorageFolder', async () => {
    const uri = storageUri();
    if (!uri) {
      void vscode.window.showWarningMessage('Local Review: no folder is open.');
      return;
    }
    await vscode.commands.executeCommand('revealInExplorer', uri);
  });

  // --- copy & export -------------------------------------------------------

  register('localReview.copyCommentMarkdown', async (arg) => {
    const target = commentTarget(arg);
    if (target) {
      await copy(commentToMarkdown(target.thread, target.comment), 'comment (Markdown)');
    }
  });

  register('localReview.copyCommentJson', async (arg) => {
    const target = commentTarget(arg);
    if (target) {
      await copy(commentToJson(target.session, target.thread, target.comment), 'comment (JSON)');
    }
  });

  register('localReview.copyFileMarkdown', async (arg) => {
    const target = resolveFile(arg);
    if (target) {
      await copy(fileToMarkdown(target.session, target.path), `${target.path} (Markdown)`);
    }
  });

  register('localReview.copyFileJson', async (arg) => {
    const target = resolveFile(arg);
    if (target) {
      await copy(fileToJson(target.session, target.path), `${target.path} (JSON)`);
    }
  });

  register('localReview.copyThreadMarkdown', async (arg) => {
    const found = resolveThread(arg);
    if (found) {
      await copy(threadToMarkdown(found.thread, markdownOptions(), 2), 'thread (Markdown)');
    }
  });

  register('localReview.copyThreadJson', async (arg) => {
    const found = resolveThread(arg);
    if (found) {
      await copy(threadToJson(found.session, found.thread), 'thread (JSON)');
    }
  });

  /** "3 sessions (Markdown)" — what the clipboard actually received. */
  const everything = (sessions: readonly ReviewSessionData[], format: string) =>
    sessions.length === 1
      ? `"${sessions[0].name}" (${format})`
      : `${sessions.length} sessions (${format})`;

  const copySessionMarkdown = async (arg: unknown) => {
    const session = await resolveSession(arg);
    if (session) {
      await copy(sessionToMarkdown(session), `"${session.name}" (Markdown)`);
    }
  };
  const copySessionJson = async (arg: unknown) => {
    const session = await resolveSession(arg);
    if (session) {
      await copy(sessionToJson(session), `"${session.name}" (JSON)`);
    }
  };

  register('localReview.copySessionMarkdown', copySessionMarkdown);
  register('localReview.copySessionJson', copySessionJson);

  // The "All" commands sit in the panel's title bar, where VS Code passes no
  // argument at all — so they cannot mean "the row you clicked", and falling
  // back to the active session made a button labelled "All" copy exactly one
  // session, silently chosen. With no argument they mean the whole panel; the
  // context-menu entries on a session row still pass their node and stay
  // session-scoped.
  register('localReview.copyAllMarkdown', async (arg) => {
    if (arg !== undefined) {
      return copySessionMarkdown(arg);
    }
    const sessions = store.allSessions;
    if (sessions.length === 0) {
      return;
    }
    await copy(sessions.map((s) => sessionToMarkdown(s)).join('\n\n---\n\n'), everything(sessions, 'Markdown'));
  });
  register('localReview.copyAllJson', async (arg) => {
    if (arg !== undefined) {
      return copySessionJson(arg);
    }
    const sessions = store.allSessions;
    if (sessions.length === 0) {
      return;
    }
    await copy(
      `[\n${sessions.map((s) => sessionToJson(s)).join(',\n')}\n]`,
      everything(sessions, 'JSON'),
    );
  });

  register('localReview.exportSession', async (arg) => {
    const session = await resolveSession(arg);
    const root = storageUri();
    if (!session || !root) {
      return;
    }
    const format = await vscode.window.showQuickPick(
      [
        { label: 'Markdown', description: 'Ready to paste into an LLM prompt', value: 'md' as const },
        { label: 'JSON', description: 'Structured, machine-readable', value: 'json' as const },
      ],
      { title: `Export "${session.name}"`, placeHolder: 'Choose a format' },
    );
    if (!format) {
      return;
    }
    const target = vscode.Uri.joinPath(root, 'exports', `${session.id}.${format.value}`);
    const content = format.value === 'md' ? sessionToMarkdown(session) : sessionToJson(session);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'exports'));
    await vscode.workspace.fs.writeFile(target, Buffer.from(content, 'utf8'));
    const open = await vscode.window.showInformationMessage(
      `Local Review: exported "${session.name}".`,
      'Open',
    );
    if (open === 'Open') {
      await vscode.window.showTextDocument(target);
    }
  });

  function commentTarget(arg: unknown) {
    const comment = asComment(arg);
    if (comment) {
      return store.findComment(comment.commentId);
    }
    const node = asNode(arg);
    if (node && node.kind === 'comment') {
      return store.findComment(node.commentId);
    }
    // Thread-level invocation: fall back to the thread's opening comment.
    const found = resolveThread(arg);
    const first = found?.thread.comments[0];
    return first ? store.findComment(first.id) : undefined;
  }

  context.subscriptions.push(
    // Catch up on anything the watcher missed while attention was elsewhere.
    vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        store.refreshFromDisk();
        // And on any file rewritten meanwhile. Only open documents announce
        // themselves; a thread in a file an agent edited while it was closed
        // would otherwise go on claiming to be anchored.
        store.reanchor(readLinesSync);
      }
    }),
    view.onDidChangeVisibility((e) => {
      if (e.visible) {
        store.refreshFromDisk();
      }
    }),
    identities.onDidChange(() => {
      comments.rebuild();
      tree.refresh();
    }),
    unread.onDidChange(() => tree.refresh()),
  );
  context.subscriptions.push(
    vscode.authentication.onDidChangeSessions((e) => {
      if (e.provider.id === 'github') {
        void identities.resolveGitHubAccount().then((changed) => {
          if (changed) {
            comments.rebuild();
            tree.refresh();
          }
        });
      }
    }),
  );
  void identities.resolveGitHubAccount().then((changed) => {
    if (changed) {
      comments.rebuild();
      tree.refresh();
    }
  });

  // Awaited, not fired and forgotten. The first paint counts unread comments
  // against this name, and a badge on every comment you wrote yourself is the
  // worst possible first impression for a notification.
  await resolveAuthor();

  await store.initialize();
  // Files may have been rewritten by anything at all since the last session.
  store.reanchor(readLinesSync);
  applySuspension();
  comments.render();
  refreshUi();

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file') {
        store.reanchor(readLinesSync, relPath(doc.uri));
      }
    }),
  );
}

async function pickSession(store: ReviewStore, title: string): Promise<ReviewSessionData | undefined> {
  const sessions = store.allSessions;
  if (sessions.length === 0) {
    void vscode.window.showInformationMessage('Local Review: no review sessions yet.');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    sessions.map((r) => ({
      label: r.id === store.activeSessionId ? `$(circle-filled) ${r.name}` : `$(circle-outline) ${r.name}`,
      description: `${r.threads.filter((t) => t.status === 'open').length} open · ${r.status}`,
      detail: r.id,
      session: r,
    })),
    { title, placeHolder: 'Review sessions, newest first' },
  );
  return picked?.session;
}

export function deactivate(): void {
  // Synchronous, and with nothing left to flush: every write already committed
  // to disk inside a locked transaction. Threads go first so the editor gets an
  // explicit disposal for each before the host is torn down.
  log('deactivate');
  activeComments?.dispose();
  disposeLog();
  activeComments = undefined;
}
