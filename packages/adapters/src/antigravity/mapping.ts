// Antigravity CLI status-line feed → AgentEvent state machine and quota usage mapping.
//
// Antigravity CLI emits whole-session state snapshots on each state change (projected by `kea-helper feed`), rather than
// discrete lifecycle hook events. `AntigravitySignals` diffs each projected snapshot against a virtual initial state so
// coalesced startup transitions still produce the exact sequence core's status engine expects, and `usageEvents` turns
// the snapshot's `quota` map into self-describing `UsageWindow` entries.

import path from 'node:path'
import { L, type AgentEvent, type UsageWindow } from '@kea/protocol'
import { cutChars } from '../kit/projection.ts'
import { clampUsagePct, sortUsageWindows } from '../kit/usage.ts'
import type { RawAgentSignal, SessionSignals } from '../types.ts'
import {
  AGENT_STATES,
  CONFIG,
  DEFAULT_PERMISSION_MODE,
  FEED_FIELDS,
  KNOWN_AGENT_STATES,
  QUOTA_BUCKETS,
  SUBAGENT_RUNNING,
  type KnownAgentState,
} from './contract.ts'

type Payload = Record<string, unknown>

/** Elapsed time in `authenticating` before a launch with a model object still counts as needing sign-in. */
const AUTH_STARTUP_GRACE_MS = 1500

/** Upper bound on conversation ids retained for a single live session across `/clear` invocations. */
const MAX_SESSION_IDS = 1000

/** Sort priority assigned to unknown future quota buckets so known buckets remain visible first. */
const DEFAULT_BUCKET_PRIORITY = 50

const USAGE_ID_MAX_CHARS = 64
const USAGE_SHORT_LABEL_MAX_CHARS = 24
const USAGE_TIP_LABEL_MAX_CHARS = 64

const KNOWN_STATE_SET = new Set<string>(KNOWN_AGENT_STATES)

const LEGACY_BRAIN_POSIX = `/${CONFIG.legacyBrainDir.join('/')}/`
const CANONICAL_BRAIN_POSIX = `/${[...CONFIG.dir, CONFIG.brainSubdir].join('/')}/`
const LEGACY_BRAIN_SEP = `${path.sep}${CONFIG.legacyBrainDir.join(path.sep)}${path.sep}`
const CANONICAL_BRAIN_SEP = `${path.sep}${[...CONFIG.dir, CONFIG.brainSubdir].join(path.sep)}${path.sep}`

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The value at a dotted path of a projected payload. */
function field(p: Payload, dottedPath: string): unknown {
  let v: unknown = p
  for (const k of dottedPath.split('.')) {
    if (!isPlainObject(v)) return undefined
    v = v[k]
  }
  return v
}

function nonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed.length > 0 ? trimmed : null
}

function rawNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

function positiveNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0
}

function runningSubagentsCount(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 0 ? v : 0
  if (Array.isArray(v)) {
    let count = 0
    for (const item of v) {
      if (isPlainObject(item) && item[FEED_FIELDS.subagentStatus] === SUBAGENT_RUNNING) count++
    }
    return count
  }
  return 0
}

function isActiveState(state: KnownAgentState): boolean {
  return state === AGENT_STATES.working || state === AGENT_STATES.toolUse
}

function makeConfirmKey(conversationId: string | null): string {
  return `confirm:${conversationId ?? ''}`
}

function makeReviewKey(conversationId: string | null): string {
  return `review:${conversationId ?? ''}`
}

/**
 * Rewrites Antigravity CLI's legacy `statusLine` transcript path (`<HOME>/.gemini/antigravity/brain/...`) to the real
 * on-disk location under `<HOME>/.gemini/antigravity-cli/brain/...`. Already-canonical paths and foreign paths pass
 * through unchanged so `ownsTranscript` can still reject paths outside the agent's brain folder.
 */
export function normalizeTranscriptPath(rawPath: string | null): string | null {
  if (rawPath === null || rawPath.trim().length === 0) return null
  if (rawPath.includes(LEGACY_BRAIN_POSIX)) {
    return rawPath.replace(LEGACY_BRAIN_POSIX, CANONICAL_BRAIN_POSIX)
  }
  if (LEGACY_BRAIN_SEP !== LEGACY_BRAIN_POSIX && rawPath.includes(LEGACY_BRAIN_SEP)) {
    return rawPath.replace(LEGACY_BRAIN_SEP, CANONICAL_BRAIN_SEP)
  }
  return rawPath
}

function parseResetTime(entry: Record<string, unknown>, now: number): number | undefined {
  const rawTime = entry[FEED_FIELDS.resetTime]
  if (typeof rawTime === 'string' && rawTime.trim() !== '') {
    const parsed = Date.parse(rawTime)
    if (Number.isFinite(parsed) && parsed > 0) {
      const rounded = Math.round(parsed)
      if (Number.isSafeInteger(rounded)) return rounded
    }
  }
  const relSec = entry[FEED_FIELDS.resetInSeconds]
  if (typeof relSec === 'number' && Number.isFinite(relSec) && relSec > 0) {
    const computed = Math.round(now + relSec * 1000)
    if (Number.isSafeInteger(computed) && computed > 0) return computed
  }
  return undefined
}

function quotaFamilyPrefix(model: string | null): string | null {
  if (!model) return null
  const lower = model.toLowerCase()
  if (lower.includes('claude') || lower.includes('gpt')) return '3p-'
  if (lower.includes('gemini')) return 'gemini-'
  return null
}

function bucketPriority(bucketId: string): number {
  return Object.hasOwn(QUOTA_BUCKETS, bucketId) ? QUOTA_BUCKETS[bucketId]!.priority : DEFAULT_BUCKET_PRIORITY
}

function findExhaustedQuota(p: Payload, activeModel: string | null, now: number): { resetsAt?: number } | null {
  const quota = p[FEED_FIELDS.quota]
  if (!isPlainObject(quota)) return null
  const prefix = quotaFamilyPrefix(activeModel)
  const keys = Object.keys(quota).sort(
    (a, b) => bucketPriority(a) - bucketPriority(b) || (a < b ? -1 : a > b ? 1 : 0),
  )
  let found = false
  let resetsAt: number | undefined
  for (const bucketId of keys) {
    if (prefix !== null && !bucketId.startsWith(prefix)) continue
    const entry = quota[bucketId]
    if (!isPlainObject(entry)) continue
    if (entry[FEED_FIELDS.disabled] === true) continue
    const remFrac = entry[FEED_FIELDS.remainingFraction]
    const remAmt = entry[FEED_FIELDS.remainingAmount]
    if (remFrac !== 0 && remAmt !== 0) continue
    found = true
    if (resetsAt === undefined) {
      resetsAt = parseResetTime(entry, now)
    }
  }
  return found ? (resetsAt !== undefined ? { resetsAt } : {}) : null
}

interface SnapshotState {
  conversationId: string | null
  agentState: KnownAgentState
  toolConfirmationPending: boolean
  confirmKey: string | null
  reviewKey: string | null
  title: string | null
  model: string | null
  effort: string | null
  permissionMode: string | null
  contextUsedPct: number | null
  costUsd: number | null
}

/**
 * Per-session signal state for an Antigravity CLI process. Diffs incoming projected status-line snapshots against a
 * virtual `initializing` baseline and emits normalised `AgentEvent` records. Antigravity CLI has no tier-1b status
 * file, so `statusFile`, `confirmInterrupt` and `turnEnded` are no-ops.
 */
export class AntigravitySignals implements SessionSignals {
  private readonly initialId: string | null
  private readonly clock: () => number
  // bounded: at most MAX_SESSION_IDS (1000) conversation ids seen in this session (oldest evicted on /clear)
  private readonly ids = new Set<string>()
  private readonly prev: SnapshotState
  private started = false
  private seenLive = false
  private authSinceMono: number | null = null
  private authEmitted = false
  private sawNonDefaultCycleMode = false
  readonly ignored = { unknownStatus: 0, unknownWait: 0, foreignSession: 0, unparsable: 0, unknownEvent: 0 }

  constructor(initialAgentSessionId: string | null, now: () => number = () => Date.now()) {
    const initId = nonEmptyString(initialAgentSessionId)
    this.initialId = initId
    this.clock = now
    if (initId !== null) this.ids.add(initId)
    this.prev = {
      conversationId: initId,
      agentState: AGENT_STATES.initializing,
      toolConfirmationPending: false,
      confirmKey: null,
      reviewKey: null,
      title: null,
      model: null,
      effort: null,
      permissionMode: null,
      contextUsedPct: null,
      costUsd: null,
    }
  }

  private recordSessionId(id: string): void {
    if (this.ids.has(id)) return
    if (this.ids.size >= MAX_SESSION_IDS) {
      const oldest = this.ids.values().next().value
      if (oldest !== undefined) this.ids.delete(oldest)
    }
    this.ids.add(id)
  }

  sessionIds(): ReadonlySet<string> {
    return new Set(this.ids)
  }

  /** The conversation id later resumes target (updated on `/clear`). */
  get agentSessionId(): string | null {
    return this.prev.conversationId
  }

  hook(raw: RawAgentSignal): AgentEvent[] {
    if (!raw || !isPlainObject(raw.payload)) {
      this.ignored.unparsable++
      return []
    }
    const p = raw.payload
    const events: AgentEvent[] = []

    // 1) Conversation id and transcript path normalisation.
    const cid = nonEmptyString(field(p, FEED_FIELDS.conversationId))
    const tp = normalizeTranscriptPath(rawNonEmptyString(field(p, FEED_FIELDS.transcriptPath)))
    if (cid !== null) {
      this.seenLive = true
      if (!this.started) {
        this.started = true
        this.prev.conversationId = cid
        this.recordSessionId(cid)
        events.push({
          t: 'session.started',
          agentSessionId: cid,
          source: this.initialId !== null ? 'resume' : 'startup',
          ...(tp !== null ? { transcriptPath: tp } : {}),
        })
      } else if (cid !== this.prev.conversationId) {
        if (this.prev.confirmKey !== null) {
          events.push({ t: 'attention.cleared', key: this.prev.confirmKey })
          this.prev.confirmKey = null
          this.prev.toolConfirmationPending = false
        }
        if (this.prev.reviewKey !== null) {
          events.push({ t: 'attention.cleared', key: this.prev.reviewKey })
          this.prev.reviewKey = null
        }
        this.prev.conversationId = cid
        this.prev.title = null
        this.recordSessionId(cid)
        events.push({
          t: 'session.started',
          agentSessionId: cid,
          source: 'clear',
          ...(tp !== null ? { transcriptPath: tp } : {}),
        })
      }
    }

    // 2) Validate agent_state without aborting metadata processing on unknown values.
    const rawState = field(p, FEED_FIELDS.agentState)
    let nextState: KnownAgentState = this.prev.agentState
    let stateValid = false
    if (typeof rawState === 'string') {
      if (KNOWN_STATE_SET.has(rawState)) {
        nextState = rawState as KnownAgentState
        stateValid = true
      } else {
        this.ignored.unknownStatus++
      }
    } else if (rawState !== undefined && rawState !== null) {
      this.ignored.unknownStatus++
    }

    // 3) Agent state transitions in strict engine order.
    const prevState = this.prev.agentState
    const wasActive = isActiveState(prevState)
    const nowActive = isActiveState(nextState)

    if (this.prev.reviewKey !== null && nextState !== AGENT_STATES.reviewing) {
      events.push({ t: 'attention.cleared', key: this.prev.reviewKey })
      this.prev.reviewKey = null
    }

    if (!wasActive && nowActive) {
      events.push({ t: 'turn.started' })
    }

    if ((wasActive || prevState === AGENT_STATES.reviewing) && nextState === AGENT_STATES.idle) {
      const tasks = positiveNumber(field(p, FEED_FIELDS.taskCount))
      const subagents = runningSubagentsCount(field(p, FEED_FIELDS.subagents))
      events.push({ t: 'turn.finished', backgroundWork: tasks > 0 || subagents > 0 })
    }

    if (prevState !== AGENT_STATES.reviewing && nextState === AGENT_STATES.reviewing) {
      const key = makeReviewKey(this.prev.conversationId)
      this.prev.reviewKey = key
      events.push({ t: 'attention.question', key, summary: 'Review requested' })
    }

    if (nextState === AGENT_STATES.authenticating) {
      if (!this.authEmitted) {
        const modelObj = p[FEED_FIELDS.model]
        const modelMissing = modelObj === null || modelObj === undefined
        const elapsed = this.authSinceMono !== null ? raw.monoMs - this.authSinceMono : 0
        if (
          this.seenLive ||
          (prevState === AGENT_STATES.authenticating && (modelMissing || elapsed >= AUTH_STARTUP_GRACE_MS))
        ) {
          events.push({ t: 'turn.failed', kind: 'auth', error: 'Antigravity CLI needs sign-in' })
          this.authEmitted = true
        } else if (this.authSinceMono === null) {
          this.authSinceMono = raw.monoMs
        }
      }
    } else {
      if (stateValid) this.seenLive = true
      this.authEmitted = false
      this.authSinceMono = null
    }

    if (prevState !== AGENT_STATES.error && nextState === AGENT_STATES.error) {
      const activeModel = nonEmptyString(field(p, FEED_FIELDS.modelId)) ?? this.prev.model
      const exhausted = findExhaustedQuota(p, activeModel, this.clock())
      if (exhausted !== null) {
        events.push({
          t: 'turn.failed',
          kind: 'rate_limit',
          error: 'Rate limit reached',
          ...(exhausted.resetsAt !== undefined ? { resetsAt: exhausted.resetsAt } : {}),
        })
      } else {
        events.push({ t: 'turn.failed', kind: 'other', error: 'Antigravity CLI reported an error' })
      }
    }

    this.prev.agentState = nextState

    // 4) Tool confirmation prompt toggle.
    const pending = field(p, FEED_FIELDS.toolConfirmationPending) === true
    if (!this.prev.toolConfirmationPending && pending) {
      const key = makeConfirmKey(this.prev.conversationId)
      this.prev.confirmKey = key
      events.push({ t: 'attention.permission', key, tool: 'Tool confirmation', summary: '' })
    } else if (this.prev.toolConfirmationPending && !pending && this.prev.confirmKey !== null) {
      events.push({ t: 'attention.cleared', key: this.prev.confirmKey })
      this.prev.confirmKey = null
    }
    this.prev.toolConfirmationPending = pending

    // 5) Metadata diffs (emitted only when changed).
    const meta: Extract<AgentEvent, { t: 'meta' }> = { t: 'meta' }
    let metaChanged = false

    const title = nonEmptyString(field(p, FEED_FIELDS.conversationTitle))
    if (title !== null && title !== this.prev.title) {
      this.prev.title = title
      meta.title = title
      meta.titleSource = 'agent'
      metaChanged = true
    }

    const modelId = nonEmptyString(field(p, FEED_FIELDS.modelId))
    if (modelId !== null && modelId !== this.prev.model) {
      this.prev.model = modelId
      meta.model = modelId
      metaChanged = true
    }

    const effort = nonEmptyString(field(p, FEED_FIELDS.modelEffort))
    if (effort !== null && effort !== this.prev.effort) {
      this.prev.effort = effort
      meta.effort = effort
      metaChanged = true
    }

    const cycleMode = nonEmptyString(field(p, FEED_FIELDS.cycleMode))
    if (cycleMode !== null) {
      this.sawNonDefaultCycleMode = true
      if (cycleMode !== this.prev.permissionMode) {
        this.prev.permissionMode = cycleMode
        meta.permissionMode = cycleMode
        metaChanged = true
      }
    } else if (this.sawNonDefaultCycleMode && this.prev.permissionMode !== DEFAULT_PERMISSION_MODE) {
      this.prev.permissionMode = DEFAULT_PERMISSION_MODE
      meta.permissionMode = DEFAULT_PERMISSION_MODE
      metaChanged = true
    }

    const rawCtx = field(p, FEED_FIELDS.contextUsedPct)
    if (typeof rawCtx === 'number' && Number.isFinite(rawCtx)) {
      const pct = clampUsagePct(rawCtx)
      if (pct !== this.prev.contextUsedPct) {
        this.prev.contextUsedPct = pct
        meta.contextUsedPct = pct
        metaChanged = true
      }
    }

    const rawCost = field(p, FEED_FIELDS.costTotalUsd)
    if (typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0) {
      if (rawCost !== this.prev.costUsd) {
        this.prev.costUsd = rawCost
        meta.costUsd = rawCost
        metaChanged = true
      }
    }

    if (metaChanged) events.push(meta)

    return events
  }

  statusFile(): { reading: null; registered: boolean; events: AgentEvent[]; interruptCandidate: null } {
    return { reading: null, registered: false, events: [], interruptCandidate: null }
  }

  confirmInterrupt(): AgentEvent[] {
    return []
  }

  turnEnded(): void {
    // Antigravity CLI has no separate tier-1b status file.
  }
}

/** Factory for one Antigravity CLI session's signal state. */
export function createSignals(initialAgentSessionId: string | null): SessionSignals {
  return new AntigravitySignals(initialAgentSessionId)
}

/**
 * Maps a projected status-line payload's `quota` map into self-describing `UsageWindow` entries for core's usage meter.
 * Disabled buckets, buckets without a valid `remaining_fraction` in `[0, 1]`, and buckets without a valid reset time
 * are skipped; the remaining windows are sorted by priority and capped at `L.usageWindowsMax`.
 */
export function usageEvents(payload: Record<string, unknown>, now: number = Date.now()): AgentEvent[] {
  if (!isPlainObject(payload)) return []
  const quota = payload[FEED_FIELDS.quota]
  if (!isPlainObject(quota)) return []

  const windows: UsageWindow[] = []
  const seenIds = new Set<string>()
  for (const [rawId, entry] of Object.entries(quota)) {
    const trimmed = rawId.trim()
    if (trimmed.length === 0 || !isPlainObject(entry)) continue
    if (entry[FEED_FIELDS.disabled] === true) continue

    const rem = entry[FEED_FIELDS.remainingFraction]
    if (typeof rem !== 'number' || !Number.isFinite(rem) || rem < 0 || rem > 1) continue

    const resetsAt = parseResetTime(entry, now)
    if (resetsAt === undefined) continue

    const id = cutChars(trimmed, USAGE_ID_MAX_CHARS)
    if (seenIds.has(id)) continue
    seenIds.add(id)

    const known = Object.hasOwn(QUOTA_BUCKETS, rawId) ? QUOTA_BUCKETS[rawId] : undefined
    const spokenFallback = trimmed.replace(/[-_]+/g, ' ').trim() || trimmed
    windows.push({
      id,
      shortLabel: known ? known.shortLabel : cutChars(trimmed, USAGE_SHORT_LABEL_MAX_CHARS),
      tipLabel: known ? known.tipLabel : cutChars(trimmed, USAGE_TIP_LABEL_MAX_CHARS),
      spokenLabel: known ? known.spokenLabel : cutChars(spokenFallback, USAGE_TIP_LABEL_MAX_CHARS),
      priority: known ? known.priority : DEFAULT_BUCKET_PRIORITY,
      usedPct: clampUsagePct((1 - rem) * 100),
      resetsAt,
    })
  }

  const sorted = sortUsageWindows(windows, L.usageWindowsMax)
  return sorted.length > 0 ? [{ t: 'account.usage', windows: sorted }] : []
}
