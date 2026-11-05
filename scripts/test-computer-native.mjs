#!/usr/bin/env node
import { app } from 'electron'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createTestEnvironment, killTestProcess, onTestExit } from './test-environment.mjs'
import { assertCompleteFull, restoreCompleteDiff, assertRestoredDiff, refFromCompleteDiff, assertTruncatedFull, fixtureBusinessWindows } from './computer-native-observation.mjs'
import { summarizeFixtureState, summarizeProcessSample } from './computer-native-diagnostics.mjs'

const args = process.argv.slice(2)
const fixtureOnly = args.includes('--fixture-only')
const compactItems = Array.from({ length: 4 }, (_, i) => `item-${i}`)
const environment = createTestEnvironment('hanekawa-computer-native-')
const profile = join(environment.root, 'electron')
mkdirSync(profile)
app.setPath('userData', profile)
app.setPath('sessionData', profile)
const repo = fileURLToPath(new URL('..', import.meta.url))
const report = { scope: 'real native fixture + deterministic production Computer driver; no model task; no full Hanekawa UI',
  fixtureOnly, electron: process.versions.electron, arch: process.arch, checks: [] }
const passed = name => {
  report.checks.push({ name, status: 'passed' })
  console.log(`[computer-native] ${name}`)
}

async function until(read, predicate, description, timeoutMs = 5000) {
  const started = performance.now(), end = started + timeoutMs
  let polls = 0
  while (performance.now() < end) {
    const value = await read()
    polls += 1
    if (predicate(value)) return value
    await delay(25)
  }
  report.failedWait = { description, timeoutMs, polls, elapsedMs: Math.round(performance.now() - started) }
  throw new Error(`Timed out: ${description}`)
}

app.whenReady().then(async () => {
  let host
  let fixture
  let exitCode = 0
  let unregisterFixture
  let sampleFixture
  const statePath = join(environment.root, 'state.json')
  const state = async () => {
    try { return JSON.parse(await readFile(statePath, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
  }
  const stopFixture = async () => {
    if (!fixture) return
    const held = fixture
    if (held.child.exitCode === null && held.child.signalCode === null) {
      held.child.kill('SIGTERM')
      const timer = setTimeout(() => killTestProcess(held.child.pid), 1000)
      try { await held.exited } finally { clearTimeout(timer) }
    } else await held.exited
    unregisterFixture?.()
    fixture = undefined
  }
  try {
    assert.ok(args.every(arg => arg === '--fixture-only'), 'Only --fixture-only is accepted')
    if (process.platform !== 'darwin') {
      report.status = 'blocked'
      report.reason = 'Native fixture requires macOS'
      exitCode = 77
      return
    }
    const { DesktopComputerHost } = await import('../dist/desktop/computer/host.js')
    const { createComputerTool } = await import('../dist/tools/ComputerTool/ComputerTool.js')
    const helper = join(repo, 'dist/desktop/computer/native/hanekawa-computer')
    const source = join(repo, 'test/fixtures/computer/ComputerFixture.swift')
    const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
    report.helperSha256 = hash(helper)
    report.fixtureSha256 = hash(source)
    const identitySource = join(repo, 'native/computer/ProcessIdentity.swift')
    const sampleSource = join(repo, 'test/fixtures/computer/ProcessSample.swift')
    report.processIdentitySourceSha256 = hash(identitySource)
    report.processSampleSourceSha256 = hash(sampleSource)
    report.os = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim()
    host = new DesktopComputerHost({ executable: helper })
    const tool = createComputerTool(host)
    const context = { cwd: environment.root, sessionId: 'native-fixture', readFiles: new Set() }
    const execute = (input, signal) => tool.execute({ ...input, timeoutMs: 5000 },
      { ...context, ...(signal ? { abortSignal: signal } : {}) })
    const call = async input => {
      const result = await execute(input)
      if (!result.ok) report.failedCall = { operation: input.operation, errorDetails: result.errorDetails }
      assert.equal(result.ok, true, result.content)
      const envelope = JSON.parse(result.content)
      if (input.operation === 'press_key') report.lastKeyAction = envelope.diagnostics
      if (['click', 'click_at', 'press_key', 'type_text', 'set_value', 'select_text', 'perform_action', 'scroll'].includes(input.operation)) {
        report.lastAction = envelope.diagnostics
      }
      return envelope.data
    }
    report.permissions = await call({ operation: 'status' })
    passed('production Computer status')

    const bundleId = `com.hanekawa.computerfixture.r${randomUUID().replaceAll('-', '')}`
    const appPath = join(environment.root, 'Hanekawa Computer Fixture.app')
    const contents = join(appPath, 'Contents')
    const executable = join(contents, 'MacOS', 'ComputerFixture')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>Hanekawa Computer Fixture</string>
<key>CFBundleExecutable</key><string>ComputerFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>`)
    execFileSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-target',
      `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
      '-module-cache-path', join(environment.root, 'swift-cache'), source, identitySource, '-o', executable],
      { env: environment.env, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
    passed('compile isolated AppKit bundle')
    const sampler = join(environment.root, 'process-sample')
    execFileSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-target',
      `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx13.0`,
      '-module-cache-path', join(environment.root, 'swift-cache'), sampleSource, identitySource, '-o', sampler],
      { env: environment.env, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] })
    sampleFixture = () => summarizeProcessSample(JSON.parse(execFileSync(sampler, [String(fixture.child.pid), executable],
      { env: environment.env, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })))

    const launch = async () => {
      const child = spawn(executable, [statePath], { env: environment.env, detached: true, stdio: 'ignore' })
      let launchError
      child.on('error', error => { launchError = error })
      fixture = { child, exited: new Promise(resolve => child.once('close', resolve)) }
      unregisterFixture = onTestExit(() => killTestProcess(child.pid))
      const ready = await until(async () => {
        if (launchError) throw launchError
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('Fixture exited before readiness')
        return state()
      }, s => s?.ready && s.pid === child.pid, 'fixture readiness')
      assert.equal(ready.bundleId, bundleId)
      report.processSamples ??= []
      const processSample = sampleFixture()
      report.processSamples.push(processSample)
      assert.equal(processSample.executableMatch, true, 'independent kernel image must be the owned fixture')
      assert.equal(processSample.sampleStable, true, 'independent kernel birth sample must be complete')
      for (const name of ['A', 'B']) {
        assert.equal(ready.windows[name].visible, true)
        assert.equal(ready.windows[name].count, 0)
        assert.equal(ready.windows[name].text, '')
        assert.deepEqual(ready.windows[name].items, compactItems)
        assert.equal(ready.windows[name].secureLength, 'FIXTURE_SECRET_DO_NOT_LOG_9X'.length)
        assert.equal(ready.windows[name].pendingSheet, false)
        assert.equal(ready.windows[name].sheetVisible, false)
        assert.deepEqual(ready.windows[name].controls, ['busy', 'close', 'compact', 'delay', 'increment', 'insert', 'long', 'move', 'replace', 'reverse', 'sheet'])
      }
      await until(() => call({ operation: 'list_apps' }), apps => apps.some(a => a.bundleId === bundleId && a.processId === child.pid),
        'fixture registration in production app discovery')
      return ready
    }
    await launch()
    passed('launch two real AppKit windows and independently inspect initial controls')

    if (fixtureOnly) {
      await stopFixture()
      await launch()
      passed('restart fixture with clean state')
      report.status = 'fixture_only_passed'
      report.skipped = 'All production AX actions deliberately skipped by --fixture-only'
      return
    }
    if (!report.permissions.accessibility) {
      const denied = await execute({ operation: 'bind', app: bundleId })
      assert.equal(denied.ok, false)
      assert.equal(denied.errorDetails?.code, 'PERMISSION_REQUIRED')
      assert.equal(denied.errorDetails?.disposition.delivery, 'not_delivered')
      passed('missing Accessibility rejected through production tool without input')
      report.status = 'blocked'
      report.reason = 'Accessibility not granted to this Electron execution chain; real AX actions skipped'
      exitCode = 77
      return
    }

    // From here every UI mutation goes through the production tool and helper.
    const bound = await call({ operation: 'bind', app: bundleId })
    assert.equal(bound.snapshotId, undefined, 'Multiple windows require explicit selection')
    const fixtureWindows = binding => {
      const a = binding.windows.find(w => w.title.endsWith('— A'))
      const b = binding.windows.find(w => w.title.endsWith('— B'))
      assert.ok(a && b)
      report.windowSelections ??= []
      report.windowSelections.push({ appId: binding.appId, a: a.id, b: b.id })
      return { a, b }
    }
    let { a } = fixtureWindows(bound)
    let appId = bound.appId
    const observe = async () => {
      const current = await call({ operation: 'get_state', appId, windowId: a.id, disableDiffing: true })
      assert.equal(current.mode, 'full')
      assert.equal(current.baseRevision, null)
      assert.ok(Number.isInteger(current.revision) && current.revision > 0)
      return current
    }
    const observeComplete = async () => {
      const current = await observe()
      assertCompleteFull(current)
      return current
    }
    const ref = (s, label, role) => {
      const matches = s.text.split('\n').filter(line => line.includes(label) && (!role || line.includes(role)))
        .map(line => line.match(/s[a-f0-9-]{36}:e[0-9]+/)?.[0]).filter(Boolean)
      assert.equal(matches.length, 1, `Expected one AX ref for ${label}`)
      return matches[0]
    }
    const click = async label => {
      const current = await observe()
      const after = await call({ operation: 'click', appId, ref: ref(current, label, 'AXButton') })
      assert.ok(after.revision > current.revision)
      if (current.complete && after.complete) {
        assert.equal(after.mode, 'diff')
        assert.equal(after.baseRevision, current.revision)
      }
      return after
    }
    const rejectOldRef = async oldRef => {
      const before = await state()
      const stale = await execute({ operation: 'click', appId, ref: oldRef })
      assert.equal(stale.ok, false)
      assert.equal(stale.errorDetails?.code, 'STALE_SNAPSHOT')
      assert.equal(stale.errorDetails?.disposition.delivery, 'not_delivered')
      assert.deepEqual(fixtureBusinessWindows((await state()).windows), fixtureBusinessWindows(before.windows),
        'Old refs must not mutate either fixture window business state')
      // Even a refused action consumes the current snapshot; observe again before input.
    }
    const initial = await observeComplete()
    const unchanged = await call({ operation: 'get_state', appId, windowId: a.id })
    assert.deepEqual(restoreCompleteDiff(initial, unchanged), assertCompleteFull(initial))
    assert.match(unchanged.text, /No AX tree changes\./)
    passed('complete native full and unchanged diff declare the published baseline revision')
    const unchangedRef = refFromCompleteDiff(initial, unchanged, 'Increment', 'AXButton')
    const refreshed = await observeComplete()
    assert.notEqual(refreshed.snapshotId, initial.snapshotId)
    assertRestoredDiff(initial, unchanged, refreshed)
    await rejectOldRef(unchangedRef)
    passed('full refresh reconstructs unchanged diff and rejects the previous snapshot ref')
    const secure = await observeComplete()
    assert.match(secure.text, /\[secure field\]/)
    assert.match(secure.text, /\[redacted\]/)
    assert.doesNotMatch(secure.text, /FIXTURE_SECRET_DO_NOT_LOG_9X/)
    passed('secure input redaction')
    const oldRef = ref(secure, 'Increment', 'AXButton')
    const incremented = await call({ operation: 'click', appId, ref: oldRef })
    await until(state, s => s.windows.A.count === 1 && s.windows.B.count === 0, 'only window A increments')
    assertRestoredDiff(secure, incremented, await observeComplete())
    await rejectOldRef(oldRef)
    passed('selected-window value change reconstructs full tree and refuses old reference')

    const verifyChange = async (label, expected, predicate, staleLabel = label) => {
      const before = await observeComplete()
      const after = await call({ operation: 'click', appId, ref: ref(before, label, 'AXButton') })
      await until(state, predicate, label)
      assertRestoredDiff(before, after, await observeComplete())
      const actual = await state()
      assert.deepEqual(actual.windows.A.items, expected)
      assert.deepEqual(actual.windows.B.items, compactItems)
      assert.equal(actual.windows.B.count, 0)
      assert.equal(actual.windows.B.generation, 0)
      await rejectOldRef(ref(before, staleLabel, 'AXButton'))
      passed(`${label}: complete diff reconstructs fresh full and old ref is refused`)
    }
    const insertedItems = ['inserted-1', ...compactItems]
    await verifyChange('Insert row', insertedItems, s => s.windows.A.items[0] === 'inserted-1')
    const reversedItems = [...insertedItems].reverse()
    await verifyChange('Reverse rows', reversedItems, s => s.windows.A.items.at(-1) === 'inserted-1')
    await verifyChange('Replace control', reversedItems, s => s.windows.A.generation === 1, 'Increment')
    await verifyChange('Increment', reversedItems, s => s.windows.A.count === 2)

    // Keep the original 80-row stress case separate from mandatory complete diffs.
    const beforeLongList = await observeComplete()
    await call({ operation: 'click', appId, ref: ref(beforeLongList, 'Long list', 'AXButton') })
    const expanded = await until(state, s => s.windows.A.items.length === 80, 'long list')
    assert.deepEqual(expanded.windows.B.items, compactItems)
    const longList = await call({ operation: 'get_state', appId, windowId: a.id, disableDiffing: true })
    assertTruncatedFull(longList)
    assert.match(longList.text, /:e\d+ AXTable /, 'Truncation must retain the table subtree entry')
    ref(longList, 'Increment', 'AXButton')
    const withoutBaseline = await call({ operation: 'get_state', appId, windowId: a.id })
    assertTruncatedFull(withoutBaseline)
    const reset = await call({ operation: 'click', appId, ref: ref(withoutBaseline, 'Reset compact list', 'AXButton') })
    assertCompleteFull(reset)
    const compact = await until(state, s => s.windows.A.items.length === compactItems.length, 'reset compact list')
    assert.deepEqual(compact.windows.A.items, compactItems)
    assert.deepEqual(compact.windows.B.items, compactItems)
    assert.equal(compact.windows.A.count, 2)
    assert.equal(compact.windows.A.generation, 1)
    const recoveredDiff = await call({ operation: 'get_state', appId, windowId: a.id })
    assertRestoredDiff(reset, recoveredDiff, await observeComplete())
    passed('long list truncates within 28000 characters, retains shallow refs, clears baseline and recovers complete full/diff')

    const mixed = '中文 English 😀 e\u0301\nSecond line'
    const editor = await observe()
    await call({ operation: 'set_value', appId, ref: ref(editor, 'Editable text', 'AXTextArea'), value: mixed })
    await until(state, s => s.windows.A.text === mixed && s.windows.B.text === '', 'mixed Unicode AXValue readback')
    passed('mixed Unicode multiline AXValue independently read back')
    const selected = await observe()
    const selectedResult = await call({ operation: 'select_text', appId, ref: ref(selected, 'Editable text', 'AXTextArea'), selection: { text: 'English', prefix: '中文 ', suffix: ' 😀' } })
    await until(state, s => s.windows.A.selection.start === 3 && s.windows.A.selection.length === 7 && s.windows.B.text === '', 'exact contextual text selection')
    assert.match(selectedResult.text, /selectedTextRange=/)
    const ambiguousText = await observe()
    await call({ operation: 'set_value', appId, ref: ref(ambiguousText, 'Editable text', 'AXTextArea'), value: 'same / same' })
    const beforeAmbiguous = await observe()
    const ambiguous = await execute({ operation: 'select_text', appId, ref: ref(beforeAmbiguous, 'Editable text', 'AXTextArea'), selection: { text: 'same' } })
    assert.equal(ambiguous.errorDetails?.code, 'INVALID_INPUT')
    assert.equal((await state()).windows.A.text, 'same / same')
    passed('AX text selection with adjacent context; ambiguous text refused without content change')
    // Distinguish setting AXValue from actual Unicode keyboard event delivery.
    const beforeTyping = await observe()
    await call({ operation: 'set_value', appId, ref: ref(beforeTyping, 'Editable text', 'AXTextArea'), value: '' })
    const keyboardState = await observe()
    await call({ operation: 'type_text', appId, snapshotId: keyboardState.snapshotId,
      ref: ref(keyboardState, 'Editable text', 'AXTextArea'), text: mixed })
    await until(state, s => s.windows.A.text === mixed && s.windows.B.text === '', 'Unicode key events preserve mixed text and target window')
    const replaceState = await observe()
    await call({ operation: 'select_text', appId, ref: ref(replaceState, 'Editable text', 'AXTextArea'), selection: { text: 'English' } })
    const replaceInput = await observe()
    await call({ operation: 'type_text', appId, snapshotId: replaceInput.snapshotId,
      ref: ref(replaceInput, 'Editable text', 'AXTextArea'), text: '替换👩🏽‍💻' })
    const replaced = mixed.replace('English', '替换👩🏽‍💻')
    await until(state, s => s.windows.A.text === replaced && s.windows.B.text === '', 'keyboard replacement preserves surrounding text')
    const shortcut = await observe()
    report.shortcutBefore = summarizeFixtureState(await state())
    await call({ operation: 'press_key', appId, snapshotId: shortcut.snapshotId,
      ref: ref(shortcut, 'Editable text', 'AXTextArea'), key: 'cmd+a' })
    const shortcutAfter = await until(state, s => s.windows.A.selection.start === 0 && s.windows.A.selection.length === replaced.length, 'explicit keyboard shortcut selection')
    report.shortcutAfter = summarizeFixtureState(shortcutAfter)
    const refusalState = await observe()
    const refused = await execute({ operation: 'type_text', appId, snapshotId: refusalState.snapshotId,
      ref: ref(refusalState, 'Refuses keyboard focus', 'AXTextArea'), text: 'MUST_NOT_BE_TYPED' })
    assert.equal(refused.ok, false)
    assert.equal(refused.errorDetails?.code, 'TARGET_CHANGED', refused.content)
    const afterRefusal = await state()
    assert.equal(afterRefusal.windows.A.text, replaced)
    assert.equal(afterRefusal.windows.A.refusesFocusText, '')
    assert.equal(afterRefusal.windows.B.text, '')
    passed('Unicode keyboard input, selected text replacement, shortcut and ignored AX focus independently checked')
    // A detected focus mismatch invalidates the binding; reacquire it explicitly.
    const liveBinding = await call({ operation: 'bind', app: bundleId })
    appId = liveBinding.appId
    a = fixtureWindows(liveBinding).a

    const emojiText = '👨‍👩‍👧‍👦'.repeat(200)
    const beforeEmoji = await observe()
    const afterEmoji = await call({ operation: 'set_value', appId, ref: ref(beforeEmoji, 'Editable text', 'AXTextArea'), value: emojiText })
    assert.ok(afterEmoji.snapshotId, 'AX output must stay within the UTF-16 protocol budget')
    await until(state, s => s.windows.A.text === emojiText && s.windows.B.text === '', 'long emoji input retained in the control')
    passed('emoji-rich AX output stays bounded without truncating actual input')
    await click('Delayed update')
    const delayed = await call({ operation: 'wait_for', appId, windowId: a.id, waitMs: 2000,
      condition: { kind: 'element', state: 'present', valueIncludes: 'Delayed: 1' } })
    assert.equal(delayed.wait.status, 'matched')
    await until(state, s => s.windows.A.delayedCount === 1 && !s.windows.A.pendingDelay, 'delayed business update')
    passed('production wait_for observes delayed update, independently checked')

    const timedOut = await call({ operation: 'wait_for', appId, windowId: a.id, waitMs: 250,
      condition: { kind: 'element', state: 'present', labelIncludes: 'FIXTURE_NEVER_APPEARS' } })
    assert.equal(timedOut.wait.status, 'timed_out')
    assert.ok(timedOut.snapshotId)
    passed('unsatisfied wait_for returns local timeout and last snapshot')

    await click('Show sheet')
    const sheet = await call({ operation: 'wait_for', appId, windowId: a.id, waitMs: 2000,
      condition: { kind: 'element', state: 'present', valueIncludes: 'Fixture sheet' } })
    assert.equal(sheet.wait.status, 'matched')
    await until(state, s => s.windows.A.sheetVisible && !s.windows.A.pendingSheet, 'async sheet appeared')
    await click('Dismiss fixture sheet')
    await until(state, s => !s.windows.A.sheetVisible, 'sheet dismissed')
    passed('production wait_for observes asynchronous sheet, independently checked')

    const application = await call({ operation: 'get_state', appId, scope: 'application', disableDiffing: true })
    assert.equal(application.windowId, undefined)
    assert.equal(application.boundsInPoints, undefined)
    assert.match(application.text, /Fixture tests/)
    assert.doesNotMatch(application.text, /FIXTURE_SECRET_DO_NOT_LOG_9X/)
    await call({ operation: 'click', appId, ref: ref(application, 'Fixture tests', 'AXMenuBarItem') })
    const menu = await call({ operation: 'get_state', appId, scope: 'application', disableDiffing: true })
    await call({ operation: 'click', appId, ref: ref(menu, 'Show sheet in A', 'AXMenuItem') })
    const menuSheet = await call({ operation: 'wait_for', appId, scope: 'application', waitMs: 2000,
      condition: { kind: 'element', state: 'present', labelIncludes: 'Fixture sheet input' } })
    assert.equal(menuSheet.wait.status, 'matched')
    const sheetState = await observe()
    await call({ operation: 'set_value', appId, ref: ref(sheetState, 'Fixture sheet input', 'AXTextField'), value: '菜单对话框测试 😀' })
    await click('Confirm fixture sheet')
    await until(state, s => s.windows.A.sheetText === '菜单对话框测试 😀' && !s.windows.A.sheetVisible && s.windows.B.sheetText === '', 'menu -> sheet -> text -> confirmation in window A only')
    passed('production application/menu scope -> sheet text -> explicit confirmation chain')

    if (report.permissions.screenRecording && report.permissions.screenshotSupported) {
      // Read-only image evidence goes through the production host. This is not
      // an attachment-store or model vision test; input still uses ComputerTool.
      const combined = await host.run({ sessionId: context.sessionId, input: { operation: 'get_state', appId, windowId: a.id, includeScreenshot: true }, timeoutMs: 5000 })
      const current = combined.envelope.data
      assert.ok(combined.image?.bytes.length)
      assert.equal(current.atomic, false)
      assert.ok(current.screenshot.revision < current.revision)
      assert.ok(current.screenshot.sampledAt <= current.sampledAt)
      assert.doesNotMatch(JSON.stringify(combined.envelope), /"png"|base64/)
      const row = current.text.split('\n').find(line => line.includes('AXButton') && line.includes('Increment'))
      const control = JSON.parse(row.match(/bounds=(\{.*\})$/)[1])
      const origin = current.boundsInPoints
      const pixels = current.imageSizeInPixels
      const imageX = (control.x + control.width / 2 - origin.x) * pixels.width / origin.width
      const imageY = (control.y + control.height / 2 - origin.y) * pixels.height / origin.height
      const beforeClickState = await state()
      const beforeClick = beforeClickState.windows.A.count
      report.coordinateClick = { control, origin, pixels, imageX, imageY,
        x: imageX * origin.width / pixels.width, y: imageY * origin.height / pixels.height,
        before: summarizeFixtureState(beforeClickState) }
      await call({ operation: 'click_at', appId, snapshotId: current.snapshotId,
        x: imageX * origin.width / pixels.width, y: imageY * origin.height / pixels.height })
      const afterClickState = await until(state, s => s.windows.A.count === beforeClick + 1 && s.windows.B.count === 0, 'combined screenshot pixel-to-point click targets only window A')
      report.coordinateClick.after = summarizeFixtureState(afterClickState)
      passed('native combined AX/PNG provenance and pixel-to-point coordinate click (not model vision/attachment resizing)')
    } else {
      report.unverified ??= []
      report.unverified.push('Combined native screenshot/coordinate path unavailable under current screen permission/OS')
    }

    const abort = new AbortController()
    const busyState = await observe()
    const pending = execute({ operation: 'click', appId, ref: ref(busyState, 'Block AX for two seconds', 'AXButton') }, abort.signal)
    await until(state, s => s.windows.A.busy, 'AX stall started')
    abort.abort()
    const cancelled = await pending
    assert.equal(cancelled.errorCode, 'aborted')
    assert.notEqual(cancelled.errorDetails?.disposition.delivery, 'not_delivered')
    const dead = await execute({ operation: 'get_state', appId })
    assert.equal(dead.errorDetails?.code, 'SESSION_CLOSED')
    await until(state, s => !s.windows.A.busy, 'fixture recovers from deliberate stall')
    passed('active cancellation drops binding without retry')

    const rebound = await call({ operation: 'bind', app: bundleId })
    await stopFixture()
    await launch()
    const obsolete = await execute({ operation: 'get_state', appId: rebound.appId })
    assert.equal(obsolete.errorDetails?.code, 'TARGET_CHANGED')
    const fresh = await call({ operation: 'bind', app: bundleId })
    assert.notEqual(fresh.appId, rebound.appId)
    passed('app restart rejects old binding and allows fresh bind')
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.error = error?.stack ?? String(error)
    if (error?.stderr) report.compilerError = String(error.stderr)
    const last = await state()
    if (last) report.failureState = summarizeFixtureState(last)
    if (fixture) {
      report.failureProcess = { pid: fixture.child.pid, exitCode: fixture.child.exitCode, signalCode: fixture.child.signalCode }
      try { if (sampleFixture) report.failureProcess.sample = sampleFixture() }
      catch (sampleError) { report.processSampleError = String(sampleError) }
    }
    exitCode = 1
  } finally {
    try { await host?.dispose() }
    catch (error) { report.hostCleanupError = String(error); exitCode = 1 }
    const hadFixture = Boolean(fixture)
    try { await stopFixture(); if (hadFixture) passed('owned fixture process reaped') }
    catch (error) { report.fixtureCleanupError = String(error); exitCode = 1 }
    const cleanupError = environment.cleanup()
    if (cleanupError) { report.directoryCleanupError = cleanupError; exitCode = 1 }
    else passed('isolated files removed')
    if (exitCode === 1) report.status = 'failed'
    console.log(JSON.stringify(report, null, 2))
    app.exit(exitCode)
  }
})
