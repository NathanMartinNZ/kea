#!/bin/bash
# rpmsign's gpg stand-in inside the container: hands payload bytes to the host signer through /sign and returns the
# signature so the private key never enters the container.
set -euo pipefail
# rpm queries --version first: answer with the host gpg's version string
if [ "${1:-}" = "--version" ]; then cat /sign/gpg-version.txt; exit 0; fi
sig=""; data=""; prev=""
for a in "$@"; do
  case "$prev" in -sbo|-o|--output) sig="$a" ;; --) data="$a" ;; esac
  prev="$a"
done
echo "args: $*" >> /sign/args.log
[ -n "$sig" ] || { echo "gpg-standin: no output file in: $*" >&2; exit 2; }
id="$(date +%s%N)-$$"
if [ -n "$data" ] && [ "$data" != "-" ]; then cp "$data" "/sign/$id.data"; else cat > "/sign/$id.data"; fi
: > "/sign/$id.req"
for _ in $(seq 1 600); do
  [ -s "/sign/$id.sig" ] && break
  [ -e "/sign/$id.fail" ] && { echo "gpg-standin: the signer refused" >&2; exit 1; }
  sleep 0.5
done
[ -s "/sign/$id.sig" ] || { echo "gpg-standin: no signature after 5 minutes" >&2; exit 1; }
cp "/sign/$id.sig" "$sig"
