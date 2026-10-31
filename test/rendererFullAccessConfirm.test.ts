import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub } from './helpers/domStub.js'
import { createFullAccessConfirmView } from '../src/desktop/renderer/dom/fullAccessConfirmView.js'

/**
 * The question behind the composer's 完全访问权限 row.
 *
 * What is worth a test is only what the view decides: the answer is handed back
 * once, and every way out that is *not* 确认 leaves the gate where it was. The
 * rest is the stylesheet's.
 */

function render(t: { after(fn: () => void): void }) {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer()
  const learnMore: number[] = []
  const view = createFullAccessConfirmView(container, { onLearnMore: () => learnMore.push(1) })
  const panel = () => stub.inspect(container).children[0]!
  /** The two buttons, in the order the panel draws them: 取消 then 确认. */
  const buttons = () => panel().children.find((child) => child.classes.includes('full-access-actions'))!.children
  return { stub, container, view, learnMore, panel, buttons }
}

test('确认 hands the answer back once and closes the question', (t) => {
  const r = render(t)
  const answers: number[] = []

  r.view.open(() => answers.push(1))
  assert.equal(r.view.isOpen(), true)
  assert.equal(r.stub.inspect(r.container).hidden, false)
  assert.equal(r.panel().attributes.get('role'), 'dialog')
  // 取消 first: the safe answer is where focus lands, not the red one.
  assert.equal(r.stub.activeElement(), r.buttons()[0]!.node)

  r.stub.click(r.buttons()[1]!.node)
  assert.deepEqual(answers, [1])
  assert.equal(r.view.isOpen(), false)
})

test('取消, Escape and the scrim all leave the gate alone', (t) => {
  const r = render(t)
  const answers: number[] = []

  r.view.open(() => answers.push(1))
  r.stub.click(r.buttons()[0]!.node)
  assert.equal(r.view.isOpen(), false)

  r.view.open(() => answers.push(1))
  const escape = r.stub.dispatch(r.container, 'keydown', { key: 'Escape' })
  assert.equal(r.view.isOpen(), false)
  // Consumed here: at the document, Escape means "stop the turn".
  assert.equal(escape.defaultPrevented, true)
  assert.equal(escape.propagationStopped, true)

  r.view.open(() => answers.push(1))
  r.stub.dispatch(r.container, 'pointerdown', { target: r.container })
  assert.equal(r.view.isOpen(), false)

  assert.deepEqual(answers, [], 'nothing outside 确认 may run the pending answer')
})

test('a press inside the panel is not a dismissal, and 了解更多 opens the screen behind it', (t) => {
  const r = render(t)
  const answers: number[] = []

  r.view.open(() => answers.push(1))
  r.stub.dispatch(r.container, 'pointerdown', { target: r.panel().node })
  assert.equal(r.view.isOpen(), true)

  const more = r.panel().children.find((child) => child.classes.includes('full-access-foot'))!.children[0]!
  r.stub.click(more.node)
  assert.equal(r.view.isOpen(), false)
  assert.deepEqual(r.learnMore, [1])
  assert.deepEqual(answers, [])
})