/**
 * P0-2: the `write` description must not claim anything the code cannot do.
 *
 * The 18.12.6 prompt is two sentences and every clause is a capability claim:
 * which archive containers are writable, which are read-only, and the three
 * SQLite row operations. The 17.3.5 description we shipped before made the
 * opposite mistake — it enumerated `tar/zip/jar/war/ear/apk` only because the
 * archive layer happened to stop there, and the 18.12.6 text would have been a
 * lie until asar/tar.zst landed. So each clause is asserted twice: once that the
 * sentence still says it (drift guard on the verbatim md), once that the code
 * still does it (the claim is executable).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config/settings.ts'
import { renderOmpPrompt, sanitizeWritePrompt } from '../../src/tools/shared/omp-prompt.ts'
import {
  type ArchiveFormat,
  isWritableArchiveFormat,
  openArchive,
  writeArchive,
} from '../../src/tools/shared/archive/index.ts'
import { executeWriteTool } from '../../src/tools/write/adapter/index.ts'
import writeMd from '../../src/tools/omp/prompts/tools/write.md' with { type: 'text' }

const description = renderOmpPrompt(sanitizeWritePrompt(writeMd), {})

const tmpDirs: string[] = []
const tmpDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'tp-write-prompt-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const execFor = (cwd: string): any => ({ agent: { session: { header: { cwd } } }, signal: undefined })
const CFG = resolveConfig({ writeBackend: 'native', writeRetryEnabled: false })

describe('P0-2: write description shape', () => {
  it('renders with no unresolved template markers', () => {
    expect(description).not.toContain('{{')
    expect(description.trim().length).toBeGreaterThan(0)
  })

  it('states the writable archive set and the read-only remainder', () => {
    expect(description).toContain('ZIP/tar families')
    expect(description).toContain('.asar')
    expect(description).toContain('others read-only')
  })

  it('states all three SQLite row operations', () => {
    expect(description).toContain('db.sqlite:table')
    expect(description).toContain('db.sqlite:table:key')
    expect(description).toContain('empty content deletes')
  })

  it('still sends the model to edit for existing files', () => {
    expect(description).toMatch(/SHOULD `edit` existing files/)
    expect(description).toContain('NEVER create docs or emojis')
  })
})

describe('P0-2: "writable" in the description is executable', () => {
  // "ZIP/tar families and .asar" — every container the sentence promises.
  const WRITABLE: readonly [ArchiveFormat, string][] = [
    ['zip', 'zip'],
    ['tar', 'tar'],
    ['tar.gz', 'tar.gz'],
    ['tar.zst', 'tar.zst'],
    ['asar', 'asar'],
  ]
  // "others read-only" — formats the layer can only decode.
  const READ_ONLY: readonly ArchiveFormat[] = ['rar', '7z', 'iso', 'cab', 'cpio', 'rpm', 'deb', 'lzh', 'arj', 'ar']

  for (const [format, extension] of WRITABLE) {
    it(`writes ${format}`, async () => {
      expect(isWritableArchiveFormat(format)).toBe(true)
      const target = path.join(tmpDir(), `probe.${extension}`)
      await writeArchive(target, format, [['a.txt', 'a']])
      const reader = await openArchive(target)
      expect(reader.listDirectory('').map(entry => entry.name)).toEqual(['a.txt'])
    })
  }

  for (const format of READ_ONLY) {
    it(`refuses to write ${format}`, async () => {
      expect(isWritableArchiveFormat(format)).toBe(false)
      const target = path.join(tmpDir(), `probe.${format}`)
      await expect(writeArchive(target, format, [['a.txt', 'a']])).rejects.toThrow(/read-only/)
    })
  }
})

describe('P0-2: archive members are writable through the real tool', () => {
  // The adapter test proves writeArchive can frame each container; this proves
  // the tool's path resolution + whole-archive rewrite reaches it, which is what
  // the model actually triggers with `archive.ext:member`.
  const cases: readonly [ArchiveFormat, string][] = [
    ['asar', 'asar'],
    ['tar.zst', 'tar.zst'],
    ['zip', 'zip'],
  ]

  for (const [format, extension] of cases) {
    it(`writes a new member into an existing ${format}`, async () => {
      const dir = tmpDir()
      const target = path.join(dir, `bundle.${extension}`)
      await writeArchive(target, format, [['seed.txt', 'seed']])

      const result = await executeWriteTool(execFor(dir), CFG, {
        path: `${target}:fresh.txt`,
        content: 'fresh\n',
      })
      expect(result.path).toBeTruthy()

      const reader = await openArchive(target)
      expect(reader.listDirectory('').map(entry => entry.name).sort()).toEqual(['fresh.txt', 'seed.txt'])
      const fresh = await reader.readFile('fresh.txt')
      expect(new TextDecoder().decode(fresh.bytes)).toBe('fresh\n')
    })
  }
})

describe('P0-2: SQLite claims are executable through the real write tool', () => {
  const seedDatabase = async (dbPath: string): Promise<void> => {
    const { Database } = await import('bun:sqlite')
    const db = new (Database as any)(dbPath, { create: true }) as any
    db.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
    db.run("INSERT INTO users (name) VALUES ('seeded')")
    db.close()
  }

  const readNames = async (dbPath: string): Promise<string[]> => {
    const { Database } = await import('bun:sqlite')
    const db = new (Database as any)(dbPath, { create: false }) as any
    // bun:sqlite's `query()` is not part of our shim surface; the tool code only
    // uses prepare/run, so the verification helper does the same.
    const rows = db.prepare('SELECT name FROM users ORDER BY id').all() as { name: string }[]
    db.close()
    return rows.map(row => row.name)
  }

  it('inserts with db.sqlite:table', async () => {
    const dir = tmpDir()
    const dbPath = path.join(dir, 'data.sqlite')
    await seedDatabase(dbPath)

    const result = await executeWriteTool(execFor(dir), CFG, {
      path: `${dbPath}:users`,
      content: '{"name":"inserted"}',
    })
    expect(result.text).toContain('Inserted row into users')
    expect(await readNames(dbPath)).toEqual(['seeded', 'inserted'])
  })

  it('updates with JSON content on db.sqlite:table:key', async () => {
    const dir = tmpDir()
    const dbPath = path.join(dir, 'data.sqlite')
    await seedDatabase(dbPath)

    const result = await executeWriteTool(execFor(dir), CFG, {
      path: `${dbPath}:users:1`,
      content: '{"name":"updated"}',
    })
    expect(result.text).toContain("Updated row '1' in users")
    expect(await readNames(dbPath)).toEqual(['updated'])
  })

  it('deletes with empty content on db.sqlite:table:key', async () => {
    const dir = tmpDir()
    const dbPath = path.join(dir, 'data.sqlite')
    await seedDatabase(dbPath)

    const result = await executeWriteTool(execFor(dir), CFG, {
      path: `${dbPath}:users:1`,
      content: '',
    })
    expect(result.text).toContain("Deleted row '1' from users")
    expect(await readNames(dbPath)).toEqual([])
  })
})
