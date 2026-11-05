import assert from 'node:assert/strict'

// Harness-only OR across two exact production matchers. Never replay an action.
export async function waitForFinderName(call, { appId, windowId, name }, evidence, now = () => performance.now()) {
  const start = now()
  evidence.budgetMs = 3000
  evidence.attempts = []
  const wait = async (field, waitMs) => {
    const attempt = { field, waitMs }
    evidence.attempts.push(attempt)
    let state
    try {
      state = await call({ operation: 'wait_for', appId, windowId, waitMs,
        condition: { kind: 'element', state: 'present', [field]: name } })
    } catch (error) {
      attempt.failed = true
      throw error
    }
    Object.assign(attempt, { status: state.wait.status, elapsedMs: state.wait.elapsedMs,
      complete: state.complete === true, truncated: state.truncated === true })
    return state
  }
  const label = await wait('labelIncludes', 1500)
  if (label.wait.status !== 'timed_out') return label
  // Account for native read/queue overhead; do not renew the original budget.
  evidence.remainingMsBeforeValue = Math.max(0, Math.floor(evidence.budgetMs - (now() - start)))
  const waitMs = Math.min(1500, evidence.remainingMsBeforeValue)
  if (waitMs < 100) { // Production schema's minimum, never rounded up.
    evidence.valueWaitSkippedForBudget = true
    return label
  }
  return wait('valueIncludes', waitMs)
}

// Shared real-app harness parser: only published rows, with owning-window metadata.
export function computerRows(state) {
  return (state.text ?? '').split('\n').flatMap(line => {
    const match = line.match(/(s[a-f0-9-]{36}:e\d+) (AX\w+) ("(?:[^"\\]|\\.)*") value=("(?:[^"\\]|\\.)*")/)
    if (!match) return []
    const metadata = line.slice(match.index + match[0].length)
    return [{ ref: match[1], role: match[2], label: JSON.parse(match[3]), value: JSON.parse(match[4]), line,
      windowId: metadata.match(/(?:^| )windowId=(w[1-9]\d*)(?: |$)/)?.[1] }]
  })
}

// Only rows matching this run's generated name contribute; retain no AX text.
export function finderNameMatches(rows, name) {
  const labels = rows.filter(row => row.label.includes(name))
  const values = rows.filter(row => row.value.includes(name))
  return { labelMatches: labels.length, valueMatches: values.length,
    roles: [...new Set([...labels, ...values].map(row => row.role))].map(role => ({ role,
      labelMatches: labels.filter(row => row.role === role).length,
      valueMatches: values.filter(row => row.role === role).length })) }
}

function finderTarget(state, { appId, windowId, name }, evidence, kind) {
  const parsed = computerRows(state)
  const candidates = parsed.filter(row => row.label.includes(name) || row.value.includes(name))
  const summary = evidence[kind] = { complete: state.complete === true, truncated: state.truncated === true,
    full: state.mode === 'full', appMatches: state.appId === appId,
    windowMatches: state.scope === 'window' && state.windowId === windowId && candidates.every(row => row.windowId === windowId),
    candidateCount: candidates.length, ...finderNameMatches(parsed, name) }
  assert.equal(summary.appMatches, true, `Finder ${kind} must belong to the bound app`)
  assert.equal(summary.windowMatches, true, `Finder ${kind} and target must belong to the selected window`)
  assert.equal(summary.full, true, `Finder ${kind} requires full mode`)
  assert.equal(state.baseRevision, null, `Finder ${kind} must not be a diff baseline`)
  if (kind === 'targetSubtree') {
    assert.equal(state.complete, true, 'Finder targetSubtree must be complete')
    assert.equal(state.truncated, false, 'Finder targetSubtree must not be truncated')
  }
  assert.equal(candidates.length, 1, `Finder ${kind} requires exactly one visible generated-name candidate; missing or ambiguous evidence`)
  const target = candidates[0]
  assert.ok(target.ref.startsWith(`${state.snapshotId}:e`), `Finder ${kind} target ref must be published in this observation`)
  return target
}

// A truncated window can supply positive evidence, never evidence of absence.
export async function observeFinderName(call, { appId, windowId, name }, evidence) {
  const windowObservation = await call({ operation: 'get_state', appId, windowId, disableDiffing: true })
  const target = finderTarget(windowObservation, { appId, windowId, name }, evidence, 'windowObservation')
  const targetSubtree = await call({ operation: 'get_state', appId, windowId, rootRef: target.ref, disableDiffing: true })
  finderTarget(targetSubtree, { appId, windowId, name }, evidence, 'targetSubtree')
  return targetSubtree
}
