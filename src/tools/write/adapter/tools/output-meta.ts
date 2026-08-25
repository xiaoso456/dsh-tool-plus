/**
 * DSH adapter for OMP `tools/output-meta.ts`.
 *
 * OMP attaches LSP diagnostics + output metadata to tool results. LSP
 * diagnostics are cut (plan.md §3); the metadata *shape* is kept verbatim so
 * engine code (`outputMeta().get()`) compiles unchanged. The fluent builder
 * is implemented with the same semantics but never carries diagnostics.
 */
export interface TruncationMeta {
  kind: 'head' | 'tail' | 'middle'
  startLine?: number
  totalFileLines?: number
}

export interface SourceMeta {
  path?: string
  lines?: number
}

export interface DiagnosticMeta {
  summary?: string
  messages?: string[]
  errored?: boolean
}

export interface LimitsMeta {
  maxBytes?: number
}

export interface OutputMeta {
  truncation?: TruncationMeta
  source?: SourceMeta
  diagnostics?: DiagnosticMeta
  limits?: LimitsMeta
}

/** Fluent builder for OutputMeta (verbatim OMP shape; diagnostics inert). */
export class OutputMetaBuilder {
  #meta: OutputMeta = {}

  diagnostics(summary: string, messages: string[]): this {
    this.#meta.diagnostics = { summary, messages, errored: false }
    return this
  }

  truncation(value: TruncationMeta): this {
    this.#meta.truncation = value
    return this
  }

  source(value: SourceMeta): this {
    this.#meta.source = value
    return this
  }

  limits(value: LimitsMeta): this {
    this.#meta.limits = value
    return this
  }

  get(): OutputMeta {
    return this.#meta
  }
}

/** Create a new OutputMeta builder. */
export function outputMeta(): OutputMetaBuilder {
  return new OutputMetaBuilder()
}
