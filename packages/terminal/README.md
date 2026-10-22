# packages/terminal

Everything both terminal sides must agree on: the ptyhost mirror (`@xterm/headless`) and the renderer's terminal
(`@xterm/xterm`). It holds the options both are created with, the one query table (who answers each terminal query),
the mode trailer that makes snapshots faithful, and the ground-state scanner that decides where a snapshot may be cut.
It has no process of its own and imports neither xterm package at runtime. Callers pass their terminal in; only the
tests load `@xterm/headless`.

| Module | What |
|---|---|
| `options.ts` | `createTerminalOptions({ side })`: the same parser, buffer and VT extensions on both sides (kitty keyboard on, colour-scheme query off). Window reports are off; the mirror allows only `CSI 14/16/18 t`. `appearanceOptions` maps the `terminal.*` settings, and `terminalFontStack` puts this system's fallback fonts after the user's. Renderer only: `RENDERER_BEHAVIOUR` (typing scrolls to the bottom, ⌥-drag selects while an app captures the mouse) and `applyAppearance`, which sets only the options that changed on a live terminal. |
| `queries.ts` | `QUERY_TABLE`: every query form, with who answers it on the mirror (`xterm` / `kea` / `nobody`). `installRendererSwallow` swallows every query form in the renderer but lets set forms through. `installMirrorResponders` answers colours, colour scheme and geometry, and keeps the deliberately silent ones silent. |
| `colors.ts` | `ColorState` (theme + OSC 4/10/11/12 overrides, 104/110–112 restores), X colour parsing and xterm-format replies, ported from xterm.js |
| `modes.ts` | `ModeTracker`: parser hooks for state the serializer drops, the current attributes, each screen's saved cursor and each screen's tab stops among them. `trailer()` (prefix, alternate-screen switch, suffix) and `composeSnapshot()` |
| `attrs.ts` | Character attributes as xterm.js keeps them (fg / bg words, underline style and colour): `applySgr` and `applyProtected`, ported from xterm.js's SGR and DECSCA handling, and `sgrOf`, the SGR that sets a given state exactly |
| `scanner.ts` | `VtScanner`: xterm.js's parser state table and UTF-8 decoder, ported, tracking ground state and DEC 2026. `CharsetTracker`: G0–G3 (the table's exact length), GL and each screen's DECSC charset slot. |
| `mirror.ts` | `MirrorKit`: everything above, wired for one ptyhost mirror. It adds a reply gate (off while rebuilding from the ring), `parsed(bytes)` (called from the write callback), `atGround` and `snapshot(serializer)`. |
| `xterm.ts` | The slice of the xterm.js API used, shared by headless and browser |
| `themes.ts` | The terminal themes as both sides resolve them: the bundled palettes of `constants/tokens.json` by id (`themeOf`; `generated/themes.ts`), and "Match Ghostty config" (`ghosttyTheme`: the colours core read of the file laid over Kea Dark, with Ghostty's own selection and cursor defaults where the file states a background or foreground but not those; `ghosttyFont`, held to the font-size setting's range). `resolveTheme(id, ghostty)` is the one function the window's terminals and core's mirror colours both go through (`colorThemeOf`, and `isDarkTheme`: the scheme a program is told), so what a terminal shows and what its program is told agree. `Appearance.colors` carries a resolved theme that is not a bundled one. |

The tests sit beside the modules (`*.test.ts`) and drive real `@xterm/headless` terminals (`test-support.ts`). Where
xterm.js has no public API, the tests read its internals, but only to verify state, never to implement it.

## Design notes

- **One upstream commit.** `@xterm/headless` 6.1.0-beta.303, `@xterm/xterm` 6.1.0-beta.304 and every addon carry the
  same `commit` field in their `package.json` (c58ea36…). The commit is the pin, not the beta numbers, which each
  package counts on its own; `tests/memory/app-pins.test.ts` checks that every `@xterm` package resolves to it.
- **Who answers what.**
  - The headless mirror answers these itself: DA1, DA2, DSR/CPR, DECXCPR, DECRQM (incl. 2026), kitty `CSI ? u`,
    XTVERSION and DECRQSS.
  - It answers none of OSC 4/10/11/12, `CSI ? 996 n` or `CSI 14/16/18 t`, so Kea's responders do.
  - Deliberately silent: DA3, XTGETTCAP, OSC 52 reads, and `CSI 11/13/15/19/20/21 t`.
- **The mirror enables three window reports.** xterm.js wraps every custom `CSI Ps t` handler in its `windowOptions`
  check, and swallows the op unless it is allowed. So the mirror allows exactly `getWinSizePixels`, `getCellSizePixels`
  and `getWinSizeChars`, and Kea's responder answers those three before xterm.js's own handler can. The renderer keeps
  every window option off, since terminal output is untrusted and a title report would echo text a program chose.
- **Character sets are tracked by the scanner, not by parser hooks.** SI/SO are C0 controls, and xterm.js's public
  parser API cannot hook C0. If charset state came partly from hooks (at parse time) and partly from the byte scanner,
  SO and `ESC n` could be applied out of order. So all of it — designations, shifts, the DECSC/DECRC/1049 slots, DECSTR
  and RIS — is tracked in byte order by the same scanner that finds ground state. Feed it in the mirror's write
  callback, so it describes the same seq as the mirror.
- **Colour overrides are in the trailer.** A program's OSC 4/10/11/12 changes are re-applied after a restore, so colour
  queries answer the same before and after a rebuild.
- **Tab stops are tracked per screen, as xterm.js keeps them.** HTS and TBC are hooked; a resize lays new stops from the
  last one left of the new width (`Buffer.setupTabStops`); leaving the alternate screen resets its stops, and RIS resets
  both. A screen whose stops left of the right margin are the default ones costs nothing in the trailer; otherwise
  `CSI 3 g` and one `CHA` + `HTS` per stop. The main screen's go in the prefix when the alternate screen is active; the
  alternate screen's never need to while the main one is.
- **LNM is stated in every snapshot.** xterm.js keeps LNM as its `convertEol` option, which neither RIS nor
  `Terminal.reset()` clears, so a renderer reusing its terminal could still have it on; the trailer reads the option and
  writes `CSI 20 h` or `CSI 20 l`.
- **The serializer already restores:** DECCKM, keypad mode, bracketed paste, insert mode, DECOM, reverse wrap-around,
  focus reporting, DECAWM, mouse protocol (9/1000/1002/1003), cursor visibility, the scroll region and the alternate
  screen.
- **The serializer loses:** kitty keyboard flags and stacks, SGR / SGR-pixels mouse encoding, character sets, cursor
  style, the title, colour overrides, tab stops and LNM. With a scroll region or origin mode, the cursor ends up homed,
  and it can be one column off (xterm.js #6165).
- **The trailer re-emits all of it.** Its positioning ends DECSTBM → DECOM → cursor, followed only by what moves nothing
  (character sets, attributes); `modes.test.ts` keeps this list honest.
- **Kitty stacks of the inactive screen.**
  - If the alternate screen is active, the main screen's stack is built in a prefix, before the serialized content.
  - If the main screen is active, the alternate screen's stack is built inside a `CSI ? 47 h … CSI ? 47 l` pair on the
    fresh terminal. The alternate screen is empty there, so nothing is lost.
  - Both saved flag slots are rebuilt, the active screen's stale one too: xterm.js swaps them on every 47/1047/1049, so
    a leave without an enter reads it.
- **Saved cursors are rebuilt, not just positioned.** Each screen's slot is built by setting its origin and wrap modes,
  its character sets, its colours and flags, moving to it (absolutely, with the region reset, if it was saved in origin
  mode) and `DECSC`, then putting back what the next part expects. The alternate screen's slot goes in the prefix when
  the main screen is active; the main screen's in the alternate-screen switch when it is not; the active screen's at the
  start of the suffix.
- **The alternate-screen switch is the trailer's.** The serializer's `CSI ? 1049 h CSI H` is replaced by the main
  screen's slot, default attributes (the serializer writes the alternate screen as if from default attributes), the
  main screen's scroll region and `CSI ? 1047 h CSI H` (1049 would save the cursor over the slot just built).
- **The current attributes are sent in full, last** (`sgrOf`, with DECSCA). The serializer restores only what shows in a
  cell, so an underline colour set before the underline itself would be lost.
- **The serializer is patched, not its output rewritten** (one patch in `patches/`, which also makes it allocate nothing
  per cell). Rewriting the output can fix a misplaced 22 or a zero-count move, but not bold + dim coming back as one of
  them, wrapped rows starting with an empty cell, lone zero-width cells, or blank rows trimmed or coloured wrongly:
  those need the serializer's own row and style state.
- **Pending wrap** (cursor just past the last column) cannot be reached with CUP.
  - On the main screen, the cursor's row is reprinted through the serializer's range mode. That leaves the cursor
    pending and restores the current SGR.
  - On the alternate screen, or in origin mode, the cursor comes back on the last column instead. **This is a known
    loss:** the next character overwrites that cell instead of wrapping.
  - Origin mode is excluded because xterm.js adds the region top to *relative* cursor moves in origin mode, and the
    reprinted row uses CUF for gaps. Mirror and renderer share that quirk, so live output is unaffected.
- **Other known losses** (`tests/chaos/ptyhost-fuzz.test.ts` skips or tolerates exactly these):
  - A zero-width character or REP right after the cut does not join the character printed before it: the parser
    remembers it, and a snapshot cannot carry that.
  - A cursor *saved* in the pending-wrap column comes back on the last column, where DECRC puts it anyway unless the
    terminal is widened first.
  - Attributes a DECRC left inconsistent (xterm.js restores the saved colours and flags but keeps the current underline
    style and colour) come back as SGR can set them. Rebuilding them needs a DECRC from a slot holding the current
    colours, and both slots are taken.
  - A character-set table can come back longer than it was; only undesignated sets differ.
  - After a resize that pulls lines back from scrollback, a saved row can be off by the lines pulled.
  - Cells' DECSCA protection is not restored. (There is no title stack to lose: title push/pop are off on both sides.)
  - A tab stop set by the 8-bit C1 HTS (U+0088) is not restored: it is an execute, which no parser hook sees. Nor are
    stops at or past the right margin (set in the pending-wrap column, or left by a narrowing); they matter only once
    the terminal is widened.
  - OSC 8 links become plain text, and a link still open at the cut is not reopened.
