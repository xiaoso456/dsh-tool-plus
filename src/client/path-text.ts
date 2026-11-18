/**
 * 路径字段用到的纯文本换算：从输入框猜起始目录、把目录切成面包屑、打字跳转。
 * 与 React 无关，单独放一处，测试可以直接盯它。
 * @module @xiaoso/dsh-tool-plus/client
 */

/**
 * 输入框里的值 → 浏览弹窗从哪一层开始。
 *
 * 值可能是半截目录（`D:/tools/`）、完整文件（`D:/tools/zip.exe`）或者只是
 * 一个名字（`zip.exe`）。只有前两种能给出起点，光有名字就交给宿主（主目录）。
 */
export function dirOfPath(value: string): string | undefined {
  const text = value.trim().replace(/\\/g, '/')
  if (text.length === 0) return undefined
  if (text.endsWith('/')) return text
  const cut = text.lastIndexOf('/')
  if (cut < 0) return undefined
  const last = text.slice(cut + 1)
  // 手输 `D:/tools` 时最后一段是目录，不是文件名：没有扩展名就当成目录进去。
  // 带点的一律当文件（`zip.exe`、`v1.2.exe`），否则「从哪一层开始」会猜反。
  if (!last.includes('.')) return text + '/'
  const dir = text.slice(0, cut)
  // `D:` 这种只剩盘符的写法补回分隔符，否则宿主会当相对路径解析。
  return /^[A-Za-z]:$/.test(dir) ? dir + '/' : dir
}

/** 面包屑：每一段都能点，最后一段是当前位置。 */
export function crumbsOf(dir: string): { label: string; path: string }[] {
  const text = dir.replace(/\\/g, '/')
  const absolute = text.startsWith('/')
  const parts = text.split('/').filter(part => part.length > 0)
  const out: { label: string; path: string }[] = []
  let prefix = ''
  for (const part of parts) {
    if (prefix.length === 0) prefix = /^[A-Za-z]:$/.test(part) ? part + '/' : absolute ? '/' + part : part
    else prefix = prefix.replace(/\/$/, '') + '/' + part
    out.push({ label: part, path: prefix })
  }
  return out
}

/**
 * 上一级目录；已经是根（`C:/` 或 `/`）时返回 null。
 *
 * 不从宿主回包里取：翻目录是瞬时的，等回包再决定「上一级」能去哪，连点两下就
 * 会走到错的地方。
 */
export function parentOfPath(dir: string): string | null {
  const text = dir.replace(/\\/g, '/').replace(/\/+$/, '')
  if (text.length === 0) return null
  if (/^[A-Za-z]:$/.test(text)) return null
  const cut = text.lastIndexOf('/')
  if (cut < 0) return null
  const head = text.slice(0, cut)
  if (head.length === 0) return '/'
  // `C:` 只剩盘符时补回分隔符，宿主才不会把相对路径当成另一处。
  return /^[A-Za-z]:$/.test(head) ? head + '/' : head
}

/**
 * 打字跳转：从 `from` 之后找第一个名字以 `prefix` 开头的项，找不到就从头绕一圈。
 * 大小写不敏感，与资源管理器一致。
 */
export function firstMatchIndex(names: readonly string[], prefix: string, from: number): number {
  const needle = prefix.toLowerCase()
  if (needle.length === 0 || names.length === 0) return -1
  for (let step = 1; step <= names.length; step += 1) {
    const index = (from + step) % names.length
    if (names[index].toLowerCase().startsWith(needle)) return index
  }
  return -1
}

