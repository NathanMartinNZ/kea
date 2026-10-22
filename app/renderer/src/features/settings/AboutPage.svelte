<!--
Settings › About: what this build is, and the platform report as main assembled it last and sent it to
core. Read when the page opens (`diagnostics.platform`); no timer and no store behind the sheet.
-->
<script lang="ts">
  import { untrack } from 'svelte'
  import type { PlatformReport } from '@kea/protocol'
  import { platform } from '../../lib/bridge.ts'
  import { call } from '../../lib/rpc.ts'
  import { buildFacts } from './about.ts'
  import AboutView from './AboutView.svelte'

  const build = buildFacts(platform)
  // plain data (a dozen short lines): no heavy object in rune state
  let report = $state.raw<PlatformReport | null | undefined>(undefined)
  /** Why core did not answer (it went away meanwhile): said in place, not as a toast. */
  let error = $state<string | null>(null)

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

<AboutView {build} {report} {error} />
