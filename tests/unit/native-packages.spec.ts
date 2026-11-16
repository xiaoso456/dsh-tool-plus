import { describe, expect, it } from 'vitest'
import lock from '../../vendor/oh-my-pi/lock.json'
import { PLATFORMS, assertVersionMatchesPin, packageManifest } from '../../scripts/build-native-packages.mjs'

/**
 * The loader (src/vendor/pi-natives, patch 0006) looks for exactly
 * `@xiaoso/dsh-tool-plus-natives-<platform>-<arch>` and re-derives the addon
 * filename from the same tag/arch pair. Any drift between those strings and the
 * published package means the addon is silently never found — the plugin still
 * runs, just without the shell builtins. These assertions pin the handshake.
 */
describe('native platform packages', () => {
	it('names every package the way the loader resolves it', () => {
		for (const platform of PLATFORMS) {
			const manifest = packageManifest(platform, '18.12.6-plus.1')
			// The loader asks for `<name>/package.json`; a missing exports entry
			// would make require.resolve reject exactly that path.
			expect(manifest).not.toHaveProperty('exports')
			expect(manifest.name).toBe(`@xiaoso/dsh-tool-plus-natives-${platform.tag}`)
			expect(manifest.main).toBe(`./${platform.file}`)
			expect(manifest.files).toEqual([platform.file])
		}
	})

	it('declares the platform constraints npm needs to skip the wrong hosts', () => {
		for (const platform of PLATFORMS) {
			const manifest = packageManifest(platform, '18.12.6-plus.1')
			expect(manifest.os).toEqual([platform.os])
			expect(manifest.cpu).toEqual([platform.cpu])
			if (platform.os === 'linux') expect(manifest.libc).toEqual(['glibc'])
			else expect(manifest).not.toHaveProperty('libc')
		}
	})

	it('covers exactly the targets the pinned build ships', () => {
		expect(PLATFORMS.map(platform => platform.artifact).sort()).toEqual([...lock.targets].sort())
	})

	it('accepts a pin or a pin plus a prerelease suffix, and nothing else', () => {
		expect(() => assertVersionMatchesPin('18.12.6', '18.12.6')).not.toThrow()
		expect(() => assertVersionMatchesPin('18.12.6-plus.1', '18.12.6')).not.toThrow()
		expect(() => assertVersionMatchesPin('18.12.6-plus.12.3', '18.12.6')).not.toThrow()
		expect(() => assertVersionMatchesPin('18.12.7-plus.1', '18.12.6')).toThrow(/does not belong/)
		expect(() => assertVersionMatchesPin('18.12.6-plus..1', '18.12.6')).toThrow(/invalid prerelease/)
		expect(() => assertVersionMatchesPin('18.12.6-plus 1', '18.12.6')).toThrow(/invalid prerelease/)
	})
})
