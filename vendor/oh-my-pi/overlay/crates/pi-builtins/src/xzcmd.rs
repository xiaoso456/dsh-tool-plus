//! xz builtin: compress or expand .xz files.
//!
//! Windows has no xz at all (Git Bash does not ship it either), and .tar.xz is
//! still the dominant source-package format, so the shell needs it in-process.
//! Reached as xz / unxz / xzcat, mirroring GNU xz's invocation names.
//!
//! Supported surface (see docs/shell-commands/xz.md):
//!   -d -c -k -f -q -v -t -l -0..-9 -e -S --format=xz --check=... -h -V
//!
//! Deliberately unsupported, reported instead of silently ignored:
//!   -T/--threads (threaded mode), --format=lzma|raw, --block-*, --memlimit-*.

use std::{
	fs::{self, File},
	io::{self, BufReader, BufWriter, Read, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use xz2::stream::{Check, Stream};

use crate::host::{Host, Utility, matches_parser, util};

const DEFAULT_SUFFIX: &str = ".xz";
/// liblzma's LZMA_PRESET_EXTREME, OR-ed into the preset number.
const PRESET_EXTREME: u32 = 0x8000_0000;

/// Options GNU xz accepts that this builtin deliberately does not implement.
const UNSUPPORTED: &[(&str, Option<&str>, Option<char>, bool, &str)] = &[
	("threads", None, Some('T'), true, "threaded compression is not implemented"),
	("block-size", Some("block-size"), None, true, "--block-* options are not implemented"),
	("block-list", Some("block-list"), None, true, "--block-* options are not implemented"),
	("memlimit-compress", Some("memlimit-compress"), None, true, "memory limits are not implemented"),
	("memlimit-decompress", Some("memlimit-decompress"), None, true, "memory limits are not implemented"),
];

/// Compress or expand .xz files, also reachable as unxz and xzcat.
pub(crate) struct Xz {
	matches: ArgMatches,
}

matches_parser!(Xz, app);

impl Utility for Xz {
	const NAME: &'static str = "xz";

	/// xz spells levels as numeric flags (-0 .. -9). clap only takes one short
	/// per flag, so numeric tokens are rewritten into \`--level=N\` before parsing.
	fn rewrite_argv(argv: Vec<std::ffi::OsString>) -> Result<Vec<std::ffi::OsString>, String> {
		let mut out = Vec::with_capacity(argv.len());
		let mut level: Option<u32> = None;
		for arg in argv {
			let text = arg.to_string_lossy();
			if let Some(rest) = text.strip_prefix('-')
				&& !rest.is_empty()
			{
				let digits: String = rest.chars().take_while(|character| character.is_ascii_digit()).collect();
				let tail = &rest[digits.len()..];
				// -9 and combined forms such as -9e both name a preset.
				if !digits.is_empty() && tail.chars().all(|character| character.is_ascii_alphabetic()) {
					let parsed: u32 = digits
						.parse()
						.map_err(|_| format!("invalid compression level '{text}'"))?;
					if parsed > 9 {
						return Err(format!("compression level out of range: {text}"));
					}
					level = Some(level.map_or(parsed, |current| current.max(parsed)));
					if !tail.is_empty() {
						out.push(std::ffi::OsString::from(format!("-{tail}")));
					}
					continue;
				}
			}
			out.push(arg);
		}
		if let Some(level) = level {
			out.push(std::ffi::OsString::from(format!("--level={level}")));
		}
		Ok(out)
	}

	fn run(self, host: &mut Host) -> i32 {
		if self.matches.get_flag("version") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = writeln!(out, "xz 5.6.2 (pi-builtins)");
			let _ = out.flush();
			return 0;
		}
		if self.matches.get_flag("help") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = write!(out, "{}", app().render_help());
			let _ = out.flush();
			return 0;
		}

		let options = match Options::from_matches(&self.matches, host) {
			Ok(options) => options,
			Err((message, code)) => {
				host.error(message, code);
				return code;
			},
		};

		run_with(host, &options)
	}
}

pub(crate) fn xz_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Xz, SE>()
}

struct Options {
	decompress: bool,
	to_stdout: bool,
	force: bool,
	keep: bool,
	quiet: bool,
	verbose: bool,
	test: bool,
	list: bool,
	level: u32,
	extreme: bool,
	check: Check,
	suffix: String,
	files: Vec<PathBuf>,
}

impl Options {
	fn from_matches(matches: &ArgMatches, host: &Host) -> Result<Self, (String, i32)> {
		for (id, long, short, takes_value, reason) in UNSUPPORTED {
			let supplied = if *takes_value {
				matches.get_one::<String>(id).is_some()
			} else {
				matches.get_flag(id)
			};
			if supplied {
				let spelling = match (long, short) {
					(Some(long), _) => format!("--{long}"),
					(None, Some(short)) => format!("-{short}"),
					_ => id.to_string(),
				};
				return Err((format!("xz: {spelling} {reason}"), 1));
			}
		}

		if let Some(format) = matches.get_one::<String>("format")
			&& format != "xz"
		{
			return Err((format!("xz: --format={format} is not implemented (only xz)"), 1));
		}

		let check = match matches.get_one::<String>("check").map(String::as_str) {
			None | Some("crc64") => Check::Crc64,
			Some("crc32") => Check::Crc32,
			Some("sha256") => Check::Sha256,
			Some("none") => Check::None,
			Some(other) => {
				return Err((format!("xz: --check={other} is not supported"), 1));
			},
		};

		let invoked = host.name();
		let mut decompress = matches.get_flag("decompress");
		let mut to_stdout = matches.get_flag("stdout");
		if invoked == "unxz" {
			decompress = true;
		} else if invoked == "xzcat" {
			decompress = true;
			to_stdout = true;
		}

		let mut files: Vec<PathBuf> = matches
			.get_many::<std::ffi::OsString>("FILE")
			.map(|values| values.map(PathBuf::from).collect())
			.unwrap_or_default();
		for file in &mut files {
			if file != Path::new("-") && file.is_relative() {
				*file = host.cwd().join(&*file);
			}
		}

		Ok(Self {
			decompress,
			to_stdout,
			force: matches.get_flag("force"),
			keep: matches.get_flag("keep"),
			quiet: matches.get_flag("quiet"),
			verbose: matches.get_flag("verbose"),
			test: matches.get_flag("test"),
			list: matches.get_flag("list"),
			level: matches.get_one::<u32>("level").copied().unwrap_or(6),
			extreme: matches.get_flag("extreme"),
			check,
			suffix: matches
				.get_one::<String>("suffix")
				.cloned()
				.unwrap_or_else(|| DEFAULT_SUFFIX.to_string()),
			files,
		})
	}
}

fn run_with(host: &mut Host, options: &Options) -> i32 {
	if options.files.is_empty() {
		return stream_stdin(host, options);
	}
	let mut status = 0;
	for path in &options.files {
		let result = if options.list {
			list_file(host, path)
		} else if options.test {
			test_file(path)
		} else if options.decompress {
			expand_one(host, options, path)
		} else {
			compress_one(host, options, path)
		};
		if let Err((message, code)) = result {
			if !options.quiet {
				let mut err = BufWriter::new(host.stderr_clone());
				let _ = writeln!(err, "{message}");
				let _ = err.flush();
			}
			status = status.max(code);
		}
	}
	status
}

fn stream_stdin(host: &mut Host, options: &Options) -> i32 {
	let mut out = BufWriter::new(host.stdout_clone());
	let mut reader = BufReader::new(&mut host.stdin);
	let result = if options.decompress {
		decode(&mut reader, &mut out)
	} else {
		encode(&mut reader, &mut out, options.level, options.extreme, options.check)
	};
	match result {
		Ok(()) => 0,
		Err((message, code)) => {
			if !options.quiet {
				let mut err = BufWriter::new(host.stderr_clone());
				let _ = writeln!(err, "{message}");
				let _ = err.flush();
			}
			code
		},
	}
}

fn test_file(path: &Path) -> Result<(), (String, i32)> {
	let mut reader = BufReader::new(File::open(path).map_err(|error| {
		(format!("xz: {}: {}", path.display(), error), 1)
	})?);
	let mut decoder = xz2::read::XzDecoder::new_multi_decoder(&mut reader);
	io::copy(&mut decoder, &mut io::sink())
		.map_err(|error| (format!("xz: {}: {}", path.display(), error), 1))?;
	Ok(())
}

fn list_file(host: &mut Host, path: &Path) -> Result<(), (String, i32)> {
	let compressed = fs::metadata(path)
		.map(|meta| meta.len())
		.map_err(|error| (format!("xz: {}: {}", path.display(), error), 1))?;
	let mut uncompressed: u64 = 0;
	let mut reader = BufReader::new(File::open(path).map_err(|error| {
		(format!("xz: {}: {}", path.display(), error), 1)
	})?);
	let mut decoder = xz2::read::XzDecoder::new_multi_decoder(&mut reader);
	let mut buffer = [0u8; 64 * 1024];
	loop {
		let read = decoder
			.read(&mut buffer)
			.map_err(|error| (format!("xz: {}: {}", path.display(), error), 1))?;
		if read == 0 {
			break;
		}
		uncompressed += read as u64;
	}
	let ratio = if uncompressed == 0 {
		0.0
	} else {
		100.0 - (compressed as f64 * 100.0 / uncompressed as f64)
	};
	let mut out = BufWriter::new(host.stdout_clone());
	let _ = writeln!(
		out,
		"  {:>12} {:>13} {:>5.1}%  {}",
		compressed,
		uncompressed,
		ratio,
		path.display()
	);
	let _ = out.flush();
	Ok(())
}

fn compress_one(host: &mut Host, options: &Options, path: &Path) -> Result<(), (String, i32)> {
	let target = PathBuf::from(format!("{}{}", path.display(), options.suffix));
	if options.to_stdout {
		let mut out = BufWriter::new(host.stdout_clone());
		let mut reader = BufReader::new(File::open(path).map_err(|error| {
			(format!("xz: {}: {}", path.display(), error), 1)
		})?);
		return encode(&mut reader, &mut out, options.level, options.extreme, options.check);
	}
	if target.exists() && !options.force {
		return Err((
			format!("xz: {} already exists; not overwritten", target.display()),
			1,
		));
	}
	write_through(&target, path, |reader, writer| {
		encode(reader, writer, options.level, options.extreme, options.check)
	})?;
	if !options.keep {
		fs::remove_file(path)
			.map_err(|error| (format!("xz: {}: {}", path.display(), error), 1))?;
	}
	if options.verbose {
		report(host, path, &target);
	}
	Ok(())
}

fn expand_one(host: &mut Host, options: &Options, path: &Path) -> Result<(), (String, i32)> {
	let target = match stripped_path(path, &options.suffix) {
		Some(target) => target,
		None => {
			return Err((
				format!("xz: {}: unknown suffix -- ignored", path.display()),
				2,
			));
		},
	};
	if options.to_stdout {
		let mut out = BufWriter::new(host.stdout_clone());
		let mut reader = BufReader::new(File::open(path).map_err(|error| {
			(format!("xz: {}: {}", path.display(), error), 1)
		})?);
		return decode(&mut reader, &mut out);
	}
	if target.exists() && !options.force {
		return Err((
			format!("xz: {} already exists; not overwritten", target.display()),
			1,
		));
	}
	write_through(&target, path, decode)?;
	if !options.keep {
		fs::remove_file(path)
			.map_err(|error| (format!("xz: {}: {}", path.display(), error), 1))?;
	}
	if options.verbose {
		report(host, path, &target);
	}
	Ok(())
}

fn encode(
	reader: &mut dyn Read,
	writer: &mut dyn Write,
	level: u32,
	extreme: bool,
	check: Check,
) -> Result<(), (String, i32)> {
	let preset = if extreme { level | PRESET_EXTREME } else { level };
	let stream = Stream::new_easy_encoder(preset, check)
		.map_err(|error| (format!("xz: {error}"), 1))?;
	let mut encoder = xz2::write::XzEncoder::new_stream(writer, stream);
	io::copy(reader, &mut encoder).map_err(|error| (format!("xz: {error}"), 1))?;
	encoder.finish().map_err(|error| (format!("xz: {error}"), 1))?;
	Ok(())
}

fn decode(reader: &mut dyn Read, writer: &mut dyn Write) -> Result<(), (String, i32)> {
	let mut decoder = xz2::read::XzDecoder::new_multi_decoder(reader);
	io::copy(&mut decoder, writer).map_err(|error| (format!("xz: {error}"), 1))?;
	Ok(())
}

fn write_through(
	target: &Path,
	source: &Path,
	body: impl FnOnce(&mut dyn Read, &mut dyn Write) -> Result<(), (String, i32)>,
) -> Result<(), (String, i32)> {
	let mut temp = target.to_path_buf().into_os_string();
	temp.push(".part");
	let temp = PathBuf::from(temp);
	let mut reader = BufReader::new(File::open(source).map_err(|error| {
		(format!("xz: {}: {}", source.display(), error), 1)
	})?);
	let mut writer = BufWriter::new(File::create(&temp).map_err(|error| {
		(format!("xz: {}: {}", temp.display(), error), 1)
	})?);
	if let Err(error) = body(&mut reader, &mut writer) {
		let _ = fs::remove_file(&temp);
		return Err(error);
	}
	writer.flush().map_err(|error| (format!("xz: {error}"), 1))?;
	drop(writer);
	drop(reader);
	fs::rename(&temp, target).map_err(|error| {
		let _ = fs::remove_file(&temp);
		(format!("xz: {}: {}", target.display(), error), 1)
	})?;
	Ok(())
}

fn report(host: &mut Host, input: &Path, output: &Path) {
	let before = fs::metadata(input).map(|meta| meta.len()).unwrap_or(0);
	let after = fs::metadata(output).map(|meta| meta.len()).unwrap_or(0);
	let mut err = BufWriter::new(host.stderr_clone());
	let _ = writeln!(
		err,
		"{}:\t{} -> {} bytes ({})",
		input.display(),
		before,
		after,
		output.display()
	);
	let _ = err.flush();
}

fn stripped_path(path: &Path, suffix: &str) -> Option<PathBuf> {
	let text = path.to_string_lossy();
	if let Some(stripped) = text.strip_suffix(suffix) {
		return Some(PathBuf::from(stripped));
	}
	if text.ends_with(".txz") {
		return Some(PathBuf::from(format!("{}.tar", &text[..text.len() - 4])));
	}
	None
}

fn app() -> Command {
	Command::new("xz")
		.disable_help_flag(true)
		.disable_version_flag(true)
		.version("5.6.2")
		.about("Compress or decompress .xz files")
		.arg(Arg::new("help").short('h').long("help").action(ArgAction::SetTrue).help("display this help and exit"))
		.arg(Arg::new("version").short('V').long("version").action(ArgAction::SetTrue).help("output version information and exit"))
		.arg(Arg::new("decompress").short('d').long("decompress").action(ArgAction::SetTrue).help("decompress"))
		.arg(Arg::new("stdout").short('c').long("stdout").action(ArgAction::SetTrue).help("write to standard output"))
		.arg(Arg::new("force").short('f').long("force").action(ArgAction::SetTrue).help("overwrite output files"))
		.arg(Arg::new("keep").short('k').long("keep").action(ArgAction::SetTrue).help("keep input files"))
		.arg(Arg::new("quiet").short('q').long("quiet").action(ArgAction::SetTrue).help("suppress warnings"))
		.arg(Arg::new("verbose").short('v').long("verbose").action(ArgAction::SetTrue).help("verbose mode"))
		.arg(Arg::new("test").short('t').long("test").action(ArgAction::SetTrue).help("test compressed file integrity"))
		.arg(Arg::new("list").short('l').long("list").action(ArgAction::SetTrue).help("list information about .xz files"))
		.arg(Arg::new("extreme").short('e').long("extreme").action(ArgAction::SetTrue).help("use the extreme variant of the preset"))
		.arg(Arg::new("suffix").short('S').long("suffix").value_name("SUF").help("use suffix SUF on compressed files"))
		.arg(Arg::new("format").long("format").value_name("FMT").help("file format (only xz is implemented)"))
		.arg(Arg::new("check").long("check").value_name("TYPE").help("integrity check: none/crc32/crc64/sha256"))
		.arg(Arg::new("level").long("level").value_name("N").value_parser(clap::value_parser!(u32)).hide(true))
		.args(UNSUPPORTED.iter().map(|(id, long, short, takes_value, reason)| {
			let mut arg = Arg::new(*id).action(if *takes_value { ArgAction::Set } else { ArgAction::SetTrue }).hide(true).help(*reason);
			if *takes_value {
				arg = arg.num_args(1);
			}
			if let Some(long) = long {
				arg = arg.long(*long);
			}
			if let Some(short) = short {
				arg = arg.short(*short);
			}
			arg
		}))
		.arg(
			Arg::new("FILE")
				.num_args(0..)
				.value_name("FILE")
				.value_parser(clap::builder::ValueParser::os_string()),
		)
}

#[cfg(test)]
mod tests {
	use std::fs;

	use tempfile::{TempDir, tempdir};

	use crate::host::{run_script, run_util};

	use super::Xz;

	fn fixture() -> TempDir {
		let dir = tempdir().unwrap();
		fs::write(dir.path().join("data.txt"), b"hello xz\nhello xz\n").unwrap();
		dir
	}

	fn run(dir: &TempDir, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Xz>(args, "", dir.path());
		(code, capture.out(), capture.err())
	}

	#[test]
	fn compresses_and_expands_back_to_the_same_bytes() {
		let dir = fixture();
		let original = fs::read(dir.path().join("data.txt")).unwrap();

		let (code, _, err) = run(&dir, &["-q", "-k", "data.txt"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert!(dir.path().join("data.txt.xz").exists());
		assert!(dir.path().join("data.txt").exists());

		fs::remove_file(dir.path().join("data.txt")).unwrap();
		let (code, _, err) = run(&dir, &["-dqk", "data.txt.xz"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(fs::read(dir.path().join("data.txt")).unwrap(), original);
		assert!(dir.path().join("data.txt.xz").exists());
	}

	#[test]
	fn deletes_the_source_unless_keep_is_given() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-q", "data.txt"]).0, 0);
		assert!(!dir.path().join("data.txt").exists());
		assert!(dir.path().join("data.txt.xz").exists());
	}

	#[test]
	fn refuses_to_overwrite_without_force() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-q", "-k", "data.txt"]).0, 0);
		let (code, _, err) = run(&dir, &["-k", "data.txt"]);
		assert_eq!(code, 1);
		assert!(err.contains("already exists"), "{err}");
		assert_eq!(run(&dir, &["-q", "-kf", "data.txt"]).0, 0);
	}

	#[test]
	fn test_mode_accepts_valid_files_and_rejects_corrupt_ones() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-qk", "data.txt"]).0, 0);
		assert_eq!(run(&dir, &["-t", "data.txt.xz"]).0, 0);

		fs::write(dir.path().join("broken.xz"), b"not an xz stream").unwrap();
		let (code, _, err) = run(&dir, &["-t", "broken.xz"]);
		assert_ne!(code, 0);
		assert!(!err.is_empty());
	}

	#[test]
	fn list_reports_the_uncompressed_size() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-qk", "data.txt"]).0, 0);
		let (code, out, err) = run(&dir, &["-l", "data.txt.xz"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert!(out.contains("18"), "{out}");
		assert!(out.contains("data.txt.xz"), "{out}");
	}

	#[test]
	fn numeric_levels_and_extreme_are_parsed() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-q", "-k", "-0", "data.txt"]).0, 0);
		fs::remove_file(dir.path().join("data.txt.xz")).unwrap();
		assert_eq!(run(&dir, &["-q", "-k", "-9e", "data.txt"]).0, 0);
		let (code, _, err) = run(&dir, &["-k", "-10", "data.txt"]);
		assert_ne!(code, 0);
		assert!(err.contains("out of range"), "{err}");
	}

	#[test]
	fn unsupported_options_explain_themselves() {
		let dir = fixture();
		for args in [&["-T4", "data.txt"][..], &["--format=lzma", "data.txt"][..]] {
			let (code, _, err) = run(&dir, args);
			assert_eq!(code, 1, "{args:?} must fail");
			assert!(err.starts_with("xz: "), "{args:?}: {err}");
		}
	}

	#[tokio::test]
	async fn invocation_names_switch_to_decompression() {
		let dir = tempdir().unwrap();
		let (code, out, err) = run_script("printf 'xz-name-ok\\n' | xz -q | xzcat", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "xz-name-ok\n");
	}
}
