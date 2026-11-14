# free

| 项 | 内容 |
|---|---|
| 一句话定位 | 显示系统内存与交换区的总量、已用、可用、缓存和提交量 |
| 实现层 | 内建命令（brush + pi-builtins） |
| 上游来源 | procps-ng 的 `free`（按 4.0.4 的 `free.c` / `local/units.c` 实现排版与缩放）；**Windows 上完全缺失** |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/shellcmds/freecmd.rs`（742 行，含 13 个单测 + 1 个 ignored 性能探针） |
| 接入方式 | 统一接线补丁 `vendor/oh-my-pi/patches/0001-shell-commands.patch` 提供的 `util.shellcmds` feature；本命令在 overlay 的 `shellcmds.rs` 里加一行注册 |
| 依赖 | 无新库：Windows 复用已有的 `windows-sys 0.61`，补丁里新增 `Win32_System_ProcessStatus` feature（`GetPerformanceInfo`） |
| 测试 | 13 个单测：排版、缩放、单位冲突、重复、`/proc/meminfo` 解析、真机采样、真实 shell |

## 为什么自研

`command -v free` 在 Windows 上为空。查内存余量通常要开任务管理器或写 PowerShell（`Get-CimInstance Win32_OperatingSystem`），脚本里没有像 `free` 这样一眼能读、能 `awk` 的固定排版。实现只读系统计数器并格式化，不需要新依赖；Windows 部分用 `GlobalMemoryStatusEx` + `GetPerformanceInfo`，Unix 部分读 `/proc/meminfo`。

## 实现规模

| 文件 | 职责 |
|---|---|
| `freecmd.rs` | 参数解析、单位/人类可读缩放、procps 排版、Windows 与 `/proc/meminfo` 两个采样器、13 个单测与性能探针 |

## 能力面

| 参数 | 行为 |
|---|---|
| （无） | 默认按 KiB 输出；procps 4.x 的 11 字符列宽与表头 |
| `-b` / `--bytes` | 字节 |
| `-k` / `--kibi`，`-m` / `--mebi`，`-g` / `--gibi` | KiB / MiB / GiB（1024 进制） |
| `--tebi`，`--pebi` | TiB / PiB |
| `--kilo`，`--mega`，`--giga`，`--tera`，`--peta` | KB / MB / GB / TB / PB（1000 进制） |
| `-h` / `--human` | 人类可读，算法照抄 procps `scale_size`：`999B`、`1.0Ki`、`16Gi`，binary 带 `i` |
| `--si` | 1000 进制；未指定单位时默认输出也从 KiB 变为 KB |
| `-w` / `--wide` | 把 `buff/cache` 拆成 `buffers` 与 `cache` 两列 |
| `-l` / `--lohi` | 额外打印 Low/High 两行；**仅 Unix**，Windows 明确拒绝（无 low/high 内存划分） |
| `-L` / `--line` | 单行短标签：`SwapUse … CachUse … MemUse … MemFree …` |
| `-t` / `--total` | 追加 `Total:` 行（内存 + swap 的 total/used/free） |
| `-v` / `--committed` | 追加 `Comm:` 行（commit limit / committed / 剩余） |
| `-s` / `--seconds N` | 每 N 秒重复；支持小数 |
| `-c` / `--count N` | 重复 N 次；单独给 `-c` 时按 1 秒间隔重复（与 procps 一致） |
| `--help`，`-V` / `--version` | 帮助与版本 |

多个单位开关同时出现时报错 `Multiple unit options don't make sense.`（与 procps 相同）。`-s` 非正数、`-c 0` 均报错退出 1。

## 与 procps-ng free 的差异

| 项 | 本实现 | procps-ng | 说明 |
|---|---|---|---|
| Windows 的 `free` 列 | `available - SystemCache` | 无 Windows 实现 | Windows 不暴露 Linux 的 `MemFree`；拆出 cache 后保证 `free + buff/cache = available`，列可相加 |
| Windows 的 `buff/cache` | `GetPerformanceInfo::SystemCache × page size` | — | 是系统缓存页的近似，不是 Linux 的 `Cached + SReclaimable` |
| `buffers` / `shared` | Windows 恒为 0 | 真实值 | Windows 无对应计数器；文档明示，不伪造 |
| swap | `TotalPageFile - TotalPhys`、`AvailPageFile - AvailPhys` 差值近似 | swap 分区精确值 | Windows 的分页文件与 Linux swap 语义不同 |
| `-l` | Windows 拒绝并说明原因；Unix 正常 | 始终支持 | Windows 无 Low/High 划分 |
| 文案 / 表头 | 固定英文 ASCII | 受 gettext/locale 影响 | 跨平台可复现；locale 翻译不实现 |
| `--help` | clap 生成的帮助 | procps 自带帮助 | 选项集合一致，排版不同 |
| 数值精度 | `u64`，整数截断；`-h` 按 procps 的位数规则 | `unsigned long` | 几十 GB 内存无溢出风险 |

## 设计要点

- 平台采样与格式化分离：`sample()` 返回 `Snapshot`，`render()` 是纯函数，单测用合成快照钉死列宽与数值。
- procps 的 `scale_size` 逐条照抄：默认 `bytes / base`（KiB/KB）、显式单位按指数、human 先试 4/5 字符的 `%.1f` 再退整数，binary 后缀加 `i`。
- 表头与行都用 9 字符标签位 + 11 字符数值位 + 一个分隔空格，和 procps 的 `print_head_col`/`%11s` 一致。
- Windows 采样同时读 `GlobalMemoryStatusEx`（物理内存、pagefile）与 `GetPerformanceInfo`（SystemCache、Commit 计数）；`free + buff/cache = available` 是刻意维持的不变量。
- Unix 采样解析 `/proc/meminfo`，`Cached + SReclaimable` 作为 cache，`Shmem` 作为 shared，`MemTotal - MemAvailable` 作为 used（procps 4 语义）。

## 测试与验证

- `cargo test -p pi-builtins freecmd` → 13 通过，1 个 ignored 性能探针。
- 覆盖：默认表头与 Mem/Swap 行**逐字符**断言、`-w`/`-t`/`-v`/`-L`、`scale_size` 与 human 边界（0B/999B/1.0Ki/16Gi/1.0K）、`/proc/meminfo` 合成数据推导、单位冲突、`-s 0`/`-c 0`、`-c 2 -s 0.01` 两轮输出、真实 shell 调用、Windows 快照一致性、Windows `-l` 拒绝。
- **差分限制**：本机没有 GNU/procps 的 free 可执行，无法做逐字节差分；排版是照 4.0.4 源码移植并用合成快照锁定的。Linux CI 可补一条与系统 `free` 的对拍，目前没有。
- 性能（Windows 10.0.28000 / i7-12700H，`--profile local` 优化构建，单线程）：每次跑 1000 轮「采样 + 排版」，共 6 次；首次 42.9 ms，后 5 次中位数 **42.9 ms**（区间 41.2–46.8），约 **0.043 ms/轮**。没有参考实现可比：Windows 无 procps free，PowerShell/WMI 是另一条进程启动路径；这里只记录自身开销。
- 变异验证：把行标签宽度从 9 改成 8，`header_and_rows_follow_the_procps_layout` 立即变红（空格数不符）；恢复后转绿。

## 局限

- Windows 的 `free`、`buff/cache`、swap 都是近似值（理由见上）；需要精确值时用任务管理器或 `Get-CimInstance Win32_OperatingSystem`。
- `shared` 与 `buffers` 在 Windows 恒为 0，不是真实数据。
- 没有 gettext 本地化，表头固定英文。
- 在 Linux 上会遮住系统 `free`；语义与 procps 4 对齐，但帮助/版本字符串不同。
- `-s` 不带 `-c` 时无限循环，靠 Ctrl-C 结束（与 procps 相同）。
- **分发**：随 addon 注册，但 native 平台包/loader 尚未接线；真实 addon 用 `PI_NATIVES_DIR` 跑过 `pnpm e2e`（24/24），场景未单列 free 断言，命令由单测与真实 shell 覆盖。

## 维护

- 升上游 pin 后重跑 `pnpm vendor:apply` / `pnpm vendor:check`，确认 `Win32_System_ProcessStatus` feature 与补丁仍能应用。
- 删除条件：上游 pi-builtins 自带 free，或 Windows 的 Git Bash 开始提供可用的 `free`。
