/**
 * Verify the minimal-style two-tool composition (bash-plus + str_replace_editor)
 * composes without conflict — the shape the `minimal-bash-plus` user preset uses.
 * @module tests
 */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { CallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as StrReplaceEditor from '@deepseek-ai/dsh-tool-str-replace-editor'
import { describe, expect, it } from 'vitest'
import * as BashPlus from '../../src/index.ts'
import { getShellConfig } from '../../src/bash-executor.ts'

const bashAvailable = ((): boolean => {
  try {
    const { shell } = getShellConfig()
    return shell === 'bash' ? true : require('node:fs').existsSync(shell)
  } catch {
    return false
  }
})()

const describeShell = bashAvailable ? describe : describe.skip

describeShell('minimal-style two-tool preset', () => {
  it('composes bash-plus with str_replace_editor without collision', async () => {
    const ctx = new Context()
    const fibers = [
      await ctx.plugin(SystemPrompt),
      await ctx.plugin(ToolRuntime),
      await ctx.plugin(AgentRegistry),
      await ctx.plugin(SessionStore),
      await ctx.plugin(LocalJobRegistry),
      await ctx.plugin(ToolTasks),
      await ctx.plugin(BashEnvPlugin),
      await ctx.plugin(BashPlus, { autoBackgroundMs: 0, defaultTimeoutMs: 300000 }),
      await ctx.plugin(LocalFileSystem, { cwd: process.cwd() }),
      await ctx.plugin(StrReplaceEditor, { maxOutputChars: 16000 }),
    ]
    try {
      const fiber = ctx.plugin(() => {})
      const id = SessionId('minimal-bash-plus-test')
      const agent = {
        id,
        ctx: fiber.ctx,
        inject: () => {},
        session: { id, header: { version: 0, id, createdAt: 0 } },
      } as unknown as Agent
      ctx.agents.register(agent)

      // Both tools visible in the agent's catalog.
      expect(ctx.tools.get('bash', agent.ctx)).toBeDefined()
      expect(ctx.tools.get('str_replace_editor', agent.ctx)).toBeDefined()

      // The bash tool executes.
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('minimal-call-1'),
        name: 'bash',
        arguments: { command: 'echo minimal-works', description: 'echo' },
        agent,
      })
      expect(result.isError).toBe(false)
      const text = result.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')
      expect(text).toContain('minimal-works')
    } finally {
      for (const f of fibers.reverse()) await f.dispose()
    }
  })
})
