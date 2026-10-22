// Open in editor: the one call every way of opening a file in the editor goes through — the header's `Code` button, the
// tree, the Changes list, the finder's `⌘↵`, a viewer tab's `⌘↵`, a `⌘`-click on a path in a terminal. With it, what
// else leaves Kea for a session's folder: the editors and tools found installed, the terminal app, the pull request
// page (`session.createPR`), and the check that a path printed in a terminal is a file of the session.

import { z } from 'zod'
import { zWorktreePath } from './files.ts'
import { L } from './generated/limits.ts'
import { defineApi } from './rpc.ts'
import { EDITORS } from './settings.ts'
import { zSessionId } from './terminal.ts'

/** Where a path is resolved: a session's working directory, or a project's root. */
export const EDITOR_TARGETS = ['session', 'project'] as const
export type EditorTarget = (typeof EDITOR_TARGETS)[number]

/**
 * Why nothing opened. `unavailable`: there is no editor to launch. `failed`: every launch strategy failed; `message` is
 * the last attempt's stderr.
 */
export const EDITOR_OPEN_FAILURES = ['unavailable', 'failed'] as const
export type EditorOpenFailure = (typeof EDITOR_OPEN_FAILURES)[number]

export const zEditorOpenRequest = z.object({
  target: z.enum(EDITOR_TARGETS),
  /** The session's or the project's id. */
  id: zSessionId,
  /** A file in that directory; omitted, the directory itself opens as a folder. */
  path: zWorktreePath.optional(),
  /** 1-based; without `path` they mean nothing. */
  line: z.number().int().min(1).optional(),
  col: z.number().int().min(1).optional(),
  /** One of the detected editors, by the id detection gives it; omitted, the default editor. */
  editor: z.string().min(1).optional(),
})
export type EditorOpenRequest = z.infer<typeof zEditorOpenRequest>

export const zEditorOpenResult = z.object({
  ok: z.boolean(),
  /** The editor that was launched, or would have been; null when none is known. */
  editor: z.string().nullable(),
  reason: z.enum(EDITOR_OPEN_FAILURES).nullable(),
  message: z.string().nullable(),
})
export type EditorOpenResult = z.infer<typeof zEditorOpenResult>

/** An editor Kea can launch. `id` is a value of the `general.defaultEditor` setting. */
export const zEditorInfo = z.object({ id: z.enum(EDITORS), name: z.string() })
export type EditorInfo = z.infer<typeof zEditorInfo>

/** What was found installed, and what the split button does with it. */
export const zEditorList = z.object({
  /** The installed editors, in the order of core's editor catalog. Only these are listed. */
  editors: z.array(zEditorInfo),
  /** The editor the primary click opens; null when the default editor is not installed (`Open in…`). */
  default: z.enum(EDITORS).nullable(),
  /** The `general.defaultEditor` setting, installed or not. */
  configured: zEditorInfo,
  /** The terminal app "Open in Terminal App" opens; null when none was found. */
  terminalApp: z.object({ name: z.string() }).nullable(),
  /** `session.createPR`: the GitHub CLI is installed. */
  gh: z.boolean(),
})
export type EditorList = z.infer<typeof zEditorList>

/** The window's state before core's first answer: nothing found yet (the button reads `Open in…`). */
export const NO_EDITORS: EditorList = { editors: [], default: null, configured: { id: 'vscode', name: 'VS Code' }, terminalApp: null, gh: false }

/** The split button's label: the default editor's short name (`Code`), or `Open in…`. */
export const EDITOR_BUTTON_LABEL: Record<(typeof EDITORS)[number], string> = { vscode: 'Code', 'vscode-insiders': 'Insiders', cursor: 'Cursor', windsurf: 'Windsurf', zed: 'Zed' }

/** What a launch outside Kea answers: never a rejection for a predictable state. `message`: the tool's last words. */
export const zLaunchResult = z.object({ ok: z.boolean(), reason: z.enum(EDITOR_OPEN_FAILURES).nullable(), message: z.string().nullable() })
export type LaunchResult = z.infer<typeof zLaunchResult>

/** Why no pull request page opened: no GitHub CLI, no branch (an in-place session), or `gh` said why (`message`). */
export const CREATE_PR_FAILURES = ['noGh', 'noBranch', 'failed'] as const
export type CreatePrFailure = (typeof CREATE_PR_FAILURES)[number]

/**
 * A file reference printed in a terminal, as written: relative to the session's working directory, absolute,
 * or `~/…`. Core answers with the path relative to the working directory when it is a file whose real path stays
 * inside it, else null.
 */
export const zLinkCandidate = z.string().min(1).max(L.terminalLinkPathMaxChars)

/** Methods core serves to the renderer for editors. */
export const editorApi = defineApi({
  /** Launch the editor. Never rejects for a predictable state: the result says why not. */
  'editor.open': { args: zEditorOpenRequest, result: zEditorOpenResult },
  /** What is installed. Answered from the cache (L.editorDetectCacheMs) unless it has expired; `fresh` looks again now. */
  'editor.list': { args: z.object({ fresh: z.boolean().optional() }), result: zEditorList },
  /** The session's (or project's) folder in the terminal app. */
  'editor.openTerminalApp': { args: z.object({ target: z.enum(EDITOR_TARGETS), id: zSessionId }), result: zLaunchResult },
  /** `session.createPR`: `gh pr create --web` in the session's worktree. */
  'editor.createPR': { args: z.object({ sessionId: zSessionId }), result: z.object({ ok: z.boolean(), reason: z.enum(CREATE_PR_FAILURES).nullable(), message: z.string().nullable() }) },
  /** Which of these printed paths are files of the session (one answer per candidate, in order). */
  'editor.resolvePaths': {
    args: z.object({ sessionId: zSessionId, paths: z.array(zLinkCandidate).max(L.terminalLinkCandidatesMax) }),
    result: z.object({ paths: z.array(zWorktreePath.nullable()) }),
  },
})
