# rev

| 项 | 内容 |
|---|---|
| 一句话定位 | 逐行反转字符顺序（默认 UTF-8 按字符，非法序列按字节），支持 NUL 分行 |
| 实现层 | 内建命令（brush + pi-builtins） |
| 上游来源 | util-linux 的 `rev`（2.43 手册语义：characterwise，`-0` 用 NUL 分行）；**Windows 上完全缺失**（Git Bash 不提供） |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/shellcmds/revcmd.rs`（266 行，含 7 个单测 + 2 个 ignored 探针） |
| 接入方式 | 统一接线补丁 `vendor/oh-my-pi/patches/0001-shell-commands.patch` 提供的 `util.shellcmds` feature；本命令在 overlay 的 `shellcmds.rs` 里加一行注册 |
| 依赖 | 无（只用标准库） |
| 测试 | 7 个单测：ASCII/空行/无尾换行、NUL 分行、UTF-8 与非法字节、文件与 stdin、缺文件继续、帮助/版本、真实 shell |

## 为什么自研

`command -v rev` 在 Windows 的 brush shell 里为空。它常被用来反转路径、倒序查看流水、生成回文类测试数据；逻辑只有「按分隔符切行 + 反转 + 原样输出」，用标准库几十行就能完成，不值得引入外部依赖。

## 实现规模

| 文件 | 职责 |
|---|---|
| `revcmd.rs` | 参数解析、按分隔符切分、UTF-8/字节反转、多文件与错误处理、7 个单测、性能与差分探针 |

## 能力面

| 参数 | 行为 |
|---|---|
| （无） | 以 `\n` 分行；无文件时读 stdin |
| `-0` / `--zero` | 以 NUL（`\0`）作为记录分隔符，输出也用 NUL |
| `-h` / `--help`，`-V` / `--version` | 帮助与版本 |
| `FILE...` | 逐文件处理；`-` 表示 stdin（重复的 `-` 只读一次）；缺文件报错但继续处理其余文件，最终退出码 1 |

分隔符本身保留在原来的位置：输入最后没有分隔符时，输出也没有；空行原样保留。

## 与 util-linux rev 的差异

| 项 | 本实现 | util-linux | 说明 |
|---|---|---|---|
| 多字节字符 | 固定按 UTF-8 码点反转；某一行不是合法 UTF-8 时，该行退化为按字节反转 | 按当前 locale 的 wide-char 处理 | 我们在 Windows 上固定 UTF-8，避免受 `LC_ALL` 影响；对合法 UTF-8 与参考实现结果一致，非法字节不会丢数据 |
| 内存 | 整个文件读入内存再按分隔符切分 | 每次分配一整行 wide-char 缓冲 | 两者都是“整行/整文件”模型；超大且无换行的文件都可能占大量内存（见「局限」） |
| 缺文件 | 报错后继续处理其余文件，退出码 1 | 未逐字节对照 | 我们选择 cat 风格：一次调用尽量处理完；这是有意行为，不声称与参考一致 |
| `-` 重复 | 只读一次 stdin | 依次读（第二次读到 EOF） | 结果等价 |
| 其它 | 无已知差异 | — | ASCII 语料逐字节相同 |

## 设计要点

- `reverse_data(data, delimiter, output)` 只负责切片与分隔符，`reverse_segment()` 只负责单段反转；`-0` 只是换一个分隔符字节。
- 单段先用 `std::str::from_utf8` 试解码：成功则 `chars().rev()`，失败则 `bytes().rev()`。非法行整行按字节处理，不做替换字符，保证二进制内容不被改写。
- 文件读取用 `std::fs::read`，路径先经 `host.resolve()` 解析到当前工作目录。
- 输出一次性 `BufWriter` 写出，避免逐行 flush。

## 测试与验证

- `cargo test -p pi-builtins revcmd` → 7 通过，2 个 ignored 探针。
- 覆盖：多行/空行/末行无换行、NUL 分隔（含末尾 NUL）、中文按字符反转、非法 UTF-8 按字节反转、文件与 stdin、缺文件继续且退出码 1、帮助/版本、真实 shell 管道。
- 差分（2026-11-14）：8,388,643 字节纯 ASCII 文本，与 BusyBox v1.39.0 的 `rev` 输出**逐字节相同**（BusyBox 是字节级实现；本语料不含多字节字符，因此该对比同时验证了分隔与末尾行为）。
- 性能基线（2026-11-14，纯 ASCII 语料）：环境：Windows 10.0.28000 / i7-12700H / 40 GB，`--profile local` 优化构建，单线程。每项先跑 1 次（记为首次，未清系统文件缓存），再跑 5 次取中位数；本实现只计 `run()` 壁钟（不含进程启动），参考实现用 Node `spawnSync` 计时（含进程启动与 applet 分发）。CPU/IO 未单独分离，只报壁钟。

| 场景 | 本实现 | BusyBox rev | 输出字节 |
|---|---|---|---|
| 8 MiB 文本大文件 | **36.9 ms** | 114.1 ms | 8,388,643 |
| 300 × 4 KiB 文本小文件 | **36.2 ms** | 115.6 ms | 1,239,575 |

  首次运行：本实现 33.0 ms / 参考 114.6 ms（大文件）。两种场景的输出字节数都与参考一致。

## 局限

- 整文件读入内存：反转 1 GiB 无换行文件会占用约 1 GiB 内存（util-linux 的整行缓冲在无换行时同样会很大）。
- 固定 UTF-8，不随 locale 切换；在非 UTF-8 编码的文本上会退化为字节反转（不损坏数据，但显示顺序不是“字符”顺序）。
- 不支持无分隔符时的流式处理，也没有 `--` 之外的额外选项（util-linux 也只有 `-0/-h/-V`）。
- **分发**：随 addon 注册，但 native 平台包/loader 尚未接线。真实 addon 已用 `PI_NATIVES_DIR` 通道验证加载（24/24 全过），但 e2e 场景未单列 rev 断言；命令本身由真实 shell 单测覆盖。

## 维护

- 升上游 pin 后重跑 `pnpm vendor:apply` / `pnpm vendor:check`，确认聚合补丁仍能应用。
- 删除条件：上游 pi-builtins 自带 rev，或 Windows 的 Git Bash 开始提供可用的 `rev`。
