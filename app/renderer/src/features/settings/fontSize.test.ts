import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FONT_SIZES, L } from '@kea/protocol'
import { TYPE_SIZE_PX } from '@kea/ui/tokens'
import { typeSizeVars } from './fontSize.ts'

const TOKENS_CSS = fs.readFileSync(new URL('../../../../../packages/ui/src/generated/tokens.css', import.meta.url), 'utf8')

describe('the window’s type sizes', () => {
  it('U-SET-14 · each font size level moves every type role’s size by its offset; Default leaves the stylesheet’s sizes', () => {
    expect(typeSizeVars('default').map(([, v]) => v)).toEqual(Object.keys(TYPE_SIZE_PX).map(() => null))
    for (const [i, level] of FONT_SIZES.entries()) {
      if (level === 'default') continue
      const steps = i - FONT_SIZES.indexOf('default')
      expect(typeSizeVars(level), level).toEqual(Object.entries(TYPE_SIZE_PX).map(([role, px]) => [`--type-${role}-size`, `${px + steps * L.fontSizeStep}px`]))
    }
    // the properties are the stylesheet's own, each set there to the token's size
    for (const [role, px] of Object.entries(TYPE_SIZE_PX)) expect(TOKENS_CSS).toContain(`--type-${role}-size: ${px}px;`)
  })
})
