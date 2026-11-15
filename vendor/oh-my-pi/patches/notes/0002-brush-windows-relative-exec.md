# 0002 Windows relative executable resolution

- Patch: `patches/0002-brush-windows-relative-exec.patch`
- Upstream issue/PR: [#1251](https://github.com/reubeno/brush/issues/1251), [#1252](https://github.com/reubeno/brush/pull/1252), [#1518](https://github.com/reubeno/brush/pull/1518), [#1519](https://github.com/reubeno/brush/pull/1519)
- Status: local
- Files: `crates/vendor/brush-core/src/sys/fs.rs` (`normalize_executable_path`), `crates/vendor/brush-core/src/commands.rs` (`compose_std_command`), `crates/pi-builtins/src/host.rs` (regression test)

## Why

On Windows, `CreateProcess` resolves a relative `lpApplicationName` against
the **parent process's** current directory. `Command::current_dir` only sets
the child's starting directory; it does not affect where Windows looks for the
image.

brush keeps its working directory in `Shell` and deliberately does not change
the host process cwd (the shell is embedded and may serve several sessions).
As a result, after `cd some-dir`, a relative external command such as
`./tool.exe` is looked up under the embedding process's cwd, not the shell's:

```
cd C:\work\sub
./tool.exe
# error: command not found: ./tool.exe  (status 127)
```

`compose_std_command` already computes `spelled = shell.absolute_path(...)`,
but only used it for non-native virtual paths. Native-local paths kept the
unresolved spelling and were handed to `CreateProcess`.

This belongs in the vendored `brush-core` rather than the overlay because it
changes how the shared command-spawn entry point interprets an existing shell
working directory. The fix also covers every native-local caller, including a
future Windows `exec` path; a caller-specific workaround would miss them.

## Behaviour

Before: on Windows, a native-local command name containing a path separator
(`./tool.exe`, `.\tool.exe`, `sub/tool.exe`) was passed to
`Command::new` as spelled. `CreateProcess` resolved it against the parent
process cwd, so it failed whenever the shell cwd differed from the process cwd.

After: on Windows, the already shell-resolved path is lexically normalized with
the `normalize_path` crate before `Command::new` (`C:\work\sub\.\tool.exe`
becomes `C:\work\sub\tool.exe`). The program path is therefore independent
of the embedding process cwd. The child still starts in `spawn_dir`, so
relative arguments and redirections keep their existing meaning.

Other platforms are unchanged: `normalize_executable_path` returns the input
borrowed, and the `compose_std_command` branch is compiled only on Windows.
The OS resolves relative image paths in the child after `chdir`.

Deliberately not covered:

- Drive-relative names such as `C:tool.exe` (not absolute; the shell path is
  not unambiguously resolvable without the drive's per-drive current directory).
- Non-UTF-8 paths are preserved as `PathBuf`; no lossy conversion is used.
- The lexical `normalize_path` pass collapses `..` without consulting
  symlinks. This is the same trade-off the upstream review asked for
  (`normalize_path` rather than hand-rolled normalization) and only affects
  the spelled program path, not argument handling.

## Tests

Platform: Windows 10.0.28000 (x86_64-pc-windows-msvc), pinned
`nightly-2026-10-06`.

Regression test in `crates/pi-builtins/src/host.rs`:

```sh
cargo test -p pi-builtins --lib \
  relative_external_command_resolves_after_cd -- --nocapture
```

It copies `where.exe` into a fresh `sub/` directory, sets the shell cwd to
the temp parent, runs `cd sub; ./relative-exec-probe.exe cmd.exe`, and asserts
the command exits 0 and prints a `cmd.exe` path. Without the patch it fails
exactly as the bug reports do:

```
assertion failed: left == right
  left: 127
 right: 0
stderr: error: command not found: ./relative-exec-probe.exe
```

With the patch it passes. The full unit suite also passes:

```
cargo test -p pi-builtins --lib
# 1448 passed; 0 failed; 11 ignored
```

## Risks

- Only the Windows branch changes; Unix spawn semantics are untouched.
- `normalize_path` is lexical. For an executable path that traverses a
  symlink or junction, the normalized spelling can differ from the
  filesystem-resolved path; Windows accepts the normalized absolute path in the
  tested cases, and arguments are not rewritten.
- Paths that are not absolute after `absolute_path` (drive-relative
  `C:foo`) remain broken; this patch does not claim to fix them.
- The fix is in `compose_std_command`, not `execute_external_command`; it
  therefore also applies to `pi-builtins` callers that build commands through
  the shared entry point.

## Removal condition

Remove this patch once the pinned or published `brush-core` contains an
upstream fix for relative executable resolution on Windows (for example
[#1252](https://github.com/reubeno/brush/pull/1252) or
[#1518](https://github.com/reubeno/brush/pull/1518)/[#1519](https://github.com/reubeno/brush/pull/1519)
merged), and the vendored version is bumped.

After deleting the patch:

1. Remove the ledger row and this note.
2. Re-run the regression test above; if upstream chose a different fix, keep
   the test (it is an external contract) and adjust its location/name only.
3. Re-run `cargo test -p pi-builtins --lib`.
4. Build the local addon and repeat the `cd sub && ./tool.exe` smoke test in
   the real shell.
