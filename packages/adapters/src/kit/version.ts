// Version gates: features keyed on `detect().version`; an unknown newer version is assumed compatible.

/** `a` vs `b` as dotted numeric versions (`2.1.296`): negative, 0, positive. Missing parts count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/** At or above `min`. An unknown version (null) is not assumed supported; a newer one always is. */
export function atLeast(version: string | null, min: string): boolean {
  return version !== null && compareVersions(version, min) >= 0
}
