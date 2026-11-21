/**
 * Windows /tmp alias translation: the tool layer must land on the same
 * directory as the shell's /tmp (TMP -> TEMP -> OS default), while native
 * C:\tmp, C:/tmp, current-drive \tmp, UNC //... and /TMP stay untouched.
 *
 * Pure cases run everywhere with an injected platform/tempDir. The end-to-end
 * cases (read/write/edit/grep/glob + the shared search-scope resolver used by
 * ast_grep/ast_edit) run on Windows only, where the mapping is live.
 * @module tests
 */
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../../src/config/settings.ts'
import { closeSessionShells, executeBash, getShellConfig } from '../../src/tools/bash/bash-executor.ts'
import { executeEditTool } from '../../src/tools/edit/adapter/index.ts'
import { executeGlobTool } from '../../src/tools/glob/adapter/index.ts'
import { executeGrepTool } from '../../src/tools/grep/adapter/index.ts'
import { formatPathRelativeToCwd, resolveToCwd, resolveToolSearchScope } from '../../src/tools/omp/tools/path-utils.ts'
import { executeReadTool } from '../../src/tools/read/adapter/index.ts'
import { normalizeWindowsUnixTmpPath, resolveWindowsTempDir } from '../../src/tools/shared/windows-tmp-path.ts'
import { executeWriteTool } from '../../src/tools/write/adapter/index.ts'

const WIN32 = process.platform === 'win32'
const BASH_AVAILABLE = (() => {
  try {
    const { shell } = getShellConfig()
    return shell === 'bash' ? fs.existsSync('/bin/bash') || process.platform !== 'win32' : fs.existsSync(shell)
  } catch {
    return false
  }
})()
const TEMP = 'C:\\Users\\test\\AppData\\Local\\Temp'
const WIN_OPTS = { platform: 'win32' as const, tempDir: TEMP }

const tmpDirs: string[] = []
function tmpDirIn(base: string, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(base, prefix))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function execFor(cwd: string): any {
  return { agent: { session: { header: { cwd } } }, signal: undefined }
}

function readCtx(): any {
  return {
    get: () => undefined,
    fs: {
      resolve: async () => { throw new Error('unused') },
      stat: async () => undefined,
      readBytes: async () => new Uint8Array(),
    },
    emit: () => undefined,
  }
}

describe('normalizeWindowsUnixTmpPath', () => {
  it('maps the bare /tmp root and its descendants', () => {
    expect(normalizeWindowsUnixTmpPath('/tmp', WIN_OPTS)).toBe(TEMP)
    expect(normalizeWindowsUnixTmpPath('/tmp/a/b', WIN_OPTS)).toBe(path.win32.join(TEMP, 'a', 'b'))
    expect(normalizeWindowsUnixTmpPath('/tmp/a\\b', WIN_OPTS)).toBe(path.win32.join(TEMP, 'a', 'b'))
  })

  it('folds . and .. against the logical POSIX root', () => {
    expect(normalizeWindowsUnixTmpPath('/tmp/./a', WIN_OPTS)).toBe(path.win32.join(TEMP, 'a'))
    expect(normalizeWindowsUnixTmpPath('/tmp/../tmp/x', WIN_OPTS)).toBe(path.win32.join(TEMP, 'x'))
    expect(normalizeWindowsUnixTmpPath('/tmp/..', WIN_OPTS)).toBe('/tmp/..')
    expect(normalizeWindowsUnixTmpPath('/tmp/../x', WIN_OPTS)).toBe('/tmp/../x')
  })

  it('leaves native spellings and other / roots untouched', () => {
    for (const value of [
      'C:\\tmp\\x',
      'C:/tmp/x',
      'D:\\tmp',
      '\\tmp\\x',
      '//tmp/x',
      '//server/share/tmp',
      '///tmp',
      '/tmpfoo',
      '/TMP',
      '/tmp-suffix',
    ]) {
      expect(normalizeWindowsUnixTmpPath(value, WIN_OPTS)).toBe(value)
    }
  })

  it('is a no-op off Windows', () => {
    expect(normalizeWindowsUnixTmpPath('/tmp/x', { platform: 'linux', tempDir: TEMP })).toBe('/tmp/x')
    expect(normalizeWindowsUnixTmpPath('/tmp/x', { platform: 'darwin', tempDir: TEMP })).toBe('/tmp/x')
  })
})

describe('resolveWindowsTempDir', () => {
  it('prefers TMP over TEMP', () => {
    expect(resolveWindowsTempDir({ TMP: 'C:\\T1', TEMP: 'C:\\T2' } as NodeJS.ProcessEnv)).toBe(path.win32.normalize('C:\\T1'))
  })

  it('falls back to TEMP when TMP is missing or not absolute', () => {
    expect(resolveWindowsTempDir({ TEMP: 'C:\\T2' } as NodeJS.ProcessEnv)).toBe(path.win32.normalize('C:\\T2'))
    expect(resolveWindowsTempDir({ TMP: 'relative', TEMP: 'C:\\T2' } as NodeJS.ProcessEnv)).toBe(path.win32.normalize('C:\\T2'))
    expect(resolveWindowsTempDir({ TMP: '%TEMP%', TEMP: 'C:\\T2' } as NodeJS.ProcessEnv)).toBe(path.win32.normalize('C:\\T2'))
  })

  it('falls back to os.tmpdir() when neither variable is usable', () => {
    expect(resolveWindowsTempDir({} as NodeJS.ProcessEnv)).toBe(path.win32.normalize(os.tmpdir()))
  })
})

describe.skipIf(!WIN32)('Windows /tmp end-to-end', () => {
  it('resolves through the shared resolver, display formatter, and search scope', async () => {
    const workspace = tmpDirIn(resolveWindowsTempDir(), 'tp-tmp-ws-')
    const actualDir = tmpDirIn(resolveWindowsTempDir(), 'tp-tmp-path-')
    const logicalDir = '/tmp/' + path.basename(actualDir)

    expect(resolveToCwd(logicalDir, workspace)).toBe(actualDir)
    expect(resolveToCwd('C:\\tmp\\x', workspace)).toBe('C:\\tmp\\x')
    expect(resolveToCwd('C:/tmp/x', workspace)).toBe('C:/tmp/x')
    expect(formatPathRelativeToCwd(logicalDir, workspace)).toBe(actualDir.replace(/\\/g, '/'))

    const scope = await resolveToolSearchScope({
      rawPaths: [logicalDir],
      cwd: workspace,
      internalUrlAction: 'search',
    })
    expect(scope.searchPath).toBe(actualDir)
    expect(scope.isDirectory).toBe(true)
  })

  it('read/write/edit all land in the host temp directory', async () => {
    const workspace = tmpDirIn(resolveWindowsTempDir(), 'tp-tmp-ws-')
    const actualDir = tmpDirIn(resolveWindowsTempDir(), 'tp-tmp-path-')
    const logicalDir = '/tmp/' + path.basename(actualDir)
    const logicalFile = logicalDir + '/hello.txt'
    const actualFile = path.join(actualDir, 'hello.txt')
    fs.writeFileSync(actualFile, 'hello from tmp\n')

    const read = await executeReadTool(execFor(workspace), resolveConfig({}), { path: logicalFile }, readCtx())
    expect(read.text).toContain('hello from tmp')

    const writtenLogical = logicalDir + '/written.txt'
    await executeWriteTool(
      execFor(workspace),
      resolveConfig({ writeBackend: 'native', writeRetryEnabled: false }),
      { path: writtenLogical, content: 'written through /tmp\n' },
      null,
    )
    expect(fs.readFileSync(path.join(actualDir, 'written.txt'), 'utf8')).toBe('written through /tmp\n')

    await executeEditTool(
      execFor(workspace),
      resolveConfig({ writeBackend: 'native', writeRetryEnabled: false }),
      { file_path: logicalFile, old_string: 'hello', new_string: 'HELLO' },
      null,
    )
    expect(fs.readFileSync(actualFile, 'utf8')).toBe('HELLO from tmp\n')
  })

  it.skipIf(!BASH_AVAILABLE)('bash and the tools read and write the same /tmp file', async () => {
    const workspace = tmpDirIn(resolveWindowsTempDir(), 'tp-tmp-ws-')
    const sessionKey = 'tp-tmp-cross-' + randomBytes(4).toString('hex')
    const shellName = 'tp-tmp-shell-' + randomBytes(4).toString('hex') + '.txt'
    const toolName = 'tp-tmp-tool-' + randomBytes(4).toString('hex') + '.txt'
    const shellFile = path.join(resolveWindowsTempDir(), shellName)
    const toolFile = path.join(resolveWindowsTempDir(), toolName)
    try {
      const shell = await executeBash('printf from-shell > /tmp/' + shellName, { sessionKey })
      expect(shell.exitCode).toBe(0)
      expect(fs.readFileSync(shellFile, 'utf8')).toBe('from-shell')

      const read = await executeReadTool(execFor(workspace), resolveConfig({}), { path: '/tmp/' + shellName }, readCtx())
      expect(read.text).toContain('from-shell')

      await executeWriteTool(
        execFor(workspace),
        resolveConfig({ writeBackend: 'native', writeRetryEnabled: false }),
        { path: '/tmp/' + toolName, content: 'from-tool' },
        null,
      )
      const cat = await executeBash('cat /tmp/' + toolName, { sessionKey })
      expect(cat.exitCode).toBe(0)
      expect(cat.output).toContain('from-tool')
    } finally {
      closeSessionShells(sessionKey)
      fs.rmSync(shellFile, { force: true })
      fs.rmSync(toolFile, { force: true })
    }
  })

  it('grep and glob search the translated /tmp scope', async () => {
    const workspace = tmpDirIn(resolveWindowsTempDir(), 'tp-tmp-ws-')
    const actualDir = tmpDirIn(resolveWindowsTempDir(), 'tp-tmp-path-')
    const logicalDir = '/tmp/' + path.basename(actualDir)
    fs.writeFileSync(path.join(actualDir, 'hello.txt'), 'hello from tmp\n')
    fs.writeFileSync(path.join(actualDir, 'other.txt'), 'other\n')

    const grep = await executeGrepTool(
      execFor(workspace),
      resolveConfig({ grepGitignoreDefault: false }),
      { pattern: 'hello from tmp', path: logicalDir },
      {} as never,
    )
    expect(grep.text).toContain('hello.txt')
    expect(grep.matchCount).toBeGreaterThan(0)

    const glob = await executeGlobTool(
      execFor(workspace),
      resolveConfig({ globGitignoreDefault: false }),
      { path: logicalDir + '/*.txt' },
      {} as never,
    )
    expect(glob.text).toContain('hello.txt')
    expect(glob.fileCount).toBeGreaterThan(0)
  })
})
