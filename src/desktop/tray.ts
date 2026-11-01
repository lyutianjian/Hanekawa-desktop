import type { MenuItemConstructorOptions, NativeImage, Tray } from 'electron'
import type { WireMenuAction } from './shellProtocol.js'

export interface TrayPort {
  loadImage(path: string): NativeImage
  create(image: NativeImage): Tray
  setMenu(tray: Tray, template: MenuItemConstructorOptions[]): void
}

export class DesktopTray {
  private tray: Tray | undefined
  private explained = false

  constructor(
    private readonly port: TrayPort,
    private readonly actions: {
      available(): boolean
      show(): void
      run(action: WireMenuAction): void
      quit(): void
      error(error: unknown): void
    },
  ) {}

  create(platform: string, path: string): void {
    if (platform !== 'win32' || this.tray) return
    let tray: Tray | undefined
    const run = (action: () => void) => () => {
      if (this.actions.available()) action()
    }
    try {
      const image = this.port.loadImage(path)
      if (image.isEmpty()) throw new Error('托盘图标为空或无法加载')
      tray = this.port.create(image)
      tray.setToolTip('Hanekawa')
      this.port.setMenu(tray, [
        { label: '显示 Hanekawa', click: run(() => this.actions.show()) },
        { label: '新建会话', click: run(() => this.actions.run('new-session')) },
        { label: '打开项目…', click: run(() => this.actions.run('open-project')) },
        { type: 'separator' },
        { label: '退出 Hanekawa', click: () => this.actions.quit() },
      ])
      tray.on('click', run(() => this.actions.show()))
      this.tray = tray
    } catch (error) {
      tray?.destroy()
      this.actions.error(error)
    }
  }

  isAvailable(): boolean {
    return this.tray !== undefined && !this.tray.isDestroyed()
  }

  explainBackground(): void {
    if (!this.isAvailable() || this.explained) return
    this.explained = true
    try {
      this.tray?.displayBalloon({ title: 'Hanekawa 仍在运行', content: '任务会在后台继续。点击托盘图标恢复窗口，从托盘菜单退出应用。' })
    } catch (error) {
      this.actions.error(error)
    }
  }

  dispose(): void {
    this.tray?.destroy()
    this.tray = undefined
  }
}
