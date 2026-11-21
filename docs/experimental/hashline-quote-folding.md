# hashline 的弯引号折叠（暂不支持）

## 问题

`hashline` 模式走 native Rust 引擎（`crates/pi-edit`）。它的模糊归一化
`normalize_for_fuzzy` 只折 `„‟«»`、`‚‛`、反引号、锐音符，没有
`U+201C “`、`U+201D ”`、`U+2018 ‘`、`U+2019 ’`。

模型写弯引号、文件里是直引号（或反过来）时，两边归一化后仍不相等，相似度被拉低：
`“后写胜”` 对 `"后写胜"` 只有 94%，低于默认 0.95 阈值，模糊匹配失败。

## 现状

- TS 引擎路径已修（提交 `4410e79`）：`replace`（默认）、`patch`、`apply_patch`。
- native Rust 路径未修：`hashline` 仍受影响。vendored 源码在
  `vendor/oh-my-pi/upstream/crates/pi-edit/src/text.rs`（pi-natives 18.12.6），
  上游测试 `fuzzy_normalization_folds_punctuation` 还把「`“` 不折」写成了预期。

## 为什么暂不支持（2026-11-21 决定）

修代码只是一行字符类，成本在发版流程：要新开 0008 补丁、重编六个平台包
（`@xiaoso/dsh-tool-plus-natives-*`）、升 `optionalDependencies`、发一轮 native 包。
当前优先级不值得，先记为已知限制。

## 绕法

- 把 `old_string` 里的弯引号换成文件里的直引号，或反过来。
- 或改用已经修好的 `replace` / `patch` / `apply_patch`。

## 要修时的步骤

1. 在 `vendor/oh-my-pi/upstream/crates/pi-edit/src/text.rs` 的
   `normalize_for_fuzzy` 字符类里补 `'\u{2018}' | '\u{2019}' => '\''` 与
   `'\u{201C}' | '\u{201D}' => '"'`，同步更新上游测试预期。
2. 按 `vendor/oh-my-pi/patches/README.md` 开 0008 编号补丁与 note，更新台账。
3. 重发平台包（tag `native-v<新 pin>-plus.<n>`），把 `package.json` 六个
   `optionalDependencies` 改到同一版本，跑 `tests/unit/native-packages.spec.ts`。
4. 用真 addon 验证 `hashline` 的弯引号用例。
