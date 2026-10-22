<!--
Settings › Keyboard: the read-only list of every command and its binding, conflicts, and "Open keybindings.json".
All of it is the commands feature's `KeyboardList`, which is also the Keyboard Shortcuts sheet.
-->
<script lang="ts">
  import KeyboardList from '../commands/KeyboardList.svelte'
</script>

<div class="settings-form settings-fill" role="group" aria-label="Keyboard settings">
  <KeyboardList />
</div>
