# OfficeFlow 视觉改版说明（v4）

> 在 v3（动效重构）基础上做的**视觉改版**：配色分层、卡片去描边、阴影体系、间距节奏、
> 外壳与导航结构。功能代码未变，31 个 IPC 通道与 45 个事件处理器一个不少。
> **动效部分见 [`UI-v3-说明.md`](UI-v3-说明.md)**，两份改动在同一个 app.asar 里。

---

## 1. 为什么要再做一轮

v3 结束时你说「感觉界面 UI 没什么变化」——**这是准确的**。v3 是动效重构 + 排版精修，
动效在静帧里看不见，而视觉上只动了字体切字与行高，确实不够。

这一轮专门解决「一眼能看出」：**问题不在配色本身，而在三层表面的色差太小。**

改之前：

| 层 | 色值 | 问题 |
|---|---|---|
| 画布（内容区底） | `#F3F4F6` | 与卡片只差一点点 |
| 侧栏 | `#F7F8FA` | 与画布只差 2 个色阶，等于同一层 |
| 卡片 | `#FFFFFF` + `1px #E3E6EA` 描边 | 靠一根 1px 灰线分层，几乎没有浮起感 |

三个面几乎同色 → 白卡片「浮」不起来 → 整屏读起来是一张灰白的纸。

---

## 2. 改了什么

### 2.1 三层表面拉开（本轮的主杠杆）

| 层 | 改后 | 作用 |
|---|---|---|
| `--bg-chrome` | `#F2F6FB` | 标题栏 + 侧栏合成一块带品牌冷调的「外壳」 |
| `--bg-app` | `#E5EAF2` | 画布明显加深，白卡片才浮得起来 |
| `--bg-surface` | `#FFFFFF` | 卡片 / 面板纯白，落在画布上 |
| `--bg-veil` | `rgba(229,234,242,.94)` | 吸底条 = 画布的半透明版（**不再写死颜色**） |

### 2.2 卡片去掉描边，层级交给投影

每级阴影改成两层：一层近处勾边（贴上背景），一层远处铺开（浮起来）。

```
--sh-1: 0 1px 2px rgba(16,24,40,.05), 0 3px 12px rgba(16,24,40,.06)   卡片静置
--sh-2: 0 2px 6px rgba(16,24,40,.07), 0 12px 28px rgba(16,24,40,.11)  悬停 / 浮起
--sh-3: 0 16px 42px rgba(16,24,40,.18)                                模态 / 浮层
```

- 卡片 `border-color: transparent`，**保留 1px 占位**，避免去掉边框时布局跳动。
- 主按钮用**品牌色投影**（`--sh-brand`），CTA 才真的「凸」出来。
- 选中态改用 `--ring-brand`（一圈品牌描边 + 抬升），比「换底色 + 换描边色」干净。

### 2.3 侧栏与标题栏结构

- 两者共用 `--bg-chrome`，分隔线改用 `--chrome-line`，视觉上合成一块外壳。
- 当前导航项从「淡蓝底块」改成**落在外壳上的白色胶囊**（白底 + 品牌描边 + 投影）。
- 悬停底色由中性灰改成品牌色低透明度（`rgba(15,108,189,.07)`），和整体冷调一致。
- 导航项内边距 `9px 12px → 10px 13px`。

### 2.4 节奏与字阶

| 项 | v3 | v4 |
|---|---|---|
| 内容区内边距 | `24px 32px` | `32px 44px` |
| 页面区块间距 | 16px | 24px |
| 卡片内边距 | `20px 22px` | `22px 24px` |
| 圆角 | 6 / 8 / 12 / 16 | 8 / 10 / 14 / 18 |
| Hero 标题 | 26px | 30px |
| 区块标题 h2 | 15px | 16px |

**卡片去掉描边后，层级靠留白 + 投影承担，间距一紧就全糊在一起**——所以节奏必须同时放开。

### 2.5 顺带修掉的隐患

- `.table-sticky-actions` 原来写死 `rgba(243,244,246,.94)`（旧画布色）。画布一加深它就和背景对不上，
  已有 `--bg-veil` token 接管。
- 窗口控制按钮的按下底色 `#E2E5E9`、滚动条滑块 `#C9CED4` 同样跟着新外壳重算。
- 拖放接收窗同步换到新配色与圆角刻度。

---

## 3. 改配色时踩到的坑（重要）

画布一加深，**直接落在画布上的次要文字对比度会掉**。审计实测：

```
--text-muted #676D73 在白卡上 5.23 ✓  →  在新画布 #E5EAF2 上只有 4.33 ✗（需 4.5）
```

涉及步骤条标签、页面副标题等 18 个文本节点，全部不达标。

修法：`--text-muted` 由 `#676D73` 加深到 `#5D6369`。实测：

| 文本 | 白卡片 | 画布 #E5EAF2 | 外壳 #F2F6FB | 禁用底 #E9EDF3 |
|---|---|---|---|---|
| `--text` | 15.9 | 13.7 | 14.6 | 13.4 |
| `--text-secondary` | 7.8 | 6.8 | 7.2 | 6.6 |
| `--text-muted` | 6.1 | **5.0** | 5.6 | **5.2** |

**结论：`--text-muted` 是「画布相关」的 token，不是固定值。改画布必须重跑审计。**
这条已写进 `design-system/officeflow/MASTER.md`。

---

## 4. 验证结论（全部实际运行）

| 检查 | 结果 |
|---|---|
| `verify-ui-v2.cjs` 静态 | **FAIL 0 / 通过 9 项**；31 IPC 通道、45 事件处理器、29 个 id 全在 |
| `verify-css.cjs` 样式表静态 | **FAIL 0 / WARN 0**；68 个自定义属性全部有定义 |
| `verify-motion.cjs` 动效断言 | **32 / 32**；零页面错误 |
| `ui-v2-audit.cjs` 渲染审计 | **13 / 13 全清**；零页面错误 |
| `ui-v2-overlay-check.cjs` | 接收窗 5 态对比度 0 问题 |
| `ui-v2-visual-check.cjs` | 17 张截图，1440 / 900 两种宽度均无横向溢出 |

两点值得单独说：

1. **v3 里那条 `table-smart` 吸底条遮挡，本轮变成 clean 了**（v3 时 13 页里有 1 项 ISSUE）。
2. **审计的意义在这次体现出来了**：改配色后它一次性抓出 18 个对比度不达标节点，
   这是肉眼绝对看不出来的——AI 输出的浅灰文字在白底和灰底上「看起来都还行」。

---

## 5. 前后对比

我做了三张上下对照图（上 = 改前 v3，下 = 改后 v4）：

| 文件 | 内容 |
|---|---|
| [`tmp\visual-explore\compare-home.png`](tmp/visual-explore/compare-home.png) | 工作台首页 |
| [`tmp\visual-explore\compare-tasks.png`](tmp/visual-explore/compare-tasks.png) | 选择任务 |
| [`tmp\visual-explore\compare-settings.png`](tmp/visual-explore/compare-settings.png) | 设置 |

改后的单页截图在 `tmp\ui-v2\`（`01-home.png` … `23-narrow-settings.png`）。

---

## 6. 不满意怎么还原

```powershell
# 回到本轮视觉改版之前（v3：动效已改、配色未改）
.\scripts\restore-v3-ui.ps1

# 回到更早的两版
.\scripts\restore-v2-ui.ps1          # v2：v3 动效改造之前
.\scripts\restore-original-ui.ps1    # v1：出厂原版
```

> 本机 PowerShell 执行策略不允许直接跑 `.ps1`，实际命令是：
> `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-v3-ui.ps1`

| 备份 | 内容 | app.asar SHA256 前 16 位 |
|---|---|---|
| `backup-v1\` | 出厂原版 | `6817447BC2555A4C` |
| `backup-v2\` | v3 动效改造之前 | `1C350DB6B70DB4BD` |
| `backup-v3\` | v4 视觉改版之前 | `07F862759F43F57A` |

---

## 7. 文件改动

| 文件 | v3 | v4 |
|---|---|---|
| `app-source\style.css` | 60482 | 63213 |
| `app-source\drop-overlay.css` | 6230 | 6399 |
| `app-source\index.html` | 129589 | 129589（未改） |
| `app-source\drop-overlay.html` | 1720 | 1720（未改） |
| `design-system\officeflow\MASTER.md` | — | §2 配色 / §4 间距圆角 / §5 阴影 全部重写 |

打包产物：`tmp\app.asar` → `OfficeFlow\resources\app.asar`，
**614311 字节**（v3 为 611411），SHA256 前 16 位 `79FE396D3FD2D090`。

`electron.js`、`table-services.js`、`document_table.py`、`pdf_utils.py`、
`img_utils.py`、`ocr.ps1`、`drag-monitor.exe` 等**逐字节未变**。

新增脚本：

| 脚本 | 用途 |
|---|---|
| `scripts\explore-visual.cjs` | 并行渲染多套视觉方向候选，出对比截图（本轮用它选的方向） |
| `scripts\restore-v3-ui.ps1` | 回滚到 v3 |
