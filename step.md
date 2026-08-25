# dsh-tool-plus 移植步骤记录（step.md）

> 目标：按 plan.md 规划，把 OMP 原版工具（read/write/edit/grep/glob/read-image/hashline/shared）整体复制并适配为 DSH 插件 `tool-plus`。
> 原则：不篡改算法、不简化；先整包复制再减法适配；适配部分集中在 `src/tools/shared/` 与各工具 `index.ts`，不动 `_raw_omp` 原样副本；Bun 特殊语法留到最后做兼容并在此记录。

## 步骤清单

- [x] 0. 恢复上一会话 stash 中的 tool-plus 源码（src/tools/ 229 文件 + 新 index.ts/settings.ts/truncate.ts）
- [x] 1. 迁移 bash-runtime → src/tools/bash/，删除旧目录，更新测试导入路径
- [x] 2. 验证 src/tools/ 各工具文件完整性与依赖（read/write/edit/grep/glob/read-image/ast-edit/hashline/shared）
- [x] 3. 构建 + 类型检查（pnpm build / typecheck），修复编译错误
- [x] 4. 单元测试全绿（pnpm test 61/61）
- [x] 5. 更新 cordis.patch.yml（tool-fs/tool-fs-search disabled + tool-plus 插入；移除 dsh-base 不存在的 tool-bash-persistent 行）
- [x] 6. 真实环境测试：`dsh --profile tool-plus` 冒烟 bash/read/write/edit/grep/glob/read_image 全 PASS
- [x] 7. Bun 特殊语法兼容处理（见下）

## 修复记录（本轮）

- `src/tools/shared/suffix-match.ts`：头注释中 `**/<escaped>` 的 `*/` 提前闭合块注释导致语法错误 → 改为 `**\/<escaped>`
- `src/tools/read/index.ts`：`tryArchiveRead` 缺 `signal` 参数（385 行使用未定义变量）→ 补参数并传调用点
- `package.json`：新增 peerDeps `@deepseek-ai/dsh-fs` / `@deepseek-ai/dsh-attachment` / `@deepseek-ai/dsh-sandbox`，deps `@oh-my-pi/pi-utils@17.3.5`（markit docx/xml/turndown 子模块）
- `tsconfig.json`：exclude `src/tools/_raw_omp`、hashline test/bench（原样参考副本不参与编译）
- `scripts/copy-assets.mjs`：shell-snapshot-fn-env.sh 源路径 bash-runtime → tools/bash
- `tests/boot/composition.spec.ts`：setup 挂载 `LocalFileSystem`（插件硬注入 fs）；移除与插件自带 read 冲突的 registerReadTool 辅助
- `tsdown.config.ts`：`@oh-my-pi/pi-utils` 是纯 TS 源码包（main: ./src/index.ts），Node 无法 strip node_modules 下的类型 → `deps.alwaysBundle: [/^@oh-my-pi\/pi-utils/]` 强制打包；`neverBundle` 只留 `@deepseek-ai` 和 `pi-natives`
- 包名/插件名按 plan.md §9 改名：`@xiaoso/dsh-bash-plus` → `@xiaoso/dsh-tool-plus`，插件名 `tool-plus`，设置命名空间 `tool-plus`（client locales.ts 的 LocaleNamespaceMap 键、BashPlusCard locale 引用、settings.ts 主命名空间、e2e 测试同步）
- `cordis.patch.yml`：移除 `tool-bash-persistent`（dsh-base 0.1.1-rc.2 无此行，patch 报 not found）

## Bun 特殊语法兼容记录

实际打包代码（src/tools/ 下非 _raw_omp、非 test/bench）已无 Bun 语法残留，全部在适配时替换为 Node 等价物（源文件注释留有 DSH port note）：
- `Bun.file().text()/stat()/exists()/bytes()` → `node:fs/promises` readFile/stat（read/write/read-archive/read-sqlite/read-summary/auto-generated-guard 等）
- `Bun.write()` → `fsp.writeFile`（需先 mkdir -p，Bun.write 自动建父目录而 fs 不会；docx.ts/pptx.ts 已处理）
- `Bun.Archive`（zip/tar 读写）→ `src/tools/shared/archive/zip.ts` 纯 node:zlib 实现（读整包加载，注释说明）
- `bun:sqlite` Database → `node:sqlite` DatabaseSync（shared/sqlite-reader.ts + read-sqlite.dsh.ts；boolean 绑定差异已处理：bun 原生绑 boolean，node:sqlite 拒绝 → 转 1/0）
- `Bun.hash` → FNV-1a 32-bit shim（hashline/omp-hashline/src/format.ts:119 注释）
- `Bun.JSON5.parse` → 严格 JSON（write/index.ts:163 注释）
- `Bun.sleep` → setTimeout Promise（bash 运行时 yield.ts 已有）
- `Bun.stringWidth` → 未使用（TUI 渲染已去掉）
- `bun:test`（hashline test/bench）→ 不参与构建，tsconfig exclude，保留原样

## 测试记录

- pnpm typecheck：通过
- pnpm build：通过（ESM 576KB + CJS client 46KB）
- pnpm test：61/61 全绿
- 真实环境冒烟（scripts/smoke-tool-plus.mjs，dsh --profile tool-plus + mock LLM）：bash/read/write/edit/grep/glob/read_image 7/7 PASS

## 模式适配实施记录（plan.md §10，2026-08-22）

- [x] plan.md 新增 §10「模式适配（标准模式增强 + PTC 模式增强）」
- [x] 两个增强 preset 已存在并挂载正常：`tool-plus`（标准增强，基于 standard）、`tool-plus-code`（PTC 增强，基于 code + tool-presentation code mode），均引用 `@xiaoso/dsh-tool-plus`，官方 pwsh disabled
- [x] `~/.dsh/profiles/tool-plus-web/cordis.patch.yml` 新建：`agent-presets config.default: tool-plus` + `settings path: dshHomePath('profiles/tool-plus-web/settings.yaml')`（依赖升级后原配置丢失，已重建）
- [x] 3081 重启（旧进程 15:40 启动加载旧构建/旧配置 → 新进程加载新构建 + patch）
- [x] RPC 验证（POST /api/agentPreset.list）：默认 preset = tool-plus（Tool Plus 标准增强版）；tool-plus / tool-plus-code 均 broken: none
- [x] RPC 验证（POST /api/settings.describe）：agent-default-model = router9/openrouter/stealth/ox-alpha（profile settings.yaml 生效）；agent-presets.default = tool-plus
- [x] 官方工具关闭：dump-config 确认 tool-bash/tool-pwsh/tool-fs/tool-fs-search 均 disabled: true；tool-plus 行存在
- [x] 3080（web profile）未污染

## read/write 整包恢复（2026-08-22 晚）决策记录

按用户最新指令：只去掉用户明确点出的能力，其余全部原样保留；拿不准的写此节请用户决策。

**已按 plan 明确点掉（不移植）**：
- local:// / agent:// 内部协议路由（internal-urls 适配层 canHandle=false，本地协议不解析）
- LSP（拍板#5）、ACP（拍板#8）、vault://（拍板#8）、plan-mode 硬拦截、streaming progress（TUI 专属）
- TUI 渲染：renderers.ts（35 个工具的 TUI 渲染注册表）→ 适配层仅保留 ToolRenderer 类型

**待用户决策**：
1. read-pdf.ts 的浏览器渲染链（browser/registry、tab-supervisor、tab-protocol）：PDF 页面截图依赖 OMP browser 工具链（headless Chromium）。plan 未提及浏览器工具。当前 omp/ 内以接口存根占位（类型+抛错），完整浏览器链是否整体移植待决策。
2. tools/index.ts（OMP 工具注册中心 746 行，import 全部工具）：conflict-detect/report-tool-issue/xdev 仅 type-import ToolSession/Tool。不复制注册中心，omp/ 内以类型存根 index.ts 提供（只 re-export 类型），待确认。
3. fetch.ts（URL 管道 1908 行）：read.ts 原样 import；web/scrapers（76 抓取器）+ web/parallel + web/search 已按用户指示全量原样复制保留（http(s) 网页抓取不裁剪，只去掉 local/agent 本地协议路由）。

**Bun 兼容（留到最后统一处理）**：bun:sqlite（sqlite-reader/write）、Bun.randomUUIDv7、Bun 全局等。

---

## read/adapter TS2307 消除（2026-08-23）

任务：消除 `src/tools/read/adapter/` 下所有非 Bun 类 TS2307（Cannot find module）。
结果：`npx tsc --noEmit` 中 read/adapter 的 TS2307 已只剩 Bun 类（bun:sqlite / pi-wire /
pi-catalog / puppeteer-core / .md 文本导入 / browser 子系统）。全程未改 `adapter/omp/` 内原版文件
（28 个 VERBATIM 与 refs 逐字节一致，diff 验证通过；index.ts / renderers.ts / browser/ 为既有 shim）。

### 复制到适配层（refs 原样复制，保持相对路径）
- `session/agent-storage.ts`（807 行，原版 copy；含 bun:sqlite，Bun 类遗留）
- `utils/turndown.ts`（82 行，纯 @oh-my-pi/pi-utils/turndown）
- `utils/profile-tree.ts`（111 行，无依赖）
- `tools/path-utils.ts`（1489 行，refs/tools/path-utils.ts 原样；consumed by plan-mode-guard→resolveToCwd、image-loading→resolveReadPath）
- `markit/`（整个目录：index/registry/types + converters/docx|epub|pdf|pptx|xlsx；converters 内含 Bun.file/Bun.write，Bun 类）
- `mcp/json-rpc.ts`（122 行，纯 @oh-my-pi/pi-utils logger）
- `exa/types.ts`（纯 @oh-my-pi/pi-ai TSchema）
- `src/tools/read/package.json`（新建：name/version，供 markit-cache.ts `../../package.json` version 折叠进缓存键）

### 新建接口存根 / 类型 shim（文件头已注释 DSH adapter shim）
- `config/model-registry.ts`：原版 2218 行、pi-catalog(Bun) 依赖；只提供 ModelRegistry 最小面（authStorage + find/getProviderBaseUrl/getProviderHeaders/hasCommandBackedApiKey/resolver），供 web/search providers 类型使用
- `registry/agent-registry.ts`：原版 312 行（内部 agent 协议注册中心，明确去掉能力）；空注册表 global()/list()/get()
- `internal-urls/skill-protocol.ts`：原版 skill:// 处理器（明确去掉）；只留 validateRelativePath（纯函数，local-protocol.ts 依赖）
- `exa/mcp-client.ts`：原版用 $env(Bun) + CustomTool 类型（adapter 无）；只留 findApiKey/isSearchResponse 供 web/search/providers/exa.ts
- `lib/xai-http.ts`：原版含 pi-catalog(Bun)；只留 XAIHttpProvider/XAIHttpTransport/resolveXAIHttpTransport（去 bundled-catalog 比较）
- `tools/index.ts`：类型 shim（re-export ToolSession/DeferredDiagnosticsEntry from sdk + Tool），对齐 omp/index.ts
- `adapter/index.ts`：修正 `../../config/settings.ts` → `../../../config/settings.ts`（RuntimeConfig 在 src/config/settings.ts，非 read 局部）

### 决策点（待用户确认）
1. **`config/model-registry`** 未整包复制：原版 imports pi-catalog(Bun) + 多个 sibling config（model-resolver/api-key-resolver/models-config…）会级联出一串非 Bun TS2307。改用最小 ModelRegistry shim（authStorage + 5 个 accessor）。若需真实 model registry，应走 DSH 侧实现而非 OMP 全量移植。
2. **`exa/mcp-client`** 未整包复制：原版依赖 $env(Bun) + CustomTool 类型（adapter extensibility 无），消费方仅用 findApiKey/isCredential → shim。
3. **`lib/xai-http`** 未整包复制：原版依赖 pi-catalog(Bun) → shim，略去 bundled-model baseUrl 比较。
4. **write adapter 对称**：`src/tools/write/adapter/` 存在同型缺失（tools/index、tools/path-utils、session/agent-storage、registry/agent-registry、skill-protocol、config/model-registry、exa/、mcp/、lib/、utils/turndown、utils/profile、markit、internal-urls 等）。本次仅处理 read；write 侧同样处理（可复用同批 shim 策略）。

### 剩余 Bun 类 TS2307（留最后统一处理，step.md 记录）
- bun:sqlite：omp/fetch.ts、omp/read-sqlite.ts、omp/report-tool-issue.ts、omp/sqlite-reader.ts、session/agent-storage.ts
- @oh-my-pi/pi-wire：omp/json-tree.ts
- @oh-my-pi/pi-catalog/*：web/search/providers/{anthropic,codex,gemini,perplexity}.ts
- puppeteer-core：web-search/providers/browser-page.ts、mojeek.ts
- .md 文本导入：read/adapter/omp/read.ts(read.md)、omp/resolve.ts(resolve-device-reminder.md)、web/search/index.ts(web-search.md ×2)
- browser 子系统：`read/adapter/tools/browser/{launch,registry}` —— 整条链 bun: Subprocess 类型 / puppeteer-core / .txt 文本导入，read 类子系统；web/search/providers/browser-page.ts 依赖它且本身含 puppeteer-core + Bun.sleep，整文件 Bun 阻塞

## write/adapter TS2307 消除（2026-08-23，本轮）

任务：消除 `src/tools/write/adapter/` 下所有非 Bun 类 TS2307（Cannot find module）。
结果：`npx tsc --noEmit` 中 write/adapter 的 TS2307 已只剩 Bun 类（bun:sqlite / pi-wire / pi-catalog / puppeteer-core / .md 文本导入）。未改 `adapter/omp/` 内原版文件：23 个文件里 21 个与 refs 逐字节一致（diff 验证通过），仅 `index.ts` / `renderers.ts` 为既有类型 shim（计划内替换注册中心/TUI 渲染）。`write.ts` 与 refs 逐字节一致。

### 复制到适配层（refs 原样复制，保持相对路径）
- `tools/path-utils.ts`（1489 行，refs/tools/path-utils.ts 原样；consumed by adapter/utils/image-loading→resolveReadPath、tools/plan-mode-guard→resolveToCwd）
- `utils/profile-tree.ts`（111 行，无依赖）
- `utils/turndown.ts`（82 行，纯 @oh-my-pi/pi-utils/turndown）
- `markit/types.ts`（纯类型）
- `mcp/json-rpc.ts`（122 行，纯 @oh-my-pi/pi-utils logger）
- `exa/mcp-client.ts` + `exa/types.ts`（原样 copy；含 CustomTool 依赖，见决策点 6）
- `lib/xai-http.ts`（146 行，原样 copy；含 pi-catalog 依赖，Bun 类遗留）

### 新建接口存根 / 类型 shim（文件头已注释 DSH adapter shim）
- `tools/index.ts`：类型 shim（re-export ToolSession/DeferredDiagnosticsEntry/Tool），对齐 omp/index.ts；DeferredDiagnosticsEntry 供 lsp/deferred-diagnostics.ts
- `session/agent-storage.ts`：类型 shim（原版 807 行 bun:sqlite）；只留 `AgentStorage` 类类型 + `listAuthCredentials`（供 omp/fetch.ts 等 type-only 消费）
- `registry/agent-registry.ts`：空注册表 shim（agent:// / local:// 明确去掉，canHandle=false 一致）
- `internal-urls/skill-protocol.ts`：只留 `validateRelativePath`（纯函数，local-protocol.ts 依赖）
- `config/model-registry.ts`：最小 ModelRegistry shim（authStorage + find/getProviderBaseUrl/getProviderHeaders/hasCommandBackedApiKey/resolver/getAll/getApiKeyForProvider），供 web/search providers 类型使用
- `extensibility/custom-tools/types.ts`：补 `CustomTool`/`CustomToolResult` 类型（RenderResultOptions 之外），供 exa/mcp-client.ts implements
- `tools/browser/launch.ts` + `registry.ts`：类型 shim（browser 子系统，puppeteer-core 待决），供 web/search/providers/browser-page.ts
- `adapter/index.ts`：修正 `../../config/settings.ts` → `../../../config/settings.ts`（RuntimeConfig 在 src/config/settings.ts）

### 决策点（待用户确认）
5. **`utils/markit-cache.ts` 的 `../../package.json`**：适配层嵌套使相对路径失效。read 侧选择在 `src/tools/read/` 建 `package.json`；write 侧直接改为指向仓库根 `../../../../../package.json`（version 0.0.1 折叠进缓存键）。两种修法等价，write 侧未新增 package.json。
6. **`exa/mcp-client.ts`** 原样整包复制（read 侧是 shim）：因其被 `web/search/providers/exa.ts` 完整消费（findApiKey/isSearchResponse 真实现），且除 `CustomTool` 类型外无 Bun 运行时依赖。相应给 `extensibility/custom-tools/types.ts` 补了 `CustomTool`/`CustomToolResult` 类型面。若不愿在 write adapter 暴露 CustomTool 面，可改回 shim（仅留 findApiKey/isSearchResponse）。
7. **`lib/xai-http.ts`** 原样整包复制（read 侧是 shim）：含 `@oh-my-pi/pi-catalog/models`（Bun 类遗留）+ `ModelRegistry.getAll/getApiKeyForProvider`。若要求零 Bun 引用，改回 shim 去掉 bundled-model 比较。

### 剩余 Bun 类 TS2307（write/adapter，留最后统一处理）
- bun:sqlite：write/adapter/omp/{fetch,report-tool-issue,sqlite-reader,write}.ts
- @oh-my-pi/pi-wire：omp/json-tree.ts
- @oh-my-pi/pi-catalog/*：lib/xai-http.ts(3)、web/search/providers/{anthropic,codex,gemini,perplexity}.ts
- puppeteer-core：tools/browser/{launch,registry}.ts（shim 内）、web/search/providers/{browser-page,mojeek}.ts
- .md 文本导入：omp/write.ts(write.md)、omp/resolve.ts(resolve-device-reminder.md)、web/search/index.ts(web-search.md ×2)

## 2026-08-22 深夜：read/write 适配层非 Bun 错误清零

- read/adapter/omp/ 25 文件 + write/adapter/omp/ 17 文件全部与原版逐字节一致（diff 抽查通过）
- read/write 适配层搭建完成：sdk.ts（ToolSession 全成员）、config/settings（getStorage/isConfigured/set/RawSettings/getDefault re-export）、internal-urls（canResolve/getHandler/write/WriteContext/resolveLocalRoot/resolveVaultUrlToPath/resolveLocalUrlToFile）、lsp/utils（formatGroupedDiagnosticMessages）、extensibility（CustomTool/CustomToolContext）、model-registry/agent-storage/xai-http shim、web/ 全套保留
- 注册入口：read/adapter/index.ts + write/adapter/index.ts（OMP 原生 path 单参，src/index.ts 已接线）
- tsc 非 Bun 错误 = 0；剩余 339 个全部 Bun 兼容类（Bun 全局 226 / bun:sqlite·pi-catalog·pi-wire·puppeteer·.md·.lark 46 / toBase64 16 / browser 链 10 / fs.exists 3 / 其余 38）留最后统一处理
- tsconfig lib: es2024 → esnext（Array.fromAsync 标准 ES2024，Node 22.13+ 支持）

## 2026-08-23：Bun 兼容统一处理完成（修改点记录）

### 新建 shim（src/tools/shared/）
- bun-shim.ts：globalThis.Bun 运行时实现（file/write/env/sleep/hash(FNV-1a)+xxHash64(标准算法自实现)/stringWidth(东亚宽度)/Glob/Archive.write(tar/tar.gz)/FileSink/CryptoHasher/color/randomUUIDv7/JSON/JSON5(包)/BunImage抛错-plan点掉image）+ Buffer/Uint8Array toBase64/fromBase64 patch
- bun-sqlite-shim.ts：bun:sqlite → node:sqlite（Database/Statement/SQLQueryBindings，readonly映射/boolean绑定/transaction）
- fs-promises-shim.ts：node:fs/promises + exists（Bun扩展）
- bun-named-shim.ts：import { Glob/YAML/plugin } from "bun"（YAML→yaml包）
- bun-ffi-shim.ts：bun:ffi dlopen→null（pi-utils stderr-guard/process-name 自带降级）
- src/types/bun-compat.d.ts：declare global Bun 命名空间/Timer/Buffer扩展/ReadableStreamDefaultReadResult 放宽
- src/types/text-imports.d.ts：declare module "*.md"/"*.lark"/"xxhashjs"（非 module 文件，通配符才生效）

### 接线
- src/index.ts apply() 开头 installBunShim()
- tsdown.config.ts：alias（bun:sqlite/node:fs/promises/bun/bun:ffi→shim，绝对路径）+ loader（.md/.lark→text）
- tsconfig.json：paths bun:sqlite→shim（TS6 无 baseUrl 形式）
- vitest.config.ts：resolve.alias 同 tsdown + text-imports transform 插件（.md/.lark/.html）+ define import.meta.dir
- tests/vitest-setup.ts：installBunShim

### 依赖新增
- @oh-my-pi/pi-catalog@17.3.5、@oh-my-pi/pi-wire@17.3.5、puppeteer-core、json5、yaml（xxhashjs 移除，自实现 xxHash64）

### 其他
- 复制 refs prompts/system/resolve-device-reminder.md 到 read/write adapter/prompts/system/
- read/adapter/omp/read-pdf.ts 的 Bun.randomUUIDv7 → shim randomUUID（v4，仅 tab 名）
- 验证：tsc 0 错误 / build 通过（ESM 12 文件 2.13MB）/ 单测 74/74 / 运行时冒烟通过（file/write/sqlite/xxHash64/Glob/Archive/CryptoHasher）

## 2026-08-23：真实环境冒烟完成（scripts/smoke-tools.mjs）

加载 lib/index.mjs（真实 bundle）+ 完整服务栈，在临时 cwd 驱动 read/write/edit：
- write：新建/覆盖 ✅
- read：全文/:/N上下文窗口(:N=1前导+3尾随+limit)/:raw:N-N精确行/:N-M/:raw/多区间/不存在报错/目录列表 ✅
- edit：replace ✅、未命中报错（含相似度提示）✅、patch unified diff ✅
- 归档：write zip 成员从零建容器 ✅、read 归档成员 ✅、read 归档根目录 ✅
- sqlite：write 行（JSON5 内容）✅、read 表 ✅
- 运行时验证：bun-shim 全 API、bun:sqlite、fs.exists、xxHash64 标准向量一致

测试中发现并修正（非移植问题）：
1. tsdown 需 alwaysBundle 全部纯 TS @oh-my-pi 包（pi-tui/pi-agent-core/pi-ai/pi-catalog/pi-wire/hashline）——Node 不能 strip node_modules 下 TS
2. import.meta.dir 是 Bun 专属（Node 只有 dirname）→ tsdown define 替换
3. bundle 顶层 Bun.env 访问 → 独立 bun-shim.mjs entry + banner 先装 shim（避免循环：bun-shim 内 fs/promises 不带 node: 前缀；json5 保持 external 用 Node CJS default-interop）
4. pi-ai/pi-tui 额外 bun 命名导入（$ / Cookie / CookieMap / CString）→ bun-named-shim/bun-ffi-shim 补导出

## 2026-08-24：edit 四模式冒烟测试补全 + 两处适配保真修正

### 适配器保真修正（src/tools/edit/adapter/index.ts，纯 glue，不动 omp/）
1. **file_path 不再是全模式必填**：OMP 的 hashline/apply_patch 模式路径在 `input` 内部（`[PATH#TAG]` 节头 / `*** <File|Move>:` 信封标记），顶层无 file_path。原适配器在模式分发前强制校验 file_path，会拒绝 OMP 原生的 `edit {input}` 调用形状 → 校验下移到 patch/replace 模式。
2. **allowCreateOverwrite 按模式区分**（对齐 OMP omp/index.ts 模式分发）：JSON `patch` 模式 = true（`op:"create"` 兼作整文件覆盖，patch.md 契约）；`apply_patch` 信封 = 不设（false，`*** Add File` 严格不覆盖）。原来硬编码 true 会让 apply_patch 覆盖已存在文件，偏离 OMP。

### 冒烟覆盖新增（scripts/smoke-tools.mjs，共 33 项断言）
- hashline：read 输出 `[path#TAG]` 头提取 ✅；PUT N.=M 区间替换 ✅；PUT >N 插入 ✅；CUT 删行 ✅；过期 tag 拒绝 ✅；多节（两文件一 input，preflight+commit）✅
- apply_patch：Update File（unified diff hunk）✅；Add File ✅；Add File 覆盖已存在文件拒绝 ✅；Delete File ✅；Update+Move to（diff 应用于源、落于目标）✅；多文件信封（Add+Update 一次调用）✅
- 运行：pnpm build && node scripts/smoke-tools.mjs → 全部 PASS（含既有 write/read/patch/archive/sqlite 断言）

## 2026-08-24：OMP 原版测试搬入 vitest + xxHash32 算法修正

用户问"OMP 的测试用例能不能搬过来使用"。侦查结论：OMP 工具源码（_raw_omp/tools 98 文件）无自带测试，唯一带测试的组件是 hashline（src/tools/hashline/omp-hashline/test/ 12 个 bun:test 文件，302 用例）。该目录是 workspace 链接（node_modules/@oh-my-pi/hashline → src/tools/hashline/omp-hashline），正是打包进 lib 的同一份代码。

### 搬移方案（零拷贝、零改动测试文件）
- vitest.config.ts：include 直接加 `src/tools/hashline/omp-hashline/test/*.test.ts`（原样位置跑，不复制）
- 新建 tests/bun-test-shim.ts：`export { describe, expect, it } from 'vitest'`；alias `bun:test` → shim
- 测试里唯一 Bun 全局是 patcher.test.ts 一处 `Bun.write`（tests/vitest-setup.ts 的 installBunShim 已覆盖）
- 结果：12 文件 302/302 全绿

### 搬入即发现算法偏差（重要）
- patcher.test.ts "colliding snapshot" 用例失败：测试注释给出硬编码锚点——两段文本 `"line one 263\nline two 4471\n"` / `"line one 410\nline two 6970\n"` 在**原版 computeFileHash 下都 hash 到 `1D84`**（snapshots.test.ts 同款碰撞对）
- 我们之前的 Bun 兼容 fallback 是 FNV-1a 32 位截 16 位 → 碰撞不成立（0BE0 vs 6C2A），证明 **FNV-1a 与原版算法不一致**（冒烟测试覆盖不到的碰撞场景）
- 用标准 XXH32（seed 0、UTF-8 字节、低 16 位）验证：两文本 xxh32 全值 0x1A971D84 / 0x1CBC1D84，低 16 位都 = 1D84 ✓；空串 = 0x2CC5D505（与规范向量一致）✓ → 原版就是 Bun.hash.xxHash32 低 16 位
- 修正：omp-hashline/src/format.ts computeFileHash 换为标准 xxHash32 纯 JS 实现（normalizeFileHashText 保留，原版逻辑）；12 文件 302/302 全绿
- bun-shim 的 Bun.hash(FNV-1a) 保留：其余消费点（fetch 缓存键/image-loading/noop-loop-guard/read-summary/block-resolver）全是运行时内部一致性用途，无跨运行时契约

## 2026-08-24 晚：grep/glob/ast-edit 整包复制 + 孤儿清理（移植收尾）

用户拍板：不引入 @oh-my-pi/pi-coding-agent npm 依赖（barrel 拉全包、需 rolldown 模块替换插件，方案否决），**继续本地复制维护**；grep/glob/ast-edit 三个重写工具按整包复制+适配重做（子代理并行）。

### 三个工具完成情况
- `src/tools/grep/adapter/omp/`：grep.ts(1920) verbatim + 平级依赖 12 个（fetch/file-recorder/grouped-file-output/match-line-format/list-limit/output-meta/path-utils/render-utils/sqlite-reader/tool-errors/tool-result/tool-timeouts），与 refs 逐字节一致（diff 验证）
- `src/tools/glob/adapter/omp/`：glob.ts(691) verbatim + 平级依赖 6 个；`internal-urls/memory-protocol.ts`、`task/spawn-policy.ts`、`prompts/tools/glob.md` 原版复制
- `src/tools/ast-edit/adapter/omp/`：ast-edit.ts(718) verbatim + file-recorder/grouped-file-output/match-line-format + prompts
- 每个工具新建 adapter/index.ts（defineTool 注册，OMP 原版参数形状）+ sdk.ts（ToolSession）；grep/glob 的 `internal-urls/router.ts` 空路由 shim（canHandle 恒 false，memory:// 按用户确认整体去掉）
- **唯一允许的 import 调整**：`from "."`（tools barrel 746 行不可复制）→ `from "../sdk"`；ast-edit 另跨工具复用 read/edit 已适配副本（`../../../read/adapter/...`），diff 证实仅 import 块 31 行变化、其余 687 行逐字节不变
- glob 复用 read 适配层全闭包：modes/theme（99 主题 json）、tui、session/streaming-output、config 等（151 文件）

### 孤儿清理
删除旧简化版：`src/tools/read/index.ts`(753)、`src/tools/write/index.ts`(590)、`src/tools/grep/index.ts`(547)、`src/tools/glob/index.ts`(337)、`src/tools/ast-edit/index.ts`(200)；src/index.ts 切换三工具注册到 adapter 并传 `() => cfg`。

### 修复（typecheck 报错清零）
1. DSH defineTool 参数 schema **禁止显式 `required: false`**（TS 报 false not assignable to true）→ 可选字段省略 required
2. glob adapter 补：`config/model-registry.ts`、`lsp/types.ts`、`tools/grouped-file-output.ts`（从 read 复制）
3. glob `registry/agent-registry.ts` shim 补 getCwd/getHindsightSessionState 类型成员（memory-protocol verbatim 消费）
4. `src/tools/grep/package.json` 占位（markit-cache.ts `../../package.json` 相对导入，同 read 方案）

### Bun 兼容点（构建链已覆盖，未改源码）
- 各闭包内：`bun:sqlite`（fetch/sqlite-reader）、`Bun.file/Bun.write/Bun.hash/Bun.stringWidth/Bun.Image/Bun.color/Bun.env`、`with { type: "text"/"json" }` 文本/JSON 导入（theme 97 个 json）
- 均由 tsdown alias（bun:sqlite→shim）/ loader（.md/.lark/.html→text）/ banner（installBunShim）统一处理；typecheck 0 错误、build 通过（9.14MB / 88 文件）

### 验证
- `pnpm typecheck` 0 错误；`pnpm build` 通过
- smoke-tools.mjs 扩展 grep/glob/ast_edit 用例后 **45/45 ALL PASS**（原有 read/write/edit 33 断言 + grep 5 + glob 2 + ast_edit 2）
- 测试中发现并修正（非移植问题）：grep 原版默认**大小写敏感**（`caseSensitive ?? true`），适配描述曾误写为默认不敏感

### 语义说明（原版行为，未加 fallback）
- ast_edit 在 DSH 下为**纯预览语义**：原版 queueResolveHandler 在 session 无 tool-choice 队列时静默 return，dry-run 不修改文件（预览 diff 输出正常）
- grep 输出 hashline 模式 `*N:行`（有 edit 工具时）/ plain 模式 `*N|行`

## 2026-08-24 深夜：真实 dsh 环境回归（mock LLM，零 API 消耗）

`dsh --profile tool-plus "任务"`（tool-plus profile 的 app 即 headless 一次任务退出）+ `--patch` 临时覆盖 settings 文档（`settings` 插件 `config.path: !!js dshHomePath('.smoke-mock/mock-settings.yaml')`，仅 DSH 家目录内路径可解析）指向自写 OpenAI 兼容 SSE mock（`scripts/.dsh-mock/mock-llm.mjs`，默认 30199 端口），按序下发 tool_call 驱动 grep→glob→ast_edit→read 全链，工具结果由 mock 校验记录。

- **四个移植工具在真实 dsh 进程中全部执行成功**：grep `[grepme.txt#B955]*1:alpha one *2:alpha two` ✅、glob `grepme.txt` ✅、ast_edit 预览提案 ✅、read 全文 ✅；最终消息 MOCK_DONE tools=call_1,call_2,call_3,call_4
- 环境事实：`agent-default-model` 是对象结构（provider/model/reasoningEffort），字符串写法加载失败回退真实模型（第一次测试意外走了真实 LLM——功能同样验证通过，但确认后改用 mock 重测）；mock 模型需声明 `reasoningEfforts`（否则 UNSUPPORTED_REASONING_EFFORT）
- mock 脚本踩坑记录：dsh 会并发发**会话标题生成请求**（developer 提示含 "Create a concise title"，返回纯文本短标题、不得消耗工具序列）；主序列计数器须在响应**之后**递增（否则序列偏移丢失首个工具）
- 测试后清理：~/.dsh/.smoke-mock 与临时工作区已删；mock 三件套保留在 `scripts/.dsh-mock/` 供后续工具移植复用；未污染任何现有 profile/全局 settings.yaml

## 2026-08-25 审计：hashline LRU shim 恢复原版

- snapshots.ts 曾用自写 Map-based LRUCache shim（替代 @oh-my-pi/pi-utils/lru），只按 count 驱逐、忽略 maxSize（DEFAULT_MAX_TOTAL_BYTES 字节上限语义丢失）→ 审计发现后恢复原版 （pi-utils 在 tsdown deps.alwaysBundle 内，Node 直跑不行但打包正常）
- 验证：typecheck 0 错误、hashline 302/302、build 通过、smoke 47/47

## 2026-08-25：设置键全面对比审计（subagent）与补全

- 审计：OMP settings-schema.ts 共 452 个注册键；已移植工具引擎实际读取 50 个键（去重）；hashline 0 键
- 修复：① tools.outputMaxColumns=768（唯一 reachable A 类缺口，read 行宽截断）② tools.artifactSpillThreshold/TailBytes/HeadBytes/TailLines=50/20/20/500（dormant 防御）③ tui.maxInlineImageRows 30→20（D 类唯一真实偏差）④ edit.streamingAbort=false、glob/grep/astGrep/astEdit.enabled=true 默认兜底
- UI 字段再补 4 个（read/write 抓取与读图）：fetchEnabled、fetchMaxTimeoutSeconds、imagesAutoResize、inspectImageMode（select auto/on/off），含 locales/settings.ts 全链路
- 明确不加：web/search（searxng/exa/antigravity，dormant）、lsp.*、bash.*、browser.* 等未移植模块

## 2026-08-25：统一 OMP 配置注册表（用户拍板：尽量支持 OMP 所有配置，字段统一放一处）

- 新建 `src/config/omp-settings.ts`（单一事实源）：`OMP_DEFAULTS`（全部引擎读取的 OMP 键默认值，verbatim 取自 refs settings-schema.ts：edit.*/read.*/grep.*/lsp.*/task.*/tui.*/display.*/fetch.*/tools.*/images.*/inspect_image.*/memory.*/providers.*/exa.*/searxng.*/dev.* 共 33 键）+ `OMP_KEY_TO_FIELD`（OMP 键→DSH flat 字段映射，含新增 edit.mode/read.defaultLimit/read.renderMarkdown/readLineNumbers/grep.contextBefore/grep.contextAfter）
- 5 个 adapter（read/write/edit/grep/glob）的 config/settings.ts + settings-schema.ts 删除本地重复表，改为引用统一注册表
- fields.ts 补 9 个 UI 字段（editMode/editFuzzyMatch/editFuzzyThreshold/editEnforceSeenLines/readDefaultLimit/readLineNumbers/readRenderMarkdown/grepContextBefore/grepContextAfter）；grep tab 挂上字段；locales 补中英文案；src/config/settings.ts 补 RuntimeConfig/Config/z.object/resolveConfig 四处
- 验证：typecheck 0 错、build 通过、smoke 47/47

## 2026-08-24 深夜：ast_edit 落盘 + ast_grep 移植（用户新拍板）

用户拍板："ast_edit需要预览后真实落盘，ast_grep这个工具也添加进plan.md，按和之前一样的规格移植"。plan.md 更新：§3.2 表格加"AST 查询（ast-grep.ts）整体复制"、§3.3 小结、§8 拍板 #14。

### ast_edit 落盘（DSH resolve 通道，纯适配层接线，不动 omp/）
- `src/tools/ast-edit/adapter/index.ts`：ToolSession 注入 `getToolChoiceQueue`（返回捕获队列：registerPendingInvoker 保存 invoker 到 `session.pendingInvoker`）；execute 返回预览后若存在 pending 则以 `{action:'apply', reason:'DSH auto-apply'}` 调用 → 原版 apply 回调（runAstEditOnce dryRun:false）真实写盘，返回 "Applied N replacements" 报告
- `sdk.ts`：ToolSession 加 `pendingInvoker` 成员
- 验证：smoke 断言改为"Applied 报告 + 文件真实修改"（`Applied 2 replacements in 1 file. [code.ts#61D4]`，newName 替换 oldName）PASS

### ast_grep 移植（子代理）
- `src/tools/ast-grep/adapter/omp/ast-grep.ts`（526 行 verbatim，17 处 import 路径调整，正文逐字节一致）+ omp/prompts/tools/ast-grep.md
- 依赖全跨工具复用已适配副本（fetch/file-recorder/grouped-file-output/match-line-format/output-meta/path-utils/render-utils/tool-errors/tool-result 指向 read/ast-edit adapter；tui/theme/file-display-mode/session 指向 read adapter；spawn-policy 指向 glob adapter；file-snapshot-store 指向 edit adapter）
- `adapter/index.ts`：registerAstGrep（pat 必填 + path/skip 可选，只读查询无 preview）；`adapter/sdk.ts`（基于 ast-edit 版加 getSessionSpawns）
- bun 语法点：仅 `with { type: "text" }`（构建链 text loader 覆盖）
- src/index.ts 已注册 `registerAstGrep(ctx, () => cfg)`

### 验证
- typecheck 0 错误；build 通过（9.16MB）；smoke **47/47 ALL PASS**（ast_edit 落盘 2 断言 + ast_grep 2 断言）

- 真实 dsh 回归（mock LLM）：ast_grep 查询 [code.ts#5258]*1:oldName *4:oldName → ast_edit Applied 2 replacements in 1 file. [code.ts#61D4]（真实落盘 5258→61D4）→ read 读回 newName（fresh tag 61D4 闭环）；文件系统验证 code.ts 已真实修改

## 2026-08-25：浏览器工具链删除（用户拍板#16）

用户拍板："浏览器browser工具链删除吧"（PDF 页面截图链不移植，写入 plan.md 拍板#16）。执行范围：

- **删除**（read/write/grep 三 adapter 各一份）：
  - `adapter/tools/browser/{launch,registry}.ts`（类型 shim）
  - `adapter/web/search/providers/browser-page.ts`（browserFetch：全部免密钥抓取 provider 的公共底座）
  - `adapter/web/search/providers/browser-headers.ts`（仅 browser-page 引用）
  - **方案A（用户拍板"那都不需要留吧，方案A全删掉"）连带删除 5 个浏览器抓取 provider + public 聚合器**：`mojeek.ts`、`google.ts`、`ecosia.ts`、`duckduckgo.ts`、`startpage.ts`、`public.ts`（browserFetch 被这 5 个免密钥抓取族共用，删浏览器链后无法工作；web/search 本身 dormant 未注册，只留 API-key 型 provider：perplexity/gemini/anthropic/codex/xai/zai/exa/tinyfish/jina/kagi/tavily/firecrawl/brave/kimi/parallel/synthetic/searxng）
- **同步编辑**（read/write/grep 各一份）：`web/search/provider.ts` 删 6 个注册块；`web/search/types.ts` 删 6 条选项（SearchProviderId/LABELS/ORDER/CHOICES 全由 SEARCH_PROVIDER_OPTIONS 派生，删条目即全同步）
- **package.json**：移除 `puppeteer-core` 依赖（删除后全仓库零 puppeteer 引用）
- **保留为明示不支持缝**（read/omp/browser/ 三个文件）：`registry.ts`/`tab-protocol.ts`/`tab-supervisor.ts` 收缩为最小类型面 + 抛错（"DSH has no browser tool: PDF page screenshots are unavailable."）——read-pdf.ts 是 verbatim 复制文件，其 import 路径不能动，故该缝必须留在原路径；头注已更新为拍板#16
- 确认：read 读 URL 不走 browserFetch（走 omp/fetch.ts 自有后端链 native/trafilatura/lynx/Parallel/Jina），浏览器链删除不影响 read 抓取
- 验证：typecheck 0 错、单测全绿（见上）

## 2026-08-25：OMP 原版提示词接入工具描述（用户拍板）

用户拍板："先放到工具描述里吧" + "edit工具是什么模式，就给什么描述"。9 份 OMP 原版 prompts/tools/*.md（+ hashline 引擎 prompt.md）接入各工具 defineTool 的 description；md 源文件保持 verbatim 一字未动，适配全部集中在新建的 `src/tools/shared/omp-prompt.ts`。

- **渲染**：`renderOmpPrompt` 支持 `{{#if KEY}}A{{else}}B{{/if}}` 与 `{{#if KEY}}A{{/if}}`（md 内无嵌套、无插值变量，无需完整 Handlebars）
- **接入**：read（read.md，IS_HL_MODE 随 edit.mode==='hashline'、INSPECT_IMAGE_ENABLED=false）、write（write.md）、grep（grep.md）、glob（glob.md）、ast_edit（ast-edit.md）、ast_grep（ast-grep.md）、edit（按配置 editMode 选 replace.md/patch.md/apply-patch.md/hashline prompt.md 之一）
- **剔除点白名单**（DSH 不适用提法，全部在 shared/omp-prompt.ts 的 sanitize 函数内）：
  - read.md：`(not browser)` 提法句删；`internal resources` 词删；internal URIs 段（`artifact://` `ssh://` 整段）删；`{{#if IS_HL_MODE}}` 按模式渲染；`{{#if INSPECT_IMAGE_ENABLED}}` 取 else 分支（DSH 无 inspect_image）
  - grep.md：`internal URLs` 提法删；`Task + scout` 句删（DSH 无 scout/Task）
  - glob.md：`memory://`/`ssh://`/internal URL 句删；scout avoid 句删
  - ast-edit.md：`xd://resolve`/`xd://reject` 预演确认句 → 替换为 "STAGED as a preview, then automatically applied (DSH auto-apply)"（拍板#14 语义）
  - ast-grep.md：scout 句删
  - write/patch/apply-patch/replace/hashline prompt.md：无 DSH 不适用提法，纯 trim
- **热更新（2026-08-25 追加）**：DSH 工具注册表同名重复注册会抛错（NamedEntries），但 `register()` 返回 disposer——read/edit 的注册改为返回 disposer，src/index.ts 在配置热更新回调里先 dispose 再重注册（registerModeSensitive），editMode 切换后 read 的 IS_HL_MODE 描述与 edit 的模式描述即时刷新，无需重启。其余工具描述不依赖配置，不受影响。验证：tsc 0 错、376/376、smoke ALL PASS、build 通过。
- **验证**：typecheck 0 错、smoke ALL PASS、单测 376/376、build 通过

