const assert = require('assert')
const fs = require('fs')
const path = require('path')

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function loaded(window) {
  if (!window.webContents.isLoading() && window.webContents.getURL().includes('.html')) return
  await Promise.race([
    new Promise((resolve, reject) => {
      window.webContents.once('did-finish-load', resolve)
      window.webContents.once('did-fail-load', (event, code, description) => reject(new Error(description)))
    }),
    delay(15000).then(() => { throw new Error('Renderer load timeout') }),
  ])
}

module.exports = async function runSmoke({ app, mainWindow, dropOverlayWindow, reportPath, getMonitorReady }) {
  const directory = path.dirname(reportPath)
  fs.mkdirSync(directory, { recursive: true })
  mainWindow.webContents.setBackgroundThrottling(false)
  await loaded(mainWindow)
  await loaded(dropOverlayWindow)
  const preferences = mainWindow.webContents.getLastWebPreferences()
  assert.strictEqual(preferences.nodeIntegration, false)
  assert.strictEqual(preferences.contextIsolation, true)
  assert.strictEqual(preferences.sandbox, true)
  const ui = await mainWindow.webContents.executeJavaScript(`({
    requireHidden: typeof window.require === 'undefined',
    apiReady: typeof window.officeFlow?.invoke === 'function',
    homeReady: document.querySelector('.hero__title')?.textContent.includes('OfficeFlow'),
    stylesLoaded: getComputedStyle(document.body).fontFamily.length > 0,
  })`)
  assert(ui.requireHidden && ui.apiReady && ui.homeReady && ui.stylesLoaded, 'Main renderer failed')
  const invoke = (channel, ...args) => mainWindow.webContents.executeJavaScript(
    'window.officeFlow.invoke(' + JSON.stringify(channel) + ',' + args.map(value => JSON.stringify(value)).join(',') + ')'
  )
  const python = await invoke('check-python-deps')
  assert(python.ok && python.bundled, 'Bundled Python dependencies unavailable')
  const settings = await invoke('get-app-settings')
  assert(settings.configPath.startsWith(directory), 'Smoke settings escaped the isolated directory')
  const fixture = path.join(directory, '学生会活动安排示例.txt')
  fs.writeFileSync(fixture, '事项：会场布置\n负责人：同学甲\n截止时间：2026-10-10\n状态：待确认\n\n事项：物资确认\n负责人：同学乙\n截止时间：2026-10-09\n状态：进行中\n')
  const analysis = await invoke('table-analyze', { files: [fixture], mode: 'auto', useAi: false })
  assert(analysis.ok && analysis.rows.length === 2, 'Local table analysis failed')
  const exported = await invoke('table-export', {
    jobId: analysis.jobId, format: 'xlsx', tableData: { columns: analysis.columns, rows: analysis.rows },
  })
  assert(exported.ok && fs.existsSync(exported.outputPath), 'XLSX export failed')
  async function screenshot(name) {
    // Hidden-window captures can otherwise retain the preceding transition frame.
    // Finish finite animations at their real end state; never change application CSS.
    await mainWindow.webContents.executeJavaScript("document.getAnimations().forEach(a => { if (Number.isFinite(a.effect?.getTiming().iterations)) { try { a.finish() } catch (_) {} } })")
    mainWindow.webContents.invalidate()
    await mainWindow.webContents.capturePage()
    await delay(200)
    const image = await mainWindow.webContents.capturePage()
    fs.writeFileSync(path.join(directory, name), image.toPNG())
  }
  await screenshot('main-window.png')
  await mainWindow.webContents.executeJavaScript('selectedFiles=' + JSON.stringify([fixture]) + ";showPage('upload')")
  await screenshot('upload.png')
  await mainWindow.webContents.executeJavaScript("selectedTask='document-to-table';tableState=createEmptyTableState();showPage('table-workbench');setTableMode('smart');updateTableGoal('将活动筹备材料整理为可执行的工作安排')")
  await screenshot('table-setup.png')
  await mainWindow.webContents.executeJavaScript('tableState=createEmptyTableState();applyTableResponse(' + JSON.stringify(analysis) + ");tableState.stage='preview';showPage('table-workbench')")
  assert(await mainWindow.webContents.executeJavaScript("tableState.totalRows === 2 && document.getElementById('content').textContent.includes('表格预览')"), 'Actual table preview did not render')
  await screenshot('table-preview.png')
  await mainWindow.webContents.executeJavaScript("showPage('settings')")
  await delay(500)
  assert(await mainWindow.webContents.executeJavaScript("Boolean(document.getElementById('pythonStatusText'))"), 'Settings page failed to render')
  await screenshot('settings.png')
  await invoke('table-cancel', { jobId: analysis.jobId })
  const overlay = await dropOverlayWindow.webContents.executeJavaScript(
    "({apiReady: typeof window.officeFlowDrop?.submit === 'function', requireHidden: typeof window.require === 'undefined'})"
  )
  assert(overlay.apiReady && overlay.requireHidden, 'Drop renderer failed')
  assert(!dropOverlayWindow.isVisible(), 'Drop panel should start hidden')
  // Capture the real panel in an isolated UI state, without simulating a successful file drag.
  dropOverlayWindow.webContents.setBackgroundThrottling(false)
  dropOverlayWindow.setSize(360, 280)
  await dropOverlayWindow.webContents.executeJavaScript("document.body.classList.add('expanded', 'dragging')")
  await dropOverlayWindow.webContents.executeJavaScript("document.getAnimations().forEach(a => { try { a.finish() } catch (_) {} })")
  dropOverlayWindow.webContents.invalidate()
  await dropOverlayWindow.webContents.capturePage()
  await delay(200)
  const overlayImage = await dropOverlayWindow.webContents.capturePage()
  fs.writeFileSync(path.join(directory, 'drop-panel.png'), overlayImage.toPNG())
  for (let attempt = 0; attempt < 50 && !getMonitorReady(); attempt += 1) await delay(100)
  assert(getMonitorReady(), 'Drag monitor did not become ready')
  mainWindow.close()
  assert(!mainWindow.isDestroyed() && !mainWindow.isVisible(), 'Closing window did not preserve background mode')
  const report = {
    ok: true, version: app.getVersion(), electron: process.versions.electron,
    platform: process.platform, arch: process.arch,
    rendererIsolation: true, homeRendered: true, bundledPython: true,
    localTableRows: analysis.rows.length, xlsxExport: true,
    overlayHiddenAtIdle: true, overlayBridgeReady: true,
    dragMonitorReady: true, closeKeepsBackground: true, aiTokensUsed: 0,
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2))
}
