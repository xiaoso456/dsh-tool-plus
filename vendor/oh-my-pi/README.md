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
`cargo test -p pi-builtins --lib` run passes 1449 tests (11 ignored, 2026-11-15).

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

Business code lives in `overlay/`; only upstream integration points or
behaviour changes get a numbered patch and a row here. Behaviour patches also
get a note under [`patches/notes/`](./patches/notes/README.md); wiring patches
do not.

| patch | area | change | why | upstream issue/PR | applies to | test | removal condition |
|---|---|---|---|---|---|---|---|
| `0001-shell-commands.patch` | `pi-builtins` | one aggregated wiring patch: `util.shellcmds` feature (pulls `util.zip`/`util.tree`/`util.gzip`/`util.envsubst`/`util.zstd`/`util.xz`), four dependencies (`zip`, `flate2`, `zstd`, `xz2`), `mod shellcmds`, one `shellcmds::register(&mut m)` call in `factory.rs`, the pi-natives feature switch, the Bazel feature line, and the cumulative `Cargo.lock` entries | brush has no `zip`/`tree`/gzip trio/envsubst/zstd/xz; Windows users need these in-process | - | `v18.12.6` | `cargo test -p pi-builtins` (all command modules) | remove once upstream ships these builtins; then delete the patch and the matching `overlay/` modules |
| `0002-brush-windows-relative-exec.patch` | `brush-core` | `compose_std_command` normalizes a native-local executable path against the shell working directory on Windows; new `sys::fs::normalize_executable_path`, regression test in `pi-builtins` | Windows `CreateProcess` resolves a relative image name against the parent process cwd, not the shell cwd, so `cd dir; ./tool.exe` failed with 127 | [#1251](https://github.com/reubeno/brush/issues/1251), [#1252](https://github.com/reubeno/brush/pull/1252), [#1463](https://github.com/reubeno/brush/pull/1463), [#1518](https://github.com/reubeno/brush/pull/1518), [#1519](https://github.com/reubeno/brush/pull/1519) | `v18.12.6` | `cargo test -p pi-builtins --lib relative_external_command_resolves_after_cd` | #1252 or #1463 merged into pinned `brush-core`; delete patch + note + row, keep the regression test (#1518/#1519 alone are not enough) |
| `0003-brush-cygdrive-path-alias.patch` | `brush-core` | accepts Cygwin's default `/cygdrive/<drive>` spelling as an input alias in `normalize_shell_path` and in glob roots; no output/argument conversion | Cygwin tools emit `/cygdrive/c/...`; native brush treated it as `<current-drive>:\cygdrive\c`, so `cd` and external commands failed | [#1142](https://github.com/reubeno/brush/issues/1142), [#1157](https://github.com/reubeno/brush/issues/1157), [#1463](https://github.com/reubeno/brush/pull/1463) | `v18.12.6` | `cargo test -p pi-builtins --lib cygwin_drive_alias_is_accepted` | upstream #1142/#1463 supports the alias; delete patch + note + row, keep the regression tests |
| `0004-pi-shell-windows-git-discovery.patch` | `pi-shell` | `configure_windows_path` skips `where git` when the HKLM Git for Windows `InstallPath` contains `bin\bash.exe`; unavailable/stale registry falls back to the PATH probe; no cross-shell cache | `where git` costs ~90ms and every new shell runs it; default auto-background creates one shell per call | [#7430](https://github.com/can1357/oh-my-pi/issues/7430), [#9776](https://github.com/can1357/oh-my-pi/pull/9776) | `v18.12.6` | `cargo test -p pi-shell --lib windows::tests` | upstream stops probing `where git` when the registry is usable, or adds an equivalent policy; delete patch + note + row |
| `0005-bazel-pin-windows-sdk.patch` | `bazel` (build only) | `xwin_sysroot(name = "xwin_sysroot")` pins `sdk_version = "10.0.22621"`, matching the arm64 repo, so both MSVC cross-compile sysroots are independent of the SDK release train | xwin 0.6.5 cannot splat the current "latest" SDK: `unable to find x86_64 headers for Win11SDK_10.0.26100` fails the repo fetch before any compile and kills every `native-v*` run | - | `v18.12.6` | `node scripts/vendor.mjs check` plus a `native-v*` CI run | drop once the pinned xwin handles the latest SDK, or once upstream pins x64 the way it pinned arm64; delete patch + note + row |

Rules:

- Keep one **wiring** patch. Every self-written command registers through
  `overlay/crates/pi-builtins/src/shellcmds.rs`; adding a command touches the
  overlay only, never the patch.
- A semantic change to existing upstream behaviour (`brush-core`,
  `brush-parser`, or an upstream `pi-builtins` builtin) gets its own numbered
  patch (`0002+`) and a note under `patches/notes/`. Do not append it to
  `0001`, and do not hide it in an overlay copy of an upstream file.
- Every patch, wiring or semantic, gets a ledger row.
- Record the upstream issue/PR when there is one; prefer upstreaming.
- A patch that only patches the JS loader belongs in
  `patches/@oh-my-pi__pi-natives.patch` (pnpm patch), not here.
- Regenerating the patch: `git reset --hard` in `vendor/oh-my-pi/upstream`,
  copy `overlay/crates/pi-builtins/src/*` over the checkout, apply the wiring
  (feature entry, dependencies, `mod shellcmds`, one factory call, pi-natives
  feature, Bazel feature), run `cargo check` so `Cargo.lock` settles, then
  `git -c core.autocrlf=false diff > ../patches/0001-shell-commands.patch`.
- Re-check the whole ledger on every upstream bump.
