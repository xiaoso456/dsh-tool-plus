/**
 * DSH adapter for OMP `tools/output-meta.ts`.
 *
 * OMP attaches LSP diagnostics + output metadata to tool results. LSP
 * diagnostics are cut (plan.md 拍板#5); the metadata *shape* is kept so
 * engine code (`outputMeta().get()`) compiles unchanged.
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

export interface LimitsMeta {
  maxBytes?: number
}

export interface OutputMeta {
  truncation?: TruncationMeta
  source?: SourceMeta
  limits?: LimitsMeta
}

/** Fluent builder for OutputMeta. */
export class OutputMetaBuilder {
  #meta: OutputMeta = {}

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
