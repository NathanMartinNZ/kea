// graceful-fs as the macOS updater's bundle has it (tools/build.ts): Node's own fs, copied, and a gracefulify that
// does nothing. The updater's fs-extra and jsonfile use graceful-fs only as an fs-like object, while the real package,
// once loaded, patches the process's fs (a retry queue behind every close, a cached process.cwd): main loads the
// updater late, into a process whose fs must stay as it is.
'use strict'

module.exports = { ...require('node:fs'), gracefulify() {} }
