// Linux's side of the kit's OS layer, where it is pure enough to check on any system, and the instance
// lock, which needs Linux itself.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { need } from '@kea/protocol/platform'
import { fileName, nameKey, namesAsStored } from '../names.ts'
import { UnsafePathError } from '../privateDir.ts'
import { runProcess } from '../runProcess.ts'
import { darwin } from './darwin.ts'
import { kitOs } from './index.ts'
import { linux, procHidepid, xdgRuntimeDir } from './linux.ts'

describe("kit's OS layer on Linux", () => {
  it("U-HLD-4 · $XDG_RUNTIME_DIR takes a long home's sockets only when it is the user's own: absolute, a real directory, owned by this user, closed to everyone else", () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-hld-4-')))
    try {
      const own = path.join(tmp, 'own')
      fs.mkdirSync(own, { mode: 0o700 })
      const open = path.join(tmp, 'open')
      fs.mkdirSync(open)
      fs.chmodSync(open, 0o755)
      const link = path.join(tmp, 'link')
      fs.symlinkSync(own, link)
      const file = path.join(tmp, 'file')
      fs.writeFileSync(file, '')
      fs.chmodSync(file, 0o700)
      expect(xdgRuntimeDir({ XDG_RUNTIME_DIR: own })).toBe(own)
      expect([open, link, file, path.join(tmp, 'missing'), 'relative/dir', ''].map((d) => xdgRuntimeDir({ XDG_RUNTIME_DIR: d }))).toEqual([null, null, null, null, null, null])
      expect(xdgRuntimeDir({})).toBeNull()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it.runIf(kitOs.system === 'linux')("U-PLT-15 · the instance lock is a flock on a file in a private run directory: taken once (not again by this process), the file 0600 and empty, still there after dispose and taken again; a run directory open to others or reached through a symlink, and a lock file that is a symlink, are refused", () => {
    const { tryLock } = need(linux.instanceLock)
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kea-u-plt-15-')))
    try {
      const run = path.join(tmp, 'run')
      const file = path.join(run, 'core.lock')
      const lock = tryLock(file)
      expect(lock).not.toBeNull()
      expect(fs.statSync(run).mode & 0o777, 'made private').toBe(0o700)
      expect([fs.statSync(file).mode & 0o777, fs.statSync(file).size]).toEqual([0o600, 0])
      expect(tryLock(file), 'another open file description of this process').toBeNull()
      lock!.dispose()
      expect(fs.existsSync(file), 'never removed').toBe(true)
      const again = tryLock(file)
      expect(again).not.toBeNull()
      again!.dispose()

      const open = path.join(tmp, 'open')
      fs.mkdirSync(open)
      fs.chmodSync(open, 0o755)
      expect(() => tryLock(path.join(open, 'core.lock'))).toThrow(UnsafePathError)
      expect(fs.existsSync(path.join(open, 'core.lock')), 'nothing made there').toBe(false)
      fs.symlinkSync(run, path.join(tmp, 'link'))
      expect(() => tryLock(path.join(tmp, 'link', 'core.lock'))).toThrow(UnsafePathError)
      fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(run, 'ptyhost.lock'))
      expect(() => tryLock(path.join(run, 'ptyhost.lock')), 'O_NOFOLLOW').toThrow(/ELOOP/)
      expect(fs.existsSync(path.join(tmp, 'elsewhere')), 'nothing made through the link').toBe(false)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("U-PLT-15 · /proc's hidepid from mountinfo: a stock /proc hides nothing; hidepid=invisible, 2, noaccess or ptraceable hides holders; the last mount at /proc wins; other mounts are not /proc", () => {
    // the first line as Ubuntu 24.04 prints it; the others are it remounted
    const stock = '27 33 0:25 / /proc rw,nosuid,nodev,noexec,relatime shared:13 - proc proc rw'
    const sys = '26 33 0:24 / /sys rw,nosuid,nodev,noexec,relatime shared:7 - sysfs sysfs rw'
    const binfmt = '40 27 0:35 / /proc/sys/fs/binfmt_misc rw,relatime shared:14 - autofs systemd-1 rw,fd=32,pgrp=1,timeout=0'
    const hide = (v: string) => `91 33 0:52 / /proc rw,relatime - proc proc rw,hidepid=${v},gid=27`
    expect(procHidepid([sys, stock, binfmt].join('\n'))).toBeNull()
    for (const v of ['invisible', '2', 'noaccess', '1', 'ptraceable', '4']) expect(procHidepid([stock, hide(v)].join('\n')), v).toBe(v)
    for (const v of ['0', 'off']) expect(procHidepid([stock, hide(v)].join('\n')), v).toBeNull()
    expect(procHidepid([hide('invisible'), stock].join('\n')), 'remounted stock over it').toBeNull()
    expect(procHidepid('91 33 0:52 / /proc rw - tmpfs none rw,hidepid=2'), 'not a proc mount').toBeNull()
    expect(procHidepid(''), 'nothing mounted at /proc').toBeNull()
  })

  it("U-PLT-27 · background deletes run in ionice's idle class on Linux (taskpolicy -b on macOS); a name keeps its bytes for file operations on Linux and NFC is only its key, macOS takes NFC for both", async () => {
    const rm = ['-rf', '--', '/x/trash/01J']
    expect(need(linux.backgroundIo).argv('/bin/rm', rm)).toEqual({ file: '/usr/bin/ionice', args: ['-c', '3', '/bin/rm', ...rm] })
    expect(need(darwin.backgroundIo).argv('/bin/rm', rm)).toEqual({ file: '/usr/bin/taskpolicy', args: ['-b', '/bin/rm', ...rm] })
    if (kitOs.system === 'linux') {
      // the class the command really runs in: `ionice` alone prints its own
      const bg = need(linux.backgroundIo).argv('/usr/bin/ionice', [])
      const r = await runProcess(bg.file, bg.args, { pool: 'other', collect: true })
      expect([r.code, r.stdout?.toString('utf8').trim()]).toEqual([0, 'idle'])
    }

    const nfd = 'Cafe\u0301.txt'
    const nfc = 'Caf\u00e9.txt'
    const l = need(linux.nameKey)
    const d = need(darwin.nameKey)
    expect([l.fileName(nfd), l.fileName(nfc), l.key(nfd), l.key(nfc), l.asStored]).toEqual([nfd, nfc, nfc, nfc, true])
    expect([d.fileName(nfd), d.fileName(nfc), d.key(nfd), d.key(nfc), d.asStored]).toEqual([nfc, nfc, nfc, nfc, false])
    expect([fileName(nfd), nameKey(nfd), namesAsStored()]).toEqual(kitOs.system === 'linux' ? [nfd, nfc, true] : [nfc, nfc, false])
  })
})

