# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: on the repository's
**Security** tab, choose **Report a vulnerability**. Include what you found, how to reproduce it, and the Kea version
(Settings › About, or Copy Diagnostics).

Kea is maintained by one person, so fixes are best effort; you should get a first reply within a week. Once a fix is
released, the advisory is published with credit to you unless you prefer otherwise.

## Supported versions

Only the latest release gets security fixes.

## Scope

In scope, for example:

- another local user, or a process that is not Kea, reaching a session's terminal or the sockets in `~/.kea/run`;
- `install.sh` or the packages installing something that does not match the release's checksums and signing key;
- Kea writing outside its own folders, into a repository's configuration, or into `~/.claude` or `~/.commandcode`;
- terminal content, file paths or other private data leaving the machine, or appearing in Copy Diagnostics when it
  should not;
- the window reading files outside the sessions it shows, or escaping Chromium's sandbox.

Out of scope:

- what an agent CLI does with the permissions you give it. A session's worktree is not a sandbox: an agent in a
  permission-bypass mode can change anything your user can;
- the reduced isolation of a Linux `--user` install, which the installer states;
- macOS builds being signed with Kea's own certificate rather than notarised by Apple.
