# AGENTS.md

面向 AI 助手与维护者的仓库须知。

## 项目

`@xiaoso/dsh-tool-plus`：DeepSeek Harness 基础工具增强——持久 bash、结构化 read、多模式 edit、原子 write、双引擎 grep/glob、图像直读，一个插件全覆盖（Oh My Pi 内核移植，可选 ast_grep/ast_edit）。一个 git 仓库发两个 npm 包：

| 包 | 目录 | 版本线 |
|---|---|---|
| `@xiaoso/dsh-tool-plus` | 仓库根 | 始终同版 |
| `@xiaoso/dsh-tool-plus-presets` | `presets/` | 始终同版 |

**版本号同步**：两包始终同版（拍板 2026-08-27），发布迭代时两边的 package.json 一起 `pnpm version prerelease`，谁有变更发谁。

两包 `publishConfig` 均已配 `tag: latest` / `access: public`——发布直接落在 latest 标签，`dsh plugin add`（不带 tag）默认安装与 dsh 当前版本匹配（官方 dsh CLI 同样将 latest 指向 rc 版本）。

## 发布与推送（每次迭代照此走）

```sh
# 1. 两包版本同步自增（都执行，保持一致）
pnpm version prerelease            # 在包所在目录执行

# 2. 四连验证
pnpm typecheck && pnpm build && pnpm test

# 3. 更新 CHANGELOG.md：按 Keep a Changelog 为本次版本新增一节
#    （格式沿用历史版本：## [<ver>] - <日期> + Added/Changed/Fixed/Removed
#    + 对比链接），随本版变更一起提交；不更新不得发版

# 4. 提交 + 打消歧标签（两包同仓，用前缀区分）
git commit -am "release: <pkg> v<ver>"
git tag presets-v<ver>             # 或 tool-plus-v<ver>

# 5. 推 git + 发 npm（谁有变更发谁）
git push && git push --tags        # 先推分支，再推标签（--tags 只推标签不推分支）
npm publish ./presets              # 预设包（显式路径，防 npm 把 "presets" 当包名）
npm publish                        # 主包（发布直接落 latest，无需额外参数）

# 6. 发 GitHub Release（手动，不用 workflow；notes 用 CHANGELOG 本节内容）
gh release create tool-plus-v<ver> --title "v<ver>" --notes-file <notes 文件>
```

版本对齐：插件版本号与 dsh 同版号，发布直接落在 `latest` 标签，默认安装（不带 tag）即与 dsh 匹配。README 只描述当前对应关系，不保留历史 dsh 版本号。

## 改动守则

- `refs/oh-my-pi/` 是干净的上游对照克隆，只读不动；`src/tools/hashline/engine/` 与 `_raw_omp/` 的逐字文件审计以 refs 为基准
- pi-natives 兼容走双轨：pnpm 补丁（patches/）+ 非.pnpm 安装的 postinstall 自愈脚本，两者都不许删
- 改动源码后必须跑完第 2 步验证链再交付
