<!--
The header's menu button (Linux): at the start of the leftmost visible header, where macOS has its traffic lights. It
opens the application menu under itself (windowMenu.ts, WindowMenu.svelte) and closes it again; `Alt` pressed alone
does the same.
-->
<script lang="ts">
  import { Icon } from '@kea/ui'
  import { openMenuUnderButton } from './windowMenu.ts'
  import { windowMenuUi } from './windowMenuState.svelte.ts'

  const keepFocus = (e: MouseEvent) => e.preventDefault()
</script>

<button class="quiet-button icon window-menu" aria-label="Menu" aria-haspopup="menu" aria-expanded={windowMenuUi.open !== null} data-tip="Menu (Alt)" data-window-menu onmousedown={keepFocus} onclick={openMenuUnderButton}><Icon name="menu" /></button>
