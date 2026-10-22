#!/bin/sh
# The end-to-end install test's stand-in release (E-DST-3): what a release of Kea holds, made from test builds and
# signed with a key generated for the run, never the repository's key. Test tooling only.
#
#   sh standin-release.sh key <work>
#       a throwaway signing key in <work>/gnupg; its public half as <work>/kea-app.gpg (binary) and kea-app.asc,
#       which `pnpm package --test-repository <owner/name> --test-key <work>/kea-app.gpg` builds the packages with
#   sh standin-release.sh assemble <work> <owner/name> <version> <file…>
#       <work>/release: the files (packages, tarball, zip, install.sh…), kea-app.asc, the rpm signed, the flat apt
#       repository (Packages, Packages.gz, Release, InRelease, Release.gpg) when there is a .deb, SHA256SUMS over them
#       all and SHA256SUMS.asc; <work>/pages/<name>/rpm/<arch>: the rpm repository's metadata, its packages at the
#       release's versioned URL (xml:base), repomd.xml signed; <work>/tls: a test CA and the stand-in's certificate
#       for github.com, release-assets.githubusercontent.com and <owner>.github.io
#   sh standin-release.sh tamper <work>
#       two releases made wrong, for install.sh to refuse: <work>/release-badhash (every package one byte longer than
#       SHA256SUMS says) and <work>/release-badkey (all of it signed by another key, kea-app.asc that key)
# Needs gpg and openssl; rpmsign and createrepo_c for an rpm; apt-ftparchive for a .deb.
set -eu

say() { printf '%s\n' "$*"; }
fail() {
  say "FAIL $*" >&2
  exit 1
}
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

what=${1:?usage: standin-release.sh key|assemble <work> …}
work=${2:?the work folder}
export GNUPGHOME="$work/gnupg"
gpg_batch() { gpg --batch --quiet --pinentry-mode loopback --passphrase '' "$@"; }

if [ "$what" = key ]; then
  mkdir -p "$work"
  rm -rf "$GNUPGHOME"
  mkdir -m 700 "$GNUPGHOME"
  gpg_batch --quick-gen-key 'Kea stand-in release key, E-DST-3 only <kea-test@invalid>' rsa3072 sign never
  fpr=$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }')
  gpg --batch --export "$fpr" >"$work/kea-app.gpg"
  gpg --batch --armor --export "$fpr" >"$work/kea-app.asc"
  gpgconf --kill all # the agent gpg started for this key
  say "$fpr"
  exit 0
fi
if [ "$what" = tamper ]; then
  rel=$work/release
  [ -f "$rel/SHA256SUMS" ] || fail "no stand-in release in $rel: run the assemble step first"
  rm -rf "$work/release-badhash" "$work/release-badkey" "$work/gnupg-other"
  cp -R "$rel" "$work/release-badhash"
  for f in "$work/release-badhash"/*.deb "$work/release-badhash"/*.rpm "$work/release-badhash"/*.tar.gz "$work/release-badhash"/*.zip; do
    [ ! -e "$f" ] || printf 'x' >>"$f"
  done
  cp -R "$rel" "$work/release-badkey"
  GNUPGHOME="$work/gnupg-other"
  mkdir -m 700 "$GNUPGHOME"
  gpg_batch --quick-gen-key 'Not Kea, E-DST-3 only <kea-test-other@invalid>' rsa3072 sign never
  other=$(gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }')
  gpg --batch --armor --export "$other" >"$work/release-badkey/kea-app.asc"
  (
    cd "$work/release-badkey"
    rm -f SHA256SUMS SHA256SUMS.asc
    sha256 ./* | sed 's|  \./|  |' >SHA256SUMS
    gpg_batch --local-user "$other" --armor --detach-sign -o SHA256SUMS.asc SHA256SUMS
  )
  gpgconf --kill all
  say "tampered releases in $work/release-badhash (packages changed) and $work/release-badkey (signed by $other)"
  exit 0
fi
[ "$what" = assemble ] || fail "unknown step $what"
repository=${3:?owner/name}
version=${4:?the version}
shift 4
owner=${repository%%/*}
name=${repository#*/}
fpr=$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')
[ -n "$fpr" ] || fail "no stand-in key in $GNUPGHOME: run the key step first"

rel=$work/release
rm -rf "$rel" "$work/pages"
mkdir -p "$rel"
for f in "$@"; do cp "$f" "$rel/"; done
cp "$work/kea-app.asc" "$rel/"

# the rpm signed with the stand-in key (a release signs every rpm), then its repository on "Pages"
for rpm in "$rel"/*.rpm; do
  [ -e "$rpm" ] || continue
  rpmsign --define "__gpg $(command -v gpg)" --define "_gpg_name $fpr" --define "_gpg_path $GNUPGHOME" --define '_gpg_sign_cmd_extra_args --pinentry-mode loopback --passphrase ""' --addsign "$rpm" >/dev/null ||
    fail "rpmsign $rpm"
  arch=$(basename "$rpm" .rpm)
  arch=${arch##*.}
  pages=$work/pages/$name/rpm/$arch
  mkdir -p "$pages/in"
  cp "$rpm" "$pages/in/"
  createrepo_c --quiet --baseurl "https://github.com/$repository/releases/download/v$version/" --outputdir "$pages" "$pages/in" || fail createrepo_c
  rm -rf "$pages/in"
  gpg_batch --local-user "$fpr" --armor --detach-sign -o "$pages/repodata/repomd.xml.asc" "$pages/repodata/repomd.xml"
done

# the flat apt repository inside the release
if ls "$rel"/*.deb >/dev/null 2>&1; then
  (
    cd "$rel"
    apt-ftparchive packages . >Packages
    gzip -9nk Packages
    apt-ftparchive -o APT::FTPArchive::Release::Origin=Kea -o APT::FTPArchive::Release::Label=Kea -o APT::FTPArchive::Release::Suite=stable release . >Release
    gpg_batch --local-user "$fpr" --clearsign -o InRelease Release
    gpg_batch --local-user "$fpr" --armor --detach-sign -o Release.gpg Release
  )
fi

# every file of the release in SHA256SUMS, signed
(
  cd "$rel"
  set --
  for f in *; do case $f in SHA256SUMS*) ;; *) set -- "$@" "$f" ;; esac; done
  sha256 "$@" >SHA256SUMS
  gpg_batch --local-user "$fpr" --armor --detach-sign -o SHA256SUMS.asc SHA256SUMS
)

# the test CA and the stand-in's certificate, for a run only
tls=$work/tls
rm -rf "$tls"
mkdir -m 700 "$tls"
pages_host=$(printf '%s' "$owner" | tr '[:upper:]' '[:lower:]').github.io
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj '/CN=Kea E-DST-3 test CA' -addext 'basicConstraints=critical,CA:true' -addext 'keyUsage=critical,keyCertSign,cRLSign' -keyout "$tls/ca.key" -out "$tls/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj '/CN=github.com' -keyout "$tls/server.key" -out "$tls/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:github.com,DNS:release-assets.githubusercontent.com,DNS:%s\nbasicConstraints=CA:false\nextendedKeyUsage=serverAuth\n' "$pages_host" >"$tls/ext"
openssl x509 -req -in "$tls/server.csr" -CA "$tls/ca.pem" -CAkey "$tls/ca.key" -CAcreateserial -days 7 -extfile "$tls/ext" -out "$tls/server.pem" 2>/dev/null
chmod 644 "$tls/ca.pem"
gpgconf --kill all
set -- "$rel"/*
say "stand-in release of $repository v$version in $rel ($# files), signed by $fpr"
