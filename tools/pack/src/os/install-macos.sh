#!/bin/sh
# The end-to-end install test's macOS part (E-DST-3): install.sh in a clean macOS VM, as its administrator runs it,
# against a stand-in release that the host serves on the VM's 127.0.0.1:8443 (an SSH tunnel: sshd forwards no port
# below 1024 for a user) with a test CA. Never on a Mac of your own: it installs into /Applications, edits /etc/hosts
# and loads a pf rule that sends 127.0.0.1:443 to the tunnel.
#   sh install-macos.sh <owner/name> <version> <folder with ca.pem and fingerprint> <out folder>
# It points github.com and release-assets.githubusercontent.com at 127.0.0.1 and trusts the test CA for curl only
# (CURL_CA_BUNDLE), then runs the README's command through every macOS path and checks what each leaves:
# --version 9.9.8-rc.1 (a zip that does not match SHA256SUMS) and 9.9.9-rc.1 (a release signed by another key)
# refused; the dry run (out/dry-run-mac.txt, for the golden); --user and --no-repo refused; the install (no quarantine
# attribute, the signature and Kea's certificate, the version); again ("already installed"); an older Kea replaced only
# when none runs; --uninstall (refused while Kea runs; ~/.kea kept). Prints one line per step; exits non-zero at the
# first that fails.
set -eu

repo=$1
version=$2
e=$3
out=$4
app=/Applications/Kea.app
url="https://github.com/$repo/releases/latest/download/install.sh"
say() { printf '%s\n' "$*"; }
fail() {
  say "FAIL $*"
  exit 1
}
ok() { say "ok   $*"; }

# ── the Mac, as its administrator's is ────────────────────────────────────────────────────────────────────────────
[ ! -e "$app" ] || fail "$app is there already: this runs on a clean VM only"
grep -q ' github\.com$' /etc/hosts || printf '%s\n' '127.0.0.1 github.com' '127.0.0.1 release-assets.githubusercontent.com' | sudo tee -a /etc/hosts >/dev/null
echo 'rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 443 -> 127.0.0.1 port 8443' | sudo pfctl -q -ef - 2>/dev/null || true
sudo pfctl -s nat 2>/dev/null | grep -q 'port = 443' || fail 'pf does not send 127.0.0.1:443 to the tunnel'
cat /etc/ssl/cert.pem "$e/ca.pem" >"$e/ca-bundle.pem"
mkdir -p ~/.kea "$out"
echo kept >~/.kea/marker
ok "ready: macOS $(sw_vers -productVersion), github.com on the tunnel, the test CA trusted by curl, ~/.kea holds a file"

readme() { # readme <name> [options…]: the README's command, its output in $out/<name>.txt
  rd_name=$1
  shift
  env CURL_CA_BUNDLE="$e/ca-bundle.pem" sh -c "curl -fsSL $url | sh -s -- $*" >"$out/$rd_name.txt" 2>&1
}
must() {
  readme "$@" || { tail -20 "$out/$1.txt"; fail "install.sh $(shift; echo "$*") exited non-zero"; }
}
refused() { # refused <name> <what it must say> [options…]
  rf_name=$1
  rf_why=$2
  shift 2
  readme "$rf_name" "$@" && fail "install.sh $* did not refuse"
  grep -q "$rf_why" "$out/$rf_name.txt" || { tail -5 "$out/$rf_name.txt"; fail "install.sh $* refused without saying: $rf_why"; }
}
kept() { [ "$(cat ~/.kea/marker 2>/dev/null)" = kept ] || fail "$HOME/.kea was touched"; }
app_version() { plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist"; }
running() { # a process that pgrep sees as /Applications/Kea.app's Kea (install.sh looks for no more)
  bash -c "exec -a $app/Contents/MacOS/Kea sleep 600" &
  fake=$!
}

refused refused-bad-hash 'does not match SHA256SUMS' --version 9.9.8-rc.1
refused refused-bad-key "kea-app.asc is not Kea's key" --version 9.9.9-rc.1
[ ! -e "$app" ] || fail 'a refused run left Kea.app'
ok 'refused: a zip that does not match SHA256SUMS, and a release signed by another key; nothing installed'
must dry-run-mac --dry-run
[ ! -e "$app" ] || fail 'the dry run installed Kea.app'
refused refused-user 'are for Linux' --user
refused refused-no-repo 'are for Linux' --no-repo
ok "the dry run changed nothing; --user and --no-repo refused; SHA256SUMS: $(sed -n 's/^SHA256SUMS: //p' "$out/dry-run-mac.txt")"
sed -n 's/^\(warning: .*git.*\)$/     \1/p; s/^\(git [0-9].*\)$/     \1/p' "$out/dry-run-mac.txt"

must install-mac
[ "$(app_version)" = "$version" ] || fail "$app is not Kea $version"
if xattr -r "$app" | grep -q com.apple.quarantine; then fail "$app carries a quarantine attribute"; fi
codesign --verify --deep --strict "$app" || fail "$app's signature does not verify"
leaf=$(sed -n 's/.*certificate leaf (leaf \([0-9a-f]*\)).*/\1/p; s/.*against Kea.s certificate (leaf \([0-9a-f]*\)).*/\1/p' "$out/dry-run-mac.txt" | sed -n 1p)
[ "$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')" = "identifier \"dev.kea.app\" and certificate leaf = H\"$leaf\"" ] || fail "$app's designated requirement is not Kea's certificate's"
grep -q "^Kea $version is installed in $app" "$out/install-mac.txt" || fail 'no line saying Kea is installed'
if [ -w /Applications ] && grep -q 'sudo' "$out/install-mac.txt"; then fail 'it speaks of sudo, though it changes /Applications as you'; fi
kept
ok "installed: Kea $version in $app, no quarantine attribute, the signature and Kea's certificate (leaf $leaf) check"
must install-mac-again
grep -q "^Kea $version is already installed" "$out/install-mac-again.txt" || fail 'installing the same version again did not say it is installed'
ok 'again: already installed, nothing replaced'

# an older Kea: replaced only when it is not running
plutil -replace CFBundleShortVersionString -string 0.0.9 "$app/Contents/Info.plist"
running
refused refused-running 'is running from /Applications/Kea.app, so nothing was replaced'
[ "$(app_version)" = 0.0.9 ] || fail 'a running Kea was replaced'
kill "$fake"
wait "$fake" 2>/dev/null || true
must install-mac-update
[ "$(app_version)" = "$version" ] || fail 'the older Kea was not replaced'
codesign --verify --deep --strict "$app" || fail "the replaced $app's signature does not verify"
if xattr -r "$app" | grep -q com.apple.quarantine; then fail "the replaced $app carries a quarantine attribute"; fi
kept
ok "an older Kea: refused while it runs, replaced by $version when it does not"

running
refused refused-uninstall-running 'Kea is running' --uninstall
[ -d "$app" ] || fail '--uninstall removed a running Kea'
kill "$fake"
wait "$fake" 2>/dev/null || true
must uninstall-mac --uninstall
[ ! -e "$app" ] || fail "--uninstall left $app"
grep -q "Kea's data stays in ~/.kea" "$out/uninstall-mac.txt" || fail '--uninstall did not say ~/.kea stays'
kept
must uninstall-mac-again --uninstall
grep -q 'nothing to remove' "$out/uninstall-mac-again.txt" || fail '--uninstall with nothing installed'
ok '--uninstall: refused while Kea runs; then Kea.app removed, ~/.kea kept, and nothing to remove after'
say PASS
