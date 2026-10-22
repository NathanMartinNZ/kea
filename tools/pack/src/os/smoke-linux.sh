#!/bin/sh
# The package smoke test (E-DST-1): one Linux package in a clean container, run as the container's root:
#   sh smoke-linux.sh <package file>
# Installs the package with the system's own tool (its dependencies from the system's archive), checks the files it
# put in place, starts Kea as a new user under an Xvfb of its own with a temporary KEA_HOME, reads the platform report
# from main's log, quits Kea completely and starts it again, then removes the package and checks what is left: the
# user's KEA_HOME and Chromium's userData under ~/.config only (the desktop libraries' own stores are reported). Opens
# no terminal: a packaged Kea has no test hooks, so that part of the test waits for a driver of the packaged window.
# Prints one line per step; exits non-zero at the first that fails. Run it for each supported Linux system before a
# release; tools/package.ts never does.
set -eu

pkg=$1
user=kuser
display=:93
say() { printf '%s\n' "$*"; }
fail() { say "FAIL $*"; exit 1; }
ok() { say "ok   $*"; }

# ── install ────────────────────────────────────────────────────────────────────────────────
if command -v apt-get >/dev/null 2>&1; then
  family=deb
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq >/dev/null
  # AppArmor's tools first, so the package's script finds them as on a desktop (the kernel side is the host's)
  apt-get install -y -qq apparmor >/tmp/apparmor.log 2>&1 || { tail -20 /tmp/apparmor.log; fail 'apt-get install apparmor'; }
  apt-get install -y -qq "$pkg" xvfb xauth procps passwd >/tmp/install.log 2>&1 || { tail -20 /tmp/install.log; fail "apt-get install $pkg"; }
elif command -v dnf >/dev/null 2>&1; then
  family=rpm
  dnf install -y -q "$pkg" xorg-x11-server-Xvfb procps-ng shadow-utils util-linux >/tmp/install.log 2>&1 || { tail -20 /tmp/install.log; fail "dnf install $pkg"; }
else
  fail 'no apt-get or dnf here'
fi
ok "installed $(basename "$pkg") with its dependencies ($family)"

mode() { stat -c '%a %U:%G' "$1"; }
[ "$(mode /usr/bin/kea-app)" = '755 root:root' ] || fail "/usr/bin/kea-app: $(mode /usr/bin/kea-app)"
[ "$(mode /opt/Kea/kea-app)" = '755 root:root' ] || fail "/opt/Kea/kea-app: $(mode /opt/Kea/kea-app)"
[ "$(mode /opt/Kea/chrome-sandbox)" = '4755 root:root' ] || fail "/opt/Kea/chrome-sandbox: $(mode /opt/Kea/chrome-sandbox)"
for f in /usr/share/applications/dev.kea.app.desktop /usr/share/icons/hicolor/256x256/apps/dev.kea.app.png /usr/share/doc/kea-app/copyright /opt/Kea/resources/apparmor-profile /opt/Kea/resources/licenses.txt /opt/Kea/resources/kea-helper; do
  [ -f "$f" ] && continue
  # a system installing without documentation (Fedora's container images: tsflags=nodocs) leaves out what rpm counts
  # as documentation; the package still holds it, and the licences are in /opt/Kea/resources as well
  if [ "$family" = rpm ] && rpm -q --qf '[%{FILESTATES:fstate} %{FILENAMES}\n]' kea-app | grep -qx "not installed $f"; then
    say "note $f is in the package; this system installs without documentation"
    continue
  fi
  fail "$f is missing"
done
grep -q '^Exec=/usr/bin/kea-app %U$' /usr/share/applications/dev.kea.app.desktop || fail 'the desktop file does not start the launcher'
grep -q '^StartupWMClass=dev.kea.app$' /usr/share/applications/dev.kea.app.desktop || fail "the desktop file's StartupWMClass"
ok 'files in place: launcher, app, chrome-sandbox 4755 root, desktop file, icons, licences, profile'
for f in Regular Bold; do [ "$(mode /usr/share/fonts/kea-app/JetBrainsMono-$f.ttf)" = '644 root:root' ] || fail "the terminal font's $f style"; done
if command -v fc-match >/dev/null 2>&1; then
  case $(fc-match -f '%{file}' 'JetBrains Mono') in
    /usr/share/fonts/kea-app/*) ok "fontconfig gives JetBrains Mono from the package" ;;
    *) fail "fontconfig does not find the package's JetBrains Mono: $(fc-match 'JetBrains Mono')" ;;
  esac
fi
if command -v apparmor_parser >/dev/null 2>&1; then
  if [ -f /etc/apparmor.d/abi/4.0 ]; then
    [ -f /etc/apparmor.d/kea-app ] || { cat /tmp/install.log | tail -5; fail "this AppArmor reads abi 4.0 but /etc/apparmor.d/kea-app was not installed"; }
    apparmor_parser -Q -K /etc/apparmor.d/kea-app || fail "/etc/apparmor.d/kea-app does not parse"
    ok 'AppArmor profile installed by the package and parses'
  else
    [ -f /etc/apparmor.d/kea-app ] && fail "this AppArmor cannot read abi 4.0, yet the profile was installed"
    ok 'AppArmor here cannot read abi 4.0: the profile was rightly left out'
  fi
fi
if command -v git >/dev/null 2>&1; then ok "git $(git --version | cut -d' ' -f3) came with it (Recommends)"; else say "note git is not installed"; fi

# ── run Kea as a new user, twice ───────────────────────────────────────────────────────────
useradd -m -s /bin/sh "$user"
home=$(getent passwd "$user" | cut -d: -f6)
before=$(cd "$home" && find . -mindepth 1 | sort)
kh=$(runuser -u "$user" -- mktemp -d /tmp/kea-home.XXXXXX)/home
runuser -u "$user" -- sh -c "Xvfb $display -nolisten tcp -screen 0 1440x900x24 >/tmp/xvfb.log 2>&1 &"
i=0
until [ -e "/tmp/.X11-unix/X${display#:}" ]; do i=$((i + 1)); [ $i -lt 100 ] || fail 'Xvfb did not start'; sleep 0.1; done

start_kea() { # $1: the run's number. Started once main logged its run's start and then a platform report.
  runuser -u "$user" -- env -i HOME="$home" USER="$user" PATH=/usr/local/bin:/usr/bin:/bin DISPLAY="$display" sh -c "cd && exec /usr/bin/kea-app --kea-home=$kh --ozone-platform=x11 >/tmp/kea-$1.out 2>&1 &"
  i=0
  until runs_logged "$1" && awk '/"msg":"starting"/ { r = 0 } /"msg":"platform report"/ { r = 1 } END { exit !r }' "$kh/logs/main.log"; do
    i=$((i + 1))
    if [ $i -ge 600 ]; then cat "/tmp/kea-$1.out"; tail -5 "$kh/logs/main.log" 2>/dev/null; fail "run $1: no platform report in 60 s"; fi
    sleep 0.1
  done
}
runs_logged() { n=$(grep -c '"msg":"starting"' "$kh/logs/main.log" 2>/dev/null) || true; [ "${n:-0}" -ge "$1" ]; }
main_pid() { pgrep -u "$user" -f "^/opt/Kea/kea-app --kea-home=$kh" | head -1; }
quit_kea() { # $1: the run's number. A complete quit: SIGTERM to main, which Electron turns into app.quit()
  pid=$(main_pid)
  if [ -z "$pid" ]; then
    pgrep -u "$user" -a . | head -20
    tail -20 "/tmp/kea-$1.out"
    tail -8 "$kh/logs/main.log"
    fail "run $1: Kea main is not running"
  fi
  kill -TERM "$pid"
  i=0
  while pgrep -u "$user" -f "/opt/Kea/kea-app" | grep -q . && [ $i -lt 300 ]; do i=$((i + 1)); sleep 0.1; done
  pgrep -u "$user" -f "/opt/Kea/kea-app" >/dev/null && fail "Kea did not quit in 30 s ($(pgrep -u "$user" -a -f /opt/Kea/kea-app | head -3))"
  return 0
}

start_kea 1
report=$(grep '"msg":"platform report"' "$kh/logs/main.log" | tail -1)
ok "Kea started (run 1); platform report: $(printf '%s' "$report" | sed 's/.*"why"/"why"/' | cut -c1-200)"
grep -q '"level":"error"' "$kh/logs/main.log" && { grep '"level":"error"' "$kh/logs/main.log" | head -5; fail 'main logged an error'; }
quit_kea 1
ok 'Kea quit completely'
start_kea 2
ok 'Kea started again (run 2)'
quit_kea 2
pkill -u "$user" Xvfb || true

# ── remove the package; only the user's data is left ──────────────────────────────────────
if [ "$family" = deb ]; then apt-get remove -y -qq kea-app >/tmp/remove.log 2>&1 || fail 'apt-get remove'; else dnf remove -y -q kea-app >/tmp/remove.log 2>&1 || fail 'dnf remove'; fi
for f in /opt/Kea /usr/bin/kea-app /usr/share/fonts/kea-app /usr/share/applications/dev.kea.app.desktop /usr/share/icons/hicolor/256x256/apps/dev.kea.app.png /etc/apparmor.d/kea-app /usr/share/doc/kea-app $(ls -d /var/cache/apparmor/*/kea-app 2>/dev/null); do
  [ -e "$f" ] && fail "$f is still there after removal"
done
# what any app of the desktop leaves: its libraries' own stores, shared by every app that uses them, never Kea's to
# remove: whatever is in ~/.cache (fontconfig's, dconf's, Mesa's shader cache, glycin's loaders; a cache named after Kea
# fails), NSS's certificate database, IBus's bus address
after=$(cd "$home" && find . -mindepth 1 | sort)
added=$(printf '%s\n' "$after" | grep -vxF "$before" || true)
SHARED='^\./\.(cache|local|local/share)$|^\./\.(cache|local/share/pki|config/ibus)(/|$)'
kea_cache=$(printf '%s\n' "$added" | grep -E '^\./\.cache/' | grep -i kea || true)
[ -z "$kea_cache" ] || fail "a cache named after Kea is left: $(printf '%s' "$kea_cache" | head -3 | tr '\n' ' ')"
shared=$(printf '%s\n' "$added" | grep -oE '^\./\.(cache/[^/]+|local/share/pki|config/ibus)' | sort -u | tr '\n' ' ' || true)
new=$(printf '%s\n' "$added" | grep -v '^\./\.config$' | grep -v '^\./\.config/Kea' | grep -Ev "$SHARED" || true)
[ -z "$new" ] || fail "left in the user's home besides ~/.config/Kea…: $(printf '%s' "$new" | head -10 | tr '\n' ' ')"
ok "removed: no file of the package left; the user's home holds only $(cd "$home" && ls -d .config/Kea* | tr '\n' ' ')and KEA_HOME ($kh); the desktop libraries' stores: ${shared:-none}"
say PASS
