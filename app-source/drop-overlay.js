const api = window.officeFlowDrop
const statusElement = document.getElementById('dropStatus')
let dragDepth = 0
let collapseTimer = null

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes('Files')
}

function setStatus(message, state) {
  statusElement.textContent = message
  document.body.classList.toggle('error', state === 'error')
  document.body.classList.toggle('success', state === 'success')
}

function scheduleCollapse(delay = 400) {
  clearTimeout(collapseTimer)
  collapseTimer = setTimeout(() => {
    dragDepth = 0
    api.collapse()
  }, delay)
}

document.addEventListener('dragenter', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  dragDepth += 1
  clearTimeout(collapseTimer)
  document.body.classList.add('dragging')
  setStatus('松开文件后自动进入处理页面')
  api.expand()
})

document.addEventListener('dragover', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
})

document.addEventListener('dragleave', (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) {
    document.body.classList.remove('dragging')
    scheduleCollapse()
  }
})

document.addEventListener('drop', async (event) => {
  if (!hasFiles(event)) return
  event.preventDefault()
  dragDepth = 0
  clearTimeout(collapseTimer)
  document.body.classList.remove('dragging')

  const filePaths = Array.from(event.dataTransfer.files)
    .map((file) => api.getPathForFile(file))
    .filter(Boolean)

  if (filePaths.length === 0) {
    setStatus('没有读取到可处理的文件', 'error')
    scheduleCollapse(1200)
    return
  }

  const result = await api.submit(filePaths)
  if (!result.ok) {
    setStatus(result.error || '文件接收失败', 'error')
    scheduleCollapse(1200)
    return
  }

  setStatus(`已接收 ${result.count} 个文件`, 'success')
})

api.onStateChanged(({ expanded }) => {
  if (expanded) {
    document.body.classList.remove('expanded')
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.body.classList.add('expanded')
    }))
    return
  }
  document.body.classList.remove('expanded', 'dragging')
  setStatus('松开文件后自动进入处理页面')
})
