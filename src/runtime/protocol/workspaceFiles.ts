export interface WorkspaceEntry {
  path: string
  name: string
  kind: 'directory' | 'file' | 'link'
}

export interface WorkspaceListing {
  entries: WorkspaceEntry[]
  nextOffset?: number
}

export type WorkspaceFile =
  | { kind: 'text'; path: string; size: number; revision: string; content: string }
  | { kind: 'image' | 'pdf'; path: string; size: number; revision: string; mime: string; bytes: Uint8Array }
  | { kind: 'unsupported'; path: string; size: number; reason: string }

export type WorkspaceSaveResult =
  | { kind: 'saved'; revision: string }
  | { kind: 'conflict'; disk: WorkspaceFile | null }

export interface WorkspaceSearchResult {
  entries: WorkspaceEntry[]
  truncated: boolean
  cancelled: boolean
}

export type PdfResourceKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'

export type WorkspaceFileCommand = { id: string; sessionId: string } & (
  | { type: 'workspace-list'; path: string; offset: number }
  | { type: 'workspace-search'; path: string; query: string }
  | { type: 'workspace-read'; path: string }
  | { type: 'workspace-save'; path: string; content: string; expectedRevision: string }
  | { type: 'workspace-watch'; paths: string[] }
  | { type: 'workspace-open'; path: string }
  | { type: 'workspace-pdf-resource'; kind: PdfResourceKind; name: string }
)

export interface WorkspaceFilesChanged {
  paths: string[]
  error?: string
}
