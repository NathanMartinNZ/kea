# Building Kea from source

## Requirements

- macOS 14 or later on Apple silicon, or Linux (x64 or arm64) with glibc 2.35 or later.
- Node.js 26 or later.
- pnpm 11 (`npm install -g pnpm@11`); `package.json` pins the exact version.
- A Rust toolchain: `brew install rustup && rustup default stable` on macOS, or [rustup.rs](https://rustup.rs).
  `tools/cargo.ts` finds Homebrew's `cargo` even when it is not on your `PATH`.
- A C and C++ compiler and Python 3: Xcode Command Line Tools (`xcode-select --install`) on macOS,
  `build-essential` and `python3` (or your system's equivalents) on Linux. `pnpm install` builds Kea's patched file
  watcher from source with them; without them it keeps the prebuilt watcher, prints a warning, and Kea runs without
  the patch's fixes. Some tests also compile small C programs.
- git 2.40 or later.

## A development build

```sh
pnpm install    # dependencies, and Electron's binary
pnpm dev        # build kea-helper (the Rust process every terminal runs in) and Kea, then run it
```

A development build keeps its data in `~/.kea-dev`, never in `~/.kea`, so it runs beside an installed Kea. Its
window state is in `~/Library/Application Support/Kea-dev-…` on macOS and `~/.config/Kea-dev-…` on Linux. Ctrl-C
stops it; its terminals keep running, as they would after quitting the installed app. Arguments after `pnpm dev` go
to Kea, for example a throwaway home:

```sh
pnpm dev --kea-home=/tmp/kea-try
```

On Linux, `pnpm dev` writes a desktop file for the development build to `~/.local/share/applications` (notifications
need it to bring the window forward); `pnpm dev --remove-desktop-file` removes it. If Chromium's sandbox cannot start
on your system, `pnpm dev` prints the fix and stops.

## A signed Kea.app on your own Mac

`pnpm kea:install` builds a release, signs the app, `kea-helper` and every native module with a certificate from your
keychain, checks the result, and installs it as `/Applications/Kea.app`. Signing with the same certificate every time
means macOS sees the same app after each rebuild, so it keeps Kea's notification permission and privacy grants, and
each terminal's helper accepts only a Kea signed with it.

### Once: the signing certificate

The certificate exists only in your login keychain. `pnpm kea:install` looks for it (read-only) and prints these steps
when it is missing.

1. Keychain Access › menu Keychain Access › Certificate Assistant › Create a Certificate…
2. Name `Kea Local Code Signing`, Identity Type "Self-Signed Root", Certificate Type "Code Signing", then Create.
3. Open the new certificate in the login keychain › Trust › Code Signing: "Always Trust". Close the window to save.
4. Check: `security find-identity -v -p codesigning` must list "Kea Local Code Signing" once.

If Certificate Assistant fails ("The specified item could not be found in the keychain"), create the certificate in
Terminal with the system's own `openssl` (Homebrew's OpenSSL 3 may write a key bundle Keychain cannot import):

```sh
mkdir -m 700 ~/kea-cert-tmp && cd ~/kea-cert-tmp
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Kea Local Code Signing" -addext "basicConstraints=critical,CA:false" -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" -keyout key.pem -out cert.pem
/usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -name "Kea Local Code Signing" -out kea.p12 -passout pass:kea
security import kea.p12 -k ~/Library/Keychains/login.keychain-db -P kea -T /usr/bin/codesign
security add-trusted-cert -p codeSign -k ~/Library/Keychains/login.keychain-db cert.pem
cd ~ && rm -rf ~/kea-cert-tmp
```

The first build asks for keychain access once per signature unless you choose "Always Allow".

Releases are signed with the project's certificate, not yours, and `install.sh` installs only those.

### Build and install

```sh
pnpm kea:install                # build, sign, check, then install /Applications/Kea.app
pnpm kea:install --no-install   # stop after the checks; the app is in dist/pack
pnpm kea:install --adhoc        # check the pipeline without the certificate (never installed)
```

The checks cover the signatures, an arm64-only build, and what the app may reach: no crash reporter, and no network
client but the update check and the macOS updater, each in its own bundle. The app carries the updater's code but no
update feed, so it never updates itself: run `pnpm kea:install` again for a newer build. Nothing in `/Applications`
changes before the checks pass.

### Updating while sessions are running

Run `pnpm kea:install` again. You do not need to quit Kea or stop anything first; where it cannot go on safely, it
stops before changing anything and says why. In order, it:

1. reports what it found: the version in `/Applications`, whether Kea is running from it and how many terminals run
   in the background;
2. builds, signs and checks the new app;
3. looks again, and finishes or rolls back whatever an earlier run left if that run was killed part-way;
4. copies the new app next to the old one and verifies its signature there, while Kea keeps running;
5. asks Kea to quit completely and waits for it; if Kea has not quit in time, nothing is replaced;
6. replaces `/Applications/Kea.app`;
7. opens Kea again only if it was running with its window in front. A Kea that was in the menu bar or behind
   another app is left closed, so no window takes your keyboard, and the tool says so.

Every terminal survives with its scrollback, whether it runs an agent in the middle of a turn, a dev server or a
shell: terminals run from their own copy of `kea-helper` in `~/.kea/bin`, never from the app, and the new Kea
reattaches to them. Names, order and settings are kept, and macOS keeps the notification permission and privacy
grants because the path and the signature are the same. While Kea is closed nothing posts notifications; a session
that finished or asked for you meanwhile shows the right status when Kea opens again.

On its first launch a new build removes the helper copies of earlier builds that no terminal uses any more.

### Removing it

Follow [Uninstall](../README.md#uninstall) in the README, then delete "Kea Local Code Signing" from the login keychain
in Keychain Access.

## Linux packages

```sh
pnpm package                      # the .deb, .rpm and tarball for this machine, in dist/package
pnpm package --formats deb        # only some of them
```

`pnpm package` builds on a machine of the target's system and architecture only (no cross-builds) and checks each
package with `lintian` and `rpmlint`. It needs `dpkg-deb`, `rpmbuild`, `lintian`, `rpmlint`, `desktop-file-validate`
and `apparmor_parser` from your distribution. Install the result with your package manager, for example:

```sh
sudo apt install ./dist/package/kea-app_<version>_amd64.deb
```

A package adds Kea's repository only when it is built with the repository's signing key
(`assets/release/kea-app.gpg`). Without the key, it is never updated automatically.
