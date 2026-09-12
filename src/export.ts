import { DEFAULT_MARKDOWN_OPTIONS, type MarkdownOptions } from './core/export';
import { config } from './util';

export * from './core/export';

/** Markdown options taken from VS Code settings. */
export function markdownOptions(overrides: Partial<MarkdownOptions> = {}): MarkdownOptions {
  const c = config();
  return {
    commentStyle: c.get('markdown.commentStyle', DEFAULT_MARKDOWN_OPTIONS.commentStyle),
    includeCode: c.get('markdown.includeCode', DEFAULT_MARKDOWN_OPTIONS.includeCode),
    includeLineNumbers: c.get('markdown.includeLineNumbers', DEFAULT_MARKDOWN_OPTIONS.includeLineNumbers),
    includeResolved: c.get('markdown.includeResolved', DEFAULT_MARKDOWN_OPTIONS.includeResolved),
    maxCodeLines: Math.max(0, c.get('markdown.maxCodeLines', DEFAULT_MARKDOWN_OPTIONS.maxCodeLines)),
    ...overrides,
  };
}
