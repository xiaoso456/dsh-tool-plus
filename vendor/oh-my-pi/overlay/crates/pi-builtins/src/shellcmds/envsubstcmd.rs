//! envsubst builtin: substitute environment variables in shell-format text.
//!
//! Windows/Git Bash does not ship GNU gettext's envsubst at all, so templates
//! that rely on it fail outright. Supported surface mirrors the reference:
//!   -v/--variables, -h/--help, -V/--version, optional SHELL-FORMAT operand.
//!
//! Semantics: standard input is copied to standard output with ${VAR} and
//! ${VAR} references replaced by the environment value (empty when unset).
//! When a SHELL-FORMAT is given, only variables referenced there are
//! substituted and every other reference is left untouched.

use std::{
	collections::BTreeSet,
	io::{BufWriter, Read, Write},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};

use crate::host::{Host, Utility, matches_parser, util};

/// Substitute environment variables in stdin, filtered by an optional format.
pub(crate) struct Envsubst {
	matches: ArgMatches,
}

matches_parser!(Envsubst, app);

impl Utility for Envsubst {
	const NAME: &'static str = "envsubst";

	fn run(self, host: &mut Host) -> i32 {
		if self.matches.get_flag("version") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = writeln!(out, "envsubst 0.24 (pi-builtins)");
			let _ = out.flush();
			return 0;
		}
		if self.matches.get_flag("help") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = write!(out, "{}", app().render_help());
			let _ = out.flush();
			return 0;
		}

		let format = self.matches.get_one::<String>("FORMAT").map(String::as_str);

		if self.matches.get_flag("variables") {
			let Some(format) = format else {
				host.error("envsubst: missing SHELL-FORMAT for --variables", 1);
				return 1;
			};
			let mut out = BufWriter::new(host.stdout_clone());
			for name in unique_variables(format) {
				let _ = writeln!(out, "{name}");
			}
			let _ = out.flush();
			return 0;
		}

		let allowed: BTreeSet<String> = format.map(collect_variables).unwrap_or_default();
		let filtered = format.is_some();

		let mut input = String::new();
		if let Err(error) = host.stdin.read_to_string(&mut input) {
			host.error(format!("envsubst: {error}"), 1);
			return 1;
		}

		let rendered = substitute(&input, &allowed, filtered, host);
		let mut out = BufWriter::new(host.stdout_clone());
		if out.write_all(rendered.as_bytes()).is_err() {
			return 1;
		}
		let _ = out.flush();
		0
	}
}

pub(crate) fn envsubst_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Envsubst, SE>()
}

/// Variable names referenced in a shell-format string.
fn collect_variables(text: &str) -> BTreeSet<String> {
	let mut names = BTreeSet::new();
	for (name, _) in references(text) {
		if let Some(name) = name {
			names.insert(name);
		}
	}
	names
}

/// Variable names in order of appearance, de-duplicated.
fn unique_variables(text: &str) -> Vec<String> {
	let mut seen = Vec::new();
	for (name, _) in references(text) {
		if let Some(name) = name {
			if !seen.contains(&name) {
				seen.push(name);
			}
		}
	}
	seen
}

/// Walk text, yielding (Some(variable), span) for references and (None, span)
/// for literal stretches the caller must copy verbatim.
fn references(text: &str) -> Vec<(Option<String>, &str)> {
	let bytes = text.as_bytes();
	let mut parts = Vec::new();
	let mut literal_start = 0;
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] != b'$' {
			index += 1;
			continue;
		}
		let Some((name, end)) = parse_reference(text, index) else {
			index += 1;
			continue;
		};
		if literal_start < index {
			parts.push((None, &text[literal_start..index]));
		}
		parts.push((Some(name), &text[index..end]));
		index = end;
		literal_start = end;
	}
	if literal_start < text.len() {
		parts.push((None, &text[literal_start..]));
	}
	parts
}

/// Parse one dollar-NAME or brace form reference starting at start.
fn parse_reference(text: &str, start: usize) -> Option<(String, usize)> {
	let bytes = text.as_bytes();
	let mut index = start + 1;
	if index >= bytes.len() {
		return None;
	}
	if bytes[index] == b'{' {
		index += 1;
		let name_start = index;
		while index < bytes.len() && bytes[index] != b'}' {
			if !is_name_byte(bytes[index]) {
				return None;
			}
			index += 1;
		}
		if index >= bytes.len() || index == name_start {
			return None;
		}
		let name = &text[name_start..index];
		if !starts_name(name) {
			return None;
		}
		return Some((name.to_string(), index + 1));
	}
	let name_start = index;
	while index < bytes.len() && is_name_byte(bytes[index]) {
		index += 1;
	}
	if index == name_start {
		return None;
	}
	let name = &text[name_start..index];
	if !starts_name(name) {
		return None;
	}
	Some((name.to_string(), index))
}

fn is_name_byte(byte: u8) -> bool {
	byte.is_ascii_alphanumeric() || byte == b'_'
}

fn starts_name(name: &str) -> bool {
	name.as_bytes()
		.first()
		.is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
}

/// Replace references, honouring the optional SHELL-FORMAT filter.
fn substitute(input: &str, allowed: &BTreeSet<String>, filtered: bool, host: &Host) -> String {
	let mut out = String::with_capacity(input.len());
	for (name, span) in references(input) {
		let Some(name) = name else {
			out.push_str(span);
			continue;
		};
		let substitute_this = !filtered || allowed.contains(&name);
		if substitute_this {
			out.push_str(host.var(&name).unwrap_or(""));
		} else {
			out.push_str(span);
		}
	}
	out
}

fn app() -> Command {
	Command::new("envsubst")
		.disable_help_flag(true)
		.disable_version_flag(true)
		.version("0.24")
		.about("Substitute environment variables in shell-format text")
		.arg(
			Arg::new("help")
				.short('h')
				.long("help")
				.action(ArgAction::SetTrue)
				.help("display this help and exit"),
		)
		.arg(
			Arg::new("version")
				.short('V')
				.long("version")
				.action(ArgAction::SetTrue)
				.help("output version information and exit"),
		)
		.arg(
			Arg::new("variables")
				.short('v')
				.long("variables")
				.action(ArgAction::SetTrue)
				.help("list the variables referenced in SHELL-FORMAT"),
		)
		.arg(
			Arg::new("FORMAT")
				.value_name("SHELL-FORMAT")
				.help("only substitute variables referenced in this string"),
		)
}


#[cfg(test)]
mod tests {
	use tempfile::tempdir;

	use crate::host::{run_script, run_util};

	use super::Envsubst;

	fn run(args: &[&str], stdin: &str) -> (i32, String, String) {
		let dir = tempdir().unwrap();
		let (code, capture) = run_util::<Envsubst>(args, stdin, dir.path());
		(code, capture.out(), capture.err())
	}

	#[tokio::test]
	async fn substitutes_plain_and_braced_references() {
		// run_util builds an in-memory host without a shell environment, so the
		// environment-backed cases go through a real shell.
		unsafe {
			std::env::set_var("PI_ENVSUBST_A", "alpha");
			std::env::set_var("PI_ENVSUBST_B", "beta");
		}
		let dir = tempdir().unwrap();
		let script = "printf 'a=$PI_ENVSUBST_A b=${PI_ENVSUBST_B}\\n' | envsubst";
		let (code, out, err) = run_script(script, "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "a=alpha b=beta\n");
	}

	#[tokio::test]
	async fn shell_format_limits_which_references_are_substituted() {
		unsafe {
			std::env::set_var("PI_ENVSUBST_A", "alpha");
			std::env::set_var("PI_ENVSUBST_B", "beta");
		}
		let dir = tempdir().unwrap();
		let script = "printf 'a=$PI_ENVSUBST_A b=$PI_ENVSUBST_B\\n' | envsubst '$PI_ENVSUBST_A'";
		let (code, out, err) = run_script(script, "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "a=alpha b=$PI_ENVSUBST_B\n");
	}

	#[test]
	fn unset_references_become_empty() {
		let (code, out, _) = run(&[], "x=$PI_ENVSUBST_DEFINITELY_UNSET y\n");
		assert_eq!(code, 0);
		assert_eq!(out, "x= y\n");
	}

	#[test]
	fn variables_lists_unique_names_in_order() {
		let (code, out, _) = run(&["-v", "$PI_ENVSUBST_B $PI_ENVSUBST_A $PI_ENVSUBST_B"], "");
		assert_eq!(code, 0);
		assert_eq!(out, "PI_ENVSUBST_B\nPI_ENVSUBST_A\n");
	}

	#[test]
	fn non_variable_dollars_stay_literal() {
		let (code, out, _) = run(&[], "$ $1 $- ${} ${1}\n");
		assert_eq!(code, 0);
		assert_eq!(out, "$ $1 $- ${} ${1}\n");
	}

	#[test]
	fn variables_without_format_fails() {
		let (code, _, err) = run(&["-v"], "");
		assert_eq!(code, 1);
		assert!(err.contains("SHELL-FORMAT"), "{err}");
	}

	#[test]
	fn unterminated_brace_is_left_alone() {
		let (code, out, _) = run(&[], "${PI_ENVSUBST_A\n");
		assert_eq!(code, 0);
		assert_eq!(out, "${PI_ENVSUBST_A\n");
	}
}
