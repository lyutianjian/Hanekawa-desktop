import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeFixtureState, summarizeProcessSample } from '../scripts/computer-native-diagnostics.mjs'

const secret = 'MUST_NOT_LOG_INPUT_OR_SECURE_VALUE'

test('native failure diagnostics retain exact birth identity without image paths or input', () => {
  const sample = summarizeProcessSample({ pid: 41, bsdBytes: 136, kernelStatus: 2, sampleStable: true,
    kernelStartSeconds: '1793865000', kernelStartMicroseconds: '999999', appKitRegistered: false,
    executableMatch: true, executable: '/private/' + secret, text: secret, secureValue: secret })
  assert.deepEqual(sample, { pid: 41, bsdBytes: 136, kernelStatus: 2, sampleStable: true,
    executableMatch: true, appKitRegistered: false, kernelStartSeconds: '1793865000', kernelStartMicroseconds: '999999' })
  assert.doesNotMatch(JSON.stringify(sample), new RegExp(secret))
})

test('fixture failure reports selection and focus for both owned windows without their contents', () => {
  const state = summarizeFixtureState({ pid: 41, sampledAt: 1000, kernelExecutableMatches: true,
    windows: { A: { count: 2, text: '😀' + secret, sheetText: secret, secureLength: 31, secureValue: secret,
      selectAllCalls: 0, selection: { start: 30, length: 0, selectedText: secret },
      focus: { keyWindow: true, mainWindow: true, editable: true, refusesFocus: false, secure: false, body: secret } },
    B: { text: '', selection: { start: 0, length: 0 }, focus: { keyWindow: false, editable: false } },
    userWindow: { text: secret } } })
  const windows = state.windows as Record<string, Record<string, unknown>>
  assert.equal(windows.A!.textUnits, secret.length + 2)
  assert.equal(windows.A!.sheetTextUnits, secret.length)
  assert.deepEqual(windows.A!.selection, { start: 30, length: 0 })
  assert.deepEqual(windows.A!.focus, { keyWindow: true, mainWindow: true, editable: true, refusesFocus: false, secure: false })
  assert.deepEqual(windows.B!.selection, { start: 0, length: 0 })
  assert.equal(windows.userWindow, undefined)
  assert.doesNotMatch(JSON.stringify(state), /MUST_NOT_LOG|secureLength|secureValue|selectedText/)
})

test('shortcut evidence caps event history and retains routing facts without characters', () => {
  const state = summarizeFixtureState({ keyboardEvents: Array.from({ length: 20 }, (_, index) => ({
    type: 10, keyCode: 0, modifiers: 1048576, timestamp: index, charactersUnits: 2,
    ignoringModifiersUnits: 2, selectAllEquivalent: false, active: true, editableFocus: true,
    characters: secret, charactersIgnoringModifiers: secret,
  })), menuDiagnostics: { selectAllEnabled: true, modifiers: 1048576, targetIsEditable: true, title: secret } })
  const events = state.keyboardEvents as Record<string, unknown>[]
  assert.equal(events.length, 12)
  assert.equal(events[0]!.timestamp, 8)
  assert.equal(events[11]!.timestamp, 19)
  assert.equal(events[11]!.selectAllEquivalent, false)
  assert.deepEqual(state.menuDiagnostics, { selectAllEnabled: true, modifiers: 1048576, targetIsEditable: true })
  assert.doesNotMatch(JSON.stringify(state), new RegExp(secret))
})

test('diagnostic whitelist excludes malformed facts and represents missing evidence safely', () => {
  assert.deepEqual(summarizeProcessSample({ pid: secret, sampledAt: Infinity, bsdErrno: NaN,
    kernelStartSeconds: secret, kernelStartMicroseconds: '-1', kernelStatus: {}, appKitRegistered: true }),
  { appKitRegistered: true })
  const empty = summarizeFixtureState(undefined)
  assert.deepEqual(empty.windows, {})
  assert.deepEqual(empty.keyboardEvents, [])
  assert.deepEqual(empty.processIdentity, {})
})

test('increment callback evidence keeps bounded numeric facts only for owned fixture windows', () => {
  const state = summarizeFixtureState({ incrementEvents: { A: Array.from({ length: 20 }, (_, i) => ({
    count: i, timestamp: i / 10, currentEventType: 2, characters: secret, target: secret,
  })), B: [{ count: 1, timestamp: 2, currentEventType: 13, text: secret }], userWindow: [{ count: 9 }] } })
  const increments = state.incrementEvents as Record<string, Record<string, unknown>[]>
  assert.equal(increments.A!.length, 12)
  assert.deepEqual(increments.A![0], { count: 8, timestamp: 0.8, currentEventType: 2 })
  assert.deepEqual(increments.B, [{ count: 1, timestamp: 2, currentEventType: 13 }])
  assert.equal(increments.userWindow, undefined)
  assert.doesNotMatch(JSON.stringify(state), new RegExp(secret))
})
