# packages/kit

Runtime building blocks shared by Kea's Node processes (`app/main`, `app/core`, `app/ptyhost`) and
`packages/adapters`: ownership and cleanup of long-lived resources, bounded collections, the one way to start a child
process, git, table-driven state machines, the process supervisor, crash-safe file writes, locks, logging and the
resource report. It is a library with no entry point of its own and no dependency on Electron.

## Modules

| Module | What it provides |
|---|---|
| `disposable.ts` | `Disposable`, `DisposableStore` (disposes in reverse order of addition), `MutableDisposable`, and `DisposableTracker`, which records where each live object was created so a leak points at its source |
| `scope.ts` | `Scope`: a `DisposableStore` with self-removing `timeout`, `interval`, `on` (Node or DOM event targets), `listen` (a kit `Event`) and `child` helpers, and a `signal` that aborts when the scope is disposed |
| `emitter.ts` | `Emitter<T>`, `Event<T>` and `once`. In development builds an emitter with too many listeners warns once, with the creation stack of its most common listener |
| `lru.ts` | `LruCache` (entry cap, optional byte cap, `deleteWhere`, an eviction callback with the reason) and `BoundedQueue` (drops the oldest item or rejects the new one when full) |
| `runProcess.ts` | `runProcess`: argv only (never a shell), its own process group, a timeout, output byte caps or streaming, cancellation, and the `git`, `ports` and `other` concurrency pools. `runHeld` for a child whose stdin stays open for its whole life; `launchDetached` for an app the user keeps open |
| `git.ts` | `git()` and `gitText()` on the `git` pool, with `GIT_TERMINAL_PROMPT=0` always and `GIT_OPTIONAL_LOCKS=0` for read-only commands |
| `fsm.ts` | `createFsm` (a state machine as a table of state × event → handler, with a transition hook) and `allPairs`, which lists every pair so a table can be tested exhaustively |
| `supervisor.ts` | `Supervisor`: restarts a child with exponential backoff, resets the backoff once the child has stayed up, restarts it after missed heartbeats, and never runs two at once. The child is injected; `app/main` adapts Electron's `utilityProcess` to it |
| `atomicWrite.ts` | `atomicWrite` and `atomicWriteSync`: write a temp file, fsync, rename over the target, fsync the directory |
| `trash.ts` | `moveToTrash`, a same-volume rename into a trash folder (a move across volumes throws `CrossDeviceError` instead of copying), and `emptyTrashEntry` / `emptyTrash`, which delete later at background I/O priority |
| `flock.ts` | `tryLock`: an exclusive, non-blocking lock on a file, released when disposed or when the process exits (one core and one ptyhost per `KEA_HOME`) |
| `privateDir.ts`, `rundir.ts` | `ensurePrivateDir`, a directory only this user can reach (checked, never repaired), and `runDir`, where terminal holders' sockets live: `<home>/run`, or, when a socket path under it would be too long, a hashed folder in the user's runtime directory or in `/tmp/kea-<uid>` |
| `logger.ts` | An NDJSON file logger per process with size-based rotation, plus memory and no-op loggers. Writing never throws |
| `resources.ts` | The resource report: named counters and gauges, read by the dev HUD, Copy diagnostics, the hourly resource log and the leak tests |
| `ids.ts`, `fnv.ts`, `clock.ts` | `ulid()` and `ptyId()`; `fnv1a64`; `monotonicMs`, `wallMs` and the injectable `Clock` that timers run on |
| `names.ts`, `rootOnly.ts`, `visibility.ts` | File-name handling (NFC on macOS; names as stored on Linux, with NFC only for comparison), whether only root can change a file, and whether `/proc` hides this user's holders (Linux) |
| `os/` | The kit's OS layer (below) |

Import from `@kea/kit`. The renderer may import only `@kea/kit/fsm`, which has no imports at all.

## The OS layer

What differs between macOS and Linux lives in `src/os/`: `index.ts` declares the capabilities, `darwin.ts` and
`linux.ts` implement them, and `select.ts` picks one at start. Callers import `os/index.ts` only.

| Capability | macOS | Linux |
|---|---|---|
| `instanceLock` | `O_EXLOCK` at open | util-linux `flock` on the process's own descriptor |
| `backgroundIo` | `taskpolicy -b` | `ionice -c 3` |
| `nameKey` | NFC for comparison and file operations | NFC for comparison, names as stored for file operations |
| `paths` (Electron's app-data folder) | `~/Library/Application Support/<name>` | `$XDG_CONFIG_HOME/<name>`, else `~/.config/<name>` |
| `runtimeDir` | none | `$XDG_RUNTIME_DIR`, when it is the user's own |
| `holderVisibility` | always visible | hidden when `/proc` is mounted with `hidepid` |

## Changing the kit

`runDir` and `fnv1a64` have Rust twins in `native/kea-helper/src/rundir.rs`. Both sides are tested against
`fixtures/protocol/holder-golden.json`, so change them together.

Everything else follows the repository's conventions in [CONTRIBUTING.md](../../CONTRIBUTING.md#conventions).

## Tests

Unit tests sit beside the modules they test (`*.test.ts`):

```sh
pnpm exec vitest run --project unit packages/kit
```
