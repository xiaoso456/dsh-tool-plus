<div align="center">
  <img width="160" src="assets/icon.png" alt="dsh tool plus icon"><br>
  <img width="240" src="assets/wordmark.png" alt="dsh tool plus">
</div>

<div align="center">

[简体中文](./README.md) | English

</div>

<div align="center">

[![npm version](https://img.shields.io/npm/v/@xiaoso/dsh-tool-plus?logo=npm)](https://www.npmjs.com/package/@xiaoso/dsh-tool-plus)
[![License: MIT](https://img.shields.io/github/license/xiaoso456/dsh-tool-plus)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24.9-339933?logo=nodedotjs)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-windows%20%7C%20macos%20%7C%20linux-lightgrey)]()

</div>

Essential tools enhancement for DeepSeek Harness: bash takes over the shell work PowerShell used to do, alongside structured read, multi-mode edit, atomic write, full-text search and direct image reading. The core is ported from [Oh My Pi](https://github.com/can1357/oh-my-pi); once installed it takes over the official bash / pwsh / file / search tools.

![dsh tool plus: dsh on Windows, now with bash and common Linux commands](./assets/hero.en.png)

## Installation

> ⚠️ **Restart dsh after the first install and after every upgrade.**

### Requirements

- **dsh**: `v0.2.2-rc.3` or newer (pre-release; interfaces may change)
- **Node.js** ≥ 24.9
- **Git Bash** (recommended on Windows): bash itself is built into the plugin; Git Bash only adds common Linux tools beyond the built-in commands (such as `awk`)
- **Permissions**: `danger-full-access` is recommended, so sandboxed modes do not block file writes by mistake

### Web

```sh
dsh plugin --profile web add @xiaoso/dsh-tool-plus
```

### Desktop

Install from the app's plugin page by entering the package name `@xiaoso/dsh-tool-plus`.

## Features

### Shell

- **bash**: 150+ commands built in — `ls`, `grep`, `sed`, `jq` and friends work without the system programs of the same name
  - Commands the system often lacks, such as `zip`, `tree`, `bc` and `gzip` / `zstd` / `xz`, ship with the plugin ([details](docs/shell-commands/README.md))
  - The working directory follows `cd` across calls
  - Verbose logs (git/npm/cargo…) are condensed; overlong output keeps only head and tail, with the full content written to disk for later retrieval
  - Long-running commands move to the background
  - Optionally intercepts `cat`, `grep`, `find` and `sed -i` to steer the model toward the dedicated tools (off by default)
- **Safe delete**: `rm` moves files to the system trash by default, so accidental deletes are recoverable; use `command rm` for a real delete

### Files

- **read**: precise line-range reading (`:N-M`, `:raw`, multiple ranges)
  - Large code files return a structural summary by default, with details expanded on demand
  - zip/tar archives, SQLite, notebooks and PDFs read directly
  - PNG / JPEG / WebP / GIF images read directly and scaled down when oversized
  - Fetches web content (including images embedded in the page); SPA sites are fetched through local browser rendering
- **write**: atomic writes that return a diff; supports patch-style writing, and can write directly into archive members and SQLite data
- **edit**: `replace` by default, with patch / hashline / apply-patch formats also supported; multi-hunk edits, uniqueness validation, fuzzy matching tolerant of whitespace differences

### Search

- **grep / glob**: full-text search and filename matching; mtime sorting, context lines and configurable ignore rules
- **ast_grep / ast_edit** (optional): syntax-tree based structural search and rewrite, enabled in settings

### Settings and presets

- **Command panel**: choose, per command, the plugin's built-in, the system program, or an executable of your own
- **agent presets**: Standard enhanced and PTC (Code Mode)

## Usage

### Presets

| Preset | Base | What it is |
|---|---|---|
| **Tool Plus 标准增强版** | official standard | everything in standard mode, with the file/shell toolset swapped for this plugin |
| **Tool Plus PTC 增强版** | official PTC (Code Mode) | same, but composing multi-step operations through Code Mode's `run_code` |

Once the plugin is installed, pick one from the preset list. To adjust them, go to Settings → Tool Plus → Presets: after an official upgrade, click "Follow the official preset"; to go back to the default, click "Revert to bundled".

### Settings

All under Settings → Tool Plus:

- **Command panel** (Bash → Commands): lists every command bash can run and where it comes from; point each one at the plugin's built-in, the system program, or an executable you pick. Changes apply to the next shell
- **Shell init** (Bash → Shell init): a script run each time a shell is created; edit, test-run or reset it

## Performance

On Linux, comparing the official standard mode with this plugin's Standard enhanced preset (SWE-bench Multilingual, 20 tasks × 3 rounds). Numbers are from plugin 0.1.13; 0.2.x has not been re-measured.

| Metric | Official tool surface | This plugin (command interception on) | This plugin (command interception off, default) |
|---|---|---|---|
| Resolve rate | 83.3% | **83.3%** | 81.7% (1 task lower, within normal variance) |
| Steps / task | 24.4 | 29.7 (+21.7%) | 25.3 (+3.8%) |
| Total tokens / task | **729,434** | 954,100 (+30.8%) | 779,799 (+6.9%) |
| System prompt / step (incl. tool definitions) | **4,642** | 6,305 (+35.8%) | 6,305 (+35.8%) |
| System prompt total / task (per step × steps) | **113,265** | 187,259 (+65.3%) | 159,622 (+40.9%) |
| Net tokens / task (excl. system prompt) | **616,169** | 766,841 (+24.5%) | 620,177 (+0.7%) |
| Average context length at task end (tokens) | **42,817** | 48,645 (+13.6%) | 44,781 (+4.6%) |
| `read` calls | 225 | 459 | **198** |
| `bash` time per call | 3,140 ms | **2,391 ms** | 2,045 ms |
| `bash` tokens returned per call | 790 tok | **343 tok** | 638 tok |
| Average time / task | **123 s** | 135 s | 151 s |

Notes:

1. Average time is measured end to end and moves with token rate and network speed; use it for horizontal comparison only
2. This benchmark uses little context and does not represent large tasks
3. The figures were cross-checked by a model; small slips are possible without changing the overall conclusion

Conclusions:

1. The resolve rate matches the official tools (the interception-off group is 1 task lower, within normal variance)
2. `bash` itself is leaner and faster, but the tokens it saves are roughly cancelled out by the thicker tool definitions (the plugin adds capabilities)
3. On Linux the combined performance is on par with the official standard mode, with a richer feature set; Windows is not suitable for the standard benchmark, so the only claim there is a **personal impression** that it is more pleasant to use than PowerShell

Full data and the per-task matrix: [docs/benchmark/sbml-compare-ops.md](docs/benchmark/sbml-compare-ops.md) (Chinese).

## Notes

- No standalone `pwsh` tool: shell work is handled by the more capable `bash`
- **bash state**: by default each command gets its own shell and only the working directory follows `cd`; set `autoBackgroundMs` to `0` to share one persistent shell, where exported variables, aliases and shell functions carry over. The change applies immediately — the description the model sees is rewritten with it, no restart.
- Presets showing "failed to load": the plugin is too old (0.1.19 or earlier), upgrade it; if the official presets changed after that, click "Follow the official preset" under Settings → Tool Plus → Presets to rebase them
- Pointed a command at the wrong program in the command panel: change it back there, or delete `$DSH_HOME/tool-plus/commands.json` to return to the defaults

**Safe rm sends deleted files to the system trash.** Where they land, and whether you can see them:

| | Windows | macOS | Linux |
|---|---|---|---|
| **Location** | Recycle Bin | Trash `~/.Trash` | `$XDG_DATA_HOME/Trash`; defaults to `~/.local/share/Trash` |
| **Another volume / external disk** | That volume's Recycle Bin | That volume's `.Trashes` | `.Trash-<uid>` at that mount point |
| **Visible in the OS trash** | Yes | Yes | Same volume: yes; another volume: open that location |
| **File name** | Unchanged | Unchanged | A UUID; the original name comes from `.trashinfo` |
| **Put back** | Yes | Yes | Depends on the file manager |
| **Implementation** | Shell API | System API | Third-party XDG implementation |
| **Known limits** | No Recycle Bin on network drives | Requires macOS 10.12+ | Some desktops do not list it — restore from the location above |

## License

[MIT](LICENSE); third-party component licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
