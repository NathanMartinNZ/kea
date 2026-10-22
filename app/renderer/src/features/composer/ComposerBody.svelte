<!--
The new-session composer: in the main pane, not a modal; `--size-composer` wide at most, top-aligned at
`--ratio-composer-top` of the pane. Keyboard first: the prompt has focus, ↵ is a newline, ⌘↵ starts and switches to the
session, ⌥⌘↵ starts it in the background and clears the prompt for the next task, Esc closes and keeps the draft.

  heading     "New session in <project> ▾" — the project picker (⌘⇧N opens with it open)
  prompt      grows to `--size-composer-prompt-max`, then scrolls; pasted or dropped files go in as paths
  footer      ⎇ base ▾ · Worktree switch · branch name (follows the prompt until edited) · Start ⌘↵ —
              while the switch is off, base and branch become "In place · <branch>"; a non-git project has the switch
              off and fixed, and "Initialise git…"
  validation  inline and non-blocking: core's `sessions.validate`, one request in flight at a time; Start is
              disabled only by a hard problem, whose message is its tooltip

  selectors   under the prompt: Agent ▾ · Model ▾ · Effort ▾ · Permission mode ▾, quiet dropdowns from
              core's `agents` store (cached detection, never awaited), each opened by ⌘1…⌘4 while the composer
              has the keyboard; a knob the agent lacks is not shown; changing the agent takes that agent's last
              choices in this project; a missing CLI is listed greyed, copies its install command when chosen and
              blocks Start; dangerous modes appear only when allowed, in `--danger` text
  condition   under the box: the chosen agent's account condition (features/status ConditionNote), non-blocking

Locatable as: `region` "New session", `textbox` "Prompt", `switch` "Worktree", `textbox` "Branch name", `button`
"Start", `button` "Base branch", `button` "Project", `group` "Agent options" with `button`s "Agent: …", "Model: …",
"Effort: …", "Permission mode: …".
-->
<script lang="ts">
  import { tick, untrack } from 'svelte'
  import type { CoreApi, LaunchOptions, Project, ResultOf, ValidationProblem } from '@kea/protocol'
  import { Menu, type MenuItem } from '@kea/ui'
  import { pathForFile } from '../../lib/bridge.ts'
  import { External } from '../../lib/reactive.svelte.ts'
  import { call } from '../../lib/rpc.ts'
  import { orderProjects } from '../sessions/model.ts'
  import { closeComposer, failed, openComposer, projects, selectSession, ui } from '../sessions/state.svelte.ts'
  import { settings } from '../settings/store.ts'
  import ConditionNote from '../status/ConditionNote.svelte'
  import { agentList, agents, installAgents } from './agents.ts'
  import { drafts } from './drafts.ts'
  import './composer.css'
  import { primaryDown, primaryHeld, primaryLabel } from '../commands/keys.ts'
  import { claimSelectorKeys, type Selector } from './keys.ts'
  import { afterStart, agentLabel, agentProblem, applicable, createArgs, duplicateDraft, fitConfig, insertPaths, isolationDefault, isolationLockReason, knobs, shownModel, startBlocker, validateArgs, withAgent, type Draft } from './state.ts'

  installAgents()
  // values() is the list as of its last structural change; each row is read fresh (a model list or notice may change)
  const agentRows = new External(agents.subscribeAny, () => agentList(agents.values().map((a) => agents.get(a.id) ?? a)))

  type Bases = ResultOf<CoreApi, 'sessions.bases'>
  type Validation = ResultOf<CoreApi, 'sessions.validate'>

  let { project, pickProject }: { project: Project; pickProject: boolean } = $props()

  // the project is the same for this mount (Composer.svelte is keyed by it); its row's other fields may change
  const projectId = untrack(() => project.id)
  const seed = $derived(ui.composerSeed?.projectId === projectId ? ui.composerSeed : null)
  let draft = $state.raw<Draft>(
    untrack(() => {
      const s = ui.composerSeed?.projectId === projectId ? ui.composerSeed : null
      return s?.draft ? duplicateDraft(s.draft, project) : drafts.get(projectId, project, settings.get<string>('general.defaultAgent'))
    }),
  )
  let bases = $state.raw<Bases | null>(null)
  let validation = $state.raw<Validation | null>(null)
  let started = $state.raw<{ id: string; slug: string } | null>(null)
  type MenuKind = 'project' | 'base' | Selector
  let menu = $state.raw<{ kind: MenuKind; at: { x: number; y: number } } | null>(null)
  // the open menu's kind, kept after it closes: a menu closes first, then reports the pick (Menu.svelte)
  let menuKind: MenuKind = 'project'
  let sectionEl: HTMLElement | undefined = $state()
  const selectorEls: Partial<Record<Selector, HTMLButtonElement>> = {} // read only by the ⌘1…4 claim
  let customModel = $state(false)
  // The choices made for each agent in this draft, so switching back restores them
  const perAgent = new Map<string, LaunchOptions>() // bounded: one per registered agent, released with the mount
  let starting = $state(false)
  let promptEl: HTMLTextAreaElement | undefined = $state()
  let projectBtn: HTMLButtonElement | undefined = $state()
  const note = $derived(seed?.note ?? null)

  function setDraft(d: Draft): void {
    draft = d
    drafts.set(projectId, d)
  }

  // a Duplicate's draft is taken once (its isolation is this draft's only)
  untrack(() => {
    if (seed?.draft) drafts.set(projectId, draft)
  })

  // The prompt has focus when the composer opens, and again on ⌘N while it is open; ⌘⇧N opens the project picker
  $effect(() => {
    const pick = pickProject
    void ui.composerFocus
    untrack(() => {
      if (pick && projectBtn) {
        const r = projectBtn.getBoundingClientRect()
        menuKind = 'project'
        menu = { kind: 'project', at: { x: r.left, y: r.bottom } }
      } else promptEl?.focus()
    })
  })

  // the Base list for this project
  const isGit = $derived(project.isGit)
  $effect(() => {
    if (!isGit) return
    let live = true
    call('sessions.bases', { projectId })
      .then((b) => {
        if (live) bases = b
      })
      .catch(() => {
        if (live) bases = null
      })
    return () => {
      live = false
    }
  })

  // Validate the current draft, one request in flight; a newer draft is sent when it returns
  let inflight = false
  let sent = ''
  function validate(): void {
    const d = draft
    const key = JSON.stringify(validateArgs(projectId, d))
    if (key === sent || inflight) return
    inflight = true
    sent = key
    call('sessions.validate', validateArgs(projectId, d))
      .then((v) => {
        if (JSON.stringify(validateArgs(projectId, draft)) === key) validation = v
      })
      .catch(() => undefined)
      .finally(() => {
        inflight = false
        validate()
      })
  }
  $effect(() => {
    void draft
    untrack(validate)
  })

  // the agent and its knobs: core's cached detection; nothing here waits for it
  const info = $derived(agentRows.current.find((a) => a.id === draft.agent))
  const config = $derived(info ? fitConfig(draft.config, info) : draft.config)
  const k = $derived(knobs(info, config))
  const model = $derived(shownModel(info, config))
  const mode = $derived(k.modes.find((m) => m.id === config.permissionMode) ?? k.modes.find((m) => m.id === info?.defaults.permissionMode) ?? null)
  // before core's store first arrives (a fraction of a second at launch) nothing is known yet, so nothing is wrong
  const agentProb = $derived(agentRows.current.length === 0 ? null : agentProblem(info, draft.agent))

  const locked = $derived(isolationDefault(project).locked)
  const problems: ValidationProblem[] = $derived([...(agentProb ? [agentProb] : []), ...(validation ? applicable(validation.problems, draft).filter((p) => p.code !== 'agentMissing') : [])])
  const blocker = $derived(agentProb?.hard ? agentProb.message : startBlocker(validation?.problems ?? [], draft))
  const autoBranch = $derived(validation?.branch ?? '')
  const branchShown = $derived(draft.branch ?? autoBranch)

  /**
   * "Initialise git…": `git init` and one empty commit; the project becomes a git project and the draft stays in place
   * until the toggle is turned on. Without a git identity the commit is not made, and the "no commit yet" problem says
   * what a worktree needs.
   */
  let initialising = $state(false)
  let initEl: HTMLButtonElement | undefined = $state()
  let worktreeEl: HTMLInputElement | undefined = $state()
  async function initGit(): Promise<void> {
    // one at a time: while git runs the button stays pressable in its place (`aria-disabled`), so it keeps the keyboard
    if (initialising) return
    initialising = true
    try {
      await call('projects.initGit', { id: projectId })
    } catch (e) {
      // the message says how far it got: nothing done, or the repository made without its first commit
      failed('Initialise git', e)
    } finally {
      initialising = false
    }
  }

  // the button goes once the folder is a repository. If it held the keyboard, the Worktree switch beside it, which it
  // has just unlocked, takes it (the prompt where the switch stays locked: a bare repository): never nothing
  $effect.pre(() => {
    if (!isGit) return
    untrack(() => {
      if (!initEl || document.activeElement !== initEl) return
      void tick().then(() => (worktreeEl && !worktreeEl.disabled ? worktreeEl : promptEl)?.focus())
    })
  })

  async function start(background: boolean): Promise<void> {
    // one at a time, from the button or ⌘↵: the button is not `disabled` meanwhile (it keeps the keyboard)
    if (blocker || starting) return
    starting = true
    try {
      const r = await call('sessions.create', createArgs(projectId, { ...draft, config }))
      // The choices live on in lastLaunch; the draft goes. A background start keeps the composer open
      const next = afterStart(drafts, projectId, draft, background)
      if (next) {
        draft = next
        started = { id: r.sessionId, slug: r.slug }
        promptEl?.focus()
      } else selectSession(r.sessionId, { arriving: true })
    } catch (e) {
      failed("Couldn't start the session", e)
    } finally {
      starting = false
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && primaryHeld(e)) {
      e.preventDefault()
      void start(e.altKey)
    } else if (e.key === 'Escape' && !e.metaKey && !e.altKey && !e.ctrlKey) {
      e.preventDefault()
      closeComposer()
    }
  }

  function insertFiles(files: FileList | null | undefined, el: HTMLTextAreaElement): boolean {
    const paths = [...(files ?? [])].map(pathForFile).filter(Boolean)
    if (paths.length === 0) return false
    const r = insertPaths(draft.prompt, el.selectionStart, el.selectionEnd, paths, project.rootPath)
    setDraft({ ...draft, prompt: r.text })
    requestAnimationFrame(() => el.setSelectionRange(r.caret, r.caret))
    return true
  }

  function baseLabel(d: Draft, b: Bases | null): string {
    switch (d.base.kind) {
      case 'default': {
        // the project's row knows its default branch before the bases arrive: the label does not change under the eye
        const name = b?.defaultBranch ?? project.defaultBranch
        return name ? `${name} (fresh)` : 'default branch (fresh)'
      }
      case 'head':
        return b?.head ? `HEAD · ${b.head}` : 'current HEAD'
      case 'ref':
        return d.base.ref ?? ''
      case 'existing':
        return `existing ${d.base.ref ?? ''}`
    }
  }

  /** The projects as the picker lists them when it opens. */
  function projectItems(): MenuItem[] {
    return orderProjects(projects.values()).map((p) => ({ id: p.id, label: p.name, ...(p.missing ? { disabled: true } : {}) }))
  }
  const baseItems: MenuItem[] = $derived([
    { id: 'default', label: bases?.defaultBranch ? `${bases.defaultBranch} (default, fresh)` : 'Default branch (fresh)' },
    ...(bases?.head ? [{ id: 'head', label: `Current HEAD · ${bases.head}` }] : []),
    ...(bases?.refs ?? []).map((r) => ({ id: `ref:${r.name}`, label: r.kind === 'tag' ? `${r.name} (tag)` : r.name })),
  ])

  function openMenu(kind: MenuKind, e: MouseEvent & { currentTarget: HTMLButtonElement }): void {
    openAt(kind, e.currentTarget)
  }

  function openAt(kind: MenuKind, el: HTMLElement): void {
    const r = el.getBoundingClientRect()
    menuKind = kind
    menu = { kind, at: { x: r.left, y: r.bottom } }
  }

  // ⌘1…⌘4 open the selectors while the keyboard is in the composer (a hidden knob's key does nothing)
  $effect(() =>
    claimSelectorKeys({
      active: () => !!sectionEl && sectionEl.contains(document.activeElement),
      open: (s) => {
        const el = selectorEls[s]
        if (el) openAt(s, el)
      },
    }),
  )

  function setConfig(c: LaunchOptions): void {
    setDraft({ ...draft, config: c })
  }

  async function copyInstall(command: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(command)
    } catch (e) {
      failed("Couldn't copy the install command", e)
    }
  }

  function agentItems(): MenuItem[] {
    // a missing CLI is listed greyed, and choosing it still copies its install command
    return agentRows.current.map((a) => ({ id: a.id, label: agentLabel(a), ...(a.state === 'missing' ? { muted: true, reason: `${a.displayName} is not installed` } : {}) }))
  }
  function modelItems(): MenuItem[] {
    const items: MenuItem[] = k.models.map((m) => ({ id: m.id, label: m.label }))
    if (info?.options.allowCustomModel) items.push({ id: '\u0000custom', label: 'Custom model…' })
    return items
  }
  function effortItems(): MenuItem[] {
    return [{ id: '', label: 'Model default' }, ...k.efforts.map((e) => ({ id: e, label: e }))]
  }
  function modeItems(): MenuItem[] {
    return k.modes.map((m) => ({ id: m.id, label: m.label, ...(m.dangerous ? { danger: true } : {}) }))
  }
  function menuItems(kind: MenuKind): MenuItem[] {
    switch (kind) {
      case 'project':
        return projectItems()
      case 'base':
        return baseItems
      case 'agent':
        return agentItems()
      case 'model':
        return modelItems()
      case 'effort':
        return effortItems()
      case 'mode':
        return modeItems()
    }
  }
  const MENU_LABELS: Record<MenuKind, string> = { project: 'Projects', base: 'Base branch', agent: 'Agent', model: 'Model', effort: 'Effort', mode: 'Permission mode' }

  function pick(id: string): void {
    if (menuKind === 'project') {
      if (id !== projectId) openComposer(id)
      return
    }
    if (menuKind === 'agent') {
      const next = agentRows.current.find((a) => a.id === id)
      // a missing CLI's row copies its install command; the agent is still chosen, and Start says why not
      if (next?.state === 'missing' && next.installCommand) void copyInstall(next.installCommand)
      if (id === draft.agent) return
      perAgent.set(draft.agent, config)
      setDraft(withAgent(draft, next, id, project.settings.lastLaunch, perAgent.get(id)))
      return
    }
    if (menuKind === 'model') {
      if (id === '\u0000custom') {
        customModel = true
        return
      }
      setConfig(fitConfig({ ...config, model: id }, info))
      return
    }
    if (menuKind === 'effort') {
      const { effort: _drop, ...rest } = config
      setConfig(id ? { ...rest, effort: id } : rest)
      return
    }
    if (menuKind === 'mode') {
      setConfig({ ...config, permissionMode: id })
      return
    }
    const base = id === 'default' ? { kind: 'default' as const } : id === 'head' ? { kind: 'head' as const } : { kind: 'ref' as const, ref: id.slice('ref:'.length) }
    setDraft({ ...draft, base })
  }
</script>

<!-- svelte-ignore a11y_no_redundant_roles, a11y_no_noninteractive_element_interactions (tests find the composer by this
  role; the keydown is the composer's ⌘↩ and Escape, caught as they bubble from its fields) -->
<section class="composer" role="region" aria-label="New session" onkeydown={onKeyDown} bind:this={sectionEl}>
  <h1 class="composer-heading">
    New session in <button bind:this={projectBtn} class="quiet-button composer-project" aria-haspopup="menu" aria-label={`Project: ${project.name}`} onclick={(e) => openMenu('project', e)}>{project.name} ▾</button>
  </h1>
  {#if note}
    <p class="composer-note">{note}</p>
  {/if}
  <div class="composer-box">
    <textarea
      bind:this={promptEl}
      class="composer-prompt"
      aria-label="Prompt"
      placeholder="Describe the task…"
      value={draft.prompt}
      spellcheck="false"
      oninput={(e) => setDraft({ ...draft, prompt: e.currentTarget.value })}
      onpaste={(e) => {
        if (e.clipboardData?.files.length && insertFiles(e.clipboardData.files, e.currentTarget)) e.preventDefault()
      }}
      ondragover={(e) => {
        if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
      }}
      ondrop={(e) => {
        if (insertFiles(e.dataTransfer?.files, e.currentTarget)) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    ></textarea>
    <div class="composer-selectors" role="group" aria-label="Agent options">
      <button bind:this={selectorEls.agent} class="quiet-button" aria-haspopup="menu" aria-label={`Agent: ${info?.displayName ?? draft.agent}`} data-tip="Agent" data-tip-key={primaryLabel('1')} onclick={(e) => openMenu('agent', e)}>{info?.displayName ?? draft.agent} ▾</button>
      {#if customModel}
        <input
          class="composer-model"
          aria-label="Model id"
          placeholder="model id"
          spellcheck="false"
          value={config.model ?? ''}
          onkeydown={(e) => {
            if (e.key === 'Enter' && !primaryDown(e)) {
              e.preventDefault()
              const v = e.currentTarget.value.trim()
              customModel = false
              setConfig(fitConfig(v ? { ...config, model: v } : { ...config, model: undefined }, info))
              requestAnimationFrame(() => promptEl?.focus())
            } else if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              customModel = false
              requestAnimationFrame(() => promptEl?.focus())
            }
          }}
        />
      {:else if k.models.length > 0 || info?.options.allowCustomModel}
        <button bind:this={selectorEls.model} class="quiet-button" aria-haspopup="menu" aria-label={`Model: ${model ?? 'default'}`} data-tip="Model" data-tip-key={primaryLabel('2')} onclick={(e) => openMenu('model', e)}>{k.models.find((m) => m.id === model)?.label ?? model ?? 'default'} ▾</button>
      {/if}
      {#if k.efforts.length > 0}
        <button bind:this={selectorEls.effort} class="quiet-button" aria-haspopup="menu" aria-label={`Effort: ${config.effort ?? 'model default'}`} data-tip="Effort" data-tip-key={primaryLabel('3')} onclick={(e) => openMenu('effort', e)}>{config.effort ?? 'Model default'} ▾</button>
      {/if}
      {#if k.modes.length > 0}
        <button bind:this={selectorEls.mode} class="quiet-button{mode?.dangerous ? ' danger-text' : ''}" aria-haspopup="menu" aria-label={`Permission mode: ${mode?.label ?? 'default'}`} data-tip="Permission mode" data-tip-key={primaryLabel('4')} onclick={(e) => openMenu('mode', e)}>{mode?.label ?? 'Default mode'} ▾</button>
      {/if}
    </div>
  </div>
  <!-- The chosen agent's account condition, if any; it blocks nothing -->
  <ConditionNote agent={draft.agent} />
  <div class="composer-footer">
    {#if draft.isolation === 'worktree'}
      <button class="quiet-button" aria-haspopup="menu" aria-label={`Base branch: ${baseLabel(draft, bases)}`} onclick={(e) => openMenu('base', e)}>⎇ from {baseLabel(draft, bases)} ▾</button>
    {:else}
      <span class="composer-inplace">In place · {bases?.head ?? project.defaultBranch ?? project.rootPath.split('/').pop()}</span>
    {/if}
    <label class="composer-toggle{locked ? ' locked' : ''}" data-tip={isolationLockReason(project) ?? undefined}>
      <input
        bind:this={worktreeEl}
        type="checkbox"
        role="switch"
        aria-label="Worktree"
        checked={draft.isolation === 'worktree'}
        disabled={locked}
        onchange={(e) => setDraft({ ...draft, isolation: e.currentTarget.checked ? 'worktree' : 'inplace' })}
      />Worktree
    </label>
    {#if !project.isGit}
      <!-- One click runs git init in the project's folder and makes one empty commit. While git runs it
        keeps its place and the keyboard (a `disabled` button drops the focus to nothing, and the composer's Esc with it) -->
      <button bind:this={initEl} class="link-button" aria-disabled={initialising} onclick={() => void initGit()}>Initialise git…</button>
    {/if}
    {#if draft.isolation === 'worktree'}
      <input
        class="composer-branch"
        aria-label="Branch name"
        value={branchShown}
        placeholder={autoBranch}
        spellcheck="false"
        oninput={(e) => setDraft({ ...draft, branch: e.currentTarget.value === autoBranch ? null : e.currentTarget.value })}
      />
    {/if}
    <span class="composer-spacer"></span>
    <!-- A blocked Start says why as its tooltip. The tip is on the wrapper: a disabled button has none of its own.
      While a session is being started the button keeps its place and the keyboard (`aria-disabled`, and `start` lets
      one through at a time): a `disabled` button under the focus drops the keyboard to nothing -->
    <!-- svelte-ignore a11y_role_supports_aria_props_implicit (Chromium exposes aria-description on any role) -->
    <span class="composer-start" data-tip={blocker ?? 'Start in the background'} data-tip-key={blocker ? undefined : primaryLabel('enter', true)}>
      <button class="primary-button" aria-label="Start" aria-description={blocker ?? undefined} disabled={!!blocker} aria-disabled={starting} onclick={() => void start(false)}>Start <kbd>{primaryLabel('enter')}</kbd></button>
    </span>
  </div>
  {#if problems.length > 0}
    <ul class="composer-problems" aria-label="Problems">
      {#each problems as p (p.code)}
        <li class={p.hard ? 'hard' : undefined}><span>{p.message}</span>{#if p.code === 'branchExists' && p.suggestion}<button class="link-button" onclick={() => setDraft({ ...draft, branch: p.suggestion ?? null })}>Use {p.suggestion}</button>{/if}{#if p.code === 'branchExists'}<button class="link-button" onclick={() => setDraft({ ...draft, base: { kind: 'existing', ref: branchShown }, branch: null })}>Use the existing branch</button>{/if}{#if p.code === 'branchCheckedOut' && p.sessionId}<button class="link-button" onclick={() => selectSession(p.sessionId!)}>Open that session</button>{/if}{#if p.code === 'agentMissing' && p.hard && p.suggestion}{@const cmd = p.suggestion}<button class="link-button" onclick={() => void copyInstall(cmd)}>Copy install command</button>{/if}</li>
      {/each}
    </ul>
  {/if}
  {#if started}
    {@const s = started}
    <p class="composer-started" role="status">Started <button class="link-button" onclick={() => selectSession(s.id)}>{s.slug}</button></p>
  {/if}
  {#if menu}
    <Menu
      label={MENU_LABELS[menu.kind]}
      items={menuItems(menu.kind)}
      at={menu.at}
      onClose={() => {
        menu = null
        // Back to the prompt, unless another selector was opened meanwhile (⌘2 right after Esc): its menu keeps the keyboard
        requestAnimationFrame(() => {
          if (!menu) promptEl?.focus()
        })
      }}
      onPick={pick}
    />
  {/if}
</section>
