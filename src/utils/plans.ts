/**
 * Plan-mode file utilities.
 *
 * Hanekawa plan mode mirrors Claude Code's real behaviour:
 *   - Plan files live at `<plansDir>/<word-slug>.md` (main session) or
 *     `<plansDir>/<word-slug>-agent-<agentId>.md` (sub-agents).
 *   - The slug is generated LAZILY on first call — entering plan mode does
 *     NOT create a file. The model is told the path via the plan_mode
 *     attachment and writes/edits the file itself using Write/Edit, which
 *     the permission gate auto-allows for any path matching the prefix.
 *   - One slug per session, in-memory. Re-entering plan mode in the same
 *     session reuses the slug. /clear clears the slug.
 */

import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getProjectPlansDir } from './paths.js'

/** Process-wide cache: sessionId → slug. Survives across plan mode entry/exit
 *  within the same session. Cleared by clearPlanSlug or clearAllPlanSlugs. */
const SLUG_CACHE = new Map<string, string>()

/** Maximum retries when generating a slug to avoid existing-file collision. */
const MAX_SLUG_RETRIES = 10

// Compact word lists — sized for low collision in typical use without
// shipping a 30 KB dictionary. ~50 × 50 × 50 = 125k unique combinations.

const ADJECTIVES = [
  'amber', 'azure', 'bold', 'brave', 'bright', 'calm', 'clever', 'cosmic',
  'crimson', 'crystal', 'curious', 'dapper', 'dazzling', 'eager', 'electric',
  'emerald', 'fancy', 'fierce', 'gentle', 'golden', 'happy', 'humble', 'indigo',
  'jade', 'jolly', 'keen', 'lively', 'lucky', 'merry', 'mighty', 'nimble',
  'noble', 'plucky', 'quiet', 'radiant', 'rapid', 'rustic', 'scarlet', 'silver',
  'silent', 'sleek', 'spry', 'stellar', 'sunny', 'swift', 'twilight', 'velvet',
  'vivid', 'wandering', 'witty', 'zealous',
]

const VERBS = [
  'bouncing', 'building', 'chasing', 'climbing', 'crafting', 'dancing',
  'discovering', 'dreaming', 'drifting', 'exploring', 'flying', 'gliding',
  'guarding', 'humming', 'jumping', 'leaping', 'mending', 'painting', 'planning',
  'playing', 'racing', 'reading', 'roaming', 'sailing', 'searching', 'shining',
  'singing', 'sketching', 'sliding', 'smiling', 'soaring', 'sparkling', 'spinning',
  'sprinting', 'stargazing', 'studying', 'swimming', 'thinking', 'tracking',
  'traveling', 'venturing', 'wandering', 'watching', 'weaving', 'whispering',
  'whistling', 'wondering', 'working', 'writing', 'yearning',
]

const NOUNS = [
  'badger', 'beacon', 'breeze', 'bridge', 'canyon', 'castle', 'cavern', 'cipher',
  'cloud', 'comet', 'compass', 'cricket', 'dragon', 'eagle', 'echo', 'ember',
  'falcon', 'feather', 'forest', 'fountain', 'galaxy', 'garden', 'glacier',
  'griffin', 'harbor', 'horizon', 'island', 'lantern', 'lighthouse', 'lily',
  'meadow', 'meridian', 'mosaic', 'nebula', 'opal', 'orchid', 'otter', 'panda',
  'pebble', 'phoenix', 'prism', 'quartz', 'raven', 'river', 'shadow', 'sparrow',
  'spire', 'tundra', 'valley', 'wanderer',
]

function pickRandom<T>(arr: readonly T[]): T {
  // Use crypto RNG for a tiny bit of unpredictability beyond Math.random.
  const idx = randomBytes(2).readUInt16BE() % arr.length
  return arr[idx]!
}

/**
 * Generate a fresh adjective-verb-noun slug. Caller is responsible for
 * collision check against the plans directory — see getOrCreatePlanSlug.
 */
export function generateWordSlug(): string {
  return `${pickRandom(ADJECTIVES)}-${pickRandom(VERBS)}-${pickRandom(NOUNS)}`
}

/**
 * Resolve the plans directory, `~/.hanekawa/projects/<key>/plans`. Creates it on
 * first call (mkdir recursive). Idempotent.
 */
export function getPlansDir(cwd: string): string {
  const dir = getProjectPlansDir(cwd)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // mkdirSync is idempotent with recursive:true; any error here is
    // either a real filesystem fault (which downstream IO will surface)
    // or a benign race. Swallow.
  }
  return dir
}

/**
 * Get-or-create the in-memory slug for a session. First call generates a
 * fresh slug (with collision retry against the plans directory); subsequent
 * calls return the cached value. Re-entering plan mode in the same session
 * reuses the slug.
 *
 * Pure side effects: cache write + file existence checks. Does NOT create
 * the plan file itself — the model creates it via Write when it first
 * decides to record its plan.
 */
export function getOrCreatePlanSlug(cwd: string, sessionId: string): string {
  const cached = SLUG_CACHE.get(sessionId)
  if (cached) return cached

  const plansDir = getPlansDir(cwd)
  let slug = generateWordSlug()
  for (let i = 0; i < MAX_SLUG_RETRIES; i++) {
    const probe = join(plansDir, `${slug}.md`)
    if (!existsSync(probe)) break
    slug = generateWordSlug()
  }
  // Final verification: if all retries collided, the last slug still collides.
  // Throw rather than silently returning a non-unique slug.
  const finalProbe = join(plansDir, `${slug}.md`)
  if (existsSync(finalProbe)) {
    throw new Error(
      `Failed to generate a unique plan slug after ${MAX_SLUG_RETRIES} attempts. ` +
      `Last candidate "${slug}" already exists at ${finalProbe}.`,
    )
  }
  SLUG_CACHE.set(sessionId, slug)
  return slug
}

/**
 * Read-only lookup. Returns the cached slug for a session, or undefined if
 * no slug has been generated yet. Used by StatusLine and other observers
 * that want to display the slug without forcing generation.
 */
export function getPlanSlug(sessionId: string): string | undefined {
  return SLUG_CACHE.get(sessionId)
}

/**
 * Explicitly seed the slug cache. Used during session resume / fork to
 * carry the slug forward without regenerating.
 */
export function setPlanSlug(sessionId: string, slug: string): void {
  SLUG_CACHE.set(sessionId, slug)
}

/**
 * Clear the slug for a session. /clear and clearConversation should call
 * this so the next plan mode entry generates a fresh slug.
 */
export function clearPlanSlug(sessionId: string): void {
  SLUG_CACHE.delete(sessionId)
}

/** Drop every cached slug. Used on TUI shutdown / test cleanup. */
export function clearAllPlanSlugs(): void {
  SLUG_CACHE.clear()
}

/**
 * Resolve the plan file path for a session. Generates the slug on first
 * call. For sub-agents, appends `-agent-<agentId>` to the slug so each
 * sub-agent gets its own file under the same session.
 *
 *   main:      <plansDir>/<slug>.md
 *   sub-agent: <plansDir>/<slug>-agent-<agentId>.md
 *
 * Both forms share the same prefix `<plansDir>/<slug>`, so the permission
 * gate's `isSessionPlanFile` prefix check covers both (Claude Code parity).
 */
export function getPlanFilePath(
  cwd: string,
  sessionId: string,
  agentId?: string,
): string {
  const slug = getOrCreatePlanSlug(cwd, sessionId)
  const dir = getPlansDir(cwd)
  return agentId
    ? join(dir, `${slug}-agent-${agentId}.md`)
    : join(dir, `${slug}.md`)
}

/**
 * Atomic write via temp + rename. Caller must ensure the destination
 * directory exists (getPlansDir handles the plans/ root, but agent-specific
 * paths share the same root so no extra mkdir is needed).
 */
export async function writePlan(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  // Ensure parent exists in case caller passed a non-plans-dir path.
  mkdirSync(dirname(filePath), { recursive: true })
  await writeFile(tmp, content, 'utf8')
  // fs.promises.rename is atomic on POSIX and best-effort on Windows.
  const { rename } = await import('node:fs/promises')
  await rename(tmp, filePath)
}

/**
 * Read plan content from disk. Returns null if the file doesn't exist
 * (ENOENT). Other errors propagate.
 */
export async function readPlan(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Copy a plan file. Used by sub-agent contexts that want to seed a child
 * file with the parent's content. Errors propagate.
 */
export async function copyPlanFile(srcPath: string, destPath: string): Promise<void> {
  await copyFile(srcPath, destPath)
}
