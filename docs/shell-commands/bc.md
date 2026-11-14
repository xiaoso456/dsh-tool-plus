# bc

| 项 | 内容 |
|---|---|
| 一句话定位 | 任意精度十进制计算器，脚本里做算数/进制换算 |
| 实现层 | 内建命令（brush + pi-builtins），进程内执行 |
| 上游来源 | GNU bc 1.07；**Windows 上完全缺失**（Git Bash 也不带） |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/shellcmds/bccmd.rs`（约 1300 行，含 10 个单测） |
| 接入方式 | 统一接线补丁 `patches/0001-shell-commands.patch` 的 `util.shellcmds`；在 `shellcmds.rs` 里注册 |
| 依赖 | `bigdecimal 0.4` + `num-bigint`（pi-builtins 已有依赖，本命令未引入新依赖） |
| 测试 | 13 个单测（含真实 shell 管道用例） |

## 为什么自研

`command -v bc` 在本机 brush 里为空。bc 是 shell 脚本里最常见的算数工具（`echo "scale=2; 1/3" | bc`），缺失会让一批脚本直接失败。表达式求值 + 十进制大数是可控工作量，因此自写，复用仓库里已有的 `bigdecimal`/`num-bigint`。

## 能力面

| 类别 | 支持 |
|---|---|
| 数字 | 任意精度十进制；`ibase` 2..16 输入、`obase` 2..16 输出；单字符数字 ≥ ibase 时按 GNU 规则夹到 ibase-1 |
| 运算 | `+ - * / % ^`、比较 `== != < <= > >=`、逻辑 `&& \|\| !`、括号、一元负号 |
| 变量 | 普通变量、`scale`/`ibase`/`obase` 特殊变量、复合赋值 `+= -= *= /= %= ^=` |
| 语句 | 表达式（非赋值时打印结果）、`print`（字符串 + 表达式，不换行）、字符串字面量（打印后换行）、`quit`/`halt` |
| 内置函数 | `sqrt(x)`、`length(x)`、`scale(x)`、`read()` |
| 数学库 | `-l` 提供 `s c a l e j`（sin/cos/atan/ln/exp/Bessel），并把默认 `scale` 设为 20 |
| 参数 | GNU bc 的 7 个参数全部支持：`-h/--help`、`-i/--interactive`、`-l/--mathlib`、`-q/--quiet`、`-s/--standard`、`-w/--warn`、`-v/--version`（`-V` 作为兼容别名），可跟文件 |

### 与 GNU bc 的差异

| 项 | 本实现 | GNU bc |
|---|---|---|
| `-s` 标准模式 | 部分实现：对已实现的 GNU 扩展（`print`、`read()`、`halt`）报错；未实现语法本身也不可用 | 完整 POSIX 严格子集 |
| `-w` 警告 | 部分实现：同上三类扩展输出 `warning: ... is a GNU extension` 后继续 | 全部扩展告警 |
| `define` 函数 | 报 `functions (define) are not implemented yet` 并退出 1 | 支持 |
| `if`/`while`/`for`/`break`/`continue`/`return` | 同上，可读报错 | 支持 |
| 数组 | 词法能识别 `[]`，语法阶段报未实现 | 支持 |
| 行宽 | 不按 70 列折行（GNU 用 `\` 续行） | 70 列折行 |
| 数学库精度 | 走 `f64`（约 15 位有效数字） | 任意精度内部实现 |
| `obase` 上限 | 16 | `BC_BASE_MAX`（通常 999） |
| 启动横幅 | 不打印 | 交互模式打印版本与版权 |

## 设计要点

- 词法 → 递归下降（赋值 / 或 / 与 / 比较 / 加减 / 乘除模 / 一元 / 幂 / primary），幂右结合且比一元负号紧（`-2^2 = -4`，与 GNU 一致）。
- 数值语义：加减取较大 scale；乘法 scale 相加；除法与取模按 `scale` 变量截断（向零）；幂按 `min(scale(a)*exp, max(scale, scale(a)))` 截断。
- 十进制输入直接交给 `BigDecimal` 解析（保留输入的小数位）；非十进制按 `ibase` 手工累积，分数部分以高精度除法近似。
- 输出复刻 bc 习惯：小于 1 的数省略前导零（`.33333`）。
- `parse_number` 对单字符数字做 GNU 的 `ibase-1` 夹取（`ibase=2` 时输入 `2` 得 1）。

## 测试来源

GNU bc 的测试是 `tests/` 下的 shell 脚本 + 期望输出，依赖编译好的二进制与大量特性开关，无法直接搬进 cargo 单测。这里按手册语义自写 10 条；最后一条走真实 shell（`echo '2 + 3' | bc`），覆盖 argv[0] 与管道路径。

## 测试与验证

- `cargo test -p pi-builtins bccmd` → 13 通过
- 覆盖：优先级与幂/一元、`scale` 对除法的影响、赋值静默、`ibase`/`obase` 换算、`sqrt`/`length`/`scale`、`print` 拼接、`-l` 数学库、除零错误、未实现语法报错、shell 管道、`-v` 版本、`-s` 拒绝扩展、`-w` 告警

## 局限与后续

- 语言层仍缺：`define` 函数、`if/else/while/for`、数组、`last`、70 列折行（这些是语言特性，不是命令行参数；GNU bc 的参数已经齐了）。
- `-s`/`-w` 只覆盖已实现的扩展（`print`/`read()`/`halt`），没有实现语法自然也不会被检查到。
- `scale` 上限 4096（防止误设导致长时间计算）。
- 数学库用 `f64`，超过约 15 位有效数字后与 GNU 不一致；需要高精度时改用 `BigDecimal` 级数展开。
- **真 addon 端到端已验证**（2026-11-14）：`local` 构建 → `scripts/stamp-pi-natives.mjs` 打戳 → 替换 leaf 包 `.node` → `PI_E2E_EXPECT_TREE=1 pnpm e2e`，24 项全过；步骤 1 的命令含 `echo 'obase = 16; 255' | bc`，输出里出现 `FF`
- 写 e2e 断言时踩过一次坑：`xz-ok` 与 `FF` 在结果里是连着的（`xz-okFF`），`\bFF\b` 没有词边界，改用 `xz-ok[\s\S]*FF` 才匹配。

## 维护

- 代码在 `overlay/.../shellcmds/bccmd.rs`；新增命令不需要改补丁（见 `docs/shell-commands/README.md` 第 3 步）。