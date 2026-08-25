# @xiaoso/dsh-tool-plus

Oh My Pi 全家桶移植为 deepseek-harness 插件：`bash`（持久 shell + minimizer + 截断 + 后台 + 拦截）+ `read` / `write` / `edit` / `grep` / `glob` / `read_image`。对齐 `@deepseek-ai/dsh 0.1.0-rc.8`（`dsh-v0.1.0-rc.8`），执行内核复用 [`@oh-my-pi/pi-natives@17.3.5`](https://www.npmjs.com/package/@oh-my-pi/pi-natives)（`brush-core` / `pi-walker` / `grep` 双引擎）与 `@vscode/ripgrep` 侧车。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

本项目是**独立 pnpm 项目**（自带 `pnpm-workspace.yaml` 与 lockfile），不修改、不引用 deepseek-harness 源码；`@deepseek-ai/*` 依赖全部 `pnpm install` 自 npm registry。项目同时是一个 **dsh profile bundle**（`dsh.bundle.patch` 声明），可用全局 `dsh` 装进自定义 profile。

## 安装与使用（需全局 `dsh`，`npm i -g @deepseek-ai/dsh`）

```sh
# 1. 安装到名为 dsh-tool-plus 的 profile（首次自动初始化，含 dsh-base + dsh-headless）
dsh plugin --profile dsh-tool-plus add link:<本目录绝对路径>

# 2. 直接跑任务
dsh --profile dsh-tool-plus "你的任务"

# 3. 交互/其它用法与任何 profile 相同
dsh --profile dsh-tool-plus
```

`cordis.patch.yml`（方案 A 全局替换）禁用 5 行官方插件并插入 `tool-plus`：

```yaml
- id: tool-bash         # bash（一次性 bash -c）
  disabled: true
- id: tool-bash-persistent  # bash（PTY 持久，同名冲突必禁）
  disabled: true
- id: tool-pwsh         # pwsh（由本包 bash 统一替代，无丢失）
  disabled: true
- id: tool-fs           # read / write / edit / read_image
  disabled: true
- id: tool-fs-search    # grep / glob（rg --json/--files）
  disabled: true
- insert:
  - id: tool-plus
    name: '@xiaoso/dsh-tool-plus'
```

`bash-sandbox` / `pwsh-sandbox` 保持挂载（服务 `ctx.shell` 能力缝，供 hooks / tmux 等）。**不要同时挂载被禁的 5 个官方包**——同名 `bash`/`read`/`grep` 会在加载期 fail-loud。

## 功能

- **bash 全家桶内核**：持久 `brush` shell（`cd`/`export` 跨调用）、输出 `minimizer`（`git/npm/cargo` 智能压缩）、截断 `head+tail` + `spill` 落盘、后台 `run_in_background` + `autoBackgroundMs`、拦截 `cat`/`grep`/`find`/`sed -i`→`read`/`grep`/`glob`/`edit`。
- **read**：`file_path` / `offset?` / `limit?`（`2000`），`50 KB` / `2000 字符` 双截断，`10 MiB` 以上 `streamText`，`fs/observed` 版本守卫。
- **write**：`file_path` / `content`（可空），`fs/write-intent` 策略槽 → `writeText` 原子落盘，`structuredPatch` 产 `FileDiff`。
- **edit**：`file_path` / `old_string`≠`new_string` / `replace_all?`，要求唯一命中（`OMP` 侧含多段 `edits[]` + 10 级 `fuzzy` + `hashline` + `patch` + `ast-edit`，薄包装已接入，全量待 `src/tools/edit/*` 减法后补齐）。
- **grep**：`pattern*` / `path?` / `include?`（单 `glob`），优先 `pi-natives.grep`（双引擎容错、`4 MiB` 窗口），回退 `rg --json` 直调（`--no-config`）。
- **glob**：`pattern*` / `path?`，`rg --files --sort=modified --no-ignore --hidden` + VCS 双排除，或 `pi-natives.glob`（`mtime` 排序、深度限界、多根并发）。
- **read_image**：`file_path` 唯一，`attachments` 挂载时注册（`ctx.inject`），`rc.8` 新增 `IMAGE_DIMENSION_TOO_LARGE` / `IMAGE_TOO_MANY_PIXELS` 维度门。
- **一工具一文件夹**：`src/tools/{read,write,edit,grep,glob,read-image,hashline,shared,bash}`，整包 `cp -r refs/oh-my-pi/...` 后减法，`_raw_omp` 保留原料。

## 模型可见契约

| 工具 | 参数 | 结果 |
|---|---|---|
| `bash` | `command*` `description*` `timeoutMs?` `workdir?` `env?` `run_in_background?` | `[exit code: N]` / `[killed]` / `[timed out]` / `[output minimized]` / `[output truncated; full output: <path>]` |
| `read` | `file_path*` `offset?` `limit?` | `<path><type>file` 包裹的 `N: text` 窗口 + `Output capped / Showing lines` 尾注 |
| `write` | `file_path*` `content*` | `{path, operation:create\|update, before, after}` + `FileDiff[]` |
| `edit` | `file_path*` `old_string*` `new_string*` `replace_all?` | 同 `write` 的 `diff` 卡，唯一命中校验 |
| `grep` | `pattern*` `path?` `include?` | `{matches: [{path,lineNumber,line}]}`，分组 `Line N:` 文本 |
| `glob` | `pattern*` `path?` | `{root, paths: string[]}`，`mtime` 排序 |
| `read_image` | `file_path*` | `{path, image:{attachmentId,mediaType,bytes,width,height}}` + `image` 块 |

## 配置（`tool-plus` 行的 `config`，均可选）

沿用 `bash-plus` 命名空间（`bash-plus` settings doc），对齐 `rc.8`：

| Key | 默认 | 含义 |
|---|---|---|
| `enableRunInBackground` | `true` | 暴露 `run_in_background` |
| `autoBackgroundMs` | `60000` | 前台自动后台化阈值（`0` 关闭） |
| `defaultTimeoutMs` | `300000` | 默认截止 |
| `maxTimeoutMs` | `3600000` | 上限 |
| `outputMaxBytes` | `51200` | 预览 tail |
| `outputSinkTailBytes` / `outputSinkHeadBytes` | `51200` / `20480` | 截断窗口 |
| `minimizer.enabled` | `true` | 输出最小化 |
| `interceptorEnabled` | `false` | 拦截 `cat/grep/find/sed -i`（自提供后常驻） |
| `nonInteractiveEnv` / `snapshotEnabled` / `useShellCommandWrapper` | `true`/`true`/`false` | 环境加固 / rc 快照 / `bash -c` 包裹 |
| `maxBackgroundJobs` | `15` | 并发上限 |

`grep`/`glob` 侧 `GREP_MAX_MATCHES=250` / `GLOB_MAX_RESULTS=100` 等为内部 caps（官方 `20 MB` RAW / `30s` 超时 / `64 KB` meta，同 `plan.md §0.2`）。

## 测试

```sh
pnpm install
pnpm run typecheck     # tsc --noEmit（include 已收窄，_raw_omp 排除）
pnpm run build         # tsc 声明 + tsdown（lib/index.mjs + lib/client.js）
pnpm run test          # 8 files / 61 tests（boot 组合含 bash 真执行）
pnpm run test:e2e
```

- 真实 `bash` 用例依赖 `bash` 在 `PATH`（Windows 为 Git Bash），缺失自动 skip。
- `e2e` 使用隔离 `DSH_HOME`，profile 名 `dsh-tool-plus`。

## Known Limitations

- **pwsh 由 bash 统一替代**：`tool-pwsh` 的 `pwsh` 不单独提供，`cordis.patch.yml` 禁用无丢失（设计决策，见 `plan.md §0.3 9/9`）。
- **streaming progress 不移植**：`write` 的 TUI `onUpdate` 流式进度为 CLI 专属，官方 `tool-fs` 亦无（原子 `writeText`/`editText`），Web 无通道，故跟随官方不支持而特别标注（`plan.md §2.2`）。
- **LSP/ACP/vault/TUI 已去掉**：按 `plan.md §2-§3` 判定，`hashline`/`conflict`/`notebook`/`markit`/`archive/sqlite` 等在 `src/tools/read|write|edit|hashline` 副本中待减法后补齐。
- **pi-natives 补丁**：`@oh-my-pi/pi-natives@17.3.5` 的 `import.meta.dir` → `import.meta.dirname`（`patches/@oh-my-pi__pi-natives.patch`）以支持 Node 22+。
