#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

if (process.platform !== 'darwin') throw new Error('Generate the macOS ICNS on macOS.')
const source = fileURLToPath(new URL('../build/icon-source.png', import.meta.url))
const output = fileURLToPath(new URL('../build/icon.icns', import.meta.url))
const metadata = await sharp(source).metadata()
if (metadata.width !== 1024 || metadata.height !== 1024) throw new Error('Expected a 1024×1024 source icon.')
const root = mkdtempSync(join(tmpdir(), 'hanekawa-icons-'))
try {
  const iconset = join(root, 'Hanekawa.iconset')
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
      await sharp(source).resize(size * scale, size * scale).png().toFile(join(iconset, name))
    }
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', output])
  console.log(`Generated ${output}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
