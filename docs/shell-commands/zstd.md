# zstd

| 项 | 内容 |
|---|---|
| 一句话定位 | Zstandard 压缩/解压；`.tar.zst` 这类分发包的直接解压工具 |
| 实现层 | 内建命令（brush + pi-builtins）；`zstd` / `unzstd` / `zstdcat` 三个调用名共用一份实现 |
| 上游来源 | GNU zstd；**Windows 上完全缺失**（Git Bash 也不带） |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/zstdcmd.rs`（约 620 行，含 9 个单测） |
| 接入方式 | 统一接线补丁 `vendor/oh-my-pi/patches/0001-shell-commands.patch` 提供的 `util.shellcmds` feature；三个调用名在 overlay 的 `shellcmds.rs` 里注册 |
| 依赖 | `zstd 0.14`（已在 lock 里，MIT；zstd-sys 用 cc 构建，无需 cmake） |
| 测试 | 9 个单测（含真实 shell 的调用名测试） |

## 为什么自研

`command -v zstd` 在本机 brush 里为空——Windows 与 Git Bash 都不提供。`.tar.zst` 已是常见分发格式（很多工具链的预编译包），缺了就只能报错让用户装第三方。

## 能力面

| 类别 | 参数 |
|---|---|
| 模式 | 默认压缩、`-d` 解压、`-t` 校验、`-l` 列表 |
| 输出 | `-c` 写到 stdout、`-o FILE` 指定输出、`-S SUF` 自定义后缀（默认 `.zst`，解压认 `.tzst`→`.tar`） |
| 文件 | `-f` 覆盖、`--rm` 成功后删除源文件（默认保留，符合 zstd 语义） |
| 级别 | `-1`..`-19`、`--fast[=N]`（负数级别） |
| 其它 | `-q` 静默、`-v` 打印大小、`-h`、`-V` |
| 调用名 | `unzstd` = `-d`；`zstdcat` = `-dc` |

## 与 GNU zstd 的差异

| 项 | 本实现 | GNU zstd |
|---|---|---|
| 多帧串接 | 单帧（`Decoder` 读到帧尾即止） | 支持 concatenated frames |
| `-l` 输出 | 简化（compressed / uncompressed / ratio / name） | 带帧数与 checksum 列 |
| `-v` | 打印输入输出字节数 | 更详细的进度与比例 |
| 默认级别 | 3 | 3 |

## 明确拒绝的参数（报可读原因）

| 参数 | 原因 |
|---|---|
| `-D` / `--patch-from` | 字典文件未实现 |
| `-T` | 多线程压缩未实现（不启 zstdmt） |
| `--long` / `--ultra` / `--train` | 长距离模式、超高级别、字典训练均未实现 |
| `--format` | 只产出原生 zstd 帧（gzip/xz/lzma 输出不支持） |

## 设计要点

- 数字级别的解析：clap 只接受单字符短选项，`-19` 会被拆开；因此实现 `rewrite_argv`，把纯数字 token 改写成隐藏参数 `--level=N` 后再交给 clap。
- 输出先写 `<目标>.part` 再 rename，失败清理临时文件。
- 相对路径（输入与 `-o`）都按 **shell 的 cwd** 解析。
- `zstd` 默认**不删**源文件，只有 `--rm` 才删；这点与 gzip 相反，已在行为上对齐。

## 测试来源

上游 zstd 的测试是 C/Perl 混合的回归套件（`tests/playTests.sh` 依赖大量构建产物），无法直接搬进 cargo 单测。这里按手册语义自写 9 条；调用名（`unzstd`/`zstdcat`）那条走真实 shell（`run_script` + 管道），因为只有真实分发才会用到 argv[0]。

本机没有系统 `zstd`，因此**没有**像 gzip 那样的双向互操作测试；如果在有 zstd 的机器上跑，建议补一条「我们的归档交给系统 zstd -d 解」的差分用例。

## 测试与验证

- `cargo test -p pi-builtins zstdcmd` → 9 通过
- 覆盖：往返字节一致、默认保留源文件、`--rm` 删除源、拒绝覆盖与 `-f` 覆盖、`-o` 指定输出、`-t` 校验正常与损坏、`-l` 报原始大小、`-1/-19` 解析与越界拒绝、拒绝项报原因、`zstdcat` 调用名

## 局限与后续

- 多帧串接、字典、多线程未实现（均有明确原因）
- **真 addon 端到端已验证**（2026-11-14）：`local` 构建 → `scripts/stamp-pi-natives.mjs` 打戳 → 替换 leaf 包 `.node` → `PI_E2E_EXPECT_TREE=1 pnpm e2e`，24 项全过；步骤 1 的命令含 `printf zstd-ok | zstd -q | unzstd`，输出里出现 `zstd-ok`

## 维护

- 升上游 pin 后重跑 `pnpm vendor:apply`，确认 0005 仍能应用
- 代码全在 `overlay/`；删除条件：上游 pi-builtins 自带 zstd