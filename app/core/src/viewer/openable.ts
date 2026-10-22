// "Open with default app": which files may be handed to `open`. Opening must never run what a repository holds, and the
// system decides what "open" means by the file's type: for the types below it means run it, follow it somewhere else,
// install it or mount it. A file of such a type is never given to `open`; the viewer offers Reveal in the file manager
// alone for it, where the person can still open it by hand.
//
// A file with the execute bit is refused before this is asked (service.ts, read.ts): opening one can run it (macOS
// hands it to Terminal). This list is for what needs no such bit. It is a deny-list, so it names what is known: the
// types macOS itself runs, follows, installs or mounts, and the common ones a widely installed app does that for. Each
// system adds its own (the OS layer's `editors`: on Linux what a desktop runs, installs or adds when it is opened),
// and names its file manager in what the viewer says ("Reveal in Finder", "Reveal in File Manager").

import path from 'node:path'
import { isAvailable } from '@kea/protocol'
import { coreOs } from '../os/index.ts'

/** By what opening does; lower case, without the dot. */
const BY_KIND: Readonly<Record<string, readonly string[]>> = {
  // Terminal runs it, or reads a command to run from it
  terminal: ['command', 'tool', 'terminal', 'term'],
  // a script or program a launcher runs when one is installed for it (Python Launcher, Java, a terminal app that takes scripts)
  launched: ['sh', 'bash', 'zsh', 'csh', 'tcsh', 'ksh', 'fish', 'py', 'pyw', 'pyc', 'pyo', 'pl', 'rb', 'jar', 'jnlp'],
  // scripts and automation: Script Editor, Automator, Shortcuts, scripting additions
  automation: ['scpt', 'scptd', 'applescript', 'jxa', 'osax', 'workflow', 'action', 'caction', 'wflow', 'shortcut', 'service'],
  // a program
  program: ['app', 'appex', 'xpc', 'ipa'],
  // a location: the system opens whatever it names (another file, an app, a server, a URL scheme's handler)
  location: ['webloc', 'inetloc', 'fileloc', 'afploc', 'ftploc', 'mailloc', 'nfsloc', 'vncloc', 'atloc', 'url'],
  // installers and disk images (mounted at once)
  install: ['pkg', 'mpkg', 'dist', 'xip', 'dmg', 'sparseimage', 'sparsebundle', 'iso', 'cdr', 'toast', 'img', 'smi', 'udif'],
  // what is installed into the system or an app: profiles, certificates and identities, add-ons
  system: ['mobileconfig', 'configprofile', 'mobileprovision', 'provisionprofile', 'cer', 'crt', 'der', 'p12', 'pfx', 'p7b', 'p7c', 'prefpane', 'saver', 'qlgenerator', 'mdimporter', 'kext', 'dext', 'plugin', 'bundle', 'component', 'colorpicker', 'framework', 'wdgt', 'safariextz', 'safariextension'],
  // a page: the browser runs its scripts, from a `file:` address
  page: ['html', 'htm', 'xhtml', 'xht', 'shtml', 'mht', 'mhtml', 'webarchive', 'svg', 'svgz'],
  // a Windows program or script: run by whatever was installed to run those (a virtual machine, Wine)
  windows: ['exe', 'msi', 'bat', 'cmd', 'scr', 'ps1', 'vbs', 'lnk'],
}

const editors = coreOs.editors

/** Every extension never handed to `open` on this system. */
export const NEVER_OPENED: ReadonlySet<string> = new Set([...Object.values(BY_KIND).flat(), ...(isAvailable(editors) ? editors.neverOpened : [])])

/** The file manager as this system's titles name it ("File Manager" on Linux). */
export const FILE_MANAGER = isAvailable(editors) ? editors.fileManager : 'Finder'

/** What the system reads a name's type from: what follows its last dot, lower case; `''` when it has none. */
export function typeOf(file: string): string {
  const name = path.basename(file)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** Whether a file with this name (or path) may be handed to `open`, as far as its type goes. */
export function opensSafely(file: string): boolean {
  return !NEVER_OPENED.has(typeOf(file))
}

/** What the viewer says for a file of such a type. */
export const NOT_OPENED_BY_TYPE = `A file of this type can run or install something when it is opened. Use Reveal in ${FILE_MANAGER} instead.`
