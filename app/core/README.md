# app/core

Kea's core process: an Electron `utilityProcess` that main starts, and restarts if it dies. Core holds the meaning of
everything a window shows: projects and sessions in SQLite, their git worktrees, the record of every terminal, the
agents and their status, the files panel and the viewer, dev servers, settings, disk usage and diagnostics. Each
window talks to it over an RPC connection of its own, subscribing to its stores and calling its handlers (the
messages are defined in `packages/protocol`). Core drives ptyhost over a control port: core decides what a terminal
is for, and ptyhost carries its bytes.

## How it is put together

- `src/main.ts` is the entry point. It takes `<KEA_HOME>/run/core.lock`, so only one core runs per home, installs the
  guard (`guard.ts`: anything uncaught is logged and core exits, so that main restarts it), resolves the login-shell
  environment, builds core and answers main's messages: the heartbeat, the resource report, window focus, Stop All
  and shutdown.
- `src/core.ts` (`createCore`) builds every service in order and wires them together. The database and the settings
  file come first, so the first subscription is answered at once; the slower start-up work (git, the rebuild of
  sessions from the terminals that survived, the first reconciliation with ptyhost) follows in the background. The
  integration and chaos suites call the same `createCore` under plain Node, against a real ptyhost.

## Folders

| Folder | What it does |
|---|---|
| `src/platform/` | Infrastructure: the SQLite database (`db/`: one connection, the schema and its migrations, the status write batch), the watch service (`watch/`: every file system watch in core, through `@parcel/watcher`), the visible set (which session each window shows), the app's banners, and keeping Kea's own folders out of backups |
| `src/os/` | What differs between macOS and Linux: finding editors, the Trash tool, mounts, the port range, backup exclusion, the git stub check, shell defaults, port owners, the watcher binding and the spool lock |
| `src/sessions/` | Projects and sessions: registering a project, the session lifecycle, creation (worktree, copied files, setup), stop, resume, restart, archive, delete with a snapshot, restore and auto-clean, a session's environment variables and its setup and teardown scripts |
| `src/worktrees/` | git: which `git` to run, a mutex per repository, adding and removing worktrees, delete snapshots and restores, slugs and branch names, copying untracked files into a new worktree, rebuildable build folders, disk usage and the creation log |
| `src/terminal/` | Core's side of terminals: a record of every PTY, the reconciliation with ptyhost's holders each time it connects, the login-shell environment, what each PTY runs, shell tab numbers and the process each shell tab's tooltip names, and the one gate for typing text into a terminal |
| `src/agents/` | The agent service: detecting each agent CLI, the command a session's agent starts with, the hook socket and the spools behind it, the helper copy that hooks run, and the watches on an agent's status file and transcript. Everything agent-specific comes from `packages/adapters` |
| `src/status/` | The status engine (each live session's phase and the items that need the user, from hooks, status files, transcripts and terminal activity), the notification policy, account conditions such as a usage limit, "Why this status?" and status reports |
| `src/files/` | The files panel: the tree and its file operations, git status and the diff against the session's base, the finder (fuzzy file search on a worker thread) and Discard Changes |
| `src/viewer/` | The file viewer and diffs: reads that stay inside the session's working directory, binary and text detection, a diff's two sides and its gutter |
| `src/editor/` | Open in Editor, the terminal app, the pull request page, and checking paths printed in a terminal |
| `src/server/` | Each session's dev server: detecting it, Run, Stop and Restart in a terminal of its own, port blocks, port scans and the URL it prints |
| `src/settings/` | `settings.json`, `keybindings.json` and the Ghostty config: parsed, validated and watched, with the last good version kept while a file is broken |
| `src/resources/` | Core's rows in the resource report, and its part of Copy Diagnostics |

## Constraints

- Core is the only process that writes the database, and the only one that knows what a terminal is for. It never
  connects to a terminal holder: ptyhost is the holders' only client.
- Git never changes the main checkout's working tree: a command that writes runs in a session's worktree or touches
  only git's own data.
- The conventions in [CONTRIBUTING.md](../../CONTRIBUTING.md) hold here: children start through `runProcess` in
  `packages/kit` or in a terminal holder, and code that differs by system lives in `src/os/`.

## Tests

- Unit tests sit beside the code (`src/**/*.test.ts`) and run with `pnpm test:unit`.
- `tests/integration/core-*.test.ts` run the assembled core under plain Node with a real ptyhost, real git and
  generated repositories (`tests/integration/core-support.ts` builds it).
- Core's chaos, leak and performance suites are in `tests/chaos/`, `tests/memory/` and `tests/perf/`.
