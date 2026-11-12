// The window's type sizes at a font size level (`general.fontSize`): each role's token (`--type-<role>-size`) moved by
// the level's offset. The settings store writes them on the document's root and takes them off again at Default, so
// the stylesheet's own values apply. Line heights stay, so rows keep their heights.

import { fontSizeOffset, type FontSizeLevel } from '@kea/protocol'
import { TYPE_SIZE_PX } from '@kea/ui/tokens'

/** Each type role's custom property and its value at the level; null at Default, where the stylesheet's applies. */
export function typeSizeVars(level: FontSizeLevel): [property: string, value: string | null][] {
  const offset = fontSizeOffset(level)
  return Object.entries(TYPE_SIZE_PX).map(([role, px]) => [`--type-${role}-size`, offset === 0 ? null : `${px + offset}px`])
}
