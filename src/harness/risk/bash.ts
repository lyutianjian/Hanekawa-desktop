import path from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { analyzeBashSafety } from '../bashSafety.js'
import { normalizedExecutable, parseSedInvocation } from '../commandAnalysis.js'
import { analyzeDestructiveCommands } from '../destructiveCommands.js'
import { isDangerousRemovalPath } from '../../utils/permissions/protectedPaths.js'
import { classifyPath, expandHome, isSameOrInside, realPath, samePath, workspaceRootOf, type PathAccess, type PathTarget } from './paths.js'
import { findRoots, gitSubcommandIndex, positionalWords, readOnlyCommand } from './readOnlyCommands.js'
import { parseShell, type SimpleCommand, type Word } from './shellParse.js'
import { MASS_DELETE_CODES, type RiskContext, type RiskReason, type RiskTier } from './types.js'

const require = createRequire(import.meta.url)
const picomatch = require('picomatch') as {
  isMatch(input: string, pattern: string, options?: { dot?: boolean; nocase?: boolean }): boolean
}

/** Shells, wrappers and `eval` nested deeper than this are not followed. */
const MAX_DEPTH = 4
/** A glob matching more entries than this is judged by its directory alone. */
const MAX_GLOB_MATCHES = 200

const RESERVED_WORDS = new Set(['!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', '{', '}'])
const LIST_KEYWORDS = new Set(['for', 'select', 'case', 'in'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'])
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm'])
const STDIN_EVALUATORS = new Set(['iex', 'invoke-expression'])
const CODE_FLAGS = new Set(['-c', '-e', '-E', '-p', '-m', '--eval', '--print'])
const SQL_CLIENTS = new Set(['mysql', 'psql', 'sqlite3'])
const REMOVERS = new Set(['rm', 'rmdir', 'unlink', 'remove-item', 'ri', 'del', 'erase', 'rd'])
/** The only variables a path may use and still be judged: the shell resolves them to what the analysis already knows. */
const KNOWN_VARIABLES = /\$\{(HOME|PWD)\}|\$(HOME|PWD)(?![A-Za-z0-9_])|\$\(pwd\)|`pwd`/g
const FORK_BOMB = /([A-Za-z_:][\w:]*)\s*\(\)\s*\{[^}]*\1\s*\|\s*\1\s*&/

const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T'])
const XARGS_VALUE_FLAGS = new Set(['-I', '-L', '-l', '-n', '-P', '-s', '-d', '-E', '-e', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--max-chars'])
const KUBECTL_READ = new Set(['get', 'describe', 'logs', 'explain', 'version', 'config', 'api-resources', 'api-versions', 'cluster-info', 'top'])
const POWER_VERBS = new Set(['poweroff', 'reboot', 'halt', 'kexec'])
const FIND_FILTERS = /^-(i?name|i?path|i?wholename|i?regex|newer\w*|[acm](time|min)|size|empty|user|group|perm|inum|samefile|links)$/
/** Directories a build or install recreates; deleting one is routine cleanup. */
const ARTIFACT_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache', 'coverage', 'target',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.gradle',
])
/** Process names that would take this agent down with them. */
const SELF_PROCESS = /node|electron|hanekawa|myagent/i
const PKILL_VALUE_FLAGS = new Set(['-u', '-U', '-g', '-G', '-P', '-s', '-t', '-F', '--signal', '--uid', '--euid', '--group', '--parent', '--session', '--terminal', '--pidfile'])
const PARTED_WRITES =new Set(['mklabel', 'mkpart', 'rm', 'resizepart', 'rescue', 'name', 'set', 'toggle', 'mkfs'])

export interface BashRisk {
  reasons: RiskReason[]
  readPaths: string[]
  writePaths: string[]
  commands: string[]
}

export function classifyBash(command: string, ctx: RiskContext): BashRisk {
  const analyzer = new BashAnalyzer(ctx)
  for (const issue of analyzeBashSafety(command).issues) {
    if (issue.severity === 'deny') analyzer.add('risky', `shell_${issue.code}`, `The command ${issue.message}.`)
  }
  analyzer.source(command, ctx.cwd, 0)
  return analyzer.result()
}

/** Where a command's runtime operands come from; `find` bounds them by its roots, `xargs` by nothing. */
type RuntimeOperands = false | 'xargs' | 'find'

interface Scope {
  /** Undefined once a `cd` went somewhere the analysis cannot follow. */
  cwd: string | undefined
  dirs: Array<string | undefined>
}

class BashAnalyzer {
  private readonly reasons: RiskReason[] = []
  private readonly reads = new Set<string>()
  private readonly writes = new Set<string>()
  private readonly commands = new Set<string>()

  constructor(private readonly ctx: RiskContext) {}

  add(level: RiskTier, code: string, message: string): void {
    this.reasons.push({ level, code, message })
  }

  result(): BashRisk {
    return { reasons: this.reasons, readPaths: [...this.reads], writePaths: [...this.writes], commands: [...this.commands] }
  }

  source(text: string, cwd: string | undefined, depth: number): void {
    if (depth > MAX_DEPTH) {
      this.add('risky', 'nesting_too_deep', 'Nests shells or wrappers too deeply to analyze.')
      return
    }
    if (FORK_BOMB.test(text)) this.add('critical', 'fork_bomb', 'Defines a fork bomb.')
    const parsed = parseShell(text)
    if (parsed.malformed) this.add('normal', 'unparsed', 'Uses shell syntax the analysis cannot fully follow.')

    const scope: Scope = { cwd, dirs: [] }
    const groups: Array<string | undefined> = []
    let downloadUpstream = false
    for (const item of parsed.items) {
      if (item.kind === 'open') {
        groups.push(scope.cwd)
        continue
      }
      if (item.kind === 'close') {
        // A subshell's `cd` does not outlive it.
        if (groups.length > 0) scope.cwd = groups.pop()
        continue
      }
      if (!item.command.pipedFrom) downloadUpstream = false
      if (this.command(item.command, scope, depth, downloadUpstream)) downloadUpstream = true
    }
  }

  /** Returns whether the command downloads, for the pipe-to-interpreter check. */
  private command(cmd: SimpleCommand, scope: Scope, depth: number, afterDownload: boolean): boolean {
    for (const substitution of cmd.substitutions) this.source(substitution, scope.cwd, depth + 1)
    for (const redirect of cmd.redirects) {
      if (!redirect.target || redirect.op === '<<<') continue
      this.path(redirect.target, redirect.op === '<' || redirect.op === '<&' ? 'read' : 'write', scope)
    }

    let words = cmd.words
    while (words.length > 0 && !words[0]!.dynamic && RESERVED_WORDS.has(words[0]!.text)) words = words.slice(1)
    if (words.length === 0 || (!words[0]!.dynamic && LIST_KEYWORDS.has(words[0]!.text))) return false
    let assignments = 0
    while (assignments < words.length && ASSIGNMENT.test(words[assignments]!.text)) assignments++
    if (assignments > 0) this.add('normal', 'assignment', 'Sets shell or environment variables.')
    words = words.slice(assignments)
    return words.length > 0 && this.words(words, scope, depth, afterDownload, false)
  }

  /**
   * One command's words. `runtimeOperands` marks a command that receives more
   * arguments at runtime (`xargs`, `find -exec`), which no path check can see.
   */
  private words(words: Word[], scope: Scope, depth: number, afterDownload: boolean, runtimeOperands: RuntimeOperands): boolean {
    if (depth > MAX_DEPTH) {
      this.add('risky', 'nesting_too_deep', 'Nests shells or wrappers too deeply to analyze.')
      return false
    }
    this.commands.add(words.map((word) => word.text).join(' '))
    const head = words[0]!
    if (head.dynamic) {
      this.add('risky', 'dynamic_command', 'Runs a program whose name is only known at runtime.')
      return false
    }
    const name = normalizedExecutable(head.text)
    const args = words.slice(1)
    const texts = args.map((arg) => arg.text)
    const inner = (rest: Word[], moreOperands = runtimeOperands) => (
      rest.length > 0 && this.words(rest, scope, depth + 1, afterDownload, moreOperands)
    )

    switch (name) {
      case 'sudo':
      case 'doas':
        this.add('risky', 'privilege', `Runs with elevated privileges (${name}).`)
        return inner(skipOptions(args, SUDO_VALUE_FLAGS))
      case 'su': {
        this.add('risky', 'privilege', 'Switches user with su.')
        const payload = args[texts.indexOf('-c') + 1]
        if (texts.includes('-c') && payload) this.payload(payload, scope, depth)
        return false
      }
      case 'env':
        return inner(this.envCommand(args, scope, depth))
      case 'command':
        if (texts[0] === '-v' || texts[0] === '-V') return false
        return inner(skipOptions(args, new Set()))
      case 'exec':
        return inner(skipOptions(args, new Set(['-a'])))
      case 'nohup':
      case 'time':
        return inner(skipOptions(args, new Set()))
      case 'nice':
        return inner(skipOptions(args, new Set(['-n'])))
      case 'timeout':
        return inner(skipOptions(args, new Set(['-s', '-k'])).slice(1))
      case 'busybox':
        return inner(args)
      case 'xargs': {
        const rest = skipOptions(args, XARGS_VALUE_FLAGS)
        const argFile = texts.findIndex((text) => text === '-a' || text === '--arg-file')
        if (argFile !== -1 && args[argFile + 1]) this.path(args[argFile + 1]!, 'read', scope)
        return inner(rest.length > 0 ? rest : [literal('echo')], 'xargs')
      }
      case 'eval':
        if (args.some((arg) => arg.dynamic)) this.add('risky', 'dynamic_eval', 'Evaluates code only known at runtime.')
        if (args.some(runsDownloadedCode)) this.downloadExec()
        this.source(texts.join(' '), scope.cwd, depth + 1)
        return false
      case 'source':
      case '.':
        if (args[0] && runsDownloadedCode(args[0])) this.downloadExec()
        this.add('normal', 'runs_script', `Runs the script ${texts[0] ?? ''} in the current shell.`)
        return false
      case 'cd':
      case 'pushd':
      case 'popd':
        this.changeDirectory(name, args, scope)
        return false
    }

    if (SHELLS.has(name)) {
      if (args.some(runsDownloadedCode)) this.downloadExec()
      const payloadIndex = shellPayloadIndex(texts)
      if (payloadIndex !== undefined) {
        if (args[payloadIndex]) this.payload(args[payloadIndex]!, scope, depth)
        return false
      }
      const script = args.find((arg) => !arg.text.startsWith('-'))
      if (afterDownload && (!script || texts.includes('-s'))) this.downloadExec()
      this.add('normal', 'runs', `Runs ${name}.`)
      return false
    }
    if (STDIN_EVALUATORS.has(name) || /^(python[0-9.]*|perl|ruby|node|deno|bun|php)$/.test(name)) {
      if (args.some(runsDownloadedCode)) this.downloadExec()
      if (afterDownload && readsProgramFromStdin(name, texts)) this.downloadExec()
    }

    const readPaths = readOnlyCommand(name, args)
    if (readPaths) {
      if (runtimeOperands) this.add('normal', 'runtime_operands', `Runs ${name} on arguments only known at runtime.`)
      for (const word of readPaths) this.path(word, 'read', scope)
    } else {
      this.add('normal', 'runs', `Runs ${name}.`)
      this.checkCommand(name, args, scope, depth, runtimeOperands)
      if (!REMOVERS.has(name) && name !== 'find' && name !== 'git') this.wrappedRemoval(args, scope, depth, runtimeOperands)
    }
    return DOWNLOADERS.has(name)
  }

  /**
   * `watch rm -rf ~`, `flock l rm -rf ~`: a command this analysis does not know
   * may run the rest of its line. Only a mass delete found there counts, so
   * `npm rm left-pad` stays what it was.
   */
  private wrappedRemoval(args: Word[], scope: Scope, depth: number, runtimeOperands: RuntimeOperands): void {
    const start = args.findIndex((arg) => !arg.dynamic && REMOVERS.has(normalizedExecutable(arg.text)))
    if (start === -1) return
    const inner = new BashAnalyzer(this.ctx)
    inner.words(args.slice(start), { cwd: scope.cwd, dirs: [] }, depth + 1, false, runtimeOperands)
    this.reasons.push(...inner.reasons.filter((reason) => MASS_DELETE_CODES.has(reason.code)))
  }

  /** `word` with `$HOME`, `$PWD` and `$(pwd)` filled in; still dynamic if anything else is left to the runtime. */
  private expanded(word: Word, scope: Scope): Word {
    if (!word.dynamic) return word
    const text = word.text.replace(KNOWN_VARIABLES, (match, braced?: string, bare?: string) => (
      (braced ?? bare) === 'HOME' ? this.ctx.home : scope.cwd ?? match
    ))
    return /[$`]|\{[^}]*(,|\.\.)[^}]*\}/.test(text) ? word : { ...word, text, dynamic: false }
  }

  /** A relative path after a `cd` the analysis could not follow. */
  private unseen(word: Word, scope: Scope): boolean {
    return scope.cwd === undefined && !path.isAbsolute(word.tilde ? expandHome(word.text, this.ctx.home) : word.text)
  }

  private unknownDelete(what: string): void {
    this.add('critical', 'unknown_delete', `Recursively deletes ${what}, a location only known at runtime; write the path out literally.`)
  }

  private payload(word: Word, scope: Scope, depth: number): void {
    if (runsDownloadedCode(word)) this.downloadExec()
    this.source(word.text, scope.cwd, depth + 1)
  }

  private downloadExec(): void {
    this.add('critical', 'download_exec', 'Downloads code and runs it immediately.')
  }

  private envCommand(args: Word[], scope: Scope, depth: number): Word[] {
    let index = 0
    while (index < args.length) {
      const text = args[index]!.text
      if (ASSIGNMENT.test(text)) {
        this.add('normal', 'assignment', 'Sets shell or environment variables.')
        index++
      } else if (text === '-S' || text === '--split-string') {
        const payload = args[index + 1]
        if (payload) this.payload(payload, scope, depth)
        return []
      } else if (text === '-u' || text === '--unset' || text === '-C' || text === '--chdir') {
        index += 2
      } else if (text === '--') {
        return args.slice(index + 1)
      } else if (text.startsWith('-')) {
        index++
      } else {
        break
      }
    }
    return args.slice(index)
  }

  private changeDirectory(name: string, args: Word[], scope: Scope): void {
    if (name === 'popd') {
      scope.cwd = scope.dirs.length > 0 ? scope.dirs.pop() : undefined
      return
    }
    const found = args.find((arg) => !arg.text.startsWith('-') || arg.text === '-')
    const target = found && this.expanded(found, scope)
    let next: string | undefined
    if (!target) next = this.ctx.home
    else if (!target.dynamic && !target.glob && target.text !== '-') {
      const text = target.tilde ? expandHome(target.text, this.ctx.home) : target.text
      if (path.isAbsolute(text)) next = path.resolve(text)
      else if (scope.cwd !== undefined) next = path.resolve(scope.cwd, text)
    }
    if (name === 'pushd') scope.dirs.push(scope.cwd)
    scope.cwd = next
    if (next !== undefined && workspaceRootOf(realPath(next), this.ctx) === undefined) {
      this.add('normal', 'outside_read', `Changes to ${target?.text ?? '~'} outside the workspace.`)
    }
  }

  private path(raw: Word, access: PathAccess, scope: Scope): void {
    const word = this.expanded(raw, scope)
    if (word.dynamic) {
      if (access === 'read') this.add('normal', 'dynamic_read', `Reads ${word.text}, a path only known at runtime.`)
      else this.add('risky', 'dynamic_write', `Writes ${word.text}, a path only known at runtime.`)
      return
    }
    for (const target of this.targets(word, scope)) {
      ;(access === 'read' ? this.reads : this.writes).add(target.abs ?? target.raw)
      this.reasons.push(...classifyPath(target, access, this.ctx))
    }
  }

  /** The concrete paths a word names; a glob is expanded against the filesystem the way the shell would. */
  private targets(word: Word, scope: Scope): PathTarget[] {
    const text = word.tilde ? expandHome(word.text, this.ctx.home) : word.text
    if (!path.isAbsolute(text) && (scope.cwd === undefined || /^[A-Za-z]:[\\/]/.test(text))) return [{ raw: word.text }]
    // `..` after a symlink climbs out of the link's target, not out of its
    // parent, so a path with `..` is resolved by the filesystem, not lexically.
    const abs = text.split(/[\\/]/).includes('..')
      ? physicalPath(path.isAbsolute(text) ? path.sep : scope.cwd!, text)
      : path.resolve(scope.cwd ?? path.sep, text)
    if (!word.glob) return [{ raw: word.text, abs }]

    const segments = abs.split(path.sep)
    const first = segments.findIndex((segment) => /[*?[]/.test(segment))
    const directory = segments.slice(0, first).join(path.sep) || path.sep
    if (first < segments.length - 1) {
      // A glob mid-path: judge the literal parts, standing a placeholder in for each glob segment.
      const literal = segments.map((segment) => (/[*?[]/.test(segment) ? '_' : segment)).join(path.sep)
      return [{ raw: word.text, abs: directory }, { raw: word.text, abs: literal }]
    }
    let entries: string[]
    try {
      entries = readdirSync(directory).filter((entry) => picomatch.isMatch(entry, segments[first]!))
    } catch {
      entries = []
    }
    // No match leaves the word as typed, which names nothing sensitive by construction.
    if (entries.length === 0) return [{ raw: word.text, abs }]
    if (entries.length > MAX_GLOB_MATCHES) return [{ raw: word.text, abs: directory }]
    return entries.map((entry) => ({ raw: path.join(path.dirname(word.text), entry), abs: path.join(directory, entry) }))
  }

  private checkCommand(name: string, args: Word[], scope: Scope, depth: number, runtimeOperands: RuntimeOperands): void {
    const texts = args.map((arg) => arg.text)
    const firstPositional = texts.find((text) => !text.startsWith('-'))
    if (REMOVERS.has(name)) return this.removal(name, args, scope, runtimeOperands)
    switch (name) {
      case 'find':
        return this.find(args, scope, depth)
      case 'truncate':
      case 'shred':
        this.add('risky', 'destroys_contents', `Destroys file contents with ${name}.`)
        for (const word of positionalWords(args, new Set(['-s', '-r', '-n', '--size', '--reference', '--iterations']))) this.path(word, 'write', scope)
        return
      case 'killall':
      case 'pkill': {
        const patterns = positionalWords(args, PKILL_VALUE_FLAGS)
        if (patterns.length === 0 || patterns.some((word) => word.dynamic || SELF_PROCESS.test(word.text))) {
          this.add('risky', 'kills_processes', `Kills processes by name with ${name}, possibly this agent's own.`)
        }
        return
      }
      case 'chmod':
      case 'chown':
      case 'chgrp':
        return this.permissions(name, args, scope)
      case 'wipefs':
      case 'diskpart':
      case 'format':
        this.add('critical', 'disk_format', `Formats or wipes disks with ${name}.`)
        return
      case 'fdisk':
        if (!texts.includes('-l')) this.add('critical', 'disk_format', 'Edits a partition table with fdisk.')
        return
      case 'parted':
        if (texts.some((text) => PARTED_WRITES.has(text)) || !texts.some((text) => text === '-l' || text === '--list' || text === 'print')) {
          this.add('critical', 'disk_format', 'Edits a partition table with parted.')
        }
        return
      case 'dd':
        for (const arg of args) {
          if (arg.text.startsWith('of=')) this.path(subWord(arg, arg.text.slice(3)), 'write', scope)
          if (arg.text.startsWith('if=')) this.path(subWord(arg, arg.text.slice(3)), 'read', scope)
        }
        return
      case 'shutdown':
      case 'reboot':
      case 'halt':
      case 'poweroff':
        this.add('critical', 'power', `Shuts down or restarts the machine (${name}).`)
        return
      case 'systemctl':
        if (firstPositional && POWER_VERBS.has(firstPositional)) this.add('critical', 'power', `Shuts down or restarts the machine (systemctl ${firstPositional}).`)
        return
      case 'init':
      case 'telinit':
        if (texts[0] === '0' || texts[0] === '6') this.add('critical', 'power', `Shuts down or restarts the machine (${name} ${texts[0]}).`)
        return
      case 'kill':
        if (killsEverything(texts)) this.add('critical', 'kill_all', 'Kills every process the user can signal (kill -1).')
        return
      case 'crontab': {
        const rest = skipOptions(args, new Set(['-u']), false).map((arg) => arg.text)
        const listing = texts.includes('-l') && !texts.some((text) => text === '-r' || text === '-e') && rest.length === 0
        if (!listing) this.add('critical', 'persistence', 'Changes scheduled jobs with crontab.')
        return
      }
      case 'git':
        return this.git(texts)
      case 'npm':
      case 'pnpm':
      case 'yarn':
      case 'bun': {
        const positional = texts.filter((text) => !text.startsWith('-'))
        if (positional[0] === 'publish' || (positional[0] === 'npm' && positional[1] === 'publish')) this.publish(`${name} publish`)
        return
      }
      case 'cargo':
        if (firstPositional === 'publish') this.publish('cargo publish')
        return
      case 'twine':
        if (firstPositional === 'upload') this.publish('twine upload')
        return
      case 'gem':
        if (firstPositional === 'push') this.publish('gem push')
        return
      case 'docker':
        return this.docker(texts)
      case 'kubectl':
        if (firstPositional && !KUBECTL_READ.has(firstPositional)) this.publish(`kubectl ${firstPositional}`)
        return
      case 'helm':
        if (firstPositional && ['install', 'upgrade', 'uninstall', 'rollback', 'delete'].includes(firstPositional)) this.publish(`helm ${firstPositional}`)
        return
      case 'terraform':
      case 'tofu':
        if (firstPositional === 'apply' || firstPositional === 'destroy') this.publish(`${name} ${firstPositional}`)
        return
      case 'pulumi':
        if (firstPositional === 'up' || firstPositional === 'destroy') this.publish(`pulumi ${firstPositional}`)
        return
      case 'sed': {
        const sed = parseSedInvocation(texts)
        if (sed?.inPlace) for (const arg of args.filter((arg) => sed.operands.includes(arg.text))) this.path(arg, 'write', scope)
        return
      }
      case 'perl':
        if (texts.some((text) => /^-[a-zA-Z]*i/.test(text))) {
          for (const word of positionalWords(args, new Set(['-e', '-E']))) this.path(word, 'write', scope)
        }
        return
      case 'tee':
        for (const word of positionalWords(args)) this.path(word, 'write', scope)
        return
      case 'touch':
        for (const word of positionalWords(args, new Set(['-d', '-t', '-r']))) this.path(word, 'write', scope)
        return
      case 'mkdir':
        for (const word of positionalWords(args, new Set(['-m']))) this.path(word, 'write', scope)
        return
      case 'cp':
      case 'mv':
      case 'install':
      case 'ln':
        return this.copy(name, args, scope)
      case 'curl':
      case 'wget':
        return this.transfer(name, args, scope)
    }
    if (name.startsWith('mkfs')) {
      this.add('critical', 'disk_format', `Formats a filesystem with ${name}.`)
      return
    }
    if (SQL_CLIENTS.has(name)) {
      for (const warning of analyzeDestructiveCommands([name, ...texts].join(' '))) {
        this.add('risky', warning.code, warning.message)
      }
    }
  }

  private removal(name: string, args: Word[], scope: Scope, runtimeOperands: RuntimeOperands): void {
    const texts = args.map((arg) => arg.text.toLowerCase())
    const windows = name === 'del' || name === 'erase' || name === 'rd'
    const recursive = name === 'rm'
      ? texts.some((text) => text === '--recursive' || /^-[a-z]*r/.test(text))
      : name === 'remove-item' || name === 'ri'
        ? texts.some((text) => text === '-recurse' || text === '-r')
        : (windows || name === 'rmdir') && texts.includes('/s')
    const operands = (windows
      ? args.filter((arg) => !/^\/[a-z]$/i.test(arg.text))
      : positionalWords(args)).map((operand) => this.expanded(operand, scope))

    if (recursive && runtimeOperands === 'xargs') this.unknownDelete('the paths xargs hands it')
    else if (runtimeOperands) this.add('risky', 'dynamic_delete', 'Deletes paths only known at runtime.')
    for (const operand of operands) {
      if (recursive && (operand.dynamic || this.unseen(operand, scope))) {
        this.unknownDelete(operand.text)
        continue
      }
      if (operand.dynamic) {
        this.add('risky', 'dynamic_delete', `Deletes ${operand.text}, a path only known at runtime.`)
        continue
      }
      if (this.isCriticalTarget(operand, scope)) {
        this.add('critical', 'catastrophic_delete', `Deletes ${operand.text}: a root, home or workspace directory.`)
      }
      this.path(operand, 'write', scope)
    }
    if (recursive && !operands.every((operand) => this.isDisposable(operand, scope))) {
      this.add('risky', 'recursive_delete', `Recursively deletes ${operands.map((operand) => operand.text).join(' ')}.`)
    }
  }

  /**
   * What a recursive delete of `word` costs nothing to lose: a file or nothing
   * at all (no tree goes), or a tree inside a temp dir or a build-artifact dir.
   */
  private isDisposable(word: Word, scope: Scope): boolean {
    if (word.dynamic) return false
    return this.targets(word, scope).every((target) => {
      if (target.abs === undefined) return false
      if (!isDirectory(target.abs)) return true
      const real = realPath(target.abs)
      if (this.ctx.tempRoots.some((root) => isSameOrInside(root, real) && !samePath(root, real))) return true
      const root = workspaceRootOf(real, this.ctx)
      if (root === undefined) return false
      return path.relative(root, real).split(path.sep).some((segment) => (
        ARTIFACT_DIRS.has(segment.toLowerCase()) || segment.toLowerCase().endsWith('.egg-info')
      ))
    })
  }

  /**
   * The removal targets no rule may cover: `/`, the home directory, a direct
   * child of either, a drive root or its child, a workspace root itself, and a
   * bare `*` in any of those.
   */
  private isCriticalTarget(word: Word, scope: Scope): boolean {
    let text = word.tilde ? expandHome(word.text, this.ctx.home) : word.text
    if (/^[A-Za-z]:([\\/][^\\/]*)?[\\/]?$/.test(text)) return true
    if (word.glob) {
      if (!/(^|[\\/])\*$/.test(text)) return false
      text = text.replace(/[\\/]?\*$/, '') || (text.startsWith('/') ? '/' : '.')
    }
    if (!path.isAbsolute(text) && scope.cwd === undefined) return false
    const abs = path.resolve(scope.cwd ?? path.sep, text)
    return [abs, realPath(abs)].some((candidate) => (
      isDangerousRemovalPath(candidate, this.ctx.home)
      || samePath(path.dirname(candidate), this.ctx.home)
      || this.ctx.workspaceRoots.some((root) => samePath(root, candidate))
    ))
  }

  private find(args: Word[], scope: Scope, depth: number): void {
    const texts = args.map((arg) => arg.text.toLowerCase())
    const roots = findRoots(args).map((root) => this.expanded(root, scope))
    if (roots.length === 0) roots.push(literal('.'))
    const execs: Word[][] = []
    for (let index = 0; index < texts.length; index++) {
      const text = texts[index]!
      if (text === '-exec' || text === '-execdir' || text === '-ok' || text === '-okdir') {
        let end = index + 1
        while (end < args.length && args[end]!.text !== ';' && args[end]!.text !== '+') end++
        const command = args.slice(index + 1, end).filter((arg) => arg.text !== '{}')
        if (command.length > 0) execs.push(command)
        index = end
      } else if (text === '-fprint' || text === '-fprint0' || text === '-fprintf' || text === '-fls') {
        if (args[index + 1]) this.path(args[index + 1]!, 'write', scope)
      }
    }

    // `-exec rm {} +` deletes what `-delete` would.
    if (texts.includes('-delete') || execs.some((command) => REMOVERS.has(normalizedExecutable(command[0]!.text)))) {
      // `-type f` narrows nothing that matters; a name, path, time or size test does.
      const filtered = texts.some((text) => FIND_FILTERS.test(text))
      const contained = roots.every((root) => (
        !root.dynamic && this.targets(root, scope).every((target) => (
          target.abs !== undefined && workspaceRootOf(realPath(target.abs), this.ctx) !== undefined
        ))
      ))
      if (!contained || !(filtered || roots.every((root) => this.isDisposable(root, scope)))) {
        this.add('risky', 'find_delete', 'Deletes every file find matches.')
      }
      for (const root of roots) {
        if (!filtered && (root.dynamic || this.unseen(root, scope))) this.unknownDelete(`everything under ${root.text}`)
        else if (!filtered && this.isCriticalTarget(root, scope)) {
          this.add('critical', 'catastrophic_delete', `Deletes files under ${root.text}: a root, home or workspace directory.`)
        }
        this.path(root, 'write', scope)
      }
    } else {
      for (const root of roots) this.path(root, 'read', scope)
    }
    for (const command of execs) this.words(command, scope, depth + 1, false, 'find')
  }

  private permissions(name: string, args: Word[], scope: Scope): void {
    const texts = args.map((arg) => arg.text)
    const recursive = texts.some((text) => text === '--recursive' || /^-[a-zA-Z]*R/.test(text))
    const operands = args.filter((arg) => !/^(-[RvfchHLP]+|--.*)$/.test(arg.text))
    const mode = operands.shift()?.text ?? ''
    const wide = name === 'chmod' && (/^0?777$/.test(mode) || /(^|,)a?\+[rwxX]*w/.test(mode) || /(^|,)[ao]+\+[rwxX]*w/.test(mode))
    for (const operand of operands) {
      if (operand.dynamic) {
        if (recursive) this.add('risky', 'dynamic_write', `Changes permissions under ${operand.text}, a path only known at runtime.`)
        continue
      }
      if ((recursive || wide) && this.isCriticalTarget(operand, scope)) {
        this.add('critical', 'wide_permissions', `Changes permissions of ${operand.text}: a root, home or workspace directory.`)
      }
      this.path(operand, 'write', scope)
    }
    if (recursive) this.add('risky', 'recursive_permissions', `Recursively changes ownership or permissions with ${name}.`)
  }

  private git(texts: string[]): void {
    const index = gitSubcommandIndex(texts)
    if (index === -1) return
    const subcommand = texts[index]?.toLowerCase()
    const rest = texts.slice(index + 1)
    const short = (letter: string) => rest.some((text) => /^-[a-zA-Z]+$/.test(text) && text.includes(letter))
    const verb = rest.find((text) => !text.startsWith('-'))
    const risky = (code: string, message: string) => this.add('risky', code, message)
    switch (subcommand) {
      case 'reset':
        if (rest.includes('--hard')) risky('git_reset_hard', 'Discards uncommitted changes with git reset --hard.')
        return
      case 'clean':
        if (rest.includes('--force') || short('f')) risky('git_clean_force', 'Deletes untracked files with git clean.')
        return
      case 'push':
        if (rest.some((text) => /^--(force|force-with-lease|force-if-includes|mirror)(=|$)/.test(text)) || short('f')) {
          risky('git_push_force', 'Force-pushes and may overwrite shared history.')
        }
        if (rest.includes('--delete') || short('d') || rest.some((text) => /^[:+]/.test(text))) {
          risky('git_push_rewrite', 'Deletes or force-updates a remote ref.')
        }
        return
      case 'branch':
        if (short('D') || ((short('d') || rest.includes('--delete')) && (short('f') || rest.includes('--force')))) {
          risky('git_branch_force_delete', 'Force-deletes a branch, even unmerged work.')
        }
        return
      case 'checkout':
        if (rest.some((text) => text === '--' || text === '.' || text === '-f' || text === '--force')) {
          risky('git_checkout_discard', 'Discards working-tree changes with git checkout.')
        }
        return
      case 'restore':
        if (!(rest.includes('--staged') || short('S')) || rest.includes('--worktree') || short('W')) {
          risky('git_restore', 'Discards working-tree changes with git restore.')
        }
        return
      case 'stash':
        if (verb === 'drop' || verb === 'clear') risky('git_stash_drop', `Deletes stashed changes with git stash ${verb}.`)
        return
      case 'filter-branch':
      case 'filter-repo':
        risky('git_history_rewrite', `Rewrites repository history with git ${subcommand}.`)
        return
      case 'update-ref':
        if (rest.includes('-d')) risky('git_update_ref_delete', 'Deletes a ref with git update-ref -d.')
        return
      case 'reflog':
        if (verb === 'expire' || verb === 'delete') risky('git_reflog_expire', 'Discards reflog entries, the last way back to lost commits.')
        return
      case 'gc':
        if (rest.some((text) => text === '--prune=now' || text === '--prune=all')) risky('git_gc_prune', 'Permanently prunes unreachable commits.')
    }
  }

  private docker(texts: string[]): void {
    const positional = texts.filter((text) => !text.startsWith('-'))
    if (positional[0] === 'prune' || positional[1] === 'prune') this.add('risky', 'docker_prune', 'Deletes Docker data with prune.')
    const removing = positional[0] === 'rm' || positional[0] === 'rmi' || (positional[0] === 'container' && positional[1] === 'rm')
    if (removing && texts.some((text) => text === '--force' || /^-[a-z]*f/.test(text))) {
      this.add('risky', 'docker_force_remove', 'Force-removes Docker containers or images.')
    }
    if (positional[0] === 'push') this.publish('docker push')
  }

  private publish(what: string): void {
    this.add('risky', 'publish', `Publishes or deploys to a shared system (${what}).`)
  }

  private copy(name: string, args: Word[], scope: Scope): void {
    let target: Word | undefined
    const operands: Word[] = []
    let endOfFlags = false
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!
      if (endOfFlags || !arg.text.startsWith('-') || arg.text === '-') operands.push(arg)
      else if (arg.text === '--') endOfFlags = true
      else if (arg.text === '-t' || arg.text === '--target-directory') target = args[++index]
      else if (arg.text.startsWith('--target-directory=')) target = subWord(arg, arg.text.slice(arg.text.indexOf('=') + 1))
      else if (arg.text === '-S' || (name === 'install' && (arg.text === '-m' || arg.text === '-o' || arg.text === '-g'))) index++
    }
    if (name === 'mv' || (name === 'install' && args.some((arg) => arg.text === '-d'))) {
      for (const operand of operands) this.path(operand, 'write', scope)
      if (target) this.path(target, 'write', scope)
      return
    }
    if (!target && (name !== 'ln' || operands.length >= 2)) target = operands.pop()
    if (target) this.path(target, 'write', scope)
    if (name !== 'ln') for (const operand of operands) this.path(operand, 'read', scope)
  }

  private transfer(name: string, args: Word[], scope: Scope): void {
    const writeFlags = name === 'curl' ? ['-o', '--output'] : ['-O', '--output-document', '-P', '--directory-prefix']
    const readFlags = name === 'curl' ? ['-T', '--upload-file', '-K', '--config'] : ['--post-file', '--body-file', '-i', '--input-file']
    for (let index = 0; index < args.length; index++) {
      const text = args[index]!.text
      const value = args[index + 1]
      if (!value) break
      if (writeFlags.includes(text)) {
        if (value.text !== '-') this.path(value, 'write', scope)
        index++
      } else if (readFlags.includes(text)) {
        this.path(value, 'read', scope)
        index++
      } else if (name === 'curl' && /^(-d|--data|--data-binary|--data-urlencode|--json|-F|--form)$/.test(text)) {
        const file = /(?:^|=)[@<](.+)$/.exec(value.text)?.[1]
        if (file && file !== '-') this.path(subWord(value, file.split(';')[0]!), 'read', scope)
        index++
      }
    }
  }
}

/** `base/text` with each symlink resolved before the `..` after it, as the kernel does. */
function physicalPath(base: string, text: string): string {
  let current = realPath(base)
  for (const segment of text.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    current = segment === '..' ? path.dirname(current) : realPath(path.join(current, segment))
  }
  return current
}

function isDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory()
  } catch {
    return false
  }
}

function literal(text: string): Word {
  return { text, dynamic: false, glob: false, tilde: false }
}

/** Part of a word (`of=PATH`, `@PATH`) taken as a word of its own. */
function subWord(word: Word, text: string): Word {
  return { ...word, text, tilde: text === '~' || text.startsWith('~/'), glob: word.glob && /[*?[]/.test(text) }
}

/** The words after a command's leading options. */
function skipOptions(args: Word[], valueFlags: ReadonlySet<string>, stopAtOperand = true): Word[] {
  const rest: Word[] = []
  let index = 0
  for (; index < args.length; index++) {
    const text = args[index]!.text
    if (text === '--') return [...rest, ...args.slice(index + 1)]
    if (!text.startsWith('-') || text === '-') {
      if (stopAtOperand) break
      rest.push(args[index]!)
      continue
    }
    if (valueFlags.has(text)) index++
  }
  return [...rest, ...args.slice(index)]
}

/** Index of the script a shell was handed with `-c` (also in a flag cluster like `-lc`). */
function shellPayloadIndex(texts: string[]): number | undefined {
  for (let index = 0; index < texts.length; index++) {
    const text = texts[index]!
    if (!text.startsWith('-') || text.startsWith('--')) {
      if (!text.startsWith('-')) return undefined
      continue
    }
    if (text.slice(1).includes('c')) return index + 1
  }
  return undefined
}

function readsProgramFromStdin(name: string, texts: string[]): boolean {
  if (STDIN_EVALUATORS.has(name)) return true
  if (texts.some((text) => CODE_FLAGS.has(text))) return false
  const script = texts.find((text) => !text.startsWith('-') || text === '-')
  return script === undefined || script === '-'
}

/** A `$(curl …)` or `<(curl …)` word: whatever runs it runs code fresh off the network. */
function runsDownloadedCode(word: Word): boolean {
  if (!word.dynamic) return false
  return parseShell(word.text).items.some((item) => (
    item.kind === 'command' && item.command.substitutions.some(sourceDownloads)
  ))
}

function sourceDownloads(source: string): boolean {
  return parseShell(source).items.some((item) => {
    if (item.kind !== 'command') return false
    const words = item.command.words.filter((word) => !ASSIGNMENT.test(word.text))
    const index = words.findIndex((word) => !['sudo', 'env', 'command', 'exec'].includes(normalizedExecutable(word.text)) && !word.text.startsWith('-'))
    return index !== -1 && DOWNLOADERS.has(normalizedExecutable(words[index]!.text))
  })
}

function killsEverything(texts: string[]): boolean {
  let index = 0
  if (texts[0] === '-s' || texts[0] === '-n') index = 2
  else if (texts.length > 1 && /^-([0-9]+|[A-Za-z]+)$/.test(texts[0] ?? '')) index = 1
  if (texts[index] === '--') index++
  return texts.slice(index).includes('-1')
}
