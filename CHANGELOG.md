# Changelog

## 0.2.0

- Sessions moved into their own **Local Review** tab in the bottom panel (was an
  activity-bar view).
- "Round" renamed to "Session" everywhere, including on disk: rounds are now
  stored in `.local-review/sessions/` and `index.json` carries `activeSessionId`.
  An existing `.local-review/rounds/` folder is still read.
- Every comment in the editor now has Reply, Edit, Copy as Markdown, Copy as
  JSON, Resolve/Unresolve, Collapse and Delete buttons.
- Inline buttons on every panel row: copy/delete on sessions, threads and
  replies, plus resolve on threads.
- Resolving a thread folds it away.

## 0.1.0

- Initial release: inline review comments on line ranges, review rounds, folding,
  the built-in Comments panel, Markdown/JSON copy & export, JSON storage under
  `.local-review/`.
