# OfficeFlow 界面优化说明

> 界面已优化完成，原版只保留在 `backup-v1\` 备份中（约 1.2 MB），一条命令即可还原。
> **功能已通过真实端到端验证**（13/13），详见 §4 与 `design-qa-v2.md`。

---

## 1. 现在长什么样

整个工作区只有一个可运行程序：

```
OfficeFlow\OfficeFlow.exe      ← 唯一入口，当前为优化后的界面
```

启动方式和以前完全一样：双击、托盘图标、开机自启动（`--hidden`）、
拖到桌面右侧的接收窗，全部照旧。开机自启动注册项仍然指向
`...\OfficeFlow\OfficeFlow.exe --hidden`，没有变。

---

## 2. 不满意怎么还原

```powershell
.\scripts\restore-original-ui.ps1
```

它会把 `app-source\` 和 `OfficeFlow\resources\app.asar` 一起还原成原版，
并校验哈希等于原版的 `6817447BC2555A4C…`，不一致就直接报错。

原版内容都在 `backup-v1\`：

| 备份项 | 内容 |
|---|---|
| `backup-v1\app-source\` | 原版全部 21 个源码文件 |
| `backup-v1\app.asar` | 原版打包产物（SHA256 `6817447BC2555A4C…`） |
| `backup-v1\app.asar.original` | 出厂自带的更早版本归档 |

---

## 3. 改了什么

只动了 4 个界面文件，其余 13 个（`electron.js`、`table-services.js`、
`document_table.py`、`pdf_utils.py`、`img_utils.py`、`ocr.ps1`、`drag-monitor.exe` 等）
逐字节未变。

| 文件 | 改动前 | 改动后 |
|---|---|---|
| `app-source\index.html` | 100 KB | 126 KB |
| `app-source\style.css` | 25 KB | 52 KB |
| `app-source\drop-overlay.html` | 0.9 KB | 1.7 KB |
| `app-source\drop-overlay.css` | 2.8 KB | 5.4 KB |

### 具体优化点

**整体框架**
- 标题栏 32→40px，加入应用标识与副标题；最小化/最大化/关闭从文字符号 `− □ ×`
  换成 SVG 图标，关闭按钮悬停变红。
- 侧边栏 200→224px，导航项加图标、当前项加左侧指示条与品牌色底；
  底部新增「本地优先」说明卡。
- 内容区居中限宽 1120px，窗口最大化时表单不再被拉得过长。

**能力图标化**
- 21 个任务原本用 `XLS / PDF / ++ / -- / 90 / WM / RZ / CVT / GRAY` 这类自造字母码
  当图标，换成 16 个语义 SVG 图标（表格、转 PDF、提取文本、合并、拆分、水印、
  压缩、旋转、OCR…），并保留 Word 蓝 / Excel 绿 / PDF 红 / PPT 橙 / 图片蓝的语义色。
- 页面上的 `+`、`...`、`OK`、`!` 等占位符号全部替换为 SVG。

**流程感**
- 上传页与任务页新增「选择文件 → 选择任务 → 查看结果」步骤条，已完成步骤可点击回退。
- 任务页底部加吸底操作条，长列表下按钮始终可达。
- 处理中 / 结果页改为状态卡：旋转指示器、渐变进度条、成功失败圆形图标与统计块。

**可读性与可达性**
- 正文次要文字由 `#999`（对比度 2.85:1，不达标）改为 `#676D73`（4.97:1）。
- 小字号下限统一 12px（原来有 10px、11px 的状态徽标与说明文字）。
- 所有可交互元素补齐 `hover / active / focus-visible` 三态；
  禁用态文字对比度由 2.3–2.8:1 提升到 4.7:1。
- 空状态全部给出图形 + 说明 + 下一步按钮。
- 拖放接收窗同步换用新配色与图标，并修好「支持格式」提示行对比度不足的问题。

**顺手修掉的原有缺陷**
- `getExtColor` 里 `txt/md` 用 `#666`、兜底用 `#999`，拼上 `20` 之后得到
  `#66620` 这种非法色值，徽标背景色一直没生效。现在统一为 6 位色 + `1F` 透明度。

**设计规范**
配色、字体、间距、圆角、阴影、动效统一收敛为 CSS 变量，
写在 `design-system\officeflow\MASTER.md`。

---

## 4. 验证结论

全部为实际运行结果。

### 4.1 静态正确性（`node scripts\verify-ui-v2.cjs`）

把当前 `app-source` 与原版 `backup-v1\app-source` 逐函数对比：

| 检查 | 结果 |
|---|---|
| 函数级源码对比 | 48 个函数源码完全相同；5 个差异全部在模板插值内部（只塞图标/步骤条/空状态） |
| 语句级差异 | 7 个，逐个复核均为 HTML 模板改动；唯一真实逻辑改动是 `setupDragDrop` 里 drop 之后 `renderUpload(...)` → `showPage('upload')`（同步导航高亮，行为等价） |
| v2 新增函数 | `icon` `taskIcon` `hydrateIcons` `renderStepper` `emptyState` `getExtIcon` `getExtInk` `setPythonStatus` |
| 事件处理器 | 原版 45 个，新版 45 个，无缺失、未定义 |
| 元素 id 引用 | JS 引用的 28 个 id 全部存在（含 `${providerId}-key` 这类动态 id） |
| IPC 通道 | 原版 31 个，新版 31 个，**完全一致，无丢失** |
| 样式覆盖 | 无「原版有样式、新版丢样式但 HTML 仍在用」的 class |

### 4.2 真实功能端到端（`node scripts\ui-v2-functional-check.cjs`）

启动正式程序 `OfficeFlow\OfficeFlow.exe`，用 CDP 驱动真实界面跑完整流程：

```
13 / 13 通过
 ✓ check-python-deps            python 依赖就绪
 ✓ get-app-settings             输出目录读取正常
 ✓ 投递文件 -> 上传页列表        走真实 drop 处理分支
 ✓ 任务页选中 document-to-table
 ✓ 整理工作台渲染               4 种模式、按文件数正确启用「开始分析」
 ✓ 本地解析 -> 表格预览         2 行，表头 姓名/部门/电话，首行 张三/销售部/13800138000
 ✓ 单元格编辑联动状态徽标        改成 E2E-已编辑 后徽标变「已编辑」
 ✓ 导出 XLSX                    整理结果_20260914112233.xlsx（8847 B，zip 签名正确）
 ✓ XLSX 文件落盘
 ✓ 按文件类型筛选任务            PNG 过滤出 8 个任务
 ✓ 图片转灰度产出文件            ocr-smoke-scan-1_gray.png
 ✓ 结果文件页读取真实输出目录    3 行
 ✓ 历史记录页读取 localStorage   2 条
```

导出的 XLSX 用项目自带工具 `qa\verify-exported-xlsx.mjs` 复核，内容正确：

| Sheet | 内容 |
|---|---|
| 数据 | 表头 `姓名/部门/电话/来源编号`，2 行数据，**含编辑后的 `E2E-已编辑`** |
| 待确认 | 表头 `编号/原因/内容/来源编号/建议操作` |
| 来源索引 | 6 条来源记录，可回溯到 `qa\table-service-fixture.txt` 的具体行号与原文 |

公式错误扫描：0 条。

顺带验证了错误处理：把 txt 文件也投给「转灰度」时，结果页正确显示
「部分完成 · 1 成功 1 失败」，并给出 `cannot identify image file` 的具体原因，
成功文件照常产出。

### 4.3 渲染审计（`node scripts\ui-v2-audit.cjs`）

13 个页面状态 × 9 类断言（横向溢出、文本对比度、最小字号、点击目标尺寸、
图标墨迹、文本裁切、粘性条遮挡焦点、重复 id、图标占位）：

```
clean  home / upload×2 / tasks×2 / processing / result / outputs /
       history / settings / table-configure / table-preview    12 项全清
ISSUE  table-smart  仅 1 项：吸底条在某个中间滚动位置几何上盖住「刷新」
页面错误：无
键盘聚焦遮挡探针（26 个控件）：covered = []
```

吸底条那项已用 `scroll-padding-bottom: 88px` 处理：键盘聚焦时浏览器会把控件
滚出遮挡区（探针已验证），属于吸底操作条的固有表现，非缺陷。

窄屏 900×600：4/4 无横向滚动。拖放接收窗 360×280 五种状态：对比度全部达标、无裁切。

### 4.4 打包完整性

- 用自研打包器从 `backup-v1\app-source` 重新打包，产物与**出厂自带的 app.asar
  逐字节一致**（SHA256 相同），证明打包链路可信。
- `OfficeFlow\resources\app.asar` 解包后与 `app-source\` 0 处不一致。

---

## 5. 目录结构

```
OfficeFlow-Portable-Fixed\
├─ OfficeFlow\                 ← 唯一可运行程序（当前为新界面）
│   └─ resources\app.asar      ← 新版界面归档
├─ app-source\                 ← 源码（= 当前生效的界面）
├─ backup-v1\                  ← 原版备份：源码 + app.asar，用于还原
├─ design-system\officeflow\   ← 设计规范 MASTER.md
├─ design-qa-v2.md             ← 渲染与功能验收报告
├─ UI-v2-说明.md               ← 本文件
├─ scripts\                    ← 打包 / 还原 / 各类校验脚本
└─ tmp\ui-v2*\                 ← 截图与审计原始数据
```

常用脚本：

```powershell
.\scripts\pack-app.ps1                 # 从 app-source 打包并安装到 OfficeFlow
.\scripts\pack-app.ps1 -CheckOnly      # 只打包校验，不覆盖
.\scripts\restore-original-ui.ps1      # 还原原版界面
node .\scripts\verify-ui-v2.cjs        # 静态正确性（对比原版）
node .\scripts\ui-v2-audit.cjs         # 渲染审计（需要 Chrome）
node .\scripts\ui-v2-functional-check.cjs  # 真实端到端功能验证
```

> 注：`scripts\*.ps1` 是 UTF-8 **带 BOM** 保存的，因为本机是 Windows PowerShell 5.1，
> 无 BOM 时会把中文注释按 ANSI 解析而报语法错误。后续编辑请保持 BOM。

---

## 6. 遗留说明

- **我没有肉眼看过截图**：生成这些结果的模型不支持读图，视觉效果是靠渲染后的
  DOM 几何与计算样式逐项断言的。截图在 `tmp\ui-v2\`（浏览器 13 页 + 窄屏 4 页 +
  拖放窗 5 态）和 `tmp\app-verify\`（正式程序 3 页），建议你自己过一眼。
- `qa\table-services-smoke.js` 未能运行：它需要 spawn PowerShell 并抓取输出，
  在当前环境被拒绝（`EPERM`）。它与界面无关，`table-services.js` 逐字节未改动。
- 拖放接收窗的**展开动画**没有做端到端验证：它由 `drag-monitor.exe` 在真实
  桌面拖拽时触发，无法用脚本模拟真实鼠标拖拽；本次验证覆盖其 5 种可见状态的渲染。
