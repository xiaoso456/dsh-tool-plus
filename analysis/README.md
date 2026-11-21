# analysis/ 会话与失败分析

调试期用的探针脚本和一次性报告都放这里，不跟 `scripts/`（发布/构建用）混。

## 文件

| 文件 | 作用 |
|---|---|
| `session-store.mjs` | **共用读取层**：多帧 zstd 解压、按会话目录选版本、读头部 `agentPreset`。三个脚本都从这里取数据，别再复制解压逻辑。 |
| `session-token-stats.mjs` | 单会话 token 结构探针（user/assistant/tool 体积、工具调用分布）。 |
| `tool-result-aggregate.mjs` | 全量聚合：默认按部署分界对比结果体积；`--failures` 按预设统计失败率、失败簇与高频特征。 |
| `reports/` | 跑出来的报告，按日期命名。 |

## 会话日志格式要点

- 路径：`$DSH_HOME/sessions/<workspace>/<session>/session[.vN].jsonl.zstd`。
- 同一会话可能同时存在 `session.jsonl.zstd`（v1）、`.v3`、`.v4`（迁移残留），**默认取版本最高那份**。
- 文件是**多 zstd 帧拼接**（魔数 `28 B5 2F FD`），必须逐帧解压；整包解压只会吐出第一帧，v1 时代每帧一条事件，直接解压就只剩头部。
- v1 的 tool/result 形如 `data.message.content[0] = {type:'tool-result', content:[...], isError}`；v4 改成 `data.message.isError` + 扁平 `content`。读取层两种情况都认。

## 常用命令

```sh
# 单个会话的 token 结构
node analysis/session-token-stats.mjs ~/.dsh/sessions/<workspace>/<session>

# 默认：官方工具 vs tool-plus 的结果体积对比
node analysis/tool-result-aggregate.mjs

# 只看我们两个预设、限定 v4 格式的失败统计
node analysis/tool-result-aggregate.mjs --failures --format v4 --preset tool-plus-standard
node analysis/tool-result-aggregate.mjs --failures --format v4 --preset tool-plus-ptc

# 最近一周、按 JSON 输出
node analysis/tool-result-aggregate.mjs --failures --since 2026-11-14 --json
```

参数：`--home`（默认 `$DSH_HOME` 或 `~/.dsh`）、`--since YYYY-MM-DD`（按文件 mtime 粗筛）、`--format v4|v3|1|all`、`--preset <名>`、`--top N`、`--json`。

## 口径与坑

- **必须按 `agentPreset` 分组**：同一条机器上官方预设和我们两个增强预设的会话混在一起，不分组会把「规则拦截」和「真实失败」的比例算歪。
- 会话是日常使用记录，不是受控实验：插件版本、工具面（直调 / PTC）都在变，结论只做方向参考。
- `--since` 用的是文件 mtime，不是事件时间；跨时区或长期未写的会话可能有偏差。
