const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('officeFlowDrop', {
  expand: () => ipcRenderer.send('drop-overlay-expand'),
  collapse: () => ipcRenderer.send('drop-overlay-collapse'),
  submit: (filePaths) => ipcRenderer.invoke('drop-overlay-submit', filePaths),
  getPathForFile: (file) => {
    if (webUtils?.getPathForFile) return webUtils.getPathForFile(file)
    return file?.path || ''
  },
  onStateChanged: (callback) => {
    ipcRenderer.on('drop-overlay-state', (event, state) => callback(state))
  },
})
