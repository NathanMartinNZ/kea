// Kea's admission test app: a windowless Electron main that forks one utility process running Node's service,
// as Kea's main forks ptyhost, and writes both pids to KEA_ADMISSION_OUT. Installed root-owned as
// `/opt/kea-test/resources/app` beside a copy of Electron (`/opt/kea-test/kea-app`): see the README next to it.
const { app, utilityProcess } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

app.whenReady().then(() => {
  const child = utilityProcess.fork(path.join(__dirname, 'utility.js'), [], { serviceName: 'Kea admission test', stdio: 'ignore' })
  child.on('spawn', () => fs.writeFileSync(process.env.KEA_ADMISSION_OUT, JSON.stringify({ main: process.pid, utility: child.pid })))
  // SIGUSR1: the utility process tries the holder's socket again
  process.on('SIGUSR1', () => child.postMessage('connect'))
})
