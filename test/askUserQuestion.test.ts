import test from 'node:test'
import assert from 'node:assert/strict'
import { askUserQuestionTool } from '../src/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import type { ToolContext } from '../src/harness/types.js'

function context(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: 'main',
    readFiles: new Set(),
    askUserQuestionBridge: {
      ask: async () => ({
        kind: 'answers',
        answers: { 'Which layout?': 'Dense' },
        annotations: {
          'Which layout?': {
            preview: 'Dense table preview',
            notes: 'Prefer scanability',
          },
        },
      }),
    },
  }
}

test('AskUserQuestion includes selected preview annotations in the model-facing result', async () => {
  const result = await askUserQuestionTool.execute({
    questions: [{
      question: 'Which layout?',
      header: 'Layout',
      options: [
        { label: 'Dense', description: 'Compact table', preview: 'Dense table preview' },
        { label: 'Roomy', description: 'More spacing', preview: 'Roomy card preview' },
      ],
    }],
  }, context())

  assert.equal(result.ok, true)
  assert.match(result.content, /"Which layout\?"="Dense"/)
  assert.match(result.content, /selected preview:\nDense table preview/)
  assert.match(result.content, /user notes: Prefer scanability/)
  // The answers ride the persisted display so a replayed transcript can show them.
  assert.deepEqual(result.metadata?.display, { summary: 'Answered 1 question', answers: { 'Which layout?': 'Dense' } })
})

test('AskUserQuestion rejects previews on multi-select questions', async () => {
  await assert.rejects(() => askUserQuestionTool.execute({
    questions: [{
      question: 'Which features?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Search', description: 'Add search', preview: 'Search preview' },
        { label: 'Filter', description: 'Add filters' },
      ],
    }],
  }, context()))
})
