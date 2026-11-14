# 自研 shell 命令

记录**既没有上游 OMP、也没有 brush**、由我们自己在 `vendor/oh-my-pi/overlay/` 里实现、并经 patch 台账接入的 shell 命令。

这个目录随仓库发布（`.gitignore` 里是 `docs/*` 的例外），因为 `AGENTS.md` 直接引用它。

## 判定标准

一个命令要进这个目录，必须同时满足：

1. 上游 pin（`vendor/oh-my-pi/lock.json`，当前 `v18.12.6` / `45c35e4`）里没有：`git -C vendor/oh-my-pi/upstream ls-tree -r --name-only HEAD <path>` 查不到；
2. OMP（`refs/oh-my-pi`）的工具目录里也没有；
3. 我们的实现落在 `vendor/oh-my-pi/overlay/`，并由 `vendor/oh-my-pi/patches/` 里编号补丁接进 crate。

移植来的工具（bash/read/write/edit/grep/glob/ast_grep/ast_edit）不进这个目录——它们来自 OMP。

## 清单

| 命令 | 上游 OMP | brush（v18.12.6） | 实现位置 | 状态 | 文档 |
|---|---|---|---|---|---|
| `zip` | 无 | 无 | `overlay/crates/pi-builtins/src/zipcmd*` | 代码完成，分发未接线 | [zip.md](./zip.md) |
| `gzip` | 无 | 无 | `overlay/crates/pi-builtins/src/gzipcmd.rs` | 代码完成、9 单测绿、真 addon e2e 通过；未进发布包 | [gzip.md](./gzip.md) |
| `gunzip` | 无 | 无 | 同上（同一实现，隐含 `-d`） | 同上 | [gunzip.md](./gunzip.md) |
| `zcat` | 无 | 无 | 同上（同一实现，隐含 `-dc`） | 同上 | [zcat.md](./zcat.md) |
| `tree` | 无 | 无 | `overlay/crates/pi-builtins/src/treecmd.rs` | 代码完成、32 单测绿、真 addon e2e 24/24 通过；未进发布包 | [tree.md](./tree.md) |

## 候选工具与可用性摸底（Windows）

2026-11-14 在插件的真实 shell 里实测，决定「值不值得自研」先看它现在从哪来：

| 来源 | 含义 | 工具 |
|---|---|---|
| **内建** | pi-builtins 工厂注册，无进程开销 | bassum/base64/cat/chmod/cksum/cmp/comm/cp/cut/date/dd/df/diff/dirname/du/env/fd/find/fold/grep/rg/head/hostname/id/jq/zip/ln/ls/md5sum/mkdir/mktemp/mv/nl/nproc/od/paste/printenv/readlink/realpath/rm/rmdir/sed/seq/sha*sum/sort/sponge/stat/tac/tail/tee/touch/tr/tree/truncate/ts/uname/uniq/uptime/wc/which/whoami/xargs/yes/pgrep/pkill/ps/sleep/timeout/top |
| **Git Bash 外部 exe** | 能用，但依赖 Git 安装、每次 spawn 进程 | unzip / tar / column / shuf / patch / file / awk / less / xxd / split / join / expr |
| **完全缺失** | 哪都没有 | envsubst / nc / watch（`gzip`/`gunzip`/`zcat` 已内建，见清单） |

**优先级原则（用户 2026-11-14 定）**：Git Bash 已提供的降优先级——它们不是不能用，只是没内建；优先补 `完全缺失` 这一类。

注意 `gunzip`/`zcat`：Git 的 `usr/bin/gunzip` 是**无扩展名脚本**，而 brush 在 Windows 上按 PATH 查找只认 `.exe/.cmd/.bat`，所以实测 `command -v gunzip` 为空——「文件存在」不等于「shell 能用」。判别方法就是真 shell 里跑 `command -v`，别只看目录。
## 实现流程

动手前按顺序走完，每一步都有通过标准；跳步的结果是“写完了但对不上原版”。

### 0. 立项验证：确认它真的不存在

- 三条证据至少两条：`command -v <cmd>` 实测落到外部二进制、上游 pin 的 `git ls-tree` 查不到、`pi-builtins/src` 里没有对应模块
- **通过标准**：能一句话说清「谁有、谁没有、我们为什么要自己写」，并写进文档

### 1. 先找现成实现，别自己造轮子

- 顺序：上游 crate → crates.io 成熟库 → 其它语言的同类实现（仅作行为对照）
- 记录候选：库名、版本、许可证（要进 `THIRD_PARTY_NOTICES.md`）、维护状态、已知限制
- **通过标准**：写下选型结论与理由（直接依赖 / 复制代码 / 自己实现）

### 2. 列兼容矩阵，先于写代码

**参数复刻原则（2026-11-14 定）**：原版支持的命令行参数，一律尽可能照原样支持，不因为「用不到」而省掉；只有实现复杂度明显不成比例时才拒绝，并且必须在文档里写明原因。拒绝要报出可读的理由（例如「--du 暂不支持：目录累计大小需要后序遍历累加」），不能静默忽略、也不能让用户看到解析器的 unexpected argument。

- 拉官方手册逐选项过一遍，分三档：**支持** / **语义不同**（写清差在哪） / **不支持**（写清原因：平台无对应语义、库做不到、有意不做）
- 平台差异单独标：Windows 无 fifo、无文件权限位、无硬链接语义
- **通过标准**：矩阵能直接翻译成测试用例清单

### 3. 实现：overlay 优先，补丁最小化

- 业务代码进 `vendor/oh-my-pi/overlay/`，不改上游文件
- 只在必须改接入点（feature、依赖、factory 注册）时加编号补丁 `patches/00NN-<名字>.patch`，并在 `vendor/oh-my-pi/README.md` 台账补一行
- 不许动 `refs/oh-my-pi`，不许动 `node_modules`
- **通过标准**：`pnpm vendor:check` 通过，台账有对应行

### 4. 测试：以兼容矩阵为准，不以覆盖率为准

- 每个「支持」项至少一个正例；每个「不支持」项必须有**明确拒绝**的用例（报错退出），不能静默忽略
- 边界：空输入、超大文件、非 UTF-8 文件名、CRLF、权限位、损坏输入、目标已存在
- 对照测试：与原版二进制跑同一批输入，比对产物（能字节比对就字节比对）
- 端到端：真 addon + 真 shell，走 `PI_NATIVES_DIR` 通道（见 `AGENTS.md` 的「本地 native 开发」）
- **变异验证**：把实现改坏一次，测试必须变红；不红说明没测到
- **通过标准**：`cargo test -p pi-builtins <模块>` 全绿 + 至少一次真实的变异验证记录

### 5. 性能：耗时、CPU、IO 都要有数

- 语料固定且不入库（`bench:fetch` 重建，仓库只提交脚本与说明）
- 冷热各测一遍，重复次数写清，报中位数不报单次
- 与系统原版对比（Git Bash 的二进制），记录机器、版本、口径
- 至少覆盖一类大文件、一类多小文件；Windows 上另看是否走慢盘
- IO 可靠性：并发写同一档案、磁盘满、目标被占用，三种行为要可预期（报错，不是产出一个坏档案）
- **通过标准**：文档里有可直接复现的命令和一张数字表；明显劣化要写原因

### 6. 文档

- `docs/shell-commands/<命令>.md` 一篇，本 README 的清单加一行
- **通过标准**：只看文档能知道支持什么、不支持什么、怎么验证

### 7. 分发前置

- native 平台包与 loader 目前都没接线，命令做完用户也拿不到
- 每次明确这次是「只入代码」还是「要能装」
- **通过标准**：结论写在文档「局限」一节

## 每篇命令文档的固定结构

```
# <命令名>

表头表：一句话定位 / 实现层 / 上游来源 / 实现位置 / 接入方式 / 依赖 / 测试

## 为什么自研      谁有、谁没有、为什么自己写
## 实现规模        文件清单 + 行数，逐文件一句职责
## 能力面          按类别列，具体到选项
## 与 <原版> 的差异 支持 / 语义不同 / 不支持，每条带原因
## 测试与验证      用例数、真机验证方法、变异验证记录
## 局限            已知缺口与代价判断
## 维护            升上游要重跑什么、删除条件
```