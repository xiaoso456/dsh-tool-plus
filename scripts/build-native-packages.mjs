/**
 * Assemble the per-platform npm packages from built addon artifacts.
 *
 * WHY: the plugin's JS loader (src/vendor/pi-natives, patch 0006) asks for
 * \`@xiaoso/dsh-tool-plus-natives-<platform>-<arch>\` first and only falls back
 * to the upstream package, so shipping our own builtins means publishing one
 * small package per platform. Nothing here builds anything: it takes the
 * \`pi_natives.<target>.node\` files the \`native-v*\` workflow produced and wraps
 * each in a manifest npm accepts.
 *
 * DELIBERATELY NO \`exports\` FIELD: the loader resolves
 * \`<pkg>/package.json\` to locate the directory, and an exports map without a
 * \`./package.json\` entry would reject that lookup. Upstream's platform
 * packages have no exports field either.
 *
 * Usage:
 *   node scripts/build-native-packages.mjs --version 18.12.6-plus.1
 *   node scripts/build-native-packages.mjs --version 18.12.6-plus.1 --dry-run
 * @module dsh-tool-plus/scripts/build-native-packages
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCOPE = '@xiaoso/dsh-tool-plus-natives'

/**
 * artifact = the CI matrix name, which is also the addon filename suffix.
 * tag      = the loader's platform tag (process.platform + "-" + process.arch).
 */
export const PLATFORMS = [
	{ artifact: 'linux-x64-baseline', tag: 'linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc', file: 'pi_natives.linux-x64-baseline.node' },
	{ artifact: 'linux-arm64', tag: 'linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc', file: 'pi_natives.linux-arm64.node' },
	{ artifact: 'darwin-arm64', tag: 'darwin-arm64', os: 'darwin', cpu: 'arm64', file: 'pi_natives.darwin-arm64.node' },
	{ artifact: 'darwin-x64-baseline', tag: 'darwin-x64', os: 'darwin', cpu: 'x64', file: 'pi_natives.darwin-x64-baseline.node' },
	{ artifact: 'win32-x64-baseline', tag: 'win32-x64', os: 'win32', cpu: 'x64', file: 'pi_natives.win32-x64-baseline.node' },
	{ artifact: 'win32-arm64', tag: 'win32-arm64', os: 'win32', cpu: 'arm64', file: 'pi_natives.win32-arm64.node' },
]

/** Manifest for one platform package. Contract asserted by the unit test. */
export function packageManifest(platform, version) {
	const manifest = {
		name: `${SCOPE}-${platform.tag}`,
		version,
		description: `Prebuilt tool-plus addon (upstream pi-natives + the in-process shell builtins) for ${platform.os}-${platform.cpu}. Installed automatically by @xiaoso/dsh-tool-plus.`,
		os: [platform.os],
		cpu: [platform.cpu],
		// No `exports`: see the module docblock.
		main: `./${platform.file}`,
		files: [platform.file],
		license: 'MIT',
		repository: { type: 'git', url: 'git+https://github.com/xiaoso456/dsh-tool-plus.git' },
	}
	if (platform.libc) manifest.libc = [platform.libc]
	return manifest
}

/** `18.12.6-plus.1` is accepted for pin 18.12.6; a bare pin is accepted too. */
export function assertVersionMatchesPin(version, pin) {
	const base = `${pin}-`
	if (version === pin) return
	if (!version.startsWith(base)) {
		throw new Error(`version ${version} does not belong to the pinned pi-natives ${pin}; expected ${pin} or ${base}<suffix>`)
	}
	const suffix = version.slice(base.length)
	if (!/^[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*$/.test(suffix)) {
		throw new Error(`version ${version} has an invalid prerelease suffix ${JSON.stringify(suffix)}; use e.g. ${pin}-plus.1`)
	}
}

function parseArgs(argv) {
	const options = { artifacts: join(root, 'build'), out: join(root, 'dist-natives'), version: null, dryRun: false }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (arg === '--dry-run') options.dryRun = true
		else if (arg === '--version') options.version = argv[++i]
		else if (arg === '--artifacts') options.artifacts = argv[++i]
		else if (arg === '--out') options.out = argv[++i]
		else throw new Error(`unknown argument: ${arg}`)
	}
	if (!options.version) throw new Error('--version is required, e.g. --version 18.12.6-plus.1')
	return options
}

function main() {
	const options = parseArgs(process.argv.slice(2))
	const lock = JSON.parse(readFileSync(join(root, 'vendor', 'oh-my-pi', 'lock.json'), 'utf8'))
	assertVersionMatchesPin(options.version, lock.version)

	const missing = []
	const built = []
	for (const platform of PLATFORMS) {
		const source = join(options.artifacts, platform.artifact, platform.file)
		if (!existsSync(source)) {
			missing.push(relative(root, source))
			continue
		}
		built.push({ platform, source, bytes: statSync(source).size })
	}
	if (missing.length > 0) {
		console.error('missing addon artifacts:')
		for (const item of missing) console.error(`  ${item}`)
		console.error('build them first (see .github/workflows/native.yml) or point --artifacts at a downloaded artifact tree')
		process.exit(1)
	}

	if (!options.dryRun) rmSync(options.out, { recursive: true, force: true })
	for (const { platform, source, bytes } of built) {
		const manifest = packageManifest(platform, options.version)
		if (options.dryRun) {
			console.log(`${manifest.name}@${manifest.version}  <- ${relative(root, source)} (${(bytes / 1048576).toFixed(1)} MiB)`)
			console.log(`  ${JSON.stringify(manifest)}`)
			continue
		}
		const dir = join(options.out, `dsh-tool-plus-natives-${platform.tag}`)
		mkdirSync(dir, { recursive: true })
		copyFileSync(source, join(dir, platform.file))
		writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
		console.log(`${manifest.name}@${manifest.version}  <- ${relative(root, source)} (${(bytes / 1048576).toFixed(1)} MiB)`)
	}
	if (!options.dryRun) console.log(`\nwrote ${built.length} packages to ${relative(root, options.out)}`)
}

// Importable for the unit test; only acts as a CLI when executed directly.
const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (invokedDirectly) {
	try {
		main()
	} catch (error) {
		// No stack: these are expected operator mistakes (wrong --version, an
		// artifact tree that was never downloaded).
		console.error(`build-native-packages: ${error instanceof Error ? error.message : String(error)}`)
		process.exit(1)
	}
}
