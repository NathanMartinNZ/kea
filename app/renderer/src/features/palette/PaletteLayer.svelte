<!--
The palette's floating layer, mounted once by the window: the palette while it is open (`⌘⇧P`; `⌘P` in file mode),
nothing otherwise. Its index, rows and listeners live only while it is open.
-->
<script lang="ts">
  import Palette from './Palette.svelte'
  import { palette } from './state.svelte.ts'
</script>

{#if palette.open}
  <Palette base={palette.open.base} seq={palette.open.seq} />
{/if}
