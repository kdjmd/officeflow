const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
let api
const listeners = new Map()
const electron = {
  contextBridge: { exposeInMainWorld(name, value) { assert.strictEqual(name, 'officeFlow'); api = value } },
  ipcRenderer: {
    invoke(channel, ...args) { return { channel, args } },
    send() {},
    on(channel, listener) { listeners.set(channel, listener) },
    removeListener(channel, listener) { if (listeners.get(channel) === listener) listeners.delete(channel) },
  },
  webUtils: { getPathForFile() { return 'synthetic-file.txt' } },
}
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'app-source', 'main-preload.js'), 'utf8'), {
  require(name) { assert.strictEqual(name, 'electron'); return electron },
})
assert.strictEqual(api.invoke('get-app-settings').channel, 'get-app-settings')
assert.throws(() => api.invoke('arbitrary-channel'), /Unsupported IPC/)
assert.throws(() => api.send('process-files'), /Unsupported IPC/)
assert.throws(() => api.subscribe('unknown', () => {}), /Unsupported IPC/)
let received
const unsubscribe = api.subscribe('table-progress', value => { received = value })
listeners.get('table-progress')({ dangerous: true }, { percent: 50 })
assert.deepStrictEqual(received, { percent: 50 })
unsubscribe()
assert.strictEqual(listeners.size, 0)
assert.strictEqual(api.getPathForFile({}), 'synthetic-file.txt')
assert.strictEqual(api.require, undefined)
console.log('Main preload whitelist tests: OK')
