<!--
The file viewer's mount: what the main area shows while the active tab is a file or a diff (`shell/TerminalPane.svelte`
mounts it over the terminal area, whose terminals stay alive underneath). Its props are the contract
(`tab.ts`): one instance serves every tab of its pane, and `tab` changes under it.

This component is the frame only — the header row, the one line of notices, and the place where the body goes. The
document, its tokens and the editors are never here: the controller (`controller.svelte.ts`) reads the tab's
file or diff and puts it into the window's one file-view editor or its diff instance (`editor.ts`, `merge.ts`), which
are attached into this mount's `editor` element while it shows them. What the header says comes back as plain data
(`ctl.ui`).

Keys: `⌘` bindings are the router's. The viewer's own keys (`⌃G`, `⌥Z`, `⌥↓`, `⌥↑`, `]`, `[`) arrive here, and
their command is looked up in the command table's scoped bindings (`scopedBinding`). `Esc` and `↵` are the tab strip's
unless a bar of the viewer uses them (`bars.ts`). The viewer adds the `Markdown file` key scope to the pane's two.
-->
<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { protocolOs } from '@kea/protocol'
  import { terminalFontStack } from '@kea/terminal'
  import './viewer.css'
  import { shortcut } from '../commands/bindings.svelte.ts'
  import { scopedBinding } from '../commands/keys.ts'
  import { commands } from '../commands/registry.ts'
  import { LETTER_NAMES } from '../files/changes.ts'
  import { currentKeyScopes, provideKeyScope } from '../commands/scope.ts'
  import { prefs } from '../terminal/prefs.ts'
  import { copyPath, noteAction, openTabInEditor, switchMode } from './commands.ts'
  import { sizeText, ViewerController, type NoteAction } from './controller.svelte.ts'
  import { fileEditor } from './editor.ts'
  import { installSyntaxStyles } from './highlight.ts'
  import type { ViewerProps } from './tab.ts'

  let { sessionId, tab, onview }: ViewerProps = $props()

  let root: HTMLDivElement | undefined = $state()
  let body: HTMLDivElement | undefined = $state()
  let editorHost: HTMLDivElement | undefined = $state()
  let previewHost: HTMLDivElement | undefined = $state()
  /** An image at its own size instead of scaled to fit (a click toggles it). */
  let actual = $state(false)
  let look = $state.raw(prefs.appearance())

  installSyntaxStyles()

  const ctl = new ViewerController({
    editor: () => editorHost ?? null,
    preview: () => previewHost ?? null,
    focused: () => {
      const a = document.activeElement
      return !!root && (root.contains(a) || a === root.parentElement)
    },
    onview: (view) => onview(view),
  })
  onDestroy(() => ctl.dispose())

  const ui = $derived(ctl.ui)
  const segments = $derived(ui.path.split('/'))
  const editorShown = $derived(ui.body.kind === 'text' || ui.body.kind === 'diff')
  // `Reveal in Finder`, `Reveal in File Manager`
  const NOTE_LABELS: Readonly<Record<NoteAction, string>> = { editor: 'Open in editor', default: 'Open with default app', reveal: `Reveal in ${protocolOs.words.fileManager}` }

  // which tab is on screen, as values: the strip hands over a new `tab` object every time the viewer saves the tab's
  // view (`onview`), and that alone must not show the document again
  const path = $derived(tab.path)
  const mode = $derived(tab.mode)
  const goto = $derived(tab.goto)

  // the tab on screen: a different path, or the same path in the other view
  $effect(() => {
    const s = sessionId
    void path
    void mode
    untrack(() => {
      actual = false
      ctl.show(s, tab)
    })
  })
  // the tab on screen opened again at a position
  $effect(() => {
    const g = goto
    untrack(() => {
      if (g) ctl.goto(g)
    })
  })

  // the terminal's font, size and line height, live
  $effect(() =>
    prefs.subscribe(() => {
      look = prefs.appearance()
      fileEditor()?.requestMeasure()
    }),
  )

  // the pane hands the keyboard to the mount; the document takes it from there
  $effect(() => {
    const mount = root?.parentElement
    if (!mount) return
    const onFocus = (e: FocusEvent) => {
      if (e.target === mount) ctl.focus()
    }
    mount.addEventListener('focus', onFocus)
    return () => mount.removeEventListener('focus', onFocus)
  })

  // a Markdown file's own binding (`⇧⌘V`) applies while the keyboard is in its tab
  $effect(() => provideKeyScope(() => (ctl.ui.canPreview && root?.contains(document.activeElement) ? 'Markdown file' : null)))

  /** The viewer's keys without `⌘`. A field of a bar keeps its plain characters. */
  function onKey(e: KeyboardEvent): void {
    if (e.isComposing || e.metaKey) return
    if (e.target instanceof HTMLInputElement && !e.ctrlKey && !e.altKey) return
    const b = scopedBinding(e, currentKeyScopes())
    if (!b || !commands.available(b.id, b.args)) return
    e.preventDefault()
    e.stopPropagation()
    commands.run(b.id, b.args)
  }

  /** Header controls never take the keyboard from the document. */
  const keepFocus = (e: MouseEvent) => e.preventDefault()

  /** A breadcrumb segment: that folder (or the file itself) in the file tree. */
  function revealInTree(i: number): void {
    commands.run('files.revealInTree', { sessionId, path: segments.slice(0, i + 1).join('/') })
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (the viewer's own keys: the document inside has the keyboard) -->
<div
  bind:this={root}
  class="viewer"
  data-body={ui.body.kind}
  data-language={ui.language ?? ''}
  style:--viewer-font={terminalFontStack(look.fontFamily)}
  style:--viewer-font-size={`${look.fontSize}px`}
  style:--viewer-line-height={String(look.lineHeight)}
  onkeydowncapture={onKey}
>
  <div class="viewer-header">
    {#if ui.mode === 'diff'}
      {#if ui.letter}<span class="viewer-code" data-code={ui.letter} role="img" aria-label={LETTER_NAMES[ui.letter] ?? ui.letter} data-tip={LETTER_NAMES[ui.letter]}>{ui.letter}</span>{/if}
      <!-- cut in its middle: the folders give way, the file's name stays whole -->
      <button class="viewer-path path-mid" aria-label={ui.path} data-tip="Copy path" onmousedown={keepFocus} onclick={() => copyPath(ctl)}><span class="head">{ui.path.slice(0, ui.path.lastIndexOf('/') + 1)}</span><span class="tail">{segments.at(-1)}</span></button>
      {#if ui.counts}
        <span class="viewer-stat" aria-label={`${ui.counts.added} added, ${ui.counts.removed} removed`}><span class="add">+{ui.counts.added}</span> <span class="del">−{ui.counts.removed}</span></span>
      {/if}
    {:else}
      <nav class="viewer-crumbs" aria-label="Path">
        {#each segments as seg, i (i)}
          {#if i > 0}<span class="sep" aria-hidden="true">›</span>{/if}
          <button class={i === segments.length - 1 ? 'crumb last' : 'crumb'} data-command="files.revealInTree" onmousedown={keepFocus} onclick={() => revealInTree(i)}>{seg}</button>
        {/each}
      </nav>
      {#if ui.link}<span class="viewer-quiet" data-tip="Symbolic link">→ {ui.link}</span>{/if}
    {/if}
    <span class="viewer-spacer"></span>
    {#if ui.body.kind === 'image'}
      <span class="viewer-quiet viewer-image-info">{ui.body.width && ui.body.height ? `${ui.body.width} × ${ui.body.height} · ` : ''}{sizeText(ui.size ?? 0)}</span>
    {:else if ui.language && ui.mode === 'file' && editorShown}
      <span class="viewer-quiet viewer-language">{ui.language}</span>
    {/if}
    {#if ui.encoding && editorShown}<span class="viewer-quiet viewer-encoding">{ui.encoding}</span>{/if}
    {#if ui.mode === 'diff' || ui.entry}
      <div class="viewer-switch" role="group" aria-label="File or diff">
        <button aria-pressed={ui.mode === 'file'} onmousedown={keepFocus} onclick={() => switchMode(ctl, 'file')}>File</button>
        <span class="dot" aria-hidden="true">·</span>
        <button aria-pressed={ui.mode === 'diff'} onmousedown={keepFocus} onclick={() => switchMode(ctl, 'diff')}>Diff</button>
      </div>
    {/if}
    {#if ui.canPreview}
      <div class="viewer-switch" role="group" aria-label="Source or preview">
        <button aria-pressed={!ui.preview} onmousedown={keepFocus} onclick={() => ui.preview && ctl.toggleOther()}>Source</button>
        <span class="dot" aria-hidden="true">·</span>
        <button aria-pressed={ui.preview} data-command="viewer.toggleMarkdownPreview" onmousedown={keepFocus} onclick={() => !ui.preview && ctl.toggleOther()}>Preview</button>
      </div>
    {:else if ui.canSource && ui.mode === 'file'}
      <div class="viewer-switch" role="group" aria-label="Image or source">
        <button aria-pressed={!ui.source} onmousedown={keepFocus} onclick={() => ui.source && ctl.toggleOther()}>Image</button>
        <span class="dot" aria-hidden="true">·</span>
        <button aria-pressed={ui.source} onmousedown={keepFocus} onclick={() => !ui.source && ctl.toggleOther()}>Source</button>
      </div>
    {/if}
    {#if ui.body.kind === 'diff'}
      <div class="viewer-switch" role="group" aria-label="Diff layout">
        <button aria-pressed={ui.layout === 'unified'} data-command="viewer.toggleDiffLayout" onmousedown={keepFocus} onclick={() => ui.layout !== 'unified' && ctl.toggleLayout()}>Unified</button>
        <span class="dot" aria-hidden="true">·</span>
        <button aria-pressed={ui.layout === 'split'} data-command="viewer.toggleDiffLayout" onmousedown={keepFocus} onclick={() => ui.layout !== 'split' && ctl.toggleLayout()}>Split</button>
      </div>
    {/if}
    <button class="viewer-open" data-command="viewer.openInEditor" onmousedown={keepFocus} onclick={() => openTabInEditor(ctl)}>Open in editor{#if shortcut('viewer.openInEditor')}<kbd>{shortcut('viewer.openInEditor')}</kbd>{/if}</button>
  </div>
  {#if ui.notices.length > 0}
    <p class="viewer-notice" role="status">{ui.notices.join(' · ')}</p>
  {/if}
  <div bind:this={body} class={ui.deleted ? 'viewer-body deleted' : 'viewer-body'} tabindex="-1">
    <!-- the window's editors are attached here while this mount shows them (editor.ts, merge.ts) -->
    <div bind:this={editorHost} class="viewer-editor" hidden={!editorShown}></div>
    <div bind:this={previewHost} class="viewer-preview" hidden={ui.body.kind !== 'preview'}></div>
    {#if ui.body.kind === 'image'}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions (a pointer convenience: scaled to fit or at its own size) -->
      <div class={actual ? 'viewer-image actual' : 'viewer-image'} onclick={() => (actual = !actual)}>
        <!-- SVG included: an <img> runs no script and loads nothing -->
        <img src={ui.body.url} alt={ui.path} draggable="false" />
      </div>
    {:else if ui.body.kind === 'images'}
      <div class="viewer-images">
        <figure>
          <figcaption>Before</figcaption>
          {#if ui.body.old}<img src={ui.body.old} alt="Before" draggable="false" />{:else}<span class="none">Not there</span>{/if}
        </figure>
        <figure>
          <figcaption>After</figcaption>
          {#if ui.body.new}<img src={ui.body.new} alt="After" draggable="false" />{:else}<span class="none">Not there</span>{/if}
        </figure>
      </div>
    {:else if ui.body.kind === 'note'}
      <p class="viewer-note">
        <span>{ui.body.text}</span>
        {#each ui.body.actions as action (action)}
          <button onmousedown={keepFocus} onclick={() => void noteAction(ctl, action)}>{NOTE_LABELS[action]}</button>
        {/each}
      </p>
    {/if}
  </div>
</div>
