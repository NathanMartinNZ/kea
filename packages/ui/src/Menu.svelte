<!--
A floating menu: context menus, the header overflow and the composer's pickers. Drawn with the floating-surface tokens
(`--surface-4`, `--radius-lg`, `--shadow-float`), `--space-1` inner padding and `--size-row` rows; it fades in over
`--motion-float-in` and goes at once. Keyboard first: it opens with the first enabled item focused, ↑ ↓ Home End and a
typed letter move (menuNav.ts), ↵ or Space chooses, Esc or Tab closes, and closing gives focus back to where it was. A
pointer press outside closes it too. The focused item is shown by its highlight, as in a native menu, not by a focus
ring. A disabled item is skipped, and says why in its tooltip and accessible description (`reason`). A `muted` item is
greyed the same way but stays in the keyboard order and can be chosen.
Locatable as `role=menu` named by `label`, items as
`role=menuitem`.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { ariaShortcut, firstEnabled, menuMove, type MenuProps } from './menuNav.ts'

  let p: MenuProps = $props()
  let el: HTMLDivElement | undefined = $state()
  let current = $state(untrack(() => firstEnabled(p.items)))
  let pos = $state(untrack(() => p.at))
  // the element focused before the menu gets focus back when it closes
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null

  // keep it inside the window (measured once laid out, before paint); `end` puts its right edge at the point
  $effect(() => {
    const at = { x: p.at.x, y: p.at.y }
    const end = p.align === 'end'
    untrack(() => {
      if (!el) return
      const r = el.getBoundingClientRect()
      const x = Math.max(0, Math.min(end ? at.x - r.width : at.x, window.innerWidth - r.width))
      const y = Math.max(0, Math.min(at.y, window.innerHeight - r.height))
      if (x !== pos.x || y !== pos.y) pos = { x, y }
    })
  })

  $effect(() => () => {
    if (before?.isConnected) before.focus({ preventScroll: true })
  })

  // focus follows the current item
  $effect(() => {
    const t = el?.querySelector<HTMLElement>(`[data-index="${current}"]`) ?? el
    t?.focus({ preventScroll: true })
  })

  // a press anywhere else closes it
  $effect(() => {
    const onDown = (e: PointerEvent) => {
      if (el && e.target instanceof Node && !el.contains(e.target)) p.onClose()
    }
    const onBlur = () => p.onClose()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
    }
  })

  function pick(i: number): void {
    const it = p.items[i]
    if (!it || it.disabled) return
    // read before closing: the owner's props may be computed from the state the close clears
    const onPick = p.onPick
    p.onClose()
    onPick(it.id)
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      p.onClose()
      return
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      pick(current)
      return
    }
    const next = menuMove(p.items, current, e.key)
    if (next !== current || ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || [...e.key].length === 1) {
      e.preventDefault()
      e.stopPropagation()
      current = next
    }
  }
</script>

<div
  bind:this={el}
  class="kea-menu"
  role="menu"
  aria-label={p.label}
  tabindex="-1"
  style:left="{pos.x}px"
  style:top="{pos.y}px"
  onkeydown={onKeyDown}
  oncontextmenu={(e) => e.preventDefault()}
>
  {#each p.items as it, i (it.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_role_supports_aria_props (the menu's keydown handles Enter and
      Space for the current item; Chromium exposes aria-description on any role) -->
    <div
      role="menuitem"
      data-index={i}
      data-command={it.id}
      tabindex="-1"
      aria-disabled={it.disabled || undefined}
      aria-description={it.disabled || it.muted ? it.reason : undefined}
      data-tip={it.disabled ? it.reason : undefined}
      aria-keyshortcuts={it.shortcut ? ariaShortcut(it.shortcut) : undefined}
      class="kea-menu-item{it.danger ? ' danger' : ''}{it.muted ? ' muted' : ''}{i === current ? ' current' : ''}"
      onpointermove={() => {
        if (!it.disabled && i !== current) current = i
      }}
      onclick={() => pick(i)}
    >
      <span class="kea-menu-label">{it.label}</span>
      {#if it.shortcut}
        <kbd class="kea-menu-kbd">{it.shortcut}</kbd>
      {/if}
    </div>
  {/each}
</div>
