#!/bin/bash
# On the host: sign each request left by gpg-standin.sh in the shared folder as a binary detached signature.
# Stops when the folder holds a file named `stop`.
#   bash sign-loop.sh <dir> <signing-key> [pinentry-mode]
set -euo pipefail
dir=${1:?usage: sign-loop.sh <dir> <signing-key> [pinentry-mode]}
key=${2:?usage: sign-loop.sh <dir> <signing-key> [pinentry-mode]}
pinentry_mode=${3:-${KEA_GPG_PINENTRY_MODE:-loopback}}
while true; do
  for req in "$dir"/*.req; do
    [ -e "$req" ] || continue
    id="${req%.req}"
    if gpg --batch --no-tty --yes --pinentry-mode "$pinentry_mode" --local-user "$key" --digest-algo SHA512 --detach-sign --output "$id.sig.tmp" "$id.data"; then
      mv "$id.sig.tmp" "$id.sig"; echo "signed $(basename "$id")"
    else
      : > "$id.fail"; echo "FAILED $(basename "$id")"
    fi
    rm -f "$req"
  done
  [ -e "$dir/stop" ] && exit 0
  sleep 0.3
done
