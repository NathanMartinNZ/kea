<!--
The main column's pane: what the window is on (sessions/state.svelte.ts `pane`) — a session (SessionPane.svelte), the
composer, or, with neither, the plain shell tabs of the `shells` pseudo-session. Sheets attach to the top of the pane.
-->
<script lang="ts">
  import ShortcutsSheet from '../features/commands/ShortcutsSheet.svelte'
  import Composer from '../features/composer/Composer.svelte'
  import RemoveBuildFoldersSheet from '../features/disk/RemoveBuildFoldersSheet.svelte'
  import CopyInSheet from '../features/files/CopyInSheet.svelte'
  import DiscardSheet from '../features/files/DiscardSheet.svelte'
  import TrashSheet from '../features/files/TrashSheet.svelte'
  import { panel } from '../features/files/state.svelte.ts'
  import Sheets from '../features/sessions/Sheets.svelte'
  import Settings from '../features/settings/Settings.svelte'
  import { ui } from '../features/sessions/state.svelte.ts'
  import SessionPane from './SessionPane.svelte'
  import TerminalPane from './TerminalPane.svelte'
  import { SHELLS_CONTEXT } from './terminalPane.ts'
</script>

<div class="main-pane">
  {#if ui.pane.kind === 'composer'}
    {#key ui.pane.projectId}
      <Composer projectId={ui.pane.projectId} pickProject={!!ui.pane.pickProject} />
    {/key}
  {:else if ui.pane.kind === 'session'}
    {#key ui.pane.id}
      <SessionPane id={ui.pane.id} />
    {/key}
  {:else}
    <TerminalPane context={SHELLS_CONTEXT} canOpenShell />
  {/if}
  <Sheets />
  <!-- Settings: the window's one sheet when its kind is `settings`; Project Settings is its Projects page -->
  <Settings />
  <!-- Keyboard Shortcuts (`app.shortcuts`): the same list as Settings › Keyboard -->
  <ShortcutsSheet />
  <!-- Remove Build Folders… from the palette, the menu bar or a key asks first -->
  <RemoveBuildFoldersSheet />
  <!-- the file panel's confirmations: Discard Changes…, Move to Trash, a copy of what was dropped from another app -->
  {#if panel.discard}
    {#key panel.discard}
      <DiscardSheet ask={panel.discard} />
    {/key}
  {/if}
  {#if panel.trash}
    {#key panel.trash}
      <TrashSheet ask={panel.trash} />
    {/key}
  {/if}
  {#if panel.copyIn}
    {#key panel.copyIn}
      <CopyInSheet ask={panel.copyIn} />
    {/key}
  {/if}
</div>
