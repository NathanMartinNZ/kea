// The `updates.check` setting, kept current in main: main checks for updates by itself only once core has said the
// switch is on in this run. Sent once at start, then on each change of that value (other settings' changes send
// nothing).

/** Send the value now, then whenever it changes; returns the unsubscribe function. */
export function watchUpdatesSetting(o: { check: () => boolean; onSettings: (cb: () => void) => () => void; send: (check: boolean) => void }): () => void {
  let last = o.check()
  o.send(last)
  return o.onSettings(() => {
    const now = o.check()
    if (now === last) return
    last = now
    o.send(now)
  })
}
