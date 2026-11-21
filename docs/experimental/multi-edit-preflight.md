# 多 entry 编辑预检（实验）

## 要解决的问题

282 条历史模糊匹配失败里，144 条（51%）发生在一次提交多个条目的 `edit` 调用里。现在的链路是
`src/tools/edit/adapter/index.ts` 把每个条目包成一个 run 交给 `executeSinglePathEntries`，每条
`executeReplace` 都真的写盘。于是第 2 条失败时，第 1 条已经落到文件里：

```
Successfully replaced text in app.ts.
Error editing app.ts (entry 2 of 2): Could not find a close enough match in app.ts.
Entry 1 was already applied.
```

模型看到这个结果，既不知道文件现在是什么状态，也不知道该把第 2 条改成什么，只能重新读一遍文件。
144 条里每一条都留下一个「改了一半」的文件。

## 目标行为（仅在开关开启时）

一次多 entry 调用要么全部应用，要么一个都不写：

- 任何一条预检失败，文件保持原样，错误里列出所有失败条目（序号、行号、相似度、文件里最接近的内容）。
- 全部通过，才走现有写盘流程，结果与今天一致。
- 错误信息里不再出现 `Entry N was already applied`。

## 为什么放实验性

这是行为语义变更，不只是文案或性能优化：上游 `executeSinglePathEntries` 是逐条应用逐条写盘
（`src/tools/omp/edit/dispatch.ts` 头部注明算法与文案逐字对齐 17.3.5），改成「先预检后写」在
失败场景下与上游不同。因此默认关闭，放在设置页「实验性」tab，由用户显式开启。

## 实现方式

只在 replace 模式下做（144 条失败全部来自 replace，默认编辑模式也是 replace）。

1. `adapter/index.ts` 的多 entry 分支（`editsInput.map` 那段）在调用 `executeSinglePathEntries`
   之前插入预检：
   - 读一次目标文件内容；
   - 按顺序对每条调用纯函数 `replaceText(content, oldText, newText, { fuzzy, all })`，用返回值里的新内容
     继续下一条，保证「第 2 条依赖第 1 条改完的文本」也能预检；
   - 某条返回 `count === 0` 时，用 `findMatch` 取 `closest`，收集失败项；
   - 有失败项：抛聚合错误，不写盘；错误里逐条列出失败条目与 closest 块；
   - 全部通过：照常走原有流程。
2. 开关 `multiEditPreflight` 默认 `false`。关闭时这条分支完全不存在，行为与今天一致。

## 设置页实验性 tab

设置页是表驱动的，不需要新的宿主扩展点：

- `src/config/fields.ts`：`ToolPlusToolId` 加 `experimental`；`TOOL_PLUS_TABS` 末尾加一个 tab；
  `TOOL_PLUS_FIELDS` 加 `multiEditPreflight`（boolean，默认 false）；`TOOL_PLUS_GROUP_LABELS`
  加分组标题。
- `src/config/settings.ts`：`Config` 加字段、`RuntimeConfig` 加字段、`resolveConfig` 映射。
- `src/client/locales.ts`：tab 名、分组名、开关名与说明（中英各一份）。
- 渲染由现有 `ToolPlusSection` 按表自动完成，不用改布局代码。

开关值在适配层可直接从 RuntimeConfig 读（`buildSession` 里已有 `cfg`），不走 OMP 键映射。

## 性能

2026-11-21 本机 Windows 实测（vitest 进程内，开/关交错，取中位数）：

| 场景 | 关闭 | 开启 | 差异 |
|---|---|---|---|
| 4 条目精确匹配，200 行 | 3.2-4.4ms | 4.7-5.8ms | +1.4-1.5ms |
| 4 条目精确匹配，2000 行 | 11.8-19.4ms | 13.5-20.7ms | +1.3-1.6ms |
| 4 条目精确匹配，20000 行 | 104-127ms | 110-134ms | +6.1ms |
| 2 条目含 1 条模糊命中，500 行 | 8.9-10.6ms | 12.0-15.3ms | +3.1-4.8ms |
| 第 2 条失败，2000 行 | 14.2-14.8ms | 10.1-11.0ms | 快 3.8-4.1ms，且文件原样 |

预检的成本就是「一次额外读文件 + 每条目一次内存匹配」，所以精确匹配的绝对开销在毫秒级；
模糊命中会把同一次模糊搜索再跑一遍，这是开启后最贵的情况。失败路径反而更快：预检在读一次之后
就中止，不做任何写盘和 diff。百分比在小文件上看着大，绝对成本都是毫秒级。

结构护栏见 `tests/unit/edit-perf-guards.spec.ts`。

## 风险

- 多 entry 调用会多跑一遍匹配，只在条目数 ≥ 2 时发生，单条编辑不受影响。
- 预检与真正写盘之间存在时间窗，期间文件被外部改动时预检结果可能失效；现有读后改守卫与快照校验兜底。
- 与上游 partial-apply 语义不同，仅开关开启时生效。
- 预检只覆盖匹配，不覆盖写盘阶段的 IO 失败；那种情况下仍可能只写成一部分。

## 回退

关掉开关即回到现有逐条应用逐条写盘的行为，不需要回滚版本。

## 测试

- 第二条失败：文件内容不变，错误列出第 2 条，且没有 `already applied`。
- 第二条依赖第一条的新文本：预检通过，最终文件与今天的结果一致。
- 全部合法：最终内容与关闭开关时完全一致。
- 单条编辑：开关开与关行为一致。
- 开关关闭：错误信息与今天逐字一致（防止默认路径被改动）。
- 性能护栏：关闭时零额外开销；开启时恰好只多一次读文件、每条目多一次内存匹配
  （`tests/unit/edit-perf-guards.spec.ts`，结构计数加宽松耗时上限）。

## 实现落点（2026-11-21）

- 开关与 tab：`src/config/fields.ts`（`ToolPlusToolId` 加 `experimental`、tab 表末尾加一项、
  `TOOL_PLUS_FIELDS` 加 `multiEditPreflight`、分组标题），`src/config/settings.ts`
  （`Config` / `RuntimeConfig` / `resolveConfig`），`src/client/locales.ts`（中英文案）。
  tab 常驻显示，开关默认 `false`。
- 预检：`src/tools/edit/adapter/preflight.ts` 是纯函数层（内存里按顺序试算、失败归类、
  聚合报错），`src/tools/edit/adapter/index.ts` 的多条目分支在写盘前调用，
  条件为 `cfg.multiEditPreflight && editsInput.length > 1`。
- 比设计多做的两处：条目替换后内容不变、`old_string` 为空，也在预检阶段拦下，
  免得这两类错误等到写到一半才出现。其余失败文案沿用引擎原文（多命中、相似度）。
- 测试：`tests/unit/edit-preflight.spec.ts`（纯函数 + 开关开/关的 adapter 行为），
  `tests/unit/settings-fields.spec.ts` 钉住「实验性 tab 在末尾、开关默认关」。
