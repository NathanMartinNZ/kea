// What a session's Branch scope compares against: `git merge-base HEAD <base branch>`, or the session's base commit
// when there is no base branch (or it was deleted). It is computed once and kept: only `HEAD` moving or a ref changing
// can move it, and both are told here (`moved()`, from the git-dir and common-dir events, or from a status whose `HEAD`
// commit differs from the one the base was computed for). Never used stale after either.

export interface BaseInputs {
  /** `HEAD`'s commit as the status that needs the base reported it; null before the first commit. */
  head: string | null
  /** The session's base branch, if it has one. */
  baseBranch: string | null
  baseCommit: string | null
}

export interface BaseResult {
  /** The commit to compare against (a full object id); null: none (no commit yet, or nothing to compare with). */
  base: string | null
  /** The base branch the merge base was taken with; null when the base commit stood in. */
  branch: string | null
}

export type ComputeBase = (inputs: BaseInputs) => Promise<BaseResult>

export class BaseCache {
  private cached: { head: string | null; baseBranch: string | null; baseCommit: string | null; result: BaseResult } | null = null
  private dirty = false
  /** How many times the base was computed (I-GS-2: once until something moves). */
  computed = 0
  private readonly compute: ComputeBase

  constructor(compute: ComputeBase) {
    this.compute = compute
  }

  /** `HEAD` or a ref moved (or may have: a rescan, a poll): the next `get` computes again. */
  moved(): void {
    this.dirty = true
  }

  /** The cached result, if one stands for these inputs. */
  peek(inputs: BaseInputs): BaseResult | null {
    const c = this.cached
    return c && !this.dirty && c.head === inputs.head && c.baseBranch === inputs.baseBranch && c.baseCommit === inputs.baseCommit ? c.result : null
  }

  async get(inputs: BaseInputs): Promise<BaseResult> {
    const hit = this.peek(inputs)
    if (hit) return hit
    // a move that arrives while this runs must not be lost: it is for the next `get`
    this.dirty = false
    this.computed++
    const result = await this.compute(inputs)
    if (!this.dirty) this.cached = { ...inputs, result }
    return result
  }

  /** What stands now: the last computed base and what it was computed for, unless something has moved since. */
  get standing(): { head: string | null; baseBranch: string | null; baseCommit: string | null; result: BaseResult } | null {
    return this.dirty ? null : this.cached
  }

  /** The last result, whatever has moved since (a caller that only wants a hint). */
  get last(): BaseResult | null {
    return this.cached?.result ?? null
  }
}
