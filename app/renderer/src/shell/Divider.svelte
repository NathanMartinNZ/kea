<!--
A divider between two columns: a 1 px line with a `--size-divider-hit` hit area. Drag to resize (persisted once, at the
drag's end), double-click to reset, ← → to step when focused. Locatable as `separator` "Resize sidebar" / "Resize file
panel" with its column's width as its value.
-->
<script lang="ts">
  import { drawn, dragTo, RANGE, resetWidth, stepWidth, type Column } from './layout.ts'
  import { layoutState, setLayout } from './layoutStore.svelte.ts'

  let { column, x, label }: { column: Column; x: number; label: string } = $props()
  let drag: { from: number; startX: number } | null = null
  const width = (c: Column) => drawn(layoutState.layout, layoutState.width)[c]

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
    const next = dragTo(layout, column, g.from, e.clientX - g.startX, w)
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
    setLayout((l) => stepWidth(l, column, e.key === 'ArrowLeft' ? -1 : 1, layoutState.width))
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (a focusable separator
  with a value is a splitter, an interactive widget in WAI-ARIA; Svelte's role table counts every separator as static) -->
<div
  class="divider"
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-valuenow={x - (column === 'tree' ? width('sidebar') : 0)}
  aria-valuemin={RANGE[column].min}
  aria-valuemax={RANGE[column].max}
  tabindex="0"
  style:left="{x}px"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  ondblclick={() => setLayout((l) => resetWidth(l, column))}
  onkeydown={onKeyDown}
></div>
