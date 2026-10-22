#!/bin/sh
# The end-to-end install test's goldens (E-DST-3): the part of an install.sh dry run that is the same on every system
# of a family, from its Release line on, with the repository (and its Pages host), key, version, verifier, architecture
# and the test user's home written as placeholders. The goldens are fixtures/install/dry-run/<name>.txt; the by-hand
# commands in docs/install-linux.md are checked against them (U-PACK-45).
#   sh dry-run-normal.sh <dry run's output> <owner/name> <key fingerprint> <version>
set -eu
owner=$(printf '%s' "${2%%/*}" | tr '[:upper:]' '[:lower:]')
sed -n '/^Release: /,$p' "$1" | sed -E -e "s|$owner\.github\.io/${2#*/}/|<owner>.github.io/<name>/|g" -e "s|$2|<repository>|g" -e "s|$3|<fingerprint>|g" -e "s|$4|<version>|g" \
  -e 's/checked with (gpgv|sqv)\)/checked with <verifier>)/' -e 's|/home/kuser|~|g' \
  -e 's#([._-])(x86_64|aarch64|amd64|arm64|x64)([._/-])#\1<arch>\3#g'
