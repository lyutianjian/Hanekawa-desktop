import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type AutomationAPI } from '../shared/contracts';
// Bundled into one CJS file. Expose one function per operation, never invoke(channel, payload).
const api: AutomationAPI = {
  targets: () => ipcRenderer.invoke(CHANNELS.targets),
  start: input => ipcRenderer.invoke(CHANNELS.start, input),
  observe: input => ipcRenderer.invoke(CHANNELS.observe, input),
  act: input => ipcRenderer.invoke(CHANNELS.act, input),
  cancel: input => ipcRenderer.invoke(CHANNELS.cancel, input)
};
contextBridge.exposeInMainWorld('automation', Object.freeze(api));
