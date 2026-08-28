# 图像链路配置旋钮 · 真机自服务测试指令（IMAGE-KNOBS-TEST v2）

> 本文件是给当前会话大模型读的**执行脚本**。你用 read 工具按顺序跑完所有用例，
> 每条给出「✅/❌ + 证据引用」。B 组配置**由你自己动手改**（见下"配置自服务操作法"），
> 只有 A6 的切换模型需要用户出手。
> 行为断言全程只准用 read 工具实测，禁止用 bash 代测图像；证据必须是 read 返回原文里的句子。

## 夹具清单（绝对路径）

| 夹具 | 路径 | 形态 |
|---|---|---|
| 大图 | `D:\code\pi-gateway-project\dsh-bash-plus\tool-plus-lab\image-knobs\big-noise.png` | 2400×1600 随机噪点 PNG，约 11.5MB |
| 纯色图 | `D:\code\pi-gateway-project\dsh-bash-plus\tool-plus-lab\image-knobs\solid100.png` | 100×100 纯色，354B |
| 极小图 | `D:\code\pi-gateway-project\dsh-bash-plus\tool-plus-lab\image-knobs\tiny8.png` | 8×8 纯色，95B |
| 伪装文件 | `D:\code\pi-gateway-project\dsh-bash-plus\tool-plus-lab\image-knobs\png-masquerading.txt` | PNG 字节、.txt 后缀 |
| 中噪声图 | `D:\code\pi-gateway-project\dsh-bash-plus\tool-plus-lab\image-knobs\mid-noise.png` | 240×240 随机噪点，约 170KB（超免重编码阈值，必走阶梯） |
| GIF | `D:\code\pi-gateway-project\dsh-bash-plus\tool-plus-lab\image-knobs\frame64.gif` | 64×64 纯红 GIF89a，110B |
| 16-bit 图 | `D:\code\pi-gateway-project\dsh-bash-plus\tool-plus-lab\image-knobs\deep16.png` | 512×512 灰度 16bit PNG（真 IHDR depth=16，宿主归一化输入形态） |
| 超宽图 | `D:\code\pi-gateway-project\dsh-bash-plus\tool-plus-lab\image-knobs\wide8193.png` | 8193×64，超宿主 8192px 单边硬限 1px |
| 远程图 | `https://imgsrc.baidu.com/forum/pic/item/ff61a28b87d6277fc1f633fd21381f30eb24fceb.jpg` | 百度图床，实际回给 webp |

## 配置自服务操作法（B 组专用，照做别发明）

配置文件：`C:\Users\xiaoso456\.dsh\profiles\tool-plus-web\settings.yaml`
里面有一行**唯一的锚点**：`tool-plus: {}`——所有实验都由替换这一行完成。

1. **开局备份（一次）**：用 bash 复制 `C:\Users\xiaoso456\.dsh\profiles\tool-plus-web\settings.yaml`
   → 同目录 `settings.yaml.bak-knobs`（cmd 用 `copy`，bash 用 `cp`，看你 shell 是哪个）。
2. **设置配置**：用 edit 工具把 `tool-plus: {}` 整行替换为所需块。例（开熄图）：
   ```yaml
   tool-plus:
     imagesBlockImages: true
   ```
   规则：两空格缩进、一次只放本用例要求的键、其余键不写=默认值；**其他任何行一概不许碰**。
3. **回读验证**：改完先 read 该文件确认写入且结构没坏（锚点处正是你要的块）。
4. **热载即生效**：无需重启/新会话，下一轮 read 图像就是新配置。若表现和预期不符，
   隔一步重试一次；仍不符则判 ❌ 并备注"疑似热载未接到"，继续下一例。
5. **每条测完还原**：把块删回一行 `tool-plus: {}`，再回读验证。
6. **结构搞坏了**：从备份还原（bash copy 反向），记 ❌"配置面自毁复位"，继续。
7. 测试期间**不要走网页设置面板**改配置（面板保存会覆盖文件，互相打架）。

可用键（camelCase，值类型照抄）：`imagesAutoResize: false`、`imagesResizeMaxBytes: 8192`、
`imagesResizeMaxSide: 320`、`imagesResizeMinSide: 64`、`imagesResizeJpegQuality: 10`、
`imagesExcludeWebp: true`、`imagesBlockImages: true`、`imagesInputMaxBytes: 1048576`、
`readConcurrentSafe: false`。

---

## A 组 · 默认配置（`tool-plus: {}` 状态，直接跑）

**A1 大图基线（autoResize 默认开）**
read 大图。预期：含 `<type>image</type>`，且含 `[Image: original 2400x1600, displayed at 1568x`。
记录 `<content>` 行全文（B6 对比格式用）。

**A2 极小图放大下限**
read 极小图。预期：`[Image: original 8x8, displayed at 200x200. Multiply coordinates by 0.04`。

**A3 后缀伪装（字节嗅探优先）**
read 伪装文件。预期：走图片路径（含 `<type>image</type>`）而非当文本读；含 200x200 放大注记。

**A4 URL 图提交**
read 远程图。预期：含 `URL: https://imgsrc.baidu.com`、`<type>image</type>`；`<content>` 行报 image/webp。记录 `<content>` 行全文。

**A5 中噪声图质量基线**
read 中噪声图。预期：出图；尺寸 240×240 未变，**不应含** `[Image: original`。记录 `<content>` 行（格式+字节，B5 对比用）。

**A6 非 vision 模型软降级 —— [需要用户，全文件唯一人工步骤]**
向用户输出：
> 请在模型选择器切到**纯文本模型**（如 ollama/deepseek-v4-flash:0731），切好回复"继续"。

用户确认后：read 大图。预期：**无**图像块；文本含 `cannot display` + `does not accept image input` + `The file is an image (image/png, 2400x1600 px`。
然后请用户切回 vision 模型（如 bailian/qwen3.8-flash 或 ocg -vision）。

## B 组 · 自服务改配置逐例测（每例独立：设键→测→还原 `{}`）

**B1 imagesAutoResize: false**
- read 大图：预期**不含** `[Image: original`（管线不动字节）；宿主归一化接手后 `<content>` 可能带 `(downscaled from 2400x1600 px` 注记（宿主口径）——记录 `<content>` 行。
- read 中噪声图：`<content>` 报 `240x240 px`、字节接近 170KB 原量级（不再压预算，对比 A5）。
- read 极小图：`displayed at` 注记消失，报 `8x8 px`、字节接近 95B。

**B2 imagesResizeMaxBytes: 8192**
- read 大图：为凑 8KB 预算阶梯连降，`displayed at` 宽度远小于 1568，`<content>` 字节 KB 量级。
- read 中噪声图：尺寸被进一步压到 240 以下。

**B3 imagesResizeMaxSide: 320**
read 大图。预期 `[Image: original 2400x1600, displayed at 320x`。

**B4 imagesResizeMinSide: 64**
read 极小图。预期 `displayed at 64x64`（对照 A2 的 200x200）。

**B5 imagesResizeJpegQuality: 10**
- read 中噪声图：仍 240×240 无尺寸注记，但 `<content>` 字节**显著低于 A5 记录值**。
- read 大图：`displayed at 1568x` 仍在（预算未变）。

**B6 imagesExcludeWebp: true**
- read 纯色图 / 伪装文件 / 远程图 三连：`<content>` 格式**都不许是 image/webp**（预期 jpeg/png；远程图 webp 源被强制转码）。与 A1/A4 记录对比确认差异。

**B7 imagesBlockImages: true**
- read 大图：输出恰好一句 `Image reading is disabled.`，无图像块。
- read 远程图：同样只含这句。

**B8 imagesInputMaxBytes: 1048576**
- read 大图（11.5MB）：报错含 `Image file too large`。
- read 纯色图（354B）：仍成功出图（上限只拦大的）。

**B9 收尾回归**
确认 `tool-plus: {}` 已还原后：read 大图与中噪声图，应分别复刻 A1、A5 记录。
（备份文件先别删，C3/D2 还可能用配置，全部跑完在 D2 末尾统一删。）

## C 组 · 补充用例

**C1 附件真进上下文的闭环（默认配置）—— [需要用户配合，轻]**
1. read 纯色图（solid100.png）。
2. 然后你自己回答：这张图主要是什么颜色？（预期描述出深莓红/洋红系色调，接近 #C81E5A；
   说不出颜色 = 图像块没真进上下文，判 ❌）
3. 请用户在**后面任意一轮**随口追问“刚才那张纯色图是什么颜色”——验历史图像块回放；
   回答应与第 2 步一致（不翻工具重读也能答对）。

**C2 怪格式（默认配置，autoResize 开）**
- read GIF（frame64.gif）：预期成功提交；`<content>` 格式**不再是** image/gif（阶梯静帧重编码），
  并带 `displayed at 200x200` 放大注记。
- read 16-bit 图（deep16.png）：fast-path 原字节直通（字节小、尺寸在界内，管线不重编），
  宿主 sharp 归一化把 16-bit 转成 8-bit sRGB——预期**成功提交**（`<type>image</type>`），
  `<content>` 行报 `image/png image, 512x512 px,` 且字节数远小于原 1311B（8-bit 重编码后）。
  报错分支 `the 16-bit PNG could not be converted` 仅在宿主 sharp 转换失败（如损坏文件）时触发，常规路径不报错。

**C3 超宽图撞宿主单边硬限 —— 自配（先 imagesAutoResize: false）**
- 关 autoResize 后 read 超宽图（wide8193.png）：原字节入库→预期报错含
  `at least one image side exceeds the 8192px limit`。
- 还原 `tool-plus: {}` 后再 read 超宽图：管线接手缩到 1568，预期成功出图。

## D2 read 并发安全 readConcurrentSafe（附录：默认开，热生效，无需重启）

> 背景：read_image 官方 `isConcurrencySafe: true` 已接到 read（2026-08-28，用户拍板）。
> `readConcurrentSafe` 默认 true；配置改动**热生效，无需重启**（注册面配置如工具开关才需重启）。
> 模型侧能验证的是**并发调用的正确性**（一次发多个 read 全部成功、结果无串扰）；
> 宿主是否真的并行调度（vs 串行排队）模型侧观测不到，需用户看日志/耗时。

1. **并行文本（默认配置）**：一次向 read 发 **3 个调用**（三个不同文件，内容各不相同）。
   预期：3 个调用全部成功，各自返回自己的内容，**无串扰**（a 的结果里没有 b 的内容）。
2. **并行图片（默认配置）**：一次向 read 发 **3 个图片调用**（solid100.png、mid-noise.png、tiny8.png）。
   预期：3 个都成功提交（`<type>image</type>` + `<content>` 行），尺寸/字节各自符合 A2/A5 基线。
3. **串行对照（自配 readConcurrentSafe: false）**：按自服务协议把 `tool-plus: {}` 换成：
   ```yaml
   tool-plus:
     readConcurrentSafe: false
   ```
   回读验证后（**无需重启**）重复第 1 步：3 个调用仍应全部成功（串行执行，正确性不变）。
   [需要用户，可选] 用户可对比两次的宿主日志/耗时：并行时 3 个 read 重叠，串行时排队。
4. **还原**：删键还原 `tool-plus: {}`，回读验证。
5. 收尾：删除备份文件 `settings.yaml.bak-knobs`（cmd `del` / bash `rm`）。

> 范围注记：本表测「图片」分组 8 个转换旋钮 + 附件消费闭环 + 怪格式错误映射；
> D2 验 read 并发安全（readConcurrentSafe，热生效无需重启）。
> （独立 read_image 工具已于 2026-08-28 删除——融合完成，逃生门 readImageToolEnabled 一并移除。）

---

## 预期关键句速查

| 现象 | 字句出处 |
|---|---|
| 管线缩放注记 | `[Image: original WxH, displayed at wxh. Multiply coordinates by` |
| 宿主归一化注记（信封内） | `(downscaled from WxH px; multiply` |
| 软降级（非 vision/无附件库） | `cannot display "…" as an image:` + `The file is an image (` |
| 熄图 | `Image reading is disabled.` |
| 准入拒读 | `Image file too large` |
| 16-bit 转换失败（防御分支，仅宿主 sharp 处理失败时报） | `the 16-bit PNG could not be converted` |
| 单边超硬限 | `at least one image side exceeds the 8192px limit` |
| 成功提交 | `<type>image</type>` + `<content>` 行 `image/… image, wxh px, N bytes` |

## 汇总表（最后必须输出）

| 用例 | 配置（实际设置的键=值） | 判定 | 证据（引用 read 原文关键行，可截断） |
|---|---|---|---|
| A1 | 默认 | ✅/❌ | |

（逐行填满 A1–A6、B1–B9、C1–C3；D2 记“并发 3 调用全成功/串行对照”。任何 ❌ 附完整报错/输出原文，不要只说失败。）
