# zstdcat

| 项 | 内容 |
|---|---|
| 一句话定位 | 解压到 stdout，等价于 `zstd -dc` |
| 实现层 | 内建命令；与 `zstd`、`unzstd` 共用一份实现（`zstdcmd.rs`） |
| 与 zstd 的差异 | 隐含 `-d` 与 `-c`（解压到 stdout，保留原文件） |
| 完整能力面 | 见 [zstd.md](./zstd.md) |
| 测试 | `cargo test -p pi-builtins zstdcmd` 覆盖（同一实现） |

## 行为

- `zstdcat file.zst` → 解压内容写到 stdout
- 也接受从 stdin 读（`cat a.zst | zstdcat`）
- 典型用法：`tar --zstd -cf - dir | zstdcat`（解包侧同理）

## 局限

与 [zstd.md](./zstd.md) 相同。