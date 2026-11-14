# zcat

| 项 | 内容 |
|---|---|
| 一句话定位 | 解压到 stdout，等价于 `gzip -dc` |
| 实现层 | 内建命令；与 `gzip`、`gunzip` **共用同一份实现**（`gzipcmd.rs`），本文件只记录该调用名的差异 |
| 接入方式 | factory 里以三个名字各注册一次：`gzip` / `gunzip` / `zcat`，运行时按 `host.name()` 切换默认行为 |
| 与 gzip 的差异 | 隐含 `-d` 与 `-c`（解压到 stdout，保留原文件） |
| 完整能力面 | 见 [gzip.md](./gzip.md) |
| 测试 | `cargo test -p pi-builtins gzipcmd` 覆盖（同一实现） |

## 为什么和 gzip 共用一个实现

同 [gunzip.md](./gunzip.md)：GNU 的 `zcat` 就是 `gzip -dc` 的别名，参数集合与 gzip 相同，只差默认值。一份实现避免三处逻辑漂移。

## 行为

- `zcat file.gz` → 解压内容写到 stdout，原文件保留
- 也接受从 stdin 读（`cat a.gz | zcat`）

## 局限

与 [gzip.md](./gzip.md) 相同。