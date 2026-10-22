// tools/mock-model: a local Anthropic Messages API stand-in for the real `claude` binary.
export { type MockModel, type MockModelOptions, type ScriptedReply, DEFAULT_MODELS, startMockModel } from './server.ts'
export { apiError, type ErrorReply, type MessageReply, type Reply, type ReplyBlock, text, toolUse } from './reply.ts'
export {
  type Answer,
  firstUserTexts,
  isAgentLoop,
  isInjected,
  type Match,
  type Matcher,
  matches,
  messagesOf,
  type RecordedRequest,
  systemText,
  textBlocks,
  toJson,
  toolNames,
} from './request.ts'
