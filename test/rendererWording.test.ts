import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The window's wording, kept to one set of terms. Each entry is a phrasing the
 * renderer used to have, with the term that replaced it; the check reads the
 * sources so a new view cannot bring an old word back.
 */
const RENDERER = fileURLToPath(new URL('../src/desktop/renderer/', import.meta.url))

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

const RETIRED: ReadonlyArray<readonly [RegExp, string]> = [
  // The composer said 思考强度 for the same setting the settings page called 推理强度.
  [/推理强度/, '思考强度'],
  // Counts read 「108k tok」 in one place and 「108k 标记」 in another.
  [/\d?\} tok`|标记/, 'token'],
  // Durations were the one English shape in a Chinese sentence.
  [/\}m \$\{|\}s`/, '「N 分 N 秒」'],
  [/\bmore`/, '「另有 N 项」'],
  [/→ done`| failed\$\{/, '「完成」/「失败」'],
  // 「快想好了」 promised an end the app cannot see.
  [/快想好了/, '「再想一会」 (the ladder stops)'],
  // A snapshot not arriving yet is a connection in progress, not a missing record.
  [/尚未收到运行时快照/, '「正在连接会话…」'],
  // The turn's file revert is the same act as /rewind, so it carries its name.
  [/撤销本轮/, '「回退本回合」'],
  // The waiting row, the tool bead and the sidebar badge said 等待确认 / 等待授权.
  [/等待授权|'等待确认|`等待确认/, '「等待你确认」'],
  // An empty state is a label, not a sentence: 「还没有会话」 with no 「。」.
  // A hint that goes on to say what to do is a sentence and keeps its stop.
  [/'(还没有|没有)[^'。，]*。'/, 'no 「。」 on a one-clause empty state'],
]

test('retired wording does not come back into the renderer', () => {
  for (const file of sources(RENDERER)) {
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
      .join('\n')
    for (const [pattern, replacement] of RETIRED) {
      assert.doesNotMatch(text, pattern, `${path.relative(RENDERER, file)}: use ${replacement}`)
    }
  }
})
