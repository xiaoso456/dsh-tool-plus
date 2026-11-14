//! uuidgen builtin: create RFC 4122 / RFC 9562 UUIDs.
//!
//! util-linux' uuidgen is missing from Windows/Git Bash. This implementation
//! covers every type it can generate without external crypto libraries:
//! random (v4), time-based (v1, v6, v7) and name-based (v3/MD5, v5/SHA1).
//! The well-known namespaces (@dns/@url/@oid/@x500) are built in, and -x
//! decodes a hexadecimal name like the reference implementation.

use std::{
	io::{BufWriter, Write},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use rand::{RngExt as _, rng};
use uucore::sum::{Digest as _, Md5, Sha1};

use crate::host::{Host, Utility, matches_parser, util};

/// Create and print RFC 4122 UUIDs.
pub(crate) struct Uuidgen {
	matches: ArgMatches,
}

matches_parser!(Uuidgen, app);

impl Utility for Uuidgen {
	const NAME: &'static str = "uuidgen";

	fn run(self, host: &mut Host) -> i32 {
		if self.matches.get_flag("version") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = writeln!(out, "uuidgen from util-linux 2.41 (pi-builtins)");
			let _ = out.flush();
			return 0;
		}
		if self.matches.get_flag("help") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = write!(out, "{}", app().render_help());
			let _ = out.flush();
			return 0;
		}

		let count = match self.matches.get_one::<u64>("count") {
			Some(0) => {
				host.error("--count must be greater than zero", 1);
				return 1;
			},
			Some(value) => *value,
			None => 1,
		};

		let kind = selected_kind(&self.matches);
		let namespace = self.matches.get_one::<String>("namespace");
		let name = self.matches.get_one::<String>("name");
		let hash_based = matches!(kind, Kind::Md5 | Kind::Sha1);
		if hash_based && (namespace.is_none() || name.is_none()) {
			host.error("--md5 and --sha1 requires --namespace and --name", 1);
			return 1;
		}

		let mut prepared = None;
		if hash_based {
			let Ok(namespace) = parse_namespace(namespace.expect("namespace checked")) else {
				host.error("invalid namespace UUID", 1);
				return 1;
			};
			let name = name.expect("name checked");
			let Ok(name) = decode_name(name, self.matches.get_flag("hex")) else {
				host.error("--name is not a hexadecimal string", 1);
				return 1;
			};
			prepared =
				Some(hash_uuid(if matches!(kind, Kind::Md5) { 3 } else { 5 }, &namespace, &name));
		}

		let mut out = BufWriter::new(host.stdout_clone());
		for index in 0..count {
			let bytes = match kind {
				Kind::Random => random_uuid(4),
				Kind::Time => time_uuid(1, index),
				Kind::V6 => time_uuid(6, index),
				Kind::V7 => time_uuid(7, index),
				Kind::Md5 | Kind::Sha1 => prepared.expect("hash uuid"),
			};
			if writeln!(out, "{}", format_uuid(&bytes)).is_err() {
				return 1;
			}
		}
		let _ = out.flush();
		0
	}
}

pub(crate) fn uuidgen_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Uuidgen, SE>()
}

fn app() -> Command {
	Command::new("uuidgen")
		.disable_help_flag(true)
		.disable_version_flag(true)
		.about("Create a new UUID value")
		.arg(
			Arg::new("random")
				.short('r')
				.long("random")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("time")
				.short('t')
				.long("time")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("md5")
				.short('m')
				.long("md5")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("sha1")
				.short('s')
				.long("sha1")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("time-v6")
				.short('6')
				.long("time-v6")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("time-v7")
				.short('7')
				.long("time-v7")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("namespace")
				.short('n')
				.long("namespace")
				.value_name("namespace"),
		)
		.arg(Arg::new("name").short('N').long("name").value_name("name"))
		.arg(
			Arg::new("count")
				.short('C')
				.long("count")
				.value_name("num")
				.value_parser(clap::value_parser!(u64)),
		)
		.arg(
			Arg::new("hex")
				.short('x')
				.long("hex")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("help")
				.short('h')
				.long("help")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("version")
				.short('V')
				.long("version")
				.action(ArgAction::SetTrue),
		)
}

/// The UUID type selected by the last type flag on the command line.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	Random,
	Time,
	Md5,
	Sha1,
	V6,
	V7,
}

fn selected_kind(matches: &ArgMatches) -> Kind {
	let candidates = [
		("random", Kind::Random),
		("time", Kind::Time),
		("md5", Kind::Md5),
		("sha1", Kind::Sha1),
		("time-v6", Kind::V6),
		("time-v7", Kind::V7),
	];
	let mut kind = Kind::Random;
	let mut chosen = 0;
	for (id, candidate) in candidates {
		if matches.value_source(id) != Some(clap::parser::ValueSource::CommandLine) {
			continue;
		}
		if let Some(index) = matches.indices_of(id).and_then(|indices| indices.max()) {
			if index >= chosen {
				chosen = index;
				kind = candidate;
			}
		}
	}
	kind
}

const NAMESPACE_DNS: [u8; 16] =
	[0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8];
const NAMESPACE_URL: [u8; 16] =
	[0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8];
const NAMESPACE_OID: [u8; 16] =
	[0x6b, 0xa7, 0xb8, 0x12, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8];
const NAMESPACE_X500: [u8; 16] =
	[0x6b, 0xa7, 0xb8, 0x14, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8];

fn parse_namespace(text: &str) -> Result<[u8; 16], ()> {
	match text.to_ascii_lowercase().as_str() {
		"@dns" => Ok(NAMESPACE_DNS),
		"@url" => Ok(NAMESPACE_URL),
		"@oid" => Ok(NAMESPACE_OID),
		"@x500" => Ok(NAMESPACE_X500),
		_ => parse_uuid(text),
	}
}

fn parse_uuid(text: &str) -> Result<[u8; 16], ()> {
	let hex: String = text.chars().filter(|character| *character != '-').collect();
	if hex.len() != 32 || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
		return Err(());
	}
	let mut bytes = [0u8; 16];
	for (index, byte) in bytes.iter_mut().enumerate() {
		*byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).map_err(|_| ())?;
	}
	Ok(bytes)
}

fn decode_name(name: &str, hexadecimal: bool) -> Result<Vec<u8>, ()> {
	if !hexadecimal {
		return Ok(name.as_bytes().to_vec());
	}
	let hex: String = name
		.chars()
		.filter(|character| !character.is_whitespace())
		.collect();
	if hex.len() % 2 != 0 || !hex.chars().all(|character| character.is_ascii_hexdigit()) {
		return Err(());
	}
	let mut bytes = Vec::with_capacity(hex.len() / 2);
	for index in (0..hex.len()).step_by(2) {
		bytes.push(u8::from_str_radix(&hex[index..index + 2], 16).map_err(|_| ())?);
	}
	Ok(bytes)
}

fn format_uuid(bytes: &[u8; 16]) -> String {
	format!(
		"{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:\
		 02x}{:02x}",
		bytes[0],
		bytes[1],
		bytes[2],
		bytes[3],
		bytes[4],
		bytes[5],
		bytes[6],
		bytes[7],
		bytes[8],
		bytes[9],
		bytes[10],
		bytes[11],
		bytes[12],
		bytes[13],
		bytes[14],
		bytes[15]
	)
}

fn set_version_variant(bytes: &mut [u8; 16], version: u8) {
	bytes[6] = (bytes[6] & 0x0f) | (version << 4);
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
}

fn random_uuid(version: u8) -> [u8; 16] {
	let mut bytes = rng().random::<u128>().to_be_bytes();
	set_version_variant(&mut bytes, version);
	bytes
}

fn hash_uuid(version: u8, namespace: &[u8; 16], name: &[u8]) -> [u8; 16] {
	let mut bytes = [0u8; 16];
	if version == 3 {
		let mut digest = Md5::default();
		digest.hash_update(namespace);
		digest.hash_update(name);
		digest.hash_finalize(&mut bytes);
	} else {
		let mut digest = Sha1::default();
		digest.hash_update(namespace);
		digest.hash_update(name);
		let mut full = [0u8; 20];
		digest.hash_finalize(&mut full);
		bytes.copy_from_slice(&full[..16]);
	}
	set_version_variant(&mut bytes, version);
	bytes
}

/// UUID epoch: 1582-10-15, in 100ns intervals from the Unix epoch.
const UUID_EPOCH_OFFSET: u64 = 0x01b2_1dd2_1381_4000;

fn uuid_timestamp(index: u64) -> u64 {
	let now = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or(Duration::ZERO);
	UUID_EPOCH_OFFSET + now.as_secs() * 10_000_000 + u64::from(now.subsec_nanos() / 100) + index
}

fn time_uuid(version: u8, index: u64) -> [u8; 16] {
	let timestamp = uuid_timestamp(index);
	let mut bytes = [0u8; 16];
	let clock = rng().random::<u16>();
	let mut node = rng().random::<u64>().to_be_bytes()[2..8].to_vec();
	node[0] |= 0x01; // multicast bit: no real MAC is disclosed
	match version {
		1 => {
			bytes[0..4].copy_from_slice(&((timestamp & 0xffff_ffff) as u32).to_be_bytes());
			bytes[4..6].copy_from_slice(&(((timestamp >> 32) & 0xffff) as u16).to_be_bytes());
			bytes[6..8]
				.copy_from_slice(&((((timestamp >> 48) & 0x0fff) as u16) | 0x1000).to_be_bytes());
			bytes[8] = (clock >> 8) as u8 & 0x3f | 0x80;
			bytes[9] = clock as u8;
			bytes[10..16].copy_from_slice(&node);
		},
		6 => {
			bytes[0..4].copy_from_slice(&(((timestamp >> 28) & 0xffff_ffff) as u32).to_be_bytes());
			bytes[4..6].copy_from_slice(&(((timestamp >> 12) & 0xffff) as u16).to_be_bytes());
			bytes[6..8].copy_from_slice(&(((timestamp & 0x0fff) as u16) | 0x6000).to_be_bytes());
			bytes[8] = (clock >> 8) as u8 & 0x3f | 0x80;
			bytes[9] = clock as u8;
			bytes[10..16].copy_from_slice(&node);
		},
		_ => {
			let millis = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.unwrap_or(Duration::ZERO)
				.as_millis() as u64
				+ index;
			bytes[0..6].copy_from_slice(&millis.to_be_bytes()[2..8]);
			bytes[6..16].copy_from_slice(&rng().random::<u128>().to_be_bytes()[2..12]);
			set_version_variant(&mut bytes, 7);
		},
	}
	bytes
}

#[cfg(test)]
mod tests {
	use super::{Uuidgen, format_uuid, hash_uuid, parse_uuid};
	use crate::host::run_util;

	fn stdout_of(args: &[&str]) -> String {
		let (code, capture) = run_util::<Uuidgen>(args, "", "/");
		assert_eq!(code, 0, "stderr: {}", capture.err());
		capture.out().to_string()
	}

	#[test]
	fn default_uuid_is_version_4_and_variant_rfc4122() {
		let out = stdout_of(&[]);
		let uuid = out.trim();
		assert_eq!(uuid.len(), 36, "{uuid}");
		let fields: Vec<&str> = uuid.split('-').collect();
		assert_eq!(fields.iter().map(|field| field.len()).collect::<Vec<_>>(), vec![8, 4, 4, 4, 12]);
		assert!(fields[2].starts_with('4'), "{uuid}");
		assert!(matches!(fields[3].as_bytes()[0], b'8'..=b'b'), "{uuid}");
		assert!(uuid.chars().all(|c| c.is_ascii_hexdigit() || c == '-'));
	}

	#[test]
	fn every_type_has_the_right_version_nibble() {
		for (flag, version) in [("-r", '4'), ("-t", '1'), ("-6", '6'), ("-7", '7')] {
			let out = stdout_of(&[flag]);
			let uuid = out.trim();
			let third = uuid.split('-').nth(2).unwrap();
			assert_eq!(third.chars().next().unwrap(), version, "{flag}: {uuid}");
		}
	}

	#[test]
	fn name_based_uuids_match_the_rfc_examples() {
		assert_eq!(
			stdout_of(&["-m", "-n", "@dns", "-N", "www.example.com"]).trim(),
			"5df41881-3aed-3515-88a7-2f4a814cf09e"
		);
		assert_eq!(
			stdout_of(&["-s", "-n", "@dns", "-N", "www.example.com"]).trim(),
			"2ed6657d-e927-568b-95e1-2665a8aea6a2"
		);
	}

	#[test]
	fn hash_helpers_set_version_and_variant() {
		let bytes = hash_uuid(5, &super::NAMESPACE_DNS, b"www.example.com");
		assert_eq!(format_uuid(&bytes), "2ed6657d-e927-568b-95e1-2665a8aea6a2");
	}

	#[test]
	fn namespace_parsing_accepts_aliases_and_uuids() {
		assert_eq!(super::parse_namespace("@dns"), Ok(super::NAMESPACE_DNS));
		assert_eq!(parse_uuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8"), Ok(super::NAMESPACE_DNS));
		assert!(parse_uuid("not-a-uuid").is_err());
	}

	#[test]
	fn count_prints_one_uuid_per_line_and_hex_name_is_decoded() {
		let out = stdout_of(&["-C", "3"]);
		assert_eq!(out.lines().count(), 3, "{out}");
		assert_eq!(
			stdout_of(&["-m", "-x", "-n", "@dns", "-N", "7777772e6578616d706c652e636f6d"]).trim(),
			"5df41881-3aed-3515-88a7-2f4a814cf09e"
		);
	}

	#[test]
	fn missing_namespace_or_name_is_rejected() {
		let (code, capture) = run_util::<Uuidgen>(&["-m", "-N", "x"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("requires --namespace and --name"), "{}", capture.err());
	}

	#[test]
	fn zero_count_is_rejected() {
		let (code, capture) = run_util::<Uuidgen>(&["-C", "0"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("greater than zero"), "{}", capture.err());
	}

	#[test]
	#[ignore]
	fn perf_probe() {
		let count = 100_000;
		let started = std::time::Instant::now();
		for _ in 0..count {
			let _ = super::random_uuid(4);
		}
		println!("uuidgen: {count} random UUIDs in {:?}", started.elapsed());

		let started = std::time::Instant::now();
		for index in 0..count {
			let _ = super::time_uuid(7, index);
		}
		println!("uuidgen: {count} v7 UUIDs in {:?}", started.elapsed());
	}

	#[tokio::test]
	async fn runs_as_a_shell_builtin() {
		let dir = tempfile::tempdir().unwrap();
		let (code, out, err) =
			crate::host::run_script("uuidgen | tr -d '\\n' | wc -c", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out.trim(), "36", "{out}");
	}

	#[test]
	fn help_and_version_are_available() {
		let help = stdout_of(&["--help"]);
		assert!(help.contains("Create a new UUID value"), "{help}");
		let version = stdout_of(&["-V"]);
		assert!(version.contains("uuidgen"), "{version}");
	}
}
