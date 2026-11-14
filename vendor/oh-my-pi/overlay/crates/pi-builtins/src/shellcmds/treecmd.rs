//! tree builtin: list directory contents in a tree.
//!
//! Not part of upstream pi-builtins; brush has no tree and Windows only ships
//! the unrelated tree.com, whose flags differ. Kept as an overlay module
//! (see vendor/oh-my-pi/overlay) wired in by a numbered patch.
//!
//! Supported surface (see docs/shell-commands/tree.md):
//!   -a all, -d dirs only, -L level, -f full path, -i no indent, -F classify,
//!   -s size, -h human size, -I exclude, -P include, --noreport, -n/-C color.
//!
//! Deliberately unsupported, reported instead of silently ignored: -p, -u, -g,
//! --inodes (no POSIX ownership here) and -X/-J/-H (structured output).

use std::{
	ffi::OsString,
	fs,
	io::{BufWriter, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use glob::{MatchOptions, Pattern};
use uucore::format::human::{SizeFormat, human_readable};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

/// ANSI colors for the entry kinds we can classify.
mod color {
	pub(super) const RESET: &str = "\x1b[0m";
	pub(super) const DIR: &str = "\x1b[01;34m";
	pub(super) const EXEC: &str = "\x1b[01;32m";
	pub(super) const LINK: &str = "\x1b[01;36m";
}

/// Parsed tree invocation.
pub(crate) struct Tree {
	matches: ArgMatches,
}

matches_parser!(Tree, app);

impl Utility for Tree {
	const NAME: &'static str = "tree";

	fn run(self, host: &mut Host) -> i32 {
		// -h is human-readable sizes here, so clap's auto help short flag is off.
		if self.matches.get_flag("version") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = writeln!(out, "tree {}", app().get_version().unwrap_or("?"));
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

		// Build the whole listing first so -o can write it in one go.
		let mut buffer: Vec<u8> = Vec::new();
		let out = &mut buffer;
		let mut counts = Counts::default();

		let _ = writeln!(out, "{}", options.root_label);

		if options.root_is_dir {
			walk(&options, out, &mut counts);
		} else {
			counts.files += 1;
		}

		if !options.noreport {
			let _ = write!(
				out,
				"\n{} director{}, {} file{}",
				counts.dirs,
				if counts.dirs == 1 { "y" } else { "ies" },
				counts.files,
				if counts.files == 1 { "" } else { "s" },
			);
			if options.du {
				let _ = write!(out, " ({} bytes)", counts.bytes);
			}
			let _ = writeln!(out);
		}

		match options.out {
			Some(path) => {
				if let Err(error) = fs::write(&path, &buffer) {
					host.error(format!("tree: {}: {}", path.display(), strip_errno(&error)), 1);
					return 1;
				}
			},
			None => {
				let mut stdout = BufWriter::new(host.stdout_clone());
				let _ = stdout.write_all(&buffer);
				let _ = stdout.flush();
			},
		}
		0
	}
}

pub(crate) fn tree_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Tree, SE>()
}

#[derive(Default)]
struct Counts {
	dirs: usize,
	files: usize,
	bytes: u64,
}

/// Everything run needs, resolved from the clap matches.
struct Options {
	root: PathBuf,
	root_label: String,
	root_is_dir: bool,
	all: bool,
	dirs_only: bool,
	level: Option<usize>,
	full_path: bool,
	no_indent: bool,
	classify: bool,
	size_bytes: bool,
	size_human: bool,
	noreport: bool,
	color: bool,
	ascii_lines: bool,
	reverse: bool,
	dirs_first: bool,
	question_marks: bool,
	filelimit: Option<usize>,
	follow_links: bool,
	prune: bool,
	du: bool,
	raw: bool,
	out: Option<PathBuf>,
	quote: bool,
	si: bool,
	matchdirs: bool,
	ignore_case: bool,
	unsorted: bool,
	metafirst: bool,
	ignore: Option<ignore::gitignore::Gitignore>,
	date: bool,
	timefmt: Option<String>,
	sort: SortKey,
	include: Vec<Pattern>,
	exclude: Vec<Pattern>,
}

impl Options {
	fn from_matches(matches: &ArgMatches, host: &Host) -> Result<Self, (String, i32)> {
		// Flags that exist in the reference tree but cannot mean anything here.
		for (id, long, short, takes_value, reason) in UNSUPPORTED {
			let present = if *takes_value {
				matches.contains_id(*id) && matches.get_one::<String>(*id).is_some()
			} else {
				matches.get_flag(*id)
			};
			if !present {
				continue;
			}
			let spelling = match (short, long) {
				(Some(short), Some(long)) => format!("-{}/--{}", short, long),
				(Some(short), None) => format!("-{}", short),
				(None, Some(long)) => format!("--{}", long),
				(None, None) => (*id).to_string(),
			};
			return Err((format!("tree: {} {}", spelling, reason), 1));
		}

		let requested = match matches.get_one::<OsString>("PATH") {
			Some(path) => PathBuf::from(path),
			None => PathBuf::from("."),
		};
		// Relative operands resolve against the shell's cwd, not the process's.
		let root = if requested.is_absolute() {
			requested.clone()
		} else {
			host.cwd().join(&requested)
		};
		let metadata = fs::symlink_metadata(&root)
			.map_err(|error| (format!("tree: {}: {}", root.display(), strip_errno(&error)), 2))?;

		let include = compile_patterns(matches.get_many::<String>("include"), "-P")?;
		let exclude = compile_patterns(matches.get_many::<String>("exclude"), "-I")?;

		// Built before the struct literal moves `root` into it.
		let ignore = build_ignore(&root, matches);

		Ok(Self {
			root_label: requested.display().to_string(),
			root_is_dir: metadata.is_dir(),
			root,
			all: matches.get_flag("all"),
			dirs_only: matches.get_flag("dirs-only"),
			level: matches.get_one::<usize>("level").copied(),
			full_path: matches.get_flag("full-path"),
			no_indent: matches.get_flag("no-indent"),
			classify: matches.get_flag("classify"),
			size_bytes: matches.get_flag("size") || matches.get_flag("du"),
			size_human: matches.get_flag("human-readable"),
			noreport: matches.get_flag("noreport"),
			color: color_enabled(matches, host),
			ascii_lines: matches.get_flag("ascii-lines")
				|| matches.get_flag("smooth")
				|| matches.get_one::<String>("charset").is_some_and(|set| set.eq_ignore_ascii_case("ascii")),
			reverse: matches.get_flag("reverse"),
			dirs_first: matches.get_flag("dirs-first"),
			question_marks: matches.get_flag("question-marks"),
			filelimit: matches.get_one::<usize>("filelimit").copied(),
			follow_links: matches.get_flag("follow-links"),
			prune: matches.get_flag("prune"),
			du: matches.get_flag("du"),
			raw: matches.get_flag("raw"),
			out: matches.get_one::<OsString>("out").map(|path| {
				let path = PathBuf::from(path);
				if path.is_absolute() { path } else { host.cwd().join(path) }
			}),
			quote: matches.get_flag("quote"),
			si: matches.get_flag("si"),
			matchdirs: matches.get_flag("matchdirs"),
			ignore_case: matches.get_flag("ignore-case"),
			unsorted: matches.get_flag("unsorted"),
			metafirst: matches.get_flag("metafirst"),
			ignore,
			date: matches.get_flag("date") || matches.get_one::<String>("timefmt").is_some(),
			timefmt: matches.get_one::<String>("timefmt").cloned(),
			sort: SortKey::from_matches(matches),
			include,
			exclude,
		})
	}
}

/// tree colorizes on a terminal by default; -n forces off, -C forces on.
fn color_enabled(matches: &ArgMatches, host: &Host) -> bool {
	if matches.get_flag("no-color") {
		return false;
	}
	if matches.get_flag("color") {
		return true;
	}
	host.stdout.is_terminal()
}

fn compile_patterns(
	values: Option<clap::parser::ValuesRef<'_, String>>,
	flag: &str,
) -> Result<Vec<Pattern>, (String, i32)> {
	let mut patterns = Vec::new();
	let Some(values) = values else {
		return Ok(patterns);
	};
	for value in values {
		for part in value.split('|') {
			if part.is_empty() {
				continue;
			}
			patterns.push(
				Pattern::new(part)
					.map_err(|error| (format!("tree: {}: invalid pattern: {}", flag, error), 1))?,
			);
		}
	}
	Ok(patterns)
}

/// --sort / -t: which key orders the entries of one directory.
#[derive(Clone, Copy, PartialEq)]
enum SortKey {
	Name,
	Size,
	Time,
}

impl SortKey {
	fn from_matches(matches: &ArgMatches) -> Self {
		if matches.get_flag("by-time") {
			return Self::Time;
		}
		match matches.get_one::<String>("sort").map(String::as_str) {
			Some("size") => Self::Size,
			Some("time") => Self::Time,
			_ => Self::Name,
		}
	}
}

/// One directory child, already filtered by -a/-d/-I/-P.
struct Child {
	name: OsString,
	path: PathBuf,
	is_dir: bool,
	is_symlink: bool,
	size: Option<u64>,
	mtime: Option<std::time::SystemTime>,
	target: Option<String>,
	executable: bool,
}

/// Iterative depth-first walk: an explicit stack keeps deep trees from
/// overflowing the thread stack, the same shape tree-rs uses.
fn walk(options: &Options, out: &mut impl Write, counts: &mut Counts) {
	let mut stack: Vec<Frame> = Vec::new();
	let mut visited: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
	if let Some(frame) = Frame::read(options, &options.root, String::new(), 1) {
		stack.push(frame);
	}

	while let Some(frame) = stack.last_mut() {
		if frame.next >= frame.entries.len() {
			stack.pop();
			continue;
		}
		let index = frame.next;
		frame.next += 1;

		let is_last = index + 1 == frame.entries.len();
		let base = frame.base.clone();
		let depth = frame.depth;
		let child = &frame.entries[index];

		if child.is_dir {
			counts.dirs += 1;
		} else {
			counts.files += 1;
		}
		if let Some(size) = child.size {
			counts.bytes += size;
		}

		let mut prefix = String::new();
		if !options.no_indent {
			prefix.push_str(&base);
			prefix.push_str(connector(options.ascii_lines, is_last));
		}
		let mut meta = String::new();
		if options.date
			&& let Some(stamp) = time_text(options, child.mtime)
		{
			meta.push_str(&format!("[{}]  ", stamp));
		}
		if options.size_bytes || options.size_human {
			let size = child.size.unwrap_or(0);
			let rendered = if options.si {
				human_readable(size, SizeFormat::Decimal)
			} else if options.size_human {
				human_readable(size, SizeFormat::Binary)
			} else {
				size.to_string()
			};
			meta.push_str(&format!("[{:>8}]  ", rendered));
		}
		let mut line = String::new();
		// --metafirst reports the metadata column before the indentation lines.
		if options.metafirst {
			line.push_str(&meta);
			line.push_str(&prefix);
		} else {
			line.push_str(&prefix);
			line.push_str(&meta);
		}
		let name = if options.quote {
			format!("\"{}\"", if options.full_path { child.path.display().to_string() } else { display(&child.name, options.question_marks) })
		} else if options.full_path {
			child.path.display().to_string()
		} else {
			display(&child.name, options.question_marks)
		};
		match if options.color { style_of(child) } else { None } {
			Some(style) => {
				line.push_str(style);
				line.push_str(&name);
				line.push_str(color::RESET);
			},
			None => line.push_str(&name),
		}
		if let Some(target) = &child.target {
			line.push_str(" -> ");
			line.push_str(target);
		}
		if options.classify {
			line.push_str(classify_of(child));
		}
		line.push('\n');
		let _ = out.write_all(line.as_bytes());

		let descend = child.is_dir
			&& (!child.is_symlink || options.follow_links)
			&& options.level.is_none_or(|level| depth < level);
		if descend {
			let child_base = if options.no_indent {
				String::new()
			} else {
				format!("{}{}", base, indent(options.ascii_lines, is_last))
			};
			let child_path = child.path.clone();
			// -l can walk into a symlink cycle; canonical paths stop it.
			let canonical = child_path.canonicalize().unwrap_or_else(|_| child_path.clone());
			if options.follow_links && !visited.insert(canonical) {
				continue;
			}
			if let Some(child_frame) = Frame::read(options, &child_path, child_base, depth + 1) {
				stack.push(child_frame);
			}
		}
	}
}

/// A directory's children plus how far the walk has advanced through them.
struct Frame {
	entries: Vec<Child>,
	next: usize,
	base: String,
	depth: usize,
}

impl Frame {
	fn read(options: &Options, dir: &Path, base: String, depth: usize) -> Option<Self> {
		let mut entries = read_children(options, dir);
		if entries.is_empty() {
			return None;
		}
		// --filelimit: do not descend into directories with too many entries.
		if options.filelimit.is_some_and(|limit| entries.len() > limit) {
			return None;
		}
		if !options.unsorted {
			entries.sort_by(|left, right| {
			let by_kind = if options.dirs_first {
				right.is_dir.cmp(&left.is_dir)
			} else {
				std::cmp::Ordering::Equal
			};
			by_kind.then_with(|| match options.sort {
				SortKey::Name => left.name.cmp(&right.name),
				SortKey::Size => left.size.unwrap_or(0).cmp(&right.size.unwrap_or(0)),
				SortKey::Time => right.mtime.cmp(&left.mtime),
			})
			});
		}
		if options.prune {
			entries.retain(|child| !child.is_dir || subtree_has_visible(options, &child.path, depth));
		}
		if options.reverse && !options.unsorted {
			entries.reverse();
		}
		Some(Self {
			entries,
			next: 0,
			base,
			depth,
		})
	}
}

fn read_children(options: &Options, dir: &Path) -> Vec<Child> {
	let Ok(entries) = fs::read_dir(dir) else {
		return Vec::new();
	};
	let mut children = Vec::new();
	for entry in entries.flatten() {
		let name = entry.file_name();
		if !options.all && is_hidden(&name) {
			continue;
		}
		let path = entry.path();
		let Ok(file_type) = entry.file_type() else {
			continue;
		};
		let is_dir = file_type.is_dir();
		let is_symlink = file_type.is_symlink();
		if options.dirs_only && !is_dir {
			continue;
		}
		if !matches_filters(options, &name, is_dir) {
			continue;
		}
		if is_ignored(options, &path, is_dir) {
			continue;
		}
		// Only pay for a stat when the size column is actually printed.
		let needs_meta = options.size_bytes
			|| options.size_human
			|| options.date
			|| options.sort == SortKey::Time;
		let metadata = if needs_meta {
			fs::symlink_metadata(&path).ok()
		} else {
			None
		};
		// --du reports a directory as the sum of everything below it.
		let size = if options.du && is_dir {
			Some(directory_size(&path))
		} else {
			metadata.as_ref().map(|metadata| metadata.len())
		};
		let executable = !is_dir && is_executable(&path);
		let target = if is_symlink {
			fs::read_link(&path).ok().map(|target| target.display().to_string())
		} else {
			None
		};
		children.push(Child {
			name,
			path,
			is_dir,
			is_symlink,
			size,
			mtime: metadata.as_ref().and_then(|metadata| metadata.modified().ok()),
			target,
			executable,
		});
	}
	children
}

/// Total bytes below a directory, following the same rules as \`du -s\`.
fn directory_size(path: &Path) -> u64 {
	let Ok(entries) = fs::read_dir(path) else {
		return 0;
	};
	let mut total = 0u64;
	for entry in entries.flatten() {
		let Ok(file_type) = entry.file_type() else {
			continue;
		};
		if file_type.is_symlink() {
			continue;
		}
		if file_type.is_dir() {
			total += directory_size(&entry.path());
		} else if let Ok(metadata) = entry.metadata() {
			total += metadata.len();
		}
	}
	total
}

/// --gitignore / --gitfile: one matcher rooted at the listing root. Sub-directory
/// .gitignore files are deliberately not read; the limitation is documented.
fn build_ignore(root: &Path, matches: &ArgMatches) -> Option<ignore::gitignore::Gitignore> {
	let explicit = matches
		.get_one::<OsString>("gitfile")
		.map(PathBuf::from)
		.map(|file| if file.is_absolute() { file } else { root.join(file) });
	if explicit.is_none() && !matches.get_flag("gitignore") {
		return None;
	}
	let mut builder = ignore::gitignore::GitignoreBuilder::new(root);
	match explicit {
		Some(file) => {
			builder.add(file);
		},
		None => {
			builder.add(root.join(".gitignore"));
		},
	}
	builder.build().ok()
}

/// -D / --timefmt: format a modification time in the shell's local zone.
fn time_text(options: &Options, time: Option<std::time::SystemTime>) -> Option<String> {
	let seconds = time?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
	let stamp = jiff::Timestamp::from_second(seconds).ok()?;
	let zoned = stamp.to_zoned(jiff::tz::TimeZone::system());
	let format = options.timefmt.as_deref().unwrap_or("%b %e %H:%M");
	Some(zoned.strftime(format).to_string())
}

/// --prune: does this directory still contribute a line after filtering?
fn subtree_has_visible(options: &Options, dir: &Path, depth: usize) -> bool {
	if options.level.is_some_and(|level| depth >= level) {
		return false;
	}
	let children = read_children(options, dir);
	if options.filelimit.is_some_and(|limit| children.len() > limit) {
		return false;
	}
	children
		.iter()
		.any(|child| !child.is_dir || subtree_has_visible(options, &child.path, depth + 1))
}

/// --gitignore: is this entry ignored by the configured matcher?
fn is_ignored(options: &Options, path: &Path, is_dir: bool) -> bool {
	let Some(matcher) = &options.ignore else {
		return false;
	};
	let relative = path.strip_prefix(&options.root).unwrap_or(path);
	matcher.matched_path_or_any_parents(relative, is_dir).is_ignore()
}

fn is_hidden(name: &OsString) -> bool {
	name.to_string_lossy().starts_with('.')
}

/// -I filters everything; -P filters files only, so the directories that hold
/// matches stay in the tree (the reference tree behaves the same way).
fn matches_filters(options: &Options, name: &OsString, is_dir: bool) -> bool {
	let name = name.to_string_lossy();
	let included = (is_dir && !options.matchdirs)
		|| options.include.is_empty()
		|| options.include.iter().any(|pattern| pattern_matches(pattern, &name, options.ignore_case));
	included
		&& !options
			.exclude
			.iter()
			.any(|pattern| pattern_matches(pattern, &name, options.ignore_case))
}

/// --ignore-case applies to -P / -I patterns instead of the whole path.
fn pattern_matches(pattern: &Pattern, name: &str, ignore_case: bool) -> bool {
	if ignore_case {
		pattern.matches_with(
			name,
			MatchOptions {
				case_sensitive: false,
				require_literal_separator: false,
				require_literal_leading_dot: false,
			},
		)
	} else {
		pattern.matches(name)
	}
}

fn is_executable(path: &Path) -> bool {
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		fs::symlink_metadata(path)
			.map(|metadata| metadata.permissions().mode() & 0o111 != 0)
			.unwrap_or(false)
	}
	#[cfg(not(unix))]
	{
		// Windows has no execute bit; fall back to the extensions users expect
		// -F to flag.
		path.extension()
			.and_then(|extension| extension.to_str())
			.map(|extension| {
				matches!(
					extension.to_ascii_lowercase().as_str(),
					"exe" | "com" | "bat" | "cmd" | "ps1"
				)
			})
			.unwrap_or(false)
	}
}

fn style_of(child: &Child) -> Option<&'static str> {
	if child.is_symlink {
		Some(color::LINK)
	} else if child.is_dir {
		Some(color::DIR)
	} else if child.executable {
		Some(color::EXEC)
	} else {
		None
	}
}

fn classify_of(child: &Child) -> &'static str {
	if child.is_symlink {
		"@"
	} else if child.is_dir {
		"/"
	} else if child.executable {
		"*"
	} else {
		""
	}
}

fn connector(ascii: bool, is_last: bool) -> &'static str {
	match (ascii, is_last) {
		(true, true) => "\\--- ",
		(true, false) => "+--- ",
		(false, true) => "└── ",
		(false, false) => "├── ",
	}
}

fn indent(ascii: bool, is_last: bool) -> &'static str {
	match (ascii, is_last) {
		(true, true) => "    ",
		(true, false) => "|   ",
		(false, true) => "    ",
		(false, false) => "│   ",
	}
}

/// -q: non-printable characters become question marks.
fn display(name: &OsString, question_marks: bool) -> String {
	let text = name.to_string_lossy().into_owned();
	if !question_marks {
		return text;
	}
	text
		.chars()
		.map(|ch| if ch.is_control() { '?' } else { ch })
		.collect()
}

fn strip_errno(error: &std::io::Error) -> String {
	let text = error.to_string();
	match text.find(" (os error ") {
		Some(index) => text[..index].to_string(),
		None => text,
	}
}

/// Flags the reference tree accepts that this build deliberately rejects, each
/// with the reason shown to the user. Declared in clap so parsing still belongs
/// to clap, and rejected in one place instead of per flag.
const UNSUPPORTED: &[(&str, Option<&str>, Option<char>, bool, &str)] = &[
	("perm", None, Some('p'), false, "POSIX permissions are not available on this platform"),
	("user", None, Some('u'), false, "file ownership is not available on this platform"),
	("group", None, Some('g'), false, "group ownership is not available on this platform"),
	("inodes", Some("inodes"), None, false, "inode numbers are not available on this platform"),
	("xdev", None, Some('x'), false, "cross-filesystem filtering has no meaning on this platform"),
	("device", Some("device"), None, false, "device numbers are not available on this platform"),
	("xml", None, Some('X'), false, "XML output is not implemented"),
	("json", None, Some('J'), false, "JSON output is not implemented"),
	("html", None, Some('H'), true, "HTML output is not implemented"),
	("title", None, Some('T'), true, "an HTML title only applies to -H, which is not implemented"),
	("ctime", None, Some('c'), false, "the change-time column is not implemented"),
	("recursive-html", None, Some('R'), false, "recursive HTML output is not implemented"),
	("fromfile", Some("fromfile"), None, false, "reading paths from a file is not implemented"),
	("fromtabfile", Some("fromtabfile"), None, false, "reading paths from a file is not implemented"),
	("info", Some("info"), None, false, ".info file comments are not implemented"),
	("infofile", Some("infofile"), None, true, ".info file comments are not implemented"),
];

fn app() -> Command {
	let mut command = Command::new(Tree::NAME)
		.disable_help_flag(true)
		.disable_version_flag(true)
		.version("1.8.0")
		.about("List contents of directories in a tree-like format")
		.override_usage(format_usage("tree [OPTIONS] [PATH]"))
		.arg(
			Arg::new("PATH")
				.default_value(".")
				.value_name("PATH")
				.value_parser(clap::builder::ValueParser::os_string()),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::SetTrue).help("print this help and exit"))
		.arg(Arg::new("reverse").short('r').long("reverse").action(ArgAction::SetTrue).help("sort the output in reverse order"))
		.arg(Arg::new("dirs-first").long("dirsfirst").action(ArgAction::SetTrue).help("list directories before files"))
		.arg(Arg::new("question-marks").short('q').long("question-marks").action(ArgAction::SetTrue).help("print non-printable characters as '?'"))
		.arg(Arg::new("ascii-lines").short('A').long("ansi-lines").action(ArgAction::SetTrue).help("draw the tree with plain ASCII lines"))
		.arg(Arg::new("follow-links").short('l').long("follow-links").action(ArgAction::SetTrue).help("follow symbolic links that point to directories"))
		.arg(Arg::new("filelimit").long("filelimit").value_name("N").value_parser(clap::value_parser!(usize)).help("do not descend into directories with more than N entries"))
		.arg(Arg::new("prune").long("prune").action(ArgAction::SetTrue).help("omit directories that end up empty"))
		.arg(Arg::new("du").long("du").action(ArgAction::SetTrue).help("report cumulative directory sizes"))
		.arg(Arg::new("out").short('o').long("out").value_name("FILE").value_parser(clap::builder::ValueParser::os_string()).help("write the listing to FILE"))
		.arg(Arg::new("quote").short('Q').long("quote").action(ArgAction::SetTrue).help("quote file names in double quotes"))
		.arg(Arg::new("raw").short('N').long("raw").action(ArgAction::SetTrue).help("print non-printable characters as is"))
		.arg(Arg::new("si").long("si").action(ArgAction::SetTrue).help("sizes use powers of 1000"))
		.arg(Arg::new("ignore-case").long("ignore-case").action(ArgAction::SetTrue).help("match -P and -I patterns case-insensitively"))
		.arg(Arg::new("unsorted").short('U').action(ArgAction::SetTrue).help("do not sort directory entries"))
		.arg(Arg::new("matchdirs").long("matchdirs").action(ArgAction::SetTrue).help("apply -P patterns to directory names too"))
		.arg(Arg::new("metafirst").long("metafirst").action(ArgAction::SetTrue).help("print metadata before the indentation lines"))
		.arg(Arg::new("gitignore").long("gitignore").action(ArgAction::SetTrue).help("use .gitignore for filtering"))
		.arg(Arg::new("gitfile").long("gitfile").value_name("FILE").value_parser(clap::builder::ValueParser::os_string()).help("use FILE as the ignore file"))
		.arg(Arg::new("date").short('D').long("date").action(ArgAction::SetTrue).help("print the last modification time"))
		.arg(Arg::new("timefmt").long("timefmt").value_name("FORMAT").help("strftime format for -D"))
		.arg(Arg::new("charset").long("charset").value_name("SET").help("character set: ascii"))
		.arg(Arg::new("smooth").short('S').action(ArgAction::SetTrue).help("draw the tree with plain ASCII lines"))
		.arg(Arg::new("sort").long("sort").value_name("KEY").help("sort by name, size or time"))
		.arg(Arg::new("by-time").short('t').action(ArgAction::SetTrue).help("sort by modification time"))
		.arg(Arg::new("all").short('a').long("all").action(ArgAction::SetTrue).help("all files, including hidden ones"))
		.arg(Arg::new("dirs-only").short('d').long("dirs-only").action(ArgAction::SetTrue).help("list directories only"))
		.arg(Arg::new("level").short('L').long("level").value_name("LEVEL").value_parser(clap::value_parser!(usize)).help("descend at most LEVEL directories deep"))
		.arg(Arg::new("full-path").short('f').long("full-path").action(ArgAction::SetTrue).help("print the full path prefix for each file"))
		.arg(Arg::new("no-indent").short('i').long("no-indent").action(ArgAction::SetTrue).help("do not print indentation lines"))
		.arg(Arg::new("classify").short('F').long("classify").action(ArgAction::SetTrue).help("append a type marker: / * @"))
		.arg(Arg::new("size").short('s').long("size").action(ArgAction::SetTrue).help("print the size of each file in bytes"))
		.arg(Arg::new("human-readable").short('h').long("human-readable").action(ArgAction::SetTrue).help("print sizes in a human readable form"))
		.arg(Arg::new("include").short('P').long("pattern").value_name("PATTERN").action(ArgAction::Append).help("list only files matching PATTERN (| separates alternatives)"))
		.arg(Arg::new("exclude").short('I').long("ignore").value_name("PATTERN").action(ArgAction::Append).help("do not list files matching PATTERN (| separates alternatives)"))
		.arg(Arg::new("noreport").long("noreport").action(ArgAction::SetTrue).help("omit the summary line"))
		.arg(Arg::new("color").short('C').long("color").action(ArgAction::SetTrue).help("colorize the output"))
		.arg(Arg::new("no-color").short('n').long("no-color").action(ArgAction::SetTrue).help("turn colorization off"))
		.arg(Arg::new("version").short('v').long("version").action(ArgAction::SetTrue).help("print the version and exit"))
		.infer_long_args(true);

	// Unsupported flags still belong to clap; they are rejected with a reason
	// in Options::from_matches instead of surfacing "unexpected argument".
	for (id, long, short, takes_value, _reason) in UNSUPPORTED {
		let mut arg = Arg::new(*id).action(if *takes_value {
			ArgAction::Set
		} else {
			ArgAction::SetTrue
		});
		if let Some(long) = long {
			arg = arg.long(*long);
		}
		if let Some(short) = short {
			arg = arg.short(*short);
		}
		if *takes_value {
			arg = arg.value_name("VALUE");
		}
		command = command.arg(arg.hide(true));
	}

	command
}

#[cfg(test)]
mod tests {
	use std::fs;

	use tempfile::{TempDir, tempdir};

	use crate::host::run_util;

	use super::Tree;

	/// root/
	///   a.txt  b.md  .hidden  sub/{c.txt, deeper/{d.txt}}
	fn fixture() -> TempDir {
		let dir = tempdir().unwrap();
		let root = dir.path();
		fs::write(root.join("a.txt"), b"hello").unwrap();
		fs::write(root.join("b.md"), b"# hi").unwrap();
		fs::write(root.join(".hidden"), b"x").unwrap();
		fs::create_dir(root.join("sub")).unwrap();
		fs::write(root.join("sub/c.txt"), b"c").unwrap();
		fs::create_dir(root.join("sub/deeper")).unwrap();
		fs::write(root.join("sub/deeper/d.txt"), b"d").unwrap();
		dir
	}

	fn tree(dir: &TempDir, args: &[&str]) -> (i32, String) {
		let (code, capture) = run_util::<Tree>(args, "", dir.path());
		(code, capture.out())
	}

	#[test]
	fn lists_nested_entries_with_connectors() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["."]);
		assert_eq!(code, 0);
		assert!(out.contains("├── a.txt"), "{out}");
		assert!(out.contains("└── sub"), "{out}");
		assert!(out.contains("    ├── c.txt"), "{out}");
		assert!(out.contains("        └── d.txt"), "{out}");
		// Hidden entries are skipped without -a, and the summary counts what it printed.
		assert!(!out.contains(".hidden"), "{out}");
		assert!(out.contains("2 directories, 4 files"), "{out}");
	}

	#[test]
	fn all_includes_hidden_entries() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-a", "."]);
		assert_eq!(code, 0);
		assert!(out.contains(".hidden"), "{out}");
		assert!(out.contains("2 directories, 5 files"), "{out}");
	}

	#[test]
	fn dirs_only_hides_files() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-d", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("sub"), "{out}");
		assert!(out.contains("deeper"), "{out}");
		assert!(!out.contains("a.txt"), "{out}");
		assert!(out.contains("2 directories, 0 files"), "{out}");
	}

	#[test]
	fn level_limits_depth() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-L", "1", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("sub"), "{out}");
		assert!(!out.contains("c.txt"), "{out}");
		assert!(out.contains("1 directory, 2 files"), "{out}");
	}

	#[test]
	fn ignore_pattern_skips_matching_entries() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-I", "*.md", "."]);
		assert_eq!(code, 0);
		assert!(!out.contains("b.md"), "{out}");
		assert!(out.contains("a.txt"), "{out}");
	}

	#[test]
	fn pattern_keeps_directories_for_matches() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-P", "*.txt", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("a.txt"), "{out}");
		assert!(out.contains("c.txt"), "{out}");
		// Directories stay so the matching files inside them are reachable.
		assert!(out.contains("sub"), "{out}");
		assert!(!out.contains("b.md"), "{out}");
	}

	#[test]
	fn classify_marks_directories() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-F", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("sub/"), "{out}");
		assert!(!out.contains("a.txt/"), "{out}");
	}

	#[test]
	fn sizes_are_printed_when_requested() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-s", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("[       5]  a.txt"), "{out}");
	}

	#[test]
	fn noreport_omits_the_summary() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["--noreport", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("a.txt"), "{out}");
		assert!(!out.contains("directories,"), "{out}");
	}

	#[test]
	fn no_indent_prints_bare_names() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-i", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("\na.txt\n"), "{out}");
		assert!(!out.contains("├──"), "{out}");
	}

	#[test]
	fn reverse_flips_the_sort_order() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-r", "."]);
		assert_eq!(code, 0);
		let first = out.lines().nth(1).unwrap_or_default();
		assert!(first.contains("sub"), "{out}");
	}

	#[test]
	fn dirsfirst_lists_directories_before_files() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["--dirsfirst", "."]);
		assert_eq!(code, 0);
		let first = out.lines().nth(1).unwrap_or_default();
		assert!(first.contains("sub"), "{out}");
	}

	#[test]
	fn filelimit_stops_descent_into_busy_directories() {
		let dir = fixture();
		// Make sub the busy directory: five entries against a limit of three.
		for name in ["e1.txt", "e2.txt", "e3.txt"] {
			fs::write(dir.path().join("sub").join(name), b"x").unwrap();
		}
		let (code, out) = tree(&dir, &["--filelimit", "3", "."]);
		assert_eq!(code, 0);
		// The root has three entries so it is listed; sub is not descended.
		assert!(out.contains("sub"), "{out}");
		assert!(!out.contains("c.txt"), "{out}");
		assert!(!out.contains("deeper"), "{out}");
	}

	#[test]
	fn prune_drops_directories_that_end_up_empty() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-P", "*.md", "--prune", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("b.md"), "{out}");
		// sub only held .txt files, so pruning removes it entirely.
		assert!(!out.contains("sub"), "{out}");
	}

	#[test]
	fn du_reports_cumulative_directory_sizes() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["--du", "."]);
		assert_eq!(code, 0);
		// sub holds c.txt (1) and deeper/d.txt (1).
		assert!(out.contains("[       2]  sub"), "{out}");
		assert!(out.contains("bytes)"), "{out}");
	}

	#[test]
	fn out_writes_the_listing_to_a_file() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-o", "listing.txt", "."]);
		assert_eq!(code, 0);
		assert!(out.is_empty(), "stdout must stay empty: {out}");
		let written = fs::read_to_string(dir.path().join("listing.txt")).unwrap();
		assert!(written.contains("a.txt"), "{written}");
	}

	#[test]
	fn quote_wraps_names_in_double_quotes() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-Q", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("\"a.txt\""), "{out}");
	}

	#[test]
	fn matchdirs_applies_patterns_to_directories() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-P", "sub", "--matchdirs", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("sub"), "{out}");
		assert!(!out.contains("a.txt"), "{out}");
	}

	#[test]
	fn sort_size_orders_by_size() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-s", "--sort", "size", "."]);
		assert_eq!(code, 0);
		// b.md (4 bytes) sorts before a.txt (5 bytes) when size ascending;
		// directories report 0 without --du, so compare positions instead.
		let b = out.find("b.md").expect("b.md listed");
		let a = out.find("a.txt").expect("a.txt listed");
		assert!(b < a, "{out}");
	}

	#[test]
	fn smooth_switches_to_ascii_lines() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-S", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("+--- ") || out.contains("\\--- "), "{out}");
		assert!(!out.contains("├──"), "{out}");
	}

	#[test]
	fn metafirst_prints_metadata_before_the_indent() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-s", "--metafirst", "."]);
		assert_eq!(code, 0);
		// The size column now leads the line instead of following the connector.
		assert!(out.lines().any(|line| line.starts_with("[") && line.contains("a.txt")), "{out}");
	}

	#[test]
	fn date_column_and_timefmt_render_a_timestamp() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-D", "."]);
		assert_eq!(code, 0);
		assert!(out.lines().any(|line| line.contains("]  a.txt")), "{out}");
		let (code, out) = tree(&dir, &["--timefmt", "%Y", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("[2026]"), "{out}");
	}

	#[tokio::test]
	async fn runs_inside_a_real_shell() {
		// Different from run_util: the script goes through brush's parser and
		// builtin dispatch, so registration and argument handling are exercised
		// the way a user's shell line would be.
		let dir = fixture();
		let (code, out, err) = crate::host::run_script("tree -L 1 -F .", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert!(out.contains("a.txt"), "{out}");
		assert!(out.contains("sub/"), "{out}");
		// -L 1 must stop at depth one even through the shell path.
		assert!(!out.contains("c.txt"), "{out}");
		assert_eq!(err, "");
	}

	#[test]
	fn gitignore_filters_ignored_entries() {
		let dir = fixture();
		fs::write(dir.path().join(".gitignore"), b"*.md\nsub/deeper\n").unwrap();
		let (code, out) = tree(&dir, &["--gitignore", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("a.txt"), "{out}");
		assert!(!out.contains("b.md"), "{out}");
		assert!(!out.contains("d.txt"), "{out}");
	}

	#[test]
	fn gitfile_uses_an_explicit_ignore_file() {
		let dir = fixture();
		fs::write(dir.path().join("my-ignores"), b"*.txt\n").unwrap();
		let (code, out) = tree(&dir, &["--gitfile", "my-ignores", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("b.md"), "{out}");
		assert!(!out.contains("a.txt"), "{out}");
	}

	#[test]
	fn ignore_case_applies_to_pattern_filters() {
		let dir = fixture();
		fs::write(dir.path().join("UPPER.MD"), b"x").unwrap();
		// Without the flag the pattern is case sensitive, so UPPER.MD is filtered out.
		let (code, out) = tree(&dir, &["-P", "*.md", "."]);
		assert_eq!(code, 0);
		assert!(!out.contains("UPPER.MD"), "{out}");
		let (code, out) = tree(&dir, &["-P", "*.md", "--ignore-case", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("UPPER.MD"), "{out}");
	}

	#[test]
	fn unsorted_keeps_directory_order() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-U", "."]);
		assert_eq!(code, 0);
		assert!(out.contains("a.txt"), "{out}");
		assert!(out.contains("sub"), "{out}");
	}

	#[test]
	fn device_is_rejected_with_a_reason() {
		let dir = fixture();
		let (code, capture) = run_util::<Tree>(&["--device", "."], "", dir.path());
		assert_eq!(code, 1);
		assert!(capture.err().contains("device"), "{}", capture.err());
	}

	#[test]
	fn unsupported_flags_fail_loudly() {
		let dir = fixture();
		for flag in ["-p", "-u", "-g"] {
			let (code, capture) = run_util::<Tree>(&[flag, "."], "", dir.path());
			assert_eq!(code, 1, "{flag} must not be silently ignored");
			assert!(!capture.err().is_empty(), "{flag} must explain why");
		}
	}

	#[test]
	fn declared_but_unimplemented_flags_explain_themselves() {
		let dir = fixture();
		// Sample a few rows from the table rather than one hard-coded flag, so a
		// flag moving from "rejected" to "implemented" does not break the test.
		for spelling in ["--info", "--fromfile", "-p"] {
			let (code, capture) = run_util::<Tree>(&[spelling, "."], "", dir.path());
			assert_eq!(code, 1, "{spelling} must fail");
			let err = capture.err();
			assert!(err.contains("tree: "), "{spelling}: {err}");
			assert!(err.len() > 12, "{spelling}: {err}");
		}
	}

	#[test]
	#[ignore = "perf probe: run explicitly with --ignored --nocapture"]
	fn perf_probe_on_a_large_tree() {
		let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
		let start = std::time::Instant::now();
		let (code, capture) = run_util::<Tree>(&["--noreport", "."], "", &root);
		let elapsed = start.elapsed();
		assert_eq!(code, 0);
		let lines = capture.out().lines().count();
		eprintln!("PERF lines={lines} elapsed_ms={}", elapsed.as_millis());
	}

	#[test]
	fn version_flag_prints_a_version() {
		let dir = fixture();
		let (code, out) = tree(&dir, &["-v"]);
		assert_eq!(code, 0);
		assert!(out.starts_with("tree "), "{out}");
	}

	#[test]
	fn missing_path_reports_and_fails() {
		let dir = fixture();
		let (code, capture) = run_util::<Tree>(&["nope"], "", dir.path());
		assert_eq!(code, 2);
		assert!(capture.err().contains("nope"), "{}", capture.err());
	}
}
