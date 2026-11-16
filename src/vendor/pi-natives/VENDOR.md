# vendored pi-natives loader

这是 `@oh-my-pi/pi-natives` 的 **JS 加载器**副本，不是手写代码。它入库的唯一原因是
tool-plus 需要改它的平台包解析逻辑（`vendor/oh-my-pi/patches/0006`），而这段 JS 会被
tsdown 打进 `lib/` —— 编译输入必须在仓库里。

## 来源

| | |
|---|---|
| 上游 | `vendor/oh-my-pi/lock.json` 的 `repo` / `tag` / `commit` |
| 上游路径 | `packages/natives/native/` |
| 应用补丁 | `vendor/oh-my-pi/patches/0006-natives-local-platform-package.patch` |

## 生成

```sh
node scripts/vendor-natives-js.mjs sync    # 重新生成
node scripts/vendor-natives-js.mjs check    # 漂移检查（CI 必跑）
```

## 文件角色

| 文件 | 来源 |
|---|---|
| `index.js` `path.js` `desktop.js` `desktop-adapter.js` `embedded-addon.js` `version-sentinel.js` | 上游逐字复制 |
| `loader-state.js` | 上游 + `0006` 补丁的生成物 |
| `index.d.ts` `path.d.ts` `desktop.d.ts` | 一行 re-export，类型从 npm 包借（它自己的 `index.d.ts` 有 4230 行） |

**不要手改这个目录里的任何文件。** 想改行为就改 `0006` 补丁，然后跑 `sync`；
`check` 会逐字节比对「pin + 补丁」的重算结果，手改必然红。

## 升级上游时

1. 改 `vendor/oh-my-pi/lock.json` 的 tag/commit
2. `node scripts/vendor.mjs sync` → `node scripts/vendor.mjs check`
3. `node scripts/vendor-natives-js.mjs sync`
4. `git diff src/vendor/pi-natives/` —— 这里就是上游 JS 面的每一行变化；补丁冲突会在第 2 步
   的 `vendor:check` 里先红
5. 跑 `pnpm natives:check && pnpm typecheck && pnpm build && pnpm test`
