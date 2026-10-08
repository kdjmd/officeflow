# QA fixtures

本目录中的姓名、电话号码、金额、部门和文档片段均为合成测试数据。临时文件放在系统临时目录。

默认 `npm test` 验证表格服务、UI 状态、路径安全和 Python 引擎，不依赖 Microsoft Office，也不调用付费 AI API。

若本机已正确安装 Word，可额外启用老式 `.doc` 集成测试：

```powershell
$env:OFFICEFLOW_RUN_WORD_INTEGRATION = '1'
npm test
Remove-Item Env:\OFFICEFLOW_RUN_WORD_INTEGRATION
```

在 `app-source` 目录执行。该集成测试需要正常工作的 Word COM 服务。
