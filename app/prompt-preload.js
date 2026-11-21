const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('moonshinePrompt', {
  onShow: (cb) => ipcRenderer.on('prompt:show', (_e, spec) => cb(spec)),
  respond: (result) => ipcRenderer.invoke('prompt:respond', result),
});
