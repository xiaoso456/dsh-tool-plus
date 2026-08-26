/**
 * DSH adapter for OMP `internal-urls/router.ts` (the `InternalUrlRouter`).
 *
 * Mirrors the read adapter's empty-router decision: DSH has no OMP internal
 * URL protocols (agent://, memory://, skill://, local://, omp://, …), so
 * `canHandle` is always `false` and the grep engine routes every path through
 * normal filesystem resolution. The `resolve`/`complete` methods are present
 * for type compatibility (the verbatim `grep.ts` calls them inside
 * `expandVirtualInternalResource`, which is only reachable when
 * `canHandle()` returned true — never in DSH).
 */
import type { InternalResource, ResolveContext, UrlCompletion } from "../../../shared/omp/internal-urls/types.ts";

/** Minimal router: no internal protocol handlers are registered in DSH. */
export class InternalUrlRouter {
	static #instance: InternalUrlRouter | undefined;

	static instance(): InternalUrlRouter {
		if (!InternalUrlRouter.#instance) {
			InternalUrlRouter.#instance = new InternalUrlRouter();
		}
		return InternalUrlRouter.#instance;
	}

	canHandle(_input: string): boolean {
		return false;
	}

	canResolve(_input: string): boolean {
		return false;
	}

	async complete(
		_scheme: string,
		_query: string,
		_context?: ResolveContext,
	): Promise<UrlCompletion[] | null> {
		return null;
	}

	async resolve(_url: string, _context?: ResolveContext): Promise<InternalResource> {
		throw new Error(`No internal URL handler for: ${_url}`);
	}
}
