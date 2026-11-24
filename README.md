<div align="center">
  <img width="160" src="assets/icon.png" alt="dsh tool plus icon"><br>
  <img width="240" src="assets/wordmark.png" alt="dsh tool plus">
</div>

<div align="center">

简体中文 | [English](./README.en.md)

</div>

<div align="center">

[![npm version](https://img.shields.io/npm/v/@xiaoso/dsh-tool-plus?logo=npm)](https://www.npmjs.com/package/@xiaoso/dsh-tool-plus)
[![License: MIT](https://img.shields.io/github/license/xiaoso456/dsh-tool-plus)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24.9-339933?logo=nodedotjs)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-lightgrey)]()

</div>

DeepSeek Harness 基础工具增强：用 bash 取代 PowerShell 承担 shell 场景，并提供结构化 read、多模式 edit、原子 write、全文搜索与图像直读。内核移植自 [Oh My Pi](https://github.com/can1357/oh-my-pi)，安装后自动接管官方的 bash / pwsh / 文件 / 搜索工具。

![dsh tool plus：Windows 上的 dsh 也能使用 bash 与常用 Linux 命令](./assets/hero.zh.png)

> ⚠️ **0.3.0 版本提示**：这一版对工具面、默认配置和输出形式的调整比较激进，并包含一些实验性功能，和 0.2.x 相比变化较大。升级前建议先读 [CHANGELOG](CHANGELOG.md)。

## 安装

> ⚠️ **首次安装和每次升级后，都要重启一次 dsh。**

### 环境要求

- **dsh**：`v0.2.2-rc.3` 及以上（pre-release，接口可能变动）
- **Node.js** ≥ 24.9
- **Git Bash**（Windows 推荐）：bash 本身由插件内置，Git Bash 只用来补充内置命令之外的常用 Linux 工具（如 `awk`）
- **权限**：建议在 `danger-full-access` 下使用，避免沙箱模式误拦文件写入

### Web 端

```sh
dsh plugin --profile web add @xiaoso/dsh-tool-plus
```

### 桌面端

在插件页输入包名 `@xiaoso/dsh-tool-plus` 安装。

## 功能特性

### Shell

- **bash**：内置 150+ 条命令，`ls`、`grep`、`sed`、`jq` 等常用工具不依赖系统里的同名程序
  - `zip`、`tree`、`bc`、`gzip` / `zstd` / `xz` 等系统里常缺的命令也由插件自带（[说明](docs/shell-commands/README.md)）
  - 工作目录跟随 `cd` 跨调用保持
  - 冗长日志（git/npm/cargo…）自动压缩；超长输出只留头尾，完整内容落盘可回读
  - 长命令自动转后台
  - 可选拦截 `cat`、`grep`、`find`、`sed -i`，引导模型改用专用工具（默认关闭）
- **安全删除**：`rm` 默认把文件移进系统回收站，误删可恢复；要真删用 `command rm`

### 文件

- **read**：按行区间读（`:N-M`、`:raw`、多区间）
  - 大代码文件默认给结构摘要，细节按需展开
  - zip/tar、SQLite、notebook、PDF 直接读
  - PNG / JPEG / WebP / GIF 图片直读，超大图自动缩放
  - 可抓网页（含页内图片），SPA 站点改用本机浏览器渲染后再抓
- **write**：原子写入并返回 diff；支持补丁式写入，可直接写归档成员与 SQLite 数据
- **edit**：replace 默认，另支持 patch / hashline / apply-patch；唯一性校验、空白模糊匹配

### 搜索

- **grep / glob**：全文搜索与文件名匹配；mtime 排序、上下文行、忽略规则可配置
- **ast_grep / ast_edit**（可选）：基于语法树的结构化搜索与重写，设置里开启

### 设置与预设

- **命令面板**：逐条指定每个命令用插件内建、系统程序，还是你自选的可执行文件
- **agent 预设**：标准增强版 / PTC（Code Mode）两套

## 使用

### 预设

| 预设 | 底座 | 说明 |
|---|---|---|
| **Tool Plus 标准增强版** | 官方 standard | 官方标准模式全部能力 + 文件/Shell 工具集换成本插件 |
| **Tool Plus PTC 增强版** | 官方 PTC（Code Mode） | 同上，但经 Code Mode 以 `run_code` 组合多步操作 |

装好插件后在预设列表里直接选。需要调整时到 设置 → Tool Plus → 预设：官方升级后点「跟随官方」；想回到默认点「恢复随包」。

### 设置

都在 设置 → Tool Plus 里：

- **命令面板**（Bash → 命令）：列出 bash 里能跑的每条命令及其来源，可逐条改用插件内建、系统程序或自选的可执行文件；改完对新开的 shell 生效
- **Shell 初始化**（Bash → Shell 初始化）：每次创建 shell 时执行的脚本，可编辑、试运行、恢复默认

## 性能

在 SWE-bench Multilingual（20 题 × 3 轮，muse-spark-1.2）上对比三种工具面——官方、dsh-ops 0.5.5 与 Tool Plus 0.3.0-beta.3，标准与 PTC 两种模式。模型、题目与驱动器相同，只换工具面与调用方式。

| 指标 | 官方 | dsh-ops 0.5.5 | Tool Plus |
|---|---|---|---|
| **标准模式** | — | — | — |
| 通过数 | 52/60 | 50/60 | 54/60 |
| 工具报错率 | 1.45% | 0.42% | 1.27% |
| token/题 | 1,587,695 | 1,604,745（+1.1%） | **1,291,880（−18.6%）** |
| 输入 token/题 | 57,918 | 56,825（−1.9%） | **45,218（−21.9%）** |
| 输出 token/题 | 10,758 | 11,793（+9.6%） | **10,491（−2.5%）** |
| 缓存命中率 | 96.3% | 96.4% | **96.5%** |
| 结束上下文（平均） | 60,634 | 57,829（−4.6%） | **45,984（−24.2%）** |
| 结束上下文（最大） | 151,784 | 121,073（−20.2%） | **91,484（−39.7%）** |
| 工具执行/题 | 78 s | 86 s（+10.3%） | **71 s（−9.4%）** |
| 墙钟/题 | 199 s | 212 s（+6.6%） | **197 s（−1.0%）** |
| 花费/题 | $0.0110 | $0.0111 | **$0.0091** |
| **PTC 模式** | — | — | — |
| 通过数 | 52/60 | 52/60 | 54/60 |
| PTC 失败率 | 3.69% | 3.54% | 7.33% |
| token/题 | 1,487,869 | **1,303,306（−12.4%）** | 1,459,520（−1.9%） |
| 输入 token/题 | 66,050 | 62,604（−5.2%） | **53,886（−18.4%）** |
| 输出 token/题 | 12,248 | **11,889（−2.9%）** | 12,037（−1.7%） |
| 缓存命中率 | 95.5% | 95.2% | **96.3%** |
| 结束上下文（平均） | 67,719 | 65,531（−3.2%） | **59,030（−12.8%）** |
| 结束上下文（最大） | 177,232 | 164,354（−7.3%） | **147,912（−16.5%）** |
| 工具执行/题 | 95 s | 88 s（−6.9%） | **85 s（−10.5%）** |
| 墙钟/题 | 218 s | **196 s（−10.0%）** | 213 s（−2.2%） |
| 花费/题 | $0.0119 | $0.0111 | **$0.0106** |

括号内为相对同模式官方基线的变化，加粗为该行较优值。标准模式的工具报错率按报告 §8.3 的逐工具失败次数汇总，只统计结果正文以 `Error:` 开头的失败；dsh-ops 的 `ops_*` 错误不进这个口径，所以偏低。PTC 失败率为整次 `run_code` 调用失败率。token 为输入 + 缓存读 + 输出，输入指未命中缓存部分，输出含思考；缓存命中率 = 缓存读 ÷（输入 + 缓存读）。标准模式 token 降 18.6%（输入 −21.9%、缓存读 −18.6%），代价是读取调用 +47%；PTC 的 token 基本持平（输入 −18.4%、缓存读 −1.1%），执行更快，但步数与固定开销上升。两边通过数的多解/少解经核对都只是随机波动。逐题结果、逐工具耗时/失败率与成本拆分见 [完整报告](docs/benchmark/sbml-compare-3plugins.md)。

> 结束上下文取各会话最后一步的上下文量；Tool Plus 标准模式的一条子代理会话未计入。

> 数据来自 0.3.0-beta.3；PTC 的 7.33% 含 63 次 `description` 参数缺失，扣除后为 4.03%，与基线同量级；这条失败不代表当前默认配置。

## 注意事项

- 不提供单独的 `pwsh` 工具：shell 场景由功能更全的 `bash` 统一承担
- **bash 的状态保持**：默认每条命令单独开 Shell，只有工作目录跟随 `cd`；把 `autoBackgroundMs` 设为 `0` 后共用一个持久 Shell，`export` 的变量、别名与函数都跨调用保留。改完立即生效，工具给模型的说明会同步改写，不用重启
- 预设显示「加载失败」：插件版本太旧（0.1.19 及以前），升级即可；升级后官方又改过预设的话，在 设置 → Tool Plus → 预设 点「跟随官方」重派生一次
- 命令面板里把某条命令指错了：在同一处改回来，或删掉 `$DSH_HOME/tool-plus/commands.json` 回到默认

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

## License

[MIT](LICENSE)，第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
