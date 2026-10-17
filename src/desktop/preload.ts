/**
 * Preload — runs in an isolated world with `require('electron')` available,
 * but only the `contextBridge` surface ends up on `window.hanekawa`.
 *
 * Keeping the surface narrow is not just hygiene: a renderer that can call
 * arbitrary IPC is a renderer that bypasses the whole `SessionHost` model.
 * The renderer can post/listen for messages and read its host platform;
 * runtime decisions stay with the host.
 *
 * Source bytes for this file travel through esbuild (see `package.json`'s
 * `build:desktop`), not `tsc -p tsconfig.build.json`, so it is excluded from
 * that build — and from the base `tsconfig.json`, since it needs the DOM lib.
 * `tsconfig.preload.json` is what typechecks it.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DesktopBridge } from './types.js'
import {
  ELECTRON_RUNTIME_CHANNEL,
  type RendererIpcListener,
  type RendererSideIpc,
} from './ipc/electronChannel.js'

// A plain annotation, not `as unknown as`: the real `ipcRenderer` is
// structurally assignable to `RendererSideIpc`, and keeping it checkable is
// what stops this file from drifting away from the Electron API again.
const ipc: RendererSideIpc = ipcRenderer

const bridge: DesktopBridge = {
  platform: process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',
  pathForFile: (file) => webUtils.getPathForFile(file),
  send: (message) => {
    ipc.send(ELECTRON_RUNTIME_CHANNEL, message)
  },
  onMessage: (handler) => {
    const listener: RendererIpcListener = (_event, message) => {
      handler(message)
    }
    ipc.on(ELECTRON_RUNTIME_CHANNEL, listener)
    // `ipcRenderer.on` returns `this`, not an unsubscriber — calling its
    // return value is a TypeError. `removeListener` is the real API.
    return () => {
      ipc.removeListener(ELECTRON_RUNTIME_CHANNEL, listener)
    }
  },
  close: () => {
    // Nothing cross-world happens here, and nothing should: under
    // `contextIsolation` the preload's `window` is a different object from the
    // renderer's, so dispatching a synthetic `pagehide` here would never reach
    // the listener `createBridgeChannel` installs. The renderer's own channel
    // fires its close handlers locally, and the *main* side learns the
    // renderer is gone from `webContents.on('destroyed')`. All this has to do
    // is stop delivering.
    ipcRenderer.removeAllListeners(ELECTRON_RUNTIME_CHANNEL)
  },
}

contextBridge.exposeInMainWorld('hanekawa', bridge)
