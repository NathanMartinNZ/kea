// Test support (never bundled: only tests import it): kea-mod.ts driven the way Command Code drives a mod, with what it
// delivers handed to the adapter's signals exactly as core would (through the helper's projection). The event shapes
// the tests feed it are those recorded on 1.79.2 (fixtures/hooks/commandcode/).

import type { AgentEvent } from '@kea/protocol'
import { projectPayload } from '../kit/projection.ts'
import { decodeOptions, keaMod, type KeaModIo, type KeaModOptions, type ModApiLike } from './kea-mod.ts'
import { modOptionArg, projection } from './launch.ts'
import { CommandCodeSignals } from './mapping.ts'
import { MOD_OPTION } from './contract.ts'

type Dict = Record<string, unknown>

export interface ModHarness {
  /** One agent event, as `cmd.on(name, handler)` receives it. */
  emit(name: string, e?: Dict): void
  /** `onSessionStart` / `onSessionEnd`, as the session hooks receive them. */
  hook(name: string, arg: Dict): void
  /** What the mod sent, in order: the payloads as core receives them. */
  readonly sent: Dict[]
  /** The events the adapter made of them, in order. */
  readonly events: AgentEvent[]
  /** Both, taken and emptied. */
  take(): { sent: Dict[]; events: AgentEvent[] }
  readonly signals: CommandCodeSignals
  /** The transcript a session id has (what the mod's look finds). */
  readonly transcripts: Map<string, string>
  /** The event names the mod subscribed to, the hooks it registered, the flags it declared. */
  readonly subscribed: string[]
  readonly hooks: string[]
  readonly flags: Dict
  /** Timers the mod holds. */
  readonly timers: number
}

/**
 * A mod under test. `option`: the `--mod-option kea=…` value (default: the one launch.ts builds); as in Command Code,
 * `getFlag` answers the declared default until the session is bound (`bind()` here is done by the first hook or event).
 */
export function modHarness(o: { option?: string | null; agentSessionId?: string | null; options?: Partial<KeaModOptions> } = {}): ModHarness {
  const built = modOptionArg({ keaSessionId: '01JXKEASESSION0000000000AA', keaHome: '/tmp/kea-home', helperPath: '/tmp/kea-home/bin/v/kea-helper' }).slice(MOD_OPTION.length + 1)
  let option: string | null = o.option === undefined ? built : o.option
  if (o.options && option) option = Buffer.from(JSON.stringify({ ...decodeOptions(option), ...o.options })).toString('base64url')
  const handlers = new Map<string, ((e: unknown) => void)[]>()
  const hooks: Record<string, (a: unknown) => void> = {}
  const flags: Dict = {}
  let bound = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const sent: Dict[] = []
  const events: AgentEvent[] = []
  const signals = new CommandCodeSignals(o.agentSessionId ?? null)
  const transcripts = new Map<string, string>()
  const io: KeaModIo = {
    deliver(_opts, payload) {
      // the mod's payload crosses a process boundary as JSON, then the helper's projection
      const p = projectPayload(JSON.parse(JSON.stringify(payload)), projection())
      sent.push(p)
      events.push(...signals.hook({ payload: p, monoMs: 0 }))
    },
    transcriptOf: (id) => transcripts.get(id) ?? null,
    setTimeout(f, ms) {
      const t = setTimeout(() => {
        timers.delete(t)
        f()
      }, ms)
      timers.add(t)
      return t
    },
    clearTimeout(t) {
      timers.delete(t as ReturnType<typeof setTimeout>)
      clearTimeout(t as ReturnType<typeof setTimeout>)
    },
  }
  const api: ModApiLike = {
    addFlag(name, f) {
      flags[name] = f.default
    },
    getFlag: (name) => (bound && name === MOD_OPTION && option !== null ? option : flags[name]),
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    hooks(h) {
      Object.assign(hooks, h)
    },
  }
  keaMod(api, io)
  return {
    emit(name, e = {}) {
      bound = true
      for (const h of handlers.get(name) ?? []) h({ type: name, ...e })
    },
    hook(name, arg) {
      bound = true
      hooks[name]?.(arg)
    },
    sent,
    events,
    take: () => ({ sent: sent.splice(0), events: events.splice(0) }),
    signals,
    transcripts,
    get subscribed() {
      return [...handlers.keys()]
    },
    get hooks() {
      return Object.keys(hooks)
    },
    flags,
    get timers() {
      return timers.size
    },
  }
}
