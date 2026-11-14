#!/usr/bin/env node
/**
 * Stamp a locally built pi-natives addon with its release version.
 *
 * The Rust side reserves a 64-byte slot in the binary:
 *   "PI_NATIVES_VERSION_STAMP:" <version> "\0" <padding>
 * Official release builds fill it after linking. A locally built addon keeps
 * the placeholder (magic + all zeroes), and the loader treats that as "no
 * release identity" — the plugin then fails to activate with
 * `Error: unknown tool "bash"`.
 *
 * Usage:
 *   node scripts/stamp-pi-natives.mjs <input.dll> <output.dll> <version>
 *
 * Example:
 *   node scripts/stamp-pi-natives.mjs \
 *     target/release/pi_natives.dll target/release/pi_natives.stamped.dll 18.12.6
 */
import fs from "node:fs";

const MAGIC = "PI_NATIVES_VERSION_STAMP:";
const SLOT = 64;

const [src, dst, version] = process.argv.slice(2);
if (!src || !dst || !version) {
	console.error("usage: node scripts/stamp-pi-natives.mjs <input> <output> <version>");
	process.exit(64);
}

const buf = fs.readFileSync(src);
const at = buf.indexOf(MAGIC);
if (at < 0) {
	console.error("version stamp slot not found; is this a pi-natives addon?");
	process.exit(2);
}

const slotStart = at + MAGIC.length;
const existing = buf.subarray(slotStart, at + SLOT).toString("latin1");
const already = existing.replace(/\0+$/u, "");
if (already.length > 0) {
	if (already === version) {
		console.log(`already stamped with ${version}; nothing to do`);
		if (src !== dst) fs.copyFileSync(src, dst);
		process.exit(0);
	}
	console.error(`slot already holds "${already}", refusing to overwrite`);
	process.exit(3);
}

Buffer.from(`${version}\0`, "utf8").copy(buf, slotStart);
fs.writeFileSync(dst, buf);

const stamped = fs.readFileSync(dst).includes(Buffer.from(`${MAGIC}${version}\0`, "utf8"));
console.log(`stamped ${dst} with ${version}: ${stamped}`);
process.exit(stamped ? 0 : 1);
