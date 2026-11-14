//! strings builtin: print printable character sequences from binary files.
//!
//! GNU binutils' strings is part of binutils, which Git Bash does not expose
//! as a usable command. This implementation covers the scanning modes people
//! actually use (-e s/S/b/l/B/L), file names, offsets and custom separators.
//! BFD/object-file section scanning (-d/-T) is intentionally rejected: we do
//! not link a BFD parser.

use std::{
	io::{BufWriter, Read, Write},
	path::Path,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};

use crate::host::{Host, Utility, matches_parser, util};

/// Print printable sequences from files (or standard input).
pub(crate) struct Strings {
	matches: ArgMatches,
}

matches_parser!(Strings, app);

impl Utility for Strings {
	const NAME: &'static str = "strings";

	fn run(self, host: &mut Host) -> i32 {
		if self.matches.get_flag("version") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = writeln!(out, "strings (GNU Binutils) 2.44 (pi-builtins)");
			let _ = out.flush();
			return 0;
		}
		if self.matches.get_flag("help") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = write!(out, "{}", app().render_help());
			let _ = out.flush();
			return 0;
		}
		if self.matches.get_flag("data") {
			host.error("strings: -d/--data requires BFD section scanning, which is not available", 1);
			return 1;
		}
		if self.matches.contains_id("target") && self.matches.get_one::<String>("target").is_some() {
			host.error("strings: -T/--target requires BFD, which is not available", 1);
			return 1;
		}
		if let Some(method) = self.matches.get_one::<String>("unicode") {
			if method != "default" {
				host.error(
					"strings: only --unicode=default is supported (other modes need a UTF-8 decoder)",
					1,
				);
				return 1;
			}
		}

		let mut min_length = self.matches.get_one::<u64>("bytes").copied().unwrap_or(4);
		let encoding = self
			.matches
			.get_one::<String>("encoding")
			.map(|value| value.as_str())
			.unwrap_or("s");
		let include_all_whitespace = self.matches.get_flag("include-all-whitespace");
		let print_name = self.matches.get_flag("print-file-name");
		let radix = self
			.matches
			.get_one::<String>("radix")
			.map(|value| value.as_str())
			.unwrap_or(if self.matches.get_flag("octal") {
				"o"
			} else {
				""
			});
		let separator = self
			.matches
			.get_one::<String>("output-separator")
			.map(|value| value.as_bytes().to_vec())
			.unwrap_or_else(|| b"\n".to_vec());

		let mut paths: Vec<String> = self
			.matches
			.get_many::<String>("FILE")
			.map(|values| values.cloned().collect())
			.unwrap_or_default();
		// GNU accepts "-NUM" as a synonym for "-n NUM"; the positional parser
		// accepts those so we can honor it here.
		let mut legacy_minimum = None;
		paths.retain(|path| {
			let bytes = path.as_bytes();
			if bytes.len() > 1 && bytes[0] == b'-' && bytes[1..].iter().all(u8::is_ascii_digit) {
				legacy_minimum = path[1..].parse::<u64>().ok();
				false
			} else {
				true
			}
		});
		if let Some(value) = legacy_minimum {
			min_length = value;
		}

		let encoding = match encoding {
			"s" | "S" | "b" | "l" | "B" | "L" => encoding.as_bytes()[0],
			other => {
				host.error(format!("strings: invalid encoding '{other}' (use s/S/b/l/B/L)"), 1);
				return 1;
			},
		};
		if !matches!(radix, "" | "o" | "d" | "x") {
			host.error(format!("strings: invalid radix '{radix}' (use o/d/x)"), 1);
			return 1;
		}

		let mut out = BufWriter::new(host.stdout_clone());
		if paths.is_empty() {
			let mut data = Vec::new();
			if let Err(error) = host.stdin.read_to_end(&mut data) {
				host.error(format!("strings: {error}"), 1);
				return 1;
			}
			if !scan_and_write(
				&data,
				"-",
				encoding,
				min_length,
				include_all_whitespace,
				print_name,
				radix,
				&separator,
				&mut out,
			) {
				return 1;
			}
		} else {
			for path in &paths {
				let label = path.as_str();
				let data = if path == "-" {
					let mut data = Vec::new();
					if let Err(error) = host.stdin.read_to_end(&mut data) {
						host.error(format!("strings: {error}"), 1);
						return 1;
					}
					data
				} else {
					let resolved = host.resolve(Path::new(path));
					let mut file = match host.fs().open(resolved) {
						Ok(file) => file,
						Err(error) => {
							host.error(format!("strings: {path}: {error}"), 1);
							return 1;
						},
					};
					let mut data = Vec::new();
					if let Err(error) = file.read_to_end(&mut data) {
						host.error(format!("strings: {path}: {error}"), 1);
						return 1;
					}
					data
				};
				if !scan_and_write(
					&data,
					label,
					encoding,
					min_length,
					include_all_whitespace,
					print_name,
					radix,
					&separator,
					&mut out,
				) {
					return 1;
				}
			}
		}
		let _ = out.flush();
		0
	}
}

pub(crate) fn strings_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Strings, SE>()
}

fn app() -> Command {
	Command::new("strings")
		.disable_help_flag(true)
		.disable_version_flag(true)
		.about("Display printable strings in a binary file")
		.arg(
			Arg::new("all")
				.short('a')
				.long("all")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("print-file-name")
				.short('f')
				.long("print-file-name")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("bytes")
				.short('n')
				.long("bytes")
				.value_name("min-len")
				.value_parser(clap::value_parser!(u64)),
		)
		.arg(
			Arg::new("radix")
				.short('t')
				.long("radix")
				.value_name("radix"),
		)
		.arg(Arg::new("octal").short('o').action(ArgAction::SetTrue))
		.arg(
			Arg::new("encoding")
				.short('e')
				.long("encoding")
				.value_name("encoding"),
		)
		.arg(
			Arg::new("include-all-whitespace")
				.short('w')
				.long("include-all-whitespace")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("output-separator")
				.short('s')
				.long("output-separator")
				.value_name("sep_string"),
		)
		.arg(
			Arg::new("data")
				.short('d')
				.long("data")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("target")
				.short('T')
				.long("target")
				.value_name("bfdname"),
		)
		.arg(
			Arg::new("unicode")
				.short('U')
				.long("unicode")
				.value_name("method"),
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

#[allow(clippy::too_many_arguments)]
fn scan_and_write(
	data: &[u8],
	label: &str,
	encoding: u8,
	min_length: u64,
	include_all_whitespace: bool,
	print_name: bool,
	radix: &str,
	separator: &[u8],
	out: &mut impl Write,
) -> bool {
	let sequences = scan(data, encoding, min_length, include_all_whitespace);
	for (offset, bytes) in sequences {
		if print_name {
			if out.write_all(label.as_bytes()).is_err() || out.write_all(b": ").is_err() {
				return false;
			}
		}
		if !radix.is_empty() {
			let formatted = match radix {
				"o" => format!("{offset:>7o}"),
				"d" => format!("{offset:>7}"),
				_ => format!("{offset:>7x}"),
			};
			if out.write_all(formatted.as_bytes()).is_err() || out.write_all(b" ").is_err() {
				return false;
			}
		}
		if out.write_all(&bytes).is_err() || out.write_all(separator).is_err() {
			return false;
		}
	}
	true
}

fn scan(
	data: &[u8],
	encoding: u8,
	min_length: u64,
	include_all_whitespace: bool,
) -> Vec<(usize, Vec<u8>)> {
	let mut found = Vec::new();
	match encoding {
		b's' | b'S' => {
			let eight_bit = encoding == b'S';
			let mut start = 0usize;
			let mut current = Vec::new();
			for (index, &byte) in data.iter().enumerate() {
				if printable_byte(byte, eight_bit, include_all_whitespace) {
					if current.is_empty() {
						start = index;
					}
					current.push(byte);
				} else {
					push_sequence(&mut found, start, &mut current, min_length);
				}
			}
			push_sequence(&mut found, start, &mut current, min_length);
		},
		b'b' | b'l' => scan_units(data, 2, encoding == b'b', min_length, &mut found),
		b'B' | b'L' => scan_units(data, 4, encoding == b'B', min_length, &mut found),
		_ => {},
	}
	found
}

fn scan_units(
	data: &[u8],
	width: usize,
	big_endian: bool,
	min_length: u64,
	out: &mut Vec<(usize, Vec<u8>)>,
) {
	let mut start = 0usize;
	let mut current = Vec::new();
	for offset in (0..data.len().saturating_sub(width - 1)).step_by(width) {
		let unit = match width {
			2 => {
				let pair = [data[offset], data[offset + 1]];
				if big_endian {
					u16::from_be_bytes(pair) as u32
				} else {
					u16::from_le_bytes(pair) as u32
				}
			},
			_ => {
				let quad = [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
				if big_endian {
					u32::from_be_bytes(quad)
				} else {
					u32::from_le_bytes(quad)
				}
			},
		};
		if unit <= 0x7f && printable_byte(unit as u8, false, false) {
			if current.is_empty() {
				start = offset;
			}
			current.push(unit as u8);
		} else {
			push_sequence(out, start, &mut current, min_length);
		}
	}
	push_sequence(out, start, &mut current, min_length);
}

fn push_sequence(
	found: &mut Vec<(usize, Vec<u8>)>,
	start: usize,
	current: &mut Vec<u8>,
	min_length: u64,
) {
	if current.len() as u64 >= min_length && !current.is_empty() {
		found.push((start, std::mem::take(current)));
	} else {
		current.clear();
	}
}

fn printable_byte(byte: u8, eight_bit: bool, include_all_whitespace: bool) -> bool {
	if include_all_whitespace && byte.is_ascii_whitespace() {
		return true;
	}
	if byte == b'\t' || (0x20..=0x7e).contains(&byte) {
		return true;
	}
	eight_bit && (0xa0..=0xff).contains(&byte)
}

#[cfg(test)]
mod tests {
	use super::Strings;
	use crate::host::run_util;

	fn out(args: &[&str], stdin: &str) -> String {
		let (code, capture) = run_util::<Strings>(args, stdin, "/");
		assert_eq!(code, 0, "stderr: {}", capture.err());
		capture.out().to_string()
	}

	#[test]
	fn scans_printable_sequences_with_the_default_minimum() {
		assert_eq!(out(&[], "hello\0abc\0longer"), "hello\nlonger\n");
	}

	#[test]
	fn length_flag_and_legacy_numeric_flag_work() {
		assert_eq!(out(&["-n", "3"], "hello\0abc\0xy"), "hello\nabc\n");
		assert_eq!(out(&["-3"], "hello\0abc\0xy"), "hello\nabc\n");
	}

	#[test]
	fn offsets_print_in_the_requested_radix() {
		assert_eq!(out(&["-t", "x"], "hello\0world"), "      0 hello\n      6 world\n");
		assert_eq!(out(&["-t", "d"], "hello\0world"), "      0 hello\n      6 world\n");
		assert_eq!(out(&["-o"], "hello\0world"), "      0 hello\n      6 world\n");
	}

	#[test]
	fn file_names_and_separators_are_honored() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("blob"), b"hello\0world").unwrap();
		let (code, capture) = run_util::<Strings>(&["-f", "blob"], "", dir.path());
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.out(), "blob: hello\nblob: world\n");

		let (code, capture) = run_util::<Strings>(&["-s", "@"], "hello\0world", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "hello@world@");
	}

	#[test]
	fn wide_encodings_are_decoded() {
		let text = "hello";
		let mut utf16le = Vec::new();
		for character in text.chars() {
			utf16le.extend((character as u16).to_le_bytes());
		}
		let (code, capture) = run_util::<Strings>(&["-e", "l"], "", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "");
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("wide.bin"), &utf16le).unwrap();
		let (code, capture) = run_util::<Strings>(&["-e", "l", "wide.bin"], "", dir.path());
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.out(), "hello\n");

		let mut utf32be = Vec::new();
		for character in "hi!!".chars() {
			utf32be.extend((character as u32).to_be_bytes());
		}
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("wide32.bin"), &utf32be).unwrap();
		let (code, capture) = run_util::<Strings>(&["-e", "B", "wide32.bin"], "", dir.path());
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.out(), "hi!!\n");
	}

	#[test]
	fn include_all_whitespace_keeps_newlines_inside_strings() {
		assert_eq!(out(&["-w", "-n", "3"], "ab\ncdef\0x"), "ab\ncdef\n");
		assert_eq!(out(&["-n", "3"], "ab\ncdef\0x"), "cdef\n");
	}

	#[test]
	fn object_file_modes_are_rejected_with_a_reason() {
		let (code, capture) = run_util::<Strings>(&["-d", "x"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("BFD"), "{}", capture.err());
	}

	#[test]
	fn bfd_options_and_unicode_modes_are_rejected_with_reasons() {
		let (code, capture) = run_util::<Strings>(&["-T", "elf64-x86-64"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("BFD"), "{}", capture.err());

		let (code, capture) = run_util::<Strings>(&["-U", "locale"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("only --unicode=default"), "{}", capture.err());
	}

	#[test]
	fn invalid_encoding_is_reported() {
		let (code, capture) = run_util::<Strings>(&["-e", "q"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("invalid"), "{}", capture.err());
	}

	#[tokio::test]
	async fn runs_as_a_shell_builtin() {
		let dir = tempfile::tempdir().unwrap();
		let (code, out, err) =
			crate::host::run_script("printf 'hello\\000xyz' | strings -n 3", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "hello\nxyz\n");
	}

	#[test]
	#[ignore = "performance probe"]
	fn perf_probe() {
		let Ok(path) = std::env::var("STRINGS_BENCH_FILE") else {
			return;
		};
		let started = std::time::Instant::now();
		let mut args = vec!["-n", "4"];
		args.extend(path.split(';'));
		let (code, capture) = run_util::<Strings>(&args, "", "/");
		println!(
			"strings: code={code} elapsed_ms={:.1} out_bytes={}",
			started.elapsed().as_secs_f64() * 1000.0,
			capture.out().len()
		);
		assert_eq!(code, 0);
	}

	#[test]
	#[ignore = "differential probe: writes output for comparison with the reference binary"]
	fn differential_probe() {
		let Ok(dir) = std::env::var("STRINGS_DUMP_DIR") else {
			return;
		};
		let path = std::env::var("STRINGS_BENCH_FILE").unwrap();
		let (code, capture) = run_util::<Strings>(&["-n", "4", path.as_str()], "", "/");
		assert_eq!(code, 0);
		std::fs::write(format!("{dir}/ours-strings.txt"), capture.out().as_bytes()).unwrap();
	}
}
