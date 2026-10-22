// The slice of the xterm.js API this package uses. `@xterm/headless` (ptyhost mirrors) and `@xterm/xterm`
// (renderer) share it, so the query table and the mode tracker work on either.

export interface Disposable {
  dispose(): void
}

export interface FunctionIdentifier {
  prefix?: string
  intermediates?: string
  final: string
}

export type CsiParams = (number | number[])[]

export interface ParserApi {
  registerCsiHandler(id: FunctionIdentifier, callback: (params: CsiParams) => boolean | Promise<boolean>): Disposable
  registerDcsHandler(id: FunctionIdentifier, callback: (data: string, params: CsiParams) => boolean | Promise<boolean>): Disposable
  registerEscHandler(id: FunctionIdentifier, callback: () => boolean | Promise<boolean>): Disposable
  registerOscHandler(ident: number, callback: (data: string) => boolean | Promise<boolean>): Disposable
}

export interface ModesApi {
  readonly applicationCursorKeysMode: boolean
  readonly applicationKeypadMode: boolean
  readonly bracketedPasteMode: boolean
  readonly insertMode: boolean
  readonly mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any'
  readonly originMode: boolean
  readonly reverseWraparoundMode: boolean
  readonly sendFocusMode: boolean
  readonly showCursor: boolean
  readonly synchronizedOutputMode: boolean
  readonly wraparoundMode: boolean
}

export interface BufferApi {
  readonly type: 'normal' | 'alternate'
  readonly cursorX: number
  readonly cursorY: number
  readonly baseY: number
}

/** The serialize addon's surface (`@xterm/addon-serialize`), loaded by ptyhost per checkpoint. */
export interface SerializerApi {
  serialize(options?: { range?: { start: number; end: number }; excludeModes?: boolean; excludeAltBuffer?: boolean; scrollback?: number }): string
}

/**
 * The options a sequence can change or a tracker needs: LNM (`CSI 20 h`) sets `convertEol`, and tab stops are laid
 * every `tabStopWidth` columns. Both xterm.js packages report every option, defaults included.
 */
export interface OptionsApi {
  readonly convertEol: boolean
  readonly tabStopWidth: number
}

export interface TerminalApi {
  readonly parser: ParserApi
  readonly modes: ModesApi
  readonly options: OptionsApi
  readonly rows: number
  readonly cols: number
  readonly buffer: { readonly active: BufferApi; readonly normal: BufferApi }
  onResize(listener: (e: { cols: number; rows: number }) => void): Disposable
  write(data: string | Uint8Array, callback?: () => void): void
}

/**
 * The i-th parameter. xterm.js's public API lists a parameter's sub-parameters as an array right after it
 * (`CSI 1:2;3 h` → `[1, [2], 3]`), so they are skipped when counting, as xterm.js's own handlers ignore them.
 */
export function p0(params: CsiParams, i = 0, dflt = 0): number {
  return nums(params)[i] ?? dflt
}

/** Top-level numeric params only. */
export function nums(params: CsiParams): number[] {
  const out: number[] = []
  for (const v of params) if (typeof v === 'number') out.push(v)
  return out
}

export function disposeAll(ds: Iterable<Disposable>): void {
  for (const d of ds) {
    try {
      d.dispose()
    } catch {
      // a disposer must never stop the others
    }
  }
}
