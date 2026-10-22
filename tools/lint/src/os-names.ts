// U-PLT-1 · OS-specific code only in `os/` folders. Outside them, and outside their tests, nothing may read which
// system it runs on, name a system tool or folder by its absolute path, call an Electron API that exists on one system
// only, or (Rust) use `cfg(target_os` or a libc symbol one system lacks.
// `tools/` and `tests/` are under the same rule. A line can be let through with `// os-ok: <reason>` on it (or alone
// on the line above it); the summary counts those lines.
//
// Comments are not scanned (they document). String literals are: a path is a string.
import { type Lexed, lexJs, lexRust, lexSvelte, lineIndex } from './lexer.ts'
import type { Violation } from './types.ts'

/** Reading which system this is (JS/TS), in Node and in the renderer. `import { platform } from 'node:os'` is caught at the import. */
const SYSTEM_READS: [RegExp, string][] = [
  [/\bprocess\s*\.\s*platform\b/g, 'process.platform'],
  [/\bos\s*\.\s*platform\s*\(/g, 'os.platform()'],
  [/\bos\s*\.\s*type\s*\(/g, 'os.type()'],
  [/\bnavigator\s*\.\s*(?:platform|userAgentData)\b/g, 'navigator.platform'],
]
const OS_IMPORT_RE = /\bimport\s*\{([^}]*)\}\s*from\s*['"](?:node:)?os['"]/g

/** Absolute paths of system tools and folders. `/bin/sh`, `/usr/bin/env` and `/dev/null` are allowed: every system has them there. */
export const SYSTEM_PATHS = ['/usr/bin/', '/usr/sbin/', '/sbin/', '/System/', '/Applications', 'Library/', '/proc/', '/sys/', '/etc/']
const ALLOWED_UNDER: Readonly<Record<string, string>> = { '/usr/bin/': 'env' }
// a path starts after anything but a word, a dot or a dash, or right after a one-letter string escape (`\t`, `\n`)
const PATH_RES: [RegExp, string][] = SYSTEM_PATHS.map((p) => {
  const allowed = ALLOWED_UNDER[p] ? `(?!${ALLOWED_UNDER[p]}(?![\\w.-]))` : ''
  return [new RegExp(`(?:(?<![\\w.-])|(?<=\\\\[a-z]))${p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}${allowed}`, 'g'), p]
})

/** Electron menu roles that exist on macOS only (Electron's MenuItem docs). */
export const MAC_MENU_ROLES = [
  'appMenu', 'hide', 'hideOthers', 'unhide', 'showSubstitutions', 'toggleSmartQuotes', 'toggleSmartDashes', 'toggleTextReplacement',
  'startSpeaking', 'stopSpeaking', 'front', 'zoom', 'toggleTabBar', 'selectNextTab', 'selectPreviousTab', 'showAllTabs',
  'mergeAllWindows', 'clearRecentDocuments', 'moveTabToNewWindow', 'window', 'help', 'services', 'recentDocuments', 'shareMenu',
]

/** Electron APIs one system only has (Electron's docs mark them macOS); checked in files that import `electron`. */
const ELECTRON_APIS: [RegExp, string][] = [
  [/\bapp\s*\.\s*dock\b/g, 'app.dock'],
  [/\bapp\s*\.\s*(?:hide|show|isHidden|isActive|setActivationPolicy)\s*\(/g, 'app.hide() and the like'],
  [/['"]did-become-active['"]/g, "'did-become-active'"],
  [/\bsystemPreferences\b/g, 'systemPreferences'],
  [/\b\w*[tT]ray\w*\s*\??\.\s*(?:setTitle|getTitle)\s*\(/g, 'Tray.setTitle'],
  [/\btrafficLightPosition\b/g, 'trafficLightPosition'],
  [/\btitleBarStyle\b/g, 'titleBarStyle'],
  [/\b(?:vibrancy|visualEffectState|setWindowButtonVisibility)\b/g, 'vibrancy and the like'],
  [new RegExp(`\\brole\\s*:\\s*['"](?:${MAC_MENU_ROLES.join('|')})['"]`, 'g'), 'a macOS-only menu role'],
  [/\bsubtitle\s*:/g, 'Notification subtitle'],
]
const ELECTRON_IMPORT_RE = /\bfrom\s*['"]electron['"]|\brequire\(\s*['"]electron['"]\s*\)/

/** libc (and framework) symbols one system lacks; whole identifiers, or prefixes where they end in `*`. Rust only. */
export const PLATFORM_SYMBOLS = [
  // macOS: libproc, the BSD socket and spawn extensions, its clocks and its random source
  'proc_pidinfo', 'proc_pidfdinfo', 'proc_pid_rusage', 'proc_listchildpids', 'proc_listallpids', 'proc_name', 'proc_bsdinfo',
  'proc_vnodepathinfo', 'proc_fdinfo', 'rusage_info_v0', 'vinfo_stat', 'vnode_info', 'PROC_PID*', 'PROX_FDTYPE_*', 'RUSAGE_INFO_*',
  '__error', '_NSGetEnviron', 'SO_NOSIGPIPE', 'LOCAL_PEER*', 'SOL_LOCAL', 'getpeereid', 'sun_len', 'clock_gettime_nsec_np',
  'CLOCK_UPTIME_RAW', 'arc4random*', 'posix_spawn_file_actions_addinherit_np', 'POSIX_SPAWN_CLOEXEC_DEFAULT', 'responsibility_*',
  'SecCode*', 'SecRequirement*', 'kSecGuest*',
  // Linux
  'SO_PEERCRED', 'SO_PEERPIDFD', '__errno_location', 'MSG_NOSIGNAL', 'PR_SET_DUMPABLE', 'pidfd_open', 'pidfd_getfd',
]
const SYMBOL_RES: [RegExp, string][] = PLATFORM_SYMBOLS.map((s) => {
  const stem = s.endsWith('*') ? s.slice(0, -1) : s
  return [new RegExp(`(?<![\\w])${stem}${s.endsWith('*') ? '\\w*' : '(?![\\w])'}`, 'g'), s]
})
/** Rust's reads of the system: any `target_os` predicate (`cfg`, `cfg!`, `cfg_attr`) and `std::env::consts::OS`. */
const RUST_SYSTEM_READS: [RegExp, string][] = [
  [/\btarget_os\b/g, 'cfg(target_os'],
  [/\bconsts\s*::\s*OS\b/g, 'env::consts::OS'],
]

const OS_OK_RE = /(?:\/\/|\/\*|<!--)\s*os-ok:\s*\S/
const OS_OK_ALONE_RE = /^\s*(?:\/\/|\/\*|<!--)\s*os-ok:\s*\S/

/**
 * Is this path checked by the os rule? Code anywhere in the repository except inside `os/` folders, fixtures and the
 * rule's own folder.
 */
export function isOsScanned(path: string): boolean {
  if (!/\.(?:[cm]?[jt]sx?|svelte|rs)$/.test(path) || path.endsWith('.d.ts')) return false
  if (/(?:^|\/)(?:node_modules|dist|out|target|test-results|generated|fixtures)\//.test(path)) return false
  if (/(?:^|\/)os\//.test(path)) return false // the OS layer and its tests
  if (path.startsWith('tools/lint/')) return false // this rule's own lists and test inputs
  if (path.startsWith('.plan/')) return false
  return true
}

export type OsResult = { violations: Violation[]; allowed: number }

export function checkOsNames(path: string, src: string): OsResult {
  const isRust = path.endsWith('.rs')
  const lexed: Lexed = isRust ? lexRust(src) : path.endsWith('.svelte') ? { code: lexSvelte(src).code, strings: [] } : lexJs(src)
  const text = lexed.code
  const lines = src.split('\n')
  const lineOf = lineIndex(text)
  const found = new Map<number, Set<string>>()
  const hit = (offset: number, what: string) => {
    const line = lineOf(offset)
    const set = found.get(line) ?? new Set<string>()
    set.add(what)
    found.set(line, set)
  }
  const scan = (res: [RegExp, string][]) => {
    for (const [re, what] of res) for (const m of text.matchAll(re)) hit(m.index, what)
  }

  scan(PATH_RES)
  if (isRust) {
    scan(RUST_SYSTEM_READS)
    // symbols are names in code: a message that mentions one is not a use, a C string handed to `dlsym` is
    let symbolText = text
    for (const st of lexed.strings) {
      if (text[st.start - 2] === 'c' && text[st.start - 1] === '"') continue
      symbolText = symbolText.slice(0, st.start) + ' '.repeat(st.end - st.start) + symbolText.slice(st.end)
    }
    for (const [re, what] of SYMBOL_RES) for (const m of symbolText.matchAll(re)) hit(m.index, what)
  } else {
    scan(SYSTEM_READS)
    for (const m of text.matchAll(OS_IMPORT_RE)) {
      const names = m[1]!.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]!.trim())
      for (const n of names) if (n === 'platform' || n === 'type') hit(m.index, `${n}() from node:os`)
    }
    if (ELECTRON_IMPORT_RE.test(text)) scan(ELECTRON_APIS)
  }

  const violations: Violation[] = []
  let allowed = 0
  for (const [line, set] of [...found.entries()].sort((a, b) => a[0] - b[0])) {
    if (OS_OK_RE.test(lines[line - 1] ?? '') || OS_OK_ALONE_RE.test(lines[line - 2] ?? '')) {
      allowed++
      continue
    }
    violations.push({
      file: path,
      line,
      rule: 'os',
      message: `OS-specific ${[...set].map((s) => `"${s}"`).join(', ')} outside an os/ folder (move it there, or mark the line \`// os-ok: <reason>\`)`,
    })
  }
  return { violations, allowed }
}
