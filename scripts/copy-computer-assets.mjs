import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

/** Build our public-API helper as a real executable outside ASAR. */
export function copyComputerAssets(destRoot) {
  const dest = join(destRoot, 'desktop', 'computer', 'native')
  // Remove obsolete agent-desktop files on incremental builds as well.
  rmSync(dest, { recursive: true, force: true })
  if (process.platform !== 'darwin') return
  mkdirSync(dest, { recursive: true })
  const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
  const scratch = mkdtempSync(join(tmpdir(), 'hanekawa-swift-'))
  try {
    const executable = join(dest, 'hanekawa-computer')
    execFileSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`, '-module-cache-path', scratch,
      join(root, 'native/computer/ComputerBridge.swift'), '-o', executable], { stdio: 'inherit' })
    chmodSync(executable, 0o755)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
