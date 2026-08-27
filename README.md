# dsh-tool-plus — DeepSeek Harness 工具全家桶

DeepSeek Harness 的工具增强插件：一个插件提供完整工具链——持久 shell 的 `bash` 加上 `read` / `write` / `edit` / `grep` / `glob` / `read_image` 文件全家桶（可选 `ast_grep` / `ast_edit`）。基于 [Oh My Pi](https://github.com/can1357/oh-my-pi) 内核移植，安装后自动接管官方 bash / pwsh / 文件 / 搜索工具。

> 当前为早期测试版：发布走 `beta` 标签（如 `0.1.0-beta.1`），行为与配置可能随时调整。

## 功能特性

- **一个插件替代四个官方工具包**：加载时自动禁用官方 `tool-bash` / `tool-pwsh` / `tool-fs` / `tool-fs-search` 并挂载本插件，工具一次配齐，无同名冲突
- **持久 bash + 后台任务**：`cd` / `export` 跨调用保持状态；git/npm/cargo 日志自动压缩（minimizer）；超长输出 head+tail 截断 + 全量落盘回读；支持手动与自动转后台
- **省 token 的 read**：大代码文件默认返回 AST 结构摘要（正文折叠），需要细节再按区间展开；归档 / SQLite / notebook / PDF 直接读
- **edit 单工具多模式**：replace 为默认，另支持 unified patch / hashline / apply-patch 格式，多段编辑、唯一性守卫与模糊匹配
- **搜索与图片**：grep / glob 双引擎（ripgrep + pi-natives），mtime 排序、上下文行可配；read_image 直读图片，超大图自动缩放
- **命令拦截引导**：模型尝试 `cat` / `grep` / `find` / `sed -i` 时被拦截并引导改用专用工具（可开关）
- **两套 agent 预设**：标准增强版、PTC（Code Mode）增强版，一条命令安装

## 推荐环境与配置

- **完全权限模式**：建议在 `danger-full-access` 下使用本插件，可避免沙箱模式下文件写入被误拦。

## 安装

插件与预设**都要安装**：

- **工具插件**：提供全套工具，加载时自动接管官方 bash / pwsh / 文件 / 搜索工具；
- **agent 预设**：官方预设里没有这些工具的配置，直接用默认配置会缺能力——标准版 / PTC 两套模板就是来补齐这块的。

### 从 npm 安装（推荐）

```sh
dsh plugin --profile dsh-tool-plus add @xiaoso/dsh-tool-plus@beta
```

### 从 GitHub 安装

跟踪最新开发版（本项目现阶段没有正式发布，一切安装均为测试构建）：

```sh
dsh plugin --profile dsh-tool-plus add github:xiaoso456/dsh-tool-plus
```

### 本地开发

```sh
dsh plugin --profile dsh-tool-plus add link:<本仓库路径>
```

### 预设安装

**方法一 · 一条命令**

```sh
npx @xiaoso/dsh-tool-plus-presets@beta
```

**方法二 · 提示词交给大模型**（不依赖上面的包）——把下面这段发给一个能改你电脑上文件的 AI 会话：

```text
请为我安装 DeepSeek Harness 的两个增强 agent 预设。

1. 找到全局 dsh 包内的官方预设目录 config/agent-presets/，其中有 standard 与 code 两套模板，
   各含 preset.yml 和 agent.cordis.yml。（Windows 在 npm 全局 node_modules\@deepseek-ai\dsh\ 下；
   macOS/Linux 先跑 npm root -g 定位；找不到就全盘搜索已安装的 @deepseek-ai/dsh 包。）
2. 在 ~/.dsh/.agent-presets/ 下新建 tool-plus-standard 与 tool-plus-ptc 两个目录。

3. tool-plus-standard：把官方 standard 的两个文件复制过来，然后修改：
   - preset.yml 整个替换为：
       name: Tool Plus 标准增强版
       description: 标准模式全部能力，文件/Shell 工具集替换为 @xiaoso/dsh-tool-plus，pwsh 默认禁用
       order: 2
   - agent.cordis.yml：
     a. 把 id: tool-bash 的条目改为
          - id: tool-plus
            name: '@xiaoso/dsh-tool-plus'
            disabled: true
     b. 把 id: tool-pwsh 条目的平台条件禁用改成固定一行 disabled: true
     c. 整块删除 id: tool-fs 和 id: tool-fs-search 两个条目（后者还带 sampleOverCapGlobResults 配置）

4. tool-plus-ptc：把官方 code 的两个文件复制过来，做第 3 步完全相同的三处修改，
   但 preset.yml 替换为：
       name: Tool Plus PTC 增强版
       description: PTC(Code Mode) 全部能力，文件/Shell 工具集替换为 @xiaoso/dsh-tool-plus，pwsh 默认禁用
       order: 3

5. 完成后列出这两个目录的文件树，并提醒我重启运行中的 dsh 让预设生效。
```

两法效果相同：文件落到 `~/.dsh/.agent-presets/`，重启 dsh 后在会话里选用预设即生效。

## 配置

settings 命名空间 `tool-plus`，开箱即用无需配置。常用调整项：后台阈值（`autoBackgroundMs`）、超时（`defaultTimeoutMs` / `maxTimeoutMs`）、输出截断窗口（`outputSinkTailBytes` 等）、编辑默认模式（`editMode`，默认 `replace`）、read 结构摘要开关（`readSummarizeEnabled`）。

## 环境要求

- **dsh CLI**：需全局安装，`npm i -g @deepseek-ai/dsh`
- **Node.js** ≥ 22.19 或 ≥ 24（`package.json` 的 `engines` 要求）
- **Git Bash**（推荐）：Windows 上作为 bash 执行环境
- 适用于 DeepSeek Harness `dsh` v0.1.1-rc.2（pre-release，接口可能变动）

## 注意事项

- 不提供单独的 `pwsh` 工具：shell 场景由功能更全的持久 `bash` 统一承担

## 构建

```sh
pnpm install
pnpm build     # tsc 声明 + tsdown 打包 + 资产复制
pnpm typecheck
pnpm test      # 含真实 bash 用例，Windows 需 Git Bash，缺失自动 skip
```

## License

[MIT](LICENSE)，第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
