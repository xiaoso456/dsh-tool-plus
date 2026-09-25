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

版本对齐：插件 peer 精确 pin 与 dsh 同版号。**注意 0.1.7 起宿主按 peer 拒绝加载不匹配的插件**，而 npm `latest` 上 `@deepseek-ai/dsh` 还停在 `0.1.5-rc.3`——pin `0.1.7-rc.2` 的插件版本**只能发 `next`/`beta`**，发 `latest` 会拒绝所有默认安装的用户。README 只描述当前对应关系，不保留历史 dsh 版本号。

## 改动守则

- `refs/oh-my-pi/` 是干净的上游对照克隆，只读不动；当前 HEAD 已升至 `v18.1.17`（旧基线 `v17.3.5` tag 保留可回溯）。**hashline 不再 vendored**：上游 18.x 删除 TS `packages/hashline`、把编辑引擎重写为 Rust `crates/pi-edit`（经 `@oh-my-pi/pi-natives` 暴露），我们只保留薄适配层 `src/tools/hashline/native/`（`diff-preview.ts` 为旧 TS 逐字移植）；`_raw_omp/` 等其余移植件的逐字审计基准是 `v17.3.5` tag，其余工具按 refs 当前 HEAD 对照
- **引擎拥有序列化，宿主只落字节**：`EditWriteRequest.content` 已是最终字节序列（notebook 的 nbformat JSON 由 Rust `files.rs::persist` 生成），`native/writer.ts` 必须逐字落盘；**不要**在写盘腿上再调 `serializeEditFileText`（那是旧 TS 引擎的契约，会把引擎的 JSON 当可编辑文本再解析，导致每次 `.ipynb` 编辑报 `Invalid notebook editable representation`）
- **notebook 只留一套解码器**：解码走引擎自身——`omp/edit/notebook.ts::readEditableNotebookText` 委托 `pi-natives` 的 `notebookToEditableText`（上游 `tools/read.ts` 同款调用）。read 用它铸 hashline tag、引擎用它校验活文件，两边**同一份代码**，一致性是结构性的而非手工维护的；**不要**再写第二套渲染器（曾经的 TS 渲染器已删）。编码半（`readNotebookDocument` / `applyNotebookEditableText` / `serializeEditedNotebookText`）仍留在 TS，因为 native 未导出编码器、而 DSH 自有的 patch/replace/write 三条路径还需要它——把这三条也迁到 Rust 引擎后即可整体删除
- pi-natives 兼容走双轨：pnpm 补丁（patches/）+ 非.pnpm 安装的 postinstall 自愈脚本，两者都不许删
- 改动源码后必须跑完第 2 步验证链再交付
