#!/bin/bash
# Inside ubuntu:22.04: generate the flat apt repository's index files for the .debs in /apt (signed on the host afterwards).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq --no-install-recommends apt-utils >/dev/null
cd /apt
rm -f Packages Packages.gz Release InRelease Release.gpg
apt-ftparchive packages . > Packages
gzip -9nfk Packages
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=Kea \
  -o APT::FTPArchive::Release::Label=Kea \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=kea \
  -o APT::FTPArchive::Release::Architectures="amd64 arm64" \
  release . > /tmp/Release
mv /tmp/Release Release
ls -l
