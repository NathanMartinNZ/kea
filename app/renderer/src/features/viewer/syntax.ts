// The "Kea Dark" syntax theme as the viewer uses it. The one source is the generated TextMate theme
// (`@kea/ui/syntax-theme.json`, from constants/tokens.json): the highlight worker gives it to Shiki, and the window
// colours tokens by the theme's roles (`text`, `comment`, `keyword`, …), each a CSS class whose colour is read from the
// same file at run time. No colour is restated here.
//
// A token crosses from the worker as one number, `(start column << STYLE_BITS) | style`, where the style is its role's
// index plus the font-style bits. The theme uses no italics; bold is Markdown headings and underline is `invalid`.

import theme from '@kea/ui/syntax-theme.json'

export interface ThemeRule {
  name: string
  scope: string[]
  settings: { foreground: string; fontStyle?: string }
}

/** The TextMate theme itself, for Shiki. */
export const SYNTAX_THEME = theme as { name: string; type: string; colors: Record<string, string>; tokenColors: ThemeRule[] }

/** The theme's roles, in its order: a style's role index is an index here. `text` is first. */
export const SYNTAX_ROLES: readonly string[] = SYNTAX_THEME.tokenColors.map((r) => r.name)

export const STYLE_BITS = 8
export const STYLE_ROLE_MASK = 0x1f
export const STYLE_BOLD = 0x20
export const STYLE_UNDERLINE = 0x40
export const STYLE_ITALIC = 0x80
/** A token that looks like plain text: the `text` role with no font style. Nothing is drawn for it. */
export const STYLE_PLAIN = 0

/** The role a theme colour stands for: the first role with that colour (roles that share a colour look the same); `text` for any other. */
export function roleOfColor(hex: string): number {
  const i = ROLE_COLORS.indexOf(hex.toLowerCase())
  return i < 0 ? 0 : i
}

/** Each role's colour, taken once as the theme was generated: whoever is handed the theme later cannot move the roles. */
const ROLE_COLORS: readonly string[] = SYNTAX_THEME.tokenColors.map((r) => r.settings.foreground.toLowerCase())

/** The theme for a highlighter to keep: its own copy, because Shiki rewrites the theme it is given (it puts a rule in front of the others). */
export function syntaxThemeCopy(): typeof SYNTAX_THEME {
  return structuredClone(SYNTAX_THEME)
}

const CLASS_PREFIX = 'kea-tok-'
const classes: (string | undefined)[] = [] // bounded: one entry per style value, at most 2^STYLE_BITS

/** The CSS classes of a style: its role, and `kea-tok-b` / `kea-tok-u` / `kea-tok-i` for the font style. */
export function tokenClass(style: number): string {
  let c = classes[style]
  if (c === undefined) {
    c = CLASS_PREFIX + (SYNTAX_ROLES[style & STYLE_ROLE_MASK] ?? 'text')
    if (style & STYLE_BOLD) c += ` ${CLASS_PREFIX}b`
    if (style & STYLE_UNDERLINE) c += ` ${CLASS_PREFIX}u`
    if (style & STYLE_ITALIC) c += ` ${CLASS_PREFIX}i`
    classes[style] = c
  }
  return c
}

/** The stylesheet of the token classes, built from the theme: one rule per role, plus the font styles. */
export function syntaxCss(): string {
  const rules = SYNTAX_THEME.tokenColors.map((r) => `.${CLASS_PREFIX}${r.name}{color:${r.settings.foreground}}`)
  rules.push(`.${CLASS_PREFIX}b{font-weight:600}`, `.${CLASS_PREFIX}u{text-decoration:underline}`, `.${CLASS_PREFIX}i{font-style:italic}`)
  return rules.join('\n')
}
