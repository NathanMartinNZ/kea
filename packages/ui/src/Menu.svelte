<!--
A floating menu: context menus, the header overflow and the composer's pickers. Drawn with the floating-surface tokens
(`--surface-4`, `--radius-lg`, `--shadow-float`), `--space-1` inner padding and `--size-row` rows; it fades in over
`--motion-float-in` and goes at once. Keyboard first: it opens with the first enabled item focused, ↑ ↓ Home End and a
typed letter move (menuNav.ts), ↵ or Space chooses, Esc or Tab closes, and closing gives focus back to where it was,
unless the pick moved it. A pointer press outside closes it too; its own button (`trigger`) closes it with a click.
One menu is open at a time, and the window's root carries `kea-menu-open` while one is. The focused item is shown by
its highlight, as in a native menu, not by a focus ring. A disabled item is skipped, and says why in its tooltip and
accessible description (`reason`). A `muted` item is greyed the same way but stays in the keyboard order and can be
chosen. A separator is a line between groups. A submenu drills down, as GNOME's menus do: choosing it (↵, →, a click)
shows its items in the menu's place after a back row that names the menu it came from (← or Esc goes back).
Locatable as `role=menu` named by `label`, items as `role=menuitem` (a submenu's with `aria-haspopup`), separators as
`role=separator`.
-->
<script module lang="ts">
  import { OpenMenus } from './menuNav.ts'

  let menus: OpenMenus<HTMLElement> | null = null
  /** The window's open menus, made at the first opening (a module of a server render has no document). */
  const openMenus = (): OpenMenus<HTMLElement> => (menus ??= new OpenMenus<HTMLElement>(document.documentElement))
</script>

<script lang="ts">
  import { untrack } from 'svelte'
  import { ariaShortcut, drillKey, levelItems, levelStart, MENU_BACK, menuMove, pressCloses, restoresFocus, type MenuProps } from './menuNav.ts'

  let p: MenuProps = $props()
  let el: HTMLDivElement | undefined = $state()
  /** The submenus gone into, from the top level: each one's index among its own menu's items. */
  let path = $state.raw<number[]>([])
  const level = $derived(levelItems(p.items, path))
  const shown = $derived(level.items)
  let current = $state(untrack(() => levelStart(p.items, 0)))
  let pos = $state(untrack(() => p.at))
  // the element focused before the menu gets focus back when it closes, unless focus has gone elsewhere since; opened in
  // another menu's place, it gives focus back where that one would have
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let before: HTMLElement | null = opener
  const triggerEl = (): Element | null => (p.trigger ? document.querySelector(p.trigger) : null)

  // keep it inside the window (measured once laid out, before paint, and again for each level shown); `end` puts its
  // right edge at the point
  $effect(() => {
    const at = { x: p.at.x, y: p.at.y }
    const end = p.align === 'end'
    void shown
    untrack(() => {
      if (!el) return
      const r = el.getBoundingClientRect()
      const x = Math.max(0, Math.min(end ? at.x - r.width : at.x, window.innerWidth - r.width))
      const y = Math.max(0, Math.min(at.y, window.innerHeight - r.height))
      if (x !== pos.x || y !== pos.y) pos = { x, y }
    })
  })

  // one menu at a time; the effect's teardown runs once the menu's elements are gone
  $effect(() => {
    const open = openMenus().opened(() => p.onClose(), { before: opener, owns: (n) => n instanceof Node && !!el?.contains(n) })
    before = open.before
    return () => {
      open.gone()
      if (before?.isConnected && restoresFocus(document.activeElement, el ?? null, document.body)) before.focus({ preventScroll: true })
    }
  })

  // focus follows the current item, in the level shown
  $effect(() => {
    void shown
    const t = el?.querySelector<HTMLElement>(`[data-index="${current}"]`) ?? el
    t?.focus({ preventScroll: true })
  })

  // a press anywhere else closes it; a click on its own button closes it before that button's handler can open it again
  $effect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && pressCloses(e.target, el ?? null, triggerEl())) p.onClose()
    }
    const onClick = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !triggerEl()?.contains(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      p.onClose()
    }
    const onBlur = () => p.onClose()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('click', onClick, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('click', onClick, true)
      window.removeEventListener('blur', onBlur)
    }
  })

  /** Into the submenu at `i` of the level shown. */
  function enter(i: number): void {
    const next = [...path, level.depth > 0 ? i - 1 : i]
    path = next
    current = levelStart(levelItems(p.items, next).items, next.length)
  }

  /** Back to the level above, on the submenu that was gone into. */
  function back(): void {
    const from = path.at(-1) ?? 0
    const next = path.slice(0, -1)
    path = next
    current = next.length > 0 ? from + 1 : from
  }

  function pick(i: number): void {
    const it = shown[i]
    if (!it || it.disabled || it.separator) return
    if (it.id === MENU_BACK) return back()
    if (it.submenu) return enter(i)
    // read before closing: the owner's props may be computed from the state the close clears
    const onPick = p.onPick
    p.onClose()
    onPick(it.id)
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const drill = drillKey(e.key, shown[current], level.depth)
    if (drill) {
      e.preventDefault()
      e.stopPropagation()
      if (drill === 'in') enter(current)
      else if (drill === 'back') back()
      else p.onClose()
      return
    }
    if (e.key === 'Tab') {
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
    const next = menuMove(shown, current, e.key)
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
  {#each shown as it, i (it.id)}
    {#if it.separator}
      <div role="separator" class="kea-menu-separator"></div>
    {:else}
      {@const isBack = it.id === MENU_BACK}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_role_supports_aria_props (the menu's keydown handles Enter and
        Space for the current item; Chromium exposes aria-description on any role) -->
      <div
        role="menuitem"
        data-index={i}
        data-command={isBack ? undefined : it.id}
        tabindex="-1"
        aria-label={isBack ? `Back from ${it.label}` : undefined}
        aria-haspopup={it.submenu ? 'menu' : undefined}
        aria-disabled={it.disabled || undefined}
        aria-description={it.disabled || it.muted ? it.reason : undefined}
        data-tip={it.disabled ? it.reason : undefined}
        aria-keyshortcuts={it.shortcut ? ariaShortcut(it.shortcut) : undefined}
        class="kea-menu-item{isBack ? ' back' : ''}{it.danger ? ' danger' : ''}{it.muted ? ' muted' : ''}{i === current ? ' current' : ''}"
        onpointermove={() => {
          if (!it.disabled && i !== current) current = i
        }}
        onclick={() => pick(i)}
      >
        {#if isBack}<span class="kea-menu-chevron" aria-hidden="true">‹</span>{/if}
        <span class="kea-menu-label">{it.label}</span>
        {#if it.submenu}
          <span class="kea-menu-chevron" aria-hidden="true">›</span>
        {:else if it.shortcut}
          <kbd class="kea-menu-kbd">{it.shortcut}</kbd>
        {/if}
      </div>
    {/if}
  {/each}
</div>
