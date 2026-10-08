# OfficeFlow 动效与界面升级说明（v3）

> **后续更新：本文件里的「界面精修」部分已被 [`UI-v4-说明.md`](UI-v4-说明.md) 的视觉改版取代**
> （配色分层、卡片去描边、阴影体系、间距节奏）。动效部分（§2.1）**仍然有效**，
> 与 v4 视觉改动一起在同一个 app.asar 里。
>
> 在 v2 界面基础上做的第二轮：**动效体系重构 + 界面精修**。
> 功能代码未变，31 个 IPC 通道与 45 个事件处理器一个不少。
> **尚未打包**——等你确认后再执行 `.\scripts\pack-app.ps1`。

---

## 1. 一句话概括

v2 的界面骨架是对的，但动效只有**一条曲线打天下**：入场、位移、悬停全用
`cubic-bezier(.2,.8,.2,1)`，列表整块弹出来，按钮按下只有颜色变化，
进度条靠改 `width` 推进，`prefers-reduced-motion` 一刀切归零。
这一轮把动效拆成**按用途分层的曲线体系**，补上缺失的反馈与连续性，
并把排版按**光学尺寸**分了层。

---

## 2. 改了什么

### 2.1 动效体系重构

| # | 位置 | 改前 | 改后 | 为什么 |
|---|---|---|---|---|
| 1 | 全局曲线 | 只有 `--ease` 一条 | `--ease-out` / `--ease-in-out` / `--ease-drawer` / `--ease-soft` 四条 | 入场和悬停用同一条曲线，必有一方是错的 |
| 2 | 进度条 | `transition: width` | `transform: scaleX(var(--p))` | 改宽度会触发每帧重排；高光同步改成 `background-position`，否则关键帧会盖掉 `scaleX` |
| 3 | 页面切换 | 无方向感，前进/后退长得一样 | 前进从下升入、后退从上沉降、侧栏页淡入 | 有步骤条的产品，转场必须告诉用户"往前还是往回" |
| 4 | 列表 | 整块同时出现 | 逐项 24ms 瀑布，第 7 项起封顶 | 一屏卡片同时弹出没有层次；封顶避免长列表末尾等太久 |
| 5 | 按钮 | 只有颜色变化 | 按下 `scale(.97)`，110ms | 按下去的那一帧就要有回应，不等 `click` |
| 6 | 侧边栏 | 指示条凭空出现 | 整条唯一，换页时滑过去 | 用户要能看见"当前项从哪来" |
| 7 | 降低动效 | `animation-duration:.01ms` 一刀切 | 只去掉位移/缩放/stagger，保留淡入与色彩 | 一刀切把该保留的淡入淡出也杀了；旋转指示器改为透明度呼吸 |
| 8 | 触摸 | 无门控 | 位移类悬停加 `@media (hover:none),(pointer:coarse)` | 触摸屏上 `:hover` 点按后会粘住 |

**一个必须记下来的坑**：入场动画用 `animation-fill-mode: both` 会把最终关键帧
永久钉住，**压死卡片悬停的 `transform`**。全部改用 `backwards`——
延迟期间保持起始状态，动画结束回到声明样式，悬停照常生效。
这一条已写进 `design-system/officeflow/MASTER.md`。

### 2.2 界面精修

| # | 改动 | 说明 |
|---|---|---|
| 1 | **光学尺寸字体分层** | 标题走 `Segoe UI Variable Display`，正文走 `Segoe UI Variable Text`。Win11 自带两套切字，用 Text 那套渲染 20px 以上标题会显得松散、笔画偏粗 |
| 2 | **字距随字号走** | Hero 26px `-0.019em`、h1 22px `-0.014em`、状态卡 20px `-0.014em`、正文 0、小字 `+0.006em`。固定一个值必然有地方是错的 |
| 3 | **大标题行高收紧** | h1 `1.3 → 1.25`，Hero `1.35 → 1.2` |
| 4 | **拖放接收窗材质** | 上浅下深渐变 + 更深的投影，桌面窗口没有可模糊的背景，靠这两点读出"厚度"；三层依次到位（面板 → 内容 → 上下文标签），走抽屉曲线 |
| 5 | **就地刷新不重播入场** | 点选任务卡、删一个文件时整页重渲染，v2 会看到整屏跳一下；现在根节点加 `.no-enter`，只有真正进入页面才有入场 |

---

## 3. 验证结论

全部为**实际运行结果**，不是推断。

### 3.1 静态正确性 `node scripts\verify-ui-v2.cjs`

```
FAIL 0 项 | WARN 1 项（预设占位 class，v2 既有）| 通过 9 项
```

| 检查 | 结果 |
|---|---|
| IPC 通道 | 原版 31 / 新版 31，**完全一致** |
| 事件处理器 | 原版 45 / 新版 45，无缺失、无未定义 |
| 元素 id 引用 | JS 引用的 29 个 id 全部存在 |
| 函数级源码对比 | 42 个函数逐字节相同 |
| 语句级差异 | 13 处，**逐条复核，全部是本次有意的界面/动效改动**（方向感转场、`--i` 索引、`animate` 参数、`setProgressFill`），无一处逻辑改动 |

新增函数：`pageDirection` `setProgressFill` `moveNavIndicator`。

### 3.2 样式表静态校验 `node scripts\verify-css.cjs`（本次新增）

无浏览器也能跑的样式检查：括号/引号配平、61 个自定义属性全部有定义、
9 个关键帧全部被正确定义、**0 处动效反模式**
（无 `transition: all`、无 `scale(0)` 入场、无 `width/top/left` 过渡、
无入场 `ease-in`、`transform` 过渡没走弱曲线）。

```
FAIL 0 项 | WARN 0 项
```

### 3.3 动效断言 `node scripts\verify-motion.cjs`（本次新增）

截图看不出动效对不对，所以直接读渲染后的计算样式逐条断言：

```
32 / 32 通过        页面错误：无
```

关键实测值：

| 断言 | 实测 |
|---|---|
| 指示条对齐当前项 | 指示条中心 72.00 / 项目中心 71.80（差 0.2px） |
| 指示条真的滑过去 | `translateY(23px) → translateY(206.375px)`，位移曲线 `cubic-bezier(.77,0,.175,1)` |
| 进度条走 transform | `matrix` 的 scaleX = 0.5（`--p:0.5`），`transition-property: transform` |
| **stagger 真的生效** | 实测 `0, 24, 48, 72, 96, 120, 144, 144, 144` ms —— `min(--i,6)` 封顶按预期工作 |
| 入场不压住悬停 | `fill-mode: backwards`，悬停 `transform` 从 `none → translateY(-2px)` |
| 方向感 | `forward` / `back` / `lateral` / 同页为空，四态全对 |
| 就地刷新 | `.no-enter` 生效，页面与列表 `animation-name: none`，选中态仍正确落地 |
| 降低动效 | 入场降级 `fade-in`、stagger 归零、指示条只过渡 `opacity`、卡片保留色彩过渡去掉位移、旋转 `none`、呼吸 `pulse-soft` + `infinite` |
| 光学字体 | h1 = `Segoe UI Variable Display`，body = `Segoe UI Variable Text` |

### 3.4 渲染审计 `node scripts\ui-v2-audit.cjs`

13 个页面状态 × 9 类断言（横向溢出 / 对比度 / 最小字号 / 点击目标 /
图标墨迹 / 文本裁切 / 粘性条遮挡 / 重复 id / 图标占位）：

```
clean  home / upload-empty / upload-files / tasks / tasks-selected /
       processing / result / outputs / history / settings /
       table-configure / table-preview        12 项全清
ISSUE  table-smart   仅 1 项：吸底条在某个中间滚动位置几何上盖住「刷新」
页面错误：无
```

`table-smart` 这一项 **v2 就存在**，不是本次引入的回归。
键盘聚焦遮挡探针 26 个控件：`covered = []`。

结构快照确认骨架未变：titlebar 40 / sidebar 224 / 基准字号 14px / 内容区限宽 1120。

### 3.5 截图 `node scripts\ui-v2-visual-check.cjs`

17 张截图全部生成，1440 与 900 两种宽度**均无横向溢出**。
产物在 `tmp\ui-v2\`（`01-home` … `23-narrow-settings`）。

**本次我真的看过截图了**：首页四张能力卡几何完全一致
（卡片 top 348.8 / 图标 365.8 / 标题 408.8 / 描述 435.4，四张逐像素相同）；
任务页正确不显示侧栏指示条（"选择任务"不是侧栏页面）；
处理页进度条 62% 渲染正确。

### 3.6 拖放接收窗 `node scripts\ui-v2-overlay-check.cjs`

5 种状态，对比度问题 0、文字裁切 0。`expanded / dragging / success / error` 全清；
`collapsed` 报的 `docScrollW 388 > 360` 是**收起态面板按设计停在屏幕外 28px**
（`translateX(28px)`）造成的几何值，不是缺陷。

### 3.7 打包链路 `.\scripts\pack-app.ps1 -CheckOnly`

```
packed app-source -> tmp\app.asar  (611411 bytes, 14 embedded, top-level 18)
校验 10 个文件，差异 0 个
```

正式程序的 `app.asar` **未被触碰**（SHA256 前 16 位仍是 `1C350DB6B70DB4BD`）。

---

## 4. 不满意怎么还原

```powershell
# 回到本次升级之前的 v2 界面
.\scripts\restore-v2-ui.ps1

# 回到出厂原版（更早的 v1）
.\scripts\restore-original-ui.ps1
```

> 本机 PowerShell 执行策略不允许直接跑 `.ps1`，实际命令是：
> `powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\restore-v2-ui.ps1`

两个脚本都会校验 `app.asar` 的 SHA256，不一致直接报错，不会留半吊子状态。

| 备份 | 内容 | app.asar SHA256 前 16 位 |
|---|---|---|
| `backup-v1\` | 出厂原版 | `6817447BC2555A4C` |
| `backup-v2\` | 本次升级前的界面 | `1C350DB6B70DB4BD` |

---

## 5. 文件改动

| 文件 | v2 | v3 |
|---|---|---|
| `app-source\index.html` | 126537 | 129589 |
| `app-source\style.css` | 52127 | 60482 |
| `app-source\drop-overlay.css` | 5404 | 6230 |
| `app-source\drop-overlay.html` | 1720 | 1720（未改） |

`electron.js`、`table-services.js`、`document_table.py`、`pdf_utils.py`、
`img_utils.py`、`ocr.ps1`、`drag-monitor.exe` 等**逐字节未变**。

新增脚本：

| 脚本 | 用途 |
|---|---|
| `scripts\verify-css.cjs` | 样式表静态校验（无浏览器） |
| `scripts\verify-motion.cjs` | 32 项动效断言（读计算样式） |
| `scripts\lib\browser.cjs` | 渲染脚本的浏览器启动器 |
| `scripts\restore-v2-ui.ps1` | 回滚到 v2 |

**顺带修好的工具链问题**：本机没装 Playwright 的浏览器包，而且
Playwright 默认走 `--remote-debugging-pipe`（命名管道）会被沙箱拒绝，
表现是 `chromium.launch()` 挂住不报错。现在三个渲染脚本统一改用
`scripts\lib\browser.cjs`：自己拉起系统 Chrome，走 TCP 调试端口，
再用 `connectOverCDP` 接上去，收尾时 `taskkill /T` 清掉整棵进程树。

---

## 6. 已知边界（没做的事）

- **没有动 Electron 原生窗口材质**。本机是 Win11 25H2，Electron 支持
  `backgroundMaterial: 'acrylic'`，但那要改 `electron.js`、把窗口设成透明、
  页面背景改半透明——影响面远超"UI 和动效"，且无法在不实际拖拽的情况下验证。
  拖放接收窗改用**渐变 + 更深投影**在页面内表达材质，效果可见且零风险。
- **拖放接收窗的展开动画仍未做端到端验证**：它由 `drag-monitor.exe` 在真实
  桌面拖拽时触发，脚本模拟不了真实鼠标拖拽（v2 就有这条遗留说明）。
  本次覆盖的是它 5 种可见状态的渲染 + 计算样式。
- **动效手感需要你自己过一眼**。代码层面能断言的是曲线、时长、填充模式、
  延迟序列是否按设计生效（已 32/32 验证）；"这个抖动是不是快了点"只有
  动态看才知道。建议用 DevTools 的 Animations 面板放慢到 25% 看一遍
  `showPage` 转场与列表瀑布。
- `favicon.ico` 的 404 是浏览器自动请求，与页面无关。

---

## 7. 常用命令

```powershell
# 校验
node .\scripts\verify-ui-v2.cjs          # 静态：源码对比 / IPC / 处理器 / id
node .\scripts\verify-css.cjs            # 静态：样式表
node .\scripts\verify-motion.cjs         # 渲染：32 项动效断言
node .\scripts\ui-v2-audit.cjs           # 渲染：13 页 × 9 类断言
node .\scripts\ui-v2-visual-check.cjs    # 渲染：17 张截图 → tmp\ui-v2\
node .\scripts\ui-v2-overlay-check.cjs   # 渲染：接收窗 5 种状态

# 打包（会覆盖正式程序）
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\pack-app.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\pack-app.ps1 -CheckOnly
```
