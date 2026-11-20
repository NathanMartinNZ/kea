# tools/release

Containerised Linux release build, signing and post-publish verification scripts. See [docs/releasing.md](../../docs/releasing.md)
for the end-to-end release procedure.

## Scripts

- **`linux.sh <version>`**: Builds the Ubuntu 22.04 (glibc 2.35) toolchain images (`Dockerfile`) for `arm64` and `x64`,
  clones the pushed tag inside each container (`build.sh`), runs `pnpm package --release`, builds the flat apt index
  (`apt.sh`), and runs package smoke tests across Ubuntu, Debian and Fedora.
- **`sign.sh <version>`**: Signs the `.rpm` packages inside a Fedora container (`rpmsign.sh`) using a host signing
  bridge (`gpg-standin.sh` and `sign-loop.sh`) so the private GPG key never enters a container, signs the apt index
  (`InRelease` and `Release.gpg`), and assembles `<work>/release` ready for `pnpm release:sums`.
- **`check.sh <version> <previous-version>`**: Verifies that the published GitHub release serves all expected files and
  tests fresh installs, apt upgrades and `--no-repo` installs in clean containers (`live.sh`).
- **`common.sh`**: Shared helpers reading the repository slug from `packages/protocol/src/release.ts`, the toolchain
  versions from `.node-version`, `package.json` and `rust-toolchain.toml`, and the public key fingerprints from
  `assets/release/kea-app.gpg`.

## Environment overrides

| Variable | Default | Purpose |
|---|---|---|
| `WORK` | `/tmp/kea-release-<version>` | Working directory for logs, build outputs and staged release files |
| `CONTAINER_CMD` | `docker` | Container runtime (`docker` or `podman`) |
| `KEA_REPO` | `RELEASE_REPOSITORY` in `packages/protocol/src/release.ts` | Target GitHub `owner/repo` |
| `KEA_GPG_KEY` | Primary fingerprint in `assets/release/kea-app.gpg` | Primary GPG key fingerprint |
| `KEA_GPG_SIGNING_KEY` | Signing subkey in `assets/release/kea-app.gpg` | GPG key/subkey used for detached RPM signatures |
| `KEA_GPG_PINENTRY_MODE` | `loopback` | Pinentry mode passed to batch `gpg` commands |
| `NODE_VERSION` | Host Node version (checked against `.node-version`) | Node version installed in the Linux build container |
| `PNPM_VERSION` | `packageManager` in `package.json` | pnpm version installed in the Linux build container |
| `RUST_VERSION` | `channel` in `rust-toolchain.toml` | Rust toolchain installed in the Linux build container |
