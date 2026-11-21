# 详细匹配失败提示（实验，默认开启）

## 要解决的问题

282 条模糊匹配失败里，引擎的报错只给「第一处不同行」和相似度：

```
Could not find a close enough match in app.ts.

Closest match (87% similar) at line 41:
  - const a = 1
  + const a = 2
Closest match was below the 95% similarity threshold.
```

只有一行，模型想改对就得重新 read 整个文件。这批失败的代价主要就是多一次往返。

## 目标行为（开关开启时，默认开启）

- 匹配失败且最接近的候选相似度 ≥ 80% 时，把候选整块原样附在报错末尾，用
  `<closest_match>` 包住，并说明可以直接当 `old_string`。
- 块超过 40 行或 4KB 时不附，只给起始行号并让模型重读那一段：截断的块拿回去也匹配不上，
  不如不给。
- 相似度低于 80% 不附：候选离得太远，附上只会误导。
- 有多个高置信候选时不附单块：引擎已经要求「补上下文去重」，附其中一块会暗示错的那个。
- 只改报错文本，成功路径、写盘语义、错误判定都不变。

## 为什么放实验性、为什么默认开

它改变的是模型看到的失败信息长度，不改任何结果，风险比多条目预检低。默认开是因为收益直接
（省一次 read），且开关可随时关掉。这是「实验性」tab 里唯一默认开启的项。

## 实现方式

- `src/tools/edit/adapter/match-error.ts`：纯函数。`describeClosestMatch` 判断相似度与上限、
  拼块；`withClosestMatch` 只处理 `EditMatchError`，把块接到原消息后面。
- `src/tools/edit/adapter/index.ts`：多条目 run 包装的 catch 里，开关开启就
  `throw withClosestMatch(err)`。单条编辑会原样抛到工具结果；多条会被 dispatch 捕获并用
  `err.message` 拼聚合文案，所以两条路径都覆盖。
- 不改上游 verbatim 的 `EditMatchError` / `replaceText`。
- 开关 `detailedMatchFailure` 默认 `true`。

## 性能

附块只在失败路径执行，只格式化引擎已经算好的 closest 文本，不重新读文件、不重新匹配。
成功编辑的读文件与匹配次数和开关关闭时完全一致。护栏见
`tests/unit/edit-perf-guards.spec.ts`：结构计数是硬保证，耗时上限只挡数量级回归。

2026-11-21 本机 Windows 实测（vitest 进程内，开/关交错，取中位数）：

| 场景 | 关闭 | 开启 | 差异 |
|---|---|---|---|
| 成功编辑，2000 行文件 2 条目 | 7.6ms | 7.3ms | 在噪声内，零开销 |
| 失败编辑，2000 行文件 1 条目（近似但不过阈值） | 16.4ms | 16.5ms | +0.05ms（+0.3%） |

`describeClosestMatch` 处理 40 行最大块约 2.9µs/次。失败路径本身的耗时大头是引擎的模糊搜索，
附块只占千分之几。

## 风险

- 报错变长：40 行 / 4KB 上限兜住，极端情况下仍多占一点上下文。
- 块里是文件原文，可能出现模型此前没读过的行：与 read 的可见范围一致（同一工作区），
  且只在失败时出现。
- 候选刚好过 0.8 但语义不对：文案写的是「如果这就是你要的文本」，原错误仍保留，
  模型可自行判断。

## 回退

设置页关掉开关即回到引擎原文。

## 测试

`tests/unit/edit-match-error.spec.ts`（12 条）：

- 附块内容、起始行、缩进原样；
- 相似度低于 80%、没有 closest、多个高置信候选、超 40 行、超 4KB 都不附；
- 单条与多条编辑的报错里都能看到块；
- 开关关闭时保持引擎原文；
- 非 `EditMatchError` 原样放过。
