// Core's watch service in a process of its own, for the Linux tests that need the kernel's side of inotify: a
// test can stop it (SIGSTOP) while the inotify queue fills, or run it in a user namespace of its own (`unshare -Ur`)
// whose inotify limits it lowers, so the system's and the test runner's stay as they are.
//
// One JSON object per line each way. In: `setup` (which binding, and the namespace's limits to set first), `follow`,
// `focus`, `limits` (set the namespace's limits again), `counts`. Out: what the consumers and the banner store are told
// (`mode`, `rescan`, `changes`, `released`, `banner`, `cleared`), `ready`, `counts`, and a `tick` every L.watchBatchMs
// from `setup` on. The ticks stop if the thread blocks, as @parcel/watcher's `subscribe` does for good when its inotify
// backend cannot start.

import fs from 'node:fs'
import readline from 'node:readline'
import { isAvailable, L } from '@kea/protocol'
import { coreOs } from '../../app/core/src/os/index.ts'
import { isPatched, loadBindingAt, prebuiltBindingPath, watcherBindingPath } from '../../app/core/src/platform/watch/native.ts'
import { Watcher } from '../../app/core/src/platform/watch/watcher.ts'

export type ChildIn =
  | { op: 'setup'; binding: 'patched' | 'prebuilt'; watches?: number; instances?: number }
  | { op: 'follow'; root: string }
  | { op: 'focus' }
  | { op: 'limits'; watches?: number; instances?: number }
  | { op: 'counts' }

export type ChildOut =
  | { ev: 'ready'; patched: boolean }
  | { ev: 'tick' }
  | { ev: 'mode'; root: string; mode: string }
  | { ev: 'rescan'; root: string; why: string }
  | { ev: 'changes'; root: string; paths: string[] }
  | { ev: 'released'; root: string }
  | { ev: 'banner'; message: string; fix: string | null }
  | { ev: 'cleared' }
  | { ev: 'counts'; counts: Record<string, number>; own: number; max: { watches: number; instances: number } | null }
  | { ev: 'error'; message: string }

const out = (o: ChildOut): void => void process.stdout.write(`${JSON.stringify(o)}\n`)

/** The user namespace's own inotify limits: this process is its root (`unshare -Ur`). */
function setLimits(watches?: number, instances?: number): void {
  // os-ok: the Linux-only test harness lowers its own user namespace's inotify limits (I-PLT-3, I-PLT-8)
  if (watches !== undefined) fs.writeFileSync('/proc/sys/user/max_inotify_watches', String(watches))
  // os-ok: as above
  if (instances !== undefined) fs.writeFileSync('/proc/sys/user/max_inotify_instances', String(instances))
}

let watcher: Watcher | null = null

async function handle(m: ChildIn): Promise<void> {
  switch (m.op) {
    case 'setup': {
      setLimits(m.watches, m.instances)
      const file = m.binding === 'patched' ? watcherBindingPath() : prebuiltBindingPath()
      if (!file) throw new Error(`no ${m.binding} binding`)
      const native = loadBindingAt(file)
      const limits = isAvailable(coreOs.watcher) ? coreOs.watcher.limits : null
      watcher = new Watcher({ native, limits })
      watcher.bindBanners({ set: (b) => out({ ev: 'banner', message: b.message, fix: b.fix }), clear: () => out({ ev: 'cleared' }) })
      setInterval(() => out({ ev: 'tick' }), L.watchBatchMs).unref()
      return out({ ev: 'ready', patched: isPatched(native) })
    }
    case 'follow': {
      const root = m.root
      const h = watcher?.worktree(
        { root, gitDir: null, commonDir: null },
        {
          onChanges: (c) => out({ ev: 'changes', root, paths: [...c.keys()] }),
          onRescan: (why) => out({ ev: 'rescan', root, why }),
          onGit: () => undefined,
          onMode: (mode) => out({ ev: 'mode', root, mode }),
          onReleased: () => out({ ev: 'released', root }),
        },
      )
      h?.setActive(true)
      return
    }
    case 'focus':
      return watcher?.focus()
    case 'limits':
      return setLimits(m.watches, m.instances)
    case 'counts': {
      const l = isAvailable(coreOs.watcher) ? coreOs.watcher.limits : null
      return out({ ev: 'counts', counts: watcher?.counts ?? {}, own: (await l?.ownWatches()) ?? 0, max: (await l?.max()) ?? null })
    }
  }
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  handle(JSON.parse(line) as ChildIn).catch((e: unknown) => out({ ev: 'error', message: String(e) }))
})
lines.on('close', () => {
  watcher?.dispose()
  process.exit(0)
})
