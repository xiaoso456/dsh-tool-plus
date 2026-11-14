//! gzip builtin: compress or expand files with the DEFLATE algorithm.
//!
//! Not part of upstream pi-builtins. On Windows the shell otherwise reaches
//! Git's gzip.exe (and gunzip is an extensionless script the shell cannot run
//! at all), so this module provides the whole trio: gzip, gunzip, zcat.
//!
//! Supported surface (see docs/shell-commands/gzip.md):
//!   -c -d -f -k -l -n -q -r -S -t -v -1..-9 --fast --best
//!
//! Deliberately unsupported, reported instead of silently ignored:
//!   -a/--ascii (line-ending conversion is a no-op here), --rsyncable,
//!   --synchronous (we always flush on close).

use std::{
	fs::{self, File},
	io::{self, BufReader, BufWriter, Read, Write},
	path::{Path, PathBuf},
	time::UNIX_EPOCH,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use flate2::{Compression, read::GzDecoder};

use crate::host::{Host, Utility, matches_parser, util};

/// Options GNU gzip accepts that this builtin deliberately does not implement.
/// Declaring them keeps the failure readable instead of "unexpected argument".
const UNSUPPORTED: &[(&str, Option<&str>, Option<char>, &str)] = &[
	("ascii", None, Some('a'), "line-ending conversion is a no-op on this platform"),
	("license", Some("license"), Some('L'), "the license text is not shipped with the builtin"),
	("rsyncable", Some("rsyncable"), None, "rsync-friendly block boundaries are not implemented"),
	("synchronous", Some("synchronous"), None, "output is flushed on close; no separate sync strategy"),
];

const DEFAULT_SUFFIX: &str = ".gz";
const DEFAULT_LEVEL: u32 = 6;
const LEVEL_IDS: [&str; 9] = [
	"level1", "level2", "level3", "level4", "level5", "level6", "level7", "level8", "level9",
];

/// Compress or expand files, also reachable as gunzip and zcat.
pub(crate) struct Gzip {
	matches: ArgMatches,
}

matches_parser!(Gzip, app);

impl Utility for Gzip {
	const NAME: &'static str = "gzip";

	fn run(self, host: &mut Host) -> i32 {
		if self.matches.get_flag("version") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = writeln!(out, "gzip 1.14 (pi-builtins)");
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

pub(crate) fn gzip_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Gzip, SE>()
}

/// One invocation, resolved from the clap matches plus the invoked name.
struct Options {
	decompress: bool,
	to_stdout: bool,
	force: bool,
	keep: bool,
	list: bool,
	test: bool,
	quiet: bool,
	verbose: bool,
	no_name: bool,
	level: u32,
	suffix: String,
	files: Vec<PathBuf>,
}

impl Options {
	fn from_matches(matches: &ArgMatches, host: &Host) -> Result<Self, (String, i32)> {
		for (id, long, short, reason) in UNSUPPORTED {
			let enabled = matches.get_flag(id)
				|| long.and_then(|name| matches.try_get_one::<bool>(name).ok().flatten().copied()).unwrap_or(false);
			if enabled {
				let spelling = match (long, short) {
					(Some(long), _) => format!("--{long}"),
					(None, Some(short)) => format!("-{short}"),
					_ => id.to_string(),
				};
				return Err((format!("gzip: {spelling} {reason}"), 1));
			}
		}

		let invoked = host.name();
		let mut decompress = matches.get_flag("decompress");
		let mut to_stdout = matches.get_flag("stdout");
		if invoked == "gunzip" {
			decompress = true;
		} else if invoked == "zcat" {
			decompress = true;
			to_stdout = true;
		}

		let level = LEVEL_IDS
			.iter()
			.enumerate()
			.filter(|(_, id)| matches.get_flag(id))
			.map(|(index, _)| index as u32 + 1)
			.max()
			.unwrap_or(if matches.get_flag("fast") {
				1
			} else if matches.get_flag("best") {
				9
			} else {
				DEFAULT_LEVEL
			});

		let mut files: Vec<PathBuf> = matches
			.get_many::<std::ffi::OsString>("FILE")
			.map(|values| values.map(PathBuf::from).collect())
			.unwrap_or_default();

		// Operands are relative to the shell working directory, not the process one.
		for file in &mut files {
			if file != Path::new("-") && file.is_relative() {
				*file = host.cwd().join(&*file);
			}
		}

		if matches.get_flag("recursive") && !files.is_empty() {
			let mut expanded = Vec::new();
			for path in files {
				collect_paths(&mut expanded, &path, !decompress)
					.map_err(|error| (format!("gzip: {}: {}", path.display(), error), 1))?;
			}
			files = expanded;
		}

		Ok(Self {
			decompress,
			to_stdout,
			force: matches.get_flag("force"),
			keep: matches.get_flag("keep"),
			list: matches.get_flag("list"),
			test: matches.get_flag("test"),
			quiet: matches.get_flag("quiet"),
			verbose: matches.get_flag("verbose"),
			no_name: matches.get_flag("no-name"),
			level,
			suffix: matches
				.get_one::<String>("suffix")
				.cloned()
				.unwrap_or_else(|| DEFAULT_SUFFIX.to_string()),
			files,
		})
	}
}

fn collect_paths(into: &mut Vec<PathBuf>, path: &Path, compress: bool) -> io::Result<()> {
	let metadata = fs::symlink_metadata(path)?;
	if metadata.is_dir() {
		for entry in fs::read_dir(path)? {
			collect_paths(into, &entry?.path(), compress)?;
		}
		return Ok(());
	}
	let name = path.to_string_lossy();
	let looks_compressed = name.ends_with(".gz") || name.ends_with(".tgz");
	if compress != looks_compressed {
		into.push(path.to_path_buf());
	}
	Ok(())
}

/// Compress or expand every operand, returning the process exit status.
fn run_with(host: &mut Host, options: &Options) -> i32 {
	if options.list {
		return list_files(host, options);
	}

	let files: Vec<PathBuf> = if options.files.is_empty() {
		vec![PathBuf::from("-")]
	} else {
		options.files.clone()
	};

	let mut status = 0;
	for path in files {
		let result = if options.test {
			test_file(&path)
		} else if options.decompress {
			expand_one(host, options, &path)
		} else {
			compress_one(host, options, &path)
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

fn test_file(path: &Path) -> Result<(), (String, i32)> {
	let mut reader: Box<dyn Read> = if path == Path::new("-") {
		Box::new(io::empty())
	} else {
		Box::new(BufReader::new(File::open(path).map_err(|error| {
			(format!("gzip: {}: {}", path.display(), error), 1)
		})?))
	};
	let mut decoder = GzDecoder::new(&mut reader);
	let mut sink = io::sink();
	io::copy(&mut decoder, &mut sink)
		.map_err(|error| (format!("gzip: {}: {}", path.display(), error), 1))?;
	Ok(())
}

fn list_files(host: &mut Host, options: &Options) -> i32 {
	let mut out = BufWriter::new(host.stdout_clone());
	let mut status = 0;
	let mut printed_header = false;
	for path in &options.files {
		let data = match fs::read(path) {
			Ok(data) => data,
			Err(error) => {
				if !options.quiet {
					let mut err = BufWriter::new(host.stderr_clone());
					let _ = writeln!(err, "gzip: {}: {}", path.display(), error);
					let _ = err.flush();
				}
				status = 1;
				continue;
			},
		};
		let uncompressed = match uncompressed_size(&data) {
			Some(size) => size,
			None => {
				if !options.quiet {
					let mut err = BufWriter::new(host.stderr_clone());
					let _ = writeln!(err, "gzip: {}: not in gzip format", path.display());
					let _ = err.flush();
				}
				status = 1;
				continue;
			},
		};
		if !printed_header {
			let _ = writeln!(out, "  compressed   uncompressed  ratio  uncompressed_name");
			printed_header = true;
		}
		let compressed = data.len() as u64;
		let ratio = if uncompressed == 0 {
			0.0
		} else {
			100.0 - (compressed as f64 * 100.0 / uncompressed as f64)
		};
		let shown = path
			.file_name()
			.map(|name| name.to_string_lossy().into_owned())
			.unwrap_or_else(|| path.display().to_string());
		let _ = writeln!(
			out,
			"  {:>12} {:>13} {:>5.1}%  {}",
			compressed, uncompressed, ratio, shown
		);
	}
	let _ = out.flush();
	status
}

fn uncompressed_size(data: &[u8]) -> Option<u64> {
	let mut decoder = GzDecoder::new(data);
	let mut total = 0u64;
	let mut buffer = [0u8; 64 * 1024];
	loop {
		match decoder.read(&mut buffer) {
			Ok(0) => return Some(total),
			Ok(read) => total += read as u64,
			Err(_) => return None,
		}
	}
}

fn compress_one(host: &mut Host, options: &Options, path: &Path) -> Result<(), (String, i32)> {
	let stdin = path == Path::new("-");
	// Reading stdin implies writing stdout, exactly like GNU gzip.
	if options.to_stdout || stdin {
		let mut out = BufWriter::new(host.stdout_clone());
		return if stdin {
			let mut reader = BufReader::new(&mut host.stdin);
			encode(&mut reader, &mut out, options, None)
		} else {
			let mut reader = BufReader::new(File::open(path).map_err(|error| {
				(format!("gzip: {}: {}", path.display(), error), 1)
			})?);
			encode(&mut reader, &mut out, options, Some(path))
		};
	}
	if stdin {
		return Err((
			"gzip: compressed data not written to a terminal; use -c to write to stdout".to_string(),
			1,
		));
	}
	let target = PathBuf::from(format!("{}{}", path.display(), options.suffix));
	if target.exists() && !options.force {
		return Err((
			format!("gzip: {} already exists; not overwritten", target.display()),
			1,
		));
	}
	write_through(&target, path, |reader, writer| {
		encode(reader, writer, options, Some(path))
	})?;
	finish_input(options, path)?;
	report(host, options, path, &target)
}

fn expand_one(host: &mut Host, options: &Options, path: &Path) -> Result<(), (String, i32)> {
	let stdin = path == Path::new("-");
	// Reading stdin implies writing stdout, exactly like GNU gzip.
	if options.to_stdout || stdin {
		let mut out = BufWriter::new(host.stdout_clone());
		return if stdin {
			let mut reader = BufReader::new(&mut host.stdin);
			decode(&mut reader, &mut out)
		} else {
			let mut reader = BufReader::new(File::open(path).map_err(|error| {
				(format!("gzip: {}: {}", path.display(), error), 1)
			})?);
			decode(&mut reader, &mut out)
		};
	}
	if stdin {
		return Err((
			"gzip: compressed data not read from a terminal; use -c to write to stdout".to_string(),
			1,
		));
	}
	let Some(target) = stripped_path(path, &options.suffix) else {
		return Err((
			format!("gzip: {}: unknown suffix -- ignored", path.display()),
			2,
		));
	};
	if target.exists() && !options.force {
		return Err((
			format!("gzip: {} already exists; not overwritten", target.display()),
			1,
		));
	}
	write_through(&target, path, |reader, writer| decode(reader, writer))?;
	finish_input(options, path)?;
	report(host, options, path, &target)
}

fn encode(
	reader: &mut dyn Read,
	writer: &mut dyn Write,
	options: &Options,
	path: Option<&Path>,
) -> Result<(), (String, i32)> {
	let mut builder = flate2::GzBuilder::new();
	if !options.no_name {
		if let Some(path) = path {
			if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
				builder = builder.filename(name);
			}
			if let Ok(metadata) = fs::metadata(path) {
				if let Ok(modified) = metadata.modified() {
					if let Ok(elapsed) = modified.duration_since(UNIX_EPOCH) {
						builder = builder.mtime(elapsed.as_secs() as u32);
					}
				}
			}
		}
	}
	let label = path
		.map(|path| path.display().to_string())
		.unwrap_or_else(|| "-".to_string());
	let mut encoder = builder.write(writer, Compression::new(options.level));
	io::copy(reader, &mut encoder).map_err(|error| (format!("gzip: {label}: {error}"), 1))?;
	encoder
		.finish()
		.map_err(|error| (format!("gzip: {label}: {error}"), 1))?;
	Ok(())
}

fn decode(reader: &mut dyn Read, writer: &mut dyn Write) -> Result<(), (String, i32)> {
	let mut decoder = GzDecoder::new(reader);
	io::copy(&mut decoder, writer).map_err(|error| (format!("gzip: {error}"), 1))?;
	Ok(())
}

/// Write the result to a temporary file and only then rename it over target.
fn write_through(
	target: &Path,
	source: &Path,
	body: impl FnOnce(&mut dyn Read, &mut dyn Write) -> Result<(), (String, i32)>,
) -> Result<(), (String, i32)> {
	let mut temp = target.to_path_buf().into_os_string();
	temp.push(".part");
	let temp = PathBuf::from(temp);
	let mut reader = BufReader::new(File::open(source).map_err(|error| {
		(format!("gzip: {}: {}", source.display(), error), 1)
	})?);
	let mut writer = BufWriter::new(File::create(&temp).map_err(|error| {
		(format!("gzip: {}: {}", temp.display(), error), 1)
	})?);
	if let Err(error) = body(&mut reader, &mut writer) {
		let _ = fs::remove_file(&temp);
		return Err(error);
	}
	writer.flush().map_err(|error| (format!("gzip: {error}"), 1))?;
	drop(writer);
	drop(reader);
	fs::rename(&temp, target).map_err(|error| {
		let _ = fs::remove_file(&temp);
		(format!("gzip: {}: {}", target.display(), error), 1)
	})?;
	Ok(())
}

fn report(
	host: &mut Host,
	options: &Options,
	input: &Path,
	output: &Path,
) -> Result<(), (String, i32)> {
	if !options.verbose {
		return Ok(());
	}
	let before = fs::metadata(input).map(|meta| meta.len()).unwrap_or(0);
	let after = fs::metadata(output).map(|meta| meta.len()).unwrap_or(0);
	let ratio = if before == 0 {
		0.0
	} else {
		100.0 - (after as f64 * 100.0 / before as f64)
	};
	let mut err = BufWriter::new(host.stderr_clone());
	let _ = writeln!(
		err,
		"{}:\t{:.1}% -- replaced with {}",
		input.display(),
		ratio,
		output.display()
	);
	let _ = err.flush();
	Ok(())
}

fn finish_input(options: &Options, input: &Path) -> Result<(), (String, i32)> {
	if options.keep {
		return Ok(());
	}
	fs::remove_file(input).map_err(|error| (format!("gzip: {}: {}", input.display(), error), 1))?;
	Ok(())
}

fn stripped_path(path: &Path, suffix: &str) -> Option<PathBuf> {
	let text = path.to_string_lossy();
	if let Some(stripped) = text.strip_suffix(suffix) {
		return Some(PathBuf::from(stripped));
	}
	if text.ends_with(".tgz") {
		return Some(PathBuf::from(format!("{}.tar", &text[..text.len() - 4])));
	}
	None
}

fn app() -> Command {
	Command::new("gzip")
		.disable_help_flag(true)
		.disable_version_flag(true)
		.version("1.14")
		.about("Compress or expand files")
		.arg(Arg::new("help").short('h').long("help").action(ArgAction::SetTrue).help("give this help"))
		.args(UNSUPPORTED.iter().map(|(id, long, short, reason)| {
			let mut arg = Arg::new(*id).action(ArgAction::SetTrue).hide(true).help(*reason);
			if let Some(long) = long {
				arg = arg.long(*long);
			}
			if let Some(short) = short {
				arg = arg.short(*short);
			}
			arg
		}))
		.arg(Arg::new("stdout").short('c').long("stdout").action(ArgAction::SetTrue).help("write on standard output, keep original files unchanged"))
		.arg(Arg::new("decompress").short('d').long("decompress").action(ArgAction::SetTrue).help("decompress"))
		.arg(Arg::new("force").short('f').long("force").action(ArgAction::SetTrue).help("force overwrite of output file"))
		.arg(Arg::new("keep").short('k').long("keep").action(ArgAction::SetTrue).help("keep (don't delete) input files"))
		.arg(Arg::new("list").short('l').long("list").action(ArgAction::SetTrue).help("list compressed file contents"))
		.arg(Arg::new("no-name").short('n').long("no-name").action(ArgAction::SetTrue).help("do not save the original name and timestamp"))
		.arg(Arg::new("quiet").short('q').long("quiet").action(ArgAction::SetTrue).help("suppress all warnings"))
		.arg(Arg::new("recursive").short('r').long("recursive").action(ArgAction::SetTrue).help("operate recursively on directories"))
		.arg(Arg::new("suffix").short('S').long("suffix").value_name("SUF").help("use suffix SUF on compressed files"))
		.arg(Arg::new("test").short('t').long("test").action(ArgAction::SetTrue).help("test compressed file integrity"))
		.arg(Arg::new("verbose").short('v').long("verbose").action(ArgAction::SetTrue).help("verbose mode"))
		.arg(Arg::new("version").short('V').long("version").action(ArgAction::SetTrue).help("display version number"))
		.arg(Arg::new("fast").long("fast").action(ArgAction::SetTrue).help("compress faster"))
		.arg(Arg::new("best").long("best").action(ArgAction::SetTrue).help("compress better"))
		.args(LEVEL_IDS.iter().enumerate().map(|(index, id)| {
			let level = index as u32 + 1;
			Arg::new(*id)
				.short(char::from_digit(level, 10).unwrap())
				.action(ArgAction::SetTrue)
				.hide(true)
				.help(format!("compression level {level}"))
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

	use crate::host::run_util;

	use super::Gzip;

	fn fixture() -> TempDir {
		let dir = tempdir().unwrap();
		fs::write(dir.path().join("hello.txt"), b"hello world\nhello world\n").unwrap();
		dir
	}

	fn run(dir: &TempDir, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Gzip>(args, "", dir.path());
		(code, capture.out(), capture.err())
	}

	#[test]
	fn compresses_then_expands_back_to_the_same_bytes() {
		let dir = fixture();
		let original = fs::read(dir.path().join("hello.txt")).unwrap();

		let (code, _, err) = run(&dir, &["hello.txt"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert!(dir.path().join("hello.txt.gz").exists());
		assert!(!dir.path().join("hello.txt").exists());

		let (code, _, err) = run(&dir, &["-d", "hello.txt.gz"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert!(!dir.path().join("hello.txt.gz").exists());
		assert_eq!(fs::read(dir.path().join("hello.txt")).unwrap(), original);
	}

	#[test]
	fn keep_retains_the_input_file() {
		let dir = fixture();
		let (code, _, err) = run(&dir, &["-k", "hello.txt"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert!(dir.path().join("hello.txt").exists());
		assert!(dir.path().join("hello.txt.gz").exists());
	}

	#[test]
	fn refuses_to_overwrite_without_force() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-k", "hello.txt"]).0, 0);
		let (code, _, err) = run(&dir, &["-k", "hello.txt"]);
		assert_eq!(code, 1);
		assert!(err.contains("already exists"), "{err}");
	}

	#[test]
	fn list_reports_the_uncompressed_size() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-k", "hello.txt"]).0, 0);
		let (code, out, err) = run(&dir, &["-l", "hello.txt.gz"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert!(out.contains("uncompressed"), "{out}");
		assert!(out.contains("hello.txt.gz"), "{out}");
		assert!(out.contains("24"), "{out}");
	}

	#[test]
	fn test_mode_accepts_valid_archives_and_rejects_corrupt_ones() {
		let dir = fixture();
		assert_eq!(run(&dir, &["-k", "hello.txt"]).0, 0);
		assert_eq!(run(&dir, &["-t", "hello.txt.gz"]).0, 0);

		fs::write(dir.path().join("broken.gz"), b"not a gzip stream").unwrap();
		let (code, _, err) = run(&dir, &["-t", "broken.gz"]);
		assert_ne!(code, 0);
		assert!(!err.is_empty(), "corrupt archive must be reported");
	}

	#[test]
	fn decompressing_a_plain_file_reports_unknown_suffix() {
		let dir = fixture();
		let (code, _, err) = run(&dir, &["-d", "hello.txt"]);
		assert_eq!(code, 2);
		assert!(err.contains("unknown suffix"), "{err}");
	}

	#[test]
	fn missing_operand_reports_and_fails() {
		let dir = fixture();
		let (code, _, err) = run(&dir, &["nope.txt"]);
		assert_eq!(code, 1);
		assert!(err.contains("nope.txt"), "{err}");
	}

	#[test]
	fn verbose_reports_the_ratio() {
		let dir = fixture();
		let (code, _, err) = run(&dir, &["-v", "hello.txt"]);
		assert_eq!(code, 0);
		assert!(err.contains("replaced with"), "{err}");
	}

	#[test]
	fn declares_unsupported_options_with_reasons() {
		let dir = fixture();
		for flag in ["-a", "-L", "--rsyncable", "--synchronous"] {
			let (code, _, err) = run(&dir, &[flag, "hello.txt"]);
			assert_eq!(code, 1, "{flag} must fail");
			assert!(err.starts_with("gzip: "), "{flag}: {err}");
			assert!(err.len() > "gzip: -a ".len(), "{flag} must explain why: {err}");
		}
	}

	#[test]
	#[ignore = "local performance probe; run with --ignored"]
	fn perf_probe() {
		use std::time::Instant;

		let dir = tempdir().unwrap();
		let path = dir.path().join("corpus.bin");
		let mut payload = Vec::with_capacity(64 * 1024 * 1024);
		while payload.len() < 64 * 1024 * 1024 {
			payload.extend_from_slice(b"the quick brown fox jumps over the lazy dog 0123456789 ");
		}
		fs::write(&path, &payload).unwrap();
		let megabytes = payload.len() as f64 / (1024.0 * 1024.0);

		let start = Instant::now();
		let (code, _, err) = run(&dir, &["-k", "corpus.bin"]);
		let elapsed = start.elapsed();
		assert_eq!(code, 0, "stderr: {err}");
		eprintln!(
			"compress: {:.0} ms, {:.1} MB/s ({:.1} MB)",
			elapsed.as_millis(),
			megabytes / elapsed.as_secs_f64(),
			megabytes
		);
	}

	#[test]
	fn interoperates_with_the_system_gzip() {
		// Differential check against GNU gzip: our archives must be readable by
		// the original implementation and vice versa. Skipped when no gzip is
		// installed (CI images without it), which keeps the suite portable.
		let Some(system) = find_system_gzip() else {
			eprintln!("system gzip not found; skipping interop check");
			return;
		};

		let dir = fixture();
		let original = fs::read(dir.path().join("hello.txt")).unwrap();

		let (code, _, err) = run(&dir, &["-k", "hello.txt"]);
		assert_eq!(code, 0, "stderr: {err}");
		let theirs = std::process::Command::new(&system)
			.args(["-dc", "hello.txt.gz"])
			.current_dir(dir.path())
			.output()
			.expect("run system gzip");
		assert_eq!(theirs.stdout, original, "system gzip must read our archive");

		let sys_gz = std::process::Command::new(&system)
			.args(["-c", "hello.txt"])
			.current_dir(dir.path())
			.output()
			.expect("run system gzip");
		fs::write(dir.path().join("from-system.gz"), &sys_gz.stdout).unwrap();
		let (code, out, err) = run(&dir, &["-dc", "from-system.gz"]);
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out.as_bytes(), original, "we must read the system archive");
	}

	fn find_system_gzip() -> Option<std::path::PathBuf> {
		let paths = std::env::var_os("PATH")?;
		std::env::split_paths(&paths)
			.flat_map(|dir| ["gzip.exe", "gzip"].map(|name| dir.join(name)))
			.find(|candidate| candidate.is_file())
	}
}
