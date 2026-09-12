import * as path from 'path';

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
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

/** "19 minutes ago", matching how the built-in Comments view reads. */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return iso;
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) {
    return 'just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }
  return formatTimestamp(iso);
}

/** Compact form for tree rows, where "19 minutes ago" is mostly noise. */
export function relativeShort(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return '';
  }
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) {
    return 'now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days}d`;
  }
  const weeks = Math.round(days / 7);
  return weeks < 5 ? `${weeks}w` : formatTimestamp(iso).slice(0, 10);
}

const INLINE_MARKDOWN =
  /(\*\*|__)(.+?)\1|`([^`]+)`|!?\[([^\]]*)\]\([^)]*\)|(?<![*\w])(\*|_)(?!\s)(.+?)(?<!\s)\5(?![*\w])|~~(.+?)~~/g;

/**
 * First meaningful line of a Markdown body, with the inline syntax removed.
 *
 * Fenced blocks are skipped so a body that opens with code gets a label from
 * its prose rather than reading `` ```ts ``. They are skipped a line at a time
 * because a fence only opens at the start of a line: a regex matching ```
 * anywhere ate the rest of any sentence that mentioned one.
 */
export function summaryLine(body: string, maxLength = 140): string {
  let fence: string | undefined;
  for (const raw of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence !== undefined) {
      // A fence closes on the same character, at least as long as the opener.
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (!raw.trim()) {
      continue;
    }
    const stripped = raw
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s{0,3}[-*+]\s+/, '')
      .replace(INLINE_MARKDOWN, (...m) => m[2] ?? m[3] ?? m[4] ?? m[6] ?? m[7] ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    if (stripped) {
      return stripped.slice(0, maxLength);
    }
  }
  return '';
}

/**
 * Splits file text into lines, dropping the empty string a trailing newline
 * produces. Almost every file ends with a newline, and counting the phantom
 * line makes a range one past the end look valid.
 */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}
