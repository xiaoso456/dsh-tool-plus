# 模糊匹配失败语料

从本机会话日志里捞出的历史 `edit` 模糊匹配失败（`Could not find a close enough match`），
用于给匹配器做回归和调优评估。由 `analysis/extract-fuzzy-fixtures.mjs` 生成，只读会话日志。

## 两份文件

| 文件 | 内容 | 用途 |
|---|---|---|
| `fuzzy-failures-index.jsonl` | 282 条失败的全部元信息：请求的 oldText/newText、报错里的相似度与最接近原文行、路径、entry 序号 | 统计、看失败形态、挑样本 |
| `fuzzy-replay-cases.jsonl` | 47 条内容能对上的子集，带 `content`（报错行前后 150 行的窗口） | 直接回放喂给匹配器 |

字段：

- `session` / `preset` / `time` / `tool`：来源会话、预设、时间、`edit` 还是 `run_code` 里的 edit。
- `path` / `entry` / `entries` / `ambiguous`：目标文件、失败的是第几个 entry、共几个；`ambiguous` 表示源码里有多个 `tools.edit` 调用，oldText 可能对错位。
- `reported`：`similarity`（历史消息里报的百分比，不是重算的）、`line`（报错行号）、`minus`（**请求的文本**，模型以为文件里是这样）、`plus`（**文件里实际的文本**）。
- `oldText` / `newText` / `oldTextSource`：请求文本；`args` 来自调用参数（精确），`run_code-source` 从源码字面量抠出来（可能有偏差）。
- `contentSource`：`session-write`（同会话失败前最后一次 write 的全文）、`session-read`、`disk`（磁盘现文件）。
- `verified`：报错里那行最接近原文能在 content 里找到。为 `false` 说明内容不是当时的（read 返回结构摘要、文件后来被改过），这些不进 replay。
- `exactHit` / `squashedHit` / `normalizedHit`：oldText 在 content 里原样命中 / 空白折叠后命中 / 规范化后命中。
- `contentStartLine` / `windowed`：窗口起点行号，报错行号据此换算到 content 内。

## 覆盖情况

- 282 条失败：`tool-plus-standard` 113、`tool-plus-ptc` 164、`standard` 5（宿主层插件接管工具，官方预设下同样走我们的 edit）。
- 按工具：`edit` 115、`run_code` 167。
- 有精确 oldText 的 241 条（args 115 + 源码 126）；另 41 条 oldText 抠不出来，只在 index 里留元信息。
- 多 entry 失败 144 条。
- 相似度分布：0-49 有 75、50-69 有 67、70-79 有 52、80-89 有 49、90-94 有 25。真正常见的是「旧文本已经漂了」，不是差一点点空白。
- 47 条可信回放：`session-write` 20、`disk` 25、`session-read` 2；去重后 30 组（同一文件重复重试很多）。

## 已知偏差，用之前必读

1. **内容快照可能滞后**：14 条 `exactHit` 的回放里 oldText 本来就存在，说明快照落后于失败时刻（中间还有别的编辑）。做负样本时要按 `!exactHit` 过滤。
2. **真正「空白差异本该匹配」的只有 10 条**（`squashedHit && !exactHit`）。想靠放宽阈值或去空白把失败救回来，收益上限就这么大。
3. **硬样本 23 条**（`!exactHit && !squashedHit`）：区域在、请求文本已经实质性不同，是判断「该不该自动套用」的好素材。
4. `run_code` 的 oldText 是从程序源码字面量里扫出来的，多调用时按 entry 序号对位，可能有偏差（看 `ambiguous`）。
5. 相似度是历史消息里报的数，换算法后不会一致，只能当参考。

## 用法

```js
const cases = readFileSync('analysis/fixtures/fuzzy-replay-cases.jsonl', 'utf8')
  .trim().split('\n').map(JSON.parse)

// 负样本：现在拒绝，调优后也不许静默套用
const negatives = cases.filter((c) => !c.exactHit)
// 正样本：空白漂移，本就该匹配上
const positives = cases.filter((c) => c.squashedHit && !c.exactHit)
```

重新生成：

```sh
node analysis/extract-fuzzy-fixtures.mjs          # 写两份文件
node analysis/extract-fuzzy-fixtures.mjs --dry-run # 只看统计
```
