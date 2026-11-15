# Patch notes

One note per patch that changes upstream **behaviour**. Notes are for the
patch, not for the source files it touches: a command added under
`overlay/crates/pi-builtins/src/shellcmds/` is documented in
`docs/shell-commands/`, and a pure wiring patch (`0001-shell-commands.patch`)
is covered by the ledger row in [`../../README.md`](../../README.md).

## When a note is required

- The patch changes `brush-core`, `brush-parser`, `pi-builtins`, or another
  vendored crate's behaviour, not just its wiring.
- The patch is a platform workaround that upstream does not have yet.
- The patch must be removed when an upstream issue/PR lands, so the removal
  condition needs to be explicit.

A note is **not** required for: feature/dependency/factory wiring, a
version-only bump, or a typo fix. Those still need a ledger row.

## Naming and placement

`patches/notes/<patch-number>-<slug>.md`, matching
`patches/<patch-number>-<slug>.patch`, e.g.
`0002-brush-relative-exec.patch` -> `0002-brush-relative-exec.md`.

## Template

```md
# <number> <short title>

- Patch: `patches/<number>-<slug>.patch`
- Upstream issue/PR: <link or ->
- Status: local | upstream-merged | superseded
- Files: <upstream files/functions changed>

## Why

<the observed bug or missing capability, and why the fix belongs here rather than in the overlay>

## Behaviour

<before/after, including platforms and edge cases; state what is deliberately not covered>

## Tests

<exact commands and platform; what turns red if the patch is removed>

## Risks

<behavioural differences, performance, path/encoding edge cases>

## Removal condition

<the upstream release/PR that makes this patch unnecessary, and what to re-run after deleting it>
```

## Ledger link

Every note must have a row in the [patch ledger](../../README.md#patch-ledger)
with its `upstream issue/PR`, `test`, and `removal condition` kept in sync.
