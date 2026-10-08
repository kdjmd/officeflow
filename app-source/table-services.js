const fs = require('fs')
const path = require('path')
const https = require('https')
const dns = require('dns')
const net = require('net')
const crypto = require('crypto')
const { spawn } = require('child_process')

const SERVICE_VERSION = 1
const TABLE_FILE_EXTENSIONS = new Set(['.txt', '.md', '.doc', '.docx', '.pdf'])
const MAX_FILE_COUNT = 30
const MAX_FILE_SIZE = 100 * 1024 * 1024
const MAX_TOTAL_SIZE = 300 * 1024 * 1024
const MAX_RESULT_BYTES = 64 * 1024 * 1024
const MAX_ACTIVE_JOBS = 3
const MAX_RETAINED_JOBS = 20
const JOB_TTL_MS = 6 * 60 * 60 * 1000
const STALE_JOB_DIR_MS = 24 * 60 * 60 * 1000
const PYTHON_ANALYZE_TIMEOUT_MS = 10 * 60 * 1000
const PYTHON_EXPORT_TIMEOUT_MS = 5 * 60 * 1000
const LEGACY_DOC_TIMEOUT_MS = 90 * 1000
const AI_TIMEOUT_MS = 45 * 1000
const AI_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const MAX_AI_CACHE_ENTRIES = 500
const MAX_AI_FRAGMENTS = 50
const MAX_AI_SOURCE_CHARS = 16000
const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_TABLE_PRESETS = 100
const TABLE_FIELD_TYPES = new Set(['text', 'number', 'date', 'datetime', 'currency', 'percentage', 'boolean', 'url', 'email', 'phone'])
const V4_BASE_URL = 'https://api.deepseek.com'
const V4_MODEL_ID = 'deepseek-flash'

const PROVIDER_IDS = {
  V3: 'deepseek-v3-compatible',
  V4: 'deepseek-v4-flash',
}

function defaultSecretState() {
  return {
    version: SERVICE_VERSION,
    settings: {
      enabled: false,
      autoFallback: true,
      inputTokenLimit: 4000,
      outputTokenLimit: 1200,
      documentTokenLimit: 12000,
      jobTokenLimit: 50000,
    },
    providers: {
      [PROVIDER_IDS.V3]: {
        enabled: false,
        baseUrl: '',
        modelId: '',
        apiKeyCiphertext: '',
        keyLast4: '',
      },
      [PROVIDER_IDS.V4]: {
        enabled: false,
        baseUrl: V4_BASE_URL,
        modelId: V4_MODEL_ID,
        apiKeyCiphertext: '',
        keyLast4: '',
      },
    },
  }
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.round(number)))
}

function safeErrorMessage(error, fallback) {
  const message = error && typeof error.message === 'string' ? error.message : String(error || '')
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 500) || fallback
}

function atomicWriteJson(filePath, value) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    fs.renameSync(tempPath, filePath)
  } catch (error) {
    try { fs.rmSync(filePath, { force: true }) } catch (removeError) {}
    fs.renameSync(tempPath, filePath)
  }
}

function readJsonFile(filePath, maxBytes = MAX_RESULT_BYTES) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('结果文件无效或过大')
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function removePath(targetPath) {
  try { fs.rmSync(targetPath, { recursive: true, force: true }) } catch (error) {}
}

function canonicalProviderId(value) {
  if (value === 'deepseek-v3' || value === 'v3') return PROVIDER_IDS.V3
  if (value === 'deepseek-v4' || value === 'v4' || value === 'v4-flash') return PROVIDER_IDS.V4
  return value
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 512) throw new Error('API 地址无效')
  let url
  try { url = new URL(value.trim()) } catch (error) { throw new Error('API 地址格式无效') }
  if (url.protocol !== 'https:') throw new Error('API 地址必须使用 HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new Error('API 地址不能包含凭据、查询参数或片段')
  const host = url.hostname.toLowerCase().replace(/\.$/, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('API 地址不能指向本机或局域网主机')
  }
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error('API 地址不能指向私网或保留地址')
  url.hostname = host
  url.pathname = url.pathname.replace(/\/+$/, '')
  return url.toString().replace(/\/$/, '')
}

function normalizeModelId(value) {
  const modelId = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(modelId)) throw new Error('模型 ID 无效')
  return modelId
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const [a, b, c] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true
  if (a === 203 && b === 0 && c === 113) return true
  return false
}

function isPrivateAddress(address) {
  const normalized = String(address || '').toLowerCase().split('%')[0]
  const family = net.isIP(normalized)
  if (family === 4) return isPrivateIpv4(normalized)
  if (family !== 6) return true
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (/^fe[89ab]/.test(normalized) || normalized.startsWith('ff')) return true
  if (normalized.startsWith('2001:db8:')) return true
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mapped ? isPrivateIpv4(mapped[1]) : false
}

async function resolvePublicAddress(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateAddress(hostname)) throw new Error('API 地址不能指向私网或保留地址')
    return { address: hostname, family: net.isIP(hostname) }
  }
  let addresses
  try {
    addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true })
  } catch (error) {
    throw new Error('无法解析 API 主机名')
  }
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error('API 主机名解析到了私网或保留地址')
  }
  return addresses[0]
}

function chatCompletionUrl(baseUrl) {
  const url = new URL(baseUrl)
  const cleanPath = url.pathname.replace(/\/+$/, '')
  url.pathname = `${cleanPath}/chat/completions`.replace(/\/+/g, '/')
  return url
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  let wideChars = 0
  for (const char of text) if (char.charCodeAt(0) > 255) wideChars += 1
  return Math.ceil(wideChars + (text.length - wideChars) / 4)
}

function parseJsonContent(content) {
  if (typeof content !== 'string' || content.length > MAX_HTTP_RESPONSE_BYTES) throw new Error('模型返回内容无效')
  let text = content.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  }
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) throw new Error('模型未返回 JSON 对象')
  return JSON.parse(text.slice(first, last + 1))
}

function normalizedEvidenceText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKC')
    .replace(/[\s\u200b]+/g, '')
    .replace(/[，。；：、“”‘’（）()\[\]{}]/g, '')
    .toLowerCase()
}

function textContainsEvidence(source, evidence) {
  const normalizedSource = normalizedEvidenceText(source)
  const normalizedEvidence = normalizedEvidenceText(evidence)
  return normalizedEvidence.length > 0 && normalizedSource.includes(normalizedEvidence)
}

function validateApiKey(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 4096) throw new Error('API Key 长度无效')
  if (/\s|[\u0000-\u001f\u007f]/.test(value)) throw new Error('API Key 不能包含空白或控制字符')
  return value
}

function normalizeMode(value) {
  const modeMap = { existing: 'native', custom: 'fields' }
  const mode = modeMap[value] || value || 'auto'
  return ['auto', 'native', 'ledger', 'fields', 'smart'].includes(mode) ? mode : 'auto'
}

function normalizeSchemaGoal(value) {
  const goal = typeof value === 'string' ? value.trim() : ''
  if (goal.length > 500) throw new Error('智能整理目标不能超过 500 字符')
  return goal || '根据文档实际内容识别合适字段，并整理成便于后续处理的表格'
}

function normalizeFields(value) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 64).map((field, index) => {
    if (typeof field === 'string') return field.trim().slice(0, 100)
    if (!field || typeof field !== 'object') return ''
    const key = String(field.key || `field_${index + 1}`).trim().slice(0, 80)
    const label = String(field.label || key).trim().slice(0, 100)
    const aliases = Array.isArray(field.aliases)
      ? field.aliases.slice(0, 20).map(alias => String(alias).trim().slice(0, 100)).filter(Boolean)
      : []
    return { key, label, aliases }
  }).filter(field => typeof field === 'string' ? Boolean(field) : Boolean(field.key && field.label))
}

function normalizeOcrLanguage(value) {
  const language = typeof value === 'string' && value.trim() ? value.trim() : 'zh-CN'
  if (language.length > 24 || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(language)) {
    throw new Error('OCR 语言标签无效')
  }
  return language
}

function normalizeAnalyzeRequest(payload) {
  const input = payload && typeof payload === 'object' ? payload : {}
  const options = input.options && typeof input.options === 'object' ? input.options : {}
  return {
    files: Array.isArray(input.files) ? input.files : input.filePaths,
    mode: normalizeMode(input.mode || options.mode),
    fields: normalizeFields(input.fields || options.fields),
    useAi: Boolean(input.useAi == null ? options.useAi : input.useAi),
    provider: canonicalProviderId(input.provider || options.provider || 'auto'),
    ocrLanguage: normalizeOcrLanguage(input.ocrLanguage || options.ocrLanguage),
    goal: normalizeSchemaGoal(input.goal || options.goal),
    presetId: String(input.presetId || options.presetId || '').trim().slice(0, 100),
    presetSchema: input.presetSchema && typeof input.presetSchema === 'object'
      ? input.presetSchema
      : (options.presetSchema && typeof options.presetSchema === 'object' ? options.presetSchema : null),
  }
}

function representativeSamples(analysis, maxCharacters = 9000, maxItems = 16) {
  const candidates = []
  const unresolved = Array.isArray(analysis && analysis.unresolved) ? analysis.unresolved : []
  for (const item of unresolved) {
    if (item && typeof item.text === 'string') candidates.push(item.text)
  }
  const sources = analysis && analysis.sources && typeof analysis.sources === 'object' ? analysis.sources : {}
  for (const source of Object.values(sources)) {
    if (source && typeof source.text === 'string') candidates.push(source.text)
  }
  const samples = []
  const seen = new Set()
  let used = 0
  for (const candidate of candidates) {
    const compact = String(candidate).replace(/\s+/g, ' ').trim()
    if (!compact) continue
    const fingerprint = crypto.createHash('sha1').update(normalizedEvidenceText(compact).slice(0, 1000)).digest('hex')
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    const remaining = maxCharacters - used
    if (remaining <= 0 || samples.length >= maxItems) break
    const sample = compact.slice(0, Math.min(1200, remaining))
    if (!sample) break
    samples.push(sample)
    used += sample.length
  }
  return samples
}

function unsafeSchemaText(value) {
  const text = String(value || '').trim()
  return /[\u0000-\u001f\u007f<>]/.test(text) || /^[=+\-@]/.test(text)
}

function validateSuggestedSchema(value) {
  if (value && typeof value === 'object' && value.result && typeof value.result === 'object') value = value.result
  const schemaValue = value && value.schema && typeof value.schema === 'object' ? value.schema : value
  const rawFields = schemaValue && Array.isArray(schemaValue.fields) ? schemaValue.fields : null
  if (!rawFields || rawFields.length < 2 || rawFields.length > 20) throw new Error('AI 字段方案必须包含 2–20 个字段')
  const fields = []
  const keys = new Set()
  const labels = new Set()
  for (let index = 0; index < rawFields.length; index += 1) {
    const item = rawFields[index]
    if (!item || typeof item !== 'object') throw new Error('AI 字段方案格式无效')
    const label = String(item.label || '').trim()
    let key = String(item.key || `field_${index + 1}`).trim()
    if (!label || label.length > 100 || unsafeSchemaText(label)) throw new Error('AI 字段名称无效')
    if (!key || key.length > 80 || !/^[A-Za-z0-9_.:-]+$/.test(key)) key = `field_${index + 1}`
    const canonicalKey = normalizedEvidenceText(key)
    const canonicalLabel = normalizedEvidenceText(label)
    if (!canonicalKey || keys.has(canonicalKey) || labels.has(canonicalLabel)) throw new Error('AI 字段方案包含重复字段')
    keys.add(canonicalKey)
    labels.add(canonicalLabel)
    const aliases = Array.isArray(item.aliases)
      ? [...new Set(item.aliases.map(alias => String(alias).trim()).filter(alias => alias && alias.length <= 100 && !unsafeSchemaText(alias)))].slice(0, 12)
      : []
    const descriptionValue = String(item.description || '').trim()
    const fieldType = String(item.type || 'text').trim().toLowerCase()
    fields.push({
      key,
      label,
      aliases,
      description: unsafeSchemaText(descriptionValue) ? '' : descriptionValue.slice(0, 300),
      required: Boolean(item.required),
      type: TABLE_FIELD_TYPES.has(fieldType) ? fieldType : 'text',
    })
  }
  const rawTitle = String(schemaValue && schemaValue.tableTitle || '').trim()
  const rawRowDefinition = String(schemaValue && schemaValue.rowDefinition || '').trim()
  return {
    tableTitle: rawTitle && rawTitle.length <= 100 && !unsafeSchemaText(rawTitle) ? rawTitle : '智能整理表',
    rowDefinition: rawRowDefinition && rawRowDefinition.length <= 300 && !unsafeSchemaText(rawRowDefinition)
      ? rawRowDefinition
      : '每行代表一条独立记录',
    fields,
  }
}

function validateSuggestedFields(value) {
  return validateSuggestedSchema(value).fields
}

function presetFieldDefinitions(fields) {
  if (!Array.isArray(fields)) return []
  return fields.slice(0, 20).map((field, index) => {
    if (typeof field === 'string') {
      const label = field.trim()
      return { key: `field_${index + 1}`, label, aliases: [label], description: '', required: false, type: 'text' }
    }
    if (!field || typeof field !== 'object') return null
    const label = String(field.label || field.key || '').trim()
    return {
      key: String(field.key || `field_${index + 1}`).trim(),
      label,
      aliases: Array.isArray(field.aliases) ? field.aliases.map(String) : [],
      description: String(field.description || '').slice(0, 300),
      required: Boolean(field.required),
      type: TABLE_FIELD_TYPES.has(String(field.type || '').toLowerCase()) ? String(field.type).toLowerCase() : 'text',
    }
  }).filter(field => field && field.label)
}

function localSchemaMatchesPreset(analysis, presetFields) {
  const definitions = presetFieldDefinitions(presetFields)
  if (definitions.length < 2 || definitions.length > 20) return { matched: false, reason: 'preset-unavailable' }
  let preset
  try {
    preset = validateSuggestedSchema({ tableTitle: '预设格式表', rowDefinition: '每行代表一条独立记录', fields: definitions }).fields
  } catch (error) {
    return { matched: false, reason: 'preset-invalid' }
  }
  const genericNames = /^(?:c\d+|column[_\s-]*\d+|列\s*\d+|字段\s*\d+|内容|文本|原文|值)$/i
  if (preset.some(field => genericNames.test(field.label.trim()))) return { matched: false, reason: 'preset-generic' }
  for (const table of Array.isArray(analysis && analysis.tables) ? analysis.tables : []) {
    const columns = Array.isArray(table.columns) ? table.columns : []
    const rows = Array.isArray(table.rows) ? table.rows : []
    if (columns.length !== preset.length || rows.length === 0) continue
    let columnsMatch = true
    for (let index = 0; index < columns.length; index += 1) {
      const column = columns[index] || {}
      const localLabel = String(column.label || column.name || '').trim()
      if (!localLabel || genericNames.test(localLabel)) { columnsMatch = false; break }
      const localNames = [localLabel, column.fieldKey].map(normalizedEvidenceText).filter(Boolean)
      const presetNames = [preset[index].label, preset[index].key, ...preset[index].aliases].map(normalizedEvidenceText).filter(Boolean)
      if (!localNames.some(name => presetNames.includes(name))) { columnsMatch = false; break }
    }
    if (!columnsMatch) continue
    let needsReview = false
    for (const row of rows) {
      if (!row) { needsReview = true; continue }
      if (row.status === 'needs_review') needsReview = true
      for (const column of columns) {
        const key = String(column.key || column.label || '')
        const cell = row.cells && row.cells[key]
        const confidence = Number(cell && cell.confidence)
        const value = cell && typeof cell === 'object' ? cell.value : cell
        if (!cell || cell.missing || value == null || String(value).trim() === '' || (Number.isFinite(confidence) && confidence < 0.75)) {
          needsReview = true
        }
      }
    }
    return {
      matched: true,
      reason: 'preset-schema-match',
      table,
      dataNeedsReview: needsReview,
      schema: {
        tableTitle: String(table.title || '').trim() && !unsafeSchemaText(table.title) && String(table.title || '').length <= 100 ? String(table.title) : '预设格式表',
        rowDefinition: '每行代表一条独立记录',
        fields: preset,
      },
    }
  }
  return { matched: false, reason: 'preset-schema-mismatch' }
}

function normalizePresetSchema(schema) {
  const validated = validateSuggestedSchema(schema)
  return {
    tableTitle: validated.tableTitle,
    rowDefinition: validated.rowDefinition,
    fields: validated.fields.map(field => ({
      key: field.key,
      label: field.label,
      aliases: field.aliases.slice(0, 12),
      required: Boolean(field.required),
      type: TABLE_FIELD_TYPES.has(field.type) ? field.type : 'text',
    })),
  }
}

function tablePresetFingerprint(schema) {
  const normalized = normalizePresetSchema(schema)
  const canonical = {
    tableTitle: normalizedEvidenceText(normalized.tableTitle),
    rowDefinition: normalizedEvidenceText(normalized.rowDefinition),
    fields: normalized.fields.map(field => ({
      key: normalizedEvidenceText(field.key),
      label: normalizedEvidenceText(field.label),
      aliases: field.aliases.map(normalizedEvidenceText).filter(Boolean).sort(),
      required: field.required,
      type: field.type,
    })),
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function normalizePresetName(value, schema) {
  const name = String(value || schema.tableTitle || '本地表格预设').trim()
  if (!name || name.length > 100 || unsafeSchemaText(name)) throw new Error('预设名称无效')
  return name
}

function publicTablePreset(preset) {
  return {
    id: preset.id,
    name: preset.name,
    schema: copyJson(preset.schema),
    tableTitle: preset.schema.tableTitle,
    rowDefinition: preset.schema.rowDefinition,
    fields: copyJson(preset.schema.fields),
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
    useCount: preset.useCount,
  }
}

function validateInputFiles(filePaths) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) throw new Error('请选择需要整理的文件')
  if (filePaths.length > MAX_FILE_COUNT) throw new Error(`单次最多处理 ${MAX_FILE_COUNT} 个文件`)
  const files = []
  const seen = new Set()
  let totalSize = 0
  for (const candidate of filePaths) {
    if (typeof candidate !== 'string' || !candidate || candidate.length > 32767) throw new Error('文件路径无效')
    const resolved = fs.realpathSync.native(path.resolve(candidate))
    if (seen.has(resolved.toLowerCase())) continue
    const extension = path.extname(resolved).toLowerCase()
    if (!TABLE_FILE_EXTENSIONS.has(extension)) throw new Error(`不支持的文件格式：${extension || '无扩展名'}`)
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) throw new Error('输入路径不是文件')
    if (stat.size <= 0) throw new Error(`文件为空：${path.basename(resolved)}`)
    if (stat.size > MAX_FILE_SIZE) throw new Error(`文件超过 100 MB：${path.basename(resolved)}`)
    totalSize += stat.size
    if (totalSize > MAX_TOTAL_SIZE) throw new Error('文件总大小不能超过 300 MB')
    seen.add(resolved.toLowerCase())
    files.push(resolved)
  }
  if (!files.length) throw new Error('没有可处理的文件')
  return files
}

function copyJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function sourceLocation(source) {
  if (!source || typeof source !== 'object') return ''
  if (Number.isFinite(source.page)) return `第 ${source.page} 页`
  if (Number.isFinite(source.paragraph)) return `段落 ${source.paragraph}`
  if (Number.isFinite(source.lineStart)) {
    return source.lineEnd && source.lineEnd !== source.lineStart
      ? `第 ${source.lineStart}–${source.lineEnd} 行`
      : `第 ${source.lineStart} 行`
  }
  if (Number.isFinite(source.table)) return `表格 ${source.table}`
  return ''
}

function previewRowsForAnalysis(analysis, table) {
  const sourceMap = analysis.sources && typeof analysis.sources === 'object' ? analysis.sources : {}
  return (Array.isArray(table.rows) ? table.rows : []).map((row, index) => {
    const sourceIds = Array.isArray(row.sourceIds) ? row.sourceIds.map(String) : []
    const sources = sourceIds.map(id => sourceMap[id]).filter(Boolean)
    const sourceLabel = [...new Set(sources.map(source => source.fileName || (source.file && path.basename(source.file))).filter(Boolean))].join(', ')
    const location = [...new Set(sources.map(sourceLocation).filter(Boolean))].join(' · ')
    const cells = {}
    let lowestConfidence = 1
    let cellNeedsReview = false
    for (const column of Array.isArray(table.columns) ? table.columns : []) {
      const key = String(column.key || column.label || '')
      if (!key) continue
      const original = row.cells && typeof row.cells === 'object' ? row.cells[key] : null
      const cell = original && typeof original === 'object' ? copyJson(original) : { value: original == null ? '' : original }
      const confidence = Number(cell.confidence)
      const needsReview = Boolean(cell.missing) || (Number.isFinite(confidence) && confidence < 0.75)
      if (Number.isFinite(confidence)) lowestConfidence = Math.min(lowestConfidence, confidence)
      if (needsReview) cellNeedsReview = true
      cells[key] = {
        ...cell,
        needsReview,
        source: sourceLabel,
      }
    }
    const needsReview = row.status === 'needs_review' || cellNeedsReview
    return {
      id: row.id == null ? index : row.id,
      cells,
      sourceIds,
      source: sourceLabel,
      location,
      confidence: lowestConfidence === 1 && !Object.keys(cells).length ? NaN : lowestConfidence,
      needsReview,
      status: row.status,
      aiEnhanced: row.status === 'ai-verified' || Object.values(cells).some(cell => cell.aiVerified),
    }
  })
}

function flattenAnalysis(jobId, result, extra = {}) {
  const safeResult = result && typeof result === 'object' ? result : {}
  const tables = Array.isArray(safeResult.tables) ? safeResult.tables : []
  const primary = tables[0] && typeof tables[0] === 'object' ? tables[0] : {}
  const columns = Array.isArray(safeResult.columns) ? safeResult.columns : (Array.isArray(primary.columns) ? primary.columns : [])
  const rows = Array.isArray(safeResult.rows) ? safeResult.rows : previewRowsForAnalysis(safeResult, primary)
  const warnings = Array.isArray(safeResult.warnings) ? safeResult.warnings : []
  const errors = Array.isArray(safeResult.errors) ? safeResult.errors : []
  const unresolved = Array.isArray(safeResult.unresolved) ? safeResult.unresolved : []
  const totalRows = Number.isFinite(safeResult.totalRows)
    ? safeResult.totalRows
    : tables.reduce((sum, table) => sum + (Array.isArray(table.rows) ? table.rows.length : 0), 0)
  const presentedResult = { ...safeResult, columns, rows, totalRows, warnings, errors, tables, unresolved }
  return {
    ok: safeResult.success !== false,
    jobId,
    result: presentedResult,
    columns,
    rows,
    totalRows,
    warnings,
    errors,
    stats: safeResult.stats && typeof safeResult.stats === 'object' ? safeResult.stats : {},
    tables,
    unresolved,
    ...extra,
  }
}

function prepareExportAnalysis(analysis, tableData) {
  const result = copyJson(analysis || {})
  if (!tableData || typeof tableData !== 'object') return result
  if (Array.isArray(tableData.patches)) {
    if (tableData.patches.length > 100000) throw new Error('单次编辑补丁不能超过 100,000 项')
    const tables = Array.isArray(result.tables) ? result.tables : []
    const requestedTableId = tableData.tableId == null ? '' : String(tableData.tableId)
    const target = (requestedTableId ? tables.find(table => String(table.id || '') === requestedTableId) : null) || tables[0]
    if (!target) throw new Error('找不到需要更新的表格')
    const columns = new Set((Array.isArray(target.columns) ? target.columns : []).map(column => String(column.key || column.label || '')).filter(Boolean))
    const rows = Array.isArray(target.rows) ? target.rows : []
    const rowsById = new Map(rows.map(row => [row && row.id != null ? String(row.id) : '', row]).filter(([id]) => id))
    for (const patch of tableData.patches) {
      if (!patch || typeof patch !== 'object') throw new Error('编辑补丁格式无效')
      const columnKey = String(patch.columnKey || '')
      if (!columnKey || columnKey.length > 100 || !columns.has(columnKey)) throw new Error('编辑补丁包含未知列')
      const rowId = patch.rowId == null ? '' : String(patch.rowId).slice(0, 120)
      const rowIndex = Number(patch.rowIndex)
      const row = (rowId && rowsById.get(rowId)) || (Number.isInteger(rowIndex) && rowIndex >= 0 && rowIndex < rows.length ? rows[rowIndex] : null)
      if (!row) throw new Error('编辑补丁包含未知行')
      const value = patch.value == null ? '' : String(patch.value)
      if (value.length > 32767) throw new Error('单元格内容超过 32,767 字符')
      if (!row.cells || typeof row.cells !== 'object') row.cells = {}
      const existing = row.cells[columnKey] && typeof row.cells[columnKey] === 'object' ? row.cells[columnKey] : {}
      row.cells[columnKey] = {
        ...existing,
        value,
        sourceIds: Array.isArray(existing.sourceIds)
          ? existing.sourceIds
          : (Array.isArray(row.sourceIds) ? copyJson(row.sourceIds) : []),
      }
    }
    return result
  }
  if (Array.isArray(tableData.tables)) {
    result.tables = copyJson(tableData.tables)
    return result
  }
  if (Array.isArray(tableData.columns) && Array.isArray(tableData.rows)) {
    const current = Array.isArray(result.tables) && result.tables[0] ? result.tables[0] : {}
    if (Array.isArray(current.rows) && current.rows.length > tableData.rows.length) {
      throw new Error('预览数据不完整，请使用稀疏编辑补丁导出，已阻止截断原始数据')
    }
    const columns = copyJson(tableData.columns)
    const rows = tableData.rows.map((row, index) => {
      const currentRow = Array.isArray(current.rows) ? current.rows[index] : null
      const values = row && typeof row === 'object' ? (row.values || row.data || row.cells || {}) : {}
      const cells = {}
      for (const column of columns) {
        const key = String(column && (column.key || column.label) || '')
        if (!key) continue
        const rawValue = values && typeof values === 'object' ? values[key] : ''
        const value = rawValue && typeof rawValue === 'object' ? rawValue.value : rawValue
        const existingCell = currentRow && currentRow.cells && currentRow.cells[key]
        cells[key] = {
          value: value == null ? '' : String(value),
          confidence: existingCell && Number.isFinite(Number(existingCell.confidence)) ? Number(existingCell.confidence) : 1,
          sourceIds: existingCell && Array.isArray(existingCell.sourceIds)
            ? copyJson(existingCell.sourceIds)
            : (currentRow && Array.isArray(currentRow.sourceIds) ? copyJson(currentRow.sourceIds) : []),
          ...(row && row.needsReview ? { missing: !String(value == null ? '' : value).trim() } : {}),
        }
      }
      return {
        id: currentRow && currentRow.id != null ? currentRow.id : `edited_${index + 1}`,
        cells,
        sourceIds: currentRow && Array.isArray(currentRow.sourceIds) ? copyJson(currentRow.sourceIds) : [],
        status: row && row.needsReview ? 'needs_review' : 'ready',
      }
    })
    const replacement = {
      ...current,
      id: current.id || 'table_1',
      title: current.title || '整理结果',
      kind: current.kind || 'user-edited',
      columns,
      rows,
    }
    result.tables = [replacement, ...(Array.isArray(result.tables) ? result.tables.slice(1) : [])]
  }
  return result
}

function makeOutputName(payload, format) {
  const requested = payload && typeof payload.outputName === 'string' ? path.basename(payload.outputName) : ''
  const rawBase = requested ? path.basename(requested, path.extname(requested)) : `整理结果_${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`
  const base = rawBase.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 120) || '整理结果'
  return `${base}.${format}`
}

function appendBounded(buffer, chunk, maxLength) {
  const value = buffer + chunk.toString('utf8')
  return value.length > maxLength ? value.slice(value.length - maxLength) : value
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function terminateChildProcess(child) {
  if (!child || child.killed) return
  if (process.platform === 'win32' && Number.isInteger(child.pid)) {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
      killer.once('error', () => { try { child.kill() } catch (error) {} })
      return
    } catch (error) {}
  }
  try { child.kill() } catch (error) {}
}

function restoreLegacySourceNames(result, aliases) {
  if (!result || typeof result !== 'object' || !(aliases instanceof Map) || !aliases.size) return result
  const normalizedAliases = new Map([...aliases].map(([temporary, original]) => [path.resolve(temporary).toLowerCase(), original]))
  const basenameAliases = new Map([...aliases].map(([temporary, original]) => [path.basename(temporary), path.basename(original)]))
  const sources = result.sources && typeof result.sources === 'object' ? result.sources : {}
  for (const source of Object.values(sources)) {
    if (!source || typeof source !== 'object') continue
    const sourcePath = typeof source.file === 'string' ? path.resolve(source.file).toLowerCase() : ''
    const original = normalizedAliases.get(sourcePath)
    if (original) {
      source.file = original
      source.fileName = path.basename(original)
      source.originalFormat = 'doc'
    }
  }
  for (const table of Array.isArray(result.tables) ? result.tables : []) {
    if (!table || typeof table.title !== 'string') continue
    for (const [temporaryName, originalName] of basenameAliases) {
      table.title = table.title.replace(temporaryName, originalName)
      table.title = table.title.replace(path.basename(temporaryName, '.docx'), path.basename(originalName, '.doc'))
    }
  }
  return result
}

function createTableServices(dependencies) {
  const {
    app,
    ipcMain,
    safeStorage,
    resourcePath,
    resolvePythonCommand,
    getOutputDir,
    uniquePath,
    isTrustedSender,
  } = dependencies

  const jobs = new Map()
  const aiCache = new Map()
  let secretState = null
  let presetState = null
  let cleanupTimer = null
  let disposed = false

  function secretsPath() {
    return path.join(app.getPath('userData'), 'secrets.v1.json')
  }

  function jobsRoot() {
    return path.join(app.getPath('temp'), 'OfficeFlow', 'table-jobs')
  }

  function presetsPath() {
    return path.join(app.getPath('userData'), 'table-presets.v1.json')
  }

  function normalizePresetId(value) {
    const id = String(value || '').trim()
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error('预设 ID 无效')
    return id
  }

  function loadPresets() {
    if (presetState) return presetState
    const loaded = []
    try {
      const stored = readJsonFile(presetsPath(), 1024 * 1024)
      for (const item of Array.isArray(stored.presets) ? stored.presets.slice(0, MAX_TABLE_PRESETS) : []) {
        try {
          if (!item || typeof item !== 'object') continue
          const schema = normalizePresetSchema(item.schema || item)
          const id = normalizePresetId(item.id)
          const createdAt = Number.isFinite(Date.parse(item.createdAt)) ? new Date(item.createdAt).toISOString() : new Date().toISOString()
          const updatedAt = Number.isFinite(Date.parse(item.updatedAt)) ? new Date(item.updatedAt).toISOString() : createdAt
          loaded.push({
            id,
            name: normalizePresetName(item.name, schema),
            schema,
            fingerprint: tablePresetFingerprint(schema),
            createdAt,
            updatedAt,
            useCount: clampInteger(item.useCount, 0, 0, 1000000000),
          })
        } catch (error) {}
      }
    } catch (error) {}
    const deduplicated = new Map()
    for (const preset of loaded.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const existing = deduplicated.get(preset.fingerprint)
      if (!existing) deduplicated.set(preset.fingerprint, preset)
      else existing.useCount = Math.min(1000000000, existing.useCount + preset.useCount)
    }
    presetState = { version: SERVICE_VERSION, presets: [...deduplicated.values()].slice(0, MAX_TABLE_PRESETS) }
    return presetState
  }

  function savePresets() {
    const state = loadPresets()
    state.presets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    atomicWriteJson(presetsPath(), {
      version: SERVICE_VERSION,
      presets: state.presets.map(preset => ({
        id: preset.id,
        name: preset.name,
        tableTitle: preset.schema.tableTitle,
        rowDefinition: preset.schema.rowDefinition,
        fields: preset.schema.fields,
        createdAt: preset.createdAt,
        updatedAt: preset.updatedAt,
        useCount: preset.useCount,
      })),
    })
  }

  function findPreset(presetId) {
    const id = normalizePresetId(presetId)
    return loadPresets().presets.find(preset => preset.id === id) || null
  }

  function incrementPresetUse(preset) {
    preset.useCount = Math.min(1000000000, preset.useCount + 1)
    preset.updatedAt = new Date().toISOString()
    savePresets()
  }

  function loadSecrets() {
    if (secretState) return secretState
    const defaults = defaultSecretState()
    try {
      const stored = readJsonFile(secretsPath(), 1024 * 1024)
      const settings = stored.settings && typeof stored.settings === 'object' ? stored.settings : {}
      const providers = stored.providers && typeof stored.providers === 'object' ? stored.providers : {}
      const storedV3 = providers[PROVIDER_IDS.V3] && typeof providers[PROVIDER_IDS.V3] === 'object' ? providers[PROVIDER_IDS.V3] : {}
      const storedV4 = providers[PROVIDER_IDS.V4] && typeof providers[PROVIDER_IDS.V4] === 'object' ? providers[PROVIDER_IDS.V4] : {}
      secretState = {
        ...defaults,
        settings: { ...defaults.settings, ...settings },
        providers: {
          [PROVIDER_IDS.V3]: { ...defaults.providers[PROVIDER_IDS.V3], ...storedV3 },
          [PROVIDER_IDS.V4]: { ...defaults.providers[PROVIDER_IDS.V4], ...storedV4 },
        },
      }
    } catch (error) {
      secretState = defaults
    }
    secretState.providers[PROVIDER_IDS.V4].baseUrl = V4_BASE_URL
    secretState.providers[PROVIDER_IDS.V4].modelId = V4_MODEL_ID
    return secretState
  }

  function saveSecrets() {
    const state = loadSecrets()
    state.version = SERVICE_VERSION
    state.providers[PROVIDER_IDS.V4].baseUrl = V4_BASE_URL
    state.providers[PROVIDER_IDS.V4].modelId = V4_MODEL_ID
    atomicWriteJson(secretsPath(), state)
  }

  function encryptionAvailable() {
    try { return Boolean(safeStorage && safeStorage.isEncryptionAvailable()) } catch (error) { return false }
  }

  function encryptApiKey(apiKey) {
    if (!encryptionAvailable()) throw new Error('当前系统无法安全加密 API Key')
    return safeStorage.encryptString(validateApiKey(apiKey)).toString('base64')
  }

  function decryptApiKey(provider) {
    if (!provider || typeof provider.apiKeyCiphertext !== 'string' || !provider.apiKeyCiphertext || provider.apiKeyCiphertext.length > 16384) {
      throw new Error('尚未配置 API Key')
    }
    if (!encryptionAvailable()) throw new Error('当前系统无法解密 API Key')
    try {
      return safeStorage.decryptString(Buffer.from(provider.apiKeyCiphertext, 'base64'))
    } catch (error) {
      throw new Error('API Key 无法解密，请删除后重新填写')
    }
  }

  function publicProvider(providerId) {
    const provider = loadSecrets().providers[providerId]
    const locked = providerId === PROVIDER_IDS.V4
    return {
      providerId,
      displayName: locked ? 'DeepSeek V4.1 Flash' : 'DeepSeek V3 兼容接口',
      enabled: Boolean(provider.enabled),
      configured: Boolean(provider.apiKeyCiphertext),
      keyLast4: provider.apiKeyCiphertext ? String(provider.keyLast4 || '') : '',
      baseUrl: locked ? V4_BASE_URL : String(provider.baseUrl || ''),
      modelId: locked ? V4_MODEL_ID : String(provider.modelId || ''),
      lockedEndpoint: locked,
    }
  }

  function publicAiSettings() {
    const state = loadSecrets()
    const v3 = publicProvider(PROVIDER_IDS.V3)
    const v4 = publicProvider(PROVIDER_IDS.V4)
    return {
      ok: true,
      encryptionAvailable: encryptionAvailable(),
      enabled: Boolean(state.settings.enabled),
      autoFallback: state.settings.autoFallback !== false,
      tokenLimit: state.settings.documentTokenLimit,
      inputTokenLimit: state.settings.inputTokenLimit,
      outputTokenLimit: state.settings.outputTokenLimit,
      documentTokenLimit: state.settings.documentTokenLimit,
      jobTokenLimit: state.settings.jobTokenLimit,
      providers: {
        [PROVIDER_IDS.V3]: v3,
        'deepseek-v3': v3,
        [PROVIDER_IDS.V4]: v4,
      },
      providerList: [v3, v4],
    }
  }

  function requireTrustedSender(event) {
    if (!event || typeof isTrustedSender !== 'function' || !isTrustedSender(event)) {
      throw new Error('无效的请求来源')
    }
  }

  function activeJobCount() {
    let count = 0
    for (const job of jobs.values()) if (job.active) count += 1
    return count
  }

  function cleanupJob(jobId) {
    const job = jobs.get(jobId)
    if (!job) return
    if (job.process && !job.process.killed) {
      terminateChildProcess(job.process)
    }
    if (job.request && !job.request.destroyed) {
      try { job.request.destroy(new Error('任务已取消')) } catch (error) {}
    }
    jobs.delete(jobId)
    if (path.dirname(job.directory) === jobsRoot() && path.basename(job.directory).startsWith('job-')) {
      removePath(job.directory)
    }
  }

  function pruneJobs(forceExpired = false) {
    const now = Date.now()
    const inactive = [...jobs.values()].filter(job => !job.active).sort((a, b) => a.lastAccess - b.lastAccess)
    for (const job of inactive) {
      if ((forceExpired && now - job.lastAccess > JOB_TTL_MS) || jobs.size > MAX_RETAINED_JOBS) cleanupJob(job.id)
    }
    for (const [key, entry] of aiCache) {
      if (now - entry.createdAt > AI_CACHE_TTL_MS) aiCache.delete(key)
    }
    while (aiCache.size > MAX_AI_CACHE_ENTRIES) aiCache.delete(aiCache.keys().next().value)
  }

  function cleanStaleDirectories() {
    const root = jobsRoot()
    fs.mkdirSync(root, { recursive: true })
    const now = Date.now()
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('job-')) continue
      const target = path.join(root, entry.name)
      try {
        if (now - fs.statSync(target).mtimeMs > STALE_JOB_DIR_MS) removePath(target)
      } catch (error) {}
    }
  }

  function createJob(event, files, options) {
    pruneJobs()
    if (activeJobCount() >= MAX_ACTIVE_JOBS) throw new Error('当前表格任务过多，请等待已有任务完成')
    const id = crypto.randomUUID()
    fs.mkdirSync(jobsRoot(), { recursive: true })
    const directory = fs.mkdtempSync(path.join(jobsRoot(), `job-${id}-`))
    const job = {
      id,
      ownerId: event.sender.id,
      directory,
      files,
      options,
      createdAt: Date.now(),
      lastAccess: Date.now(),
      active: false,
      cancelled: false,
      process: null,
      request: null,
      analysis: null,
      aiUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHits: 0 },
    }
    jobs.set(id, job)
    return job
  }

  function ownedJob(event, value) {
    const jobId = typeof value === 'string' ? value : (value && value.jobId)
    if (typeof jobId !== 'string' || jobId.length > 100) throw new Error('任务 ID 无效')
    const job = jobs.get(jobId)
    if (!job || job.ownerId !== event.sender.id) throw new Error('任务不存在或已过期')
    job.lastAccess = Date.now()
    return job
  }

  function sendProgress(event, job, progress) {
    if (!event.sender || event.sender.isDestroyed()) return
    const allowed = progress && typeof progress === 'object' ? progress : {}
    const current = Number.isFinite(allowed.current) ? allowed.current : 0
    const total = Number.isFinite(allowed.total) ? allowed.total : 0
    const percent = total > 0 ? Math.min(99, Math.max(1, Math.round((current / total) * 95))) : 3
    const message = String(allowed.message || '').slice(0, 300)
    event.sender.send('table-progress', {
      jobId: job.id,
      type: 'progress',
      phase: String(allowed.phase || ''),
      current,
      total,
      percent,
      progress: percent,
      message,
      step: message,
    })
  }

  async function convertLegacyDoc(event, job, inputPath, index, total) {
    if (process.platform !== 'win32') throw new Error('老式 .doc 转换仅支持 Windows 和 Microsoft Word')
    if (job.cancelled) throw new Error('任务已取消')
    const digest = crypto.createHash('sha256').update(inputPath).digest('hex').slice(0, 12)
    const outputPath = path.join(job.directory, `legacy-${index + 1}-${digest}.docx`)
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$word = $null
$document = $null
try {
  $inputPath = [System.IO.Path]::GetFullPath($env:OFFICEFLOW_DOC_INPUT)
  $outputPath = [System.IO.Path]::GetFullPath($env:OFFICEFLOW_DOC_OUTPUT)
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $word.AutomationSecurity = 3
  $word.Options.UpdateLinksAtOpen = $false
  $word.Options.SaveNormalPrompt = $false
  $word.Options.ConfirmConversions = $false
  $document = $word.Documents.Open($inputPath, $false, $true, $false)
  $document.SaveAs2($outputPath, 16)
  Write-Output '{"ok":true}'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $document) {
    try { $document.Close(0) } catch {}
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($document) | Out-Null } catch {}
  }
  if ($null -ne $word) {
    try { $word.Quit() } catch {}
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($word) | Out-Null } catch {}
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
    sendProgress(event, job, {
      phase: 'convert',
      current: index,
      total,
      message: `正在安全转换 ${path.basename(inputPath)}…`,
    })
    await new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodedScript,
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OFFICEFLOW_DOC_INPUT: inputPath,
          OFFICEFLOW_DOC_OUTPUT: outputPath,
        },
      })
      job.process = child
      let stderr = ''
      let timedOut = false
      let settled = false
      const timer = setTimeout(() => {
        timedOut = true
        terminateChildProcess(child)
      }, LEGACY_DOC_TIMEOUT_MS)

      function finish(error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }

      child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk, 16384) })
      child.on('error', error => finish(new Error(`无法启动 Word 转换器：${safeErrorMessage(error, '启动失败')}`)))
      child.on('close', code => {
        if (job.cancelled) return finish(new Error('任务已取消'))
        if (timedOut) return finish(new Error(`转换超时：${path.basename(inputPath)}`))
        if (code !== 0) {
          const detail = safeErrorMessage(stderr, '')
          const noWord = /class not registered|80040154|com object|word\.application/i.test(detail)
          return finish(new Error(noWord
            ? '未检测到可用的 Microsoft Word，老式 .doc 请先另存为 .docx'
            : `无法转换老式 Word 文档：${detail || path.basename(inputPath)}`))
        }
        try {
          const stat = fs.statSync(outputPath)
          const signature = Buffer.alloc(2)
          const descriptor = fs.openSync(outputPath, 'r')
          try { fs.readSync(descriptor, signature, 0, 2, 0) } finally { fs.closeSync(descriptor) }
          if (!stat.isFile() || stat.size <= 0 || signature.toString('ascii') !== 'PK') throw new Error('转换结果不是有效的 DOCX')
          finish()
        } catch (error) {
          finish(new Error(safeErrorMessage(error, 'Word 转换未生成有效文件')))
        }
      })
    })
    job.process = null
    sendProgress(event, job, {
      phase: 'convert',
      current: index + 1,
      total,
      message: `已转换 ${path.basename(inputPath)}`,
    })
    return outputPath
  }

  async function prepareInputFiles(event, job) {
    const legacyFiles = job.files.filter(file => path.extname(file).toLowerCase() === '.doc')
    if (!legacyFiles.length) return { files: job.files, aliases: new Map() }
    if (job.active) throw new Error('该任务正在执行其他操作')
    job.active = true
    job.cancelled = false
    const aliases = new Map()
    let legacyIndex = 0
    try {
      const prepared = []
      for (const inputPath of job.files) {
        if (path.extname(inputPath).toLowerCase() !== '.doc') {
          prepared.push(inputPath)
          continue
        }
        const converted = await convertLegacyDoc(event, job, inputPath, legacyIndex, legacyFiles.length)
        aliases.set(converted, inputPath)
        prepared.push(converted)
        legacyIndex += 1
      }
      return { files: prepared, aliases }
    } finally {
      job.process = null
      job.active = false
      job.lastAccess = Date.now()
    }
  }

  async function runPythonAction(event, job, action, requestData, timeoutMs) {
    if (job.active) throw new Error('该任务正在执行其他操作')
    const script = resourcePath('document_table.py')
    if (!fs.existsSync(script)) throw new Error('文档表格引擎缺失，请重新安装 OfficeFlow')
    const python = await resolvePythonCommand()
    if (!python) throw new Error('未找到 Python 3，请先安装 Python')
    const requestPath = path.join(job.directory, `${action}.request.json`)
    const resultPath = path.join(job.directory, `${action}.result.json`)
    atomicWriteJson(requestPath, requestData)
    removePath(resultPath)
    job.active = true
    job.cancelled = false
    job.lastAccess = Date.now()

    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(python.command, [...python.prefix, script, action, requestPath, resultPath], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        job.process = child
        let stdoutBuffer = ''
        let stderr = ''
        let timedOut = false
        let settled = false
        const timer = setTimeout(() => {
          timedOut = true
          terminateChildProcess(child)
        }, timeoutMs)

        function finish(error, value) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (error) reject(error)
          else resolve(value)
        }

        child.stdout.on('data', chunk => {
          stdoutBuffer += chunk.toString('utf8')
          if (stdoutBuffer.length > 128 * 1024) stdoutBuffer = stdoutBuffer.slice(-128 * 1024)
          const lines = stdoutBuffer.split(/\r?\n/)
          stdoutBuffer = lines.pop() || ''
          for (const line of lines) {
            if (!line.trim() || line.length > 8192) continue
            try {
              const progress = JSON.parse(line)
              if (progress.type === 'progress') sendProgress(event, job, progress)
            } catch (error) {}
          }
        })
        child.stderr.on('data', chunk => { stderr = appendBounded(stderr, chunk, 32768) })
        child.on('error', error => finish(new Error(`无法启动文档表格引擎：${safeErrorMessage(error, '启动失败')}`)))
        child.on('close', code => {
          if (job.cancelled) return finish(new Error('任务已取消'))
          if (timedOut) return finish(new Error('文档表格任务超时，已自动终止'))
          if (code !== 0 && !fs.existsSync(resultPath)) {
            return finish(new Error(safeErrorMessage(stderr, `文档表格引擎异常退出 (${code})`)))
          }
          try {
            const parsed = readJsonFile(resultPath)
            if (!parsed || typeof parsed !== 'object') throw new Error('文档表格引擎返回格式无效')
            if (parsed.success === false) throw new Error(safeErrorMessage(parsed.error || parsed.errors?.[0], '文档表格处理失败'))
            finish(null, parsed)
          } catch (error) {
            finish(new Error(safeErrorMessage(error, '无法读取文档表格结果')))
          }
        })
      })
      return result
    } finally {
      job.process = null
      job.active = false
      job.lastAccess = Date.now()
      removePath(requestPath)
      removePath(resultPath)
    }
  }

  function providerConfig(providerId, allowDisabled = false) {
    const canonicalId = canonicalProviderId(providerId)
    if (![PROVIDER_IDS.V3, PROVIDER_IDS.V4].includes(canonicalId)) throw new Error('不支持的 AI 模型')
    const stored = loadSecrets().providers[canonicalId]
    if (!allowDisabled && !stored.enabled) throw new Error('AI 模型尚未启用')
    if (!stored.apiKeyCiphertext) throw new Error('AI 模型尚未配置 API Key')
    const baseUrl = canonicalId === PROVIDER_IDS.V4 ? V4_BASE_URL : normalizeBaseUrl(stored.baseUrl)
    const modelId = canonicalId === PROVIDER_IDS.V4 ? V4_MODEL_ID : normalizeModelId(stored.modelId)
    return { providerId: canonicalId, baseUrl, modelId, apiKey: decryptApiKey(stored) }
  }

  async function postJson(provider, payload, job, timeoutMs = AI_TIMEOUT_MS) {
    const url = chatCompletionUrl(provider.baseUrl)
    const resolved = await resolvePublicAddress(url.hostname)
    const body = JSON.stringify(payload)
    if (Buffer.byteLength(body) > 512 * 1024) throw new Error('AI 请求内容过大')
    return new Promise((resolve, reject) => {
      let settled = false
      const request = https.request(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        minVersion: 'TLSv1.2',
        servername: url.hostname,
        lookup: (hostname, options, callback) => callback(null, resolved.address, resolved.family),
      }, response => {
        let responseBody = ''
        let tooLarge = false
        response.on('data', chunk => {
          if (tooLarge) return
          responseBody += chunk.toString('utf8')
          if (Buffer.byteLength(responseBody) > MAX_HTTP_RESPONSE_BYTES) {
            tooLarge = true
            request.destroy(new Error('AI 响应过大'))
          }
        })
        response.on('end', () => {
          if (tooLarge || settled) return
          if (response.statusCode < 200 || response.statusCode >= 300) {
            const retryable = response.statusCode === 408 || response.statusCode === 429 || response.statusCode >= 500
            const error = new Error(`AI 服务返回 HTTP ${response.statusCode}`)
            error.retryable = retryable
            error.statusCode = response.statusCode
            return finish(error)
          }
          try { finish(null, JSON.parse(responseBody)) }
          catch (error) { finish(new Error('AI 服务返回了无效 JSON')) }
        })
      })
      if (job) job.request = request
      const timer = setTimeout(() => request.destroy(new Error('AI 请求超时')), timeoutMs)

      function finish(error, value) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (job && job.request === request) job.request = null
        if (error) reject(error)
        else resolve(value)
      }

      request.on('error', error => {
        const safeError = new Error(safeErrorMessage(error, 'AI 请求失败'))
        safeError.retryable = Boolean(error.retryable) || /timeout|timed out|reset|socket|network|AI 请求超时/i.test(error.message || '')
        finish(safeError)
      })
      request.write(body)
      request.end()
    })
  }

  async function requestChatJson(provider, messages, limits, job) {
    const payload = {
      model: provider.modelId,
      messages,
      temperature: 0,
      max_tokens: limits.outputTokenLimit,
      response_format: { type: 'json_object' },
    }
    if (provider.providerId === PROVIDER_IDS.V4) payload.thinking = { type: 'disabled' }
    let lastError
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (job && job.cancelled) throw new Error('任务已取消')
      try {
        const response = await postJson(provider, payload, job)
        const choice = response && Array.isArray(response.choices) ? response.choices[0] : null
        const content = choice && choice.message ? choice.message.content : ''
        return {
          json: parseJsonContent(content),
          usage: response.usage && typeof response.usage === 'object' ? response.usage : {},
          model: String(response.model || provider.modelId),
        }
      } catch (error) {
        lastError = error
        if (!error.retryable || attempt > 0) break
        await delay(600)
      }
    }
    throw lastError || new Error('AI 请求失败')
  }

  function collectColumns(analysis) {
    const columns = []
    const seen = new Set()
    for (const table of Array.isArray(analysis.tables) ? analysis.tables : []) {
      for (const column of Array.isArray(table.columns) ? table.columns : []) {
        const key = String(column && (column.key || column.label) || '').slice(0, 80)
        if (!key || seen.has(key)) continue
        seen.add(key)
        columns.push({ key, label: String(column.label || key).slice(0, 100) })
      }
    }
    return columns.slice(0, 64)
  }

  function fragmentSourceText(fragment, analysis) {
    const sourceMap = analysis.sources && typeof analysis.sources === 'object' ? analysis.sources : {}
    const texts = []
    for (const id of Array.isArray(fragment.sourceIds) ? fragment.sourceIds : []) {
      const source = sourceMap[id]
      if (source && typeof source.text === 'string' && source.text.trim()) texts.push(source.text.trim())
    }
    if (!texts.length && typeof fragment.text === 'string') texts.push(fragment.text.trim())
    return [...new Set(texts)].join('\n').slice(0, MAX_AI_SOURCE_CHARS)
  }

  function selectFragments(requested, analysis) {
    const unresolved = Array.isArray(analysis.unresolved) ? analysis.unresolved : []
    let allowedIds = null
    if (Array.isArray(requested)) {
      allowedIds = new Set(requested.map(item => String(typeof item === 'string' ? item : item && item.id || '')).filter(Boolean))
    }
    return unresolved
      .filter(item => item && typeof item === 'object' && (!allowedIds || allowedIds.has(String(item.id))))
      .slice(0, MAX_AI_FRAGMENTS)
  }

  function buildEnhanceMessages(fragment, sourceText, columns, analysis) {
    const tableHints = (Array.isArray(analysis.tables) ? analysis.tables : []).slice(0, 10).map(table => ({
      id: String(table.id || ''),
      title: String(table.title || '').slice(0, 100),
      columns: (Array.isArray(table.columns) ? table.columns : []).map(column => String(column.key || column.label || '')).filter(Boolean),
    }))
    const contract = {
      fragmentId: String(fragment.id || ''),
      targetTableId: '只能填写上方表格中的 id；无法判断则留空',
      targetRowId: '仅在能确定已有行时填写，否则留空',
      cells: [{ column: '只能使用允许列 key', value: '必须直接来自原文', evidence: '必须是原文中的连续证据' }],
      confidence: 0.0,
    }
    return [
      {
        role: 'system',
        content: '你是严格的文档表格整理器。只提取原文明示的信息，不推断、不补全、不改写。每个值必须附带原文连续证据。仅输出一个 JSON 对象。无法可靠提取时 cells 返回空数组。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          task: '把这个本地规则未解决的片段整理到已有表格列中',
          fragment: { id: fragment.id, reason: fragment.reason, text: sourceText },
          allowedColumns: columns,
          tables: tableHints,
          outputContract: contract,
        }),
      },
    ]
  }

  function validateEnhancement(value, fragment, sourceText, columns, analysis) {
    if (value && typeof value === 'object' && value.result && typeof value.result === 'object') value = value.result
    if (!value || typeof value !== 'object') throw new Error('AI 结果不是对象')
    if (String(value.fragmentId || '') !== String(fragment.id || '')) throw new Error('AI 结果片段 ID 不匹配')
    const allowedColumns = new Set(columns.map(column => column.key))
    const validTableIds = new Set((Array.isArray(analysis.tables) ? analysis.tables : []).map(table => String(table.id || '')))
    const targetTableId = validTableIds.has(String(value.targetTableId || '')) ? String(value.targetTableId) : ''
    const cells = []
    let candidates = []
    if (Array.isArray(value.cells)) {
      candidates = value.cells
    } else if (value.cells && typeof value.cells === 'object') {
      candidates = Object.entries(value.cells).map(([column, cell]) => ({
        column,
        ...(cell && typeof cell === 'object' ? cell : { value: cell }),
      }))
    } else if (value.values && typeof value.values === 'object') {
      const evidenceMap = value.evidence && typeof value.evidence === 'object' ? value.evidence : {}
      candidates = Object.entries(value.values).map(([column, cellValue]) => ({ column, value: cellValue, evidence: evidenceMap[column] }))
    }
    for (const item of candidates.slice(0, columns.length)) {
      if (!item || !allowedColumns.has(String(item.column || ''))) continue
      const cellValue = String(item.value == null ? '' : item.value).trim().slice(0, 2000)
      const evidence = String(item.evidence == null ? '' : item.evidence).trim().slice(0, 2000)
      if (!cellValue || !textContainsEvidence(sourceText, evidence)) continue
      const normalizedValue = normalizedEvidenceText(cellValue)
      const normalizedEvidence = normalizedEvidenceText(evidence)
      if (!normalizedEvidence.includes(normalizedValue) && !normalizedValue.includes(normalizedEvidence)) continue
      cells.push({ column: String(item.column), value: cellValue, evidence })
    }
    if (!cells.length) throw new Error('AI 未返回可由原文验证的值')
    return {
      fragmentId: String(fragment.id),
      targetTableId,
      targetRowId: String(value.targetRowId || '').slice(0, 100),
      cells,
      confidence: Math.min(1, Math.max(0, Number(value.confidence) || 0.75)),
      sourceIds: Array.isArray(fragment.sourceIds) ? fragment.sourceIds.map(String) : [],
    }
  }

  function cacheKeyFor(provider, fragment, sourceText, columns) {
    return crypto.createHash('sha256').update(JSON.stringify({
      version: SERVICE_VERSION,
      provider: provider.providerId,
      model: provider.modelId,
      id: fragment.id,
      sourceText,
      columns,
    })).digest('hex')
  }

  function reserveUsage(job, estimatedInput) {
    job.aiUsage.promptTokens += estimatedInput
    job.aiUsage.totalTokens += estimatedInput
  }

  function reconcileUsage(job, usage, estimatedInput) {
    const prompt = clampInteger(usage.prompt_tokens, estimatedInput, 0, 1000000)
    const completion = clampInteger(usage.completion_tokens, 0, 0, 1000000)
    job.aiUsage.promptTokens += prompt - estimatedInput
    job.aiUsage.completionTokens += completion
    job.aiUsage.totalTokens += prompt - estimatedInput + completion
  }

  function applyEnhancements(analysis, enhancements, failures) {
    const result = copyJson(analysis)
    const successfulIds = new Set(enhancements.map(item => item.fragmentId))
    result.aiEnhancements = [...(Array.isArray(result.aiEnhancements) ? result.aiEnhancements : []), ...enhancements]
    result.unresolved = (Array.isArray(result.unresolved) ? result.unresolved : []).filter(item => !successfulIds.has(String(item.id)))
    for (const enhancement of enhancements) {
      const tables = Array.isArray(result.tables) ? result.tables : []
      const target = tables.find(table => String(table.id || '') === enhancement.targetTableId) || tables[0]
      if (!target) continue
      if (!Array.isArray(target.rows)) target.rows = []
      let row = enhancement.targetRowId
        ? target.rows.find(item => String(item.id || '') === enhancement.targetRowId)
        : null
      if (!row && enhancement.sourceIds.length) {
        const enhancementSources = new Set(enhancement.sourceIds.map(String))
        row = target.rows.find(item => Array.isArray(item.sourceIds) && item.sourceIds.some(sourceId => enhancementSources.has(String(sourceId))))
      }
      if (!row) {
        row = {
          id: `ai_${crypto.createHash('sha1').update(enhancement.fragmentId).digest('hex').slice(0, 12)}`,
          cells: {},
          sourceIds: enhancement.sourceIds,
          status: 'ai-verified',
        }
        target.rows.push(row)
      }
      if (!row.cells || typeof row.cells !== 'object') row.cells = {}
      for (const cell of enhancement.cells) {
        const existing = row.cells[cell.column]
        if (existing && existing.value != null && String(existing.value).trim()) continue
        row.cells[cell.column] = {
          value: cell.value,
          confidence: enhancement.confidence,
          sourceIds: enhancement.sourceIds,
          evidence: cell.evidence,
          aiVerified: true,
        }
      }
      const targetColumnKeys = (Array.isArray(target.columns) ? target.columns : []).map(column => String(column.key || column.label || '')).filter(Boolean)
      if (targetColumnKeys.length && targetColumnKeys.every(key => row.cells[key] && String(row.cells[key].value == null ? '' : row.cells[key].value).trim())) {
        row.status = 'ai-verified'
      }
    }
    if (!result.stats || typeof result.stats !== 'object') result.stats = {}
    result.stats.needsAi = result.unresolved.length > 0
    result.stats.aiEnhanced = enhancements.length
    result.stats.aiFailed = failures.length
    return result
  }

  function configuredProviderOrder(requested) {
    const settings = loadSecrets().settings
    const canonical = canonicalProviderId(requested)
    if (!['auto', PROVIDER_IDS.V3, PROVIDER_IDS.V4].includes(canonical)) throw new Error('不支持的 AI 模型')
    let candidates
    if (canonical === PROVIDER_IDS.V4) candidates = [PROVIDER_IDS.V4]
    else candidates = [PROVIDER_IDS.V3, ...(settings.autoFallback === false ? [] : [PROVIDER_IDS.V4])]
    const result = []
    for (const providerId of candidates) {
      try { result.push(providerConfig(providerId)) } catch (error) {}
    }
    if (!result.length) throw new Error('没有已启用并配置 API Key 的 AI 模型')
    return result
  }

  function currentAiLimits() {
    const settings = loadSecrets().settings
    return {
      inputTokenLimit: clampInteger(settings.inputTokenLimit, 4000, 512, 8000),
      outputTokenLimit: clampInteger(settings.outputTokenLimit, 1200, 128, 2000),
      documentTokenLimit: clampInteger(settings.documentTokenLimit, 12000, 1000, 100000),
      jobTokenLimit: clampInteger(settings.jobTokenLimit, 50000, 2000, 200000),
    }
  }

  function schemaMessages(analysis, goal, maxSampleCharacters, presetSchema) {
    const existingColumns = collectColumns(analysis).map(column => ({ key: column.key, label: column.label }))
    const samples = representativeSamples(analysis, maxSampleCharacters, 12)
    if (!samples.length) throw new Error('本地分析没有可用于识别字段的代表性片段')
    return [
      {
        role: 'system',
        content: '你是严格的数据建模助手。依据用户明确目标和少量代表性原文动态设计表格字段；不得仅因用户是学生、学生会成员或其他身份角色就臆造原文与目标都未要求的字段。可以包含用户目标明确需要但原文暂缺的字段，缺失值之后必须留空，绝不虚构具体数据。当前步骤只设计字段、不提取数据。只输出 JSON 对象。字段必须具体、互不重复，数量 2 到 20。',
      },
      {
        role: 'user',
        content: JSON.stringify({
          goal,
          presetSchema: presetSchema && typeof presetSchema === 'object'
            ? normalizePresetSchema(presetSchema)
            : { fields: presetFieldDefinitions(presetSchema) },
          existingLocalColumns: existingColumns,
          representativeSamples: samples,
          outputContract: {
            tableTitle: '表格标题，不超过100字',
            rowDefinition: '说明每一行代表什么，不超过300字',
            fields: [{ key: '稳定且简短的字段key', label: '显示名称', aliases: ['原文可能使用的同义标签'], description: '字段用途', required: false }],
          },
        }),
      },
    ]
  }

  async function discoverSchema(event, job, analysis, goal, requestedProvider, presetSchema) {
    const state = loadSecrets()
    if (!state.settings.enabled) throw new Error('AI 功能尚未启用，无法进行动态字段识别')
    const providers = configuredProviderOrder(requestedProvider || 'auto')
    const limits = currentAiLimits()
    const messages = schemaMessages(analysis, goal, Math.max(500, limits.inputTokenLimit - 600), presetSchema)
    const estimatedInput = estimateTokens(messages)
    if (estimatedInput > limits.inputTokenLimit) throw new Error('字段识别样本超过单次 AI Token 上限')
    if (estimatedInput > limits.documentTokenLimit) throw new Error('字段识别样本超过单文档 AI Token 上限')
    if (job.aiUsage.promptTokens + estimatedInput > limits.jobTokenLimit) throw new Error('已达到 AI Token 预算上限')
    job.active = true
    job.cancelled = false
    let lastError
    try {
      sendProgress(event, job, { phase: 'ai-schema', current: 0, total: 1, message: '正在识别适合当前文档的动态字段…' })
      for (const provider of providers) {
        if (job.cancelled) throw new Error('任务已取消')
        if (job.aiUsage.promptTokens + estimatedInput > limits.jobTokenLimit) {
          throw new Error('已达到 AI Token 预算上限')
        }
        const cacheKey = crypto.createHash('sha256').update(JSON.stringify({
          version: SERVICE_VERSION,
          kind: 'schema',
          provider: provider.providerId,
          model: provider.modelId,
          goal,
          messages,
        })).digest('hex')
        const cached = aiCache.get(cacheKey)
        if (cached && Date.now() - cached.createdAt <= AI_CACHE_TTL_MS) {
          job.aiUsage.cacheHits += 1
          const schema = copyJson(cached.value)
          return { schema, fields: schema.fields, providerId: provider.providerId, cached: true }
        }
        reserveUsage(job, estimatedInput)
        try {
          const response = await requestChatJson(provider, messages, limits, job)
          reconcileUsage(job, response.usage, estimatedInput)
          const schema = validateSuggestedSchema(response.json)
          aiCache.set(cacheKey, { createdAt: Date.now(), value: copyJson(schema) })
          sendProgress(event, job, { phase: 'ai-schema', current: 1, total: 1, message: `已识别 ${schema.fields.length} 个动态字段` })
          return { schema, fields: schema.fields, providerId: provider.providerId, model: response.model, cached: false }
        } catch (error) {
          lastError = error
        }
      }
      throw lastError || new Error('动态字段识别失败')
    } finally {
      job.request = null
      job.active = false
      job.lastAccess = Date.now()
    }
  }

  async function enhanceJob(event, job, payload) {
    if (!job.analysis) throw new Error('请先完成本地文档分析')
    if (job.active) throw new Error('该任务正在执行其他操作')
    const state = loadSecrets()
    if (!state.settings.enabled) throw new Error('AI 功能尚未启用')
    const columns = collectColumns(job.analysis)
    if (!columns.length) throw new Error('本地分析尚未生成可整理的表格列')
    const fragments = selectFragments(payload && payload.fragments, job.analysis)
    if (!fragments.length) return flattenAnalysis(job.id, job.analysis, { usage: copyJson(job.aiUsage), ai: { enhanced: 0, failed: 0 } })
    const providers = configuredProviderOrder(payload && payload.provider || 'auto')
    const limits = currentAiLimits()
    job.active = true
    job.cancelled = false
    const enhancements = []
    const failures = []
    let documentInputTokens = job.aiUsage.promptTokens
    try {
      for (let index = 0; index < fragments.length; index += 1) {
        if (job.cancelled) throw new Error('任务已取消')
        const fragment = fragments[index]
        const sourceText = fragmentSourceText(fragment, job.analysis)
        if (!sourceText) {
          failures.push({ id: String(fragment.id || ''), error: '缺少可验证的原文' })
          continue
        }
        sendProgress(event, job, { phase: 'ai', current: index + 1, total: fragments.length, message: '正在整理低可信片段…' })
        let completed = false
        let lastError = 'AI 整理失败'
        for (const provider of providers) {
          const messages = buildEnhanceMessages(fragment, sourceText, columns, job.analysis)
          const estimatedInput = estimateTokens(messages)
          if (estimatedInput > limits.inputTokenLimit) {
            lastError = '片段超过单次 AI Token 上限'
            break
          }
          if (documentInputTokens + estimatedInput > limits.documentTokenLimit || job.aiUsage.promptTokens + estimatedInput > limits.jobTokenLimit) {
            lastError = '已达到 AI Token 预算上限'
            break
          }
          const cacheKey = cacheKeyFor(provider, fragment, sourceText, columns)
          const cached = aiCache.get(cacheKey)
          try {
            let enhancement
            let usage = {}
            if (cached && Date.now() - cached.createdAt <= AI_CACHE_TTL_MS) {
              enhancement = copyJson(cached.value)
              job.aiUsage.cacheHits += 1
            } else {
              reserveUsage(job, estimatedInput)
              documentInputTokens += estimatedInput
              const response = await requestChatJson(provider, messages, limits, job)
              usage = response.usage
              const actualPrompt = clampInteger(usage.prompt_tokens, estimatedInput, 0, 1000000)
              reconcileUsage(job, usage, estimatedInput)
              documentInputTokens += actualPrompt - estimatedInput
              enhancement = validateEnhancement(response.json, fragment, sourceText, columns, job.analysis)
              enhancement.providerId = provider.providerId
              enhancement.model = response.model
              aiCache.set(cacheKey, { createdAt: Date.now(), value: copyJson(enhancement) })
            }
            enhancements.push(enhancement)
            completed = true
            break
          } catch (error) {
            lastError = safeErrorMessage(error, 'AI 整理失败')
          }
        }
        if (!completed) failures.push({ id: String(fragment.id || ''), error: lastError })
      }
      job.analysis = applyEnhancements(job.analysis, enhancements, failures)
      job.lastAccess = Date.now()
      return flattenAnalysis(job.id, job.analysis, {
        usage: copyJson(job.aiUsage),
        ai: { enhanced: enhancements.length, failed: failures.length, failures },
      })
    } finally {
      job.request = null
      job.active = false
      job.lastAccess = Date.now()
    }
  }

  function handleListPresets(event) {
    try {
      requireTrustedSender(event)
      const presets = loadPresets().presets
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(publicTablePreset)
      return { ok: true, presets }
    } catch (error) {
      return { ok: false, presets: [], error: safeErrorMessage(error, '读取表格预设失败') }
    }
  }

  function handleSavePreset(event, payload) {
    try {
      requireTrustedSender(event)
      const input = payload && typeof payload === 'object' ? payload : {}
      if (JSON.stringify(input).length > 65536) throw new Error('预设数据过大')
      const schemaInput = input.schema && typeof input.schema === 'object'
        ? input.schema
        : { tableTitle: input.tableTitle, rowDefinition: input.rowDefinition, fields: input.fields }
      const schema = normalizePresetSchema(schemaInput)
      const name = normalizePresetName(input.name, schema)
      const fingerprint = tablePresetFingerprint(schema)
      const state = loadPresets()
      const requestedId = input.presetId || input.id ? normalizePresetId(input.presetId || input.id) : ''
      const byId = requestedId ? state.presets.find(preset => preset.id === requestedId) : null
      const byFingerprint = state.presets.find(preset => preset.fingerprint === fingerprint)
      const target = byFingerprint || byId
      const now = new Date().toISOString()
      let created = false
      let deduplicated = Boolean(byFingerprint)
      let preset
      if (target) {
        target.name = name
        target.schema = schema
        target.fingerprint = fingerprint
        target.updatedAt = now
        target.useCount = Math.min(1000000000, target.useCount + 1)
        preset = target
        if (byId && byFingerprint && byId !== byFingerprint) {
          state.presets = state.presets.filter(item => item !== byId)
        }
      } else {
        if (state.presets.length >= MAX_TABLE_PRESETS) throw new Error(`本地表格预设最多保存 ${MAX_TABLE_PRESETS} 个`)
        preset = {
          id: crypto.randomUUID(),
          name,
          schema,
          fingerprint,
          createdAt: now,
          updatedAt: now,
          useCount: 1,
        }
        state.presets.push(preset)
        created = true
        deduplicated = false
      }
      savePresets()
      return { ok: true, preset: publicTablePreset(preset), created, deduplicated }
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error, '保存表格预设失败') }
    }
  }

  function handleDeletePreset(event, payload) {
    try {
      requireTrustedSender(event)
      const input = typeof payload === 'string' ? { presetId: payload } : (payload || {})
      const id = normalizePresetId(input.presetId || input.id)
      const state = loadPresets()
      const before = state.presets.length
      state.presets = state.presets.filter(preset => preset.id !== id)
      if (state.presets.length === before) throw new Error('预设不存在')
      savePresets()
      return { ok: true, presetId: id, deleted: true }
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error, '删除表格预设失败') }
    }
  }

  function handleUsePreset(event, payload) {
    try {
      requireTrustedSender(event)
      const input = typeof payload === 'string' ? { presetId: payload } : (payload || {})
      const preset = findPreset(input.presetId || input.id)
      if (!preset) throw new Error('预设不存在')
      incrementPresetUse(preset)
      return { ok: true, preset: publicTablePreset(preset) }
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error, '使用表格预设失败') }
    }
  }

  async function handleAnalyze(event, payload) {
    let job
    try {
      requireTrustedSender(event)
      const request = normalizeAnalyzeRequest(payload)
      let requestedPreset = null
      let requestedPresetSchema = null
      if (request.mode === 'smart' && request.presetId) {
        requestedPreset = findPreset(request.presetId)
        if (!requestedPreset) throw new Error('所选表格预设不存在或已被删除')
        requestedPresetSchema = copyJson(requestedPreset.schema)
      } else if (request.mode === 'smart' && request.presetSchema) {
        requestedPresetSchema = normalizePresetSchema(request.presetSchema)
      } else if (request.mode === 'smart' && request.fields.length) {
        requestedPresetSchema = {
          tableTitle: '预设格式表',
          rowDefinition: '每行代表一条独立记录',
          fields: presetFieldDefinitions(request.fields),
        }
      }
      const effectivePresetFields = requestedPresetSchema ? requestedPresetSchema.fields : request.fields
      const files = validateInputFiles(request.files)
      job = createJob(event, files, request)
      const prepared = await prepareInputFiles(event, job)
      const pythonRequest = {
        version: SERVICE_VERSION,
        files: prepared.files,
        mode: request.mode === 'smart' ? 'auto' : request.mode,
        fields: request.mode === 'smart' ? [] : request.fields,
        ocrLanguage: request.ocrLanguage,
      }
      let result = restoreLegacySourceNames(
        await runPythonAction(event, job, 'analyze', pythonRequest, PYTHON_ANALYZE_TIMEOUT_MS),
        prepared.aliases
      )
      job.analysis = result
      if (request.mode === 'smart') {
        const presetMatch = localSchemaMatchesPreset(result, effectivePresetFields)
        if (presetMatch.matched) {
          if (requestedPresetSchema) presetMatch.schema = copyJson(requestedPresetSchema)
          const matchedTable = presetMatch.table
          if (matchedTable) {
            matchedTable.title = presetMatch.schema.tableTitle
            matchedTable.rowDefinition = presetMatch.schema.rowDefinition
          }
          result.suggestedFields = presetMatch.schema.fields
          result.suggestedSchema = presetMatch.schema
          result.schemaGoal = request.goal
          result.aiSkipped = true
          result.aiSkipReason = 'preset-schema-match'
          result.presetId = requestedPreset ? requestedPreset.id : request.presetId
          job.analysis = result
          return flattenAnalysis(job.id, result, {
            suggestedFields: presetMatch.schema.fields,
            suggestedSchema: presetMatch.schema,
            schemaGoal: request.goal,
            aiSkipped: true,
            aiSkipReason: 'preset-schema-match',
            usage: copyJson(job.aiUsage),
            presetId: requestedPreset ? requestedPreset.id : request.presetId,
          })
        }
        let schema
        try {
          schema = await discoverSchema(event, job, result, request.goal, request.provider, requestedPresetSchema)
        } catch (error) {
          const localFields = collectColumns(result).slice(0, 20).map(column => ({
            key: column.key,
            label: column.label,
            aliases: [column.label],
            description: '',
            required: false,
          }))
          const presetFields = requestedPresetSchema ? requestedPresetSchema.fields : presetFieldDefinitions(request.fields)
          let fallbackFields = localFields
          if (presetFields.length >= 2) {
            try {
              fallbackFields = validateSuggestedSchema({ fields: presetFields }).fields
            } catch (validationError) {}
          }
          const localSchema = requestedPresetSchema || {
            tableTitle: '智能整理表',
            rowDefinition: '每行代表一条独立记录',
            fields: fallbackFields,
          }
          result.suggestedFields = fallbackFields
          result.suggestedSchema = localSchema
          result.schemaGoal = request.goal
          result.warnings = [
            ...(Array.isArray(result.warnings) ? result.warnings : []),
            { code: 'AI_SCHEMA_UNAVAILABLE', message: safeErrorMessage(error, '动态字段识别不可用，已保留本地分析结果') },
          ]
          job.analysis = result
          return flattenAnalysis(job.id, result, {
            suggestedFields: fallbackFields,
            suggestedSchema: localSchema,
            schemaGoal: request.goal,
            usage: copyJson(job.aiUsage),
          })
        }

        result = restoreLegacySourceNames(
          await runPythonAction(event, job, 'analyze', {
            version: SERVICE_VERSION,
            files: prepared.files,
            mode: 'fields',
            fields: schema.fields,
            ocrLanguage: request.ocrLanguage,
          }, PYTHON_ANALYZE_TIMEOUT_MS),
          prepared.aliases
        )
        result.suggestedFields = schema.fields
        result.suggestedSchema = schema.schema
        result.schemaGoal = request.goal
        result.schemaProvider = schema.providerId
        const primarySmartTable = Array.isArray(result.tables) ? result.tables[0] : null
        if (primarySmartTable) {
          primarySmartTable.title = schema.schema.tableTitle
          primarySmartTable.rowDefinition = schema.schema.rowDefinition
          primarySmartTable.kind = 'smart_fields'
        }
        job.analysis = result
        if (Array.isArray(result.unresolved) && result.unresolved.length) {
          try {
            const enhanced = await enhanceJob(event, job, { provider: request.provider, fragments: 'needs-review' })
            enhanced.suggestedFields = schema.fields
            enhanced.suggestedSchema = schema.schema
            enhanced.schemaGoal = request.goal
            enhanced.result.suggestedFields = schema.fields
            enhanced.result.suggestedSchema = schema.schema
            enhanced.result.schemaGoal = request.goal
            return enhanced
          } catch (error) {
            result.warnings = [
              ...(Array.isArray(result.warnings) ? result.warnings : []),
              { code: 'AI_CELL_ENHANCE_FAILED', message: safeErrorMessage(error, '动态字段已生成，但低可信片段 AI 增强失败') },
            ]
            job.analysis = result
          }
        }
        return flattenAnalysis(job.id, result, {
          suggestedFields: schema.fields,
          suggestedSchema: schema.schema,
          schemaGoal: request.goal,
          usage: copyJson(job.aiUsage),
        })
      }
      let response = flattenAnalysis(job.id, result)
      if (request.useAi && loadSecrets().settings.enabled && Array.isArray(result.unresolved) && result.unresolved.length) {
        response = await enhanceJob(event, job, { provider: request.provider, fragments: 'needs-review' })
      }
      return response
    } catch (error) {
      if (job && !job.analysis) cleanupJob(job.id)
      return { ok: false, jobId: job ? job.id : '', error: safeErrorMessage(error, '文档分析失败'), errors: [safeErrorMessage(error, '文档分析失败')] }
    }
  }

  async function handleExport(event, payload) {
    try {
      requireTrustedSender(event)
      const input = payload && typeof payload === 'object' ? payload : {}
      const job = ownedJob(event, input)
      if (!job.analysis) throw new Error('请先完成本地文档分析')
      const format = String(input.format || 'xlsx').toLowerCase()
      if (!['xlsx', 'csv'].includes(format)) throw new Error('仅支持导出 XLSX 或 CSV')
      const outputDir = path.resolve(getOutputDir())
      fs.mkdirSync(outputDir, { recursive: true })
      const outputPath = uniquePath(path.join(outputDir, makeOutputName(input, format)))
      const analysis = prepareExportAnalysis(job.analysis, input.tableData)
      const request = {
        version: SERVICE_VERSION,
        analysis,
        outputPath,
        format,
        options: {
          includeSource: input.options ? input.options.includeSource !== false : true,
        },
      }
      const result = await runPythonAction(event, job, 'export', request, PYTHON_EXPORT_TIMEOUT_MS)
      const outputs = Array.isArray(result.outputs) ? result.outputs.filter(item => typeof item === 'string') : []
      return {
        ok: result.success !== false,
        jobId: job.id,
        result,
        outputs,
        outputPath: outputs[0] || outputPath,
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
        stats: result.stats && typeof result.stats === 'object' ? result.stats : {},
      }
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error, '表格导出失败'), outputs: [] }
    }
  }

  async function handleEnhance(event, payload) {
    try {
      requireTrustedSender(event)
      const input = payload && typeof payload === 'object' ? payload : {}
      const job = ownedJob(event, input)
      if (input.tableData && typeof input.tableData === 'object') {
        job.analysis = prepareExportAnalysis(job.analysis, input.tableData)
      }
      return await enhanceJob(event, job, input)
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error, 'AI 整理失败') }
    }
  }

  function handleCancel(event, payload) {
    try {
      requireTrustedSender(event)
      const requestedId = typeof payload === 'string' ? payload : (payload && payload.jobId)
      let job
      if (requestedId) {
        job = ownedJob(event, payload)
      } else {
        job = [...jobs.values()]
          .filter(candidate => candidate.ownerId === event.sender.id && candidate.active)
          .sort((a, b) => b.createdAt - a.createdAt)[0]
        if (!job) throw new Error('没有正在执行的表格任务')
      }
      const wasActive = job.active
      job.cancelled = true
      if (job.process && !job.process.killed) {
        terminateChildProcess(job.process)
      }
      if (job.request && !job.request.destroyed) {
        try { job.request.destroy(new Error('任务已取消')) } catch (error) {}
      }
      if (!wasActive) cleanupJob(job.id)
      return { ok: true, jobId: job.id, cancelled: true }
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error, '取消任务失败') }
    }
  }

  async function handleSaveProvider(event, payload) {
    try {
      requireTrustedSender(event)
      const input = payload && typeof payload === 'object' ? payload : {}
      const providerId = canonicalProviderId(input.providerId || input.provider)
      const state = loadSecrets()
      if (providerId === 'general') {
        state.settings.enabled = Boolean(input.enabled == null ? input.aiEnabled : input.enabled)
        if (input.autoFallback != null) state.settings.autoFallback = Boolean(input.autoFallback)
        if (input.inputTokenLimit != null) {
          state.settings.inputTokenLimit = clampInteger(input.inputTokenLimit, state.settings.inputTokenLimit, 512, 8000)
        }
        state.settings.outputTokenLimit = clampInteger(input.outputTokenLimit, state.settings.outputTokenLimit, 128, 2000)
        state.settings.documentTokenLimit = clampInteger(input.documentTokenLimit ?? input.tokenLimit, state.settings.documentTokenLimit, 1000, 100000)
        state.settings.jobTokenLimit = clampInteger(input.jobTokenLimit, state.settings.jobTokenLimit, 2000, 200000)
        saveSecrets()
        return publicAiSettings()
      }
      if (![PROVIDER_IDS.V3, PROVIDER_IDS.V4].includes(providerId)) throw new Error('不支持的 AI 模型')
      const current = state.providers[providerId]
      if (providerId === PROVIDER_IDS.V4) {
        if (input.baseUrl && normalizeBaseUrl(input.baseUrl) !== V4_BASE_URL) throw new Error('DeepSeek V4.1 Flash API 地址不可修改')
        if (input.modelId && normalizeModelId(input.modelId) !== V4_MODEL_ID) throw new Error('DeepSeek V4.1 Flash 模型 ID 不可修改')
        current.baseUrl = V4_BASE_URL
        current.modelId = V4_MODEL_ID
      } else {
        if (input.baseUrl != null) current.baseUrl = normalizeBaseUrl(input.baseUrl)
        if (input.modelId != null) current.modelId = normalizeModelId(input.modelId)
        if (Boolean(input.enabled) && (!current.baseUrl || !current.modelId)) throw new Error('请填写 V3 兼容服务的 HTTPS 地址和模型 ID')
      }
      if (input.apiKey != null && input.apiKey !== '') {
        const apiKey = validateApiKey(input.apiKey)
        current.apiKeyCiphertext = encryptApiKey(apiKey)
        current.keyLast4 = apiKey.slice(-4)
        if (input.enabled == null) current.enabled = true
      }
      if (input.enabled != null) current.enabled = Boolean(input.enabled)
      if (current.enabled && !current.apiKeyCiphertext) throw new Error('请先填写 API Key')
      if (current.enabled && providerId === PROVIDER_IDS.V3 && (!current.baseUrl || !current.modelId)) {
        throw new Error('请填写 V3 兼容服务的 HTTPS 地址和模型 ID')
      }
      saveSecrets()
      return publicAiSettings()
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error, '保存 AI 设置失败') }
    }
  }

  function handleDeleteProvider(event, payload) {
    try {
      requireTrustedSender(event)
      const input = typeof payload === 'string' ? { providerId: payload } : (payload || {})
      const providerId = canonicalProviderId(input.providerId || input.provider)
      if (![PROVIDER_IDS.V3, PROVIDER_IDS.V4].includes(providerId)) throw new Error('不支持的 AI 模型')
      const state = loadSecrets()
      state.providers[providerId].apiKeyCiphertext = ''
      state.providers[providerId].keyLast4 = ''
      state.providers[providerId].enabled = false
      saveSecrets()
      return publicAiSettings()
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error, '删除 API Key 失败') }
    }
  }

  async function handleTestProvider(event, payload) {
    const startedAt = Date.now()
    try {
      requireTrustedSender(event)
      const input = typeof payload === 'string' ? { providerId: payload } : (payload || {})
      const providerId = canonicalProviderId(input.providerId || input.provider)
      if (![PROVIDER_IDS.V3, PROVIDER_IDS.V4].includes(providerId)) throw new Error('不支持的 AI 模型')
      const stored = loadSecrets().providers[providerId]
      const apiKey = input.apiKey ? validateApiKey(input.apiKey) : decryptApiKey(stored)
      let baseUrl
      let modelId
      if (providerId === PROVIDER_IDS.V4) {
        if (input.baseUrl && normalizeBaseUrl(input.baseUrl) !== V4_BASE_URL) throw new Error('DeepSeek V4.1 Flash API 地址不可修改')
        if (input.modelId && normalizeModelId(input.modelId) !== V4_MODEL_ID) throw new Error('DeepSeek V4.1 Flash 模型 ID 不可修改')
        baseUrl = V4_BASE_URL
        modelId = V4_MODEL_ID
      } else {
        baseUrl = normalizeBaseUrl(input.baseUrl || stored.baseUrl)
        modelId = normalizeModelId(input.modelId || stored.modelId)
      }
      const provider = { providerId, apiKey, baseUrl, modelId }
      const messages = [
        { role: 'system', content: '只输出 JSON。' },
        { role: 'user', content: '返回 {"ok":true}，不要添加其他内容。' },
      ]
      const response = await requestChatJson(provider, messages, { outputTokenLimit: 32 }, null)
      if (!response.json || response.json.ok !== true) throw new Error('模型响应未通过 JSON 校验')
      return {
        ok: true,
        providerId: provider.providerId,
        model: response.model,
        latencyMs: Date.now() - startedAt,
        usage: response.usage,
      }
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - startedAt, error: safeErrorMessage(error, '连接测试失败') }
    }
  }

  ipcMain.handle('table-analyze', handleAnalyze)
  ipcMain.handle('table-export', handleExport)
  ipcMain.handle('table-ai-enhance', handleEnhance)
  ipcMain.handle('table-cancel', handleCancel)
  ipcMain.handle('list-table-presets', handleListPresets)
  ipcMain.handle('save-table-preset', handleSavePreset)
  ipcMain.handle('delete-table-preset', handleDeletePreset)
  ipcMain.handle('use-table-preset', handleUsePreset)
  ipcMain.handle('get-ai-settings', event => {
    try {
      requireTrustedSender(event)
      return publicAiSettings()
    } catch (error) {
      return { ok: false, error: safeErrorMessage(error, '读取 AI 设置失败') }
    }
  })
  ipcMain.handle('save-ai-provider', handleSaveProvider)
  ipcMain.handle('delete-ai-provider', handleDeleteProvider)
  ipcMain.handle('test-ai-provider', handleTestProvider)

  function initialize() {
    if (disposed) return
    try { cleanStaleDirectories() } catch (error) { console.error('Table job cleanup initialization failed') }
    loadSecrets()
    loadPresets()
    cleanupTimer = setInterval(() => pruneJobs(true), 5 * 60 * 1000)
    if (cleanupTimer.unref) cleanupTimer.unref()
  }

  function dispose() {
    disposed = true
    if (cleanupTimer) clearInterval(cleanupTimer)
    cleanupTimer = null
    for (const jobId of [...jobs.keys()]) cleanupJob(jobId)
    aiCache.clear()
  }

  return { initialize, dispose }
}

module.exports = {
  createTableServices,
  __test: {
    normalizeAnalyzeRequest,
    representativeSamples,
    validateSuggestedSchema,
    validateSuggestedFields,
    localSchemaMatchesPreset,
    normalizePresetSchema,
    tablePresetFingerprint,
    prepareExportAnalysis,
  },
}
