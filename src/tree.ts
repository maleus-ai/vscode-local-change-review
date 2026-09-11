import * as path from 'path';
import * as vscode from 'vscode';

import type { ReviewCommentsController } from './comments';
import type { ReviewStore } from './storage';
import type { ReviewSessionData, ReviewThreadData } from './types';
import { formatTimestamp, lineLabel, resolvePath } from './util';

export type TreeNode =
  | { kind: 'session'; sessionId: string }
  | { kind: 'file'; sessionId: string; path: string }
  | { kind: 'thread'; sessionId: string; threadId: string }
  | { kind: 'comment'; sessionId: string; threadId: string; commentId: string };

export class ReviewTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(
    private readonly store: ReviewStore,
    private readonly comments: ReviewCommentsController,
  ) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      return this.store.allSessions.map((r) => ({ kind: 'session' as const, sessionId: r.id }));
    }
    const session = this.store.getSession(element.sessionId);
    if (!session) {
      return [];
    }
    switch (element.kind) {
      case 'session': {
        const paths: string[] = [];
        for (const thread of session.threads) {
          if (!paths.includes(thread.path)) {
            paths.push(thread.path);
          }
        }
        return paths.map((p) => ({ kind: 'file' as const, sessionId: session.id, path: p }));
      }
      case 'file':
        return session.threads
          .filter((t) => t.path === element.path)
          .map((t) => ({ kind: 'thread' as const, sessionId: session.id, threadId: t.id }));
      case 'thread': {
        const thread = session.threads.find((t) => t.id === element.threadId);
        // The opening comment is already the thread's label; only replies add rows.
        return (thread?.comments ?? []).slice(1).map((c) => ({
          kind: 'comment' as const,
          sessionId: session.id,
          threadId: element.threadId,
          commentId: c.id,
        }));
      }
      case 'comment':
        return [];
    }
  }

  getParent(element: TreeNode): TreeNode | undefined {
    switch (element.kind) {
      case 'session':
        return undefined;
      case 'file':
        return { kind: 'session', sessionId: element.sessionId };
      case 'thread': {
        const thread = this.store.findThread(element.threadId)?.thread;
        return thread ? { kind: 'file', sessionId: element.sessionId, path: thread.path } : undefined;
      }
      case 'comment':
        return { kind: 'thread', sessionId: element.sessionId, threadId: element.threadId };
    }
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    const session = this.store.getSession(element.sessionId);
    if (!session) {
      return new vscode.TreeItem('(missing session)');
    }
    switch (element.kind) {
      case 'session':
        return this.sessionItem(session);
      case 'file':
        return this.fileItem(session, element.path);
      case 'thread':
        return this.threadItem(session, element.threadId);
      case 'comment':
        return this.commentItem(session, element.threadId, element.commentId);
    }
  }

  private sessionItem(session: ReviewSessionData): vscode.TreeItem {
    const open = session.threads.filter((t) => t.status === 'open').length;
    const resolved = session.threads.length - open;
    const isActive = session.id === this.store.activeSessionId;
    const isVisible = this.comments.isSessionVisible(session.id);

    const item = new vscode.TreeItem(
      session.name,
      session.threads.length > 0
        ? isActive
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `session:${session.id}`;
    const bits = [`${open} open`];
    if (resolved > 0) {
      bits.push(`${resolved} resolved`);
    }
    if (isActive) {
      bits.push('active');
    }
    if (session.status === 'closed') {
      bits.push('closed');
    }
    item.description = bits.join(' · ');
    item.iconPath = new vscode.ThemeIcon(
      session.status === 'closed' ? 'check-all' : isActive ? 'circle-filled' : 'circle-outline',
    );
    item.contextValue = [
      'session',
      isActive ? 'isactive' : 'notactive',
      session.status,
      isVisible ? 'visible' : 'hidden',
    ].join(' ');

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${session.name}**\n\n`);
    tooltip.appendMarkdown(`Started ${formatTimestamp(session.createdAt)}\n\n`);
    if (session.base?.branch || session.base?.sha) {
      const sha = session.base.sha ? ` \`${session.base.sha.slice(0, 8)}\`` : '';
      tooltip.appendMarkdown(`Base: \`${session.base.branch ?? 'detached'}\`${sha}\n\n`);
    }
    tooltip.appendMarkdown(`${session.threads.length} thread(s) · comments ${isVisible ? 'shown' : 'hidden'} in editor`);
    item.tooltip = tooltip;
    return item;
  }

  private fileItem(session: ReviewSessionData, filePath: string): vscode.TreeItem {
    const threads = session.threads.filter((t) => t.path === filePath);
    const item = new vscode.TreeItem(
      path.posix.basename(filePath),
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `file:${session.id}:${filePath}`;
    item.resourceUri = resolvePath(filePath);
    item.description = path.posix.dirname(filePath) === '.' ? undefined : path.posix.dirname(filePath);
    item.tooltip = `${filePath} — ${threads.length} thread(s)`;
    item.contextValue = 'file';
    return item;
  }

  private threadItem(session: ReviewSessionData, threadId: string): vscode.TreeItem {
    const thread = session.threads.find((t) => t.id === threadId);
    if (!thread) {
      return new vscode.TreeItem('(missing thread)');
    }
    const first = thread.comments[0];
    const item = new vscode.TreeItem(
      firstLine(first?.body ?? '(empty)'),
      thread.comments.length > 1
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `thread:${thread.id}`;
    const replies = thread.comments.length - 1;
    item.description = `Ln ${lineLabel(thread.startLine, thread.endLine)}${replies > 0 ? ` · ${replies} repl${replies === 1 ? 'y' : 'ies'}` : ''}`;
    item.iconPath = new vscode.ThemeIcon(thread.status === 'resolved' ? 'pass-filled' : 'comment');
    item.contextValue = `thread ${thread.status}`;
    item.tooltip = threadTooltip(thread);
    item.command = {
      command: 'localReview.openThread',
      title: 'Go to Review Comment',
      arguments: [{ kind: 'thread', sessionId: session.id, threadId: thread.id } satisfies TreeNode],
    };
    return item;
  }

  private commentItem(session: ReviewSessionData, threadId: string, commentId: string): vscode.TreeItem {
    const thread = session.threads.find((t) => t.id === threadId);
    const comment = thread?.comments.find((c) => c.id === commentId);
    if (!thread || !comment) {
      return new vscode.TreeItem('(missing comment)');
    }
    const item = new vscode.TreeItem(firstLine(comment.body), vscode.TreeItemCollapsibleState.None);
    item.id = `comment:${comment.id}`;
    item.description = `${comment.author} · ${formatTimestamp(comment.createdAt)}`;
    item.iconPath = new vscode.ThemeIcon('reply');
    item.contextValue = 'comment';
    const tooltip = new vscode.MarkdownString(comment.body);
    tooltip.supportHtml = false;
    item.tooltip = tooltip;
    item.command = {
      command: 'localReview.openThread',
      title: 'Go to Review Comment',
      arguments: [{ kind: 'thread', sessionId: session.id, threadId } satisfies TreeNode],
    };
    return item;
  }
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? text;
  return line.trim().slice(0, 120) || '(empty)';
}

function threadTooltip(thread: ReviewThreadData): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`\`${thread.path}:${lineLabel(thread.startLine, thread.endLine)}\`\n\n`);
  if (thread.snippet.length) {
    md.appendCodeblock(thread.snippet.slice(0, 12).join('\n'), thread.languageId);
  }
  for (const comment of thread.comments) {
    md.appendMarkdown(`\n**${comment.author}** · ${formatTimestamp(comment.createdAt)}\n\n${comment.body}\n`);
  }
  return md;
}
