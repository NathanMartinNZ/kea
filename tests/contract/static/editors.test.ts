// The editors installed on this machine against Kea's table of them (EDITOR_DEFS, app/core/src/editor/catalog.ts, with
// its Linux commands). It only looks: one Spotlight query (macOS) or the PATH, the known places and the desktop entries
// (Linux), and a few `stat`s, through the launcher's own detection with the system's host. Nothing is launched. An
// editor that is not installed is not checked (on a machine with none, the test checks nothing).

import fs from 'node:fs'
import path from 'node:path'
import { EDITOR_DEFS } from '@kea/core/src/editor/catalog.ts'
import { Editors } from '@kea/core/src/editor/editors.ts'
import { systemEditorHost } from '@kea/core/src/editor/host.ts'
import { noopLogger } from '@kea/kit'
import { describe, expect, it } from 'vitest'

describe('installed editors', () => {
  it('K-ED-1 · for each installed editor: its bundle id resolves to an app bundle that names that id, and the bundled CLI is there and executable (on Linux: its command-line tool, by one of its commands or beside its desktop entry’s program)', async () => {
    const host = systemEditorHost()
    const editors = new Editors({ log: noopLogger, host, env: () => Promise.resolve({ PATH: process.env.PATH ?? '' }) })
    const found = await editors.detect(true)
    editors.dispose()
    const ids = EDITOR_DEFS.map((d) => d.id)
    if (host?.kind === 'commands') {
      for (const { def, app } of found.editors) {
        expect(ids, def.id).toContain(def.id)
        expect(fs.statSync(app).isFile(), `${def.name}: ${app}`).toBe(true)
        expect(() => fs.accessSync(app, fs.constants.X_OK), `${def.name}: ${app} is executable`).not.toThrow()
        const names = [...def.linux.commands, ...def.linux.cliFromExec.map((r) => path.basename(r))]
        expect(names, `${def.name}: ${app}`).toContain(path.basename(app))
      }
      expect(found.editors.map((e) => e.def.id)).toEqual(ids.filter((id) => found.editors.some((e) => e.def.id === id)))
      return
    }
    for (const { def, app: bundle } of found.editors) {
      expect(ids, def.id).toContain(def.id)
      expect(fs.statSync(bundle).isDirectory(), `${def.name}: ${bundle}`).toBe(true)
      expect(bundle.endsWith('.app'), bundle).toBe(true)
      // the bundle is the one the table means: its Info.plist carries the bundle id (as text in either plist form)
      const plist = fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'))
      expect(plist.includes(def.bundleId), `${def.name}: Info.plist names ${def.bundleId}`).toBe(true)
      const cli = path.join(bundle, def.cli)
      expect(fs.statSync(cli).isFile(), `${def.name}: ${def.cli}`).toBe(true)
      expect(() => fs.accessSync(cli, fs.constants.X_OK), `${def.name}: ${def.cli} is executable`).not.toThrow()
    }
    // each editor at most once, in the table's order
    expect(found.editors.map((e) => e.def.id)).toEqual(ids.filter((id) => found.editors.some((e) => e.def.id === id)))
  })
})
