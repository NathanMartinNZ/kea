// What a build to publish must be: one version everywhere, Kea's repository named, the key the Linux packages carry
// present, a real signature. Pure but for `versionProblems`, which reads the version files.
import fs from 'node:fs'
import path from 'node:path'

/** Semver, and release candidates `-rc.<n>`. */
export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$/

/** The helper's version as its Cargo.toml says it (its `[package]` table's `version`). */
export function cargoVersion(toml: string): string | null {
  const table = /^\[package\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? ''
  return /^version\s*=\s*"([^"]+)"\s*$/m.exec(table)?.[1] ?? null
}

/** Package.json's version, which the app and every package take, is semver as above, and the helper's is the same. */
export function versionProblems(root: string): string[] {
  const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version
  const problems: string[] = []
  if (!VERSION_RE.test(version)) problems.push(`package.json's version "${version}" is not <major>.<minor>.<patch>, or that with -rc.<n>`)
  const helper = cargoVersion(fs.readFileSync(path.join(root, 'native/kea-helper/Cargo.toml'), 'utf8'))
  if (helper !== version) problems.push(`native/kea-helper/Cargo.toml's version is ${helper ?? 'missing'}, not package.json's ${version}`)
  return problems
}

/** The package step's `install.sh`: built, left out with a note, or a release refused for want of it. */
export type InstallScriptStep = { kind: 'build' } | { kind: 'skip'; note: string } | { kind: 'refuse'; reason: string }

/**
 * What the package step does about `install.sh`: it pins the repository's key, so it needs the repository and the key.
 * Until the key exists a macOS release goes without it (its zip is installed by hand), as `releaseProblems` allows; a
 * Linux release cannot, since its packages install the key for apt.
 */
export function installScriptStep(o: { system: 'darwin' | 'linux'; release: boolean; repository: string | null; key: boolean }): InstallScriptStep {
  if (o.repository !== null && o.key) return { kind: 'build' }
  if (o.release && o.system === 'linux') return { kind: 'refuse', reason: "install.sh needs the repository's key (assets/release/kea-app.gpg): it pins its fingerprint" }
  if (o.release) return { kind: 'skip', note: "not built: there is no repository key yet (assets/release/kea-app.gpg), so this release is the zip alone, installed by hand; publish no install.sh or SHA256SUMS with it" }
  return { kind: 'skip', note: 'not built: it needs the repository and its key (assets/release/kea-app.gpg); tests build one with --test-repository and --test-key' }
}

/** `--release`: what stops a build from being published. */
export function releaseProblems(o: { repository: string | null; key: boolean; adhoc: boolean; version: string }): string[] {
  const problems: string[] = []
  if (o.repository === null) problems.push("Kea's repository is not named yet (RELEASE_REPOSITORY in packages/protocol/src/release.ts): a release names it in its feed and its packages")
  if (!o.key) problems.push("the repository's signing key is missing (assets/release/kea-app.gpg): the packages install it for apt")
  if (o.adhoc) problems.push('an ad hoc signature is never published: releases are signed with the shared "Kea Local Code Signing" certificate')
  if (!VERSION_RE.test(o.version)) problems.push(`"${o.version}" is not a release version (<major>.<minor>.<patch>, or that with -rc.<n>)`)
  return problems
}

/**
 * The leaf of "Kea Local Code Signing", the one certificate every macOS build is signed with (its SHA-1, as a
 * designated requirement writes it). Public: every signed file carries the certificate. install.sh checks the app it
 * downloads against it, and a release's app must name it in its designated requirement. If the certificate is
 * ever replaced (R43), this changes with the release that switches.
 */
export const CERTIFICATE_LEAF = 'a2a3615d4399591d66f30acfb0c5562b0552e87c'

/** The designated requirement every release of Kea.app has: the identifier and the shared leaf. */
export function releaseRequirement(appId: string, leaf: string = CERTIFICATE_LEAF): string {
  return `identifier "${appId}" and certificate leaf = H"${leaf}"`
}
