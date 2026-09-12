import type { StoreState } from './files';
import type { ReviewThreadData } from './types';

export interface Anchor {
  startLine: number;
  endLine: number;
  outdated: boolean;
}

function normalize(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

function matchesAt(lines: string[], snippet: string[], start: number, loose: boolean): boolean {
  if (start < 0 || start + snippet.length > lines.length) {
    return false;
  }
  for (let i = 0; i < snippet.length; i++) {
    const a = lines[start + i];
    const b = snippet[i];
    if (loose ? normalize(a) !== normalize(b) : a !== b) {
      return false;
    }
  }
  return true;
}

/**
 * The occurrence of `snippet` nearest to `hint`, searching outwards from it.
 *
 * Code usually shifts by a few lines, so the answer is almost always within a
 * handful of steps; scanning the whole file and sorting every hit did the same
 * work whether the thread had moved by four lines or not at all.
 *
 * Distance is the outermost loop, so it dominates: a whitespace-insensitive
 * match right here beats an exact one forty lines away. Running a whole-file
 * exact pass before the loose one inverted that, and lost reindented code to
 * any surviving copy of its old text — defeating the loose pass in exactly the
 * case it exists for. Exactness only breaks ties between equidistant hits.
 */
function findNearest(
  lines: string[],
  snippet: string[],
  hint: number,
  allowLoose: boolean,
): number | undefined {
  const last = lines.length - snippet.length;
  if (last < 0) {
    return undefined;
  }
  const start = Math.min(Math.max(hint, 0), last);
  const modes = allowLoose ? [false, true] : [false];
  for (let distance = 0; distance <= Math.max(start, last - start); distance++) {
    const candidates = (distance === 0 ? [start] : [start - distance, start + distance]).filter(
      (c) => c >= 0 && c <= last,
    );
    for (const loose of modes) {
      for (const candidate of candidates) {
        if (matchesAt(lines, snippet, candidate, loose)) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

/**
 * Finds where a thread's captured source now lives.
 *
 * Tries the recorded position first, then an exact match elsewhere, then a
 * whitespace-insensitive one — preferring whichever occurrence is closest to
 * where the thread used to be, since code usually shifts rather than teleports.
 * A thread whose snippet has gone entirely is reported as outdated rather than
 * silently left pointing at whatever now occupies those lines.
 */
export function locate(thread: ReviewThreadData, lines: string[]): Anchor {
  const snippet = thread.snippet;
  const lastLine = Math.max(1, lines.length);
  if (snippet.length === 0) {
    // Nothing was captured, so there is nothing to search for: trust the
    // recorded position, but keep it inside the file — an endLine past EOF is
    // handed straight to the editor and to every export heading.
    return {
      startLine: Math.min(thread.startLine, lastLine),
      endLine: Math.min(thread.endLine, lastLine),
      outdated: thread.startLine > lines.length,
    };
  }

  const hint = thread.startLine - 1;
  if (matchesAt(lines, snippet, hint, false)) {
    // The end comes from the snippet, not from the stored `endLine`: a match
    // proves the snippet occupies exactly `snippet.length` lines from here, and
    // the two can disagree after an outdated clamp has moved the numbers.
    return {
      startLine: thread.startLine,
      endLine: thread.startLine + snippet.length - 1,
      outdated: false,
    };
  }
  const best = findNearest(lines, snippet, hint, true);
  if (best !== undefined) {
    return { startLine: best + 1, endLine: best + snippet.length, outdated: false };
  }
  return {
    startLine: Math.min(thread.startLine, lastLine),
    endLine: Math.min(thread.endLine, lastLine),
    outdated: true,
  };
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

/**
 * Reads a thread's file.
 *
 * Three answers, and the third matters: the lines, `undefined` for a file that
 * is gone or unreadable, and `null` for one the reader is not allowed to look
 * at. The MCP server refuses to read outside the workspace, and threads there
 * must be left alone rather than declared outdated on the strength of a file
 * nobody looked at.
 */
export type ReadLines = (relativePath: string) => string[] | null | undefined;

/**
 * Re-anchors threads against the current contents of their file. Pass
 * `onlyPath` to limit the work to one file — saving one file has no bearing on
 * threads anchored in any other. Returns true if anything moved.
 */
export function reanchorAll(state: StoreState, readLines: ReadLines, onlyPath?: string): boolean {
  const cache = new Map<string, string[] | null | undefined>();
  let changed = false;

  for (const session of state.sessions.values()) {
    for (const thread of session.threads) {
      if (onlyPath !== undefined && thread.path !== onlyPath) {
        continue;
      }
      if (!cache.has(thread.path)) {
        cache.set(thread.path, readLines(thread.path));
      }
      const resolved = thread.status === 'resolved';
      const lines = cache.get(thread.path);
      if (lines === null) {
        // Out of this reader's reach. It has said nothing about whether the file
        // exists, so neither do we: leave the thread exactly as it was.
        continue;
      }
      if (!lines) {
        // File gone or unreadable: say so rather than guessing — unless the
        // thread is resolved, in which case its code being gone is expected.
        const flag = resolved ? undefined : true;
        if (thread.outdated !== flag) {
          thread.outdated = flag;
          changed = true;
        }
        continue;
      }
      const anchor = locate(thread, lines);

      if (anchor.outdated) {
        // The snippet is nowhere in the file. Never re-capture from wherever the
        // clamp landed — the stored snippet is the only record of what was
        // commented on, and overwriting it with unrelated lines is unrecoverable.
        if (resolved) {
          // Its code being gone is the point of resolving, so leave the thread
          // entirely alone rather than moving it to the end of the file.
          if (thread.outdated !== undefined) {
            thread.outdated = undefined;
            changed = true;
          }
          continue;
        }
        if (
          thread.startLine !== anchor.startLine ||
          thread.endLine !== anchor.endLine ||
          thread.outdated !== true
        ) {
          thread.startLine = anchor.startLine;
          thread.endLine = anchor.endLine;
          thread.outdated = true;
          changed = true;
        }
        continue;
      }

      // Compared as well as the position: a whitespace-only edit matches at the
      // recorded position, so nothing else here would notice the snippet is now
      // a stale copy of the code.
      //
      // An empty snippet is the exception and is never filled in. `locate` does
      // not search for one — it just trusts line numbers that may be very old —
      // so re-capturing would invent a record of what was commented on out of
      // whatever happens to sit there now, which is the same unrecoverable loss
      // the not-found branch below refuses to commit.
      const nextSnippet =
        thread.snippet.length === 0 ? thread.snippet : lines.slice(anchor.startLine - 1, anchor.endLine);
      if (
        anchor.startLine !== thread.startLine ||
        anchor.endLine !== thread.endLine ||
        thread.outdated !== undefined ||
        !sameLines(thread.snippet, nextSnippet)
      ) {
        thread.startLine = anchor.startLine;
        thread.endLine = anchor.endLine;
        thread.outdated = undefined;
        thread.snippet = nextSnippet;
        changed = true;
      }
    }
  }
  return changed;
}
