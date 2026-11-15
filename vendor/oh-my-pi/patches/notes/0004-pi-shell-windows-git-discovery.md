# 0004 pi-shell Windows Git discovery

- Patch: `patches/0004-pi-shell-windows-git-discovery.patch`
- Upstream issue/PR: [#7430](https://github.com/can1357/oh-my-pi/issues/7430), [#9776](https://github.com/can1357/oh-my-pi/pull/9776)
- Status: local
- Files: `crates/pi-shell/src/windows.rs` (`discover_git`, new `git_install_is_usable`, extracted `combine_git_discovery`, tests)

## Why

Every new shell runs `configure_windows_path`, which calls `discover_git()`.
That helper queries HKLM for the Git for Windows `InstallPath` **and** runs
`where git`. On the measured Windows host the registry read is ~45ms and
`where git` is ~90ms, so every new shell pays ~100ms before it can run a
command.

The default bash path creates a new `:async:` shell for every tool call
(`autoBackgroundMs > 0`), so this is a fixed per-call cost. Upstream #9776
already collapsed the duplicate probes into one invocation-local pass, but
deliberately keeps fresh discovery for every later shell setup and does not add
a cross-invocation cache.

On this host, with the patched `--profile local` addon, a cold `Shell` running
`true` measures p50 21.9ms and a warm run 0.39ms; the bundled `executeBash`
measures 25.0ms cold and 2.33ms warm. `where git` alone still measures ~95.8ms,
which is the cost the registry-usable branch removes.

## Behaviour

Before: every `discover_git()` queried the registry and then always ran
`where git`, even when the installer's registry entry already named a working
Git for Windows installation.

After: if the registry path exists and contains `bin\bash.exe`, the registry
entry is authoritative and the `where git` fallback is skipped. The registry is
still re-read on every new shell, so a Git installed after launch is still found
when the registry entry appears; a missing, non-installer, or stale registry
entry keeps the `where git` fallback. Portable Git installs (no registry key)
and installs without `bin\bash.exe` behave exactly as before.

Deliberately not covered:

- No process-wide cache; the registry read remains per shell, matching the
  upstream "fresh discovery" decision.
- If the registry names an old but still valid install and a newer portable Git
  is earlier on PATH, only the registry install contributes top-level
  `install_roots`; existing PATH ordering is unchanged.
- The check uses the default Git for Windows layout (`<root>\bin\bash.exe`).
  Installations that keep bash only under `usr/bin` fall back to `where git`.

## Tests

Platform: Windows 10.0.28000 (x86_64-pc-windows-msvc), pinned
`nightly-2026-10-06`.

```sh
cargo test -p pi-shell --lib windows::tests
# 9 passed; 0 failed
```

The new skip test fails if the registry-usable branch calls the WHERE probe;
the fallback test keeps the old behaviour covered for an unreadable/unusable
registry path. The rest of the module covers the existing discovery ordering,
dedupe, MSYS translation, and drive-letter semantics.

The full `pi-shell` suite reports 870 passed and 3 failures unrelated to this
patch: `output_decode` (this terminal decodes the invalid byte as `?`), the
`every_utility_builtin` registry expectation (the 0001 overlay deliberately
adds builtins), and `ps_builtin` (passes when run alone; full-suite timing).

## Risks

- Skipping `where git` can hide a second, newer Git installation when the
  registry also names a valid one. The registry install is the one the
  installer owns, and PATH order is unchanged, so this is the intended
  authority rule rather than a new search order.
- A registry key that points at a partially removed install is rejected by the
  `bin\bash.exe` check and falls back to `where git`.
- No invalidation is needed because nothing is cached across shells; the next
  new shell re-reads the registry.

## Removal condition

Remove this patch when the pinned or published `pi-shell` stops probing
`where git` when the registry already names a usable install, or when upstream
adds an equivalent discovery policy. Re-run
`cargo test -p pi-shell --lib windows::tests` after deleting the patch; if
upstream keeps its own regression coverage, keep the behavior test and adjust
its location/name only.
