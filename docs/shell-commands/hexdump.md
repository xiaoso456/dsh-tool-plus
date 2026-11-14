# hexdump

| 项 | 内容 |
|---|---|
| 一句话定位 | 以十六进制/八进制/十进制/ASCII 固定版式查看二进制内容，支持跳过、限长、去重折叠 |
| 实现层 | 内建命令（brush + pi-builtins） |
| 上游来源 | util-linux 的 `hexdump`（2.41 手册语义）；**Windows 上完全缺失**（Git Bash 既没有 hexdump 也没有等价的 od 之外工具） |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/shellcmds/hexdumpcmd.rs`（794 行，含 10 个单测 + 2 个 ignored 探针） |
| 接入方式 | 统一接线补丁 `vendor/oh-my-pi/patches/0001-shell-commands.patch` 提供的 `util.shellcmds` feature；本命令在 overlay 的 `shellcmds.rs` 里注册 `hexdump` 与 `hd` 两个名字 |
| 依赖 | 无（只用标准库） |
| 测试 | 10 个单测：7 种固定版式、`hd` 隐含 `-C`、折叠、跳过/限长、大小后缀、拒绝路径、真实 shell |

## 为什么自研

`command -v hexdump` 在 Windows 的 brush shell 里为空。看文件头、定位协议字段、确认 UTF-8 字节、排查二进制差异都靠它；Git Bash 只有 `od`/`xxd`，前者版式不直观，后者是外部 exe。固定版式本质是逐字节格式化，不需要任何外部库。

## 实现规模

| 文件 | 职责 |
|---|---|
| `hexdumpcmd.rs` | 参数解析、版式枚举、大小后缀解析、8 种渲染器、折叠与窗口切片、单测与探针 |

## 能力面

| 参数 | 行为 |
|---|---|
| （无） | 默认版式：偏移 + 8 个两字节小端十六进制字，每行 16 字节 |
| `-b` / `--one-byte-octal` | 每行 16 个三列八进制字节 |
| `-X` / `--one-byte-hex` | 每行 16 个两列十六进制字节（较新 util-linux 版式，2.43.devel 手册已收录） |
| `-c` / `--one-byte-char` | 每行 16 个字符：可打印字符原样、控制字符用 `\0 \a \b \t \n \v \f \r`、其余三列八进制 |
| `-C` / `--canonical` | 经典 `xxd` 风格：偏移 + 16 字节十六进制 + `\|ASCII\|` |
| `-d` / `--two-bytes-decimal` | 每行 8 个五列十进制两字节单元 |
| `-o` / `--two-bytes-octal` | 每行 8 个六列八进制两字节单元 |
| `-x` / `--two-bytes-hex` | 每行 8 个四列十六进制两字节单元 |
| `-v` / `--no-squeezing` | 不把连续重复行折叠成 `*` |
| `-n` / `--length LEN` | 最多显示 LEN 字节 |
| `-s` / `--skip OFS` | 跳过前 OFS 字节，输出偏移仍从原文件位置开始 |
| `-h` / `--help`，`-V` / `--version` | 帮助与版本 |
| `FILE...` | 多个文件按顺序拼接；`-` 表示 stdin；没有文件时读 stdin |

`LEN`/`OFS` 接受十进制、`0x` 十六进制、前导 `0` 八进制；后缀 `K`/`KiB` 等按 1024，`KB`/`MB` 等按 1000（与 util-linux 一致）。多个版式开关同时出现时，**命令行上最后一个生效**。

`hd` 是同一实现的别名，**默认等价于 `hexdump -C`**；显式给 `-b`/`-x` 等仍以显式版式为准。

## 与 util-linux hexdump 的差异

| 项 | 本实现 | util-linux | 说明 |
|---|---|---|---|
| `-e` / `--format`，`-f` / `--format-file` | **不支持**，报错退出 1：`custom format strings are not supported (the format language is a mini-printf)` | 完整格式语言（迭代次数/字节数/转换字符/转义） | 那是一个小型 printf 解释器，工作量会超过其余全部功能之和；固定版式已覆盖绝大多数用法，按「复杂度明显不成比例」拒绝并报可读原因 |
| `-L` / `--color` | **不支持**，报错退出 1：`-L/--color is not implemented` | 支持 auto/never/always，默认随终端 | 颜色映射表与终端探测都没有实现；不算静默忽略 |
| `-X` | 支持，版式按手册「16 个空格分隔、两列、补零」实现 | 较新版本支持（2.43.devel 手册已收录） | 本机参考二进制 BusyBox 1.39 没有 `-X`，无法做差分；用单测钉住版式 |
| 重复行折叠 | 连续相同的完整 16 字节组输出一次 `*` | 相同行为 | 未整组的尾部不会重复，无需折叠 |
| 两字节单元的字节序 | 固定按小端组合 | 按宿主字节序 | x86/ARM 的 Windows/macOS/Linux 都是小端；大端平台输出会不同 |
| `-c` 的字符分类 | 固定 ASCII（`\t` 与 `0x20..=0x7e`） | 受 locale 影响 | 跨平台可复现 |
| 空输入 | 不输出任何内容 | 相同 | 已验证 |
| `-s` 超过文件尾 | 只输出文件长度偏移 | BusyBox 同行为；util-linux 按 getopt+读逻辑也如此 | 不做额外报错 |
| 其它 | 无已知差异 | — | 7 种固定版式在 8 MiB 语料上与参考实现逐字节相同 |

## 设计要点

- 渲染器是纯函数 `render(data, first_offset, mode, no_squeeze) -> String`：先切片再渲染，偏移计算与版式解耦，单测可直接断言字节串。
- 折叠只比较原始字节组（16 字节），与版式无关；`-v` 关闭后每条都输出。
- 两字节单元按小端组合，再分别以 `%04x`/`%05d`/`%06o` 格式化，缺字段用等宽空格补齐，保证列对齐。
- `-c` 的控制字符名与八进制回退集中在一个 `char_name()`，避免 8 个渲染器各自复制。

## 测试与验证

- `cargo test -p pi-builtins hexdumpcmd` → 10 通过，2 个 ignored 探针。
- 覆盖：8 种版式的完整/部分最后一行、`*` 折叠与 `-v`、`-s`/`-n`、`hd` 默认与显式版式覆盖、大小后缀与非法值、`-e`/`-L` 拒绝理由、文件与 stdin、真实 shell 管道。
- 差分（2026-11-14）：8 MiB 伪随机混合语料，`-v` 下 default/`-b`/`-c`/`-C`/`-d`/`-o`/`-x` 七种输出与 BusyBox v1.39.0 **逐字节相同**（`-C` 输出 41,418,761 字节；其余版式 25–41 MB）。
- 性能基线（2026-11-14，`-C`）。环境：Windows 10.0.28000 / i7-12700H / 40 GB，`--profile local` 优化构建，单线程。每项先跑 1 次（记为首次，未清系统文件缓存），再跑 5 次取中位数；本实现只计 `run()` 壁钟（不含进程启动），参考实现用 Node `spawnSync` 计时（含进程启动与 applet 分发）。CPU/IO 未单独分离，只报壁钟。

| 场景 | 本实现 | BusyBox hexdump | 输出字节 |
|---|---|---|---|
| 8 MiB 混合大文件 | **332.2 ms** | 2,508.9 ms | 41,418,761 |
| 300 × 4 KiB 小文件 | **68.9 ms** | 453.6 ms | 6,067,209 |

  首次运行：本实现 317.9 ms / 参考 2,620.6 ms（大文件）。两种场景的输出字节数都与参考一致。

## 局限

- `-e`/`-f` 格式语言与 `-L` 颜色不支持（理由见上）；需要自定义格式时只能用固定版式组合。
- 整文件读入内存后渲染：8 MiB 生成 41 MB 输出字符串，超大文件（数百 MB）会同时占用输入与输出内存；流式输出是后续可做的优化。
- 偏移宽度固定为 7 位（`-C` 为 8 位），超过 16 MiB 后按实际位数自然加宽，与参考实现一致。
- **分发**：随 addon 注册，但 native 平台包/loader 尚未接线。真实 addon 已用 `PI_NATIVES_DIR` 通道验证加载（24/24 全过），但 e2e 场景未单列 hexdump 断言；命令本身由真实 shell 单测覆盖。

## 维护

- 升上游 pin 后重跑 `pnpm vendor:apply` / `pnpm vendor:check`，确认聚合补丁仍能应用。
- 若将来实现 `-e`，应把格式解析拆成独立模块并补一整套转换字符的差分用例；不要塞进现有渲染器。
- 删除条件：上游 pi-builtins 自带 hexdump，或 Windows 的 Git Bash 开始提供可用的 `hexdump`。
