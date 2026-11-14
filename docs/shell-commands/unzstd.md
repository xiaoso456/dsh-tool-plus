# unzstd

| 项 | 内容 |
|---|---|
| 一句话定位 | 解压 `.zst`，等价于 `zstd -d` |
| 实现层 | 内建命令；与 `zstd`、`zstdcat` 共用一份实现（`zstdcmd.rs`），本文件只记录该调用名的差异 |
| 与 zstd 的差异 | 隐含 `-d`；其余参数与限制一致 |
| 完整能力面 | 见 [zstd.md](./zstd.md) |
| 测试 | `cargo test -p pi-builtins zstdcmd` 覆盖（同一实现） |

## 为什么共用一个实现

GNU zstd 也是同一可执行文件按 `argv[0]` 切换默认行为；三个名字参数集合相同，只差默认值，拆开只会让逻辑漂移。

## 局限

与 [zstd.md](./zstd.md) 相同（单帧、无字典、无多线程）。