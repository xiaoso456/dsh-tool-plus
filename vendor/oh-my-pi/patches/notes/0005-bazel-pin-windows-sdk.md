# 0005 Bazel: pin the MSVC cross-compile Windows SDK

- Patch: `patches/0005-bazel-pin-windows-sdk.patch`
- Upstream issue/PR: none filed (build-configuration deviation, not a behaviour bug)
- Status: local
- Files: `MODULE.bazel` (`xwin_sysroot(name = "xwin_sysroot")` gains `sdk_version = "10.0.22621"`)

## Why

The `natives-win32-*` Bazel targets do not compile on a Windows host; they cross
compile from Linux/macOS through the `@msvc_cc` + `@xwin_sysroot` toolchain,
which downloads the MSVC CRT and Windows SDK payloads with the pinned xwin
0.6.5.

The x64 `xwin_sysroot` repo rule never passed `sdk_version`, so xwin resolved
"latest", which moves with Microsoft's SDK release train. On 2026-11-15 that is
`Win11SDK_10.0.26100`, whose manifest the pinned xwin cannot splat:

```
INFO: Repo +xwin_sysroot_repository+xwin_sysroot defined by rule xwin_sysroot_repository
ERROR: .../bazel/toolchains/msvc/sysroot.bzl:137:13: An error occurred during the fetch of repository '+xwin_sysroot_repository+xwin_sysroot':
Error in fail: bazel/toolchains/msvc: xwin splat failed (exit 1):
Error: unable to find x86_64 headers for Win11SDK_10.0.26100
```

The failure lands during repository fetch — roughly two seconds in, before any
payload download or compilation — so it is independent of our crates and kills
the whole `native-v*` CI run at the first Windows target.

Upstream already hit this class of breakage on the arm64 side and pinned
`10.0.22621` there; `sysroot.bzl` even documents the reason ("the newest SDK's
arm64 MSIs reference no cab files, which xwin 0.6.5 rejects"). x64 was left on
"latest" and is now hitting the same manifest churn.

## Behaviour

Before: `@xwin_sysroot` resolved whatever SDK xwin considered newest at fetch
time, so the toolchain silently changed with Microsoft's release train and could
break with no change on our side.

After: both `@xwin_sysroot` (x64) and `@xwin_sysroot_arm64` pin
`sdk_version = "10.0.22621"`. Builds are reproducible and independent of the SDK
release train.

No runtime behaviour changes: the Windows SDK supplies headers and import
libraries only. The addon links against the UCRT/kernel32 imports, which are
identical across these SDK versions.

## Tests

```sh
node scripts/vendor.mjs check
# 0001 … 0005 apply in order against a clean checkout of the pin
```

Validated end to end by the `native-v0.0.0-dev.1` CI run: the win32-x64 job that
previously died at `xwin splat failed` proceeds to compile after this patch.

## Risks

- If Microsoft drops the 10.0.22621 payload from the xwin manifest CDN, the pin
  breaks and must move forward. Mitigation: the failure is loud and at fetch
  time, not a silent miscompile.
- Pinning keeps us on an SDK that no longer receives updates. Acceptable for a
  build-only dependency; revisit when xwin is upgraded (a newer xwin is
  reported to handle 26100 and would let both pins go away).
- The patch touches `MODULE.bazel`, which upstream edits often. Re-generate it
  on the next pin bump; a conflict here is mechanical (one changed line).

## Removal condition

Delete this patch + note + ledger row once the pinned xwin can splat the
"latest" SDK (i.e. after an xwin upgrade), or once upstream pins x64 the same
way it pinned arm64. Verify by running `node scripts/vendor.mjs check` and a
`native-v*` CI run with the patch removed.
