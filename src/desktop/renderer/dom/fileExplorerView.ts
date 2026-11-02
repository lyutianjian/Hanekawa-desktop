import type { FileWorkspace, FileWorkspaceBinding } from './fileWorkspaceView.js'

export class FileExplorerPanel {
  private readonly workspaces = new Map<string, FileWorkspace>()
  private active: FileWorkspace | undefined
  private requested: FileWorkspaceBinding | undefined
  private factory: typeof FileWorkspace | undefined
  private loading: Promise<void> | undefined
  private disposed = false
  constructor(private readonly container: HTMLElement, private readonly report: (error: unknown) => void) {}

  render(binding: FileWorkspaceBinding | undefined): void {
    this.requested = binding
    if (this.disposed) return
    if (binding && !this.factory) {
      this.loading ??= import('./fileWorkspaceView.js').then(({ FileWorkspace }) => {
        this.factory = FileWorkspace
        this.render(this.requested)
      }).catch(this.report).finally(() => { this.loading = undefined })
      return
    }
    let workspace = binding ? this.workspaces.get(binding.sessionId) : undefined
    if (binding && !workspace) {
      const Workspace = this.factory!
      workspace = new Workspace(binding, this.report)
      this.workspaces.set(binding.sessionId, workspace)
    }
    if (workspace === this.active) return
    this.active?.setVisible(false)
    if (this.active) this.active.element.hidden = true
    this.active = workspace
    if (workspace) {
      if (workspace.element.parentNode !== this.container) this.container.append(workspace.element)
      workspace.element.hidden = false
      workspace.setVisible(true)
    }
  }
  retain(sessionIds: ReadonlySet<string>): void { for (const id of this.workspaces.keys()) if (!sessionIds.has(id)) this.release(id) }
  refresh(): void { void this.active?.refresh() }
  hasPending(sessionId: string): boolean { return this.workspaces.get(sessionId)?.hasPending() ?? false }
  async guard(sessionId?: string): Promise<boolean> {
    for (const [id, workspace] of this.workspaces) if ((!sessionId || sessionId === id) && !await workspace.guard()) return false
    return true
  }
  release(sessionId: string): void { const workspace = this.workspaces.get(sessionId); if (workspace === this.active) this.active = undefined; workspace?.dispose(); this.workspaces.delete(sessionId) }
  dispose(): void { this.disposed = true; for (const workspace of this.workspaces.values()) workspace.dispose(); this.workspaces.clear() }
}
