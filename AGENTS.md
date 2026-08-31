# AGENTS.md

面向 AI 助手与维护者的仓库须知。

## 项目

`@xiaoso/dsh-tool-plus`：DeepSeek Harness 基础工具增强——持久 bash、结构化 read、多模式 edit、原子 write、双引擎 grep/glob、图像直读，一个插件全覆盖（Oh My Pi 内核移植，可选 ast_grep/ast_edit）。一个 git 仓库发两个 npm 包：

| 包 | 目录 | 版本线 | 当前 |
|---|---|---|---|
| `@xiaoso/dsh-tool-plus` | 仓库根 | 锁步 | 0.1.0-beta.7 |
| `@xiaoso/dsh-tool-plus-presets` | `presets/` | 锁步 | 0.1.0-beta.7 |

**版本号锁步**：两包始终同版（拍板 2026-08-27），发布迭代时两边的 package.json 一起 `pnpm version prerelease`，谁有变更发谁。

两包 `publishConfig` 均已配 `tag: beta` / `access: public`——测试期一切发布只落 beta 标签。

## 发布与推送（每次迭代照此走）

```sh
# 1. 两包版本锁步自增（都执行，保持一致）
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
git push --tags
(cd presets && npm publish)        # 预设包
npm publish                        # 主包
```

转正流程：发无后缀版本 → `npm dist-tag add <pkg>@<版> latest` → README 删去 `@beta` 后缀与顶部测试声明。

## 改动守则

- `refs/oh-my-pi/` 是干净的上游对照克隆，只读不动；`src/tools/hashline/engine/` 与 `_raw_omp/` 的逐字文件审计以 refs 为基准
- pi-natives 兼容走双轨：pnpm 补丁（patches/）+ 非.pnpm 安装的 postinstall 自愈脚本，两者都不许删
- 改动源码后必须跑完第 2 步验证链再交付
