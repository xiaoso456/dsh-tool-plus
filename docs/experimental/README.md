# 实验性功能

实验性功能的文档放这里（设计、实现落点、回退方式）。设置页「实验性」tab 常驻显示，
每个功能对应其中的一个控件，默认关闭为主；打开后才走对应实现，关掉立刻回到原有行为。

例外：`writeBackend` 默认 DSH 写入（安全路径，不是关掉功能）；`writeRetryEnabled` 和
`detailedMatchFailure` 默认开启，前者只重试可恢复的文件竞争，后者只往报错里补信息，都不改成功路径。

| 文档 | 开关 | 默认 | 状态 |
|---|---|---|---|
| [write-backend.md](write-backend.md) | `writeBackend` | DSH 写入 | 已实现 |
| [write-retry.md](write-retry.md) | `writeRetryEnabled` | 开 | 已实现 |
| [multi-edit-preflight.md](multi-edit-preflight.md) | `multiEditPreflight` | 关 | 已实现 |
| [detailed-match-failure.md](detailed-match-failure.md) | `detailedMatchFailure` | 开 | 已实现 |

## 已知限制

| 文档 | 状态 |
|---|---|
| [hashline-quote-folding.md](hashline-quote-folding.md) | 暂不支持（TS 路径已修） |
