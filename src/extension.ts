import * as vscode from 'vscode';

import { ReviewComment, ReviewCommentsController } from './comments';
import {
  commentToJson,
  commentToMarkdown,
  markdownOptions,
  sessionToJson,
  sessionToMarkdown,
  threadToJson,
  threadToMarkdown,
} from './export';
import { ReviewStore, type ThreadLocation } from './storage';
import { ReviewTreeProvider, type TreeNode } from './tree';
import type { ReviewSessionData } from './types';
import { invalidateAuthorCache, storageUri } from './util';

let activeStore: ReviewStore | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new ReviewStore();
  activeStore = store;
  const comments = new ReviewCommentsController(store);
  const tree = new ReviewTreeProvider(store, comments);

  const view = vscode.window.createTreeView('localReview.sessions', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'localReview.switchSession';

  context.subscriptions.push(store, comments, view, status);

  const refreshUi = () => {
    tree.refresh();
    const sessions = store.allSessions;
    void vscode.commands.executeCommand('setContext', 'localReview.hasSessions', sessions.length > 0);

    const active = store.activeSession;
    view.title = active ? `Review Sessions — ${active.name}` : 'Review Sessions';
    const show = vscode.workspace.getConfiguration('localReview').get<boolean>('showStatusBarItem', true);
    if (!show || !active) {
      status.hide();
      return;
    }
    const open = active.threads.filter((t) => t.status === 'open').length;
    status.text = `$(comment-discussion) ${active.name} · ${open}`;
    status.tooltip = `Local Review — active session "${active.name}", ${open} open thread(s). Click to switch sessions.`;
    status.show();
  };

  context.subscriptions.push(
    store.onDidChange(refreshUi),
    comments.onDidChangeView(refreshUi),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('localReview.author')) {
        invalidateAuthorCache();
      }
      if (e.affectsConfiguration('localReview.showStatusBarItem')) {
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

  const resolveSession = async (arg: unknown, prompt = true): Promise<ReviewSessionData | undefined> => {
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
    const active = store.activeSession;
    if (active) {
      return active;
    }
    return prompt ? pickSession(store, 'Select a review session') : undefined;
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
    void vscode.window.showInformationMessage(`Local Review: started "${session.name}".`);
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
    const session = await resolveSession(arg, false);
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
    const session = await resolveSession(arg, false);
    if (session) {
      comments.setSessionVisible(session.id, true);
    }
  });

  register('localReview.hideSessionInline', async (arg) => {
    const session = await resolveSession(arg, false);
    if (session) {
      comments.setSessionVisible(session.id, false);
    }
  });

  // --- authoring -----------------------------------------------------------

  register('localReview.createThread', (reply: vscode.CommentReply) => comments.createThreadFromReply(reply));
  register('localReview.replyToThread', (reply: vscode.CommentReply) => comments.replyToThread(reply));

  register('localReview.replyToComment', async (arg) => {
    const found = resolveThread(arg);
    if (found) {
      await comments.reveal(found.thread.id);
    }
  });

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
  register('localReview.refresh', () => {
    comments.render();
    refreshUi();
  });
  register('localReview.showCommentsPanel', () =>
    vscode.commands.executeCommand('workbench.panel.comments.view.focus'),
  );

  register('localReview.openThread', async (arg) => {
    const found = resolveThread(arg);
    if (found) {
      await comments.reveal(found.thread.id);
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
  register('localReview.copyAllMarkdown', copySessionMarkdown);
  register('localReview.copyAllJson', copySessionJson);

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

  await store.initialize();
  comments.render();
  refreshUi();
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

export async function deactivate(): Promise<void> {
  // Writes are debounced, so a comment added in the last moments of the session
  // would otherwise never reach disk.
  await activeStore?.flush();
  activeStore = undefined;
}
