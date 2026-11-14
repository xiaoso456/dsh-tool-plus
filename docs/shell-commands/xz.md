# xz

| 项 | 内容 |
|---|---|
| 一句话定位 | LZMA2 压缩/解压；`.tar.xz` 源码包与 `.xz` 分发件的主要解压工具 |
| 实现层 | 内建命令（brush + pi-builtins）；`xz` / `unxz` / `xzcat` 三个调用名共用一份实现 |
| 上游来源 | XZ Utils（GNU xz）；**Windows 上完全缺失**（Git Bash 也不带） |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/xzcmd.rs`（约 700 行，含 8 个单测） |
| 接入方式 | `vendor/oh-my-pi/patches/0006-xz-integration.patch`（含 Cargo.toml / lib.rs / factory.rs / pi-natives 的 feature，以及 Cargo.lock 的累计条目） |
| 依赖 | `xz2 0.1`（liblzma 绑定，MIT；`static` feature 内置 C 源码，cc 构建，不需要 cmake） |
| 测试 | 8 个单测（含真实 shell 的调用名测试） |

## 为什么自研

`command -v xz` 在本机 brush 里为空：Windows 与 Git Bash 都不提供。`.tar.xz` 仍是大量源码包/预编译包的默认格式，缺了只能让用户装 7-Zip。

## 能力面

| 类别 | 参数 |
|---|---|
| 模式 | 默认压缩、`-d` 解压、`-t` 校验、`-l` 列表 |
| 输出 | `-c` 写到 stdout、`-S SUF` 自定义后缀（默认 `.xz`，解压认 `.txz`→`.tar`） |
| 文件 | `-f` 覆盖、`-k` 保留源文件（**默认删除源文件**，符合 xz 语义） |
| 级别 | `-0`..`-9`、`-e` 极端模式、组合形式（`-9e`） |
| 完整性 | `--check=none|crc32|crc64|sha256`（默认 crc64） |
| 其它 | `-q` 静默、`-v` 打印大小、`-h`、`-V` |
| 调用名 | `unxz` = `-d`；`xzcat` = `-dc` |

## 与 GNU xz 的差异

| 项 | 本实现 | GNU xz |
|---|---|---|
| 多流串接 | 支持（`XzDecoder::new_multi_decoder`） | 支持 |
| `-l` 输出 | 简化（compressed / uncompressed / ratio / name） | 带流数、块数、校验类型、内存用量 |
| `-v` | 打印输入输出字节数 | 更详细的进度与比例 |
| 默认级别 | 6 | 6 |

## 明确拒绝的参数（报可读原因）

| 参数 | 原因 |
|---|---|
| `-T` / `--threads` | 多线程模式未实现 |
| `--format=lzma\|raw` | 只产出/读取 xz 容器（lzma-alone、raw 未实现） |
| `--block-*` / `--memlimit-*` | 块控制与内存限制未实现 |

## 设计要点

- 数字级别与 zstd 一样用 `rewrite_argv` 预解析：`-9`、`-9e` 改写成 `--level=9`（+ `-e`）再交给 clap。
- `-e` 通过 `preset | LZMA_PRESET_EXTREME`（`0x8000_0000`）传给 liblzma。
- 输出先写 `<目标>.part` 再 rename，失败清理临时文件。
- 相对路径（输入）按 **shell 的 cwd** 解析。

## 测试来源

XZ Utils 的测试是 C 测试程序 + `tests/*.sh` 回归脚本，依赖完整构建树，无法直接搬进 cargo 单测。这里按手册语义自写 8 条；调用名（`unxz`/`xzcat`）走真实 shell（`run_script` + 管道）。

本机没有系统 `xz`，因此没有双向互操作测试；有 xz 的机器上建议补「我们的归档交给系统 xz -d 解」的差分用例。

## 测试与验证

- `cargo test -p pi-builtins xzcmd` → 8 通过
- 覆盖：往返字节一致、默认删除源、`-k` 保留、拒绝覆盖与 `-f`、`-t` 正常与损坏、`-l` 报原始大小、`-0/-9e` 解析与越界拒绝、拒绝项报原因、`xzcat` 调用名

## 局限与后续

- 单线程、无字典/块控制（均有明确原因）
- **真 addon 端到端已验证**（2026-11-14）：`local` 构建 → `scripts/stamp-pi-natives.mjs` 打戳 → 替换 leaf 包 `.node` → `PI_E2E_EXPECT_TREE=1 pnpm e2e`，24 项全过；步骤 1 的命令含 `printf xz-ok | xz -q | unxz`，输出里出现 `xz-ok`
- 干净树重放验证：`git reset --hard` 后 `node scripts/vendor.mjs apply`，0001→0006 六个补丁全部应用；0006 的 Cargo.lock 段同时补齐了 zstd 与 xz 的依赖条目（0005 当时未包含 lock）

## 维护

- 升上游 pin 后重跑 `pnpm vendor:apply`，确认 0006 仍能应用
- 代码全在 `overlay/`；删除条件：上游 pi-builtins 自带 xz