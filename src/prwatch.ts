import * as vscode from 'vscode';

import { config } from './util';

const PR_EXTENSION_ID = 'GitHub.vscode-pull-request-github';

/**
 * Best-effort detection of "the GitHub Pull Request extension is mid-review".
 *
 * There is no API for its review mode, so this watches for open tabs whose URI
 * scheme belongs to that extension (its diffs and PR descriptions do not use
 * `file:`). The scheme list is a setting precisely because it is a guess about
 * another extension's internals.
 */
export class PullRequestWatcher implements vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  private reviewing = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.window.tabGroups.onDidChangeTabs(() => this.refresh()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.refresh()),
      vscode.extensions.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('localReview.autoSuspendDuringPullRequestReview') ||
          e.affectsConfiguration('localReview.pullRequestSchemes')
        ) {
          this.refresh();
        }
      }),
    );
    this.reviewing = this.detect();
  }

  get isReviewing(): boolean {
    return this.reviewing;
  }

  refresh(): void {
    const next = this.detect();
    if (next !== this.reviewing) {
      this.reviewing = next;
      this.onDidChangeEmitter.fire(next);
    }
  }

  private detect(): boolean {
    if (!config().get<boolean>('autoSuspendDuringPullRequestReview', true)) {
      return false;
    }
    if (!vscode.extensions.getExtension(PR_EXTENSION_ID)) {
      return false;
    }
    const schemes = new Set(
      config()
        .get<string[]>('pullRequestSchemes', [])
        .map((s) => s.toLowerCase()),
    );
    if (schemes.size === 0) {
      return false;
    }
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        for (const uri of tabUris(tab.input)) {
          if (schemes.has(uri.scheme.toLowerCase())) {
            return true;
          }
        }
      }
    }
    return false;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.onDidChangeEmitter.dispose();
  }
}

function tabUris(input: unknown): vscode.Uri[] {
  if (input instanceof vscode.TabInputText) {
    return [input.uri];
  }
  if (input instanceof vscode.TabInputCustom) {
    return [input.uri];
  }
  if (input instanceof vscode.TabInputNotebook) {
    return [input.uri];
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return [input.original, input.modified];
  }
  if (input instanceof vscode.TabInputNotebookDiff) {
    return [input.original, input.modified];
  }
  return [];
}
