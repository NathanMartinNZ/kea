#!/bin/sh
# The end-to-end install test (E-DST-3): install.sh against a stand-in release, in a clean container of each system.
# Run on a Linux machine with podman (rootless is fine), from the checkout:
#   sh tools/pack/src/os/standin-release.sh key <work>
#   node tools/package.ts --target linux-<arch> --test-repository <owner/name> --test-key <work>/kea-app.gpg --out <dir>
#   sh tools/pack/src/os/install-e2e.sh <work> <dir> [--update-goldens] [image…]
# It assembles the stand-in release from <dir>'s packages, tarball and install.sh (signed with <work>'s throwaway key,
# with two tampered copies), serves it as github.com, release-assets.githubusercontent.com and <owner>.github.io on
# 127.0.0.1:443 over HTTPS with a test CA (the machine must let a user bind port 443:
# net.ipv4.ip_unprivileged_port_start=443), and runs install-container.sh in each image, on the host's network with
# those names pointed at the stand-in. Then it compares each dry run with its golden in fixtures/install/dry-run/
# (normalised: from the Release line on, the repository, version, key, architecture and home written as placeholders;
# --update-goldens writes them instead), and runs shellcheck on install.sh and on these scripts. Output in
# <work>/runs/<image>/. Prints one line per image and per check; exits non-zero if any failed.
set -eu

work=$(cd "${1:?the work folder}" && pwd)
dir=$(cd "${2:?the packages folder}" && pwd)
shift 2
update=0
if [ "${1:-}" = --update-goldens ]; then
  update=1
  shift
fi
[ $# -gt 0 ] || set -- ubuntu:24.04 ubuntu:26.04 debian:13 fedora:43 fedora:44 docker.io/library/photon:5.0 docker.io/opensuse/tumbleweed:latest
images=$* # image names are single words
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
goldens=$root/fixtures/install/dry-run
say() { printf '%s\n' "$*"; }
fail() {
  say "FAIL $*"
  exit 1
}

# ── the release under test ────────────────────────────────────────────────────────────────────────────────────────
[ -f "$dir/install.sh" ] || fail "no install.sh in $dir: build the packages with --test-repository and --test-key"
repo=$(sed -n "s/^  repository='\([^']*\)'.*/\1/p" "$dir/install.sh")
fpr=$(sed -n "s/^  key_fingerprint='\([^']*\)'.*/\1/p" "$dir/install.sh")
if [ -z "$repo" ] || [ -z "$fpr" ]; then fail "$dir/install.sh names no repository or key"; fi
set -- "$dir"/kea-app-*-linux-*.tar.gz
[ -f "$1" ] || fail "no tarball in $dir"
tarball=${1##*/}
version=${tarball#kea-app-}
version=${version%-linux-*}
owner=${repo%%/*}
pages_host=$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]').github.io
[ "$(GNUPGHOME=$work/gnupg gpg --show-keys --with-colons "$work/kea-app.gpg" | awk -F: '$1 == "fpr" { print $10; exit }')" = "$fpr" ] ||
  fail "$dir/install.sh pins $fpr, which is not $work's stand-in key: build the packages with --test-key $work/kea-app.gpg"
set --
for f in "$dir"/*.deb "$dir"/*.rpm "$dir"/*.tar.gz "$dir/install.sh"; do [ ! -f "$f" ] || set -- "$@" "$f"; done
sh "$here/standin-release.sh" assemble "$work" "$repo" "$version" "$@"
sh "$here/standin-release.sh" tamper "$work"
rm -rf "$work/e"
mkdir "$work/e"
cp "$work/tls/ca.pem" "$work/kea-app.gpg" "$here/install-container.sh" "$work/e/"
printf '%s\n' "$fpr" >"$work/e/fingerprint"

# ── the stand-in, until this script ends ──────────────────────────────────────────────────────────────────────────
ready=$work/standin.ready
rm -f "$ready" "$work/standin.log"
mkfifo "$ready"
node "$here/release-standin.ts" --release "$work/release" --pages "$work/pages" --repository "$repo" --version "$version" \
  --cert "$work/tls/server.pem" --key "$work/tls/server.key" --also "9.9.8-rc.1=$work/release-badhash" --also "9.9.9-rc.1=$work/release-badkey" \
  --log "$work/standin.log" >"$ready" 2>"$work/standin.err" &
standin=$!
trap 'kill "$standin" 2>/dev/null || true' EXIT
read -r line <"$ready" || line=
[ "$line" = ready ] || fail "the stand-in did not start: $(cat "$work/standin.err")"
set -- "$work/release"/*
say "ok   stand-in for $repo v$version on 127.0.0.1:443 ($# files; key $fpr)"

# ── each system ───────────────────────────────────────────────────────────────────────────────────────────────────
normalise() { sh "$here/dry-run-normal.sh" "$1" "$repo" "$fpr" "$version"; }
failed=0
mkdir -p "$work/runs" "$goldens"
# shellcheck disable=SC2086 # one word per image
for image in $images; do
  slug=$(printf '%s' "${image##*/}" | tr ':' '-')
  out=$work/runs/$slug
  rm -rf "$out"
  mkdir -p "$out"
  if podman run --rm --network host --add-host github.com:127.0.0.1 --add-host release-assets.githubusercontent.com:127.0.0.1 \
    --add-host "$pages_host:127.0.0.1" -v "$work/e:/e:ro" -v "$out:/out" "$image" sh /e/install-container.sh "$repo" "$version" /out >"$out.log" 2>&1; then
    say "PASS $image ($(grep -c '^ok' "$out.log") steps; $out.log)"
  else
    say "FAIL $image: $(grep '^FAIL' "$out.log" | head -1 || tail -1 "$out.log") ($out.log)"
    failed=1
  fi
  for run in "$out"/dry-run-*.txt; do
    [ -e "$run" ] || continue
    name=$(basename "$run")
    normalise "$run" >"$run.normal"
    if [ "$update" = 1 ] && [ ! -e "$goldens/$name.new" ]; then
      cp "$run.normal" "$goldens/$name"
      : >"$goldens/$name.new"
    elif ! cmp -s "$run.normal" "$goldens/$name"; then
      say "FAIL $image: $name differs from its golden:"
      diff "$goldens/$name" "$run.normal" | sed 's/^/     /' | head -20
      failed=1
    fi
  done
done
rm -f "$goldens"/*.new
[ "$update" = 0 ] || say "ok   goldens written in $goldens"

# ── shellcheck ────────────────────────────────────────────────────────────────────────────────────────────────────
command -v shellcheck >/dev/null 2>&1 || fail 'shellcheck is not installed'
if shellcheck -s sh "$dir/install.sh" "$here/install-container.sh" "$here/install-macos.sh" "$here/dry-run-normal.sh" "$here/standin-release.sh" "$here/install-e2e.sh"; then
  say "ok   shellcheck $(shellcheck --version | sed -n 's/^version: //p'): install.sh and the test scripts"
else
  failed=1
fi
if [ "$failed" = 0 ]; then say PASS; else say FAIL; fi
exit "$failed"
