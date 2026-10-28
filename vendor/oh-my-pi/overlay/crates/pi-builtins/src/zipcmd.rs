//! `zip` builtin: create ZIP archives.
//!
//! The archive format is implemented by the `zip` crate; this module owns the
//! command-line surface and the filesystem walk. Every path goes through the
//! shell's `BlockingFs`, so `scheme://` inputs work like they do for `cp`.
//!
//! The command covers create, update/freshen/grow, delete, test/list, archive
//! comments, AES-256 password encryption, and the common Info-ZIP switches
//! that map cleanly onto the archive model.

use std::{
	fmt,
	io::{self, Read, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};

use crate::host::{Host, Utility, matches_parser, util};

mod entry;
mod line_endings;
mod update;
mod verify;

const ABOUT: &str = "create, update, or inspect ZIP archives\n\nUsage: zip [OPTION]... ZIPFILE FILE...\n\nSupports create/update/freshen/grow, delete, test/list, comments, and\nInfo-ZIP-compatible creation switches.";

/// Parsed `zip` invocation.
pub(crate) struct Zip {
	matches: ArgMatches,
}

matches_parser!(Zip, app);

impl Utility for Zip {
	const NAME: &'static str = "zip";
	const USAGE_ERROR: u8 = 16;

	fn run(self, host: &mut Host) -> i32 {
		run_zip(&self.matches, host)
	}
}

fn app() -> Command {
	let mut command = Command::new(Zip::NAME)
		.about(ABOUT)
		.disable_version_flag(true)
		.arg(
			Arg::new("recurse")
				.short('r')
				.long("recurse-paths")
				.action(ArgAction::SetTrue)
				.help("recurse into directories"),
		)
		.arg(
			Arg::new("quiet")
				.short('q')
				.long("quiet")
				.action(ArgAction::SetTrue)
				.help("suppress progress messages"),
		)
		.arg(
			Arg::new("junk-paths")
				.short('j')
				.long("junk-paths")
				.action(ArgAction::SetTrue)
				.help("store just the name of a saved file (junk the path)"),
		)
		.arg(
			Arg::new("update")
				.short('u')
				.long("update")
				.action(ArgAction::SetTrue)
				.conflicts_with_all(["freshen", "grow", "delete", "test"])
				.help("update existing entries and add new ones"),
		)
		.arg(
			Arg::new("move")
				.short('m')
				.long("move")
				.action(ArgAction::SetTrue)
				.conflicts_with_all(["delete", "test"])
				.help("move files into the archive, removing each source after a successful write"),
		)
		.arg(
			Arg::new("line-endings")
				.short('l')
				.action(ArgAction::Count)
				.help("translate LF to CRLF; use -ll to translate CRLF to LF"),
		)
		.arg(
			Arg::new("latest-time")
				.short('o')
				.action(ArgAction::SetTrue)
				.help("set the archive time to the latest input file time"),
		)
		.arg(
			Arg::new("password")
				.short('P')
				.value_name("PASSWORD")
				.action(ArgAction::Set)
				.help("encrypt entries with PASSWORD using AES-256"),
		)
		.arg(
			Arg::new("encrypt")
				.short('e')
				.action(ArgAction::SetTrue)
				.conflicts_with_all(["password", "files-from-stdin", "archive-comment"])
				.help("prompt for a password and encrypt entries"),
		)
		.arg(
			Arg::new("temp-dir")
				.short('b')
				.value_name("PATH")
				.action(ArgAction::Set)
				.help("use PATH for temporary archives"),
		)
		.arg(
			Arg::new("freshen")
				.short('f')
				.long("freshen")
				.action(ArgAction::SetTrue)
				.conflicts_with_all(["grow", "delete", "test"])
				.help("update existing entries without adding new ones"),
		)
		.arg(
			Arg::new("grow")
				.short('g')
				.long("grow")
				.action(ArgAction::SetTrue)
				.conflicts_with_all(["delete", "test"])
				.help("add new entries without replacing existing ones"),
		)
		.arg(
			Arg::new("delete")
				.short('d')
				.long("delete")
				.action(ArgAction::SetTrue)
				.conflicts_with_all(["test"])
				.help("delete entries from the archive"),
		)
		.arg(
			Arg::new("test")
				.short('T')
				.long("test")
				.action(ArgAction::SetTrue)
				.help("test the integrity of the archive"),
		)
		.arg(
			Arg::new("symlinks")
				.short('y')
				.long("symlinks")
				.action(ArgAction::SetTrue)
				.help("store symbolic links as links"),
		)
		.arg(
			Arg::new("include")
				.short('i')
				.long("include")
				.value_name("PATTERN")
				.action(ArgAction::Append)
				.help("include only entries matching PATTERN"),
		)
		.arg(
			Arg::new("exclude")
				.short('x')
				.long("exclude")
				.value_name("PATTERN")
				.action(ArgAction::Append)
				.help("exclude entries matching PATTERN"),
		)
		.arg(
			Arg::new("no-compress")
				.short('n')
				.long("suffixes")
				.value_name("SUFFIX")
				.action(ArgAction::Append)
				.help("do not compress files with SUFFIX"),
		)
		.arg(
			Arg::new("show-files")
				.short('s')
				.long("show-files")
				.action(ArgAction::SetTrue)
				.help("list archive entries"),
		)
		.arg(
			Arg::new("archive-comment")
				.short('z')
				.long("archive-comment")
				.action(ArgAction::SetTrue)
				.conflicts_with_all(["test", "show-files"])
				.help("set the archive comment from standard input"),
		)
		.arg(
			Arg::new("no-dir-entries")
				.short('D')
				.long("no-dir-entries")
				.action(ArgAction::SetTrue)
				.help("do not add directory entries"),
		)
		.arg(
			Arg::new("files-from-stdin")
				.short('@')
				.long("files-from-stdin")
				.action(ArgAction::SetTrue)
				.help("read file names from standard input"),
		)
		.arg(
			Arg::new("version")
				.short('v')
				.long("version")
				.action(ArgAction::SetTrue)
				.help("show version information"),
		)
		.arg(
			Arg::new("archive")
				.value_name("ZIPFILE")
				.index(1)
				.help("archive to create"),
		)
		.arg(
			Arg::new("files")
				.value_name("FILE")
				.num_args(1..)
				.action(ArgAction::Append)
				.index(2)
				.help("files and directories to add"),
		);

	for digit in 0..=9 {
		command = command.arg(
			Arg::new(level_name(digit))
				.short(char::from(b'0' + digit))
				.action(ArgAction::SetTrue)
				.help(if digit == 0 { "store uncompressed" } else { "compress with level 0..9" }),
		);
	}

	command
}

fn level_name(digit: u8) -> &'static str {
	const NAMES: [&str; 10] = [
		"level0", "level1", "level2", "level3", "level4", "level5", "level6", "level7", "level8",
		"level9",
	];
	NAMES[usize::from(digit)]
}

/// `zip` returns 1 for a failed archive operation, like Info-ZIP's generic
/// error status. `nothing to do` and write failures keep Info-ZIP's statuses
/// so scripts written against the Linux command keep working.
const FAILURE: i32 = 1;
const NOTHING_TO_DO: i32 = 12;
const EMPTY_ARCHIVE: i32 = 13;
const WRITE_ERROR: i32 = 15;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum LineEndings {
	LfToCrlf,
	CrlfToLf,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Operation {
	Create,
	Update,
	Freshen,
	Grow,
	Delete,
	Test,
	List,
	Comment,
}

/// Creates the `zip` builtin registration.
pub(crate) fn zip_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Zip, SE>()
}

fn run_zip(matches: &ArgMatches, host: &mut Host) -> i32 {
	if matches.get_flag("version") {
		let _ = writeln!(host.stdout_writer(), "zip 3.0 (pi-builtins)");
		return 0;
	}

	let Some(archive) = matches.get_one::<String>("archive") else {
		host.error("missing archive name", NOTHING_TO_DO);
		return NOTHING_TO_DO;
	};
	let archive = archive_with_zip_extension(PathBuf::from(archive));
	let mut inputs: Vec<PathBuf> = matches
		.get_many::<String>("files")
		.map(|files| files.map(PathBuf::from).collect())
		.unwrap_or_default();
	if matches.get_flag("files-from-stdin") {
		let mut list = String::new();
		if let Err(error) = host.stdin.read_to_string(&mut list) {
			host.error(error, FAILURE);
			return FAILURE;
		}
		inputs.extend(
			list.lines()
				.filter(|line| !line.is_empty())
				.map(PathBuf::from),
		);
	}
	let password = match password(matches, host) {
		Ok(password) => password,
		Err(code) => return code,
	};
	let config = Config {
		operation:  operation(matches),
		recurse:    matches.get_flag("recurse"),
		quiet:      matches.get_flag("quiet"),
		junk_paths: matches.get_flag("junk-paths"),
		symlinks:   matches.get_flag("symlinks"),
		store_dirs: !matches.get_flag("no-dir-entries"),
		include:    list_values(matches, "include"),
		exclude:    list_values(matches, "exclude"),
		no_compress: list_values(matches, "no-compress"),
		move_files:  matches.get_flag("move"),
		line_endings: line_endings(matches),
		latest_time: matches.get_flag("latest-time"),
		password,
		temp_dir:   matches
			.get_one::<String>("temp-dir")
			.map(|path| host.resolve(Path::new(path))),
		comment:    archive_comment(matches, host),
		level:      compression_level(matches),
		archive:    host.resolve(&archive),
	};

	match config.operation {
		Operation::Create => {
			let (entries, failed) = entry::collect_all(host, &inputs, &config);
			if entries.is_empty() {
				host.error("nothing to do", NOTHING_TO_DO);
				return NOTHING_TO_DO;
			}
			let status = entry::create_archive(host, &archive, &entries, &config);
			if status == 0 && config.latest_time {
				entry::set_archive_time(host, &config.archive, &entries);
			}
			if status == 0 && !failed && config.move_files {
				entry::remove_sources(host, &entries);
			}
			if failed && status == 0 { FAILURE } else { status }
		},
		Operation::Update | Operation::Freshen | Operation::Grow => {
			update::rewrite(host, &archive, &inputs, &config)
		},
		Operation::Delete => update::delete(host, &archive, &inputs, &config),
		Operation::Test => verify::test(host, &archive, &config),
		Operation::List => verify::list(host, &archive, &config),
		Operation::Comment => update::comment(host, &archive, &config),
	}
}

fn operation(matches: &ArgMatches) -> Operation {
	if matches.get_flag("show-files") {
		Operation::List
	} else if matches.get_flag("archive-comment") {
		Operation::Comment
	} else if matches.get_flag("update") {
		Operation::Update
	} else if matches.get_flag("freshen") {
		Operation::Freshen
	} else if matches.get_flag("grow") {
		Operation::Grow
	} else if matches.get_flag("delete") {
		Operation::Delete
	} else if matches.get_flag("test") {
		Operation::Test
	} else {
		Operation::Create
	}
}

fn archive_with_zip_extension(path: PathBuf) -> PathBuf {
	let text = path.to_string_lossy();
	if text.to_ascii_lowercase().ends_with(".zip") {
		path
	} else {
		PathBuf::from(format!("{text}.zip"))
	}
}

/// Options shared by every entry in one invocation.
struct Config {
	operation:  Operation,
	recurse:    bool,
	quiet:      bool,
	junk_paths: bool,
	symlinks:    bool,
	store_dirs:  bool,
	include:     Vec<String>,
	exclude:     Vec<String>,
	no_compress: Vec<String>,
	move_files:  bool,
	line_endings: Option<LineEndings>,
	latest_time: bool,
	password:    Option<Vec<u8>>,
	temp_dir:    Option<PathBuf>,
	comment:     Option<Vec<u8>>,
	level:       i64,
	archive:     PathBuf,
}

fn password(matches: &ArgMatches, host: &mut Host) -> Result<Option<Vec<u8>>, i32> {
	if let Some(password) = matches.get_one::<String>("password") {
		return Ok(Some(password.as_bytes().to_vec()));
	}
	if !matches.get_flag("encrypt") {
		return Ok(None);
	}
	let _ = write!(host.stderr, "Enter password: ");
	let _ = host.stderr.flush();
	let mut input = String::new();
	if let Err(error) = host.stdin.read_to_string(&mut input) {
		host.error(error, FAILURE);
		return Err(FAILURE);
	}
	let mut lines = input.lines();
	let password = lines.next().unwrap_or_default();
	let verify = lines.next().unwrap_or_default();
	if password != verify {
		host.error("passwords do not match", FAILURE);
		return Err(FAILURE);
	}
	Ok(Some(password.as_bytes().to_vec()))
}

fn line_endings(matches: &ArgMatches) -> Option<LineEndings> {
	match matches.get_count("line-endings") {
		0 => None,
		1 => Some(LineEndings::LfToCrlf),
		_ => Some(LineEndings::CrlfToLf),
	}
}

fn archive_comment(matches: &ArgMatches, host: &mut Host) -> Option<Vec<u8>> {
	if !matches.get_flag("archive-comment") {
		return None;
	}
	let mut comment = Vec::new();
	if let Err(error) = host.stdin.read_to_end(&mut comment) {
		host.error(error, FAILURE);
		return None;
	}
	Some(comment)
}

fn list_values(matches: &ArgMatches, name: &str) -> Vec<String> {
	matches
		.get_many::<String>(name)
		.map(|values| values.cloned().collect())
		.unwrap_or_default()
}

fn compression_level(matches: &ArgMatches) -> i64 {
	for digit in (0..=9).rev() {
		if matches.get_flag(level_name(digit)) {
			return i64::from(digit);
		}
	}
	6
}

fn report(host: &mut Host, message: &str) {
	let _ = writeln!(host.stderr, "zip: {message}");
}

type ZipResult<T> = Result<T, ZipError>;

#[derive(Debug)]
enum ZipError {
	Io(io::Error),
	Zip(zip::result::ZipError),
	Message(String),
}

impl fmt::Display for ZipError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Io(error) => error.fmt(formatter),
			Self::Zip(error) => error.fmt(formatter),
			Self::Message(message) => formatter.write_str(message),
		}
	}
}

impl From<io::Error> for ZipError {
	fn from(error: io::Error) -> Self {
		Self::Io(error)
	}
}

impl From<zip::result::ZipError> for ZipError {
	fn from(error: zip::result::ZipError) -> Self {
		Self::Zip(error)
	}
}

impl From<String> for ZipError {
	fn from(message: String) -> Self {
		Self::Message(message)
	}
}

/// The archive spelling of a command-line operand.
///
/// Relative operands keep their path; absolute operands lose the root and the
/// Windows drive prefix, matching Info-ZIP's habit of not storing a leading
/// slash. `.` contributes no prefix, so `zip -r out.zip .` stores the tree at
/// the archive root.
fn archive_base(operand: &Path, junk_paths: bool) -> String {
	if junk_paths {
		return leaf_name(operand);
	}

	let mut name = operand.to_string_lossy().replace('\\', "/");
	if name.len() >= 2 && name.as_bytes()[1] == b':' {
		name = name[2..].to_owned();
	}
	while name.starts_with('/') {
		name.remove(0);
	}
	while name.ends_with('/') {
		name.pop();
	}
	normalize_archive_name(&name)
}

/// Drops empty and `.` components and resolves `..` lexically, so an entry
/// can never point outside the archive root.
fn normalize_archive_name(name: &str) -> String {
	let mut parts: Vec<&str> = Vec::new();
	for part in name.split('/') {
		match part {
			"" | "." => {},
			".." => {
				parts.pop();
			},
			_ => parts.push(part),
		}
	}
	parts.join("/")
}

fn child_archive_name(parent: &str, child: &str, junk_paths: bool) -> String {
	if junk_paths || parent.is_empty() {
		child.to_owned()
	} else {
		format!("{parent}/{child}")
	}
}

fn leaf_name(path: &Path) -> String {
	path.file_name()
		.map(|name| name.to_string_lossy().into_owned())
		.unwrap_or_else(|| path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		io::Read,
		path::Path,
		time::{Duration, SystemTime},
	};

	use tempfile::tempdir;
	use zip::{CompressionMethod, ZipArchive};

	use super::Zip;
	use crate::host::run_util;

	fn open(path: &Path) -> ZipArchive<std::fs::File> {
		ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap()
	}

	fn read_entry(archive: &mut ZipArchive<std::fs::File>, name: &str) -> String {
		let mut entry = archive.by_name(name).unwrap();
		let mut text = String::new();
		entry.read_to_string(&mut text).unwrap();
		text
	}

	fn make_newer(path: &Path) {
		let file = fs::OpenOptions::new().write(true).open(path).unwrap();
		file.set_modified(SystemTime::now() + Duration::from_secs(5))
			.unwrap();
	}

	#[test]
	fn version_does_not_require_an_archive() {
		let (code, capture) = run_util::<Zip>(&["-v"], "", "/");
		assert_eq!(code, 0, "{}", capture.err());
		assert!(capture.out().contains("zip 3.0"), "{}", capture.out());
	}

	#[test]
	fn appends_zip_extension() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("hello.txt"), b"hello").unwrap();

		let (code, capture) = run_util::<Zip>(&["out", "hello.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert!(archive.by_name("hello.txt").is_ok());
	}

	#[test]
	fn move_removes_sources_after_success() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("hello.txt"), b"hello").unwrap();

		let (code, capture) = run_util::<Zip>(
			&["-m", "out.zip", "hello.txt"],
			"",
			fixture.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());
		assert!(!fixture.path().join("hello.txt").exists());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(read_entry(&mut archive, "hello.txt"), "hello");
	}

	#[test]
	fn move_update_removes_only_added_sources() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("old.txt"), b"old").unwrap();
		let (code, capture) =
			run_util::<Zip>(&["-q", "out.zip", "old.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		fs::write(fixture.path().join("new.txt"), b"new").unwrap();
		make_newer(&fixture.path().join("old.txt"));
		let (code, capture) = run_util::<Zip>(
			&["-u", "-m", "out.zip", "old.txt", "new.txt"],
			"",
			fixture.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());
		assert!(!fixture.path().join("old.txt").exists());
		assert!(!fixture.path().join("new.txt").exists());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert!(archive.by_name("old.txt").is_ok());
		assert!(archive.by_name("new.txt").is_ok());
	}

	#[test]
	fn lf_translates_to_crlf() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("text.txt"), b"a\nb\n").unwrap();

		let (code, capture) =
			run_util::<Zip>(&["-l", "out.zip", "text.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(read_entry(&mut archive, "text.txt"), "a\r\nb\r\n");
	}

	#[test]
	fn existing_crlf_is_not_doubled_by_l() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("text.txt"), b"a\r\nb\n").unwrap();

		let (code, capture) =
			run_util::<Zip>(&["-l", "out.zip", "text.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(read_entry(&mut archive, "text.txt"), "a\r\nb\r\n");
	}

	#[test]
	fn double_l_translates_crlf_to_lf() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("text.txt"), b"a\r\nb\r\n").unwrap();

		let (code, capture) =
			run_util::<Zip>(&["-ll", "out.zip", "text.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(read_entry(&mut archive, "text.txt"), "a\nb\n");
	}

	#[test]
	fn password_encrypts_and_test_decrypts() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("hello.txt"), b"hello").unwrap();

		let (code, capture) = run_util::<Zip>(
			&["-P", "secret", "out.zip", "hello.txt"],
			"",
			fixture.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		let mut entry = archive.by_name_decrypt("hello.txt", b"secret").unwrap();
		let mut text = String::new();
		entry.read_to_string(&mut text).unwrap();
		assert_eq!(text, "hello");

		let (code, capture) =
			run_util::<Zip>(&["-T", "-P", "secret", "out.zip"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
	}

	#[test]
	fn e_prompts_and_encrypts() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("hello.txt"), b"hello").unwrap();

		let (code, capture) = run_util::<Zip>(
			&["-e", "out.zip", "hello.txt"],
			"secret\nsecret\n",
			fixture.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		let mut entry = archive.by_name_decrypt("hello.txt", b"secret").unwrap();
		let mut text = String::new();
		entry.read_to_string(&mut text).unwrap();
		assert_eq!(text, "hello");
	}

	#[test]
	fn b_uses_named_temp_directory() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("old.txt"), b"old").unwrap();
		let (code, capture) =
			run_util::<Zip>(&["-q", "out.zip", "old.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let temp = fixture.path().join("tmp");
		fs::create_dir(&temp).unwrap();
		fs::write(fixture.path().join("new.txt"), b"new").unwrap();
		let (code, capture) = run_util::<Zip>(
			&["-u", "-b", "tmp", "out.zip", "new.txt"],
			"",
			fixture.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert!(archive.by_name("new.txt").is_ok());
		assert_eq!(fs::read_dir(&temp).unwrap().count(), 0);
	}

	#[test]
	fn b_uses_named_temp_directory_for_create() {
		let fixture = tempdir().unwrap();
		let temp = fixture.path().join("tmp");
		fs::create_dir(&temp).unwrap();
		fs::write(fixture.path().join("hello.txt"), b"hello").unwrap();

		let (code, capture) = run_util::<Zip>(
			&["-b", "tmp", "out.zip", "hello.txt"],
			"",
			fixture.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(read_entry(&mut archive, "hello.txt"), "hello");
		assert_eq!(fs::read_dir(&temp).unwrap().count(), 0);
	}

	#[test]
	fn o_sets_archive_time_to_latest_input() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("hello.txt"), b"hello").unwrap();
		let source_time = fs::metadata(fixture.path().join("hello.txt")).unwrap().modified().unwrap();

		let (code, capture) = run_util::<Zip>(&["-o", "out.zip", "hello.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let archive_time = fs::metadata(fixture.path().join("out.zip")).unwrap().modified().unwrap();
		let delta = archive_time.duration_since(source_time).unwrap_or_else(|error| error.duration());
		assert!(delta < Duration::from_secs(2), "archive time differs by {delta:?}");
	}

	#[test]
	fn creates_archive_from_a_file() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("hello.txt"), b"hello").unwrap();

		let (code, capture) =
			run_util::<Zip>(&["out.zip", "hello.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(archive.len(), 1);
		let mut entry = archive.by_name("hello.txt").unwrap();
		let mut text = String::new();
		entry.read_to_string(&mut text).unwrap();
		assert_eq!(text, "hello");
	}

	#[tokio::test]
	async fn registered_in_a_real_shell() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("hello.txt"), b"hello").unwrap();

		let (code, out, err) =
			crate::host::run_script("zip -q out.zip hello.txt", "", fixture.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(err, "");
		assert_eq!(out, "");

		let mut archive = open(&fixture.path().join("out.zip"));
		assert!(archive.by_name("hello.txt").is_ok());
	}

	#[test]
	fn dot_operand_stores_children_at_the_root_and_skips_the_archive() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("hello.txt"), b"hello").unwrap();

		let (code, capture) = run_util::<Zip>(&["-r", "out.zip", "."], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let archive = open(&fixture.path().join("out.zip"));
		let mut names: Vec<String> = archive.file_names().map(|name| name.unwrap().into_owned()).collect();
		names.sort();
		assert_eq!(names, vec!["hello.txt"]);
	}

	#[test]
	fn recurses_into_directories_with_r() {
		let fixture = tempdir().unwrap();
		let tree = fixture.path().join("tree");
		fs::create_dir_all(tree.join("nested")).unwrap();
		fs::write(tree.join("nested").join("leaf.txt"), b"leaf").unwrap();

		let (code, capture) = run_util::<Zip>(&["-r", "out.zip", "tree"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		let mut names: Vec<String> = archive.file_names().map(|name| name.unwrap().into_owned()).collect();
		names.sort();
		assert_eq!(names, vec!["tree/", "tree/nested/", "tree/nested/leaf.txt"]);

		let mut leaf = archive.by_name("tree/nested/leaf.txt").unwrap();
		let mut text = String::new();
		leaf.read_to_string(&mut text).unwrap();
		assert_eq!(text, "leaf");
	}

	#[test]
	fn level_zero_stores_entries() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("hello.txt"), b"hello hello hello").unwrap();

		let (code, capture) = run_util::<Zip>(&["-0", "out.zip", "hello.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		let entry = archive.by_name("hello.txt").unwrap();
		assert_eq!(entry.compression(), CompressionMethod::Stored);
	}

	#[test]
	fn junk_paths_uses_the_leaf_name() {
		let fixture = tempdir().unwrap();
		fs::create_dir(fixture.path().join("dir")).unwrap();
		fs::write(fixture.path().join("dir").join("hello.txt"), b"hello").unwrap();

		let (code, capture) =
			run_util::<Zip>(&["-j", "out.zip", "dir/hello.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert!(archive.by_name("hello.txt").is_ok());
	}

	#[test]
	fn missing_input_returns_nothing_to_do_without_creating_an_archive() {
		let fixture = tempdir().unwrap();
		let (code, capture) = run_util::<Zip>(&["out.zip", "missing.txt"], "", fixture.path());
		assert_eq!(code, 12);
		assert!(capture.err().contains("missing.txt"), "{}", capture.err());
		assert!(!fixture.path().join("out.zip").exists());
	}

	#[test]
	fn no_input_returns_nothing_to_do() {
		let fixture = tempdir().unwrap();
		let (code, capture) = run_util::<Zip>(&["out.zip"], "", fixture.path());
		assert_eq!(code, 12, "{}", capture.err());
		assert!(!fixture.path().join("out.zip").exists());
	}

	#[test]
	fn unknown_option_returns_16() {
		let fixture = tempdir().unwrap();
		let (code, _) = run_util::<Zip>(&["-w", "out.zip", "hello.txt"], "", fixture.path());
		assert_eq!(code, 16);
	}

	#[cfg(unix)]
	#[test]
	fn stores_symlinks_as_links() {
		use std::os::unix::fs::symlink;

		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("target.txt"), b"target").unwrap();
		symlink("target.txt", fixture.path().join("link.txt")).unwrap();

		let (code, capture) = run_util::<Zip>(&["-y", "out.zip", "link.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		let mut entry = archive.by_name("link.txt").unwrap();
		assert_eq!(entry.unix_mode().unwrap() & 0o170000, 0o120000);
		let mut target = String::new();
		entry.read_to_string(&mut target).unwrap();
		assert_eq!(target, "target.txt");
	}

	#[test]
	fn update_replaces_newer_entries_and_adds_new_ones() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"old").unwrap();
		fs::write(fixture.path().join("two.txt"), b"two").unwrap();
		let (code, capture) =
			run_util::<Zip>(&["out.zip", "one.txt", "two.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		fs::write(fixture.path().join("one.txt"), b"new").unwrap();
		make_newer(&fixture.path().join("one.txt"));
		fs::write(fixture.path().join("three.txt"), b"three").unwrap();
		let (code, capture) = run_util::<Zip>(
			&["-u", "out.zip", "one.txt", "three.txt"],
			"",
			fixture.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(archive.len(), 3);
		assert_eq!(read_entry(&mut archive, "one.txt"), "new");
		assert_eq!(read_entry(&mut archive, "two.txt"), "two");
		assert_eq!(read_entry(&mut archive, "three.txt"), "three");
	}

	#[test]
	fn update_missing_archive_creates_one() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"one").unwrap();
		let (code, capture) = run_util::<Zip>(&["-u", "out.zip", "one.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert!(fixture.path().join("out.zip").exists());
	}

	#[test]
	fn update_without_inputs_uses_empty_archive_status() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"one").unwrap();
		run_util::<Zip>(&["out.zip", "one.txt"], "", fixture.path());

		let (code, capture) = run_util::<Zip>(&["-u", "out.zip"], "", fixture.path());
		assert_eq!(code, 12, "{}", capture.err());
		let (code, capture) = run_util::<Zip>(&["-u", "missing.zip"], "", fixture.path());
		assert_eq!(code, 13, "{}", capture.err());
	}

	#[test]
	fn delete_removes_only_named_entries() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"one").unwrap();
		fs::write(fixture.path().join("two.txt"), b"two").unwrap();
		let (code, capture) =
			run_util::<Zip>(&["out.zip", "one.txt", "two.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let (code, capture) = run_util::<Zip>(&["-d", "out.zip", "one.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(archive.len(), 1);
		assert_eq!(read_entry(&mut archive, "two.txt"), "two");

		let (code, _) = run_util::<Zip>(&["-d", "out.zip", "missing.txt"], "", fixture.path());
		assert_eq!(code, 12);
		let (code, _) = run_util::<Zip>(&["-d", "out.zip", "two.txt"], "", fixture.path());
		assert_eq!(code, 0);
		assert_eq!(open(&fixture.path().join("out.zip")).len(), 0);
	}

	#[test]
	fn freshen_only_updates_existing_entries() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"old").unwrap();
		run_util::<Zip>(&["out.zip", "one.txt"], "", fixture.path());

		fs::write(fixture.path().join("two.txt"), b"two").unwrap();
		let (code, capture) = run_util::<Zip>(&["-f", "out.zip", "two.txt"], "", fixture.path());
		assert_eq!(code, 12, "{}", capture.err());
		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(archive.len(), 1);
		assert_eq!(read_entry(&mut archive, "one.txt"), "old");

		fs::write(fixture.path().join("one.txt"), b"new").unwrap();
		make_newer(&fixture.path().join("one.txt"));
		let (code, capture) = run_util::<Zip>(&["-f", "out.zip", "one.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(read_entry(&mut archive, "one.txt"), "new");
	}

	#[test]
	fn grow_keeps_existing_entries_and_adds_new_ones() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"old").unwrap();
		run_util::<Zip>(&["out.zip", "one.txt"], "", fixture.path());

		fs::write(fixture.path().join("one.txt"), b"new").unwrap();
		make_newer(&fixture.path().join("one.txt"));
		fs::write(fixture.path().join("two.txt"), b"two").unwrap();
		let (code, capture) =
			run_util::<Zip>(&["-g", "out.zip", "one.txt", "two.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(archive.len(), 2);
		assert_eq!(read_entry(&mut archive, "one.txt"), "old");
		assert_eq!(read_entry(&mut archive, "two.txt"), "two");
	}

	#[test]
	fn test_archive_reads_every_entry() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"one").unwrap();
		run_util::<Zip>(&["out.zip", "one.txt"], "", fixture.path());

		let (code, capture) = run_util::<Zip>(&["-T", "out.zip"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		fs::write(fixture.path().join("bad.zip"), b"not a zip").unwrap();
		let (code, _) = run_util::<Zip>(&["-T", "bad.zip"], "", fixture.path());
		assert_eq!(code, 3);
	}

	#[test]
	fn reads_file_list_from_stdin() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"one").unwrap();
		fs::write(fixture.path().join("two.txt"), b"two").unwrap();
		let (code, capture) = run_util::<Zip>(
			&["-@", "out.zip"],
			"one.txt\ntwo.txt\n",
			fixture.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());
		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(archive.len(), 2);
		assert!(archive.by_name("one.txt").is_ok());
	}

	#[test]
	fn include_filters_entries() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"one").unwrap();
		fs::write(fixture.path().join("two.bin"), b"two").unwrap();
		let (code, capture) = run_util::<Zip>(
			&["-i", "*.txt", "out.zip", "one.txt", "two.bin"],
			"",
			fixture.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());
		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(archive.len(), 1);
		assert!(archive.by_name("one.txt").is_ok());
	}

	#[test]
	fn exclude_filters_entries() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"one").unwrap();
		fs::write(fixture.path().join("two.bin"), b"two").unwrap();
		let (code, capture) = run_util::<Zip>(
			&["-x", "*.txt", "out.zip", "one.txt", "two.bin"],
			"",
			fixture.path(),
		);
		assert_eq!(code, 0, "{}", capture.err());
		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(archive.len(), 1);
		assert!(archive.by_name("two.bin").is_ok());
	}

	#[test]
	fn no_compress_suffix_stores_files() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"one one one").unwrap();
		let (code, capture) =
			run_util::<Zip>(&["-n", ".txt", "out.zip", "one.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		let mut archive = open(&fixture.path().join("out.zip"));
		assert_eq!(
			archive.by_name("one.txt").unwrap().compression(),
			CompressionMethod::Stored
		);
	}

	#[test]
	fn archive_comment_is_set_and_preserved_across_update() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"one").unwrap();
		run_util::<Zip>(&["out.zip", "one.txt"], "", fixture.path());

		let (code, capture) =
			run_util::<Zip>(&["-z", "out.zip"], "hello comment", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		let archive = open(&fixture.path().join("out.zip"));
		assert_eq!(archive.comment(), b"hello comment");
		assert_eq!(archive.len(), 1);

		fs::write(fixture.path().join("two.txt"), b"two").unwrap();
		run_util::<Zip>(&["-u", "out.zip", "two.txt"], "", fixture.path());
		let archive = open(&fixture.path().join("out.zip"));
		assert_eq!(archive.comment(), b"hello comment");
		assert_eq!(archive.len(), 2);
	}

	#[test]
	fn list_outputs_entries() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("one.txt"), b"one").unwrap();
		fs::write(fixture.path().join("two.txt"), b"two").unwrap();
		run_util::<Zip>(&["out.zip", "one.txt", "two.txt"], "", fixture.path());

		let (code, capture) = run_util::<Zip>(&["-sf", "out.zip"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert!(capture.out().contains("Archive contains:"), "{}", capture.out());
		assert!(capture.out().contains("  one.txt"), "{}", capture.out());
		assert!(capture.out().contains("  two.txt"), "{}", capture.out());
	}

	#[test]
	fn no_dir_entries_skips_directories() {
		let fixture = tempdir().unwrap();
		let tree = fixture.path().join("tree");
		fs::create_dir_all(tree.join("nested")).unwrap();
		fs::write(tree.join("nested").join("leaf.txt"), b"leaf").unwrap();

		let (code, capture) =
			run_util::<Zip>(&["-r", "-D", "out.zip", "tree"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let archive = open(&fixture.path().join("out.zip"));
		let mut names: Vec<String> = archive
			.file_names()
			.map(|name| name.unwrap().into_owned())
			.collect();
		names.sort();
		assert_eq!(names, vec!["tree/nested/leaf.txt"]);
	}

	#[cfg(unix)]
	#[test]
	fn follows_symlinks_by_default() {
		use std::os::unix::fs::symlink;

		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("target.txt"), b"target").unwrap();
		symlink("target.txt", fixture.path().join("link.txt")).unwrap();

		let (code, capture) = run_util::<Zip>(&["out.zip", "link.txt"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		let mut archive = open(&fixture.path().join("out.zip"));
		{
			let entry = archive.by_name("link.txt").unwrap();
			assert_ne!(entry.unix_mode().unwrap() & 0o170000, 0o120000);
		}
		assert_eq!(read_entry(&mut archive, "link.txt"), "target");
	}
}
