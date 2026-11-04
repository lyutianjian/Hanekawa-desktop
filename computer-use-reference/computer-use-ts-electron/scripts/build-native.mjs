import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
if (process.platform !== 'darwin') throw new Error('The native helper requires macOS 14.4+ and Xcode Command Line Tools');
mkdirSync('resources/bin', { recursive: true });
mkdirSync('build/swift-cache', { recursive: true });
const result = spawnSync('swiftc', ['-parse-as-library', '-module-cache-path', 'build/swift-cache', 'native/MacAXBridge.swift', '-o', 'resources/bin/mac-ax-bridge'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
