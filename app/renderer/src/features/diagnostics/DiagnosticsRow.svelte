<!--
Settings › Advanced, the Diagnostics rows: "Copy diagnostics" with its "Include file paths" tick box
and what the last copy did; and, in a development build only, the tick box that shows the performance HUD. The copy is
the command `app.copyDiagnostics` (the menu bar and the palette run the same one).
-->
<script lang="ts">
  import { commands } from '../commands/registry.ts'
  import { DEV_BUILD } from './dev.ts'
  import { copyStatus, diagUi } from './state.svelte.ts'

  const available = $derived(commands.available('app.copyDiagnostics'))

  /** One copy at a time: the button stays pressable (it keeps the focus), a press while one is made does nothing. */
  function copy(): void {
    if (diagUi.copy.state !== 'copying') commands.run('app.copyDiagnostics')
  }
</script>

<div class="settings-row">
  <span class="settings-label">Diagnostics</span>
  <div class="gen-control">
    <!-- while a copy is made it keeps its place and the keyboard (a `disabled` button drops the focus out of the sheet, and Esc with it) -->
    <button
      class="button"
      disabled={!available}
      aria-disabled={diagUi.copy.state === 'copying'}
      data-command="app.copyDiagnostics"
      aria-describedby="diagnostics-status"
      onclick={copy}>Copy diagnostics</button
    >
    <label class="sheet-check"><input type="checkbox" checked={diagUi.paths} onchange={(e) => (diagUi.paths = e.currentTarget.checked)} />Include file paths</label>
  </div>
  <span class="settings-help" id="diagnostics-status" role="status" data-diagnostics={diagUi.copy.state}>{available ? copyStatus(diagUi.copy, diagUi.paths) : (commands.reason('app.copyDiagnostics') ?? 'Not available yet')}</span>
</div>

{#if DEV_BUILD}
  <div class="settings-row">
    <span class="settings-label">Development</span>
    <label class="sheet-check"><input type="checkbox" checked={diagUi.hud} onchange={(e) => (diagUi.hud = e.currentTarget.checked)} />Show the performance HUD</label>
    <span class="settings-help">Frame time, calls to core in flight, bytes per second per terminal and the resource report. Only in a development build: a release build does not contain it.</span>
  </div>
{/if}
