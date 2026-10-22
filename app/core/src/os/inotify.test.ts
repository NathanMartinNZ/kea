// inotify's limits as Linux's OS layer reads them, where that is pure enough to check on any system: an instance's
// `fdinfo` recorded in an Ubuntu 24.04 VM (fixtures/os/linux/inotify-fdinfo), the watcher's errors at each limit as
// `@parcel/watcher` words them, and the banner's words. The reads of `/proc` themselves run in the VM (I-PLT-3,
// I-PLT-8).
import fs from 'node:fs'
import path from 'node:path'
import { isAvailable, L } from '@kea/protocol'
import { describe, expect, it } from 'vitest'
import { limitBanner } from '../platform/watch/limits.ts'
import { darwin } from './darwin.ts'
import { inotifyWatchesIn, linux, watchLimitOf } from './linux.ts'

const FIXTURES = path.resolve(import.meta.dirname, '../../../../fixtures/os/linux')

describe('inotify’s limits (os/linux.ts)', () => {
  it('U-PLT-32 · Kea’s own watches are the `inotify wd:` lines of its instances’ fdinfo; ENOSPC from inotify_add_watch (no code: known by its message, any path) is the watch limit and the backend’s start at EMFILE the instance limit, nothing else is; the banner names the limit with its value, Kea’s watches and the sysctl that raises it; macOS meets no limit', () => {
    expect(inotifyWatchesIn(fs.readFileSync(path.join(FIXTURES, 'inotify-fdinfo'), 'utf8'))).toBe(2)
    expect(inotifyWatchesIn('pos:\t0\nflags:\t02004000\n')).toBe(0)

    expect(watchLimitOf("inotify_add_watch on '/home/u/repo/node_modules/a' failed: No space left on device")).toBe('watches')
    expect(watchLimitOf("inotify_add_watch on '/home/u/it's\nodd' failed: No space left on device"), 'a path with a quote and a newline').toBe('watches')
    expect(watchLimitOf('Unable to initialize inotify: Too many open files')).toBe('instances')
    for (const other of [
      "inotify_add_watch on '/home/u/repo' failed: Permission denied",
      'Events were dropped by the kernel (the inotify queue overflowed). File system must be re-scanned.',
      'Unable to initialize inotify: Cannot allocate memory',
      'No space left on device',
      'Error starting FSEvents stream',
    ]) {
      expect(watchLimitOf(other), other).toBeNull()
    }

    const os = linux.watcher
    if (!isAvailable(os) || !os.limits) throw new Error('Linux’s watcher has inotify’s limits')
    const fix = os.limits.fix('watches')
    expect(fix).toContain(`sudo sysctl fs.inotify.max_user_watches=${L.inotifyWatchesSuggested}`)
    expect(os.limits.fix('instances')).toContain(`fs.inotify.max_user_instances=${L.inotifyInstancesSuggested}`)
    const w = limitBanner({ kind: 'watches', max: 65536 }, 61234, os.limits.setting('watches'), fix)
    expect(w.message).toContain('inotify watch limit (fs.inotify.max_user_watches = 65536)')
    expect(w.message).toContain('Kea holds 61234 watches')
    expect(w.message).toContain('refresh when Kea comes to the front')
    expect(w.fix).toBe(fix)
    expect(limitBanner({ kind: 'instances', max: null }, 0, os.limits.setting('instances'), 'x').message).toContain('at the system’s limit (fs.inotify.max_user_instances)')

    // FSEvents, no limit core meets, `fs.watch` recursive where allowed; the binding built from Kea's patch,
    // as on Linux (its fixes apply on both systems)
    const mac = darwin.watcher
    expect(isAvailable(mac) && [mac.limits, mac.patchedBuild, mac.backend, mac.recursiveFsWatch]).toEqual([null, 'build/Release/watcher.node', null, true])
    expect([os.backend, os.recursiveFsWatch, os.bindingPackage('x64')]).toEqual(['inotify', false, '@parcel/watcher-linux-x64-glibc'])
  })
})
