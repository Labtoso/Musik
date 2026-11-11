const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('musikDesktop', {
  connect: (server) => ipcRenderer.invoke('musik:connect', server),
  changeServer: () => ipcRenderer.invoke('musik:change-server')
});
