// Terminal feature messages:
//  · the control port core ⇄ ptyhost (core owns the meaning, ptyhost owns the bytes)
//  · the per-terminal stream port renderer ⇄ ptyhost (snapshot + chunks one way, input + credit the other)
import { z } from 'zod'
import { L } from './generated/limits.ts'
import { defineApi } from './rpc.ts'
import { zPtyKind, zPtyState } from './enums.ts'

/** A ptyId's characters (L.ptyIdLength of [a-z0-9]), for building patterns such as `<ptyId>.sock`. */
export const PTY_ID_PATTERN = `[a-z0-9]{${L.ptyIdLength}}`
/** A whole ptyId. */
export const PTY_ID_RE = new RegExp(`^${PTY_ID_PATTERN}$`)
export const zPtyId = z.string().regex(PTY_ID_RE)
export const zSessionId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/)

/**
 * The key of a string-keyed record that crosses a process boundary. `__proto__` cannot be an own key of a plain object
 * (parsing would silently drop it), so it is refused instead.
 */
export const zRecordKey = z.string().refine((k) => k !== '__proto__', 'reserved name')

/**
 * The rule for typed text: text typed for the person at a terminal's prompt holds no control character (C0,
 * DEL, C1). A terminal reads each as a key (`\r` and `\n` are Enter, `\t` completes, `\x03` interrupts) or as the start
 * of a control sequence, so a text that holds one could act; it is refused whole, never typed with the character
 * dropped (a path without its control character is another path). Not empty either.
 */
const TYPED_TEXT_RE = /^[^\u0000-\u001f\u007f-\u009f]+$/
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f-\u009f]/

/**
 * Does `text` hold a control character (C0, DEL, C1)? Text sent to a terminal never carries one, and a dropped path
 * never leaves one raw.
 */
export function hasControlCharacter(text: string): boolean {
  return CONTROL_CHARACTER_RE.test(text)
}

/** May `text` be typed at a terminal's prompt as it is? */
export function isTypedText(text: string): boolean {
  return TYPED_TEXT_RE.test(text)
}

/**
 * Text the window may ask core to type (`terminal.sendText`): the rule above, checked before the call reaches
 * core.
 */
export const zTypedText = z.string().regex(TYPED_TEXT_RE)

export const zSpawnSpec = z.object({
  file: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(zRecordKey, z.string()),
  cwd: z.string().startsWith('/'),
})
export type SpawnSpec = z.infer<typeof zSpawnSpec>

export const zPtyInfo = z.object({
  ptyId: zPtyId,
  sessionId: zSessionId,
  kind: zPtyKind,
  /** running: holder connected and child alive · exited: child gone, holder lingering or gone · lost: holder gone without an exit record */
  state: z.enum(['running', 'exited', 'lost']),
  holderPid: z.number().int().nullable(),
  holderStartedAt: z.number().nullable(),
  childPid: z.number().int().nullable(),
  cwd: z.string(),
  argv: z.array(z.string()),
  cols: z.number().int(),
  rows: z.number().int(),
  exitCode: z.number().int().nullable(),
  exitSignal: z.number().int().nullable(),
  detached: z.boolean(),
  title: z.string().nullable(),
  /**
   * In core's `terminals` store only (ptyhost's list never has it): the name of the process in the foreground
   * of a shell tab whose session is on screen, from the holder's `STAT`. Absent or null: not known (not a shell tab, not
   * on screen, not asked yet). It is the process's own name: shown as data, like a title.
   */
  foreground: z.string().nullable().optional(),
})
export type PtyInfo = z.infer<typeof zPtyInfo>

export const zStat = z.object({ childPid: z.number(), fgPid: z.number(), fgName: z.string(), cwd: z.string(), descendants: z.array(z.number()) })

/** Colours and options the mirror needs to answer queries and to size its buffers. */
export const zMirrorConfig = z.object({
  foreground: z.string(),
  background: z.string(),
  cursor: z.string(),
  palette: z.array(z.string()).length(16),
  dark: z.boolean(),
  scrollback: z.number().int().min(0),
  diskBackedScrollback: z.boolean(),
})
export type MirrorConfig = z.infer<typeof zMirrorConfig>

/** Methods ptyhost serves to core. */
export const ptyhostApi = defineApi({
  'pty.spawn': {
    args: z.object({
      ptyId: zPtyId,
      sessionId: zSessionId,
      kind: zPtyKind,
      spec: zSpawnSpec,
      cols: z.number().int().min(1),
      rows: z.number().int().min(1),
      ringBytes: z.number().int(),
      keaVersion: z.string(),
    }),
    result: z.object({ holderPid: z.number(), childPid: z.number(), detached: z.boolean() }),
  },
  'pty.list': { args: z.object({}), result: z.array(zPtyInfo) },
  'pty.terminate': { args: z.object({ ptyId: zPtyId, graceMs: z.number().int().min(0) }), result: z.object({ ok: z.boolean() }) },
  'pty.signal': { args: z.object({ ptyId: zPtyId, signo: z.number().int().min(1).max(31), target: z.enum(['child', 'fg', 'session']) }), result: z.object({ ok: z.boolean() }) },
  'pty.stat': { args: z.object({ ptyId: zPtyId }), result: zStat.nullable() },
  'pty.release': { args: z.object({ ptyId: zPtyId }), result: z.object({ ok: z.boolean() }) },
  /** Ptyhost lets go of the holder without releasing or signalling it; it keeps running (a holder core does not trust). */
  'pty.detach': { args: z.object({ ptyId: zPtyId }), result: z.object({ ok: z.boolean() }) },
  /** Text typed on the user's behalf (only ever after a user gesture, e.g. Continue all). */
  'pty.input': { args: z.object({ ptyId: zPtyId, data: z.string() }), result: z.object({ ok: z.boolean() }) },
  'pty.resize': { args: z.object({ ptyId: zPtyId, cols: z.number().int().min(1), rows: z.number().int().min(1) }), result: z.object({ ok: z.boolean() }) },
  /** The visible terminal(s): rebuilt first, the checkpoint quiet rule watches their keystrokes. */
  'pty.setVisible': { args: z.object({ ptyIds: z.array(zPtyId) }), result: z.object({ ok: z.boolean() }) },
  'pty.configure': { args: zMirrorConfig, result: z.object({ ok: z.boolean() }) },
  /**
   * Current screen as text and the last bytes of output (for report bundles). `screen: false` leaves the screen out
   * (an empty string): only the ring is read, so a parked mirror costs nothing (a dev server's output is read this
   * way). `end`: the output sequence number just past `ring`, so a caller can tell what it has not read yet.
   */
  'pty.capture': {
    args: z.object({ ptyId: zPtyId, ringBytes: z.number().int().min(0), screen: z.boolean().optional() }),
    result: z.object({ screen: z.string(), ring: z.instanceof(Uint8Array), end: z.number().optional() }).nullable(),
  },
  /**
   * Last screen of an exited / lost / parked PTY from its checkpoint + ring, as a snapshot string. `cols × rows` is the
   * grid to replay a ring that has no checkpoint at (the pane's grid).
   */
  'pty.lastScreen': {
    args: z.object({ ptyId: zPtyId, sessionId: zSessionId, cols: z.number().int().min(1), rows: z.number().int().min(1) }),
    result: z.object({ cols: z.number(), rows: z.number(), data: z.string() }).nullable(),
  },
  /**
   * An ended PTY's last screen made its checkpoint, at the ring's latest seq, so the ring can go (an archived
   * session keeps only its checkpoints). `written`: a checkpoint on disk now covers everything the ring holds; false
   * for a live PTY, a corrupt ring (C-COR-3) or checkpoints kept in memory ("Keep scrollback on disk" off).
   */
  'pty.foldCheckpoint': { args: z.object({ ptyId: zPtyId, sessionId: zSessionId }), result: z.object({ written: z.boolean() }) },
  /** Clear terminal and scrollback (⌘K): mirror cleared, a fresh checkpoint written; the ring is untouched. */
  'pty.clear': { args: z.object({ ptyId: zPtyId }), result: z.object({ ok: z.boolean() }) },
  'debug.resources': { args: z.object({}), result: z.record(zRecordKey, z.unknown()) },
})

/** Notifications ptyhost sends to core over the control port. */
export type PtyhostNote =
  | { m: 'pty.exit'; a: { ptyId: string; sessionId: string; code: number | null; signal: number | null; lost: boolean } }
  | { m: 'pty.title'; a: { ptyId: string; title: string } }
  | { m: 'pty.bell'; a: { ptyId: string } }
  | { m: 'pty.oscNotify'; a: { ptyId: string; text: string } }
  | { m: 'pty.activity'; a: { ptyId: string; active: boolean; at: number } }
  | { m: 'pty.keystroke'; a: { ptyId: string; at: number } }
  | { m: 'pty.cwd'; a: { ptyId: string; cwd: string } }
  | { m: 'pty.banner'; a: { kind: 'notDetached' | 'helperMissing' | 'diskFull' | 'sessionMode'; message: string } }
  /** The condition behind a banner is over (a checkpoint was written again after the disk was full). */
  | { m: 'pty.bannerCleared'; a: { kind: 'diskFull' } }

// ── stream port (one per attached terminal) ───────────────────────────────────────────────────────────────

export type StreamToRenderer =
  /** First message, and again after a skip-ahead or gap rebuild: the full state to paint, then live chunks from `seq`. */
  | { k: 'snapshot'; seq: number; cols: number; rows: number; data: string; exited: { code: number | null; signal: number | null } | null; title: string | null }
  | { k: 'data'; seq: number; b: Uint8Array }
  | { k: 'exit'; code: number | null; signal: number | null }
  | { k: 'title'; title: string }
  /** No such PTY in ptyhost, or it was removed; the port is closed after this. */
  | { k: 'gone'; reason: string }

export type StreamToPtyhost =
  | { k: 'in'; d: string }
  | { k: 'inb'; d: Uint8Array }
  /**
   * What the renderer has written into its terminal since its last credit: the byte length of each `data`
   * chunk and the string length of each snapshot, counted once `term.write` has called back.
   */
  | { k: 'credit'; n: number }
  | { k: 'resize'; cols: number; rows: number; xpx: number; ypx: number }
  | { k: 'close' }

export function isStreamToPtyhost(m: unknown): m is StreamToPtyhost {
  if (typeof m !== 'object' || m === null) return false
  const r = m as Record<string, unknown>
  switch (r.k) {
    case 'in':
      return typeof r.d === 'string'
    case 'inb':
      return r.d instanceof Uint8Array
    case 'credit':
      return typeof r.n === 'number' && r.n >= 0 && Number.isFinite(r.n)
    case 'resize':
      return [r.cols, r.rows, r.xpx, r.ypx].every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65535)
    case 'close':
      return true
  }
  return false
}

/** A holder as Settings › Advanced lists it: what its socket and its state file say, and what Kea makes of it. */
export const zHolderRow = z.object({
  ptyId: zPtyId,
  /** From its state file; null when the file is missing or not trusted. */
  sessionId: z.string().nullable(),
  kind: zPtyKind.nullable(),
  /** The holder process, and the program it holds. */
  pid: z.number().int().nullable(),
  childPid: z.number().int().nullable(),
  /** Holder process start, ms since the epoch (its uptime counts from here). */
  startedAt: z.number().nullable(),
  /** Its process runs (pid, start time and executable agree); null: `ps` could not tell, or no trusted state file. */
  alive: z.boolean().nullable(),
  /** Its program has exited (the holder lingers until it is released). */
  exited: z.boolean(),
  /** No running record of its session accounts for it (an orphan). */
  orphan: z.boolean(),
})
export type HolderRow = z.infer<typeof zHolderRow>

// ── renderer ⇄ core (terminals of the window) ─────────────────────────────────────────────────────────────────

/** Methods core serves to the renderer for terminals. The `terminals` store (PtyInfo by ptyId) lists them. */
export const coreTerminalApi = defineApi({
  /** A shell tab at the reported grid; `cwd` defaults to the home directory. */
  'terminal.openShell': {
    args: z.object({ cwd: z.string().startsWith('/').optional(), cols: z.number().int().min(1), rows: z.number().int().min(1) }),
    result: z.object({ ptyId: zPtyId }),
  },
  /** Close a tab: terminate its process tree, then let the holder go. */
  'terminal.close': { args: z.object({ ptyId: zPtyId }), result: z.object({ ok: z.boolean() }) },
  /**
   * What a shell tab is running in the foreground now, asked before the tab is closed. `busy`: a process other
   * than the shell itself has the terminal; `name` is that process's (empty when idle). `known` false: that could not
   * be learned (ptyhost or the holder cannot tell); the answer is then `busy`, so the person is asked.
   */
  'terminal.foreground': { args: z.object({ ptyId: zPtyId }), result: z.object({ busy: z.boolean(), name: z.string(), known: z.boolean() }) },
  /** The terminals this window shows: rebuilt first, the checkpoint quiet rule watches their keystrokes. */
  'terminal.setVisible': { args: z.object({ ptyIds: z.array(zPtyId) }), result: z.object({ ok: z.boolean() }) },
  /**
   * Resolves once core has listed ptyhost's PTYs (adopted holders included) at least once, with the number of
   * running shells and of sessions that have a terminal (running or ended; the sessions a database rebuild brought
   * back are counted): a window decides whether it is a first launch only after this, never on a timer.
   */
  'terminal.restored': { args: z.object({}), result: z.object({ shells: z.number().int().min(0), sessions: z.number().int().min(0) }) },
  /**
   * `⌘K`: the renderer has cleared its own terminal; core clears the mirror and writes a fresh checkpoint
   * (`pty.clear`), so a later attach does not bring the scrollback back. The raw ring is untouched.
   */
  'terminal.clear': { args: z.object({ ptyId: zPtyId }), result: z.object({ ok: z.boolean() }) },
  /**
   * The last screen of an ended terminal whose holder is gone, from its checkpoint and ring,
   * as a snapshot to write into a fresh view; `cols × rows` is the grid for a ring with no checkpoint. Null while the PTY
   * runs (attach a stream instead), for a ring whose header is corrupt (C-COR-3), or when nothing was kept.
   */
  'terminal.lastScreen': {
    args: z.object({ ptyId: zPtyId, cols: z.number().int().min(1), rows: z.number().int().min(1) }),
    result: z.object({ cols: z.number().int(), rows: z.number().int(), data: z.string() }).nullable(),
  },
  /** Settings › Advanced › Orphaned holders, "Adopt as shell": the holder becomes a shell tab of its session. */
  'terminal.adoptOrphan': { args: z.object({ ptyId: zPtyId }), result: z.object({ ptyId: zPtyId }) },
  /** Settings › Advanced › Orphaned holders, "Terminate": its process tree ends and the holder goes. */
  'terminal.terminateOrphan': { args: z.object({ ptyId: zPtyId }), result: z.object({ ok: z.boolean() }) },
  /**
   * Settings › Advanced › Running background processes: every holder with a socket in `<KEA_HOME>/run`, each
   * described by its own state file. The ground truth for "what did Kea leave running": never read from the database.
   */
  'terminal.holders': { args: z.object({}), result: z.object({ holders: z.array(zHolderRow) }) },
  /**
   * "Terminate": end that holder's process tree. One Kea holds is ended as a stopped terminal is (its record and
   * last screen stay); an orphan as `terminal.terminateOrphan`; one nothing accounts for by `SIGKILL` to its pid, only
   * after its identity (pid, start time, executable) is confirmed again. `ok` false: it could not be confirmed or ended.
   */
  'terminal.terminateHolder': { args: z.object({ ptyId: zPtyId }), result: z.object({ ok: z.boolean() }) },
  /** Settings › Advanced › "Reload shell environment": resolve the login-shell environment again. */
  'terminal.reloadShellEnv': { args: z.object({}), result: z.object({ source: z.enum(['login-interactive', 'login', 'fallback']) }) },
  /**
   * Text at a terminal's prompt on the user's behalf: a path dragged in, the finder's `⌥↵`, a reference sent from the
   * viewer. Never submitted: the window cannot press Enter this way, and its text holds no control character
   * (`zTypedText`: not as a paste either, since a paste that is not submitted may carry neither a line feed nor a tab),
   * so a call that could act fails validation. `ptyId` is one of the session's running terminals; omitted, its agent
   * terminal. `ok` false, and nothing written, when there is no such running terminal.
   */
  'terminal.sendText': {
    args: z.object({ sessionId: zSessionId, ptyId: zPtyId.optional(), text: zTypedText, bracketed: z.boolean().optional() }),
    result: z.object({ ok: z.boolean() }),
  },
})

export const TERMINALS_STORE = 'terminals'

/** Why a live holder is an orphan. */
export const ORPHAN_REASONS = [
  /** No record names its ptyId. */
  'noRecord',
  /** Its record says the PTY ended (a holder showing up again never revives a record). */
  'recordEnded',
  /** Its record names another session: never attached (C-COR-6). */
  'sessionMismatch',
] as const

/** A live holder with no running record of its session, listed in Settings › Advanced. */
export const zOrphanInfo = z.object({
  ptyId: zPtyId,
  sessionId: zSessionId,
  kind: zPtyKind,
  argv: z.array(z.string()),
  cwd: z.string(),
  holderPid: z.number().int().nullable(),
  /** Holder process start, ms since the epoch. */
  holderStartedAt: z.number().nullable(),
  state: zPtyState,
  reason: z.enum(ORPHAN_REASONS),
  /** Ptyhost holds a connection to it. An unreachable holder can only be terminated (by pid, identity checked). */
  reachable: z.boolean(),
  /** "Adopt as shell" applies: reachable, and no record uses its ptyId. */
  canAdopt: z.boolean(),
})
export type OrphanInfo = z.infer<typeof zOrphanInfo>

/** The orphaned holders (OrphanInfo by ptyId), kept current by core's launch reconciliation. */
export const TERMINAL_ORPHANS_STORE = 'terminals.orphans'
