# 对应源码与依赖

OfficeFlow 1.1.0 对应源码：[v1.1.0](https://github.com/kdjmd/officeflow/tree/v1.1.0)。GitHub 自动提供该标签的 Source code ZIP / tar.gz；源码包含应用、拖放辅助程序、构建脚本及依赖锁定文件。

发行资产另提供未修改的上游 AGPL 源码，与发行包使用的版本对应：

| 组件 | 源码资产 | SHA256 |
|---|---|---|
| PyMuPDF 1.28.2 | pymupdf-1.28.2.tar.gz | 5e0be7908a715aa20333caddd73f1d6f01e4cd0c26e869fa2dd0b7f344da2249 |
| MuPDF 1.28.2 | mupdf-1.28.2-source.tar.gz | 44075a84e329db55b9bef5f342a70fd26d69e48ad1d33cb89d9664581c641156 |

来源：[PyMuPDF 官方 PyPI](https://pypi.org/project/PyMuPDF/1.28.2/#files)、[MuPDF 官方源码](https://mupdf.com/downloads/archive/mupdf-1.28.2-source.tar.gz)。PyMuPDF 的 setup.py 含构建配置；MuPDF 源码包保留 include、source、scripts、platform、thirdparty 和许可证。按上游说明可使用 `PYMUPDF_SETUP_MUPDF_BUILD` 指定已解压的 MuPDF 源码目录，在相应 Visual Studio C++ 环境构建 Python wheel。本项目没有修改这些第三方组件。

其余 Python 二进制来源、精确版本与 SHA256 见同次发行的 `dependencies.json`，对应 wheel 许可证位于程序 `resources/python/Lib/site-packages` 的 dist-info / licenses 目录。CPython 3.14.8 来源为 [Python 官方 Windows 嵌入式发行包](https://www.python.org/ftp/python/3.14.8/python-3.14.8-embed-amd64.zip)，许可证保留于 `resources/python/LICENSE.txt`。

Electron / Chromium 的许可证保留于程序根目录的 LICENSE.electron.txt、LICENSES.chromium.html。OfficeFlow 的 AGPL 许可证保留于 LICENSE.OfficeFlow.txt。完整列表见 THIRD_PARTY_NOTICES.md。以上源码与 OfficeFlow 二进制一起长期保留在同一 Release 中。
