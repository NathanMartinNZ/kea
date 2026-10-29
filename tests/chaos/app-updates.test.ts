// The update check in a dev Kea under the test hooks, against a stand-in for GitHub on 127.0.0.1 that redirects as
// GitHub does (latest → the versioned file → the asset host): the automatic check runs once the window has shown the
// one-time line, makes one GET whose every hop carries Kea's headers and no cookie, and finds the newer version; a
// redirect off the allowed hosts is refused before it leaves; a 404 and a release that is not newer each say so; with
// the switch off nothing is scheduled. On macOS the updater is left out (`--kea-test-update-command`), so both systems
// take the check that reads the release's list of files.

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { releaseFileNames, systemOf } from '@kea/protocol'
import { KeaRun, until, type Kea } from '../support/app.ts'

type Phase = { k: string; version?: string | null; reason?: string }
type Probe = { state: { phase: Phase; notice: boolean; lastChecked: number | null }; title: string; core: boolean | null; timers: number }
type Api = { updates(): Probe; checkUpdates(): void }

const SYSTEM = systemOf(process.platform)
const ARCH = process.arch === 'x64' ? 'x64' : 'arm64'
/** This system's file in a release, as the install kind the hooks force reads it. */
const KIND = SYSTEM === 'darwin' ? 'mac' : 'tarball'
const fileOf = (v: string) => (SYSTEM === 'darwin' ? releaseFileNames(v, 'arm64').zip : releaseFileNames(v, ARCH).tarball)
const sums = (v: string) => `${'a'.repeat(64)}  ${fileOf(v)}\n${'b'.repeat(64)}  install.sh\n`

type Seen = { url: string; headers: http.IncomingHttpHeaders }

/** A stand-in for GitHub's release downloads: `mode` says what it answers. */
async function standIn(): Promise<{ base: string; origin: string; seen: Seen[]; mode: { v: 'newer' | 'same' | '404' | 'offsite' }; offsite: Seen[]; close(): Promise<void> }> {
  const seen: Seen[] = []
  const offsite: Seen[] = []
  const mode: { v: 'newer' | 'same' | '404' | 'offsite' } = { v: 'newer' }
  const other = http.createServer((req, res) => {
    offsite.push({ url: req.url ?? '', headers: req.headers })
    res.end('no')
  })
  await new Promise<void>((r) => other.listen(0, 'localhost', r))
  const otherPort = (other.address() as AddressInfo).port
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    const url = req.url ?? ''
    if (mode.v === '404') return void res.writeHead(404).end('Not Found')
    if (url === '/o/n/releases/latest/download/SHA256SUMS') return void res.writeHead(302, { location: '/o/n/releases/download/v1.0.90/SHA256SUMS' }).end()
    if (url === '/o/n/releases/download/v1.0.90/SHA256SUMS') return void res.writeHead(302, { location: mode.v === 'offsite' ? `http://localhost:${otherPort}/asset/SHA256SUMS` : '/asset/SHA256SUMS?sig=x' }).end()
    if (url.startsWith('/asset/SHA256SUMS')) return void res.writeHead(200, { 'content-type': 'text/plain' }).end(sums(mode.v === 'same' ? '1.0.2' : '1.0.90'))
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    base: `${origin}/o/n/releases/latest/download/`,
    origin,
    seen,
    offsite,
    mode,
    close: async () => {
      await new Promise((r) => server.close(r))
      await new Promise((r) => other.close(r))
    },
  }
}

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function launch(o: { switchOff?: boolean } = {}) {
  const feed = await standIn()
  cleanups.push(() => feed.close())
  const run = KeaRun.create()
  cleanups.push(() => run.dispose())
  if (o.switchOff) fs.writeFileSync(path.join(run.home, 'settings.json'), JSON.stringify({ 'updates.check': false }))
  const kea = await run.launch({ args: [`--kea-test-install-kind=${KIND}`, `--kea-test-update-feed=${feed.base}`, '--kea-test-update-delay=0', '--kea-test-update-command'] })
  return { feed, kea }
}

const probe = (kea: Kea) => kea.app.evaluate(() => (globalThis as unknown as { __keaTest: Api }).__keaTest.updates())
const check = (kea: Kea) => kea.app.evaluate(() => (globalThis as unknown as { __keaTest: Api }).__keaTest.checkUpdates())
const settled = (kea: Kea, what: string) => until(what, async () => {
  const p = await probe(kea)
  return p.state.phase.k !== 'checking' && p.state.phase.k !== 'idle' ? p : undefined
})

describe('the update check (app)', () => {
  it('I-DST-1 · the automatic check waits for the one-time line, then makes one GET through GitHub’s redirects, each hop with User-Agent Kea, Accept-Language en and no cookie, and finds the newer version', async () => {
    const { feed, kea } = await launch()
    const p = await settled(kea, 'the automatic check')
    expect(p.state.phase).toEqual({ k: 'available', version: '1.0.90' })
    expect(p.state.notice, 'the line was seen first').toBe(false)
    expect(feed.seen.map((s) => s.url)).toEqual(['/o/n/releases/latest/download/SHA256SUMS', '/o/n/releases/download/v1.0.90/SHA256SUMS', '/asset/SHA256SUMS?sig=x'])
    for (const s of feed.seen) {
      expect(s.headers['user-agent'], s.url).toBe('Kea')
      expect(s.headers['accept-language'], s.url).toBe('en')
      expect(s.headers.cookie, s.url).toBeUndefined()
      expect(Object.keys(s.headers).filter((h) => /staging|user-id|client-id/i.test(h)), s.url).toEqual([])
    }
  })

  it('I-DST-2 · a redirect off the allowed hosts is refused before it leaves Kea; a 404 and a release that is not newer each say so', async () => {
    const { feed, kea } = await launch()
    await settled(kea, 'the automatic check')
    feed.mode.v = 'offsite'
    await check(kea)
    const off = await settled(kea, 'the check redirected off GitHub')
    expect(off.state.phase.k).toBe('failed')
    expect(feed.offsite, 'nothing reached the other host').toEqual([])
    feed.mode.v = '404'
    await check(kea)
    expect((await settled(kea, 'the 404')).state.phase).toEqual({ k: 'failed', reason: 'the newest release has no list of files' })
    feed.mode.v = 'same'
    await check(kea)
    expect((await settled(kea, 'the same version')).state.phase).toEqual({ k: 'current', version: expect.any(String) })
  })

  it('I-DST-3 · with “Check for updates automatically” off, core says so and nothing is scheduled or asked for', async () => {
    const { feed, kea } = await launch({ switchOff: true })
    const p = await until('core’s switch heard', async () => {
      const x = await probe(kea)
      return x.core === false ? x : undefined
    })
    expect(p.timers).toBe(0)
    expect(p.state.lastChecked).toBeNull()
    expect(feed.seen).toEqual([])
  })
})
