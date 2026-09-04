# Changelog

本文件记录 `@xiaoso/dsh-tool-plus` 与 `@xiaoso/dsh-tool-plus-presets` 的版本更新（两个包的版本号始终保持一致）。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.2-rc.1] - 2026-09-03

### Changed

- dsh 依赖升级到 0.1.2-rc.1 并全部改为精确锁定版本（不再使用 `^`）：dsh-* 0.1.2-rc.1、cordis 4.0.2、schemastery 3.18.2
- 移除已随 dsh 0.1.2-rc.1 删除的 dsh-client-runtime 依赖，客户端类型迁移到 dsh-client-ui-settings / dsh-client-ui-renderer
- 适配 dsh 0.1.2-rc.1 API 变更：设置注册改用 `ctx.settings.installSection`、连接 RPC 处理器改为两参签名、`CallId` 更名 `ToolCallId`
- 版本号与 dsh 对齐（0.1.2-rc.1），npm `latest` 标签指向该版本，`dsh plugin add` 默认安装与 dsh 匹配
- README 适用版本说明更新

[对比 0.1.2](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.2...tool-plus-v0.1.2-rc.1)

## [0.1.2] - 2026-09-01

### Added

- grep/glob 搜索默认值开关：大小写敏感、跳过被忽略文件、包含隐藏文件均可配置（未显式传参时按设置生效，显式传参始终优先）
- 恢复 Glob 工具设置页（此前因无配置项被移除）

### Fixed

- 修复安全 rm 默认不生效的问题：后台任务路径调用执行器时漏传安全 rm 开关，导致日常命令（自动后台化）从不注入 rm 重定义，只有保存设置触发验证时才生效；现已与前台路径对齐，默认开启即生效
- 修复安全 rm 注入被共享脚本文件污染的问题：注入改为直接内联进会话快照，不再生成独立的 rm-safe 脚本文件，消除不同安装路径实例与测试进程互相覆盖的隐患

### Changed

- README 增加设置面板（Bash 工具页）截图
- 设置项文案改为自然表述（grep 匹配上下文、截断单位、已见行守卫等）

[对比 0.1.1](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.1...tool-plus-v0.1.2)

## [0.1.2-beta.1] - 2026-09-01

### Changed

- 安全 rm 注入改为直接内联进会话快照：不再生成独立的 rm-safe 脚本文件，消除跨进程共享缓存互相覆盖的隐患（不同安装路径的实例、测试进程曾会把共享脚本重写成无效路径，导致 rm 报错）

[对比 beta.0](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.2-beta.0...tool-plus-v0.1.2-beta.1)

## [0.1.2-beta.0] - 2026-09-01

### Added

- grep/glob 搜索默认值开关：大小写敏感、跳过被忽略文件、包含隐藏文件均可配置（未显式传参时按设置生效，显式传参始终优先）
- 恢复 Glob 工具设置页（此前因无配置项被移除）

### Fixed

- 修复安全 rm 默认不生效的问题：后台任务路径调用执行器时漏传安全 rm 开关，导致日常命令（自动后台化）从不注入 rm 重定义，只有保存设置触发验证时才生效；现已与前台路径对齐，默认开启即生效

### Changed

- README 增加设置面板（Bash 工具页）截图

[对比 0.1.1](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.1...tool-plus-v0.1.2-beta.0)

## [0.1.1] - 2026-08-31

### Added

- 安全删除（安全 rm）：`rm` 默认把文件移入系统回收站而非永久删除，误删可恢复；需要真删时用 `command rm`
- 安全 rm 注入状态验证：在设置中开启安全 rm 并保存时，自动测试注入是否生效，并以提示框告知结果（成功或失败原因）

### Changed

- 正式版发布（移除 beta 标记）
- 「rm 进回收站」更名为「安全 rm」
- README 增加安全删除说明与项目徽标

### Fixed

- 修复设置行整行可点导致误触开关/下拉的问题

[对比 beta.7](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.7...tool-plus-v0.1.1)

## [0.1.0-beta.7] - 2026-08-31

### Changed

- 设置面板 Tool Plus 页视觉升级：工具切换标签改为下划线样式，切换时下划线平滑滑动；各工具的配置项改为分组卡片展示，层次更清晰
- 设置项操作更顺手：整行点击即可切换开关、展开下拉、聚焦数字输入框
- 保存与放弃修改按钮固定在面板底部，内容较长时无需滚到底即可操作

### Fixed

- 修复设置页标题、标签与选项挤在一起的问题（页面布局样式此前未生效）
- 修复切换工具标签时下划线指示器无滑动动画的问题

[对比 beta.6](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.6...tool-plus-v0.1.0-beta.7)

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
