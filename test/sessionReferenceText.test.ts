import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSessionReference, parseSessionReferences, sessionReferenceMarkdown, sessionReferenceUri } from '../src/runtime/sessionReferenceText.js'

const id = 'b2b827ab-cfe8-42a6-a8b8-869aa37a4783'
test('session references validate complete IDs and strict application URIs', () => {
  assert.equal(parseSessionReference(id), id)
  assert.equal(parseSessionReference(sessionReferenceUri(id)), id)
  for (const ref of [id.slice(0, 8), `hanekawa://other/${id}`, `hanekawa://session/${id}/x`, `hanekawa://session/${id}?x=1`, `hanekawa://session/${id}#x`, '/tmp/history']) assert.equal(parseSessionReference(ref), undefined)
})
test('Markdown labels round trip and preserve positions among multiple references', () => {
  const title = '缓存 [命中] \\ 配置 (讨论)'
  const markdown = sessionReferenceMarkdown({ sessionId: id, title })
  const input = `参考 ${markdown} 和 ${sessionReferenceUri(id)} 继续`
  const refs = parseSessionReferences(input)
  assert.equal(refs.length, 2)
  assert.equal(refs[0]!.title, title)
  for (const ref of refs) assert.equal(input.slice(ref.start, ref.end), ref.text)
  assert.equal(parseSessionReferences(`${sessionReferenceUri(id)}?path=/etc/passwd`).length, 0)
  assert.equal(parseSessionReferences(`${sessionReferenceUri(id)}/extra`).length, 0)
})


test('a closed Markdown reference may touch neighboring prose', () => {
  const markdown = sessionReferenceMarkdown({ sessionId: id, title: 'source' })
  assert.equal(parseSessionReferences(`before${markdown}after`).length, 1)
  assert.equal(parseSessionReferences(`${sessionReferenceUri(id)}extra`).length, 0)
})
