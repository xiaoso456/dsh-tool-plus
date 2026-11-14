//! zstd builtin: compress or expand Zstandard streams.
//!
//! Windows does not ship zstd, and .tar.zst is now a common distribution
//! format, so the shell needs it in-process. Reached as zstd / unzstd /
//! zstdcat, mirroring GNU zstd's invocation names.
//!
//! Supported surface (see docs/shell-commands/zstd.md):
//!   -d -c -f -k -q -v -1..-19 --fast[=N] -o -t -l --rm -h -V
//!
//! Deliberately unsupported, reported instead of silently ignored:
//!   -D/--patch-from (dictionaries), -T (threads), --long, --ultra,
//!   --train, --format (gzip/xz/lzma outputs).

use std::{
	fs::{self, File},
	io::{self, BufReader, BufWriter, Read, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};

use crate::host::{Host, Utility, matches_parser, util};

const DEFAULT_SUFFIX: &str = ".zst";
/// Options GNU zstd accepts that this builtin deliberately does not implement.
const UNSUPPORTED: &[(&str, Option<&str>, Option<char>, bool, &str)] = &[
	("dict", None, Some('D'), true, "dictionary files are not implemented"),
	("threads", None, Some('T'), true, "multi-threaded compression is not implemented"),
	("long", Some("long"), None, false, "--long mode is not implemented"),
	("ultra", Some("ultra"), None, false, "--ultra levels are not implemented"),
	("train", Some("train"), None, false, "dictionary training is not implemented"),
	("patch-from", Some("patch-from"), None, true, "patch-from is not implemented"),
	("format", Some("format"), None, true, "only native zstd frames are produced"),
];

/// Compress or expand files, also reachable as unzstd and zstdcat.
pub(crate) struct Zstd {
	matches: ArgMatches,
}

matches_parser!(Zstd, app);

impl Utility for Zstd {
	const NAME: &'static str = "zstd";

	/// zstd spells levels as numeric flags (-3, -19). clap only takes one short
	/// per flag, so numeric tokens are rewritten into `--level=N` before parsing.
	fn rewrite_argv(argv: Vec<std::ffi::OsString>) -> Result<Vec<std::ffi::OsString>, String> {
		let mut out = Vec::with_capacity(argv.len());
		let mut level: Option<u32> = None;
		for arg in argv {
			let text = arg.to_string_lossy();
			if let Some(rest) = text.strip_prefix('-')
				&& !rest.is_empty()
				&& rest.chars().all(|character| character.is_ascii_digit())
			{
				let parsed: u32 = rest
					.parse()
					.map_err(|_| format!("invalid compression level '{text}'"))?;
				if !(1..=19).contains(&parsed) {
					return Err(format!("compression level out of range: {text}"));
				}
				level = Some(level.map_or(parsed, |current| current.max(parsed)));
				continue;
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
			let _ = writeln!(out, "zstd 1.5.7 (pi-builtins)");
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

pub(crate) fn zstd_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Zstd, SE>()
}

struct Options {
	decompress: bool,
	to_stdout: bool,
	force: bool,
	quiet: bool,
	verbose: bool,
	test: bool,
	list: bool,
	remove_source: bool,
	level: i32,
	suffix: String,
	output: Option<PathBuf>,
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
				return Err((format!("zstd: {spelling} {reason}"), 1));
			}
		}

		let invoked = host.name();
		let mut decompress = matches.get_flag("decompress");
		let mut to_stdout = matches.get_flag("stdout");
		if invoked == "unzstd" {
			decompress = true;
		} else if invoked == "zstdcat" {
			decompress = true;
			to_stdout = true;
		}

		let mut level = matches
			.get_one::<u32>("level")
			.map(|level| *level as i32)
			.unwrap_or(3);
		if let Some(fast) = matches.get_one::<String>("fast") {
			let steps: i32 = fast.parse().map_err(|_| {
				(format!("zstd: --fast: invalid value '{fast}'"), 1)
			})?;
			level = -steps.max(1);
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

		let output = matches.get_one::<std::ffi::OsString>("output").map(|value| {
			let path = PathBuf::from(value);
			if path.is_relative() {
				host.cwd().join(path)
			} else {
				path
			}
		});

		Ok(Self {
			decompress,
			to_stdout,
			force: matches.get_flag("force"),
			quiet: matches.get_flag("quiet"),
			verbose: matches.get_flag("verbose"),
			test: matches.get_flag("test"),
			list: matches.get_flag("list"),
			remove_source: matches.get_flag("rm"),
			level,
			suffix: matches
				.get_one::<String>("suffix")
				.cloned()
				.unwrap_or_else(|| DEFAULT_SUFFIX.to_string()),
			output,
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
			list_file(host, options, path)
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
	let result = if options.decompress {
		let mut reader = BufReader::new(&mut host.stdin);
		decode(&mut reader, &mut out)
	} else {
		let mut reader = BufReader::new(&mut host.stdin);
		encode(&mut reader, &mut out, options.level)
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
		(format!("zstd: {}: {}", path.display(), error), 1)
	})?);
	let mut decoder = zstd::stream::read::Decoder::new(&mut reader)
		.map_err(|error| (format!("zstd: {}: {}", path.display(), error), 1))?;
	io::copy(&mut decoder, &mut io::sink())
		.map_err(|error| (format!("zstd: {}: {}", path.display(), error), 1))?;
	Ok(())
}

fn list_file(host: &mut Host, options: &Options, path: &Path) -> Result<(), (String, i32)> {
	let compressed = fs::metadata(path)
		.map(|meta| meta.len())
		.map_err(|error| (format!("zstd: {}: {}", path.display(), error), 1))?;
	let mut uncompressed: u64 = 0;
	let mut reader = BufReader::new(File::open(path).map_err(|error| {
		(format!("zstd: {}: {}", path.display(), error), 1)
	})?);
	let mut decoder = zstd::stream::read::Decoder::new(&mut reader)
		.map_err(|error| (format!("zstd: {}: {}", path.display(), error), 1))?;
	let mut buffer = [0u8; 64 * 1024];
	loop {
		let read = decoder
			.read(&mut buffer)
			.map_err(|error| (format!("zstd: {}: {}", path.display(), error), 1))?;
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
	let _ = options;
	Ok(())
}

fn compress_one(host: &mut Host, options: &Options, path: &Path) -> Result<(), (String, i32)> {
	let target = if let Some(output) = &options.output {
		output.clone()
	} else {
		PathBuf::from(format!("{}{}", path.display(), options.suffix))
	};
	if options.to_stdout {
		let mut out = BufWriter::new(host.stdout_clone());
		let mut reader = BufReader::new(File::open(path).map_err(|error| {
			(format!("zstd: {}: {}", path.display(), error), 1)
		})?);
		return encode(&mut reader, &mut out, options.level);
	}
	if target.exists() && !options.force {
		return Err((
			format!("zstd: {} already exists; not overwritten", target.display()),
			1,
		));
	}
	write_through(&target, path, |reader, writer| encode(reader, writer, options.level))?;
	if options.remove_source {
		fs::remove_file(path)
			.map_err(|error| (format!("zstd: {}: {}", path.display(), error), 1))?;
	}
	if options.verbose {
		report(host, path, &target);
	}
	Ok(())
}

fn expand_one(host: &mut Host, options: &Options, path: &Path) -> Result<(), (String, i32)> {
	let target = if let Some(output) = &options.output {
		output.clone()
	} else {
		match stripped_path(path, &options.suffix) {
			Some(target) => target,
			None => {
				return Err((
					format!("zstd: {}: unknown suffix -- ignored", path.display()),
					2,
				));
			},
		}
	};
	if options.to_stdout {
		let mut out = BufWriter::new(host.stdout_clone());
		let mut reader = BufReader::new(File::open(path).map_err(|error| {
			(format!("zstd: {}: {}", path.display(), error), 1)
		})?);
		return decode(&mut reader, &mut out);
	}
	if target.exists() && !options.force {
		return Err((
			format!("zstd: {} already exists; not overwritten", target.display()),
			1,
		));
	}
	write_through(&target, path, decode)?;
	if options.remove_source {
		fs::remove_file(path)
			.map_err(|error| (format!("zstd: {}: {}", path.display(), error), 1))?;
	}
	if options.verbose {
		report(host, path, &target);
	}
	Ok(())
}

fn encode(
	reader: &mut dyn Read,
	writer: &mut dyn Write,
	level: i32,
) -> Result<(), (String, i32)> {
	let mut encoder = zstd::stream::write::Encoder::new(writer, level)
		.map_err(|error| (format!("zstd: {error}"), 1))?;
	io::copy(reader, &mut encoder).map_err(|error| (format!("zstd: {error}"), 1))?;
	encoder.finish().map_err(|error| (format!("zstd: {error}"), 1))?;
	Ok(())
}

fn decode(reader: &mut dyn Read, writer: &mut dyn Write) -> Result<(), (String, i32)> {
	let mut decoder = zstd::stream::read::Decoder::new(reader)
		.map_err(|error| (format!("zstd: {error}"), 1))?;
	io::copy(&mut decoder, writer).map_err(|error| (format!("zstd: {error}"), 1))?;
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
		(format!("zstd: {}: {}", source.display(), error), 1)
	})?);
	let mut writer = BufWriter::new(File::create(&temp).map_err(|error| {
		(format!("zstd: {}: {}", temp.display(), error), 1)
	})?);
	if let Err(error) = body(&mut reader, &mut writer) {
		let _ = fs::remove_file(&temp);
		return Err(error);
	}
	writer.flush().map_err(|error| (format!("zstd: {error}"), 1))?;
	drop(writer);
	drop(reader);
	fs::rename(&temp, target).map_err(|error| {
		let _ = fs::remove_file(&temp);
		(format!("zstd: {}: {}", target.display(), error), 1)
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
	if text.ends_with(".tzst") {
		return Some(PathBuf::from(format!("{}.tar", &text[..text.len() - 5])));
	}
	None
}

fn app() -> Command {
	Command::new("zstd")
		.disable_help_flag(true)
		.disable_version_flag(true)
		.version("1.5.7")
		.about("Compress or expand Zstandard files")
		.arg(Arg::new("help").short('h').long("help").action(ArgAction::SetTrue).help("display this help and exit"))
		.arg(Arg::new("version").short('V').long("version").action(ArgAction::SetTrue).help("output version information and exit"))
		.arg(Arg::new("decompress").short('d').long("decompress").action(ArgAction::SetTrue).help("decompress"))
		.arg(Arg::new("stdout").short('c').long("stdout").action(ArgAction::SetTrue).help("write to standard output"))
		.arg(Arg::new("force").short('f').long("force").action(ArgAction::SetTrue).help("overwrite output files"))
		.arg(Arg::new("quiet").short('q').long("quiet").action(ArgAction::SetTrue).help("suppress warnings"))
		.arg(Arg::new("verbose").short('v').long("verbose").action(ArgAction::SetTrue).help("verbose mode"))
		.arg(Arg::new("test").short('t').long("test").action(ArgAction::SetTrue).help("test compressed file integrity"))
		.arg(Arg::new("list").short('l').long("list").action(ArgAction::SetTrue).help("list information about .zst files"))
		.arg(Arg::new("rm").long("rm").action(ArgAction::SetTrue).help("remove source file(s) after successful operation"))
		.arg(Arg::new("suffix").short('S').long("suffix").value_name("SUF").help("use suffix SUF on compressed files"))
		.arg(Arg::new("output").short('o').long("output").value_name("FILE").value_parser(clap::builder::ValueParser::os_string()).help("write output to FILE"))
		.arg(Arg::new("fast").long("fast").value_name("N").num_args(0..=1).default_missing_value("1").help("use fast compression levels"))
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

	use super::Zstd;

	fn fixture() -> TempDir {
		let dir = tempdir().unwrap();
		fs::write(dir.path().join("data.txt"), b"hello zstd\nhello zstd\n").unwrap();
		dir
	}

	fn run(dir: &TempDir, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Zstd>(args, "", dir.path());
		(code, capture.out(), capture.err())
	}

	#[test]
	fn compresses_and_expands_back_to_the_same_bytes() {
		let dir = fixture();
		let original = fs::read(dir.path().join("data.txt")).unwrap();

		let (code, _, err) = run(&dir, &["-q", "data.txt"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert!(dir.path().join("data.txt.zst").exists());
		// zstd keeps the source unless --rm is given.
		assert!(dir.path().join("data.txt").exists());

		fs::remove_file(dir.path().join("data.txt")).unwrap();
		let (code, _, err) = run(&dir, &["-dq", "data.txt.zst"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(fs::read(dir.path().join("data.txt")).unwrap(), original);
		assert!(dir.path().join("data.txt.zst").exists());
	}

	#[test]
	fn remove_source_flag_deletes_the_input() {
		let dir = fixture();
		let (code, _, err) = run(&dir, &["-q", "--rm", "data.txt"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert!(!dir.path().join("data.txt").exists());
		assert!(dir.path().join("data.txt.zst").exists());
	}

	#[test]
	fn refuses_to_overwrite_without_force() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-q", "data.txt"]).0, 0);
		let (code, _, err) = run(&dir, &["data.txt"]);
		assert_eq!(code, 1);
		assert!(err.contains("already exists"), "{err}");
		assert_eq!(run(&dir, &["-q", "-f", "data.txt"]).0, 0);
	}

	#[test]
	fn output_flag_writes_to_the_named_file() {
		let dir = fixture();
		let (code, _, err) = run(&dir, &["-q", "-o", "out.zst", "data.txt"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert!(dir.path().join("out.zst").exists());
		assert!(!dir.path().join("data.txt.zst").exists());
	}

	#[test]
	fn test_mode_accepts_valid_files_and_rejects_corrupt_ones() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-q", "data.txt"]).0, 0);
		assert_eq!(run(&dir, &["-t", "data.txt.zst"]).0, 0);

		fs::write(dir.path().join("broken.zst"), b"not a zstd frame").unwrap();
		let (code, _, err) = run(&dir, &["-t", "broken.zst"]);
		assert_ne!(code, 0);
		assert!(!err.is_empty());
	}

	#[test]
	fn list_reports_the_uncompressed_size() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-q", "data.txt"]).0, 0);
		let (code, out, err) = run(&dir, &["-l", "data.txt.zst"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert!(out.contains("22"), "{out}");
		assert!(out.contains("data.txt.zst"), "{out}");
	}

	#[test]
	fn numeric_levels_are_parsed_and_range_checked() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-q", "-19", "data.txt"]).0, 0);
		fs::remove_file(dir.path().join("data.txt.zst")).unwrap();
		assert_eq!(run(&dir, &["-q", "-3", "data.txt"]).0, 0);
		let (code, _, err) = run(&dir, &["-99", "data.txt"]);
		assert_ne!(code, 0);
		assert!(err.contains("out of range"), "{err}");
	}

	#[test]
	fn unsupported_options_explain_themselves() {
		let dir = fixture();
		for args in [&["-D", "dict", "data.txt"][..], &["-T2", "data.txt"][..], &["--long", "data.txt"][..]] {
			let (code, _, err) = run(&dir, args);
			assert_eq!(code, 1, "{args:?} must fail");
			assert!(err.starts_with("zstd: "), "{args:?}: {err}");
		}
	}

	#[tokio::test]
	async fn invocation_names_switch_to_decompression() {
		let dir = tempdir().unwrap();
		let (code, out, err) = run_script("printf 'zstd-name-ok\\n' | zstd -q | zstdcat", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "zstd-name-ok\n");
	}
}
