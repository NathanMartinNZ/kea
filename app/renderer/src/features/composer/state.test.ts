import { describe, expect, it } from 'vitest'
import { L, baseKey, lastChoicesFor, nextLastLaunch, zWindowHandoff, type AgentInfo, type ValidationProblem } from '@kea/protocol'
import { fakeProject } from '../sessions/fakes.ts'
import { selectorFor } from './keys.ts'
import { darwin } from '@kea/protocol/os/darwin'
import { afterStart, agentLabel, agentProblem, applicable, clampPrompt, createArgs, Drafts, duplicateDraft, fitConfig, insertPaths, isolationDefault, isolationLockReason, knobs, newDraft, promptPath, shownModel, startBlocker, validateArgs, withAgent } from './state.ts'

/** An agent row as core's `agents` store sends it (a made-up adapter: the composer knows no agent by name). */
function agentRow(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'agent-a',
    displayName: 'Agent A',
    state: 'ready',
    version: '1.0.0',
    path: '/opt/agent-a',
    loggedIn: true,
    notice: null,
    installCommand: 'npm i -g agent-a',
    loginCommand: null,
    rightButtonMenu: false,
    options: {
      models: [
        { id: 'big', label: 'Big', efforts: ['low', 'high'], isDefault: false },
        { id: 'small', label: 'Small', efforts: [], isDefault: true },
      ],
      allowCustomModel: true,
      permissionModes: [
        { id: 'ask', label: 'Ask before edits', dangerous: false },
        { id: 'plan', label: 'Plan', dangerous: false },
      ],
    },
    defaults: { model: 'big', effort: 'high' },
    detectedAt: 1,
    order: 0,
    ...over,
  }
}

const problem = (code: ValidationProblem['code'], hard: boolean, message: string = code): ValidationProblem => ({ code, hard, message, suggestion: null, path: null, sessionId: null })

describe('composer state', () => {
  it('U-CMP-7 · the drafts a window hands the one rebuilt in its place: every project’s draft, as it is, valid as the handoff main checks, the latest window_handoff_drafts_max of them; taken in, they are each project’s draft again, and a malformed one is left out', () => {
    const p = fakeProject({ rootPath: '/srv/code/app' })
    const q = fakeProject({ rootPath: '/srv/code/web' })
    const from = new Drafts()
    from.set(p.id, { ...from.get(p.id, p), prompt: 'fix the login redirect loop', base: { kind: 'ref', ref: 'develop' }, branch: 'kea/login-loop' })
    from.set(q.id, { ...from.get(q.id, q), prompt: 'é'.repeat(10), branch: '' })
    const handed = { drafts: from.entries() }
    expect(zWindowHandoff.safeParse(handed).success, 'what main checks').toBe(true)
    const to = new Drafts()
    expect(to.adopt(handed.drafts)).toBe(2)
    expect(to.get(p.id, p)).toEqual(from.get(p.id, p))
    expect(to.get(q.id, q)).toEqual(from.get(q.id, q))
    // the latest drafts only, past the cap
    const many = new Drafts()
    for (let i = 0; i < L.windowHandoffDraftsMax + 3; i++) many.set(`p${i}`, { ...from.get(p.id, p), prompt: `draft ${i}` })
    const kept = many.entries()
    expect(kept).toHaveLength(L.windowHandoffDraftsMax)
    expect(kept[0]![1].prompt).toBe('draft 3')
    // a malformed entry (not from a window of this build) is left out, the others are taken
    const odd = new Drafts()
    expect(odd.adopt([['p-ok', from.get(p.id, p)], ['p-bad', { prompt: 3 }] as never, 'nonsense' as never])).toBe(1)
    expect([odd.has('p-ok'), odd.has('p-bad')]).toEqual([true, false])
  })

  it('U-CMP-1 · an empty prompt is a valid start; a start sends the full choice set and clears the draft; pasted or dropped paths go in relative to the project', () => {
    const p = fakeProject({ rootPath: '/srv/code/app' })
    const drafts = new Drafts()
    const d = drafts.get(p.id, p)
    expect(d.prompt).toBe('')
    // An empty prompt blocks nothing and is sent as an empty prompt
    expect(startBlocker([], d)).toBe(null)
    expect(createArgs(p.id, d)).toEqual({ projectId: p.id, prompt: '', agent: d.agent, config: {}, isolation: 'worktree', base: { kind: 'default' } })

    // the draft is kept per project until a start (Esc keeps it)
    drafts.set(p.id, { ...d, prompt: 'fix the login redirect loop', base: { kind: 'ref', ref: 'develop' }, branch: 'kea/login-loop' })
    const kept = drafts.get(p.id, p)
    expect(kept.prompt).toBe('fix the login redirect loop')
    // What core saves as lastLaunch is everything chosen, sent with the start
    expect(createArgs(p.id, kept)).toEqual({ projectId: p.id, prompt: 'fix the login redirect loop', agent: kept.agent, config: {}, isolation: 'worktree', base: { kind: 'ref', ref: 'develop' }, branch: 'kea/login-loop' })
    // A background start leaves the composer on the same choices, the prompt and branch cleared, and keeps no draft
    const shown = afterStart(drafts, p.id, kept, true)
    expect(shown).toEqual({ ...kept, prompt: '', branch: null })
    expect(drafts.has(p.id), 'a background start keeps no draft').toBe(false)
    // A start clears the draft; the composer closes
    drafts.set(p.id, kept)
    expect(afterStart(drafts, p.id, kept, false)).toBe(null)
    expect(drafts.has(p.id), 'a start keeps no draft').toBe(false)
    // ... and the next draft starts from it (core wrote lastLaunch), with the prompt cleared
    const saved = fakeProject({ ...p, settings: { lastLaunch: { agent: kept.agent, config: {}, isolation: 'worktree', base: baseKey({ kind: 'ref', ref: 'develop' }) } } })
    const next = drafts.get(p.id, saved)
    expect(next.prompt).toBe('')
    expect(next.base).toEqual({ kind: 'ref', ref: 'develop' })
    expect(next.branch).toBe(null)

    // the prompt is byte-capped like a stored draft, never splitting a character
    const big = 'é'.repeat(L.composerDraftMaxBytes)
    const cut = clampPrompt(big)
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(L.composerDraftMaxBytes)
    expect(cut.endsWith('é')).toBe(true)
    const emoji = clampPrompt('a' + '😀'.repeat(L.composerDraftMaxBytes / 4))
    expect(emoji.at(-1)).not.toMatch(/[\ud800-\udbff]$/)

    // Paths, relative inside the project, absolute outside; spaced from the text around them
    expect(promptPath('/srv/code/app/src/a.ts', p.rootPath)).toBe('src/a.ts')
    expect(promptPath('/srv/code/app', p.rootPath)).toBe('.')
    expect(promptPath('/srv/code/application/x', p.rootPath)).toBe('/srv/code/application/x')
    expect(promptPath('/tmp/shot.png', p.rootPath)).toBe('/tmp/shot.png')
    const r = insertPaths('look at and fix', 8, 8, ['/srv/code/app/src/a.ts', '/tmp/shot.png'], p.rootPath)
    expect(r.text).toBe('look at src/a.ts /tmp/shot.png and fix')
    expect(r.caret).toBe('look at src/a.ts /tmp/shot.png '.length)
    expect(insertPaths('', 0, 0, ['/srv/code/app/README.md'], p.rootPath)).toEqual({ text: 'README.md', caret: 9 })
    expect(insertPaths('see:x', 4, 4, ['/srv/code/app/b'], p.rootPath).text).toBe('see: b x')
    expect(insertPaths('abc', 1, 2, [], p.rootPath)).toEqual({ text: 'abc', caret: 2 })
  })

  it('U-CMP-6 · a bare repository’s project: the Worktree toggle is on and locked, with its reason, whatever the last launch said; "Current HEAD" is never a draft’s base; a duplicate of an in-place session there is a worktree draft; core’s refusal of an in-place start blocks Start', () => {
    const bare = fakeProject({ bare: true, settings: { lastLaunch: { agent: 'shell', config: {}, isolation: 'inplace', base: 'head' } } })
    expect(isolationDefault(bare)).toEqual({ isolation: 'worktree', locked: true })
    expect(isolationLockReason(bare)).toMatch(/bare repository/)
    expect(newDraft(bare)).toMatchObject({ isolation: 'worktree', base: { kind: 'default' } })
    expect(duplicateDraft({ projectId: bare.id, agent: 'shell', prompt: 'again', config: {}, isolation: 'inplace', base: { kind: 'head' } }, bare)).toMatchObject({ isolation: 'worktree', base: { kind: 'default' } })
    expect(duplicateDraft({ projectId: bare.id, agent: 'shell', prompt: '', config: {}, isolation: 'worktree', base: { kind: 'ref', ref: 'release' } }, bare).base).toEqual({ kind: 'ref', ref: 'release' })
    // the reasons of the other two kinds of project
    expect(isolationLockReason(fakeProject())).toBeNull()
    expect(isolationLockReason(fakeProject({ isGit: false }))).toMatch(/Not a git repository/)
    // what core says to an in-place start in a bare repository is a blocker like any hard problem
    const refused = [problem('bareInPlace', true, 'This project is a bare repository')]
    expect(startBlocker(refused, { isolation: 'inplace' })).toBe('This project is a bare repository')
  })

  it('U-CMP-4 · the Worktree toggle opens as the project last used it, else on; a non-git project is off and locked; Duplicate sets it for that draft only; while off there is no base or branch and no branch checks; the toggle is sent with the start', () => {
    const fresh = fakeProject()
    expect(isolationDefault(fresh)).toEqual({ isolation: 'worktree', locked: false })
    const inplace = fakeProject({ settings: { lastLaunch: { agent: 'shell', config: {}, isolation: 'inplace', base: 'default' } } })
    expect(isolationDefault(inplace)).toEqual({ isolation: 'inplace', locked: false })
    expect(newDraft(inplace).isolation).toBe('inplace')
    const plain = fakeProject({ isGit: false, settings: { lastLaunch: { agent: 'shell', config: {}, isolation: 'worktree', base: 'default' } } })
    expect(isolationDefault(plain)).toEqual({ isolation: 'inplace', locked: true })

    // Duplicate: the session's isolation for this draft; the project's lastLaunch is not touched
    const before = structuredClone(inplace.settings)
    const dup = duplicateDraft({ projectId: inplace.id, agent: 'shell', prompt: 'again', config: {}, isolation: 'worktree', base: { kind: 'existing', ref: 'kea/x' } }, inplace)
    expect(dup.isolation).toBe('worktree')
    expect(dup.base).toEqual({ kind: 'existing', ref: 'kea/x' })
    expect(inplace.settings).toEqual(before)
    expect(isolationDefault(inplace).isolation).toBe('inplace')
    // a duplicate into a non-git project is still in place
    expect(duplicateDraft({ projectId: plain.id, agent: 'shell', prompt: '', config: {}, isolation: 'worktree', base: { kind: 'default' } }, plain).isolation).toBe('inplace')

    // off: no base or branch is sent, and the branch checks are not applied
    const off = { ...newDraft(fresh), isolation: 'inplace' as const, base: { kind: 'ref' as const, ref: 'develop' }, branch: 'kea/edited' }
    const args = createArgs(fresh.id, off)
    expect(args.isolation).toBe('inplace')
    expect(args.branch).toBeUndefined()
    expect(args.base).toEqual({ kind: 'default' })
    expect(validateArgs(fresh.id, off).branch).toBeUndefined()
    const problems = [problem('branchExists', true, 'kea/x exists'), problem('branchCheckedOut', true), problem('projectMissing', true, 'The project folder is missing')]
    expect(applicable(problems, off).map((p) => p.code)).toEqual(['projectMissing'])
    expect(startBlocker(problems, off)).toBe('The project folder is missing')
    // on: the branch checks count; only a hard problem blocks Start, and its message is the reason
    const on = { ...off, isolation: 'worktree' as const }
    expect(startBlocker(problems, on)).toBe('kea/x exists')
    expect(startBlocker([problem('branchExists', false)], on)).toBe(null)
    // the toggle's state goes with the start (core saves it as lastLaunch.isolation)
    expect(createArgs(fresh.id, on).isolation).toBe('worktree')
    expect(createArgs(fresh.id, on).branch).toBe('kea/edited')
  })

  it('U-CMP-5 · the selector row offers only what the agent has (a model without efforts shows no Effort; an agent without knobs shows none); switching agents takes the project\'s last choices for it, else its defaults, else what was chosen earlier in the draft, dropping what it lacks; a missing CLI is a hard problem with its install command; ⌘1…⌘4 name the four selectors', () => {
    const a = agentRow()
    // the shown model: the draft's, else the agent's default model
    expect(shownModel(a, {})).toBe('small')
    expect(shownModel(a, { model: 'big' })).toBe('big')
    // Knobs follow the model; an empty list is not shown (removed, not disabled)
    expect(knobs(a, {}).efforts).toEqual([])
    expect(knobs(a, { model: 'big' }).efforts).toEqual(['low', 'high'])
    // a free-text model: every effort any model has (the CLI ignores what it does not support)
    expect(knobs(a, { model: 'my-own-model' }).efforts).toEqual(['low', 'high'])
    const bare = agentRow({ id: 'bare', options: { models: [], allowCustomModel: false, permissionModes: [] }, defaults: {} })
    expect(knobs(bare, {})).toEqual({ models: [], efforts: [], modes: [] })
    expect(knobs(undefined, { model: 'x' })).toEqual({ models: [], efforts: [], modes: [] })

    // what the agent lacks is dropped: an unknown model (no free text), an effort the model lacks, a mode no longer listed
    // (a dangerous mode is listed only while the agent's "Allow bypass-permission modes" is on: core leaves it out
    // otherwise, so a remembered one goes here)
    const strict = agentRow({ options: { ...a.options, allowCustomModel: false } })
    expect(fitConfig({ model: 'gone', effort: 'high', permissionMode: 'yolo' }, strict)).toEqual({})
    expect(fitConfig({ model: 'big', effort: 'high', permissionMode: 'plan', extraArgs: ['--x'] }, a)).toEqual({ model: 'big', effort: 'high', permissionMode: 'plan', extraArgs: ['--x'] })
    expect(fitConfig({ model: 'small', effort: 'high' }, a), 'the small model has no efforts').toEqual({ model: 'small' })
    expect(fitConfig({ model: 'mine' }, a), 'free text is kept').toEqual({ model: 'mine' })
    expect(fitConfig({ model: 'big' }, undefined)).toEqual({})

    // switching agents: the project's last start with that agent, else its defaults; choices made earlier in this
    // draft win; each fitted to the agent
    const p = fakeProject()
    const d = newDraft(p)
    expect(withAgent(d, a, 'agent-a', undefined).config).toEqual({ model: 'big', effort: 'high' })
    const last = { agent: 'agent-a', config: { model: 'big', effort: 'low', permissionMode: 'plan' }, isolation: 'worktree' as const, base: 'default' }
    expect(withAgent(d, a, 'agent-a', last).config).toEqual({ model: 'big', effort: 'low', permissionMode: 'plan' })
    expect(withAgent(d, a, 'agent-a', { ...last, agent: 'other' }).config, 'another agent\'s last start is not used').toEqual({ model: 'big', effort: 'high' })
    // each agent's last start in this project is remembered (`lastLaunch.byAgent`): back to an agent, its own choices
    const two = nextLastLaunch(nextLastLaunch(undefined, last, 8), { agent: 'other', config: { model: 'o1' }, isolation: 'inplace', base: 'head' }, 8)
    expect(two).toEqual({ agent: 'other', config: { model: 'o1' }, isolation: 'inplace', base: 'head', byAgent: { 'agent-a': last.config, other: { model: 'o1' } } })
    expect(withAgent(d, a, 'agent-a', two).config).toEqual({ model: 'big', effort: 'low', permissionMode: 'plan' })
    expect(lastChoicesFor(two, 'other')).toEqual({ model: 'o1' })
    expect(lastChoicesFor(two, 'never-started')).toBeUndefined()
    // a lastLaunch saved before `byAgent` existed keeps its agent's choices; the memory holds the most recent agents only
    expect(nextLastLaunch({ agent: 'agent-a', config: { model: 'big' }, isolation: 'worktree', base: 'default' }, { agent: 'other', config: {}, isolation: 'worktree', base: 'default' }, 8).byAgent).toEqual({ 'agent-a': { model: 'big' }, other: {} })
    let many: ReturnType<typeof nextLastLaunch> | undefined
    for (const id of ['a', 'b', 'c', 'a', 'd']) many = nextLastLaunch(many, { agent: id, config: { model: id }, isolation: 'worktree', base: 'default' }, 3)
    expect(Object.keys(many!.byAgent!)).toEqual(['c', 'a', 'd'])
    expect(withAgent(d, a, 'agent-a', last, { model: 'small' }).config).toEqual({ model: 'small' })
    const toBare = withAgent({ ...d, agent: 'agent-a', config: { model: 'big', effort: 'high' } }, bare, 'bare', undefined)
    expect(toBare).toMatchObject({ agent: 'bare', config: {} })
    // a fresh draft takes the default agent when the project has no last start (`general.defaultAgent`)
    expect(new Drafts().get(p.id, p, 'agent-a').agent).toBe('agent-a')
    expect(new Drafts().get(p.id, fakeProject({ settings: { lastLaunch: last } }), 'shell').agent).toBe('agent-a')

    // A missing CLI blocks Start and carries its install command; outdated or logged out is a note
    const missing = agentRow({ state: 'missing', version: null, path: null })
    const m = agentProblem(missing, 'agent-a')!
    expect(m).toMatchObject({ code: 'agentMissing', hard: true, suggestion: 'npm i -g agent-a' })
    expect(m.message).toContain('npm i -g agent-a')
    expect(startBlocker([m], d)).toBe(m.message)
    expect(agentLabel(missing)).toBe('Agent A — not installed · copy install command')
    expect(agentProblem(agentRow({ state: 'outdated', notice: 'Agent A 0.9 is older than 1.0' }), 'agent-a')).toMatchObject({ hard: false, message: 'Agent A 0.9 is older than 1.0' })
    expect(agentProblem(a, 'agent-a')).toBe(null)
    expect(agentProblem(agentRow({ state: 'detecting' }), 'agent-a'), 'never waits for a detection').toBe(null)
    expect(agentLabel(agentRow({ state: 'detecting' }))).toBe('Agent A (checking…)')
    expect(agentProblem(undefined, 'shell')).toBe(null)
    expect(agentProblem(undefined, 'nobody')?.hard).toBe(true)

    // ⌘1…⌘4 open Agent, Model, Effort, Permission mode; with another modifier, or another digit, they do not
    const key = (code: string, o: { shift?: boolean; alt?: boolean; ctrl?: boolean; meta?: boolean } = {}) => ({ key: code.slice(-1), code, metaKey: o.meta ?? true, shiftKey: !!o.shift, altKey: !!o.alt, ctrlKey: !!o.ctrl })
    // macOS's keys on every system (both run this suite); commands/keys.test.ts checks Linux's (U-PLT-41)
    const mac = darwin.keys
    expect(['Digit1', 'Digit2', 'Digit3', 'Digit4'].map((c) => selectorFor(key(c), mac))).toEqual(['agent', 'model', 'effort', 'mode'])
    expect([selectorFor(key('Digit5'), mac), selectorFor(key('Digit1', { shift: true }), mac), selectorFor(key('Digit2', { alt: true }), mac), selectorFor(key('Digit1', { meta: false }), mac)]).toEqual([null, null, null, null])
  })
})
