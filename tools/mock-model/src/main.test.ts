import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const MAIN = join(import.meta.dirname, 'main.ts')
const dir = mkdtempSync(join(tmpdir(), 'mock-model-cli-'))
const children: ChildProcess[] = []
afterAll(() => {
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL')
  rmSync(dir, { recursive: true, force: true })
})

/** Starts the CLI and resolves with its URL once it prints `MOCK_MODEL_URL=…`. */
function startCli(args: string[]): Promise<{ child: ChildProcess; url: string; stderr: () => string }> {
  const child = spawn(process.execPath, [MAIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let out = ''
  let err = ''
  child.stderr!.on('data', (d: Buffer) => (err += d))
  return new Promise((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => {
      out += d
      const m = /MOCK_MODEL_URL=(\S+)/.exec(out)
      if (m) resolve({ child, url: m[1]!, stderr: () => err })
    })
    child.on('exit', (code) => reject(new Error(`mock-model CLI exited ${code}: ${err}`)))
  })
}

const exited = (c: ChildProcess) => new Promise<number | null>((r) => (c.exitCode !== null ? r(c.exitCode) : c.on('exit', (code) => r(code))))

describe('mock-model CLI', () => {
  it('U-MOCK-12 · prints its URL, answers from a script file, takes replies over the control API, logs without credentials, exits 0 on SIGTERM', async () => {
    const script = join(dir, 'script.json')
    const log = join(dir, 'requests.jsonl')
    writeFileSync(script, JSON.stringify({ default: 'from script', replies: [{ content: [{ type: 'text', text: 'first' }], when: { lastUser: 'one' } }] }))
    const { child, url, stderr } = await startCli(['--script', script, '--log', log])
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const ask = async (prompt: string) => {
      const r = await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': 'sk-ant-test-dummy', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: prompt }] }),
      })
      return ((await r.json()) as { content: Array<{ text: string }> }).content[0]!.text
    }
    expect(await ask('one')).toBe('first')
    expect(await ask('two')).toBe('from script')
    const enq = await fetch(`${url}/__mock/replies`, { method: 'POST', body: JSON.stringify([{ content: [{ type: 'text', text: 'pushed' }], when: { lastUser: 'three' } }]) })
    expect(await enq.json()).toEqual({ pending: 1 })
    expect(await ask('three')).toBe('pushed')
    const recorded = (await (await fetch(`${url}/__mock/requests`)).json()) as Array<{ seq: number; path: string; mono: string; headers: Record<string, string> }>
    expect(recorded.map((r) => [r.seq, r.path])).toEqual([
      [1, '/v1/messages'],
      [2, '/v1/messages'],
      [3, '/v1/messages'],
    ]) // control calls are not recorded
    expect(typeof recorded[0]!.mono).toBe('string')
    await fetch(`${url}/__mock/reset`, { method: 'POST' })
    expect(await (await fetch(`${url}/__mock/requests`)).json()).toEqual([])
    child.kill('SIGTERM')
    expect(await exited(child)).toBe(0)
    const lines = readFileSync(log, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.join('\n')).not.toContain('sk-ant-test-dummy')
    expect(stderr()).toMatch(/mock-model #1 POST \/v1\/messages model=m → scripted#0/)
  })

  it('U-MOCK-13 · rejects unknown arguments with usage and exit 2', async () => {
    const child = spawn(process.execPath, [MAIN, '--nope'], { stdio: ['ignore', 'ignore', 'pipe'] })
    children.push(child)
    let err = ''
    child.stderr!.on('data', (d: Buffer) => (err += d))
    expect(await exited(child)).toBe(2)
    expect(err).toMatch(/unknown argument --nope[\s\S]*usage:/)
  })
})
