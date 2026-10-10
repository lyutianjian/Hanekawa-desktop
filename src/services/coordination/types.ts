export type ThreadStatus =
  | 'running'
  | 'idle'
  | 'awaiting-coordinator'
  | 'needs-you'
  | 'failed'
  | 'interrupted'
  | 'quiet'
  | 'resolved'
  | 'stale'

export interface ThreadWorktree {
  /** The worktree root. */
  path: string
  branch: string
  baseRef: string
  /** Where the thread works: the project cwd's counterpart inside the worktree. */
  cwd: string
}

export interface ThreadRecord {
  threadId: string
  sessionId: string
  title: string
  name: string
  brief: string
  background: string
  status: ThreadStatus
  worktree?: ThreadWorktree
  merge?: { conflict?: boolean; dismissedHead?: string }
  createdAt: string
  lastActivityAt: string
  statusLine?: string
  lastReport?: string
}

export interface CoordinatorNote {
  threadId: string
  kind: 'report' | 'question'
  userDriven: boolean
  text: string
  at: string
}

export interface CoordinatorState {
  sessionId: string
  notes: CoordinatorNote[]
  pendingSnapshot?: string
  autoWakeCount: number
  wakeLocked: boolean
  /** The one-time opening turn of a coordinator created by 新建项目 was issued; set before it runs, never cleared. */
  openingIssued?: boolean
}

export interface CoordinationFile {
  version: 1
  coordinator?: CoordinatorState
  threads: ThreadRecord[]
}
