/*
 * Ported from oh-my-pi (https://github.com/can1357/oh-my-pi) — MIT.
 *   Copyright (c) 2025 Mario Zechner
 *   Copyright (c) 2025-2026 Can Bölük
 */
/**
 * Chromium executable resolution for the read browser renderer — the probe
 * family of OMP's browser launch machinery, trimmed to what rendering needs:
 * `PUPPETEER_EXECUTABLE_PATH` wins, then the system Chrome/Edge/Chromium
 * candidate table. The OMP download fallback (Chrome for Testing via
 * @puppeteer/browsers) and the whole launch/stealth/worker surface are
 * intentionally absent — this plugin never installs a browser; rendering
 * degrades when none is found.
 *
 * The one behavioral adaptation vs. upstream: `isChromiumExecutable` uses
 * `ptree.exec` instead of `Bun.spawn` so the probe runs under Node too.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, ptree } from "@oh-my-pi/pi-utils";
import { runtimeLogger } from "../../bash/logger";

/**
 * Per-CDP-message timeout applied to every puppeteer launch/connect. Set above
 * the fetch tool timeout (30s) so the tool wall-clock is the canonical limit;
 * this constant only catches genuinely stuck CDP sockets.
 */
export const BROWSER_PROTOCOL_TIMEOUT_MS = 60_000;

function isExecutableFile(p: string): boolean {
	try {
		const st = fs.statSync(p);
		if (!st.isFile()) return false;
		if (process.platform === "win32") return true;
		fs.accessSync(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function isChromiumExecutable(p: string): Promise<boolean> {
	if (!isExecutableFile(p)) return false;
	// The version probe below launches the candidate. It exists to reject
	// non-Chromium `chrome`/`chromium` wrapper scripts that appear on a Linux
	// PATH (ecb22957, "validate Linux browser executables"). On Windows and
	// macOS the candidates are fixed GUI application paths, not PATH wrappers,
	// and executing them is harmful: a GUI `chrome.exe --version` does not print
	// to a detached stdout and can hand off to the user's running instance,
	// opening/activating a normal browser window (#8445). Confine the probe to
	// Linux and trust the executable-file check elsewhere.
	if (process.platform !== "linux") return true;
	try {
		const probeTimeoutMs = 3000;
		const result = await ptree.exec([p, "--version"], {
			stderr: "buffer",
			allowNonZero: true,
			allowAbort: true,
			signal: AbortSignal.timeout(probeTimeoutMs),
		});
		return result.exitCode === 0 && /Chrom|Edg/i.test(result.stdout);
	} catch {
		return false;
	}
}

/** Flatpak application id published by the Ungoogled Chromium project. */
const UNGOOGLED_CHROMIUM_FLATPAK_ID = "io.github.ungoogled_software.ungoogled_chromium";

function systemChromiumCandidates(
	platform: NodeJS.Platform = process.platform,
	home = os.homedir(),
	which: (name: string) => string | null | undefined = $which,
): string[] {
	const candidates: string[] = [];
	switch (platform) {
		case "darwin": {
			for (const root of ["/Applications", path.join(home, "Applications")]) {
				candidates.push(
					path.join(root, "Google Chrome.app/Contents/MacOS/Google Chrome"),
					path.join(root, "Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta"),
					path.join(root, "Google Chrome Dev.app/Contents/MacOS/Google Chrome Dev"),
					path.join(root, "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"),
					path.join(root, "Chromium.app/Contents/MacOS/Chromium"),
					path.join(root, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
				);
			}
			break;
		}
		case "linux": {
			const names = ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "chrome"];
			for (const name of names) {
				const found = which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				"/usr/bin/google-chrome-stable",
				"/usr/bin/google-chrome",
				"/usr/bin/chromium",
				"/usr/bin/chromium-browser",
				"/snap/bin/chromium",
				"/var/lib/flatpak/exports/bin/com.google.Chrome",
				"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
			);
			let onNixos = false;
			try {
				onNixos = fs.existsSync("/etc/NIXOS");
			} catch {}
			if (onNixos) {
				candidates.push(path.join(home, ".nix-profile/bin/chromium"), "/run/current-system/sw/bin/chromium");
			}
			for (const name of ["ungoogled-chromium", "ungoogled-chromium-browser"]) {
				const found = which(name);
				if (found) candidates.push(found);
			}
			candidates.push(
				// Ungoogled Chromium. Distro and AUR packages that keep the plain
				// `chromium` name are already covered above; these are the paths
				// unique to it, including the system and per-user Flatpak shims.
				"/usr/bin/ungoogled-chromium",
				"/usr/bin/ungoogled-chromium-browser",
				`/var/lib/flatpak/exports/bin/${UNGOOGLED_CHROMIUM_FLATPAK_ID}`,
				path.join(home, ".local/share/flatpak/exports/bin", UNGOOGLED_CHROMIUM_FLATPAK_ID),
			);
			break;
		}
		case "win32": {
			const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
			const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
			const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData\\Local");
			candidates.push(
				path.join(programFiles, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFilesX86, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(localAppData, "Google\\Chrome\\Application\\chrome.exe"),
				path.join(programFiles, "Chromium\\Application\\chrome.exe"),
				path.join(localAppData, "Chromium\\Application\\chrome.exe"),
				path.join(programFiles, "Microsoft\\Edge\\Application\\msedge.exe"),
				path.join(programFilesX86, "Microsoft\\Edge\\Application\\msedge.exe"),
			);
			break;
		}
	}
	return candidates;
}

let resolvedChromium: string | null | undefined; // undefined = unchecked; null = not found

async function resolveSystemChromium(): Promise<string | undefined> {
	if (resolvedChromium !== undefined) return resolvedChromium ?? undefined;
	const seen = new Set<string>();
	for (const candidate of systemChromiumCandidates()) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if (await isChromiumExecutable(candidate)) {
			resolvedChromium = candidate;
			runtimeLogger().debug("Using system Chrome/Chromium", { path: candidate });
			return candidate;
		}
	}
	resolvedChromium = null;
	return undefined;
}

let chromiumExecutablePromise: Promise<string | undefined> | undefined;

/**
 * Resolve the Chromium executable the browser renderer will launch.
 * `PUPPETEER_EXECUTABLE_PATH` always wins, then the system
 * Chrome/Edge/Chromium candidate table (Windows and macOS check mere file
 * existence; Linux additionally version-probes, see {@link isChromiumExecutable}).
 * Returns undefined when nothing is found — puppeteer-core would fall back to
 * its own bundled-Chromium search, which for this package means failure, so
 * callers should treat undefined as "browser rendering unavailable".
 *
 * Unlike OMP upstream there is no Chrome-for-Testing download fallback: this
 * plugin ships no browser installer, and the detection button only reports
 * what is already on the machine.
 */
export async function ensureChromiumExecutable(): Promise<string | undefined> {
	const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
	if (envPath) return envPath;
	chromiumExecutablePromise ??= resolveSystemChromium();
	try {
		return await chromiumExecutablePromise;
	} catch {
		chromiumExecutablePromise = undefined;
		return undefined;
	}
}

/** Reset the cached executable resolution (test seam). */
export function resetChromiumExecutableForTest(): void {
	chromiumExecutablePromise = undefined;
	resolvedChromium = undefined;
}

/** Exposes executable candidates for detection tests (OMP parity export). */
export function systemChromiumCandidatesForTest(
	platform: NodeJS.Platform = process.platform,
	home?: string,
	which?: (name: string) => string | null | undefined,
): string[] {
	return systemChromiumCandidates(platform, home, which);
}

/** Expose the Linux probe for tests (OMP parity export). */
export async function chromiumExecutableProbeForTest(executablePath: string): Promise<boolean> {
	return isChromiumExecutable(executablePath);
}

/** Expose the executable-file check for tests. */
export function isExecutableFileForTest(p: string): boolean {
	return isExecutableFile(p);
}
