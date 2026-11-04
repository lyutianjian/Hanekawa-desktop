import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/** Build our public-API helper as a real executable outside ASAR. */
export function copyComputerAssets(destRoot, run = execFileSync) {
  const dest = join(destRoot, 'desktop', 'computer', 'native')
  // Remove obsolete agent-desktop files on incremental builds as well.
  rmSync(dest, { recursive: true, force: true })
  if (process.platform !== 'darwin') return
  mkdirSync(dest, { recursive: true })
  const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
  const scratch = mkdtempSync(join(dest, '.build-'))
  try {
    const executable = join(scratch, 'hanekawa-computer')
    run('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`, '-module-cache-path', scratch,
      join(root, 'native/computer/ComputerBridge.swift'), join(root, 'native/computer/ElementIdentity.swift'), join(root, 'native/computer/Observation.swift'), join(root, 'native/computer/TextSelection.swift'), join(root, 'native/computer/KeyboardInput.swift'), '-o', executable], { stdio: 'inherit', timeout: 120_000 })
    chmodSync(executable, 0o755)
    const result = JSON.parse(run(executable, ['--self-test'], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }))
    if (result.passed !== true || result.scope !== 'protocol helpers only; no GUI access') throw new Error('Computer helper self-test did not pass')
    renameSync(executable, join(dest, 'hanekawa-computer'))
  } catch (error) {
    rmSync(dest, { recursive: true, force: true })
    throw error
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
