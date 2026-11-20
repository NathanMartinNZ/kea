#!/bin/bash
# After a release is published: verify the live release endpoints and install Kea from GitHub in clean containers
# (Ubuntu 24.04 arm64 and x64, Ubuntu 22.04 on host arch, an apt upgrade from the previous release, and Fedora 44 --no-repo).
#   bash tools/release/check.sh <version> <previous-version>
set -euo pipefail
V=${1:?usage: check.sh <version> <previous-version>}
PREV=${2:?usage: check.sh <version> <previous-version>}
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
source "$HERE/common.sh"

REPO=$(release_repo_root)
CTR=$(release_container_cmd)
HOST_PLATFORM=$(release_host_docker_platform)
HOST_ARCH=$(release_host_arch)
REPO_SLUG=$(release_repository "$REPO")
WORK=${WORK:-/tmp/kea-release-$V}
mkdir -p "$WORK/logs/live"

for f in InRelease Release Packages "kea-app_${V}_amd64.deb" install.sh SHA256SUMS; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -L "https://github.com/${REPO_SLUG}/releases/latest/download/$f")
  printf '%-28s %s\n' "$f" "$code"
  [ "$code" = 200 ] || { echo "the latest release does not serve $f"; exit 1; }
done

run() { # <docker platform> <image> <mode> <name>
  "$CTR" run --rm --platform "$1" -v "$HERE":/scripts:ro "$2" \
    sh /scripts/live.sh "$3" "$PREV" "$REPO_SLUG" "$V" > "$WORK/logs/live/$4.log" 2>&1
}

check_names=(ubuntu2404-arm64 "ubuntu2204-$HOST_ARCH" ubuntu2404-x64 "upgrade-from-$PREV" fedora44-norepo)
check_pids=()
run linux/arm64 ubuntu:24.04 fresh ubuntu2404-arm64 & check_pids+=($!)
run "$HOST_PLATFORM" ubuntu:22.04 fresh "ubuntu2204-$HOST_ARCH" & check_pids+=($!)
run linux/amd64 ubuntu:24.04 fresh ubuntu2404-x64 & check_pids+=($!)
run "$HOST_PLATFORM" ubuntu:24.04 upgrade "upgrade-from-$PREV" & check_pids+=($!)
run "$HOST_PLATFORM" fedora:44 norepo fedora44-norepo & check_pids+=($!)

ok=1
for i in "${!check_names[@]}"; do
  name="${check_names[$i]}"
  log="$WORK/logs/live/$name.log"
  rc=0
  wait "${check_pids[$i]}" || rc=$?
  echo "== $name (exit $rc)"
  grep -E "^== " "$log" || true
  if [ "$rc" -ne 0 ]; then
    ok=0
    tail -n 10 "$log" || true
  fi
done
[ "$ok" = 1 ] || { echo "one or more live release checks failed: see $WORK/logs/live/"; exit 1; }
