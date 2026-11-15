# 0003 Cygwin /cygdrive path alias

- Patch: `patches/0003-brush-cygdrive-path-alias.patch`
- Upstream issue/PR: [#1142](https://github.com/reubeno/brush/issues/1142); related [#1157](https://github.com/reubeno/brush/issues/1157), [#1463](https://github.com/reubeno/brush/pull/1463)
- Status: local
- Files: `crates/vendor/brush-core/src/sys/fs.rs` (`drive_alias_parts`, `pattern_drive_alias_root_impl`), `crates/pi-builtins/src/host.rs` (regression test)

## Why

Cygwin's default Windows drive mapping is `/cygdrive/c/...`, not MSYS2's
`/c/...` and not WSL's `/mnt/c/...`. brush is a native Windows binary with
no MSYS/Cygwin runtime, so nothing converts that spelling automatically.

The pinned `brush-core` already aliases `/c/...`, `/mnt/c/...` and
`/tmp` in `normalize_shell_path`; `/cygdrive/c` was left as a native
Windows rooted path, i.e. `<current-drive>:\cygdrive\c`, which normally does
not exist.

This is an input-only compatibility alias. It does not make brush an MSYS
runtime, does not change shell output, and does not translate arguments passed
to native external programs. The upstream discussion in #1142 explains why a
full `/` mapping is not a simple change; this patch deliberately takes only
the default Cygwin spelling.

## Behaviour

Before: `cd /cygdrive/c/Windows` failed with `i/o error`; executing
`/cygdrive/c/Windows/System32/where.exe` failed with 127.

After, `/cygdrive/<single ASCII drive letter>` is treated like the other
drive aliases:

```sh
cd /cygdrive/c                  # C:\
cd /cygdrive/c/Windows          # C:\Windows
cd /CYGDRIVE/D/Project          # D:\Project
echo /cygdrive/c/Windows/System32/where.*   # glob root is C:\
/cygdrive/c/Windows/System32/where.exe cmd.exe
```

- Prefix and drive letter are case-insensitive.
- The tail is converted to backslashes; non-ASCII components are preserved.
- Glob roots use the same alias in `pattern_drive_alias_root_impl`.
- No per-builtin changes: all consumers of `Shell::absolute_path` inherit it,
  and external command paths combine this alias with the 0002 spawn fix.
- Output remains native. `pwd` after `cd /cygdrive/c/Windows` prints
  `C:\Windows`; the shell never emits `/cygdrive/...`.

Deliberately not covered:

- `/cygdrive` alone or `/cygdrive/` (not a drive root).
- `/cygdrive/data`, `/cygdrive/cc/foo` (not one ASCII drive letter).
- Custom Cygwin drive prefixes; use `cygpath -w` for those.
- Non-UTF-8 alias paths (`translate_unix_drive_path` still requires UTF-8).
- `C:foo` drive-relative paths; this patch does not change their handling.
- Arguments of native external programs; only the shell's own path resolution
  and executable path are normalized.

## Tests

Platform: Windows 10.0.28000 (x86_64-pc-windows-msvc), pinned
`nightly-2026-10-06`.

```sh
cargo test -p brush-core --lib cygwin
cargo test -p pi-builtins --lib cygwin_drive_alias_is_accepted
cargo test -p pi-builtins --lib
node scripts/vendor.mjs check
```

RED before the implementation:

- `cygwin_drive_aliases_translate_to_windows_roots` failed with
  `left: None, right: Some("C:\\")`.
- `pattern_cygwin_drive_alias_roots_report_consumed_components` failed with
  `left: None, right: Some(("D:/", 3))`.
- The integration test failed with
  `error: cd: i/o error` and
  `error: command not found: /cygdrive/c/Windows/System32/where.exe`.

GREEN after:

- `cargo test -p brush-core --lib cygwin`: 3 passed.
- `cygwin_drive_alias_is_accepted`: covers `cd`, `test -d`, external
  execution, and glob expansion.
- `cargo test -p pi-builtins --lib`: 1449 passed, 0 failed, 11 ignored.
- `vendor check`: 0001, 0002, 0003 apply in order.

## Risks

- A real `<current-drive>:\cygdrive\c` directory is shadowed by the alias.
  This is extremely unlikely, but it is a semantic choice, not a pure addition.
- Cygwin supports a configurable `/cygdrive` prefix; only the default is
  recognized.
- `translate_unix_drive_path` uses `to_str()`, so a non-UTF-8 tail under the
  ASCII prefix is left untouched and will not resolve as a Cygwin path.
- `..` is not collapsed by the alias conversion itself; `cd` and the 0002
  executable normalizer collapse it, while file/glob operands rely on the OS
  and glob engine. The integration test covers the common cases, not every
  `/cygdrive/c/..` shape.
- The alias is input-only: it does not make `cygpath`, native programs, or
  shell output agree on one spelling.

## Removal condition

Remove this patch if upstream #1142 (or a replacement path abstraction in
#1463) lands support for Cygwin `/cygdrive/<drive>` aliases, or if the
vendored pin otherwise resolves that spelling.

After deleting the patch:

1. Remove the ledger row and this note.
2. Keep the regression tests if the behavior is still expected; move them to
   the owning upstream/overlay location if the helper functions disappear.
3. Re-run `cargo test -p pi-builtins --lib cygwin_drive_alias_is_accepted`.
4. Re-run `cargo test -p pi-builtins --lib` and `node scripts/vendor.mjs check`.
