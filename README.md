# Local Change Review

Review your **local, uncommitted** changes with GitHub-PR-style inline comments — then copy the whole review as Markdown or JSON and hand it to an LLM to fix.

No branch to push, no throwaway PR, no pile of review comments on a PR nobody has reviewed yet.

## What it does

- **Comment on a line or a range.** Select lines and hit `Ctrl+Alt+C` (`Cmd+Alt+C` on macOS), use the `+` in the gutter, or the editor context menu.
- **Sessions of review.** Each session is a separate file. Start a new one when you start a new pass; previous sessions stay browsable and can be re-shown in the editor.
- **Fold / unfold.** Threads render collapsed by default; fold or unfold all of them from the view title bar.
- **A "Local Review" panel.** Sessions live in their own tab in the bottom panel, next to Problems / Output / Terminal. Expand a session to see every thread in it; click one to jump straight to the line it's anchored to.
- **Buttons everywhere they're useful.** Every comment in the editor carries Reply, Edit, Copy as Markdown, Copy as JSON, Resolve, Collapse and Delete. Every row in the panel carries the same actions inline.
- **Also in the Comments panel.** Threads additionally show up in VS Code's built-in **Comments** panel, grouped by file, exactly like the GitHub PR extension.
- **Copy for an LLM.** Copy a single comment, a whole thread, or an entire session — as Markdown (with the source lines it's anchored to) or as JSON.
- **Plain files on disk.** Everything lives in `.local-review/`, so an agent can read the review directly instead of you pasting it.

![The Local Review panel](media/image.png)

## Letting an LLM read and write the review

The same review files are exposed over MCP, so an agent can list threads, reply,
open its own, and export — while you keep control of what counts as resolved.

### Install

Build it once:

```bash
pnpm install && pnpm run compile
```

Everything below points at `out/mcp/server.js` by **absolute path**. That matters:
the server takes its *workspace* from the directory the client runs it in, so one
build serves every repository, and a repository you never review gets no
`.local-review/` folder created.

For brevity, `SERVER` below means
`/absolute/path/to/local-change-review/out/mcp/server.js`.

#### Claude Code

```bash
claude mcp add --scope user local-review -- node SERVER      # every repository
claude mcp add local-review -- node SERVER                   # this repository only
```

Then **restart Claude Code and approve the server** when it asks. Until you do,
`claude mcp list` shows `⏸ Pending approval` and no tools appear —
`claude mcp reset-project-choices` makes it ask again if you declined by accident.
Working inside this repository, the bundled `.mcp.json` already registers it, so
only the approval applies.

#### Codex

```bash
codex mcp add local-review --env LOCAL_REVIEW_AUTHOR=codex -- node SERVER
```

Codex keeps MCP servers in `~/.codex/config.toml`, so this is always user-level:

```toml
[mcp_servers.local-review]
command = "node"
args = ["/absolute/path/to/local-change-review/out/mcp/server.js"]
env = { LOCAL_REVIEW_AUTHOR = "codex" }
```

#### Gemini CLI

```bash
gemini mcp add -s user  -e LOCAL_REVIEW_AUTHOR=gemini local-review node SERVER
gemini mcp add -s project -e LOCAL_REVIEW_AUTHOR=gemini local-review node SERVER
```

`-s project` is the default. The two scopes write `~/.gemini/settings.json` and
`.gemini/settings.json` respectively, both under an `mcpServers` key in the shape
shown below.

#### Cursor

Cursor reads `~/.cursor/mcp.json` for every project and `.cursor/mcp.json` for one,
using the same shape:

```json
{
  "mcpServers": {
    "local-review": {
      "command": "node",
      "args": ["/absolute/path/to/local-change-review/out/mcp/server.js"],
      "env": { "LOCAL_REVIEW_AUTHOR": "cursor" }
    }
  }
}
```

#### Anything else

Most clients take that same `mcpServers` block; put it in the client's global
config for every project, or its per-project config for one. VS Code's own agent
mode is the notable exception — it uses `.vscode/mcp.json` with a `servers` key
rather than `mcpServers`.

The server speaks MCP over stdio, so there is no port and nothing to discover: the
client starts the process, and the editor picks up whatever it writes through the
file watcher it already has.

Set `LOCAL_REVIEW_AUTHOR` to whatever you want that agent's comments signed as —
it is also the name the resolve rule keys off, so give each agent its own.

### Tools

| Tool                               | What it does                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `list_sessions` / `create_session` | See sessions, start a new round                                                                                           |
| `list_threads`                     | Threads with their comments; filter by `file`, `status`, `author`, `agent`, `needsReply`, and `compact` for one line each |
| `get_thread`                       | One thread, including the source it is anchored to                                                                        |
| `create_thread`                    | Open a thread on a line range                                                                                             |
| `add_comment`                      | Reply to a thread                                                                                                         |
| `resolve_thread`                   | Close a thread — **only ones the agent opened itself**                                                                    |
| `unresolve_thread`                 | Reopen any thread, with a comment saying why                                                                              |
| `export_markdown`                  | A session, a file, or one thread as Markdown                                                                              |

Two rules shape it:

- **The agent cannot resolve your comments.** `resolve_thread` refuses any thread
  whose opening comment has a different author, and says so. It can reply with what
  it changed; whether that counts as done stays your call, in the editor.
- **It can reopen any thread, but never silently.** Closing a comment hides work
  from you; reopening only asks for your attention, so it is not restricted — an
  agent that thinks an issue is not actually fixed should be able to say so.
  `unresolve_thread` requires a comment and posts it in the same step, so a thread
  never springs back open unexplained.
- **Line numbers are re-anchored on every read**, so they reflect the code as it is
  now rather than as it was when you wrote the comment.

Two filters worth knowing, because they shape the workflow:

- `needsReply: true` returns only threads whose most recent comment is not the
  agent's — its actual queue of work, without reasoning about timestamps.
- `compact: true` returns one summary line per thread instead of every body,
  around 3× smaller on real review prose. Survey with it, then `get_thread` the
  ones that matter.

Writes go through the same locked transaction the extension uses, and the editor
picks them up live through its file watcher — no coordination between the two.

Environment: `LOCAL_REVIEW_ROOT` (default: cwd), `LOCAL_REVIEW_STORAGE`
(default `.local-review`), `LOCAL_REVIEW_AUTHOR` (default `claude`).

## Build & install

```bash
pnpm install
pnpm run compile          # or: pnpm run watch
pnpm run package          # produces local-change-review-<version>.vsix
code --install-extension local-change-review-*.vsix
```

Or press `F5` in this folder to launch an Extension Development Host.

The panel is at **View → Appearance → Panel**, tab **Local Review**.

## Storage layout

```
.local-review/
  index.json              { "version": 1, "activeSessionId": "session-20260911-143000" }
  sessions/
    session-20260911-143000.json
    session-20260912-091200.json
  exports/                written by "Export Session to File…"
    session-20260911-143000.md
  .lock/                  a directory, present only while a write is in flight
```

Every write — from the editor and from the MCP server alike — happens under
`.lock/`, so the two never overlap. It is a *directory* holding one file named
after its owner, because `rmdir` refusing a non-empty directory is the only
conditional removal POSIX offers: a lock that has changed hands cannot be taken
away by a writer still acting on an older judgement. If a process is killed
mid-write the lock is reclaimed automatically once it goes stale.

A session file:

```json
{
  "version": 1,
  "id": "session-20260911-143000",
  "name": "Session 1",
  "status": "open",
  "createdAt": "2026-09-11T14:30:00.000Z",
  "base": { "branch": "feat/billing", "sha": "a1b2c3d4…", "dirty": true },
  "threads": [
    {
      "id": "thread-…",
      "path": "src/features/assistant/AssistantBilling.service.ts",
      "startLine": 33,
      "endLine": 36,
      "snippet": ["export class AssistantBillingService {", "  constructor("],
      "original": ["export class AssistantBillingService {", "  constructor("],
      "originalStartLine": 33,
      "originalEndLine": 36,
      "languageId": "typescript",
      "status": "open",
      "createdAt": "…",
      "updatedAt": "…",
      "comments": [
        { "id": "comment-…", "author": "Shiranuit", "agent": false, "body": "…", "createdAt": "…" }
      ]
    }
  ]
}
```

`agent` records whether a comment came from an agent through the MCP server or
from a person in the editor; it is absent on comments written before the flag
existed, which is not the same as `false`.

`path` is workspace-relative and POSIX-separated. `startLine`/`endLine` are **1-based and inclusive**.

`snippet` is the source the thread currently sits on. It is refreshed **only**
when the code at the new position is the same code, indentation aside — an
anchor never follows the editor's tracked range onto something else, because a
range is not a claim about content. When the code can no longer be found the
thread is marked `outdated`, keeps its last known position, and stops moving.

`original`, `originalStartLine` and `originalEndLine` are what the thread was
opened on and where it sat, written once and never rewritten. They are what the
editor, the exports and the MCP server show for an outdated thread, so a comment
is still readable long after the code it was about has gone.

The MCP server never rewrites a snippet. Reading a review refreshes line numbers
and the `outdated` flag — facts about where the code is — but the record of what
the review is *about* is only ever written by the editor.

Add `.local-review/` to `.gitignore` if you'd rather not commit reviews, or commit them if you want the history.

## Typical loop

1. Make local changes.
2. **Local Review: Start New Review Session**.
3. Select lines, `Ctrl+Alt+C`, write what's wrong. Repeat.
4. **Copy All Comments as Markdown** from the view title bar.
5. Paste into your agent: *"Here is a review of the current working tree, fix it."*
6. Start the next session to review the fixes.

## Commands

### In the editor

| Toolbar       | Actions                                                                                               |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Thread header | Copy Thread as JSON · Copy Thread as Markdown · Resolve/Unresolve · Delete Thread · Collapse Thread   |
| Each comment  | Edit · Delete, with Edit, Copy Comment as JSON, Copy Comment as Markdown and Delete Comment under `…` |

Thread-scoped actions appear once, on the thread; comment-scoped actions appear
on each comment. Replies go in the thread's reply box. Session-scoped actions
(copy everything, new session, delete session) are in the **Local Review** panel.

### Reading the panel

Each row carries three separate signals, one per channel:

| Channel                     | Means                                            |
| --------------------------- | ------------------------------------------------ |
| Icon                        | the thread's state — open, resolved, or outdated |
| Badge at the end of the row | comments you have not read                       |
| Dimmed text                 | location, author, reply count, age               |

So a resolved thread that an agent has just commented on still shows as resolved,
with a count at the end of the line telling you something arrived. Opening the
thread clears the count; **Mark All as Read** clears them in bulk.

### In the **Local Review** panel

| Row     | Inline buttons                                                                 |
| ------- | ------------------------------------------------------------------------------ |
| Session | show/hide in editor · Copy all as Markdown · Copy all as JSON · Delete session |
| File    | Copy File's Threads as Markdown · Copy File's Threads as JSON                  |
| Thread  | Copy as Markdown · Copy as JSON · Resolve/Unresolve · Delete                   |
| Reply   | Copy as Markdown · Copy as JSON · Delete                                       |

Right-click any row for the rest: set active, rename, close/reopen, export.

### Panel title bar

New Session `+` · Copy All as Markdown · Copy All as JSON · Fold All Threads · Redraw, with Switch Session, Export, Unfold All, Comments panel and Reveal storage folder under `…`.

### Elsewhere

| Command                         | Where                                                                                  |
| ------------------------------- | -------------------------------------------------------------------------------------- |
| Add Review Comment on Selection | `Ctrl+Alt+C`, editor context menu, gutter `+` — all three only while a session is open |
| Switch Active Session…          | status bar                                                                             |
| Everything above                | Command Palette, under **Local Review**                                                |

## Living alongside the GitHub Pull Request extension

Both extensions put comment threads on the same `file:` documents and share the
Comments panel, so this one deliberately stays out of the way:

- **Nothing on non-`file:` documents.** PR diffs, PR descriptions and every other
  virtual document are never touched — the gutter there belongs entirely to the
  Pull Request extension.
- **No gutter `+` until you start a session.** With the default
  `localReview.commenting: "whenSessionActive"`, the `+`, the editor context-menu
  entry and `Ctrl+Alt+C` only appear once a review session is open. Until then the
  gutter looks exactly as it did before you installed this.
- **Auto-suspend during a PR review.** While a pull request review is open, Local
  Review suspends itself: no gutter affordance, and its threads leave the editor
  *and* the Comments panel, so they can't be mistaken for PR comments. The status
  bar says so, and one click resumes.
- **Manual suspend.** **Local Review: Suspend** from the palette or the panel's
  `…` menu does the same on demand, and is remembered per workspace.
- **Distinct label.** Our threads are labelled `Local Review` in the Comments
  panel, against `Pull Request (owner/repo)` for the other extension.

Auto-suspend detects a review by looking for open tabs whose URI scheme belongs
to the Pull Request extension. There is no API for its review mode, so that list
is the setting `localReview.pullRequestSchemes` — if detection misfires either
way, edit the list rather than waiting for a fix.

## Settings

| Setting                                   | Default             | Meaning                                                                   |
| ----------------------------------------- | ------------------- | ------------------------------------------------------------------------- |
| `localReview.storageFolder`               | `.local-review`     | Where sessions are stored. Set to `.vscode/local-review` to tuck it away. |
| `localReview.author`                      | *(git `user.name`)* | Name recorded on new comments.                                            |
| `localReview.defaultThreadState`          | `collapsed`         | How threads render in the editor.                                         |
| `localReview.highlightCommentedLines`     | `true`              | Highlight commented ranges and mark them in the overview ruler.           |
| `localReview.showStatusBarItem`           | `true`              | Active session + open-thread count in the status bar.                     |
| `localReview.markdown.includeCode`        | `true`              | Embed the commented source in Markdown exports.                           |
| `localReview.markdown.includeLineNumbers` | `true`              | Prefix embedded source with line numbers.                                 |
| `localReview.markdown.includeResolved`    | `false`             | Include resolved threads when exporting a session.                        |
| `localReview.markdown.maxCodeLines`       | `40`                | Truncate long embedded snippets.                                          |

### Built-in VS Code settings worth knowing

The comment widgets are rendered by VS Code, not by this extension, so their
behaviour is tuned through VS Code's own `comments.*` settings:

| Setting                      | Default | Meaning                                                                                                                                                                                                                  |
| ---------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `comments.maxHeight`         | `true`  | Caps the widget's height and scrolls long comments. Set to `false` to let the widget **expand to the full comment** instead — useful for long review findings, at the cost of pushing the surrounding code further down. |
| `comments.collapseOnResolve` | `true`  | Collapse a thread when it is resolved.                                                                                                                                                                                   |
| `comments.useRelativeTime`   | `true`  | Show `1 day ago` rather than an absolute timestamp.                                                                                                                                                                      |

## Notes & limits

- Sessions are stored under the **first** workspace folder. Files outside it are recorded by absolute path.
- Thread anchors follow edits in the editor, and are re-found by content otherwise:
  on startup, on save, on demand (**Re-anchor Comments to Current Code**) and on
  every MCP read. A thread whose code can no longer be found anywhere in the file
  is marked **outdated** rather than left pointing at whatever now occupies those
  lines.
- Editing `.local-review/**` from outside the editor is picked up automatically.
