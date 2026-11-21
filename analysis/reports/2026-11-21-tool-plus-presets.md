# 工具失败分析：tool-plus 标准 / PTC 预设（2026-11-21）

数据源：`~/.dsh/sessions`，只统计 v4 格式、`agentPreset` 为 `tool-plus-standard` 或 `tool-plus-ptc`、且确实有工具调用的会话。

命令：

```sh
node analysis/tool-result-aggregate.mjs --failures --format v4 --preset tool-plus-standard
node analysis/tool-result-aggregate.mjs --failures --format v4 --preset tool-plus-ptc
```

## 总量

| 预设 | 会话 | 调用 | 失败 | 失败率 |
|---|---|---|---|---|
| tool-plus-standard | 270 | 65,406 | 2,513 | 3.8% |
| tool-plus-ptc | 249 | 91,444 | 2,112 | 2.3% |

standard 面：bash 28,018（失败 5.9%）、read 10,401（0.8%）、edit 6,050（4.0%）、grep 4,242（1.6%）。
PTC 面几乎全走 `run_code`（88,132 次，失败 2.3%），直调工具只剩零头。

## 可优化的失败簇

| 失败簇 | standard | ptc | 合计 |
|---|---|---|---|
| edit 模糊匹配未达阈值 | 113 | 150 | 263 |
| 多段编辑半途失败 | 92 | 54 | 146 |
| bash cwd 已不存在 | 48 | 51 | 99 |
| Windows ReplaceFileW EIO | 35 | 42 | 77 |
| interceptor 拦截（改用专用工具） | 1,503 | 0 | 1,503 |

另外 standard 面 read 路径不存在 76 次、grep 路径不存在 69 次。

## 两处已复现的问题

**多段编辑不原子**：`edits[]` 第 1 段写盘成功后第 2 段失败，文件留在半改状态，且报错首行是「Successfully replaced…」。复现（仓库 `.git/` 下临时文件，已删）：

```
edits: [{aaa→AAA}, {zzz-not-there→ZZZ}]
→ 抛 ToolCallError，文件里 aaa 已变成 AAA
```

建议：先在内存里把每段（含模糊匹配）校验通过，再一次落盘；失败时明确「第 k 段失败，前面未写入」，并给出最接近的候选行。

**PTC 里的 TypeError**：290 次 `Cannot read properties of undefined (reading 'text')`，样本显示是程序对 `tools.bash(...)` 直接取 `.text`，而返回结构是 `{output:{text}}`。属程序写法错误，可在类型声明里更显眼，但不是插件 bug。

## 未纳入

- interceptor 拦截是产品策略（默认关闭，那几个 profile 打开了），不是 bug。
- PTC 面 `run_code` 的超时（163）、abort（130）、语法错误属宿主工具或程序自身问题。
