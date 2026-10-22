// The switches of `pnpm kea:install` (the header of tools/install.ts lists them) and the rule they keep: nothing but
// the plain command, with no switch that changes the build, ever installs for use. The switches that change the build
// are `--adhoc` (another signature), `--perf-probes` (other code) and `--version-suffix` (another version): a build
// made with any of them is never put in /Applications. A test's own folder (`--install-to`) is the only other place a
// build goes, and an ad-hoc build goes nowhere.

import os from 'node:os'
import path from 'node:path'
import { applicationsFolderOf, resolveTarget, type InstallTarget } from './target.ts'

export interface InstallOptions {
  /** Where to install; null: build only. */
  target: InstallTarget | null
  noRelaunch: boolean
  adhoc: boolean
  perfProbes: boolean
  /** Where Kea.app is built. */
  out: string
  versionSuffix: string
}

const VALUE_SWITCHES = ['--out', '--version-suffix', '--install-to'] as const

/** Parse the command line. Throws with a sentence for the person who typed it. */
export function parseOptions(argv: readonly string[], env: { root: string; homedir?: string }): InstallOptions {
  const homedir = env.homedir ?? os.homedir()
  let noInstall = false
  let installTo: string | null = null
  const o: InstallOptions = { target: null, noRelaunch: false, adhoc: false, perfProbes: false, out: path.join(env.root, 'dist', 'pack'), versionSuffix: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--no-install') noInstall = true
    else if (a === '--no-relaunch') o.noRelaunch = true
    else if (a === '--adhoc') o.adhoc = true
    else if (a === '--perf-probes') o.perfProbes = true
    else if ((VALUE_SWITCHES as readonly string[]).includes(a)) {
      const v = argv[++i]
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`)
      if (a === '--out') o.out = path.resolve(v)
      else if (a === '--install-to') installTo = v
      else if (/^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(v)) o.versionSuffix = v
      else throw new Error(`--version-suffix must be letters, digits, dots and dashes (a semver pre-release), got "${v}"`)
    } else throw new Error(`unknown option ${a} (see the header of tools/install.ts)`)
  }
  // by what the folder is, not by its name: the build step deletes and rewrites `<out>/Kea.app` with no look at what runs from it
  if (applicationsFolderOf(o.out, homedir)) throw new Error(`--out must not be in an Applications folder (got ${o.out}); installing is the default step`)
  if (installTo !== null) {
    if (noInstall) throw new Error('--install-to and --no-install contradict each other')
    // an ad-hoc signature is a new identity with every build: the next build's Kea is refused by this one's holders
    if (o.adhoc) throw new Error('an --adhoc build is never installed, not even into a test target')
    o.target = resolveTarget(installTo, homedir)
  } else if (!noInstall && !o.adhoc && !o.perfProbes && !o.versionSuffix) o.target = resolveTarget(null, homedir)
  return o
}
