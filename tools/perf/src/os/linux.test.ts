import { describe, expect, it } from 'vitest'
import { statTicks, unixSocketsAt } from './linux.ts'

describe('the harnesses’ Linux readings (os/linux.ts)', () => {
  it('U-PERF-11 · CPU time from a /proc stat line, its fields counted after the name’s last parenthesis (a name may hold spaces and parentheses); a holder’s sockets from /proc/net/unix by their path, the listening one and each accepted connection, no other path, no prefix', () => {
    // utime 1234, stime 56 (fields 14 and 15); the name holds ") S 9"
    const stat = '4268 (Kea ) S 9 (x)) S 4265 4265 4192 0 -1 4194560 3 0 0 0 1234 56 0 0 20 0 1 0 33132 1 2'
    expect(statTicks(stat)).toBe(1290)
    expect(statTicks('garbage')).toBeNull()
    const sock = '/tmp/kea-1000/abc/run/p1.sock'
    const table = [
      'Num       RefCount Protocol Flags    Type St Inode Path',
      `0000000000000000: 00000002 00000000 00010000 0001 01 21001 ${sock}`,
      `0000000000000000: 00000003 00000000 00000000 0001 03 21002 ${sock}`,
      `0000000000000000: 00000003 00000000 00000000 0001 03 21003 ${sock}`,
      `0000000000000000: 00000002 00000000 00010000 0001 01 21004 ${sock}.old`,
      '0000000000000000: 00000003 00000000 00000000 0001 03 21005',
      '0000000000000000: 00000002 00000000 00010000 0001 01 21006 @kea-abstract',
      '0000000000000000: 00000002 00000000 00010000 0001 01 21007 /tmp/with space/p.sock',
    ].join('\n')
    expect(unixSocketsAt(table, sock)).toBe(3)
    expect(unixSocketsAt(table, '/tmp/with space/p.sock'), 'a path with a space').toBe(1)
    expect(unixSocketsAt(table, '/tmp/kea-1000/abc/run/p1'), 'no prefix').toBe(0)
  })
})
