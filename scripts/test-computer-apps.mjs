#!/usr/bin/env node
import { app } from 'electron'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createTestEnvironment, onTestExit } from './test-environment.mjs'

const args = process.argv.slice(2)
const scenario = args.find(a => a.startsWith('--scenario='))?.slice(11) ?? 'all'
const evidenceDir = args.find(a => a.startsWith('--evidence-dir='))?.slice(15)
const repetitions = Number(args.find(a => a.startsWith('--repetitions='))?.slice(14) ?? 3)
// GUI windows can outlive a failed driver. Never remove their files at exit.
const environment = createTestEnvironment('hanekawa-computer-apps-', { keep: true })
const profile = join(environment.root, 'electron')
mkdirSync(profile)
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const repo = fileURLToPath(new URL('..', import.meta.url))
const report = { scope: 'real macOS apps; deterministic production Computer driver, no model/full Hanekawa UI',
  scenario, repetitions, electron: process.versions.electron, arch: process.arch, attempts: [] }
const owned = new Set()
const stopOwned = () => { for (const pid of owned) { try { process.kill(pid, 'SIGTERM') } catch {} } }
onTestExit(stopOwned)

async function until(read, predicate, description, timeoutMs = 10000) {
  const end = performance.now() + timeoutMs
  while (performance.now() < end) {
    const value = await read()
    if (predicate(value)) return value
    await delay(50)
  }
  throw new Error(`Timed out: ${description}`)
}
function rows(state) {
  return (state.text ?? '').split('\n').flatMap(line => {
    const match = line.match(/(s[a-f0-9-]{36}:e\d+) (AX\w+) ("(?:[^"\\]|\\.)*") value=("(?:[^"\\]|\\.)*")/)
    return match ? [{ ref: match[1], role: match[2], label: JSON.parse(match[3]), value: JSON.parse(match[4]), line }] : []
  })
}
function one(state, role, labels) {
  const matches = rows(state).filter(row => row.role === role && (!labels || labels.includes(row.label)))
  assert.equal(matches.length, 1, `Expected one ${role} ${labels ?? ''}; found ${matches.length}`)
  return matches[0]
}

app.whenReady().then(async () => {
  let host, current, lastState, finderWindow
  let exitCode = 0
  try {
    assert.ok(['all', 'calculator', 'textedit', 'finder'].includes(scenario))
    assert.ok(Number.isInteger(repetitions) && repetitions >= 1 && repetitions <= 5)
    assert.ok(args.every(a => /^--scenario=(all|calculator|textedit|finder)$|^--repetitions=[1-5]$|^--evidence-dir=.+$|^--interrupt-rename$/.test(a)))
    assert.ok(!args.includes('--interrupt-rename') || scenario === 'finder', '--interrupt-rename requires --scenario=finder')
    if (evidenceDir) mkdirSync(evidenceDir, {recursive:true})
    if (process.platform !== 'darwin') { report.status = 'blocked'; report.reason = 'macOS required'; exitCode = 77; return }
    const { DesktopComputerHost } = await import('../dist/desktop/computer/host.js')
    const { createComputerTool } = await import('../dist/tools/ComputerTool/ComputerTool.js')
    const helper = join(repo, 'dist/desktop/computer/native/hanekawa-computer')
    report.helperSha256 = createHash('sha256').update(readFileSync(helper)).digest('hex')
    report.os = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
    host = new DesktopComputerHost({ executable: helper })
    const tool = createComputerTool(host)
    const context = { cwd: environment.root, sessionId: 'real-apps', readFiles: new Set() }
    const call = async (input, expectedError) => {
      const result = await tool.execute({ ...input, timeoutMs: 15000 }, context)
      const payload = result.ok ? JSON.parse(result.content) : undefined
      if (current) {
        current.calls ??= []
        current.calls.push({ operation: input.operation, ok: result.ok, diagnostics: payload?.diagnostics ?? result.errorDetails?.diagnostics,
          ...(result.ok ? {} : { error: result.errorDetails }) })
      }
      if (expectedError) {
        assert.equal(result.ok, false, 'expected a rejected action')
        assert.equal(result.errorDetails?.code, expectedError, result.content)
        assert.equal(result.errorDetails?.disposition.delivery, 'not_delivered')
        return result
      }
      assert.equal(result.ok, true, result.content)
      if (payload.data?.text) lastState = payload.data
      return payload.data
    }
    report.permissions = await call({ operation: 'status' })
    if (!report.permissions.accessibility) { report.status = 'blocked'; report.reason = 'Accessibility required'; exitCode = 77; return }
    const launch = async (name, bundle, files = []) => {
      assert.ok(!(await call({ operation: 'list_apps' })).some(a => a.bundleId === bundle), `${name} is already running; leave user instances untouched`)
      execFileSync('/usr/bin/open', ['-n', '-a', `/System/Applications/${name}.app`, ...files, '--args', '-ApplePersistenceIgnoreState', 'YES'])
      const apps = await until(() => call({ operation: 'list_apps' }), apps => apps.some(a => a.bundleId === bundle), `${name} registration`)
      const matches = apps.filter(a => a.bundleId === bundle)
      assert.equal(matches.length, 1)
      owned.add(matches[0].processId)
      current.app = { bundleId: bundle, processId: matches[0].processId,
        version: execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', `/System/Applications/${name}.app/Contents/Info.plist`], { encoding: 'utf8' }).trim() }
      return call({ operation: 'bind', app: bundle })
    }
    const observe = (appId, windowId) => call({ operation: 'get_state', appId, ...(windowId ? { windowId } : {}), disableDiffing: true })
    const key = async (appId, windowId, key, ref) => {
      const state = await observe(appId, windowId)
      return call({ operation: 'press_key', appId, snapshotId: state.snapshotId, key, ...(ref ? { ref } : {}) })
    }
    const click = async (appId, windowId, role, labels) => {
      const state = await observe(appId, windowId)
      return call({ operation: 'click', appId, ref: one(state, role, labels).ref })
    }
    const stop = async binding => {
      await call({ operation: 'release', appId: binding.appId })
      process.kill(binding.processId, 'SIGTERM')
      await until(() => call({ operation: 'list_apps' }), apps => !apps.some(a => a.processId === binding.processId), 'owned application exit')
      owned.delete(binding.processId)
    }

    if (scenario === 'all' || scenario === 'calculator') for (let run = 1; run <= repetitions; run++) {
      current = { scenario: 'AX-01', run, status: 'running' }; report.attempts.push(current)
      const binding = await launch('Calculator', 'com.apple.calculator')
      const { appId, windowId } = binding
      for (const labels of [['全部清除', 'All Clear', '清除', 'Clear'], ['1'], ['2'], ['加', 'Add', '+'], ['3'], ['4'], ['等于', 'Equals', '=']])
        await click(appId, windowId, 'AXButton', labels)
      const result = await observe(appId, windowId)
      assert.ok(rows(result).some(row => row.role === 'AXStaticText' && row.value === '46'), '12 + 34 must equal 46 in AX')
      const shot = await host.run({ sessionId: context.sessionId, input: { operation: 'get_state', appId, windowId, includeScreenshot: true }, timeoutMs: 15000 })
      current.calls.push({ operation: 'get_state_with_screenshot', ok: true, diagnostics: shot.diagnostics })
      assert.ok(shot.image?.bytes.length)
      assert.equal(shot.envelope.data.processId, binding.processId)
      if (evidenceDir) writeFileSync(join(evidenceDir, `calculator-${run}.png`), shot.image.bytes)
      current.screenshot = { sha256: createHash('sha256').update(shot.image.bytes).digest('hex'), bytes: shot.image.bytes.length }
      current.axResult = '46'
      await stop(binding)
      current.status = 'passed'
      console.log(`[computer-apps] calculator ${run} passed (AX + captured PNG; visual result requires separate inspection)`)
    }

    if (scenario === 'all' || scenario === 'textedit') for (let run = 1; run <= repetitions; run++) {
      current = { scenario: 'TXT-01', run, status: 'running' }; report.attempts.push(current)
      const directory = join(environment.root, `textedit-${run}`)
      mkdirSync(directory)
      const seed = join(directory, 'seed.txt')
      writeFileSync(seed, '')
      let binding = await launch('TextEdit', 'com.apple.TextEdit', [seed])
      const { appId } = binding
      let state = await until(() => observe(appId), s => rows(s).some(r => r.role === 'AXTextArea'), 'TextEdit editor')
      const windowId = state.windowId
      const text = `中文 English 😀 e\u0301\nSecond line ${run}`
      await call({ operation: 'type_text', appId, snapshotId: state.snapshotId, ref: one(state, 'AXTextArea').ref, text })
      await key(appId, windowId, 'cmd+s')
      await until(() => readFile(seed, 'utf8'), value => value === text, 'saved UTF-8 bytes')
      await key(appId, windowId, 'cmd+w')
      // Environment preparation reopens exactly the generated document; no UI mutation bypass.
      execFileSync('/usr/bin/open', ['-a', '/System/Applications/TextEdit.app', seed])
      state = await until(() => observe(appId), s => rows(s).some(r => r.role === 'AXTextArea' && r.value === text), 'saved document reopened through AX')
      current.file = { bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(await readFile(seed)).digest('hex') }
      await stop(binding)
      current.status = 'passed'
      console.log(`[computer-apps] textedit ${run} passed`)
    }

    if (scenario === 'all' || scenario === 'finder') for (let run = 1; run <= repetitions; run++) {
      current = { scenario: 'FS-01', run, status: 'running' }; report.attempts.push(current)
      const directory = join(environment.root, `${basename(environment.root)}-finder-${run}`)
      mkdirSync(directory)
      execFileSync('/usr/bin/open', [directory])
      const binding = await call({ operation: 'bind', app: 'com.apple.finder' })
      current.app = { bundleId: 'com.apple.finder', processId: binding.processId,
        version: execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/System/Library/CoreServices/Finder.app/Contents/Info.plist'], { encoding: 'utf8' }).trim() }
      const { appId } = binding
      let state = await until(() => call({ operation: 'get_state', appId }), s => s.windows.some(w => w.title === basename(directory)), 'isolated Finder window')
      const windowId = state.windows.find(w => w.title === basename(directory)).id
      const name = `验证-${basename(environment.root).slice(-6)}-${run}`
      finderWindow = { appId, windowId, titles: [basename(directory), name] }
      await key(appId, windowId, 'cmd+shift+n')
      state = await observe(appId, windowId)
      const editors = state.windows.filter(w => w.role === 'AXTextField')
      assert.equal(editors.length, 1, 'Finder exposes exactly one top-level rename editor')
      const editorWindowId = editors[0].id
      finderWindow.editorWindowId = editorWindowId
      state = await observe(appId, editorWindowId)
      await call({ operation: 'click_at', appId, snapshotId: state.snapshotId, x: 0, y: 0 }, 'UNSUPPORTED')
      state = await observe(appId, editorWindowId)
      await call({ operation: 'type_text', appId, snapshotId: state.snapshotId, ref: one(state, 'AXTextField').ref, text: name })
      if (args.includes('--interrupt-rename')) throw new Error('Injected driver failure while the test rename editor is open')
      const obsolete = await observe(appId, editorWindowId)
      await key(appId, editorWindowId, 'return')
      await call({ operation: 'type_text', appId, snapshotId: obsolete.snapshotId, text: 'MUST_NOT_BE_TYPED' }, 'STALE_SNAPSHOT')
      await until(() => readdir(directory), names => names.length === 1 && names[0] === name, 'Finder folder creation/rename on disk')
      state = await call({ operation: 'wait_for', appId, windowId, waitMs: 3000,
        condition: { kind: 'element', state: 'present', labelIncludes: name } })
      assert.equal(state.wait.status, 'matched', 'renamed folder must reach the AX tree')
      assert.ok(rows(state).some(r => r.value.includes(name) || r.label.includes(name)), 'renamed folder visible in AX')
      await key(appId, windowId, 'cmd+down')
      state = await observe(appId, windowId)
      assert.equal(state.windows.find(w => w.id === windowId).title, name, 'opening the selected folder reaches the expected directory')
      await key(appId, windowId, 'cmd+w')
      const closed = await call({ operation: 'wait_for', appId, condition: { kind: 'window', state: 'absent', windowId }, waitMs: 1000 })
      assert.equal(closed.wait.status, 'matched', 'test window must close before its directory is removed')
      finderWindow = undefined
      await call({ operation: 'release', appId })
      current.status = 'passed'
      console.log(`[computer-apps] finder ${run} passed`)
    }
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.error = error?.stack ?? String(error)
    if (current) current.status = 'failed'
    report.failureProcessAlive = [...owned].map(pid => {
      try { process.kill(pid, 0); return { pid, alive: true } }
      catch { return { pid, alive: false } }
    })
    // Debug only control metadata; no arbitrary document/sidebar text is persisted.
    if (lastState) report.lastControls = rows(lastState).filter(r => ['AXTextArea', 'AXTextField', 'AXButton'].includes(r.role))
      .map(r => ({ role: r.role, label: r.label, writable: r.line.includes(' writable'), window: r.line.match(/windowId=w\d+/)?.[0] }))
    exitCode = 1
  } finally {
    let safeToRemove = true
    if (finderWindow) {
      try {
        let {appId, windowId, titles, editorWindowId} = finderWindow
        const run = async input => (await host.run({sessionId:'real-apps',input,timeoutMs:5000})).envelope.data
        let state
        try { state = await run({operation:'get_state',appId,windowId,disableDiffing:true}) }
        catch (error) {
          if (error.code !== 'SESSION_CLOSED') throw error
          const binding = await run({operation:'bind',app:'com.apple.finder'})
          appId = binding.appId
          // A lost helper cannot prove which live rename surface it owned.
          assert.ok(!binding.windows.some(w => w.role === 'AXTextField'), 'retain files while a rename editor remains unclaimed')
          const matches = binding.windows.filter(w => titles.includes(w.title))
          assert.equal(matches.length, 1, 'identify only the uniquely named test window')
          windowId = matches[0].id
          state = await run({operation:'get_state',appId,windowId,disableDiffing:true})
          editorWindowId = undefined
        }
        if (editorWindowId && state.windows.some(w => w.id === editorWindowId)) {
          const editor = await run({operation:'get_state',appId,windowId:editorWindowId,disableDiffing:true})
          await run({operation:'press_key',appId,snapshotId:editor.snapshotId,key:'escape'})
          state = await run({operation:'get_state',appId,windowId,disableDiffing:true})
        }
        assert.ok(state.windowId === windowId && titles.includes(state.windows.find(w => w.id === windowId)?.title))
        await run({operation:'press_key',appId,snapshotId:state.snapshotId,key:'cmd+w'})
        const closed = await run({operation:'wait_for',appId,condition:{kind:'window',state:'absent',windowId},waitMs:1000})
        assert.equal(closed.wait.status, 'matched')
      } catch (error) { report.windowCleanupError = String(error); safeToRemove = false; exitCode = 1 }
    }
    await host?.dispose()
    stopOwned()
    try {
      await until(async () => [...owned].every(pid => {
        try { process.kill(pid, 0); return false } catch (error) { return error.code === 'ESRCH' }
      }), stopped => stopped, 'owned application termination')
      report.ownedApplicationsReaped = true
    } catch (error) { report.processCleanupError = String(error); safeToRemove = false; exitCode = 1 }
    if (safeToRemove) {
      try { rmSync(environment.root, { recursive: true, force: true }); report.isolatedFilesRemoved = true }
      catch (error) { report.cleanupError = String(error); safeToRemove = false; exitCode = 1 }
    }
    if (!safeToRemove) report.retainedTestDirectory = environment.root
    environment.cleanup()
    if (exitCode === 1) report.status = 'failed'
    console.log(JSON.stringify(report, null, 2))
    app.exit(exitCode)
  }
})
