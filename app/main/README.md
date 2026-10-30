# app/main

Kea's Electron main process. It is kept thin: no business logic, and nothing that can block. It owns the native
surfaces (the window, the menus, the menu-bar item or tray, notifications and the Dock badge), runs core and ptyhost as
Electron utility processes under one `Supervisor` each (`packages/kit`), and brokers the MessagePorts between them and
the window: the control port between core and ptyhost, one RPC port per window to core, and one stream port per
attached terminal to ptyhost. After that, main is not on the data path. It also samples every process's memory, runs
the memory watchdog, serves the window's local images over `kea-file://`, and checks for updates (on macOS it also
runs Kea's updater).

## Startup

`main.ts` first removes the variables a terminal session would pass on (`scrubSessionEnv`), before anything reads the
environment. It then picks the home directory (`home.ts`): `~/.kea` for an installed build, `~/.kea-dev` for a dev
build, or `--kea-home=<absolute path>` for tests. Each home gets its own single-instance lock and its own Electron data
folder, so dev, installed and test builds never share one. A packaged build refuses to start with a debugger switch or
a perf-harness switch (`switches.ts`).

After its lock, main copies `resources/kea-helper` into `<KEA_HOME>/bin/<version>-<hash>/` (kit's `installHookHelper`)
and hands that copy to core and ptyhost (`--helper`) and to the footprint sampler, so every helper the run starts is the
run's own, whatever a package manager does to Kea's files later. A checkout without a built helper, or a copy that
fails, uses the build's own. Each child also gets the bundle's build id (`--kea-build`): a child from another build
exits at once with `L.childBuildMismatchExit`. If drafts were kept for this start by a restart Kea made itself, the
first window takes them (`updates/store.ts`, `handoff.ts`).

The UI is served from `kea://app/` with a content security policy and a path check. The window is sandboxed with
context isolation; navigation away from `kea://app/`, new windows and webviews are refused, and the only permission
granted is the sanitised clipboard write. The preload (`app/preload`) is the window's only bridge.

## Children and the window

- `utility.ts` adapts Electron's `utilityProcess` to the kit's `Supervisor`: a ping/pong heartbeat, `SIGKILL` to stop
  a hung child, and V8 flags passed inside `--js-flags`, the one form a utility process honours. Each child's old space
  is capped at its watchdog hard limit, and ptyhost's young generation at `L.ptyhostSemiSpaceMb`.
- When either child becomes ready, core and ptyhost get a fresh control port. After a ptyhost restart every window
  hears `kea:streamsReset` and reattaches its terminals. After a core restart every window that has said hello gets a
  new RPC port: one per renderer load and core instance, never two in a row (`lifecycle.ts`, `RpcPortHandout`).
- While a core that had been ready is gone, every window is told (`kea:coreAway`) and shows a "Reconnecting…" bar if
  core stays away long enough (`CoreAvailability`).
- A full quit asks each child to shut down, waits up to `L.supervisorShutdownGraceMs`, then stops supervising
  (`shutdownChildren`). That shutdown leaves the terminal holders alone: a quit the user asks for stops every terminal first (`stopAllAndQuit`), while an update's or a relaunch's quit leaves them for the new Kea to adopt.
- Closing the last window does not quit Kea on macOS. On Linux, Kea goes to the background while terminals run and a
  tray host is there to reopen it from, and stops every terminal and quits otherwise.
- An unresponsive renderer is crashed and its window reloaded; every terminal reattaches from ptyhost's snapshots.
- Before every respawn of core or ptyhost the Supervisor asks main (`beforeRespawn`), which refuses once Kea's files
  were replaced or removed under the running Kea (`updates/upgrade.ts`). A refused respawn restarts the whole of Kea
  into the new files instead, once per version, so no child ever loads new files into the old Electron.

## Messages with the window

Main accepts a message only from the main frame of one of Kea's own windows, and checks its payload before acting on
it.

- From the window: `kea:hello`, `kea:menuState`, `kea:openStream`, `kea:pickFolder`, `kea:reveal`,
  `kea:openSettingsFile`, `kea:openHomeItem`, `kea:mainCommand`, `kea:editRole`, `kea:openMenu`, `kea:quitChoice`,
  `kea:notificationState`, `kea:openNotificationSettings`, `kea:resources`, `kea:resourceReports`, `kea:handoff`,
  `kea:takeHandoff`, `kea:updateState`, `kea:checkUpdates`, `kea:restartToUpdate` and `kea:updateNoticeShown`.
- To the window: `kea:rpc` and `kea:stream` (with their ports), `kea:streamError`, `kea:streamsReset`, `kea:coreAway`,
  `kea:command`, `kea:folder`, `kea:showSession`, `kea:quitSheet`, `kea:screenReader`, `kea:wake`, `kea:gpuReset`,
  `kea:resources`, `kea:resourceReports`, `kea:notificationState`, `kea:handoffAsk` and `kea:updateState`.

## Files

| File | What |
|---|---|
| `main.ts` | The entry point: startup, the children, the window, the IPC handlers, and the wiring of everything below |
| `home.ts`, `switches.ts` | The home directory for this build; the command-line switches a packaged build refuses |
| `utility.ts`, `lifecycle.ts` | A supervised utility process; core availability, the RPC port handout and the full-quit shutdown, kept free of Electron |
| `menu.ts` | The menu bar (macOS) or the window's menu (Linux), generated from the command table. Shortcuts are shown but not registered: the renderer's key router runs them. Main runs only the commands that must work with no window |
| `menuBar.ts`, `trayIcon.ts` | What `⌘Q` does (quit, stop all and quit, or stay in the menu bar, with the first-quit sheet), the menu-bar item or tray and its menu, and the Dock icon's show and hide; the item's icon, drawn from the Kea mark |
| `notifier.ts` | Notifications and the badge: core's policy decides what to post or withdraw, main shows it, one notification per tag |
| `native.ts` | The folder picker, Reveal, and the window's saved bounds |
| `handoff.ts` | On Wayland a minimized window cannot be brought back, so Kea makes a new one in its place; the old window's composer drafts are handed to the new one. A restart Kea makes itself carries them the same way, through a file |
| `external.ts`, `links.ts` | The one place a link leaves Kea for the system browser: `http`, `https` and `mailto` only |
| `keaFile.ts` | `kea-file://`: serves an image only when its real path lies inside a working directory the window shows, it is a regular file, and it is no larger than `L.imageMaxBytes` |
| `resources.ts` | The resource report (each process's counters, collected on request), the footprint sampler (`kea-helper footprint`), and the hourly line in `<KEA_HOME>/logs/resources.ndjson` |
| `watchdog.ts` | The memory watchdog: a soft and a hard limit per kind of process, from `constants/limits.toml`. Past a hard limit while the person is idle, it restarts core or ptyhost, reloads the window, or resets WebGL, once per episode and then not again until a cool-down has passed |
| `rendererLog.ts` | Writes the window's console warnings and errors to `<KEA_HOME>/logs/renderer.log`, since the sandboxed renderer writes no file |
| `platformReport.ts`, `platformLines.ts` | The platform report (what Settings › About and Copy Diagnostics say about the system), kept here and sent to core when it changes |
| `frontGuard.ts`, `testHooks.ts` | Test builds only: never stay the frontmost app; the `globalThis.__keaTest` API for the harness |
| `updates/` | Updates (below) |
| `os/` | The OS layer (below) |

## Updates

`updates/` holds main's update state and everything that feeds it; the window draws it in Settings › About and the
sidebar footer.

| File | What |
|---|---|
| `manager.ts` | The state (checking, current, available, downloading, ready, upgraded, removed, did not install, failed), the menu item's title (Check for Updates…, Restart to Update, Restart Kea), and when an automatic check runs: only where nothing else updates Kea, for the default home, once core has said `updates.check` is on and the one-time line saying Kea checks has been shown; by the wall clock, tested every `L.updateTickMs` and on resume. Pure: the clock, the check and the macOS driver are handed in |
| `feed.ts` | The check where Kea's own updater does not run: one GET of the newest release's `SHA256SUMS` through the in-memory `kea-updates` session; the version offered is the one in this install's own file name, never a prerelease |
| `net.ts` | Where an update request may go (Kea's releases on GitHub and GitHub's release-asset hosts, every redirect hop judged) and the exact headers it carries; used by both update sessions |
| `store.ts` | `<userData>/updates.json` (the marks kept across launches) and `<userData>/handoff.json` (the window's drafts across one restart Kea makes itself, read once and deleted) |
| `upgrade.ts` | Kea's files replaced or removed under it, as a Linux package manager does: `app.asar` compared by device and inode through `original-fs`, a child of another build, and the restart into the new files with its loop guard |
| `how.ts`, `driver.ts` | How an install is updated, and the install commands; the macOS updater's driver as main sees it (types only) |

The macOS updater is its own bundle, `updater.cjs`, built from `os/squirrel.ts` (electron-updater's `MacUpdater`,
Electron's Squirrel.Mac and their session) with its logic in `os/squirrelDriver.ts`. Only the Mac app ships it, and
main loads it only when it first makes the updater, so none of that code runs on Linux or in a build that does not
update itself. Main's own bundle names none of the updater's calls.

## The OS layer

What differs between macOS and Linux lives in `src/os/`: `index.ts` declares the capabilities, `darwin.ts` and
`linux.ts` implement them, and `select.ts` picks one at start. Nothing there imports Electron at run time: a capability
is handed the Electron object it acts on, so the decisions are unit-tested in Node.

| Capability | macOS | Linux |
|---|---|---|
| `windowChrome` | A hidden-inset title bar, the traffic lights inside the sidebar header | The Window Controls Overlay in the header's colours; the window is created shown; a saved position is restored only on X11 |
| `raise` | Restore and focus | On Wayland, hide and show an open window, and rebuild a minimized one (`handoff.ts`); restore and focus on X11 |
| `menu` | The menu bar, with the app menu, Services and Hide | File … Help, opened from the header's menu button or `Alt` |
| `notify`, `badge` | Notification Center; the Dock badge | The freedesktop notification service, with the subtitle folded into the body; the launcher badge |
| `background` | The menu-bar item, with the needs-you count as its title | A coloured tray icon, only while a StatusNotifierItem host is there, with the count in its menu's first line |
| `desktopServices` | Always present | The tray host, the notification service and GNOME's idle monitor, followed on the session bus (`dbus.ts`, a minimal client) |
| `idle` | The system's idle time | The system's, or input to Kea's own windows where the compositor reports none |
| `sandboxStatus` | Always on | Read from the renderer's own process |
| `installKind` | `resources/install-kind` | `resources/install-kind`; a tarball under the home folder is a `--user` install |
| `updates` | Kea's updater where it can replace its own bundle, from the default home; otherwise the install command, with the reason | apt for a deb with Kea's apt source; otherwise the install command (`--no-repo` for an rpm or a deb without the source, `--user` for a home install) |
| `packageWatch` | Not available | One `fs.watch` on `resources/` for a deb or rpm, settled before `app.asar` is compared |
| `report` | How Kea was installed and is updated, how terminals run and how their holders check their client, the window sandbox, the terminal renderer, the menu bar and Notification Center | How Kea was installed and is updated, how terminals detach, how strictly holders check their client, holder visibility, the window sandbox, the terminal renderer, the desktop and its services, idle and file watching |

## Test builds

`--kea-perf` is the switch the test and perf harnesses launch Kea with; a packaged build accepts it only when it was
built with `--perf-probes`. Under it the window never takes keyboard focus, no dialog opens (the harness queues the
folder a pick returns), and no link, folder or file is opened: each is logged or recorded instead.
`--kea-perf-busy=<ms>:<everyMs>` stalls ptyhost on a schedule. A dev build run with `--kea-perf` also records
notifications instead of posting them and installs `globalThis.__keaTest` (`testHooks.ts`), through which
`tests/support/app.ts` reads what was recorded and drives main; core and ptyhost then load
`tests/support/app-child-hooks.cjs` through `NODE_OPTIONS`. Under those hooks `--kea-test-install-kind=<kind>`,
`--kea-test-update-feed=http://127.0.0.1:<port>/…/` and `--kea-test-update-delay=<ms>` set the update check's world,
and a restart Kea would make for an upgrade is recorded, never made. A packaged build never installs the test hooks.

## Tests

Unit tests sit beside the modules (`*.test.ts`). Most modules are pure and run without Electron; `utility.test.ts`
fakes it.

```sh
pnpm exec vitest run --project unit app/main
```

The app-level suites in `tests/` (`e2e`, `chaos`, `memory`, `perf`) launch the built app and reach main through
`__keaTest`. `tools/build.ts` bundles main as `main.cjs`.
