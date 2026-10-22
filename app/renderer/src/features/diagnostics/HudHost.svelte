<!--
Where the dev-only performance HUD is mounted in the window. The HUD's own code is loaded only when it is first shown,
and only a development build can load it: Vite replaces `import.meta.env.MODE` as it builds, so in a release build
`load` is the constant null and the bundle holds neither Hud.svelte nor a way to ask for it. While the HUD is hidden
this component is one `if`: no timer, no listener.
-->
<script lang="ts">
  import { diagUi } from './state.svelte.ts'

  const load = import.meta.env.MODE !== 'production' ? () => import('./Hud.svelte') : null
</script>

{#if load && diagUi.hud}
  {#await load() then m}
    <m.default />
  {/await}
{/if}
