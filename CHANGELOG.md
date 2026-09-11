# Changelog

## 0.4.0

- Worked around the duplicated comment widget. Root cause, from tracing plus two
  experiments: a widget that is already drawn when the Git extension registers
  quick-diff for its file makes VS Code rebuild the file's comment zones and leave
  two widgets for one thread. Disabling Git avoids it; redrawing does not clear it,
  because the extra zone is orphaned inside VS Code and cannot be disposed from the
  extension.
  Threads are now drawn only for files that have been visible for
  `localReview.renderDelayMs` (default 1500), and are retired when the file closes
  so re-opening starts the wait again. Set the delay to `0` for the old behaviour.
- Side effect: the built-in Comments view now lists threads for open files only.
  The Local Review panel is unaffected and still lists everything.
- Diagnostics reports `renderDelayMs` and which documents have settled.

## 0.3.11

- Fixed the duplicated comment widget at its source. Threads were built with
  `createCommentThread(uri, range, [])` and had their comments assigned a moment
  later, so the editor materialised the widget twice — once as the empty "new
  comment" draft, then again when the comments arrived. Threads are now
  constructed with their comments, and their state is set before they are
  tracked.
- Reverted the `reveal` workarounds from 0.3.8 and 0.3.10; tracing showed the
  duplicate exists before any navigation happens, so they were aimed at the wrong
  cause.

## 0.3.10

- Fixed a thread being drawn twice when opened from the Local Review panel while
  its file was closed. Tracing showed the extension does nothing between the editor
  opening and the second widget appearing: VS Code re-evaluates the document's
  comment zones about a second later and builds two for one thread. The trigger is
  writing `collapsibleState` on a thread whose widget the editor has not
  materialised. `reveal` now only toggles an already-visible widget, and otherwise
  recreates the thread with the expanded state set at construction.

## 0.3.8

- Fixed a thread being drawn twice when opened from the Local Review panel while
  its file was not already open. `reveal` expanded the thread *after* awaiting
  `showTextDocument`, which lands inside the window where the editor is still
  materialising the comment zone; the write raced it and produced a second widget.
  The thread is now expanded before the editor is opened.

## 0.3.7

- Stopped rewriting a comment thread's properties on every render. `toRange`
  produces line-start positions while VS Code keeps character offsets on the range
  it tracks, so `Range.isEqual` was always false and the range — plus `canReply`,
  `contextValue`, `state` and `label` — was reassigned on every render, forcing the
  editor to re-lay-out the widget each time. Ranges are now compared by line and
  every property is written only when it actually changes.
- **Refresh** is now **Redraw Comment Threads**: it disposes every widget and draws
  them again, preserving which were expanded. Use it if a duplicate widget appears.

## 0.3.6

- **Show Diagnostics** now lists every widget the extension is holding — thread id,
  file, lines, comment count, and whether it is in the live map or an in-progress
  draft — so a duplicate widget can be attributed instead of guessed at.

## 0.3.5

- Per-file copy in the Local Review panel: **Copy File's Threads as Markdown** and
  **as JSON**, inline on each file row and in its context menu. The Markdown form
  names the file in its title and skips the redundant per-file heading.

## 0.3.4

- Fixed a stray duplicate thread widget that could appear after starting a comment
  with `Ctrl+Alt+C`. Widgets created for an in-progress draft were not tracked, so
  `render()` could never clean them up; every widget is now tracked and orphans are
  swept on each render.
- Markdown exports delimit comment bodies. A comment containing a heading, a list
  or a rule used to merge into the report's own structure. New
  `localReview.markdown.commentStyle`: `blockquote` (default), `fenced`, `plain`.
- New **Local Review: Show Diagnostics** command reporting session, widget and
  suspension state.

## 0.3.3

- Fixed every thread appearing twice immediately after **Developer: Reload
  Window**. `deactivate` was async and awaited a rewrite of every session file,
  so the host lingered and its comment widgets stayed on screen while the next
  host drew its own. `deactivate` is now synchronous: it disposes each thread and
  the comment controller first, then writes only the files with pending changes,
  using synchronous I/O.

## 0.3.2

- Put each action back at its own scope. 0.3.1 had emptied the thread header and
  moved everything onto the comments, so Resolve and Collapse Thread repeated on
  every message in a thread.
  - Thread header: Copy Thread as JSON · Copy Thread as Markdown ·
    Resolve/Unresolve · Delete Thread · Collapse Thread.
  - Each comment: Edit and Delete as icons, with Edit, Copy Comment as JSON,
    Copy Comment as Markdown and Delete Comment under `…`.
- Dropped the Reply button; the thread's reply box already does this.

## 0.3.1

- Removed the comment thread's title-bar actions. VS Code renders that menu as a
  flat icon strip with no overflow, so Copy Thread as Markdown/JSON sat next to
  Copy All as Markdown/JSON as two indistinguishable pairs of icons. Thread- and
  session-scoped copies now live only in the Local Review panel; the comment's own
  toolbar carries the seven per-comment actions, each with a distinct icon.

## 0.3.0

- Stay out of the GitHub Pull Request extension's way:
  - the gutter `+`, the editor context-menu entry and `Ctrl+Alt+C` now appear only
    while a review session is open (`localReview.commenting`);
  - Local Review auto-suspends while a pull request review is open
    (`localReview.autoSuspendDuringPullRequestReview`, detected via
    `localReview.pullRequestSchemes`);
  - new **Suspend** / **Resume** commands, remembered per workspace, which remove
    our threads from both the editor and the Comments panel.

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
