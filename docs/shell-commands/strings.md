# strings

| 项 | 内容 |
|---|---|
| 一句话定位 | 从二进制文件里提取可打印字符串，支持单字节、8 位与 UTF-16/32 编码、偏移和文件名前缀 |
| 实现层 | 内建命令（brush + pi-builtins） |
| 上游来源 | GNU binutils 的 `strings`（2.44 行为）；**Windows 上完全缺失**（Git Bash 不带 binutils），排查二进制、看 exe/dll 里的提示语时没有替代 |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/shellcmds/stringscmd.rs`（541 行，含 10 个单测 + 2 个 ignored 探针） |
| 接入方式 | 统一接线补丁 `vendor/oh-my-pi/patches/0001-shell-commands.patch` 提供的 `util.shellcmds` feature；本命令在 overlay 的 `shellcmds.rs` 里加一行注册 |
| 依赖 | 无（只用标准库） |
| 测试 | 10 个单测：单字节/8 位/UTF-16/UTF-32、长度与旧式 `-NUM`、偏移进制、文件名/分隔符、`-w`、`-d`/`-T`/`-U` 拒绝路径、真实 shell |

## 为什么自研

`command -v strings` 在 Windows 的 brush shell 里为空——Git Bash 不带 binutils 的 `strings`。它是「不知道二进制里有什么，先把可读文本倒出来」的第一手段，逻辑本身只是按编码宽度扫描可打印单元，不需要链接 BFD 或 libiberty，自己实现比引入 binutils 依赖清晰得多。

## 实现规模

| 文件 | 职责 |
|---|---|
| `stringscmd.rs` | 参数校验、编码选择、扫描器（1/2/4 字节单元）、偏移与前缀格式化、9 个单测、性能与差分探针 |

## 能力面

| 参数 | 行为 |
|---|---|
| （无） / `-a` / `--all` | 扫描整个文件；`-a` 是 GNU 的历史开关，在现代平台上本来就是默认行为，接受但无额外效果 |
| `-f` / `--print-file-name` | 每条结果前加 `文件名: ` |
| `-n` / `--bytes` | 最短长度，默认 4 |
| `-NUM` | 旧式写法，等价于 `-n NUM`（例如 `strings -6`） |
| `-t` / `--radix` | 偏移进制：`o` / `d` / `x`，宽度 7，后跟一个空格 |
| `-o` | `-t o` 的别名 |
| `-e` / `--encoding` | `s`（7 位）、`S`（8 位）、`b`/`l`（UTF-16BE/LE）、`B`/`L`（UTF-32BE/LE）；非法值报错退出 1 |
| `-w` / `--include-all-whitespace` | 把空白（含换行）算作可打印字符，字符串可以跨行 |
| `-s` / `--output-separator` | 每条结果后的分隔串，默认换行；每条都追加（与 GNU 一致，最后一条也带） |
| `FILE...` | 多个文件顺序扫描；`-` 表示 stdin；没有文件时读 stdin |
| `-h` / `--help`，`-V` / `--version` | 帮助与版本 |

可打印判定（单字节模式）：`\t` 与 `0x20..=0x7e`；`-e S` 额外接受 `0xa0..=0xff`。宽字符模式逐 2/4 字节单元解码，只接受值 `<= 0x7f` 且属于上述可打印集合的单元；偏移按单元的**字节起点**计算。

## 与 GNU strings 的差异

| 项 | 本实现 | GNU binutils | 说明 |
|---|---|---|---|
| `-d` / `--data` | 报错退出 1：`requires BFD section scanning, which is not available` | 只扫描已初始化数据段 | 需要 BFD 解析 ELF/PE 段表，为了一个开关引入整套 BFD 不成比例 |
| `-T` / `--target` | 报错退出 1：`requires BFD` | 指定 BFD 目标格式 | 同上 |
| `-U` / `--unicode` | 只接受 `default`；其它值报错 | 支持 `locale` / `invalid` 等 | 需要完整 UTF-8 解码/locale 数据；`-e l/L/b/B` 已覆盖实际用途 |
| `-a` | 接受，无额外效果 | 现代平台默认全文件扫描，语义相同 | — |
| locale | 固定 ASCII / 8 位 / UTF-16/32 规则 | 依赖 `LC_ALL` 的 `isprint` 与多字节处理 | 结果跨平台可复现；代价是非 ASCII 的 UTF-8 文本不会按字符识别，而是按 `-e S` 的字节规则输出 |
| 内存 | 整个文件读入内存再扫描 | 流式扫描 | 单文件几十 MB 无感；超大文件会占用等量内存（见「局限」） |

## 设计要点

- 扫描器与输出格式分离：`scan()` 返回 `(offset, bytes)` 列表，格式化在 `scan_and_write()`，偏移/前缀/分隔符互不干扰。
- 宽字符按固定宽度步进，不对不完整尾部单元报错（直接丢弃最后不足一个单元的字节），与 GNU 的宽松行为一致。
- 旧式 `-NUM` 由 clap 的 `allow_hyphen_values` 放行后在 `run()` 里识别，避免把 `-3` 当成未知选项；`-n` 优先于旧式写法。
- 输出直接写 `BufWriter`，不先拼大字符串；8 MiB 输入产生 2.7 MB 结果时内存占用可控。

## 测试与验证

- `cargo test -p pi-builtins stringscmd` → 10 通过，2 个 ignored 探针。
- 覆盖：默认最短 4、`-n 3` 与 `-3`、`-t x/d/o` 偏移宽度、`-f` 前缀、`-s` 自定义分隔（含末尾也追加）、UTF-16LE/UTF-32BE、`-w` 跨行、`-d`/`-T` 与 `-U locale` 拒绝理由、非法 `-e`、真实 shell 管道。
- 差分（2026-11-14）：8 MiB 伪随机混合语料，`strings -n 4` 输出 2,735,227 字节，与 BusyBox v1.39.0 的 `strings -n 4` **逐字节相同**（BusyBox 作为本机可用的参考二进制；GNU binutils 未安装）。
- 性能基线（2026-11-14）：环境：Windows 10.0.28000 / i7-12700H / 40 GB，`--profile local` 优化构建，单线程。每项先跑 1 次（记为首次，未清系统文件缓存），再跑 5 次取中位数；本实现只计 `run()` 壁钟（不含进程启动），参考实现用 Node `spawnSync` 计时（含进程启动与 applet 分发）。CPU/IO 未单独分离，只报壁钟。

| 场景 | 本实现 | BusyBox strings | 输出字节 |
|---|---|---|---|
| 8 MiB 混合大文件 | **87.3 ms** | 247.0 ms | 2,735,227 |
| 300 × 4 KiB 小文件 | **46.8 ms** | 129.7 ms | 777,973 |

  首次运行：本实现 84.5 ms / 参考 222.5 ms（大文件）。两种场景的输出字节数都与参考一致。

## 局限

- 整文件读入内存：扫描 1 GiB 文件会占用约 1 GiB 内存；需要流式处理超大文件时应改用外部 GNU strings。
- 不解析目标文件格式：`-d` / `-T` 明确拒绝，不能只扫数据段，也不能指定 BFD 目标。
- UTF-8 locale 下的多字节可打印字符不按字符识别；`-e S` 只按 8 位字节规则处理。
- 没有实现 GNU 的 `-U` 其它模式（`locale`、`invalid`）。
- **分发**：随 addon 注册，但 native 平台包/loader 尚未接线，用户还不能从 npm 安装得到。真实 addon 已用 `PI_NATIVES_DIR` 通道验证加载（24/24 全过），但 e2e 场景未单列 strings 断言；命令本身由真实 shell 单测覆盖。

## 维护

- 升上游 pin 后重跑 `pnpm vendor:apply` / `pnpm vendor:check`，确认聚合补丁仍能应用。
- 删除条件：上游 pi-builtins 自带 strings，或 Windows 的 Git Bash 开始提供可用的 `strings`。
