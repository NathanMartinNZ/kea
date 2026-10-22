// macOS's side of tools/pack's OS layer (index.ts).
import path from 'node:path'
import type { MacTool, PackOs, PackTool } from './index.ts'

const TOOLS: Readonly<Record<MacTool, string>> = {
  codesign: '/usr/bin/codesign',
  ditto: '/usr/bin/ditto',
  lsregister: '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister',
  plutil: '/usr/bin/plutil',
  lipo: '/usr/bin/lipo',
  lsappinfo: '/usr/bin/lsappinfo',
  open: '/usr/bin/open',
  security: '/usr/bin/security',
  strip: '/usr/bin/strip',
}

/** How to create the self-signed signing certificate once: Keychain Access, or Terminal with the system's OpenSSL. */
const certificateSteps = (identity: string) => `Create it once:
  1. Keychain Access → menu Keychain Access → Certificate Assistant → Create a Certificate…
  2. Name "${identity}", Identity Type "Self-Signed Root", Certificate Type "Code Signing" → Create.
  3. Open the new certificate in the login keychain → Trust → Code Signing: "Always Trust"; close the window to save.
  4. Check: security find-identity -v -p codesigning   must list "${identity}" once.
If Certificate Assistant fails ("The specified item could not be found in the keychain"), create it in Terminal
instead (the system /usr/bin/openssl writes a key bundle Keychain imports; Homebrew's OpenSSL 3 may not):
  mkdir -m 700 ~/kea-cert-tmp && cd ~/kea-cert-tmp
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=${identity}" -addext "basicConstraints=critical,CA:false" -addext "keyUsage=critical,digitalSignature" -addext "extendedKeyUsage=critical,codeSigning" -keyout key.pem -out cert.pem
  /usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -name "${identity}" -out kea.p12 -passout pass:kea
  security import kea.p12 -k ~/Library/Keychains/login.keychain-db -P kea -T /usr/bin/codesign
  security add-trusted-cert -p codeSign -k ~/Library/Keychains/login.keychain-db cert.pem
  cd ~ && rm -rf ~/kea-cert-tmp
Or check the pipeline without it (never installable): pnpm kea:install --adhoc`

export const darwin: PackOs = {
  system: 'darwin',
  // Homebrew's rustup is keg-only, so its cargo is often not on PATH
  rust: { cargo: (home) => ['/opt/homebrew/opt/rustup/bin/cargo', path.join(home, '.cargo', 'bin', 'cargo')], installHint: 'brew install rustup && rustup default stable (or rustup.rs)' },
  tools: {
    path: (tool: PackTool) => {
      if (!(tool in TOOLS)) throw new Error(`${tool} is a Linux packaging tool: Linux's packages are built on Linux`)
      return TOOLS[tool as MacTool]
    },
  },
  installPlace: {
    refusal: (arch) => (arch === 'arm64' ? null : 'Kea is built for Apple silicon Macs only'),
    installedApp: (appName) => `/Applications/${appName}`,
    folders: (home) => ['/Applications', '/System/Applications', path.join(home, 'Applications')],
    certificateSteps,
  },
  nativeAddons: {
    sqlitePrebuild: (arch) => `prebuilds/darwin-${arch}.node`,
    watcherPackage: (arch) => `@parcel/watcher-darwin-${arch}`,
    // Kea's patched watcher, built by `pnpm install` as on Linux; core loads it first
    watcherPatchedBuild: path.join('build', 'Release', 'watcher.node'),
  },
  // no desktop file: a notification's click reaches the running app itself; Chromium's sandbox always starts
  devDesktop: { file: () => null, sandboxProblem: () => null },
}
