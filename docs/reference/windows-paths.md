# Windows 路径方言与 shell 边界

对象：本插件的 `bash` 工具，OMP 18.12.6 / `brush-core` 0.5.0，Windows 10.0.28000。
状态（2026-11-15）：0002 已本地覆盖“相对路径可执行文件”，0003 覆盖 `/cygdrive/<盘符>` 输入别名；两者都还不是已发布 addon 的行为。

这份文档回答一个问题：**同一条路径，为什么 `pwd`、`cygpath`、Git Bash、`cmd.exe` 给出的写法不一样，模型应该信哪一个、shell 应该接受哪一个。**

## 0. 一句话契约

**输入宽容，输出原生。**

- shell 接受 Windows 原生、Git Bash/MSYS、WSL，以及 Cygwin 默认前缀四种写法；
- shell 自己的 `pwd`、`command -v`、`realpath` 输出 Windows 原生路径；
- 执行外部程序前，把含分隔符的路径绝对化并规范化；
- 不试图让每个外部程序、每个命令都输出同一种写法。

## 1. 语法：四种“绝对路径”

| 写法 | Windows 原生含义 | MSYS/Cygwin/WSL 含义 | 本 shell 分支 |
|---|---|---|---|
| `C:\x` | 绝对盘路径 | 原生路径 | 接受 |
| `C:/x` | 绝对盘路径（Win32 接受正斜杠） | 原生路径 | 接受 |
| `C:x` | **drive-relative**：该盘上次的当前目录 | 原生路径 | 不保证，见 §6 |
| `\x` | 当前盘根相对 | 原生路径 | 接受 |
| `/x` | 当前盘根下的 `x` | MSYS 虚拟根 | 按当前盘根处理 |
| `/c/x` | 当前盘根下的 `c\x` | `C:\x` | 按 MSYS 别名处理 |
| `/mnt/c/x` | 当前盘根下的 `mnt\c\x` | WSL 的 `C:\x` | 按 WSL 别名处理 |
| `/cygdrive/c/x` | 当前盘根下的 `cygdrive\c\x` | Cygwin 的 `C:\x` | 0003 起按 Cygwin 别名处理 |
| `\\server\share` | UNC | 原生路径 | 接受 |
| `\\?\C:\x` | verbatim / 扩展长度 | 原生路径 | 文件操作通常接受；外部程序支持不一 |

关键歧义：**`/foo` 在 Windows 原生是“当前盘根 + foo”，在 MSYS 是虚拟根。** 两边都合法，无法在不选边的情况下自动判断。本 shell 的选择是：

- 只把明确的盘符别名（`/c`、`/mnt/c`、`/cygdrive/c`）翻译成盘根；
- 其余 `/foo` 保留 Windows 原生语义（当前盘根）。

## 2. 谁输出什么（本机实测）

| 生产者 | 输出 | 备注 |
|---|---|---|
| `pwd` / `$PWD` | `D:\code\...` | 原生，推荐作为默认展示 |
| `pwd -P` | `\\?\D:\code\...` | Rust `canonicalize` 的物理路径；`cd` 能接受，但很多工具不认 |
| `pwd -W` | 报错 | Git Bash 扩展；brush 的 `pwd` 只声明 `-P/-L` |
| `command -v where.exe` | `C:\WINDOWS\system32\where.exe` | 原生 |
| `realpath /c/Windows` | `C:\Windows` | 原生 |
| `cygpath -u 'C:\Windows'` | `/c/Windows` | 外部 Git Bash 工具，MSYS 风格 |
| `cygpath -w /c/Windows` | `C:\Windows` | 需要原生路径时用它 |
| `ls -d /c/Windows` | `/c/Windows` | 只是原样回显 operand，不是 canonicalize |
| 外部 Git Bash 的 `pwd -P` | `/d/code/...` | 子进程自己的方言，不代表 brush 的 `pwd` |
| `where.exe cmd.exe` | `C:\Windows\System32\cmd.exe` | 原生 |

结论：**不要跨生产者做字符串比较**。同一个目录，`pwd`、`pwd -P`、`cygpath -u`、Git Bash 子进程的 `pwd` 可以给出四种不同写法。

## 3. 谁接受什么

| 输入 | `cd` | 文件类 builtin / `test` | 外部命令 | glob |
|---|---|---|---|---|
| `C:\...` | 是 | 是 | 是 | 是 |
| `C:/...` | 是 | 是 | 是 | 是 |
| `/c/...` | 是 | 是 | 0002 起是 | 是（pattern alias） |
| `/mnt/c/...` | 是 | 是 | 0002 起是 | 是（pattern alias） |
| `/cygdrive/c/...` | 0003 起是 | 0003 起是 | 0003 + 0002 起是 | 0003 起是 |
| `pwd -P` 的 `\\?\...` | 是 | 是 | 取决于程序 | 取决于 pattern |
| `C:foo` | 不保证 | 不保证 | 不保证 | 不保证 |

这里的“是”不是给每个 builtin 单独加分支，而是它们都走 shell 的绝对路径入口（见 §4）。绕过 `absolute_path` 直接调 filesystem 的新代码不在自动覆盖范围内。

## 4. 内部管线

非 glob 路径：

```text
path string
  -> Shell::absolute_path
       -> 虚拟路径？原样返回
       -> sys::fs::normalize_shell_path
            -> translate_unix_drive_path  (/c, /mnt/c, /cygdrive/c)
            -> translate_unix_tmp_path    (/tmp)
       -> 已是绝对？返回 : join(shell working_dir)
  -> open_file / test / cd / redirection / source / external command
```

执行外部程序：

```text
compose_std_command
  -> absolute_path
  -> 0002: sys::fs::normalize_executable_path (Windows, 词法折叠 . / ..)
  -> Command::new(absolute program).current_dir(shell cwd)
```

glob：

```text
patterns::expand_pattern
  -> pattern_drive_alias_root  (/c, /mnt/c, /cygdrive/c)
  -> read_dir(根) + 逐段展开
```

因此 `/cygdrive` 的代码改动只需要两个函数：

- `translate_unix_drive_path` / `drive_alias_parts`：普通路径；
- `pattern_drive_alias_root_impl`：glob 根。

不需要改 `cd.rs`、`interp.rs`、`test.rs` 或每个 builtin。

## 5. 0003 的支持范围（/cygdrive）

只支持 **Cygwin 默认前缀** `/cygdrive`，且只接受**单个 ASCII 盘符**：

```sh
cd /cygdrive/c                  # C:\
cd /cygdrive/c/Windows          # C:\Windows
cd /CYGDRIVE/D/Project          # D:\Project
echo /cygdrive/c/Windows/System32/where.*   # glob 能展开
/cygdrive/c/Windows/System32/where.exe cmd.exe  # 0003 + 0002 可执行
```

不匹配、按普通原生路径处理的：

```sh
/cygdrive            # 不是盘符根
/cygdrive/           # 不是盘符根
/cygdrive/data       # data 不是盘符
/cygdrive/cc/foo     # 盘符必须是一个字母
```

Cygwin 的 `/cygdrive` 前缀可配置；本实现只认默认值。自定义前缀请用 `cygpath -w` 转成原生路径。

## 6. 明确不支持 / 例外

| 项 | 状态 | 原因 / 替代 |
|---|---|---|
| `pwd -W` | 不支持 | Git Bash 扩展，不是 POSIX；用 `pwd` 或 `cygpath -w` |
| `pwd -P` 改输出 `C:\...` | 不改 | `-P` 是物理路径，`\\?\` 是真实结果；展示用 `pwd` |
| `cygpath` 输出统一 | 不做 | 外部程序；shell 接受它的 `/c/...` 输出即可 |
| 外部程序参数自动转换 | 不做 | 参数级转换会误伤；原生程序请传原生路径 |
| 完整 MSYS：`/usr`、`/bin`、`/dev`、mount 表 | 不做 | 上游 #1142 就是这层复杂度，brush 不是 MSYS runtime |
| 自定义 `/cygdrive` 前缀 | 不做 | 只认默认前缀；用 `cygpath -w` |
| `C:foo` drive-relative | 不保证 | 依赖进程/盘的“当前目录”，和 shell 逻辑 cwd 不是一回事 |
| 非 UTF-8 的别名路径 | 有局限 | `translate_unix_drive_path` 当前要求 UTF-8；原生 UTF-16 路径不受影响 |
| 当前盘下真实存在 `\cygdrive\c` | 被别名遮蔽 | 0003 的已知风险；极罕见，文档记录 |

## 7. 给模型的规则

1. **路径展开一律加引号**：`cd "$p"`，不要 `cd $p`，也不要直接把 `pwd` 的 `D:\...` 原样敲进命令。
2. **输入可以是多种方言，输出以原生为主**；不要假设 `pwd` 和 `cygpath` 给同一个字符串。
3. 需要原生路径时：
   ```sh
   p=$(cygpath -w "$p")
   p=$(realpath "$p")
   ```
4. 不要用 `pwd -W`；需要当前目录就直接 `pwd`。
5. `pwd -P` 的 `\\?\` 只适合直接喂文件 API，不适合展示、拼接或做字符串比较。
6. 看到 `/c/...`、`/mnt/c/...`、`/cygdrive/c/...` 可以交给本 shell 的 `cd`/文件操作/外部命令（后者需 0002）；但传给原生外部程序做参数时，优先先转成 `C:\...`。
7. `ls -d /c/...` 的输出只是回显，不是 canonicalize；不要把它当成解析结果。

## 8. 上游 issue 地图

| 编号 | 状态 | 关系 |
|---|---|---|
| [#1142](https://github.com/reubeno/brush/issues/1142) | open | MSYS `/c/` 整体语义；无专门修复 PR |
| [#1251](https://github.com/reubeno/brush/issues/1251) / [#1252](https://github.com/reubeno/brush/pull/1252) | issue open / PR open | 相对路径执行；本地 0002 |
| [#1463](https://github.com/reubeno/brush/pull/1463) | draft, conflicting | 广义路径解析重构，可能覆盖 #1251 |
| [#1303](https://github.com/reubeno/brush/issues/1303) / [#1304](https://github.com/reubeno/brush/pull/1304) | open / draft | 进程 cwd 不 `chdir`；opt-in，多 shell 嵌入不适用 |
| [#1317](https://github.com/reubeno/brush/issues/1317) | open | PATHEXT 裸命令 spawn；0002 不覆盖 |
| [#1157](https://github.com/reubeno/brush/issues/1157) | open | Cygwin target 构建，不是 native Windows 模拟 |

## 9. 验证

```sh
cd vendor/oh-my-pi/upstream
cargo test -p brush-core --lib cygwin
cargo test -p pi-builtins --lib cygwin_drive_alias_is_accepted
cargo test -p pi-builtins --lib
cd ../..
node scripts/vendor.mjs check
```

手工冒烟（0003 + 0002 的构建产物）：

```sh
cd /cygdrive/c/Windows && pwd          # C:\Windows
test -d /cygdrive/c/Windows && echo ok
/cygdrive/c/Windows/System32/where.exe cmd.exe
pwd -W                                  # 预期：报错
```

发现某条路径没生效时，先看它是否走 §4 的入口；绕过 `absolute_path` 的直接 filesystem 调用要单独补，不要假设 0003 自动覆盖。

## 10. 参考资料

- [Windows file path formats](https://learn.microsoft.com/en-us/dotnet/standard/io/file-path-formats)
- [Naming Files, Paths, and Namespaces](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file)
- [CreateProcessA](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessa)
- [Rust std::path::Path](https://doc.rust-lang.org/std/path/struct.Path.html)
- [Rust std::process::Command](https://doc.rust-lang.org/std/process/struct.Command.html)
- [MSYS2 Filesystem Paths](https://www.msys2.org/docs/filesystem-paths/)
- [Cygwin cygpath](https://cygwin.com/cygwin-ug-net/cygpath.html)
- [normalize_path](https://docs.rs/normalize-path)
- [dunce](https://docs.rs/dunce)
