# 0007 pi-natives: hidden host console for GUI-subsystem callers

- Patch: `patches/0007-hidden-host-console.patch`
- Upstream issue/PR: none filed (downstream packaging deviation)
- Status: local
- Files: `crates/pi-natives/Cargo.toml` (`Win32_System_Console` feature),
  `crates/pi-natives/src/lib.rs` (`pub mod hostconsole`, `#[napi] hide_host_console`),
  new `crates/pi-natives/src/hostconsole.rs` (lives in `overlay/`)

## Why

DSH's desktop/Web build is a GUI-subsystem process: it has **no console**, so
every `conhost.exe` child that wants a console allocates its own window. A
single `bash` startup can spawn a dozen short-lived processes, and each one
flashes a black window before it exits.

The usual fix is for the host to call `AllocConsole()` once and hide the
window, so children inherit that (invisible) console instead of creating one.
We used to do it through the `koffi` FFI package from TypeScript
(`src/host/win32-console.ts`), which meant every consumer had to install
`koffi` and allow its install script (`pnpm`'s `strictDepBuilds` turns a
missing `allowBuilds` entry into `ERR_PNPM_IGNORED_BUILDS` and exits
`dsh plugin add` with status 1). The addon we already ship is the natural home
for a 40-line Win32 call, so the plugin can go back to being a plain
`dsh plugin add` with no postinstall hooks and no buildable dependencies.

## Behaviour

`hideHostConsole(): string` returns one of:

| value | meaning |
|---|---|
| `not-windows` | not Windows; nothing attempted |
| `console-present` | the process already has a console (terminal, ConPTY, GUI app started from one); left untouched |
| `alloc-failed` | `AllocConsole()` returned 0; nothing to hide |
| `allocated` | a console was allocated and its window hidden |

Only `allocated` changes process state. When a console appears, the previous
`STD_INPUT_HANDLE` / `STD_OUTPUT_HANDLE` / `STD_ERROR_HANDLE` values are
saved and restored around the call, so stdio redirection set up by the host
survives.

**Detection is `GetConsoleCP() != 0`, not `GetConsoleWindow() != NULL`.**
Under ConPTY (Windows Terminal, VS Code, the desktop app’s own terminal) the
window handle is null while the console object exists, so a window-only check
reads "no console", calls `AllocConsole`, and gets `ERROR_ACCESS_DENIED` — the
host then reports a failure on a machine that never had the problem. Whether a
*child* creates a new window depends on the console object being inherited,
which is exactly what `GetConsoleCP` tests.

Deliberately not covered: consoles created by a process that never calls us
(standalone CLI launches, `bun test`, another tool’s spawn) and `FreeConsole`
— once allocated, the console stays for the process lifetime, which is what we
want since every later child benefits.

## Tests

```sh
node scripts/vendor.mjs check          # 0001 … 0007 apply in order
```

Runtime validation (Windows, verified 2026-11-16 with a debug
`cargo build -p pi-natives` and the built `pi_natives.dll` renamed to `.node`):

| parent | call 1 | call 2 |
|---|---|---|
| a console (this terminal, ConPTY) | `console-present` | `console-present` |
| `DETACHED_PROCESS` child (no console — the desktop host’s situation) | `allocated` | `console-present` |

The detached row is the one that matters: `allocated` proves `AllocConsole()`
really created a console for a process that had none, and the second
`console-present` proves the call is idempotent and the console is now
attached. Deleting the patch makes the export disappear, the TS side falls back
to `native-unavailable`, and the detached row stops producing a console at all
(children flash their own windows again).

## Risks

- `AllocConsole` creates the window visible and `ShowWindow(SW_HIDE)` hides it
  immediately after, so a one-frame flash is theoretically possible. The old
  `koffi` path had the same shape; avoiding it entirely would need a ConPTY
  (`CreatePseudoConsole`), far more plumbing than one Win32 call.
- The std-handle restore is a heuristic: if the host holds raw handles of its
  own (not through `STD_*`), those are unaffected either way.
- `SW_HIDE` on the console window is a one-way trip for that window; a later
  `ShowWindow(SW_SHOW)` by unrelated code would re-reveal it, which we never
  do.

## Removal condition

Upstream exposes a supported "allocate a hidden console" hook (or ships its own
startup call), or DSH stops being a GUI-subsystem host on Windows. Verify by
removing the patch and running `node scripts/vendor.mjs check` plus the runtime
check above.
