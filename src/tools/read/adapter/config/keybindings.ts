/**
 * DSH adapter for OMP `config/keybindings.ts`.
 *
 * OMP's full keybindings module loads TUI keybinding config (JSONC/YAML via
 * Bun) and manages the TUI keybinding registry. DSH has no TUI; the edit
 * renderer only needs the pure *formatting* helpers (`formatKeyHints`,
 * `KeyId`), which are kept verbatim below.
 */
export type { KeyId } from '@oh-my-pi/pi-tui'

/** App-level keybinding actions (verbatim OMP declaration merge). */
interface AppKeybindings {
  'app.interrupt': true
  'app.clear': true
  'app.exit': true
  'app.suspend': true
  'app.display.reset': true
  'app.thinking.cycle': true
  'app.thinking.toggle': true
  'app.model.cycleForward': true
  'app.model.cycleBackward': true
  'app.model.select': true
  'app.model.selectTemporary': true
  'app.tools.expand': true
  'app.tools.toggleVisibility': true
  'app.editor.external': true
  'app.message.followUp': true
  'app.retry': true
  'app.message.dequeue': true
  'app.clipboard.pasteImage': true
  'app.clipboard.pasteTextRaw': true
  'app.clipboard.copyLine': true
  'app.clipboard.copyPrompt': true
  'app.agents.hub': true
  'app.session.new': true
  'app.session.tree': true
  'app.session.fork': true
  'app.session.resume': true
  'app.session.observe': true
  'app.session.togglePath': true
  'app.session.toggleSort': true
  'app.session.rename': true
  'app.session.delete': true
  'app.session.deleteNoninvasive': true
  'app.tree.foldOrUp': true
  'app.tree.unfoldOrDown': true
  'app.plan.toggle': true
  'app.history.search': true
  'app.stt.toggle': true
  'app.live.toggle': true
}

declare module '@oh-my-pi/pi-tui' {
  interface Keybindings extends AppKeybindings {}
}

let keyHintPlatformOverride: NodeJS.Platform | undefined

function keyHintPlatform(): NodeJS.Platform {
	return keyHintPlatformOverride ?? process.platform
}

type Modifier = 'ctrl' | 'shift' | 'alt' | 'super'

function isModifier(part: string): part is Modifier {
	return part === 'ctrl' || part === 'shift' || part === 'alt' || part === 'super'
}

function modifierLabel(mod: Modifier, platform: NodeJS.Platform = keyHintPlatform()): string {
	switch (mod) {
		case 'ctrl':
			return 'Ctrl'
		case 'shift':
			return 'Shift'
		case 'alt':
			return platform === 'darwin' ? 'Option' : 'Alt'
		case 'super':
			return platform === 'darwin' ? 'Cmd' : 'Super'
	}
}

const KEY_LABELS: Record<string, string> = {
	esc: 'Esc',
	escape: 'Esc',
	enter: 'Enter',
	return: 'Enter',
	space: 'Space',
	tab: 'Tab',
	backspace: 'Backspace',
	delete: 'Delete',
	home: 'Home',
	end: 'End',
	pageup: 'PgUp',
	pagedown: 'PgDn',
	up: 'Up',
	down: 'Down',
	left: 'Left',
	right: 'Right',
}

function formatKeyPart(part: string, platform: NodeJS.Platform): string {
	const lower = part.toLowerCase()
	if (isModifier(lower)) return modifierLabel(lower, platform)
	const label = KEY_LABELS[lower]
	if (label) return label
	if (part.length === 1) return part.toUpperCase()
	return `${part.charAt(0).toUpperCase()}${part.slice(1)}`
}

export function formatKeyHint(key: string): string {
	const platform = keyHintPlatform()
	return key
		.split('+')
		.map(part => formatKeyPart(part, platform))
		.join('+')
}

export function formatKeyHints(keys: string | string[]): string {
	const list = Array.isArray(keys) ? keys : [keys]
	return list.map(formatKeyHint).join('/')
}
