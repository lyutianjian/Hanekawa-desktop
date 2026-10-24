import test from 'node:test'
import assert from 'node:assert/strict'
import { highlightShell, isShellLang } from '../src/desktop/renderer/model/syntax.js'
import type { SyntaxRun } from '../src/desktop/renderer/model/syntax.js'

/** Shell colouring as data: the runs `dom/syntaxView.ts` turns into spans. */

const SAMPLE = `cd /Users/miyano && python3 - <<'PY'
import math
print("x=%d" % 1)
PY
# a comment
for f in *.ts; do echo "$f" \${HOME} | grep -n --color=never 'x' > /tmp/out.txt 2>&1; done
export FOO=42 && git commit -m "msg" || exit 1`

function runs(code: string): readonly SyntaxRun[] {
  const result = highlightShell(code)
  assert.ok(result !== undefined, `expected ${JSON.stringify(code)} to be highlighted`)
  return result
}

function kindOf(result: readonly SyntaxRun[], fragment: string): string | undefined {
  const run = result.find((candidate) => candidate.text.includes(fragment))
  assert.ok(run !== undefined, `no run contains ${JSON.stringify(fragment)}`)
  return run.kind
}

test('isShellLang accepts the bash family in any case and nothing else', () => {
  for (const lang of ['bash', 'Bash', 'SH', 'zsh', 'shell', 'shellscript']) assert.equal(isShellLang(lang), true, lang)
  for (const lang of ['ts', 'console', 'powershell', undefined, '']) assert.equal(isShellLang(lang), false, String(lang))
})

test('the runs join back to the source exactly', () => {
  runs(SAMPLE)
  for (const code of [SAMPLE, '', 'echo hi\n', 'a\r\nb']) {
    const result = highlightShell(code)
    if (result !== undefined) assert.equal(result.map((run) => run.text).join(''), code)
  }
})

test('commands, strings, comments, variables, keywords and heredoc bodies get their kinds', () => {
  const result = runs(SAMPLE)
  assert.equal(kindOf(result, 'python3'), 'function')
  assert.equal(kindOf(result, '"msg"'), 'string')
  assert.equal(kindOf(result, '# a comment'), 'comment')
  assert.equal(kindOf(result, '$f'), 'variable')
  assert.equal(kindOf(result, 'for'), 'keyword')
  assert.equal(kindOf(result, 'import math'), 'string')
  assert.equal(kindOf(result, '--color=never'), 'parameter')
})

test('adjacent runs never share a kind', () => {
  const result = runs(SAMPLE)
  for (let index = 1; index < result.length; index++) assert.notEqual(result[index]!.kind, result[index - 1]!.kind)
})

test('code past the length cap is left plain', () => {
  assert.equal(highlightShell('x'.repeat(20_001)), undefined)
  assert.notEqual(highlightShell('x'.repeat(20_000)), undefined)
})

test('the same source returns the cached runs', () => {
  assert.equal(highlightShell('ls -la'), highlightShell('ls -la'))
})
