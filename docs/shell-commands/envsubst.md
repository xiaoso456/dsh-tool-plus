# envsubst

| 项 | 内容 |
|---|---|
| 一句话定位 | 把 stdin 里的 `$VAR` / `${VAR}` 替换成环境变量值，可只用指定的变量集合 |
| 实现层 | 内建命令（brush + pi-builtins） |
| 上游来源 | GNU gettext 的 `envsubst`；**Windows 上完全缺失**（Git Bash 也不带），模板类脚本会直接失败 |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/envsubstcmd.rs`（约 300 行，含 7 个单测） |
| 接入方式 | `vendor/oh-my-pi/patches/0004-envsubst-integration.patch`（4 处：pi-builtins 的 Cargo.toml / lib.rs / factory.rs，pi-natives 的 feature 列表） |
| 依赖 | 无（只用标准库） |
| 测试 | 7 个单测；其中两个走真实 shell（见「测试来源」） |

## 为什么自研

`command -v envsubst` 在本机的 brush shell 里为空——Git Bash 不提供，Windows 也没有替代品。它又是模板渲染、配置生成里最常见的一行，缺失会直接卡住脚本。实现量小（变量扫描 + 替换），不需要引入第三方 crate。

## 能力面

| 参数 | 行为 |
|---|---|
| （无） | stdin → stdout，替换所有 `$VAR` 与 `${VAR}`；未设置的变量替换为空串 |
| `SHELL-FORMAT` 操作数 | 只替换在该字符串里出现过的变量，其余引用原样保留（GNU 语义） |
| `-v` / `--variables` | 不读 stdin，按出现顺序逐行输出 SHELL-FORMAT 里引用的变量名（去重） |
| `-h` / `--help` | 帮助 |
| `-V` / `--version` | 版本 |

识别的变量名规则：`[A-Za-z_][A-Za-z0-9_]*`；`$` 后面不构成变量名时原样保留（`$`、`$1`、`$-`、`${}`、`${1}`、未闭合的 `${VAR` 都不改动）。

## 与 GNU envsubst 的差异

| 项 | 本实现 | GNU gettext |
|---|---|---|
| `-v` 无 SHELL-FORMAT | 报错退出 1（`missing SHELL-FORMAT`） | 同样要求操作数 |
| 其它 | 无已知差异 | — |

## 设计要点

- 扫描器只认 `$NAME` 与 `${NAME}` 两种形式，不做 shell 展开（无引号、无 `$( )`、无默认值语法），与 GNU 一致。
- 过滤集合按 **SHELL-FORMAT 里出现的引用** 计算，因此 `$FOO` 与 `${FOO}` 被视为同一个变量。
- 环境值来自 shell 环境（`host.var`），不是进程环境，`unset` 后不会错误回退。

## 测试来源

上游 gettext 的测试是 autotest 套件（shell + 大量语言环境依赖），无法直接搬进 cargo 单测。这里按手册语义自写 7 条；其中「变量替换」「SHELL-FORMAT 过滤」两条走真实 shell（`run_script`），因为内存态测试宿主没有 shell 环境变量，这也是实现层面真实的使用路径。

## 测试与验证

- `cargo test -p pi-builtins envsubstcmd` → 7 通过
- 覆盖：普通与花括号引用、未设置变量替换为空、SHELL-FORMAT 只替换列出的变量、`-v` 去重且保序、非变量 `$` 原样保留、`-v` 缺格式串报错、未闭合 `${` 原样保留

## 局限与后续

- 不支持 `--variables` 之外的 GNU 扩展（gettext 也没有别的）
- **真 addon 端到端已验证**（2026-11-14）：`local` 构建 → `scripts/stamp-pi-natives.mjs` 打戳 → 替换 leaf 包 `.node` → `PI_E2E_EXPECT_TREE=1 pnpm e2e`，24 项全过；步骤 1 的命令含 `export PI_E2E_V=envsubst-ok; printf '$PI_E2E_V' | envsubst`，输出里出现 `envsubst-ok`

## 维护

- 升上游 pin 后重跑 `pnpm vendor:apply`，确认 0004 仍能应用
- 代码全在 `overlay/`；删除条件：上游 pi-builtins 自带 envsubst 或 Git Bash 开始提供