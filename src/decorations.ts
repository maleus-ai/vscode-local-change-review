import * as vscode from 'vscode';

import type { ReviewThreadData } from './core/types';

export const THREAD_SCHEME = 'local-review';

/**
 * Session rows carry one too, so the active session's label can be coloured —
 * an icon alone is easy to miss in a list.
 */
export function sessionUri(id: string, active: boolean, unread: number): vscode.Uri {
  return vscode.Uri.from({
    scheme: THREAD_SCHEME,
    path: `/session/${id}`,
    query: `active=${active}&unread=${unread}`,
  });
}

/**
 * Thread rows carry a synthetic `resourceUri` purely so a decoration can colour
 * them — a tree label has one colour, and this is the only way to vary it. The
 * state is encoded in the URI so the decoration is a pure function of it and
 * VS Code's cache invalidates itself when the state changes.
 */
export function threadUri(thread: ReviewThreadData, unread: number): vscode.Uri {
  const state = thread.status === 'resolved' ? 'resolved' : thread.outdated ? 'outdated' : 'open';
  return vscode.Uri.from({
    scheme: THREAD_SCHEME,
    path: `/thread/${thread.id}`,
    query: `state=${state}&unread=${unread}`,
  });
}

export class ReviewDecorationProvider implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== THREAD_SCHEME) {
      return undefined;
    }
    const params = new URLSearchParams(uri.query);
    const unreadHere = Number(params.get('unread')) || 0;

    if (uri.path.startsWith('/session/')) {
      const active = params.get('active') === 'true';
      if (!active && unreadHere === 0) {
        return undefined;
      }
      return {
        badge: unreadHere > 0 ? String(Math.min(99, unreadHere)) : undefined,
        color: active ? new vscode.ThemeColor('charts.blue') : undefined,
        tooltip: [
          active ? 'Active session — new comments go here' : undefined,
          unreadHere > 0 ? `${unreadHere} new comment${unreadHere === 1 ? '' : 's'}` : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
      };
    }

    // One meaning per channel: the icon carries the thread's state, and the
    // badge — rendered at the end of the row — means only "comments you have not
    // read". A number that could be either a reply count or an unread count is
    // worse than no number.
    if (unreadHere > 0) {
      return {
        badge: String(Math.min(99, unreadHere)),
        color: new vscode.ThemeColor('charts.blue'),
        tooltip: `${unreadHere} new comment${unreadHere === 1 ? '' : 's'}`,
      };
    }
    switch (params.get('state')) {
      case 'outdated':
        return {
          color: new vscode.ThemeColor('list.warningForeground'),
          tooltip: 'The commented code was not found in the file',
        };
      case 'resolved':
        return { color: new vscode.ThemeColor('disabledForeground'), tooltip: 'Resolved' };
      default:
        return undefined;
    }
  }
}
