# 写入重试（实验，默认开启）

## 背景

2014 个历史会话文件里，ReplaceFileW EIO 的错误码分布：

| 错误码 | 次数 | 含义 |
|---|---|---|
| 1175 | 578 | ERROR_UNABLE_TO_REMOVE_REPLACED |
| 32 | 15 | ERROR_SHARING_VIOLATION |
| 1176 | 1 | 上下文引用，不是真实失败 |
| 1177 | 0 | 没出现 |

1175 是替换时删不掉被替换文件，32 是文件被占用。两种情况下替换都没完成，原文件和临时文件都在，
原文件完好，所以重试安全。

1176/1177 是替换文件移动阶段失败，盲目重试可能丢文件，所以永远不重试。

## 两种写入后端的错误不一样

| 后端 | 错误形态 | 重试什么 | 不重试什么 |
|---|---|---|---|
| DSH 写入 | FsError，message 含 ReplaceFileW EIO (Win32 1175/32) | 1175、32 | 1176、1177、其他 FsError |
| 原生写入 | Node ErrnoException，带 code | EBUSY | EPERM、EACCES、ENOSPC 等 |

EBUSY 是 Windows 的 ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION，和 1175/32 是同一类竞争。
EPERM / EACCES 多是权限或 ACL 问题，重试只会延后报错。

## 行为

- 开关 writeRetryEnabled 默认 true；writeRetryCount 默认 3，运行时 clamp 到 0 到 10。
- 只对匹配的错误重试；其他错误立即抛出。
- 每次重试重新执行完整写入。
- 退避 50 / 150 / 400ms；超过 3 次后翻倍，封顶 1 秒。
- signal 已 abort 时不再发起下一次写；退避期间 abort，醒来后也会停止。
- 次数用尽后抛原始错误，不吞错、不改错误文案。

## 安全边界

- 只重试「失败但原文件完好」的情况。
- 不重试 1176/1177、EPERM、EACCES、ENOSPC 等。
- 不重试 resolve / policy 失败，只重试 writeText 本身。
- 原生通道重试整个 writethroughNoop；带 file 句柄时也重新调用 file.write，依赖它自身的截断语义。

## 性能

- 成功路径：matcher 不执行，只多一层 try/catch，实测 0ms。
- 失败路径：正则匹配约 20 到 30ns。
- 每次重试重写一遍（DSH 约 6 到 12ms，原生约 0.5 到 2ms）。
- 3 次全失败：约 30ms 写 + 600ms 退避，最坏约 0.63 秒。
- 典型一次 1175：多约 60ms。

## 配置

- writeRetryEnabled：默认 true。
- writeRetryCount：默认 3，0 表示不重试，最多 10。
- 设置页实验性 tab；次数只在开关打开时显示；两项都有悬浮说明。

## 实现

- src/tools/shared/atomic-write-retry.ts：错误识别、退避、writeWithRetry、abort。
- src/tools/shared/write-channel.ts：按 writeBackend 选通道，在通道里套重试。
- tests/unit/write-backend.spec.ts：1175 / 32 / 1176 / 1177、EBUSY / EPERM / EACCES、重试次数、
  abort、两种通道集成。

## 回退

关掉写入重试即可，行为回到「一次失败就报错」。原生通道仍然不会有 1175/32，但 EBUSY 会直接抛。
