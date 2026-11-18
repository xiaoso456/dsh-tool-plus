/**
 * 浮层层栈：同一时刻只有最上面那层拥有键盘。
 *
 * 为什么需要它：设置抽屉、命令面板、命令面板里再开的浏览弹窗是三层各自独立的
 * 门户，每层都在 document 的 capture 阶段抢 Tab 和 Esc。后开的层挂在 body 末尾，
 * 却不是 DOM 祖先，于是外层的「焦点不在我这层的可聚焦元素里，就拽回第一个」
 * 会把焦点从里层抢走（实测：浏览弹窗里按 Tab，焦点跳到命令面板的关闭按钮，
 * 再 Tab 又回到弹窗的 ×，弹窗底部的取消/选择永远到不了）。
 *
 * 规则：层挂载时入栈、卸载时出栈；所有键盘处理开头先问 `isTopLayer`，不是最上层
 * 就原样放行，不 preventDefault、也不 stopPropagation，交给真正该处理的那层。
 * @module @xiaoso/dsh-tool-plus/client
 */

const stack: object[] = []

/** 入栈。每层自己造一个稳定的 token（`useRef({}).current`）。 */
export function pushLayer(token: object): void {
  if (stack.includes(token)) return
  stack.push(token)
}

/** 出栈。不是最上层也允许移除（层可能在中间被卸载）。 */
export function popLayer(token: object): void {
  const index = stack.lastIndexOf(token)
  if (index >= 0) stack.splice(index, 1)
}

/** 这一层现在是不是最上层。 */
export function isTopLayer(token: object): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token
}

/** 只给测试用：看栈里还有几层。 */
export function layerDepth(): number {
  return stack.length
}
