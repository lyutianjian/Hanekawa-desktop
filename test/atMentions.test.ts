import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  buildAtMentionContextRecord,
  classifyAtMentions,
  collectAtMentionImages,
  extractAtMentionedFiles,
  formatAtMentionImageErrors,
  parseAtMentionedFileLines,
  type AtMentionImageImporter,
} from '../src/harness/atMentions.js'
import { extractAtMentions } from '../src/runtime/suggestions/atToken.js'
import type { ToolContext } from '../src/harness/types.js'
import { fixtureImagePath, loadFixtureBytes, makeImageAttachmentRef } from './helpers/imageFixtures.js'

const execFile = promisify(execFileCallback)

function context(cwd: string): ToolContext {
  return {
    cwd,
    sessionId: 's1',
    readFiles: new Set(),
    readFileState: new Map(),
  }
}

test('the host and the desktop renderer agree on what a mention is', () => {
  // 5d moved the two patterns into `runtime/suggestions/atToken.ts` so the renderer
  // could draw a pill for each mention without importing this file (it needs
  // `node:fs`). This is what stops the two readers from drifting: the host keeps its
  // own order and dedupe, but never its own idea of the syntax.
  const inputs = [
    'read @src/a.py @"src/with space.cpp"#L3-4 @src/c.ts#L10-20',
    'mail me at foo@bar.com',
    '@a.ts is broken',
    'no mention at all',
    '把 @a.ts 的逻辑搬到 @b.ts',
  ]

  for (const input of inputs) {
    assert.deepEqual(
      [...extractAtMentions(input).map((span) => span.mention)].sort(),
      [...new Set(extractAtMentionedFiles(input).map((mention) => mention.raw))].sort(),
      input,
    )
  }
})

test('extractAtMentionedFiles parses regular, quoted, line ranges, and deduplicates', () => {
  const mentions = extractAtMentionedFiles('read @src/a.py @src/a.py @"src/with space.cpp"#L3-4 @"src/b.ts" @src/c.ts#L10-20')

  assert.deepEqual(mentions.map((mention) => mention.filePath), [
    'src/with space.cpp',
    'src/b.ts',
    'src/a.py',
    'src/c.ts',
  ])
  assert.deepEqual(mentions[0], {
    raw: 'src/with space.cpp#L3-4',
    filePath: 'src/with space.cpp',
    lineStart: 3,
    lineEnd: 4,
  })
  assert.deepEqual(parseAtMentionedFileLines('src/c.ts#L10-20'), {
    filePath: 'src/c.ts',
    lineStart: 10,
    lineEnd: 20,
  })
})

test('buildAtMentionContextRecord injects code file content and updates read state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await mkdir(path.join(dir, 'src'))
    const file = path.join(dir, 'src', 'a.py')
    await writeFile(file, 'one\ntwo\nthree\n', 'utf8')
    const ctx = context(dir)

    const record = await buildAtMentionContextRecord({
      userInput: 'explain @src/a.py#L2-3',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: ctx,
      createdAt: '2026-06-02T00:00:00.000Z',
    })

    assert.ok(record)
    assert.equal(record.type, 'at_mention_context')
    assert.match(record.content, /<file path="src\/a.py" lines="2-3">/)
    assert.match(record.content, /two\nthree/)
    assert.equal(ctx.readFiles.has(file), true)
    assert.equal(ctx.readFileState?.get(file)?.content, 'one\ntwo\nthree\n')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord attaches markdown and plain-text documents', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await writeFile(path.join(dir, 'README.md'), '# readme\n', 'utf8')
    await writeFile(path.join(dir, 'notes.txt'), 'todo\n', 'utf8')

    const record = await buildAtMentionContextRecord({
      userInput: 'read @README.md and @notes.txt',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: context(dir),
    })

    assert.ok(record)
    assert.deepEqual(record.files.map((file) => file.displayPath), ['README.md', 'notes.txt'])
    assert.match(record.content, /# readme/)
    assert.match(record.content, /todo/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord skips non-code, empty directories, protected paths, and cwd escapes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-out-'))
  try {
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, 'src', 'blob.bin'), 'nope', 'utf8')
    await writeFile(path.join(outside, 'x.py'), 'print(1)', 'utf8')

    const record = await buildAtMentionContextRecord({
      userInput: `@src @src/blob.bin @${path.relative(dir, path.join(outside, 'x.py'))}`,
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: context(dir),
    })

    assert.equal(record, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord expands mentioned directories to code files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await mkdir(path.join(dir, 'src', 'nested'), { recursive: true })
    await writeFile(path.join(dir, 'src', 'a.py'), 'print(1)\n', 'utf8')
    await writeFile(path.join(dir, 'src', 'nested', 'b.ts'), 'export {}\n', 'utf8')
    await writeFile(path.join(dir, 'src', 'blob.bin'), 'nope\n', 'utf8')
    const ctx = context(dir)

    const record = await buildAtMentionContextRecord({
      userInput: '@src/',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: ctx,
    })

    assert.ok(record)
    assert.deepEqual(record.files.map((file) => file.displayPath), [
      'src/a.py',
      'src/nested/b.ts',
    ])
    assert.match(record.content, /<file path="src\/a.py"/)
    assert.match(record.content, /<file path="src\/nested\/b.ts"/)
    assert.doesNotMatch(record.content, /blob.bin/)
    assert.equal(ctx.readFiles.has(path.join(dir, 'src', 'a.py')), true)
    assert.equal(ctx.readFiles.has(path.join(dir, 'src', 'nested', 'b.ts')), true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord attaches gitignored directory files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await execFile('git', ['init'], { cwd: dir })
    await mkdir(path.join(dir, 'src'))
    await writeFile(path.join(dir, '.gitignore'), 'src/ignored.py\n', 'utf8')
    await writeFile(path.join(dir, 'src', 'ignored.py'), 'print("ignored")\n', 'utf8')
    await writeFile(path.join(dir, 'src', 'visible.py'), 'print("visible")\n', 'utf8')

    const record = await buildAtMentionContextRecord({
      userInput: '@src/',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: context(dir),
    })

    assert.ok(record)
    assert.deepEqual(record.files.map((file) => file.displayPath), [
      'src/ignored.py',
      'src/visible.py',
    ])
    assert.match(record.content, /ignored/)
    assert.match(record.content, /visible/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord attaches dotfile and extensionless mentions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await writeFile(path.join(dir, '.env'), 'TOKEN=abc\n', 'utf8')
    await writeFile(path.join(dir, 'Makefile'), 'all:\n', 'utf8')

    const record = await buildAtMentionContextRecord({
      userInput: '@.env @Makefile',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: context(dir),
    })

    assert.ok(record)
    assert.deepEqual(record.files.map((file) => file.displayPath), ['.env', 'Makefile'])
    assert.match(record.content, /TOKEN=abc/)
    assert.match(record.content, /all:/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord rejects binary content without an extension', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await writeFile(path.join(dir, 'blob'), Buffer.from([0, 1, 2, 3]))

    const record = await buildAtMentionContextRecord({
      userInput: '@blob',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: context(dir),
    })

    assert.equal(record, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord truncates large attached content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    const content = Array.from({ length: 2_100 }, (_, index) => `line ${index + 1}`).join('\n')
    await writeFile(path.join(dir, 'big.py'), content, 'utf8')

    const record = await buildAtMentionContextRecord({
      userInput: '@big.py',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: context(dir),
    })

    assert.ok(record)
    assert.equal(record.files[0]?.lineStart, 1)
    assert.equal(record.files[0]?.lineEnd, 2000)
    assert.equal(record.files[0]?.truncated, true)
    assert.match(record.content, /\[... @-mentioned file content truncated ...\]/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// S09: @-mentioned images

/** Records what the store was asked to import; answers from a script. */
function recordingImporter(
  answer: (name: string) =>
    | { ok: true; value: { ref: ReturnType<typeof makeImageAttachmentRef> } }
    | { ok: false; reason: 'unsupported-format' | 'decode-failed' | 'image-too-large' | 'store-write-failed'; message: string },
): { importer: AtMentionImageImporter; calls: Array<{ sessionId: string; name: string; bytes: Buffer }> } {
  const calls: Array<{ sessionId: string; name: string; bytes: Buffer }> = []
  return {
    calls,
    importer: {
      importImage: async (sessionId, bytes, name) => {
        calls.push({ sessionId, name, bytes })
        return answer(name)
      },
    },
  }
}

function okRef(name: string): { ok: true; value: { ref: ReturnType<typeof makeImageAttachmentRef> } } {
  return {
    ok: true,
    value: { ref: makeImageAttachmentRef({ id: `img-${name}`, ownerSessionId: 's1', name }) },
  }
}

test('classifyAtMentions applies the code-text cap without swallowing image mentions', () => {
  const input = '@a.py @shot1.png @b.py @c.py @d.py @e.py @f.py @shot2.png'

  const { codeFiles, images } = classifyAtMentions(input)
  assert.deepEqual(codeFiles.map((mention) => mention.filePath), ['a.py', 'b.py', 'c.py', 'd.py', 'e.py'])
  assert.deepEqual(images.map((mention) => mention.filePath), ['shot1.png', 'shot2.png'])

  // The syntax layer stays quota-free: identification happens before any cap.
  assert.equal(extractAtMentionedFiles(input).length, 8)
})

test('classifyAtMentions dedupes image mentions by path and keeps text order', () => {
  const { images } = classifyAtMentions('see @b.png and @"a space.png" plus @b.png#L1 and @b.png')
  assert.deepEqual(images.map((mention) => mention.filePath), ['b.png', 'a space.png'])
})

test('collectAtMentionImages imports project images in text order through the store', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await copyFile(fixtureImagePath('transparent.png'), path.join(dir, 'shot.png'))
    await copyFile(fixtureImagePath('static.webp'), path.join(dir, 'other.webp'))
    const { importer, calls } = recordingImporter(okRef)

    const result = await collectAtMentionImages({
      userInput: 'look at @shot.png and @other.webp please',
      toolContext: context(dir),
      importer,
    })

    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.images.map((ref) => ref.name), ['shot.png', 'other.webp'])
    assert.deepEqual(calls.map((call) => call.name), ['shot.png', 'other.webp'])
    assert.equal(calls[0]?.sessionId, 's1')
    assert.deepEqual(calls[0]?.bytes, await loadFixtureBytes('transparent.png'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectAtMentionImages reports #L ranges on images as not applicable', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await copyFile(fixtureImagePath('transparent.png'), path.join(dir, 'shot.png'))
    const { importer, calls } = recordingImporter(okRef)

    const result = await collectAtMentionImages({
      userInput: 'annotate @shot.png#L3-4',
      toolContext: context(dir),
      importer,
    })

    assert.deepEqual(result.images, [])
    assert.equal(calls.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0]?.reason, 'line-range-not-applicable')
    assert.match(result.errors[0]?.message ?? '', /do not apply to images/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectAtMentionImages fails loudly for missing and outside-project images', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  const outside = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-out-'))
  try {
    await copyFile(fixtureImagePath('transparent.png'), path.join(outside, 'external.png'))
    const { importer, calls } = recordingImporter(okRef)

    const result = await collectAtMentionImages({
      userInput: `@missing.png and @${path.relative(dir, path.join(outside, 'external.png'))}`,
      toolContext: context(dir),
      importer,
    })

    assert.deepEqual(result.images, [])
    assert.equal(calls.length, 0)
    assert.deepEqual(result.errors.map((error) => error.reason), ['file-missing', 'outside-project'])
    assert.match(result.errors[1]?.message ?? '', /attach it explicitly/)
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test('collectAtMentionImages enforces the per-input quota counting explicit attachments', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    for (const name of ['one.png', 'two.png', 'three.png']) {
      await copyFile(fixtureImagePath('transparent.png'), path.join(dir, name))
    }
    const { importer } = recordingImporter(okRef)

    const result = await collectAtMentionImages({
      userInput: '@one.png @two.png @three.png',
      toolContext: context(dir),
      importer,
      existingImageCount: 1,
      maxImages: 2,
    })

    assert.deepEqual(result.images.map((ref) => ref.name), ['one.png'])
    assert.deepEqual(result.errors.map((error) => error.reason), ['too-many-images', 'too-many-images'])
    assert.match(result.errors[0]?.message ?? '', /maximum of 2/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectAtMentionImages surfaces importer failures instead of degrading to text', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await writeFile(path.join(dir, 'photo.bmp'), 'not really a bitmap', 'utf8')
    const { importer } = recordingImporter(() => ({
      ok: false,
      reason: 'unsupported-format',
      message: 'BMP is not supported; convert it to PNG or JPEG first.',
    }))

    const result = await collectAtMentionImages({
      userInput: 'use @photo.bmp',
      toolContext: context(dir),
      importer,
    })

    assert.deepEqual(result.images, [])
    assert.deepEqual(result.errors, [{
      mention: 'photo.bmp',
      reason: 'unsupported-format',
      message: 'BMP is not supported; convert it to PNG or JPEG first.',
    }])
    // The line names the reason class, keeps the importer's facts, and ends
    // with the exit for that reason (S24).
    const formatted = formatAtMentionImageErrors(result.errors)
    assert.match(formatted, /- @photo\.bmp: 图片格式不支持：BMP is not supported/)
    assert.match(formatted, /转换成 PNG 或 JPEG/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('collectAtMentionImages attaches gitignored images like any other mention', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await execFile('git', ['init'], { cwd: dir })
    await writeFile(path.join(dir, '.gitignore'), 'ignored.png\n', 'utf8')
    await copyFile(fixtureImagePath('transparent.png'), path.join(dir, 'ignored.png'))
    await copyFile(fixtureImagePath('transparent.png'), path.join(dir, 'visible.png'))
    const { importer } = recordingImporter(okRef)

    const result = await collectAtMentionImages({
      userInput: '@ignored.png @visible.png',
      toolContext: context(dir),
      importer,
    })

    assert.deepEqual(result.errors, [])
    assert.deepEqual(result.images.map((ref) => ref.name), ['ignored.png', 'visible.png'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a mentioned directory contributes code files but never images', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await mkdir(path.join(dir, 'assets'))
    await writeFile(path.join(dir, 'assets', 'a.py'), 'print(1)\n', 'utf8')
    await copyFile(fixtureImagePath('transparent.png'), path.join(dir, 'assets', 'pic.png'))
    const { importer, calls } = recordingImporter(okRef)

    const classified = classifyAtMentions('@assets/')
    assert.deepEqual(classified.images, [])
    assert.deepEqual(classified.codeFiles.map((mention) => mention.filePath), ['assets/'])

    const collected = await collectAtMentionImages({
      userInput: '@assets/',
      toolContext: context(dir),
      importer,
    })
    assert.deepEqual(collected.images, [])
    assert.deepEqual(collected.errors, [])
    assert.equal(calls.length, 0)

    const record = await buildAtMentionContextRecord({
      userInput: '@assets/',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: context(dir),
    })
    assert.ok(record)
    assert.deepEqual(record.files.map((file) => file.displayPath), ['assets/a.py'])
    assert.doesNotMatch(record.content, /pic\.png/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildAtMentionContextRecord keeps image mentions out of the code-text record', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-at-'))
  try {
    await writeFile(path.join(dir, 'a.py'), 'print(1)\n', 'utf8')
    await copyFile(fixtureImagePath('transparent.png'), path.join(dir, 'shot.png'))

    const record = await buildAtMentionContextRecord({
      userInput: 'explain @a.py and @shot.png',
      userMessageId: 'u1',
      turnId: 't1',
      toolContext: context(dir),
    })

    assert.ok(record)
    assert.deepEqual(record.files.map((file) => file.displayPath), ['a.py'])
    assert.doesNotMatch(record.content, /shot\.png/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
