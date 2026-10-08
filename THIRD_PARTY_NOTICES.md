# Third-party notices

组件保留其原许可证。完整分发时还需保留 Electron/Chromium 随构建生成的许可证文件。

| Component | Purpose | License |
|---|---|---|
| Electron | Desktop runtime | MIT |
| Chromium | Rendering/runtime | Multiple BSD-style and other licenses |
| PyMuPDF | PDF extraction/rendering | AGPL-3.0 or Artifex commercial license |
| MuPDF | Native PDF engine used by PyMuPDF | AGPL-3.0 or Artifex commercial license |
| pypdf | PDF processing | BSD-3-Clause |
| pdfplumber | PDF text/table extraction | MIT |
| openpyxl | XLSX generation | MIT |
| Pillow | Image processing | MIT-CMU |
| ReportLab | PDF support | BSD-style |
| CPython | Bundled Python runtime | PSF License |
| pdfminer.six | PDF text extraction | MIT |
| pypdfium2 / PDFium | PDF rendering | Apache-2.0 / BSD-style and third-party notices |
| cryptography | PDF encryption support | Apache-2.0 OR BSD-3-Clause |
| cffi | Native library bindings | MIT-0 |
| charset-normalizer | Text decoding | MIT |
| et-xmlfile | XML streaming | MIT |
| pycparser | C parsing dependency | BSD-3-Clause |

版本见 `app-source/package-lock.json` 和 `app-source/requirements-release.txt`。发行包中的 `resources/dependencies.json` 附有 Python 组件版本、原始下载地址和 wheel SHA256；许可证原文保留在各组件 dist-info / licenses 目录。OfficeFlow 项目源码以 AGPL-3.0-only 发布。

PyMuPDF/MuPDF 对应源码与二进制同次分发，详见 [第三方源码说明](https://github.com/kdjmd/officeflow/blob/v1.1.0/docs/THIRD_PARTY_SOURCES.md) 与 GitHub Release 附件。
