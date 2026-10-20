import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod/v3'
import type { Tool, ToolContext, ToolResult } from '../../harness/types.js'
import { requireFreshRead, readFileAndRemember } from '../fileState.js'
import { assertParentNotSymlink, assertFileNotSymlink } from '../pathSafety.js'
import { resolveToolPath } from '../../utils/paths.js'
import { patchDetail } from '../editPatch.js'
import { trackFileEdit } from '../trackFileEdit.js'
import { DESCRIPTION } from './prompt.js'

// ── Types ──────────────────────────────────────────────────────────────────────

interface NotebookCell {
  id?: string
  cell_type: 'code' | 'markdown' | 'raw'
  source: string | string[]
  metadata: Record<string, unknown>
  execution_count?: number | null
  outputs?: unknown[]
}

interface NotebookContent {
  cells: NotebookCell[]
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

interface NotebookEditInput {
  notebook_path: string
  cell_id?: string
  new_source: string
  cell_type?: 'code' | 'markdown'
  edit_mode?: 'replace' | 'insert' | 'delete'
}

// ── Cell ID parsing ────────────────────────────────────────────────────────────

/**
 * Parse a cell_id that might be "cell-N" (numeric index) or an exact cell ID.
 * Returns { index, id } — index is resolved from "cell-N" or -1 for exact ID lookup.
 */
function parseCellId(cellId: string): { index: number; id: string | null } {
  const match = cellId.match(/^cell-(\d+)$/)
  if (match) {
    return { index: parseInt(match[1]!, 10), id: null }
  }
  return { index: -1, id: cellId }
}

/**
 * Find a cell in the notebook by cell_id.
 * Tries exact ID match first, then falls back to "cell-N" index.
 * Returns { cell, index } or null if not found.
 */
function findCell(notebook: NotebookContent, cellId: string): { cell: NotebookCell; index: number } | null {
  const parsed = parseCellId(cellId)

  // Try exact ID match first
  if (parsed.id !== null) {
    const index = notebook.cells.findIndex((c) => c.id === parsed.id)
    if (index !== -1) return { cell: notebook.cells[index]!, index }
  }

  // Fall back to numeric index
  if (parsed.index >= 0 && parsed.index < notebook.cells.length) {
    return { cell: notebook.cells[parsed.index]!, index: parsed.index }
  }

  return null
}

/**
 * Generate a random cell ID for nbformat >= 4.5.
 */
function generateCellId(): string {
  return Math.random().toString(36).substring(2, 15)
}

/**
 * Check if notebook requires cell IDs (nbformat > 4, or 4.5+).
 */
function requiresCellIds(notebook: NotebookContent): boolean {
  return notebook.nbformat > 4 || (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)
}

/**
 * Serialize cell source back to the format expected by Jupyter.
 * Jupyter expects an array of strings (one per line), but we store as a single string.
 * We split on newlines, keeping the newline at the end of each line except the last.
 */
function serializeSource(source: string): string[] {
  if (source === '') return ['']
  const lines = source.split('\n')
  return lines.map((line, i) => (i < lines.length - 1 ? `${line}\n` : line))
}

/** The cell's text as one string, whichever of the two on-disk shapes it uses. */
function cellSourceText(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join('') : cell.source
}

/**
 * A notebook's patch is over the *cell's* source, not the .ipynb JSON: a
 * JSON-level diff is mostly execution counts and output blobs, which is not
 * what the edit was about.
 */
function cellPatchLabel(notebookPath: string, index: number): string {
  return `${notebookPath}#cell-${index}`
}

// ── Tool implementation ────────────────────────────────────────────────────────

export const notebookEditTool: Tool = {
  name: 'NotebookEdit',
  description: DESCRIPTION,
  searchHint: 'edit jupyter notebook ipynb cells',
  shouldDefer: true,
  inputSchema: z.object({
    notebook_path: z.string().min(1).describe('Path to the .ipynb file. Relative paths resolve against the working directory.'),
    cell_id: z.string().optional().describe('Target cell, either its real id or a 0-based "cell-N". Required for replace and delete; for insert it names the cell to insert after.'),
    new_source: z.string().describe('Full source of the cell. Ignored by delete, but still required — send an empty string.'),
    cell_type: z.enum(['code', 'markdown']).optional().describe('Cell type. Required for insert; for replace it changes the existing cell\'s type.'),
    edit_mode: z.enum(['replace', 'insert', 'delete']).optional().default('replace').describe('What to do with the cell. Defaults to "replace".'),
  }).strict(),
  riskLevel: 'confirm',
  isReadOnly: false,
  isConcurrencySafe: false,
  maxResultSizeChars: 50_000,
  userFacingName: () => 'Edit Notebook',
  getToolUseSummary(input) {
    const { notebook_path, edit_mode, cell_id } = input as NotebookEditInput
    const basename = path.basename(notebook_path)
    const mode = edit_mode ?? 'replace'
    return cell_id ? `${mode} ${basename} cell ${cell_id}` : `${mode} ${basename}`
  },
  getActivityDescription(input) {
    const { notebook_path, edit_mode } = input as NotebookEditInput
    const basename = path.basename(notebook_path)
    return `Editing ${basename} (${edit_mode ?? 'replace'})`
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const options = input as NotebookEditInput
    const editMode = options.edit_mode ?? 'replace'
    const absolutePath = resolveToolPath(context, options.notebook_path)

    // Validate extension (case-insensitive for Windows/macOS)
    if (!absolutePath.toLowerCase().endsWith('.ipynb')) {
      return {
        ok: false,
        content: `File "${options.notebook_path}" is not a .ipynb file. Use the Edit tool for non-notebook files.`,
        errorCode: 'invalid_input',
      }
    }

    // Insert requires cell_type
    if (editMode === 'insert' && !options.cell_type) {
      return {
        ok: false,
        content: 'The "cell_type" parameter is required when edit_mode is "insert".',
        errorCode: 'invalid_input',
      }
    }

    // Check symlink safety (both parent directory and the file itself)
    const unsafeParent = await assertParentNotSymlink(absolutePath, options.notebook_path)
    if (unsafeParent) return unsafeParent
    const unsafeFile = await assertFileNotSymlink(absolutePath, options.notebook_path)
    if (unsafeFile) return unsafeFile

    // Enforce read-before-edit
    const staleError = await requireFreshRead(absolutePath, options.notebook_path, context)
    if (staleError) return staleError

    // Read the notebook
    let rawContent: string
    try {
      rawContent = await readFile(absolutePath, 'utf-8')
    } catch (error) {
      return {
        ok: false,
        content: `Failed to read notebook: ${error instanceof Error ? error.message : String(error)}`,
        errorCode: 'precondition_failed',
      }
    }

    // Parse JSON
    let notebook: NotebookContent
    try {
      notebook = JSON.parse(rawContent) as NotebookContent
    } catch {
      return {
        ok: false,
        content: `File "${options.notebook_path}" is not valid JSON.`,
        errorCode: 'invalid_input',
      }
    }

    // Validate notebook structure
    if (!Array.isArray(notebook.cells)) {
      return {
        ok: false,
        content: `File "${options.notebook_path}" does not have a valid notebook structure (missing "cells" array).`,
        errorCode: 'invalid_input',
      }
    }

    // ── DELETE mode ──────────────────────────────────────────────────────────

    if (editMode === 'delete') {
      if (!options.cell_id) {
        return {
          ok: false,
          content: 'The "cell_id" parameter is required when edit_mode is "delete".',
          errorCode: 'invalid_input',
        }
      }

      const found = findCell(notebook, options.cell_id)
      if (!found) {
        return {
          ok: false,
          content: `Cell "${options.cell_id}" not found in notebook.`,
          errorCode: 'not_found',
        }
      }

      const deletedSource = cellSourceText(found.cell)
      notebook.cells.splice(found.index, 1)
      await writeNotebook(absolutePath, notebook, context)

      return {
        ok: true,
        content: `Deleted cell ${found.index} from ${path.basename(options.notebook_path)}. Notebook now has ${notebook.cells.length} cells.`,
        metadata: {
          display: {
            summary: `Deleted cell ${found.index} (${notebook.cells.length} cells remaining)`,
            ...patchDetail(cellPatchLabel(options.notebook_path, found.index), deletedSource, ''),
          },
        },
      }
    }

    // ── INSERT mode ──────────────────────────────────────────────────────────

    if (editMode === 'insert') {
      let insertIndex = 0

      if (options.cell_id) {
        const found = findCell(notebook, options.cell_id)
        if (!found) {
          return {
            ok: false,
            content: `Cell "${options.cell_id}" not found in notebook. Cannot insert after a non-existent cell.`,
            errorCode: 'not_found',
          }
        }
        insertIndex = found.index + 1
      }

      const cellType = options.cell_type!
      const newCell: NotebookCell = {
        cell_type: cellType,
        source: serializeSource(options.new_source),
        metadata: {},
      }

      if (cellType === 'code') {
        newCell.execution_count = null
        newCell.outputs = []
      }

      if (requiresCellIds(notebook)) {
        newCell.id = generateCellId()
      }

      notebook.cells.splice(insertIndex, 0, newCell)
      await writeNotebook(absolutePath, notebook, context)

      return {
        ok: true,
        content: `Inserted new ${cellType} cell at position ${insertIndex} in ${path.basename(options.notebook_path)}. Notebook now has ${notebook.cells.length} cells.`,
        metadata: {
          display: {
            summary: `Inserted ${cellType} cell at ${insertIndex} (${notebook.cells.length} cells)`,
            ...patchDetail(cellPatchLabel(options.notebook_path, insertIndex), '', options.new_source),
          },
        },
      }
    }

    // ── REPLACE mode (default) ───────────────────────────────────────────────

    if (!options.cell_id) {
      return {
        ok: false,
        content: 'The "cell_id" parameter is required when edit_mode is "replace".',
        errorCode: 'invalid_input',
      }
    }

    const found = findCell(notebook, options.cell_id)
    if (!found) {
      // Special case: if cell index equals notebook length, convert to insert
      const parsed = parseCellId(options.cell_id)
      if (parsed.index === notebook.cells.length) {
        const cellType = options.cell_type ?? 'code'
        const newCell: NotebookCell = {
          cell_type: cellType,
          source: serializeSource(options.new_source),
          metadata: {},
        }
        if (cellType === 'code') {
          newCell.execution_count = null
          newCell.outputs = []
        }
        if (requiresCellIds(notebook)) {
          newCell.id = generateCellId()
        }
        notebook.cells.push(newCell)
        await writeNotebook(absolutePath, notebook, context)

        return {
          ok: true,
          content: `Appended new ${cellType} cell at end of ${path.basename(options.notebook_path)}. Notebook now has ${notebook.cells.length} cells.`,
          metadata: {
            display: {
              summary: `Appended ${cellType} cell (${notebook.cells.length} cells)`,
              ...patchDetail(
                cellPatchLabel(options.notebook_path, notebook.cells.length - 1),
                '',
                options.new_source,
              ),
            },
          },
        }
      }

      return {
        ok: false,
        content: `Cell "${options.cell_id}" not found in notebook.`,
        errorCode: 'not_found',
      }
    }

    // Update the cell
    const targetCell = found.cell
    const previousSource = cellSourceText(targetCell)
    targetCell.source = serializeSource(options.new_source)

    // Reset execution state for code cells
    if (targetCell.cell_type === 'code') {
      targetCell.execution_count = null
      targetCell.outputs = []
    }

    // Change cell type if requested
    if (options.cell_type && options.cell_type !== targetCell.cell_type) {
      targetCell.cell_type = options.cell_type
      if (options.cell_type === 'code') {
        targetCell.execution_count = null
        targetCell.outputs = []
      } else {
        // Clean up code-cell-specific fields when converting to markdown/raw
        delete targetCell.execution_count
        delete targetCell.outputs
      }
    }

    await writeNotebook(absolutePath, notebook, context)

    return {
      ok: true,
      content: `Updated cell ${found.index} in ${path.basename(options.notebook_path)}.`,
      metadata: {
        display: {
          summary: `Updated cell ${found.index} (${targetCell.cell_type})`,
          ...patchDetail(
            cellPatchLabel(options.notebook_path, found.index),
            previousSource,
            options.new_source,
          ),
        },
      },
    }
  },
}

/**
 * Write the notebook back to disk with standard Jupyter formatting.
 * Uses atomic write (tmp + rename) for safety.
 */
async function writeNotebook(absolutePath: string, notebook: NotebookContent, context: ToolContext): Promise<void> {
  await trackFileEdit(context, absolutePath)

  // Jupyter standard: 1-space indent
  const content = JSON.stringify(notebook, null, 1)

  // Ensure parent directory exists
  await mkdir(path.dirname(absolutePath), { recursive: true })

  // Atomic write: tmp file + rename
  const tmpPath = `${absolutePath}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, absolutePath)

  // Update read state so subsequent edits don't fail with stale_file
  await readFileAndRemember(absolutePath, context)
}
