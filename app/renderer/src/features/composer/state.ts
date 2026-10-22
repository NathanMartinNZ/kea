// The composer's state as data: one draft per project, what a new draft starts from, what Start sends, and what blocks
// it. Core owns the rest (sessions.validate / sessions.create: slugs, branch checks, saving `lastLaunch`); this file is
// pure so the rules are unit-tested (U-CMP-1, U-CMP-4).
//
//   isolation   the Worktree toggle: the project's last start (`lastLaunch.isolation`), else on; a non-git
//               project is off and cannot be turned on; a Duplicate's draft takes the session's isolation for
//               that draft only
//   base        the project's last base (`lastLaunch.base`), else the default branch, fresh
//   branch      follows the prompt (core's slug) until edited
//   prompt      may be empty; kept per project when the composer closes and cleared by a start;
//               at most L.composerDraftMaxBytes
//   paths       pasted or dropped files go in as paths, relative to the project when inside it
//   agent       the project's last start's agent, else `general.defaultAgent`; its knobs come from core's `agents`
//               store: changing the agent takes that agent's last-used choices in this project (`lastLaunch.byAgent`,
//               kept by core at each start), else its defaults, and drops what it lacks; a CLI that is not installed
//               is a hard problem with its install command; dangerous modes are listed only when allowed (core
//               leaves them out)

import { L, lastChoicesFor, parseBaseKey, zKeptDraft, type AgentInfo, type ArgsOf, type BaseChoice, type ComposerDraft, type CoreApi, type Isolation, type LaunchOptions, type ModelOption, type PermissionModeOption, type Project, type ValidationProblem } from '@kea/protocol'

export interface Draft {
  prompt: string
  isolation: Isolation
  base: BaseChoice
  /** The branch name as edited; null while it follows the prompt. */
  branch: string | null
  agent: string
  config: LaunchOptions
}

/** Core's `shell` pseudo-agent (a login shell in the session's directory): what a draft runs when nothing else is known. */
export const PSEUDO_AGENT = 'shell'

/**
 * The Worktree toggle a new draft opens with, and whether it can change. A plain folder has no worktrees (off, locked);
 * a bare repository has nothing but worktrees (on, locked).
 */
export function isolationDefault(p: Pick<Project, 'isGit' | 'bare' | 'settings'>): { isolation: Isolation; locked: boolean } {
  if (!p.isGit) return { isolation: 'inplace', locked: true }
  if (p.bare) return { isolation: 'worktree', locked: true }
  return { isolation: p.settings.lastLaunch?.isolation ?? 'worktree', locked: false }
}

/** Why the Worktree toggle cannot change (its tip); null while it can. */
export function isolationLockReason(p: Pick<Project, 'isGit' | 'bare'>): string | null {
  if (!p.isGit) return 'Not a git repository: sessions run in place'
  return p.bare ? 'A bare repository has no working tree: sessions run in worktrees' : null
}

/** Nothing is checked out in a bare repository, so "Current HEAD" is no base there; the default stands in. */
function baseFor(p: Pick<Project, 'bare'>, base: BaseChoice): BaseChoice {
  return p.bare && base.kind === 'head' ? { kind: 'default' } : base
}

/** A fresh draft for a project: its last launch's choices, else the defaults (`agent`: `general.defaultAgent`). */
export function newDraft(p: Pick<Project, 'isGit' | 'bare' | 'settings'>, agent: string = PSEUDO_AGENT): Draft {
  const last = p.settings.lastLaunch
  return {
    prompt: '',
    isolation: isolationDefault(p).isolation,
    base: baseFor(p, parseBaseKey(last?.base)),
    branch: null,
    agent: last?.agent ?? agent,
    config: last?.config ?? {},
  }
}

/** Duplicate: the session's choices, for this draft only (the project's `lastLaunch` is untouched). */
export function duplicateDraft(d: ComposerDraft, p: Pick<Project, 'isGit' | 'bare'>): Draft {
  return { prompt: d.prompt, isolation: !p.isGit ? 'inplace' : p.bare ? 'worktree' : d.isolation, base: baseFor(p, d.base), branch: null, agent: d.agent, config: d.config }
}

/** The prompt cut to L.composerDraftMaxBytes of UTF-8, never inside a character. */
export function clampPrompt(text: string): string {
  const enc = new TextEncoder()
  if (enc.encode(text).length <= L.composerDraftMaxBytes) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (enc.encode(text.slice(0, mid)).length <= L.composerDraftMaxBytes) lo = mid
    else hi = mid - 1
  }
  // never split a surrogate pair
  const code = text.charCodeAt(lo - 1)
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? lo - 1 : lo)
}

/** One draft per project, released when the project is removed. */
export class Drafts {
  private readonly map = new Map<string, Draft>() // bounded: one per project, each ≤ L.composerDraftMaxBytes

  /** The project's draft, or a fresh one (`agent`: the default agent, `general.defaultAgent`). */
  get(projectId: string, p: Pick<Project, 'isGit' | 'bare' | 'settings'>, agent?: string): Draft {
    return this.map.get(projectId) ?? newDraft(p, agent)
  }

  has(projectId: string): boolean {
    return this.map.has(projectId)
  }

  set(projectId: string, d: Draft): void {
    this.map.set(projectId, { ...d, prompt: clampPrompt(d.prompt) })
  }

  /** A start clears the draft (the choices live on in `lastLaunch`). */
  clear(projectId: string): void {
    this.map.delete(projectId)
  }

  /** Drop the drafts of projects that are gone. */
  prune(exists: (projectId: string) => boolean): void {
    for (const id of [...this.map.keys()]) if (!exists(id)) this.map.delete(id)
  }

  get size(): number {
    return this.map.size
  }

  /** The drafts by project, oldest first, the latest L.windowHandoffDraftsMax: what this window hands a rebuilt one. */
  entries(): [string, Draft][] {
    return [...this.map.entries()].slice(-L.windowHandoffDraftsMax)
  }

  /** Take in the drafts a window handed this one; an entry that is not a project's draft is left out. Returns how many were taken. */
  adopt(entries: readonly unknown[]): number {
    let taken = 0
    for (const e of entries) {
      if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string') continue
      const d = zKeptDraft.safeParse(e[1])
      if (!d.success) continue
      this.set(e[0], d.data)
      taken++
    }
    return taken
  }
}

/**
 * After a start the project's draft goes (its choices live on in core's `lastLaunch`). A background start keeps the
 * composer open on the same choices with the prompt and the branch cleared; that is the draft returned, shown but not
 * kept as the project's. A foreground start returns null (the composer closes).
 */
export function afterStart(drafts: Drafts, projectId: string, d: Draft, background: boolean): Draft | null {
  drafts.clear(projectId)
  return background ? { ...d, prompt: '', branch: null } : null
}

type CreateArgs = ArgsOf<CoreApi, 'sessions.create'>
type ValidateArgs = ArgsOf<CoreApi, 'sessions.validate'>

/** In place, there is no base or branch to send. */
function branchPart(d: Draft): { base: BaseChoice; branch?: string } {
  if (d.isolation === 'inplace') return { base: { kind: 'default' } }
  return d.branch !== null && d.branch.trim() !== '' ? { base: d.base, branch: d.branch.trim() } : { base: d.base }
}

/** What Start sends (an empty prompt is a valid start). Core saves these choices as `lastLaunch`. */
export function createArgs(projectId: string, d: Draft): CreateArgs {
  return { projectId, prompt: clampPrompt(d.prompt), agent: d.agent, config: d.config, isolation: d.isolation, ...branchPart(d) }
}

/** What the inline validation asks. */
export function validateArgs(projectId: string, d: Draft): ValidateArgs {
  return { projectId, prompt: clampPrompt(d.prompt), isolation: d.isolation, agent: d.agent, ...branchPart(d) }
}

const BRANCH_CODES = new Set<ValidationProblem['code']>(['branchExists', 'branchCheckedOut', 'branchInvalid', 'baseMissing'])

/** The problems that apply to this draft: in place, the branch checks do not. */
export function applicable(problems: readonly ValidationProblem[], d: Pick<Draft, 'isolation'>): ValidationProblem[] {
  return d.isolation === 'inplace' ? problems.filter((p) => !BRANCH_CODES.has(p.code)) : [...problems]
}

/** Start is disabled only for a hard problem, with its message as the tooltip; null when it can start. */
export function startBlocker(problems: readonly ValidationProblem[], d: Pick<Draft, 'isolation'>): string | null {
  return applicable(problems, d).find((p) => p.hard)?.message ?? null
}

/** A path as the prompt gets it: relative when inside the project, else absolute. */
export function promptPath(path: string, root: string): string {
  const r = root.endsWith('/') ? root.slice(0, -1) : root
  if (path === r) return '.'
  return path.startsWith(`${r}/`) ? path.slice(r.length + 1) : path
}

/** Insert pasted or dropped files' paths at the selection, separated by spaces; returns the text and caret. */
export function insertPaths(text: string, start: number, end: number, paths: readonly string[], root: string): { text: string; caret: number } {
  if (paths.length === 0) return { text, caret: end }
  const before = text.slice(0, start)
  const after = text.slice(end)
  const lead = before === '' || /\s$/.test(before) ? '' : ' '
  const trail = after === '' || /^\s/.test(after) ? '' : ' '
  const ins = lead + paths.map((p) => promptPath(p, root)).join(' ') + trail
  const out = clampPrompt(before + ins + after)
  return { text: out, caret: Math.min(out.length, before.length + ins.length) }
}

// ── the agent and its knobs ──────────────────────────────────────────────────────────────────────────────────

/** The model a draft shows: its own, else the agent's default model (the one marked `isDefault`, else the first). */
export function shownModel(info: AgentInfo | undefined, config: LaunchOptions): string | undefined {
  if (config.model) return config.model
  const models = info?.options.models ?? []
  return (models.find((m) => m.isDefault) ?? models[0])?.id
}

/** What the selector row offers for this draft: lists that are empty are not shown (removed, not disabled). */
export function knobs(info: AgentInfo | undefined, config: LaunchOptions): { models: ModelOption[]; efforts: string[]; modes: PermissionModeOption[] } {
  if (!info) return { models: [], efforts: [], modes: [] }
  const models = info.options.models
  const model = models.find((m) => m.id === shownModel(info, config))
  // a free-text model the list does not know: every effort any model has (the CLI ignores what it does not support)
  const efforts = model ? model.efforts : info.options.allowCustomModel ? [...new Set(models.flatMap((m) => m.efforts))] : []
  return { models, efforts, modes: info.options.permissionModes }
}

/** `config` with what `info` does not offer taken out (a dangerous mode no longer listed goes too). */
export function fitConfig(config: LaunchOptions, info: AgentInfo | undefined): LaunchOptions {
  if (!info) return {}
  const out: LaunchOptions = {}
  const models = info.options.models
  if (config.model && (models.some((m) => m.id === config.model) || info.options.allowCustomModel)) out.model = config.model
  const { efforts, modes } = knobs(info, out)
  if (config.effort && efforts.includes(config.effort)) out.effort = config.effort
  if (config.permissionMode && modes.some((m) => m.id === config.permissionMode)) out.permissionMode = config.permissionMode
  if (config.extraArgs?.length) out.extraArgs = [...config.extraArgs]
  return out
}

/**
 * The draft with another agent: that agent's last-used choices in this project (its last start there, which the
 * project remembers per agent: `lastLaunch.byAgent`), else the agent's defaults (`agents.<id>.defaults` over the
 * adapter's), fitted to what it offers. `remembered`: choices made for that agent earlier in this draft, which win.
 */
export function withAgent(d: Draft, info: AgentInfo | undefined, id: string, last: Project['settings']['lastLaunch'], remembered?: LaunchOptions): Draft {
  const base: LaunchOptions = remembered ?? lastChoicesFor(last, id) ?? info?.defaults ?? {}
  return { ...d, agent: id, config: fitConfig(base, info) }
}

/**
 * The start check for the agent: one that is not installed is a hard problem whose message carries the install command;
 * one Kea does not know is hard too; an outdated or logged-out one is a soft note. Null while detecting and when ready.
 */
export function agentProblem(info: AgentInfo | undefined, id: string): ValidationProblem | null {
  const p = (hard: boolean, message: string): ValidationProblem => ({ code: 'agentMissing', hard, message, suggestion: info?.installCommand ?? null, path: null, sessionId: null })
  if (!info) return id === PSEUDO_AGENT ? null : p(true, `Kea has no agent called “${id}”.`)
  if (info.state === 'missing') return p(true, `${info.displayName} is not installed.${info.installCommand ? ` Install it with: ${info.installCommand}` : ''}`)
  if ((info.state === 'outdated' || info.state === 'ready') && info.notice) return p(false, info.notice)
  return null
}

/** The agent menu's label for a row: a missing CLI says so (the menu also shows it greyed). */
export function agentLabel(info: AgentInfo): string {
  if (info.state === 'missing') return `${info.displayName} — not installed · copy install command`
  if (info.state === 'detecting') return `${info.displayName} (checking…)`
  return info.displayName
}
