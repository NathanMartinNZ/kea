<!--
The command palette: one floating layer, `--size-palette` wide near the top of the window, one input over one list of
rows (`--size-palette-row` high). `⌘⇧P` opens it over everything; `⌘P` opens it in file mode, which is the file finder
(`features/files/FinderResults.svelte`).

  text          sessions, commands and projects matched together, ranked, laid out as Sessions · Actions · Projects
  > text        commands only            / text   files of the session on screen
  ↵             a session: show it · a command: run it · a project: a new session there · a file: the preview tab
  ⌘↵            the other action: a session or a file in the editor       ⌥↵   a file's path at the prompt
  ↑ ↓           move (they wrap); PageUp PageDown go to the ends                  Esc  close, the keyboard back where it was

An empty query lists the sessions that need you, the recent ones and the most-used commands. A command that cannot run
now is listed dimmed with its reason, and with what `↵` does instead where there is something ("Set a run command…" on
the dev server's commands when there is nothing to run). A command that needs an argument lists its choices here in
place of a dialog: Backspace in the empty input goes back to the commands.

Locatable as `role=dialog` "Command Palette" (`combobox` "Command palette", `listbox` "Results" with one `group` per
section — "Sessions", "Actions", "Projects", or the command whose argument is being chosen — of `option`s carrying
`data-kind` and `data-id`, `aria-disabled` and `data-reason` on a command that cannot run, each key a `kbd`). In file
mode it is the finder: `dialog` "Go to File", `combobox` "Go to file", `listbox` "Files".
-->
<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { chordLabel } from '@kea/protocol'
  import { StatusGlyph } from '@kea/ui'
  import { bindingsState } from '../commands/bindings.svelte.ts'
  import { modClick, primaryDown } from '../commands/keys.ts'
  import { commands, type ArgumentChoice } from '../commands/registry.ts'
  import FinderResults from '../files/FinderResults.svelte'
  import { activeSessionId, projects, selectSession, sessions } from '../sessions/state.svelte.ts'
  import { markRuns, moveRow, parseQuery, PaletteIndex, sectioned, SECTION_TITLE, type BaseMode, type Candidate } from './model.ts'
  import './palette.css'
  import { PaletteData, type Row } from './data.ts'
  import { closePalette, paletteHolds, paletteSources, paletteTiming, usage } from './state.svelte.ts'
  import { focusMain } from '../../shell/regions.ts'

  let { base, seq }: { base: BaseMode; seq: number } = $props()

  /** A command's argument being chosen. */
  interface Arg {
    id: string
    title: string
    placeholder: string
    choices: readonly ArgumentChoice[]
    loading: boolean
  }

  let input: HTMLInputElement | undefined = $state()
  let list: HTMLDivElement | undefined = $state()
  let query = $state('')
  let rows = $state.raw<readonly Row[]>([])
  let current = $state(0)
  let arg = $state.raw<Arg | null>(null)
  let finder: { key(e: KeyboardEvent): boolean } | undefined = $state()
  let fileActive = $state<string | undefined>()
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
  /** The session on screen when the palette opened: file mode is its files, and the palette goes when it does. */
  const sessionId = untrack(activeSessionId)

  // plain data, never rune state: the index over the sources, made again when they change
  let data = new PaletteData(paletteSources(), usage)
  /** The index over an argument's choices. */
  let choices: PaletteIndex | null = null

  const parsed = $derived(parseQuery(base, query))
  const fileMode = $derived(arg === null && parsed.mode === 'files')
  const sections = $derived(arg ? (rows.length ? [{ id: 'choices' as const, title: arg.title, rows }] : []) : sectioned(rows.map((r) => ({ item: { kind: r.kind }, r }))).map((s) => ({ id: s.id, title: SECTION_TITLE[s.id], rows: s.hits.map((h) => h.r) })))
  /** The rows in the order the sections show them: what ↑ ↓ walk. */
  const order = $derived(sections.flatMap((s) => s.rows))
  const note = $derived.by(() => {
    if (fileMode) return sessionId === null ? 'No session is open: there are no files to find.' : null
    if (arg) return arg.loading ? null : arg.choices.length === 0 ? 'Nothing to choose from.' : rows.length === 0 ? 'No match.' : null
    if (rows.length > 0) return parsed.mode === 'commands' && parsed.needle === '' && data.commandCount > rows.length ? `The ${rows.length} most used of ${data.commandCount} commands. Type to find the others.` : null
    return parsed.needle === '' ? 'Type to find a session, a command or a project.' : 'No match.'
  })

  function choiceRow(c: ArgumentChoice, i: number, marks: readonly number[]): Row {
    return { key: `choice:${i}`, kind: 'choice', id: String(i), title: markRuns(c.label, marks), detail: c.detail ?? null, glyph: null, shortcut: null, disabled: false, remedy: null }
  }

  function compute(): Row[] {
    if (arg) {
      const a = arg
      const needle = query.trim()
      if (needle === '' || !choices) return a.choices.map((c, i) => choiceRow(c, i, []))
      return choices.search(needle).map((h) => choiceRow(a.choices[Number(h.item.id)] as ArgumentChoice, Number(h.item.id), choices!.marks(h, needle)))
    }
    const p = parseQuery(base, query)
    if (p.mode === 'files') return []
    if (p.needle === '') return p.mode === 'commands' ? data.allCommands() : data.empty()
    return data.search(p.needle, { commandsOnly: p.mode === 'commands' })
  }

  /** The list for the input's text now; the first row is current, or the row that was, when it is still listed. */
  function refresh(keep = false): void {
    const was = keep ? order[current]?.key : undefined
    rows = compute()
    paletteHolds.rows = rows.length
    paletteHolds.candidates = data.size
    const at = was === undefined ? -1 : untrack(() => order.findIndex((r) => r.key === was))
    current = at >= 0 ? at : 0
  }

  // opened, or asked for again while open (`⌘⇧P` or `⌘P` pressed again): the keyboard is in the input, its text
  // selected, and the list is the one of how it was asked for
  $effect(() => {
    void seq
    void base
    untrack(() => {
      arg = null
      refresh()
      input?.focus()
      input?.select()
    })
  })

  // the sources changed under the open palette (a session's status, a command's availability, a key): read them again,
  // once per burst
  $effect(() => {
    let scheduled = false
    const stale = (): void => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        data = new PaletteData(paletteSources(), usage)
        refresh(true)
      })
    }
    const offs = [sessions.subscribeAny(stale), projects.subscribeAny(stale), commands.onChange(stale)]
    return () => {
      for (const off of offs) off()
      paletteHolds.rows = 0
      paletteHolds.candidates = 0
    }
  })
  // … or keybindings.json changed while it is open: the chips show the keys now
  let keysAt = untrack(() => bindingsState.version)
  $effect(() => {
    const v = bindingsState.version
    if (v === keysAt) return
    keysAt = v
    untrack(() => {
      data = new PaletteData(paletteSources(), usage)
      refresh(true)
    })
  })

  // the session on screen changed under it (⌃Tab, a session that went): what it listed was that session's
  $effect(() => {
    if (activeSessionId() !== sessionId) untrack(() => close(false))
  })

  // the current row stays in view
  $effect(() => {
    list?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  })

  /**
   * Close. `restore`: the keyboard goes back where it was, or to the main pane when that is gone. Without it the
   * keyboard is nowhere, so whatever the pick opens takes it by its own rules (a terminal shown while nothing has the
   * keyboard takes it; so does a file tab, and the composer's prompt).
   */
  function close(restore: boolean): void {
    closePalette()
    if (!restore) {
      if (document.activeElement === input) input?.blur()
    } else if (before?.isConnected) before.focus({ preventScroll: true })
    else focusMain()
  }

  /**
   * A command runs from where the person was (what it acts on and whether it is available read that), and once it has
   * run the keyboard is in the main pane unless the command put it somewhere itself: a sheet, the composer, the file
   * panel, a find bar.
   */
  function runCommand(id: string, args?: unknown): void {
    close(true)
    usage.ran(id)
    const at = document.activeElement
    commands.run(id, args)
    void tick().then(() => {
      const a = document.activeElement
      if (!a || a === document.body || a === at) focusMain()
    })
  }

  /** The command's argument is chosen here. */
  function askArgument(id: string, a: { placeholder: string; choices(): readonly ArgumentChoice[] | Promise<readonly ArgumentChoice[]> }): void {
    const title = commands.title(id)
    const got = a.choices()
    const show = (list: readonly ArgumentChoice[], loading: boolean): void => {
      arg = { id, title, placeholder: a.placeholder, choices: list, loading }
      choices = new PaletteIndex(list.map((c, i): Candidate => ({ kind: 'choice', id: String(i), fields: c.detail ? [c.label, c.detail] : [c.label], boost: 0 })))
      query = ''
      refresh()
    }
    if (got instanceof Promise) {
      show([], true)
      got.then(
        (list) => {
          if (arg?.id === id && arg.loading) show(list, false)
        },
        () => {
          if (arg?.id === id && arg.loading) show([], false)
        },
      )
    } else show(got, false)
  }

  /** `↵` (or a click) on a row; `alt`: `⌘↵`, the other action where the row has one. */
  function pick(r: Row, alt: boolean): void {
    if (r.kind === 'session') {
      if (alt) {
        // open its folder in the editor; the window stays as it was
        if (commands.available('session.openInEditor', { id: r.id })) {
          close(true)
          commands.run('session.openInEditor', { id: r.id })
        }
        return
      }
      close(false)
      // the session's terminal takes the keyboard as it is shown; the one already on screen is given it
      if (activeSessionId() === r.id) focusMain()
      else selectSession(r.id)
      return
    }
    if (r.kind === 'project') {
      close(false)
      commands.run('session.new', { projectId: r.id })
      return
    }
    if (r.kind === 'choice') {
      const a = arg
      const c = a?.choices[Number(r.id)]
      if (a && c) runCommand(a.id, c.args)
      return
    }
    if (r.disabled) {
      // What the row offers instead
      const remedy = commands.remedy(r.id)
      if (remedy) {
        close(true)
        remedy.run()
      }
      return
    }
    const a = commands.argument(r.id)
    if (a) askArgument(r.id, a)
    else runCommand(r.id)
  }

  /** When a typed key was pressed, for the keystroke probe (P-UI-3). */
  let keyAt = 0

  function onInput(e: Event & { currentTarget: HTMLInputElement }): void {
    query = e.currentTarget.value
    refresh()
    const probe = paletteTiming.keystroke
    if (probe) {
      const from = keyAt || e.timeStamp
      keyAt = 0
      // the end of the update that draws the list (its paint excluded)
      void tick().then(() => probe(performance.now() - from))
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (paletteTiming.keystroke && e.key.length === 1 && !e.metaKey && !e.ctrlKey) keyAt = e.timeStamp
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    // focus stays in the palette while it is open
    if (e.key === 'Tab') {
      e.preventDefault()
      return
    }
    if (arg && e.key === 'Backspace' && query === '') {
      e.preventDefault()
      arg = null
      choices = null
      refresh()
      return
    }
    if (fileMode) {
      if (finder?.key(e)) {
        e.preventDefault()
        e.stopPropagation()
      } else if (e.key === 'Enter') e.preventDefault()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const r = order[current]
      if (r) pick(r, primaryDown(e))
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const next = moveRow(order.length, current, e.key)
    if (next === null) return
    e.preventDefault()
    if (next >= 0) current = next
  }

  // a press outside closes it (the press goes where it was aimed), and so does the keyboard going elsewhere (a key
  // that opened the composer or a sheet under it)
  $effect(() => {
    const el = input?.closest<HTMLElement>('.palette')
    if (!el) return
    const down = (e: PointerEvent): void => {
      if (e.target instanceof Node && !el.contains(e.target)) closePalette()
    }
    const out = (e: FocusEvent): void => {
      if (e.relatedTarget instanceof Node && !el.contains(e.relatedTarget)) closePalette()
    }
    window.addEventListener('pointerdown', down, true)
    el.addEventListener('focusout', out)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      el.removeEventListener('focusout', out)
    }
  })

  const placeholder = $derived(arg ? arg.placeholder : base === 'files' ? 'Go to file…' : 'Search sessions, commands and projects…   > commands   / files')
</script>

<div class="palette" role="dialog" aria-label={fileMode ? 'Go to File' : 'Command Palette'} data-mode={arg ? 'argument' : parsed.mode}>
  <input
    bind:this={input}
    value={query}
    type="text"
    role="combobox"
    aria-label={fileMode ? 'Go to file' : arg ? arg.placeholder : 'Command palette'}
    aria-expanded="true"
    aria-controls={fileMode ? 'finder-list' : 'palette-list'}
    aria-activedescendant={fileMode ? fileActive : order[current] ? `palette-row-${current}` : undefined}
    aria-autocomplete="list"
    {placeholder}
    spellcheck="false"
    autocomplete="off"
    oninput={onInput}
    onkeydown={onKeyDown}
  />
  {#if fileMode}
    {#if sessionId !== null}
      <FinderResults bind:this={finder} bind:active={fileActive} {sessionId} query={parsed.needle} onclose={close} />
    {/if}
  {:else}
    <div bind:this={list} id="palette-list" class="palette-list" role="listbox" aria-label="Results">
      {#each sections as s (s.id)}
        <div class="palette-group" role="group" aria-label={s.title}>
          <div class="palette-section" aria-hidden="true">{s.title}</div>
          {#each s.rows as r (r.key)}
            {@const i = order.indexOf(r)}
            <!-- svelte-ignore a11y_click_events_have_key_events (the input has the keyboard: ↑ ↓ and Enter act on the rows) -->
            <div
              id="palette-row-{i}"
              class="palette-row{i === current ? ' current' : ''}"
              role="option"
              tabindex="-1"
              aria-selected={i === current}
              aria-disabled={r.disabled || undefined}
              data-index={i}
              data-kind={r.kind}
              data-id={r.id}
              data-reason={r.disabled ? (r.detail ?? '') : undefined}
              onpointermove={() => {
                if (i !== current) current = i
              }}
              onclick={(e) => pick(r, modClick(e))}
            >
              {#if r.glyph}<StatusGlyph kind={r.glyph} />{/if}
              <span class="palette-title">{#each r.title as p, k (k)}{#if p.hit}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}</span>
              {#if r.detail}<span class="palette-detail">{r.detail}</span>{/if}
              {#if r.remedy}<span class="palette-remedy"><kbd>{chordLabel('enter')}</kbd> {r.remedy}</span>{/if}
              {#if r.shortcut}<kbd class="palette-kbd">{r.shortcut}</kbd>{/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>
  {/if}
  {#if note}
    <p class="palette-note" role="status">{note}</p>
  {/if}
</div>
