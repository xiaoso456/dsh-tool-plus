# gunzip

| 项 | 内容 |
|---|---|
| 一句话定位 | 解压 `.gz`，等价于 `gzip -d` |
| 实现层 | 内建命令；与 `gzip`、`zcat` **共用同一份实现**（`gzipcmd.rs`），本文件只记录该调用名的差异 |
| 接入方式 | factory 里以三个名字各注册一次：`gzip` / `gunzip` / `zcat`，运行时按 `host.name()` 切换默认行为 |
| 与 gzip 的差异 | 隐含 `-d`（解压）；其余参数与限制完全一致 |
| 完整能力面 | 见 [gzip.md](./gzip.md) |
| 测试 | `cargo test -p pi-builtins gzipcmd` 覆盖（同一实现） |

## 为什么和 gzip 共用一个实现

GNU gzip 本身就是一个二进制带三个名字：`gunzip` 是脚本包装、`zcat` 是 `gzip -dc` 的别名。三个名字的参数集合完全相同，只有默认真假值不同。拆成三份代码会让三处逻辑漂移（改一个忘了另一个），所以这里沿用上游的做法：一份实现、三个注册名。

## 行为

- `gunzip file.gz` → 解压为 `file`，删除原 `.gz`（除非 `-k`）
- 目标已存在时拒绝覆盖，除非 `-f`
- `.tgz` 会解成 `.tar`

## 局限

与 [gzip.md](./gzip.md) 的局限相同；`-a` `-L` `--rsyncable` `--synchronous` 明确拒绝并给原因。