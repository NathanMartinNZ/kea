// @kea/adapters — the only place agent-specific knowledge lives. See README.md.

export type { AgentAdapter, AgentSettingsLike, Detection, Disposable, Env, LaunchContext, RawAgentSignal, ReconcileResult, SessionRecord, SessionSignals, SpawnSpec, TranscriptWatch, WatchFile } from './types.ts'
export { AdapterRegistry, ADAPTERS, agentCommands, defaultRegistry } from './registry.ts'
export { JsonlTailer, parseLine, readTail } from './kit/jsonl.ts'
export { activityNotes, Tier3, TIER3_KEYS } from './kit/heuristics.ts'
export { atLeast, compareVersions } from './kit/version.ts'
export { editEnv, findOnPath, internalKeys } from './kit/env.ts'
export { atMention } from './kit/mention.ts'
