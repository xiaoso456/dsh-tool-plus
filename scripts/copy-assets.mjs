// Copy the shell-snapshot POSIX helper next to the bundled runtime entry so
// `new URL('./shell-snapshot-fn-env.sh', import.meta.url)` resolves in both
// source (tsx) and built (lib/index.js) layouts.
import { copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = join(root, 'src', 'shell-snapshot-fn-env.sh')
const target = join(root, 'lib', 'shell-snapshot-fn-env.sh')
mkdirSync(join(root, 'lib'), { recursive: true })
copyFileSync(source, target)
