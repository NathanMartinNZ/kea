# Kea

[![Latest release](https://img.shields.io/github/v/release/NathanMartinNZ/kea?include_prereleases&sort=semver&label=release&color=8246e7)](https://github.com/NathanMartinNZ/kea/releases)
[![Tests](https://img.shields.io/github/actions/workflow/status/NathanMartinNZ/kea/ci.yml?branch=main&label=tests)](https://github.com/NathanMartinNZ/kea/actions/workflows/ci.yml)
[![Licence: MIT](https://img.shields.io/badge/licence-MIT-8246e7)](LICENSE)
[![macOS 14 or later on Apple silicon](https://img.shields.io/badge/macOS-14%2B%20Apple%20silicon-8246e7)](#macos)
[![Linux on x64 or arm64](https://img.shields.io/badge/Linux-x64%20%C2%B7%20arm64-8246e7)](#linux)
[![Agents: Claude Code and Command Code](https://img.shields.io/badge/agents-Claude%20Code%20%C2%B7%20Command%20Code-8246e7)](#requirements)

![Pixel art of three kea, New Zealand's alpine parrot, on a snowy ridge above a glacial lake, one tugging at a pack](docs/hero.jpg)

Kea is a desktop app for macOS (Apple silicon) and Linux that runs coding-agent CLIs side by side: Claude Code and
Command Code today. Each session gets its own git worktree and branch, a real terminal running the agent's own CLI, a
live file tree with the session's changes, and a dev server one click away. The sidebar shows which sessions are
working, which are waiting for you and which have finished. Sessions keep running when Kea quits, crashes or is
updated.

Kea has no account, no server and no telemetry. It runs the agent CLIs you already use, signed in as you.

<!-- screenshot:
![Kea with projects and sessions in the sidebar, a session's changes and its agent terminal](docs/screenshot.png)
-->

## Install

> [!NOTE]
> Kea's dnf and zypper repositories are not published yet. On Fedora and openSUSE, add `--no-repo`
> (`… | sh -s -- --no-repo`): Kea then installs from the release itself, and running the command again updates it.

Kea needs macOS 14 or later on Apple silicon (Intel Macs are not supported), or Linux on x64 or arm64 with
glibc 2.35 or later. It also needs git 2.40 or later and a signed-in agent CLI (see [Requirements](#requirements)).

```sh
curl -fsSL https://github.com/NathanMartinNZ/kea/releases/latest/download/install.sh | sh
```

The same command works on macOS and Linux. To see what it would do without changing anything:

```sh
curl -fsSL https://github.com/NathanMartinNZ/kea/releases/latest/download/install.sh | sh -s -- --dry-run
```

To read the script before running it, download it and run it with `sh`; it behaves as the piped command does:

```sh
curl -fsSLO https://github.com/NathanMartinNZ/kea/releases/latest/download/install.sh
less install.sh
sh install.sh
```

The script downloads over HTTPS only, checks every file against the release's `SHA256SUMS`, and checks Kea's signing
key against the fingerprint written into the script. Where `gpgv` or `sqv` is installed, it also checks the signature
of `SHA256SUMS` with that key. It prints each command that changes the system before running it; the only password it
asks for is `sudo`'s. Options go after `sh -s --`, or after `sh install.sh` for a downloaded copy:

| Option | What it does |
|---|---|
| `--dry-run` | Print what it would do and change nothing |
| `--version <v>` | Install that release instead of the newest |
| `--no-repo` | Linux: install the package without Kea's repository, so it is never updated |
| `--user` | Linux: install into `~/.local` without root (see below) |
| `--uninstall` | Remove what it installed; `~/.kea` stays |
| `--help` | List the options |

### macOS

The command installs `Kea.app` in `/Applications`, using `sudo` only if you cannot write to that folder. To update,
quit Kea completely (`⌥⌘Q`; its sessions keep running) and run the command again. Settings, sessions and terminals
carry over.

Kea's macOS builds are signed with the project's own certificate, not an Apple Developer ID, and are not notarised.
This does not affect the install command. It does affect an app downloaded with a browser: macOS refuses to open it
until you clear the download flag once:

```sh
xattr -dr com.apple.quarantine /Applications/Kea.app
```

To install by hand, download `Kea-<version>-arm64-mac.zip` from the
[latest release](https://github.com/NathanMartinNZ/kea/releases/latest), move `Kea.app` to Applications and run the
command above before the first open. Or, after a refused open, use System Settings › Privacy & Security › Open Anyway.

### Linux

The command picks the install for your system:

| System | What the command does |
|---|---|
| Debian, Ubuntu | Adds Kea's apt repository and installs the `kea-app` package |
| Fedora and RHEL-like | Adds Kea's dnf repository and installs `kea-app` |
| openSUSE | Adds Kea's zypper repository and installs `kea-app` |
| Anything else (Arch, …) | Unpacks the tarball into `/opt/Kea` and lists every file it installs in `/opt/Kea/.install-manifest` |

A package from Kea's repository updates with the rest of the system (`apt upgrade`, `dnf upgrade`, `zypper update` or
the software centre); quit Kea completely and open it again to run the new version. A tarball install updates by
running the command again (with `--user` for a home install).

`--user` installs the tarball into your home without root. Kea's own files are then writable by your user, so an
agent could change Kea itself; the installer says so. Where AppArmor restricts user namespaces (Ubuntu 23.10 and
later), Kea cannot start without root, and `--user` stops before installing anything.

The installer and packages are tested on Ubuntu 24.04 and 26.04, Debian 13 and Fedora. openSUSE and other glibc
systems are best effort. [Installing Kea on Linux by hand](docs/install-linux.md) covers a downloaded `.deb` or
`.rpm`, adding Kea's repository yourself and unpacking the tarball.

### Requirements

- git 2.40 or later, for the sessions' worktrees. On macOS, `xcode-select --install` installs it; the Linux packages
  recommend it, so apt and dnf install it with Kea. Without git, Kea still opens folders, with no worktrees and no
  Changes view.
- At least one agent CLI, installed and signed in as you use it in a terminal:
  [Claude Code](https://code.claude.com/docs/en/setup) (`claude`) or
  [Command Code](https://commandcode.ai/docs/quickstart) (`cmd`). Settings › Agents shows where Kea found each one,
  its version and whether it is signed in.

### Uninstall

```sh
curl -fsSL https://github.com/NathanMartinNZ/kea/releases/latest/download/install.sh | sh -s -- --uninstall
```

Add `--user` for a home install. This removes the app, and on Linux the package with Kea's repository and key. It
leaves `~/.kea`: the sessions' worktrees, which may hold uncommitted work, their scrollback and your settings.
Terminals still running keep running after Kea is gone.

<details>
<summary>Remove everything, including sessions and settings</summary>

1. Save what you need from the sessions' worktrees. Uncommitted work exists only there; commits are on branches in
   your own repositories (named `kea/…` by default) and stay.
2. In Kea, stop every session and quit: set Settings › General › On quit to "Stop all sessions and quit", then quit.
3. Run the uninstall command above.
4. Delete `~/.kea`, and Electron's window state: `~/Library/Application Support/Kea` and
   `~/Library/Preferences/dev.kea.app.plist` on macOS, `~/.config/Kea` on Linux.
5. In each repository that had sessions, `git worktree prune` drops the entries of the deleted worktrees.
   `git for-each-ref refs/kea` lists snapshots of recently deleted sessions; `git update-ref -d <ref>` removes one.

</details>

## Getting started

1. **Add a project:** `⌘O`, or drop a folder on the window. In a git repository each session gets a worktree and a
   branch of its own unless you turn Worktree off in the composer; a plain folder runs its sessions in place.
2. **Start a session:** `⌘N`, describe the task, change the agent, model or permission mode if the defaults do not
   suit, then `⌘↵`. `⌥⌘↵` starts it in the background and keeps the composer open for the next task.
3. **Work with it:** the Agent tab is the CLI's own terminal; `⌘T` opens a shell in the same folder; Files and Changes
   show what the agent did; `⌘R` runs the dev server (the project's run command, or `start.sh` in the worktree);
   `⇧⌘O` opens the worktree in your editor.

By default `⌘Q` closes the window and keeps Kea in the menu bar, so notifications and the count of sessions that need
you keep working; `⌥⌘Q` quits completely. On Linux, `Ctrl+Shift+Q` closes the window and Kea keeps running in the
background where the desktop has a tray. Sessions keep running either way.

### Keyboard shortcuts

| Command | macOS | Linux |
|---|---|---|
| Add Project… | `⌘O` | `Ctrl+Shift+O` |
| New Session · New Session in Project… | `⌘N` · `⇧⌘N` | `Ctrl+Shift+N` · `Ctrl+Shift+Alt+N` |
| In the composer: start · start in the background | `⌘↵` · `⌥⌘↵` | `Ctrl+Shift+Enter` · `Ctrl+Shift+Alt+Enter` |
| Jump to the next session that needs you | `⌘J` | `Ctrl+Shift+J` |
| Jump to a session by its place in the sidebar | `⌘1` … `⌘9` | `Ctrl+Shift+1` … `9` |
| Next · previous session, most recently used first | `⌃Tab` · `⌃⇧Tab` | `Ctrl+Tab` · `Ctrl+Shift+Tab` |
| New Shell Tab · Close Tab | `⌘T` · `⌘W` | `Ctrl+Shift+T` · `Ctrl+Shift+W` |
| Go to File… | `⌘P` | `Ctrl+Shift+P` |
| Show Files · Show Changes | `⇧⌘E` · `⇧⌘G` | `Ctrl+Shift+E` · `Ctrl+Shift+G` |
| Run or stop · restart the dev server | `⌘R` · `⇧⌘R` | `Ctrl+Shift+R` · `Ctrl+Shift+F5` |
| Open in Editor | `⇧⌘O` | `Ctrl+Shift+Alt+O` |
| Archive the session | `⇧⌘⌫` | `Ctrl+Shift+Backspace` |
| Command Palette | `⇧⌘P` | `Ctrl+Shift+Alt+P` |
| Close the window · Quit Kea Completely | `⌘Q` · `⌥⌘Q` | `Ctrl+Shift+Q` · `Ctrl+Shift+Alt+Q` |

Help › Keyboard Shortcuts lists every command with its current keys. Keys that a terminal program needs, such as
`Ctrl+C`, always reach the terminal.

### Settings and key bindings

`⌘,` (`Ctrl+Shift+,` on Linux) opens Settings. The values live in `~/.kea/settings.json`, a JSON-with-comments file you
can also edit by hand: Kea applies a saved change at once and keeps your comments and order when you change a value in
the window. Key bindings live in `~/.kea/keybindings.json` (Settings › Keyboard opens it and lists every command's
id):

```jsonc
[
  { "command": "terminal.jumpToBottom", "key": "cmd+alt+b" }, // ⌥⌘B on macOS, Ctrl+Shift+Alt+B on Linux
  { "command": "session.archive", "key": null }               // no key
]
```

`cmd` means the system's main modifier: `⌘` on macOS, `Ctrl+Shift` on Linux. A file that breaks a rule or takes
another command's key is reported in Settings › Keyboard; the rest of it still applies.

### Reporting a problem

- **Report Wrong Status** (`⌥⌘J`, or `Ctrl+Shift+Alt+J` on Linux, on the session) records what the status should have
  been. Kea saves the evidence to `~/.kea/reports/` and sends nothing. The report holds the session's screen and the
  end of its transcript, so read it before you share it.
- **Copy Diagnostics** (Help menu, the palette, or Settings › Advanced) copies versions, the agent CLIs found, session
  counts, background processes, recent warnings and errors, and each process's memory. It never includes terminal
  content, and no file path outside `~/.kea` unless you tick "Include file paths". Paste it into a bug report.
- Logs are in `~/.kea/logs` (Settings › Advanced › Open logs folder).

## Where Kea keeps its data

Everything is in `~/.kea`:

| Path | What |
|---|---|
| `kea.db` | Projects and sessions: names, order and options |
| `settings.json`, `keybindings.json` | Your settings and key bindings |
| `worktrees/` | The sessions' checkouts, unless Settings › General names another location |
| `sessions/` | Each terminal's state and scrollback |
| `bin/` | The copy of `kea-helper` that running terminals use |
| `run/` | Sockets and locks |
| `logs/`, `reports/` | Logs and status reports |

On macOS, `run/`, `sessions/`, `bin/`, `logs/` and `reports/` are excluded from Time Machine: scrollback can hold
secrets and changes all the time. Worktrees are backed up, without rebuildable folders such as `node_modules`.
Electron's window state is in `~/Library/Application Support/Kea` on macOS and `~/.config/Kea` on Linux.

## What Kea does not do

- **Change your repositories' configuration or the agents' own folders** (`~/.claude`, `~/.commandcode`). What an
  agent needs from Kea is passed to its process when it starts. In a repository Kea uses git: a worktree and a branch
  per session, and a ref under `refs/kea/` that keeps a deleted session restorable. It runs `git init` or discards a
  change only when you click it.
- **Make network requests of its own.** No update check, no telemetry, no crash reports. The agents and your dev
  servers use the network as they would in a terminal.
- **Stop a session because the app went away.** After a quit, a crash or an update the terminals keep running; a
  session ends when you stop, archive or delete it.

## How it works

Kea is an Electron app. Its main process owns windows and menus, `core` owns sessions, git, files and settings, and
`ptyhost` connects the window to the terminals. Each terminal runs inside its own `kea-helper`, a small Rust process
that holds the PTY and its scrollback. It is detached from Kea, so it outlives a quit or a crash, and a new Kea finds
the running helpers and reattaches. The repository map is in [CONTRIBUTING.md](CONTRIBUTING.md#finding-your-way-around).

## Build from source

You need Node 26 or later, pnpm 11, a Rust toolchain, Python 3, and a C and C++ compiler (Xcode Command Line Tools on
macOS, `build-essential` or your system's equivalent on Linux); [docs/building.md](docs/building.md) has the details.

```sh
npm install -g pnpm@11
git clone https://github.com/NathanMartinNZ/kea.git
cd kea
pnpm install
pnpm dev    # build kea-helper and Kea, then run it; its data goes to ~/.kea-dev, never ~/.kea
```

To build and install a signed `Kea.app` on your own Mac (`pnpm kea:install`), or Linux packages (`pnpm package`), see
[docs/building.md](docs/building.md). It also covers the one-time signing certificate and updating while sessions
are running.

## Contributing

Bug reports and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the checks to run and
the project's conventions. Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Licence

Kea is released under the [MIT licence](LICENSE). The bundled font, code ported from xterm.js and the recorded agent
output in `fixtures/` keep their own licences: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Kea is an independent project. It is not affiliated with or endorsed by Anthropic or Command Code.
