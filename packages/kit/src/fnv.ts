// FNV-1a 64-bit: the one hash of a KEA_HOME, the same in native/kea-helper (`rundir::fnv1a64`). It names the run
// dir's socket folder, and in the helper also the holders' systemd scopes.

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

/** FNV-1a 64-bit over the UTF-8 bytes of `str`, as 16 lowercase hex digits. */
export function fnv1a64(str: string): string {
  let h = FNV_OFFSET
  for (const b of new TextEncoder().encode(str)) {
    h ^= BigInt(b)
    h = (h * FNV_PRIME) & MASK_64
  }
  return h.toString(16).padStart(16, '0')
}
