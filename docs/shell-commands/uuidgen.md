# uuidgen

| 项 | 内容 |
|---|---|
| 一句话定位 | 生成 RFC 4122 / RFC 9562 UUID（v1/v3/v4/v5/v6/v7），支持命名空间、批量与十六进制名字 |
| 实现层 | 内建命令（brush + pi-builtins） |
| 上游来源 | util-linux 的 `uuidgen`；**Windows 上完全缺失**（Git Bash 也不带），脚本里生成 ID 只能靠 PowerShell 或手写随机数 |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/shellcmds/uuidgencmd.rs`（476 行，含 10 个单测 + 1 个 ignored 性能探针） |
| 接入方式 | 统一接线补丁 `vendor/oh-my-pi/patches/0001-shell-commands.patch` 提供的 `util.shellcmds` feature；本命令在 overlay 的 `shellcmds.rs` 里加一行注册 |
| 依赖 | 复用 crate 已有依赖：`rand`（随机数）、`uucore::sum`（MD5/SHA1），未新增第三方库 |
| 测试 | 10 个单测：版本位、RFC 测试向量、命名空间解析、批量/十六进制名字、错误路径、真实 shell |

## 为什么自研

`command -v uuidgen` 在 Windows 的 brush shell 里为空——Git Bash 不提供，Windows 也没有同名替代。生成数据库主键、幂等键、测试夹具、临时目录名都要用它；PowerShell 的 `[guid]::NewGuid()` 只能生成 v4，且要跨进程。UUID 的位布局是公开标准，MD5/SHA1 与随机源 crate 里已经现成，自己实现比引入一个新的 UUID crate 更直接。

## 实现规模

| 文件 | 职责 |
|---|---|
| `uuidgencmd.rs` | 参数解析、版本选择、时间戳/哈希/随机三类生成器、UUID 格式化与解析、10 个单测 |

## 能力面

| 参数 | 行为 |
|---|---|
| （无） / `-r` / `--random` | v4 随机 UUID（默认） |
| `-t` / `--time` | v1 时间戳 UUID（UUID epoch 100ns；节点为随机值并置 multicast 位，不泄露真实 MAC） |
| `-m` / `--md5` | v3 命名空间 + 名字的 MD5 |
| `-s` / `--sha1` | v5 命名空间 + 名字的 SHA1 |
| `-6` / `--time-v6` | v6（可排序的时间戳布局，RFC 9562） |
| `-7` / `--time-v7` | v7（Unix 毫秒 + 随机尾） |
| `-n` / `--namespace` | 命名空间：`@dns` / `@url` / `@oid` / `@x500`，或 32 位十六进制 UUID（可带连字符） |
| `-N` / `--name` | 名字；与 `-x` 搭配时按十六进制串解释 |
| `-C` / `--count` | 生成个数（默认 1；0 报错） |
| `-x` / `--hex` | `--name` 按十六进制解码（不是输出格式开关） |
| `-h` / `--help` | 帮助 |
| `-V` / `--version` | 版本 |

多个类型开关同时出现时，**命令行上最后一个生效**（与 util-linux 的 getopt 行为一致）。`-m`/`-s` 必须同时给 `--namespace` 与 `--name`，否则报错退出 1。

## 与 util-linux uuidgen 的差异

| 项 | 本实现 | util-linux | 说明 |
|---|---|---|---|
| v1 节点 | 每次随机 6 字节并置 multicast 位 | 优先真实 MAC，取不到时随机 | 有意不读取本机 MAC：Windows 上取 MAC 要额外依赖，且泄露硬件地址没有收益 |
| v1 clock sequence | 每次随机 | 持久化并在时钟回拨时递增 | 批量生成仍唯一（时间戳按 index 递增），但不保证跨进程单调 |
| v6/v7 时钟序列 | v6 随机；v7 毫秒 + index + 随机尾 | libuuid 维护时钟状态 | 同一毫秒内不保证严格单调，RFC 只要求“尽量单调” |
| `-C` 批量 | 时间型按 index 递增时间戳 | 逐个调用生成 | 输出均为合法 UUID |
| 其它 | 无已知差异 | — | 输出小写、带连字符，与参考实现相同 |

## 设计要点

- 生成器只产出 16 字节，版本/变体位在最后一层统一写入，避免各版本各自拼位。
- v3/v5 直接调用 `uucore::sum` 的 `Md5`/`Sha1`；SHA1 先写入 20 字节再截断 16 字节，不用手写哈希。
- 随机源用 `rand::rng()`（操作系统熵），不是时间种子 PRNG。
- 命名空间解析先认四个别名，再按“去掉连字符后必须 32 位十六进制”校验，报错信息不区分大小写。

## 测试与验证

- `cargo test -p pi-builtins uuidgencmd` → 10 通过。
- RFC 4122 附录 C 向量：v3 DNS `www.example.com` → `5df41881-3aed-3515-88a7-2f4a814cf09e`；v5 → `2ed6657d-e927-568b-95e1-2665a8aea6a2`。
- 覆盖：默认 v4 的版本位/变体位、每个类型开关、最后开关生效、别名与 UUID 字面量命名空间、`-x` 十六进制名字、`-C 3` 行数、`-C 0` 报错、缺 namespace/name 报错、真实 shell 管道。
- 性能基线（`--profile local`，Windows 10.0.28000 / i7-12700H，单线程）：10 万个 v4 中位数 **1.67 ms**、10 万个 v7 中位数 **14.80 ms**（6 次运行去掉首次后取中位数，含格式化与字符串分配）。没有和 util-linux 对比：参考实现一次进程只生成一个，进程启动成本会淹没生成成本；内建路径本来就没有进程启动。
- 真实 addon：随 `pi-builtins` 一起编进 `pi_natives`，本轮用 `PI_NATIVES_DIR` 通道跑过 `pnpm e2e`（24/24 全过）；e2e 场景未单列 uuidgen 断言，命令注册由 `shellcmds` 单测与真实 shell 用例覆盖。

## 局限

- v1 不使用真实 MAC，v6/v7 不维护跨进程时钟状态——需要严格单调 UUID 的场合应使用数据库序列或 ULID。
- 没有实现 `--verbose` 等 util-linux 之外的新选项；当前 util-linux 2.41 的 uuidgen 选项已全覆盖。
- 未实现交互式 REPL（uuidgen 本来也没有）。

## 维护

- 升上游 pin 后重跑 `pnpm vendor:apply` 与 `pnpm vendor:check`，确认聚合补丁仍能应用。
- 删除条件：上游 pi-builtins 自带 uuidgen，或 Windows 的 shell 环境开始提供可用的 `uuidgen`。
