# dsh-tool-plus — Essential Tools Enhancement for DeepSeek Harness

[简体中文](./README.md) | English

Essential tools enhancement for DeepSeek Harness: persistent bash, structured read, multi-mode edit, atomic write, full-text search, and direct image reading — one plugin covers it all. Ported from the [Oh My Pi](https://github.com/can1357/oh-my-pi) core; once installed it automatically takes over the official bash / pwsh / file / search tools, with optional `ast_grep` / `ast_edit` structural search and rewrite.

> Currently in early beta — behavior and configuration may change at any time.

## Features

- **bash**: persistent shell; `cd` and `export` keep state across calls; verbose logs (git/npm/cargo…) are condensed automatically; overlong output keeps only head and tail, with the full content written to disk for later retrieval; long-running commands are moved to the background automatically; optionally intercepts `cat`, `grep`, `find`, and `sed -i` to steer you toward the dedicated tools
- **read**: precise line-range reading (supports `:N-M`, `:raw`, and multiple ranges); large code files return a structural summary by default, with details expanded on demand; zip/tar archives, SQLite, notebooks, and PDFs read directly; PNG / JPEG / WebP / GIF images read directly, oversized ones scaled down automatically; can fetch web content (including images embedded in the page)
- **write**: atomic writes that return a diff of the changes; supports patch-style writing, and can write directly into zip/tar archive members and SQLite data
- **edit**: `replace` by default, with patch / hashline / apply-patch formats also supported; multi-hunk edits, uniqueness validation, fuzzy matching tolerant of whitespace differences
- **grep / glob**: full-text search and filename matching; mtime sorting, context lines, and configurable ignore rules
- **ast_grep / ast_edit** (optional): syntax-tree based structural code search and rewrite, enabled in settings
- **agent presets**: two companion templates — Standard enhanced and PTC (Code Mode) — installable in one command (see Installation)

## Recommended Environment & Configuration

- **Full-access mode**: the plugin is best used under `danger-full-access`, which avoids file writes being blocked by mistake in sandboxed modes.

## Installation

Install **both** the plugin and the presets:

- **Tool plugin**: provides the full toolset and takes over the official bash / pwsh / file / search tools;
- **Agent presets**: the official presets contain no configuration for these tools, so the stock setup is missing capabilities — the Standard / PTC templates exist to fill exactly that gap.

### Install from npm (recommended)

```sh
dsh plugin --profile web add @xiaoso/dsh-tool-plus@beta
```

### Install from GitHub

Track the latest development build (the project has no formal release yet — every install is a test build):

```sh
dsh plugin --profile web add github:xiaoso456/dsh-tool-plus
```

### Local development

```sh
dsh plugin --profile web add link:<path to this repo>
```

### Preset installation

**Option 1 · Install with the npx script**

```sh
npx @xiaoso/dsh-tool-plus-presets@beta
```

**Option 2 · Have an AI session configure the presets** (no dependency on the package above) — paste the following into an AI session that can edit files on your machine:

```text
Please install the two enhanced agent presets for DeepSeek Harness.

1. Locate the official preset directory config/agent-presets/ inside the globally installed dsh package;
   it contains the standard and code templates, each with preset.yml and agent.cordis.yml.
   (On Windows it is under the global node_modules\@deepseek-ai\dsh\ directory; on macOS/Linux run
   npm root -g first to locate it; if you cannot find it, search the whole disk for the installed
   @deepseek-ai/dsh package.)
2. Create two directories under ~/.dsh/.agent-presets/: tool-plus-standard and tool-plus-ptc.

3. tool-plus-standard: copy over the two files from the official standard template, then modify:
   - Replace preset.yml entirely with:
       name: Tool Plus 标准增强版
       description: Full standard-mode capabilities, file/shell toolset replaced by @xiaoso/dsh-tool-plus, pwsh disabled by default
       order: 2
   - agent.cordis.yml:
     a. Change the entry with id: tool-bash to
          - id: tool-plus
            name: '@xiaoso/dsh-tool-plus'
            disabled: true
     b. Change the id: tool-pwsh entry's platform-conditional disable into a plain disabled: true line
     c. Delete the two entries with id: tool-fs and id: tool-fs-search entirely
        (the latter also carries a sampleOverCapGlobResults setting)

4. tool-plus-ptc: copy over the two files from the official code template and make exactly the same
   three changes as in step 3, except replace preset.yml with:
       name: Tool Plus PTC 增强版
       description: Full PTC (Code Mode) capabilities, file/shell toolset replaced by @xiaoso/dsh-tool-plus, pwsh disabled by default
       order: 3

5. When done, list the file trees of both directories and remind me to restart any running dsh
   so the presets take effect.
```

Keep the `name:` fields as shown — they match the templates the npx script installs. Both options produce the same result: the files land in `~/.dsh/.agent-presets/`; restart dsh and select the preset in your session to activate it.

## Configuration

Works out of the box, no configuration needed. Common tweaks: background threshold (`autoBackgroundMs`), timeouts (`defaultTimeoutMs` / `maxTimeoutMs`), the output truncation window, the default edit mode (`editMode`, default `replace`), and the structured summary toggle (`readSummarizeEnabled`).

## Requirements

- **dsh CLI**: installed globally, `npm i -g @deepseek-ai/dsh`
- **Node.js** ≥ 22.19 or ≥ 24
- **Git Bash** (recommended): serves as the bash execution environment on Windows
- Targets DeepSeek Harness `dsh` v0.1.1-rc.2 (pre-release; interfaces may change)

## Notes

- No standalone `pwsh` tool: shell work is handled by the more capable persistent `bash`

## Build

```sh
pnpm install
pnpm build     # type declarations (tsc) + tsdown bundle + asset copy
pnpm typecheck
pnpm test      # includes real-bash cases; needs Git Bash on Windows, auto-skips when missing
```

## License

[MIT](LICENSE); third-party component licenses in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
