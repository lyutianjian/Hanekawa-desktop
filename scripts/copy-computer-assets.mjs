import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Copy native files as files, never into an esbuild bundle or an ASAR archive. */
export function copyComputerAssets(destRoot) {
  const require = createRequire(import.meta.url)
  const packageRoot = dirname(require.resolve('agent-desktop/package.json'))
  const { resolve, helperNames } = require('agent-desktop/lib/platform.js')
  const entry = resolve(process.platform, process.arch)
  if (!entry?.released) throw new Error(`Computer use has no native build for ${process.platform}-${process.arch}.`)
  const dest = join(destRoot, 'desktop', 'computer', 'native')
  mkdirSync(dest, { recursive: true })
  const copies = [[entry.binaryName, entry.entries[0]]]
  for (const helper of helperNames(entry)) {
    const qualified = `${helper}-${process.platform}-${process.arch}`
    // npm can suppress postinstall; the package also carries each helper under
    // its platform-qualified name, so no install script or download is needed.
    copies.push([existsSync(join(packageRoot, 'bin', qualified)) ? qualified : helper, helper])
  }
  for (const [source, name] of copies) {
    const destination = join(dest, name)
    copyFileSync(join(packageRoot, 'bin', source), destination)
    if (process.platform !== 'win32') chmodSync(destination, 0o755)
  }
  copyFileSync(join(packageRoot, 'README.md'), join(dest, 'agent-desktop-README.md'))
  copyFileSync(new URL('../third-party/agent-desktop-LICENSE', import.meta.url), join(dest, 'LICENSE'))
}
