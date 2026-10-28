# Vendored oh-my-pi native layer

This directory pins the OMP source used to build a **patched** `pi-natives`
addon. The upstream checkout is not committed; the tracked pieces are the pin,
the source overlay, the integration patch ledger, and the scripts that
reproduce the build.

## Why

- `@oh-my-pi/pi-natives` is a prebuilt native addon. `pnpm patch` can change
  its JS loader, but it cannot change Rust behaviour.
- Any invasive change therefore needs a pinned source checkout, a recorded
  patch, and a platform build. Mixing that into the main plugin package would
  make the JS package huge and hide which native patch is running.

The upstream checkout lives at `vendor/oh-my-pi/upstream/` and is gitignored.
It is recreated by `pnpm vendor:init` locally, or by a second
`actions/checkout` step in CI.

Our Rust source lives in `vendor/oh-my-pi/overlay/` and is tracked. Edit the
overlay, then copy it into the checkout with `pnpm vendor:sync`; patches only
carry the small integration points.

## Pin

The pin source of truth is [`lock.json`](./lock.json); the source of truth
for local Rust code is [`overlay/`](./overlay/):

- upstream repo + tag + commit
- `@oh-my-pi/pi-natives` version
- `brush-core` / `brush-parser` versions
- build tool versions and the full platform target list

Never edit the checkout in place; edit `overlay/` and run `pnpm vendor:sync`.

## Local commands

```sh
# Seed from the read-only reference clone (fast, no second GitHub clone)
pnpm vendor:init -- --from refs/oh-my-pi

# Or clone the pinned upstream commit (needs network)
pnpm vendor:init

# After editing vendor/oh-my-pi/overlay/, copy it into the checkout
pnpm vendor:sync

# Copy the overlay and apply the integration patches (local build)
pnpm vendor:apply

pnpm vendor:check
```

`vendor:init` checks out the pin and syncs the overlay. `vendor:check` verifies:

1. `upstream/HEAD` equals `lock.commit`
2. a temporary clean worktree receives the overlay
3. every `patches/*.patch` applies sequentially in filename order on that tree

## Local native build (Windows)

OMP's windows host path uses Cargo/N-API rather than Bazel. Start from an
applied checkout (`pnpm vendor:init` then `pnpm vendor:apply`):

```sh
cd vendor/oh-my-pi/upstream
bun install --frozen-lockfile --ignore-scripts --filter @oh-my-pi/pi-natives
RUSTUP_TOOLCHAIN=nightly-2026-10-06 \
  bun run scripts/bazel-natives.ts host --dest ../build/win32-x64
```

Prerequisites: Bun, the pinned nightly Rust toolchain, and Visual Studio Build
Tools with CMake/Ninja (the build script locates them via vswhere). Cross
targets cannot be built from a Windows host; use Linux/macOS for those.

### Verified local result (2026-10-26)

`win32-x64-modern` built successfully on this machine:

- `pi_natives.win32-x64-modern.node`, 112 MB
- build time about 11m20s
- loaded with `process.dlopen`, reports `18.12.6`, and an in-process
  `grep()` smoke test passed

Two environment issues were hit, both reproducible:

1. **Stable Rust cannot compile this tree.** `crates/pi-vfs` uses the nightly
   `result_option_map_or_default` feature. Use the pinned
   `nightly-2026-10-06`; stable fails with E0658.
2. **crates.io can stall on this network.** Resolve with a Cargo mirror before
   building. The local test used a separate `CARGO_HOME` whose `config.toml`
   replaced crates.io with `sparse+https://rsproxy.cn/index/`; the normal
   registry then built from the cache.

The host build picks `modern` on an AVX2 machine; baseline is built by the CI
matrix's explicit target.

### Verified local result (2026-10-28)

After the `zip` compatibility work, a debug host build was produced with the
Visual Studio 2022 bundled CMake/Ninja (the earlier failure was simply that
`cmake` was not on `PATH`):

- `cargo build -p pi-natives` produced `target/debug/pi_natives.dll`
- copied to `%TEMP%\dev-natives\18.12.6\`, stamped with
  `bun scripts/stamp-native-version.ts`, and loaded through
  `PI_NATIVES_DIR`; the loader reported the local addon as `18.12.6`
- `type -a zip` resolved to the shell builtin; `zip -L`, `zip -V`, and
  `zip -du ...` all exited 0

### `zip` builtin compatibility

The overlay adds an in-process `zip` builtin under the `util.zip` feature.
It covers the Info-ZIP switches that map cleanly onto the archive model; the
Windows-relevant surface is complete.

| area | switches |
|---|---|
| core | create/update/freshen/grow/delete/test/list, `-r/-R`, `-0..-9`, `-Z store\|deflate`, `-u -f -g -d -T -y -D -x -i` |
| names/paths | `-j -jj -p -k` (DOS 8.3), `-n`, `-@`, `-m`, `-o`, `-X`, `-c`, `-z`, `-U/--out` |
| Windows | `-S/--system-hidden`, `-AS/--archive-set`, `-AC/--archive-clear`, `-TT/--test-command` |
| sync | `-FS/--filesync`, `-DF/--difference`, `-RE/--regex`, `-MM/--must-match` |
| progress/logging | `-db -dc -dd -dg -ds -du -dv -lf -la -li` |
| info | `-L/--license`, `-V/--version-info`, `-h2`, `-so/--show-options` |

Accepted for compatibility but not applicable on Windows: `-FI/--fifo`
(Unix FIFOs) and `-N/--notes` (Amiga/MacOS filenotes).

Not implemented: non-Windows platform switches `-a -B -C/-C2/-C5 -E -I -w -!`;
split archives (`-s/-sp/-sb/-sv`), repair (`-F/-FF`), and SFX adjustment
(`-A/-J`) because `zip 9.1.2` has no support for them. `-s` remains an alias
for `--show-files`.

Tests: `cargo test -p pi-builtins zipcmd` covers the builtin; the full
`cargo test -p pi-builtins` run currently passes 1280 tests.

## CI

[`.github/workflows/native.yml`](../../.github/workflows/native.yml) does two
things:

- Pull requests touching the vendor pin: checkout the pinned commit, verify
  the patch series, and stop there.
- `native-v*` tags / manual dispatch: build the full matrix and upload
  `pi-natives-<target>` artifacts. Tagged runs also attach the addons and a
  `SHA256SUMS` file to the GitHub Release.

Matrix targets: `linux-x64-baseline`, `linux-x64-modern`, `linux-arm64`,
`linux-musl-x64-baseline`, `linux-musl-arm64`, `darwin-arm64`,
`darwin-x64-baseline`, `win32-x64-baseline`, `win32-arm64`. Windows
targets and musl are Bazel cross builds on Linux; Windows host is a separate
Cargo/N-API smoke job.

npm platform packages are a later packaging step: the build workflow produces
the native artifacts and the provenance trail first; publishing them as
`@xiaoso/pi-natives-patched-<platform>` should only be wired after the local
build and the wrapper loader are proven.

## Patch ledger

Business code lives in `overlay/`; only upstream integration points get a
numbered patch and a row here.

| patch | area | change | why | upstream issue/PR | applies to | test | removal condition |
|---|---|---|---|---|---|---|---|
| `0001-zip-integration.patch` | `pi-builtins` | wires the tracked `overlay/` zip source into the crate: `util.zip` feature, `zip` dependency, factory registration, Bazel feature | brush has no `zip`; shell users need a drop-in archive command without a system binary | — | `v18.12.6` | `cargo test -p pi-builtins zipcmd` | remove when upstream ships a `zip` builtin, or when the shell no longer exposes in-process utilities |

Rules:

- Keep one patch focused on one problem.
- Record the upstream issue/PR when there is one; prefer upstreaming.
- A patch that only patches the JS loader belongs in
  `patches/@oh-my-pi__pi-natives.patch` (pnpm patch), not here.
- Re-check the whole ledger on every upstream bump.
