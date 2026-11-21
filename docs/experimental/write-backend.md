# 写入通道（实验）

## 要解决的问题

DSH 的 edit 一直走 ctx.fs.writeText，宿主在 Windows 上用临时文件 + fsync + ReplaceFileW 原子替换。
文件被其他进程占用时，ReplaceFileW 返回 1175 或 32，工具报错。

OMP 原生的 write/edit 写盘是 Bun.write（我们的适配层是 node:fs 的 writeFile），不走 ReplaceFileW，
所以不会有这个错误码，但也不是原子写。

这个实验项让用户自己选：默认 DSH 原子写，或者退回 OMP 原生直写。

## 两个通道

**DSH 写入（默认，配置值 dsh）**

- ctx.fs.resolve + 每次调用解析 sandboxPolicy + ctx.fs.writeText。
- 临时文件 + fsync + ReplaceFileW；失败时原文件完好。
- 遵守 read-only / workspace-write；有进程内锁和版本检查。
- 小文件单次约 6 到 12ms。

**原生写入（配置值 native）**

- OMP 的 writethroughNoop，node:fs 直写。
- 更快，约 0.5 到 2ms；但不是原子写，崩溃或中断可能留半截文件。
- 不经过 ctx.fs，不检查沙箱，也没有锁和版本检查。
- 不会出现 ReplaceFileW 的 1175/32。

## 后果对照

| 项目 | DSH 写入 | 原生写入 |
|---|---|---|
| 1175 / 32 | 可能遇到，写入重试默认开、3 次兜住 | 不会出现，因为不走 ReplaceFileW |
| 其他占用 | FsError（FS_IO_ERROR 等） | EBUSY / EPERM / EACCES；对方允许共享写时可能直接覆盖，不报错 |
| 原子性 | 临时文件 + fsync + 原子替换 | 原地截断再写，崩溃可能半截文件 |
| 沙箱 | 遵守 read-only / workspace-write | 完全绕过 |
| fsync / 锁 / 版本 | 有 | 无 |
| 性能（1KB 覆盖写） | 6 到 12ms | 0.5 到 2ms |
| 适用 | 默认、安全 | 追求速度、接受风险 |

## 1175 / 32 与原生写入

DSH 写入可能遇到 1175（被替换文件删不掉）和 32（文件被占用）。这两种失败时替换没完成，
原文件和临时文件都还在，原文件完好，所以可以重试。写入重试默认开，详见
[write-retry.md](write-retry.md)。

原生写入不会出现这两个错误码，因为不调 ReplaceFileW。但同样的占用会以 EBUSY / EPERM 出现；
如果占用方允许共享写，直写甚至可能直接写进去，不报错，覆盖别人的修改。这不是更安全，
是错误形态不同。

## 为什么默认 DSH

- 保留原子写、fsync、ACL 和沙箱策略。
- 1175/32 有重试兜底，不是必须靠换通道解决。
- 这是当前 edit 的行为；write 之前是直写，默认切到 DSH 正好修掉它绕过沙箱的问题。

## 实现范围

- edit 的四个模式都走同一个 writethrough，所以开关对 replace / patch / apply_patch / hashline 一起生效。
- write 的主写路径和两处 conflict:// 解析都走注入的 writethrough。
- 归档成员写入和 SQLite 行写入有各自的路径，不受这个开关影响。

## 性能

2026-11-21 本机 Windows 实测（直接用 dsh-fs-local 的 LocalFileSystem，覆盖写，交错跑，取中位）：

| 文件大小 | 直接 node:fs | DSH 写入 |
|---|---|---|
| 1KB | 0.5 到 1.0ms | 6 到 12ms |
| 64KB | 1.0 到 1.2ms | 10 到 12ms |
| 1MB | 2 到 3ms | 13 到 18ms |
| 8MB | 14ms | 60ms |

端到端 1KB：现在 write 直写约 2.3ms；DSH 写入约 11 到 13ms；官方 write 工具走同一层，
约 10 到 12ms。绝对差约 9 到 11ms 一次，批量 100 个小文件约多 1 秒。

## 设置页

实验性 tab 里三项：

- 写入通道：下拉，DSH 写入 / 原生写入，默认 DSH 写入。
- 写入重试：开关，默认开。
- 重试次数：默认 3，范围 0 到 10。

三项都有 info 图标的悬浮说明。

## 回退

把写入通道切回 DSH 写入即可，只影响后续写调用，不需要重启。

## 测试

- tests/unit/write-backend.spec.ts：两种通道的路由、policy 透传、edit / write 都生效。
- tests/unit/settings-fields.spec.ts：字段顺序、默认值、实验项都有 tipKey。
