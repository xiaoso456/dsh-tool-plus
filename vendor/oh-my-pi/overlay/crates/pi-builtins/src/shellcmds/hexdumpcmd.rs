//! hexdump builtin: display file contents in hexadecimal/octal/decimal/ASCII.
//!
//! util-linux' hexdump is missing from Windows/Git Bash, but is the standard
//! way scripts and debugging sessions inspect binary data. This module
//! implements every built-in display preset plus -n/-s/-v. The custom format
//! language (-e/-f) is rejected with a readable reason: it is a mini-printf
//! interpreter, and implementing it would dwarf the rest of the command.

use std::{
	fmt::Write as _,
	io::{BufWriter, Read, Write as _},
	path::Path,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, parser::ValueSource};

use crate::host::{Host, Utility, matches_parser, util};

/// Display file bytes in a fixed hexdump layout.
pub(crate) struct Hexdump {
	matches: ArgMatches,
}

matches_parser!(Hexdump, app);

impl Utility for Hexdump {
	const NAME: &'static str = "hexdump";

	fn run(self, host: &mut Host) -> i32 {
		run_hexdump(self.matches, host, false)
	}
}

/// `hd` is the same utility with `-C` implied (util-linux documents this).
pub(crate) struct Hd {
	matches: ArgMatches,
}

matches_parser!(Hd, app_hd);

impl Utility for Hd {
	const NAME: &'static str = "hd";

	fn run(self, host: &mut Host) -> i32 {
		run_hexdump(self.matches, host, true)
	}
}

fn run_hexdump(matches: ArgMatches, host: &mut Host, default_canonical: bool) -> i32 {
	if matches.get_flag("version") {
		let mut out = BufWriter::new(host.stdout_clone());
		let name = if default_canonical { "hd" } else { "hexdump" };
		let _ = writeln!(out, "{name} from util-linux 2.41 (pi-builtins)");
		let _ = out.flush();
		return 0;
	}
	if matches.get_flag("help") {
		let mut out = BufWriter::new(host.stdout_clone());
		let mut usage = if default_canonical { app_hd() } else { app() };
		let _ = write!(out, "{}", usage.render_help());
		let _ = out.flush();
		return 0;
	}
	if matches.contains_id("format") || matches.contains_id("format-file") {
		host.error(
			"-e/-f custom format strings are not supported (the format language is a mini-printf); \
			 use the built-in presets instead",
			1,
		);
		return 1;
	}
	if matches.value_source("color") == Some(ValueSource::CommandLine) {
		host.error("-L/--color is not implemented", 1);
		return 1;
	}

	let mode = selected_mode(&matches, default_canonical);
	let skip = match matches.get_one::<String>("skip") {
		Some(text) => match parse_size(text) {
			Ok(value) => value,
			Err(()) => {
				host.error(format!("invalid skip offset '{text}'"), 1);
				return 1;
			},
		},
		None => 0,
	};
	let length = match matches.get_one::<String>("length") {
		Some(text) => match parse_size(text) {
			Ok(value) => Some(value),
			Err(()) => {
				host.error(format!("invalid length '{text}'"), 1);
				return 1;
			},
		},
		None => None,
	};

	let mut data = Vec::new();
	let files: Vec<String> = matches
		.get_many::<String>("FILE")
		.map(|values| values.cloned().collect())
		.unwrap_or_default();
	if files.is_empty() {
		if let Err(error) = host.stdin.read_to_end(&mut data) {
			host.error(format!("{error}"), 1);
			return 1;
		}
	} else {
		for name in &files {
			if name == "-" {
				if let Err(error) = host.stdin.read_to_end(&mut data) {
					host.error(format!("{error}"), 1);
					return 1;
				}
				continue;
			}
			let mut file = match host.fs().open(host.resolve(Path::new(name))) {
				Ok(file) => file,
				Err(error) => {
					host.error(format!("{name}: {error}"), 1);
					return 1;
				},
			};
			if let Err(error) = file.read_to_end(&mut data) {
				host.error(format!("{name}: {error}"), 1);
				return 1;
			}
		}
	}

	if data.is_empty() {
		return 0;
	}
	let start = skip.min(data.len() as u64) as usize;
	let end = match length {
		Some(0) => return 0,
		Some(length) => (skip.saturating_add(length)).min(data.len() as u64) as usize,
		None => data.len(),
	};
	let no_squeeze = matches.get_flag("no-squeezing");
	let rendered = render(&data[start..end], start as u64, mode, no_squeeze);
	let mut out = BufWriter::new(host.stdout_clone());
	if out.write_all(rendered.as_bytes()).is_err() {
		return 1;
	}
	let _ = out.flush();
	0
}

pub(crate) fn hexdump_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Hexdump, SE>()
}

pub(crate) fn hd_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Hd, SE>()
}

fn app_hd() -> Command {
	app().name("hd")
}

fn app() -> Command {
	Command::new("hexdump")
		.disable_help_flag(true)
		.disable_version_flag(true)
		.about("Display file contents in hexadecimal, decimal, octal, or ascii")
		.arg(
			Arg::new("one-byte-octal")
				.short('b')
				.long("one-byte-octal")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("one-byte-hex")
				.short('X')
				.long("one-byte-hex")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("one-byte-char")
				.short('c')
				.long("one-byte-char")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("canonical")
				.short('C')
				.long("canonical")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("two-bytes-decimal")
				.short('d')
				.long("two-bytes-decimal")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("two-bytes-octal")
				.short('o')
				.long("two-bytes-octal")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("two-bytes-hex")
				.short('x')
				.long("two-bytes-hex")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("format")
				.short('e')
				.long("format")
				.value_name("format_string"),
		)
		.arg(
			Arg::new("format-file")
				.short('f')
				.long("format-file")
				.value_name("file"),
		)
		.arg(
			Arg::new("color")
				.short('L')
				.long("color")
				.value_name("when")
				.num_args(0..=1),
		)
		.arg(
			Arg::new("length")
				.short('n')
				.long("length")
				.value_name("length"),
		)
		.arg(
			Arg::new("skip")
				.short('s')
				.long("skip")
				.value_name("offset"),
		)
		.arg(
			Arg::new("no-squeezing")
				.short('v')
				.long("no-squeezing")
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
		.arg(
			Arg::new("FILE")
				.num_args(0..)
				.value_name("FILE")
				.allow_hyphen_values(true),
		)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	Default,
	OneByteOctal,
	OneByteHex,
	OneByteChar,
	Canonical,
	TwoBytesDecimal,
	TwoBytesOctal,
	TwoBytesHex,
}

fn selected_mode(matches: &ArgMatches, default_canonical: bool) -> Mode {
	let candidates = [
		("one-byte-octal", Mode::OneByteOctal),
		("one-byte-hex", Mode::OneByteHex),
		("one-byte-char", Mode::OneByteChar),
		("canonical", Mode::Canonical),
		("two-bytes-decimal", Mode::TwoBytesDecimal),
		("two-bytes-octal", Mode::TwoBytesOctal),
		("two-bytes-hex", Mode::TwoBytesHex),
	];
	let mut mode = if default_canonical {
		Mode::Canonical
	} else {
		Mode::Default
	};
	let mut chosen = 0usize;
	for (id, candidate) in candidates {
		if matches.value_source(id) != Some(ValueSource::CommandLine) {
			continue;
		}
		if let Some(index) = matches.indices_of(id).and_then(|indices| indices.max()) {
			if index >= chosen {
				chosen = index;
				mode = candidate;
			}
		}
	}
	mode
}

fn parse_size(text: &str) -> Result<u64, ()> {
	let text = text.trim();
	if text.is_empty() {
		return Err(());
	}
	let (radix, rest) =
		if let Some(rest) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
			(16, rest)
		} else if text.len() > 1 && text.starts_with('0') {
			(8, &text[1..])
		} else {
			(10, text)
		};
	let digits_end = rest
		.char_indices()
		.find(|(_, character)| !character.is_digit(radix))
		.map(|(index, _)| index)
		.unwrap_or(rest.len());
	if digits_end == 0 {
		return Err(());
	}
	let (digits, suffix) = rest.split_at(digits_end);
	let value = u64::from_str_radix(digits, radix).map_err(|_| ())?;
	let suffix = suffix.trim().to_ascii_uppercase();
	let (power, binary) = match suffix.as_str() {
		"" => (0, false),
		"K" | "KIB" => (1, true),
		"KB" => (1, false),
		"M" | "MIB" => (2, true),
		"MB" => (2, false),
		"G" | "GIB" => (3, true),
		"GB" => (3, false),
		"T" | "TIB" => (4, true),
		"TB" => (4, false),
		"P" | "PIB" => (5, true),
		"PB" => (5, false),
		"E" | "EIB" => (6, true),
		"EB" => (6, false),
		_ => return Err(()),
	};
	let base: u64 = if binary { 1024 } else { 1000 };
	let multiplier = if power == 0 { 1 } else { base.pow(power) };
	value.checked_mul(multiplier).ok_or(())
}

fn render(data: &[u8], first_offset: u64, mode: Mode, no_squeeze: bool) -> String {
	let mut output = String::new();
	let group_size = 16;
	let mut offset = first_offset;
	let mut previous: Option<Vec<u8>> = None;
	let mut squeezing = false;
	for group in data.chunks(group_size) {
		let repeated = !no_squeeze && previous.as_deref() == Some(group) && group.len() == group_size;
		if repeated {
			if !squeezing {
				output.push_str("*\n");
				squeezing = true;
			}
			offset += group.len() as u64;
			continue;
		}
		squeezing = false;
		previous = Some(group.to_vec());
		match mode {
			Mode::Default => render_default(&mut output, offset, group),
			Mode::OneByteOctal => render_one_byte_octal(&mut output, offset, group),
			Mode::OneByteHex => render_one_byte_hex(&mut output, offset, group),
			Mode::OneByteChar => render_one_byte_char(&mut output, offset, group),
			Mode::Canonical => render_canonical(&mut output, offset, group),
			Mode::TwoBytesDecimal => render_two_bytes_decimal(&mut output, offset, group),
			Mode::TwoBytesOctal => render_two_bytes_octal(&mut output, offset, group),
			Mode::TwoBytesHex => render_two_bytes_hex(&mut output, offset, group),
		}
		offset += group.len() as u64;
	}
	if mode == Mode::Canonical {
		let _ = writeln!(output, "{offset:08x}");
	} else {
		let _ = writeln!(output, "{offset:07x}");
	}
	output
}

fn render_default(output: &mut String, offset: u64, group: &[u8]) {
	let _ = write!(output, "{offset:07x}");
	for index in 0..8 {
		if let Some(pair) = group.chunks(2).nth(index) {
			let value = if pair.len() == 2 {
				u16::from_le_bytes([pair[0], pair[1]])
			} else {
				u16::from(pair[0])
			};
			let _ = write!(output, " {value:04x}");
		} else {
			output.push_str("     ");
		}
	}
	output.push('\n');
}

fn render_one_byte_octal(output: &mut String, offset: u64, group: &[u8]) {
	let _ = write!(output, "{offset:07x}");
	for index in 0..16 {
		match group.get(index) {
			Some(byte) => {
				let _ = write!(output, " {byte:03o}");
			},
			None => output.push_str("    "),
		}
	}
	output.push('\n');
}

fn render_one_byte_hex(output: &mut String, offset: u64, group: &[u8]) {
	let _ = write!(output, "{offset:07x}");
	for index in 0..16 {
		match group.get(index) {
			Some(byte) => {
				let _ = write!(output, " {byte:02x}");
			},
			None => output.push_str("   "),
		}
	}
	output.push('\n');
}

fn render_one_byte_char(output: &mut String, offset: u64, group: &[u8]) {
	let _ = write!(output, "{offset:07x}");
	for index in 0..16 {
		match group.get(index) {
			Some(byte) => {
				let _ = write!(output, " {:>3}", char_name(*byte));
			},
			None => output.push_str("    "),
		}
	}
	output.push('\n');
}

fn char_name(byte: u8) -> String {
	match byte {
		0x00 => "\\0".to_string(),
		0x07 => "\\a".to_string(),
		0x08 => "\\b".to_string(),
		0x09 => "\\t".to_string(),
		0x0a => "\\n".to_string(),
		0x0b => "\\v".to_string(),
		0x0c => "\\f".to_string(),
		0x0d => "\\r".to_string(),
		0x20..=0x7e => (byte as char).to_string(),
		_ => format!("{byte:03o}"),
	}
}

fn render_canonical(output: &mut String, offset: u64, group: &[u8]) {
	let _ = write!(output, "{offset:08x}  ");
	for index in 0..16 {
		match group.get(index) {
			Some(byte) => {
				let _ = write!(output, "{byte:02x} ");
			},
			None => output.push_str("   "),
		}
		if index == 7 {
			output.push(' ');
		}
	}
	output.push_str(" |");
	for byte in group.iter().take(16) {
		output.push(if (0x20..=0x7e).contains(byte) {
			*byte as char
		} else {
			'.'
		});
	}
	output.push_str("|\n");
}

fn render_two_bytes_decimal(output: &mut String, offset: u64, group: &[u8]) {
	let _ = write!(output, "{offset:07x}");
	for index in 0..8 {
		match group.chunks(2).nth(index) {
			Some(pair) => {
				let value = if pair.len() == 2 {
					u16::from_le_bytes([pair[0], pair[1]])
				} else {
					u16::from(pair[0])
				};
				let _ = write!(output, "   {value:05}");
			},
			None => output.push_str("        "),
		}
	}
	output.push('\n');
}

fn render_two_bytes_octal(output: &mut String, offset: u64, group: &[u8]) {
	let _ = write!(output, "{offset:07x}");
	for index in 0..8 {
		match group.chunks(2).nth(index) {
			Some(pair) => {
				let value = if pair.len() == 2 {
					u16::from_le_bytes([pair[0], pair[1]])
				} else {
					u16::from(pair[0])
				};
				let _ = write!(output, "  {value:06o}");
			},
			None => output.push_str("        "),
		}
	}
	output.push('\n');
}

fn render_two_bytes_hex(output: &mut String, offset: u64, group: &[u8]) {
	let _ = write!(output, "{offset:07x}");
	for index in 0..8 {
		match group.chunks(2).nth(index) {
			Some(pair) => {
				let value = if pair.len() == 2 {
					u16::from_le_bytes([pair[0], pair[1]])
				} else {
					u16::from(pair[0])
				};
				let _ = write!(output, "    {value:04x}");
			},
			None => output.push_str("        "),
		}
	}
	output.push('\n');
}

#[cfg(test)]
mod tests {
	use super::{Hd, Hexdump, Mode, parse_size, render};
	use crate::host::run_util;

	fn bytes(start: u8, count: usize) -> Vec<u8> {
		(0..count)
			.map(|index| start.wrapping_add(index as u8))
			.collect()
	}

	#[test]
	fn default_layout_matches_the_reference() {
		let data = bytes(0, 40);
		assert_eq!(
			render(&data, 0, Mode::Default, false),
			concat!(
				"0000000 0100 0302 0504 0706 0908 0b0a 0d0c 0f0e\n",
				"0000010 1110 1312 1514 1716 1918 1b1a 1d1c 1f1e\n",
				"0000020 2120 2322 2524 2726                    \n",
				"0000028\n"
			)
		);
	}

	#[test]
	fn every_preset_matches_the_reference() {
		let data = bytes(0, 40);
		assert_eq!(
			render(&data, 0, Mode::OneByteOctal, false),
			concat!(
				"0000000 000 001 002 003 004 005 006 007 010 011 012 013 014 015 016 017\n",
				"0000010 020 021 022 023 024 025 026 027 030 031 032 033 034 035 036 037\n",
				"0000020 040 041 042 043 044 045 046 047                                \n",
				"0000028\n"
			)
		);
		assert_eq!(
			render(&data, 0, Mode::OneByteChar, false),
			concat!(
				"0000000  \\0 001 002 003 004 005 006  \\a  \\b  \\t  \\n  \\v  \\f  \\r 016 017\n",
				"0000010 020 021 022 023 024 025 026 027 030 031 032 033 034 035 036 037\n",
				"0000020       !   \"   #   $   %   &   '                                \n",
				"0000028\n"
			)
		);
		assert_eq!(
			render(&data, 0, Mode::Canonical, false),
			concat!(
				"00000000  00 01 02 03 04 05 06 07  08 09 0a 0b 0c 0d 0e 0f  |................|\n",
				"00000010  10 11 12 13 14 15 16 17  18 19 1a 1b 1c 1d 1e 1f  |................|\n",
				"00000020  20 21 22 23 24 25 26 27                           | !\"#$%&'|\n",
				"00000028\n"
			)
		);
		assert_eq!(
			render(&data, 0, Mode::TwoBytesDecimal, false),
			concat!(
				"0000000   00256   00770   01284   01798   02312   02826   03340   03854\n",
				"0000010   04368   04882   05396   05910   06424   06938   07452   07966\n",
				"0000020   08480   08994   09508   10022                                \n",
				"0000028\n"
			)
		);
		assert_eq!(
			render(&data, 0, Mode::TwoBytesOctal, false),
			concat!(
				"0000000  000400  001402  002404  003406  004410  005412  006414  007416\n",
				"0000010  010420  011422  012424  013426  014430  015432  016434  017436\n",
				"0000020  020440  021442  022444  023446                                \n",
				"0000028\n"
			)
		);
		assert_eq!(
			render(&data, 0, Mode::TwoBytesHex, false),
			concat!(
				"0000000    0100    0302    0504    0706    0908    0b0a    0d0c    0f0e\n",
				"0000010    1110    1312    1514    1716    1918    1b1a    1d1c    1f1e\n",
				"0000020    2120    2322    2524    2726                                \n",
				"0000028\n"
			)
		);
	}

	#[test]
	fn one_byte_hex_matches_the_util_linux_layout() {
		let data = bytes(0, 40);
		assert_eq!(
			render(&data, 0, Mode::OneByteHex, false),
			concat!(
				"0000000 00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f\n",
				"0000010 10 11 12 13 14 15 16 17 18 19 1a 1b 1c 1d 1e 1f\n",
				"0000020 20 21 22 23 24 25 26 27                        \n",
				"0000028\n"
			)
		);
	}

	#[test]
	fn duplicate_lines_are_squeezed_unless_no_squeezing_is_set() {
		let data = [vec![0x41; 48], vec![0x42; 16]].concat();
		assert_eq!(
			render(&data, 0, Mode::Default, false),
			concat!(
				"0000000 4141 4141 4141 4141 4141 4141 4141 4141\n",
				"*\n",
				"0000030 4242 4242 4242 4242 4242 4242 4242 4242\n",
				"0000040\n"
			)
		);
		assert_eq!(
			render(&data, 0, Mode::Default, true)
				.matches("4141")
				.count(),
			24
		);
	}

	#[test]
	fn skip_and_length_change_the_offset_window() {
		let data = bytes(0, 40);
		assert_eq!(
			render(&data[5..10], 5, Mode::TwoBytesHex, false),
			concat!(
				"0000005    0605    0807    0009                                        \n",
				"000000a\n"
			)
		);
		assert_eq!(render(&[], 0, Mode::Default, false), "0000000\n");
	}

	#[test]
	fn a_skip_past_the_end_prints_only_the_final_offset() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("five.bin"), b"abcde").unwrap();
		let (code, capture) = run_util::<Hexdump>(&["-s", "9", "five.bin"], "", dir.path());
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.out(), "0000005\n");
	}

	#[test]
	fn sizes_accept_radix_prefixes_and_binary_suffixes() {
		assert_eq!(parse_size("10"), Ok(10));
		assert_eq!(parse_size("0x10"), Ok(16));
		assert_eq!(parse_size("010"), Ok(8));
		assert_eq!(parse_size("1K"), Ok(1024));
		assert_eq!(parse_size("2MiB"), Ok(2 * 1024 * 1024));
		assert!(parse_size("nope").is_err());
	}

	#[test]
	fn hd_implies_canonical_and_an_explicit_preset_wins() {
		let (code, capture) = run_util::<Hd>(&[], "hi", "/");
		assert_eq!(code, 0);
		assert_eq!(
			capture.out(),
			"00000000  68 69                                             |hi|\n00000002\n"
		);

		let (code, capture) = run_util::<Hd>(&["-x"], "hi", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("0000000    6968{}\n0000002\n", " ".repeat(56)));

		let (code, capture) = run_util::<Hd>(&["-e", "16/1 \"%02x \""], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("hd: -e/-f"), "{}", capture.err());
	}

	#[test]
	fn custom_formats_and_colors_are_rejected_with_reasons() {
		let (code, capture) = run_util::<Hexdump>(&["-e", "16/1 \"%02x \" \"\\n\""], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("not supported"), "{}", capture.err());

		let (code, capture) = run_util::<Hexdump>(&["-f", "formats.txt"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("not supported"), "{}", capture.err());

		let (code, capture) = run_util::<Hexdump>(&["-L", "never"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("not implemented"), "{}", capture.err());
	}

	#[test]
	fn files_and_stdin_are_supported() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("a.bin"), b"hello").unwrap();
		let (code, capture) = run_util::<Hexdump>(&["-C", "a.bin"], "", dir.path());
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(
			capture.out(),
			"00000000  68 65 6c 6c 6f                                    |hello|\n00000005\n"
		);

		let (code, capture) = run_util::<Hexdump>(&["-C"], "hi", "/");
		assert_eq!(code, 0);
		assert_eq!(
			capture.out(),
			"00000000  68 69                                             |hi|\n00000002\n"
		);
	}

	#[tokio::test]
	async fn runs_as_a_shell_builtin() {
		let dir = tempfile::tempdir().unwrap();
		let (code, out, err) =
			crate::host::run_script("printf 'AB' | hexdump -C", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert!(out.contains("41 42"), "{out}");
		assert!(out.contains("|AB|"), "{out}");
	}

	#[test]
	#[ignore = "performance probe"]
	fn perf_probe() {
		let Ok(path) = std::env::var("HEXDUMP_BENCH_FILE") else {
			return;
		};
		let started = std::time::Instant::now();
		let mut args = vec!["-C"];
		args.extend(path.split(';'));
		let (code, capture) = run_util::<Hexdump>(&args, "", "/");
		println!(
			"hexdump: code={code} elapsed_ms={:.1} out_bytes={}",
			started.elapsed().as_secs_f64() * 1000.0,
			capture.out().len()
		);
		assert_eq!(code, 0);
	}

	#[test]
	#[ignore = "differential probe: writes output for comparison with the reference binary"]
	fn differential_probe() {
		let Ok(dir) = std::env::var("HEXDUMP_DUMP_DIR") else {
			return;
		};
		let path = std::env::var("HEXDUMP_BENCH_FILE").unwrap();
		let data = std::fs::read(path).unwrap();
		let modes = [
			("default", Mode::Default),
			("b", Mode::OneByteOctal),
			("X", Mode::OneByteHex),
			("char", Mode::OneByteChar),
			("canonical", Mode::Canonical),
			("d", Mode::TwoBytesDecimal),
			("o", Mode::TwoBytesOctal),
			("x", Mode::TwoBytesHex),
		];
		for (name, mode) in modes {
			std::fs::write(format!("{dir}/ours-{name}.txt"), render(&data, 0, mode, true)).unwrap();
		}
	}
}
