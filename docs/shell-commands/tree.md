# tree

| 项 | 内容 |
|---|---|
| 一句话定位 | 以树形列出目录内容，替代 Windows 自带的 tree.com（参数完全不同） |
| 实现层 | 内建命令（brush + pi-builtins），不是外部进程 |
| 上游来源 | 上游 pin v18.12.6 / 45c35e4 没有 tree；OMP 也没有 |
| 实现位置 | vendor/oh-my-pi/overlay/crates/pi-builtins/src/treecmd.rs（1136 行，含 29 个单测） |
| 接入方式 | vendor/oh-my-pi/patches/0002-tree-integration.patch（46 行，只改 lib.rs / factory.rs / Cargo.toml） |
| 依赖 | 零新增 crate：clap、glob、uucore::format::human 都已在依赖里 |
| 测试 | 29 个单测（cargo test -p pi-builtins treecmd）；pi-builtins 全量 1309 通过 |

## 为什么自研

- command -v tree 在本机解析到 C:\WINDOWS\system32\tree.com，tree --version 会把参数当路径去列目录，-a/-L/-I 全都不认。
- 上游 pin 的 crates/pi-builtins/src 里没有 tree.rs，refs/oh-my-pi 的工具目录也没有。
- 脚本里写 tree -L 2 会静默走到 Windows 的实现上，行为与 Linux 完全不同：这是「有命令但语义错」，比缺命令更难发现。

## 能力面（已支持 30 个参数）

| 类别 | 参数 |
|---|---|
| 列目录 | -a 全部、-d 只目录、-L N 最大深度、-f 完整路径、-i 不画缩进线 |
| 过滤 | -P 只列匹配文件（目录保留）、-I 排除、--matchdirs 让 -P 也匹配目录名、| 分隔多模式、--gitignore 用根级 .gitignore、--gitfile 指定 ignore 文件 |
| 显示 | -F 类型标记、-s 字节大小、-h 人类可读、--si 十进制单位、-q 不可打印字符显示为 ?、-N 原样输出、-Q 双引号包裹 |
| 排序 | -r 反序、--dirsfirst 目录优先、--sort=name|size|time、-t 按修改时间 |
| 结构 | -l 跟随目录符号链接（带环路检测）、--filelimit=N 条目过多不展开、--prune 剪掉过滤后为空的目录 |
| 大小 | --du 目录累计大小（隐含 -s，汇总行附总字节数） |
| 时间 | -D 打印修改时间（本地时区，默认 %b %e %H:%M）、--timefmt FORMAT 自定义 strftime 格式 |
| 线条 | -A / -S / --charset=ascii 切换 ASCII 线条 |
| 输出 | -o FILE 写入文件（相对路径按 shell cwd 解析）、--metafirst 元数据列前置、-C 强制彩色、-n 关闭彩色、--noreport 不打印汇总 |
| 其它 | -v 版本、--help 帮助 |

## 与参考实现的差异

| 项 | 本实现 | 参考 tree 2.1 |
|---|---|---|
| -A / -S | 都表示「用 ASCII 线条」 | -A 是 ANSI 画线补丁、-S 是线条集开关，语义不同 |
| 非打印字符 | 默认原样输出；-q 显示为 ?；-N 是同义空操作 | 默认打印 \ooo 转义，-N 才原样 |
| 符号链接 | 默认不跟随，显示 name -> target（与参考一致）；--du 不计入链接自身 | 相同 |
| -F 标记 | 目录 /、可执行 *、符号链接 @ | 还有 socket =、FIFO |、doors > |
| -h 与 --si | -h 用 1024；--si 用 1000 | 相同 |

## 仍然拒绝的参数（报可读原因，不静默）

| 参数 | 原因 |
|---|---|
| -p -u -g --inodes | 本平台没有 POSIX 权限位 / 所有者 / 组 / inode |
| -X -J -H -T -R | 结构化输出与递归 HTML 未实现 |
| -c | 状态变更时间（ctime）在本平台不可用 |
| -x | 跨文件系统判断在本平台无意义 |
| --skip-ignore | 不属于 tree 2.1 的选项，未声明 |
| --info --infofile --fromfile --fromtabfile | .info 注释与文件输入未实现 |

全部在 UNSUPPORTED 表里声明给 clap，运行时统一拒绝，不会出现 unexpected argument；表与文档同一份来源。

## 设计要点

- 显式栈而非递归：walk() 用 Vec<Frame>，深目录不爆栈（与 tree-rs 同款做法）。
- 惰性 stat：只有 -s/-h/--du/-t 才取 metadata；Windows 上 DirEntry::file_type() 不产生额外系统调用。
- 相对路径按 shell 的 cwd 解析（根路径与 -o 目标都是），不是进程 cwd。
- -P 只过滤文件，目录保留，否则子目录里的匹配项永远到不了（--matchdirs 才让目录参与）。
- 输出先写进内存缓冲，-o 时一次落盘，避免半截文件。

## 测试与验证

- cargo test -p pi-builtins treecmd → 27 通过（1 个 unix-only 符号链接用例在 Windows 上 ignored）
- cargo test -p pi-builtins → 1307 通过（无回归）
- 覆盖：嵌套连接线、-a、-d、-L、-I、-P、-F、-s、--noreport、-i、-r、--dirsfirst、--filelimit、--prune、--du、-o、-Q、--matchdirs、--sort=size、-S、-D/--timefmt、--metafirst、--gitignore、--gitfile、-v、路径不存在、拒绝项报原因
- 真实 shell 通道：runs_inside_a_real_shell 用 brush 的 Shell::builder 构建真 shell、跑脚本 `tree -L 1 -F .`，经解析器与 builtin 分发验证（比 run_util 更接近真实调用）
- 变异验证：把 -a 的判断改成永远跳过隐藏文件 → all_includes_hidden_entries 变红，恢复后全绿
- 性能：同一目录（vendor/oh-my-pi，56,681 行输出）内建 2,333 ms vs Windows tree.com 2,241 ms，慢约 4%，在噪声范围内；口径不完全对等（tree.com 输出到 NUL，内建捕获进内存）

## 局限与后续

- **真实 brush shell 已验证**（`runs_inside_a_real_shell`）；**编译后的 native addon 已端到端验证**（2026-11-14）：
  - 方式：release 构建 → 打版本戳 → 放进 leaf 包的 `.node` 位置 → `PI_E2E_EXPECT_TREE=1 pnpm e2e`
  - 结果：**24 项全过**，其中 `步骤 1 bash` 的断言是 `echo MOCK_E2E_BASH_OK; tree --version`，要求输出里出现 `tree 1.`；验证前 `type -a tree` 只返回 `C:\WINDOWS\system32\tree.com`，验证后返回 `tree is a shell builtin`
  - 完整配方见下方「在真 addon 里验证」
- 待补：无低成本项；剩余拒绝项都属于平台限制或高成本

## 在真 addon 里验证

```sh
# 1. 构建（需要 cmake + ninja；wasmtime 等 release 依赖耗时 10 分钟以上）
cd vendor/oh-my-pi/upstream
cargo build --release -p pi-natives

# 2. 打版本戳：源码里的 stamp 槽是 64 字节占位（magic + 全 0），
#    不打戳的话 loader 会以「版本不符」拒绝加载，表现为插件整体不激活
node scripts/stamp-pi-natives.mjs target/release/pi_natives.dll target/release/pi_natives.stamped.dll 18.12.6

# 3. 替换 leaf 包的 addon（先备份，验证后还原）
L=node_modules/.pnpm/@oh-my-pi+pi-natives-win32-x64@18.12.6/node_modules/@oh-my-pi/pi-natives-win32-x64/pi_natives.win32-x64-baseline.node
cp "$L" "$L.bak"
cp vendor/oh-my-pi/upstream/target/release/pi_natives.stamped.dll "$L"

# 4. 跑 e2e（dsh 必须用与插件兼容的 0.2.2）
PI_E2E_EXPECT_TREE=1 DSH_BIN='node D:/program/nvm/v24.22.2/node_modules/@deepseek-ai/dsh/lib/bin.js' pnpm e2e

# 5. 还原
mv "$L.bak" "$L"
```

两个容易踩的点：

1. **版本戳**——`crates/pi-natives/src/lib.rs` 的 `VERSION_STAMP` 是编译期占位（magic + 全 0），官方发布流程会在链接后写入版本号。自己编的 dll 不打戳，loader 会判定「没有 release identity」而拒绝，现象是插件的 8 个工具全部不注册（`Error: unknown tool "bash"`）。`scripts/stamp-pi-natives.mjs` 就是把 `18.12.6\0` 写进那个槽。
2. **feature 要一路打开**——`crates/pi-natives/Cargo.toml` 里 `pi-builtins = { features = ["util.grep", "util.tree"] }`，只给 pi-builtins 自己的 Cargo.toml 加 `util.tree` 不够；这条已包含在 0002 补丁里。
## 维护

- 升上游 pin 后重跑 pnpm vendor:apply，确认 0002 仍能应用（只改三处：mod treecmd;、factory 注册、Cargo feature）
- 代码全在 overlay/，不动 vendored 上游文件；删除条件：上游自己实现了 tree