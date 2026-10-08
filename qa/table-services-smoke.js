const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const { createTableServices, __test } = require('../app-source/table-services')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'officeflow-table-service-'))
const handlers = new Map()
const ipcMain = { handle(name, handler) { handlers.set(name, handler) } }
const sender = { id: 7, isDestroyed: () => false, send: () => {} }
const event = { sender }
const app = {
  getPath(name) {
    if (name === 'userData') return path.join(root, 'user-data')
    if (name === 'temp') return path.join(root, 'temp')
    throw new Error(`unexpected path ${name}`)
  },
}
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: value => value.toString('utf8').replace(/^encrypted:/, ''),
}

function uniquePath(filePath) {
  if (!fs.existsSync(filePath)) return filePath
  const extension = path.extname(filePath)
  const base = filePath.slice(0, -extension.length)
  let index = 1
  while (fs.existsSync(`${base}_${index}${extension}`)) index += 1
  return `${base}_${index}${extension}`
}

async function main() {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
  const legacyFixture = path.join(root, 'table-service-legacy.doc')
  const legacyScript = `
$ErrorActionPreference = 'Stop'
$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  $document = $word.Documents.Add()
  $document.Content.Text = "姓名：王五\r部门：运营部\r电话：13700137000"
  $document.SaveAs2($env:OFFICEFLOW_TEST_DOC, 0)
} finally {
  if ($null -ne $document) { $document.Close(0); [Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) | Out-Null }
  if ($null -ne $word) { $word.Quit(); [Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null }
}
`
  const legacyDocRequested = process.env.OFFICEFLOW_RUN_WORD_INTEGRATION === '1'
  if (legacyDocRequested) {
    execFileSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(legacyScript, 'utf16le').toString('base64'),
    ], { windowsHide: true, timeout: 30000, stdio: 'pipe', env: { ...process.env, OFFICEFLOW_TEST_DOC: legacyFixture } })
    if (!fs.existsSync(legacyFixture)) throw new Error('failed to generate required legacy DOC fixture')
  }
  const service = createTableServices({
    app,
    ipcMain,
    safeStorage,
    resourcePath: file => path.resolve(__dirname, '..', 'app-source', file),
    resolvePythonCommand: async () => ({ command: 'python.exe', prefix: [] }),
    getOutputDir: () => path.join(root, 'output'),
    uniquePath,
    isTrustedSender: candidate => candidate.sender === sender,
  })
  service.initialize()
  if (handlers.size !== 12) throw new Error(`expected 12 IPC handlers, got ${handlers.size}`)

  const initial = await handlers.get('get-ai-settings')(event)
  if (!initial.ok || initial.providers['deepseek-v4-flash'].configured) throw new Error('unexpected initial AI settings')
  const rejected = await handlers.get('save-ai-provider')(event, {
    providerId: 'deepseek-v3', apiKey: 'unit-test-v3-placeholder', baseUrl: 'https://localhost', modelId: 'model-v3',
  })
  if (rejected.ok) throw new Error('localhost provider was accepted')
  const saved = await handlers.get('save-ai-provider')(event, {
    providerId: 'deepseek-v4-flash', apiKey: 'unit-test-v4-placeholder',
  })
  if (!saved.ok || !saved.providers['deepseek-v4-flash'].configured) throw new Error('V4 key save failed')
  const secretText = fs.readFileSync(path.join(root, 'user-data', 'secrets.v1.json'), 'utf8')
  if (secretText.includes('unit-test-v4-placeholder')) throw new Error('plaintext key persisted')
  await handlers.get('delete-ai-provider')(event, { providerId: 'deepseek-v4-flash' })

  const fields = __test.validateSuggestedFields({ fields: [
    { key: 'task', label: '工作事项', aliases: ['事项'] },
    { key: 'owner', label: '负责人', required: true },
    { key: 'deadline', label: '截止日期', description: '允许目标所需但原文暂缺，值保持为空' },
  ] })
  if (fields.length !== 3 || fields[2].key !== 'deadline') throw new Error('dynamic schema validation failed')
  let duplicateRejected = false
  try { __test.validateSuggestedFields({ fields: [{ key: 'same', label: 'A' }, { key: 'same', label: 'B' }] }) }
  catch (_) { duplicateRejected = true }
  if (!duplicateRejected) throw new Error('duplicate schema keys were accepted')
  const schema = __test.validateSuggestedSchema({
    tableTitle: '客户跟进安排',
    rowDefinition: '每行代表一名待跟进客户',
    fields: [
      { key: 'customer', label: '客户', description: '客户名称', required: true },
      { key: 'next_action', label: '下一步行动', aliases: ['跟进行动'] },
    ],
  })
  if (schema.tableTitle !== '客户跟进安排' || schema.rowDefinition !== '每行代表一名待跟进客户' || !schema.fields[0].required) {
    throw new Error('smart table format validation failed')
  }
  const safeFallbackSchema = __test.validateSuggestedSchema({
    tableTitle: '=HYPERLINK("bad")', rowDefinition: '<b>bad</b>',
    fields: [{ key: 'a', label: '字段A' }, { key: 'b', label: '字段B' }],
  })
  if (safeFallbackSchema.tableTitle.startsWith('=') || safeFallbackSchema.rowDefinition.includes('<')) throw new Error('unsafe schema text escaped validation')
  const presetSchema = {
    tableTitle: '通讯录安排',
    rowDefinition: '每行代表一名联系人',
    fields: [
      { key: 'name', label: '姓名', aliases: ['名字'], required: true, type: 'text' },
      { key: 'department', label: '部门', aliases: [], required: false, type: 'text' },
      { key: 'phone', label: '电话', aliases: ['手机号'], required: true, type: 'phone' },
    ],
  }
  const savedPreset = await handlers.get('save-table-preset')(event, { name: '通讯录预设', schema: presetSchema })
  if (!savedPreset.ok || !savedPreset.created || savedPreset.preset.schema.fields[2].type !== 'phone') throw new Error('preset creation failed')
  const duplicatePreset = await handlers.get('save-table-preset')(event, { name: '通讯录预设（更新）', schema: presetSchema })
  if (!duplicatePreset.ok || !duplicatePreset.deduplicated || duplicatePreset.preset.id !== savedPreset.preset.id || duplicatePreset.preset.useCount !== 2) {
    throw new Error('preset fingerprint deduplication failed')
  }
  const usedPreset = await handlers.get('use-table-preset')(event, { presetId: savedPreset.preset.id })
  if (!usedPreset.ok || usedPreset.preset.useCount !== 3) throw new Error('preset usage tracking failed')
  const listedPresets = await handlers.get('list-table-presets')(event, {})
  if (!listedPresets.ok || listedPresets.presets.length !== 1 || listedPresets.presets[0].schema.tableTitle !== '通讯录安排') {
    throw new Error('preset listing failed')
  }
  const presetFile = JSON.parse(fs.readFileSync(path.join(root, 'user-data', 'table-presets.v1.json'), 'utf8'))
  const storedPresetKeys = Object.keys(presetFile.presets[0]).sort().join(',')
  const storedFieldKeys = Object.keys(presetFile.presets[0].fields[0]).sort().join(',')
  if (storedPresetKeys !== 'createdAt,fields,id,name,rowDefinition,tableTitle,updatedAt,useCount' || storedFieldKeys !== 'aliases,key,label,required,type') {
    throw new Error('preset file contains non-structural properties')
  }
  const presetRaw = JSON.stringify(presetFile)
  if (presetRaw.includes('张三') || presetRaw.includes('sourceIds') || presetRaw.includes('rows')) throw new Error('preset file persisted document content')
  const unsafePreset = await handlers.get('save-table-preset')(event, {
    name: '<script>', schema: { tableTitle: 'bad', fields: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] },
  })
  if (unsafePreset.ok) throw new Error('unsafe preset name was accepted')
  const matchWithGap = __test.localSchemaMatchesPreset({ tables: [{
    title: '通讯录',
    columns: [{ key: 'name', label: '姓名' }, { key: 'phone', label: '电话' }],
    rows: [{ id: 'r1', status: 'needs_review', cells: { name: { value: '张三', confidence: 0.9 }, phone: { value: '', confidence: 0, missing: true } } }],
  }] }, [{ key: 'name', label: '姓名' }, { key: 'phone', label: '电话' }])
  if (!matchWithGap.matched || !matchWithGap.dataNeedsReview) throw new Error('matching preset with missing values should still skip AI')

  const largeAnalysis = {
    tables: [{
      id: 'large',
      columns: [{ key: 'value', label: '值' }],
      rows: Array.from({ length: 10001 }, (_, index) => ({
        id: `row-${index}`,
        cells: { value: { value: String(index), confidence: 0.9, sourceIds: [`src-${index}`] } },
        sourceIds: [`src-${index}`],
        status: 'ready',
      })),
    }],
  }
  const patched = __test.prepareExportAnalysis(largeAnalysis, {
    tableId: 'large',
    patches: [{ rowId: 'row-10000', rowIndex: 10000, columnKey: 'value', value: '已编辑' }],
  })
  if (patched.tables[0].rows.length !== 10001 || patched.tables[0].rows[10000].cells.value.value !== '已编辑') {
    throw new Error('sparse edit truncated large table')
  }
  if (patched.tables[0].rows[10000].cells.value.sourceIds[0] !== 'src-10000') throw new Error('sparse edit lost provenance')

  const analyzed = await handlers.get('table-analyze')(event, {
    files: [path.resolve(__dirname, 'table-service-fixture.txt')], mode: 'auto', fields: [], useAi: false,
  })
  if (!analyzed.ok || !analyzed.jobId || !analyzed.columns.length || !analyzed.rows.length) {
    throw new Error(`analysis failed: ${JSON.stringify(analyzed)}`)
  }
  if (!analyzed.result.columns || !analyzed.result.rows) throw new Error('flattened result aliases are missing')
  const matchedSmart = await handlers.get('table-analyze')(event, {
    files: [path.resolve(__dirname, 'table-service-fixture.txt')],
    mode: 'smart',
    goal: '按通讯录格式整理',
    fields: [{ key: 'name', label: '姓名' }, { key: 'department', label: '部门' }, { key: 'phone', label: '电话' }],
    useAi: true,
  })
  if (!matchedSmart.ok || !matchedSmart.aiSkipped || matchedSmart.aiSkipReason !== 'preset-schema-match' || matchedSmart.usage.totalTokens !== 0) {
    throw new Error(`preset schema should skip AI: ${JSON.stringify(matchedSmart)}`)
  }
  handlers.get('table-cancel')(event, matchedSmart.jobId)
  const persistedSmart = await handlers.get('table-analyze')(event, {
    files: [path.resolve(__dirname, 'table-service-fixture.txt')],
    mode: 'smart',
    goal: '按已保存的通讯录格式整理',
    presetId: savedPreset.preset.id,
    presetSchema,
    useAi: true,
  })
  if (!persistedSmart.ok || !persistedSmart.aiSkipped || persistedSmart.usage.totalTokens !== 0 || persistedSmart.suggestedSchema.tableTitle !== '通讯录安排') {
    throw new Error(`persisted preset should skip AI: ${JSON.stringify(persistedSmart)}`)
  }
  handlers.get('table-cancel')(event, persistedSmart.jobId)
  if (legacyDocRequested) {
    const legacy = await handlers.get('table-analyze')(event, { files: [legacyFixture], mode: 'auto', useAi: false })
    if (!legacy.ok || !legacy.rows.length) throw new Error(`legacy DOC conversion failed: ${JSON.stringify(legacy)}`)
    const sourceFiles = Object.values(legacy.result.sources || {}).map(source => source && source.fileName).filter(Boolean)
    if (!sourceFiles.includes('table-service-legacy.doc')) throw new Error('legacy DOC source name was not restored')
    handlers.get('table-cancel')(event, legacy.jobId)
  }
  const smart = await handlers.get('table-analyze')(event, {
    files: [path.resolve(__dirname, 'table-service-fixture.txt')],
    mode: 'smart',
    goal: '安排客户跟进工作',
    fields: [{ key: 'name', label: '姓名' }, { key: 'owner', label: '负责人' }, { key: 'deadline', label: '截止日期' }],
    useAi: true,
  })
  if (!smart.ok || smart.aiSkipped || smart.schemaGoal !== '安排客户跟进工作' || !(smart.warnings || []).some(item => item.code === 'AI_SCHEMA_UNAVAILABLE')) {
    throw new Error(`smart local fallback failed: ${JSON.stringify(smart)}`)
  }
  handlers.get('table-cancel')(event, smart.jobId)
  const deletedPreset = await handlers.get('delete-table-preset')(event, { presetId: savedPreset.preset.id })
  if (!deletedPreset.ok || (await handlers.get('list-table-presets')(event, {})).presets.length !== 0) throw new Error('preset deletion failed')
  const exported = await handlers.get('table-export')(event, {
    jobId: analyzed.jobId,
    format: 'xlsx',
    tableData: { columns: analyzed.columns, rows: analyzed.rows },
  })
  if (!exported.ok || !fs.existsSync(exported.outputPath)) throw new Error(`export failed: ${JSON.stringify(exported)}`)
  const cancelled = handlers.get('table-cancel')(event, analyzed.jobId)
  if (!cancelled.ok) throw new Error('job cleanup failed')
  service.dispose()
  fs.rmSync(root, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: true, handlers: handlers.size, columns: analyzed.columns.length, rows: analyzed.rows.length, sparseRows: 10001, smartFallback: true, presets: true, legacyDoc: legacyDocRequested ? 'passed' : 'skipped-opt-in' }))
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch(error => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
