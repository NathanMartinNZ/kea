# Installing Kea on Linux by hand

The [install command](../README.md#install) does all of this for you, and `--dry-run` prints exactly what it would
run on your system. Use this page to install a downloaded package, to set up Kea's repository yourself, or to unpack
the tarball on a system without apt, dnf or zypper.

Kea needs x64 or arm64 and glibc 2.35 or later. Every file below is on the
[latest release](https://github.com/NathanMartinNZ/kea/releases/latest) page.

## A downloaded package

Download `kea-app_<version>_amd64.deb` (or `_arm64.deb`) or `kea-app-<version>-1.x86_64.rpm` (or `.aarch64.rpm`),
then open it with your software centre, or:

```sh
# Debian, Ubuntu
sudo apt install ./kea-app_<version>_amd64.deb
# Fedora
sudo dnf install ./kea-app-<version>-1.x86_64.rpm
```

The `.deb` adds Kea's apt repository and the `.rpm` adds Kea's dnf repository, so later versions arrive with your
system's updates. On openSUSE, add the zypper repository below.

## Kea's repository

First download Kea's signing key and check that its fingerprint is `<fingerprint>`:

```sh
curl -fsSLO https://github.com/NathanMartinNZ/kea/releases/latest/download/kea-app.asc
gpg --show-keys kea-app.asc
```

Then, in the same folder, run the block for your system.

### Debian and Ubuntu

```sh
gpg --dearmor <kea-app.asc >kea-app.gpg
cat >kea-app.sources <<'EOF'
Types: deb
URIs: https://github.com/NathanMartinNZ/kea/releases/latest/download/
Suites: ./
Signed-By: /usr/share/keyrings/kea-app.gpg
EOF
sudo install -D -m 0644 kea-app.gpg /usr/share/keyrings/kea-app.gpg
sudo install -m 0644 kea-app.sources /etc/apt/sources.list.d/kea-app.sources
sudo apt-get update
sudo apt-get install -y kea-app
```

### Fedora

```sh
cat >kea-app.repo <<'EOF'
[kea-app]
name=Kea
baseurl=https://nathanmartinnz.github.io/kea/rpm/$basearch
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://github.com/NathanMartinNZ/kea/releases/latest/download/kea-app.asc
EOF
sudo rpm --import kea-app.asc
sudo install -m 0644 kea-app.repo /etc/yum.repos.d/kea-app.repo
sudo dnf install -y kea-app
```

### openSUSE

```sh
cat >kea-app.repo <<'EOF'
[kea-app]
name=Kea
enabled=1
autorefresh=1
baseurl=https://nathanmartinnz.github.io/kea/rpm/$basearch
type=rpm-md
gpgcheck=1
repo_gpgcheck=1
pkg_gpgcheck=1
gpgkey=https://github.com/NathanMartinNZ/kea/releases/latest/download/kea-app.asc
EOF
sudo rpm --import kea-app.asc
sudo install -m 0644 kea-app.repo /etc/zypp/repos.d/kea-app.repo
sudo zypper --non-interactive refresh kea-app
sudo zypper --non-interactive install kea-app
```

To remove a package installed either way, run the install command with `--uninstall`
([Uninstall](../README.md#uninstall)): it removes the package, Kea's repository file and Kea's key.
`sudo apt purge kea-app` does the same on Debian and Ubuntu. `sudo dnf remove kea-app` and `sudo zypper remove kea-app`
may leave the repository file and Kea's key in rpm's keyring.

## The tarball

On a system with none of these package managers, download `kea-app-<version>-linux-x64.tar.gz` (or `-arm64`) and
`SHA256SUMS`, then:

```sh
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf kea-app-<version>-linux-x64.tar.gz
cd kea-app-<version>-linux-x64
sudo cp -R opt/Kea /opt/Kea
sudo chown -R root:root /opt/Kea
sudo chmod 4755 /opt/Kea/chrome-sandbox
sudo install -m 0755 usr/bin/kea-app /usr/local/bin/kea-app
sed 's|^Exec=/usr/bin/kea-app |Exec=/usr/local/bin/kea-app |' usr/share/applications/dev.kea.app.desktop >dev.kea.app.desktop
sudo install -D -m 0644 dev.kea.app.desktop /usr/local/share/applications/dev.kea.app.desktop
sudo cp -R usr/share/icons usr/share/fonts usr/share/doc /usr/local/share/
sudo fc-cache /usr/local/share/fonts/kea-app
```

Where AppArmor restricts user namespaces (Ubuntu 23.10 and later), also install Kea's profile:

```sh
sudo install -m 0644 /opt/Kea/resources/apparmor-profile /etc/apparmor.d/kea-app
sudo apparmor_parser --replace /etc/apparmor.d/kea-app
```

`--uninstall` removes only what the install command installed. If you unpacked the tarball by hand, remove those files
yourself. The install command runs the same steps but also records each file in `/opt/Kea/.install-manifest`, so
prefer it where you can.
