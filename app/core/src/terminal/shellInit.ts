// The startup files that let zsh, bash and fish activate a session's virtual env after the user's own startup files,
// and how each shell is started with them. Their text is constant; core writes them into `<KEA_HOME>/shell/`, since a
// shell cannot read a file inside the app's archive. Any other shell gets the env's variables instead (venv.ts).

import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteSync, ensurePrivateDir } from '@kea/kit'
import type { Env } from './shellEnv.ts'
import { venvVariables, type Venv } from './venv.ts'

/**
 * Activates the env in KEA_VENV as its own `bin/activate` would; zsh's and bash's startup files source it last. The
 * venv's own script is never run: it is a file inside the session's folder.
 */
const ACTIVATE_SH = `# Kea: activates the virtual env in KEA_VENV as its own bin/activate would, after the user's startup files.
# KEA_VENV and KEA_VENV_PROMPT are removed either way.
if [ -n "\${KEA_VENV-}" ] && [ -r "$KEA_VENV/pyvenv.cfg" ]; then
  # a virtual env the user's own files activated is put away first, as bin/activate does
  if [ -n "\${_OLD_VIRTUAL_PATH+x}" ] && command -v deactivate >/dev/null 2>&1; then deactivate nondestructive; fi
  deactivate () {
    if [ -n "\${_OLD_VIRTUAL_PATH+x}" ]; then PATH=$_OLD_VIRTUAL_PATH; export PATH; unset _OLD_VIRTUAL_PATH; fi
    if [ -n "\${_OLD_VIRTUAL_PYTHONHOME+x}" ]; then PYTHONHOME=$_OLD_VIRTUAL_PYTHONHOME; export PYTHONHOME; unset _OLD_VIRTUAL_PYTHONHOME; fi
    hash -r 2>/dev/null
    if [ -n "\${_OLD_VIRTUAL_PS1+x}" ]; then PS1=$_OLD_VIRTUAL_PS1; unset _OLD_VIRTUAL_PS1; fi
    unset VIRTUAL_ENV VIRTUAL_ENV_PROMPT
    if [ "\${1-}" != nondestructive ]; then unset -f deactivate; fi
  }
  VIRTUAL_ENV=$KEA_VENV
  export VIRTUAL_ENV
  # every copy of the env's bin leaves PATH, so deactivate leaves none behind
  __kea_rest=$PATH:
  __kea_path=
  __kea_first=1
  while [ -n "$__kea_rest" ]; do
    __kea_entry=\${__kea_rest%%:*}
    __kea_rest=\${__kea_rest#*:}
    if [ "$__kea_entry" != "$VIRTUAL_ENV/bin" ]; then
      if [ -n "$__kea_first" ]; then __kea_path=$__kea_entry; __kea_first=; else __kea_path=$__kea_path:$__kea_entry; fi
    fi
  done
  _OLD_VIRTUAL_PATH=$__kea_path
  if [ -n "$__kea_first" ]; then PATH=$VIRTUAL_ENV/bin; else PATH=$VIRTUAL_ENV/bin:$__kea_path; fi
  export PATH
  VIRTUAL_ENV_PROMPT=\${KEA_VENV_PROMPT:-\${VIRTUAL_ENV##*/}}
  export VIRTUAL_ENV_PROMPT
  if [ -n "\${PYTHONHOME+x}" ]; then _OLD_VIRTUAL_PYTHONHOME=$PYTHONHOME; unset PYTHONHOME; fi
  if [ -z "\${VIRTUAL_ENV_DISABLE_PROMPT-}" ]; then _OLD_VIRTUAL_PS1=\${PS1-}; PS1="($VIRTUAL_ENV_PROMPT) \${PS1-}"; fi
  hash -r 2>/dev/null
  unset __kea_rest __kea_path __kea_first __kea_entry
fi
unset KEA_VENV KEA_VENV_PROMPT
`

/** One of zsh's startup files: the user's file of the same name, read with ZDOTDIR set to the user's. */
function zshFile(name: string, before: string, after: string): string {
  return `${before}if [[ -n $__kea_user_zdotdir_set ]]; then ZDOTDIR=$__kea_user_zdotdir; else unset ZDOTDIR; fi
if [[ -r \${ZDOTDIR:-$HOME}/${name} ]]; then builtin source "\${ZDOTDIR:-$HOME}/${name}"; fi
# the user's file may move ZDOTDIR (an XDG layout sets it in .zshenv); later files are read from there
if [[ -n \${ZDOTDIR+x} ]]; then __kea_user_zdotdir=$ZDOTDIR; __kea_user_zdotdir_set=1; else __kea_user_zdotdir_set=; fi
ZDOTDIR=$__kea_zdotdir
${after}`
}

const ZSH_HEAD = `# Kea starts zsh with this folder as ZDOTDIR to activate a session's virtual env. Each file reads the user's file of the
# same name with ZDOTDIR set to the user's, then puts this folder back for the next; the last file zsh reads activates
# the env (finish.zsh) and leaves ZDOTDIR as the user's.
`

const ZSHENV = zshFile(
  '.zshenv',
  `${ZSH_HEAD}__kea_zdotdir=$ZDOTDIR
if [[ -n \${KEA_ZDOTDIR+x} ]]; then __kea_user_zdotdir=$KEA_ZDOTDIR; __kea_user_zdotdir_set=1; else __kea_user_zdotdir=; __kea_user_zdotdir_set=; fi
unset KEA_ZDOTDIR
`,
  `if [[ ! -o login && ! -o interactive ]]; then builtin source "$__kea_zdotdir/finish.zsh"; fi
`,
)

const ZPROFILE = zshFile('.zprofile', ZSH_HEAD, '')

const ZSHRC = zshFile(
  '.zshrc',
  `${ZSH_HEAD}# the system's zshrc can point HISTFILE into ZDOTDIR, which was this folder when it ran
if [[ \${HISTFILE-} == "$__kea_zdotdir/.zsh_history" ]]; then
  if [[ -n $__kea_user_zdotdir_set ]]; then HISTFILE=$__kea_user_zdotdir/.zsh_history; else HISTFILE=$HOME/.zsh_history; fi
fi
`,
  `if [[ ! -o login ]]; then builtin source "$__kea_zdotdir/finish.zsh"; fi
`,
)

const ZLOGIN = zshFile('.zlogin', ZSH_HEAD, `builtin source "$__kea_zdotdir/finish.zsh"
`)

const ZSH_FINISH = `# The end of Kea's zsh startup: ZDOTDIR is the user's again, and the session's virtual env is activated.
if [[ -n $__kea_user_zdotdir_set ]]; then export ZDOTDIR=$__kea_user_zdotdir; else unset ZDOTDIR; fi
builtin source "\${__kea_zdotdir:h}/activate.sh"
unset __kea_zdotdir __kea_user_zdotdir __kea_user_zdotdir_set
`

/** What every bash login shell reads first. */
const SYSTEM_PROFILE = '/etc/profile' // os-ok: bash's own path, the same on every system

const BASH_TAB = `# Kea runs a shell tab's bash with --init-file pointing here to activate a session's virtual env. A login shell
# ignores --init-file, so this reads what bash -l would, then activates the env.
if [ -r ${SYSTEM_PROFILE} ]; then . ${SYSTEM_PROFILE}; fi
if [ -r ~/.bash_profile ]; then . ~/.bash_profile
elif [ -r ~/.bash_login ]; then . ~/.bash_login
elif [ -r ~/.profile ]; then . ~/.profile
fi
. "\${BASH_SOURCE[0]%/*}/../activate.sh"
`

const BASH_ENV_FILE = `# Kea sets BASH_ENV to this file for a login bash that runs a command, to activate a session's virtual env: bash reads
# it after the profiles and before the command. The user's own BASH_ENV is put back and read first.
if [ -n "\${KEA_BASH_ENV+x}" ]; then
  BASH_ENV=$KEA_BASH_ENV
  unset KEA_BASH_ENV
  if [ -n "$BASH_ENV" ] && [ -r "$BASH_ENV" ]; then . "$BASH_ENV"; fi
else
  unset BASH_ENV
fi
. "\${BASH_SOURCE[0]%/*}/../activate.sh"
`

const FISH = `# Kea starts fish with --init-command sourcing this file to activate a session's virtual env: fish runs it after
# config.fish. It activates the env as the env's own activate.fish would, without running that file.
set -e KEA_SHELL_INIT
if set -q KEA_VENV; and test -r "$KEA_VENV/pyvenv.cfg"
    # a virtual env the user's own files activated is put away first, as activate.fish does
    if set -q _OLD_VIRTUAL_PATH; and functions -q deactivate
        deactivate nondestructive
    end
    function deactivate -d 'Leave the virtual env'
        if set -q _OLD_VIRTUAL_PATH
            set -gx PATH $_OLD_VIRTUAL_PATH
            set -e _OLD_VIRTUAL_PATH
        end
        if set -q _OLD_VIRTUAL_PYTHONHOME
            set -gx PYTHONHOME $_OLD_VIRTUAL_PYTHONHOME
            set -e _OLD_VIRTUAL_PYTHONHOME
        end
        if set -q _OLD_FISH_PROMPT_OVERRIDE
            set -e _OLD_FISH_PROMPT_OVERRIDE
            if functions -q _old_fish_prompt
                functions -e fish_prompt
                functions -c _old_fish_prompt fish_prompt
                functions -e _old_fish_prompt
            end
        end
        set -e VIRTUAL_ENV
        set -e VIRTUAL_ENV_PROMPT
        if test "$argv[1]" != nondestructive
            functions -e deactivate
        end
    end
    set -gx VIRTUAL_ENV $KEA_VENV
    # every copy of the env's bin leaves PATH, so deactivate leaves none behind
    set -l __kea_path
    for __kea_entry in $PATH
        if test "$__kea_entry" != "$VIRTUAL_ENV/bin"
            set -a __kea_path $__kea_entry
        end
    end
    set -gx _OLD_VIRTUAL_PATH $__kea_path
    set -gx PATH "$VIRTUAL_ENV/bin" $__kea_path
    if test -n "$KEA_VENV_PROMPT"
        set -gx VIRTUAL_ENV_PROMPT $KEA_VENV_PROMPT
    else
        set -gx VIRTUAL_ENV_PROMPT (string replace -r '.*/' '' -- $VIRTUAL_ENV)
    end
    if set -q PYTHONHOME
        set -gx _OLD_VIRTUAL_PYTHONHOME $PYTHONHOME
        set -e PYTHONHOME
    end
    if test -z "$VIRTUAL_ENV_DISABLE_PROMPT"
        functions -c fish_prompt _old_fish_prompt
        function fish_prompt
            set -l old_status $status
            printf '%s%s%s' (set_color 4B8BBE) "($VIRTUAL_ENV_PROMPT) " (set_color normal)
            echo "exit $old_status" | source
            _old_fish_prompt
        end
        set -gx _OLD_FISH_PROMPT_OVERRIDE $VIRTUAL_ENV
    end
end
set -e KEA_VENV
set -e KEA_VENV_PROMPT
`

/** Every startup file, by its path under `<KEA_HOME>/shell/`. */
export const SHELL_INIT_FILES: Readonly<Record<string, string>> = {
  'activate.sh': ACTIVATE_SH,
  'zsh/.zshenv': ZSHENV,
  'zsh/.zprofile': ZPROFILE,
  'zsh/.zshrc': ZSHRC,
  'zsh/.zlogin': ZLOGIN,
  'zsh/finish.zsh': ZSH_FINISH,
  'bash/kea.bash': BASH_TAB,
  'bash/env.bash': BASH_ENV_FILE,
  'fish/kea.fish': FISH,
}

/** fish's `--init-command`: constant text; the file's path arrives in KEA_SHELL_INIT, never quoted into it. */
export const FISH_INIT_COMMAND = 'source "$KEA_SHELL_INIT"'

/** `<KEA_HOME>/shell`. */
export function shellInitDir(keaHome: string): string {
  return path.join(keaHome, 'shell')
}

/** Write every startup file whose text differs or that is missing (folders 0700, files 0600). Throws when one cannot be. */
export function writeShellInit(dir: string): void {
  for (const [rel, text] of Object.entries(SHELL_INIT_FILES)) {
    const file = path.join(dir, rel)
    ensurePrivateDir(path.dirname(file))
    if (!sameText(file, text)) atomicWriteSync(file, text, { mode: 0o600 })
  }
}

/** Whether every startup file is in `dir`, writing them when one is not; false when they cannot be written. */
export function ensureShellInit(dir: string): boolean {
  if (Object.keys(SHELL_INIT_FILES).every((rel) => fs.existsSync(path.join(dir, rel)))) return true
  try {
    writeShellInit(dir)
    return true
  } catch {
    return false
  }
}

function sameText(file: string, text: string): boolean {
  try {
    if (fs.statSync(file).size !== Buffer.byteLength(text)) return false
    return fs.readFileSync(file, 'utf8') === text
  } catch {
    return false
  }
}

/** A shell Kea starts itself: a shell tab (`$SHELL -l`), or a login shell running a script (`$SHELL -l -c <script>`). */
export type ShellRole = { kind: 'tab'; shell: string } | { kind: 'script'; shell: string; script: string }

/** The shells whose startup files Kea has. */
export type InitShell = 'zsh' | 'bash' | 'fish'

export function initShell(shell: string): InitShell | null {
  const name = path.basename(shell)
  return name === 'zsh' || name === 'bash' || name === 'fish' ? name : null
}

/** The argv and complete environment of `role` with `venv` active. `dir`: the startup files, null when unwritable. */
export function venvShellStart(role: ShellRole, venv: Venv, env: Readonly<Env>, dir: string | null): { argv: string[]; env: Env } {
  const kind = dir ? initShell(role.shell) : null
  const plain = role.kind === 'tab' ? [role.shell, '-l'] : [role.shell, '-l', '-c', role.script]
  if (!kind || !dir) {
    const out: Env = { ...env, ...venvVariables(venv, env.PATH) }
    delete out.PYTHONHOME
    return { argv: plain, env: out }
  }
  const out: Env = { ...env, KEA_VENV: venv.dir, KEA_VENV_PROMPT: venv.prompt }
  if (kind === 'zsh') {
    out.ZDOTDIR = path.join(dir, 'zsh')
    if (env.ZDOTDIR !== undefined) out.KEA_ZDOTDIR = env.ZDOTDIR
    return { argv: plain, env: out }
  }
  if (kind === 'bash') {
    if (role.kind === 'tab') return { argv: [role.shell, '--init-file', path.join(dir, 'bash', 'kea.bash')], env: out }
    out.BASH_ENV = path.join(dir, 'bash', 'env.bash')
    if (env.BASH_ENV !== undefined) out.KEA_BASH_ENV = env.BASH_ENV
    return { argv: plain, env: out }
  }
  out.KEA_SHELL_INIT = path.join(dir, 'fish', 'kea.fish')
  const argv = [role.shell, '-l', '--init-command', FISH_INIT_COMMAND]
  return { argv: role.kind === 'tab' ? argv : [...argv, '-c', role.script], env: out }
}
