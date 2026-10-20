/**
 * How much a single tool call can change, independent of permission mode:
 * - `readonly`: changes nothing and reads only inside the workspace.
 * - `normal`: ordinary writes and execution, network, reads outside the workspace.
 * - `risky`: irreversible or wide-reaching, but everyday development work.
 * - `critical`: plainly dangerous — destruction, privilege, persistence, credentials.
 */
export type RiskTier = 'readonly' | 'normal' | 'risky' | 'critical'

export const RISK_TIERS: readonly RiskTier[] = ['readonly', 'normal', 'risky', 'critical']

export interface RiskReason {
  /** Stable identifier, e.g. `private_key`, `git_push_force`. */
  code: string
  /** One sentence, written for both the user and the model. */
  message: string
  level: RiskTier
}

export interface RiskAssessment {
  level: RiskTier
  /** Every finding above `readonly`, highest first. */
  reasons: RiskReason[]
  /** A file-tool write (`Write`, `Edit`, …); shell writes do not set it. */
  isFileWrite: boolean
  /** Paths the call reads or writes, absolute where they could be resolved. */
  readPaths: string[]
  writePaths: string[]
  /**
   * Shell tools: each command the shell would run, as its words — loop and
   * `if` keywords, subshells, wrappers (`sudo`, `timeout`, `xargs`) peeled off,
   * substitutions and `sh -c`/`eval` payloads included.
   */
  commands: string[]
}

export interface RiskContext {
  /** The workspace root the call runs in, symlinks resolved. */
  cwd: string
  home: string
  /** `cwd`, additional directories, the session's spill/plan dirs and the system temp dirs, all resolved. */
  workspaceRoots: string[]
  /** The system temp dirs, resolved; also in `workspaceRoots`. */
  tempRoots: string[]
  /** Hanekawa's own permission-bearing settings files; writing one is self-escalation. */
  configFiles: string[]
}

/**
 * Deleting a root, home or workspace directory, or a tree whose location is
 * only known at runtime: the one kind of critical call bypass still refuses.
 */
export const MASS_DELETE_CODES: ReadonlySet<string> = new Set(['catastrophic_delete', 'unknown_delete'])

export function tierRank(tier: RiskTier): number {
  return RISK_TIERS.indexOf(tier)
}

export function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return tierRank(a) >= tierRank(b) ? a : b
}
