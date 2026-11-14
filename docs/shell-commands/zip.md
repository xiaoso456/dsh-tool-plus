# zip

| 项 | 内容 |
|---|---|
| 一句话定位 | 在 shell 里直接创建、更新、检查 ZIP 归档，不依赖系统 `zip` 二进制 |
| 实现层 | brush 内建（Rust，`pi-builtins` crate），进程内执行 |
| 上游来源 | 无。上游 pin `v18.12.6`（commit `45c35e4`）的 `crates/pi-builtins/src` 下没有 `zipcmd` |
| 实现位置 | `vendor/oh-my-pi/overlay/crates/pi-builtins/src/zipcmd*/ `，5 个文件共 3421 行 |
| 接入方式 | `vendor/oh-my-pi/patches/0001-zip-integration.patch`（350 行）：`util.zip` feature、`zip` 依赖、factory 注册、Bazel feature |
| 依赖 | `zip` crate 9.1.2 |
| 测试 | `zipcmd.rs` 内 68 个 `#[test]` |

## 为什么自研

- **brush 没有**：`git -C vendor/oh-my-pi/upstream ls-tree -r --name-only HEAD crates/pi-builtins/src | grep -i zip` 在上游 pin 上无输出。工作区里看到的 `upstream/.../zipcmd` 是应用 overlay 之后的结果，不是上游自带。
- **OMP 没有**：`refs/oh-my-pi/packages/coding-agent/src/tools` 下没有 zip 相关工具。
- **动机**：Windows 上不必依赖外部 `zip` 二进制，shell 里就有可用的归档命令；同时保证跨平台行为一致。

## 实现规模

| 文件 | 行数 | 职责 |
|---|---|---|
| `zipcmd.rs` | 2220 | 参数定义、分流、创建/更新/列表/测试/注释/过滤/日志等主流程，内含 68 个单测 |
| `zipcmd/update.rs` | 536 | 更新已有归档：读中央目录、增删改条目、写回 |
| `zipcmd/entry.rs` | 504 | 条目级处理：路径规整、名字匹配、条目重建 |
| `zipcmd/line_endings.rs` | 83 | `-l` / `-ll` 的换行转换 |
| `zipcmd/verify.rs` | 78 | 归档自检与差异比较的支撑 |

## 能力面

- **创建 / 更新**：新建、追加、`-f` freshen、`-u` 更新、`-g` grow、`-d` 删除
- **递归与过滤**：`-r` 递归目录、`-R` 按模式递归、`-i` / `-x` 包含与排除、`-n` 后缀过滤、`-t` 起始日期、`-tt` 截止日期、`-@` 从 stdin 读文件清单
- **查询**：`-sf` 只列条目、`-T` 测试归档、`-TT` 写入后跑外部命令测试、`-v` 带档案时是详细输出、不带档案时显示版本
- **归档维护**：`-FS` 与文件系统同步、`-DF` 差异写入、`-MM` 强匹配、`-RE` 正则匹配、`-U` 复制到新档案（配合 `--out`）
- **压缩方式**：`-0` 到 `-9`、`-Z` 指定方法、`-n` 后缀规则
- **Windows 相关**：`-k` 8.3 名、`-S` 系统/隐藏位、`-AS`、`-AC`、`-TT`、`-m` 移动
- **注释与日志**：`-c` / `-z` 归档与条目注释、`-db`..`-dv` 进度明细、`-lf` 日志文件、`-li` 附带信息
- **加密**：`-P` 直接给密码、`-e` 交互输入，均为 AES-256
- **信息**：`-L` 许可、`-V` 版本

## 与 Info-ZIP 的差异

三类缺口（完整清单见 [../draft/zip-builtin-gaps.md](../draft/zip-builtin-gaps.md)）：

- **接受但本平台不适用**：`-FI/--fifo`、`-N/--notes`
- **crate 做不到**：`-s` 分卷（`-sp/-sb/-sv`）、`-F/-FF` 修复、`-A/-J` SFX 调整
- **有意不做**：`-a -B -C/-C2/-C5 -E -w -! -I`

容易踩的两处：

- `-s` 在这里是 `--show-files` 的别名，**不是** Info-ZIP 的分卷大小
- `-e` / `-P` 产出 AES-256（WinZip AES），不是 Info-ZIP 的 ZipCrypto；旧工具打不开。这条可以修，crate 同时支持 `with_deprecated_encryption`（`write.rs:3537`）与 `with_aes_encryption`

## 测试与验证

- 单测：`cargo test -p pi-builtins zipcmd`（68 个 `#[test]`，记录中全 crate 1280 项全绿）
- 本地真机：编出 debug addon 后用 `PI_NATIVES_DIR` 指向独立目录（`<PI_NATIVES_DIR>/<pi-natives 版本>/<addon 文件名>`），实测 `zip -L` / `-V` / `-du` 均 exit 0
- 不要改 `node_modules/@oh-my-pi/pi-natives/native/`，也不要拷进 `~/.omp/natives/`，否则桌面端和其它 profile 会吃到未发布的产物

## 局限与后续

1. **用户还拿不到**：npm 平台包（`@xiaoso/pi-natives-patched-<platform>`）未发布，wrapper/loader 未接线。装 0.1.21 的用户在 shell 里执行 `zip` 仍是 `command not found`。
2. **矩阵没跑过**：`.github/workflows/native.yml` 只在 `feat/tool-optimization` 上，默认分支没有这个文件；`native-v*` tag 没打过，9 个 target 没有产物。release 构建未验证。
3. 上述三类选项缺口；`-F` 修复需要自写扫描器（中央目录坏了 `ZipArchive` 打不开），`-s` 分卷受限于 writer 把 `disk_number` 写死为 0。

## 维护要点

- 上游升版本时：重拷 `vendor/oh-my-pi/upstream` 到新 commit、确认 `0001-zip-integration.patch` 仍能应用（重点看 `util` feature 与 factory 注册点有没有变）、重跑 `cargo test -p pi-builtins zipcmd`
- overlay 只放新增源码，接入点一律走编号补丁并登记到 `vendor/oh-my-pi/README.md` 的 patch 台账
- 删掉 zip 的条件写在台账里：上游自带 zip，或 shell 不再暴露进程内工具
