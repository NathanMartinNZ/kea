<!--
The file finder's results (`⌘P`, Go to File…): the list under the palette's input while the palette is in file mode
(`features/palette/Palette.svelte` owns the floating layer, the input and the keyboard, and hands this the query and the
keys it does not use itself).

Every change of the query asks core (`files.find`); core answers only the last query of a burst, and an answer that
is not for what the input says now is dropped. An empty query lists the files opened lately and the changed ones.

  Enter   the file in the viewer's preview tab (`viewer.open`)        ⌘↵   in the editor (`openInEditor`)
  ⌥↵      its relative path, shell-escaped, typed at the session's agent prompt (`sendText`), and the Agent tab shown

`onclose(restore)` closes the palette before a pick acts: `restore` says whether the keyboard goes back where it was
(the viewer takes it itself). `active` is the current row's element id, for the input's `aria-activedescendant`.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { FinderHit } from '@kea/protocol'
  import { call } from '../../lib/rpc.ts'
  import { modClick, primaryDown } from '../commands/keys.ts'
  import { commands } from '../commands/registry.ts'
  import { openInEditor } from '../editor/open.ts'
  import { wantTab } from '../status/viewing.svelte.ts'
  import { sendText } from '../terminal/sendText.ts'
  import { pathsForShell } from '../terminal/shellEscape.ts'
  import { finderMove, finderNote, hitRow, midParts, type Part } from './finder.ts'
  import './files.css'
  import { filesModel } from './model.ts'

  let { sessionId, query, active = $bindable(), onclose }: { sessionId: string; query: string; active?: string | undefined; onclose(restore: boolean): void } = $props()

  let list: HTMLDivElement | undefined = $state()
  let hits = $state.raw<readonly FinderHit[]>([])
  let found = $state.raw({ total: 0, truncated: false })
  let loading = $state(true)
  let current = $state(0)
  /** The last question asked: an answer to an earlier one is not shown. */
  let asked = 0

  const rows = $derived(hits.map(hitRow))
  const note = $derived(finderNote({ hits: hits.length, total: found.total, truncated: found.truncated, query, loading }))

  function ask(q: string): void {
    const n = ++asked
    call('files.find', { sessionId, query: q, recent: filesModel.recent }).then(
      (r) => {
        if (n !== asked || r.superseded) return
        hits = r.hits
        found = { total: r.total, truncated: r.truncated }
        loading = false
        current = 0
      },
      () => {
        if (n !== asked) return
        hits = []
        loading = false
      },
    )
  }

  $effect(() => {
    const q = query
    untrack(() => ask(q))
  })

  $effect(() => {
    active = hits[current] ? `finder-row-${current}` : undefined
  })

  // the current row stays in view
  $effect(() => {
    list?.querySelector<HTMLElement>(`[data-index="${current}"]`)?.scrollIntoView({ block: 'nearest' })
  })

  function choose(path: string, how: 'view' | 'editor' | 'terminal'): void {
    const id = sessionId
    if (how === 'view') {
      // the viewer takes the keyboard
      onclose(false)
      commands.run('viewer.open', { sessionId: id, path, mode: 'file' })
    } else if (how === 'editor') {
      onclose(true)
      void openInEditor({ target: 'session', id, path })
    } else {
      onclose(true)
      void sendText(id, pathsForShell([path])).then((ok) => {
        if (ok) wantTab(id, 'agent')
      })
    }
  }

  /** A key of the palette's input: Enter picks the current row, ↑ ↓ PageUp PageDown move. True when it was used. */
  export function key(e: KeyboardEvent): boolean {
    if (e.key === 'Enter') {
      const hit = hits[current]
      if (hit) choose(hit.path, primaryDown(e) ? 'editor' : e.altKey ? 'terminal' : 'view')
      return true
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return false
    const next = finderMove(hits.length, current, e.key)
    if (next === null) return false
    if (next >= 0) current = next
    return true
  }
</script>

{#snippet runs(parts: readonly Part[])}{#each parts as p, k (k)}{#if p.hit}<mark>{p.text}</mark>{:else}{p.text}{/if}{/each}{/snippet}

<div bind:this={list} id="finder-list" class="finder-list" role="listbox" aria-label="Files">
  {#each rows as row, i (row.path)}
    {@const dir = midParts(row.dir)}
    <!-- svelte-ignore a11y_click_events_have_key_events (the palette's input has the keyboard: ↑ ↓ and Enter act on the rows) -->
    <div
      id="finder-row-{i}"
      class="finder-row{i === current ? ' current' : ''}"
      role="option"
      tabindex="-1"
      aria-selected={i === current}
      data-index={i}
      data-path={row.path}
      onpointermove={() => (current = i)}
      onclick={(e) => choose(row.path, modClick(e) ? 'editor' : e.altKey ? 'terminal' : 'view')}
    >
      <span class="name">{@render runs(row.name)}</span>
      <span class="dir path-mid" data-tip={row.path}><span class="head">{@render runs(dir.head)}</span><span class="tail">{@render runs(dir.tail)}</span></span>
      {#if row.changed}<span class="changed" role="img" aria-label="changed"></span>{/if}
    </div>
  {/each}
</div>
{#if note}
  <p class="finder-note" role="status">{note}</p>
{/if}
