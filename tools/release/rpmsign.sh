#!/bin/bash
# Inside fedora:44 (rpm 6): sign every rpm in /rpms through the host gpg stand-in, then verify each with the public key.
#   bash rpmsign.sh <gpg-key-fingerprint>
set -euo pipefail
KEY=${1:?usage: rpmsign.sh <gpg-key-fingerprint>}
dnf -q -y install rpm-sign >/dev/null
rpm --version
for r in /rpms/*.rpm; do
  rpmsign --define "__gpg /scripts/gpg-standin.sh" --define "_gpg_name $KEY" --addsign "$r"
done
rpm --import /keys/kea-app.asc
rpm -K -v /rpms/*.rpm
rpm -qp --qf '%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}: %{OPENPGP:pgpsig}\n' /rpms/*.rpm
