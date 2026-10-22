#!/bin/sh
# /usr/bin/kea-app, Linux's launcher, installed by the .deb, the .rpm and install.sh.
# Chromium's sandbox needs user namespaces Kea may make, or the set-uid chrome-sandbox helper; when it cannot start,
# Chromium ends before any of Kea's code runs. So this checks first, and prints the fix instead of that crash. Kea
# never runs with --no-sandbox. KEA_DIR names another install (a tarball unpacked elsewhere); /opt/Kea by default.
set -eu

dir=${KEA_DIR:-/opt/Kea}
app="$dir/kea-app"
helper="$dir/chrome-sandbox"

# user namespaces for every program (no AppArmor restriction, Debian's switch not off)
restricted=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)
clone=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)
if [ "$restricted" != 1 ] && [ "$clone" != 0 ] && unshare --user true 2>/dev/null; then
  exec "$app" "$@"
fi
# Ubuntu 23.10 and later: Kea's own AppArmor profile, which grants it user namespaces, is loaded
if [ "$restricted" = 1 ] && grep -q '^kea-app ' /sys/kernel/security/apparmor/profiles 2>/dev/null; then
  exec "$app" "$@"
fi
# the set-uid helper, owned by root with mode 4755
if [ "$(stat -c '%u %a' "$helper" 2>/dev/null || true)" = "0 4755" ]; then
  exec "$app" "$@"
fi

cat >&2 <<EOF
Kea cannot start: its window needs Chromium's sandbox, and neither of the sandbox's two ways works here.
  - User namespaces: this system allows them only to programs an AppArmor profile names, and Kea's profile
    (/etc/apparmor.d/kea-app) is not loaded. Load it with:
      sudo apparmor_parser -r /etc/apparmor.d/kea-app
  - The set-uid helper $helper is not owned by root with mode 4755. Fix it with:
      sudo chown root:root $helper && sudo chmod 4755 $helper
Reinstalling Kea's package does both. Kea never runs with --no-sandbox.
EOF
exit 1
