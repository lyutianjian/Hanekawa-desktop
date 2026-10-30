import test from 'node:test'
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readFileTool } from '../src/tools/FileReadTool/FileReadTool.js'
import { ImageAttachmentService } from '../src/services/imageAttachments/imageAttachmentService.js'
import { AgentLoop } from '../src/harness/loop.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { MemoryRecordStream } from '../src/harness/recordStream.js'
import type { ModelProvider, ReadFileState, ToolContext } from '../src/harness/types.js'
import type { ImageAttachmentImporter } from '../src/harness/types.js'
import {
  assertNoImageBytes,
  fixtureImagePath,
  loadFixtureBytes,
} from './helpers/imageFixtures.js'

/**
 * S10: the Read tool's image branch. Every test gets its own scratch project
 * so the real `ImageAttachmentService` stores under `<project>/.hanekawa` —
 * the same shape `createRuntime` hands the session's toolContext.
 */
const SESSION_ID = 'session-read'

async function withProject(run: (project: string) => Promise<void>): Promise<void> {
  const project = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-readimg-'))
  try {
    await run(project)
  } finally {
    await rm(project, { recursive: true, force: true })
  }
}

function imageContext(
  project: string,
  overrides: Partial<Pick<ToolContext, 'imageAttachments' | 'getSupportsImageInput'>> = {},
): ToolContext {
  return {
    cwd: project,
    sessionId: SESSION_ID,
    readFiles: new Set<string>(),
    readFileState: new Map<string, ReadFileState>(),
    ...overrides,
  }
}

/** A capable model plus the real store — the shape a wired session has. */
function capableContext(project: string): ToolContext {
  return imageContext(project, {
    imageAttachments: new ImageAttachmentService(project),
    getSupportsImageInput: () => true,
  })
}

test('Read returns a caption and image ref for a PNG without touching read state', async () => {
  await withProject(async (project) => {
    await copyFile(fixtureImagePath('transparent.png'), path.join(project, 'shot.png'))
    const context = capableContext(project)

    const result = await readFileTool.execute({ filePath: 'shot.png' }, context)
    assert.equal(result.ok, true, result.content)

    // The caption carries the original size, the supplied size, and the cache
    // path (design §7.2); transparent.png is 64x64 and never upscaled.
    assert.match(result.content, /oriented original 64x64/)
    assert.match(result.content, /supplied image 64x64/)
    assert.match(result.content, /cached original: /)
    assert.match(result.content, /attached to this tool result/)

    assert.equal(result.images?.length, 1)
    const ref = result.images?.[0]
    assert.equal(ref?.ownerSessionId, SESSION_ID)
    assert.equal(ref?.name, 'shot.png')
    assert.equal(ref?.mimeType, 'image/png')

    // No text was extracted, and no bytes leaked into the result.
    assertNoImageBytes(result)

    // Image content never enters read state: a later Edit must refuse the
    // file instead of matching against binary pixels.
    assert.equal(context.readFiles.has(path.join(project, 'shot.png')), false)
    assert.equal(context.readFileState?.size, 0)
  })
})

test('Read applies EXIF orientation facts in the caption', async () => {
  await withProject(async (project) => {
    // Stored 64x48 with orientation tag 6: the upright image is 48x64, and
    // the send version is rotated to match.
    await copyFile(fixtureImagePath('exif-orientation.jpg'), path.join(project, 'photo.jpg'))
    const result = await readFileTool.execute({ filePath: 'photo.jpg' }, capableContext(project))

    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /oriented original 48x64/)
    assert.match(result.content, /supplied image 48x64/)
  })
})

test('Read notes the first frame of an animated GIF', async () => {
  await withProject(async (project) => {
    await copyFile(fixtureImagePath('animated.gif'), path.join(project, 'spin.gif'))
    const result = await readFileTool.execute({ filePath: 'spin.gif' }, capableContext(project))

    assert.equal(result.ok, true, result.content)
    assert.match(result.content, /first frame of an animated image/)
  })
})

test('a wrong extension still reads as an image when the content says so', async () => {
  await withProject(async (project) => {
    // PNG bytes named .jpg: the extension only nominates, the sniff decides.
    await copyFile(fixtureImagePath('png-named-jpg.jpg'), path.join(project, 'disguised.jpg'))
    const result = await readFileTool.execute({ filePath: 'disguised.jpg' }, capableContext(project))

    assert.equal(result.ok, true, result.content)
    assert.equal(result.images?.[0]?.mimeType, 'image/png')
    assert.equal(result.images?.[0]?.name, 'disguised.jpg')
  })
})

test('a text file with an image extension stays a text read', async () => {
  await withProject(async (project) => {
    await writeFile(path.join(project, 'notes.png'), 'hello\nworld\n', 'utf8')
    const context = capableContext(project)

    const result = await readFileTool.execute({ filePath: 'notes.png' }, context)
    assert.equal(result.ok, true)
    assert.match(result.content, /hello/)
    assert.equal('images' in result && result.images !== undefined, false)

    // Full text semantics: remembered for a later edit, line numbers intact.
    assert.equal(context.readFiles.has(path.join(project, 'notes.png')), true)
    assert.equal(context.readFileState?.get(path.join(project, 'notes.png'))?.content, 'hello\nworld\n')
  })
})

test('an SVG keeps its text semantics even under an image extension', async () => {
  await withProject(async (project) => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect/></svg>\n'
    await writeFile(path.join(project, 'icon.png'), svg, 'utf8')
    const result = await readFileTool.execute({ filePath: 'icon.png' }, capableContext(project))

    assert.equal(result.ok, true)
    assert.match(result.content, /<rect\/>/)
    assert.equal(result.images, undefined)
  })
})

test('a text-only model gets precondition_failed, never bytes', async () => {
  await withProject(async (project) => {
    await copyFile(fixtureImagePath('transparent.png'), path.join(project, 'shot.png'))

    const explicit = imageContext(project, {
      imageAttachments: new ImageAttachmentService(project),
      getSupportsImageInput: () => false,
    })
    const refused = await readFileTool.execute({ filePath: 'shot.png' }, explicit)
    assert.equal(refused.ok, false)
    assert.equal(refused.errorCode, 'precondition_failed')
    assert.deepEqual(refused.errorDetails, { reason: 'model-not-capable' })
    assert.match(refused.content, /does not accept image input/)
    assert.equal(refused.images, undefined)
    assertNoImageBytes(refused)

    // An absent probe means the same thing: not capable.
    const absent = imageContext(project, {
      imageAttachments: new ImageAttachmentService(project),
    })
    const refusedToo = await readFileTool.execute({ filePath: 'shot.png' }, absent)
    assert.equal(refusedToo.errorCode, 'precondition_failed')
  })
})

test('no attachment store means precondition_failed, not a binary text read', async () => {
  await withProject(async (project) => {
    await copyFile(fixtureImagePath('transparent.png'), path.join(project, 'shot.png'))
    const context = imageContext(project, { getSupportsImageInput: () => true })

    const result = await readFileTool.execute({ filePath: 'shot.png' }, context)
    assert.equal(result.ok, false)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.deepEqual(result.errorDetails, { reason: 'attachment-store-unavailable' })
    assert.equal(result.images, undefined)
    assertNoImageBytes(result)
  })
})

test('offset and limit are rejected for images', async () => {
  await withProject(async (project) => {
    await copyFile(fixtureImagePath('transparent.png'), path.join(project, 'shot.png'))
    const context = capableContext(project)

    const windowed = await readFileTool.execute({ filePath: 'shot.png', offset: 2 }, context)
    assert.equal(windowed.ok, false)
    assert.equal(windowed.errorCode, 'invalid_input')
    assert.deepEqual(windowed.errorDetails, { reason: 'line-range-not-applicable' })
    assert.match(windowed.content, /do not apply to images/)

    const limited = await readFileTool.execute({ filePath: 'shot.png', limit: 5 }, context)
    assert.equal(limited.ok, false)
    assert.equal(limited.errorCode, 'invalid_input')
    assert.deepEqual(limited.errorDetails, { reason: 'line-range-not-applicable' })
  })
})

test('unsupported formats and undecodable files fail with distinct reasons', async () => {
  await withProject(async (project) => {
    // A BMP header: sniffed, named, and rejected with a conversion hint.
    await writeFile(path.join(project, 'legacy.bmp'), Buffer.concat([Buffer.from('BM'), Buffer.alloc(64)]))
    const bmp = await readFileTool.execute({ filePath: 'legacy.bmp' }, capableContext(project))
    assert.equal(bmp.ok, false)
    assert.equal(bmp.errorCode, 'invalid_input')
    assert.deepEqual(bmp.errorDetails, { reason: 'unsupported-format' })
    assert.match(bmp.content, /convert it to PNG or JPEG first/i)
    assertNoImageBytes(bmp)

    await copyFile(fixtureImagePath('corrupt.png'), path.join(project, 'broken.png'))
    const corrupt = await readFileTool.execute({ filePath: 'broken.png' }, capableContext(project))
    assert.equal(corrupt.ok, false)
    assert.equal(corrupt.errorCode, 'invalid_input')
    assert.deepEqual(corrupt.errorDetails, { reason: 'decode-failed' })
  })
})

test('image reads settle through the ToolRunner with paired records', async () => {
  await withProject(async (project) => {
    await copyFile(fixtureImagePath('transparent.png'), path.join(project, 'shot.png'))
    const emitted: unknown[] = []
    const runner = new ToolRunner([readFileTool], new PermissionGate(async () => true), {
      onRecord: async (record) => { emitted.push(record) },
    })

    const success = await runner.run(
      { id: 'call-1', name: 'Read', input: { filePath: 'shot.png' } },
      capableContext(project),
    )
    assert.equal(success.ok, true, success.content)
    assert.equal(success.images?.length, 1)
    assertNoImageBytes(success)

    // tool_use, tool_approval, tool_result — the failure below keeps the pair.
    const useRecord = emitted.find((record) => (record as { type?: string }).type === 'tool_use')
    assert.ok(useRecord, 'tool_use record emitted')

    // A text-only model still settles the same call: paired, structured, no images.
    emitted.length = 0
    const refused = await runner.run(
      { id: 'call-2', name: 'Read', input: { filePath: 'shot.png' } },
      imageContext(project, {
        imageAttachments: new ImageAttachmentService(project),
        getSupportsImageInput: () => false,
      }),
    )
    assert.equal(refused.ok, false)
    assert.equal(refused.errorCode, 'precondition_failed')
    assert.equal(refused.images, undefined)
    assertNoImageBytes(refused)
    assert.ok(emitted.some((record) => (record as { type?: string }).type === 'tool_result'))
  })
})

test('an explicit deny rule cannot be bypassed by the image branch', async () => {
  await withProject(async (project) => {
    await copyFile(fixtureImagePath('transparent.png'), path.join(project, 'shot.png'))
    let imports = 0
    const never: ImageAttachmentImporter = {
      importImage: async () => {
        imports += 1
        throw new Error('a denied read must never reach the store')
      },
    }
    const gate = new PermissionGate(async () => true)
    gate.addSessionRules([{ toolName: 'Read', behavior: 'deny', source: 'session' }])
    const runner = new ToolRunner([readFileTool], gate, { onRecord: async () => {} })

    const denied = await runner.run(
      { id: 'call-1', name: 'Read', input: { filePath: 'shot.png' } },
      imageContext(project, { imageAttachments: never, getSupportsImageInput: () => true }),
    )
    assert.equal(denied.ok, false)
    assert.equal(denied.errorCode, 'permission_denied')
    assert.equal(imports, 0)
  })
})

test('the loop installs a live capability probe and runTool keeps it with the store', async () => {
  await withProject(async (project) => {
    await copyFile(fixtureImagePath('transparent.png'), path.join(project, 'shot.png'))

    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        return {
          content: 'seen',
          toolCalls: [],
          usage: { inputTokens: 1, cacheReadInputTokens: 0, outputTokens: 1 },
        }
      },
    }
    const toolContext = imageContext(project, {
      imageAttachments: new ImageAttachmentService(project),
    })
    const loop = new AgentLoop({
      provider,
      model: 'fake-model',
      tools: [readFileTool],
      contextBuilder: new ContextBuilder(),
      toolRunner: new ToolRunner([readFileTool], new PermissionGate(async () => true), {
        onRecord: async () => {},
      }),
      toolContext,
      recordStream: new MemoryRecordStream(),
      supportsImageInput: true,
    })

    // The probe reads the model actually serving the loop, not a snapshot:
    // absent option means not capable.
    assert.equal(toolContext.getSupportsImageInput?.(), true)

    // runTool executes on a forked context; the store and the probe must
    // survive the fork or every isolated read would degrade to a precondition.
    const record = await loop.runTool({ id: 'call-1', name: 'Read', input: { filePath: 'shot.png' } })
    assert.equal(record.ok, true, record.content)
    assert.equal(record.images?.length, 1)
    assertNoImageBytes(record)
  })
})

test('a loop without image capability reports not capable through the probe', async () => {
  await withProject(async (project) => {
    const provider: ModelProvider = {
      name: 'fake',
      async createMessage() {
        return { content: 'seen', toolCalls: [], usage: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 } }
      },
    }
    const toolContext = imageContext(project)
    new AgentLoop({
      provider,
      model: 'fake-model',
      tools: [],
      contextBuilder: new ContextBuilder(),
      toolRunner: new ToolRunner([], new PermissionGate(async () => true), { onRecord: async () => {} }),
      toolContext,
      recordStream: new MemoryRecordStream(),
    })
    assert.equal(toolContext.getSupportsImageInput?.(), false)
  })
})
