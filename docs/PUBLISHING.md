# 发布维护指南

在 Windows x64、Node.js 22.12+、Python 3.14 和正常网络环境构建。构建依赖由 package-lock.json 及 requirements-release.txt 锁定；内置 Python 由官方压缩包的 SHA256 验证。打包不会包含用户设置、API key、处理文件或运行日志。

在 `app-source` 执行：

```powershell
npm ci
python -m pip install -r requirements.txt
npm test
npm run benchmark
npm run release:win
npm run test:release
node ../scripts/release-assets.js
```

`release:win` 自动准备内置运行时、图标及拖动监控辅助程序，并生成 NSIS 安装程序和免安装 ZIP。真实发行程序的自检使用独立临时用户目录，不修改开机启动设置、不调用付费 AI API。覆盖界面隔离、内置 Python、本地表格分析/XLSX 导出、悬浮窗默认隐藏、辅助监控启动和关闭窗口后台运行；不等同于完整的鼠标拖放、Office COM、安装/卸载或真实 AI 服务人工验收。

检查 `dist/release-smoke/verification.json` 及界面截图后，`release-assets.js` 只收集白名单资产，下载并核对对应 AGPL 第三方源码，检查 PyPI 已公开的依赖漏洞记录，生成 SHA256SUMS.txt。存在已公开漏洞记录或无法完成查询时停止发布；这不保证不存在未知漏洞。不要将整个 dist/release-smoke 目录上传，它可能包含自检生成的应用数据和文档。

提交源码并确认 CI 成功后，创建与 package.json 版本相同的标签，例如 `v1.1.0`，推送标签。在 GitHub Actions 手动运行 **Windows release**，填入此标签；工作流重新构建、测试并发布。没有标签时拒绝发布，不通过 force push 改写历史；已有 Release 时发布命令会失败，需明确审阅后再决定更新。

本版本未配置商业代码签名。配置签名证书时仅使用 GitHub Secrets，绝不提交证书或密码。新增依赖或升级版本时同步更新 runtime-manifest、requirements-release、第三方源码资产和许可说明。
