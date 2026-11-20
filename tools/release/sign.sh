#!/bin/bash
# On the host, once the release signing key is unlocked in gpg-agent: sign a release's Linux files with the repository
# key and assemble the release folder. RPMs are signed by rpmsign in fedora:44 (rpm 6) through a stand-in that hands
# signing requests back to the host's gpg (the private key never enters the container); the apt index gets InRelease
# and Release.gpg. Afterwards <work>/release holds the macOS files, Linux files and apt index, ready for release:sums.
#   bash tools/release/sign.sh <version>
set -euo pipefail
V=${1:?usage: sign.sh <version>}
HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
source "$HERE/common.sh"

REPO=$(release_repo_root)
CTR=$(release_container_cmd)
HOST_PLATFORM=$(release_host_docker_platform)
WORK=${WORK:-/tmp/kea-release-$V}
KEYRING="$REPO/assets/release/kea-app.gpg"
KEY=$(release_primary_key "$KEYRING")
PINENTRY_MODE="${KEA_GPG_PINENTRY_MODE:-loopback}"

MAC=("Kea-$V-arm64-mac.zip" "Kea-$V-arm64-mac.zip.blockmap" latest-mac.yml)
for f in "${MAC[@]}"; do
  [ -f "$WORK/mac/$f" ] || { echo "missing $WORK/mac/$f (pnpm package --release --out $WORK/mac)"; exit 1; }
done
echo test | gpg --batch --pinentry-mode "$PINENTRY_MODE" --local-user "$KEY" --clearsign >/dev/null 2>&1 ||
  { echo "the release key ($KEY) is locked: unlock it in gpg-agent first (see docs/releasing.md)"; exit 1; }

# rpms
mkdir -p "$WORK/logs"
rm -rf "$WORK/sign" && mkdir -p "$WORK/sign" "$WORK/keys"
gpg --version > "$WORK/sign/gpg-version.txt"
gpg --armor --export "$KEY" > "$WORK/keys/kea-app.asc"
if [ -n "${KEA_GPG_KEY:-}" ]; then
  gpg --export "$KEY" > "$WORK/keys/kea-app.gpg"
  VERIFY_KEYRING="$WORK/keys/kea-app.gpg"
else
  VERIFY_KEYRING="$KEYRING"
fi
SIGN_KEY=$(release_signing_key "$VERIFY_KEYRING")
bash "$HERE/sign-loop.sh" "$WORK/sign" "$SIGN_KEY" "$PINENTRY_MODE" > "$WORK/logs/sign-loop.log" 2>&1 &
loop=$!
trap 'touch "$WORK/sign/stop"' EXIT
"$CTR" run --rm --platform "$HOST_PLATFORM" -v "$HERE":/scripts:ro -v "$WORK/rpms":/rpms -v "$WORK/sign":/sign \
  -v "$WORK/keys":/keys:ro fedora:44 bash /scripts/rpmsign.sh "$KEY" > "$WORK/logs/rpmsign.log" 2>&1 ||
  { echo "rpm signing failed: $WORK/logs/rpmsign.log"; exit 1; }
touch "$WORK/sign/stop"; wait $loop || true
grep -E "OpenPGP|EdDSA" "$WORK/logs/rpmsign.log"
[ "$(grep -c 'signature, key fingerprint: .*: OK' "$WORK/logs/rpmsign.log")" = 2 ] || { echo "the rpms do not both verify"; exit 1; }

# the release folder
R="$WORK/release"
rm -rf "$R" && mkdir -p "$R"
for f in "${MAC[@]}"; do cp "$WORK/mac/$f" "$R/"; done
cp "$WORK/apt/kea-app_${V}_amd64.deb" "$WORK/apt/kea-app_${V}_arm64.deb" "$WORK/apt/Packages" "$WORK/apt/Packages.gz" "$WORK/apt/Release" "$R/"
cp "$WORK/rpms/kea-app-$V-1.aarch64.rpm" "$WORK/rpms/kea-app-$V-1.x86_64.rpm" "$R/"
cp "$WORK/out-arm64/kea-app-$V-linux-arm64.tar.gz" "$WORK/out-x64/kea-app-$V-linux-x64.tar.gz" "$R/"

# the apt index's signatures
gpg --batch --yes --pinentry-mode "$PINENTRY_MODE" --local-user "$KEY" --clearsign -o "$R/InRelease" "$R/Release"
gpg --batch --yes --pinentry-mode "$PINENTRY_MODE" --local-user "$KEY" --armor --detach-sign -o "$R/Release.gpg" "$R/Release"
gpgv --keyring "$VERIFY_KEYRING" "$R/InRelease" 2>&1 | tail -n 1
gpgv --keyring "$VERIFY_KEYRING" "$R/Release.gpg" "$R/Release" 2>&1 | tail -n 1

echo "$(ls -1 "$R" | wc -l | tr -d ' ') files in $R (release:sums adds install.sh, kea-app.asc, SHA256SUMS, SHA256SUMS.asc: 18)"
echo "next: pnpm release:sums $R"
