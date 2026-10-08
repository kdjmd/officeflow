const { contextBridge, ipcRenderer, webUtils } = require('electron')

const invokeChannels = new Set([
  'open-file-dialog', 'cancel-task', 'process-files', 'open-output-folder',
  'get-output-files', 'open-path', 'show-item-in-folder', 'get-app-settings',
  'set-launch-at-login', 'set-output-dir', 'reset-output-dir',
  'check-python-deps', 'install-python-deps',
  'table-analyze', 'table-export', 'table-ai-enhance', 'table-cancel',
  'list-table-presets', 'save-table-preset', 'delete-table-preset', 'use-table-preset',
  'get-ai-settings', 'save-ai-provider', 'delete-ai-provider', 'test-ai-provider',
])
const sendChannels = new Set(['window-minimize', 'window-maximize', 'window-close'])
const eventChannels = new Set(['task-progress', 'table-progress', 'external-files-dropped'])

function checkChannel(channels, channel) {
  if (!channels.has(channel)) throw new Error('Unsupported IPC channel')
}

contextBridge.exposeInMainWorld('officeFlow', {
  invoke(channel, ...args) {
    checkChannel(invokeChannels, channel)
    return ipcRenderer.invoke(channel, ...args)
  },
  send(channel, ...args) {
    checkChannel(sendChannels, channel)
    ipcRenderer.send(channel, ...args)
  },
  subscribe(channel, callback) {
    checkChannel(eventChannels, channel)
    if (typeof callback !== 'function') throw new Error('Invalid event callback')
    const listener = (event, data) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  getPathForFile(file) {
    return webUtils.getPathForFile(file)
  },
})
