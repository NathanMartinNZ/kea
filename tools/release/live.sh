#!/bin/sh
# Inside a clean Linux container: install Kea from a published GitHub release as a user does:
#   fresh   — run the README's install.sh command
#   norepo  — run install.sh with --no-repo
#   upgrade — install the previous version's .deb, then upgrade through apt
#   sh live.sh <mode> <previous-version> <owner/repo> <expected-version>
set -eu
mode="$1"
prev="${2:-}"
repo="$3"
want="${4:-}"
URL="https://github.com/${repo}/releases/latest/download/install.sh"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq --no-install-recommends curl ca-certificates >/dev/null
fi
case "$mode" in
  fresh) curl -fsSL "$URL" | sh ;;
  norepo) curl -fsSL "$URL" | sh -s -- --no-repo ;;
  upgrade)
    cd /tmp && curl -fsSLO "https://github.com/${repo}/releases/download/v${prev}/kea-app_${prev}_$(dpkg --print-architecture).deb"
    apt-get install -y -qq ./kea-app_"${prev}"_*.deb >/dev/null
    echo "== before: kea-app $(dpkg-query -W -f='${Version}' kea-app)"
    apt-get update -q 2>&1 | grep -iE "kea|^(E|W):" || true
    apt-get install -y -qq --only-upgrade kea-app >/dev/null ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac
if command -v dpkg-query >/dev/null; then
  got="$(dpkg-query -W -f='${Version}' kea-app)"
  echo "== installed: kea-app ${got} $(dpkg-query -W -f='${Architecture}' kea-app)"
  if [ -n "$want" ] && [ "$got" != "$want" ]; then
    echo "== version mismatch: expected $want, got $got"
    exit 1
  fi
  apt-get update > /tmp/update.log 2>&1
  if grep -E "^(E|W):" /tmp/update.log; then echo "== apt-get update: NOT clean"; exit 1; fi
  echo "== apt-get update: clean"; grep -i kea /tmp/update.log | head -3
else
  got="$(rpm -q --qf '%{VERSION}' kea-app)"
  echo "== installed: $(rpm -q kea-app)"
  if [ -n "$want" ] && [ "$got" != "$want" ]; then
    echo "== version mismatch: expected $want, got $got"
    exit 1
  fi
  rpm -q --qf '== signature: %{OPENPGP:pgpsig}\n' kea-app
fi
