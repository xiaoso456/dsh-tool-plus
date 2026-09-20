# dsh-tool-plus — DeepSeek Harness 基础工具增强

简体中文 | [English](./README.en.md)

[![npm version](https://img.shields.io/npm/v/@xiaoso/dsh-tool-plus?logo=npm)](https://www.npmjs.com/package/@xiaoso/dsh-tool-plus)
[![License: MIT](https://img.shields.io/github/license/xiaoso456/dsh-tool-plus)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.19%20%7C%20%3E%3D24-339933?logo=nodedotjs)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-lightgrey)]()

DeepSeek Harness 基础工具增强：持久 bash、结构化 read、多模式 edit、原子 write、全文搜索、图像直读，一个插件全覆盖。基于 [Oh My Pi](https://github.com/can1357/oh-my-pi) 内核移植，安装后自动接管官方 bash / pwsh / 文件 / 搜索工具，另有可选的 `ast_grep` / `ast_edit` 结构化搜索与重写。

## 功能特性

- **bash**：持久 shell，`cd`、`export` 跨调用保持状态；冗长日志（git/npm/cargo…）自动压缩；超长输出只保留头尾，完整内容落盘可回读；长命令自动转后台；可选拦截 `cat`、`grep`、`find`、`sed -i`，引导改用专用工具
- **安全删除**：`rm` 默认把文件移入系统回收站而非永久删除，误删可恢复；需要真删时用 `command rm`
- **read**：按行区间精准读取（支持 `:N-M`、`:raw`、多区间）；大代码文件默认返回结构摘要，细节按需展开；zip/tar 归档、SQLite、notebook、PDF 直接读；PNG / JPEG / WebP / GIF 图片直读，超大图自动缩放；可抓取网页内容（含网页内图片）；SPA 站点（内容由 JS 动态渲染，如 excalidraw.com）自动改用本机浏览器渲染后抓取
- **write**：原子写入，返回修改 diff；支持补丁式写入，可直接写 zip/tar 归档成员与 SQLite 数据
- **edit**：replace 默认，另支持 patch / hashline / apply-patch 三种补丁格式；多段编辑、唯一性校验、空白差异模糊匹配
- **grep / glob**：全文搜索与文件名匹配；mtime 排序、上下文行、忽略规则可配置
- **ast_grep / ast_edit**（可选）：基于语法树的结构化代码搜索与重写，可在设置中开启
- **agent 预设**：标准增强版 / PTC（Code Mode）两套配套模板

设置面板（Bash 工具页）：

![Tool Plus 设置面板（Bash）](docs/screenshots/settings-bash-zh.png)

## 推荐环境与配置

- **完全权限模式**：建议在 `danger-full-access` 下使用本插件，可避免沙箱模式下文件写入被误拦。

## 安装

- **agent 预设**：标准增强版 / PTC（Code Mode）两套配套模板

### 从 npm 安装（推荐）

```sh
dsh plugin --profile web add --allow-build=@xiaoso/dsh-tool-plus @xiaoso/dsh-tool-plus
```

`--allow-build` 放行本包的安装脚本，需要 pnpm ≥ 10.4；pnpm 11 起不加会直接报 `ERR_PNPM_IGNORED_BUILDS` 装不上。用不了该参数（pnpm 版本过低）时，先任选一种放行方式，再重跑安装命令：

- 往 `~/.dsh/profiles/web/pnpm-workspace.yaml` 追加两行：`allowBuilds:` 与 `  '@xiaoso/dsh-tool-plus': true`
- 或执行 `cd ~/.dsh/profiles/web && pnpm approve-builds --all`（需 pnpm ≥ 10.32）

### 本地开发

```sh
dsh plugin --profile web add link:<本仓库路径>
```

### 预设

| 预设 | 底座 | 说明 |
|---|---|---|
| **Tool Plus 标准增强版** | 官方 standard | 官方标准模式全部能力 + 文件/Shell 工具集换成本插件 |
| **Tool Plus PTC 增强版** | 官方 PTC（Code Mode） | 同上，但经 Code Mode 以 `run_code` 组合多步操作 |

已有旧版预设想跟上当前版本，用设置页「Tool Plus → 预设」：

- **最小更新**：只禁用冲突的工具行，保留其余本地改动
- **重置为对比模板**：整份覆盖成所选模板，写前自动备份
- **查看差异**：先看差在哪几行，再决定动不动手

## 配置

开箱即用，无需配置。需要微调时常用项有：后台阈值（`autoBackgroundMs`）、超时（`defaultTimeoutMs` / `maxTimeoutMs`）、输出截断窗口、编辑默认模式（`editMode`，默认 `replace`）、结构化摘要开关（`readSummarizeEnabled`）。抓取相关：可切换网页转 Markdown 的后端（`fetchReader`，含浏览器 JS 渲染——SPA 页面），设置面板里可一键「探测浏览器」查看本机可用的 Chrome/Edge。

## 环境要求

- **dsh CLI**：需全局安装，`npm i -g @deepseek-ai/dsh`
- **Node.js** ≥ 22.19 或 ≥ 24
- **Git Bash**（推荐）：Windows 上作为 bash 执行环境
- 适用于 DeepSeek Harness `dsh` v0.1.5-rc.1（pre-release，接口可能变动）

## 注意事项

- 不提供单独的 `pwsh` 工具：shell 场景由功能更全的持久 `bash` 统一承担

**安全 rm 删掉的文件进系统回收站**，各平台的落点与可见性：

| | Windows | macOS | Linux |
|---|---|---|---|
| **落点** | 回收站 | 废纸篓 `~/.Trash` | `$XDG_DATA_HOME/Trash`；默认 `~/.local/share/Trash` |
| **跨卷 / 外接盘** | 该卷回收站 | 该卷 `.Trashes` | 该挂载点 `.Trash-<uid>` |
| **系统回收站可见** | 可见 | 可见 | 同卷可见；跨卷要打开该位置 |
| **文件名** | 原名 | 原名 | UUID，靠 `.trashinfo` 还原 |
| **放回原处** | 支持 | 支持 | 视文件管理器 |
| **实现** | Shell API | 系统 API | 第三方 XDG 实现 |
| **已知限制** | 网络盘无回收站 | 需 10.12+ | 部分桌面环境看不到，需到落点自行还原 |

## 构建

```sh
pnpm install
pnpm build     # tsc 声明 + tsdown 打包 + 资产复制
pnpm typecheck
pnpm test      # 含真实 bash 用例，Windows 需 Git Bash，缺失自动 skip
```

## License

[MIT](LICENSE)，第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
