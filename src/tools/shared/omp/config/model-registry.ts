/**
 * DSH adapter type shim for OMP `config/model-registry.ts`.
 *
 * The original `ModelRegistry` is the full OMP model/credential registry
 * (model discovery, custom models, provider model-patching, codex attestation,
 * …). It depends on `@oh-my-pi/pi-catalog/*` (model build/cache/manager) — a
 * Bun-class / external dependency chain left for the unified Bun compatibility
 * pass (step.md "Bun 兼容").
 *
 * The write adapter's web-search providers reference `ModelRegistry` only for
 * the type surface: `authStorage`, `find`, `getProviderBaseUrl`,
 * `getProviderHeaders`, `hasCommandBackedApiKey`, `resolver`. DSH supplies no
 * ModelRegistry, so the class is declared structurally and its runtime methods
 * throw (never driven in DSH).
 */
import type { Api, ApiKeyResolver, AuthStorage, Model } from '@oh-my-pi/pi-ai'

/** Provider-scoped resolver options (verbatim OMP surface). */
export interface ApiKeyResolverOptions {
  sessionId?: string
  baseUrl?: string
  modelId?: string
}

/** Minimal model slice used by `find` / `resolver` (structural). */
export type ApiKeyResolverModel = Pick<Model<Api>, 'provider' | 'baseUrl' | 'id'>

/**
 * Model / provider registry facade (verbatim OMP type surface). Bun/native
 * backed in OMP; in DSH the class is never constructed.
 */
export class ModelRegistry {
  constructor(public readonly authStorage: AuthStorage) {}

  getAll(): Model<Api>[] {
    throw new Error('ModelRegistry is not available in DSH')
  }

  async getApiKeyForProvider(
    _provider: string,
    _sessionId?: string,
    _options?: { baseUrl?: string; modelId?: string; forceRefresh?: boolean; signal?: AbortSignal },
  ): Promise<string | undefined> {
    throw new Error('ModelRegistry is not available in DSH')
  }

  find(_provider: string, _modelId: string): Model<Api> | undefined {
    throw new Error('ModelRegistry is not available in DSH')
  }

  getProviderBaseUrl(_provider: string): string | undefined {
    throw new Error('ModelRegistry is not available in DSH')
  }

  getProviderHeaders(_provider: string): Record<string, string> | undefined {
    throw new Error('ModelRegistry is not available in DSH')
  }

  hasCommandBackedApiKey(_provider: string): boolean {
    return false
  }

  resolver(_provider: string, _options?: ApiKeyResolverOptions): ApiKeyResolver {
    throw new Error('ModelRegistry is not available in DSH')
  }
}
