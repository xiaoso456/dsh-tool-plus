/**
 * DSH adapter type shim for OMP `config/model-registry.ts`.
 *
 * The original (2218 lines) is the OMP model registry — a pi-catalog-backed
 * (Bun) module wiring bundled models, provider discovery, credential
 * resolution, and the API-key resolver. Its full port is a Bun-class
 * dependency (rule #3, step.md) and would cascade into many sibling config
 * modules (model-resolver, api-key-resolver, config-file, models-config, …).
 *
 * The OMP read/write web-search providers consumed this registry surface as a
 * credential/transport source; web-search is dormant in DSH (拍板#16), so this
 * shim exists only to keep the module graph's minimal surface (constructor +
 * `authStorage` + the handful of accessors). The real DSH model registry is
 * session-side.
 */
import type { AuthStorage, Model } from '@oh-my-pi/pi-ai'

/** Provider-scoped resolver options (verbatim OMP surface). */
export interface ApiKeyResolverOptions {
  sessionId?: string
  baseUrl?: string
  modelId?: string
}

/** Minimal registry surface consumed by the read engine's web-search providers. */
export class ModelRegistry {
  /** Credential store backing provider auth (real value wired by the caller). */
  readonly authStorage: AuthStorage

  constructor(authStorage: AuthStorage) {
    this.authStorage = authStorage
  }

  /** Look up a bundled/configured model (DSH shim: never populated). */
  find(_provider: string, _modelId: string): Model<any> | undefined {
    return undefined
  }

  /** Provider base URL override (DSH shim: none). */
  getProviderBaseUrl(_provider: string): string | undefined {
    return undefined
  }

  /** Provider-level request headers (DSH shim: none). */
  getProviderHeaders(_provider: string): Record<string, string> | undefined {
    return undefined
  }

  /** Whether the provider's API key is command-backed (DSH shim: false). */
  hasCommandBackedApiKey(_provider: string): boolean {
    return false
  }

  /** Build an API-key resolver delegating to the auth storage. */
  resolver(provider: string, _options?: ApiKeyResolverOptions): import('@oh-my-pi/pi-ai').ApiKeyResolver {
    return async ctx => this.authStorage.getApiKey(provider, undefined, { signal: ctx.signal })
  }
}
