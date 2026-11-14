//! rev builtin: reverse each line of a file (or stdin).
//!
//! Missing from Windows/Git Bash. Lines are reversed per UTF-8 character when
//! the line is valid UTF-8 (so CJK text stays readable) and per byte when it
//! is not; this is the one intentional difference from busybox rev, which is
//! byte-oriented. -0 switches the record separator to NUL.

use std::io::{BufWriter, Read, Write as _};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, Command};

use crate::host::{Host, Utility, matches_parser, util};

/// Reverse each line of the given files or standard input.
pub(crate) struct Rev {
	matches: clap::ArgMatches,
}

matches_parser!(Rev, app);

impl Utility for Rev {
	const NAME: &'static str = "rev";

	fn run(self, host: &mut Host) -> i32 {
		if self.matches.get_flag("version") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = writeln!(out, "rev from util-linux 2.41 (pi-builtins)");
			let _ = out.flush();
			return 0;
		}
		if self.matches.get_flag("help") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = write!(out, "{}", app().render_help());
			let _ = out.flush();
			return 0;
		}

		let delimiter = if self.matches.get_flag("zero") {
			0
		} else {
			b'\n'
		};
		let files: Vec<String> = self
			.matches
			.get_many::<String>("FILE")
			.map(|values| values.cloned().collect())
			.unwrap_or_default();
		let mut output = Vec::new();
		let mut stdin_used = false;
		let mut status = 0;
		if files.is_empty() {
			let mut data = Vec::new();
			if let Err(error) = host.stdin.read_to_end(&mut data) {
				host.error(format!("rev: {error}"), 1);
				return 1;
			}
			reverse_data(&data, delimiter, &mut output);
		} else {
			for name in &files {
				if name == "-" {
					if stdin_used {
						continue;
					}
					stdin_used = true;
					let mut data = Vec::new();
					if let Err(error) = host.stdin.read_to_end(&mut data) {
						host.error(format!("rev: {error}"), 1);
						return 1;
					}
					reverse_data(&data, delimiter, &mut output);
					continue;
				}
				let path = host.resolve(std::path::Path::new(name));
				match std::fs::read(&path) {
					Ok(data) => reverse_data(&data, delimiter, &mut output),
					Err(error) => {
						host.error(format!("rev: {name}: {error}"), 1);
						status = 1;
					},
				}
			}
		}

		let mut out = BufWriter::new(host.stdout_clone());
		if out.write_all(&output).is_err() {
			return 1;
		}
		let _ = out.flush();
		status
	}
}

pub(crate) fn rev_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Rev, SE>()
}

fn app() -> Command {
	Command::new("rev")
		.disable_help_flag(true)
		.disable_version_flag(true)
		.about("Reverse lines of FILE")
		.arg(
			Arg::new("zero")
				.short('0')
				.long("zero")
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

fn reverse_data(data: &[u8], delimiter: u8, output: &mut Vec<u8>) {
	let mut position = 0;
	while position < data.len() {
		match data[position..].iter().position(|byte| *byte == delimiter) {
			Some(offset) => {
				let end = position + offset;
				reverse_segment(&data[position..end], output);
				output.push(delimiter);
				position = end + 1;
			},
			None => {
				reverse_segment(&data[position..], output);
				position = data.len();
			},
		}
	}
}

fn reverse_segment(segment: &[u8], output: &mut Vec<u8>) {
	match std::str::from_utf8(segment) {
		Ok(text) => {
			let mut reversed = String::with_capacity(segment.len());
			reversed.extend(text.chars().rev());
			output.extend_from_slice(reversed.as_bytes());
		},
		Err(_) => output.extend(segment.iter().rev().copied()),
	}
}

#[cfg(test)]
mod tests {
	use super::{Rev, reverse_data, reverse_segment};
	use crate::host::run_util;

	fn reversed(input: &[u8], delimiter: u8) -> Vec<u8> {
		let mut output = Vec::new();
		reverse_data(input, delimiter, &mut output);
		output
	}

	#[test]
	fn reverses_lines_and_preserves_missing_final_newline() {
		assert_eq!(reversed(b"abc\ndef\n", b'\n'), b"cba\nfed\n");
		assert_eq!(reversed(b"abc\ndef", b'\n'), b"cba\nfed");
		assert_eq!(reversed(b"", b'\n'), b"");
		assert_eq!(reversed(b"\n", b'\n'), b"\n");
		assert_eq!(reversed(b"a\n\nb", b'\n'), b"a\n\nb");
	}

	#[test]
	fn zero_delimiter_reverses_nul_separated_records() {
		assert_eq!(reversed(b"ab\0cd", 0), b"ba\0dc");
		assert_eq!(reversed(b"ab\0cd\0", 0), b"ba\0dc\0");
	}

	#[test]
	fn utf8_lines_are_reversed_by_character() {
		let mut output = Vec::new();
		reverse_segment("你好abc".as_bytes(), &mut output);
		assert_eq!(String::from_utf8(output).unwrap(), "cba好你");

		let mut output = Vec::new();
		reverse_segment(&[0xff, 0x41], &mut output);
		assert_eq!(output, vec![0x41, 0xff]);
	}

	#[test]
	fn reverses_stdin_and_files() {
		let (code, capture) = run_util::<Rev>(&[], "abc\ndef", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "cba\nfed");

		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("a.txt"), b"one\ntwo\n").unwrap();
		std::fs::write(dir.path().join("b.txt"), b"three").unwrap();
		let (code, capture) = run_util::<Rev>(&["a.txt", "b.txt"], "", dir.path());
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.out(), "eno\nowt\neerht");
	}

	#[test]
	fn reports_missing_files_but_still_processes_the_rest() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("good.txt"), b"abc\n").unwrap();
		let (code, capture) = run_util::<Rev>(&["missing.txt", "good.txt"], "", dir.path());
		assert_eq!(code, 1);
		assert!(capture.err().contains("missing.txt"), "{}", capture.err());
		assert_eq!(capture.out(), "cba\n");
	}

	#[test]
	fn help_and_version_are_handled() {
		let (code, capture) = run_util::<Rev>(&["-h"], "", "/");
		assert_eq!(code, 0);
		assert!(capture.out().contains("Reverse lines of FILE"));
		let (code, capture) = run_util::<Rev>(&["-V"], "", "/");
		assert_eq!(code, 0);
		assert!(capture.out().contains("util-linux"));
	}

	#[tokio::test]
	async fn runs_as_a_shell_builtin() {
		let dir = tempfile::tempdir().unwrap();
		let (code, out, err) =
			crate::host::run_script("printf 'abc\\ndef\\n' | rev", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "cba\nfed\n");
	}

	#[test]
	#[ignore = "performance probe"]
	fn perf_probe() {
		let Ok(path) = std::env::var("REV_BENCH_FILE") else {
			return;
		};
		let started = std::time::Instant::now();
		let paths: Vec<&str> = path.split(';').collect();
		let (code, capture) = run_util::<Rev>(&paths, "", "/");
		println!(
			"rev: code={code} elapsed_ms={:.1} out_bytes={}",
			started.elapsed().as_secs_f64() * 1000.0,
			capture.out().len()
		);
		assert_eq!(code, 0);
	}

	#[test]
	#[ignore = "differential probe: writes output for comparison with the reference binary"]
	fn differential_probe() {
		let Ok(dir) = std::env::var("REV_DUMP_DIR") else {
			return;
		};
		let path = std::env::var("REV_BENCH_FILE").unwrap();
		let (code, capture) = run_util::<Rev>(&[path.as_str()], "", "/");
		assert_eq!(code, 0);
		std::fs::write(format!("{dir}/ours-rev.txt"), capture.out().as_bytes()).unwrap();
	}
}
