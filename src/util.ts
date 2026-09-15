import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { formatTimestamp, lineLabel, relativeShort, relativeTime, splitLines, toPosix } from './core/format';
import type { ReviewSessionBase } from './types';

// Re-exported so extension-side modules keep a single import site.
export { formatTimestamp, lineLabel, relativeShort, relativeTime, splitLines, toPosix };

export const CONTROLLER_ID = 'localChangeReview';

export function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('localReview');
}

/** The folder review sessions are stored in, or undefined when no folder is open. */
export function storageUri(): vscode.Uri | undefined {
  const root = workspaceRoot();
  if (!root) {
    return undefined;
  }
  const folder = config().get<string>('storageFolder', '.local-review').trim() || '.local-review';
  return vscode.Uri.joinPath(root, ...folder.split(/[\\/]+/).filter(Boolean));
}

export function workspaceRoot(): vscode.Uri | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** Workspace-relative POSIX path, or an absolute path for files outside the workspace. */
export function relPath(uri: vscode.Uri): string {
  const root = workspaceRoot();
  if (root && uri.scheme === root.scheme) {
    const rel = path.relative(root.fsPath, uri.fsPath);
    // Compared as path components: `..eslintrc.js` in the root is not an escape,
    // and calling it one would store an absolute path for a file plainly inside
    // the workspace.
    const escapes = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (rel && !escapes) {
      return toPosix(rel);
    }
  }
  return toPosix(uri.fsPath);
}

export function resolvePath(stored: string): vscode.Uri {
  if (path.isAbsolute(stored)) {
    return vscode.Uri.file(stored);
  }
  const root = workspaceRoot();
  return root ? vscode.Uri.joinPath(root, ...stored.split('/')) : vscode.Uri.file(stored);
}

/** 1-based inclusive line range -> zero-based `vscode.Range` covering whole lines. */
export function toRange(startLine: number, endLine: number): vscode.Range {
  const start = Math.max(0, startLine - 1);
  const end = Math.max(start, endLine - 1);
  return new vscode.Range(start, 0, end, 0);
}

/** `vscode.Range` -> 1-based inclusive line numbers. */
export function fromRange(range: vscode.Range): { startLine: number; endLine: number } {
  return { startLine: range.start.line + 1, endLine: range.end.line + 1 };
}

function run(cmd: string, args: string[], cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 5000 }, (err, stdout) => {
      resolve(err ? undefined : stdout.trim());
    });
  });
}

let cachedAuthor: string | undefined;

export async function resolveAuthor(): Promise<string> {
  const configured = config().get<string>('author', '').trim();
  if (configured) {
    return configured;
  }
  if (cachedAuthor) {
    return cachedAuthor;
  }
  const root = workspaceRoot();
  const fromGit = root ? await run('git', ['config', 'user.name'], root.fsPath) : undefined;
  cachedAuthor = fromGit || os.userInfo().username || 'reviewer';
  return cachedAuthor;
}

/**
 * Forgets the resolved author and works out the new one.
 *
 * Awaitable on purpose: clearing the cache without re-resolving left
 * `currentAuthor()` empty until the next comment was posted, and everything
 * that renders unread counts reads it synchronously.
 */
export async function invalidateAuthorCache(): Promise<string> {
  cachedAuthor = undefined;
  return resolveAuthor();
}

/** The local author, without awaiting — for rendering. Empty until resolved. */
export function currentAuthor(): string {
  return config().get<string>('author', '').trim() || cachedAuthor || '';
}

/** Best-effort git snapshot recorded when a session starts. Absent outside a repo. */
export async function gitBase(): Promise<ReviewSessionBase | undefined> {
  const root = workspaceRoot();
  if (!root || root.scheme !== 'file') {
    return undefined;
  }
  const cwd = root.fsPath;
  const sha = await run('git', ['rev-parse', 'HEAD'], cwd);
  if (sha === undefined) {
    return undefined;
  }
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const status = await run('git', ['status', '--porcelain'], cwd);
  return {
    sha,
    branch: branch && branch !== 'HEAD' ? branch : undefined,
    dirty: status !== undefined && status.length > 0,
  };
}

/** Reads a file's lines, preferring the in-memory document when one is open. */
export async function readLines(uri: vscode.Uri): Promise<string[] | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    return splitLines(open.getText());
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString('utf8').split(/\r?\n/);
  } catch {
    return undefined;
  }
}

export function languageIdFor(uri: vscode.Uri): string | undefined {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    return open.languageId;
  }
  const ext = path.extname(uri.fsPath).slice(1).toLowerCase();
  return ext || undefined;
}

/**
 * Reads a reviewed file's lines synchronously, preferring the in-memory
 * document so unsaved edits are respected. Used for re-anchoring, which must
 * run inside a lock and therefore cannot await.
 */
export function readLinesSync(storedPath: string): string[] | undefined {
  const uri = resolvePath(storedPath);
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    return splitLines(open.getText());
  }
  try {
    return splitLines(fs.readFileSync(uri.fsPath, 'utf8'));
  } catch {
    return undefined;
  }
}
