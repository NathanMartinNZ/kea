# assets/fonts

Fonts the Linux packages ship. They are installed to `/usr/share/fonts/kea-app/`, where fontconfig gives them to
Chromium as it gives any other font; macOS ships none (its terminal font is SF Mono).

## jetbrains-mono

JetBrains Mono, the Linux terminal font's first choice. Only the weights Kea uses: 400 and, for bold text, 700. No
italic: Kea uses none, and Chromium slants the regular face where a program asks for italics.

- **Source:** Ubuntu 24.04's `fonts-jetbrains-mono` **2.304+ds-4** (`noble/universe`, `all`), fetched with apt from
  Ubuntu's archive, whose index is signed: the package file's SHA-256 is the one that index names,
  `eb83c67770850473155d8ab7e1789f174a74a1ea3d477deb10be5504ba2a7770`. Debian builds the fonts from JetBrains' sources
  (`+ds`).
- **Files** (SHA-256, as they are in that package's `usr/share/fonts/truetype/jetbrains-mono/`):
  - `JetBrainsMono-Regular.ttf` `bb03b32b13f66bb799975d478d3725fbed9101728d46ffda995e87d7847fda2d`
  - `JetBrainsMono-Bold.ttf` `587fe1c01c3c1a8c579edd0d213476b3db625269bd5f43a7ec4ead6826f64557`
- **Licence:** SIL Open Font License 1.1, as each file's own name table says ("This Font Software is licensed under the
  SIL Open Font License, Version 1.1"), copyright 2020 The JetBrains Mono Project Authors. `OFL.txt` is that notice with
  the licence's text. The Debian package's `copyright` file still names Apache-2.0, JetBrains' licence before they moved
  the font to the OFL; the files' own metadata is what Kea follows. The Linux licences file (`resources/licenses.txt`,
  `/usr/share/doc/kea-app/copyright`) carries `OFL.txt`.
- **Replacing them:** take the files from a newer Ubuntu package the same way, and update the version and hashes here.
