import assert from 'node:assert/strict'

// Focus and call counters are asynchronous telemetry, not fixture business state.
// Retain every other field so a stale ref still must leave both windows unchanged.
export function fixtureBusinessWindows(windows) {
  return Object.fromEntries(Object.entries(windows).map(([name, window]) => {
    const { focus, selectAllCalls, ...business } = window
    return [name, business]
  }))
}

function assertComplete(observation) {
  assert.equal(observation.complete, true, 'Native acceptance requires a complete observation')
  assert.equal(observation.truncated, false)
  assert.ok(observation.text.length <= 28_000, 'Native observation exceeds the product output budget')
  assert.ok(Number.isInteger(observation.revision) && observation.revision > 0)
  assert.match(observation.snapshotId, /^s[a-f0-9-]{36}$/)
}

function rows(observation) {
  const result = new Map()
  for (const line of observation.text.split('\n').slice(1)) {
    if (line === 'No AX tree changes.' || line.startsWith('- ')) continue
    const row = line.match(/^([+~] )?\s*(s[a-f0-9-]{36}):e(\d+)(?: \(from (s[a-f0-9-]{36}):e(\d+)\))? (AX.*)$/)
    assert.ok(row, `Unrecognized native AX row: ${line}`)
    assert.equal(row[2], observation.snapshotId, 'Rows must publish fresh snapshot refs')
    assert.equal(Boolean(row[1]), observation.mode === 'diff')
    const index = Number(row[3])
    assert.equal(result.has(index), false, 'Duplicate native AX index')
    result.set(index, row[6])
  }
  return result
}

export function assertCompleteFull(observation) {
  assertComplete(observation)
  assert.equal(observation.mode, 'full')
  assert.equal(observation.baseRevision, null)
  const result = rows(observation)
  assert.ok(result.size > 0, 'Complete full observation must contain AX rows')
  return result
}

export function restoreCompleteDiff(before, diff) {
  const restored = assertCompleteFull(before)
  assertComplete(diff)
  assert.equal(diff.mode, 'diff')
  assert.equal(diff.baseRevision, before.revision, 'Diff must name the published full baseline')
  assert.ok(diff.revision > before.revision)
  assert.notEqual(diff.snapshotId, before.snapshotId)
  // Remove every old source before writing any new index: moves can form cycles,
  // and same-index replacements can publish an addition before its removal.
  for (const line of diff.text.split('\n').slice(1)) {
    const old = line.match(/^- (s[a-f0-9-]{36}):e(\d+)$/) ?? line.match(/\(from (s[a-f0-9-]{36}):e(\d+)\)/)
    if (!old) {
      assert.equal(line.startsWith('- '), false, 'Malformed baseline removal')
      continue
    }
    assert.equal(old[1], before.snapshotId, 'Removal/move must reference the old snapshot')
    assert.ok(restored.has(Number(old[2])), 'Removal/move must reference an existing baseline row')
    restored.delete(Number(old[2]))
  }
  for (const [index, row] of rows(diff)) restored.set(index, row)
  return restored
}

export function assertRestoredDiff(before, diff, full) {
  assert.ok(full.revision > diff.revision)
  assert.notEqual(full.snapshotId, diff.snapshotId)
  assert.deepEqual(restoreCompleteDiff(before, diff), assertCompleteFull(full),
    'Applying native diff must reconstruct the independently refreshed full tree')
}

export function refFromCompleteDiff(before, diff, label, role) {
  const matches = [...restoreCompleteDiff(before, diff)]
    .filter(([, row]) => row.includes(label) && (!role || row.includes(role)))
  assert.equal(matches.length, 1, `Expected one restored AX ref for ${label}`)
  return `${diff.snapshotId}:e${matches[0][0]}`
}

export function assertTruncatedFull(observation) {
  assert.equal(observation.mode, 'full')
  assert.equal(observation.baseRevision, null)
  assert.equal(observation.truncated, true, 'Long-list fixture must exercise output truncation')
  assert.equal(observation.complete, false)
  assert.ok(observation.text.length <= 28_000)
  assert.match(observation.text, /Output truncated/)
}
