/**
 * On-disk shapes. These are the contract for anything that reads
 * `.local-review/**` outside the extension (an LLM, a script, a human), so they
 * are deliberately flat, stable and free of VS Code types.
 */

export const SESSION_FORMAT_VERSION = 1;
export const INDEX_FORMAT_VERSION = 1;

export interface ReviewCommentData {
  id: string;
  author: string;
  /**
   * Whether this was written by an agent through the MCP server rather than by a
   * person in the editor. Absent on comments written before the flag existed,
   * which is not the same as `false`.
   */
  agent?: boolean;
  body: string;
  createdAt: string;
  updatedAt?: string;
}

export type ThreadStatus = 'open' | 'resolved';

export interface ReviewThreadData {
  id: string;
  /** Workspace-relative, POSIX-separated. Absolute for files outside the workspace. */
  path: string;
  /** 1-based, inclusive on both ends. */
  startLine: number;
  endLine: number;
  /**
   * The source lines this thread currently sits on, refreshed as the code is
   * edited. This is what re-anchoring searches for, so keeping it current is
   * what lets a thread follow code through many small changes.
   */
  snippet: string[];
  /**
   * The code as it was when the thread was opened, and where it sat. Written
   * once and never rewritten — the only record of what a comment was actually
   * about, which `snippet`/`startLine` cannot be because they track the code as
   * it moves, and are clamped to nothing in particular once it is gone.
   *
   * Absent on threads created before these fields existed; fall back to the
   * live ones rather than inventing a value.
   */
  original?: string[];
  originalStartLine?: number;
  originalEndLine?: number;
  languageId?: string;
  status: ThreadStatus;
  /**
   * Set when the commented code can no longer be found in the file, so the line
   * numbers are a last known position rather than a live one.
   */
  outdated?: boolean;
  createdAt: string;
  updatedAt: string;
  comments: ReviewCommentData[];
}

export type SessionStatus = 'open' | 'closed';

export interface ReviewSessionBase {
  branch?: string;
  sha?: string;
  /** Whether the working tree had uncommitted changes when the session started. */
  dirty?: boolean;
}

export interface ReviewSessionData {
  version: number;
  id: string;
  name: string;
  status: SessionStatus;
  createdAt: string;
  closedAt?: string;
  base?: ReviewSessionBase;
  threads: ReviewThreadData[];
}

export interface ReviewIndexData {
  version: number;
  activeSessionId?: string;
}
