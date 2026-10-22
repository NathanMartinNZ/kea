// The utility process of Kea's admission test app (main.js): it connects to the holder's socket KEA_ADMISSION_SOCK,
// says HELLO (type 0x01, length 2, proto 1) and writes what became of it to KEA_ADMISSION_RESULT: `admitted` (the
// holder answered HELLO, 0x81), `refused` (the holder closed it) or `error <code>`. Once at start when
// KEA_ADMISSION_SOCK is set, and again at each message from main.
const fs = require('node:fs')
const net = require('node:net')

function attempt() {
  const { KEA_ADMISSION_SOCK: sock, KEA_ADMISSION_RESULT: result } = process.env
  if (!sock || !result) return
  const s = net.connect(sock)
  let said = false
  const say = (what) => {
    if (said) return
    said = true
    fs.writeFileSync(result, what)
    s.destroy()
  }
  s.on('connect', () => s.write(Buffer.from([0x01, 2, 0, 0, 0, 1, 0])))
  s.on('data', (d) => say(d[0] === 0x81 ? 'admitted' : `answered ${d[0]}`))
  s.on('close', () => say('refused'))
  s.on('error', (e) => say(`error ${e.code}`))
}

process.parentPort.on('message', attempt)
attempt()
setInterval(() => {}, 1 << 30)
