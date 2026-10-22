<!--
The window's one tooltip: micro type on `--surface-4`, after `--motion-tooltip-delay`, with the shortcut. Mounted
once. Controls carry `data-tip` (with `data-tip-key` for a key no command owns), and buttons `data-command`
(tooltip.ts); this listens on the document, so no control has a listener of its own and a control that goes leaves
nothing behind. The pointer resting on such a control, or the keyboard arriving on one, shows its tip after the delay;
leaving it, any key, any press, a scroll or the window losing focus hides it. `resolve(command)` gives a command's title
and its key now, read when the tip shows.

It is a hint for the eye: the control's own accessible name already says what it does and its key, so the tip is
hidden from assistive technology. Locatable as `.kea-tooltip` (its text, and the key in a `kbd`).
-->
<script lang="ts">
  import { SPACE_PX } from './generated/tokens.ts'
  import { cssDurationMs, tipOf, tipPlace, TooltipDelay, type Tip } from './tooltip.ts'

  let { resolve }: { resolve(command: string): { title: string; shortcut?: string | undefined } | undefined } = $props()

  let el: HTMLDivElement | undefined = $state()
  let tip = $state.raw<Tip | null>(null)
  let pos = $state.raw({ left: 0, top: 0 })
  /** The control the tip is for; plain, never rune state. */
  let anchor: Element | null = null
  const GAP = SPACE_PX[0]

  // a control that names its command; rows that carry `data-command` for other reasons (a menu's items, the keyboard
  // list) say their key themselves
  const SELECTOR = '[data-tip], button[data-command]:not([role=menuitem])'

  // placed once laid out (before paint): under its control, inside the window
  $effect(() => {
    if (!tip || !el || !anchor) return
    const a = anchor.getBoundingClientRect()
    const next = tipPlace({ left: a.left, top: a.top, width: a.width, height: a.height }, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, GAP)
    if (next.left !== pos.left || next.top !== pos.top) pos = next
  })

  $effect(() => {
    const delay = new TooltipDelay<Element>({
      delayMs: () => cssDurationMs(getComputedStyle(document.documentElement).getPropertyValue('--motion-tooltip-delay')) ?? 0,
      show: (target) => {
        // read when it shows: the key is the one now, and a control that went in the meantime shows nothing
        const t = target.isConnected && target instanceof HTMLElement ? tipOf({ tip: target.dataset.tip ?? null, command: target.dataset.command ?? null, key: target.dataset.tipKey ?? null }, resolve) : null
        anchor = t ? target : null
        tip = t
      },
      hide: () => {
        anchor = null
        tip = null
      },
      timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
    })
    const on = (target: EventTarget | null): void => {
      const c = target instanceof Element ? target.closest(SELECTOR) : null
      if (c && !(c instanceof HTMLButtonElement && c.disabled)) delay.enter(c)
      else delay.leave()
    }
    const over = (e: PointerEvent): void => on(e.target)
    // the keyboard arriving on a control shows its tip too; a click's focus does not (the press hid it)
    const focusIn = (e: FocusEvent): void => {
      if (e.target instanceof Element && e.target.matches(':focus-visible')) on(e.target)
    }
    const leave = (): void => delay.leave()
    const opts = { capture: true, passive: true } as const
    document.addEventListener('pointerover', over, opts)
    document.addEventListener('focusin', focusIn, opts)
    document.addEventListener('focusout', leave, opts)
    document.addEventListener('pointerdown', leave, opts)
    document.addEventListener('keydown', leave, opts)
    document.addEventListener('scroll', leave, opts)
    document.documentElement.addEventListener('pointerleave', leave, opts)
    window.addEventListener('blur', leave)
    return () => {
      delay.leave()
      document.removeEventListener('pointerover', over, opts)
      document.removeEventListener('focusin', focusIn, opts)
      document.removeEventListener('focusout', leave, opts)
      document.removeEventListener('pointerdown', leave, opts)
      document.removeEventListener('keydown', leave, opts)
      document.removeEventListener('scroll', leave, opts)
      document.documentElement.removeEventListener('pointerleave', leave, opts)
      window.removeEventListener('blur', leave)
    }
  })
</script>

{#if tip}
  <div bind:this={el} class="kea-tooltip" aria-hidden="true" style:left="{pos.left}px" style:top="{pos.top}px">
    <span>{tip.text}</span>{#if tip.shortcut}<kbd>{tip.shortcut}</kbd>{/if}
  </div>
{/if}
