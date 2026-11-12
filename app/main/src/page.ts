// Open in Browser: a web page of a worktree, handed to the default browser (the OS layer's `browser`) at the window's
// request. Main checks the request itself, whatever the window decided: an absolute path as written (no `.` or `..`
// segment), of a page type by its name and by the real file's (protocol `isPage`), whose real path lies inside a
// working directory the asking window shows (keaFile.ts `openVisibleFile`), a regular file without an execute bit.
// The browser then runs the page's scripts from a `file:` address, as it does for a page opened from the file manager.

import path from 'node:path'
import { isPage } from '@kea/protocol'
import { openVisibleFile, type KeaFileRefusal } from './keaFile.ts'

export type PageRefusal = KeaFileRefusal | 'executable'

/** What the window says for each refusal. */
export const PAGE_REFUSALS: Readonly<Record<PageRefusal, string>> = {
  url: 'The file is not inside the session folder',
  outside: 'The file is not inside the session folder',
  type: 'Only a web page opens in the browser',
  missing: 'The file is gone',
  special: 'The file could not be opened',
  large: 'The file could not be opened',
  executable: 'Executable files are not opened from here',
}

/** The page `asked` names, as its real path, or why it is not opened. `dirs`: the working directories the asking window shows. */
export async function resolvePage(asked: unknown, dirs: readonly string[]): Promise<{ ok: true; real: string } | { ok: false; why: PageRefusal }> {
  if (typeof asked !== 'string' || asked.includes('\0') || !path.isAbsolute(asked) || path.normalize(asked) !== asked) return { ok: false, why: 'url' }
  const a = await openVisibleFile(asked, dirs, isPage)
  if (!a.ok) return { ok: false, why: a.why }
  await a.fh.close().catch(() => undefined)
  // opening an executable file can run it, whatever its name says
  if ((a.stat.mode & 0o111) !== 0) return { ok: false, why: 'executable' }
  return { ok: true, real: a.real }
}
