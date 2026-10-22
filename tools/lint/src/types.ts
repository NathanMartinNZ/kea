/** One lint finding, printed as `file:line rule message`. */
export type Violation = { file: string; line: number; rule: string; message: string }

export function formatViolation(v: Violation): string {
  return `${v.file}:${v.line} ${v.rule} ${v.message}`
}
