# OfficeFlow 界面优化 — 渲染与功能验收报告

对应用户需求「界面优化 + 保留原版本」。本文件只记录**实测结果**，不含主观评价。
原版 overlay 的历史验收记录见 `design-qa.md`。

> 目录已收敛：`app-source\` 即当前生效的界面源码，
> 原版界面与归档保留在 `backup-v1\`。

## 被测对象

| 项 | 值 |
|---|---|
| 源码 | `app-source\index.html`、`style.css`、`drop-overlay.html`、`drop-overlay.css` |
| 打包产物 | `OfficeFlow\resources\app.asar` (SHA256 `1C350DB6B70DB4BD…`) |
| 对照基准 | `backup-v1\app-source\`、`backup-v1\app.asar` (`6817447BC2555A4C…`) |
| 运行环境 A | 真实 Electron 28.3.3 / Chromium 120.0.6099.291（`OfficeFlow\OfficeFlow.exe`） |
| 运行环境 B | 系统 Chrome（Playwright 驱动），1440×900 与 900×600 |
| 视口 | 1440×900（主）、900×600（窄屏）、360×280（拖放窗） |

## 1. 静态正确性（对照原版逐函数比对）

`node scripts\verify-ui-v2.cjs`，把当前 `app-source` 与 `backup-v1\app-source` 对比：

| 检查项 | 结果 |
|---|---|
| 函数级源码对比 | 48 个函数源码完全相同 |
| 差异只在模板插值内部 | 5 个（`renderTableWorkbench`、`renderTablePreview`、`renderProcessing`、`renderHistory`、`renderAiProviderCard`）——新增内容均为 `${icon(...)}` / `${renderStepper(n)}` / `emptyState(...)` |
| 语句级差异（人工复核） | 7 个：`renderHome`（新增 UI 数据数组 `features`）、`renderUpload`、`renderTasks`、`renderTableRow`、`updateTableCell`、`renderResult`、`renderAiProviderCard` —— 均为 HTML 模板改动 |
| 唯一真实逻辑改动 | `setupDragDrop` 中 drop 后 `renderUpload(document.getElementById('content'))` → `showPage('upload')`，同步导航高亮，行为等价 |
| 新增函数 | `icon` `taskIcon` `hydrateIcons` `renderStepper` `emptyState` `getExtIcon` `getExtInk` `setPythonStatus` |
| 事件处理器 | 原版 45 个 / 新版 45 个，无未定义、无丢失 |
| 元素 id 引用 | JS 引用的 28 个 id 全部存在于 HTML（含 `${providerId}-key` 等动态 id） |
| IPC 通道 | 原版 31 个 / 新版 31 个，**集合完全一致** |
| 样式覆盖 | 无「原版有规则、新版缺规则但 HTML 仍在用」的 class |

FAIL 0 项。

## 2. 真实功能端到端（Electron 28 实际运行）

`node scripts\ui-v2-functional-check.cjs` 启动 `OfficeFlow\OfficeFlow.exe`，
通过 CDP 驱动真实界面走完整业务流程：**13 / 13 通过**。

| # | 用例 | 实测结果 |
|---|---|---|
| 1 | `check-python-deps` | `{ok:true, command:"python", missing:[]}` |
| 2 | `get-app-settings` | `outputDir=…\OfficeFlow\结果` |
| 3 | 投递文件 → 上传页列表 | `["table-service-fixture.txt"]`（走真实 drop 处理分支） |
| 4 | 选中 `document-to-table` | `.task-card.selected` 存在 |
| 5 | 整理工作台渲染 | 4 个模式卡；1 份文档；「开始分析」可用 |
| 6 | 本地解析 → 表格预览 | 2 行；表头 `#,姓名,部门,电话,状态,来源`；首行 `张三/销售部/13800138000` |
| 7 | 单元格编辑联动 | 改为 `E2E-已编辑` 后徽标变「已编辑」 |
| 8 | 导出 XLSX | `整理结果_20260914112233.xlsx` |
| 9 | 文件落盘 | 8847 B，ZIP 签名 `PK` 正确 |
| 10 | 按类型筛选任务 | PNG 过滤出 8 个任务 |
| 11 | 图片转灰度 | 产出 `ocr-smoke-scan-1_gray.png` |
| 12 | 结果文件页 | 读取输出目录，3 行 |
| 13 | 历史记录页 | 读取 localStorage，2 条 |

**导出文件内容复核**（`qa\verify-exported-xlsx.mjs`，公式错误扫描 0 条）：

| Sheet | 内容 |
|---|---|
| 数据 | `A1:D3` — 表头 `姓名/部门/电话/来源编号`；第 2 行含编辑后的 `E2E-已编辑` |
| 待确认 | `A1:E1` — `编号/原因/内容/来源编号/建议操作` |
| 来源索引 | `A1:J7` — 6 条来源，回溯到 `qa\table-service-fixture.txt` 的第 1/2/3/5/6/7 行与原文 |

**错误处理**：把 txt 一并投给「转灰度」时，结果页正确显示
「部分完成 · 1 成功 1 失败」，失败原因 `cannot identify image file …`，
成功文件照常产出。

## 3. 渲染审计（13 个页面状态）

逐页断言九类问题：横向溢出、文本对比度、最小字号、点击目标尺寸、
图标墨迹、文本裁切、粘性条遮挡、重复 id、`data-icon` 未填充。

| 页面状态 | 图标数 | 问题 |
|---|---|---|
| home 工作台 | 17 | clean |
| upload-empty / upload-files | 12 / 20 | clean |
| tasks / tasks-selected | 26 / 26 | clean |
| processing | 12 | clean |
| result | 24 | clean |
| outputs | 24 | clean |
| history | 13 | clean |
| settings | 34 | clean |
| table-configure | 14 | clean |
| table-smart | 14 | 见下方说明 |
| table-preview | 26 | clean |

- 控制台错误：无（仅测试用静态服务器对 `/favicon.ico` 返回 404，与应用无关）
- 横向溢出：所有页面 `scrollWidth == clientWidth`
- 对比度：正文全部 ≥ 4.5:1
- 最小字号：无 < 12px 的可见文本
- 点击目标：全部 ≥ 24×24 CSS px
- 键盘聚焦遮挡探针：26 个控件，`covered = []`

**保留项**：`table-smart` 在某个中间滚动位置，吸底操作条几何上盖住预设区「刷新」。
键盘聚焦时浏览器按 `scroll-padding-bottom: 88px` 将其滚出遮挡区（探针已验证），
属吸底操作条固有表现。

## 4. 窄屏（900×600）

`20-narrow-home` / `21-narrow-upload` / `22-narrow-tasks` / `23-narrow-settings`：
4/4 无横向溢出、无文本裁切。侧边栏收窄至 176px，多列栅格降为单列。

## 5. 拖放接收窗（360×280）

独立文档，CSP 为 `style-src 'self'`，仅用外部样式表，无内联样式。

| 状态 | body class | 面板 | 拖放区 | 对比度问题 | 裁切 |
|---|---|---|---|---|---|
| collapsed | （无） | 355×276 | 326×205 | 0 | 无 |
| expanded | `expanded` | 360×280 | 331×208 | 0 | 无 |
| dragging | `expanded dragging` | 360×280 | 334×210 | 0 | 无 |
| success | `expanded success` | 360×280 | 331×208 | 0 | 无 |
| error | `expanded error` | 360×280 | 331×208 | 0 | 无 |

collapsed 状态文档 `scrollWidth` 为 388（>360）来自入场位移 `translateX(28px)`；
`html, body` 均为 `overflow: hidden`，不产生滚动条，接收窗也处于不可见状态，属预期行为。

## 6. 修正记录

审计过程中发现并修好的真实问题：

| # | 问题 | 证据 | 修正 |
|---|---|---|---|
| 1 | `--text-muted` 4.49:1 | 对比度告警 | 改为 `#676D73`（4.97:1） |
| 2 | 禁用按钮文字 2.48 / 2.78:1 | 对比度告警 | 统一 `--text-muted`（4.7:1） |
| 3 | PDF/图片类型徽标 3.9 / 3.86:1 | 对比度告警 | 新增 `getExtInk()`（6.05 / 4.59:1） |
| 4 | `.stat--danger span` 4.32:1 | 对比度告警 | 改用 `--danger`（4.95:1） |
| 5 | 吸底条遮挡获得焦点的控件 | 聚焦遮挡探针 | `.content { scroll-padding-bottom: 88px }` |
| 6 | 「允许自动回退」勾选框高 20px | 目标尺寸告警 | `.check-label { min-height: 24px }` |
| 7 | 拖放窗提示行 4.07–4.44:1 | 拖放窗审计告警 | 改用 `--text-secondary` |
| 8 | 原代码 `#666`/`#999` 拼 `20` 得到非法色值 `#66620` | 代码审查 | 统一 6 位色 + `1F` |
| 9 | 4 个 class 在原样式表有规则、新样式表没有但 HTML 仍在用 | 样式覆盖校验 | 从标记中移除失效的钩子类 |

## 7. 打包与完整性

| 检查 | 结果 |
|---|---|
| 自研打包器复现出厂 `app.asar` | **逐字节一致**（SHA256 `6817447BC2555A4C…`） |
| `OfficeFlow\resources\app.asar` 解包 vs `app-source` | 0 处不一致 |
| `backup-v1\app-source` vs 迁移前的原版 `app-source` | 21 个文件，0 处差异 |
| 改动的源码文件 | 4 个（仅界面）；其余 13 个逐字节相同 |

## 8. 功能回归

| 用例 | 命令 | 结果 |
|---|---|---|
| 表格工作台 UI 状态机 | `node qa\table-ui-state-test.js` | `Table UI state tests: OK` |
| 表格服务烟测 | `node qa\table-services-smoke.js` | 未能运行：需 spawn PowerShell 抓取输出，环境拒绝（`EPERM`）。与界面无关，`table-services.js` 未改动 |

## 9. 已知限制

- **未做人眼视觉比对**：生成这些结果的模型不支持图像输入，视觉效果通过渲染后
  DOM 几何 + 计算样式断言验证。截图已产出（`tmp\ui-v2\`、`tmp\app-verify\`），建议人工过目。
- **拖放接收窗的展开动画未做端到端验证**：它由 `drag-monitor.exe` 在真实桌面
  拖拽时触发，无法用脚本模拟真实鼠标拖拽。本次覆盖其 5 种可见状态的渲染。
- **DOM drop 分支的文件路径注入受限**：Electron 28 无 `webUtils`，CDP 注入的 File
  拿不到原生路径（`File.path` 为空），因此用例 3 用带 `path` 的普通对象数组驱动
  真实的 drop 监听器，而非真实鼠标拖拽。
