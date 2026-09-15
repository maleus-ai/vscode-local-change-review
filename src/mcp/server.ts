#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { type ReadLines, reanchorAll } from '../core/anchor';
import {
  DEFAULT_MARKDOWN_OPTIONS,
  fileToMarkdown,
  sessionToMarkdown,
  shownSnippet,
  threadToMarkdown,
} from '../core/export';
import { ReviewFiles, type StoreState } from '../core/files';
import * as ops from '../core/operations';
import { splitLines, summaryLine, toPosix } from '../core/format';
import type { ReviewSessionData, ReviewThreadData } from '../core/types';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const ROOT = path.resolve(arg('root') ?? process.env.LOCAL_REVIEW_ROOT ?? process.cwd());
const STORAGE = arg('storage') ?? process.env.LOCAL_REVIEW_STORAGE ?? '.local-review';
/** Comments written through this server are attributed here. */
const AUTHOR = arg('author') ?? process.env.LOCAL_REVIEW_AUTHOR ?? 'claude';

const STORE = path.resolve(ROOT, STORAGE);
const files = new ReviewFiles(STORE);

/**
 * The directory the review is *about*, which is what stored paths are relative
 * to — and not necessarily this server's working directory.
 *
 * Found by resolving the store through any symlinks and climbing back out by as
 * many segments as the storage folder has. That matters because the store is
 * the shared thing: point a `.local-review` in a subdirectory at the one in the
 * repository root (a symlink is the obvious way) and two clients write to the
 * same files while disagreeing about what `src/core/x.ts` means. Every thread
 * one of them wrote then reads as outdated to the other, because the path
 * resolves to nothing.
 *
 * With no symlink in play this is exactly ROOT, and nothing changes.
 */
const REVIEW_ROOT = (() => {
  const depth = STORAGE.split(/[\\/]+/).filter((part) => part && part !== '.').length;
  let root = realStore();
  if (root === undefined) {
    // No store yet, so there is nothing to disagree with.
    try {
      return fs.realpathSync(ROOT);
    } catch {
      return ROOT;
    }
  }
  for (let i = 0; i < depth; i++) {
    root = path.dirname(root);
  }
  return root;
})();

/**
 * Where the store really lives, following a symlink even when its target does
 * not exist yet. `realpathSync` gives up on a dangling one, which would answer
 * "no store" on the first run and something different on the next — and the
 * review root has to be the same answer every time.
 */
function realStore(): string | undefined {
  try {
    return fs.realpathSync(STORE);
  } catch {
    /* missing, or a symlink pointing at something not yet created */
  }
  try {
    if (fs.lstatSync(STORE).isSymbolicLink()) {
      return path.resolve(path.dirname(STORE), fs.readlinkSync(STORE));
    }
  } catch {
    /* not a symlink either */
  }
  return undefined;
}

const REAL_ROOT = (() => {
  try {
    return fs.realpathSync(ROOT);
  } catch {
    return ROOT;
  }
})();

/** The real path of `input` resolved against `base`, symlinks and all. */
function realPathOf(base: string, input: string): string | undefined {
  const abs = path.resolve(base, input);
  try {
    return fs.realpathSync(abs);
  } catch {
    try {
      // The file may not exist yet; its directory still has to.
      return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return undefined;
    }
  }
}

/** Whether `real` is the review root or somewhere beneath it. */
function withinReview(real: string): boolean {
  const rel = path.relative(REVIEW_ROOT, real);
  // Compared as path components: `path.relative` returns `..eslintrc.js` for a
  // dotfile of that name sitting in the root, and a bare `startsWith('..')`
  // reads that as an escape. Only `..` alone or `../` is one.
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * The real path of a file the caller named, or undefined when it is not inside
 * the review.
 *
 * Tried against this server's working directory first, so an agent running in a
 * subdirectory can name files the way it sees them, then against the review
 * root, so paths copied out of the review itself work too. Resolved through
 * `realpathSync` rather than compared as a string: a symlink inside the tree
 * would otherwise pass a textual containment check and still read — and
 * persist — a file from anywhere on the machine.
 */
function insideRoot(input: string): string | undefined {
  for (const base of REAL_ROOT === REVIEW_ROOT ? [REAL_ROOT] : [REAL_ROOT, REVIEW_ROOT]) {
    const real = realPathOf(base, input);
    if (real && withinReview(real) && (base === REAL_ROOT || fs.existsSync(real))) {
      return real;
    }
  }
  return undefined;
}

const readLines: ReadLines = (stored) => {
  // Resolved against the review root, never the working directory: a stored
  // path is review-relative by definition.
  const real = path.isAbsolute(stored) ? realPathOf('/', stored) : realPathOf(REVIEW_ROOT, stored);
  if (!real || !withinReview(real)) {
    // Out of our reach is not the same as gone. A thread may legitimately be
    // anchored to an absolute path outside the workspace — the editor creates
    // those — and this server must not read there. Saying "unreadable" made
    // `reanchorAll` mark such threads outdated and persist that: an amber
    // warning, and an export claiming the code was not found, about a file
    // that is sitting right where it always was.
    return null;
  }
  try {
    return splitLines(fs.readFileSync(real, 'utf8'));
  } catch {
    return undefined;
  }
};

/**
 * Relative to the review root, POSIX-separated, or undefined for anything
 * outside the review. Never relative to this server's working directory: the
 * store is shared, so the paths in it have to mean one thing.
 */
function toStoredPath(input: string): string | undefined {
  const real = insideRoot(input);
  return real === undefined ? undefined : toPosix(path.relative(REVIEW_ROOT, real));
}

/**
 * Reads with anchors refreshed, so line numbers reflect the code as it is now.
 *
 * Persisting the refresh is a convenience, not the point. `transaction` refuses
 * to write a session it cannot represent losslessly — deliberately, to stop
 * silent data loss — and routing reads through it turned one quarantined file
 * into a hard failure for `list_sessions`, `get_thread`, `export_markdown` and
 * every other read, including reads that named a perfectly healthy session. So
 * a refused write degrades to an in-memory re-anchor: accurate line numbers,
 * nothing written, and the quarantine still protecting the file.
 *
 * `recapture: false` throughout. Line numbers and the outdated flag are facts
 * about where the code is, and worth recording; the snippet is the record of
 * what the review is about, and an agent reading a review has no business
 * rewriting that.
 */
function readFresh(): StoreState {
  const refresh = (state: StoreState): StoreState => {
    ops.reconcileActiveSession(state);
    reanchorAll(state, readLines, { recapture: false });
    return state;
  };
  try {
    return files.transaction(refresh).state;
  } catch {
    return refresh(files.read());
  }
}

const text = (value: unknown) => ({
  content: [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
});
const fail = (message: string) => ({ ...text(message), isError: true });

function summariseSession(session: ReviewSessionData) {
  const open = session.threads.filter((t) => t.status === 'open').length;
  return {
    id: session.id,
    name: session.name,
    status: session.status,
    createdAt: session.createdAt,
    base: session.base,
    threads: session.threads.length,
    openThreads: open,
    resolvedThreads: session.threads.length - open,
  };
}

/**
 * What a detached thread was written about, or undefined while it is anchored.
 *
 * `startLine`/`endLine` on a detached thread are a last known position clamped
 * to the file's length — they point at whatever now occupies them, which is not
 * the code the comment is about. These are the numbers and the source as they
 * were when the thread was opened, so the comment stays readable.
 */
function originalOf(thread: ReviewThreadData) {
  if (thread.outdated !== true) {
    return undefined;
  }
  return {
    startLine: thread.originalStartLine ?? thread.startLine,
    endLine: thread.originalEndLine ?? thread.endLine,
    snippet: shownSnippet(thread),
    note: 'The code this comment was written about is no longer in the file. These are the lines and the source as they were when the thread was opened; startLine/endLine above are a last known position and point at unrelated code.',
  };
}

/** Id, location and one line — enough to choose what to open, at a fraction of the tokens. */
function compactThread(session: ReviewSessionData, thread: ReviewThreadData) {
  const last = thread.comments[thread.comments.length - 1];
  return {
    threadId: thread.id,
    sessionId: session.id,
    file: thread.path,
    startLine: thread.startLine,
    endLine: thread.endLine,
    status: thread.status,
    // Reported truthfully even on a resolved thread. `resolved` supersedes
    // `outdated` in what the editor LABELS, so a thread already dealt with does
    // not also nag — but an agent needs the fact, and the tool description
    // promises it.
    outdated: thread.outdated === true,
    author: thread.comments[0]?.author,
    // Null, not false: a comment written before the flag existed is unknown, and
    // reporting it as human hands an agent its own comments back.
    agent: thread.comments[0]?.agent ?? null,
    comments: thread.comments.length,
    lastAuthor: last?.author,
    lastFromAgent: last?.agent ?? null,
    summary: summaryLine(thread.comments[0]?.body ?? ''),
    original: originalOf(thread) && {
      startLine: thread.originalStartLine ?? thread.startLine,
      endLine: thread.originalEndLine ?? thread.endLine,
    },
  };
}

function summariseThread(session: ReviewSessionData, thread: ReviewThreadData) {
  return {
    threadId: thread.id,
    sessionId: session.id,
    file: thread.path,
    startLine: thread.startLine,
    endLine: thread.endLine,
    status: thread.status,
    outdated: thread.outdated === true,
    original: originalOf(thread),
    author: thread.comments[0]?.author,
    comments: thread.comments.map((c) => ({
      id: c.id,
      author: c.author,
      // Null, not false, exactly as `compactThread` reports it: a comment
      // written before the flag existed is unknown, and two shapes disagreeing
      // about the same comment is worse than either being wrong consistently.
      agent: c.agent ?? null,
      body: c.body,
      createdAt: c.createdAt,
      edited: c.updatedAt !== undefined,
    })),
  };
}

const server = new McpServer({ name: 'local-review', version: '0.6.0' });

server.registerTool(
  'list_sessions',
  {
    title: 'List review sessions',
    description:
      'Lists every local review session with its thread counts. The active session is the one new threads go into.',
    inputSchema: {},
  },
  async () => {
    const state = readFresh();
    return text({
      activeSessionId: state.index.activeSessionId,
      sessions: ops.allSessions(state).map((session) => ({
        ...summariseSession(session),
        active: session.id === state.index.activeSessionId,
      })),
    });
  },
);

server.registerTool(
  'create_session',
  {
    title: 'Start a review session',
    description:
      'Starts a new review session. It becomes the active one ONLY if no session was active — the active session belongs to the reviewer in the editor, and starting a round of your own does not take it from them. The result says which happened. Either way, pass the id it returns as `sessionId` on every create_thread.',
    inputSchema: { name: z.string().optional().describe('Human-readable name, e.g. "Round 2"') },
  },
  async ({ name }) => {
    const { result, state } = files.transaction((s) => ops.createSession(s, name));
    const active = state.index.activeSessionId === result.id;
    const current = state.index.activeSessionId
      ? state.sessions.get(state.index.activeSessionId)
      : undefined;
    return text({
      ...summariseSession(result),
      active,
      // Spelled out because assuming otherwise is a silent, expensive mistake:
      // every thread written without a sessionId would land somewhere else and
      // read back as an empty session.
      note: active
        ? 'This session is now the active one, because nothing else was. Still pass sessionId on create_thread: the reviewer can change the active session at any moment.'
        : `This session was NOT made active — ${current ? `"${current.name}" (${current.id})` : 'another session'} still is. Pass sessionId: "${result.id}" on every create_thread, or your threads will go somewhere else.`,
    });
  },
);

server.registerTool(
  'list_threads',
  {
    title: 'List review threads',
    description:
      'Lists review threads with their comments. Line numbers are re-anchored to the current file contents before returning, so they are accurate even if the code moved. A thread marked outdated is one whose commented code could no longer be found: its startLine/endLine point at unrelated code, and its `original` gives the lines and the source as they were when the comment was written.',
    inputSchema: {
      sessionId: z.string().optional().describe('Defaults to the active session'),
      file: z.string().optional().describe('Only threads anchored in this file'),
      status: z
        .enum(['open', 'resolved', 'all'])
        .optional()
        .describe(
          'open (default) for threads still needing attention, resolved for closed ones, all for both',
        ),
      author: z
        .string()
        .optional()
        .describe('Only threads opened by this author, matched case-insensitively'),
      needsReply: z
        .boolean()
        .optional()
        .describe(
          `Only threads whose most recent comment is not by "${AUTHOR}" — that is, the ones still waiting on a response from you`,
        ),
      agent: z
        .boolean()
        .optional()
        .describe(
          'true for threads opened by an agent, false for threads opened by a person in the editor',
        ),
      compact: z
        .boolean()
        .optional()
        .describe(
          'Return one summary line per thread instead of every comment body. Use this to survey a session, then get_thread for the ones that matter',
        ),
    },
  },
  async ({ sessionId, file, status, author, needsReply, agent, compact }) => {
    const state = readFresh();
    const id = sessionId ?? state.index.activeSessionId;
    const session = id ? state.sessions.get(id) : undefined;
    if (!session) {
      return fail(id ? `No session ${id}.` : 'No active session. Call create_session first.');
    }
    const wanted = status ?? 'open';
    const storedFile = file ? toStoredPath(file) : undefined;
    if (file && storedFile === undefined) {
      // Refused, not answered with an empty list. `create_thread` already says
      // this, and reporting the same mistake as "there are no threads here"
      // reads as a fact about the review rather than about the argument.
      return fail(`${file} is outside the review (${REVIEW_ROOT}).`);
    }
    const wantedAuthor = author?.trim().toLowerCase();
    const threads = session.threads
      .filter((t) => (wanted === 'all' ? true : t.status === wanted))
      .filter((t) => (storedFile ? t.path === storedFile : true))
      .filter((t) => !wantedAuthor || t.comments[0]?.author.toLowerCase() === wantedAuthor)
      .filter((t) => !needsReply || t.comments[t.comments.length - 1]?.author !== AUTHOR)
      .filter((t) => agent === undefined || t.comments[0]?.agent === agent);
    return text({
      session: summariseSession(session),
      threads: threads.map((t) => (compact ? compactThread(session, t) : summariseThread(session, t))),
    });
  },
);

server.registerTool(
  'get_thread',
  {
    title: 'Get one review thread',
    description: 'Returns a single thread including the source lines the comment is anchored to.',
    inputSchema: { threadId: z.string() },
  },
  async ({ threadId }) => {
    const found = ops.findThread(readFresh(), threadId);
    if (!found) {
      return fail(`No thread ${threadId}.`);
    }
    // `snippet` is what the thread is about — which, once the code is gone, is
    // what it was opened on rather than whatever now occupies those lines.
    return text({ ...summariseThread(found.session, found.thread), snippet: shownSnippet(found.thread) });
  },
);

server.registerTool(
  'create_thread',
  {
    title: 'Comment on lines',
    description:
      'Opens a new review thread on a range of lines. Line numbers are 1-based and inclusive; the source at that range is captured so the comment survives later edits.',
    inputSchema: {
      file: z.string().describe('Path relative to the workspace root'),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
      body: z.string().trim().min(1, 'body must not be empty').describe('The comment, in Markdown'),
      sessionId: z
        .string()
        .describe(
          'The session to file this thread in. Required, and deliberately so: defaulting to the active session meant a thread could land in one you did not choose — either because the session you had just created was never made active, or because the reviewer changed the active one while you were working. Use the id from create_session or list_sessions.',
        ),
    },
  },
  async ({ file, startLine, endLine, body, sessionId }) => {
    if (endLine < startLine) {
      return fail('endLine must be greater than or equal to startLine.');
    }
    const stored = toStoredPath(file);
    if (stored === undefined) {
      return fail(
        `${file} is outside the review. Only files under ${REVIEW_ROOT} can be commented on.`,
      );
    }
    const lines = readLines(stored);
    if (!lines) {
      return fail(`Cannot read ${stored}.`);
    }
    if (startLine > lines.length) {
      return fail(`${stored} has ${lines.length} lines; startLine ${startLine} is past the end.`);
    }
    if (endLine > lines.length) {
      return fail(`${stored} has ${lines.length} lines; endLine ${endLine} is past the end.`);
    }
    const snippet = lines.slice(startLine - 1, endLine);
    if (snippet.every((line) => line.trim() === '')) {
      // A blank snippet matches any blank line, so such a thread would drift
      // between them on every re-anchor and never report itself outdated.
      return fail(`${stored}:${startLine}-${endLine} is blank; comment on a range with code in it.`);
    }
    const outcome = files.transaction((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) {
        return undefined;
      }
      const id = session.id;
      const thread = ops.addThread(state, id, {
        path: stored,
        startLine,
        endLine,
        snippet,
        languageId: path.extname(stored).slice(1) || undefined,
        author: AUTHOR,
        agent: true,
        body,
      });
      return thread ? { session, thread } : undefined;
    });
    if (!outcome.result) {
      return fail(`No session ${sessionId}. Call list_sessions to see which ids exist.`);
    }
    return text(summariseThread(outcome.result.session, outcome.result.thread));
  },
);

server.registerTool(
  'add_comment',
  {
    title: 'Reply to a thread',
    description: 'Adds a reply to an existing review thread. Use this to answer a reviewer or record what you changed.',
    inputSchema: {
      threadId: z.string(),
      body: z.string().trim().min(1, 'body must not be empty').describe('The reply, in Markdown'),
    },
  },
  async ({ threadId, body }) => {
    const outcome = files.transaction((s) => ops.addComment(s, threadId, AUTHOR, body, true));
    if (!outcome.result) {
      return fail(`No thread ${threadId}.`);
    }
    const found = ops.findThread(outcome.state, threadId)!;
    return text(summariseThread(found.session, found.thread));
  },
);

/**
 * Resolution is the reviewer's call. This server may only close threads it
 * opened itself — otherwise an agent could mark its own work reviewed and the
 * human would never see what it claims to have done.
 */
/**
 * Resolving is the reviewer's call. This server may only close threads it opened
 * itself — otherwise an agent could mark its own work reviewed and the human
 * would never see what it claims to have done.
 */
function resolveThread(threadId: string) {
  const outcome = files.transaction((state) => {
    const found = ops.findThread(state, threadId);
    if (!found) {
      return { error: `No thread ${threadId}.` };
    }
    const opener = found.thread.comments[0]?.author;
    if (opener !== AUTHOR) {
      return {
        error:
          `Thread ${threadId} was opened by ${opener ? `"${opener}"` : 'nobody'}, not "${AUTHOR}". ` +
          `Only the author of a thread can resolve it — reply with what you changed and leave the ` +
          `decision to them. They can resolve it in the Local Review panel.`,
      };
    }
    ops.setThreadStatus(state, threadId, 'resolved');
    return { thread: summariseThread(found.session, found.thread) };
  }).result;
  return outcome.error ? fail(outcome.error) : text(outcome.thread);
}

/**
 * Reopening is deliberately not restricted the way resolving is: it destroys
 * nothing, and a reviewer may well have closed something the agent has good
 * reason to believe is unfixed.
 *
 * It does always post a comment. Reopening and explaining why are one action, not
 * two an agent might do only half of — a thread that springs back open with no
 * explanation is worse than one left closed.
 */
function reopenThread(threadId: string, comment: string) {
  const outcome = files.transaction((state) => {
    const found = ops.findThread(state, threadId);
    if (!found) {
      return { error: `No thread ${threadId}.` };
    }
    if (found.thread.status === 'open') {
      return { error: `Thread ${threadId} is already open. Use add_comment to say something in it.` };
    }
    ops.addComment(state, threadId, AUTHOR, comment, true);
    ops.setThreadStatus(state, threadId, 'open');
    return { thread: summariseThread(found.session, found.thread) };
  }).result;
  return outcome.error ? fail(outcome.error) : text(outcome.thread);
}

server.registerTool(
  'resolve_thread',
  {
    title: 'Resolve a thread',
    description:
      'Marks a thread resolved. Only threads opened by this server can be resolved; a reviewer resolves their own in the editor.',
    inputSchema: { threadId: z.string() },
  },
  async ({ threadId }) => resolveThread(threadId),
);

server.registerTool(
  'unresolve_thread',
  {
    title: 'Reopen a thread',
    description:
      'Reopens a resolved thread — including one someone else opened, when you have reason to believe the issue is not actually fixed. The comment is posted to the thread in the same step, so reopening always says why.',
    inputSchema: {
      threadId: z.string(),
      comment: z
        .string()
        .trim()
        .min(1, 'reopening a thread must say why')
        .describe('Why this is not settled. Posted to the thread as a comment'),
    },
  },
  async ({ threadId, comment }) => reopenThread(threadId, comment),
);

server.registerTool(
  'export_markdown',
  {
    title: 'Export review as Markdown',
    description:
      'Renders a session, a file, or a single thread as Markdown with the commented source inline — the form meant for reading.',
    inputSchema: {
      sessionId: z.string().optional().describe('Defaults to the active session'),
      file: z.string().optional().describe('Limit to threads in this file'),
      threadId: z.string().optional().describe('Render just this thread'),
      includeResolved: z
        .boolean()
        .optional()
        .describe('Include resolved threads as well as open ones. Defaults to false'),
    },
  },
  async ({ sessionId, file, threadId, includeResolved }) => {
    const state = readFresh();
    const options = { ...DEFAULT_MARKDOWN_OPTIONS, includeResolved: includeResolved ?? false };
    if (threadId) {
      const found = ops.findThread(state, threadId);
      return found ? text(threadToMarkdown(found.thread, options, 2)) : fail(`No thread ${threadId}.`);
    }
    const id = sessionId ?? state.index.activeSessionId;
    const session = id ? state.sessions.get(id) : undefined;
    if (!session) {
      return fail(id ? `No session ${id}.` : 'No active session.');
    }
    if (file) {
      const stored = toStoredPath(file);
      if (stored === undefined) {
        return fail(`${file} is outside the review (${REVIEW_ROOT}).`);
      }
      return text(fileToMarkdown(session, stored, options));
    }
    return text(sessionToMarkdown(session, options));
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  process.stderr.write(`local-review mcp: ${String(err)}\n`);
  process.exit(1);
});
