# tools/pack

What `pnpm package` (`tools/package.ts`: every release file) and `pnpm kea:install` (`tools/install.ts`: Kea.app built,
signed and installed on this Mac) are made of.

- **Dependencies**, pinned here so nothing else in the workspace pulls them in: `electron-builder` and `@electron/fuses`
  (flip and read back the fuses). Both tools resolve them from this package.
- **`src/`**: the rules, each a small module with its unit tests beside it, so the tools themselves are mostly a
  sequence.
  - The build, shared by both tools: `config.ts` (electron-builder's configuration, one function per system over shared
    parts; the targets and `--target` / `--formats`) · `app.ts` (the `dir` app, debug symbols out of the native
    modules, the fuses) · `macApp.ts` (signing inside out with the local certificate, and the checks of a built
    Kea.app) · `icons.ts` (`assets/icon/`, below) · `appPackage.ts` (the built app's `package.json`: its `desktopName`
    is the dev build's, `dev.kea.app.dev.desktop`; the Linux packages set `dev.kea.app.desktop` in `config.ts`).
  - `pnpm package`'s own: `macZip.ts` (the zip with `ditto`, its blockmap, `latest-mac.yml`, the zip checked
    unpacked) · `os/linuxPackage.ts` (the Linux packages' one staged root, every file with its owner and mode, the
    desktop file, the AppArmor profile, the scripts after install and after removal, the deb's control file, the rpm's
    spec) · `os/linuxLint.ts` (what lintian and rpmlint may say, each with why) · `checks.ts` (the checks on both
    systems: nothing names the build machine, no source maps, every ELF the target's; the packages' listings read
    back) · `licences.ts` (the licences file: the bundles' npm packages, the helper's crates, Electron's) ·
    `notices.ts` (the notices the licences file carries besides the packages' own licence files, in order: Kea's
    licence, Electron's, then Oniguruma's and the TextMate grammars' that the file viewer's syntax highlighter bundles,
    pinned to the versions it names) · `release.ts` (one version; what a `--release` build needs; the shared
    certificate's leaf, which `install.sh` pins) · `os/smoke-linux.sh` (the package smoke test, below).
  - `install.sh`: `os/install.sh` is its template, `os/installScript.ts` the build that writes in the release's values
    (below); `os/installFixtures.ts` makes the signed stand-in release its unit tests check against
    (`fixtures/install/signing`). The end-to-end install test's tooling: `os/standin-release.sh` (a stand-in release,
    signed with a throwaway key), `os/release-standin.ts` (an HTTPS server answering as github.com, its asset host and
    Pages), `os/install-e2e.sh` (the containers), `os/install-container.sh` and `os/install-macos.sh` (one system
    each), `os/dry-run-normal.sh` (the goldens).
  - `pnpm kea:install`'s own: `signature.ts` (reading a signature back) · `asar.ts` and `audit.ts` (what a packaged
    Kea must not carry: an update feed, a crash reporter, a network client; native modules unpacked; a run's net
    log) · `processes.ts` and `running.ts` (this user's processes from `kea-helper procs --args` of the build's own
    release helper; which are the Kea of one bundle, its holders by build, asking it to quit) · `replace.ts` (stage,
    swap, recover) · `target.ts` and `options.ts` (where an install may go, which switches install at all) ·
    `plan.ts` (what the tool says before it changes anything, and whether Kea is opened again) · `unregister.ts` (a
    test build taken out of LaunchServices before it is deleted).
  - `os/`, the parts that differ by system: `packTools`, every system tool by its path (macOS's for signing and the
    install, Linux's for the packages); `rust`, where cargo is; `installPlace`, `/Applications`, the refusal off Apple
    silicon and the certificate steps (Linux has none: its packages install Kea); `nativeAddons`, the darwin
    prebuilds, and on Linux the glibc prebuilds, with Kea's patched watcher where pnpm built it on either system;
    `devDesktop`, on Linux the dev build's desktop file and its sandbox check that `tools/dev.ts` runs, none on macOS.
    `os/kea-app.sh` is Linux's launcher, `/usr/bin/kea-app`: it checks Chromium's sandbox before Chromium starts and
    prints the fix instead of a crash, and never passes `--no-sandbox`.

The chaos suite's update tests (`tests/chaos/app-update.test.ts`) install a second signed build over a running first
into a temp target, and check a Kea that does not quit.

## `pnpm package`

```
node tools/package.ts [--target mac-arm64|linux-x64|linux-arm64] [--formats <list>] [--out <dir>] [--release] [--adhoc]
                      [--test-repository <owner/name> --test-key <key>]
```

Always on a machine of the target's system and architecture (another is refused: native modules and the helper are
built where they run). The files go to `dist/package`:

- **mac-arm64**: `Kea-<version>-arm64-mac.zip`, its `.blockmap` and `latest-mac.yml` (which names the zip by its
  versioned release URL). The app is signed inside out exactly as `pnpm kea:install` signs it, with the "Kea Local Code
  Signing" certificate every macOS release carries ("Always Allow" at codesign's keychain prompt, as below); the
  private key never leaves the keychain. Without the certificate, `--adhoc` checks the pipeline.
- **linux-arm64**, **linux-x64**: `kea-app_<version>_<arch>.deb`, `kea-app-<version>-1.<arch>.rpm`,
  `kea-app-<version>-linux-<arch>.tar.gz`, each with the same files. Needs `dpkg-deb`, `rpmbuild` and `rpm` (Ubuntu's
  `rpm` package), `lintian`, `rpmlint`, `desktop-file-validate` and `apparmor_parser` (AppArmor 4 reads the profile's
  abi; on an older one that check is skipped and the smoke test checks the profile where it is installed).

Steps: one version for the app, every package and the helper → the helper for the target, built with this machine's
paths mapped away (`--remap-path-prefix`) → release bundles into `dist/pack-app`, with the list of npm packages they
hold → the licences file → electron-builder's `dir` app → debug symbols out of the native modules (a module pnpm built
here names its build folder in them) → fuses → the system's checks and the archives, each checked. A failing line
stops the run and says why. `--release` also refuses while Kea's repository is not named
(`packages/protocol/src/release.ts`; never guessed), while the Linux repository key is missing
(`assets/release/kea-app.gpg`, not in the repository yet: it is added for the first release), with `--adhoc`, and
with what lint accepts only until a release (the packages' placeholder maintainer address).

The Linux packages also install the terminal font from `assets/fonts/` (its README gives the source, hashes and
licence) into `/usr/share/fonts/kea-app/`, so fontconfig gives it to Chromium with no code of Kea's; its licence goes
into the Linux licences file. macOS's zip has none (its terminal font is SF Mono).

**The package smoke test**, by hand before a release, for each image of a tested system (the repository's README
names them):

```sh
podman run --rm -v $PWD/dist/package:/pkgs:ro -v $PWD/tools/pack/src/os/smoke-linux.sh:/smoke.sh:ro <image> sh /smoke.sh /pkgs/<package>
```

It installs the package with the system's own tool, checks the files, modes, desktop file, font and AppArmor profile,
starts Kea as a new user under an Xvfb of its own with a temporary KEA_HOME, reads the platform report, quits Kea
completely and starts it again, removes the package and checks that only `~/.config/Kea` and KEA_HOME are left (the
desktop libraries' own stores, fontconfig's and dconf's caches, NSS's certificate database and IBus's bus address, are
reported, not counted). It opens no terminal: a packaged Kea has no test hooks and refuses the debugging switches, so
checking that a terminal survives the quit needs a driver for the packaged window, which this test does not have.

## `install.sh`

The release's installer for both systems. `os/install.sh` is a template: `os/installScript.ts` writes in the
repository (`RELEASE_REPOSITORY`), the repository key's fingerprint (read from the key, v4 or v6), the shared
certificate's leaf, the oldest versions from `constants/`, the repository files exactly as the packages write them and
the tarball's files outside its tree, and refuses a value it does not know or a `@@` left over. `pnpm package` writes
it into the output when the repository's key is present; `--release` refuses without it. A test build names a test
repository and key: `pnpm package --test-repository <owner/name> --test-key <key>`, or alone,
`node tools/pack/src/os/installScript.ts --out <file> --test-repository <owner/name> --test-key <key>`. Never run it on
a machine of your own: only in containers and VMs (it installs, and `install-macos.sh` edits `/etc/hosts`).

The repository's README gives the one-line install and `docs/install-linux.md` the commands to install by hand on
Linux; a unit test holds both to what the dry runs print.

**The end-to-end install test.** Linux, on a machine with podman and `shellcheck`, which lets a user bind port 443
(`net.ipv4.ip_unprivileged_port_start=443`, for the run):

```sh
sh tools/pack/src/os/standin-release.sh key <work>
node tools/package.ts --target linux-arm64 --test-repository kea-test-owner/kea --test-key <work>/kea-app.gpg --out <dir>
sh tools/pack/src/os/install-e2e.sh <work> <dir> [--update-goldens] [image…]
```

It signs a stand-in release with the throwaway key (and makes two tampered copies), serves it on 127.0.0.1:443 as
GitHub serves a release, runs `install-container.sh` in a clean container of each system with those hosts pointed at
it, compares each dry run with `fixtures/install/dry-run/` and runs `shellcheck`. `--user`'s install needs a kernel
that lets unprivileged programs make user namespaces (on Ubuntu, `kernel.apparmor_restrict_unprivileged_userns=0` for
the run); otherwise the container checks its refusal. macOS: in a clean Tart VM, the zip signed on the Mac and
`install.sh` built for the same key, served by `release-standin.ts --listen 127.0.0.1 --port 8443` on the Mac and
reached through `ssh -R 8443:127.0.0.1:8443`; then `sh install-macos.sh <owner/name> <version> <folder> <out>` in the
VM, and on the Mac `sh dry-run-normal.sh <out>/dry-run-mac.txt <owner/name> <fingerprint> <version>` must equal
`fixtures/install/dry-run/dry-run-mac.txt`. gpg's agent socket must have a short path (macOS allows 104 bytes): keep
`<work>` short. A unit test holds every golden to `dry-run-normal.sh`'s placeholders (no architecture, home, version
or key of a run).

## Icons

`src/icons.ts` draws every file in `assets/icon/` from the Kea mark (`packages/ui/src/mark.ts`, the K that main also
draws its menu-bar and tray icon from) and the design tokens, with no image tool and no new dependency: shapes are
rasterised in TypeScript with supersampling, the app icon once on Apple's 1024 px grid and averaged down to every
smaller size; PNG is written with `node:zlib` and the ICNS chunk by chunk (16 and 32 px as ARGB, the rest as PNG), so
it builds on Linux too. The app icon is the K in the accent on the terminal canvas (`--surface-0`), outlined in
`--line-strong`, on Apple's 824 px body with continuous corners and macOS's icon shadow; `kea.svg` is the same art as a
vector. The menu-bar template (`trayTemplate*.png`, black and alpha) and the Linux tray icon (`trayAccent*.png`) have
exactly the pixels main draws at run time. `node src/icons.ts` writes the folder and `--check` fails when it differs (a
PNG is compared by its pixels, since another zlib may compress the same pixels differently). Every geometry number
comes from `constants/limits.toml`'s icons section. Tests: `src/icons.test.ts`; the gallery's set V-16 shows the
committed files.

## `pnpm kea:install`

```
node tools/install.ts [--no-install] [--no-relaunch] [--adhoc] [--perf-probes] [--out <dir>] [--version-suffix <s>]
                      [--install-to <dir>]
```

1. **Build**: release bundles into `dist/pack-app` (this tool's own folder, never `dist/app`) and the release
   `kea-helper`; an arm64 `dir` target, Electron's `default_app.asar` dropped, `**/*.node` unpacked, `kea-helper` in
   `Contents/Resources`; fuses flipped (runAsNode, nodeOptions, nodeCliInspect, grantFileProtocolExtraPrivileges off;
   onlyLoadAppFromAsar, embedded asar integrity on); signed inside-out with "Kea Local Code Signing" (or ad hoc with
   `--adhoc`; hardened runtime off, no entitlements, no timestamp server; `kea-helper` as `dev.kea.helper`). Without
   `--adhoc` the certificate is checked first with `security find-identity` (read-only), and the tool explains how to
   create it.
2. **Check**: `codesign --verify --deep --strict`; one signer for every signed item, no hardened runtime, no team
   identifier; arm64 only; the certificate leaf in the designated requirement; fuses read back;
   `ElectronAsarIntegrity`; the audit of `src/audit.ts`.
3. **Install** (the plain command only; `--adhoc`, `--perf-probes` and `--version-suffix` builds are never installed
   for use): it says what is at `/Applications/Kea.app`, whether Kea runs from it and how, and which terminals are
   alive under `~/.kea` by build (read-only looks), then what it will do. It copies the build beside the app and
   verifies it, asks Kea to quit completely and waits a bounded time (if Kea does not quit, nothing is replaced), swaps
   the app by two renames, and opens Kea again only if its window was in front. What a killed run left is put right by
   the next.

`--install-to <dir>` is the test target (`<dir>/Kea.app`; never an Applications folder, by any spelling: `target.ts`
compares every folder on the way by device and inode, and `--out` is held to the same rule; Kea is never opened there):
every test of the install step uses it, and it is the only way a `--perf-probes` or `--version-suffix` build is
installed anywhere.

## The survival check with signed builds

Whether terminals survive a quit, a kill and an update to a separately built Kea (`tools/perf/src/survival.ts`):

1. `security find-identity -v -p codesigning` lists "Kea Local Code Signing" exactly once.
2. `pnpm kea:install --no-install`: choose "Always Allow" at codesign's keychain prompt (otherwise one prompt per
   signature). The summary shows the certificate as signer and a requirement with `certificate leaf = H"…"`.
3. Builds N and N+1, then the survival run:
   - `pnpm kea:install --perf-probes --out dist/s7/n`
   - `pnpm kea:install --perf-probes --version-suffix n1 --out dist/s7/n1`
   - `node tools/perf/src/survival.ts --app dist/s7/n/Kea.app --next-app dist/s7/n1/Kea.app`, where every row must say
     yes, including "new build: the old holder admits it" with 0 refusals.
4. Quit any Kea, then `pnpm kea:install` installs `/Applications/Kea.app` for the checks that need a person
   (Background App Activity, privacy prompts, notifications).
5. Delete `dist/s7` and unregister those builds, so lookups by the `dev.kea.app` bundle id (notifications, privacy
   grants) find only the installed app. The survival run ends with one line per build that names the command
   (`/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u
   <path>`; it also works after the folder is gone). A build in a temp folder or `dist/test-app-*` is unregistered by
   the harness that launched it (`src/unregister.ts`); one under `dist/s7` or `dist/pack` never is, and no harness
   ever touches the entry of `/Applications/Kea.app`.
