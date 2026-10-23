// What lintian and rpmlint may say of Kea's packages and the run still pass: each accepted tag with why.
// Anything else they report as an error or a warning stops the run.

export interface Accepted {
  tag: string
  why: string
  /** Accepted only until a release: a placeholder a release must replace (a release build fails on it). */
  untilRelease?: true
}

const IN_OPT = "Kea lives in /opt/Kea, as Electron apps' own packages do; it is no distribution's package"
const SYMBOLS = "the helper and the native modules keep their symbols for readable crash reports (only debug data is stripped); Electron's libraries are as Electron ships them"
const SANDBOX = "chrome-sandbox is Chromium's set-uid sandbox helper, root-owned with mode 4755 by design"
const NOTES = "Kea's release notes are its GitHub release's, not a changelog in the package"
const FONT = "the terminal font ships with Kea so its metrics are the same on every distribution; it is in a folder of its own, so a distribution's copy, where one is installed, never collides with it"

export const ACCEPTED_LINTIAN: readonly Accepted[] = [
  { tag: 'dir-or-file-in-opt', why: IN_OPT },
  { tag: 'embedded-library', why: 'Chromium, inside Electron, links its own copies of these libraries' },
  { tag: 'unstripped-binary-or-object', why: SYMBOLS },
  { tag: 'elevated-privileges', why: SANDBOX },
  { tag: 'no-changelog', why: NOTES },
  { tag: 'no-manual-page', why: '/usr/bin/kea-app starts a desktop app; it has no command-line interface to document' },
  { tag: 'copyright-not-using-common-license-for-apache2', why: "the licences file is the same on every system and quotes each licence in full" },
  { tag: 'copyright-not-using-common-license-for-gpl', why: "the licences file is the same on every system and quotes each licence in full (lintian 2.114, Ubuntu 22.04's, also says it of the GPL text)" },
  { tag: 'duplicate-font-file', why: FONT },
  { tag: 'bogus-mail-host', why: 'the maintainer address is a placeholder until a release names a real one (tools/package.ts MAINTAINER)', untilRelease: true },
]

export const ACCEPTED_RPMLINT: readonly Accepted[] = [
  { tag: 'dir-or-file-in-opt', why: IN_OPT },
  { tag: 'unstripped-binary-or-object', why: SYMBOLS },
  { tag: 'setuid-binary', why: SANDBOX },
  { tag: 'non-standard-executable-perm', why: SANDBOX },
  { tag: 'missing-call-to-setgroups-before-setuid', why: SANDBOX },
  { tag: 'binary-or-shlib-defines-rpath', why: "Electron's executable finds its own libraries beside it ($ORIGIN)" },
  { tag: 'binary-or-shlib-calls-gethostbyname', why: "Chromium's network stack, inside Electron; Kea itself makes no request" },
  { tag: 'explicit-lib-dependency', why: "dependencies are Kea's own list (RPM_REQUIRES in tools/pack/src/os/linuxPackage.ts), not rpm's scan (AutoReqProv off: the scan would name Ubuntu's library builds)" },
  { tag: 'no-dependency-on', why: "openSUSE's convention for apps' locale files; Kea's locales are Chromium's .pak files" },
  { tag: 'dangerous-command-in-%post', why: 'the script copies the AppArmor profile into place' },
  { tag: 'dangerous-command-in-%postun', why: 'the script removes the AppArmor profile and its cache' },
  { tag: 'use-of-home-in-%preun', why: "the note before removal names ~/.kea, which stays; the script only prints it and reads no home folder" },
  { tag: 'no-changelogname-tag', why: NOTES },
  { tag: 'no-manual-page-for-binary', why: '/usr/bin/kea-app starts a desktop app; it has no command-line interface to document' },
  { tag: 'spelling-error', why: "the description's words are git's (worktree)" },
  { tag: 'no-signature', why: "a release signs the rpm after these checks (rpmsign)" },
  { tag: 'invalid-license', why: "rpmlint 2.2 (Ubuntu 22.04, where releases are built) does not list MIT, Kea's SPDX licence id; rpmlint 2.5 accepts it" },
]

/** What a run accepts: everything above for a test build; for a release, not the placeholders (`untilRelease`). */
export function acceptedFor(list: readonly Accepted[], release: boolean): Accepted[] {
  return list.filter((a) => !release || !a.untilRelease)
}

/**
 * The errors and warnings in a lint run's output that are not accepted. lintian writes `E: kea-app: <tag> [<detail>]`
 * (and `W:`); rpmlint `kea-app.aarch64: E: <check> <detail>` (and `W:`). Information and pedantic lines are not problems.
 */
export function lintProblems(output: string, accepted: readonly Accepted[]): string[] {
  const ok = new Set(accepted.map((a) => a.tag))
  const problems: string[] = []
  for (const line of output.split('\n')) {
    const tag = /^[EW]: [^:\s]+(?: [^:\s]+)?: (\S+)/.exec(line)?.[1] ?? /^\S+: [EW]: (\S+)/.exec(line)?.[1]
    if (tag !== undefined && !ok.has(tag)) problems.push(line.trim())
  }
  return problems
}
