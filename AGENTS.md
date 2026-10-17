# AGENTS.md

面向 AI 助手与维护者的仓库须知。

## 项目

`@xiaoso/dsh-tool-plus`：DeepSeek Harness 基础工具增强——持久 bash、结构化 read、多模式 edit、原子 write、双引擎 grep/glob、图像直读，一个插件全覆盖（Oh My Pi 内核移植，可选 ast_grep/ast_edit）。

**只发一个包**（2026-09-20 起）：根包 `@xiaoso/dsh-tool-plus`。仓库里的 `presets/` 目录随根包的 `files` 一起发布，但**交付方式在 0.1.10 变了**：不再是"首次启动写目录"，而是两个补丁文件（`presets/tool-plus-{standard,ptc}.patch.yml`）挂在 `package.json` 的 `dsh.bundle.patch` 数组里，各插入一条 `@deepseek-ai/dsh-agent-preset` 声明行。装上插件即声明两个预设，**启动时零写入**。

| 包 | 目录 | 状态 |
|---|---|---|
| `@xiaoso/dsh-tool-plus` | 仓库根 | **唯一在发的包** |
| `@xiaoso/dsh-tool-plus-presets` | `presets/` | **已退役**：不再发新版（旧版已 `npm deprecate`）；目录随根包发布，但已不是"模板目录"，而是生成出来的补丁文件 |

`publishConfig` 已配 `tag: latest` / `access: public`——发布直接落在 latest 标签，`dsh plugin add`（不带 tag）默认安装与 dsh 当前版本匹配。**发预发布必须显式带 tag**（如 `npm publish --tag beta`），否则会推到 latest，把 beta 塞给所有默认安装的用户。

## 预设（agent preset）——生成物，别手改

两个预设是**生成物**，源在 `presets/baseline/`：

```
presets/baseline/{standard,ptc}.patch.yml   ← 官方随附预设补丁的逐字节快照（对应我们 pin 的 dsh 版本）
scripts/build-preset-patches.mjs            ← 基线 + 显式 delta → 生成下面两个文件
presets/tool-plus-{standard,ptc}.patch.yml  ← 生成物，入库，别手改
```

delta 只有四项，每一项都是有记录的产品决定：删 `tool-bash`/`tool-fs`/`tool-fs-search`（宿主面已由 `cordis.patch.yml` 接管，agent 面再挂一份会造成 per-session 影子实例）、强制 `tool-pwsh` 关闭、插一行文档用的 `tool-plus`（disabled）、以及身份/顺序元数据。其余**逐项等于官方基线**——官方改包名、加行、收窄默认（如 0.1.7 关掉 `tool-ralph`）都会随基线继承。

**为什么这么做**：手抄副本已经害过一次——两个预设的 `delegation` group 里挂着 `@deepseek-ai/dsh-workflow-worker-thread`，而 0.1.7 把它改名成 `dsh-workflow-ptc`，于是整份预设激活失败且无测试能发现。`tests/unit/preset-patches.spec.ts` 现在钉住"生成物 == 生成器重算结果""delta 恰好只有声明的那几项""行名集合只来自基线"。

**升 dsh 版本时多一步**：把 `packages/bundle/web-app/presets/{standard,ptc}.patch.yml` 从新版本重新拷进 `presets/baseline/`，跑 `pnpm presets:build`，**逐条 review diff**（官方新增/删除的行是有意义的信号，别默默继承），再跑验证链。

**写路径不许自己实现**：用户改动通过 `ctx.configEditor.edit()` 写进 `<profile>/cordis.patch.yml`（按行 id `preset-<id>` 覆盖整份 `config`）。宿主的这层自带 profile 锁、HMR 串行、配置校验、原子写、失败回滚与更高优先级覆盖检查；**不要**再自己写原子写、备份文件或 profile 补丁解析——那是 0.1.7 之前的做法。

## 发布与推送（每次迭代照此走）

```sh
# 1. 版本自增（只操作根包）
pnpm version prerelease

# 2. 验证链
pnpm presets:check && pnpm typecheck && pnpm build && pnpm test

# 3. 更新 CHANGELOG.md：按 Keep a Changelog 为本次版本新增一节
#    （格式沿用历史版本：## [<ver>] - <日期> + Added/Changed/Fixed/Removed
#    + 对比链接），随本版变更一起提交；不更新不得发版

# 4. 提交 + 标签
git commit -am "release: tool-plus v<ver>"
git tag tool-plus-v<ver>

# 5. 推 git + 发 npm（正式版落 latest；预发布加 --tag beta）
git push && git push --tags        # 先推分支，再推标签（--tags 只推标签不推分支）
npm publish                        # 主包（含 cordis.patch.yml 与 presets/*.patch.yml）

# 6. 发 GitHub Release（手动，不用 workflow；notes 用 CHANGELOG 本节内容）
gh release create tool-plus-v<ver> --title "v<ver>" --notes-file <notes 文件>
```

版本对齐：兼容性以 `engines.dsh` 为准，写**官方口径**的一条范围——覆盖整条 minor 线，如 `>=0.2.1-0 <0.3.0-0`。两个 `-0` 都有用：宿主匹配时预发布参与，下界不带 `-0`（写成 `>=0.2.1` 或 `^0.2.1`）会把同代的 rc/alpha 挡在外面；上界不带 `-0`（官方示例的 `<0.3.0`）会把下一代的 `0.3.0-rc.1` 也放进来。宿主优先按它判，0.2.1-alpha.5 起声明了它 peer 就不参与判定；`peerDependencies` 里 15 条 `@deepseek-ai/dsh*` 同步写**同一串**、`devDependencies` 精确 pin 同版号——peer 是留给不认识新字段的老宿主与 pnpm 的镜像，两处必须逐字一致。同一 minor 线内升级**范围不动**（只挪 devDeps 的 pin）；跨线时按实际还支持的版本追加 `||` 并集或整段替换。**跟 `next` 通道**。README 只描述当前对应关系，不保留历史 dsh 版本号。

宿主如何对待版本不匹配的插件：组合每个 profile 时按 `packages/boot/app-boot/src/plugin-compatibility.ts` 逐个插件核对 DSH 版本要求——**声明了 `engines.dsh` 就只比这一段**（必须是字符串、合法 SemVer 范围；空串、写坏的范围、`workspace:*` 之类判「不满足」，非字符串直接抛错），否则要求 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 的**每一条** peer 范围都匹配运行时（预发布版本参与匹配）。不匹配的插件模块不会被导入，普通行在启动器自己那份组合里变成游离的 `disabled: true` 行（profile 的 patch 层、依赖清单与组合包列表都不改），并带 `incompatible-version`（含 `name`/`version`/`runtimeVersion`/`requirements`）；CLI 会打印 `dsh plugin --profile <profile> allow-version <pkg>@<ver> --dsh-version <ver> --accept-risk` 这条豁免命令（`version-exemptions` 查看、`revoke-version` 撤销，只对精确的包@版本+运行时版本生效）。症状仍是「插件工具突然消失、补丁层不生效」而不是启动失败；排查时看 `<profile>/cordis.yml`（合成结果）里有没有自己的行、自己的 `disabled` 有没有生效。

发布标签：dsh npm `latest` 与 `next` 经常错开，桌面端 app 自带的 dsh 还可能领先两者。pin 到非 `latest` 版本的插件版本只能发 `next`/`beta`——发 `latest` 会让所有默认安装的用户失去这个插件（0.2.1 起宿主会显式报 `incompatible-version` 并提示豁免命令，不再是无声跳过）。

## 端到端测试（真宿主 + 假供应商）

两层，照 pi 的 `packages/gateway/test/support/{harness,mock-openai}` 分层：

```
tests/support/mock-openai/   假 LLM 服务（套件本体）
  protocol.ts                纯函数帧构造，零 IO；格式事实来源是 pi-ai 的 openai-completions
  scenario.ts                场景模型：轮次由 match 谓词选、按会话分桶
  server.ts                  node:http 薄 IO 层 + 请求记录 + /__mock/requests 调试端点 + reset()
  cli.ts                     pnpm mock:llm 独立起服务
  scenarios/*.json           场景数据（<scratch> 占位符由调用方替换）
  mock-openai.spec.ts        自己的自检（进 pnpm test）
tests/support/harness/       驱动（把真 dsh 拉起来跑）
  support.ts                 路径、测试 profile 搭建、dsh 起停
  dsh-e2e.ts                 pnpm e2e      —— headless 跑完硬断言，退出码即结论
```

**为什么轮次用 `match` 谓词而不是计数器**：宿主会并发发**会话标题请求**，计数器会被它带偏。谓词看的是这次请求长什么样（`requestIndex` / `messageCount` / `toolResultContains` / `firstUserMessageContains`），再按 `bucketBy: firstUserMessage` 分桶——标题请求的"首条 user 消息"是那段标题生成提示词，天然和主对话分在两个队列，互不消耗。场景里另设一条 `match: { messageContains: "concise title" }` 的 `00-title` 轮次接住它。

**思考与工具卡片都要能看见**：推理走 OpenAI 的 `reasoning_content` 字段（`protocol.ts::reasoningChunk`）——pi-ai 只在这个字段非空时才产 `thinking_delta`，不发它界面上永远没有思考块；工具调用则要在 profile 补丁层里设 `ui-chat: { transcriptView: verbose }`，否则整轮会被折进「用时 N 秒」那一层。

断言从**假供应商侧收到的请求记录**里取（每一步的工具结果都在下一次请求的 `role: "tool"` 消息里），比解析 dsh 的 stdout 可靠。场景本身也带断言：最后一条轮次要求 `toolResultContains: "name + GREETING"`——读回的文件里没有这句就匹配不上，脚本耗尽直接 500。

前置：全局装了 dsh、本仓库已 `pnpm build`（profile 是指向仓库根的 junction，宿主直接加载 `lib/`）。测试 profile 落在 `$DSH_HOME/profiles/tool-plus-e2e`，由脚本幂等重建；`DSH_BIN` / `E2E_TIMEOUT_MS` 可覆盖。这套东西不进 npm 包（不在 `files` 里）。

### 浏览器通道（`e2e` 框架）

上面那套是仓库自带的驱动；这套把同一个假供应商接到 `e2e`（tester-army 的 e2e 框架）上，用真浏览器点真界面：`pnpm e2e:browser`（整个通道），`pnpm e2e:browser --grep-invert agent` 跳过唯一需要模型密钥的那条。**转发过滤参数不要写 `--`**——pnpm 会把 `--` 本身也塞给 e2e，框架直接报错；等价写法是 `pnpm exec e2e run --config e2e/e2e.config.ts --grep <pattern>`（配置在子目录，直接跑 CLI 必须显式给 `--config`，框架只会往**上层**目录找配置）。

```
e2e/e2e.config.ts            主配置；**配置所在目录即框架认定的项目根**，测试 glob、output、启动命令 cwd 全在 e2e/ 下
e2e/support/start-app.mjs    启动接线：隔离 DSH_HOME + 借开发者 profiles/node_modules 的 junction + 建测试 profile + 进程内假供应商 + 起 dsh web
e2e/support/app-endpoint.mjs 读启动接线发布的 JSON（带令牌地址 + 假供应商根）
e2e/tests/support/dsh-web.ts 管道：进到可输入状态、读假供应商请求记录、切主题
e2e/tests/*.e2e.ts           用例（`*.e2e.ts` 不在 `pnpm test` 的 include 里）
e2e/fixtures/tiny.png        图像用例的夹具，由启动接线的 `<fixtures>` 占位符替换
e2e/tsconfig.json            独立配置，不进主 tsconfig 的 include（主配置是产出配置：rootDir + declaration）
.agents/skills/e2e/          框架自带技能的逐字副本（源在 node_modules/e2e/skills/e2e/）：写用例前读它，别凭记忆
```

**带令牌地址只能运行时发布**：dsh web 每次启动生成**进程级随机**令牌放在 `?token=` 上（换一枚签名 cookie），配置期无从得知。所以 `app.url` 只写 `http://127.0.0.1:0` 让框架挑端口，`readyUrl` 打**不带令牌**的根（宿主对未认证索引请求回 401，落在框架认可的 200-499 里即就绪），带令牌的地址由启动接线写进 `%TEMP%/dsh-tool-plus-e2e/app-endpoint-<端口>.txt` 供测试读。认证走注入令牌，**不填任何凭据表单**——填了框架会扣留截图与模型视觉输入。

**多套剧本共用一个场景文件**：场景按 `bucketBy: firstUserMessage` 分桶、各桶 `requestIndex` 独立计数，所以不同用例只要首条消息带不同标记（`E2E-RUN` / `E2E-ERR` / `E2E-IMG`）就能共用 `tool-plus-all-tools.json` 而互不消耗。假供应商的 `mock-model` 声明了 `image` 模态——不声明的话 read 会判成非视觉路由、把图片 soft-refuse 成一段说明文字，图像路径根本走不到。

**设置页的开关真的会改会话工具面**（插件按配置热更新重注册工具），所以「关掉 `ast_grep` → 工具名从假供应商侧消失」是可断言的；保存落在测试 profile 的 `cordis.patch.yml`，而启动接线每轮重写那份文件，留不下跨轮脏状态。

产物落在 `e2e/.e2e/`（整体 gitignore，每次 run 重写）：`results/<用例>-<hash>/attempt-1/{screenshots,video,trace.md}` 加全局 `report.json` 与被测应用自己的 `logs/app.log`。截图标签一律用 ASCII——中文标签会被产物命名规则折成一串下划线，认不出是哪张。另用配置里的 `artifacts.store` 把**每个产物同时写一份**到 `docs/e2e-evidence/`（同样 gitignore，路径与 `.e2e` 下一一对应）：`.e2e/` 那份每次重写，这份是留给人回看的稳定副本。

**分工**（别以为一条通道能全替）：整页长转录（拉高视口再拍）、轨迹页、录像、页面报错计失败都在这条通道；**宿主进程退出码**与 **headless 宿主形态**只在 `pnpm e2e` 里。老的 `pnpm e2e:web` 已于 2026-10-13 退役，它的能力（整页截图、轨迹页、欢迎层兜底、显式切预设、页面报错计失败、稳定产物目录）已全部被这条通道吸收。

## 改动守则

- `refs/oh-my-pi/` 是干净的上游对照克隆，只读不动；当前 HEAD 已升至 `v18.1.17`（旧基线 `v17.3.5` tag 保留可回溯）。**hashline 不再 vendored**：上游 18.x 删除 TS `packages/hashline`、把编辑引擎重写为 Rust `crates/pi-edit`（经 `@oh-my-pi/pi-natives` 暴露），我们只保留薄适配层 `src/tools/hashline/native/`（`diff-preview.ts` 为旧 TS 逐字移植）；`_raw_omp/` 等其余移植件的逐字审计基准是 `v17.3.5` tag，其余工具按 refs 当前 HEAD 对照
- **引擎拥有序列化，宿主只落字节**：`EditWriteRequest.content` 已是最终字节序列（notebook 的 nbformat JSON 由 Rust `files.rs::persist` 生成），`native/writer.ts` 必须逐字落盘；**不要**在写盘腿上再调 `serializeEditFileText`（那是旧 TS 引擎的契约，会把引擎的 JSON 当可编辑文本再解析，导致每次 `.ipynb` 编辑报 `Invalid notebook editable representation`）
- **notebook 只留一套解码器**：解码走引擎自身——`omp/edit/notebook.ts::readEditableNotebookText` 委托 `pi-natives` 的 `notebookToEditableText`（上游 `tools/read.ts` 同款调用）。read 用它铸 hashline tag、引擎用它校验活文件，两边**同一份代码**，一致性是结构性的而非手工维护的；**不要**再写第二套渲染器（曾经的 TS 渲染器已删）。编码半（`readNotebookDocument` / `applyNotebookEditableText` / `serializeEditedNotebookText`）仍留在 TS，因为 native 未导出编码器、而 DSH 自有的 patch/replace/write 三条路径还需要它——把这三条也迁到 Rust 引擎后即可整体删除
- pi-natives 兼容走双轨：pnpm 补丁（patches/）+ 非.pnpm 安装的 postinstall 自愈脚本，两者都不许删
- 改动源码后必须跑完第 2 步验证链再交付
