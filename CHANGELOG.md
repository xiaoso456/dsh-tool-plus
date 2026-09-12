# Changelog

本文件记录 `@xiaoso/dsh-tool-plus` 与 `@xiaoso/dsh-tool-plus-presets` 的版本更新（两个包的版本号始终保持一致）。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.7-beta.0] - 2026-09-12

> beta 预发布：供试用与验证，**不推 `latest`**（`npm dist-tag` 为 `beta`）。

### Added

- hashline 回归测试四件套：`native-writer`（写盘回调三分支 + 守卫 + 错误路径）、`native-partial-write`（部分落盘诊断）、`notebook-hashline`（`.ipynb` 读→编辑→二次编辑）、`native-adapter-surface`（适配层 30/30 运行时导出全覆盖 + 上游夹具语料 226 次调用，101 条不可达逐条登记）

### Changed

- **hashline 引擎不再 vendored**：上游 18.x 删除 TS `packages/hashline`、把编辑引擎重写为 Rust `crates/pi-edit`。我们删除旧 TS 引擎（21 文件 / 7245 行），改由 `src/tools/hashline/native/` 薄适配层驱动 `@oh-my-pi/pi-natives` 的 Rust 引擎（`EditStore` / `EditSession` / `EditPolicy` / 写盘回调）；`@oh-my-pi/hashline` alias 重指到适配层；12 个测试文件迁移到 native harness，并把上游 226 例夹具纳入回归
- `@oh-my-pi/*` 依赖锁步升级 17.3.5 → 18.1.17（pi-natives 兼容补丁同步更新，补丁与 postinstall 两条轨道都保留）；`THIRD_PARTY_NOTICES.md` 同步（hashline 不再 vendored，新增夹具来源声明）
- notebook 解码改用引擎自身 codec（`pi-natives` 的 `notebookToEditableText`）：read 铸的 tag 与引擎校验活文件跑**同一份代码**，一致性由结构保证，删除第二套 TS 渲染器。**良构 notebook 逐字节等价；畸形 notebook 的行为改为与引擎一致**（此前两边会分歧，分歧即"标签永远校验不过"），已知收窄见下
- presets：plan-mode 提示词与官方对齐

### Fixed

- 修复 hashline 编辑 `.ipynb` **必然失败**：引擎已把 notebook 序列化为 nbformat JSON 再交给宿主，写盘腿却又序列化一次，把 JSON 当可编辑文本解析 → 每次编辑报 `Invalid notebook editable representation`；现在逐字落引擎给的最终字节（对齐上游宿主）
- 修复带 UTF-8 BOM 的 `.ipynb` 在 read 侧报 `Invalid JSON in notebook`（引擎本可正常编辑该文件）
- 恢复多文件补丁部分落盘时的诊断：写盘通道拒绝第 2 个文件时，错误里重新带上 `Sections already written: a.ts.`，模型不再可能把整条补丁重发而重复应用
- 修复 `Bun.which` 缺失导致的 `TypeError: Bun.which is not a function`（pi-utils `$which` 每次调用必抛，找不到命令时本应返回 `null`）；同时修 `Bun.hash` 忽略 `seed` 导致的缓存键塌缩

### 已知收窄（畸形 notebook，均为"向引擎对齐"的副作用）

- `source` 含非字符串元素时，引擎侧投影会静默丢弃这些元素（旧 TS 渲染器会拼成 `"a5"`、`[["a"]]` 会保留 `a`）——这类畸形 cell 在 read 中显示为空，但仍可正常编辑
- 含孤立代理项（lone surrogate）的 notebook JSON：旧渲染器可读，新解码器（serde_json）拒绝并报 `Invalid JSON in notebook`
- 编码半（`readNotebookDocument` / `serializeEditedNotebookText`，服务 patch/replace/write 三条 DSH 自有路径）仍走 V8 `JSON.parse`，严格度与解码腿不同；该半随后续模式迁到 Rust 引擎一并删除

[对比 0.1.6](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.6...tool-plus-v0.1.7-beta.0)

## [0.1.6] - 2026-09-10

### Changed

- dsh 依赖升级到 0.1.5-rc.1（22 个 `@deepseek-ai/dsh-*` 包全部精确锁定），并新增 dsh-brand / dsh-invariants 直接依赖以规避 pnpm 对同版本 peer 依赖的预发布版本解析问题；peerDependencies 同步对齐到 0.1.5-rc.1，传递依赖 dsh-attachment / dsh-fs / dsh-sandbox 随之升至 0.1.5-rc.1
- 预设与官方 0.1.5-rc.1 对齐：persona 改为 prefix/suffix 结构（`You are a coding agent powered by the {{model}} model.` + `Your working directory is {{cwd}}.`），新增 command-goal 工具行与 present 工具（`@deepseek-ai/dsh-tool-present`），tool-subagent 开启模型选择设置
- PTC 预设：tool-workflow 默认禁用，tool-presentation 输出模式改为 `ptc`

[对比 0.1.5](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.5...tool-plus-v0.1.6)

## [0.1.5] - 2026-09-09

### Fixed

- 修复安全 rm 删除失败时提示毫无信息量的问题：底层回收站程序失败时只输出 `Command failed: <exe> <args>`，原因被黑盒吞掉；现在 Windows 上删除失败会先对目标做一次改名探测，按系统真实回答分类报错——文件被占用时提示 `file is locked or cannot be moved by this process (close programs using it and retry)`，权限不足时提示 `permission denied (read-only file or restricted directory)`，目标已被其他进程删除时视为删除成功不再报错
- 非 Windows 平台删除失败保持原有报错方式不变

[对比 0.1.4](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.4...tool-plus-v0.1.5)

## [0.1.4] - 2026-09-08

### Fixed

- 修复 bash 工具无法识别 Git Bash 风格路径的问题：以 `cd /d/code/... && …` 开头的命令或给 `workdir` 传 `/d/...` 路径时，Windows 下会被错误解析为 `D:\d\...`（把 `/d` 当成盘根下的子目录），导致切换到错误目录或报出晦涩的 "Failed to set cwd"；现在按 Git Bash 语义正确解析为 `D:\code\...`，并兼容 `/mnt/d/...` 写法与输入中误带的 `:` 前缀
- 工作目录不存在或指向文件时，现在直接报出清晰错误（`Working directory does not exist: ...` / `Working directory is not a directory: ...`），不再依赖 shell 侧的晦涩报错
- 修复安全 rm 误删隐患：在 bash 里执行 `rm /d/...`（Git Bash 风格路径）时，删除目标会被错误解析到 `<当前盘>:\d\...` 目录，若该目录恰好存在同名文件会被静默移入回收站；现在先转换为原生路径再删除，`-v` 输出与错误信息保留输入时的原样写法

[对比 0.1.3](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.3...tool-plus-v0.1.4)

## [0.1.3] - 2026-09-07

### Fixed

- 修复 minimizer 压缩后模型看不到原文提示的问题：后台任务路径（autoBackground 主力路径）组装完成结果时漏传 `minimized` 字段，导致 `[output minimized...]` 提示整条缺失、压缩前原文虽已落盘但模型无法得知路径；现与前台 `buildForeground` 对齐补上该字段
- 前台 fallback 路径的 `executeBash` 补传 `onMinimizedSave`，压缩发生时同样把原文写入 spill 文件并通过提示暴露路径，两条路径行为一致
- 新增 `background-minimized-notice.spec.ts` 回归测试，锁定 completion 结果携带 `minimized` 与 `originalSpillPath`

[对比 0.1.2-rc.1](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.2-rc.1...tool-plus-v0.1.3)

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
