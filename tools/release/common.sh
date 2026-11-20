#!/bin/bash
# Shared helpers for tools/release/ scripts. Sourced, not executed directly.

release_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

release_container_cmd() {
  local cmd="${CONTAINER_CMD:-docker}"
  "$cmd" info >/dev/null 2>&1 || { echo "container runtime ($cmd) is not running or unreachable" >&2; exit 1; }
  printf '%s\n' "$cmd"
}

release_host_docker_platform() {
  case "$(uname -m)" in
    arm64|aarch64) printf 'linux/arm64\n' ;;
    x86_64|amd64)  printf 'linux/amd64\n' ;;
    *) echo "unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

release_host_arch() {
  case "$(uname -m)" in
    arm64|aarch64) printf 'arm64\n' ;;
    x86_64|amd64)  printf 'x64\n' ;;
    *) echo "unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
  esac
}

release_repository() {
  if [ -n "${KEA_REPO:-}" ]; then
    printf '%s\n' "$KEA_REPO"
    return 0
  fi
  local repo_root="$1"
  node -e 'import { pathToFileURL } from "node:url"; const { RELEASE_REPOSITORY } = await import(pathToFileURL(process.argv[1]).href); if (!RELEASE_REPOSITORY) process.exit(1); console.log(RELEASE_REPOSITORY)' \
    "$repo_root/packages/protocol/src/release.ts"
}

release_node_version() {
  local repo_root="$1"
  local want_major ver
  want_major="$(tr -d '[:space:]' < "$repo_root/.node-version")"
  ver="${NODE_VERSION:-$(node -p 'process.versions.node')}"
  if [ "${ver%%.*}" != "$want_major" ]; then
    echo "Node version $ver does not match .node-version ($want_major); set NODE_VERSION explicitly" >&2
    exit 1
  fi
  printf '%s\n' "$ver"
}

release_pnpm_version() {
  if [ -n "${PNPM_VERSION:-}" ]; then
    printf '%s\n' "$PNPM_VERSION"
    return 0
  fi
  local repo_root="$1"
  node -e 'import fs from "node:fs"; console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).packageManager.replace(/^pnpm@/, ""))' \
    "$repo_root/package.json"
}

release_rust_version() {
  if [ -n "${RUST_VERSION:-}" ]; then
    printf '%s\n' "$RUST_VERSION"
    return 0
  fi
  local repo_root="$1"
  local ver
  ver="$(sed -n 's/^channel *= *"\([^"]*\)"/\1/p' "$repo_root/rust-toolchain.toml" | sed -n '1p')"
  [ -n "$ver" ] || { echo "could not read Rust channel from rust-toolchain.toml" >&2; exit 1; }
  printf '%s\n' "$ver"
}

release_primary_key() {
  if [ -n "${KEA_GPG_KEY:-}" ]; then
    printf '%s\n' "$KEA_GPG_KEY"
    return 0
  fi
  local keyring="$1"
  local fpr
  fpr="$(gpg --show-keys --with-colons "$keyring" | awk -F: '!found && $1 == "pub" { want = 1; next } !found && want && $1 == "fpr" { print $10; found = 1 }')"
  [ -n "$fpr" ] || { echo "could not read primary key fingerprint from $keyring" >&2; exit 1; }
  printf '%s\n' "$fpr"
}

release_signing_key() {
  if [ -n "${KEA_GPG_SIGNING_KEY:-}" ]; then
    printf '%s\n' "$KEA_GPG_SIGNING_KEY"
    return 0
  fi
  local keyring="$1"
  local sub
  sub="$(gpg --show-keys --with-colons "$keyring" | awk -F: '!found && $1 == "sub" && $2 !~ /^[red]$/ && index($12, "s") > 0 { want = 1; next } $1 == "sub" || $1 == "pub" { want = 0; next } !found && want && $1 == "fpr" { print $10 "!"; found = 1 }')"
  if [ -n "$sub" ]; then
    printf '%s\n' "$sub"
  else
    release_primary_key "$keyring"
  fi
}
