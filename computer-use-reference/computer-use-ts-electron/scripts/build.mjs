import { build } from 'esbuild';
import { mkdir, copyFile, rm } from 'node:fs/promises';
import { globSync } from 'node:fs';
await rm('dist', { recursive: true, force: true });
await mkdir('dist/renderer', { recursive: true });
const options = { bundle: true, platform: 'node', target: 'node24', format: 'cjs', sourcemap: true };
await build({ ...options, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.cjs', external: ['electron'] });
// A sandboxed preload may require Electron, but cannot require our other files.
await build({ ...options, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.cjs', external: ['electron'] });
await build({ bundle: true, platform: 'browser', target: 'chrome140', entryPoints: ['src/renderer/index.ts'], outfile: 'dist/renderer/index.js' });
await build({ ...options, entryPoints: ['src/demo.ts'], outfile: 'dist/demo.cjs' });
for (const file of globSync('tests/*.test.ts')) {
  await build({ ...options, entryPoints: [file], outfile: file.replace('tests/', 'dist/tests/').replace('.ts', '.cjs') });
}
for (const name of ['index.html', 'style.css']) await copyFile(`src/renderer/${name}`, `dist/renderer/${name}`);
