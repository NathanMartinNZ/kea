import { mount } from 'svelte'
import '@kea/ui/tokens.css'
import '@kea/ui/ui.css'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import './shell/window.css'
import App from './shell/App.svelte'
import { installPerfProbes } from './lib/perf.ts'
import { installTestProbes } from './lib/testProbes.ts'
import { platform } from './lib/bridge.ts'
import { installCommands } from './features/commands/install.ts'
import { installResourceReport } from './features/resources/report.ts'
import { installSessionsState } from './features/sessions/state.svelte.ts'
import { installVisible } from './features/sessions/visible.ts'
import { installStatusState } from './features/status/state.ts'
import { installWindowTitle } from './features/status/title.ts'
import { installViewing } from './features/status/viewing.svelte.ts'
import { settings } from './features/settings/store.ts'
import { installBanners } from './shell/bannerStore.ts'
import { installMenuBar } from './shell/menuBar.ts'
import { installWindowMenu } from './shell/windowMenu.ts'

installCommands()
installResourceReport()
settings.install()
installSessionsState()
installVisible()
installStatusState()
installViewing()
installWindowTitle()
installBanners()
installMenuBar()
installWindowMenu()
if (platform.perf) {
  installPerfProbes()
  installTestProbes()
}

// Svelte 5: one mount for the window's lifetime; a reload replaces the page
mount(App, { target: document.getElementById('root')! })
