<!-- A stroked icon, `--size-icon` square, in the current text colour (the set is icons.ts). -->
<script lang="ts">
  import { ICON_PATHS, type IconName } from './icons.ts'

  let { name, class: className }: { name: IconName; class?: string } = $props()
</script>

<svg class={className ? `kea-icon ${className}` : 'kea-icon'} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  <path d={ICON_PATHS[name]} />
</svg>
