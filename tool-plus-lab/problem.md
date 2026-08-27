# tool-plus 真机实测问题记录（tool-plus-lab / 2026-08-27）

> 环境：当前 DSH 会话已挂 @xiaoso/dsh-tool-plus 最新预设（read/write/edit/grep/glob/ast_edit/bash 全家桶）；
> 运行时报告的文件策略为 danger-full-access。以下按功能记录实测发现的问题与残留面。

## P1（已修复，方案A）edit replace 模式被宿主沙箱误拦；patch/hashline 模式反而绕过沙箱

- **现象（修复前）**：
  - `old_string/new_string` 与多段 `edits[]`（replace 模式）一律报
    `cannot write "...": file access denied under workspace-write mode`
  - `patch` 参数（unified diff）反而成功（notes.txt 实测改写生效）
- **根因**：
  - `omp/edit/modes/replace.ts:1153` 调 writethrough 不传 `file` → 适配层走
    `ctx.fs.writeText(target, content, undefined, signal)`——**第5参 per-call sandboxPolicy 缺失**
    → 宿主 `@deepseek-ai/dsh-fs-sandbox` 落部署回退 workspace-write → `FS_SANDBOX_DENIED`；
  - patch/hashline 引擎调 writethrough 时传 `file` 句柄 → 适配层走 `file.write()` OMP 直写 → 绕过栅栏。
- **修复（方案A，2026-08-27 用户拍板执行）**：
  - 新增 `src/tools/shared/sandbox-policy.ts`：`resolveSandboxPolicy(ctx, exec)`（官方 tool-fs 语义，
    `ctx.fs.sandboxMode` 能力事实 + `sandboxPolicy.resolve({session})`，缺服务优雅降级）；
  - `src/tools/edit/adapter/index.ts` createWritethrough：忽略 file 句柄 + policy 作 writeText 第5参；
  - 单测 `tests/unit/edit-sandbox-policy.spec.ts` 6 条；tsc 0 错 / 406 测试全绿 / build 7.25MB，未 commit。
- **生效条件**：重启会话 / 3081 profile 加载新 dist 后 replace 恢复；修复后回归 fuzzy/notebook/hashline（P4）。

## P5（残留清单，未修）沙箱策略绕过通道全量盘点（2026-08-27 补）

> 方案A只收敛了 edit 四模式的写通道。以下通道仍**直接走 node fs / Bun 直写工作区文件**，
> 宿主文件策略（read-only / workspace-write）对它们不生效。danger-full-access 会话无实感差异；
> 收敛共同障碍：WriteTool 的 writethrough 在 verbatim 构造器硬编码（write.ts:493），无注入点，
> 且宿主 ctx.fs 缝只暴露 writeText/editText（**无 delete/rename API**），删/移类操作无法原样收敛。

| # | 功能 | 位置 | 直写形式 | 严重度 |
|---|---|---|---|---|
| R1 | write 常规文件写 | `omp/tools/write.ts:493`（构造器硬编码 writethroughNoop）→ `writethrough.ts writeFileUtf8`（含 ENOENT 建父目录） | node fs writeFile+mkdir | 高（write 主通道） |
| R2 | conflict:// 写回（单个+批量） | `omp/tools/write.ts:751 / :929` 直调 writethroughNoop | node fs | 高 |
| R3 | SQLite 表/行写入 | `write.ts #writeSqliteRow`（node:sqlite 改库文件） | node:sqlite | 中 |
| R4 | 归档成员写入（zip/tgz 重写） | `omp/utils/zip.ts:1660/:1668`（Bun.write / Bun.Archive.write） | Bun | 中 |
| R5 | hashline MV（移动/改名） | `omp/edit/hashline/filesystem.ts:130-134`（Bun.write + fs.rename/rm） | Bun+node fs | 中 |
| R6 | patch/apply_patch 删除文件 | `patch.ts:1727`（LspFileSystem.delete → Bun unlink）；另 patch.ts:117-125 还有一个直写 FileSystem 字面量（Bun.write/unlink/mkdir），envelope 路径是否引用待核实 | Bun/node fs | 中 |
| R7 | patch create/rename 建父目录 | `patch.ts:1730`（LspFileSystem.mkdir → node fs.mkdir） | node fs | 低（文件写已被 policy 拦，仅空目录可越界） |
| R8 | write shebang 自动 chmod | `omp/tools/write.ts:353`（fs.chmod） | node fs | 低（mode 位变更） |
| R9 | ast_edit 预览落盘（xdev 设备通道） | 拍板#19 保留的 resolution/report_issue 设备；实测中 ast_edit 在 fallback-deny 条件下仍成功落盘=自证绕过 | node fs（具体写入点待收敛时核实） | 高（写工具语义） |

- **不属残留（判定备忘）**：grep 归档探针 scratch、markit/fetch/scraper 缓存、bash spill 流式落盘
  全在平台临时目录（workspace-write 本就放行 temp roots）；tools-manager.ts chmod 755 是基础设施安装路径，非模型可控变异面。
- **收敛方向备忘（待拍板，未动）**：
  - R1/R2：给 WriteTool 构造器加可选 writethrough 注入（动 verbatim 一行，符合拍板#17"最小衔接"），适配层传 ctx.fs 版；
  - R3/R4：写前过 resolveSandboxPolicy 包含性检查再执行（或同样注入通道，视宿主缝能力）；
  - R5/R6：宿主 ctx.fs 无 delete/rename API——先自查 policy 包含性（isPathUnder 同款判定）再直连，违规抛 FS_SANDBOX_DENIED 同形错误；
  - R9：ast_edit 落盘点接同一 resolveSandboxPolicy 检查。

## P2（已定性：原版语义，非缺陷）read `:N-M` 选择器带上下文扩展

- refs `read-format.ts:259-260` `RANGE_LEADING_CONTEXT_LINES=1 / RANGE_TRAILING_CONTEXT_LINES=3`，
  `:raw` 不扩——实测与原版语义一致。无需修复，语义备忘。

## P3（已定性：原版语义，非缺陷）SQLite 写入仅接受单行 JSON 对象

- refs `write.ts:786-787` 一字不差。多行插入拆多次调用即可（`table:key` 更新通道正常）。

## P4（2026-08-27 重启后回归：除 hashline 外全部通过）

- ✅ replace 模式恢复（notes.txt 实测改写生效，不再报 access denied）
- ✅ 10 级模糊匹配：messy.txt 不规则空格+tab 容错命中，落盘验证 NORMALIZED/converted 实际生效
- ✅ apply_patch 信封（`*** Begin Patch` input 形态）走 ctx.fs 生效
- ✅ notebook 结构化编辑（cell 源码改写成功）
- ✅ auto-generated 守卫：gen/query.sql.go（伪 sqlc 文件名）真实放行——非自动生成文件正常可编辑，无误伤
- ✅ 唯一性守卫：多命中报 Found N occurrences + 上下文展示拒绝；replace_all:true 全部替换
- ⏳ hashline 模式 live 实测仍待切 editMode 配置（写通道已同源收敛，预期无差异）
- 🐛 顺手修：适配层 replace 计数取 details.replacements（引擎无此字段）→ 改从 resultText 回解（tsc 0/406 全绿/build 完成未 commit）

---
### 实测通过项备忘
write：自动建目录/shebang chmod(+x)/zip+tgz 成员写入/SQLite 单行插入+主键更新/空文件；
read：行选择器(含raw)/结构摘要折叠(663行文件)/notebook 结构化/conflict 检测+`conflict://N/theirs` 单侧读+`@ours` 写回/
SQLite(表limit/行key/q=SQL)/PDF 文本抽取(#18 后形态)/长行2000字符截断/URL 读取(native fetch→markdown)；
grep：case:false/gitignore 排除/非法正则字面回退/跨行字面量(\n)/zip 成员内搜索；
glob：裸*目录分组树/无斜杠基名匹配/mtime 排序/hidden+gitignore 参数面；
ast_edit：AST 结构化改写真实落盘；read_image：PNG 多模态读入；
bash：3000行截断+spill 落盘/run_in_background 后台任务/job 生命周期/拦截器(grep|rg→grep 工具引导)。

### 夹具清单（tool-plus-lab/）
notes.txt、dup.txt(唯一性守卫)、messy.txt(fuzzy)、conflicted.txt(#1 未解决)、notebook.ipynb、
sample.ts(ast_edit 已改写)、big-sample.ts(663行摘要)、longline.txt、sample.pdf、color-patch.png、
lab.zip、lab.tgz、lab.sqlite(users 3行+tags空)、gen/query.sql.go、.gitignore+secret.env、empty.txt、
nested/deep/dir/auto-created.txt、scripts/hello.sh、problem.md(本文件)。
