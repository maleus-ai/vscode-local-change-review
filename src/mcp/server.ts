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

const files = new ReviewFiles(path.resolve(ROOT, STORAGE));

const REAL_ROOT = (() => {
  try {
    return fs.realpathSync(ROOT);
  } catch {
    return ROOT;
  }
})();

/**
 * The real path of `input`, or undefined when it is not inside the workspace.
 *
 * Resolved through `realpathSync` rather than compared as a string: a symlink
 * inside the workspace would otherwise pass a textual containment check and
 * still read — and persist — a file from anywhere on the machine.
 */
function insideRoot(input: string): string | undefined {
  const abs = path.resolve(ROOT, input);
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    try {
      real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      return undefined;
    }
  }
  const rel = path.relative(REAL_ROOT, real);
  // Compared as path components: `path.relative` returns `..eslintrc.js` for a
  // dotfile of that name sitting in the root, and a bare `startsWith('..')`
  // reads that as an escape. Only `..` alone or `../` is one.
  const escapes = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return rel && !escapes ? real : undefined;
}

const readLines: ReadLines = (stored) => {
  const real = insideRoot(stored);
  if (!real) {
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

/** Workspace-relative POSIX, or undefined for anything outside the workspace. */
function toStoredPath(input: string): string | undefined {
  const real = insideRoot(input);
  return real === undefined ? undefined : toPosix(path.relative(REAL_ROOT, real));
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
 */
function readFresh(): StoreState {
  try {
    return files.transaction((state) => {
      ops.reconcileActiveSession(state);
      reanchorAll(state, readLines);
      return state;
    }).state;
  } catch {
    const state = files.read();
    ops.reconcileActiveSession(state);
    reanchorAll(state, readLines);
    return state;
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
    outdated: thread.status !== 'resolved' && thread.outdated === true,
    author: thread.comments[0]?.author,
    // Null, not false: a comment written before the flag existed is unknown, and
    // reporting it as human hands an agent its own comments back.
    agent: thread.comments[0]?.agent ?? null,
    comments: thread.comments.length,
    lastAuthor: last?.author,
    lastFromAgent: last?.agent ?? null,
    summary: summaryLine(thread.comments[0]?.body ?? ''),
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
    outdated: thread.status !== 'resolved' && thread.outdated === true,
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
      sessions: ops.allSessions(state).map(summariseSession),
    });
  },
);

server.registerTool(
  'create_session',
  {
    title: 'Start a review session',
    description: 'Starts a new review session and makes it active. Use this to begin a fresh round of review.',
    inputSchema: { name: z.string().optional().describe('Human-readable name, e.g. "Round 2"') },
  },
  async ({ name }) => text(summariseSession(files.transaction((s) => ops.createSession(s, name)).result)),
);

server.registerTool(
  'list_threads',
  {
    title: 'List review threads',
    description:
      'Lists review threads with their comments. Line numbers are re-anchored to the current file contents before returning, so they are accurate even if the code moved. A thread marked outdated is one whose commented code could no longer be found.',
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
      return fail(`${file} is outside the workspace.`);
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
    return text({ ...summariseThread(found.session, found.thread), snippet: found.thread.snippet });
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
      sessionId: z.string().optional().describe('Defaults to the active session'),
    },
  },
  async ({ file, startLine, endLine, body, sessionId }) => {
    if (endLine < startLine) {
      return fail('endLine must be greater than or equal to startLine.');
    }
    const stored = toStoredPath(file);
    if (stored === undefined) {
      return fail(
        `${file} is outside the workspace. Only files under the review's workspace root can be commented on.`,
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
      // A pointer at a session that is gone or closed makes every default-scoped
      // call dead-end: the `??` fallback never fires, because the id is a
      // perfectly good string that simply does not resolve.
      ops.reconcileActiveSession(state);
      const id = sessionId ?? state.index.activeSessionId ?? ops.createSession(state).id;
      const session = state.sessions.get(id);
      if (!session) {
        return undefined;
      }
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
      return fail(sessionId ? `No session ${sessionId}.` : 'Could not create the thread.');
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
        return fail(`${file} is outside the workspace.`);
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
