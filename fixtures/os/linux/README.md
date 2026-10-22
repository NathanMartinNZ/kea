# Linux `/proc` fixtures

Recorded on 2026-10-19 in an arm64 Ubuntu 24.04.5 VM (kernel 6.8, glibc 2.39, stock `/proc`), as an unprivileged
desktop user (uid 1001). The pure parts of `native/kea-helper/src/os/procfs.rs` run against them on every system.

- `proc/` — a small `/proc` tree: `stat` (with `btime`); `1` (systemd) and `2` (kthreadd), root's; `2472`, a Python
  program holding five TCP listeners; `2507`, a `sleep`; `2516`, a zombie (no memory lines, no `exe`, empty
  `cmdline`). Each has the files `kea-helper procs` reads (`stat`, `status`, `cmdline`, and `exe` as a symlink where
  the user could read it). `CLK_TCK` was 100.
- `procs.txt` — `kea-helper procs --args` of that tree for uid 1001 (`crate::procs::line`), each start followed by
  `/` and its raw `starttime` in clock ticks.
- `self-cgroup` — `/proc/self/cgroup` of an SSH login (cgroup v2 only).
- `net/host/` — `2472`'s `net/tcp`, `net/tcp6` and its descriptors (`fd.links`: `readlink` of each `fd/<n>`). It
  listens on `127.0.0.1:53455`, `0.0.0.0:51429`, `[::1]:35429`, `[::]:53533` (dual stack) and
  `[::ffff:127.0.0.1]:36167`, and holds one connected pair to itself. Other users' rows (sshd, systemd-resolved) and
  a `TIME_WAIT` row are in the same tables.
- `net/ns/` — the same program in a network namespace of its own (`unshare -n`, then run as uid 1001): its tables
  hold only its own sockets (`127.0.0.1:55185`, `0.0.0.0:53199`, `[::1]:40377`, `[::]:40633`,
  `[::ffff:127.0.0.1]:40295`). Read as root, so the kernel's socket pointers were zeroed, as an unprivileged reader
  sees them; its stdio descriptors were pipes renamed from the recorder's FIFOs.
- `admission/` — what the holder's admission check reads of a peer: `maps` and `cmdline` of the utility process of
  the admission test app (`tools/process-zoo/src/admission-app`), run by a root-owned Electron 44.5.1 copy at
  `/opt/kea-test` with `--no-sandbox --ozone-platform=headless --disable-gpu`. Its executable mappings are Electron's
  own and the system's libraries (root's, under `/opt/kea-test` and `/usr/lib`), the JIT's anonymous ones and
  `[vdso]`; its `cmdline` is Chromium's rewritten title, one string with spaces, not NUL-separated arguments.
- `desktop/` — desktop entries for `app/core/src/editor/desktop.ts`, written after the ones the
  packages ship rather than recorded from an install: `code.desktop` (VS Code's `.deb`: `/usr/share/code/code %F` and
  an action group), `code_code.desktop` (its snap: an `env` prefix before `/snap/bin/code`), `dev.zed.Zed.desktop`
  (Zed's installer, under `/home/HOME___/.local/zed.app`, with `TryExec`), `quoted.desktop` (a quoted program with
  spaces, the escapes inside quotes, field codes and `%%`) and `hidden.desktop` (`Hidden=true`).
- `ip_local_port_range` — `/proc/sys/net/ipv4/ip_local_port_range` of that VM, as the kernel prints it (`32768`, a
  tab, `60999`): the stock ephemeral range, below which core keeps the dev servers' port blocks.
- `mountinfo` — `/proc/self/mountinfo` read by root in a mount namespace of its own (`unshare -m --propagation
  slave`, so nothing reached the VM's own table), with a tmpfs at `/mnt` and another at `/mnt/work on nfs`, which
  the kernel writes as `/mnt/work\040on\040nfs`. The VM had no network share to mount: the test
  adds network file system lines written in the same format (proc(5)).
- `inotify-fdinfo` — `/proc/self/fdinfo/<n>` of a Node process's inotify instance (recorded 2026-10-20 in that VM)
  holding two directory watches: one `inotify wd:` line per watch, which is how core counts its own watches for
  the file-watching banner and the platform report.
- `os-release` — `/etc/os-release` of that VM (Ubuntu 24.04.5 LTS), which main's platform report names the system by
  (`osReleaseName`).
