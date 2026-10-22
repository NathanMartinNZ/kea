// A watch service for tests: it follows nothing. A test tells it what changed with `fire`, so code written against
// `WatchService` (the viewer's live reload, the dev server's `start.sh` detection) runs without the file system. Core's
// real service is `Watcher` (watcher.ts).

import path from 'node:path'
import type { Disposable } from '@kea/kit'
import type { FileWatch, WatchService } from './service.ts'

interface Entry {
  kind: 'file' | 'dir'
  path: string
  onChange: () => void
}

export class StubWatchService implements WatchService {
  private readonly entries = new Set<Entry>() // bounded: what its callers follow; each leaves on dispose (a stand-in: core's real watches are capped by `Watcher`)

  file(file: string, onChange: () => void): FileWatch {
    const e: Entry = { kind: 'file', path: file, onChange }
    this.entries.add(e)
    return { dispose: () => void this.entries.delete(e), look() {} }
  }

  dir(dir: string, onChange: () => void): Disposable {
    const e: Entry = { kind: 'dir', path: dir, onChange }
    this.entries.add(e)
    return { dispose: () => void this.entries.delete(e) }
  }

  /** Tests: `changed` (absolute) was created, written, removed or replaced. Calls who follows it: the file, or its directory's entries. */
  fire(changed: string): void {
    for (const e of [...this.entries]) {
      if (!this.entries.has(e)) continue
      if (e.kind === 'file' ? e.path === changed : e.path === path.dirname(changed)) e.onChange()
    }
  }

  /** Tests: what is followed now. */
  watched(): { kind: 'file' | 'dir'; path: string }[] {
    return [...this.entries].map((e) => ({ kind: e.kind, path: e.path }))
  }

  get size(): number {
    return this.entries.size
  }
}
