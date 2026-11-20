# Releasing Kea

This document describes how a maintainer builds, signs, publishes and verifies a Kea release. Every published release
carries both macOS and Linux artefacts (18 files in total): `install.sh`, the macOS updater feed and every Linux apt
source read `releases/latest/download/`, so a release is always uploaded as a draft first and made public only once all
18 files are present and verified.

## Prerequisites

- A clean checkout on `main` matching `origin/main`, with CI passing on that commit.
- Node.js (major version matching [`.node-version`](../.node-version)), pnpm (version in [`package.json`](../package.json)),
  and Rust (version in [`rust-toolchain.toml`](../rust-toolchain.toml)).
- GitHub CLI (`gh`), authenticated to the target repository.
- Docker (or Podman via `CONTAINER_CMD=podman`) with multi-architecture (`linux/arm64` and `linux/amd64`) support for
  building and testing the Linux packages.
- On macOS (Apple silicon): the project's "Kea Local Code Signing" certificate in the login keychain (see
  [docs/building.md](building.md#once-the-signing-certificate)).
- GnuPG (`gpg` and `gpgv`) with the secret key matching [`assets/release/kea-app.gpg`](../assets/release/kea-app.gpg)
  available in the local keyring.

## 1. Bump the version

Every workspace `package.json`, `native/kea-helper/Cargo.toml`, and the `kea-helper` entry of
`native/kea-helper/Cargo.lock` share one semver version (`<major>.<minor>.<patch>`):

1. Update `"version"` in every tracked `package.json` (`git ls-files '*package.json'`), in
   `native/kea-helper/Cargo.toml` (`[package]`), and in the `kea-helper` entry of `native/kea-helper/Cargo.lock`.
2. Confirm the lockfile is unaffected:
   ```sh
   pnpm install --frozen-lockfile --offline
   git diff --quiet pnpm-lock.yaml
   ```
3. Run the full verification gate with nothing skipped:
   ```sh
   pnpm verify
   ```

## 2. Commit, tag and push

Write concise, user-facing release notes (one bullet per change, ending with
`Install or update: https://github.com/<owner>/<repo>#install`) to `/tmp/kea-release-<version>/notes.md`, and prepare
an annotated tag message starting with `chore: release <version>`, a blank line, and the notes:

```sh
git commit -am "chore: release <version>"
git tag -a "v<version>" -F "/tmp/kea-release-<version>/tag.txt"
git push origin main
git push origin "v<version>"
```

Wait for CI to pass on both the release commit and the tag push before publishing.

## 3. Build the packages

Work in `/tmp/kea-release-<version>` (override with `WORK=<dir>`):

### macOS (on Apple silicon)

```sh
pnpm package --release --out "/tmp/kea-release-<version>/mac"
```

This produces `Kea-<version>-arm64-mac.zip`, `Kea-<version>-arm64-mac.zip.blockmap`, and `latest-mac.yml`.

### Linux (arm64 and x64 via Docker)

```sh
bash tools/release/linux.sh <version>
```

This clones the pushed tag inside clean Ubuntu 22.04 (glibc 2.35) containers for both `arm64` and `x64`, runs
`pnpm package --release` (including `lintian`, `rpmlint`, ELF and path checks), generates the unsigned flat apt index,
and runs package smoke tests across Ubuntu 22.04, 24.04, 26.04, Debian 13 and Fedora 44.

Ubuntu 22.04's smoke test may report `/usr/share/fonts/kea-app` left behind after removal (an old fontconfig `.uuid`
file); that is expected and not a blocker.

## 4. Sign and generate checksums

Unlock the release signing key in `gpg-agent` first (the signing scripts run `gpg` in batch mode so they fail fast if
the key is locked, and the private key never enters any container):

```sh
KEY="$(gpg --show-keys --with-colons assets/release/kea-app.gpg | awk -F: '!found && $1 == "pub" { want = 1; next } !found && want && $1 == "fpr" { print $10; found = 1 }')"
echo unlock | gpg --pinentry-mode loopback --local-user "$KEY" --clearsign >/dev/null
```

Then sign the RPMs (via the host signing bridge) and the apt index, assemble the release folder, and generate
`install.sh`, `kea-app.asc`, `SHA256SUMS` and `SHA256SUMS.asc`:

```sh
bash tools/release/sign.sh <version>
pnpm release:sums "/tmp/kea-release-<version>/release"
```

Verify that `/tmp/kea-release-<version>/release` holds exactly 18 files:

- `InRelease`, `Packages`, `Packages.gz`, `Release`, `Release.gpg`
- `Kea-<version>-arm64-mac.zip`, `Kea-<version>-arm64-mac.zip.blockmap`, `latest-mac.yml`
- `kea-app_<version>_amd64.deb`, `kea-app_<version>_arm64.deb`
- `kea-app-<version>-1.aarch64.rpm`, `kea-app-<version>-1.x86_64.rpm`
- `kea-app-<version>-linux-arm64.tar.gz`, `kea-app-<version>-linux-x64.tar.gz`
- `install.sh`, `kea-app.asc`, `SHA256SUMS`, `SHA256SUMS.asc`

## 5. Upload as a draft, verify, and publish

```sh
gh release create "v<version>" --verify-tag --draft \
  --title "Kea <version>" \
  --notes-file "/tmp/kea-release-<version>/notes.md" \
  "/tmp/kea-release-<version>/release"/*
```

Confirm all 18 assets and their sizes match, confirm CI is green on the tagged commit, then publish:

```sh
gh release edit "v<version>" --draft=false --latest
```

## 6. Post-publish verification

Test the live release endpoints, fresh installs on Ubuntu (arm64 and x64), an apt upgrade from the previous version,
and Fedora `--no-repo` installation in clean containers:

```sh
bash tools/release/check.sh <version> <previous-version>
```

Also verify the macOS update feed serves the new version:

```sh
curl -fsSL "https://github.com/<owner>/<repo>/releases/latest/download/latest-mac.yml"
```

Once verified, remove `/tmp/kea-release-<version>` and prune temporary release container images if desired.

## Customising for forks

The scripts in [`tools/release/`](../tools/release/README.md) read the repository slug from
[`packages/protocol/src/release.ts`](../packages/protocol/src/release.ts) and the signing key fingerprints from
[`assets/release/kea-app.gpg`](../assets/release/kea-app.gpg). Environment variables (`KEA_REPO`, `KEA_GPG_KEY`,
`KEA_GPG_SIGNING_KEY`, `KEA_GPG_PINENTRY_MODE`, `CONTAINER_CMD`, `WORK`, `NODE_VERSION`, `PNPM_VERSION`,
`RUST_VERSION`) override them without editing any script.
