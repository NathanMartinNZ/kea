// ptyhost's OS layer: its one capability that differs by system, how the holders it launches recognise their client.
// Callers import this file only; `select.ts` picks `darwin.ts` or `linux.ts` once, at start.
import type { NotAvailable, System } from '@kea/protocol'

/**
 * How a holder is told its client: the launcher's option and its value. macOS: `--client-req` and a code requirement.
 * Linux: `--client-exe` and the executable, checked in full, or `--client-exe-unchecked` and the executable, checked by
 * its identity only.
 */
export interface ClientOption {
  readonly option: '--client-req' | '--client-exe' | '--client-exe-unchecked'
  readonly value: string
}

/** `clientRequirement()`: what the holders ptyhost launches admit as their client. */
export interface ClientRequirement {
  /** The client option for the executable at `execPath` (ptyhost's own in production). */
  of(execPath: string): Promise<ClientOption>
  /**
   * The option for an executable that is not Kea's own build of Electron (a test runner's node): macOS, its code
   * signature as `of` reads it (an ad-hoc node has its `cdhash`); Linux, `--client-exe-unchecked`, since such a process
   * is no utility process of Kea's main.
   */
  unchecked(execPath: string): Promise<ClientOption>
}

export interface PtyhostOs {
  readonly system: System
  readonly clientRequirement: ClientRequirement | NotAvailable
}

export { ptyhostOs } from './select.ts'
