import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import type { ReviewSessionBase } from './types';

export const CONTROLLER_ID = 'localChangeReview';

export function nowIso(): string {
  return new Date().toISOString();
}

let idCounter = 0;
export function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 0xffff;
  const random = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}${random}`;
}

export function sessionId(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `session-${stamp}`;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

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
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
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

export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export function lineLabel(startLine: number, endLine: number): string {
  return startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;
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

export function invalidateAuthorCache(): void {
  cachedAuthor = undefined;
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
    return open.getText().split(/\r?\n/);
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
