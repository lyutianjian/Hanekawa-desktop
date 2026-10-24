import path from 'node:path'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { checkWindowsPathSafety, isProtectedPath } from '../../utils/permissions/protectedPaths.js'
import {
  getGlobalMyAgentDir,
  getProjectDataDir,
  getProjectPlansDir,
  getToolResultSpillDir,
  normalizeCaseForComparison,
  resolveExistingPrefix,
  userHome,
} from '../../utils/paths.js'
import type { RiskContext, RiskReason } from './types.js'

export interface RiskContextOptions {
  cwd: string
  /** Key for the project's data dirs (plans, spill, settings.local.json); absent means `cwd`. */
  projectDir?: string
  additionalDirectories?: readonly string[]
  sessionId?: string
  /** The project's memory directory, when auto memory is on: workspace, so reading it is plain reading. */
  memoryDir?: string
}

export function createRiskContext(options: RiskContextOptions): RiskContext {
  const home = userHome()
  const cwd = realPath(path.resolve(options.cwd))
  const projectDir = options.projectDir ?? options.cwd
  const extraRoots = [getProjectPlansDir(projectDir)]
  if (options.sessionId) extraRoots.push(getToolResultSpillDir(projectDir, options.sessionId))
  if (options.memoryDir) extraRoots.push(options.memoryDir)
  // Scratch space is part of the workspace: writing a temp file is ordinary work.
  const tempRoots = [tmpdir(), ...(process.platform !== 'win32' ? ['/tmp'] : [])].map(realPath)
  const additional = (options.additionalDirectories ?? [])
    .map((dir) => dir.trim())
    .filter((dir) => dir !== '')
    .map((dir) => path.resolve(options.cwd, expandHome(dir, home)))
  return {
    cwd,
    home,
    workspaceRoots: [cwd, ...[...additional, ...extraRoots].map(realPath), ...tempRoots],
    tempRoots,
    configFiles: [
      path.join(getGlobalMyAgentDir(), 'settings.json'),
      path.join(getGlobalMyAgentDir(), 'config.json'),
      path.join(getProjectDataDir(projectDir), 'settings.local.json'),
      path.join(options.cwd, '.myagent', 'settings.json'),
    ].map(realPath),
  }
}

export function expandHome(text: string, home: string): string {
  if (text === '~') return home
  if (text.startsWith('~/')) return path.join(home, text.slice(2))
  return text
}

/** `realpath` of the nearest existing ancestor, with the missing tail re-joined. */
export function realPath(absolute: string): string {
  try {
    return resolveExistingPrefix(absolute)
  } catch {
    return absolute
  }
}

/**
 * The path a file-write tool actually operates on: the parent resolved through
 * every symlink, the final component left as named. A write replaces that
 * component by rename and a delete unlinks it, so neither follows it — binding
 * permission to the followed target would refuse a legal delete of a link.
 *
 * Only a missing ancestor is walked past; a permission error, a component that
 * is not a directory, a dangling link or a path without an existing ancestor
 * throws, so callers can refuse instead of trusting an unverified path.
 */
export function resolveWriteTarget(absolute: string): string {
  const missing: string[] = []
  let probe = path.dirname(absolute)

  for (;;) {
    try {
      return path.join(realpathSync(probe), ...missing, path.basename(absolute))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    // realpath answers ENOENT for a dangling link too, and that is not a name
    // a write may create through.
    let entry
    try {
      entry = lstatSync(probe)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (entry?.isSymbolicLink()) {
      throw new Error(`"${probe}" is a symbolic link that does not resolve`)
    }

    const parent = path.dirname(probe)
    if (parent === probe) {
      throw new Error(`"${absolute}" has no existing ancestor`)
    }
    missing.unshift(path.basename(probe))
    probe = parent
  }
}

function comparable(filePath: string): string {
  return normalizeCaseForComparison(filePath.replace(/[\\/]+$/, '') || filePath)
}

export function isSameOrInside(root: string, candidate: string): boolean {
  const r = comparable(root)
  const c = comparable(candidate)
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep)
}

export function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b)
}

/** The workspace root holding `real` (already realpath'd), if any. */
export function workspaceRootOf(real: string, ctx: RiskContext): string | undefined {
  return ctx.workspaceRoots.find((root) => isSameOrInside(root, real))
}

/**
 * A path a call touches. `abs` is absent when the path is relative to a
 * directory the analysis lost track of (`cd "$X" && cat a`): its name still
 * says something, its location does not.
 */
export interface PathTarget {
  raw: string
  abs?: string
}

export type PathAccess = 'read' | 'write'

const SAFE_DEVICES = new Set([
  '/dev/null',
  '/dev/zero',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/tty',
  '/dev/random',
  '/dev/urandom',
])

const PRIVATE_KEY_NAME = /^id_(rsa|ed25519|ecdsa|dsa)/
const ENV_TEMPLATES = new Set(['.env.example', '.env.sample', '.env.template'])
const SHELL_RC_FILES = new Set(['.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.zshenv', '.bash_login', '.envrc'])

export function classifyPath(target: PathTarget, access: PathAccess, ctx: RiskContext): RiskReason[] {
  const reasons: RiskReason[] = []
  const shown = target.raw
  const verb = access === 'read' ? 'Reads' : 'Writes'
  const add = (level: RiskReason['level'], code: string, message: string) => reasons.push({ level, code, message })

  if (checkWindowsPathSafety(target.raw).suspicious) {
    add('risky', 'suspicious_path', `${verb} a path with a suspicious Windows form (${shown}).`)
  }

  const real = target.abs === undefined ? undefined : realPath(target.abs)
  const posixAbs = target.abs?.replace(/\\/g, '/')
  if (posixAbs !== undefined && (SAFE_DEVICES.has(posixAbs) || posixAbs.startsWith('/dev/fd/'))) return reasons
  if (access === 'write' && posixAbs?.startsWith('/dev/')) {
    add('critical', 'device_write', `Writes directly to the device ${shown}.`)
  }

  const names = [...new Set([target.abs ?? target.raw, ...(real ? [real] : [])])]
  for (const name of names) classifyName(name, access, ctx, shown, add)

  const root = real === undefined ? undefined : workspaceRootOf(real, ctx)
  if (root === undefined) {
    if (access === 'read') add('normal', 'outside_read', `Reads ${shown} outside the workspace.`)
    else add('risky', 'outside_write', `Writes ${shown} outside the workspace.`)
  } else if (access === 'write') {
    add('normal', 'write', `Writes ${shown}.`)
    // Judged relative to the workspace root, so a project that itself lives
    // under a `.vscode/` directory is not protected wholesale.
    const relative = path.relative(root, real!)
    if (relative !== '' && isProtectedPath(relative.split(path.sep).join('/'))) {
      add('risky', 'protected_path', `Writes the protected path ${shown}.`)
    }
  }
  return reasons
}

function classifyName(
  name: string,
  access: PathAccess,
  ctx: RiskContext,
  shown: string,
  add: (level: RiskReason['level'], code: string, message: string) => void,
): void {
  const segments = name.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean)
  const base = segments.at(-1) ?? ''
  const parent = segments.at(-2)
  const verb = access === 'read' ? 'Reads' : 'Writes'

  if (isCredential(segments, base, parent, name, ctx)) {
    add('critical', 'credential', `${verb} a private key or credential file (${shown}).`)
  } else if (base === '.npmrc' || base === '.pypirc') {
    add('risky', 'registry_config', `${verb} ${shown}, which may hold a registry token.`)
  }

  // Creating an env file (`cp .env.example .env`) exposes and overwrites no secret.
  const creates = access === 'write' && path.isAbsolute(name) && !existsSync(name)
  if (!creates && (base === '.env' || (base.startsWith('.env.') && !ENV_TEMPLATES.has(base)))) {
    add('risky', 'env_file', `${verb} the environment file ${shown}, which usually holds secrets.`)
  }

  if (access !== 'write') return
  if (isPersistenceLocation(segments, base, parent)) {
    add('critical', 'persistence', `Writes ${shown}, which runs automatically later (shell startup, hooks, login items).`)
  }
  const comparableName = comparable(realPath(name))
  if (path.isAbsolute(name) && ctx.configFiles.some((file) => comparable(file) === comparableName)) {
    add('critical', 'permission_config', `Writes Hanekawa's own permission settings (${shown}).`)
  }
}

function isCredential(segments: string[], base: string, parent: string | undefined, name: string, ctx: RiskContext): boolean {
  if (PRIVATE_KEY_NAME.test(base) && !base.endsWith('.pub')) return true
  if (base.endsWith('.key')) return true
  if (base.endsWith('.pem') && /key|priv/.test(base)) return true
  if (base === '.netrc' || base === '_netrc' || base === '.git-credentials') return true
  if (base === 'credentials' && (parent === '.aws' || parent === '.gcp')) return true
  if (base === 'config' && parent === '.kube') return true
  if (base === 'config.json' && parent === '.docker') return true
  const gcloud = segments.findIndex((segment, index) => segment === '.config' && segments[index + 1] === 'gcloud')
  if (gcloud !== -1 && segments.slice(gcloud + 2).some((segment) => /credential|token/.test(segment))) return true
  // A user-level registry config is where `npm login` puts the token.
  if ((base === '.npmrc' || base === '.pypirc') && path.isAbsolute(name)) {
    return comparable(path.dirname(name)) === comparable(ctx.home)
  }
  return false
}

function isPersistenceLocation(segments: string[], base: string, parent: string | undefined): boolean {
  if (SHELL_RC_FILES.has(base)) return true
  if (parent === '.ssh' && (base === 'authorized_keys' || base === 'authorized_keys2' || base === 'config')) return true
  if (parent === 'fish' && base === 'config.fish') return true
  return hasRun(segments, ['.git', 'hooks'])
    || hasRun(segments, ['library', 'launchagents'])
    || hasRun(segments, ['library', 'launchdaemons'])
    || hasRun(segments, ['.config', 'systemd', 'user'])
    || hasRun(segments, ['.config', 'autostart'])
}

/** Whether `run` appears as consecutive path segments, followed by at least one more. */
function hasRun(segments: string[], run: string[]): boolean {
  for (let start = 0; start + run.length < segments.length; start++) {
    if (run.every((segment, offset) => segments[start + offset] === segment)) return true
  }
  return false
}
