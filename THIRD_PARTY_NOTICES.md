# Third-party notices

Kea is released under the MIT licence (see [LICENSE](LICENSE)). This repository also contains material from other
projects. Each item below stays under its own licence.

Release packages carry a generated `licenses.txt` that lists the npm packages and Rust crates bundled into the app,
with their licence texts, along with Electron's licence and, on Linux, the font's. Chromium's credits are in
`LICENSES.chromium.html`, which ships with the app too.

## JetBrains Mono (font)

- **Files:** `assets/fonts/jetbrains-mono/JetBrainsMono-Regular.ttf`, `JetBrainsMono-Bold.ttf` (version 2.304,
  unmodified; shipped in the Linux packages only)
- **Copyright:** © 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono)
- **Licence:** SIL Open Font License 1.1. The full text is in
  [`assets/fonts/jetbrains-mono/OFL.txt`](assets/fonts/jetbrains-mono/OFL.txt); provenance and checksums are in
  [`assets/fonts/README.md`](assets/fonts/README.md).
- "JetBrains Mono" is a trademark of JetBrains s.r.o.

## xterm.js (ported code)

Parts of `packages/terminal/src/` are ported from xterm.js (https://github.com/xtermjs/xterm.js):

- `scanner.ts`: the escape-sequence parser's transition table (`src/common/parser/EscapeSequenceParser.ts`) and its
  UTF-8 decoding rules (`src/common/input/TextDecoder.ts`)
- `colors.ts`: X11 colour-spec parsing (`src/common/input/XParseColor.ts`), the 256-colour default palette, and the
  way OSC 4, 10–12 and 104 payloads are split into slots (`src/common/InputHandler.ts`)
- `attrs.ts`: SGR attribute handling (`src/common/InputHandler.ts`) and the attribute bit layout
  (`src/common/buffer/Constants.ts`)

xterm.js is under the MIT licence:

```text
Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)
Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)
Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Icons

The icons in `packages/ui/src/icons.ts` are Kea's own paths on a 16-unit grid, drawn in the style of Phosphor's
"regular" weight (round caps and joins). No Phosphor files are included.

## Patches to npm packages (`patches/`)

pnpm applies these at install time. Each patch contains excerpts of the package it modifies, which remain under that
package's licence; Kea's changes in them are under Kea's MIT licence.

| Patch | Package | Licence | Copyright |
|---|---|---|---|
| `@parcel__watcher@2.6.0.patch` | [@parcel/watcher](https://github.com/parcel-bundler/watcher) 2.6.0 | MIT | © 2017-present Devon Govett |
| `@xterm__xterm@6.1.0-beta.304.patch` | [@xterm/xterm](https://github.com/xtermjs/xterm.js) 6.1.0-beta.304 | MIT | © The xterm.js authors (see above); bundled code © Microsoft Corporation, MIT |
| `@xterm__addon-serialize@0.15.0-beta.301.patch` | @xterm/addon-serialize 0.15.0-beta.301 | MIT | © The xterm.js authors; bundled code © Microsoft Corporation, MIT |
| `@xterm__addon-webgl@0.20.0-beta.300.patch` | @xterm/addon-webgl 0.20.0-beta.300 | MIT | © 2018 The xterm.js authors; bundled code © Microsoft Corporation, MIT |
| `svelte@5.57.2.patch` | [svelte](https://github.com/sveltejs/svelte) 5.57.2 | MIT | © 2016-2025 Svelte Contributors |

Each package's licence text is in its repository and, where the package ships one, in its `LICENSE` file under
`node_modules/`.

## Recorded output of third-party tools (`fixtures/`)

Some test fixtures are recordings of other products' command-line output, help text, terminal screens and data files,
kept so Kea's tests can check that it works with them:

- **Claude Code** (© Anthropic PBC; proprietary): `fixtures/cli/claude/`, `fixtures/cassettes/`,
  `fixtures/hooks/claude/`, `fixtures/status/claude/`, `fixtures/transcripts/claude/`
- **Command Code** (proprietary): `fixtures/cli/commandcode/`, `fixtures/hooks/commandcode/`,
  `fixtures/transcripts/commandcode/`

These recordings are **not** covered by Kea's MIT licence. They belong to their respective owners and are included
only as test data. The prompts in them are Kea's own and the replies come from Kea's mock model (`tools/mock-model`);
no output of Anthropic's or Command Code's models is included.

## Names of other products

Claude Code (Anthropic PBC), Command Code, VS Code, Zed, Ghostty and the other tools Kea works with belong to their
respective owners; their names are used only to say what Kea works with. Kea is an independent project and is not
affiliated with or endorsed by any of them.
