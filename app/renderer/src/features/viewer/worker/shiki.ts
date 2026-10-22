// The worker's one Shiki instance: TextMate grammars on the Oniguruma WASM engine, with the "Kea Dark"
// theme. Grammars load on first use (grammars.ts) and stay until the instance is disposed with its worker.
// Apart from the worker entry, only the unit tests build one (in Node, where the same WASM runs).

import { createShikiPrimitiveAsync } from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import type { IGrammar } from 'shiki/textmate'
import type { ShikiPrimitive, ThemeRegistration } from 'shiki/types'
import { roleOfColor, SYNTAX_THEME, syntaxThemeCopy } from '../syntax.ts'
import { GRAMMARS } from './grammars.ts'

export class ShikiGrammars {
  private shiki: Promise<ShikiPrimitive> | null = null
  private instance: ShikiPrimitive | null = null
  private roles = new Uint8Array(0)
  // bounded: one per language asked for, at most the keys of GRAMMARS; the window's recycling of the worker ends it
  private readonly asked = new Map<string, Promise<IGrammar | null>>()
  // bounded: the names of the grammars loaded, at most every grammar of Shiki's bundle; the same recycling ends it
  private readonly names = new Set<string>()

  private start(): Promise<ShikiPrimitive> {
    this.shiki ??= createShikiPrimitiveAsync({ engine: createOnigurumaEngine(import('shiki/wasm')), themes: [syntaxThemeCopy() as unknown as ThemeRegistration], langs: [] }).then((p) => {
      // the theme's colour map, resolved to role indexes once: a token's colour id → the role the window draws it with
      const { colorMap } = p.setTheme(SYNTAX_THEME.name)
      this.roles = Uint8Array.from(colorMap, (hex) => (typeof hex === 'string' ? roleOfColor(hex) : 0))
      this.instance = p
      return p
    })
    return this.shiki
  }

  /** The grammar of a language id of grammars.ts, loaded on first use; null for any other id. */
  grammar(lang: string): Promise<IGrammar | null> {
    let g = this.asked.get(lang)
    if (!g) {
      g = this.load(lang)
      this.asked.set(lang, g)
    }
    return g
  }

  private async load(lang: string): Promise<IGrammar | null> {
    const loader = Object.hasOwn(GRAMMARS, lang) ? GRAMMARS[lang] : undefined
    if (!loader) return null
    const [p, mod] = await Promise.all([this.start(), loader()])
    // the grammar and those it embeds (an HTML file's script and style blocks), each counted once
    for (const g of mod.default) this.names.add(g.name)
    await p.loadLanguage(mod.default)
    return p.getLanguage(lang)
  }

  /** Role index per theme colour id (syntax.ts); empty until the first grammar has loaded. */
  roleOf(): Uint8Array {
    return this.roles
  }

  /**
   * Grammars the instance holds, those another grammar brought with it included, each once whatever its aliases: the
   * count the window's recycling limit applies to.
   */
  count(): number {
    return this.names.size
  }

  dispose(): void {
    this.instance?.dispose()
    this.instance = null
    this.shiki = null
    this.asked.clear()
    this.names.clear()
  }
}
