# bc

| 项 | 内容 |
|---|---|
| 一句话定位 | 任意精度十进制计算器，脚本里做算数/进制换算 |
| 实现层 | 内建命令（brush + pi-builtins），进程内执行 |
| 上游来源 | GNU bc 1.07.1（Windows 上完全缺失，Git Bash 也不带） |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/shellcmds/bccmd.rs`（约 3000 行，含 48 个单测 + 1 个 ignored 性能探针） |
| 接入方式 | 统一接线补丁 `patches/0001-shell-commands.patch` 的 `util.shellcmds`；在 `shellcmds.rs` 里注册 |
| 依赖 | `bigdecimal 0.4` + `num-bigint`（pi-builtins 已有依赖，本命令未引入新依赖） |
| 测试 | 48 个单测（语法/语义/错误恢复/环境变量/管道 + 真实 shell） |

## 为什么自研

`command -v bc` 在本机 brush 里为空。bc 是 shell 脚本里最常见的算数工具（`echo "scale=2; 1/3" | bc`），缺失会让一批脚本直接失败。表达式求值 + 十进制大数是可控工作量，因此自写，复用仓库里已有的 `bigdecimal`/`num-bigint`。

## 能力面

| 类别 | 支持 |
|---|---|
| 数字 | 任意精度十进制；`ibase` 2..16（`-s`）或 2..36（GNU 扩展）；`obase` 2..2147483647；非十进制输出按 GNU 的多字符数字格式（每位十进制数、空格分隔、宽度取 `obase-1` 的位数）；整个数字只有一位整数位时即使大于等于 ibase 也按原值读取，多位数则每一位（含首位）夹到 ibase-1 |
| 运算 | `+ - * / % ^`、比较 `== != < <= > >=`、逻辑 `&& \|\| !`、括号、一元负号、前后缀 `++`/`--` |
| 变量 | 普通变量、`scale`/`ibase`/`obase`/`last` 特殊变量、复合赋值 `+= -= *= /= %= ^=`；给特殊变量赋值时向零截断再夹取（scale 0..1000000、ibase 2..16 或 2..36、obase 2..2147483647），越界打 `Runtime warning` |
| 语句 | 表达式（非赋值时打印结果）、`print`（字符串 + 表达式，不换行）、字符串字面量（打印后换行）、`quit`/`halt`、`limits`、`warranty`、复合语句 `{ ... }` |
| 字符串 | 转义 `\a \b \f \n \q \r \t \\`；其他反斜杠组合按 GNU 规则连字符一起忽略 |
| 流程控制 | `if (expr) stmt [else stmt]`、`while (expr) stmt`、`for ([expr]; [expr]; [expr]) stmt`、`break`、`continue`（只允许在循环内） |
| 函数 | `define [void] name(params) { auto a, b[]; ... }`、`return`/`return (expr)`、递归（上限 1000 层）、动态作用域、`auto` 遮蔽并恢复全局 |
| 函数参数 | 标量按值；数组 `x[]` 按值拷贝；`*x[]` 按变量传引用（写入穿透到调用方）；函数内常量用进入函数时的 `ibase`（POSIX） |
| 数组 | `name[expr]`，下标向零截断并限制在 0..65535；未赋值元素为 0 |
| 内置函数 | `sqrt(x)`、`length(x)`、`scale(x)`、`read()` |
| 数学库 | `-l` 提供 `s c a l e j`（sin/cos/atan/ln/exp/Bessel），并把默认 `scale` 设为 20；结果按当前 `scale` 截断 |
| 参数 | GNU bc 的 7 个参数全部支持：`-h/--help`、`-i/--interactive`、`-l/--mathlib`、`-q/--quiet`、`-s/--standard`、`-w/--warn`、`-v/--version`（`-V` 作为兼容别名），可跟文件 |
| 环境变量 | `BC_ENV_ARGS`（只识别 `-l/-q/-s/-w` 与长选项，其中的文件参数不处理）、`POSIXLY_CORRECT`（等同 `-s`）、`BC_LINE_LENGTH`（默认 70，0 关闭折行，<3 按 70） |

## 错误与告警行为

逐语句解析、执行（GNU 的 execution block 模型）：

- **运行期错误**：打印 `Runtime error (func=<函数名\|(main)>, adr=0): <消息>`，放弃当前语句，继续执行后面的语句；进程退出码仍是 0（GNU 同样如此）。
- **语法错误**：打印 `<program> <line>: <消息>`，跳过到下一个换行/分号后继续；退出码 0。
- **非法字节**：每个字节一条 `<program> <line>: illegal character: X`，跳过该 Token，语句随之报错并恢复；退出码 0。
- **标准模式（`-s` / `POSIXLY_CORRECT`）**：扩展打印 `<program> <line>: Error: <feature>`，并跳过**整行**（GNU 的 execution block 语义），后面的行继续执行。
- **告警模式（`-w`）**：扩展打印 `<program> <line>: (Warning) <feature>`，语句照常执行。
- 已覆盖的扩展项：`print`、`halt`、`continue`、`else`、`void`、`*array` 参数、`read()`、`last`、多字母名、比较出现在表达式/下标/实参/return/for 首尾表达式、`\|\|`、`&&`、`!`、不带括号的 `return expr`、空 for 表达式。
- `ibase` 超过 16（非标准）在 `-w` 下额外告警 `ibase larger than 16 is non-standard`；`ibase`/`obase`/`scale` 越界、除零、负数开方等按 GNU 打 `Runtime warning/error`。
- 程序来自文件时诊断前缀是文件名，来自 stdin 时是 `(standard_in)`。

## 与 GNU bc 1.07.1 的差异

| 项 | 本实现 | GNU bc |
|---|---|---|
| 交互式 REPL | 无：一次读完后执行；`-i` 被接受但无效果；不打印启动横幅 | 逐行读取/求值，交互模式回显提示符与横幅 |
| 输出时序 | 整个程序执行完才写 stdout；诊断先于 stdout 一次性写 stderr | 边执行边输出，stdout/stderr 按发生顺序交错 |
| 数学库精度 | `f64`（约 15–16 位有效数字），超出部分按 `scale` 补齐零 | 任意精度内部实现 |
| 递归上限 | 1000 层 | 不设显式上限（受内存限制） |
| `scale` 上限 | 1,000,000（资源保护） | `BC_SCALE_MAX = INT_MAX` |
| `BC_ENV_ARGS` | 只识别选项；其中的文件、`-v`/`-h` 不处理 | 与命令行参数同等处理（含文件） |
| `read()` 的数据源 | 程序来自 stdin 时恒返回 0；来自文件时启动即把 stdin 读进内存再逐行取 | 从同一个 stdin 流按需读取 |
| `random()` / `history` | 未实现：`random()` 报未定义函数，`history` 当普通变量（0） | 1.07 扩展：`random()` 返回伪随机数，`history` 返回历史条数（无 readline 时为 -1） |
| `%` 的极端 scale | 按 `左 - trunc(左/右)*右`，结果按 `scale` 截断 | 内部实现细节可能不同 |
| 数组维度上限 | 65535 | 手册/1.06 是 65535，1.07 源码编译期常量是 16777215 |
| 未闭合字符串/注释 | 整个程序停止（剩余内容本就在字符串/注释里） | 扫到 EOF 报错，效果相同 |

## 设计要点

- 词法 → 递归下降（赋值 / 或 / 与 / 比较 / 加减 / 乘除模 / 一元 / 幂 / postfix / primary），幂右结合且比一元负号紧（`-2^2 = -4`，与 GNU 一致）；数字字母只接受 `0-9A-Z`（GNU 的 DIGIT 定义），标识符只接受小写字母开头。
- 解释循环是「解析一条语句 → 执行 → 再解析下一条」：`quit`/`halt` 之后的内容不会被执行；解析错误按 yacc 的 `error ENDOFLINE` 方式恢复到下一个换行/分号；标准模式的扩展错误按 execution block 跳过整行。
- 数值语义：加减取较大 scale；乘法 scale 相加；除法与取模按 `scale` 变量截断（向零）；幂按 `min(scale(a)*exp, max(scale, scale(a)))` 截断。
- 非十进制常量按 GNU `push_constant` 的规则转换：单个整数位原样保留，其余位夹到 `ibase-1`；小数部分按 `数字个数` 位截断（`.B` 在 ibase=16 下是 `.6`，不是精确的 `.6875`）。
- 输出复刻 bc 习惯：小于 1 的数省略前导零（`.33333`）；obase>16 时每位十进制数字零填充到 `obase-1` 的宽度、空格分隔；`last` 记录最后一次打印的数值；`BC_LINE_LENGTH` 的折行在 `emit` 里统一处理（数字折行加反斜杠，`-s` 下字符串不折）。
- 函数调用按 POSIX：进入函数时捕获当时的 `ibase`，函数体内的常量用捕获值转换；`auto`/参数保存旧值，返回时按逆序恢复。数组参数 `*x[]` 用别名表实现，每帧局部数组阻断向外的别名查找。
- 递归在独立线程上跑（栈 32 MiB，帧上限 1000），输出与诊断缓冲在 `Machine` 里，结束后写回宿主。

## 上游测试脚本验证

GNU bc 1.07.1 的 `Test/` 脚本已下载到 `docs/draft/upstream/bc-1.07.1/`（`docs/*` 被 gitignore，不随仓库发布）。逐个跑过：

| 脚本 | 结果 | 备注 |
|---|---|---|
| `array.b`、`arrayp.b`、`aryprm.b` | 通过 | 数组、数组参数、`*array` 写回 |
| `div.b`、`fact.b`、`mul.b`、`raise.b` | 通过 | 见下方性能表 |
| `sqrt.b`、`sqrt1.b`、`sqrt2.b` | 通过 | `sqrt.b` 的 22.3383079036886766608314514… 与 GNU 输出一致 |
| `exp.b`、`ln.b`、`atan.b`、`sine.b`、`jn.b` | 通过（无报错） | 受 `f64` 精度限制，高位数字不可靠 |
| `checklib.b` | 0 failures | 各 scale 下 `e/l/s/a/j` 自洽性检查；只证明跨 scale 一致，不证明高位精度 |
| `BUG.bc` | 通过 | 16 进制除法/取模回归 |

这些脚本不进 CI（依赖本地下载的 GPL 测试数据）；CI 只跑单测。

## 性能

环境：Windows，本仓库 `cargo build --profile local` 优化构建；对照 GnuWin32 GNU bc 1.06。每个脚本跑 3 次取中位数；本实现只计 `run()` 的壁钟时间，GNU 计整个进程（含启动，约 10–20 ms 的固定开销）。

| 脚本 | 内容 | 本实现 | GNU bc | 比值 |
|---|---|---|---|---|
| `div.b` | 10 万次 scale=20 除法 | 452 ms | 178 ms | 2.54× |
| `mul.b` | 约 200 万次乘法 | 2034 ms | 2226 ms | 0.91× |
| `fact.b` | 599! 递归 | 630 ms | 656 ms | 0.96× |
| `raise.b` | 大批量幂运算 | 5 ms | 581 ms | 0.01× |
| `sqrt.b` | 4 个 scale 下各 499 次开方 | 175 ms | 102 ms | 1.72× |

结论：除法与开方慢 1.5–2.5 倍（`BigDecimal` 除法/牛顿迭代的实现差异），乘法与阶乘基本持平；幂运算因用二进制快速幂，比 GNU 的线性连乘快两个数量级。日常脚本里 bc 的调用多是几十次运算，这点差距不可感知。

## 测试与验证

- `cargo test -p pi-builtins bccmd` → 48 通过，1 个 ignored 性能探针。
- 覆盖：优先级与幂/一元、`scale` 对除法的影响、赋值静默、`(a=1)` 打印、`ibase`/`obase` 换算（含 36 进制、单 digit 夹取、非十进制小数位数）、`sqrt`/`length`/`scale`、`print` 拼接、`-l` 数学库、除零/负数开方错误恢复、shell 管道、`-v` 版本、`-s` 整行跳过、`-w` 告警、`BC_ENV_ARGS`/`POSIXLY_CORRECT`、`BC_LINE_LENGTH`、`if/else/while/for`、`break`/`continue`、递归与 `return`、`auto` 与动态作用域、数组与 `*array` 参数、数组下标截断/越界、`void` 函数、前后缀 `++`/`--`、字符串转义、`read()`（文件模式）、深递归（`length(100!) = 158`）、`last` 赋值、`quit` 后内容不再执行、`limits`/`warranty`、非法字节逐字符报错并继续。
- 差分校准：用 GnuWin32 GNU bc 1.06 对拍过 40+ 个手写用例（括号、进制、夹取、折行、错误恢复、多字符数字、小数位数等）；`ibase > 16` 是 1.07 新增行为，1.06 会夹到 16，这部分按 1.07 源码实现、无本地对照。
- **真 addon 端到端已验证**（2026-11-14）：`local` 构建 → `scripts/stamp-pi-natives.mjs` 打戳 → 替换 leaf 包 `.node` → `PI_E2E_EXPECT_TREE=1 pnpm e2e`，24 项全过；步骤 1 的命令含 `echo 'obase = 16; 255' | bc`，输出里出现 `FF`。
- 写 e2e 断言时踩过一次坑：`xz-ok` 与 `FF` 在结果里是连着的（`xz-okFF`），`\bFF\b` 没有词边界，改用 `xz-ok[\s\S]*FF` 才匹配。

## 局限与后续

- 没有交互式 REPL：`bc` 作为内建命令通常接管道，这一点影响不大；但直接连终端时不会逐行回显。
- 数学库是 `f64` 近似，`scale` 超过约 15 位后与 GNU 不一致；要真正对齐需要把 `e/l/s/a/j` 改成 `BigDecimal` 级数。
- `random()`、`history` 等 1.07 扩展未做；`%` 在极端 scale 组合下可能与 GNU 的实现细节不同。
- 输出/诊断是缓冲的，与 GNU 的流式交错输出不同。

## 维护

- 代码在 `overlay/.../shellcmds/bccmd.rs`；新增命令不需要改补丁（见 `docs/shell-commands/README.md` 第 3 步）。
