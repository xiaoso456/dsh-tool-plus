# xzcat

| 项 | 内容 |
|---|---|
| 一句话定位 | 解压到 stdout，等价于 `xz -dc` |
| 实现层 | 内建命令；与 `xz`、`unxz` 共用一份实现（`xzcmd.rs`） |
| 与 xz 的差异 | 隐含 `-d` 与 `-c`（解压到 stdout，保留原文件） |
| 完整能力面 | 见 [xz.md](./xz.md) |
| 测试 | `cargo test -p pi-builtins xzcmd` 覆盖（同一实现） |

## 行为

- `xzcat file.xz` → 解压内容写到 stdout
- 也接受从 stdin 读（`cat a.xz | xzcat`）
- 典型用法：`tar -cJf - dir | xzcat`（解包侧同理）

## 局限

与 [xz.md](./xz.md) 相同。