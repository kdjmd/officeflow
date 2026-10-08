const assert = require('assert')
const fs = require('fs')
const path = require('path')

const html = fs.readFileSync(path.resolve(__dirname, '..', 'app-source', 'index.html'), 'utf8')
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))
const content = { innerHTML: '', dataset: {}, scrollTo() {} }
const listeners = new Map()
const pendingInvocations = new Map()
const invocationLog = []

const documentStub = {
  querySelectorAll() { return [] },
  querySelector() { return { focus() {} } },
  getElementById(id) { return id === 'content' ? content : null },
}

const ipcRenderer = {
  send() {},
  on(channel, listener) {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel).add(listener)
  },
  removeListener(channel, listener) {
    listeners.get(channel)?.delete(listener)
  },
  invoke(channel, payload) {
    invocationLog.push({ channel, payload })
    const queue = pendingInvocations.get(channel)
    if (queue?.length) return queue.shift().promise
    if (channel === 'get-app-settings') {
      return Promise.resolve({ launchAtLoginSupported: true, backgroundMonitorActive: true, trayReady: true, outputDir: 'C:\\out' })
    }
    if (channel === 'get-ai-settings') return Promise.resolve({ ok: true, providers: {} })
    if (channel === 'check-python-deps') return Promise.resolve({ ok: true })
    return Promise.resolve({ ok: true })
  },
}

function deferInvocation(channel) {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  if (!pendingInvocations.has(channel)) pendingInvocations.set(channel, [])
  pendingInvocations.get(channel).push({ promise, resolve, reject })
  return { resolve, reject }
}

function emit(channel, data) {
  for (const listener of listeners.get(channel) || []) listener({}, data)
}

const factory = new Function(
  'require', 'document', 'localStorage', 'confirm', 'window',
  `${script}\nreturn {
    applyTableResponse,
    applySmartGoalSuggestion,
    enhanceTableWithAi,
    exportTable,
    loadTablePresets,
    serializeTableData,
    selectTablePreset,
    setTableMode,
    showPage,
    startTableAnalyze,
    resetTableAnalysis,
    updateTableFields,
    updateTableGoal,
    updateTableCell,
    state() { return tableState },
    page() { return currentPage },
    files() { return selectedFiles.slice() },
    reset(files) {
      invalidateTableOperation(false)
      tableState = createEmptyTableState()
      selectedFiles = files.slice()
      selectedTask = 'document-to-table'
    },
  }`,
)

const ui = factory(
  name => name === 'electron' ? { ipcRenderer, webUtils: {} } : require(name),
  documentStub,
  { getItem() { return null }, setItem() {}, removeItem() {} },
  () => true,
  {
    addEventListener() {},
    officeFlow: {
      send: (...args) => ipcRenderer.send(...args),
      invoke: (...args) => ipcRenderer.invoke(...args),
      getPathForFile: () => '',
      subscribe(channel, callback) {
        const listener = (event, data) => callback(data)
        ipcRenderer.on(channel, listener)
        return () => ipcRenderer.removeListener(channel, listener)
      },
    },
  },
)

function makeAnalysis(rowCount) {
  return {
    ok: true,
    jobId: 'job-1',
    result: {
      tables: [{
        id: 'table-1',
        title: '测试表',
        columns: [{ key: 'c1', label: '值' }],
        rows: Array.from({ length: rowCount }, (_, index) => ({
          id: `row-${index}`,
          cells: { c1: { value: String(index), confidence: 1, sourceIds: [] } },
          sourceIds: [],
          status: 'ready',
        })),
      }],
      totalRows: rowCount,
      sources: {},
      warnings: [],
      errors: [],
    },
  }
}

async function testSparsePatchesKeepFullBackendTable() {
  ui.reset(['C:\\large.txt'])
  ui.applyTableResponse(makeAnalysis(10001))
  assert.equal(ui.state().rows.length, 10000, 'preview should remain bounded')
  assert.equal(ui.state().totalRows, 10001)
  assert.deepEqual(ui.serializeTableData(), { tableId: 'table-1', patches: [] })

  ui.updateTableCell(2, 0, '已编辑', null)
  assert.deepEqual(ui.serializeTableData(), {
    tableId: 'table-1',
    patches: [{ rowId: 'row-2', rowIndex: 2, columnKey: 'c1', value: '已编辑' }],
  })
}

async function testBusyExportLocksUiAndIgnoresExternalDrop() {
  ui.state().stage = 'preview'
  ui.showPage('table-workbench')
  const pending = deferInvocation('table-export')
  const exportPromise = ui.exportTable('xlsx')
  await Promise.resolve()

  assert.equal(ui.state().busyOperation, 'export')
  assert.match(content.innerHTML, /取消当前操作/)
  assert.match(content.innerHTML, /oninput="updateTableCell[^>]+disabled/)
  assert.match(content.innerHTML, /onclick="resetTableAnalysis\(\)" disabled/)

  const filesBeforeDrop = ui.files()
  emit('external-files-dropped', ['C:\\ignored.txt'])
  assert.deepEqual(ui.files(), filesBeforeDrop, 'external drop must be ignored while table operation is busy')
  assert.equal(ui.page(), 'table-workbench')

  ui.showPage('home')
  pending.resolve({ ok: true, outputPath: 'C:\\out.xlsx' })
  await exportPromise
  assert.equal(ui.page(), 'home')
  assert.match(content.innerHTML, /欢迎使用 OfficeFlow/)
  assert.doesNotMatch(content.innerHTML, /表格预览/)
}

async function testStaleAnalyzeCannotOverwriteAnotherPage() {
  ui.reset(['C:\\source.txt'])
  ui.showPage('table-workbench')
  const pending = deferInvocation('table-analyze')
  const analyzePromise = ui.startTableAnalyze()
  await Promise.resolve()
  assert.equal(ui.state().busyOperation, 'analyze')

  ui.showPage('home')
  pending.resolve(makeAnalysis(1))
  await analyzePromise
  assert.equal(ui.page(), 'home')
  assert.match(content.innerHTML, /欢迎使用 OfficeFlow/)
  assert.doesNotMatch(content.innerHTML, /表格预览/)
}

function testKeyboardAndEscapingMarkup() {
  assert.match(html, /class="drop-zone"[^>]+role="button"[^>]+tabindex="0"/)
  assert.match(html, /<button type="button" class="nav-item/)
  assert.match(html, /<button type="button" class="task-card/)

  const attack = '<img src=x onerror=globalThis.pwned=1>'
  ui.reset(['C:\\safe.txt'])
  const response = makeAnalysis(1)
  response.result.tables[0].columns[0].label = attack
  response.result.tables[0].rows[0].cells.c1.value = attack
  response.result.warnings = [{ message: attack }]
  ui.applyTableResponse(response)
  ui.state().stage = 'preview'
  ui.showPage('table-workbench')
  assert.doesNotMatch(content.innerHTML, /<img src=x/)
  assert.match(content.innerHTML, /&lt;img src=x onerror=/)
}

async function testSmartPlanningProtocolAndSuggestedFields() {
  ui.reset(['C:\\plan.docx'])
  ui.showPage('table-workbench')
  ui.setTableMode('smart')
  ui.updateTableGoal('根据文档形成可执行的工作安排')

  const pending = deferInvocation('table-analyze')
  const analyzePromise = ui.startTableAnalyze()
  await Promise.resolve()
  const request = invocationLog.filter(item => item.channel === 'table-analyze').at(-1)?.payload
  assert.equal(request.mode, 'smart')
  assert.equal(request.goal, '根据文档形成可执行的工作安排')
  assert.deepEqual(request.fields, [], 'smart mode must not hard-code fields in the renderer')
  assert.equal(request.useAi, true)

  const response = makeAnalysis(1)
  response.result.suggestedFields = ['事项', '负责人', '<img src=x onerror=bad()>']
  pending.resolve(response)
  await analyzePromise
  assert.deepEqual(ui.state().suggestedFields, ['事项', '负责人', '<img src=x onerror=bad()>'])
  assert.match(content.innerHTML, /本次识别字段/)
  assert.match(content.innerHTML, /class="suggested-fields" role="status" aria-live="polite"/)
  assert.doesNotMatch(content.innerHTML, /<img src=x/)
  assert.match(content.innerHTML, /&lt;img src=x onerror=bad\(\)&gt;/)
}

async function testSmartModeRestoresAiChoiceAndGoalChipsStaySchemaFree() {
  ui.reset(['C:\\meeting.docx'])
  ui.showPage('table-workbench')
  ui.updateTableFields('已有临时字段')
  ui.setTableMode('smart')
  assert.equal(ui.state().useAi, true)
  ui.applySmartGoalSuggestion(1)
  assert.match(ui.state().tableGoal, /会议纪要/)
  assert.equal(ui.state().customFields, '已有临时字段', 'goal chips must never force output columns')
  assert.match(content.innerHTML, /活动报名 \/ 签到/)
  assert.match(content.innerHTML, /评奖材料/)
  assert.match(content.innerHTML, /快捷项只填写整理目标，不会固定输出列/)
  assert.match(content.innerHTML, /学号、电话等信息仅在确有必要时发送/)
  ui.setTableMode('auto')
  assert.equal(ui.state().useAi, false, 'leaving smart must restore the prior AI toggle')
}

async function testSmartPresetFieldLimit() {
  ui.reset(['C:\\many-columns.txt'])
  ui.showPage('table-workbench')
  ui.setTableMode('smart')
  ui.updateTableGoal('按文档表头整理')
  ui.updateTableFields(Array.from({ length: 35 }, (_, index) => `字段${index + 1}`).join(','))
  const pending = deferInvocation('table-analyze')
  const analyzePromise = ui.startTableAnalyze()
  await Promise.resolve()
  const request = invocationLog.filter(item => item.channel === 'table-analyze').at(-1).payload
  assert.equal(request.fields.length, 30)
  assert.equal(request.fields.at(-1), '字段30')
  const response = makeAnalysis(1)
  response.aiSkipped = true
  response.aiSkipReason = 'preset-schema-match'
  pending.resolve(response)
  await analyzePromise
}

async function testSavedPresetSelectionAndStructuralIpc() {
  ui.reset(['C:\\roster.pdf'])
  ui.showPage('table-workbench')
  const pendingList = deferInvocation('list-table-presets')
  ui.setTableMode('smart')
  pendingList.resolve({
    ok: true,
    presets: [{
      id: 'preset-1',
      name: '学生会排班<img src=x onerror=bad()>',
      schema: {
        tableTitle: '成员排班',
        rowDefinition: '每行一班次',
        fields: [
          { key: 'member', label: '成员', type: 'string', aliases: ['姓名'] },
          { key: 'shift', label: '班次', type: 'string', aliases: [] },
        ],
      },
    }],
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ui.state().presets.length, 1)
  assert.doesNotMatch(content.innerHTML, /学生会排班<img/)
  assert.match(content.innerHTML, /学生会排班&lt;img/)

  const pendingUse = deferInvocation('use-table-preset')
  const selectPromise = ui.selectTablePreset('preset-1')
  pendingUse.resolve({ ok: true })
  await selectPromise
  assert.equal(ui.state().selectedPresetId, 'preset-1')
  assert.equal(ui.state().customFields, '成员，班次')
  assert.match(content.innerHTML, /id="smartPresetFields"[^>]+disabled/)
  ui.updateTableGoal('安排本周值班')

  const saveCountBefore = invocationLog.filter(item => item.channel === 'save-table-preset').length
  const pendingAnalyze = deferInvocation('table-analyze')
  const analyzePromise = ui.startTableAnalyze()
  await Promise.resolve()
  const request = invocationLog.filter(item => item.channel === 'table-analyze').at(-1).payload
  assert.equal(request.presetId, 'preset-1')
  assert.equal(request.options.presetId, 'preset-1')
  assert.equal(request.presetSchema.tableTitle, '成员排班')
  assert.deepEqual(request.presetSchema.fields.map(field => field.label), ['成员', '班次'])
  assert.ok(!Object.hasOwn(request.presetSchema, 'rows'), 'preset IPC must contain structure only')
  const response = makeAnalysis(1)
  response.aiSkipped = true
  response.aiSkipReason = 'preset-schema-match'
  response.suggestedFields = ['成员', '班次']
  pendingAnalyze.resolve(response)
  await analyzePromise
  assert.equal(invocationLog.filter(item => item.channel === 'save-table-preset').length, saveCountBefore, 'local preset matches must never create drafts')
}

async function testAiDesignedSchemaAutoSavesStructureOnly() {
  ui.reset(['C:\\private-minutes.docx'])
  ui.showPage('table-workbench')
  ui.setTableMode('smart')
  ui.updateTableGoal('把会议内容整理为任务安排')
  const pendingAnalyze = deferInvocation('table-analyze')
  const analyzePromise = ui.startTableAnalyze()
  await Promise.resolve()
  const response = makeAnalysis(1)
  response.result.schemaProvider = 'deepseek-v3'
  response.result.suggestedFields = ['任务', '负责人']
  response.result.suggestedSchema = {
    tableTitle: '会议任务',
    rowDefinition: '每行一个任务',
    fields: [
      { key: 'task', label: '任务', aliases: ['行动项'], type: 'string', required: true },
      { key: 'owner', label: '负责人', aliases: [], type: 'string', required: false },
    ],
  }
  pendingAnalyze.resolve(response)
  await analyzePromise

  const saveRequest = invocationLog.filter(item => item.channel === 'save-table-preset').at(-1)?.payload
  assert.ok(saveRequest, 'a completed AI-designed smart table should be persisted')
  assert.deepEqual(Object.keys(saveRequest).sort(), ['name', 'schema'])
  assert.deepEqual(Object.keys(saveRequest.schema).sort(), ['fields', 'rowDefinition', 'tableTitle'])
  assert.ok(saveRequest.schema.fields.every(field => Object.keys(field).every(key => ['aliases', 'key', 'label', 'required', 'type'].includes(key))))
  assert.ok(!JSON.stringify(saveRequest).includes('private-minutes.docx'))
  assert.ok(!JSON.stringify(saveRequest).includes('row-0'))
  assert.match(content.innerHTML, /已自动保存为预设：会议任务/)
  assert.match(content.innerHTML, /不包含文档内容/)
}

async function testPresetMatchThenAiEnhanceDoesNotClaimZeroTokens() {
  ui.reset(['C:\\needs-review.pdf'])
  ui.showPage('table-workbench')
  ui.setTableMode('smart')
  ui.updateTableGoal('整理活动签到')
  ui.updateTableFields('姓名，签到状态')
  const pendingAnalyze = deferInvocation('table-analyze')
  const analyzePromise = ui.startTableAnalyze()
  await Promise.resolve()
  const response = makeAnalysis(1)
  response.aiSkipped = true
  response.aiSkipReason = 'preset-schema-match'
  response.suggestedFields = ['姓名', '签到状态']
  response.result.tables[0].rows[0].needsReview = true
  response.result.tables[0].rows[0].cells.c1.needsReview = true
  pendingAnalyze.resolve(response)
  await analyzePromise
  assert.match(content.innerHTML, /本次未调用 AI（0 Token）/)

  const pendingEnhance = deferInvocation('table-ai-enhance')
  const enhancePromise = ui.enhanceTableWithAi()
  await Promise.resolve()
  pendingEnhance.resolve(response)
  await enhancePromise
  assert.equal(ui.state().aiUsedAfterPresetMatch, true)
  assert.doesNotMatch(content.innerHTML, /本次未调用 AI（0 Token）/)
  assert.match(content.innerHTML, /待确认内容随后使用了 AI/)
  assert.match(content.innerHTML, /字段结构仍来自本地预设/)
}

async function testSmartPresetSkipsAiAndEscapesMetadata() {
  ui.reset(['C:\\preset.pdf'])
  ui.showPage('table-workbench')
  ui.setTableMode('smart')
  ui.updateTableGoal('形成项目工作安排')
  ui.updateTableFields('事项，负责人, 截止日期；事项')

  const pending = deferInvocation('table-analyze')
  const analyzePromise = ui.startTableAnalyze()
  await Promise.resolve()
  const request = invocationLog.filter(item => item.channel === 'table-analyze').at(-1)?.payload
  assert.equal(request.mode, 'smart')
  assert.equal(request.goal, '形成项目工作安排')
  assert.deepEqual(request.fields, ['事项', '负责人', '截止日期'])
  assert.deepEqual(request.options.fields, request.fields)
  assert.equal(request.useAi, true, 'smart mode keeps AI available only for local mismatch fallback')

  const attack = '<svg onload=globalThis.pwned=1>'
  const response = makeAnalysis(1)
  response.aiSkipped = true
  response.aiSkipReason = attack
  response.suggestedFields = ['事项', '负责人', attack]
  response.suggestedSchema = {
    tableTitle: `工作安排${attack}`,
    rowDefinition: `一行一个事项${attack}`,
  }
  pending.resolve(response)
  await analyzePromise

  assert.equal(ui.state().aiSkipped, true)
  assert.equal(ui.state().aiSkipReason, attack)
  assert.deepEqual(ui.state().suggestedFields, ['事项', '负责人', attack])
  assert.match(content.innerHTML, /已匹配预设格式，本次未调用 AI（0 Token）/)
  assert.match(content.innerHTML, /本地匹配字段/)
  assert.doesNotMatch(content.innerHTML, /本次识别字段/)
  assert.doesNotMatch(content.innerHTML, /<svg onload=/)
  assert.match(content.innerHTML, /&lt;svg onload=globalThis\.pwned=1&gt;/)

  await ui.resetTableAnalysis()
  assert.equal(ui.state().mode, 'smart')
  assert.equal(ui.state().tableGoal, '形成项目工作安排')
  assert.equal(ui.state().customFields, '事项，负责人, 截止日期；事项')
  assert.equal(ui.state().aiSkipped, false, 'result-only skip state must reset before a new analysis')
  assert.match(content.innerHTML, /id="smartPresetFields"/)
  assert.match(content.innerHTML, /完全匹配时 0 Token 本地处理/)
}

(async () => {
  await testSparsePatchesKeepFullBackendTable()
  await testBusyExportLocksUiAndIgnoresExternalDrop()
  await testStaleAnalyzeCannotOverwriteAnotherPage()
  testKeyboardAndEscapingMarkup()
  await testSmartPlanningProtocolAndSuggestedFields()
  await testSmartModeRestoresAiChoiceAndGoalChipsStaySchemaFree()
  await testSmartPresetFieldLimit()
  await testSavedPresetSelectionAndStructuralIpc()
  await testAiDesignedSchemaAutoSavesStructureOnly()
  await testPresetMatchThenAiEnhanceDoesNotClaimZeroTokens()
  await testSmartPresetSkipsAiAndEscapesMetadata()
  console.log('Table UI state tests: OK')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
