# Changelog

本文件记录 `@xiaoso/dsh-tool-plus` 的版本更新。（`@xiaoso/dsh-tool-plus-presets` 已于 2026-09-20 退役，不再发新版。）

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.3.0-beta.2] - 2026-11-23

> 测试版：bash 工具描述去重，行为无变化。

### Changed

- **bash 工具描述删掉重复的 `[exit code: N]` 说明**：这句与 `tool:bash` 系统提示段重复，现在只留在系统提示里（官方 `dsh-tool-bash` 同样只在提示段讲 marker）；非零退出的 marker 渲染与检查要求不变。

## [0.3.0-beta.1] - 2026-11-23

> 测试版：修提示词段顺序，标准与 PTC 两个预设都回到官方顺序。

### Fixed

- **工具用法段的提示词顺序**：六段（bash、read、write、edit、glob、grep）原先沿用 dsh 0.1.x 的序号 `100–105`，上游改成集中分配表后，它们在 PTC 下排到了「`run_code` 是唯一可直调工具」之前，plan 策略（500）与文件引用（900）也被越过；bash 还落在逐工具指导的末尾。现按官方位置落到 `TOOL_BASH 1000 → TOOL_GREP 1500`：模式规则在前、bash 回到首位，标准与 PTC 同时修正。数值集中在 `src/tool-section-orders.ts`，另有单测钉在宿主分配表上，上游改号会在测试里先红。

## [0.3.0-beta.0] - 2026-11-22

> 测试版：把 read / grep / glob / edit / write 的能力面按上游 Oh My Pi 18.12.6 重做了一遍，另加两组实验性开关。

### Added

- **read / grep / ast_grep 支持 URL 目标**：含内联行选择器（`:50-80`、`:5`、`:-20`、逗号多段）与 `:raw`。取回的内容先落到本会话的产物目录，再走原有的搜索与路径切片。
- **read 认识更多文件类型**：归档（zip、tar、7z 等二十余种）、EPUB、PPTX、XLSX、JSON 与 JSONL。JSON 支持 `?q=`、`?raw`、`?compact`、`?offset=`、`?limit=`。
- **patch 模式与上游对齐**：参数收 `{ path, edits: [{ op, rename, diff }] }`，`op` 可取 `update`（缺省）、`create`、`delete`；同一条目里 `rename` 加 `update` 表示改名。原先的 `patch` 字符串别名删除。
- **glob 条数可配**：设置页新增「默认条数」与「上限」，默认 100、上限 200（硬顶 2000）。请求超过上限时按上游措辞提示已夹取。
- **实验性开关**（设置页新增「实验性」tab）：「多条目预检」默认关，写盘前在内存里把所有条目试算一遍，任一失败整体拒绝并列出失败条目；「详细失败提示」默认开，匹配失败时附最接近的整块，可直接当 `old_string` 重试。
- **写入通道与重试可配**：`writeBackend` 可选 DSH 原子写（默认）或上游原生直写，edit 与 write 共用同一通道；`writeRetryEnabled` 与 `writeRetryCount` 控制重试。

### Changed

- **ast_edit 改成默认关闭**：上游默认开启，但实测 909 个会话、17.4 万次工具调用里只用了 21 次（1.5% 的会话碰过），却让每个会话多付约 271 token 的工具描述。要用的在设置页「ast_edit」组打开，跟 ast_grep 的默认值就此一致。
- **九份工具提示词与上游逐字节相同**：read、write、grep、glob、ast_grep、ast_edit、replace、patch、apply_patch 的正文与上游 18.12.6 完全一致，差异只剩 sanitize 层删掉的几句，逐条记在进度文档。默认工具面（ast_grep 关闭）合计 5830 字符，约 1458 token。
- **URL 读取的行数上限改跟 `read.defaultLimit`**：上游写死 300 行，与本地的 read 设置不一致，这里统一。
- **Windows 下小写字面 `/tmp` 映射到宿主临时目录**，bash 的 workdir、前导 `cd`、失效的 `state.cwd` 同一规则。
- **edit 的路径参数统一叫 `path`**，并只暴露当前 `editMode` 用得到的参数。

### Fixed

- **会话目录失效时 bash 的报错**：启动 shell 前校验最终 cwd，失效时明确提示改用绝对 `workdir` 或 `cd "<绝对路径>" && ...`，不再注册注定失败的作业。
- **edit 模糊匹配补齐弯引号归一化**：之前漏掉 `“ ” ‘ ’`、不换行空格与零宽字符，现在复用同一张替换表；纯 ASCII 行另走快路径，归一时间从约 2507ns 降到约 600ns。
- **提示词里三处与实现不符的说法**：glob 承诺了实际不可用的 internal URL、replace 声称「改前没读过会报错」、patch 的三种失败措辞与引擎实际输出不符，均已改正。

### 说明

- 这批改动只动根包的 JS，原生平台包沿用 `18.12.6-plus.2`。

[对比 0.2.2-beta.0](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.2.2-beta.0...tool-plus-v0.3.0-beta.0)

## [0.2.2-beta.0] - 2026-11-21

> 测试版：修 Linux / macOS 上插件 bash 找不到工具链的问题。

### Fixed

- **POSIX 上 bash 丢掉了宿主的 PATH**：生成 shell 快照的子 shell 之前只拿到一份几乎空的环境，bash 于是把编译期默认值（`/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`）写进了快照；这份快照在会话创建时是最后才被加载的，正好盖掉从进程环境继承来的那份 PATH。结果是镜像通过 ENV 加的目录（`/usr/local/cargo/bin`、`/usr/local/go/bin`、JDK 的 bin、conda 的 `python3`）全部消失，`cargo`、`go`、`python3`、`javac` 一律 `command not found`。现在生成快照的子 shell 从宿主环境起步，再叠加 shell 配置，快照里的 PATH 就是真实 PATH 加上用户 rc 自己的调整。Windows 不受影响，那边本来就是最小快照、没有 PATH 这一行。

### 说明

- 这个测试版只动了根包的 JS，原生平台包不重新发布，装的时候沿用 `18.12.6-plus.2`。

[对比 0.2.1](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.2.1...tool-plus-v0.2.2-beta.0)

## [0.2.1] - 2026-11-20

> 修一个偶发故障：插件刚被重载或刚升级时，执行 bash 偶尔直接报错、命令一条都没跑。现在照常执行。

### Fixed

- **重载或升级后 bash 偶发无法执行**：宿主重载插件或升级版本之后，模型手里的工具还是重载前那份，调用时拿不到 shell 环境服务，整条命令直接失败。现在拿不到就是拿不到，命令照常执行，只是这一次不会带上插件注入的环境变量（`DSH_HOME`、`DSH_PROFILE` 这几个）。同时在宿主日志里记一条警告并带上会话 id，下次要排查能直接看到。

### 说明

- 这类失败只会出现在重载和升级之后的短暂窗口里，重启一次 dsh 就不会再碰到。README 的安装一节已补上这条提醒。

[对比 0.2.0](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.2.0...tool-plus-v0.2.1)

## [0.2.0] - 2026-11-20

> 正式版：原生工具包改由插件自己分发，装上即自带 `zip`、`tree`、`bc`、`gzip` 等系统里常缺的命令；bash 增加 Shell 预热，常用命令不用再等初始化；设置里新增命令面板与路径浏览弹窗。

### Added

- **内建命令开箱可用**：`zip`、`tree`、`bc`、`gzip`、`zstd`、`xz` 等 19 条系统里常缺的命令随插件自带，参数尽量对齐各自的原版工具，做不到的会当场说明原因而不是静默忽略。安装时按平台自动装上对应的原生包，没有额外步骤。
- **Shell 预热**：每个会话第一次执行 bash 之后，插件在后台预建几个已经初始化好的空闲 Shell，后面的命令直接拿现成的用，省掉启动与执行初始化脚本的开销；用掉会自动补足。设置 → Tool Plus → Bash 里有独立的「Shell 预热」一组，可以开关、改每个会话保留几个、以及空闲多久回收。实测常用命令的等待从一两百毫秒降到几毫秒。
- **Windows 路径**：`/cygdrive/c/...` 形式的 Cygwin 路径现在能用了，和 `/c/...`、原生 `C:\...` 混着写都行；读文件、跑程序都认，命令输出仍然保持原生写法。
- **命令面板**（设置 → Tool Plus → Bash → 命令）：把 bash 里能跑的每条命令按来源分开，能看到它实际解析到哪个程序、有没有被同名命令遮住、现在是启用还是被替换。可以逐条指定用插件内建、系统程序，或者自己挑一个可执行文件；也能试跑一次看真实输出，或者一键恢复默认。重名、非法名字、路径不存在都在面板里当场报出来。
- **路径字段可以浏览选文件**：要填绝对路径的地方右边多了「选择…」，弹窗照宿主的目录选择器做，面包屑可点、也能直接输入路径，键盘上下键、首字母跳转都能用。列表只放文件夹和可执行文件，可以切换成显示全部文件。
- **「增强工具包」状态行**：显示这次实际加载的是不是我们的构建、包名与版本，旁边可以「重新检测」；没加载上时按原因给出下一步。

### Changed

- **安装回到一条命令**：Windows 上给宿主补一个不可见控制台的逻辑改由我们自己的原生包完成，插件不再依赖带构建脚本的第三方库，安装时不需要再放行任何构建脚本。
- **原生包独立版本线**：与插件版本解耦，以后升级插件只下载几 MB，不会重新拉上百 MB 的原生包；构建矩阵收敛到上游实际发布的六个平台。
- **Windows 上 bash 起得更快**：以前每条命令都要探测一次 Git 的安装位置，现在探测结果会复用；注册表里已经登记了 Git 的机器连这一步都跳过。单条命令的启动开销从一两百毫秒降到二三十毫秒。
- **预设基线跟随官方 0.2.2-rc.3**：官方给基线加了办公工具行、子代理中断开关与技能目录，我们的差异保持不变，只是跟着走。宿主版本下限同步抬到 rc.3，旧宿主在安装阶段就被明确拒绝，不会装上来再把预设弄坏。
- **命令面板与浮层的外观和交互**：子页签改成二级下划线并固定在内容顶部，滚动长页不跟着跑；浏览弹窗改用宿主同一套遮罩、层级与焦点管理，外观与宿主的「选择工作区目录」对齐；换一条命令时右侧详情块不再闪。
- **「增强工具包」状态收成单行卡片**：折叠时只有一行结论，展开才显示用途说明与完整句子；正常态用主标签色，只有尚未加载与出错才换色。

### Fixed

- 桌面端每条命令都会闪一下控制台窗口：旧版本留下的原生包副本一直遮住新装的那一份，现在只有同一份构建的副本才允许排在前面。
- 原生包文件缺失或装了一半时，不再因为无从比较而拒绝可用的缓存副本，避免整个插件加载失败。
- `cd` 进某个目录后直接跑 `./xxx.exe` 这类相对路径命令，现在按 shell 的当前目录找程序，不再按宿主的进程目录。
- 浏览弹窗被自己的遮罩层盖住、Esc 键归属打架、关窗后焦点掉到页面底部这几处浮层问题。
- 设置页「增强工具包」的说明不再写死内建命令数量，省得以后加了命令又对不上。

### Removed

- 去掉安装期改写官方原生包的做法，不再依赖改写第三方包里的文件。

### 说明

- 没有对应原生包构建的平台（例如 Alpine / musl）会自动回落到官方原版，内建命令不可用，设置页会说明原因。

[对比 0.1.21](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.21...tool-plus-v0.2.0)

## [0.2.0-beta.3] - 2026-11-18

> 预发布：设置里多了一个命令面板，路径字段可以直接浏览选文件；「增强工具包」状态行开始报**实际加载的那一份**。

### Added

- **命令面板**：设置里多一个「命令」页，把 bash 工具能用的命令按来源分三层：插件内建的（`bash`、`read`、`edit`、`grep` 这些）、系统 PATH 里的（这台机器 1185 条，可按来源筛）、以及自己加的可执行文件。每条看得到实际解析到的路径、被哪个同名命令遮住、现在是启用还是被替换；能试跑一次看真输出，也能一键恢复默认。自定义命令写进 `$DSH_HOME/tool-plus/commands.json`，重名、非法名字、路径不存在都在面板里当场报出来。
- **路径字段可以浏览选文件**：要填绝对路径的字段（比如「我的可执行文件」）右边多了「选择…」。弹窗照宿主自己的目录选择器做：面包屑可点、点铅笔直接敲路径、行高 28、文件夹带箭头、文件带大小，只列文件夹和 `.exe/.cmd/.bat/.com`，一个开关可以切到全部文件。定宽 680、定高 500，空目录、读不到、读取中三种状态都画在列表区里，换目录时整窗位置一像素不动。
- 列表支持键盘：上下键、Home/End、PgUp/PgDn、回车进目录或确认、Backspace 与左键回上一级、打首字母跳转。

### Changed

- **浏览弹窗改用宿主的 `Modal`**：遮罩、层级、Esc、Tab 圈定、关闭后的焦点归还都交给宿主那一套，自己不再实现浮层。外观与宿主「选择工作区目录」弹窗对齐（680×500、标题 16px、面包屑行、底栏 16/24）。
- **设置页的子页签改成二级下划线并固定在内容顶部**：滚动长页时页签不跟着跑，切页不再整块重排。
- **命令面板与浮层的动效**：换一条命令不再重放详情块的淡入，浮层进出场统一走 transition（用关键帧做退场拿不到起始值）。
- **「增强工具包」状态改成按运行期实际加载的 addon 判断**：以前只看「平台包装没装、版本是多少」，装了一堆却在跑别处的旧副本也照样显示已加载。现在把实际加载路径算进去——路径落在平台包目录内，或与包内某个 `.node` 大小一致，才算我们的构建；否则报「加载的不是我们的构建」并在展开区给出实际路径。
- **状态行收成单行卡片**：分组标题「增强工具包」+ 描边卡片，跟「预设」「对话卡片」同一套外壳。折叠时只有一行结论（`已加载 {version}` / `加载的不是我们的构建` / `尚未加载`），展开才显示用途说明与完整句子（包名、版本、实际路径）。
- 正常态改用主标签色（它现在是这一行的正文），只有「尚未加载」用三级色、出错才上红。
- **预设基线同步到 dsh 0.2.2-rc.3**：官方这两版（rc.2/rc.3 内容一致）给基线加了三个东西——两个预设都多一行 `tool-office`（`@deepseek-ai/dsh-tool-office`）、`tool-subagent-control` 加 `interrupt: false`，standard 的 `skill-filesystem` 再加 `customSkillDirs`（指向 `dsh-agent-preset` 自带的技能目录）。我们的 delta 一个字节没动，只是跟着基线走。
- **`engines.dsh` 抬到 `>=0.2.2-rc.3`**：新基线引用的 `dsh-tool-office` 从 0.2.2-rc.2 才存在，而 npm `latest` 还停在 rc.1——老宿主挂上会整份预设加载失败。现在下限对齐到我们核验过的 rc.3，旧宿主在安装阶段就被明确拒绝（`incompatible-version`），不会装上来再坏。
- **浏览弹窗的宿主 CSS 冲突改名**：宿主的排版样式里有一份 `.tpp-body`（`max-width:65ch`）会命中同类名前缀，弹窗列表一度只剩 420px 宽。类名前缀统一改成 `tpx-`。

### Fixed

- 平台包自己的 `.node` 不存在时（装了一半、文件被隔离），不再因为「无从比较大小」而拒绝缓存副本——那种情况下缓存是唯一能跑的，照旧用它，避免整个插件加载失败。
- 启动日志里那行原生包信息补上实际加载路径，回落时也能看出到底跑的是哪份。
- 命令面板按审计逐项修了对比度、键盘可达与关闭守卫；新增自定义命令的表单改成固定头，取消与添加回到右上角（原来两个 `flex:1` 平分高度，上半块 351px 全是空白）。
- 连着点不同命令时，右侧详情块不再闪一下。
- 宿主 `Modal` 的遮罩层级是 1000、命令面板是 1300，浏览弹窗被整体盖住过一次；现在按卡片把外层抬到 1400。
- Esc 的归属理清：浏览弹窗自己接管（先退编辑态、再关弹窗），命令面板在弹窗开着时让路；关窗后焦点回到「选择…」按钮，不再掉到 body 上。

[对比 0.2.0-beta.2](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.2.0-beta.2...tool-plus-v0.2.0-beta.3)

## [0.2.0-beta.2] - 2026-11-17

> 预发布：修 beta.1 的回归——桌面端每条命令都会闪出一个控制台窗口再消失。

### Fixed

- **桌面端不再闪控制台窗口**：Windows 上加载器会把 `.node` 缓存在 `~/.omp/natives/<上游版本>/` 并优先用它，而那个目录只按上游版本号命名，所有发过该版本的分发共用同一格。旧版本留下的副本一直遮住新装的平台包，缺 `hideHostConsole` 这一个导出，宿主于是拿不到隐藏控制台，每条命令的控制台子进程都要自己新建窗口。现在缓存副本必须和平台包是同一份构建（同样是逐字节拷贝）才允许排在前面，否则跳过且不覆盖，由平台包直接加载。
- 宿主控制台的降级结果（原生包不可用 / 分配失败）从 debug 改为**警告**日志，这类静默失效下次可以直接在日志里看到，不用再靠闪窗倒推。

[对比 0.2.0-beta.1](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.2.0-beta.1...tool-plus-v0.2.0-beta.2)
## [0.2.0-beta.1] - 2026-11-16

> 预发布：安装回到一条命令。Windows 的隐藏控制台改由我们自己的原生包完成，插件因此没有任何构建依赖。

### Changed

- **安装不再需要 `--allow-build`**：Windows 上「给宿主补一个不可见控制台」的逻辑从 koffi FFI 挪进我们自己的原生 addon（`hideHostConsole()`），插件不再依赖 koffi，安装时也就没有安装脚本要放行。README 的两条安装命令都简化成裸 `dsh plugin add` / `pnpm add`。
- 原生包升到 `18.12.6-plus.2`（多出宿主控制台导出），六个平台包与 `optionalDependencies` 同步。
- 宿主已有控制台（在终端里跑 CLI）时仍然什么都不做；只有 GUI 宿主才分配并隐藏一个新控制台。

### Fixed

- pnpm 11+ 上不加 `--allow-build=koffi` 时 `dsh plugin add` 以 `ERR_PNPM_IGNORED_BUILDS` 退出 1（包装上了、命令失败）——依赖去掉后这条路不存在了。

[对比 0.2.0-beta.0](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.2.0-beta.0...tool-plus-v0.2.0-beta.1)

## [0.2.0-beta.0] - 2026-11-16

> 预发布：原生包改由我们自己的平台包分发。装上即自带 zip/tree/uuidgen/strings/hexdump/rev/free/bc 八个内建命令，不再只有官方原生包那一套。

### Added

- **内建命令开箱可用**：安装插件时按平台自动装上我们构建的原生包（Linux x64/arm64、macOS Apple Silicon/Intel、Windows x64/ARM64），无需任何额外步骤。
- **设置 → Tool Plus → 全局**新增「增强工具包」状态行：显示当前加载的是我们的构建还是官方原版、包名与版本，旁边可「重新检测」。未启用时按三种原因给出下一步（系统没有对应构建、安装时没装上、版本不匹配）。
- 启动日志加一行，说明本次用的是哪个原生包；回落到官方原版时改为警告，并点名因此不可用的命令。

### Changed

- 原生包用独立的版本线 `<上游版本>-plus.<n>`，与插件版本解耦：以后升级插件只是几 MB，不会重新下载上百 MB 的原生包。
- 原生构建矩阵收敛到上游实际发布的六个平台目标。

### Removed

- 去掉安装期改写官方原生包的做法（postinstall 脚本与启动期自愈入口）：改为直接分发我们自己的原生包，不再依赖改写第三方包内的文件。

### 说明

- 没有对应构建的平台（例如 Alpine/musl）会自动回落到官方原生包，八个内建命令不可用，设置页会明确说明原因。

[对比 0.1.21](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.21...tool-plus-v0.2.0-beta.0)

## [0.1.21] - 2026-11-13

> 正式版：新增可编辑的 Shell 初始化脚本，修掉 Windows 上裸 `bash` 命中 WSL 的问题；工具描述不再夸大跨调用状态保持。

### Added

- **Shell 初始化脚本**（设置 → Tool Plus → Bash）：每次创建 shell 时执行一段可编辑脚本，可改 PATH、加别名、导出变量；弹窗内可编辑、试运行（原样执行并显示输出）、恢复默认。没有保存过个人脚本时使用内置默认版本，随插件版本更新。
- 内置默认脚本把探测到的真实 Git Bash 目录排到系统目录之前，裸 `bash` 与嵌套 `bash` 都落到 Git Bash，而不是 WSL 转发程序。

### Fixed

- 初始化脚本在默认配置下不再形同虚设：此前只有前台直连会执行，走作业通道（自动转后台、显式后台运行）时被跳过。
- Windows 的 shell 发现不再把 WSL 转发程序或应用商店的占位程序当成宿主 bash；可移植版 Git 这类没有注册表项的安装也能反推出安装根目录。
- bash 工具的描述不再声称环境变量、别名跨调用保持：自动后台开启时如实说明只有工作目录会保留。

### Changed

- 设置页新增「Shell 初始化」分组，放启用开关与会话初始化脚本，开关默认开。

[对比 0.1.20](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.20...tool-plus-v0.1.21)

## [0.1.21-beta.1] - 2026-11-12

> 修复 issue #6：0.1.21-beta.0 的 Shell 初始化脚本在默认配置下不执行。

### Fixed

- Shell 初始化脚本现在也作用于作业路径（默认自动后台、`run_in_background`）；此前只有直连路径会 source，默认配置下等于没生效。
- 补充回归覆盖：作业路径参数透传、真实作业 shell 执行、真插件工具层默认配置。

[对比 beta.0](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.21-beta.0...tool-plus-v0.1.21-beta.1)

## [0.1.21-beta.0] - 2026-11-11

> 修复 issue #5：Windows 上裸 `bash` 不再命中 WSL 转发 stub。

### Added

- **Shell 初始化脚本**（设置 → Tool Plus → Bash）：每次创建 shell 时执行一段可编辑脚本，可改 PATH、加别名、导出变量。固定路径 `$DSH_HOME/tool-plus/bash-init.sh`；弹窗内可编辑、试运行（原样执行脚本并显示它的输出）、恢复默认。没有个人副本时执行内置默认版本，随插件版本更新。
- 内置默认脚本把插件探测到的真实 Git Bash 目录排到系统目录之前；前缀经 `TOOL_PLUS_PATH_PREFIX` 注入，脚本文件本身与平台无关。

### Fixed

- Windows 的 shell 发现不再把 `C:\Windows\System32\bash.exe`（WSL 转发 stub）或 WindowsApps 的 shim 当成宿主 bash；PortableGit 这类没有注册表项的安装，也能从 `where git` 反推安装根目录。

### Changed

- 配置新增 `bashInitEnabled`（默认开）；开关与脚本编辑收在同一个「Shell 初始化」分组里。

[对比 0.1.20](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.20...tool-plus-v0.1.21-beta.0)

## [0.1.20] - 2026-11-07

> 正式版：预设新增「跟随官方」动作，官方升级后不必等插件发版。

### Added

- **设置 → Tool Plus → 预设新增「跟随官方」**：读取当前环境官方随附的预设声明，套上本插件的增量（去掉宿主面三行、pwsh 关闭、加文档行）后整份写入 profile 配置。我们的预设落后于官方时，按钮旁显示「推荐」标签。
- 派生规则是纯函数（`src/presets/rebase.ts`），测试钉住它与随包生成物逐值相等，两边漂移会立即变红。

### Changed

- 「跟随官方」与「对齐模板」一样需二次确认；确认框与动作结果出现时自动滚入视口。
- 预设的 `engines.dsh` 下界保持 `0.2.2`，行为与 0.1.19 一致；README 补充了 0.2.2 下「加载失败」的修复步骤。

[对比 0.1.19](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.19...tool-plus-v0.1.20)

## [0.1.19] - 2026-11-05

> 正式版：把 `engines.dsh` 的下界对齐到实际支持的 0.2.2 线。

### Changed

- **`engines.dsh` 下界抬到 `0.2.2`**（`>=0.2.2-0 <0.3.0-0`，15 条 peer 同步）：预设快照取自 0.2.2 基线，0.2.1 宿主上 PTC 预设引用的 `@deepseek-ai/dsh-tool-executor-ptc` 根本不存在，装上也用不了；声明下限现在和实际支持的版本一致，0.2.1 用户留在 0.1.17。

[对比 0.1.18](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.18...tool-plus-v0.1.19)

## [0.1.18] - 2026-11-05

> 正式版：预设快照跟上 dsh 0.2.2 基线，修掉 0.2.2 上两个预设加载失败的问题。

### Changed

- **dsh 依赖升到 `0.2.2-rc.1`**：34 条 `devDependencies` 与 `@deepseek-ai/dsh-brand` 精确钉到该版本；`engines.dsh` 与 peer 范围不动（`>=0.2.1-0 <0.3.0-0`，仍是同一条 minor 线）。
- **预设基线重拷自 dsh 0.2.2-rc.1**：`presets/baseline/{standard,ptc}.patch.yml` 与官方逐字节一致，两个 `tool-plus-*` 预设重新生成；README 的 dsh 版本口径同步为 `v0.2.2-rc.1`。
- 测试夹具适配 0.2.2 的宿主 API（工具批调用、`jobs.readAt`、`session-projection`），插件运行时源码零改动。
- 预设生成器现在把基线里的 `!!js` 表达式原样回写成 tag，不再退化成普通 map（否则平台门会被悄悄丢掉）。

### Fixed

- **0.2.2 上 `tool-plus-standard` / `tool-plus-ptc` 加载失败**（[#3](https://github.com/xiaoso456/dsh-tool-plus/issues/3)）：0.2.2 删掉了 `@deepseek-ai/dsh-tool-subagent-control/list-agents` 这条子路径导出，旧预设里还挂着 `tool-subagent-list-agents` 一行，预设注册表 mount 时整份失败并报 `never started`，绑着这两个预设的旧会话也恢复不了。重拷基线后该行随官方基线一起消失；同批跟进的还有 `modelSelectionSettings` → `modelSelection` + `modelDiscovery`，以及 PTC 的 `tool-presentation` → `tool-executor-ptc`。

[对比 0.1.17](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.17...tool-plus-v0.1.18)

## [0.1.17] - 2026-10-28

> 正式版。先发过 `0.1.17-beta.0` / `0.1.17-beta.1` 到 `beta` 通道，本版是 `0.1.17-beta.1` 的正式版。

### Changed

- **内置工具链升级到上游新版本**，用户可感知的变化：
  - 编辑冲突提示更明确：文件缺少快照标签时直接给出当前标签；锚定到未完整显示的超长行时，提示重新读取对应行的完整内容，而不是给一段截断预览。
  - 超长行的编辑更安全：没有完整读过的长行不再允许直接写入，避免只看到部分内容就改错。
  - Bash 内置命令的一批修复：Windows 上可删除只读目录、跨盘移动保留时间戳与权限、中文输出不再乱码、搜索不再把重定向输出当输入、`tail -F` 不再误报文件被替换，以及 `sed`、`sort`、`read` 等命令在词边界、locale 与 UTF-8 上的行为修正。
  - 搜索与编辑性能提升：大结果集的 grep 内存占用下降，编辑结果的读取格式化更快，Windows 上文件类内置命令（查找、删除、建目录、列目录、查看属性）提速。

### Fixed

- **grep 不再误报「只搜索了前 4 MB」**：显式指定一个大于 4 MB 的文件时，搜索本身已覆盖完整文件，结果末尾却仍附带「只搜索了前 4 MB」的提示。现在该提示已移除，4 MB 之后的内容正常返回匹配。

[对比 0.1.16](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.16...tool-plus-v0.1.17)

## [0.1.17-beta.1] - 2026-10-26

> 测试版：修正 grep 对显式大文件的误导提示，请安装 beta 通道验证。

### Fixed

- **grep 不再误报「只搜索了前 4 MB」**：显式指定一个大于 4 MB 的文件时，搜索本身已覆盖完整文件，结果末尾却仍附带「只搜索了前 4 MB」的提示。现在该提示已移除，4 MB 之后的内容正常返回匹配。

[对比 0.1.17-beta.0](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.17-beta.0...tool-plus-v0.1.17-beta.1)

## [0.1.17-beta.0] - 2026-10-26

> 测试版：内置工具链跟随上游升级，请安装 beta 通道验证。

### Changed

- **内置工具链升级到上游新版本**，用户可感知的变化：
  - 编辑冲突提示更明确：文件缺少快照标签时直接给出当前标签；锚定到未完整显示的超长行时，提示重新读取对应行的完整内容，而不是给一段截断预览。
  - 超长行的编辑更安全：没有完整读过的长行不再允许直接写入，避免只看到部分内容就改错。
  - Bash 内置命令的一批修复：Windows 上可删除只读目录、跨盘移动保留时间戳与权限、中文输出不再乱码、搜索不再把重定向输出当输入、`tail -F` 不再误报文件被替换，以及 `sed`、`sort`、`read` 等命令在词边界、locale 与 UTF-8 上的行为修正。
  - 搜索与编辑性能提升：大结果集的 grep 内存占用下降，编辑结果的读取格式化更快，Windows 上文件类内置命令（查找、删除、建目录、列目录、查看属性）提速。

[对比 0.1.16](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.16...tool-plus-v0.1.17-beta.0)

## [0.1.16] - 2026-10-21

> 正式版。先发过一版内容相同的 `0.1.16-beta.0` 到 `beta` 通道，本版是它的正式版。

### Fixed

- **pi-natives Node 兼容与 pnpm store 隔离**：新增启动期自愈入口 `lib/pi-natives-bootstrap.mjs`，在加载插件前修复 `@oh-my-pi/pi-natives/native/loader-state.js` 的 `import.meta.dir`；postinstall 改为 copy-on-patch（临时文件 + rename 断 pnpm store 硬链接），已修复但仍在共享 inode 上的文件会 detach。精确解析改用 `import.meta.resolve`，避免 `createRequire.resolve` 对 ESM-only 包报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

[对比 0.1.15](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.15...tool-plus-v0.1.16)

## [0.1.16-beta.0] - 2026-10-21

### Fixed

- **pi-natives Node 兼容与 pnpm store 隔离**：新增启动期自愈入口 `lib/pi-natives-bootstrap.mjs`，在加载插件前修复 `@oh-my-pi/pi-natives/native/loader-state.js` 的 `import.meta.dir`；postinstall 改为 copy-on-patch（临时文件 + rename 断 pnpm store 硬链接），已修复但仍在共享 inode 上的文件会 detach。精确解析改用 `import.meta.resolve`，避免 `createRequire.resolve` 对 ESM-only 包报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

[对比 0.1.15](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.15...tool-plus-v0.1.16-beta.0)

## [0.1.15] - 2026-10-18

### Added

- `docs/benchmark/sbml-compare-ops.md`：四种 harness（官方标准模式 / dsh-ops / 本插件 / 本插件关闭命令拦截）的完整基准报告，含逐题矩阵；README 的「性能」一节直接链到它（`.gitignore` 为此加了 `!docs/benchmark/` 例外）

### Changed

- **命令拦截默认改为关闭**（`interceptorEnabled` 默认 `false`）：SWE-bench Multilingual 实测中，拦截 `grep` 会让模型放弃 shell 搜索、改用 `read` 碎读（`read` 调用 459 次 vs 官方 225 次），步数与 token 随之上升；关闭后二者明显回落。需要主动引导模型改用专用工具时，在设置页打开该开关即可
- README（中英）新增「性能」一节：与官方标准模式的对比表（解题率、步数、总/净 token、系统提示词、`read` 调用次数、`bash` 每次调用耗时与返回 token、结束后上下文长度、平均耗时），并附测量口径与结论

[对比 0.1.14](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.14...tool-plus-v0.1.15)

## [0.1.14] - 2026-10-17

> 正式版。先发过一版内容相同的 `0.1.14-beta.0` 到 `beta` 通道，本版是它的正式版。

### Added

- **兼容性声明改用官方口径**：新增 `engines.dsh: ">=0.2.1-0 <0.3.0-0"`。dsh 0.2.1-alpha.5 起宿主优先按它判定（声明了它就不再参与 peer 判定），peer 只留给不认识该字段的老宿主与 pnpm 做镜像，两处写的是同一串
- **e2e 浏览器验收通道**：`e2e/` 装真浏览器点真界面——配置、启动接线（隔离 `DSH_HOME`、进程内假供应商、带令牌地址运行时发布）、6 条用例（会话工具面、agent 发送、亮暗双主题、工具失败如实交回、read 真图、设置页开关改工具面）；npm 脚本 `e2e:browser`
- 验收产物双写：`e2e/.e2e/`（每轮重写）与 `docs/e2e-evidence/`（留给人回看的稳定副本），两者都不入库

### Changed

- **dsh 依赖升到 `0.2.1-rc.1`**：15 条 peer 由 `>=0.2.0-0 <0.2.1-0` 整段重写为 `>=0.2.1-0 <0.3.0-0`（本轮有源码适配，故不追加并集），`devDependencies` 精确钉 `0.2.1-rc.1`，镜像检查无缺失
- `@deepseek-ai/dsh-invariants` 移除：0.2.1 线官方不再发布该包，且 `src/` 零导入
- 预设基线重拷自 `@deepseek-ai/dsh-web-app@0.2.1-rc.1` 并重新生成（与 alpha.5 的 presets 逐字节相同）；官方 delta 复核为：persona 去掉 cwd 后缀、新增 time-context 与 tool-schedule 两行、plan 提示词改述、删三条 disabled 行、新增 disabled 行 tool-plugin-market——我们自己的四项 delta 未动
- `typecheck` 现在同时检查 `tsconfig.json` 与 `e2e/tsconfig.json`；README 的 dsh 版本口径更新为 `v0.2.1-rc.1`
- README 头部语言切换与徽标重排（两组居中）

### Fixed

- 工具卡片适配 rc.1 新增的必填 `commandLine` 标签（`terminalBlockLabels` + `locale` 字典 zh/en）
- 搜索类卡片折叠头不再被超长 `scope` 挤扁：新增 `clipScope`，超过 28 字符时保尾段、切在路径边界（此前 AST Grep 的主体会被挤成 `exp…`）
- 写入 / 编辑 / AST Edit 三行的 meta 补上 `·` 分隔符，与 Bash/Grep/Glob 行一致
- 单测里后台作业 id 的断言适配上游行为变更（`bash-<计数>` → `bash-<短 UUID>`）
- e2e 设置入口改走真实路径「账号菜单 → 设置菜单项」（宿主把 `settings.launcher` 槽位交给了账号菜单）

### Removed

- `tests/support/harness/capture-web.ts` 与 npm 脚本 `e2e:web`（2026-10-13 退役，整页截图、轨迹页、录屏等能力已被 e2e 浏览器通道吸收）

[对比 0.1.13](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.13...tool-plus-v0.1.14)

## [0.1.13] - 2026-10-06

### Added

- 插件页元信息：`locale/zh.json`、`locale/en.json` 提供标题与描述（「Oh My Pi 工具增强」/「Oh My Pi Tools」），`assets/icon.png` 提供图标（384×384、圆角按 8 倍超采样抗锯齿）
- `package.json` 顶层 `icon` 字段指向图标：宿主 0.2.0-rc.2 只读「导出的 package.json」里的顶层 `icon`，不认 `./icon` 导出（后者是 0.2.1-alpha.1 才有的解析路径）
- README 头部改为居中图标 + 艺术字词标（`assets/wordmark.png`，逐词纯色；由 Jua 渲染，字体 SIL OFL 1.1，只随包出图、不分发字体文件）；仓库内保留源图 `assets/icon-source.png`（不进 npm 包）

### Changed

- `peerDependencies` 15 条由逐条精确 `0.2.0-rc.2` 改为三位数范围 `>=0.2.0-0 <0.2.1-0`：0.2.0 线内的 rc 与正式版都不再被静默跳过，0.2.1 线（含 alpha）仍不放行
- `devDependencies` 补齐 peer 缺失的 5 条镜像（`dsh-agent-preset`、`dsh-agent-preset-registry`、`dsh-attachment`、`dsh-fs`、`dsh-sandbox`），依据 harness `docs/cookbook/adding-a-package` 的「每个 dsh peer 都要在 devDependencies 里镜像」；`pnpm-lock.yaml` 随之重算

### Removed

- 不再往仓库里放 `.release-notes-*.md`（含 0.1.6 遗留文件一并删除），`.gitignore` 忽略该模式；GitHub Release 正文改为按需从本节生成

[对比 0.1.12](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.12...tool-plus-v0.1.13)

## [0.1.12] - 2026-09-29

### Changed

- dsh 依赖对齐 `0.2.0-rc.2`：44 处 `@deepseek-ai/dsh-*` pin 由 `0.2.0-rc.1` 升级（`@deepseek-ai/cordis` 仍 `~4.0.4`、`@deepseek-ai/schemastery` 仍 `~3.18.4`，两者未变）
- 预设基线复核：官方 `packages/bundle/web-app/presets/{standard,ptc}.patch.yml` 在 rc.2 与 rc.1 **逐字节相同**，随包的两个预设内容不变
- README 的 dsh 版本口径更新到 `0.2.0-rc.2`

[对比 0.1.11](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.11...tool-plus-v0.1.12)

## [0.1.11] - 2026-09-28

### Added

- 端到端测试支持套件（随仓库走，不进 npm 包）：`tests/support/mock-openai/` 是一个脚本化的**假 LLM 服务**（协议帧构造 / 场景模型 / HTTP 服务 / CLI / 场景 JSON / 自检），`tests/support/harness/` 是把它接到**真 dsh** 上的驱动
- npm 脚本 `e2e`（headless 跑完 8 个工具并硬断言）、`e2e:web`（起真 web 实例并把对话与轨迹截图）、`mock:llm`（单独起假供应商）

### Changed

- dsh 依赖对齐 `0.2.0-rc.1`：44 处 `@deepseek-ai/dsh-*` pin 由 `0.1.7-rc.2` 升级（`@deepseek-ai/cordis` 仍 `~4.0.4`、`@deepseek-ai/schemastery` 仍 `~3.18.4`，两者未变）
- 预设基线重新核对：官方 `packages/bundle/web-app/presets/{standard,ptc}.patch.yml` 在 0.2.0-rc.1 与 0.1.7-rc.2 **逐字节相同**，随包的两个预设内容不变
- README 与仓库须知把 dsh 版本口径更新到 `0.2.0-rc.1`，并写明宿主对 peer 不匹配的 bundle 是**静默跳过**（症状是插件工具消失、补丁层不生效，而非启动报错）
- `scripts/tool-result-aggregate.mjs` 不再硬编码本机会话目录，改从 `$TOOL_RESULT_SESSIONS` / `$DSH_HOME` 解析

[对比 0.1.10](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.10...tool-plus-v0.1.11)

## [0.1.10] - 2026-09-26

> 正式版。原先分列的 `0.1.10-beta.1` ~ `0.1.10-beta.3` 三节已并入本节。

### Added

- Windows：挂载时给宿主进程分配一个不可见控制台，宿主的所有 console 子进程改为继承它 —— 上游 pi-shell 的 `where git` 探测不再**每条命令**新建一个可见窗口（桌面端宿主是 GUI 子系统镜像，分配出的控制台没有可见窗口，启动过程不闪窗）
- 预设改动前落一份备份：`<profile>/cordis.patch.yml.bak-<插件版本>`，同名不覆盖
- 设置页检测到旧版 `$DSH_HOME/.agent-presets` 目录时提示可安全删除
- `presets/baseline/`（官方随附 preset 补丁的逐字节快照）、`scripts/build-preset-patches.mjs`（基线加 delta 生成两个补丁文件）、`tests/unit/preset-patches.spec.ts`
- npm 脚本 `presets:build` / `presets:check`

### Changed

- 预设改为随包声明：`dsh.bundle.patch` 增加 `presets/tool-plus-{standard,ptc}.patch.yml`，各插入一条 `@deepseek-ai/dsh-agent-preset` 行；不再写 `$DSH_HOME/.agent-presets`，启动不再写盘
- 预设内容重新基线到 dsh 0.1.7，`order` 改为 20 / 21；跟随官方的 `workflow-ptc`、`tool-plugin-manager`、`tool-ralph` 关闭、`tool-web.config.fetch: true`
- 预设面板改为三个动作：最小更新、对齐模板、恢复随包；写入委托 `ctx.configEditor`（profile 锁、配置校验、原子写、失败回滚）
- 面板状态改为「随包默认 / 已自定义」；来源只区分本插件声明与别处声明，别人的预设只提供最小更新
- 设置面只保留左侧独立的 Tool Plus 页：不再向官方「内置插件」页注册 tab，同一份配置不再有两个入口
- dsh 依赖对齐 `0.1.7-rc.2`：42 处 `@deepseek-ai/*` pin 由 `0.1.5-rc.1` 升级，`@deepseek-ai/cordis` 改 `~4.0.4`、`@deepseek-ai/schemastery` 改 `~3.18.4`
- 后台作业契约迁移到 0.1.7：`JobHooks` 收窄为 `{ cancel, done }`，输出改由 `JobSpec.output` 与 `JobHandle.append/updateProgress` 承载，`JobSpec.owner` 由 `Agent` 改为 `SessionId`
- 设置面迁移到 0.1.7：移除 `ctx.settings.installSection`、`SettingsScope`、`ctx.settingsScope`、`settings.plugin.item` slot、`CardShell`，改注册到 `settings.plugins.tab`
- Web 工具卡片适配 0.1.7 原语：图标改名、错误态判据、补 `codeBlock.*` 与 `noExitLabel` 文案、移除 `DiffBlockLabels.files`
- 清单声明补 `dsh.manifestVersion: 1`
- 新增可选依赖 `koffi@^3.3.1`（原生 FFI，含 `cnoke` 预编译安装脚本，pnpm 需放行构建；放行方式见 README「从 npm 安装」）
- 隐藏控制台用的 FFI 只从本包自己的 `optionalDependencies` 解析（运行时 `createRequire`），不再去宿主运行时的 `node_modules` 里按路径查找
- 安装说明拆成「Web 端 / 桌面端」两节，两条安装命令都补 `--allow-build=koffi`
- 注释清理：删掉 41 行纯装饰（横幅横线）与复述代码的注释，涉及 11 个文件；代码字节未变

### Fixed

- 预设无法挂载：`delegation` 组内挂着的 `@deepseek-ai/dsh-workflow-worker-thread` 在 dsh 0.1.7 已改名为 `dsh-workflow-ptc`
- 预设的目录机制在 0.1.7 上失效（registry 不再扫目录，`list()` 不再返回 `path`/`trust`）
- 在桌面端这类没有控制台的宿主里，生成 shell 快照、探测「安全 rm」这两条一次性 shell 不再闪出控制台窗口（两处 `spawn` 补 `windowsHide`）
- 跑测试会写入开发机真实的 `~/.dsh`
- 类型解析回退到工作区外的 `node_modules`，导致 `Branded<'AttachmentId'>` 的两个声明点被判为不兼容

### Removed

- 目录机制实现：`src/presets/paths.ts`、`src/presets/install.ts`、`src/presets/rewrite.ts`、`presets/<id>/`、`presets/install-presets.mjs`、`presets/package.json`，以及 `presets:install` 脚本
- 设置卡片组件 `src/client/BashPlusCard.tsx` 与 `settings.plugins.tab` 注册（随去 tab 一并移除）

[对比 0.1.9](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.9...tool-plus-v0.1.10)

## [0.1.9] - 2026-09-20

### Added

- 设置页新增预设面板（Tool Plus → 预设）：可对比本地预设与随包模板，只更新冲突的工具行，或整份重置为所选模板
- 预设面板显示两项状态：工具行是否已接入本插件、与所选模板相差几处
- 各动作按钮带问号图标，悬停可看该动作具体做什么

### Changed

- 预设随插件安装：安装插件后不再需要单独安装预设包，两套模板首次启动时自动写入
- 设置页按钮与状态色改为与宿主一致

### Fixed

- 预设面板此前读不到状态，一直显示部署不可用
- 动作说明浮层此前会被设置面板遮挡或被裁切，文字颜色在浅色主题下难以辨认

[对比 0.1.8](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.8...tool-plus-v0.1.9)

## [0.1.8] - 2026-09-17

> 正式版，发布在 `latest`。与 `0.1.8-beta.4` 逐字节同码，只多了设置页的「Web 卡片」tab 与安装说明；原先分列的 `0.1.8-beta.1` ~ `0.1.8-beta.4` 四节已并入本节。

### Added

- 对话里的工具卡片：`write` / `read` / `edit` / `grep` / `glob` / `bash` / `ast_grep` / `ast_edit` 八个工具全部改用本插件自己的卡片，关掉「Web 工具卡片」开关即回到官方行，旧会话回放同样出卡
- `read` 卡片读到图片直接显示，可点开看原图，多图按小图库排列
- 卡片折叠行补上这次调用的事实：`read` 带行选择器的路径、搜索的范围与计数、`bash` 真正执行的命令、`ast_edit` 的改写规则
- 卡片行首照搬官方：按工具显示图标，出错红点、被中断琥珀点，运行中整行扫光
- 画不出详细卡片的退化行不再显示「N 个参数」，改为路径 / 命令 / 搜索模式，且路径可点（能不能预览由右侧栏决定）
- 设置页新增「Web 卡片」tab，开关从 Bash tab 迁出

### Changed

- 安装命令加上 `--allow-build=@xiaoso/dsh-tool-plus`：pnpm 10.4+ 不加会报 `ERR_PNPM_IGNORED_BUILDS` 装不上，README 另给出 `allowBuilds` 与 `pnpm approve-builds --all` 两种放行方式
- 卡片折叠行改为从左往右排布，不再出现两种对齐
- 图片的圆角 / 边框 / 底色对齐官方，加载时按最终尺寸占位，图片出来不跳版

### Fixed

- 搜索零结果、`bash` 超时或被取消、`timeoutMs: 0`、自动转后台的调用不再显示成成功或退回通用样式
- 被中断的调用改判为琥珀点 +「已停止」（此前误判「失败」）
- 退化行路径此前点不动、关闭原图后焦点会丢，均已修

### 说明

- 模型可见的部分一律未改：工具名、参数名、描述、提示词、输出文本、报错文案；只用官方公开导出的插件 API，不引入新的运行时依赖
- 一处刻意偏离：运行扫光尊重系统的「减少动态」偏好，官方那套动画没有这道门

[对比 0.1.7](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.7...tool-plus-v0.1.8)

## [0.1.7] - 2026-09-13

> 正式版，发布在 `latest`。**与 `0.1.7-beta.1` 逐字节同码**——只多了版本号与本节说明，没有为新版本再动一行代码。
> 自 `0.1.6` 起的完整清单见下方两个 beta 节，要点如下。

### Changed

- **hashline 引擎不再 vendored**：上游 18.x 删掉 TS `packages/hashline`、重写为 Rust `crates/pi-edit`。我们删除旧 TS 引擎（21 文件 / 7245 行），改由 `src/tools/hashline/native/` 薄适配层驱动 `@oh-my-pi/pi-natives` 18.1.17 的 Rust 引擎；`@oh-my-pi/*` 全家族锁步 17.3.5 → 18.1.17（pi-natives 兼容补丁与 postinstall 自愈两条轨道都保留）
- notebook 解码统一走引擎自身 codec（`notebookToEditableText`）：read 铸的 tag 与引擎校验活文件跑**同一份代码**，删除第二套 TS 渲染器
- presets：plan-mode 提示词与官方对齐

### Fixed

- 发布物补上 TypeScript 声明文件（`build` 顺序改为 `tsdown && tsc && copy-assets`；此前 `tsdown` 的 `clean` 会在打包前清掉 `lib/types`，TS 使用者报 `TS7016`）
- hashline 模式下 `write` 的前缀清理判断对齐上游（数组身份比较 → 文本比较）：此前每次写盘都误报 `auto-stripped hashline display prefixes`，且畸形/legacy 头会被原样写进文件
- hashline 编辑 `.ipynb` 必然失败（引擎已序列化，写盘腿又序列化一次）
- 带 UTF-8 BOM 的 `.ipynb` 在 read 侧报 `Invalid JSON in notebook`
- 多文件补丁部分落盘时重新带上 `Sections already written` 诊断
- `Bun.which` 缺失、`Bun.hash` 忽略 `seed`

### Added

- hashline 回归测试四件套：`native-writer`、`native-partial-write`、`notebook-hashline`、`native-adapter-surface`（适配层 30/30 运行时导出 + 上游夹具 226 例）
- `packaging-artifacts.spec.ts`（守住每条被广告的声明路径）与 `write-hashline-prefix-strip.spec.ts`（前缀清理 6 用例，修前 1/6 通过）

### 已知收窄

- 畸形 notebook（`source` 含非字符串元素、孤立代理项）行为改为与 Rust 引擎一致，详见 `0.1.7-beta.0` 节

[对比 0.1.6](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.6...tool-plus-v0.1.7)

## [0.1.7-beta.1] - 2026-09-12

> beta 预发布：供试用与验证，**不推 `latest`**（`npm dist-tag` 为 `beta`）。

### Fixed

- 发布物补上 TypeScript 声明文件。`build` 原本先跑 `tsc`（`emitDeclarationOnly` → `lib/types`）再跑 `tsdown`，而 `tsdown.config.ts` 的 outDir 是 `lib` 且 `clean: true`（用于清陈旧 chunk），会整体清空 `lib/` —— 声明文件在打包前就被删掉，而 `types` / `exports[*].types` 仍指向 `lib/types/**`。0.1.7-beta.0 及更早的发布物一个 `.d.ts` 都没带，TS 使用者报 `TS7016: Could not find a declaration file`。现顺序改为 `tsdown && tsc && copy-assets`，并加 `tests/unit/packaging-artifacts.spec.ts` 守住「每条被广告的声明路径都必须存在、声明图内的相对引用必须可解析」
- 修复 hashline 模式下 `write` 的前缀清理判断：`stripWriteContentWithPotentialLooseHeader` 用**数组身份**比较（`cleaned !== lines`）判断是否剥掉了前缀，而 `stripHashlinePrefixes` 走 pi-natives、跨边界必然返回新数组 —— 判断恒真。后果有二：① `stripped` 恒为 true，每次写盘都报 `auto-stripped hashline display prefixes`（哪怕什么都没剥，误导模型以为内容被改过）；② 提前 return 让「松散 header 兜底」成为死代码，畸形/legacy 头（`[h#1]`、`[a.ts#]`、6 位或非 hex tag）会被**原样写进文件**（连 `[path#tag]` 头行和 `1:` 行号前缀一起），而上游会清理成裸内容。现恢复上游实现（两处文本比较，与上游逐字一致），新增 `tests/unit/write-hashline-prefix-strip.spec.ts`（6 用例，真实链路；未修前 1/6 通过）

[对比 0.1.7-beta.0](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.7-beta.0...tool-plus-v0.1.7-beta.1)

## [0.1.7-beta.0] - 2026-09-12

> beta 预发布：供试用与验证，**不推 `latest`**（`npm dist-tag` 为 `beta`）。

### Added

- hashline 回归测试四件套：`native-writer`（写盘回调三分支 + 守卫 + 错误路径）、`native-partial-write`（部分落盘诊断）、`notebook-hashline`（`.ipynb` 读→编辑→二次编辑）、`native-adapter-surface`（适配层 30/30 运行时导出全覆盖 + 上游夹具语料 226 次调用，101 条不可达逐条登记）

### Changed

- **hashline 引擎不再 vendored**：上游 18.x 删除 TS `packages/hashline`、把编辑引擎重写为 Rust `crates/pi-edit`。我们删除旧 TS 引擎（21 文件 / 7245 行），改由 `src/tools/hashline/native/` 薄适配层驱动 `@oh-my-pi/pi-natives` 的 Rust 引擎（`EditStore` / `EditSession` / `EditPolicy` / 写盘回调）；`@oh-my-pi/hashline` alias 重指到适配层；12 个测试文件迁移到 native harness，并把上游 226 例夹具纳入回归
- `@oh-my-pi/*` 依赖锁步升级 17.3.5 → 18.1.17（pi-natives 兼容补丁同步更新，补丁与 postinstall 两条轨道都保留）；`THIRD_PARTY_NOTICES.md` 同步（hashline 不再 vendored，新增夹具来源声明）
- notebook 解码改用引擎自身 codec（`pi-natives` 的 `notebookToEditableText`）：read 铸的 tag 与引擎校验活文件跑**同一份代码**，一致性由结构保证，删除第二套 TS 渲染器。**良构 notebook 逐字节等价；畸形 notebook 的行为改为与引擎一致**（此前两边会分歧，分歧即"标签永远校验不过"），已知收窄见下
- presets：plan-mode 提示词与官方对齐

### Fixed

- 修复 hashline 编辑 `.ipynb` **必然失败**：引擎已把 notebook 序列化为 nbformat JSON 再交给宿主，写盘腿却又序列化一次，把 JSON 当可编辑文本解析 → 每次编辑报 `Invalid notebook editable representation`；现在逐字落引擎给的最终字节（对齐上游宿主）
- 修复带 UTF-8 BOM 的 `.ipynb` 在 read 侧报 `Invalid JSON in notebook`（引擎本可正常编辑该文件）
- 恢复多文件补丁部分落盘时的诊断：写盘通道拒绝第 2 个文件时，错误里重新带上 `Sections already written: a.ts.`，模型不再可能把整条补丁重发而重复应用
- 修复 `Bun.which` 缺失导致的 `TypeError: Bun.which is not a function`（pi-utils `$which` 每次调用必抛，找不到命令时本应返回 `null`）；同时修 `Bun.hash` 忽略 `seed` 导致的缓存键塌缩

### 已知收窄（畸形 notebook，均为"向引擎对齐"的副作用）

- `source` 含非字符串元素时，引擎侧投影会静默丢弃这些元素（旧 TS 渲染器会拼成 `"a5"`、`[["a"]]` 会保留 `a`）——这类畸形 cell 在 read 中显示为空，但仍可正常编辑
- 含孤立代理项（lone surrogate）的 notebook JSON：旧渲染器可读，新解码器（serde_json）拒绝并报 `Invalid JSON in notebook`
- 编码半（`readNotebookDocument` / `serializeEditedNotebookText`，服务 patch/replace/write 三条 DSH 自有路径）仍走 V8 `JSON.parse`，严格度与解码腿不同；该半随后续模式迁到 Rust 引擎一并删除

[对比 0.1.6](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.6...tool-plus-v0.1.7-beta.0)

## [0.1.6] - 2026-09-10

### Changed

- dsh 依赖升级到 0.1.5-rc.1（22 个 `@deepseek-ai/dsh-*` 包全部精确锁定），并新增 dsh-brand / dsh-invariants 直接依赖以规避 pnpm 对同版本 peer 依赖的预发布版本解析问题；peerDependencies 同步对齐到 0.1.5-rc.1，传递依赖 dsh-attachment / dsh-fs / dsh-sandbox 随之升至 0.1.5-rc.1
- 预设与官方 0.1.5-rc.1 对齐：persona 改为 prefix/suffix 结构（`You are a coding agent powered by the {{model}} model.` + `Your working directory is {{cwd}}.`），新增 command-goal 工具行与 present 工具（`@deepseek-ai/dsh-tool-present`），tool-subagent 开启模型选择设置
- PTC 预设：tool-workflow 默认禁用，tool-presentation 输出模式改为 `ptc`

[对比 0.1.5](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.5...tool-plus-v0.1.6)

## [0.1.5] - 2026-09-09

### Fixed

- 修复安全 rm 删除失败时提示毫无信息量的问题：底层回收站程序失败时只输出 `Command failed: <exe> <args>`，原因被黑盒吞掉；现在 Windows 上删除失败会先对目标做一次改名探测，按系统真实回答分类报错——文件被占用时提示 `file is locked or cannot be moved by this process (close programs using it and retry)`，权限不足时提示 `permission denied (read-only file or restricted directory)`，目标已被其他进程删除时视为删除成功不再报错
- 非 Windows 平台删除失败保持原有报错方式不变

[对比 0.1.4](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.4...tool-plus-v0.1.5)

## [0.1.4] - 2026-09-08

### Fixed

- 修复 bash 工具无法识别 Git Bash 风格路径的问题：以 `cd /d/code/... && …` 开头的命令或给 `workdir` 传 `/d/...` 路径时，Windows 下会被错误解析为 `D:\d\...`（把 `/d` 当成盘根下的子目录），导致切换到错误目录或报出晦涩的 "Failed to set cwd"；现在按 Git Bash 语义正确解析为 `D:\code\...`，并兼容 `/mnt/d/...` 写法与输入中误带的 `:` 前缀
- 工作目录不存在或指向文件时，现在直接报出清晰错误（`Working directory does not exist: ...` / `Working directory is not a directory: ...`），不再依赖 shell 侧的晦涩报错
- 修复安全 rm 误删隐患：在 bash 里执行 `rm /d/...`（Git Bash 风格路径）时，删除目标会被错误解析到 `<当前盘>:\d\...` 目录，若该目录恰好存在同名文件会被静默移入回收站；现在先转换为原生路径再删除，`-v` 输出与错误信息保留输入时的原样写法

[对比 0.1.3](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.3...tool-plus-v0.1.4)

## [0.1.3] - 2026-09-07

### Fixed

- 修复 minimizer 压缩后模型看不到原文提示的问题：后台任务路径（autoBackground 主力路径）组装完成结果时漏传 `minimized` 字段，导致 `[output minimized...]` 提示整条缺失、压缩前原文虽已落盘但模型无法得知路径；现与前台 `buildForeground` 对齐补上该字段
- 前台 fallback 路径的 `executeBash` 补传 `onMinimizedSave`，压缩发生时同样把原文写入 spill 文件并通过提示暴露路径，两条路径行为一致
- 新增 `background-minimized-notice.spec.ts` 回归测试，锁定 completion 结果携带 `minimized` 与 `originalSpillPath`

[对比 0.1.2-rc.1](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.2-rc.1...tool-plus-v0.1.3)

## [0.1.2-rc.1] - 2026-09-03

### Changed

- dsh 依赖升级到 0.1.2-rc.1 并全部改为精确锁定版本（不再使用 `^`）：dsh-* 0.1.2-rc.1、cordis 4.0.2、schemastery 3.18.2
- 移除已随 dsh 0.1.2-rc.1 删除的 dsh-client-runtime 依赖，客户端类型迁移到 dsh-client-ui-settings / dsh-client-ui-renderer
- 适配 dsh 0.1.2-rc.1 API 变更：设置注册改用 `ctx.settings.installSection`、连接 RPC 处理器改为两参签名、`CallId` 更名 `ToolCallId`
- 版本号与 dsh 对齐（0.1.2-rc.1），npm `latest` 标签指向该版本，`dsh plugin add` 默认安装与 dsh 匹配
- README 适用版本说明更新

[对比 0.1.2](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.2...tool-plus-v0.1.2-rc.1)

## [0.1.2] - 2026-09-01

### Added

- grep/glob 搜索默认值开关：大小写敏感、跳过被忽略文件、包含隐藏文件均可配置（未显式传参时按设置生效，显式传参始终优先）
- 恢复 Glob 工具设置页（此前因无配置项被移除）

### Fixed

- 修复安全 rm 默认不生效的问题：后台任务路径调用执行器时漏传安全 rm 开关，导致日常命令（自动后台化）从不注入 rm 重定义，只有保存设置触发验证时才生效；现已与前台路径对齐，默认开启即生效
- 修复安全 rm 注入被共享脚本文件污染的问题：注入改为直接内联进会话快照，不再生成独立的 rm-safe 脚本文件，消除不同安装路径实例与测试进程互相覆盖的隐患

### Changed

- README 增加设置面板（Bash 工具页）截图
- 设置项文案改为自然表述（grep 匹配上下文、截断单位、已见行守卫等）

[对比 0.1.1](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.1...tool-plus-v0.1.2)

## [0.1.2-beta.1] - 2026-09-01

### Changed

- 安全 rm 注入改为直接内联进会话快照：不再生成独立的 rm-safe 脚本文件，消除跨进程共享缓存互相覆盖的隐患（不同安装路径的实例、测试进程曾会把共享脚本重写成无效路径，导致 rm 报错）

[对比 beta.0](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.2-beta.0...tool-plus-v0.1.2-beta.1)

## [0.1.2-beta.0] - 2026-09-01

### Added

- grep/glob 搜索默认值开关：大小写敏感、跳过被忽略文件、包含隐藏文件均可配置（未显式传参时按设置生效，显式传参始终优先）
- 恢复 Glob 工具设置页（此前因无配置项被移除）

### Fixed

- 修复安全 rm 默认不生效的问题：后台任务路径调用执行器时漏传安全 rm 开关，导致日常命令（自动后台化）从不注入 rm 重定义，只有保存设置触发验证时才生效；现已与前台路径对齐，默认开启即生效

### Changed

- README 增加设置面板（Bash 工具页）截图

[对比 0.1.1](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.1...tool-plus-v0.1.2-beta.0)

## [0.1.1] - 2026-08-31

### Added

- 安全删除（安全 rm）：`rm` 默认把文件移入系统回收站而非永久删除，误删可恢复；需要真删时用 `command rm`
- 安全 rm 注入状态验证：在设置中开启安全 rm 并保存时，自动测试注入是否生效，并以提示框告知结果（成功或失败原因）

### Changed

- 正式版发布（移除 beta 标记）
- 「rm 进回收站」更名为「安全 rm」
- README 增加安全删除说明与项目徽标

### Fixed

- 修复设置行整行可点导致误触开关/下拉的问题

[对比 beta.7](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.7...tool-plus-v0.1.1)

## [0.1.0-beta.7] - 2026-08-31

### Changed

- 设置面板 Tool Plus 页视觉升级：工具切换标签改为下划线样式，切换时下划线平滑滑动；各工具的配置项改为分组卡片展示，层次更清晰
- 设置项操作更顺手：整行点击即可切换开关、展开下拉、聚焦数字输入框
- 保存与放弃修改按钮固定在面板底部，内容较长时无需滚到底即可操作

### Fixed

- 修复设置页标题、标签与选项挤在一起的问题（页面布局样式此前未生效）
- 修复切换工具标签时下划线指示器无滑动动画的问题

[对比 beta.6](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.6...tool-plus-v0.1.0-beta.7)

## [0.1.0-beta.6] - 2026-08-30

### Added

- 抓取网页内容时支持现代 SPA 网站（如 excalidraw.com）：这类页面的正文由 JavaScript 动态加载，此前只能抓到空壳，现在会自动借助本机浏览器渲染完整内容后再抓取
- 设置面板新增「探测浏览器」按钮，可一键查看本机可用的浏览器（Chrome / Edge / Chromium）

### Changed

- 网页抓取能力整体增强（详见 Added）

### Fixed

- 修复浏览器渲染进程空闲时未及时释放的问题，长时间使用不再持续占用内存

[对比 beta.5](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.5...tool-plus-v0.1.0-beta.6)

## [0.1.0-beta.5] - 2026-08-29

### Fixed

- 修复插件包体积过大导致部分镜像源无法同步、安装失败的问题

[对比 beta.4](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.4...tool-plus-v0.1.0-beta.5)

## [0.1.0-beta.4] - 2026-08-29

### Changed

- 多项功能修复与稳定性提升，补齐测试覆盖
- 提示词渲染改用官方引擎，兼容性更稳
- 命令拦截默认开启

### Removed

- 清理实验性目录 tool-plus-lab

[对比 beta.3](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.3...tool-plus-v0.1.0-beta.4)

## [0.1.0-beta.3] - 2026-08-28

### Added

- 新增网页内图片直读，超大图自动缩放
- README 中英双语版本与切换

### Fixed

- 图片读取细节与官方对齐：缩放后仍标注原图尺寸、超大图与 16-bit PNG 报错提示更清晰

[对比 beta.2](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.2...tool-plus-v0.1.0-beta.3)

## [0.1.0-beta.2] - 2026-08-28

### Changed

- 完善包元数据（keywords / repository），便于检索
- 发布源切换至 npm 官方源，安装更稳

[对比 beta.1](https://github.com/xiaoso456/dsh-tool-plus/compare/tool-plus-v0.1.0-beta.1...tool-plus-v0.1.0-beta.2)

## [0.1.0-beta.1] - 2026-08-27

### Added

- 首个 Beta 版本发布
- 核心能力：持久 bash、结构化 read、多模式 edit、原子 write、全文搜索、图像直读
- 预设拆分为独立可安装包，与主包同版本发布

[查看发布](https://github.com/xiaoso456/dsh-tool-plus/releases/tag/tool-plus-v0.1.0-beta.1)
