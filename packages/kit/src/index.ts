// @kea/kit — runtime building blocks for main, core and ptyhost. See README.md.

export { monotonicMs, wallMs, systemClock } from './clock.ts'
export type { Clock, TimerHandle } from './clock.ts'

export {
  DisposableStore,
  DisposableTracker,
  MutableDisposable,
  combinedDisposable,
  disposeAll,
  getDisposableTracker,
  isDisposable,
  markAsDisposed,
  markAsSingleton,
  noopDisposable,
  setDisposableTracker,
  setParentOfDisposable,
  toDisposable,
  trackDisposable,
} from './disposable.ts'
export type { Disposable, TrackedDisposable } from './disposable.ts'

export { Scope } from './scope.ts'
export type { DomStyleTarget, ListenOptions, ListenTarget, NodeStyleTarget, ScopeOptions } from './scope.ts'

export { Emitter, once } from './emitter.ts'
export type { EmitterOptions, Event, Listener } from './emitter.ts'

export { BoundedQueue, LruCache } from './lru.ts'
export type { BoundedQueueOptions, EvictReason, LruOptions, OverflowPolicy } from './lru.ts'

export { HeldLimitError, POOL_LIMITS, PoolFullError, SpawnError, activeCount, heldCount, launchDetached, queuedCount, runHeld, runProcess } from './runProcess.ts'
export type { HeldOptions, LaunchOptions, Pool, ProcessResult, RunProcessOptions, SpawnFailure } from './runProcess.ts'

export { GitCommandError, git, gitBinary, gitEnv, gitText, setGitBinary } from './git.ts'
export type { GitOptions } from './git.ts'

export { allPairs, createFsm } from './fsm.ts'
export type { Fsm, FsmDef, FsmHandler, FsmPair, FsmTable, SendResult, Transition, TransitionRecord } from './fsm.ts'

export { Supervisor } from './supervisor.ts'
export type {
  ExitReason,
  SupervisedChild,
  SupervisorExitEvent,
  SupervisorOptions,
  SupervisorRestartEvent,
  SupervisorStartEvent,
  SupervisorState,
} from './supervisor.ts'

export { atomicWrite, atomicWriteSync } from './atomicWrite.ts'
export type { AtomicWriteOptions } from './atomicWrite.ts'

export { CrossDeviceError, emptyTrash, emptyTrashEntry, moveToTrash, type MoveToTrashOptions } from './trash.ts'

export { tryLock } from './flock.ts'

export { createLogger, createMemoryLogger, formatLine, noopLogger } from './logger.ts'
export type { FileLogger, FileLoggerOptions, LogEntry, LogFields, LogLevel, Logger, MemoryLogger, ProcessName } from './logger.ts'

export { createResourceRegistry, registerSingletonGauge, resources } from './resources.ts'
export type { Counter, GaugeValue, ResourceRegistry, ResourceReport } from './resources.ts'

export { ptyId, ulid, ULID_RE, ulidTime } from './ids.ts'

export { ensurePrivateDir, fnv1a64, isOwnSocket, runDir, socketPath, UnsafePathError } from './rundir.ts'
export { rootOnlyFile, type StatFs } from './rootOnly.ts'
export { holdersHidden } from './visibility.ts'
export { fileName, nameKey, namesAsStored } from './names.ts'
