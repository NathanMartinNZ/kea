#!/bin/bash
# Inside the toolchain container, as its non-root user: build a release's Linux files for this container's architecture
# from a fresh clone of the tag, into /out.
#   bash build.sh <tag> <commit> <repo-url>
set -euo pipefail
TAG=${1:?usage: build.sh <tag> <commit> <repo-url>}
COMMIT=${2:?usage: build.sh <tag> <commit> <repo-url>}
REPO_URL=${3:?usage: build.sh <tag> <commit> <repo-url>}
echo "== $(date -u +%T) $(uname -m) as $(id -un), home $HOME"
node --version; pnpm --version; cargo --version; lintian --version
rpmlint --version 2>/dev/null | sed -n '1p' || true
git clone -q --depth 1 --branch "$TAG" "$REPO_URL" "$HOME/src"
cd "$HOME/src"
test "$(git rev-parse HEAD)" = "$COMMIT" || { echo "the remote tag is not $COMMIT"; exit 1; }
echo "== $(date -u +%T) pnpm install"
pnpm install --frozen-lockfile
# pnpm package's licence step runs `cargo metadata --offline`
(cd native/kea-helper && cargo fetch --locked)
echo "== $(date -u +%T) pnpm package --release"
# stage inside the container: a host-mounted folder can drop chrome-sandbox's set-uid bit
pnpm package --release --out "$HOME/out"
find "$HOME/out" -maxdepth 1 -type f -exec cp {} /out/ \;
echo "== $(date -u +%T) done"
ls -l /out
