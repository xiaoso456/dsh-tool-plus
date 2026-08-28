// 同步 llm-pi-ai 块：用户层 → tool-plus-web profile 层（其余键不动）
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { parse, stringify } from 'yaml'

const USER = 'C:/Users/xiaoso456/.dsh/settings.yaml'
const PROF = 'C:/Users/xiaoso456/.dsh/profiles/tool-plus-web/settings.yaml'

copyFileSync(PROF, PROF + '.bak-imgsync')

const user = parse(readFileSync(USER, 'utf8'))
const prof = parse(readFileSync(PROF, 'utf8'))

const before = JSON.stringify(prof['llm-pi-ai']?.providers ? Object.keys(prof['llm-pi-ai'].providers) : [])
prof['llm-pi-ai'] = user['llm-pi-ai'] // 整块取用户层：9 provider + 全模型 + apiKeyEnv
writeFileSync(PROF, stringify(prof, { lineWidth: 0 }), 'utf8')

const after = parse(readFileSync(PROF, 'utf8'))
const count = m => Object.entries(m['llm-pi-ai'].providers).map(([k, v]) => `${k}:${v.models?.length ?? 0}`).join(' ')
console.log('providers 键', before, '->', JSON.stringify(Object.keys(after['llm-pi-ai'].providers)))
console.log('模型计数', count(after))
console.log('其余顶层键保持:', Object.keys(after).filter(k => k !== 'llm-pi-ai').join(','))
