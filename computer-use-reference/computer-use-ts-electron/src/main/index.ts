import { app, BrowserWindow, dialog, ipcMain, protocol, net, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CHANNELS } from '../shared/contracts';
import { parseAct, parseSession, parseStart } from '../shared/validation';
import { result } from '../shared/errors';
import { Manager } from './manager';
import { assertSender } from './sender';

protocol.registerSchemesAsPrivileged([{ scheme: 'cu-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
let window: BrowserWindow | undefined;
let manager: Manager;
let exiting = false;
const ENTRY = 'cu-app://ui/index.html';

function validateSender(event: IpcMainInvokeEvent): number {
  const owner = window?.webContents;
  assertSender({ senderId: event.sender.id, ownerId: owner?.id ?? -1,
    isMainFrame: !!owner && event.senderFrame === owner.mainFrame,
    url: event.senderFrame?.url ?? '' });
  return event.sender.id;
}
function registerIPC() {
  ipcMain.handle(CHANNELS.targets, event => result(() => { validateSender(event); return manager.targets(); }));
  ipcMain.handle(CHANNELS.start, (event, input: unknown) => result(async () => {
    const owner = validateSender(event);
    const info = await manager.start(owner, parseStart(input));
    // Owner could have disappeared while the authorization dialog was open.
    if (event.sender.isDestroyed() || !window || window.isDestroyed()) {
      await manager.cancel(owner, info.id);
      throw new Error('Owner closed');
    }
    return info;
  }));
  ipcMain.handle(CHANNELS.observe, (event, input: unknown) => result(() => {
    const owner = validateSender(event); return manager.get(owner, parseSession(input).sessionId).observe();
  }));
  ipcMain.handle(CHANNELS.act, (event, input: unknown) => result(() => {
    const owner = validateSender(event); const parsed = parseAct(input);
    return manager.get(owner, parsed.sessionId).act(parsed.action);
  }));
  ipcMain.handle(CHANNELS.cancel, (event, input: unknown) => result(() => {
    const owner = validateSender(event); return manager.cancel(owner, parseSession(input).sessionId);
  }));
}

async function createWindow() {
  const rendererDir = path.join(__dirname, '../renderer');
  // Exact static file allowlist: the custom protocol is not a filesystem proxy.
  const files: Record<string, string> = { '/index.html': 'index.html', '/index.js': 'index.js', '/style.css': 'style.css' };
  protocol.handle('cu-app', request => {
    const url = new URL(request.url);
    const file = url.host === 'ui' && !url.search && !url.hash ? files[url.pathname] : undefined;
    if (request.method !== 'GET' || !file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(path.join(rendererDir, file)).href);
  });
  window = new BrowserWindow({ width: 1100, height: 780, title: 'Computer Use · TS + Electron',
    webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  contents.session.setPermissionCheckHandler(() => false);
  // A reload, renderer crash or destroyed owner invalidates all outstanding sessions.
  contents.on('render-process-gone', () => { void manager.closeOwner(contents.id); });
  contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) void manager.closeOwner(contents.id);
  });
  window.on('close', event => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    void manager.closeOwner(contents.id).finally(() => { window?.destroy(); app.quit(); });
  });
  await window.loadURL(ENTRY);
}

app.whenReady().then(async () => {
  const helper = app.isPackaged ? path.join(process.resourcesPath, 'bin/mac-ax-bridge') : path.join(app.getAppPath(), 'resources/bin/mac-ax-bridge');
  manager = new Manager(helper, async target => {
    const response = await dialog.showMessageBox(window!, {
      type: 'question', title: '允许访问应用',
      message: `本次会话允许读取并操作 ${target.displayName}？`,
      detail: '仅限已运行的计算器、一个窗口；可随时取消。系统辅助功能权限仍需正常授予。',
      buttons: ['取消', '允许本次会话'], defaultId: 0, cancelId: 0, noLink: true
    });
    return response.response === 1;
  });
  registerIPC();
  await createWindow();
}).catch(() => { console.error('Application startup failed'); app.exit(1); });

app.on('before-quit', event => {
  if (exiting || !manager || !window || window.isDestroyed()) return;
  event.preventDefault(); exiting = true;
  void manager.closeOwner(window.webContents.id).finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());
