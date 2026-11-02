<!--
The warning before unsaved changes are lost (review.svelte.ts asks it, one file at a time): Save is the safe default
and has the keyboard, Don't Save is `--danger` text, Esc cancels. When the file cannot be saved (Kea's core is
restarting, its session or its folder is gone, it is not text any more) Copy All, which copies the text and then does
not save, replaces Save. A move to another session or tab that the review did not make answers Cancel.

The same sheet asks before a file with unsaved changes is handed to what reads it from disk: Save and Send (Copy,
Open), the default; Send (Copy, Open) Anyway; Cancel.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { fileTabsState } from '../../shell/fileTabs.svelte.ts'
  import SheetFrame from '../sessions/SheetFrame.svelte'
  import { ui } from '../sessions/state.svelte.ts'
  import { answerUnsaved, type HandOff, type UnsavedAsk } from './review.svelte.ts'

  let { ask }: { ask: UnsavedAsk } = $props()
  // fixed for this mount (MainPane keys it)
  const a = untrack(() => ask)
  const name = a.path.slice(a.path.lastIndexOf('/') + 1)
  const cancel = (): void => answerUnsaved('cancel')
  const VERB: Readonly<Record<HandOff, string>> = { send: 'Send', copy: 'Copy', open: 'Open' }
  const READER: Readonly<Record<HandOff, string>> = { send: 'The agent reads the file on disk', copy: 'The reference names the file on disk', open: 'The editor opens the file on disk' }

  let first = true
  $effect(() => {
    const pane = ui.pane
    const shown = fileTabsState.shown
    if (first) {
      first = false
      return
    }
    const there = !a.orphan && pane.kind === 'session' && pane.id === a.sessionId && shown?.mode === 'file' && shown.sessionId === a.sessionId && shown.path === a.path
    if (!there) untrack(cancel)
  })
</script>

{#if a.handOff}
  {@const verb = VERB[a.handOff]}
  <SheetFrame title={`${name} has unsaved changes`} onCancel={cancel}>
    {#snippet buttons()}
      {#if a.cannotSave === null}
        <button class="button" data-default="true" onclick={() => answerUnsaved('save')}>Save and {verb}</button>
        <button class="button" onclick={() => answerUnsaved('anyway')}>{verb} Anyway</button>
      {:else}
        <button class="button" data-default="true" onclick={() => answerUnsaved('anyway')}>{verb} Anyway</button>
      {/if}
      <button class="button" onclick={cancel}>Cancel</button>
    {/snippet}
    <p>{READER[a.handOff]}, which does not have them yet.</p>
    <p class="sheet-meta">{a.path}</p>
  </SheetFrame>
{:else}
  <SheetFrame title={a.orphan ? `${name} had unsaved changes in a session that is gone` : `Do you want to save the changes you made to ${name}?`} onCancel={cancel}>
    {#snippet buttons()}
      {#if a.cannotSave === null}
        <button class="button" data-default="true" onclick={() => answerUnsaved('save')}>Save</button>
      {:else}
        <button class="button" data-default="true" onclick={() => answerUnsaved('copyAll')}>Copy All</button>
      {/if}
      <button class="button danger" onclick={() => answerUnsaved('dontSave')}>Don’t Save</button>
      <button class="button" onclick={cancel}>Cancel</button>
    {/snippet}
    {#if a.cannotSave === null}
      <p>Your changes will be lost if you don’t save them.</p>
    {:else}
      <p>It can’t be saved: {a.cannotSave.charAt(0).toLowerCase()}{a.cannotSave.slice(1)}. Copy All copies your text, then lets it go.</p>
    {/if}
    <p class="sheet-meta">{a.path}</p>
  </SheetFrame>
{/if}
