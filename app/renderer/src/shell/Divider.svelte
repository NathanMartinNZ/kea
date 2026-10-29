<!--
A divider between two columns, or between the work pane and the agent pane (`agent`): a 1 px line with a
`--size-divider-hit` hit area. Drag to resize (persisted once, at the drag's end), double-click to reset, ← → to step
when focused. Locatable as `separator` "Resize sidebar" / "Resize file panel" / "Resize agent pane" with its column's or
pane's width as its value. While the split is drawn the side dividers stop where the main column would no longer hold
it, and say why; no mode changes while any divider is dragged (`layoutState.resizing`).
-->
<script lang="ts">
  import { SIZE_PX } from '@kea/ui/tokens'
  import { dragAgent, dragTo, drawn, mainWidth, RANGE, resetAgentWidth, resetWidth, splitNeed, stepAgent, stepWidth, type Column } from './layout.ts'
  import { cellWidth, layoutState, setLayout } from './layoutStore.svelte.ts'

  let { column, x, label, splitDrawn = false }: { column: Column | 'agent'; x: number; label: string; splitDrawn?: boolean } = $props()
  let drag: { from: number; startX: number } | null = null
  const cell = () => cellWidth(layoutState.layout)
  const main = () => mainWidth(layoutState.layout, layoutState.width)
  const width = (c: Column | 'agent') => (c === 'agent' ? (layoutState.split?.agent ?? 0) : drawn(layoutState.layout, layoutState.width)[c])
  /** What the main column keeps while a side column is dragged: the split's need while it is drawn. */
  const mainMin = () => (splitDrawn ? splitNeed(cell()).total : SIZE_PX['main-min'])
  const range = $derived.by(() => {
    if (column !== 'agent') return RANGE[column]
    const need = splitNeed(cell())
    return { min: need.agent, max: Math.max(need.agent, main() - need.work) }
  })
  const value = $derived(column === 'agent' ? width('agent') : x - (column === 'tree' ? width('sidebar') : 0))
  // a side divider at the split's stop says why it goes no further
  const stopped = $derived(column !== 'agent' && splitDrawn && main() <= splitNeed(cell()).total)

  function onPointerDown(e: PointerEvent & { currentTarget: HTMLDivElement }): void {
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag = { from: width(column), startX: e.clientX }
    layoutState.resizing = true
  }

  function onPointerMove(e: PointerEvent): void {
    const g = drag
    if (!g) return
    const { layout, width: w } = layoutState
    const dx = e.clientX - g.startX
    const next = column === 'agent' ? dragAgent(layout, g.from, dx, main(), cell()) : dragTo(layout, column, g.from, dx, w, mainMin())
    if (next !== layout) layoutState.layout = next
  }

  function onPointerUp(e: PointerEvent & { currentTarget: HTMLDivElement }): void {
    if (!drag) return
    drag = null
    e.currentTarget.releasePointerCapture(e.pointerId)
    layoutState.resizing = false
    // persisted once, when the drag ends
    setLayout((l) => ({ ...l }))
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const dir = e.key === 'ArrowLeft' ? -1 : 1
    setLayout((l) => (column === 'agent' ? stepAgent(l, dir, main(), cell()) : stepWidth(l, column, dir, layoutState.width, mainMin())))
  }

  function reset(): void {
    setLayout((l) => (column === 'agent' ? resetAgentWidth(l) : resetWidth(l, column)))
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a focusable separator
  with a value is a splitter, an interactive widget in WAI-ARIA; Svelte's role table counts every separator as static) -->
<div
  class="divider"
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={value}
  aria-valuemin={range.min}
  aria-valuemax={range.max}
  tabindex="0"
  data-tip={stopped ? 'Narrower would put the agent in a tab' : undefined}
  style:left="{x}px"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  ondblclick={reset}
  onkeydown={onKeyDown}
></div>
