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

## Tests

```sh
node scripts/vendor.mjs check                 # 0001 … 0006 apply in order
node scripts/vendor-natives-js.mjs check      # vendored copy == pin + 0006
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
