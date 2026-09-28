/**
 * 假 LLM 支持套件：一个会说 OpenAI Chat Completions 的脚本化服务。
 *
 * 分层（对齐 pi 的 `packages/gateway/test/support/mock-openai` 与官方
 * `@deepseek-ai/dsh-llm-mock-server`）：
 * - `protocol.ts` 纯函数帧构造，零 IO —— 格式事实来源是 pi-ai 的 `openai-completions`
 * - `scenario.ts` 场景模型；轮次由 `match` 谓词选择、按会话分桶 —— 不是计数器
 * - `server.ts`  `node:http` 薄 IO 层 + 请求记录 + `/__mock/requests` 调试端点
 * - `cli.ts`     独立起服务，给手工/跨进程用
 * - `scenarios/` 场景数据
 *
 * 消费者：`tests/support/harness/*` 的端到端驱动，以及 `mock-openai.spec.ts` 的自检。
 *
 * @module tests/support/mock-openai
 */

export * from './protocol.ts'
export * from './scenario.ts'
export * from './server.ts'
