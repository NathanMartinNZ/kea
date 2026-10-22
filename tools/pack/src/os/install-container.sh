#!/bin/sh
# The end-to-end install test (E-DST-3): install.sh in one clean container, run as a person runs it. Run as the
# container's root, with the stand-in release reachable as github.com (install-e2e.sh starts it with podman):
#   sh install-container.sh <owner/name> <version> <out folder>
# /e/ca.pem is the stand-in's test CA, /e/kea-app.gpg its key and /e/fingerprint that key's fingerprint. It readies the
# system as a person's is (the CA trusted; curl, sudo and awk; a user who may use sudo), then, as that user, runs the
# README's command through every path this system has and checks what each leaves:
#   every system: --version 9.9.8-rc.1 (packages that do not match SHA256SUMS) and 9.9.9-rc.1 (a release signed by
#     another key) refused with nothing changed
#   apt and dnf: the dry runs (their output goes to the out folder, for install-e2e.sh's goldens); install; install
#     again; uninstall; --no-repo; uninstall; --version
#   zypper: the dry runs (openSUSE is best effort, not a tested system: the install itself is reported, not required)
#   anything else: the tarball's dry run, install, install again, uninstall; --user's dry run, refusal or install
# ~/.kea holds a file from the start, which every step must leave. Prints one line per step; exits non-zero at the
# first that fails.
set -eu

repo=$1
version=$2
out=$3
user=kuser
home=/home/$user
url="https://github.com/$repo/releases/latest/download/install.sh"
say() { printf '%s\n' "$*"; }
fail() {
  say "FAIL $*"
  exit 1
}
ok() { say "ok   $*"; }
gone() { for g in "$@"; do [ ! -e "$g" ] || fail "$g is still there"; done; }

# ── the system, as a person's is ──────────────────────────────────────────────────────────────────────────────────
# shellcheck source=/dev/null # the system's own
os_id=$(. /etc/os-release && printf '%s' "$ID")
case $os_id in
  ubuntu | debian) family=apt ;;
  fedora) family=dnf ;;
  opensuse*) family=zypper ;;
  photon) family=tarball ;;
  *) fail "no E-DST-3 case for $os_id" ;;
esac
if [ "$family" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null
  apt-get install -y -qq ca-certificates curl sudo tzdata >/tmp/prep.log 2>&1 || { tail -20 /tmp/prep.log; fail 'apt-get install curl sudo'; }
  cp /e/ca.pem /usr/local/share/ca-certificates/kea-e-dst-3.crt
  update-ca-certificates >/dev/null 2>&1
elif [ "$family" = dnf ]; then
  dnf install -y -q curl sudo util-linux shadow-utils >/tmp/prep.log 2>&1 || { tail -20 /tmp/prep.log; fail 'dnf install curl sudo'; }
  cp /e/ca.pem /etc/pki/ca-trust/source/anchors/kea-e-dst-3.pem
  update-ca-trust
elif [ "$family" = zypper ]; then
  # the container image has no awk, which every openSUSE desktop has
  zypper -n -q install curl sudo ca-certificates util-linux shadow gzip gawk >/tmp/prep.log 2>&1 || { tail -20 /tmp/prep.log; fail 'zypper install curl sudo'; }
  cp /e/ca.pem /etc/pki/trust/anchors/kea-e-dst-3.pem
  update-ca-certificates >/dev/null 2>&1
else
  # Photon OS: glibc, and no apt, dnf or zypper, so install.sh takes the tarball. Its image has no awk and toybox's
  # tools for coreutils' (no tr); fontconfig for fc-cache and fc-match, as on a desktop
  tdnf install -y -q curl sudo shadow tar gzip gawk coreutils util-linux findutils diffutils fontconfig ca-certificates >/tmp/prep.log 2>&1 || { tail -20 /tmp/prep.log; fail 'tdnf install curl sudo'; }
  cat /e/ca.pem >>/etc/pki/tls/certs/ca-bundle.crt
fi
useradd -m -s /bin/sh "$user"
# sudo without a password, as a desktop's administrator may have it; without PAM's account check, whose helper cannot
# read Fedora's /etc/shadow (mode 000) in a rootless container
printf '%s\n' "$user ALL=(ALL) NOPASSWD:ALL" "Defaults:$user !pam_acct_mgmt" 'Defaults env_keep += "DEBIAN_FRONTEND"' >/etc/sudoers.d/kea-e-dst-3
chmod 0440 /etc/sudoers.d/kea-e-dst-3
sudo -u "$user" sh -c 'mkdir -p ~/.kea && echo kept > ~/.kea/marker'
# shellcheck source=/dev/null # the system's own
ok "ready: $(. /etc/os-release && printf '%s' "$PRETTY_NAME") ($family), the stand-in's CA trusted, $user with sudo"

# the README's command, as the user, with these options; its output in $out/<name>.txt
readme() { # readme <name> [options…]
  rd_name=$1
  shift
  # shellcheck disable=SC2024 # the output file is root's, written by this shell, not the user's
  sudo -u "$user" env -i HOME="$home" USER="$user" LOGNAME="$user" PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 DEBIAN_FRONTEND=noninteractive \
    sh -c "curl -fsSL $url | sh -s -- $*" >"$out/$rd_name.txt" 2>&1
}
must() { # must <name> [options…]: the command succeeds
  readme "$@" || { tail -30 "$out/$1.txt"; fail "install.sh $(shift; echo "$*") exited non-zero"; }
}
kept() { [ "$(cat "$home/.kea/marker" 2>/dev/null)" = kept ] || fail "$home/.kea was touched"; }
refused() { # refused <name> <what it must say> [options…]: the command fails, saying so
  rf_name=$1
  rf_why=$2
  shift 2
  readme "$rf_name" "$@" && fail "install.sh $* did not refuse"
  grep -q "$rf_why" "$out/$rf_name.txt" || { tail -5 "$out/$rf_name.txt"; fail "install.sh $* refused without saying: $rf_why"; }
}
snapshot() { find / -xdev \( -path /proc -o -path /sys -o -path /dev -o -path /tmp -o -path /run -o -path /var -o -path "$home" -o -path /root -o -path /e -o -path "$out" \) -prune -o -print | sort; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

# ── every system: a release that is not what SHA256SUMS and Kea's key say is refused, with nothing changed ─────────
refused refused-bad-hash 'does not match SHA256SUMS' --version 9.9.8-rc.1
refused refused-bad-key "kea-app.asc is not Kea's key" --version 9.9.9-rc.1
gone /opt/Kea /etc/apt/sources.list.d/kea-app.sources /usr/share/keyrings/kea-app.gpg /etc/yum.repos.d/kea-app.repo /etc/zypp/repos.d/kea-app.repo "$home/.local/opt/Kea"
if command -v rpm >/dev/null 2>&1; then rpm -q gpg-pubkey --qf '%{VERSION}\n' 2>/dev/null | grep -qix "$(cut -c33-40 /e/fingerprint)" && fail "a refused run put Kea's key in rpm's keyring"; fi
kept
ok "refused: packages that do not match SHA256SUMS, and a release signed by another key; nothing changed"
how=$(sed -n 's/^SHA256SUMS: //p' "$out/refused-bad-hash.txt")
if command -v gpgv >/dev/null 2>&1 || command -v sqv >/dev/null 2>&1; then
  case $how in "signed by Kea's key $(cat /e/fingerprint) (checked with "*) ;; *) fail "SHA256SUMS's signature was not checked here: $how" ;; esac
fi
ok "SHA256SUMS: $how"

# ── apt ───────────────────────────────────────────────────────────────────────────────────────────────────────────
if [ "$family" = apt ]; then
  must dry-run-apt --dry-run
  must dry-run-apt-no-repo --dry-run --no-repo
  gone /opt/Kea /etc/apt/sources.list.d/kea-app.sources
  ok 'dry runs changed nothing'

  must install-apt
  [ "$(dpkg-query -W -f '${Status}' kea-app)" = 'install ok installed' ] || fail 'kea-app is not installed'
  grep -qx "URIs: https://github.com/$repo/releases/latest/download/" /etc/apt/sources.list.d/kea-app.sources || fail 'the source'
  [ "$(sha /usr/share/keyrings/kea-app.gpg)" = "$(sha /e/kea-app.gpg)" ] || fail "the key in /usr/share/keyrings is not the release's"
  for f in /opt/Kea/kea-app /usr/bin/kea-app; do [ -x "$f" ] || fail "no $f"; done
  apt-cache policy kea-app | grep -q "github.com/$repo/releases/latest/download" || fail "apt does not see kea-app in Kea's repository"
  grep -q "^Kea $version is installed" "$out/install-apt.txt" || fail 'no line saying Kea is installed'
  if command -v git >/dev/null 2>&1; then ok "installed from the repository, git $(git --version | cut -d' ' -f3) with it"; else say 'note git did not come with it'; fi
  must install-apt-again
  apt-get update >/tmp/update.log 2>&1 || { cat /tmp/update.log; fail 'apt-get update with Kea installed'; }
  grep -E '^(W|E):' /tmp/update.log | grep -i kea && fail 'apt-get update warns about Kea'
  ok 'installed again; apt-get update clean'
  kept

  must uninstall-apt --uninstall
  [ "$(dpkg-query -W -f '${db:Status-Status}' kea-app 2>/dev/null || true)" != installed ] || fail 'kea-app is still installed'
  gone /opt/Kea /usr/bin/kea-app /etc/apt/sources.list.d/kea-app.sources /usr/share/keyrings/kea-app.gpg /etc/default/kea-app /usr/share/fonts/kea-app /usr/share/applications/dev.kea.app.desktop /etc/apparmor.d/kea-app
  apt-get update >/tmp/update.log 2>&1 || { cat /tmp/update.log; fail 'apt-get update after the uninstall'; }
  kept
  ok 'uninstalled: the package, its source and key gone, apt-get update clean, ~/.kea kept'

  must install-apt-no-repo --no-repo
  [ "$(dpkg-query -W -f '${Status}' kea-app)" = 'install ok installed' ] || fail 'kea-app is not installed (--no-repo)'
  gone /etc/apt/sources.list.d/kea-app.sources /usr/share/keyrings/kea-app.gpg
  grep -qx 'add_repository=no' /etc/default/kea-app || fail '/etc/default/kea-app'
  must uninstall-apt-no-repo --uninstall
  gone /opt/Kea /etc/default/kea-app /etc/apt/sources.list.d/kea-app.sources
  kept
  ok '--no-repo: the package and no repository; uninstalled'

  must install-apt-version --version "$version"
  [ "$(dpkg-query -W -f '${Status}' kea-app)" = 'install ok installed' ] || fail 'kea-app is not installed (--version)'
  [ -e /etc/apt/sources.list.d/kea-app.sources ] || fail 'no source after --version'
  must uninstall-apt-version --uninstall
  ok "--version $version: that release's package, with the repository; uninstalled"
fi

# ── dnf ───────────────────────────────────────────────────────────────────────────────────────────────────────────
if [ "$family" = dnf ]; then
  must dry-run-dnf --dry-run
  must dry-run-dnf-no-repo --dry-run --no-repo
  gone /opt/Kea /etc/yum.repos.d/kea-app.repo
  ok 'dry runs changed nothing'

  must install-dnf
  rpm -q kea-app >/dev/null || fail 'kea-app is not installed'
  rpm -V kea-app >/tmp/verify.log 2>&1 || { cat /tmp/verify.log; fail "rpm -V kea-app: the files differ from the package's (install.sh's repository file is not the package's?)"; }
  grep -q "^baseurl=https://$(printf '%s' "${repo%%/*}" | tr '[:upper:]' '[:lower:]').github.io/${repo#*/}/rpm/\$basearch$" /etc/yum.repos.d/kea-app.repo || fail 'the repository file'
  dnf -q repoquery --repo kea-app kea-app 2>/tmp/rq.log | grep -q kea-app || { cat /tmp/rq.log; fail "dnf does not see kea-app in Kea's repository"; }
  rpm -q --qf '%{SIGPGP:pgpsig}%{RSAHEADER:pgpsig}\n' kea-app | grep -qi 'key id' || say "note rpm shows no signature for kea-app ($(rpm -q --qf '%{SIGPGP:pgpsig}' kea-app))"
  if command -v git >/dev/null 2>&1; then ok "installed from the repository; rpm -V clean; git $(git --version | cut -d' ' -f3) with it"; else ok 'installed from the repository; rpm -V clean (git did not come)'; fi
  must install-dnf-again
  kept

  must uninstall-dnf --uninstall
  rpm -q kea-app >/dev/null 2>&1 && fail 'kea-app is still installed'
  gone /opt/Kea /usr/bin/kea-app /etc/yum.repos.d/kea-app.repo /etc/yum.repos.d/kea-app.repo.rpmsave /usr/share/fonts/kea-app
  rpm -q gpg-pubkey --qf '%{VERSION}\n' 2>/dev/null | grep -qix "$(cut -c33-40 /e/fingerprint)" && fail "Kea's key is still in rpm's keyring"
  kept
  ok "uninstalled: the package, its repository file and Kea's key gone, ~/.kea kept"

  must install-dnf-no-repo --no-repo
  rpm -q kea-app >/dev/null || fail 'kea-app is not installed (--no-repo)'
  grep -qx 'enabled=0' /etc/yum.repos.d/kea-app.repo || fail 'the repository is on after --no-repo'
  must uninstall-dnf-no-repo --uninstall
  gone /opt/Kea /etc/yum.repos.d/kea-app.repo /etc/yum.repos.d/kea-app.repo.rpmsave /etc/yum.repos.d/kea-app.repo.rpmnew
  kept
  ok '--no-repo: the package with its repository off; uninstalled'

  must install-dnf-version --version "$version"
  rpm -q kea-app >/dev/null || fail 'kea-app is not installed (--version)'
  must uninstall-dnf-version --uninstall
  ok "--version $version: that release's package, with the repository; uninstalled"
fi

# ── zypper: the dry runs; the install is tried and reported ────────────────────────────────────────────────────────
if [ "$family" = zypper ]; then
  must dry-run-zypper --dry-run
  must dry-run-zypper-no-repo --dry-run --no-repo
  gone /opt/Kea /etc/zypp/repos.d/kea-app.repo
  ok 'dry runs changed nothing'
  if readme install-zypper; then ok 'installed through zypper'; else say "note the install through zypper failed: $(tail -3 "$out/install-zypper.txt" | tr '\n' ' ')"; fi
fi

# ── the tarball, and --user ───────────────────────────────────────────────────────────────────────────────────────
if [ "$family" = tarball ]; then
  before=$(snapshot)
  must dry-run-tarball --dry-run
  # --user's dry run is refused where AppArmor keeps user namespaces from programs it names no profile for
  if readme dry-run-user --dry-run --user; then
    user_ok=1
  else
    grep -q 'Kea could not start without root here' "$out/dry-run-user.txt" || { tail -5 "$out/dry-run-user.txt"; fail 'install.sh --dry-run --user exited non-zero'; }
    mv "$out/dry-run-user.txt" "$out/dry-run-user-refused.txt"
    user_ok=0
  fi
  gone /opt/Kea "$home/.local/opt/Kea"
  ok 'dry runs changed nothing'

  must install-tarball
  mode() { stat -c '%a %U:%G' "$1"; }
  [ "$(mode /opt/Kea/kea-app)" = '755 root:root' ] || fail "/opt/Kea/kea-app: $(mode /opt/Kea/kea-app)"
  [ "$(mode /opt/Kea/chrome-sandbox)" = '4755 root:root' ] || fail "/opt/Kea/chrome-sandbox: $(mode /opt/Kea/chrome-sandbox)"
  [ "$(mode /usr/local/bin/kea-app)" = '755 root:root' ] || fail '/usr/local/bin/kea-app'
  grep -qx 'Exec=/usr/local/bin/kea-app %U' /usr/local/share/applications/dev.kea.app.desktop || fail 'the desktop file does not start /usr/local/bin/kea-app'
  for f in /usr/local/share/icons/hicolor/256x256/apps/dev.kea.app.png /usr/local/share/icons/hicolor/scalable/apps/dev.kea.app.svg /usr/local/share/fonts/kea-app/JetBrainsMono-Regular.ttf /usr/local/share/fonts/kea-app/JetBrainsMono-Bold.ttf /usr/local/share/doc/kea-app/copyright /opt/Kea/.install-manifest; do
    [ -f "$f" ] || fail "$f is missing"
  done
  case $(fc-match -f '%{file}' 'JetBrains Mono') in /usr/local/share/fonts/kea-app/*) ;; *) fail "fontconfig does not give JetBrains Mono from /usr/local/share/fonts/kea-app: $(fc-match 'JetBrains Mono')" ;; esac
  installed=$(snapshot | grep -vxF "$before" || true)
  listed=$(sed -n 's/^[fd] //p' /opt/Kea/.install-manifest | sort)
  [ "$installed" = "$listed" ] || { printf '%s\n' "$installed" >/tmp/installed; printf '%s\n' "$listed" >/tmp/listed; diff /tmp/listed /tmp/installed | head -20; fail 'the manifest is not exactly what the install made'; }
  ok "installed in /opt/Kea: modes and owners, the desktop file, icons, the font through fontconfig; the manifest lists exactly what it made ($(printf '%s\n' "$listed" | wc -l) paths)"
  must install-tarball-again
  [ "$(snapshot | grep -vxF "$before" || true)" = "$listed" ] || fail 'installing again left other files'
  kept
  ok 'installed again: the tree replaced, the same files'

  must uninstall-tarball --uninstall
  after=$(snapshot)
  [ "$after" = "$before" ] || { printf '%s\n' "$before" >/tmp/before; printf '%s\n' "$after" >/tmp/after; diff /tmp/before /tmp/after | head -20; fail 'the uninstall left the system other than it found it'; }
  kept
  ok 'uninstalled: the system as it was, ~/.kea kept'

  if [ "$user_ok" = 0 ]; then
    readme install-user --user && fail '--user installed where AppArmor restricts user namespaces'
    grep -q 'Install without --user' "$out/install-user.txt" || fail "--user's refusal does not say what to do"
    gone "$home/.local/opt/Kea"
    ok "--user refused: this kernel lets only programs an AppArmor profile names make user namespaces"
  else
    hbefore=$(cd "$home" && find . | sort)
    must install-user --user
    [ -x "$home/.local/opt/Kea/kea-app" ] || fail 'no ~/.local/opt/Kea/kea-app'
    [ "$(stat -c '%U' "$home/.local/opt/Kea/kea-app")" = "$user" ] || fail 'the --user tree is not the user own'
    grep -qx "dir=\${KEA_DIR:-$home/.local/opt/Kea}" "$home/.local/bin/kea-app" || fail "the launcher's default is not the --user tree"
    grep -qx "Exec=$home/.local/bin/kea-app %U" "$home/.local/share/applications/dev.kea.app.desktop" || fail "the --user desktop file"
    case $(sudo -u "$user" fc-match -f '%{file}' 'JetBrains Mono') in "$home"/.local/share/fonts/kea-app/*) ;; *) fail 'fontconfig does not give the --user font' ;; esac
    grep -q 'reduced session isolation' "$out/install-user.txt" || fail '--user does not say isolation is reduced'
    must uninstall-user --uninstall --user
    hafter=$(cd "$home" && find . | grep -v '^\./\.cache' | sort)
    [ "$hafter" = "$(printf '%s\n' "$hbefore" | grep -v '^\./\.cache')" ] || { printf '%s\n' "$hafter" | head; fail '--user uninstall left files in the home'; }
    kept
    ok '--user: installed in ~/.local, reduced isolation said; uninstalled, the home as it was'
  fi
fi
say PASS
