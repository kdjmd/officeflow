# OfficeFlow 1.1.0 Windows 发行版

安装版：运行 Setup.exe，按提示安装。免安装版：将 ZIP 完整解压到固定目录，再运行 OfficeFlow.exe；请勿直接从压缩包里运行。

已内置 Electron、Python 3.14.8 和 PDF/图片/表格依赖，无需另装 Python。Word/Excel/PPT 的 Office 转换及老式 .doc 读取需要本机安装对应的 Microsoft Office 应用。Windows OCR 需要相应系统组件和识别语言。AI 可选，由用户填写 API key。

关闭主窗口后软件继续在托盘后台运行；彻底退出请右键托盘图标选择“退出 OfficeFlow”。开机启动可在设置中关闭；免安装版启用后不要移动程序目录。

默认结果保存到“文档/OfficeFlow/结果”；设置、加密密钥和结构预设位于用户的应用数据目录。旧版程序旁的输出目录设置会自动读取。卸载不会删除已经导出的用户文档。

本发行版尚未使用商业代码签名证书，Windows 可能提示未知发布者。请从官方 GitHub Release 下载并核对 SHA256SUMS.txt；不要求关闭系统安全防护。

项目与对应源码：https://github.com/kdjmd/officeflow
许可证：AGPL-3.0-only。项目许可证见 LICENSE.OfficeFlow.txt，第三方说明见 THIRD_PARTY_NOTICES.md；Python 各依赖的许可证保留在 resources/python 的 dist-info 目录。

同次发行包含依赖清单、SHA256SUMS.txt、打包程序自检报告及对应的 PyMuPDF/MuPDF 源码。源码说明见 THIRD_PARTY_SOURCES.md；普通使用只需下载 Setup.exe 或 Windows-x64.zip。

验证范围：内置运行时、本地文档整理与 XLSX 导出、界面隔离、后台保活、拖放监控启动和悬浮窗空闲隐藏均已自动检查。Office COM 转换、实际鼠标拖放、安装/卸载及真实 AI 服务仍受用户环境影响，不包含在这份自动报告中。AI 默认未启用，自检使用 0 token。
