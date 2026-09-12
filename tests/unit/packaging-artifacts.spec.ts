/**
 * Packaging contract for the published tarball: every declaration path the
 * manifest advertises must exist in the built artifact.
 *
 * Regression guard for the build-order defect fixed 2026-09-12
 * (v0.1.7-beta.0). `build` used to run `tsc -p tsconfig.json` — a
 * declaration-only emit into `lib/types` — *before* `tsdown`, whose config
 * cleans its outDir wholesale ("Clean the outDir before each build: chunk
 * hashes change between builds"). The declarations were therefore deleted
 * before packaging: the published tarball carried zero `.d.ts` while `types`
 * and `exports[*].types` pointed at `lib/types/**`, so consumers failed with
 *
 *   TS7016: Could not find a declaration file for module '@xiaoso/dsh-tool-plus'
 *
 * The order is now `tsdown && tsc && copy-assets`. These cases make a reversal
 * (or a reintroduced `clean`) fail loudly instead of silently shipping a
 * `types` field pointing at nothing.
 *
 * Both cases need a build output, so on a clean checkout (`lib/index.mjs`
 * absent) the suite is skipped rather than failing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BUILT = fs.existsSync(new URL("../../lib/index.mjs", import.meta.url));

interface ConditionalExport {
	types?: string;
	default?: string;
}

interface PackageManifest {
	name: string;
	version: string;
	types?: string;
	exports?: Record<string, string | ConditionalExport>;
}

const manifest = JSON.parse(
	fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as PackageManifest;

/** Every declaration file the manifest advertises, as an absolute path. */
function advertisedDeclarations(): string[] {
	const declared: Array<string | undefined> = [manifest.types];
	for (const target of Object.values(manifest.exports ?? {})) {
		if (typeof target === "object" && target !== null) declared.push(target.types);
	}
	return declared
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => path.join(REPO_ROOT, entry));
}

/**
 * Relative specifiers inside an emitted `.d.ts`, as written by the compiler.
 * Source-level imports carry the `.ts` extension (`allowImportingTsExtensions`),
 * and declaration emit preserves it — hence the `.ts` → `.d.ts` mapping below.
 */
function relativeSpecifiers(file: string): string[] {
	const source = fs.readFileSync(file, "utf8");
	return [...source.matchAll(/(?:from|import)\s*["'](\.[^"']+)["']/g)].map((match) => match[1]);
}

/** `lib/types/a/b.d.ts` + `./c.ts` → `lib/types/a/c.d.ts`; assets return null. */
function declarationTarget(from: string, specifier: string): string | null {
	if (!specifier.endsWith(".ts")) return null;
	return path.resolve(path.dirname(from), `${specifier.slice(0, -".ts".length)}.d.ts`);
}

describe.skipIf(!BUILT)("packaging artifacts", () => {
	it("advertises the root and client declaration entrypoints", () => {
		const advertised = advertisedDeclarations();
		expect(advertised.length).toBeGreaterThanOrEqual(2);
		expect(advertised.some((file) => file.endsWith(path.join("lib", "types", "index.d.ts")))).toBe(true);
		expect(advertised.some((file) => file.endsWith(path.join("lib", "types", "client", "index.d.ts")))).toBe(true);
	});

	it.each(advertisedDeclarations())("ships the advertised declaration %s", (file) => {
		expect(fs.existsSync(file), `${file} is advertised by package.json but was not emitted`).toBe(true);
		expect(fs.statSync(file).size).toBeGreaterThan(0);
	});

	it("keeps every relative declaration reference resolvable inside the emitted tree", () => {
		const pending = [...advertisedDeclarations()];
		const visited = new Set<string>();
		const dangling: string[] = [];

		while (pending.length > 0) {
			const current = pending.pop() as string;
			if (visited.has(current)) continue;
			visited.add(current);

			for (const specifier of relativeSpecifiers(current)) {
				const target = declarationTarget(current, specifier);
				if (target === null) continue;
				if (!fs.existsSync(target)) {
					dangling.push(`${path.relative(REPO_ROOT, current)} → ${specifier}`);
					continue;
				}
				pending.push(target);
			}
		}

		expect(dangling).toEqual([]);
		// The walk really followed references instead of stopping at the entries:
		// the root entry re-exports `Config` from `config/settings.ts`, which is
		// the only deep module on the public declaration surface today.
		const advertised = advertisedDeclarations();
		expect(visited.size).toBeGreaterThan(advertised.length);
		expect(visited.has(path.join(REPO_ROOT, "lib", "types", "config", "settings.d.ts"))).toBe(true);
	});
});
