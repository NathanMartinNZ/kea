<!--
The dev-only performance HUD: frame time, IPC queue depth (calls to core not answered yet), bytes per second per
terminal, and the resource report on request. It exists only in a development build (HudHost.svelte) and only while it
is shown: mounting it starts one animation-frame loop and one interval (`L.hudRefreshMs`), and unmounting it ends both.
The resource report is asked of main when its part is opened and by "Read again", never on a timer: reading it asks
every process.
-->
<script lang="ts">
  import { L, reportLines, resourcesSection } from '@kea/protocol'
  import { resourceReports } from '../../lib/bridge.ts'
  import { rpcStats } from '../../lib/rpc.ts'
  import { rendererResources } from '../resources/report.ts'
  import { terminals } from '../terminal/views.ts'
  import './hud.css'
  import { ByteRates, FrameMeter, framesText, rateText, type ByteRate, type FrameStats } from './hud.ts'
  import { diagUi, hudHolds } from './state.svelte.ts'

  let frames = $state.raw<FrameStats>({ frames: 0, avgMs: 0, maxMs: 0 })
  let rpc = $state.raw({ subscriptions: 0, pendingCalls: 0 })
  // bounded: one per terminal view the window holds at the last reading (hud.ts ByteRates), replaced at each reading
  let rates = $state.raw<ByteRate[]>([])
  /** The resource report as text; null until asked for. */
  let report = $state.raw<string[] | null>(null)
  let reading = $state(false)
  let live = true

  $effect(() => {
    const meter = new FrameMeter()
    const bytes = new ByteRates()
    let raf = requestAnimationFrame(function tick(t) {
      meter.frame(t)
      raf = requestAnimationFrame(tick)
    })
    const read = (): void => {
      frames = meter.take()
      rpc = rpcStats()
      rates = bytes.read(
        performance.now(),
        [...terminals.all()].map((v) => [v.ptyId, v.bytesIn] as const),
      )
    }
    read()
    const timer = setInterval(read, L.hudRefreshMs)
    hudHolds.timers = 2
    return () => {
      live = false
      cancelAnimationFrame(raf)
      clearInterval(timer)
      hudHolds.timers = 0
    }
  })

  async function readReport(): Promise<void> {
    if (reading) return
    reading = true
    const collected = await resourceReports()
    if (!live) return
    const lines = resourcesSection(collected).slice(1)
    if (!collected) lines.push('renderer:', ...reportLines(rendererResources()))
    report = lines
    reading = false
  }
</script>

<aside class="hud" aria-label="Performance HUD" data-hud>
  <div class="hud-head">
    <span class="hud-title">Performance</span>
    <button class="link-button" aria-label="Hide the performance HUD" onclick={() => (diagUi.hud = false)}>Hide</button>
  </div>
  <dl class="hud-rows">
    <dt>Frame time</dt>
    <dd data-hud-frames>{framesText(frames)}</dd>
    <dt>Calls to core in flight</dt>
    <dd data-hud-calls>{rpc.pendingCalls} · {rpc.subscriptions} stores followed</dd>
    <dt>Terminal output</dt>
    <dd data-hud-bytes>
      {#if rates.length === 0}
        no terminal
      {:else}
        {#each rates as r (r.id)}
          <span class="hud-rate"><code>{r.id}</code> {rateText(r.bytesPerSec)}</span>
        {/each}
      {/if}
    </dd>
  </dl>
  <div class="hud-head">
    <span class="hud-title">Resource report</span>
    <!-- while every process is asked it keeps its place and the keyboard (a `disabled` button drops the focus to nothing); `readReport` lets one through at a time -->
    <button class="link-button" aria-disabled={reading} onclick={() => void readReport()}>{report === null ? 'Read' : 'Read again'}</button>
    {#if report !== null}
      <button class="link-button" onclick={() => (report = null)}>Close</button>
    {/if}
  </div>
  {#if report !== null}
    <pre class="hud-report" data-hud-report>{report.join('\n')}</pre>
  {/if}
</aside>
