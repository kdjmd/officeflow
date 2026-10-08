const { app, BrowserWindow, ipcMain, dialog, shell, screen, Tray, Menu, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { createTableServices } = require('./table-services')

function getBaseDir() {
  return app.isPackaged ? path.dirname(app.getPath('exe')) : __dirname
}

const BASE_DIR = getBaseDir()
const DEFAULT_OUTPUT_DIR = path.join(BASE_DIR, '结果')
const CONFIG_PATH = path.join(BASE_DIR, 'officeflow-settings.json')
const LOGIN_ITEM_NAME = 'OfficeFlow'
const LOGIN_ITEM_ARGS = ['--hidden']
const START_HIDDEN = process.argv.includes('--hidden')
const DRAG_MONITOR_DEBUG = process.argv.includes('--drag-debug')
const DROP_OVERLAY_COLLAPSED_WIDTH = 2
const DROP_OVERLAY_COLLAPSED_HEIGHT = 2
const DROP_OVERLAY_EXPANDED_WIDTH = 360
const DROP_OVERLAY_EXPANDED_HEIGHT = 280
const DRAG_MONITOR_RESTART_DELAY_MS = 2000
const DROP_OVERLAY_DROP_HANDOFF_MS = 350
const DROP_OVERLAY_EXIT_ANIMATION_MS = 180
const MAIN_WINDOW_RELEASE_DELAY_MS = 30000

if (process.platform === 'win32') {
  app.setAppUserModelId(LOGIN_ITEM_NAME)
  app.disableHardwareAcceleration()
}

function resourcePath(fileName) {
  const candidate = path.join(__dirname, fileName)
  if (!app.isPackaged) return candidate
  return candidate.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
}

const REQUIREMENTS_PATH = resourcePath('requirements.txt')
const DRAG_MONITOR_PATH = resourcePath('drag-monitor.exe')
const PYTHON_DEP_NAMES = {
  pypdf: 'pypdf',
  reportlab: 'reportlab',
  PIL: 'Pillow',
  fitz: 'PyMuPDF',
  openpyxl: 'openpyxl',
  pdfplumber: 'pdfplumber',
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    }
  } catch (e) {
    console.error('Failed to load settings:', e)
  }
  return {}
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8')
}

let appConfig = loadConfig()
let OUTPUT_DIR = appConfig.outputDir || DEFAULT_OUTPUT_DIR

let mainWindow
let dropOverlayWindow
let tray
let mainWindowReleaseTimer
let dragMonitorProcess
let dragMonitorRestartTimer
let dragMonitorHideTimer
let dropOverlayExitTimer
let isDropOverlayExpanded = false
let isGlobalFileDragActive = false
let dragMonitorAvailable = false
let isQuitting = false
let isProcessingFiles = false
let hasShownBackgroundTip = false
let currentProcess = null
let isCancelled = false
let pythonCommandCache = null
const pythonModuleCache = new Map()

function clearMainWindowReleaseTimer() {
  if (!mainWindowReleaseTimer) return
  clearTimeout(mainWindowReleaseTimer)
  mainWindowReleaseTimer = null
}

function scheduleMainWindowRelease() {
  clearMainWindowReleaseTimer()
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible() || isProcessingFiles) return
  mainWindowReleaseTimer = setTimeout(() => {
    mainWindowReleaseTimer = null
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible() || isProcessingFiles) return
    mainWindow.destroy()
  }, MAIN_WINDOW_RELEASE_DELAY_MS)
}

function showBackgroundTip() {
  if (hasShownBackgroundTip || !tray || tray.isDestroyed() || process.platform !== 'win32') return
  hasShownBackgroundTip = true
  tray.displayBalloon({
    iconType: 'info',
    title: 'OfficeFlow 正在后台运行',
    content: '文件拖到桌面右侧即可处理；需要彻底退出时请使用托盘菜单。',
    noSound: true,
    respectQuietTime: true,
  })
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.hide()
  scheduleMainWindowRelease()
  showBackgroundTip()
}

function createWindow(showWhenReady = true) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      navigateOnDragDrop: false,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    const currentUrl = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : ''
    if (currentUrl && targetUrl !== currentUrl) event.preventDefault()
  })
  mainWindow.once('ready-to-show', () => {
    if (!showWhenReady || !mainWindow || mainWindow.isDestroyed()) return
    clearMainWindowReleaseTimer()
    mainWindow.show()
    mainWindow.focus()
  })
  mainWindow.loadFile(path.join(__dirname, 'index.html'))
  mainWindow.webContents.on('did-finish-load', () => {
    try {
      const cssPath = path.join(__dirname, 'style.css')
      if (fs.existsSync(cssPath)) {
        mainWindow.webContents.insertCSS(fs.readFileSync(cssPath, 'utf-8'))
      }
    } catch (e) { console.error('CSS injection failed:', e) }
  })
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    hideMainWindow()
  })
  mainWindow.on('closed', () => {
    clearMainWindowReleaseTimer()
    mainWindow = null
  })
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: dragMonitorAvailable ? '后台文件拖动监听中' : '正在启动文件拖动监听…', enabled: false },
    { label: '打开 OfficeFlow', click: () => showMainWindow() },
    {
      label: '开机自启动',
      type: 'checkbox',
      checked: getLaunchAtLogin(),
      click: (menuItem) => {
        const result = setLaunchAtLogin(menuItem.checked)
        if (result.ok) {
          appConfig = { ...appConfig, launchAtLogin: result.enabled }
          saveConfig(appConfig)
        }
        updateTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: '退出 OfficeFlow',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]))
}

async function createTray() {
  try {
    const icon = await app.getFileIcon(process.execPath, { size: 'small' })
    tray = new Tray(icon)
    tray.setToolTip(dragMonitorAvailable ? 'OfficeFlow · 后台文件拖动监听中' : 'OfficeFlow · 正在启动拖动监听')
    tray.on('double-click', () => showMainWindow())
    updateTrayMenu()
  } catch (e) {
    console.error('Failed to create tray:', e)
  }
}

function getLaunchAtLogin() {
  if (process.platform !== 'win32' || !app.isPackaged) return false
  try {
    const settings = app.getLoginItemSettings({
      path: process.execPath,
      args: LOGIN_ITEM_ARGS,
    })
    if (settings.openAtLogin) return true

    const expectedPath = path.normalize(process.execPath).toLowerCase()
    return Array.isArray(settings.launchItems) && settings.launchItems.some((item) => {
      const itemPath = path.normalize(item.path || '').toLowerCase()
      const itemArgs = Array.isArray(item.args) ? item.args : []
      return item.name === LOGIN_ITEM_NAME &&
        itemPath === expectedPath &&
        itemArgs.length === LOGIN_ITEM_ARGS.length &&
        itemArgs.every((arg, index) => arg === LOGIN_ITEM_ARGS[index]) &&
        item.enabled !== false
    })
  } catch (e) {
    console.error('Failed to read login item settings:', e)
    return false
  }
}

function setLaunchAtLogin(enabled) {
  if (process.platform !== 'win32' || !app.isPackaged) {
    return { ok: false, enabled: false, error: '当前平台不支持开机自启动' }
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      name: LOGIN_ITEM_NAME,
      path: process.execPath,
      args: LOGIN_ITEM_ARGS,
    })
    const actual = getLaunchAtLogin()
    if (actual !== Boolean(enabled)) {
      return { ok: false, enabled: actual, error: 'Windows 未能保存开机启动设置' }
    }
    return { ok: true, enabled: actual }
  } catch (e) {
    console.error('Failed to update login item settings:', e)
    return { ok: false, enabled: getLaunchAtLogin(), error: e.message }
  }
}

function syncLaunchAtLogin() {
  if (typeof appConfig.launchAtLogin !== 'boolean') {
    appConfig = { ...appConfig, launchAtLogin: true }
    saveConfig(appConfig)
  }
  return setLaunchAtLogin(appConfig.launchAtLogin)
}

function getCollapsedOverlayBounds() {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: workArea.x + workArea.width - DROP_OVERLAY_COLLAPSED_WIDTH,
    y: workArea.y + Math.round((workArea.height - DROP_OVERLAY_COLLAPSED_HEIGHT) / 2),
    width: DROP_OVERLAY_COLLAPSED_WIDTH,
    height: DROP_OVERLAY_COLLAPSED_HEIGHT,
  }
}

function getExpandedOverlayBounds() {
  const cursorPoint = screen.getCursorScreenPoint()
  const { workArea } = screen.getDisplayNearestPoint(cursorPoint)
  const verticalMargin = 16
  const minY = workArea.y + verticalMargin
  const maxY = workArea.y + workArea.height - DROP_OVERLAY_EXPANDED_HEIGHT - verticalMargin
  return {
    // Keep the expanded panel flush with the edge so the drag cursor remains inside it.
    x: workArea.x + workArea.width - DROP_OVERLAY_EXPANDED_WIDTH,
    y: Math.max(minY, Math.min(cursorPoint.y - (DROP_OVERLAY_EXPANDED_HEIGHT / 2), maxY)),
    width: DROP_OVERLAY_EXPANDED_WIDTH,
    height: DROP_OVERLAY_EXPANDED_HEIGHT,
  }
}

function notifyDropOverlayState(expanded) {
  if (dropOverlayWindow && !dropOverlayWindow.isDestroyed()) {
    dropOverlayWindow.webContents.send('drop-overlay-state', { expanded })
  }
}

function expandDropOverlay() {
  if (!dropOverlayWindow || dropOverlayWindow.isDestroyed()) return
  if (dropOverlayExitTimer) {
    clearTimeout(dropOverlayExitTimer)
    dropOverlayExitTimer = null
  }
  if (dragMonitorHideTimer) {
    clearTimeout(dragMonitorHideTimer)
    dragMonitorHideTimer = null
  }
  if (isDropOverlayExpanded && dropOverlayWindow.isVisible()) return
  isDropOverlayExpanded = true
  dropOverlayWindow.setBounds(getExpandedOverlayBounds(), true)
  if (!dropOverlayWindow.isVisible()) dropOverlayWindow.showInactive()
  notifyDropOverlayState(true)
}

function collapseDropOverlay(force = false) {
  if (!dropOverlayWindow || dropOverlayWindow.isDestroyed()) return
  if (!force && isGlobalFileDragActive) return
  isDropOverlayExpanded = false
  notifyDropOverlayState(false)
  if (dropOverlayExitTimer) clearTimeout(dropOverlayExitTimer)
  const finishCollapse = () => {
    dropOverlayExitTimer = null
    if (!dropOverlayWindow || dropOverlayWindow.isDestroyed() || isDropOverlayExpanded) return
    dropOverlayWindow.hide()
    dropOverlayWindow.setBounds(getCollapsedOverlayBounds(), false)
  }
  if (dropOverlayWindow.isVisible()) {
    dropOverlayExitTimer = setTimeout(finishCollapse, DROP_OVERLAY_EXIT_ANIMATION_MS)
  } else {
    finishCollapse()
  }
}

function createDropOverlayWindow() {
  dropOverlayWindow = new BrowserWindow({
    ...getCollapsedOverlayBounds(),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'drop-overlay-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      navigateOnDragDrop: false,
    },
  })
  dropOverlayWindow.setAlwaysOnTop(true, 'screen-saver')
  dropOverlayWindow.loadFile(path.join(__dirname, 'drop-overlay.html'))
  dropOverlayWindow.once('ready-to-show', () => {
    if (!dropOverlayWindow || dropOverlayWindow.isDestroyed()) return
    notifyDropOverlayState(false)
  })
  dropOverlayWindow.on('closed', () => { dropOverlayWindow = null })
}

function handleDragMonitorEvent(eventName) {
  if (eventName === 'ready') {
    dragMonitorAvailable = true
    updateTrayMenu()
    return
  }

  if (eventName === 'drag-start') {
    isGlobalFileDragActive = true
    expandDropOverlay()
    return
  }

  if (eventName === 'drag-end') {
    isGlobalFileDragActive = false
    if (dragMonitorHideTimer) clearTimeout(dragMonitorHideTimer)
    const cursorPoint = screen.getCursorScreenPoint()
    const overlayBounds = dropOverlayWindow && !dropOverlayWindow.isDestroyed()
      ? dropOverlayWindow.getBounds()
      : null
    const releasedOnOverlay = Boolean(overlayBounds && isDropOverlayExpanded &&
      cursorPoint.x >= overlayBounds.x && cursorPoint.x < overlayBounds.x + overlayBounds.width &&
      cursorPoint.y >= overlayBounds.y && cursorPoint.y < overlayBounds.y + overlayBounds.height)

    if (!releasedOnOverlay) {
      collapseDropOverlay(true)
      return
    }

    // Mouse-up precedes Chromium's drop event. Only releases over the panel get
    // a short hand-off; all ordinary Explorer/Desktop repositioning hides now.
    dragMonitorHideTimer = setTimeout(() => {
      dragMonitorHideTimer = null
      collapseDropOverlay(true)
    }, DROP_OVERLAY_DROP_HANDOFF_MS)
  }
}

function scheduleDragMonitorRestart() {
  if (isQuitting || dragMonitorRestartTimer || process.platform !== 'win32') return
  dragMonitorRestartTimer = setTimeout(() => {
    dragMonitorRestartTimer = null
    startDragMonitor()
  }, DRAG_MONITOR_RESTART_DELAY_MS)
}

function startDragMonitor() {
  if (process.platform !== 'win32' || isQuitting || dragMonitorProcess) return
  if (!fs.existsSync(DRAG_MONITOR_PATH)) {
    console.error('Drag monitor helper is missing:', DRAG_MONITOR_PATH)
    dragMonitorAvailable = false
    updateTrayMenu()
    return
  }

  const helperArgs = [String(process.pid)]
  if (DRAG_MONITOR_DEBUG) helperArgs.push('--debug')
  const child = spawn(DRAG_MONITOR_PATH, helperArgs, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  dragMonitorProcess = child
  let stdoutBuffer = ''

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8')
    const lines = stdoutBuffer.split(/\r?\n/)
    stdoutBuffer = lines.pop() || ''
    for (const line of lines) {
      const eventName = line.trim()
      if (eventName.startsWith('error:')) console.error('Drag monitor:', eventName)
      else if (eventName.startsWith('debug:')) {
        if (DRAG_MONITOR_DEBUG) console.log('Drag monitor:', eventName)
      } else if (eventName) {
        if (DRAG_MONITOR_DEBUG) console.log('Drag monitor:', eventName)
        handleDragMonitorEvent(eventName)
      }
    }
  })

  child.stderr.on('data', (chunk) => console.error('Drag monitor stderr:', chunk.toString('utf8').trim()))
  child.on('error', (error) => console.error('Failed to start drag monitor:', error))
  child.on('exit', () => {
    if (dragMonitorProcess !== child) return
    dragMonitorProcess = null
    dragMonitorAvailable = false
    isGlobalFileDragActive = false
    collapseDropOverlay(true)
    updateTrayMenu()
    scheduleDragMonitorRestart()
  })
}

function stopDragMonitor() {
  if (dragMonitorRestartTimer) clearTimeout(dragMonitorRestartTimer)
  if (dragMonitorHideTimer) clearTimeout(dragMonitorHideTimer)
  if (dropOverlayExitTimer) clearTimeout(dropOverlayExitTimer)
  dragMonitorRestartTimer = null
  dragMonitorHideTimer = null
  dropOverlayExitTimer = null
  dragMonitorAvailable = false
  isGlobalFileDragActive = false
  const child = dragMonitorProcess
  dragMonitorProcess = null
  if (child && !child.killed) {
    try { child.kill() } catch (e) {}
  }
}

function showMainWindow(filePaths) {
  clearMainWindowReleaseTimer()
  const needsCreate = !mainWindow || mainWindow.isDestroyed()
  if (needsCreate) createWindow(true)

  const targetWindow = mainWindow
  const revealAndDispatch = () => {
    if (!targetWindow || targetWindow.isDestroyed() || mainWindow !== targetWindow) return
    if (targetWindow.isMinimized()) targetWindow.restore()
    targetWindow.show()
    targetWindow.focus()
    if (Array.isArray(filePaths) && filePaths.length > 0) {
      targetWindow.webContents.send('external-files-dropped', filePaths)
    }
  }

  // Register before checking the loading state so a very fast local load cannot
  // slip between the check and listener registration and leave the window hidden.
  targetWindow.webContents.once('did-finish-load', revealAndDispatch)
  if (!targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.removeListener('did-finish-load', revealAndDispatch)
    revealAndDispatch()
  }
}

function normalizeDroppedFilePaths(filePaths) {
  if (!Array.isArray(filePaths)) return []
  const uniquePaths = new Set()
  for (const candidate of filePaths.slice(0, 100)) {
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 32767) continue
    const normalized = path.resolve(candidate)
    try {
      if (fs.statSync(normalized).isFile()) uniquePaths.add(normalized)
    } catch (e) {}
  }
  return [...uniquePaths]
}

function isDropOverlaySender(event) {
  return Boolean(
    dropOverlayWindow &&
    !dropOverlayWindow.isDestroyed() &&
    event.sender === dropOverlayWindow.webContents
  )
}

function send(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  let index = 1
  let candidate = path.join(dir, `${base}_${index}${ext}`)
  while (fs.existsSync(candidate)) {
    index += 1
    candidate = path.join(dir, `${base}_${index}${ext}`)
  }
  return candidate
}

function outputFilePath(inputFile, suffix, ext) {
  const name = path.basename(inputFile, path.extname(inputFile))
  return uniquePath(path.join(OUTPUT_DIR, `${name}${suffix || ''}${ext}`))
}

function escapePS(s) {
  return String(s).replace(/'/g, "''")
}

function runPowerShell(psScript, timeoutMs) {
  return new Promise((resolve) => {
    const script = `
      [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
      $OutputEncoding = [System.Text.Encoding]::UTF8
      ${psScript}
    `
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script
    ], { timeout: timeoutMs || 60000, encoding: 'utf-8' })

    currentProcess = child
    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })

    child.on('close', (code) => {
      currentProcess = null
      const output = stdout.trim()
      if (output.startsWith('OK:')) {
        resolve({ ok: true, path: output.substring(3) })
      } else {
        resolve({ ok: false, error: output || stderr || `Exit code: ${code}` })
      }
    })

    child.on('error', (err) => {
      currentProcess = null
      resolve({ ok: false, error: err.message })
    })
  })
}

// ==================== CONVERTERS ====================

async function convertWordToPdf(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在打开 Word...', percent: Math.round((index / total) * 80) })
  const outPath = outputFilePath(inputFile, '', '.pdf')
  const ps = `
    $ErrorActionPreference = "Stop"
    $w = New-Object -ComObject Word.Application
    $w.Visible = $false; $w.DisplayAlerts = 0
    $w.AutomationSecurity = 3
    $w.Options.UpdateLinksAtOpen = $false
    try {
      $d = $w.Documents.Open('${escapePS(path.resolve(inputFile))}', $false, $true, $false)
      $d.SaveAs2('${escapePS(path.resolve(outPath))}', 17)
      $d.Close(0)
      Write-Output 'OK:${escapePS(outPath)}'
    } catch { Write-Output "ERR:$($_.Exception.Message)" }
    finally { try { $w.Quit() } catch {}; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null }
  `
  return runPowerShell(ps, 60000)
}

async function convertWordToText(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在提取文本...', percent: Math.round((index / total) * 80) })
  const outPath = outputFilePath(inputFile, '', '.txt')
  const ps = `
    $ErrorActionPreference = "Stop"
    $w = New-Object -ComObject Word.Application
    $w.Visible = $false; $w.DisplayAlerts = 0
    $w.AutomationSecurity = 3
    $w.Options.UpdateLinksAtOpen = $false
    try {
      $d = $w.Documents.Open('${escapePS(path.resolve(inputFile))}', $false, $true, $false)
      $d.SaveAs2('${escapePS(path.resolve(outPath))}', 2)
      $d.Close(0)
      Write-Output 'OK:${escapePS(outPath)}'
    } catch { Write-Output "ERR:$($_.Exception.Message)" }
    finally { try { $w.Quit() } catch {}; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null }
  `
  return runPowerShell(ps, 60000)
}

async function convertExcelToCsv(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在转换 CSV...', percent: Math.round((index / total) * 80) })
  const outPath = outputFilePath(inputFile, '', '.csv')
  const ps = `
    $ErrorActionPreference = "Stop"
    $x = New-Object -ComObject Excel.Application
    $x.Visible = $false; $x.DisplayAlerts = $false
    $x.AutomationSecurity = 3
    $x.AskToUpdateLinks = $false
    try {
      $wb = $x.Workbooks.Open('${escapePS(path.resolve(inputFile))}', 0, $true)
      $wb.SaveAs('${escapePS(path.resolve(outPath))}', 23)
      $wb.Close($false)
      Write-Output 'OK:${escapePS(outPath)}'
    } catch { Write-Output "ERR:$($_.Exception.Message)" }
    finally { try { $x.Quit() } catch {}; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($x) | Out-Null }
  `
  return runPowerShell(ps, 60000)
}

async function convertExcelToPdf(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在导出 PDF...', percent: Math.round((index / total) * 80) })
  const outPath = outputFilePath(inputFile, '', '.pdf')
  const ps = `
    $ErrorActionPreference = "Stop"
    $x = New-Object -ComObject Excel.Application
    $x.Visible = $false; $x.DisplayAlerts = $false
    $x.AutomationSecurity = 3
    $x.AskToUpdateLinks = $false
    try {
      $wb = $x.Workbooks.Open('${escapePS(path.resolve(inputFile))}', 0, $true)
      $wb.ExportAsFixedFormat(0, '${escapePS(path.resolve(outPath))}')
      $wb.Close($false)
      Write-Output 'OK:${escapePS(outPath)}'
    } catch { Write-Output "ERR:$($_.Exception.Message)" }
    finally { try { $x.Quit() } catch {}; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($x) | Out-Null }
  `
  return runPowerShell(ps, 60000)
}

async function convertPptToPdf(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在转换 PPT...', percent: Math.round((index / total) * 80) })
  const outPath = outputFilePath(inputFile, '', '.pdf')
  const ps = `
    $ErrorActionPreference = "Stop"
    $p = New-Object -ComObject PowerPoint.Application
    $p.AutomationSecurity = 3
    try {
      $pres = $p.Presentations.Open('${escapePS(path.resolve(inputFile))}', -1, 0, 0)
      $pres.SaveAs('${escapePS(path.resolve(outPath))}', 32)
      $pres.Close()
      Write-Output 'OK:${escapePS(outPath)}'
    } catch { Write-Output "ERR:$($_.Exception.Message)" }
    finally { try { $p.Quit() } catch {}; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($p) | Out-Null }
  `
  return runPowerShell(ps, 60000)
}

async function convertPptToImages(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在导出幻灯片...', percent: Math.round((index / total) * 80) })
  const name = path.basename(inputFile, path.extname(inputFile))
  const ps = `
    $ErrorActionPreference = "Stop"
    $p = New-Object -ComObject PowerPoint.Application
    $p.AutomationSecurity = 3
    try {
      $pres = $p.Presentations.Open('${escapePS(path.resolve(inputFile))}', -1, 0, 0)
      $count = $pres.Slides.Count
      $results = @()
      for ($i = 1; $i -le $count; $i++) {
        $outPath = Join-Path '${escapePS(OUTPUT_DIR)}' ('${escapePS(name)}_slide' + $i + '.png')
        $pres.Slides($i).Export($outPath, 'PNG', 1920, 1080)
        $results += $outPath
      }
      $pres.Close()
      Write-Output ('OK:' + ($results -join '|'))
    } catch { Write-Output "ERR:$($_.Exception.Message)" }
    finally { try { $p.Quit() } catch {}; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($p) | Out-Null }
  `
  return runPowerShell(ps, 120000)
}

async function convertPdfToText(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在提取 PDF 文字...', percent: Math.round((index / total) * 80) })
  const outPath = outputFilePath(inputFile, '', '.txt')
  const ps = `
    $ErrorActionPreference = "Stop"
    $w = New-Object -ComObject Word.Application
    $w.Visible = $false; $w.DisplayAlerts = 0
    $w.AutomationSecurity = 3
    $w.Options.UpdateLinksAtOpen = $false
    try {
      $doc = $w.Documents.Open('${escapePS(path.resolve(inputFile))}', $false, $true, $false)
      $doc.SaveAs2('${escapePS(path.resolve(outPath))}', 2)
      $doc.Close(0)
      Write-Output 'OK:${escapePS(outPath)}'
    } catch { Write-Output "ERR:$($_.Exception.Message)" }
    finally { try { $w.Quit() } catch {}; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null }
  `
  return runPowerShell(ps, 60000)
}

async function convertPdfToImages(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在将 PDF 页面导出为图片...', percent: Math.round((index / total) * 80) })
  const pyScript = resourcePath('pdf_utils.py')
  return runPython(pyScript, ['render', path.resolve(inputFile), path.resolve(OUTPUT_DIR), '2'], 120000, ['pypdf', 'fitz'])
}

async function runOcr(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在进行 OCR 识别...', percent: Math.round((index / total) * 80) })
  const psPath = resourcePath('ocr.ps1')
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', psPath,
      '-InputFile', path.resolve(inputFile),
      '-OutputDir', OUTPUT_DIR
    ], { timeout: 60000, encoding: 'utf-8' })

    currentProcess = child
    let stdout = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', () => {})
    child.on('close', () => {
      currentProcess = null
      const output = stdout.trim()
      if (output.startsWith('OK:')) {
        resolve({ ok: true, path: output.substring(3) })
      } else {
        resolve({ ok: false, error: output || 'OCR failed' })
      }
    })
    child.on('error', (err) => {
      currentProcess = null
      resolve({ ok: false, error: err.message })
    })
  })
}

const converters = {
  'word-to-pdf': convertWordToPdf,
  'word-extract': convertWordToText,
  'excel-csv': convertExcelToCsv,
  'excel-pdf': convertExcelToPdf,
  'ppt-pdf': convertPptToPdf,
  'ppt-images': convertPptToImages,
  'pdf-text': convertPdfToText,
  'pdf-images': convertPdfToImages,
  'ocr-text': runOcr,
}

// ==================== NEW FEATURES: PDF & IMAGE ====================

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      timeout: timeoutMs || 120000,
      encoding: 'utf-8'
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
    child.on('error', (err) => resolve({ code: -1, stdout: '', stderr: err.message }))
  })
}

async function resolvePythonCommand() {
  if (pythonCommandCache) return pythonCommandCache

  const candidates = [
    { command: 'python.exe', prefix: [] },
    { command: 'py.exe', prefix: ['-3'] },
  ]

  for (const candidate of candidates) {
    const result = await runProcess(candidate.command, [...candidate.prefix, '--version'], 10000)
    if (result.code === 0) {
      pythonCommandCache = candidate
      return candidate
    }
  }

  return null
}

async function checkPythonModules(modules, refresh) {
  const key = modules.slice().sort().join('|')
  if (!refresh && pythonModuleCache.has(key)) return pythonModuleCache.get(key)

  const python = await resolvePythonCommand()
  if (!python) {
    const result = { ok: false, missing: modules, error: '未找到 Python 3，请先安装 Python 并勾选 Add python.exe to PATH。' }
    pythonModuleCache.set(key, result)
    return result
  }

  const code = [
    'import importlib.util, sys',
    'missing = [m for m in sys.argv[1:] if importlib.util.find_spec(m) is None]',
    'print("|".join(missing))',
    'sys.exit(1 if missing else 0)',
  ].join('; ')
  const result = await runProcess(python.command, [...python.prefix, '-c', code, ...modules], 10000)
  const missing = result.stdout ? result.stdout.split('|').filter(Boolean) : []
  const error = missing.length
    ? `缺少 Python 依赖：${missing.map(m => PYTHON_DEP_NAMES[m] || m).join(', ')}`
    : (result.code === 0 ? '' : (result.stderr || result.stdout || 'Python 依赖检查失败'))
  const status = {
    ok: result.code === 0,
    missing,
    error,
    command: python.command === 'py.exe' ? 'py -3' : 'python',
  }
  pythonModuleCache.set(key, status)
  return status
}

async function runPython(script, args, timeoutMs, requiredModules) {
  const modules = requiredModules || []
  if (modules.length) {
    const deps = await checkPythonModules(modules)
    if (!deps.ok) {
      return {
        ok: false,
        error: `${deps.error}。可在“设置”里一键安装依赖，或手动执行：${deps.command || 'python'} -m pip install -r "${REQUIREMENTS_PATH}"`,
      }
    }
  }

  const python = await resolvePythonCommand()
  if (!python) {
    return { ok: false, error: '未找到 Python 3，请先安装 Python 并勾选 Add python.exe to PATH。' }
  }

  return new Promise((resolve) => {
    const child = spawn(python.command, [...python.prefix, script, ...args], {
      timeout: timeoutMs || 120000,
      encoding: 'utf-8'
    })
    currentProcess = child
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('close', (code) => {
      currentProcess = null
      const output = stdout.trim()
      if (output.startsWith('OK:')) {
        resolve({ ok: true, path: output.substring(3) })
      } else {
        resolve({ ok: false, error: output.replace(/^ERR:/, '') || stderr.trim() || `Python script failed (${code})` })
      }
    })
    child.on('error', (err) => {
      currentProcess = null
      resolve({ ok: false, error: err.message })
    })
  })
}

async function mergePdfs(inputFiles, index, total) {
  send('task-progress', { file: `${inputFiles.length} 个PDF`, step: '正在合并PDF...', percent: 50 })
  const outPath = uniquePath(path.join(OUTPUT_DIR, 'merged.pdf'))
  const pyScript = resourcePath('pdf_utils.py')
  const fileArgs = inputFiles.map(f => path.resolve(f)).join('|')
  return runPython(pyScript, ['merge', fileArgs, path.resolve(outPath)], 120000, ['pypdf'])
}

async function splitPdf(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在拆分PDF...', percent: 50 })
  const pyScript = resourcePath('pdf_utils.py')
  return runPython(pyScript, ['split', path.resolve(inputFile), path.resolve(OUTPUT_DIR), 'all'], 120000, ['pypdf'])
}

async function addPdfWatermark(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在添加水印...', percent: 50 })
  const outPath = outputFilePath(inputFile, '_watermark', '.pdf')
  const pyScript = resourcePath('pdf_utils.py')
  return runPython(pyScript, ['watermark', path.resolve(inputFile), path.resolve(outPath), 'CONFIDENTIAL'], 120000, ['pypdf', 'reportlab'])
}

async function compressPdf(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在压缩PDF...', percent: Math.round((index / total) * 80) })
  const outPath = outputFilePath(inputFile, '_compressed', '.pdf')
  const pyScript = resourcePath('pdf_utils.py')
  return runPython(pyScript, ['compress', path.resolve(inputFile), path.resolve(outPath)], 120000, ['pypdf'])
}

async function rotatePdf(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在旋转PDF页面...', percent: Math.round((index / total) * 80) })
  const outPath = outputFilePath(inputFile, '_rotated', '.pdf')
  const pyScript = resourcePath('pdf_utils.py')
  return runPython(pyScript, ['rotate', path.resolve(inputFile), path.resolve(outPath), '90'], 120000, ['pypdf'])
}

async function imagesToPdf(inputFiles, index, total) {
  send('task-progress', { file: `${inputFiles.length} 张图片`, step: '正在生成PDF...', percent: 50 })
  const outPath = uniquePath(path.join(OUTPUT_DIR, 'images.pdf'))
  const pyScript = resourcePath('img_utils.py')
  const fileArgs = inputFiles.map(f => path.resolve(f)).join('|')
  return runPython(pyScript, ['to-pdf', fileArgs, path.resolve(outPath)], 120000, ['PIL'])
}

async function compressImage(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在压缩图片...', percent: Math.round((index / total) * 80) })
  const name = path.basename(inputFile, path.extname(inputFile))
  const outPath = uniquePath(path.join(OUTPUT_DIR, name + '_compressed' + path.extname(inputFile)))
  const pyScript = resourcePath('img_utils.py')
  return runPython(pyScript, ['compress', path.resolve(inputFile), path.resolve(outPath), '75'], 60000, ['PIL'])
}

async function convertImageFormat(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在转换格式...', percent: Math.round((index / total) * 80) })
  const ext = path.extname(inputFile).toLowerCase()
  const targetFmt = (ext === '.png' || ext === '.bmp') ? 'JPEG' : 'PNG'
  const name = path.basename(inputFile, ext)
  const outExt = targetFmt === 'JPEG' ? '.jpg' : '.png'
  const outPath = uniquePath(path.join(OUTPUT_DIR, name + '_converted' + outExt))
  const pyScript = resourcePath('img_utils.py')
  return runPython(pyScript, ['convert', path.resolve(inputFile), path.resolve(outPath), targetFmt], 60000, ['PIL'])
}

async function resizeImage(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在调整大小...', percent: Math.round((index / total) * 80) })
  const name = path.basename(inputFile, path.extname(inputFile))
  const outPath = uniquePath(path.join(OUTPUT_DIR, name + '_resized' + path.extname(inputFile)))
  const pyScript = resourcePath('img_utils.py')
  return runPython(pyScript, ['resize', path.resolve(inputFile), path.resolve(outPath), '', ''], 60000, ['PIL'])
}

async function convertImageToWebp(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在转换为WebP...', percent: Math.round((index / total) * 80) })
  const name = path.basename(inputFile, path.extname(inputFile))
  const outPath = uniquePath(path.join(OUTPUT_DIR, name + '.webp'))
  const pyScript = resourcePath('img_utils.py')
  return runPython(pyScript, ['convert', path.resolve(inputFile), path.resolve(outPath), 'WEBP'], 60000, ['PIL'])
}

async function grayscaleImage(inputFile, index, total) {
  send('task-progress', { file: path.basename(inputFile), step: '正在生成灰度图片...', percent: Math.round((index / total) * 80) })
  const name = path.basename(inputFile, path.extname(inputFile))
  const outPath = uniquePath(path.join(OUTPUT_DIR, name + '_gray' + path.extname(inputFile)))
  const pyScript = resourcePath('img_utils.py')
  return runPython(pyScript, ['grayscale', path.resolve(inputFile), path.resolve(outPath)], 60000, ['PIL'])
}

const extraConverters = {
  'pdf-merge': mergePdfs,
  'pdf-split': splitPdf,
  'pdf-watermark': addPdfWatermark,
  'pdf-compress': compressPdf,
  'pdf-rotate': rotatePdf,
  'images-to-pdf': imagesToPdf,
  'image-compress': compressImage,
  'image-convert': convertImageFormat,
  'image-resize': resizeImage,
  'image-webp': convertImageToWebp,
  'image-grayscale': grayscaleImage,
}

const batchTaskIds = new Set(['pdf-merge', 'images-to-pdf'])
const allConverters = { ...converters, ...extraConverters }

const tableServices = createTableServices({
  app,
  ipcMain,
  safeStorage,
  resourcePath,
  resolvePythonCommand,
  getOutputDir: () => OUTPUT_DIR,
  uniquePath,
  isTrustedSender: (event) => Boolean(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    event.sender === mainWindow.webContents
  ),
})

// ==================== IPC HANDLERS ====================

ipcMain.on('window-minimize', () => mainWindow?.minimize())
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize()
  else mainWindow?.maximize()
})
ipcMain.on('window-close', () => mainWindow?.close())

ipcMain.on('drop-overlay-expand', (event) => {
  if (isDropOverlaySender(event)) expandDropOverlay()
})

ipcMain.on('drop-overlay-collapse', (event) => {
  if (isDropOverlaySender(event)) collapseDropOverlay()
})

ipcMain.handle('drop-overlay-submit', async (event, filePaths) => {
  if (!isDropOverlaySender(event)) return { ok: false, error: '无效的文件来源' }
  const validFilePaths = normalizeDroppedFilePaths(filePaths)
  if (validFilePaths.length === 0) return { ok: false, error: '没有可处理的文件' }
  isGlobalFileDragActive = false
  collapseDropOverlay(true)
  showMainWindow(validFilePaths)
  return { ok: true, count: validFilePaths.length }
})

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'All Files', extensions: ['*'] }],
  })
  return result.filePaths
})

ipcMain.handle('cancel-task', () => {
  isCancelled = true
  if (currentProcess) {
    try { currentProcess.kill() } catch (e) {}
    currentProcess = null
  }
  return true
})

ipcMain.handle('process-files', async (event, filePaths, taskId) => {
  isProcessingFiles = true
  clearMainWindowReleaseTimer()
  try {
  ensureDir(OUTPUT_DIR)
  isCancelled = false
  filePaths = Array.isArray(filePaths) ? filePaths : []

  const converter = allConverters[taskId]
  if (!converter) {
    const copied = []
    for (const src of filePaths) {
      const dest = uniquePath(path.join(OUTPUT_DIR, path.basename(src)))
      fs.copyFileSync(src, dest)
      copied.push(dest)
    }
    return { ok: true, results: copied, errors: [], outputDir: OUTPUT_DIR }
  }

  const results = []
  const errors = []
  const total = filePaths.length

  function collectResult(resultPath) {
    if (!resultPath) return
    if (resultPath.includes('|')) {
      resultPath.split('|').filter(Boolean).forEach(p => results.push(p))
    } else {
      results.push(resultPath)
    }
  }

  if (batchTaskIds.has(taskId)) {
    if (isCancelled) {
      return { ok: false, results, errors: [{ file: '', error: '用户取消' }], outputDir: OUTPUT_DIR }
    }
    send('task-progress', {
      file: `${filePaths.length} 个文件`,
      step: '正在批量处理...',
      percent: 30,
      fileIndex: 0,
      totalFiles: filePaths.length,
    })
    const r = await converter(filePaths, 0, 1)
    if (r.ok) collectResult(r.path)
    else errors.push({ file: '', error: r.error })
    return { ok: errors.length === 0, results, errors, outputDir: OUTPUT_DIR }
  }

  for (let i = 0; i < total; i++) {
    if (isCancelled) {
      errors.push({ file: path.basename(filePaths[i]), error: '用户取消' })
      continue
    }

    send('task-progress', {
      file: path.basename(filePaths[i]),
      step: `处理中 (${i + 1}/${total})...`,
      percent: Math.round((i / total) * 80),
      fileIndex: i,
      totalFiles: total,
    })

    const r = await converter(filePaths[i], i, total)

    if (r.ok) {
      collectResult(r.path)
    } else {
      errors.push({ file: path.basename(filePaths[i]), error: r.error })
    }
  }

  return { ok: errors.length === 0, results, errors, outputDir: OUTPUT_DIR }
  } finally {
    isProcessingFiles = false
    scheduleMainWindowRelease()
  }
})

ipcMain.handle('open-output-folder', async () => {
  ensureDir(OUTPUT_DIR)
  return shell.openPath(OUTPUT_DIR)
})

ipcMain.handle('get-output-files', async () => {
  if (!fs.existsSync(OUTPUT_DIR)) return []
  return fs.readdirSync(OUTPUT_DIR)
    .filter(f => !f.startsWith('.'))
    .map((name) => {
      const fullPath = path.join(OUTPUT_DIR, name)
      const stat = fs.statSync(fullPath)
      return {
        name,
        path: fullPath,
        size: stat.size,
        mtime: stat.mtimeMs,
        isDirectory: stat.isDirectory(),
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
})

ipcMain.handle('open-path', async (event, targetPath) => {
  if (!targetPath || !fs.existsSync(targetPath)) return '文件不存在'
  return shell.openPath(targetPath)
})

ipcMain.handle('show-item-in-folder', async (event, targetPath) => {
  if (!targetPath || !fs.existsSync(targetPath)) return false
  shell.showItemInFolder(targetPath)
  return true
})

ipcMain.handle('get-app-settings', async () => ({
  outputDir: OUTPUT_DIR,
  defaultOutputDir: DEFAULT_OUTPUT_DIR,
  configPath: CONFIG_PATH,
  requirementsPath: REQUIREMENTS_PATH,
  launchAtLogin: getLaunchAtLogin(),
  launchAtLoginSupported: process.platform === 'win32' && app.isPackaged,
  backgroundModeEnabled: true,
  backgroundMonitorActive: dragMonitorAvailable,
  trayReady: Boolean(tray && !tray.isDestroyed()),
  idleReleaseSeconds: Math.round(MAIN_WINDOW_RELEASE_DELAY_MS / 1000),
  version: app.getVersion(),
}))

ipcMain.handle('set-launch-at-login', async (event, enabled) => {
  const result = setLaunchAtLogin(Boolean(enabled))
  if (result.ok) {
    appConfig = { ...appConfig, launchAtLogin: result.enabled }
    saveConfig(appConfig)
  }
  updateTrayMenu()
  return result
})

ipcMain.handle('set-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
  })
  if (result.canceled || !result.filePaths.length) return { ok: false, outputDir: OUTPUT_DIR }
  OUTPUT_DIR = result.filePaths[0]
  appConfig = { ...appConfig, outputDir: OUTPUT_DIR }
  saveConfig(appConfig)
  ensureDir(OUTPUT_DIR)
  return { ok: true, outputDir: OUTPUT_DIR }
})

ipcMain.handle('reset-output-dir', async () => {
  OUTPUT_DIR = DEFAULT_OUTPUT_DIR
  appConfig = { ...appConfig, outputDir: OUTPUT_DIR }
  saveConfig(appConfig)
  ensureDir(OUTPUT_DIR)
  return { ok: true, outputDir: OUTPUT_DIR }
})

ipcMain.handle('check-python-deps', async () => {
  const modules = ['pypdf', 'reportlab', 'PIL', 'fitz', 'openpyxl', 'pdfplumber']
  const status = await checkPythonModules(modules, true)
  return {
    ...status,
    missingPackages: (status.missing || []).map(m => PYTHON_DEP_NAMES[m] || m),
    requirementsPath: REQUIREMENTS_PATH,
  }
})

ipcMain.handle('install-python-deps', async () => {
  const python = await resolvePythonCommand()
  if (!python) return { ok: false, error: '未找到 Python 3，无法安装依赖。' }
  if (!fs.existsSync(REQUIREMENTS_PATH)) return { ok: false, error: 'requirements.txt 不存在。' }
  const result = await runProcess(python.command, [...python.prefix, '-m', 'pip', 'install', '-r', REQUIREMENTS_PATH], 300000)
  pythonModuleCache.clear()
  return {
    ok: result.code === 0,
    output: result.stdout || result.stderr,
    error: result.code === 0 ? '' : (result.stderr || result.stdout || `pip exited with ${result.code}`),
  }
})

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', () => showMainWindow())

app.on('before-quit', () => {
  isQuitting = true
  clearMainWindowReleaseTimer()
  tableServices.dispose()
  stopDragMonitor()
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
})

app.whenReady().then(async () => {
  tableServices.initialize()
  syncLaunchAtLogin()
  createDropOverlayWindow()
  await createTray()
  startDragMonitor()
  if (!START_HIDDEN) createWindow(true)
  screen.on('display-metrics-changed', () => {
    if (isDropOverlayExpanded) expandDropOverlay()
  })
})

app.on('activate', () => showMainWindow())
app.on('window-all-closed', () => {})
