# packages/protocol

Everything that crosses a process boundary in Kea: the zod schemas of every message and call, the RPC layer and the
keyed stores it syncs, the terminal holder's binary wire format, the command table, and the limits generated from
`constants/`. Main, core, ptyhost and the window all import it, so each message has one definition that both of its
ends check. It has no entry point and does no I/O; its only runtime dependency is `zod`.

Import from `@kea/protocol`. Four more entry points exist: `@kea/protocol/limits` (the generated limits alone),
`@kea/protocol/platform`, and `@kea/protocol/os/darwin` and `/os/linux`, which let a test check either system's
rules on any machine.

## Modules

| Module | What it holds |
|---|---|
| `rpc.ts` | `defineApi` and `RpcPeer`: calls with cancellation and timeouts, notifications, and store subscriptions (a snapshot, then coalesced deltas, at most one unacknowledged delta per subscriber). Arguments are validated on the receiving side; disposing a peer drops everything its connection held |
| `channel.ts` | `Channel`, one message-port interface over DOM, Electron and Node ports, and `channelPair()` for tests |
| `store.ts` | `KeyedStore` (a keyed collection seen as a snapshot followed by deltas), `mergeDelta` and `applyDelta`, `SimpleStoreRegistry`, and the names of the per-session stores |
| `core.ts` | `coreApi`: every feature's API joined into the one surface core serves to a window |
| `process.ts` | Messages between main and its utility processes (core, ptyhost) on `parentPort`: ports, heartbeat, shutdown, resource reports, the menu-bar state, notifications; the children's argv and V8 flags |
| `terminal.ts` | The core ⇄ ptyhost control API and notes, the per-terminal stream messages between ptyhost and the window, the terminals store, and the rule for text typed into a terminal |
| `holder.ts` | The holder wire protocol, mirrored from `native/kea-helper/src/proto.rs`: frame codes, encoders and decoders, `FrameSplitter`, and the ring-file reader used to restore a terminal whose holder is gone |
| `sessions.ts` | Projects and sessions: their stores, `projectsApi` and `sessionsApi`, launch configurations and the composer's types |
| `worktrees.ts` | `worktreesApi`: worktrees under Kea's roots that no session owns, and adopting or removing them |
| `agents.ts` | The `agents` store (each agent CLI: installed, signed in, the models and modes it offers), `agentsApi`, and the envelope `kea-helper hook` sends for each agent hook |
| `status.ts` | Normalised agent events, the `status` and `status.conditions` stores, `statusApi`, the attention order and badge count, and the schemas of status reports and replay fixtures |
| `files.ts` | Paths inside a worktree, git status (the `git:<sessionId>` store and the one Changes order), the file tree store, and `filesApi` (tree, finder, Discard Changes) |
| `viewer.ts` | Opening a file or diff, `viewerApi` (read, diff, gutter changes, follow), and the `kea-file://` URLs local images are served through |
| `editor.ts` | `editorApi`: opening a session's folder or file in an editor or the terminal app, the editors found, and opening a pull request page |
| `server.ts` | The dev server: the `server:<sessionId>` store and `serverApi` (run, stop, restart, take over a port, scan) |
| `disk.ts` | The `disk` store (a worktree's size and rebuildable share), `diskApi`, the stale rule and `formatBytes` |
| `settings.ts` | The settings table (key, schema, default, label, section, control), `parseSettings` with per-key fallback, the settings stores and `settingsApi`, and what core reads of the Ghostty config |
| `keybindings.ts` | `keybindings.json`: its rules, the bindings in use with conflicts found, the starter file, and its store and API |
| `commands.ts` | The command table (every command's id, title, category, default keys on macOS and Linux, and the menus that list it), shortcut parsing and labels, and the menu state a window reports to main |
| `banners.ts` | The `banners` store: the app-level banners and the source that clears each |
| `visible.ts` | `visibleApi`: the window telling core which session it shows |
| `diagnostics.ts` | Copy Diagnostics: its calls, `scrubPaths` (the rule that keeps file paths out of the text), and the Resources section |
| `resources.ts` | The resource report as it crosses a process boundary, checked against its caps |
| `platform.ts` | The OS layer's shared vocabulary: the systems Kea runs on, `NotAvailable` for a capability a system lacks, and the platform report |
| `procs.ts` | `parseProcs`, the one reader of `kea-helper procs` output |
| `env.ts` | `SESSION_ENV_VARS`, the variables core sets in a session's terminals, and `scrubSessionEnv`, which every Kea process runs at start so a Kea started inside a session does not inherit them |
| `release.ts` | `RELEASE_REPOSITORY`, the `owner/name` of Kea's GitHub repository and the one value every release URL comes from, and `releaseUrls` |
| `enums.ts` | The enums of core's database columns as const arrays and zod schemas |
| `os/` | Protocol's own OS layer: how each system writes and reserves key chords, its names for its own parts, and what the window shows of it. `select.ts` picks the system once, from `process.platform` or, in the window, `navigator.platform` |
| `generated/` | `limits.ts` (`L`, from `constants/limits.toml`) and `themes.ts` (the terminal themes, from `constants/tokens.json`), written by `pnpm codegen` |

## Rules for changes here

- A feature whose messages cross a process boundary gets its own module here. Its API joins `coreApi` (or the
  process messages) and the list of APIs in `schemas.test.ts`.
- Message schemas describe plain, structured-clonable data.
- Never edit `generated/`: change `constants/` and run `pnpm codegen`.
- `holder.ts` has a Rust twin in `native/kea-helper/src/proto.rs`. Both are tested against
  `fixtures/protocol/holder-golden.json`, so change them together.

Everything else follows the repository's conventions in [CONTRIBUTING.md](../../CONTRIBUTING.md#conventions).

## Tests

Unit tests sit beside the modules they test (`*.test.ts`). `schemas.test.ts` checks, as a property, that values made
from each listed API's schemas survive the RPC round trip unchanged.

```sh
pnpm exec vitest run --project unit packages/protocol
```
