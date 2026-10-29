// The whole renderer → core RPC surface: one API per feature file, joined here. Core serves it on every window's RPC
// port; the renderer's client is typed by it. A feature that adds calls adds its API to this list.
import { agentsApi } from './agents.ts'
import { hintsApi } from './banners.ts'
import { diagnosticsApi } from './diagnostics.ts'
import { diskApi } from './disk.ts'
import { editorApi } from './editor.ts'
import { filesApi } from './files.ts'
import { keybindingsApi } from './keybindings.ts'
import { defineApi } from './rpc.ts'
import { serverApi } from './server.ts'
import { projectsApi, sessionsApi } from './sessions.ts'
import { settingsApi } from './settings.ts'
import { statusApi } from './status.ts'
import { coreTerminalApi } from './terminal.ts'
import { viewerApi } from './viewer.ts'
import { visibleApi } from './visible.ts'
import { worktreesApi } from './worktrees.ts'

export const coreApi = defineApi({ ...coreTerminalApi, ...projectsApi, ...sessionsApi, ...worktreesApi, ...settingsApi, ...statusApi, ...agentsApi, ...visibleApi, ...editorApi, ...serverApi, ...viewerApi, ...filesApi, ...keybindingsApi, ...diagnosticsApi, ...diskApi, ...hintsApi })
export type CoreApi = typeof coreApi
