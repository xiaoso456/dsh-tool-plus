# Patches

Patches contain only upstream integration points. Business code lives in
`../overlay/` and is copied into the checkout by `pnpm vendor:sync` before the
patches are applied.

Current series:

- `0001-zip-integration.patch` — Cargo/Bazel/lib/factory wiring for the overlay
  `zip` builtin.

Naming: `0001-<short-topic>.patch`, `0002-...`. Patches are applied
sequentially in filename order; do not let two patches edit the same hunk.

`pnpm vendor:apply` copies the overlay into the local checkout, then applies
the series in order. `pnpm vendor:check` does the same in a temporary clean
worktree without touching the checkout. Keep the ledger in
[../README.md](../README.md) in sync.
