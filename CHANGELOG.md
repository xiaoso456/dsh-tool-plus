# Changelog

本文件记录 `@xiaoso/dsh-tool-plus` 与 `@xiaoso/dsh-tool-plus-presets` 的版本更新（双包锁步同版）。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.0-beta.6] - 2026-08-30

### Added

- 抓取网页内容时支持现代 SPA 网站（如 excalidraw.com）：这类页面的正文由 JavaScript 动态加载，此前只能抓到空壳，现在会自动借助本机浏览器渲染完整内容后再抓取
- 设置面板新增「探测浏览器」按钮，可一键查看本机可用的浏览器（Chrome / Edge / Chromium）

### Changed

- 网页抓取能力整体增强（详见 Added）

### Fixed

- 修复浏览器渲染进程空闲时未及时释放的问题，长时间使用不再持续占用内存

[对比 beta.5](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.5...tool-plus-v0.1.0-beta.6)

## [0.1.0-beta.5] - 2026-08-29

### Fixed

- 修复插件包体积过大导致部分镜像源无法同步、安装失败的问题

[对比 beta.4](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.4...tool-plus-v0.1.0-beta.5)

## [0.1.0-beta.4] - 2026-08-29

### Changed

- 多项功能修复与稳定性提升，补齐测试覆盖
- 提示词渲染改用官方引擎，兼容性更稳
- 命令拦截默认开启

### Removed

- 清理实验性目录 tool-plus-lab

[对比 beta.3](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.3...tool-plus-v0.1.0-beta.4)

## [0.1.0-beta.3] - 2026-08-28

### Added

- 新增网页内图片直读，超大图自动缩放
- README 中英双语版本与切换

### Fixed

- 图片读取细节与官方对齐：缩放后仍标注原图尺寸、超大图与 16-bit PNG 报错提示更清晰

[对比 beta.2](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.2...tool-plus-v0.1.0-beta.3)

## [0.1.0-beta.2] - 2026-08-28

### Changed

- 完善包元数据（keywords / repository），便于检索
- 发布源切换至 npm 官方源，安装更稳

[对比 beta.1](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.1...tool-plus-v0.1.0-beta.2)

## [0.1.0-beta.1] - 2026-08-27

### Added

- 首个 Beta 版本发布
- 核心能力：持久 bash、结构化 read、多模式 edit、原子 write、全文搜索、图像直读
- 预设拆分为独立可安装包，与主包同版本发布

[查看发布](https://github.com/xiaoso456/dsh-tool-plus/releases/tag/tool-plus-v0.1.0-beta.1)
