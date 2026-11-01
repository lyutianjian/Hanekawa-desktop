#!/usr/bin/env node
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Anchor to this script: release builds may be invoked from another directory.
rmSync(fileURLToPath(new URL('../dist', import.meta.url)), { recursive: true, force: true })
