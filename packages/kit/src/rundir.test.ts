import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { L } from '@kea/protocol/limits'
import { describe, expect, it } from 'vitest'
import { ensurePrivateDir, fnv1a64, isOwnSocket, runDir, socketPath, UnsafePathError } from './rundir.ts'

interface RunDirCase {
  home: string
  uid: number
  /** The user's runtime folder (Linux's `$XDG_RUNTIME_DIR`); absent: none (macOS). */
  runtimeDir?: string
  runDir: string
}

const golden = JSON.parse(fs.readFileSync(new URL('../../../fixtures/protocol/holder-golden.json', import.meta.url), 'utf8')) as {
  runDir: RunDirCase[]
}

describe('runDir', () => {
  it.each(golden.runDir)('U-HLD-4 · golden case $home', (c) => {
    expect(runDir(c.home, c.uid, c.runtimeDir ?? null)).toBe(c.runDir)
  })

  it('U-HLD-4 · <home>/run is used exactly up to L.socketPathMaxBytes, counted in UTF-8 bytes', () => {
    const suffix = `/run/${'x'.repeat(L.ptyIdLength)}.sock`.length
    const fits = `/${'a'.repeat(L.socketPathMaxBytes - suffix - 1)}`
    expect(Buffer.byteLength(socketPath(runDir(fits, 501, null), 'x'.repeat(L.ptyIdLength)))).toBe(L.socketPathMaxBytes)
    expect(runDir(fits, 501, null)).toBe(`${fits}/run`)
    const over = `${fits}b`
    expect(runDir(over, 501, null)).toBe(`/tmp/kea-501/${fnv1a64(over)}`)
    // 'é' is two bytes: same character count as `fits`, one byte too long.
    const multibyte = `/é${'a'.repeat(L.socketPathMaxBytes - suffix - 2)}`
    expect(multibyte.length).toBe(fits.length)
    expect(runDir(multibyte, 501, null)).toBe(`/tmp/kea-501/${fnv1a64(multibyte)}`)
  })

  it('U-HLD-4 · fnv1a64 matches the reference vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325')
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c')
    expect(fnv1a64('foobar')).toBe('85944171f73967e8')
  })
})

describe('private run directory and sockets', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kea-rundir-'))

  it('U-HLD-6 · a run directory is created 0700 and refused when it is a symlink or open to others', () => {
    const t = tmp()
    try {
      const dir = path.join(t, 'a', 'run')
      ensurePrivateDir(dir)
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
      ensurePrivateDir(dir) // idempotent
      const real = path.join(t, 'elsewhere')
      fs.mkdirSync(real, { mode: 0o700 })
      fs.symlinkSync(real, path.join(t, 'link'))
      expect(() => ensurePrivateDir(path.join(t, 'link'))).toThrow(UnsafePathError)
      const open = path.join(t, 'open')
      fs.mkdirSync(open)
      fs.chmodSync(open, 0o755)
      expect(() => ensurePrivateDir(open)).toThrow(/accessible to other users/)
      expect(fs.statSync(open).mode & 0o777).toBe(0o755) // never loosened or fixed behind the user's back
    } finally {
      fs.rmSync(t, { recursive: true, force: true })
    }
  })

  it('U-HLD-6 · only a real socket owned by this user counts; a symlink to one does not', async () => {
    const t = tmp()
    const server = net.createServer()
    try {
      const sock = path.join(t, 'aaaaaaaaaa.sock')
      await new Promise<void>((r) => server.listen(sock, () => r()))
      expect(isOwnSocket(sock)).toBe(true)
      fs.symlinkSync(sock, path.join(t, 'bbbbbbbbbb.sock'))
      expect(isOwnSocket(path.join(t, 'bbbbbbbbbb.sock'))).toBe(false)
      fs.writeFileSync(path.join(t, 'cccccccccc.sock'), '')
      expect(isOwnSocket(path.join(t, 'cccccccccc.sock'))).toBe(false)
      expect(isOwnSocket(path.join(t, 'missing.sock'))).toBe(false)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
      fs.rmSync(t, { recursive: true, force: true })
    }
  })
})
