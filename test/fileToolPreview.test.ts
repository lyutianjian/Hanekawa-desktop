import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { getSessionsDir } from '../src/utils/paths.js'
import {
  PERMISSION_PREVIEW_LIMITS,
  PREVIEW_MAX_FILE_BYTES,
  buildFileToolPreview,
  capFileToolPreview,
  type FileToolDiffPreview,
  type FileToolPreview,
} from '../src/services/fileToolPreview.js'

describe('buildFileToolPreview', () => {
  const cwd = process.cwd()
  const readFile = () => 'alpha beta gamma\n'

  it('previews creating a file with an empty old side', () => {
    const preview = buildFileToolPreview('Write', {
      filePath: 'src/new-file.txt',
      content: 'new content\n',
    }, {
      cwd,
      readFile: () => undefined,
    })

    assert.equal(preview?.kind, 'diff')
    if (preview?.kind !== 'diff') return
    assert.equal(preview.title, 'Create file')
    assert.equal(preview.oldText, '')
    assert.equal(preview.newText, 'new content\n')
  })

  it('previews overwriting a file with existing content', () => {
    const preview = buildFileToolPreview('Write', {
      filePath: 'src/existing-file.txt',
      content: 'replacement\n',
    }, { cwd, readFile })

    assert.equal(preview?.kind, 'diff')
    if (preview?.kind !== 'diff') return
    assert.equal(preview.title, 'Overwrite file')
    assert.equal(preview.oldText, 'alpha beta gamma\n')
    assert.equal(preview.newText, 'replacement\n')
  })

  it('previews a single exact edit', () => {
    const preview = buildFileToolPreview('Edit', {
      filePath: 'src/edit-me.txt',
      oldString: 'beta',
      newString: 'BETA',
    }, { cwd, readFile })

    assert.equal(preview?.kind, 'diff')
    if (preview?.kind !== 'diff') return
    assert.equal(preview.oldText, 'alpha beta gamma\n')
    assert.equal(preview.newText, 'alpha BETA gamma\n')
  })

  it('previews multiple edits using the file tool ordering semantics', () => {
    const preview = buildFileToolPreview('MultiEdit', {
      filePath: 'src/multi-edit-me.txt',
      edits: [
        { oldString: 'alpha', newString: 'ALPHA' },
        { oldString: 'gamma', newString: 'GAMMA' },
      ],
    }, { cwd, readFile })

    assert.equal(preview?.kind, 'diff')
    if (preview?.kind !== 'diff') return
    assert.equal(preview.oldText, 'alpha beta gamma\n')
    assert.equal(preview.newText, 'ALPHA beta GAMMA\n')
  })

  it('reports ambiguous edits instead of showing a misleading diff', () => {
    const preview = buildFileToolPreview('Edit', {
      filePath: 'src/ambiguous.txt',
      oldString: 'beta',
      newString: 'BETA',
    }, {
      cwd,
      readFile: () => 'beta beta\n',
    })

    assert.equal(preview?.kind, 'message')
    if (preview?.kind !== 'message') return
    assert.match(preview.message, /Expected exactly one match/)
  })

  it('previews deleting a file with an empty new side', () => {
    const preview = buildFileToolPreview('Delete', {
      filePath: 'src/remove-me.txt',
    }, { cwd, readFile })

    assert.equal(preview?.kind, 'diff')
    if (preview?.kind !== 'diff') return
    assert.equal(preview.title, 'Delete file')
    assert.equal(preview.oldText, 'alpha beta gamma\n')
    assert.equal(preview.newText, '')
  })

  it('previews global runtime paths like other files', () => {
    const preview = buildFileToolPreview('Write', {
      filePath: path.join(getSessionsDir(cwd), 'x.jsonl'),
      content: 'nope',
    }, { cwd, readFile })

    assert.equal(preview?.kind, 'diff')
    if (preview?.kind !== 'diff') return
    assert.equal(preview.newText, 'nope')
  })
})

describe('oversized files are never read', () => {
  async function withOversizedFile(
    run: (cwd: string, fileName: string) => void,
  ): Promise<void> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-preview-'))
    try {
      const fileName = 'huge.txt'
      await writeFile(path.join(dir, fileName), 'x'.repeat(PREVIEW_MAX_FILE_BYTES + 1))
      run(dir, fileName)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it('degrades an edit on an oversized file to a message', async () => {
    await withOversizedFile((cwd, fileName) => {
      const preview = buildFileToolPreview('Edit', {
        filePath: fileName,
        oldString: 'x',
        newString: 'y',
      }, { cwd })

      assert.equal(preview?.kind, 'message')
      if (preview?.kind !== 'message') return
      assert.match(preview.message, /too large to preview/)
    })
  })

  it('does not mistake an oversized existing file for a file being created', async () => {
    await withOversizedFile((cwd, fileName) => {
      const preview = buildFileToolPreview('Write', {
        filePath: fileName,
        content: 'replacement\n',
      }, { cwd })

      // The refusal to read must stay distinguishable from "not there", or an
      // overwrite of a huge file would announce itself as a creation.
      assert.equal(preview?.kind, 'message')
      if (preview?.kind !== 'message') return
      assert.match(preview.message, /too large to preview/)
    })
  })
})

describe('capFileToolPreview', () => {
  function diff(oldText: string, newText: string): FileToolDiffPreview {
    return {
      kind: 'diff',
      title: 'Edit file',
      filePath: 'src/app.ts',
      oldText,
      newText,
      summary: 'src/app.ts will be edited',
    }
  }

  function lines(count: number, prefix = 'line'): string {
    return Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join('\n')
  }

  it('returns a message preview untouched', () => {
    const preview: FileToolPreview = {
      kind: 'message',
      title: 'Edit preview unavailable',
      filePath: 'src/app.ts',
      message: 'nope',
    }

    assert.equal(capFileToolPreview(preview), preview)
  })

  it('returns a preview inside both budgets by identity', () => {
    const preview = diff('alpha\nbeta\n', 'alpha\nBETA\n')

    // Identity, not deep equality: the common path must not allocate.
    assert.equal(capFileToolPreview(preview), preview)
  })

  it('truncates a long side to the line budget and records the dropped count', () => {
    const capped = capFileToolPreview(
      diff(lines(500), lines(10)),
      { maxChars: 1_000_000, maxLines: 200 },
    )

    assert.equal(capped.kind, 'diff')
    if (capped.kind !== 'diff') return
    assert.equal(capped.oldText.split('\n').length, 200)
    assert.equal(capped.elided?.oldLines, 300)
    assert.equal(capped.elided?.newLines, 0)
  })

  it('counts the character budget across both sides rather than per side', () => {
    const side = lines(12, 'ab')
    assert.ok(side.length > 50 && side.length < 100, 'fixture must straddle the per-side budget')

    const capped = capFileToolPreview(diff(side, side), { maxChars: 100, maxLines: 1_000 })

    assert.equal(capped.kind, 'diff')
    if (capped.kind !== 'diff') return
    assert.ok(capped.oldText.length + capped.newText.length <= 100)
    assert.ok((capped.elided?.oldLines ?? 0) > 0, 'the old side should have lost lines')
  })

  it('only ever cuts on a line boundary', () => {
    const capped = capFileToolPreview(diff(lines(40, 'xy'), 'z'), { maxChars: 100, maxLines: 1_000 })

    assert.equal(capped.kind, 'diff')
    if (capped.kind !== 'diff') return
    assert.ok(!capped.oldText.endsWith('\n'), 'a boundary cut leaves no dangling separator')
    for (const line of capped.oldText.split('\n')) {
      assert.match(line, /^xy \d+$/, 'no half line may survive the cut')
    }
  })

  it('degrades to a message when there is no line boundary to cut on', () => {
    const capped = capFileToolPreview(
      diff('x'.repeat(5_000_000), 'y'),
      { maxChars: 100, maxLines: 1_000 },
    )

    assert.equal(capped.kind, 'message')
    if (capped.kind !== 'message') return
    assert.match(capped.message, /Preview omitted/)
    assert.match(capped.message, /5\.0 MB/)
    assert.equal(capped.filePath, 'src/app.ts')
  })

  it('leaves a realistic edit alone under the shipped limits', () => {
    const preview = diff(lines(150), lines(150, 'edited'))

    assert.equal(capFileToolPreview(preview, PERMISSION_PREVIEW_LIMITS), preview)
  })
})
