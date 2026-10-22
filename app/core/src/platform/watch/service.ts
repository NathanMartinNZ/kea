// The watch service's interface: everything in core that follows the file system asks here, so the number of kernel
// watches and FSEvents streams has one owner and one cap. The service is `Watcher` (watcher.ts: worktree
// subscriptions through `@parcel/watcher`, batching, the exclusions, poll-only mode); `StubWatchService`
// (stub.ts) follows nothing and is what a test passes to drive changes by hand. Worktrees are followed through
// `Watcher.worktree` (the files service's alone); this interface is what every other module may ask.
//
// What a consumer may ask for:
//   file   one file followed: its creation, each write, its removal or replacement. Inside a subscribed worktree the
//          service answers from that worktree's stream (no watch of its own: the viewer's open file); elsewhere
//          it is a single-file watch (the agent's status file and transcript, settings.json).
//   dir    a directory's own entries followed, not what lies below them: an entry added, removed or renamed
//          (`start.sh` appearing in a worktree's root). The directory need not exist yet (a session shown
//          while its worktree is still being made): it is waited for on its nearest existing ancestor, that folder's
//          own entries only, and its appearance is a change like any other; so is its removal, after which it is
//          waited for again. A removal that takes the directory's parent with it is the one thing not heard at once:
//          the service finds it the next time it looks at its directories (single.ts).
//
// Both call `onChange` with no arguments, coalesced (several kernel events for one write are one call, at most one
// call per event batch), never during the call that set them up, and never after `dispose`. The consumer looks at
// the file system itself: the service does not say what changed. Paths are absolute. Read-only: nothing is ever
// written.
// On it: the status-file and transcript watches (`agents/watch.ts`, set up in `agents/agents.ts`), the settings file
// (`settings/settings.ts` `watch()`), `keybindings.json` (`settings/keybindings.ts`) and the Ghostty config
// (`settings/ghostty.ts`).

import type { Disposable } from '@kea/kit'

/** One followed file. */
export interface FileWatch extends Disposable {
  /**
   * Look again if the watch is not on its file yet: the caller has a sign the file may be there now (its writer is
   * running). The events saying its folders appeared can be lost, and where the ancestor watched is not recursive no
   * deeper write is heard either, so nothing else would find it. Nothing to do once the file itself is watched. The
   * service looks by itself once the directory stream has settled after a restart (single.ts); this is for a
   * file that appears later than that, unheard.
   */
  look(): void
}

export interface FileWatchRequest {
  /**
   * Folders inside which an ancestor may be watched recursively while the file does not exist yet (none: never
   * recursive). The path is sometimes another program's to choose: outside these a watch never listens to more than
   * one directory.
   */
  within?: readonly string[]
}

export interface WatchService {
  /** Follow `path` (a file, which need not exist yet). A watch refused at the service's cap is inert: it never fires. */
  file(path: string, onChange: () => void, o?: FileWatchRequest): FileWatch
  /**
   * Follow the entries of the directory `path` itself, which need not exist yet: its appearance and its removal are
   * changes too. Inert only when refused at the service's cap.
   */
  dir(path: string, onChange: () => void): Disposable
}
