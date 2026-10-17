import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createStatusView } from '../src/desktop/renderer/dom/statusView.js'
import type { SessionControllerSnapshot } from '../src/runtime/sessionController.js'
import type { TokenUsage } from '../src/harness/types.js'

/**
 * The status strip's token readout, and the hover card that carries the split.
 *
 * The card is the point of this file: the breakdown used to ride the `title`
 * attribute, which the OS draws about a second late and in its own colours —
 * the one surface in the window the stylesheet does not reach.
 */

function mount(t: { after(fn: () => void): void }): {
  stub: DomStub
  usage: HTMLElement
  view: () => StubView
  render: (total: TokenUsage | undefined) => void
} {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const usage = stub.createContainer('status-usage')
  const status = createStatusView({ usage })
  return {
    stub,
    usage,
    view: () => stub.inspect(usage),
    render(total) {
      status.render({ usage: { total, lastRequest: total } } as unknown as SessionControllerSnapshot)
    },
  }
}

const TOTAL = { inputTokens: 12_400, cacheReadInputTokens: 88_100, outputTokens: 3_200 }

const card = (view: StubView): StubView | undefined =>
  view.children.find((child) => child.classes.includes('hover-card'))

test('the token split is drawn by the renderer, not handed to the OS tooltip', (t) => {
  const r = mount(t)
  r.render(TOTAL)

  assert.equal((r.usage as unknown as { title: string }).title, '', 'a `title` here is the OS bubble')
  const tooltip = card(r.view())
  assert.ok(tooltip, 'the readout draws its own hover card')
  assert.equal(tooltip.attributes.get('role'), 'tooltip')
  // The figures reach a screen reader through the readout's name, which is what
  // lets the card itself be decoration.
  assert.match(r.view().attributes.get('aria-label') ?? '', /88,100/)
  assert.match(tooltip.text, /缓存命中/)
  assert.match(tooltip.text, /88,100/)
  assert.match(tooltip.text, /会话累计命中/)
})

test('the card opens on hover and closes on Escape, with no wait', (t) => {
  const r = mount(t)
  r.render(TOTAL)
  // `inert`, not `hidden`: the card is still mounted while it animates out, and
  // this is the flag that flips on the same tick as the intent.
  const open = (): boolean => !card(r.view())!.attributes.has('inert')
  assert.equal(open(), false, 'nothing is open before the pointer arrives')

  r.stub.dispatch(r.usage, 'mouseenter')
  assert.equal(open(), true)

  r.stub.dispatch(r.usage, 'keydown', { key: 'Escape' })
  assert.equal(open(), false)

  // And hovering again after Escape still works: the dismissal is not a latch.
  r.stub.dispatch(r.usage, 'mouseenter')
  assert.equal(open(), true)
})

test('an empty readout stays empty', (t) => {
  const r = mount(t)
  r.render(undefined)
  assert.equal(r.view().children.length, 0)
})

test('the card carries the session cost and repaints when only the cost moves', (t) => {
  const r = mount(t)
  r.render({ ...TOTAL, cost: { amounts: { USD: 0.42 } } })
  assert.match(card(r.view())!.text, /会话开销\$0\.42/)
  assert.doesNotMatch(card(r.view())!.text, /不含早期请求/)

  // The chips abbreviate the same totals; the card must still move.
  r.render({ ...TOTAL, cost: { amounts: { USD: 0.5, CNY: 1.2 }, legacy: true } })
  assert.match(card(r.view())!.text, /\$0\.50 \+ ¥1\.20/)
  assert.match(card(r.view())!.text, /开销不含早期请求/)
})

test('a session on unpriced models shows no cost row', (t) => {
  const r = mount(t)
  r.render({ ...TOTAL, cost: { amounts: {}, unpriced: true } })
  assert.doesNotMatch(card(r.view())!.text, /会话开销/)
})
