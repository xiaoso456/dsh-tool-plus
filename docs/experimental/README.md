# 实验性功能

实验性功能的文档放这里（设计、实现落点、回退方式）。设置页「实验性」tab 常驻显示，
每个功能对应其中的一个开关，默认关闭；打开后才走对应实现，关掉立刻回到原有行为。

例外：`detailedMatchFailure` 只往报错里补信息、不改结果，默认开启，是整个 tab 里唯一默认开的项。

| 文档 | 开关 | 默认 | 状态 |
|---|---|---|---|
| [multi-edit-preflight.md](multi-edit-preflight.md) | `multiEditPreflight` | 关 | 已实现 |
| [detailed-match-failure.md](detailed-match-failure.md) | `detailedMatchFailure` | 开 | 已实现 |
