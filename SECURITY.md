# Security

请使用仓库的 Security → Report a vulnerability 私密提交安全问题。不要在公开 Issue 中粘贴 API key、真实文档或含个人信息的日志。

## 当前安全边界

- OfficeFlow 是本地桌面应用，应只处理来源可信或已经核验的文件。
- 常规 Office 转换禁用 VBA 宏并只读打开输入；Word/Excel 禁止自动更新外部链接。这不是恶意文档沙箱。
- AI key 使用 Electron safeStorage 保存；系统加密不可用时拒绝明文持久化。
- AI 使用 HTTPS；V3 兼容入口拒绝私网地址，Flash 使用固定官方入口。启用 AI 前请确认所配置服务可信。
- 表格导出对公式注入进行防护，并保留来源与待核对信息。

## 已知待改进项

- 主窗口已关闭 nodeIntegration，启用 contextIsolation、sandbox 与 preload IPC 白名单。现有内联事件保留了 CSP 的 unsafe-inline，后续可继续拆分脚本以移除该兼容项。
- 2026-10-08 的 npm 审计有 8 项 moderate 告警，全部属于 electron-builder 的开发/打包依赖链，0 high/critical；生产依赖审计为 0。当前 sprintf-js 没有已发布修复版，不使用不存在的版本覆盖。
- Windows 发行包附带依赖版本、SHA256 校验和与发布验证报告；尚未配置商业代码签名证书。
- 发布前以 PyPI 漏洞元数据核对内置 Python 依赖，存在已公开记录时停止发布；审计结果随包公开，不代表能识别未知漏洞。

依赖由 Dependabot 定期检查。报告中请附带影响范围、复现步骤和脱敏示例。
