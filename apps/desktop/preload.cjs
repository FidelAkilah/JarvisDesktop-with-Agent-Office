const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  onCommand: (cb) => ipcRenderer.on('jarvis-cmd', (_e, cmd) => cb(cmd)),
  getSettings: () => ipcRenderer.invoke('jarvis-get-settings'),
  applySettings: (payload) => ipcRenderer.invoke('jarvis-apply-settings', payload),
});
