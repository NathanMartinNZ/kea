#!/bin/bash
# Build a release's Linux files in clean Ubuntu 22.04 (glibc 2.35) containers from a fresh clone of the pushed tag,
# build the unsigned flat apt repository index, and run package smoke tests across Ubuntu, Debian and Fedora.
#   bash tools/release/linux.sh <version>        work folder: /tmp/kea-release-<version> (WORK= to change)
set -euo pipefail
V=${1:?usage: linux.sh <version>}; TAG="v$V"
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
source "$HERE/common.sh"

REPO=$(release_repo_root)
CTR=$(release_container_cmd)
HOST_PLATFORM=$(release_host_docker_platform)
HOST_ARCH=$(release_host_arch)
REPO_SLUG=$(release_repository "$REPO")
REPO_URL="https://github.com/${REPO_SLUG}.git"
NODE_VER=$(release_node_version "$REPO")
PNPM_VER=$(release_pnpm_version "$REPO")
RUST_VER=$(release_rust_version "$REPO")

WORK=${WORK:-/tmp/kea-release-$V}
COMMIT=$(git -C "$REPO" rev-parse "$TAG^{commit}")
REMOTE=$(git -C "$REPO" ls-remote "$REPO_URL" "refs/tags/$TAG^{}" | cut -f1)
[ "$REMOTE" = "$COMMIT" ] || { echo "$TAG is not on $REPO_URL at $COMMIT (push the tag first)"; exit 1; }
mkdir -p "$WORK/logs/smoke" "$WORK/out-arm64" "$WORK/out-x64" "$WORK/apt" "$WORK/rpms"
chmod 777 "$WORK/out-arm64" "$WORK/out-x64"

build() { # <docker arch> <node arch>
  "$CTR" build -q --platform "linux/$1" \
    --build-arg NARCH="$2" \
    --build-arg NODE_VERSION="$NODE_VER" \
    --build-arg PNPM_VERSION="$PNPM_VER" \
    --build-arg RUST_VERSION="$RUST_VER" \
    -t "kea-release-toolchain:$2" "$HERE" >/dev/null
  "$CTR" run --rm --platform "linux/$1" -v "$HERE":/scripts:ro -v "$WORK/out-$2":/out "kea-release-toolchain:$2" \
    bash /scripts/build.sh "$TAG" "$COMMIT" "$REPO_URL" > "$WORK/logs/build-$2.log" 2>&1
}

echo "building $TAG ($COMMIT) for arm64 and x64 (Node $NODE_VER, pnpm $PNPM_VER, Rust $RUST_VER): logs in $WORK/logs"
build arm64 arm64 & a=$!
build amd64 x64 & b=$!
ok=1
wait $a || { echo "arm64 build failed: $WORK/logs/build-arm64.log"; ok=0; }
wait $b || { echo "x64 build failed: $WORK/logs/build-x64.log"; ok=0; }
[ $ok = 1 ] || exit 1
grep -h "checks passed" "$WORK/logs/build-arm64.log" "$WORK/logs/build-x64.log"
cmp "$WORK/out-arm64/install.sh" "$WORK/out-x64/install.sh" || { echo "the two builds' install.sh differ"; exit 1; }

cp "$WORK/out-arm64/kea-app_${V}_arm64.deb" "$WORK/out-x64/kea-app_${V}_amd64.deb" "$WORK/apt/"
cp "$WORK/out-arm64/kea-app-$V-1.aarch64.rpm" "$WORK/out-x64/kea-app-$V-1.x86_64.rpm" "$WORK/rpms/"
"$CTR" run --rm --platform "$HOST_PLATFORM" -v "$HERE":/scripts:ro -v "$WORK/apt":/apt ubuntu:22.04 \
  bash /scripts/apt.sh > "$WORK/logs/apt.log" 2>&1
grep -E "^Version|^Filename" "$WORK/apt/Packages"

# the smoke test starts Kea, whose Chromium sandbox needs namespaces the default seccomp profile refuses
if [ "$HOST_ARCH" = "arm64" ]; then
  deb="kea-app_${V}_arm64.deb"; rpm="kea-app-$V-1.aarch64.rpm"; smoke_dir="$WORK/out-arm64"
else
  deb="kea-app_${V}_amd64.deb"; rpm="kea-app-$V-1.x86_64.rpm"; smoke_dir="$WORK/out-x64"
fi
smoke() { # <image> <package> <name>
  "$CTR" run --rm --platform "$HOST_PLATFORM" --security-opt seccomp=unconfined \
    -v "$REPO/tools/pack/src/os":/smoke:ro \
    -v "$smoke_dir":/pkgs:ro "$1" sh /smoke/smoke-linux.sh "/pkgs/$2" > "$WORK/logs/smoke/$3.log" 2>&1
}
echo "smoke tests on $HOST_PLATFORM (a few minutes)"
smoke_names=(ubuntu2204 ubuntu2404 ubuntu2604 debian13 fedora44)
smoke_pids=()
smoke ubuntu:22.04 "$deb" ubuntu2204 & smoke_pids+=($!)
smoke ubuntu:24.04 "$deb" ubuntu2404 & smoke_pids+=($!)
smoke ubuntu:26.04 "$deb" ubuntu2604 & smoke_pids+=($!)
smoke debian:13 "$deb" debian13 & smoke_pids+=($!)
smoke fedora:44 "$rpm" fedora44 & smoke_pids+=($!)

smoke_ok=1
for i in "${!smoke_names[@]}"; do
  name="${smoke_names[$i]}"
  log="$WORK/logs/smoke/$name.log"
  rc=0
  wait "${smoke_pids[$i]}" || rc=$?
  res="$(grep -E '^(FAIL|PASS)' "$log" | tail -n 1 || true)"
  [ -n "$res" ] || res="(exit $rc: $(tail -n 1 "$log" 2>/dev/null || echo 'no output'))"
  printf '%-12s %s\n' "$name" "$res"
  if [ "$rc" -ne 0 ]; then
    # Ubuntu 22.04's old fontconfig leaves a .uuid file inside /usr/share/fonts/kea-app after removal
    if [ "$name" = "ubuntu2204" ] && grep -qx 'FAIL /usr/share/fonts/kea-app is still there after removal' "$log" && ! grep -q '^FAIL' <(grep -vx 'FAIL /usr/share/fonts/kea-app is still there after removal' "$log"); then
      continue
    fi
    smoke_ok=0
  fi
done
[ "$smoke_ok" = 1 ] || { echo "one or more smoke tests failed: check $WORK/logs/smoke/"; exit 1; }
echo "next: build the macOS files into $WORK/mac, unlock the release key, then bash tools/release/sign.sh $V"
