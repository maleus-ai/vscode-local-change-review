import { formatTimestamp, lineLabel } from './format';
import type { ReviewCommentData, ReviewSessionData, ReviewThreadData } from './types';

/** How a comment body is delimited from the surrounding document. */
export type CommentStyle = 'blockquote' | 'fenced' | 'plain';

export interface MarkdownOptions {
  commentStyle: CommentStyle;
  includeCode: boolean;
  includeLineNumbers: boolean;
  includeResolved: boolean;
  maxCodeLines: number;
}

export const DEFAULT_MARKDOWN_OPTIONS: MarkdownOptions = {
  commentStyle: 'blockquote',
  includeCode: true,
  includeLineNumbers: true,
  includeResolved: false,
  maxCodeLines: 40,
};

/** A fence long enough to survive a snippet that itself contains backticks. */
function fenceFor(lines: string[]): string {
  let longest = 2;
  for (const line of lines) {
    for (const match of line.matchAll(/`{3,}/g)) {
      longest = Math.max(longest, match[0].length);
    }
  }
  return '`'.repeat(longest + 1);
}

/**
 * The lines to show for a thread: what it sits on now, or — once that is no
 * longer the code it was about — what it was opened on.
 */
export function shownSnippet(thread: ReviewThreadData): string[] {
  return thread.outdated === true && thread.original?.length ? thread.original : thread.snippet;
}

function codeBlock(thread: ReviewThreadData, options: MarkdownOptions): string[] {
  const snippet = shownSnippet(thread);
  if (!options.includeCode || snippet.length === 0) {
    return [];
  }
  const truncated = options.maxCodeLines > 0 && snippet.length > options.maxCodeLines;
  const shown = truncated ? snippet.slice(0, options.maxCodeLines) : snippet;
  const width = String(thread.startLine + shown.length - 1).length;
  const body = shown.map((line, i) =>
    options.includeLineNumbers
      ? `${String(thread.startLine + i).padStart(width, ' ')} | ${line}`
      : line,
  );
  if (truncated) {
    body.push(`… ${snippet.length - shown.length} more line(s) omitted`);
  }
  const fence = fenceFor(body);
  return [`${fence}${options.includeLineNumbers ? '' : thread.languageId ?? ''}`, ...body, fence];
}

/** How much of a detached snippet the comment widget shows before truncating. */
const OUTDATED_SNIPPET_LINES = 20;

/**
 * The code a detached thread was written about, as Markdown, or undefined when
 * the thread is still anchored to real code.
 *
 * Once `locate` cannot find the snippet, the thread's line numbers are stale
 * and point at whatever now occupies them — so the widget sits on unrelated
 * code with no way to see what was actually being discussed. The stored snippet
 * is the only surviving record of that, exactly as GitHub keeps the diff hunk
 * with the comment, and this is what puts it in front of the reader.
 *
 * Resolved threads get it too. `resolved` supersedes `outdated` in labels — a
 * thread that has been dealt with should not also nag — but a resolved thread
 * is the one most likely to have lost its code, and reading it later is exactly
 * when you need to know what it was about.
 */
export function outdatedSnippetNotice(
  thread: ReviewThreadData,
  maxLines = OUTDATED_SNIPPET_LINES,
): string | undefined {
  const snippet = shownSnippet(thread);
  if (thread.outdated !== true || snippet.length === 0) {
    return undefined;
  }
  const truncated = maxLines > 0 && snippet.length > maxLines;
  const shown = truncated ? snippet.slice(0, maxLines) : snippet;
  const body = truncated
    ? [...shown, `… ${snippet.length - shown.length} more line(s) omitted`]
    : [...shown];
  const fence = fenceFor(body);
  return (
    [
      // Deliberately not the word "outdated": that is the label's job, and this
      // has to read sensibly on a resolved thread as well.
      '**Original code**',
      '',
      `${fence}${thread.languageId ?? ''}`,
      ...body,
      fence,
    ]
      // Quoted, so the whole thing renders inside one bordered, indented block
      // and reads as context rather than as something the author wrote. A real
      // box is not available: VS Code's markdown sanitiser keeps `style` only on
      // `<span>`, and only for colours, so there is no CSS to draw one with.
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n') + '\n\n'
  );
}

export function threadAnchor(thread: ReviewThreadData): string {
  return `${thread.path}:${lineLabel(thread.startLine, thread.endLine)}`;
}

function commentLines(
  comment: ReviewCommentData,
  isReply: boolean,
  options: MarkdownOptions,
): string[] {
  const edited = comment.updatedAt ? ' · edited' : '';
  const kind = isReply ? ' · reply' : '';
  const header = `**${comment.author}** · ${formatTimestamp(comment.createdAt)}${edited}${kind}`;
  const body = comment.body.trimEnd().split(/\r?\n/);

  switch (options.commentStyle) {
    case 'fenced': {
      const fence = fenceFor(body);
      return [header, '', fence, ...body, fence];
    }
    case 'plain':
      return [header, '', ...body];
    default:
      // A reviewer's comment is prose that may itself contain headings, lists or
      // rules; quoting keeps it from being read as part of the report's own
      // structure, without flattening the Markdown they wrote.
      return [header, '', ...body.map((line) => (line.trim() ? `> ${line}` : '>'))];
  }
}

export function threadToMarkdown(
  thread: ReviewThreadData,
  options: MarkdownOptions = DEFAULT_MARKDOWN_OPTIONS,
  headingLevel = 2,
): string {
  const heading = '#'.repeat(Math.min(6, Math.max(1, headingLevel)));
  const flags = [
    thread.status === 'resolved' ? 'resolved' : undefined,
    thread.status !== 'resolved' && thread.outdated
      ? 'outdated: the code below was not found in the file'
      : undefined,
  ].filter(Boolean);
  const status = flags.length ? ` — ${flags.join(', ')}` : '';
  const out: string[] = [`${heading} \`${threadAnchor(thread)}\`${status}`, ''];
  const code = codeBlock(thread, options);
  if (code.length) {
    out.push(...code, '');
  }
  thread.comments.forEach((comment, i) => {
    out.push(...commentLines(comment, i > 0, options), '');
  });
  return out.join('\n').trimEnd();
}

export function commentToMarkdown(
  thread: ReviewThreadData,
  comment: ReviewCommentData,
  options: MarkdownOptions = DEFAULT_MARKDOWN_OPTIONS,
): string {
  const out: string[] = [`\`${threadAnchor(thread)}\``, ''];
  const code = codeBlock(thread, options);
  if (code.length) {
    out.push(...code, '');
  }
  out.push(...commentLines(comment, thread.comments[0]?.id !== comment.id, options));
  return out.join('\n').trimEnd();
}

function sessionSubtitle(session: ReviewSessionData, shown: ReviewThreadData[], total: ReviewThreadData[]): string {
  const parts = [`created ${formatTimestamp(session.createdAt)}`];
  if (session.base?.branch || session.base?.sha) {
    const branch = session.base.branch ? `\`${session.base.branch}\`` : '';
    const sha = session.base.sha ? ` @ \`${session.base.sha.slice(0, 8)}\`` : '';
    parts.push(`base ${branch}${sha}${session.base.dirty ? ' (dirty working tree)' : ''}`.trim());
  }
  const open = total.filter((t) => t.status === 'open').length;
  const resolved = total.length - open;
  parts.push(`${shown.length} thread(s) shown of ${total.length} (${open} open, ${resolved} resolved)`);
  return parts.join(' · ');
}

function renderThreads(
  session: ReviewSessionData,
  threads: ReviewThreadData[],
  titleSuffix: string,
  options: MarkdownOptions,
  groupByFile = true,
): string {
  const shown = options.includeResolved ? threads : threads.filter((t) => t.status === 'open');
  const out: string[] = [
    `# Local review — ${session.name}${titleSuffix}`,
    '',
    `_${sessionSubtitle(session, shown, threads)}_`,
    '',
  ];
  if (shown.length === 0) {
    out.push('_No comments._');
    return out.join('\n');
  }

  let currentFile: string | undefined;
  for (const thread of shown) {
    if (groupByFile && thread.path !== currentFile) {
      currentFile = thread.path;
      out.push(`## \`${currentFile}\``, '');
    }
    out.push(threadToMarkdown(thread, options, groupByFile ? 3 : 2), '');
  }
  return out.join('\n').trimEnd() + '\n';
}

export function sessionToMarkdown(
  session: ReviewSessionData,
  options: MarkdownOptions = DEFAULT_MARKDOWN_OPTIONS,
): string {
  return renderThreads(session, session.threads, '', options);
}

/** Every thread anchored in one file, for the panel's per-file copy actions. */
export function fileToMarkdown(
  session: ReviewSessionData,
  filePath: string,
  options: MarkdownOptions = DEFAULT_MARKDOWN_OPTIONS,
): string {
  return renderThreads(
    session,
    session.threads.filter((t) => t.path === filePath),
    ` · \`${filePath}\``,
    options,
    false,
  );
}

// --- JSON ------------------------------------------------------------------

function sessionMeta(session: ReviewSessionData) {
  return {
    id: session.id,
    name: session.name,
    status: session.status,
    createdAt: session.createdAt,
    closedAt: session.closedAt,
    base: session.base,
  };
}

export function threadToJson(session: ReviewSessionData, thread: ReviewThreadData): string {
  return JSON.stringify({ session: sessionMeta(session), thread }, null, 2);
}

export function commentToJson(
  session: ReviewSessionData,
  thread: ReviewThreadData,
  comment: ReviewCommentData,
): string {
  const { comments: _comments, ...location } = thread;
  return JSON.stringify({ session: sessionMeta(session), location, comment }, null, 2);
}

export function fileToJson(
  session: ReviewSessionData,
  filePath: string,
  includeResolved = true,
): string {
  const threads = session.threads.filter(
    (t) => t.path === filePath && (includeResolved || t.status === 'open'),
  );
  return JSON.stringify(
    { ...sessionMeta(session), version: session.version, file: filePath, threads },
    null,
    2,
  );
}

export function sessionToJson(session: ReviewSessionData, includeResolved = true): string {
  const threads = includeResolved ? session.threads : session.threads.filter((t) => t.status === 'open');
  return JSON.stringify({ ...sessionMeta(session), version: session.version, threads }, null, 2);
}
