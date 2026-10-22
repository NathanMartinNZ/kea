// The per-repository mutex: every git worktree mutation of one repository (`add`, `remove`, `prune`,
// `repair`) runs through it, one at a time, in the order asked. Keyed by the repository's git common directory.

export class RepoMutex {
  // bounded: one entry per repository with an operation queued or running; the entry goes when its queue drains
  private readonly tails = new Map<string, Promise<unknown>>()

  /** Run `fn` once every earlier operation on `repo` has finished (whether it succeeded or not). */
  run<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(repo) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    this.tails.set(repo, tail)
    void tail.then(() => {
      if (this.tails.get(repo) === tail) this.tails.delete(repo)
    })
    return run
  }

  /** Repositories with an operation queued or running (the resource report). */
  get size(): number {
    return this.tails.size
  }
}
