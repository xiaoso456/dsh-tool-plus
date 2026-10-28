# Tool benchmarks

Reproducible comparisons for the shell tools shipped by this plugin. The
question is narrow on purpose: **inside the OMP/DSH bash runtime**, how do the
builtins compare with the external binaries and with the native tool layer?

This is not a benchmark of a native Linux shell. On a normal Linux machine
`grep`/`find` are the system GNU/BSD binaries; here they are **brush
builtins** (`pi-uu-grep`, `pi-uu-find`, ...) implemented inside brush-core.
So "brush builtin grep vs GNU grep" means "the in-shell implementation an agent
gets from brush" vs "an external binary". A label prefixed `brush builtin`
never means a compiled-in bash builtin and never means a PATH binary.

## Corpora

`pnpm bench:fetch` downloads two pinned corpora into `data/`.
**The corpora are local-only and are never committed**: `data/` and
`results/` are gitignored, so only the scripts and this README go into the
repository. It needs `curl` and `unzip`; `git` is used only by the fallback
path.

| id | source | shape |
|---|---|---|
| `enwik8` | `https://mattmahoney.net/dc/enwik8.zip` (the same 100 MB corpus used by ugrep's benchmark suite) | one 100,000,000-byte text file |
| `openssl-3.1.2` | `Genivia/ugrep-benchmarks` at commit `d24625d20a360c160b3bc68bcffa32f663905494`, file `corpi/openssl-3.1.2.zip` | an OpenSSL source tree (recursive search/walk) |

Pinned SHA-256 (the fetcher verifies both archives before extracting):

- `enwik8.zip`: `547994d9980ebed1288380d652999f38a14fe291a6247c157c3d33d4932534bc`
- `openssl-3.1.2.zip`: `c2722c5864e7c0cfb7fdd08c84ef183ee1e891dc9d3cb0d29932a5b8542dc566`

The OpenSSL archive is downloaded from a **commit-pinned raw URL**. If that
host fails, the fetcher falls back to a blobless partial clone, which avoids
pulling the repository's ~200 MB pack just for one 18 MB blob. Either way the
commit is pinned, so the tree does not drift.

If GitHub or the corpus host is slow, point `HTTPS_PROXY`/`HTTP_PROXY` at a
local proxy before fetching; both `curl` and `git` honor the standard
variables:

```sh
HTTPS_PROXY=http://127.0.0.1:10808 HTTP_PROXY=http://127.0.0.1:10808 pnpm bench:fetch
```

Partial downloads resume by default (`curl -C -`). `--force` re-downloads and
re-extracts. `--only enwik8|openssl` fetches one corpus.

## Commands

```sh
pnpm bench:fetch          # first run only (or after deleting data/)
pnpm bench:grep           # grep suite
pnpm bench:grep -- --runs 9
pnpm bench:grep -- --case enwik8-ere
pnpm bench:find           # find suite
pnpm bench:find -- --runs 9
```

Results are printed as a table and written to
`tests/benchmarks/results/<suite>-<timestamp>.json` (gitignored). The table
prints one median per case/tool; the JSON keeps every sample, min/max, the
exact command and exit code.

Set `BENCH_DATA_DIR` to use a different corpus root (useful for a quick smoke
run with a tiny tree, or for corpora kept outside the repository).

## Methodology

- Every command runs in **one persistent `pi-natives` `Shell`**, the same
  brush-core session the bash tool uses. Builtins therefore resolve exactly as
  they do for an agent. The GNU rows call the external binary by its absolute
  path: in this runtime both `command grep` and `env grep` still resolve to the
  brush builtin, so the absolute path is the only reliable escape hatch.
- One warmup run, then `--runs` measured runs (default 5). The table reports
  the median; the JSON keeps the raw samples.
- Search output is redirected to `/dev/null` so terminal capture cost does not
  dominate. Exit code 1 ("no matches") is accepted; any other non-zero exit
  skips that row.
- The OMP native grep row calls `pi-natives`' `grep()` directly, with output
  mode `count` or `filesWithMatches` matching the shell case.
- `GNU find` is resolved explicitly instead of via `command find`: on Windows
  the PATH often reaches `C:\Windows\system32\find.exe` before Git's GNU
  find. The runner checks `--version` contains "GNU" and skips the row
  otherwise.

## Cases

Grep:

| case | corpus | pattern | mode |
|---|---|---|---|
| `enwik8-the` | enwik8 | `the` | per-file count, ERE |
| `enwik8-ere` | enwik8 | `(the\|and)` | per-file count, ERE |
| `openssl-ssl-ctx` | OpenSSL | `SSL_CTX` | recursive, files-with-matches |

Find:

| case | corpus | predicate |
|---|---|---|
| `openssl-files` | OpenSSL | all regular files |
| `openssl-c` | OpenSSL | regular files named `*.c` |

## Reading the numbers

- Compare rows within one case; absolute times depend on the machine, the
  filesystem cache and whether the corpus was already warm.
- `brush builtin*` rows are brush-core in-shell implementations. `GNU*`
  rows are external processes (fork + exec + binary startup included). That is
  the real cost an agent pays, but it is not a pure algorithm comparison.
- The `brush builtin rg` row is brush-core's `rg`, which the bash help
  describes as in-process serial; it is not the multithreaded external
  ripgrep.
- This harness is Windows-first (the brush builtins it targets live in the OMP/DSH
  bash runtime there). On Linux it still runs, but `brush builtin grep` no
  longer describes the system `grep`; treat the results as a comparison of the
  runtime's brush builtins only.
