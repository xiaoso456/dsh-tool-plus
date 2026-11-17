# 0006 pi-natives: resolve our own platform package

- Patch: `patches/0006-natives-local-platform-package.patch`
- Upstream issue/PR: none filed (downstream packaging deviation)
- Status: local
- Files: `packages/natives/native/loader-state.js`

## Why

tool-plus ships its own `pi_natives.<platform>-<arch>.node`: upstream's addon
plus the in-process shell builtins (`zip`, `tree`, `uuidgen`, `strings`,
`hexdump`, `rev`, `free`, `bc`). It is published as
`@xiaoso/dsh-tool-plus-natives-<tag>` and pulled in through
`optionalDependencies`, so npm installs it next to upstream's own platform
package.

Installing it is not enough. `resolveLoaderCandidates` searches exactly two
places in a normal Node process:

```
leafPackageDir/<file>   leafPackageDir = @oh-my-pi/pi-natives-<tag> (upstream's)
nativeDir/<file>        <@oh-my-pi/pi-natives>/native/
```

Our package is neither, so the loader kept requiring upstream's addon and the
builtins never existed at runtime, while the 116 MB platform package sat
unused in `node_modules`.

`loadNative()` cannot be steered from outside either: it calls
`initLoaderContext()` with no arguments, so a caller-supplied
`leafPackageDir` is discarded.

Two smaller problems surface once this file is bundled into the plugin:

- `import packageJson from "../package.json" with { type: "json" }` resolves to
  the *consuming plugin's* manifest (version 0.1.x, not 18.12.6). The version
  feeds both `versionedDir` and the release-stamp check, so a wrong value
  rejects the addon.
- `import.meta.dir` is Bun-only; under Node it is `undefined` and
  `path.join(undefined, "..", "native")` throws. This hunk was previously
  carried as an external pnpm patch (`patches/@oh-my-pi__pi-natives.patch`),
  which only ever applied to our own install; consumers only got it through the
  runtime self-heal in `scripts/patch-pi-natives.mjs`.

## Behaviour

Before: the loader only ever considered `@oh-my-pi/pi-natives-<tag>`, so the
patched addon was never loaded and the extra builtins were missing.

After:

- `resolveLeafPackageDir` tries `@xiaoso/dsh-tool-plus-natives-<tag>` first and
  falls back to `@oh-my-pi/pi-natives-<tag>`. An install without our package
  keeps working on upstream's addon, just without the builtins.
- `packageVersion` comes from the installed `@oh-my-pi/pi-natives` manifest
  (`require.resolve("@oh-my-pi/pi-natives")` + sibling `package.json`), so the
  stamp check still compares against the real version. If resolution fails it
  degrades to `"0.0.0"`, which the stamp check then rejects loudly instead of
  crashing on `undefined`.
- `nativeDir` uses `import.meta.dirname` and works under Node.

No behaviour change for consumers that never install our platform package.

### 暂存副本只能顶掉同一份构建（同一个 bug 的第二个入口）

Windows 上 `shouldStageNodeModulesAddon` 会把 `.node` 镜子到
`~/.omp/natives/<版本>/`，而 `resolveLoaderCandidates` 把这份缓存排在平台包
**前面**（上游为了 `bun install -g` 更新安全）。但那个目录只按**上游版本号**
命名（`18.12.6`），所有发过这个版本的分发共用同一格：早期 tool-plus（用上游
addon）或上游自己留下的文件，会一直遮住新装的平台包，而且它「pre-sentinel」
兼容桥还能通过校验，于是**少了只有新构建才有的导出**——`hideHostConsole`
就是这么在桌面端丢的（宿主没拿到隐藏控制台，每条命令闪一个控制台窗口）。

现在暂存副本要跟平台包**同一份构建**才允许排在前面：暂存是逐字节拷贝，所以
比较大小即可（不同构建同长度基本不可能）。不信任的一律跳过、**绝不覆盖**
（那份文件可能正被别的进程 map 着），让平台包直接赢。

例外：平台包里**没有**可比对的 `.node` 时（装了一半、被杀毒隔离、解压失败）
仍信任缓存——那时缓存是唯一能跑的东西，拒绝会让整个插件加载失败（实测过：
把平台包的 `.node` 挪走，插件直接报 `Failed to load pi_natives native addon`）。
这种"包在、二进制没了"的场景，设置页会显示 `foreign-addon` 并点出实际路径。

- 平台包解析不到（没有可比对象）时保持上游行为：缓存照旧优先。
- 只在 `stageFromNodeModules` 打开时生效；非 Windows、开发目录、编译产物不变。

## Tests

```sh
node scripts/vendor.mjs check                 # 0001 … 0006 apply in order
node scripts/vendor-natives-js.mjs check      # vendored copy == pin + 0006
pnpm vitest run tests/unit/native-loader-candidates.spec.ts   # 候选顺序：异构建的暂存副本不得遮住平台包
node scripts/check-native-packages.mjs        # (added with the platform packages)
```

Runtime validation: with our platform package installed, `zip -L` reports the
builtin `zip`, and the startup log names the addon it loaded. Without it the
same command returns 127 and the loader still loads upstream's addon.

## Risks

- The `require.resolve("@oh-my-pi/pi-natives")` fallback assumes the plugin
  keeps a direct dependency on that package. It does, and
  `pi-agent-core`/`pi-ai`/`pi-tui`/`pi-utils` depend on it as well.
- Both packages must stay resolvable without an `exports` restriction: upstream's
  platform package has no `exports` field, and ours is generated the same way.
- Upstream rewrites this file often. A pin bump that touches these three spots
  produces a patch conflict in `vendor:check` — mechanical, three hunks.

## Removal condition

Delete this patch + note + ledger row once upstream exposes a supported way to
point the loader at a different platform package (env var, option, or an
overridable package name). Verify by running `node scripts/vendor.mjs check`
and the runtime check above with the patch removed.
