// The agent service's file watches: each live agent session's status file and transcript, followed through core's one
// watch service (platform/watch), which owns every watch, its cap and its workarounds for the events Node's `fs.watch`
// loses on macOS (platform/watch/single.ts). This keeps count of the ones the agent service asked for, for its resource
// row (`core.agents.watches`) and its shutdown.

import type { FileWatch, WatchService } from '../platform/watch/service.ts'

/** One watched file: the watch service's own shape. */
export type { FileWatch }

export class AgentWatches {
  private readonly held = new Set<FileWatch>() // bounded: 2 per live agent session (its status file and its transcript)
  private readonly service: WatchService

  constructor(service: WatchService) {
    this.service = service
  }

  get size(): number {
    return this.held.size
  }

  /**
   * Watch `file` (absolute); `onChange` after each change, including its creation and removal. `within`: the folders
   * inside which an ancestor may be watched recursively while the file does not exist yet (the agent's config folder).
   */
  watch(file: string, onChange: () => void, within: readonly string[] = []): FileWatch {
    const w = this.service.file(file, onChange, { within })
    const h: FileWatch = {
      dispose: () => {
        if (this.held.delete(h)) w.dispose()
      },
      look: () => w.look(),
    }
    this.held.add(h)
    return h
  }

  dispose(): void {
    for (const h of [...this.held]) h.dispose()
  }
}
