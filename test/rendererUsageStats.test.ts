import test from 'node:test'
import assert from 'node:assert/strict'
import { computeUsageStats } from '../src/desktop/renderer/model/usageStats.js'
import type { WireUsageDay } from '../src/desktop/shellProtocol.js'

const now = new Date(2026, 9, 11, 12) // Sunday

function day(date: string, over: Partial<WireUsageDay> & { hour?: number } = {}): WireUsageDay {
  const hours = new Array<number>(24).fill(0)
  const turns = over.turns ?? 2
  hours[over.hour ?? 10] = turns
  return { day: date, sessions: 1, turns, tokens: 1000, hours, models: { a: 1000 }, ...over }
}

test('empty data gives zeros, no peak, no model and an all-zero heatmap', () => {
  const stats = computeUsageStats([], 'all', now)
  assert.deepEqual(
    [stats.sessions, stats.messages, stats.tokens, stats.activeDays, stats.books],
    [0, 0, 0, 0, 0],
  )
  assert.equal(stats.peakHour, null)
  assert.equal(stats.topModel, null)
  assert.deepEqual(stats.modelShares, [])
  assert.equal(stats.heatmap.length, 26)
  assert.ok(stats.heatmap.flat().every((cell) => cell === null || cell.level === 0))
})

test('range cut-offs include today and the 6 or 29 days before it', () => {
  const days = [day('2026-09-11'), day('2026-09-12'), day('2026-10-04'), day('2026-10-05'), day('2026-10-11')]
  assert.equal(computeUsageStats(days, 'all', now).activeDays, 5)
  assert.equal(computeUsageStats(days, '30d', now).activeDays, 4)
  assert.equal(computeUsageStats(days, '7d', now).activeDays, 2)
  assert.equal(computeUsageStats(days, '7d', now).sessions, 2)
  assert.equal(computeUsageStats(days, '7d', now).messages, 4)
})

test('peak hour is the busiest hour and the earliest wins a tie', () => {
  const days = [day('2026-10-10', { hour: 15, turns: 3 }), day('2026-10-11', { hour: 9, turns: 3 })]
  assert.equal(computeUsageStats(days, 'all', now).peakHour, 9)
  days.push(day('2026-10-09', { hour: 20, turns: 4 }))
  assert.equal(computeUsageStats(days, 'all', now).peakHour, 20)
})

test('top model and shares follow tokens, ties broken by name', () => {
  const days = [day('2026-10-10', { tokens: 300, models: { b: 100, a: 100, c: 100 } })]
  const stats = computeUsageStats(days, 'all', now)
  assert.equal(stats.topModel, 'a')
  assert.deepEqual(stats.modelShares.map((entry) => entry.model), ['a', 'b', 'c'])
  assert.ok(Math.abs(stats.modelShares[0]!.share - 1 / 3) < 1e-9)
})

test('books convert tokens to one decimal', () => {
  assert.equal(computeUsageStats([day('2026-10-10', { tokens: 1_000_000 })], 'all', now).books, 2.5)
})

test('heatmap lays weeks out Sunday-first, nulls the future and scales levels to the busiest day', () => {
  const days = [day('2026-10-11', { turns: 8 }), day('2026-10-10', { turns: 1 })]
  const heatmap = computeUsageStats(days, '7d', now).heatmap
  assert.equal(heatmap.length, 2)
  const last = heatmap[1]!
  assert.equal(last[0]!.day, '2026-10-11')
  assert.equal(last[0]!.level, 4)
  assert.equal(last[1], null)
  assert.equal(heatmap[0]![6]!.day, '2026-10-10')
  assert.equal(heatmap[0]![6]!.level, 1)
})
