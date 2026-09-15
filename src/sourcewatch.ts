import * as path from 'path';
import * as vscode from 'vscode';

import { log } from './log';
import { relPath, resolvePath } from './util';

/** Per-file quiet period. Long enough to coalesce a write, short enough to feel immediate. */
const DEBOUNCE_MS = 300;

/**
 * Beyond this many distinct directories, watch nothing. VS Code creates a real
 * OS watcher per pattern, and a review spread that wide is better served by the
 * periodic sweep the caller falls back to.
 */
const MAX_DIRECTORIES = 64;

/**
 * Watches the source files a review has comments in, so a thread notices its
 * code has changed underneath it.
 *
 * Only the editor announces edits to documents it has open, and only the user
 * saving announces anything at all — which left a thread in a file an agent
 * rewrote claiming to be anchored until the window was reloaded. This watches
 * the files themselves, so the trigger is the edit rather than someone
 * happening to look.
 *
 * Watchers are per *directory* rather than per file: a review usually touches
 * far fewer directories than files, and each pattern costs an OS watcher.
 */
export class SourceWatcher implements vscode.Disposable {
  private watchers: vscode.FileSystemWatcher[] = [];
  private watched = new Set<string>();
  private directories = '';
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /** False when the path set is too broad to watch, so the caller keeps polling. */
  watching = true;

  constructor(private readonly onChanged: (storedPath: string) => void) {}

  /**
   * Points the watcher at the files that currently have threads. Cheap to call
   * on every store change: the OS watchers are only rebuilt when the set of
   * directories actually differs.
   */
  update(storedPaths: Iterable<string>): void {
    const paths = new Set(storedPaths);
    const directories = new Set<string>();
    for (const stored of paths) {
      directories.add(path.dirname(resolvePath(stored).fsPath));
    }
    this.watched = paths;

    const key = [...directories].sort().join(' ');
    if (key === this.directories) {
      return; // same directories; the path set alone needs no new watchers
    }
    this.directories = key;
    this.disposeWatchers();

    this.watching = directories.size <= MAX_DIRECTORIES;
    if (!this.watching) {
      log('source watcher off: too many directories', { count: directories.size });
      return;
    }
    for (const directory of directories) {
      // Non-recursive, one directory deep: `*` rather than `**/*`, so a busy
      // subtree elsewhere costs nothing.
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(directory), '*'),
      );
      const fire = (uri: vscode.Uri) => this.schedule(uri);
      watcher.onDidChange(fire);
      watcher.onDidCreate(fire);
      watcher.onDidDelete(fire);
      this.watchers.push(watcher);
    }
    log('source watcher', { directories: directories.size, files: paths.size });
  }

  private schedule(uri: vscode.Uri): void {
    const stored = relPath(uri);
    if (!this.watched.has(stored)) {
      return; // a neighbour in a directory we watch for something else
    }
    const existing = this.timers.get(stored);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      stored,
      setTimeout(() => {
        this.timers.delete(stored);
        log('source changed', { file: stored });
        this.onChanged(stored);
      }, DEBOUNCE_MS),
    );
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) {
      watcher.dispose();
    }
    this.watchers = [];
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.disposeWatchers();
  }
}
