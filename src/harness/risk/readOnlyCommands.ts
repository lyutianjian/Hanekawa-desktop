import { hasDangerousSedScript, parseSedInvocation } from '../commandAnalysis.js'
import type { Word } from './shellParse.js'

/**
 * Commands that cannot change anything on their own. Aligned with Claude
 * Code's READONLY_COMMANDS, minus `xargs` (it runs a command, analyzed as a
 * wrapper instead) and the pager-spawning `man`/`info`/`help`.
 */
const READ_ONLY_COMMANDS = new Set([
  ':', '[', '[[', 'exit', 'return', 'set', 'shift', 'alias', 'base64', 'basename', 'cal', 'cat', 'cmp', 'column', 'comm', 'cut', 'date', 'df', 'diff', 'dir',
  'dirname', 'du', 'echo', 'expand', 'expr', 'false', 'fd', 'file', 'find', 'fmt', 'fold', 'free', 'get-childitem',
  'get-content', 'get-location', 'getconf', 'grep', 'egrep', 'fgrep', 'groups', 'head', 'hexdump', 'history',
  'hostname', 'id', 'jq', 'locale', 'ls', 'lsof', 'md5sum', 'netstat', 'nl', 'nproc', 'numfmt', 'od', 'paste',
  'pgrep', 'pr', 'printenv', 'printf', 'ps', 'pwd', 'readlink', 'realpath', 'rev', 'rg', 'ripgrep', 'sed',
  'select-string', 'seq', 'sha1sum', 'sha256sum', 'sleep', 'sort', 'ss', 'stat', 'strings', 'tac', 'tail', 'test',
  'tput', 'tr', 'tree', 'true', 'tsort', 'type', 'uname', 'unexpand', 'uniq', 'uptime', 'wc', 'where', 'which',
  'whoami',
])

/** Read-only commands none of whose operands name a file to read. */
const NO_PATH_COMMANDS = new Set([
  ':', '[', '[[', 'exit', 'return', 'set', 'shift', 'alias', 'basename', 'cal', 'date', 'df', 'dirname', 'echo', 'expr', 'false', 'free', 'get-location', 'getconf',
  'groups', 'history', 'hostname', 'id', 'locale', 'lsof', 'netstat', 'nproc', 'numfmt', 'pgrep', 'printenv', 'printf',
  'ps', 'pwd', 'seq', 'sleep', 'ss', 'test', 'tput', 'tr', 'true', 'type', 'uname', 'uptime', 'where', 'which', 'whoami',
])

/** Flags whose value is the next word, per command, so the value is not taken for a path. */
const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  head: new Set(['-n', '-c']),
  tail: new Set(['-n', '-c']),
  cut: new Set(['-d', '-f', '-c', '-b']),
  column: new Set(['-s', '-c', '-o']),
  // `-a`/`-b`/`-c` are switches (`--text`, `--byte-offset`, `--count`); listing
  // them as value flags ate the pattern and left the path unjudged, so
  // `grep -a . .env` — which prints the file — graded readonly.
  grep: new Set(['-e', '-f', '-m', '-A', '-B', '-C', '-D', '-d', '--include', '--exclude', '--exclude-dir', '--label', '--regexp', '--file', '--max-count', '--context']),
  rg: new Set(['-e', '-f', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '-M', '-j', '-r', '-E', '--regexp', '--file', '--glob', '--iglob', '--type', '--type-not', '--type-add', '--context', '--max-count', '--max-columns', '--threads', '--max-depth', '--maxdepth', '--replace', '--sort', '--sortr', '--encoding', '--max-filesize', '--ignore-file', '--pre-glob', '--color', '--colors']),
  fd: new Set(['-e', '-t', '-E', '-d', '-S', '-o', '-j', '-c', '--extension', '--type', '--exclude', '--max-depth', '--min-depth', '--exact-depth', '--size', '--changed-within', '--changed-before', '--owner', '--threads', '--max-results', '--color', '--path-separator', '--base-directory', '--search-path', '--ignore-file', '--format']),
}
VALUE_FLAGS.egrep = VALUE_FLAGS.grep!
VALUE_FLAGS.fgrep = VALUE_FLAGS.grep!
VALUE_FLAGS.ripgrep = VALUE_FLAGS.rg!

/** Value flags whose value is itself a file read. */
const PATH_VALUE_FLAGS = new Set(['-f', '--file', '--ignore-file', '--base-directory', '--search-path'])

const VERSION_ONLY_COMMANDS = new Set(['claude', 'node', 'python', 'python2', 'python3'])
const VERSION_ONLY_FLAGS = new Set(['-v', '-V', '--version', '-h', '--help'])
const READ_ONLY_DOCKER_SUBCOMMANDS = new Set(['ps', 'images', 'logs', 'inspect'])

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'blame', 'cat-file', 'describe', 'diff', 'for-each-ref', 'grep', 'log', 'ls-files', 'ls-tree', 'merge-base',
  'reflog', 'rev-list', 'rev-parse', 'shortlog', 'show', 'show-ref', 'status', 'whatchanged',
])

/**
 * Git subcommands that are read-only only for specific verbs. `bareIsReadOnly`
 * covers the subcommands that report state when handed no verb at all
 * (`git remote`), which `git stash` and `git worktree` do not.
 */
const READ_ONLY_GIT_SUBCOMMAND_VERBS: Record<string, { verbs: ReadonlySet<string>; bareIsReadOnly: boolean }> = {
  remote: { verbs: new Set(['show', 'get-url']), bareIsReadOnly: true },
  stash: { verbs: new Set(['list', 'show']), bareIsReadOnly: false },
  worktree: { verbs: new Set(['list']), bareIsReadOnly: false },
}

const GIT_CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l'])
const GIT_CONFIG_WRITE_FLAGS = new Set(['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '-e', '--edit'])

/** `git tag` / `git branch` list only with these flags; a positional operand creates a ref. */
const GIT_REF_LIST_FLAGS = new Set([
  '-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '-i', '--ignore-case', '--show-current',
  '--omit-empty', '--column', '--no-column', '--merged', '--no-merged', '--contains', '--no-contains', '--points-at',
  '--sort', '--format',
])
const GIT_REF_LIST_VALUE_FLAGS = new Set(['--merged', '--no-merged', '--contains', '--no-contains', '--points-at', '--sort', '--format'])

/**
 * `sort` and `tree` are judged by an option allowlist rather than by excluding
 * their output flags: `sort --compress-program=PROG` runs a program, and an
 * exclusion list cannot know every such option.
 */
const SORT_OPTIONS: FlagSpec = {
  boolShort: 'bdfghiMmnRrsuVcCz',
  valueShort: 'ktS',
  boolLong: ['--ignore-leading-blanks', '--dictionary-order', '--ignore-case', '--general-numeric-sort', '--ignore-nonprinting', '--month-sort', '--human-numeric-sort', '--numeric-sort', '--random-sort', '--reverse', '--version-sort', '--check', '--merge', '--stable', '--unique', '--zero-terminated', '--debug'],
  valueLong: ['--key', '--field-separator', '--buffer-size', '--parallel', '--sort', '--check'],
}
const TREE_OPTIONS: FlagSpec = {
  boolShort: 'adlfxiqNQpugshDFvtcUrCnASJX',
  valueShort: 'LPI',
  boolLong: ['--du', '--si', '--prune', '--dirsfirst', '--noreport', '--inodes', '--device', '--gitignore', '--matchdirs', '--ignore-case', '--info', '--metafirst'],
  valueLong: ['--filelimit', '--charset', '--sort', '--timefmt'],
}

interface FlagSpec {
  boolShort: string
  valueShort: string
  boolLong: string[]
  valueLong: string[]
}

/**
 * Whether `name args` is read-only, and if so which of its words name files it
 * reads. Undefined means "not read-only"; the caller decides how risky it is.
 */
export function readOnlyCommand(name: string, args: Word[]): Word[] | undefined {
  const texts = args.map((arg) => arg.text)
  if (name === 'git') return isReadOnlyGit(texts) ? gitReadPaths(args) : undefined
  if (name === 'docker') return isReadOnlyDocker(texts) ? [] : undefined
  if (VERSION_ONLY_COMMANDS.has(name)) {
    return texts.length === 1 && VERSION_ONLY_FLAGS.has(texts[0]!.toLowerCase()) ? [] : undefined
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') {
    const subcommand = texts.find((text) => !text.startsWith('-'))
    return subcommand === 'ls' || subcommand === 'list' ? [] : undefined
  }
  if (name === 'cargo') {
    const subcommand = texts.find((text) => !text.startsWith('-'))
    return subcommand === 'tree' || subcommand === 'metadata' ? [] : undefined
  }
  if (name === 'go') {
    const subcommand = texts.find((text) => !text.startsWith('-'))
    if (subcommand === 'list') return []
    if (subcommand === 'env') return texts.some((text) => text === '-w' || text === '-u') ? undefined : []
    return undefined
  }
  if (!READ_ONLY_COMMANDS.has(name)) return undefined
  if (NO_PATH_COMMANDS.has(name)) {
    if (name === 'date' && texts.some((text) => text === '-s' || text.toLowerCase().startsWith('--set'))) return undefined
    return []
  }

  switch (name) {
    case 'fd':
      return isReadOnlyFd(texts) ? patternFirstPaths(args, VALUE_FLAGS.fd!) : undefined
    case 'find':
      return isReadOnlyFind(texts) ? findRoots(args) : undefined
    case 'rg':
    case 'ripgrep':
      return isReadOnlyRipgrep(texts) ? patternFirstPaths(args, VALUE_FLAGS.rg!) : undefined
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'select-string':
      return patternFirstPaths(args, VALUE_FLAGS[name] ?? new Set())
    case 'jq':
      return jqReadPaths(args)
    case 'sed': {
      const sed = parseSedInvocation(texts)
      if (!sed || sed.inPlace || sed.usesScriptFile || sed.scripts.some(hasDangerousSedScript)) return undefined
      return args.filter((arg) => sed.operands.includes(arg.text))
    }
    case 'sort':
      return allowedFlagsOnly(texts, SORT_OPTIONS) ? positionalWords(args) : undefined
    case 'tree':
      return allowedFlagsOnly(texts, TREE_OPTIONS) ? positionalWords(args) : undefined
    case 'uniq': {
      // `uniq INPUT OUTPUT` writes its second operand.
      const operands = positionalWords(args)
      return operands.length <= 1 ? operands : undefined
    }
    default:
      return positionalWords(args, VALUE_FLAGS[name])
  }
}

export function positionalWords(args: Word[], valueFlags?: ReadonlySet<string>): Word[] {
  const positional: Word[] = []
  let endOfFlags = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (endOfFlags || arg.text === '-' || !arg.text.startsWith('-')) {
      positional.push(arg)
      continue
    }
    if (arg.text === '--') endOfFlags = true
    else if (valueFlags?.has(arg.text)) index++
  }
  return positional
}

/** grep/rg/fd: the first positional is the pattern unless `-e`/`-f` supplied one. */
function patternFirstPaths(args: Word[], valueFlags: ReadonlySet<string>): Word[] {
  const paths: Word[] = []
  let patternGiven = false
  let endOfFlags = false
  let sawPattern = false
  const listOnly = args.some((arg) => arg.text === '--files')
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const text = arg.text
    if (!endOfFlags && text.startsWith('-') && text !== '-') {
      if (text === '--') {
        endOfFlags = true
        continue
      }
      const eq = text.indexOf('=')
      const flag = text.startsWith('--') && eq !== -1 ? text.slice(0, eq) : text
      if (flag === '-e' || flag === '--regexp' || flag === '-f' || flag === '--file') patternGiven = true
      if (eq !== -1 && text.startsWith('--')) {
        if (PATH_VALUE_FLAGS.has(flag)) paths.push({ ...arg, text: text.slice(eq + 1) })
        continue
      }
      if (valueFlags.has(flag)) {
        const value = args[index + 1]
        if (value && PATH_VALUE_FLAGS.has(flag)) paths.push(value)
        index++
      }
      continue
    }
    if (!patternGiven && !listOnly && !sawPattern) {
      sawPattern = true
      continue
    }
    paths.push(arg)
  }
  return paths
}

export function findRoots(args: Word[]): Word[] {
  const roots: Word[] = []
  for (const arg of args) {
    if (arg.text.startsWith('-') || arg.text === '(' || arg.text === '!') break
    roots.push(arg)
  }
  return roots
}

function jqReadPaths(args: Word[]): Word[] {
  const paths: Word[] = []
  let filterSeen = false
  for (let index = 0; index < args.length; index++) {
    const text = args[index]!.text
    if (text === '--args' || text === '--jsonargs') break
    if (text === '--arg' || text === '--argjson') {
      index += 2
      continue
    }
    if (text === '--rawfile' || text === '--slurpfile') {
      const file = args[index + 2]
      if (file) paths.push(file)
      index += 2
      continue
    }
    if (text === '-f' || text === '--from-file') {
      const file = args[index + 1]
      if (file) paths.push(file)
      filterSeen = true
      index++
      continue
    }
    if (text === '--indent' || text === '-L') {
      index++
      continue
    }
    if (text.startsWith('-') && text !== '-') continue
    if (!filterSeen) filterSeen = true
    else paths.push(args[index]!)
  }
  return paths
}

function allowedFlagsOnly(texts: string[], spec: FlagSpec): boolean {
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index]!
    if (text === '--') return true
    if (!text.startsWith('-') || text === '-') continue
    if (text.startsWith('--')) {
      const eq = text.indexOf('=')
      const flag = eq === -1 ? text : text.slice(0, eq)
      if (spec.valueLong.includes(flag)) {
        if (eq === -1 && !spec.boolLong.includes(flag)) index++
        continue
      }
      if (eq !== -1 || !spec.boolLong.includes(flag)) return false
      continue
    }
    for (let letter = 1; letter < text.length; letter++) {
      const ch = text[letter]!
      if (spec.valueShort.includes(ch)) {
        if (letter === text.length - 1) index++
        break
      }
      if (!spec.boolShort.includes(ch)) return false
    }
  }
  return true
}

/** Global options before the git subcommand: the index of the subcommand, or -1 when one redirects what git runs. */
export function gitSubcommandIndex(args: string[]): number {
  let index = 0
  while (index < args.length) {
    const lower = args[index]!.toLowerCase()
    if (lower === '--no-pager' || lower === '-p' || lower === '--paginate' || lower === '--bare' || lower === '--no-replace-objects') {
      index++
      continue
    }
    if (args[index] === '-C' || lower === '--git-dir' || lower === '--work-tree' || lower === '--namespace') {
      if (index + 1 >= args.length) return -1
      index += 2
      continue
    }
    // `-c`, `--config-env` and `--exec-path` all redirect what git executes.
    if (lower === '-c' || lower === '--config-env' || lower === '--exec-path' || lower.startsWith('--exec-path=')) return -1
    if (lower.startsWith('--git-dir=') || lower.startsWith('--work-tree=') || lower.startsWith('--namespace=')) {
      index++
      continue
    }
    break
  }
  return index
}

function isReadOnlyGit(args: string[]): boolean {
  const index = gitSubcommandIndex(args)
  if (index === -1) return false
  const subcommand = args[index]?.toLowerCase()
  if (!subcommand) return false
  const readOnlyVerbs = READ_ONLY_GIT_SUBCOMMAND_VERBS[subcommand]
  if (readOnlyVerbs) {
    const rest = args.slice(index + 1)
    const verb = rest.find((arg) => !arg.startsWith('-'))?.toLowerCase()
    if (verb === undefined) return readOnlyVerbs.bareIsReadOnly && rest.every((arg) => arg === '-v' || arg === '--verbose')
    return readOnlyVerbs.verbs.has(verb)
  }
  if (subcommand === 'config') return isReadOnlyGitConfig(args.slice(index + 1))
  if (subcommand === 'tag' || subcommand === 'branch') return isReadOnlyGitRefListing(args.slice(index + 1))
  if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) return false
  const rawSubcommandArgs = args.slice(index + 1)
  return !rawSubcommandArgs.map((arg) => arg.toLowerCase()).some((arg) => (
    arg === '--ext-diff'
    || arg === '--textconv'
    || arg === '--exec'
    || arg.startsWith('--exec=')
    || arg === '--output'
    || arg.startsWith('--output=')
    || arg === '--open-files-in-pager'
    || arg.startsWith('--open-files-in-pager=')
  )) && !(subcommand === 'grep' && rawSubcommandArgs.some((arg) => arg.startsWith('-O')))
}

/** `-C`/`--git-dir`/`--work-tree` point git at another tree; `diff --no-index` reads plain files. */
function gitReadPaths(args: Word[]): Word[] {
  const texts = args.map((arg) => arg.text)
  const paths: Word[] = []
  const index = gitSubcommandIndex(texts)
  for (let i = 0; i < index; i++) {
    const text = texts[i]!
    if (text === '-C' || text === '--git-dir' || text === '--work-tree') paths.push(args[++i]!)
    else if (text.startsWith('--git-dir=') || text.startsWith('--work-tree=')) paths.push({ ...args[i]!, text: text.slice(text.indexOf('=') + 1) })
  }
  if (texts[index] === 'diff' && texts.includes('--no-index')) {
    paths.push(...args.slice(index + 1).filter((arg) => !arg.text.startsWith('-')))
  }
  return paths
}

/**
 * `git config` reads only with an explicit read selector. A bare `name value`
 * pair writes, and `--get name value` would too, so the operand count is
 * capped at one on top of the selector check.
 */
function isReadOnlyGitConfig(args: string[]): boolean {
  let hasReadFlag = false
  const operands: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const lower = arg.toLowerCase()
    if (GIT_CONFIG_WRITE_FLAGS.has(lower)) return false
    if (GIT_CONFIG_READ_FLAGS.has(lower)) {
      hasReadFlag = true
      continue
    }
    if (lower === '-f' || lower === '--file' || lower === '--blob') {
      index++
      continue
    }
    if (arg.startsWith('-')) continue
    operands.push(arg)
  }
  return hasReadFlag && operands.length <= 1
}

function isReadOnlyGitRefListing(args: string[]): boolean {
  let explicitList = false
  let operands = 0
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    const lower = arg.toLowerCase()
    if (lower.startsWith('--') && lower.includes('=')) {
      if (!GIT_REF_LIST_FLAGS.has(lower.slice(0, lower.indexOf('=')))) return false
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (!GIT_REF_LIST_FLAGS.has(lower)) return false
      if (lower === '-l' || lower === '--list') explicitList = true
      if (GIT_REF_LIST_VALUE_FLAGS.has(lower)) index++
      continue
    }
    operands++
  }
  // Under `-l`/`--list` an operand is a glob to filter by; without one it names a ref to create.
  return operands === 0 || explicitList
}

function isReadOnlyDocker(args: string[]): boolean {
  const subcommand = args.find((arg) => !arg.startsWith('-'))?.toLowerCase()
  return subcommand !== undefined && READ_ONLY_DOCKER_SUBCOMMANDS.has(subcommand)
}

function isReadOnlyFd(args: string[]): boolean {
  return !args.some((arg) => {
    const lower = arg.toLowerCase()
    return lower === '--exec' || lower === '--exec-batch' || /^-[a-z]*x[a-z]*$/.test(lower)
  })
}

function isReadOnlyFind(args: string[]): boolean {
  const writing = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0', '-fprintf'])
  return !args.some((arg) => writing.has(arg.toLowerCase()))
}

function isReadOnlyRipgrep(args: string[]): boolean {
  return !args.some((arg) => {
    const lower = arg.toLowerCase()
    return lower === '--pre' || lower.startsWith('--pre=') || lower === '--hostname-bin' || lower.startsWith('--hostname-bin=')
  })
}
