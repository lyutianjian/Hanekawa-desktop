import { existsSync } from 'node:fs'

/**
 * What a second launch asks the already-running instance to do.
 *
 * Electron's `second-instance` reports the new process's working directory as
 * well as its argv, and for a packaged launch that directory is the app's own
 * folder, the folder the installer launched from, or `/` — never something the
 * user chose. Treating it as intent is how the install directory used to end up
 * in the projects registry: a sidebar row pointing at the `.app` bundle, a data
 * directory under `~/.myagent/projects/`, and a startup target for the next
 * launch, all from double-clicking the icon.
 *
 * Only `--cwd=` names a project. Everything else is "come to the front", which
 * is a focus when there is a window and the ordinary reopen when there is not —
 * the same resolution a Dock click makes, so a second launch never invents a
 * project of its own.
 */
export type SecondLaunchIntent =
  | { kind: 'open'; cwd: string }
  | { kind: 'focus' }
  | { kind: 'reopen' }

/**
 * The `--cwd=` value, when there is one and it names a directory this machine
 * still has. A stale flag is not intent either: opening a path that no longer
 * exists would fail at bootstrap, after the window was already gone.
 */
export function explicitCwd(
  argv: readonly string[] = process.argv,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const flag = argv.find((arg) => arg.startsWith('--cwd='))
  if (!flag) return undefined
  const value = flag.slice('--cwd='.length)
  if (value === '') return undefined
  return exists(value) ? value : undefined
}

/**
 * The decision, separated from the event: `second-instance`'s own
 * `workingDirectory` argument never reaches this function, which is the point.
 */
export function secondLaunchIntent(
  argv: readonly string[],
  options: { hasWindow: boolean },
  exists: (path: string) => boolean = existsSync,
): SecondLaunchIntent {
  const cwd = explicitCwd(argv, exists)
  if (cwd !== undefined) return { kind: 'open', cwd }
  return options.hasWindow ? { kind: 'focus' } : { kind: 'reopen' }
}