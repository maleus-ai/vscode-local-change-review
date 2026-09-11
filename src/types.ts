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
  /** The source lines the comment was anchored to, captured at write time. */
  snippet: string[];
  languageId?: string;
  status: ThreadStatus;
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
