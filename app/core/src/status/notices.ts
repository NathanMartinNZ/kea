// What status asks the notification policy to post or withdraw (N1…N5). Status decides that a notice is due; the
// policy (policy.ts) decides whether and how it is posted: only for a session not being viewed, coalesced, with
// N2 only for turns of at least L.notifyMinTurnMs and bursts merged, the sound, each kind's setting, and the
// badge. Unconfirmed statuses and reconciled ones never raise one.

import type { AccountCondition, AttentionItem } from '@kea/protocol'

export type StatusNotice =
  /** N1: the first attention item was added. `trust`: the trust question, notified only while the window is unfocused. */
  | { k: 'N1'; sessionId: string; item: AttentionItem; trust: boolean }
  /** N2: → `ready`. `turnMs`: the turn's length when its start was seen (short turns are not announced). */
  | { k: 'N2'; sessionId: string; turnMs: number | null; lastMessage: string | null; background: boolean }
  /** N3: → `failed` (not account-level), or detached `crashed` / `lost`. `reason`: `overloaded`, `exited 1`, `lost`. */
  | { k: 'N3'; sessionId: string; reason: string }
  /** The reason is gone (answered, viewed). `keys`: those attention items' notifications; all when absent. */
  | { k: 'withdraw'; sessionId: string; keys?: string[] }
  /** One prompt, one N1: a hook's item replaced the status file's item `from` for the same prompt; its notification is `to`'s now. */
  | { k: 'rekey'; sessionId: string; from: string; to: string }
  /** N4: an account condition opened, or a session joined it (updated in place). */
  | { k: 'N4'; condition: AccountCondition }
  /** N5: a usage limit reached its reset time. */
  | { k: 'N5'; condition: AccountCondition }
