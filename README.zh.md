# @xiaoso/dsh-tool-plus

Oh My Pi 全家桶移植为 deepseek-harness 插件：`bash`（持久 shell + minimizer + 截断 + 后台 + 拦截）+ `read` / `write` / `edit` / `grep` / `glob` / `read_image`。对齐 `@deepseek-ai/dsh 0.1.0-rc.8`（`dsh-v0.1.0-rc.8`），内核复用 [`@oh-my-pi/pi-natives@17.3.5`](https://www.npmjs.com/package/@oh-my-pi/pi-natives)（`brush-core` / `pi-walker` / `grep` 双引擎）与 `@vscode/ripgrep` 侧车。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

**独立 pnpm 项目**，不改、不引 deepseek-harness 源码；`dsh profile bundle`（`dsh.bundle.patch`）可用全局 `dsh` 装进自定义 profile。

## 安装与使用（需全局 `dsh`）

```sh
dsh plugin --profile dsh-tool-plus add link:<本目录绝对路径>
dsh --profile dsh-tool-plus "你的任务"
```

`cordis.patch.yml`（方案 A）禁用 5 行官方插件并插入 `tool-plus`：

| id | 包 | 工具 | 说明 |
|---|---|---|---|
| `tool-bash` | `dsh-tool-bash` | `bash` | 一次性 `bash -c`，被全量替换 |
| `tool-bash-persistent` | `dsh-tool-bash-persistent` | `bash` | PTY 持久（同名必禁） |
| `tool-pwsh` | `dsh-tool-pwsh` | `pwsh` | 由本包 `bash` 统一替代，无丢失 |
| `tool-fs` | `dsh-tool-fs` | `read/write/edit/read_image` | 薄包装已接入 |
| `tool-fs-search` | `dsh-tool-fs-search` | `grep/glob` | 由 `pi-natives`/`rg` 自研替代 |

`bash-sandbox` / `pwsh-sandbox` 保持挂载（`ctx.shell` 缝）。覆盖度 `9/9`，详见 `plan.md §0.3`。

## 预设（agent presets）：标准增强版 / PTC 增强版

仓库 `presets/` 一个文件夹收录全部预设资产（脚本 + 两份模板）。安装到 `${DSH_HOME:-~/.dsh}/.agent-presets/`：

```sh
pnpm run presets:install            # 可重入：一致跳过、本地改动保留、缺的补装
pnpm run presets:install:force      # 把改过的文件恢复为模板原件
```

模板里 `tool-plus` 行默认 `disabled: true`——host 平面（bundle patch）已全局注册，预设层重复挂载会遮蔽宿主实例（web 环境 settings 注入不触发）。文件夹名即预设 ID：`tool-plus-standard` / `tool-plus-ptc`。详见 `presets/tool-plus-standard/agent.cordis.yml` 头注释。

## 功能

- **bash**：持久 `brush` shell、`minimizer`、`截断+spill`、`run_in_background` + `autoBackgroundMs`、`cat/grep/find/sed -i` 拦截（自提供后常驻）。
- **read**：`file_path` / `offset?` / `limit?`（2000），`50KB`/`2000字符` 双截断，`10MiB` 以上 `streamText`。
- **write**：`file_path` / `content`，`fs/write-intent` → `writeText` 原子，`structuredPatch` 产 `FileDiff`。
- **edit**：`file_path` / `old_string`≠`new_string` / `replace_all?`，唯一命中；全量 `edits[]`/`fuzzy`/`hashline`/`patch`/`ast-edit` 待副本减法后补齐。
- **grep**：`pattern*` / `path?` / `include?`，`pi-natives.grep` 优先，回退 `rg --json`。
- **glob**：`pattern*` / `path?`，`rg --files --sort=modified --no-ignore --hidden` + VCS 双排除。
- **read_image**：`attachments` 挂载时注册，`rc.8` 维度门 `IMAGE_DIMENSION_TOO_LARGE` / `IMAGE_TOO_MANY_PIXELS`。
- **一工具一文件夹**：`src/tools/{read,write,edit,grep,glob,read-image,hashline,shared,bash}`，`cp -r refs/oh-my-pi/...` 后减法，`_raw_omp` 保留原料。

## 配置

`tool-plus` 配置沿用 `bash-plus` 命名空间：`enableRunInBackground` / `autoBackgroundMs` / `defaultTimeoutMs` / `maxTimeoutMs` / `outputMaxBytes` / `outputSink*` / `minimizer` / `interceptorEnabled` / `nonInteractiveEnv` / `snapshotEnabled` / `useShellCommandWrapper` / `maxBackgroundJobs` 等（见 `plan.md §6`）。`grep`/`glob` 内部 caps `GREP_MAX_MATCHES=250` / `GLOB_MAX_RESULTS=100` / `RAW 20MB` / `30s` 超时等（`plan.md §0.2`）。

## 测试

```sh
pnpm install
pnpm run typecheck
pnpm run build
pnpm run test          # 8 files / 61 tests
```

## 已知限制

- `pwsh` 由 `bash` 统一替代，`streaming progress`（TUI `onUpdate`）跟随官方不支持而特别标注不移植，`LSP/ACP/vault/TUI` 已去掉，`hashline` 等待减法后补齐。详见 `plan.md §2.2` / `§0.3`。
