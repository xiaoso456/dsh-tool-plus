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

### 从 npm 安装（推荐）

#### Web 端

```sh
dsh plugin --profile web add --allow-build=@xiaoso/dsh-tool-plus --allow-build=koffi @xiaoso/dsh-tool-plus
```

`--allow-build` 放行安装脚本（本包和 `koffi` 各一次），需要 pnpm ≥ 10.4；pnpm 11 起不加会直接报 `ERR_PNPM_IGNORED_BUILDS` 装不上。用不了该参数（pnpm 版本过低）时，先任选一种放行方式，再重跑安装命令：

- 往 `~/.dsh/profiles/web/pnpm-workspace.yaml` 追加三行：`allowBuilds:`、`  '@xiaoso/dsh-tool-plus': true`、`  koffi: true`
- 或执行 `cd ~/.dsh/profiles/web && pnpm approve-builds --all`（需 pnpm ≥ 10.32）

#### 桌面端

profile 由桌面应用独占，`dsh plugin --profile desktop` 会被拒；要装新版就进它自己的目录：

```sh
cd ~/.dsh/profiles/desktop
pnpm add --allow-build=@xiaoso/dsh-tool-plus --allow-build=koffi @xiaoso/dsh-tool-plus
```

### 本地开发

```sh
dsh plugin --profile web add link:<本仓库路径>
```

### 预设

| 预设 | 底座 | 说明 |
|---|---|---|
| **Tool Plus 标准增强版** | 官方 standard | 官方标准模式全部能力 + 文件/Shell 工具集换成本插件 |
| **Tool Plus PTC 增强版** | 官方 PTC（Code Mode） | 同上，但经 Code Mode 以 `run_code` 组合多步操作 |

两个预设**随插件声明**：安装插件（作为 profile bundle）时，插件的补丁层里就带着两条 `@deepseek-ai/dsh-agent-preset` 声明行，装上即可在预设列表里选。没有安装步骤，插件启动时也不写任何文件。

设置页「Tool Plus → 预设」是改它们的地方（dsh 0.1.7 起官方的预设页只读、也没有 `agent_preset` 工具，所以这里是唯一的图形入口）：

- **最小更新**：只把这几个仍挂着的官方工具行关掉，其他内容一个字节都不动
- **对齐模板**：用所选模板整份替换这一行的插件列表
- **恢复随包**：删掉你写在 profile 配置（`<profile>/cordis.patch.yml`）里的覆盖，回落到随包声明
- **查看差异**：先看差在哪几行，再决定动不动手

写入通过宿主自己的 `ctx.configEditor` 完成，因此自带 profile 锁、并发保护、原子写与失败回滚。

> 从 0.1.9 或更早升级过来的话：`~/.dsh/.agent-presets/` 目录**已经没有任何代码读它**（0.1.7 起预设改为补丁层声明），可以安全删除；设置页检测到它会给出提示。

## 配置

开箱即用，无需配置。需要微调时常用项有：后台阈值（`autoBackgroundMs`）、超时（`defaultTimeoutMs` / `maxTimeoutMs`）、输出截断窗口、编辑默认模式（`editMode`，默认 `replace`）、结构化摘要开关（`readSummarizeEnabled`）。抓取相关：可切换网页转 Markdown 的后端（`fetchReader`，含浏览器 JS 渲染——SPA 页面），设置面板里可一键「探测浏览器」查看本机可用的 Chrome/Edge。

## 环境要求

- **dsh CLI**：需全局安装，`npm i -g @deepseek-ai/dsh`
- **Node.js** ≥ 22.19 或 ≥ 24
- **Git Bash**（推荐）：Windows 上作为 bash 执行环境
- 适用于 DeepSeek Harness `dsh` v0.1.7-rc.2（pre-release，接口可能变动）

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
