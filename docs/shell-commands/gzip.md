# gzip / gunzip / zcat

| 项 | 内容 |
|---|---|
| 一句话定位 | DEFLATE 压缩与解压（`gzip` 调用名）；`gunzip` / `zcat` 是同一实现的另两个名字，各自文档见 [gunzip.md](./gunzip.md)、[zcat.md](./zcat.md) |
| 实现层 | 内建命令（brush + pi-builtins），不是外部进程 |
| 上游来源 | 上游 pin 没有 gzip/gunzip/zcat；Windows 上 `gzip` 落到 Git Bash 的 `gzip.exe`，`gunzip` 是**无扩展名脚本**，而 brush 在 Windows 按 PATH 查找只认 `.exe/.cmd/.bat` → 等于完全不可用 |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/gzipcmd.rs`（680 行，含 10 个单测） |
| 接入方式 | `vendor/oh-my-pi/patches/0003-gzip-integration.patch`（4 处：pi-builtins 的 Cargo.toml / lib.rs / factory.rs，pi-natives 的 feature 列表） |
| 依赖 | `flate2 1.1`（已在 lock 里，MIT/Apache-2.0，无新增传递依赖） |
| 测试 | 9 个单测 + 1 个性能探针（ignored）；pi-builtins 全量 1322 通过 |

## 为什么自研

- `gunzip` 在本机 brush 里 `command -v` 为空：Git 提供的是无扩展名脚本，brush 的 Windows PATH 查找跳过它。
- `gzip`/`zcat` 虽然有 Git 的 exe，但每次调用都要 spawn 进程，且在没装 Git 的机器上直接缺失。
- 三个名字共用一份实现，成本远低于分别补。

## 能力面

| 类别 | 参数 |
|---|---|
| 模式 | `-d` 解压、`-t` 校验、`-l` 列表、默认压缩 |
| 输出 | `-c` 写到 stdout、`-S SUF` 自定义后缀（默认 `.gz`，解压认 `.tgz`→`.tar`） |
| 文件 | `-k` 保留输入、`-f` 覆盖、`-r` 递归目录 |
| 头部 | `-n` 不写文件名与时间、默认写入（等同 `-N`） |
| 其它 | `-q` 静默、`-v` 打印压缩率、`-1`..`-9` / `--fast` / `--best`、`-h`、`-V` |
| 调用名 | `gunzip` = `-d`；`zcat` = `-dc` |

## 与 GNU gzip 1.14 的差异

| 项 | 本实现 | GNU gzip |
|---|---|---|
| `-v` 输出 | 只打印 `输入: 比例% -- replaced with 输出` | 还包含方法、crc 等细节 |
| `-l` 表头 | 简化版（compressed / uncompressed / ratio / name） | 带 CRC 列 |
| `-N` | 与默认行为相同（默认就写名字与时间） | 默认写，`-n` 关闭 |
| 错误码 | 1 硬错误、2 警告（如未知后缀） | 相同约定 |

## 明确拒绝的参数（报错并说明原因）

| 参数 | 原因 |
|---|---|
| `-a` / `--ascii` | 行尾转换在 Windows 无意义 |
| `--rsyncable` | 需要 rsync 专用分块，未实现 |
| `--synchronous` | 写入即 flush，无独立刷盘策略 |
| `-L` / `--license` | 不随内置命令分发许可证文本 |

## 设计要点

- 解压与压缩都走 `flate2`，流式 `io::copy`，不把整个文件读进内存。
- 输出先写 `<目标>.part` 再 `rename`，失败时删除临时文件，避免半截产物。
- 相对路径按 **shell 的 cwd** 解析，不是进程 cwd。
- `-l` 需要完整解压一遍才能得到原始大小（gzip 头部不存该值），与 GNU 行为一致。

## 测试来源

上游没有可移植的测试套件：gzip 1.14 的发布包只有 `make check` 的一次冒烟（压缩自身文档再解压比对），逐功能用例不在发布包里；savannah 的 git `tests/` 取不到（cgit snapshot 返回错误页、plain 路径空响应，GitHub 也没有可用镜像）。

因此这里的测试是两类：

1. **自制行为用例**：往返字节一致、`-k`/`-f`/`-l`/`-t`/后缀/缺失文件/verbose/拒绝项。
2. **与系统 GNU gzip 的双向互操作**（差分测试，`interoperates_with_the_system_gzip`）：我们的归档交给系统 gzip `-dc` 解，系统的归档交给我们的 `-dc` 解，两边字节比对。这条比移植单测更能证明格式兼容；没装 gzip 的环境会跳过。

## 测试与验证

- `cargo test -p pi-builtins gzipcmd` → 9 通过（1 个性能探针 ignored）
- `cargo test -p pi-builtins` → 1317 通过、2 ignored（无回归）
- 用例：往返压缩解压字节一致、`-k` 保留输入、无 `-f` 拒绝覆盖、`-l` 报原始大小、`-t` 校验正常与损坏文件、未知后缀报 2、文件不存在报 1、`-v` 打印比例

## 局限与后续

- **真 addon 端到端已验证**（2026-11-14）：`local` 构建 → `scripts/stamp-pi-natives.mjs` 打戳 → 替换 leaf 包 `.node` → `PI_E2E_EXPECT_TREE=1 pnpm e2e`，24 项全过；其中步骤 1 的命令是 `echo MOCK_E2E_BASH_OK; tree --version; printf gzip-ok | gzip -c | gunzip`，输出里出现 `gzip-ok` 说明压缩+解压往返成立
- 性能：64MB 重复语料，内建 **245 ms（261 MB/s）** vs Git gzip.exe **191 ms**，慢约 28%（内建侧含参数解析与临时文件写盘；两者都是默认级别 6）
- `-r` 的符号链接语义、连接文件的报错尚未对齐

## 维护

- 升上游 pin 后重跑 `pnpm vendor:apply`，确认 0003 仍能应用
- 代码全在 `overlay/`；删除条件：上游 pi-builtins 自己实现 gzip