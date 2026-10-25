import assert from 'node:assert/strict'
import test from 'node:test'

import { explicitCwd, secondLaunchIntent } from '../src/desktop/launchArgs.js'

/**
 * What a second launch is allowed to open.
 *
 * The registry is the desktop's memory of the user's projects, so anything that
 * writes to it is intent. Electron hands `second-instance` the new process's
 * working directory, which is the app bundle's folder for a double-clicked
 * icon — the bug was treating that as a project to open.
 */

const always = () => true
const never = () => false

test('only --cwd= names a project', () => {
  assert.equal(explicitCwd(['electron', '.', '--cwd=/w/one'], always), '/w/one')
  assert.equal(explicitCwd(['electron', '.'], always), undefined)
  assert.equal(explicitCwd(['electron', '/w/one'], always), undefined, 'a positional path is not a flag')
})

test('a --cwd= that no longer exists is not intent either', () => {
  assert.equal(explicitCwd(['--cwd=/w/gone'], never), undefined)
  assert.deepEqual(
    secondLaunchIntent(['--cwd=/w/gone'], { hasWindow: true }, never),
    { kind: 'focus' },
    'bootstrap would fail after the window was already gone',
  )
})

test('an empty --cwd= opens nothing', () => {
  assert.equal(explicitCwd(['--cwd='], always), undefined)
})

test('a second launch with a window and no flag only comes to the front', () => {
  assert.deepEqual(secondLaunchIntent(['electron', '.'], { hasWindow: true }, always), { kind: 'focus' })
})

test('a second launch with no window falls back to the ordinary reopen', () => {
  assert.deepEqual(secondLaunchIntent(['electron', '.'], { hasWindow: false }, always), { kind: 'reopen' })
})

test('the install directory is never a project, whatever the working directory was', () => {
  // Exactly the argv Electron reports for a double-clicked icon on macOS: the
  // executable, the app path and `/` as the working directory.
  const argv = ['/Applications/Hanekawa.app/Contents/MacOS/Hanekawa', '/Applications/Hanekawa.app/Contents/Resources/app.asar', '/']
  assert.deepEqual(secondLaunchIntent(argv, { hasWindow: true }, always), { kind: 'focus' })
  assert.deepEqual(secondLaunchIntent(argv, { hasWindow: false }, always), { kind: 'reopen' })
})

test('an explicit --cwd= wins over an existing window', () => {
  assert.deepEqual(
    secondLaunchIntent(['--cwd=/w/two'], { hasWindow: true }, always),
    { kind: 'open', cwd: '/w/two' },
  )
})

test('the first --cwd= wins, so one launch never opens two projects', () => {
  assert.deepEqual(
    secondLaunchIntent(['--cwd=/w/one', '--cwd=/w/two'], { hasWindow: false }, always),
    { kind: 'open', cwd: '/w/one' },
  )
})