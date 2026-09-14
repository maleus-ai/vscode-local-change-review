import * as path from 'path';
import * as vscode from 'vscode';

import type { ReviewCommentsController } from './comments';
import type { Identities } from './identities';
import type { UnreadTracker } from './unread';
import { currentAuthor } from './util';
import type { ReviewStore } from './storage';
import type { ReviewSessionData, ReviewThreadData } from './types';
import { shownSnippet } from './core/export';
import { hardBreaks, summaryLine } from './core/format';
import { sessionUri, threadUri } from './decorations';
import { formatTimestamp, lineLabel, relativeShort, relativeTime, resolvePath } from './util';

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
    private readonly identities: Identities,
    private readonly unread: UnreadTracker,
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
    const me = currentAuthor();
    const unread = session.threads.reduce((n, t) => n + this.unread.unread(t, me), 0);
    item.description = [
      isActive ? 'active' : undefined,
      `${open} open`,
      resolved > 0 ? `${resolved} resolved` : undefined,
      session.status === 'closed' ? 'closed' : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
    item.resourceUri = sessionUri(session.id, isActive, unread);
    item.iconPath = session.status === 'closed'
      ? new vscode.ThemeIcon('check-all', new vscode.ThemeColor('disabledForeground'))
      : isActive
        ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'))
        : new vscode.ThemeIcon('circle-outline');
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
    item.iconPath = vscode.ThemeIcon.File;
    item.description = path.posix.dirname(filePath) === '.' ? undefined : path.posix.dirname(filePath);
    const unread = threads.reduce((n, t) => n + this.unread.unread(t, currentAuthor()), 0);
    item.description = [item.description, unread > 0 ? `${unread} new` : undefined]
      .filter(Boolean)
      .join(' · ');
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
      summaryLabel(first?.body ?? ''),
      thread.comments.length > 1
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `thread:${thread.id}`;
    const unread = this.unread.unread(thread, currentAuthor());
    // No counts here: the badge at the end of the row already carries the unread
    // count, and the expand chevron already says there are replies.
    item.description = [
      `Ln ${lineLabel(thread.startLine, thread.endLine)}`,
      first ? this.identities.displayName(first.author) : undefined,
      first?.agent ? 'agent' : undefined,
      first ? relativeShort(first.createdAt) : undefined,
    ]
      .filter((b): b is string => Boolean(b))
      .join(' · ');
    item.resourceUri = threadUri(thread, unread);
    // The icon is the thread's state and nothing else, so a resolved thread still
    // reads as resolved when it has comments you have not seen.
    item.iconPath =
      thread.status === 'resolved'
        ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
        : thread.outdated
          ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
          : new vscode.ThemeIcon('comment');
    item.contextValue =
      `thread ${thread.status}` +
      `${thread.outdated && thread.status !== 'resolved' ? ' outdated' : ''}` +
      `${unread > 0 ? ' unread' : ''}`;
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
    const item = new vscode.TreeItem(summaryLabel(comment.body), vscode.TreeItemCollapsibleState.None);
    item.id = `comment:${comment.id}`;
    item.description = [
      this.identities.displayName(comment.author),
      comment.agent ? 'agent' : undefined,
      relativeShort(comment.createdAt),
    ]
      .filter(Boolean)
      .join(' · ');
    item.iconPath = new vscode.ThemeIcon('reply', new vscode.ThemeColor('descriptionForeground'));
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

/** A tree label is a plain string — VS Code renders no Markdown in one. */
function summaryLabel(body: string): vscode.TreeItemLabel {
  return { label: summaryLine(body) || '(empty)' };
}

function threadTooltip(thread: ReviewThreadData): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`\`${thread.path}:${lineLabel(thread.startLine, thread.endLine)}\`\n\n`);
  const snippet = shownSnippet(thread);
  if (snippet.length) {
    md.appendCodeblock(snippet.slice(0, 12).join('\n'), thread.languageId);
  }
  for (const comment of thread.comments) {
    md.appendMarkdown(
      `\n**${comment.author}** · ${relativeTime(comment.createdAt)} · ${formatTimestamp(comment.createdAt)}\n\n${hardBreaks(comment.body)}\n`,
    );
  }
  return md;
}
