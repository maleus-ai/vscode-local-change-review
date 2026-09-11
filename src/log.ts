import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('Local Review', { log: true });
  return channel;
}

/** Traces widget lifecycle so a rendering fault can be read off a timeline. */
export function log(message: string, detail?: unknown): void {
  if (!channel) {
    return;
  }
  channel.info(detail === undefined ? message : `${message} ${JSON.stringify(detail)}`);
}

export function showLog(): void {
  channel?.show(true);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
}
