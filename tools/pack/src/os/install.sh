#!/bin/sh
# Kea's installer for macOS and Linux, published with each release:
#
#   curl -fsSL https://github.com/@@REPOSITORY@@/releases/latest/download/install.sh | sh
#   curl -fsSL https://github.com/@@REPOSITORY@@/releases/latest/download/install.sh | sh -s -- --dry-run
#
# Options: --version <v> (that release, not the newest), --dry-run (say everything, change nothing), --no-repo (Linux:
# the package without Kea's repository, so it is not updated), --user (Linux: into your home, without root),
# --uninstall (remove what it installed; ~/.kea stays), --help.
#
# How it keeps you safe: the script is one function, called on its last line inside braces, so a download cut short
# anywhere runs nothing. It downloads over HTTPS only; checks Kea's key against the fingerprint written in below, and
# every file against the release's SHA256SUMS; and checks SHA256SUMS's signature with that key wherever GnuPG's gpgv or
# Sequoia's sqv is installed. The repositories it adds are checked by apt, dnf or zypper with the same key. It never
# pipes a download into a shell. Every command that changes the system is printed before it runs (--dry-run prints
# them and runs none), and nothing is asked but sudo's own password.
#
# Built from tools/pack/src/os/install.sh by tools/pack/src/os/installScript.ts, which writes in the values below.

kea_install() {
  set -eu

  # ── written in by the build ──────────────────────────────────────────────────────────────────────────────────────
  repository='@@REPOSITORY@@'             # Kea's GitHub repository, owner/name
  key_fingerprint='@@KEY_FINGERPRINT@@'   # the repository key, which signs SHA256SUMS
  certificate_leaf='@@CERTIFICATE_LEAF@@' # the certificate every macOS build is signed with
  git_min_major='@@GIT_MIN_MAJOR@@'       # the oldest git Kea supports
  git_min_minor='@@GIT_MIN_MINOR@@'
  macos_min='@@MACOS_MIN_MAJOR@@'         # the oldest macOS Kea supports
  glibc_min_major='@@GLIBC_MIN_MAJOR@@'   # the oldest glibc Kea supports on Linux
  glibc_min_minor='@@GLIBC_MIN_MINOR@@'

  # Names the packages use too
  name=kea-app
  app_id=dev.kea.app
  apt_source=/etc/apt/sources.list.d/kea-app.sources
  apt_key=/usr/share/keyrings/kea-app.gpg
  apt_defaults=/etc/default/kea-app
  dnf_repo=/etc/yum.repos.d/kea-app.repo
  zypper_repo=/etc/zypp/repos.d/kea-app.repo
  profile=/etc/apparmor.d/kea-app
  mac_app=/Applications/Kea.app
  command_line="curl -fsSL https://github.com/$repository/releases/latest/download/install.sh | sh"

  # ── output ───────────────────────────────────────────────────────────────────────────────────────────────────────
  say() { printf '%s\n' "$*"; }
  warn() { printf 'warning: %s\n' "$*"; }
  die() {
    printf 'install.sh: %s\n' "$*" >&2
    exit 1
  }
  usage() {
    say "Kea's installer, for macOS and Linux."
    say "  $command_line"
    say "  $command_line -s -- [options]"
    say "Options:"
    say "  --version <v>  install that release instead of the newest one"
    say "  --dry-run      say what it would do and run nothing that changes the system"
    say "  --no-repo      Linux: the package without Kea's repository (so it is never updated)"
    say "  --user         Linux: into your home (~/.local), without root; session isolation is reduced"
    say "  --uninstall    remove what it installed (with --user: the install in your home); ~/.kea stays"
  }

  # A word as a shell reads it back: as it is when that is safe, else in single quotes
  quote() {
    case $1 in
      '' | *[!A-Za-z0-9_./:=@%+,-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
      *) printf '%s' "$1" ;;
    esac
  }
  shown() {
    shown_line='+'
    for shown_word do shown_line="$shown_line $(quote "$shown_word")"; done
    say "$shown_line"
  }
  changes_begun=0
  changes() { # changes mine|root: the heading over the commands that change the system, once
    [ "$changes_begun" = 1 ] && return 0
    changes_begun=1
    if [ "$dry_run" = 1 ]; then
      say "Commands that would change the system (a dry run: none runs):"
    elif [ "$1" = root ] && [ "$root_by" = sudo ]; then
      say "Commands that change the system, each printed as it runs (sudo may ask for your password):"
    else
      say "Commands that change the system, each printed as it runs:"
    fi
  }
  # mine <command…>: a change made as you (a --user install; an /Applications you can write to)
  mine() {
    changes mine
    shown "$@"
    [ "$dry_run" = 1 ] || "$@" </dev/null
  }
  # as_root <command…>: a change made as root, through sudo unless this already runs as root
  as_root() {
    changes root
    if [ "$root_by" = sudo ]; then
      shown sudo "$@"
      [ "$dry_run" = 1 ] || sudo "$@" </dev/null
    else
      shown "$@"
      [ "$dry_run" = 1 ] || "$@" </dev/null
    fi
  }
  # made <file> <what it is>: a file this run makes in its temporary folder, shown with its text
  made() {
    say "File $1, $2:"
    sed 's/^/    /' "$1"
  }

  # ── versions, downloads and checks ───────────────────────────────────────────────────────────────────────────────
  # at_least <version> <major> <minor>: the version's first two numbers are at least these
  at_least() {
    al_major=${1%%.*}
    al_rest=${1#"$al_major"}
    al_rest=${al_rest#.}
    al_minor=${al_rest%%[!0-9]*}
    case $al_major in '' | *[!0-9]*) return 1 ;; esac
    [ -n "$al_minor" ] || al_minor=0
    [ "$al_major" -gt "$2" ] || { [ "$al_major" -eq "$2" ] && [ "$al_minor" -ge "$3" ]; }
  }
  fetch() { # fetch <file>: <base>/<file> into ./<file>, over HTTPS only
    curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o "$1" "$base/$1" || die "could not download $1 from $base/"
  }
  fetch_big() { # the same with a progress bar on a terminal
    if [ -t 2 ]; then
      curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fSL --progress-bar -o "$1" "$base/$1" || die "could not download $1 from $base/"
    else
      fetch "$1"
    fi
  }
  sha256_of() {
    if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi
  }
  listed_hash() { # the SHA-256 SHA256SUMS gives <file>, which it must list exactly once
    awk -v f="$1" 'length($1) == 64 && ($2 == f || $2 == "*" f) { print $1; n++ } END { if (n != 1) exit 1 }' SHA256SUMS
  }
  check() { # check <file>: its SHA-256 is the one SHA256SUMS gives it
    check_want=$(listed_hash "$1") || die "SHA256SUMS does not list $1 exactly once: nothing was installed"
    check_got=$(sha256_of "$1")
    [ "$check_want" = "$check_got" ] || die "$1 does not match SHA256SUMS (it hashes to $check_got, the release lists $check_want): nothing was installed"
  }
  # release_file <prefix> <suffix>: the one file of the release named <prefix><version><suffix>
  release_file() {
    awk -v p="$1" -v s="$2" 'length($1) == 64 { f = $2; sub(/^\*/, "", f); if (index(f, p) == 1 && length(f) > length(p) + length(s) && substr(f, length(f) - length(s) + 1) == s) { print f; n++ } } END { if (n != 1) exit 1 }' SHA256SUMS ||
      die "the release has no file $1<version>$2 (or more than one): this system or architecture may not have a build"
  }
  version_of() { # version_of <file> <prefix> <suffix>
    vo=${1#"$2"}
    printf '%s' "${vo%"$3"}"
  }
  # dearmor <armoured key> <binary key>: the key's base64 between its armour lines, decoded (what gpg --dearmor does)
  dearmor() {
    sed -n '/^-----BEGIN PGP PUBLIC KEY BLOCK-----/,/^-----END PGP PUBLIC KEY BLOCK-----/p' "$1" | tr -d '\r' |
      grep -v -e '^-----' -e ':' -e '^=' -e '^$' | base64 -d >"$2" 2>/dev/null || die "could not read the key in $1"
    [ -s "$2" ] || die "could not read the key in $1"
  }
  hash_of() { # hash_of 1|256: the SHA-1 or SHA-256 of what comes in, in hex
    if command -v "sha$1sum" >/dev/null 2>&1; then "sha$1sum" | awk '{ print $1 }'; else shasum -a "$1" | awk '{ print $1 }'; fi
  }
  # key_fpr <binary key>: the fingerprint of the one primary key it holds, worked out here, so the pin holds where no
  # OpenPGP tool is installed (RFC 9580 §5.5.4: v4 is SHA-1 over 0x99, a two-byte length and the key packet's body;
  # v6 SHA-256 over 0x9B and a four-byte length). Fails on a file of other packets, or of more than one primary key.
  key_fpr() {
    kf_bytes=$(od -An -v -tu1 "$1" | awk '
      { for (i = 1; i <= NF; i++) b[n++] = $i + 0 }
      END {
        p = 0 # a number: an unset variable indexes an array as "" in some awks
        keys = 0
        while (p < n) {
          h = b[p]
          if (h < 128) exit 1
          if (h >= 192) {
            t = h - 192; l = b[p + 1]
            if (l < 192) { len = l; at = p + 2 }
            else if (l < 224) { len = (l - 192) * 256 + b[p + 2] + 192; at = p + 3 }
            else if (l == 255) { len = ((b[p + 2] * 256 + b[p + 3]) * 256 + b[p + 4]) * 256 + b[p + 5]; at = p + 6 }
            else exit 1
          } else {
            t = int((h - 128) / 4); lt = h % 4
            if (lt == 0) { len = b[p + 1]; at = p + 2 }
            else if (lt == 1) { len = b[p + 1] * 256 + b[p + 2]; at = p + 3 }
            else if (lt == 2) { len = ((b[p + 1] * 256 + b[p + 2]) * 256 + b[p + 3]) * 256 + b[p + 4]; at = p + 5 }
            else exit 1
          }
          if (at + len > n || (p == 0 && t != 6)) exit 1
          if (t == 6) { keys++; ks = at; kl = len }
          p = at + len
        }
        if (keys != 1) exit 1
        if (b[ks] == 4) printf "1 \\231\\%03o\\%03o", int(kl / 256), kl % 256
        else if (b[ks] == 6) printf "256 \\233\\%03o\\%03o\\%03o\\%03o", int(kl / 16777216), int(kl / 65536) % 256, int(kl / 256) % 256, kl % 256
        else exit 1
        for (i = ks; i < ks + kl; i++) printf "\\%03o", b[i]
      }') || return 1
    # shellcheck disable=SC2059 # the format is the key's bytes as \ooo escapes, made just above, with no % in it
    printf "${kf_bytes#* }" | hash_of "${kf_bytes%% *}" | tr 'a-f' 'A-F'
  }
  # The release's SHA256SUMS, and its signature where gpgv or sqv can check it
  sums() {
    fetch SHA256SUMS
    have_key
    if sums_tool=$(command -v gpgv 2>/dev/null); then
      fetch SHA256SUMS.asc
      sums_status=$("$sums_tool" --keyring ./kea-app.gpg --status-fd 1 SHA256SUMS.asc SHA256SUMS 2>/dev/null) ||
        die "SHA256SUMS's signature does not verify with Kea's key: nothing was installed"
      sums_signer=$(printf '%s\n' "$sums_status" | awk '$1 == "[GNUPG:]" && $2 == "VALIDSIG" { print $NF }')
      [ "$sums_signer" = "$key_fingerprint" ] || die "SHA256SUMS is signed by ${sums_signer:-no key}, not by Kea's key $key_fingerprint: nothing was installed"
      sums_said="signed by Kea's key $key_fingerprint (checked with gpgv)"
    elif sums_tool=$(command -v sqv 2>/dev/null); then
      # Sequoia's verifier, which apt uses from Debian 13 on; the keyring is the pinned key alone
      fetch SHA256SUMS.asc
      "$sums_tool" --keyring ./kea-app.gpg SHA256SUMS.asc SHA256SUMS >/dev/null 2>&1 ||
        die "SHA256SUMS's signature does not verify with Kea's key: nothing was installed"
      sums_said="signed by Kea's key $key_fingerprint (checked with sqv)"
    else
      sums_said="not signature-checked (neither GnuPG's gpgv nor Sequoia's sqv is installed). Every file is still checked against it, and Kea's key against the fingerprint this script pins"
    fi
    check kea-app.asc
  }
  have_key() { # kea-app.asc downloaded, kea-app.gpg made from it and checked against the pinned fingerprint, once
    [ -f kea-app.gpg ] && return 0
    fetch kea-app.asc
    dearmor kea-app.asc kea-app.gpg
    hk_fpr=$(key_fpr kea-app.gpg) || die "kea-app.asc is not one OpenPGP key: nothing was installed"
    [ "$hk_fpr" = "$key_fingerprint" ] || die "kea-app.asc is not Kea's key (its fingerprint is $hk_fpr; this script pins $key_fingerprint): nothing was installed"
  }

  # ── options ──────────────────────────────────────────────────────────────────────────────────────────────────────
  dry_run=0
  no_repo=0
  user=0
  uninstall=0
  want_version=
  while [ $# -gt 0 ]; do
    case $1 in
      --dry-run) dry_run=1 ;;
      --no-repo) no_repo=1 ;;
      --user) user=1 ;;
      --uninstall) uninstall=1 ;;
      --version)
        [ $# -gt 1 ] || die "--version needs a version, for example --version 0.2.0"
        want_version=$2
        shift
        ;;
      --version=*) want_version=${1#--version=} ;;
      -h | --help)
        usage
        return 0
        ;;
      *) die "unknown option $1 (--help lists them)" ;;
    esac
    shift
  done
  case $repository$key_fingerprint$certificate_leaf in *@*) die "this is install.sh's template: tools/pack/src/os/installScript.ts builds the script" ;; esac
  version_ok() { # 0.2.0 or 0.2.0-rc.1, a release's form (the shell's own patterns: nothing runs before the checks)
    vk=$1
    case $vk in *-rc.*) vk_rc=${vk##*-rc.} vk=${vk%-rc.*} ;; *) vk_rc=0 ;; esac
    case $vk in *.*.*) ;; *) return 1 ;; esac
    vk_major=${vk%%.*}
    vk=${vk#*.}
    for vk_part in "$vk_rc" "$vk_major" "${vk%%.*}" "${vk#*.}"; do
      case $vk_part in '' | *[!0-9]* | 0?*) return 1 ;; esac
    done
  }
  if [ -n "$want_version" ]; then
    want_version=${want_version#v}
    version_ok "$want_version" || die "--version $want_version is not a Kea version (like 0.2.0 or 0.2.0-rc.1)"
    base="https://github.com/$repository/releases/download/v$want_version"
  else
    base="https://github.com/$repository/releases/latest/download"
  fi
  if [ "$uninstall" = 1 ] && { [ "$no_repo" = 1 ] || [ -n "$want_version" ]; }; then die "--uninstall takes only --user and --dry-run"; fi
  # the commands every path uses, looked for (command -v is the shell's own) before any runs
  nt_missing=
  for nt in uname id mktemp curl sed awk grep tr od base64 sort cat; do
    command -v "$nt" >/dev/null 2>&1 || nt_missing="$nt_missing $nt"
  done
  for nt in sha1sum sha256sum; do
    command -v "$nt" >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 || nt_missing="$nt_missing $nt"
  done
  [ -z "$nt_missing" ] || die "this system lacks commands install.sh needs:$nt_missing. Install them with your package manager (awk comes in gawk's package on most systems), then run this again"

  system=$(uname -s)
  case $system in
    Darwin) if [ "$user" = 1 ] || [ "$no_repo" = 1 ]; then die "--user and --no-repo are for Linux: on macOS Kea goes to /Applications"; fi ;;
    Linux) ;;
    *) die "Kea runs on macOS and Linux, not $system" ;;
  esac

  # Who runs the changes: you (--user), root through sudo, or root itself
  if [ "$(id -u)" = 0 ]; then root_by=root; else root_by=sudo; fi
  if [ "$user" = 1 ] && [ "$root_by" = root ]; then die "--user installs Kea for the user who runs it, and this runs as root: run it as yourself"; fi
  needs_sudo() {
    [ "$root_by" = sudo ] && [ "$dry_run" = 0 ] && ! command -v sudo >/dev/null 2>&1 && die "this needs root for the commands it prints: install sudo, or run it as root"
    return 0
  }

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/kea-install.XXXXXX") || die "could not make a temporary folder"
  trap 'cd / && rm -rf "$tmp"' EXIT
  trap 'exit 1' HUP INT TERM
  cd "$tmp"

  if [ "$dry_run" = 1 ]; then
    say "Kea's installer, a dry run: it downloads only the release's checksums and key, and changes nothing."
  fi

  # ── macOS (curl sets no quarantine attribute, so the app opens with no Gatekeeper prompt) ────────────────────────
  mac_change() { # into /Applications: as you where you can write it, else through sudo
    if [ -w /Applications ]; then mine "$@"; else as_root "$@"; fi
  }
  mac_running() {
    pgrep -f '^/Applications/Kea\.app/Contents/MacOS/Kea( |$)' >/dev/null 2>&1
  }
  mac_bundle_value() { # mac_bundle_value <app> <key>
    plutil -extract "$2" raw "$1/Contents/Info.plist" 2>/dev/null || true
  }
  mac_git() {
    mg_git=$(command -v git 2>/dev/null || true)
    if [ -z "$mg_git" ]; then
      warn "git is not installed: Kea opens projects without worktrees until it is. Install Xcode Command Line Tools (xcode-select --install) to use git"
    elif [ "$mg_git" = /usr/bin/git ] && ! xcode-select -p >/dev/null 2>&1; then
      # /usr/bin/git without the Command Line Tools is Apple's stub, which would open the install dialog
      warn "only Apple's git stub is here: Install Xcode Command Line Tools (xcode-select --install) to use git"
    else
      git_check "$mg_git"
    fi
  }
  git_check() { # git_check <git> [<hint>]: its version, and a warning below the oldest Kea supports
    gc_version=$("$1" --version 2>/dev/null | sed -n 's/^git version \([0-9][0-9.]*\).*/\1/p')
    if at_least "$gc_version" "$git_min_major" "$git_min_minor"; then
      say "git $gc_version"
    else
      warn "git ${gc_version:-of unknown version} is older than $git_min_major.$git_min_minor, which Kea needs for its worktrees${2:+: $2}"
    fi
  }
  install_mac() {
    [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] || die "Kea needs a Mac with Apple silicon: Intel Macs are not supported (Kea is built for arm64 only)"
    im_os=$(sw_vers -productVersion)
    at_least "$im_os" "$macos_min" 0 || die "Kea needs macOS $macos_min or later, and this Mac has macOS $im_os"
    say "System: macOS $im_os, Apple silicon"
    mac_git
    sums
    zip=$(release_file Kea- -arm64-mac.zip)
    version=$(version_of "$zip" Kea- -arm64-mac.zip)
    say "Release: Kea $version, from $base/"
    say "SHA256SUMS: $sums_said"
    [ -w /Applications ] || needs_sudo
    im_old=
    if [ -d "$mac_app" ]; then
      [ "$(mac_bundle_value "$mac_app" CFBundleIdentifier)" = "$app_id" ] || die "$mac_app is not Kea (its bundle identifier is not $app_id): nothing was changed"
      im_old=$(mac_bundle_value "$mac_app" CFBundleShortVersionString)
      if [ "$im_old" = "$version" ]; then
        say "Kea $version is already installed in $mac_app."
        return 0
      fi
      if mac_running; then
        die "Kea ${im_old:-(an older version)} is running from $mac_app, so nothing was replaced: quit it completely (Quit Kea Completely, ⌥⌘Q; its sessions keep running) and run this again"
      fi
    fi
    say "Plan: Kea $version in $mac_app${im_old:+, replacing Kea $im_old}, from $zip: unpacked with ditto -x -k, then checked with codesign --verify --deep --strict and against Kea's certificate (leaf $certificate_leaf)"
    if [ "$dry_run" = 0 ]; then
      fetch_big "$zip"
      check "$zip"
      ditto -x -k "$zip" app || die "could not unpack $zip"
      [ -d app/Kea.app ] || die "$zip holds no Kea.app"
      codesign --verify --deep --strict app/Kea.app || die "Kea.app's signature does not verify: nothing was installed"
      codesign --verify --strict -R "=identifier \"$app_id\" and certificate leaf = H\"$certificate_leaf\"" app/Kea.app 2>/dev/null ||
        die "Kea.app is not signed by Kea's certificate (leaf $certificate_leaf): nothing was installed"
      im_req=$(codesign -d -r- app/Kea.app 2>&1 | sed -n 's/^designated => //p')
      [ "$im_req" = "identifier \"$app_id\" and certificate leaf = H\"$certificate_leaf\"" ] ||
        die "Kea.app's designated requirement is not Kea's ($im_req): nothing was installed"
      [ "$(mac_bundle_value app/Kea.app CFBundleShortVersionString)" = "$version" ] || die "$zip holds another version of Kea than $version"
      if xattr -r app/Kea.app 2>/dev/null | grep -q 'com\.apple\.quarantine'; then
        # curl sets none; something on this Mac did, and it would make Gatekeeper ask
        warn "the download was quarantined by something on this Mac; the checked app is installed without it"
        xattr -dr com.apple.quarantine app/Kea.app
      fi
    fi
    if [ -d "$mac_app" ]; then mac_change rm -rf "$mac_app"; fi
    mac_change mv app/Kea.app "$mac_app"
    [ "$dry_run" = 1 ] && return 0
    [ "$(mac_bundle_value "$mac_app" CFBundleShortVersionString)" = "$version" ] || die "Kea $version is not in $mac_app after the move"
    say ""
    say "Kea $version is installed in $mac_app. Open it from Launchpad, Spotlight or the Applications folder."
    say "Its data will live in ~/.kea. To update it, quit it completely (⌥⌘Q; its sessions keep running) and run this again: $command_line"
    say "To uninstall: $command_line -s -- --uninstall"
  }
  uninstall_mac() {
    if [ ! -d "$mac_app" ]; then
      say "Kea is not installed in /Applications: nothing to remove."
      return 0
    fi
    [ "$(mac_bundle_value "$mac_app" CFBundleIdentifier)" = "$app_id" ] || die "$mac_app is not Kea (its bundle identifier is not $app_id): nothing was removed"
    mac_running && die "Kea is running: quit it completely first (in Kea, Stop All and Quit ends the sessions too), then run this again. Nothing was removed"
    data_note "Library/Application Support/Kea"
    mac_change rm -rf "$mac_app"
    [ "$dry_run" = 1 ] || say "Kea is removed from $mac_app."
  }
  data_note() { # data_note <the window's state, under ~>: what stays, and the order for removing everything
    say "Kea's data stays in ~/.kea: the sessions' worktrees, which may hold uncommitted work, their scrollback and your settings (~/$1 holds the window's own state)."
    say "Terminals still running keep running after Kea is gone. To remove everything: in Kea, Stop All and Quit; then remove the app; then delete ~/.kea once you have checked its worktrees."
  }

  # ── Linux ───────────────────────────────────────────────────────────────────────────────────────────────────────
  os_value() { # os_value <field>: /etc/os-release's value, read as data and never run
    [ -r "$os_release" ] || return 0
    sed -n "s/^$1=//p" "$os_release" | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" | sed -n '$p'
  }
  kea_running() { # kea_running <tree>: a process this user can see runs <tree>/kea-app
    for kr in /proc/[0-9]*; do
      case $(readlink "$kr/exe" 2>/dev/null || true) in "$1/$name" | "$1/$name (deleted)") return 0 ;; esac
    done
    return 1
  }
  linux_facts() {
    os_release=/etc/os-release
    [ -r "$os_release" ] || os_release=/usr/lib/os-release
    os_id=$(os_value ID)
    os_like=$(os_value ID_LIKE)
    os_name=$(os_value PRETTY_NAME)
    case $(uname -m) in
      x86_64 | amd64) arch=x64 deb_arch=amd64 rpm_arch=x86_64 ;;
      aarch64 | arm64) arch=arm64 deb_arch=arm64 rpm_arch=aarch64 ;;
      *) die "Kea is built for x64 and arm64 Linux, not $(uname -m)" ;;
    esac
    family=tarball
    # shellcheck disable=SC2086 # ID_LIKE is a list of words
    for lf_word in $os_id $os_like; do
      case $lf_word in
        debian | ubuntu) command -v apt-get >/dev/null 2>&1 && family=apt ;;
        fedora | rhel | centos) command -v dnf >/dev/null 2>&1 && family=dnf ;;
        suse | opensuse | opensuse-* | sles) command -v zypper >/dev/null 2>&1 && family=zypper ;;
        *) continue ;;
      esac
      break
    done
    [ "$user" = 1 ] && family=user
    return 0
  }
  linux_checks() { # glibc (refused below the floor), git and the systemd user manager (warned)
    lc_libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
    case $lc_libc in
      "glibc "*) at_least "${lc_libc#glibc }" "$glibc_min_major" "$glibc_min_minor" || die "Kea needs glibc $glibc_min_major.$glibc_min_minor or later, and this system has ${lc_libc#glibc }" ;;
      *) die "Kea needs glibc $glibc_min_major.$glibc_min_minor or later: this system has no glibc (musl-based systems are not supported)" ;;
    esac
    say "System: ${os_name:-Linux}, $arch, glibc ${lc_libc#glibc }"
    case $family in
      apt) lc_hint="Kea's package recommends git, so apt installs it" ;;
      dnf) lc_hint="Kea's package recommends git-core, so dnf installs it" ;;
      zypper) lc_hint="install git with: sudo zypper install git" ;;
      *) lc_hint="install git $git_min_major.$git_min_minor or later with your package manager" ;;
    esac
    if command -v git >/dev/null 2>&1; then
      git_check git "$lc_hint"
    else
      warn "git is not installed: Kea opens projects without worktrees until it is ($lc_hint)"
    fi
    if [ ! -d /run/systemd/system ] || [ ! -S "${XDG_RUNTIME_DIR:-/nonexistent}/systemd/private" ]; then
      warn "no systemd user manager answers here, so Kea's terminals run in session mode: sessions may end if your desktop stops Kea (Settings › About says more)"
    fi
  }
  linux_release() { # SHA256SUMS, the version, and what is said about them
    sums
    lr_tarball=$(release_file "$name-" "-linux-$arch.tar.gz")
    version=$(version_of "$lr_tarball" "$name-" "-linux-$arch.tar.gz")
    say "Release: Kea $version, from $base/"
    say "SHA256SUMS: $sums_said"
  }
  repo_text() { # the repository files the packages write too, byte for byte
    case $1 in
      apt)
        cat <<'KEA_APT_SOURCE'
@@APT_SOURCE@@
KEA_APT_SOURCE
        ;;
      dnf)
        cat <<'KEA_DNF_REPO'
@@DNF_REPO@@
KEA_DNF_REPO
        ;;
      dnf-off)
        cat <<'KEA_DNF_REPO_OFF'
@@DNF_REPO_OFF@@
KEA_DNF_REPO_OFF
        ;;
      zypper)
        cat <<'KEA_ZYPPER_REPO'
@@ZYPPER_REPO@@
KEA_ZYPPER_REPO
        ;;
    esac
  }
  the_package() { # the_package <file>: in the release; downloaded and checked (not in a dry run)
    listed_hash "$1" >/dev/null || die "the release has no $1: this system or architecture may not have a build"
    [ "$dry_run" = 1 ] && return 0
    fetch_big "$1"
    check "$1"
  }
  install_apt() {
    if [ "$no_repo" = 1 ]; then
      ia_deb="${name}_${version}_$deb_arch.deb"
      say "Plan: Kea's package $ia_deb, without Kea's repository, so apt never updates it ($apt_defaults says add_repository=no)"
      the_package "$ia_deb"
      printf '%s\n' 'add_repository=no' >kea-app.defaults
      made kea-app.defaults "for $apt_defaults: the package adds no repository"
      as_root install -m 0644 kea-app.defaults "$apt_defaults"
      as_root apt-get update
      as_root apt-get install -y "./$ia_deb"
      return 0
    fi
    if [ -n "$want_version" ]; then
      say "Plan: Kea's apt repository, then Kea's package $version from its release (newer ones come through the repository)"
    else
      say "Plan: Kea's apt repository, then Kea's package from it"
    fi
    have_key
    check kea-app.asc
    repo_text apt >kea-app.sources
    say "File kea-app.gpg, Kea's key for $apt_key: kea-app.asc, checked, with its armour taken off"
    made kea-app.sources "for $apt_source"
    [ -z "$want_version" ] || the_package "${name}_${version}_$deb_arch.deb"
    as_root install -D -m 0644 kea-app.gpg "$apt_key"
    if [ -e "$apt_source" ]; then
      say "Kept $apt_source: it is there already, and a source someone set up stays theirs"
    else
      as_root install -m 0644 kea-app.sources "$apt_source"
    fi
    as_root apt-get update
    if [ -n "$want_version" ]; then as_root apt-get install -y "./${name}_${version}_$deb_arch.deb"; else as_root apt-get install -y "$name"; fi
  }
  install_rpm() { # dnf and zypper
    ir_rpm="$name-$version-1.$rpm_arch.rpm"
    have_key
    check kea-app.asc
    if [ "$family" = dnf ]; then ir_repo=$dnf_repo; else ir_repo=$zypper_repo; fi
    if [ "$no_repo" = 1 ]; then
      say "Plan: Kea's package $ir_rpm, without Kea's repository, so $family never updates it"
    elif [ -n "$want_version" ]; then
      say "Plan: Kea's $family repository, then Kea's package $version from its release (newer ones come through the repository)"
    else
      say "Plan: Kea's $family repository, then Kea's package from it"
    fi
    if [ "$family" = dnf ] && [ "$no_repo" = 1 ]; then
      repo_text dnf-off >kea-app.repo
      made kea-app.repo "for $dnf_repo, with the repository off (the package's own file names it)"
    elif [ "$no_repo" = 0 ]; then
      repo_text "$family" >kea-app.repo
      made kea-app.repo "for $ir_repo"
    fi
    if [ "$no_repo" = 1 ] || [ -n "$want_version" ]; then the_package "$ir_rpm"; fi
    # the key in rpm's keyring: the repository's metadata and every package are signed with it
    as_root rpm --import kea-app.asc
    if [ "$family" = dnf ]; then
      if [ "$no_repo" = 1 ]; then
        as_root dnf install -y "./$ir_rpm"
        as_root install -m 0644 kea-app.repo "$dnf_repo"
        return 0
      fi
      if [ -e "$dnf_repo" ]; then say "Kept $dnf_repo: it is there already, and a repository someone set up stays theirs"; else as_root install -m 0644 kea-app.repo "$dnf_repo"; fi
      if [ -n "$want_version" ]; then as_root dnf install -y "./$ir_rpm"; else as_root dnf install -y "$name"; fi
    else
      if [ "$no_repo" = 1 ]; then
        as_root zypper --non-interactive install "./$ir_rpm"
        return 0
      fi
      if [ -e "$zypper_repo" ]; then say "Kept $zypper_repo: it is there already, and a repository someone set up stays theirs"; else as_root install -m 0644 kea-app.repo "$zypper_repo"; fi
      as_root zypper --non-interactive refresh "$name"
      if [ -n "$want_version" ]; then as_root zypper --non-interactive install "./$ir_rpm"; else as_root zypper --non-interactive install "$name"; fi
    fi
  }

  # The tarball, for systems with no apt, dnf or zypper (into /opt/Kea, root) and for --user (into ~/.local).
  # Every file and folder it makes is listed in <tree>/.install-manifest, which --uninstall removes exactly.
  tarball_files() { # the tarball's files outside opt/Kea, as "<mode> <path>" (the packages' own list)
    cat <<'KEA_TARBALL_FILES'
@@TARBALL_FILES@@
KEA_TARBALL_FILES
  }
  tree_places() {
    if [ "$user" = 1 ]; then
      run=mine
      tree=$HOME/.local/opt/Kea
      bin_dir=$HOME/.local/bin
      data_dir=${XDG_DATA_HOME:-$HOME/.local/share}
      case $data_dir in /*) ;; *) data_dir=$HOME/.local/share ;; esac
    else
      run=as_root
      tree=/opt/Kea
      bin_dir=/usr/local/bin
      data_dir=/usr/local/share
    fi
  }
  outside_place() { # outside_place <path in the tarball>: where this install puts it
    case $1 in
      usr/bin/*) printf '%s/%s\n' "$bin_dir" "${1#usr/bin/}" ;;
      usr/share/*) printf '%s/%s\n' "$data_dir" "${1#usr/share/}" ;;
      *) die "the release's tarball has $1 outside opt/Kea, usr/bin and usr/share" ;;
    esac
  }
  apparmor_tool() {
    for at in "$(command -v apparmor_parser 2>/dev/null || true)" /usr/sbin/apparmor_parser /sbin/apparmor_parser; do
      [ -n "$at" ] && [ -x "$at" ] && { printf '%s\n' "$at"; return 0; }
    done
    return 1
  }
  user_namespaces() { # whether Chromium's sandbox can make the user namespaces it needs without root
    [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" != 1 ] &&
      [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" != 0 ] &&
      [ "$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 1)" != 0 ] &&
      { ! command -v unshare >/dev/null 2>&1 || unshare --user true 2>/dev/null; }
  }
  install_tree() {
    tree_places
    it_tarball="$name-$version-linux-$arch.tar.gz"
    it_top=${it_tarball%.tar.gz}
    if [ "$user" = 1 ]; then
      case $HOME in /*) ;; *) die "--user needs HOME set to your home folder" ;; esac
      case $HOME in *[!A-Za-z0-9._/@+-]*) die "--user needs a home folder whose path has only letters, digits and . _ / @ + - (yours is $HOME)" ;; esac
      user_namespaces || die "Kea could not start without root here: this system lets only programs an AppArmor profile names make the user namespaces its window's sandbox needs (Ubuntu 23.10 and later), and only root can install that profile. Install without --user"
      say "Plan: Kea $version in $tree, for you alone, from $it_tarball"
      warn "a --user install has reduced session isolation: Kea's files are writable by your user, so an agent could change Kea itself. Without --user, Kea's files belong to root"
    else
      say "Plan: Kea $version in $tree, from $it_tarball (this system has no apt, dnf or zypper)"
    fi
    if [ -e "$tree" ] && [ ! -f "$tree/.install-manifest" ]; then die "$tree is there and install.sh did not put it there: remove it with what installed it, then run this again"; fi
    kea_running "$tree" && die "Kea is running from $tree: quit it completely first (sessions keep running), then run this again. Nothing was changed"
    it_profile=0
    if [ "$user" = 0 ] && it_aa=$(apparmor_tool) && [ -d /etc/apparmor.d ] && [ -f /etc/apparmor.d/abi/4.0 ]; then it_profile=1; fi

    # the archive, unpacked here as you: its files are checked, and the desktop file (and, for --user, the launcher)
    # made for where this install puts them
    if [ "$dry_run" = 0 ]; then
      the_package "$it_tarball"
      tar -xzf "$it_tarball" || die "could not unpack $it_tarball"
      [ -f "$it_top/opt/Kea/$name" ] || die "$it_tarball has no opt/Kea/$name"
      (cd "$it_top" && find . ! -type d ! -path './opt/Kea/*' | sed 's|^\./||' | sort) >tarball-outside
      tarball_files | awk '{ print $2 }' | sort >tarball-expected
      cmp -s tarball-outside tarball-expected || die "$it_tarball's files outside opt/Kea are not the ones this installer knows"
      if (cd "$it_top/opt/Kea" && find . | grep -q '[^A-Za-z0-9._/@+,=-]'); then die "$it_tarball has a file name this installer cannot list"; fi
      if [ "$it_profile" = 1 ] && ! "$it_aa" --skip-kernel-load --debug "$it_top/opt/Kea/resources/apparmor-profile" >/dev/null 2>&1; then it_profile=0; fi
    fi
    it_exec=$(outside_place "usr/bin/$name")
    sed_from="Exec=/usr/bin/$name "
    if [ "$dry_run" = 0 ]; then
      sed "s|^$sed_from|Exec=$it_exec |" "$it_top/usr/share/applications/$app_id.desktop" >"$app_id.desktop"
      grep -q "^Exec=$it_exec " "$app_id.desktop" || die "the tarball's desktop file does not start /usr/bin/$name"
      if [ "$user" = 1 ]; then
        # the launcher, with this tree as its default (it is /opt/Kea's otherwise)
        sed "s|^dir=\${KEA_DIR:-/opt/Kea}\$|dir=\${KEA_DIR:-$tree}|" "$it_top/usr/bin/$name" >"$name"
        grep -q "^dir=\${KEA_DIR:-$tree}\$" "$name" || die "the tarball's launcher does not name /opt/Kea as its default"
      fi
    fi

    # the manifest: the folders it makes (on an upgrade, also those the first install made), then every file
    {
      {
        {
          tarball_files | while read -r _ it_path; do dirname "$(outside_place "$it_path")"; done
          dirname "$tree"
        } | while read -r it_dir; do
          while [ ! -d "$it_dir" ]; do
            printf 'd %s\n' "$it_dir"
            it_dir=$(dirname "$it_dir")
          done
        done
        if [ -f "$tree/.install-manifest" ]; then grep '^d ' "$tree/.install-manifest" | grep -v -e "^d $tree\$" -e "^d $tree/" || true; fi
      } | sort -u
      tarball_files | while read -r _ it_path; do printf 'f %s\n' "$(outside_place "$it_path")"; done
      if [ "$dry_run" = 0 ]; then
        (cd "$it_top/opt/Kea" && find . -type d | sed "s|^\.|d $tree|")
        (cd "$it_top/opt/Kea" && find . ! -type d | sed "s|^\./|f $tree/|")
      fi
      printf 'f %s\n' "$tree/.install-manifest"
      [ "$it_profile" = 0 ] || printf 'f %s\n' "$profile"
    } >install-manifest
    say "File install-manifest, for $tree/.install-manifest: every folder and file this install makes, which --uninstall removes and nothing else"

    [ "$user" = 1 ] || needs_sudo
    # the folders it makes outside the tree, parents first
    grep '^d ' install-manifest | sed 's/^d //' | awk -v t="$tree" '$0 != t && index($0, t "/") != 1' | sort >folders-new
    while read -r it_dir; do [ -d "$it_dir" ] || $run mkdir -m 0755 "$it_dir"; done <folders-new
    [ ! -e "$tree.new" ] || $run rm -rf "$tree.new"
    $run mkdir "$tree.new"
    $run tar -xzf "$it_tarball" -C "$tree.new" --strip-components=3 "$it_top/opt/Kea"
    if [ "$user" = 1 ]; then
      $run chmod 0755 "$tree.new/chrome-sandbox" # a set-uid helper only root can make; the sandbox uses user namespaces
    else
      $run chown -R root:root "$tree.new"
      $run chmod 4755 "$tree.new/chrome-sandbox" # Chromium's set-uid sandbox helper
    fi
    $run install -m 0644 install-manifest "$tree.new/.install-manifest"
    if [ -e "$tree" ]; then
      # what the installed version had outside the tree and this one does not
      grep '^f ' "$tree/.install-manifest" | grep -v "^f $tree/" | sort >manifest-old || true
      grep '^f ' install-manifest | grep -v "^f $tree/" | sort >manifest-new
      it_gone=$(comm -23 manifest-old manifest-new | sed 's/^f //')
      $run mv "$tree" "$tree.old"
      $run mv "$tree.new" "$tree"
      $run rm -rf "$tree.old"
      for it_path in $it_gone; do $run rm -f "$it_path"; done
    else
      $run mv "$tree.new" "$tree"
    fi
    tarball_files | while read -r it_mode it_path; do
      it_from=$it_top/$it_path
      [ "$it_path" != "usr/share/applications/$app_id.desktop" ] || it_from=$app_id.desktop
      [ "$it_path" != "usr/bin/$name" ] || [ "$user" = 0 ] || it_from=$name
      $run install -m "$it_mode" "$it_from" "$(outside_place "$it_path")"
    done
    if command -v fc-cache >/dev/null 2>&1; then $run fc-cache "$data_dir/fonts/$name"; fi
    if [ "$it_profile" = 1 ]; then
      $run install -m 0644 "$tree/resources/apparmor-profile" "$profile"
      if [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || true)" = Y ]; then $run "$it_aa" --replace "$profile"; fi
    fi
  }

  linux_after() {
    [ "$dry_run" = 1 ] && return 0
    case $family in
      apt) [ "$(dpkg-query -W -f '${db:Status-Status}' "$name" 2>/dev/null || true)" = installed ] || die "apt did not install $name" ;;
      dnf | zypper) rpm -q "$name" >/dev/null 2>&1 || die "$family did not install $name" ;;
      *) [ -x "$tree/$name" ] || die "Kea is not in $tree after the install" ;;
    esac
    say ""
    case $family in
      apt | dnf | zypper)
        la_version=$(if [ "$family" = apt ]; then dpkg-query -W -f '${Version}' "$name"; else rpm -q --qf '%{VERSION}' "$name"; fi 2>/dev/null || true)
        say "Kea ${la_version:-$version} is installed. Start it from your apps (Kea), or run $name."
        if [ "$no_repo" = 1 ]; then
          say "It is not updated: install a newer release the same way. To uninstall: sudo $family remove $name"
        else
          say "It is updated with the rest of your system ($family). To uninstall: sudo $family remove $name"
        fi
        ;;
      *)
        say "Kea $version is installed in $tree. Start it from your apps (Kea), or run $(outside_place "usr/bin/$name")."
        if [ "$user" = 1 ]; then
          case ":${PATH:-}:" in *":$bin_dir:"*) ;; *) say "($bin_dir is not on your PATH, so $name alone is not found in a terminal.)" ;; esac
        fi
        if [ "$user" = 1 ]; then say "To update it, run this again: $command_line -s -- --user"; else say "To update it, run this again: $command_line"; fi
        ;;
    esac
    if [ "$user" = 1 ]; then la_how=' --user'; else la_how=; fi
    say "Its data will live in ~/.kea. To uninstall: $command_line -s -- --uninstall$la_how"
  }

  # --uninstall on Linux: a manifest install exactly as listed; a package with its package manager (purge: the
  # repository's source and key go too)
  uninstall_tree() {
    tree_places
    ut_manifest=$tree/.install-manifest
    kea_running "$tree" && die "Kea is running from $tree: quit it completely first (in Kea, Stop All and Quit ends the sessions too). Nothing was removed"
    # every line must name a place this installer puts things: the tree, or a file of the tarball's list where this install puts it
    tarball_files | while read -r _ ut_path; do outside_place "$ut_path"; done >allowed
    while read -r ut_kind ut_path; do
      case $ut_kind:$ut_path in
        *'/../'* | *'/..') die "$ut_manifest names $ut_path: nothing was removed" ;;
        "f:$tree/"* | "d:$tree" | "d:$tree/"* | "d:$(dirname "$tree")") ;;
        "f:$profile") [ "$user" = 0 ] || die "$ut_manifest names $ut_path: nothing was removed" ;;
        f:*) grep -qxF "$ut_path" allowed || die "$ut_manifest names $ut_path, which install.sh never installs: nothing was removed" ;;
        d:*) grep -q "^$ut_path/" allowed || die "$ut_manifest names the folder $ut_path, which install.sh never makes: nothing was removed" ;;
        *) die "$ut_manifest has a line install.sh never writes: nothing was removed" ;;
      esac
    done <"$ut_manifest"
    [ "$user" = 1 ] || needs_sudo
    cp "$ut_manifest" manifest # the manifest lists itself: what is left to remove is read from this copy
    if grep -qx "f $profile" manifest; then
      if ut_aa=$(apparmor_tool) && [ "$(cat /sys/module/apparmor/parameters/enabled 2>/dev/null || true)" = Y ]; then
        $run "$ut_aa" --remove "$profile" || say "(AppArmor had not loaded it)"
      fi
      for ut_cache in /var/cache/apparmor/*/"$name" /etc/apparmor.d/cache/"$name"; do
        [ ! -e "$ut_cache" ] || $run rm -f "$ut_cache"
      done
    fi
    set --
    while read -r ut_kind ut_path; do
      if [ "$ut_kind" = f ]; then set -- "$@" "$ut_path"; fi
    done <manifest
    $run rm -f -- "$@"
    grep '^d ' manifest | sed 's/^d //' | sort -r >folders
    while read -r ut_dir; do
      if [ "$dry_run" = 1 ]; then
        $run rmdir "$ut_dir"
      elif [ -d "$ut_dir" ]; then
        $run rmdir "$ut_dir" 2>/dev/null || say "Kept $ut_dir: something else is in it"
      fi
    done <folders
    if command -v fc-cache >/dev/null 2>&1 && [ -d "$data_dir/fonts" ]; then $run fc-cache "$data_dir/fonts"; fi
  }
  uninstall_linux() {
    ul_found=0
    if [ "$user" = 1 ]; then
      tree_places
      if [ -f "$tree/.install-manifest" ]; then
        ul_found=1
        data_note ".config/Kea"
        uninstall_tree
      fi
    else
      if [ -f /opt/Kea/.install-manifest ]; then
        ul_found=1
        data_note ".config/Kea"
        uninstall_tree
      fi
      ul_package=
      if command -v dpkg-query >/dev/null 2>&1 && [ "$(dpkg-query -W -f '${db:Status-Status}' "$name" 2>/dev/null || true)" = installed ]; then
        ul_package=apt
      elif command -v rpm >/dev/null 2>&1 && rpm -q "$name" >/dev/null 2>&1; then
        if command -v zypper >/dev/null 2>&1; then ul_package=zypper; else ul_package=dnf; fi
      fi
      if [ -n "$ul_package" ]; then
        [ "$ul_found" = 1 ] || data_note ".config/Kea"
        ul_found=1
        kea_running /opt/Kea && die "Kea is running: quit it completely first (in Kea, Stop All and Quit ends the sessions too). Nothing was removed"
        needs_sudo
        case $ul_package in
          apt)
            # purge: the package's script removes the repository's source and key with it
            as_root apt-get purge -y "$name"
            [ ! -e "$apt_defaults" ] || as_root rm -f "$apt_defaults"
            ;;
          dnf) as_root dnf remove -y "$name" ;;
          zypper)
            as_root zypper --non-interactive remove "$name"
            [ ! -e "$zypper_repo" ] || as_root rm -f "$zypper_repo"
            ;;
        esac
        for ul_file in "$dnf_repo" "$dnf_repo.rpmsave" "$dnf_repo.rpmnew"; do
          [ ! -e "$ul_file" ] || as_root rm -f "$ul_file"
        done
        if [ "$ul_package" != apt ]; then
          # Kea's key in rpm's keyring, by its key ID (the fingerprint's last eight digits, lower case)
          ul_keyid=$(printf '%s' "$key_fingerprint" | sed 's/.*\(........\)$/\1/' | tr 'A-F' 'a-f')
          for ul_key in $(rpm -q gpg-pubkey --qf '%{NAME}-%{VERSION}-%{RELEASE}\n' 2>/dev/null | grep "^gpg-pubkey-$ul_keyid-" || true); do
            as_root rpm -e "$ul_key"
          done
        fi
      fi
      if [ -f "$HOME/.local/opt/Kea/.install-manifest" ]; then say "Kea is also installed in your home (~/.local/opt/Kea): --uninstall --user removes it."; fi
    fi
    if [ "$ul_found" = 0 ]; then
      say "Kea is not installed here by install.sh or a package: nothing to remove."
      return 0
    fi
    [ "$dry_run" = 1 ] || say "Kea is removed. ~/.kea is where it was."
  }

  # ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  if [ "$system" = Darwin ]; then
    if [ "$uninstall" = 1 ]; then uninstall_mac; else install_mac; fi
    return 0
  fi
  chmod 0755 "$tmp" # apt reads a local package as its own sandbox user (_apt)
  linux_facts
  if [ "$uninstall" = 1 ]; then
    uninstall_linux
    return 0
  fi
  linux_checks
  linux_release
  case $family in
    apt | dnf | zypper) needs_sudo ;;
  esac
  case $family in
    apt) install_apt ;;
    dnf | zypper) install_rpm ;;
    *) install_tree ;;
  esac
  linux_after
}

{ kea_install "$@"; }
