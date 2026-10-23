import assert from 'node:assert/strict'
import test from 'node:test'

import { BrowserHostError } from '../src/desktop/browser/errors.js'
import type { ElementScanResult, TextScanResult } from '../src/desktop/browser/inject/bundle.js'
import { BrowserProjection } from '../src/desktop/browser/projection.js'
import type { SnapshotOwner } from '../src/desktop/browser/snapshotCache.js'

/**
 * Scan → cache → encode → page, with the page itself replaced by a canned
 * answer.
 *
 * The point of the seam is right here: the projection never sees a
 * `WebContents`, so everything about how a scan becomes pages is checked in a
 * plain test process. Left untested is only whether a real page returns the
 * shape this test hands in.
 */

const owner: SnapshotOwner = { tabId: 'tab-1', contentsId: 5, generation: 2 }

function elementScan(rows: number, truncated = false): ElementScanResult {
  return {
    snapshotId: 'ignored',
    url: 'https://x.test/',
    title: 'X',
    rows: Array.from({ length: rows }, (_, index) => ({
      ref: `e${index + 1}`,
      role: 'link',
      name: `Row ${index + 1} ${'padding '.repeat(8)}`,
      visible: true,
    })),
    truncated,
    scanned: rows * 3,
  }
}

function evaluator(value: unknown): (script: string) => Promise<unknown> {
  return async () => ({ ok: true, value })
}

test('a long scan comes back paged, and the cursor walks it without rescanning', async () => {
  const projection = new BrowserProjection()
  let calls = 0
  const evaluate = async (): Promise<unknown> => {
    calls += 1
    return { ok: true, value: elementScan(400) }
  }

  const first = await projection.elements(owner, evaluate, {})
  assert.equal(first.total, 400)
  assert.ok(first.cursor !== undefined)
  assert.ok(first.text.includes('e1\tlink'))

  const second = projection.read(owner, first.cursor as string)
  assert.equal(calls, 1, 'paging must not ask the page again')
  assert.equal(second.snapshotId, first.snapshotId)
  assert.ok(!second.text.includes('\ne1\t'))
})

test('limit is a page size: the scan is not cut at it, and the cursor pages on by the same count', async () => {
  const projection = new BrowserProjection()
  let maxResults: unknown
  const evaluate = async (script: string): Promise<unknown> => {
    maxResults = /"maxResults":(\d+)/.exec(script)?.[1]
    return { ok: true, value: elementScan(25) }
  }
  const first = await projection.elements(owner, evaluate, { limit: 10 })
  assert.equal(maxResults, '2000', 'the scan runs to the hard cap, not to limit')
  assert.equal(first.scanTruncated, false)
  assert.equal(first.total, 25)
  assert.match(first.text, /\ne10\t/)
  assert.doesNotMatch(first.text, /\ne11\t/)
  assert.match(first.text, /# more: 15 remaining/)

  const second = projection.read(owner, first.cursor as string)
  assert.match(second.text, /\ne11\t/)
  assert.doesNotMatch(second.text, /\ne21\t/)
  const third = projection.read(owner, second.cursor as string)
  assert.match(third.text, /\ne25\t/)
  assert.equal(third.cursor, undefined)
})

test('a short scan is one page with no cursor', async () => {
  const projection = new BrowserProjection()
  const result = await projection.elements(owner, evaluator(elementScan(3)), {})
  assert.equal(result.cursor, undefined)
  assert.equal(result.total, 3)
})

test('a truncated scan says so where the model will read it', async () => {
  const projection = new BrowserProjection()
  const result = await projection.elements(owner, evaluator(elementScan(2, true)), {})
  assert.equal(result.scanTruncated, true)
  assert.match(result.text, /scanTruncated=true/)
  assert.match(result.text, /paging cannot reach it/)
})

test('a cursor does not survive a navigation', async () => {
  const projection = new BrowserProjection()
  const first = await projection.elements(owner, evaluator(elementScan(400)), {})
  assert.throws(
    () => projection.read({ ...owner, generation: owner.generation + 1 }, first.cursor as string),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'SNAPSHOT_EXPIRED',
  )
})

test('a closing tab drops its snapshots', async () => {
  const projection = new BrowserProjection()
  const first = await projection.elements(owner, evaluator(elementScan(400)), {})
  projection.dropTab(owner.tabId)
  assert.throws(
    () => projection.read(owner, first.cursor as string),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'SNAPSHOT_EXPIRED',
  )
})

test('text blocks page the same way, one kind-and-text row each', async () => {
  const scan: TextScanResult = {
    url: 'https://x.test/',
    title: 'X',
    blocks: Array.from({ length: 500 }, (_, index) => ({
      kind: 'text',
      text: `Paragraph ${index + 1} ${'word '.repeat(10)}`,
    })),
    truncated: false,
    scanned: 1500,
  }
  const projection = new BrowserProjection()
  const first = await projection.text(owner, evaluator(scan), {})
  assert.ok(first.cursor !== undefined)
  assert.match(first.text, /^# text {2}url=https:\/\/x\.test\/.*\nkind\ttext\ntext\tParagraph 1 word/)
  const second = projection.read(owner, first.cursor as string)
  assert.ok(second.text.includes('Paragraph '))
})

test('the page reporting a coded failure keeps the code', async () => {
  const projection = new BrowserProjection()
  const evaluate = async (): Promise<unknown> => ({ ok: false, message: 'INVALID_REQUEST: no element matches scope #x' })
  await assert.rejects(
    () => projection.elements(owner, evaluate, { scope: '#x' }),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'INVALID_REQUEST',
  )
})

test('an uncoded page failure is retryable rather than the caller’s fault', async () => {
  const projection = new BrowserProjection()
  const evaluate = async (): Promise<unknown> => ({ ok: false, message: 'Script failed to execute' })
  await assert.rejects(
    () => projection.elements(owner, evaluate, {}),
    (error: unknown) => error instanceof BrowserHostError && error.code === 'PAGE_NOT_READY' && error.retryable,
  )
})
