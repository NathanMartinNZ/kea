<!--
Settings › About: what this build is, the update state main keeps (followed while the page is open; opening the page
counts as seeing the line that says Kea checks for updates), and the platform report as main assembled it last and
sent it to core, read when the page opens (`diagnostics.platform`).
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import { settingRows, type PlatformReport } from '@kea/protocol'
  import { checkUpdates, openExternal, platform, restartToUpdate, updateNoticeShown } from '../../lib/bridge.ts'
  import { External } from '../../lib/reactive.svelte.ts'
  import { call } from '../../lib/rpc.ts'
  import { copyText } from '../sessions/actions.ts'
  import { showToast } from '../sessions/state.svelte.ts'
  import { buildFacts } from './about.ts'
  import AboutView from './AboutView.svelte'
  import { sectionRows } from './model.ts'
  import Rows from './Rows.svelte'
  import { settings } from './store.ts'
  import { aboutUpdate, lastCheckedText, releaseNotesUrl, updates, type UpdateAction } from './updates.ts'

  /** The switch for checking by itself: the schema's one Updates row. */
  const AUTO_ROWS = sectionRows(settingRows([]), 'Updates')

  const build = buildFacts(platform)
  // plain data (a dozen short lines): no heavy object in rune state
  let report = $state.raw<PlatformReport | null | undefined>(undefined)
  /** Why core did not answer (it went away meanwhile): said in place, not as a toast. */
  let error = $state<string | null>(null)

  const update = new External(updates.subscribe, () => updates.state)
  const values = new External(settings.subscribe, () => settings.values)
  const shown = $derived.by(() => {
    const s = update.current
    const about = aboutUpdate(s)
    return { about, last: lastCheckedText(s.lastChecked), why: s.why, notesUrl: about.notes ? releaseNotesUrl(about.notes) : null, auto: s.auto }
  })
  // the page open counts as the one-time line seen
  $effect(() => {
    if (update.current.notice) untrack(() => updateNoticeShown())
  })

  function act(a: UpdateAction): void {
    if (a === 'check' || a === 'retry') checkUpdates()
    else if (a === 'restartUpdate' || a === 'restartKea') restartToUpdate()
    else if (a === 'copy' && shown.about.command) {
      void copyText(shown.about.command).then((ok) => showToast({ message: ok ? 'Command copied' : 'Couldn’t copy: the window must be in front' }))
    }
  }

  $effect(() => {
    let live = true
    untrack(() => {
      call('diagnostics.platform', {}).then(
        (r) => {
          if (live) report = r.report
        },
        (e: unknown) => {
          if (!live) return
          report = null
          error = e instanceof Error ? e.message : String(e)
        },
      )
    })
    return () => {
      live = false
    }
  })
</script>

<AboutView {build} {report} {error} updates={shown} onUpdateAction={act} onNotes={(url) => openExternal(url)}>
  {#snippet autoRow()}
    {#if shown.auto}
      <Rows rows={AUTO_ROWS} value={(key) => values.current.get(key)} agents={[]} onSet={(row, value) => call('settings.set', { key: row.fullKey, value })} onReset={(row) => call('settings.reset', { key: row.fullKey })} />
    {/if}
  {/snippet}
</AboutView>
