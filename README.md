# OfficeFlow

[![CI](https://github.com/kdjmd/officeflow/actions/workflows/ci.yml/badge.svg)](https://github.com/kdjmd/officeflow/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

OfficeFlow 是面向 Windows 的本地办公文件处理工具，适合大学生、学生会成员和日常办公场景。支持批量文件处理、文档整理为表格、桌面拖放接收与可选 AI 辅助。

## 功能

- Word、Excel、PowerPoint 文件转换；PDF 合并、拆分、压缩、旋转、水印及图片导出。
- 图片转换、压缩、调整尺寸与 Windows 本地 OCR。
- 将 Word、PDF、文本中的原生表格、分隔文本和键值记录整理为 XLSX/CSV，保留来源、置信度与待核对内容。
- 根据原文与用户目标确定字段；学生会常用报名、活动安排、物资清单和会议记录只是应用场景，不限制字段分类。
- 保存新表格的结构预设；已有格式匹配时优先本地处理，避免重复消耗 AI token。
- 支持开机后台启动、托盘运行；关闭窗口隐藏到后台。拖动文件时在屏幕右侧出现接收窗，放入后进入文件处理页面。
- AI 只有两个入口：DeepSeek V3 兼容接口和官方 Flash 回退接口。API key 由 Windows 加密存储，用户自行配置。

## 环境

- Windows 10/11 x64，Node.js 22.12.0+，Python 3.11+（加入 PATH）。
- 常规 Word/Excel/PowerPoint 转换及老式 `.doc` 读取需要安装相应 Microsoft Office 桌面应用。
- `.docx` 文本/原生表格、文本 PDF 和文本文件的表格分析无需启动 Office。
- 本地 OCR 需要 Windows OCR 组件及相应识别语言。

## 从源码运行

```powershell
git clone https://github.com/kdjmd/officeflow.git
Set-Location officeflow\app-source
npm ci
python -m pip install -r requirements.txt
npm start
```

启动前会自动编译 C# 拖动监控辅助程序，使用 Windows 自带的 .NET Framework 编译器。首次 npm 安装会下载 Electron。

## 测试和打包

在 `app-source` 目录执行：

```powershell
npm test
npm run benchmark
npm run build:win
```

Windows 构建位于 `dist/win-unpacked`，运行 `OfficeFlow.exe`。构建不捆绑 Python 或 Microsoft Office，需要目标机器满足上面的环境要求。测试数据为合成数据，默认测试不需要 Office；额外 Word 集成测试见 [qa/README.md](qa/README.md)。

## AI 与隐私

默认优先本地处理。只有启用 AI 且本地不能确定结构或内容时，才按任务发送必要片段到所配置的服务。请先检查文档是否含不应外发的个人或组织信息。预设仅保存表格结构，不保存文档行内容。

V3 入口允许填写 HTTPS 兼容地址与模型 ID；Flash 固定使用 DeepSeek 官方地址，当前模型 ID 为 `deepseek-flash`，内部保留旧配置键以兼容已有设置。没有 API key 时仍可进行本地处理。本项目未提供或内置付费 API key，自动测试不消耗 AI token。

仓库只包含源码、合成测试、文档和构建配置。用户文件、输出结果、API key、个人设置、日志、缓存、运行时和备份均不提交。

## 开源许可与贡献

OfficeFlow 采用 [AGPL-3.0-only](LICENSE)。PyMuPDF 使用 AGPL/商业双许可；本开源版本选择 AGPL 方式分发。第三方组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

贡献指南见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。当前安全边界、依赖告警和后续改进记录在安全文档中。
