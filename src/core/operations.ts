import type { StoreState } from './files';
import { newId, newSessionId, nowIso } from './ids';
import {
  SESSION_FORMAT_VERSION,
  type ReviewCommentData,
  type ReviewSessionBase,
  type ReviewSessionData,
  type ReviewThreadData,
  type ThreadStatus,
} from './types';

export interface ThreadLocation {
  session: ReviewSessionData;
  thread: ReviewThreadData;
}

export interface CommentLocation extends ThreadLocation {
  comment: ReviewCommentData;
  /** 0 for the thread's opening comment, >0 for replies. */
  index: number;
}

export function allSessions(state: StoreState): ReviewSessionData[] {
  return [...state.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findThread(state: StoreState, threadId: string): ThreadLocation | undefined {
  for (const session of state.sessions.values()) {
    const thread = session.threads.find((t) => t.id === threadId);
    if (thread) {
      return { session, thread };
    }
  }
  return undefined;
}

export function findComment(state: StoreState, commentId: string): CommentLocation | undefined {
  for (const session of state.sessions.values()) {
    for (const thread of session.threads) {
      const index = thread.comments.findIndex((c) => c.id === commentId);
      if (index >= 0) {
        return { session, thread, comment: thread.comments[index], index };
      }
    }
  }
  return undefined;
}

// --- sessions --------------------------------------------------------------

export function createSession(
  state: StoreState,
  name?: string,
  base?: ReviewSessionBase,
  /**
   * Whether the new session becomes the active one. Defaults to only when there
   * is nothing active: an agent starting a session must not silently redirect
   * where the reviewer's own next comment lands.
   */
  activate?: boolean,
): ReviewSessionData {
  let id = newSessionId();
  let suffix = 1;
  while (state.sessions.has(id)) {
    id = `${newSessionId()}-${++suffix}`;
  }
  const session: ReviewSessionData = {
    version: SESSION_FORMAT_VERSION,
    id,
    name: name?.trim() || `Session ${state.sessions.size + 1}`,
    status: 'open',
    createdAt: nowIso(),
    base,
    threads: [],
  };
  state.sessions.set(session.id, session);
  if (activate ?? state.index.activeSessionId === undefined) {
    state.index.activeSessionId = session.id;
  }
  return session;
}

export function renameSession(state: StoreState, id: string, name: string): boolean {
  const session = state.sessions.get(id);
  if (!session || !name.trim()) {
    return false;
  }
  session.name = name.trim();
  return true;
}

export function setActiveSession(state: StoreState, id: string): boolean {
  if (!state.sessions.has(id)) {
    return false;
  }
  state.index.activeSessionId = id;
  return true;
}

export function setSessionStatus(
  state: StoreState,
  id: string,
  status: ReviewSessionData['status'],
): boolean {
  const session = state.sessions.get(id);
  if (!session || session.status === status) {
    return false;
  }
  session.status = status;
  session.closedAt = status === 'closed' ? nowIso() : undefined;
  if (status === 'open') {
    state.index.activeSessionId = id;
  } else if (state.index.activeSessionId === id) {
    state.index.activeSessionId = allSessions(state).find((s) => s.status === 'open')?.id;
  }
  return true;
}

export function deleteSession(state: StoreState, id: string): boolean {
  if (!state.sessions.delete(id)) {
    return false;
  }
  if (state.index.activeSessionId === id) {
    state.index.activeSessionId = allSessions(state).find((s) => s.status === 'open')?.id;
  }
  return true;
}

/**
 * Drops the active pointer if it names a session that is gone or closed.
 *
 * The status check is not decoration. `createSession` only activates a new
 * session when nothing is active, so a closed session left pinned as active is
 * a trap: the new session is never activated and every later default-scoped
 * write files into the closed one. `pickSession` lists closed sessions and
 * `setActiveSession` accepts them, so this is reachable by pointing at one.
 */
export function reconcileActiveSession(state: StoreState): void {
  const active = state.index.activeSessionId;
  if (active && state.sessions.get(active)?.status === 'open') {
    return;
  }
  const open = allSessions(state).filter((s) => s.status === 'open');
  // A quarantined session is open but unwritable, so pointing at it would send
  // every default-scoped write into a refusal. Prefer one that can be written
  // to, and only settle for a quarantined one if it is all there is.
  state.index.activeSessionId = (open.find((s) => !state.readOnly.has(s.id)) ?? open[0])?.id;
}

// --- threads & comments ----------------------------------------------------

export interface NewThreadInput {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string[];
  languageId?: string;
  author: string;
  agent: boolean;
  body: string;
}

export function addThread(
  state: StoreState,
  sessionId: string,
  input: NewThreadInput,
): ReviewThreadData | undefined {
  const session = state.sessions.get(sessionId);
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
    comments: [
      {
        id: newId('comment'),
        author: input.author,
        agent: input.agent,
        body: input.body,
        createdAt: timestamp,
      },
    ],
  };
  session.threads.push(thread);
  return thread;
}

export function addComment(
  state: StoreState,
  threadId: string,
  author: string,
  body: string,
  agent: boolean,
): ReviewCommentData | undefined {
  const found = findThread(state, threadId);
  if (!found) {
    return undefined;
  }
  const comment: ReviewCommentData = {
    id: newId('comment'),
    author,
    agent,
    body,
    createdAt: nowIso(),
  };
  found.thread.comments.push(comment);
  found.thread.updatedAt = comment.createdAt;
  return comment;
}

export function updateComment(state: StoreState, commentId: string, body: string): boolean {
  const found = findComment(state, commentId);
  if (!found || found.comment.body === body) {
    return false;
  }
  found.comment.body = body;
  found.comment.updatedAt = nowIso();
  found.thread.updatedAt = found.comment.updatedAt;
  return true;
}

/** Deleting a thread's last comment deletes the thread. */
export function deleteComment(state: StoreState, commentId: string): boolean {
  const found = findComment(state, commentId);
  if (!found) {
    return false;
  }
  found.thread.comments.splice(found.index, 1);
  if (found.thread.comments.length === 0) {
    found.session.threads = found.session.threads.filter((t) => t.id !== found.thread.id);
  } else {
    found.thread.updatedAt = nowIso();
  }
  return true;
}

export function deleteThread(state: StoreState, threadId: string): boolean {
  const found = findThread(state, threadId);
  if (!found) {
    return false;
  }
  found.session.threads = found.session.threads.filter((t) => t.id !== threadId);
  return true;
}

export function setThreadStatus(
  state: StoreState,
  threadId: string,
  status: ThreadStatus,
): boolean {
  const found = findThread(state, threadId);
  if (!found || found.thread.status === status) {
    return false;
  }
  found.thread.status = status;
  if (status === 'resolved') {
    // The commented code being gone is the point of resolving, not a problem to
    // flag — so resolved supersedes outdated.
    found.thread.outdated = undefined;
  }
  found.thread.updatedAt = nowIso();
  return true;
}

export function updateAnchor(
  state: StoreState,
  threadId: string,
  startLine: number,
  endLine: number,
  snippet: string[],
): boolean {
  const found = findThread(state, threadId);
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
  return true;
}
