import type { ReviewCommentData, ReviewSessionData, ReviewThreadData } from './types';
import { config, formatTimestamp, lineLabel } from './util';

/** How a comment body is delimited from the surrounding document. */
export type CommentStyle = 'blockquote' | 'fenced' | 'plain';

export interface MarkdownOptions {
  commentStyle: CommentStyle;
  includeCode: boolean;
  includeLineNumbers: boolean;
  includeResolved: boolean;
  maxCodeLines: number;
}

export function markdownOptions(overrides: Partial<MarkdownOptions> = {}): MarkdownOptions {
  const c = config();
  return {
    commentStyle: c.get<CommentStyle>('markdown.commentStyle', 'blockquote'),
    includeCode: c.get<boolean>('markdown.includeCode', true),
    includeLineNumbers: c.get<boolean>('markdown.includeLineNumbers', true),
    includeResolved: c.get<boolean>('markdown.includeResolved', false),
    maxCodeLines: Math.max(0, c.get<number>('markdown.maxCodeLines', 40)),
    ...overrides,
  };
}

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

function codeBlock(thread: ReviewThreadData, options: MarkdownOptions): string[] {
  if (!options.includeCode || thread.snippet.length === 0) {
    return [];
  }
  const truncated = options.maxCodeLines > 0 && thread.snippet.length > options.maxCodeLines;
  const shown = truncated ? thread.snippet.slice(0, options.maxCodeLines) : thread.snippet;
  const width = String(thread.startLine + shown.length - 1).length;
  const body = shown.map((line, i) =>
    options.includeLineNumbers
      ? `${String(thread.startLine + i).padStart(width, ' ')} | ${line}`
      : line,
  );
  if (truncated) {
    body.push(`… ${thread.snippet.length - shown.length} more line(s) omitted`);
  }
  const fence = fenceFor(body);
  return [`${fence}${options.includeLineNumbers ? '' : thread.languageId ?? ''}`, ...body, fence];
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
  options: MarkdownOptions = markdownOptions(),
  headingLevel = 2,
): string {
  const heading = '#'.repeat(Math.min(6, Math.max(1, headingLevel)));
  const status = thread.status === 'resolved' ? ' — resolved' : '';
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
  options: MarkdownOptions = markdownOptions(),
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
  options: MarkdownOptions = markdownOptions(),
): string {
  return renderThreads(session, session.threads, '', options);
}

/** Every thread anchored in one file, for the panel's per-file copy actions. */
export function fileToMarkdown(
  session: ReviewSessionData,
  filePath: string,
  options: MarkdownOptions = markdownOptions(),
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
