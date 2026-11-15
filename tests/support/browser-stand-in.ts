// A stand-in for the desktop's browser and file manager on Linux: a `.desktop` handler, named the default for web
// pages, web addresses and folders in a run's own HOME, that records what it is handed instead of opening it. Kea is
// launched with the variables below, so `xdg-open` takes its generic path with the system's own lists and BROWSER shut
// out, finds the stand-in and runs it: no real browser or file manager starts.
import fs from 'node:fs'
import path from 'node:path'
import { harnessUserHome } from '../../tools/perf/src/launch.ts'

const DESKTOP_ID = 'kea-stand-in.desktop'
const TYPES = ['text/html', 'application/xhtml+xml', 'x-scheme-handler/http', 'x-scheme-handler/https', 'x-scheme-handler/mailto', 'inode/directory']

export interface BrowserStandIn {
  /** The variables Kea is launched with so that `xdg-open` finds the stand-in. */
  readonly env: Record<string, string>
  /** What the stand-in was handed so far, one entry per launch. */
  handed(): string[]
}

/** Installs the stand-in for the run whose KEA_HOME is `runHome` (its HOME is `harnessUserHome(runHome)`). */
export function browserStandIn(runHome: string): BrowserStandIn {
  const home = harnessUserHome(runHome)
  const data = path.join(runHome, 'stand-in', 'data')
  const configDirs = path.join(runHome, 'stand-in', 'config')
  const marks = path.join(runHome, 'stand-in', 'handed')
  const script = path.join(runHome, 'stand-in', 'browser.sh')
  const mailcap = path.join(runHome, 'stand-in', 'mailcap')
  for (const d of [path.join(data, 'applications'), configDirs, marks, path.join(home, '.config'), path.join(home, '.local', 'share', 'applications')]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(script, `#!/bin/sh\nf=$(mktemp "${marks}/h.XXXXXX") || exit 1\nprintf '%s' "$1" > "$f"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(data, 'applications', DESKTOP_ID), `[Desktop Entry]\nType=Application\nName=Kea test stand-in\nExec=${script} %u\nMimeType=${TYPES.join(';')};\nNoDisplay=true\n`)
  // a .desktop file alone is no default: both lists name it, the one xdg-mime reads first and the older one
  const defaults = `[Default Applications]\n${TYPES.map((t) => `${t}=${DESKTOP_ID}`).join('\n')}\n`
  fs.writeFileSync(path.join(home, '.config', 'mimeapps.list'), defaults)
  fs.writeFileSync(path.join(home, '.local', 'share', 'applications', 'mimeapps.list'), defaults)
  fs.writeFileSync(mailcap, '')
  return {
    env: {
      // prepended: replacing the list would lose the shared MIME database, and xdg-mime could not type the page
      XDG_DATA_DIRS: `${data}:${process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share'}`,
      XDG_CONFIG_DIRS: configDirs,
      XDG_CURRENT_DESKTOP: 'X-Generic',
      MAILCAPS: mailcap,
      BROWSER: '',
    },
    handed: () =>
      fs
        .readdirSync(marks)
        .sort()
        .map((f) => fs.readFileSync(path.join(marks, f), 'utf8')),
  }
}
