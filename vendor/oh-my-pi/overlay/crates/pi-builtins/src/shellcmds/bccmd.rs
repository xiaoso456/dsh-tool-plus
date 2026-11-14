//! bc builtin: arbitrary-precision decimal calculator.
//!
//! Windows has no bc at all (Git Bash does not ship it), and shell scripts
//! use it for arithmetic. The implementation covers the expression language,
//! variables, special variables (scale/ibase/obase), print/quit statements,
//! the -l math library, control flow (if/while/for/break/continue), functions
//! with autos and array parameters, and arrays.

use std::{
	collections::HashMap,
	io::{BufWriter, Read, Write},
	path::PathBuf,
};

use bigdecimal::{BigDecimal, FromPrimitive, One, Signed, ToPrimitive, Zero};
use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use num_bigint::BigInt;

use crate::host::{Host, Utility, matches_parser, util};

/// Compute-or-print calculator; see docs/shell-commands/bc.md.
/// Safety guard: the builtin shares memory with the host process (unlike a
/// standalone bc binary), so scale is capped at a practical value.
const MAX_SCALE: i64 = 1_000_000;
/// GNU bc's BC_BASE_MAX is INT_MAX in the 1.07.1 build.
const MAX_OBASE: i64 = i32::MAX as i64;
/// GNU bc only caps ibase at 36 in non-standard mode.
const MAX_IBASE: i64 = 36;
/// POSIX limits ibase to 16.
const STANDARD_MAX_IBASE: i64 = 16;

pub(crate) struct Bc {
	matches: ArgMatches,
}

matches_parser!(Bc, app);

impl Utility for Bc {
	const NAME: &'static str = "bc";

	fn run(self, host: &mut Host) -> i32 {
		if self.matches.get_flag("version") || self.matches.get_flag("version-alias") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = writeln!(out, "bc 1.07.1 (pi-builtins)");
			let _ = out.flush();
			return 0;
		}
		if self.matches.get_flag("help") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = write!(out, "{}", app().render_help());
			let _ = out.flush();
			return 0;
		}
		let options = Options::from_matches(&self.matches, host);
		run(host, &options)
	}
}

pub(crate) fn bc_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Bc, SE>()
}

struct Options {
	mathlib: bool,
	/// Output line width; 0 disables GNU bc's backslash continuation.
	line_length: usize,
	quiet: bool,
	standard: bool,
	warn: bool,
	files: Vec<PathBuf>,
}

impl Options {
	fn from_matches(matches: &ArgMatches, host: &Host) -> Self {
		let (env_mathlib, env_quiet, env_standard, env_warn) = environment_flags(host);
		Self {
			mathlib: matches.get_flag("mathlib") || env_mathlib,
			line_length: match host
				.var("BC_LINE_LENGTH")
				.and_then(|value| value.trim().parse::<usize>().ok())
			{
				Some(0) => 0,
				Some(length) if length >= 3 => length,
				_ => 70,
			},
			quiet: matches.get_flag("quiet") || env_quiet,
			standard: matches.get_flag("standard")
				|| env_standard
				|| host.var("POSIXLY_CORRECT").is_some(),
			warn: matches.get_flag("warn") || env_warn,
			files: matches
				.get_many::<std::ffi::OsString>("FILE")
				.map(|values| {
					values
						.map(|value| {
							let path = PathBuf::from(value);
							if path.is_relative() { host.cwd().join(path) } else { path }
						})
						.collect()
				})
				.unwrap_or_default(),
		}
	}
}

/// Options from GNU bc's BC_ENV_ARGS (short and long spellings).
fn environment_flags(host: &Host) -> (bool, bool, bool, bool) {
	let mut mathlib = false;
	let mut quiet = false;
	let mut standard = false;
	let mut warn = false;
	if let Some(value) = host.var("BC_ENV_ARGS") {
		for token in value.split_whitespace() {
			if let Some(long) = token.strip_prefix("--") {
				match long {
					"mathlib" => mathlib = true,
					"quiet" => quiet = true,
					"standard" => standard = true,
					"warn" => warn = true,
					_ => {},
				}
			} else if let Some(short) = token.strip_prefix('-') {
				for character in short.chars() {
					match character {
						'l' => mathlib = true,
						'q' => quiet = true,
						's' => standard = true,
						'w' => warn = true,
						_ => {},
					}
				}
			}
		}
	}
	(mathlib, quiet, standard, warn)
}

fn run(host: &mut Host, options: &Options) -> i32 {
	let mut source = String::new();
	let mut input = String::new();
	if options.files.is_empty() {
		if let Err(error) = host.stdin.read_to_string(&mut source) {
			host.error(format!("{error}"), 1);
			return 1;
		}
	} else {
		for path in &options.files {
			match std::fs::read_to_string(path) {
				Ok(text) => {
					source.push_str(&text);
					source.push('\n');
				},
				Err(error) => {
					host.error(format!("{}: {}", path.display(), error), 1);
					return 1;
				},
			}
		}
		// read() takes its value from standard input; only drain it when the
		// program actually asks for one, so a plain "bc file" does not block.
		if source.contains("read(") {
			if let Err(error) = host.stdin.read_to_string(&mut input) {
				host.error(format!("{error}"), 1);
				return 1;
			}
		}
	}
	let _ = options.quiet;

	let program_name = options
		.files
		.first()
		.map(|path| path.display().to_string())
		.unwrap_or_else(|| "(standard_in)".to_string());
	let line_length = options.line_length;
	let mathlib = options.mathlib;
	let standard = options.standard;
	let warn = options.warn;

	// Recursion is part of the language, so the interpreter runs on a thread
	// with a generous stack instead of the caller's. Output and diagnostics are
	// buffered and written back on this thread.
	let machine = Machine::new(mathlib, input, line_length, !standard);
	let worker = std::thread::Builder::new()
		.name("bc".to_string())
		.stack_size(32 * 1024 * 1024)
		.spawn(move || interpret(machine, source, standard, warn, &program_name));
	let outcome = match worker {
		Ok(handle) => handle.join(),
		Err(error) => {
			host.error(format!("{error}"), 1);
			return 1;
		},
	};
	let Ok((output, diagnostics)) = outcome else {
		host.error("internal error", 1);
		return 1;
	};
	if !diagnostics.is_empty() {
		let mut err = BufWriter::new(host.stderr_clone());
		let _ = err.write_all(diagnostics.as_bytes());
		let _ = err.flush();
	}
	if !output.is_empty() {
		let mut out = BufWriter::new(host.stdout_clone());
		let _ = out.write_all(output.as_bytes());
		let _ = out.flush();
	}
	// GNU bc reports parse and runtime errors but still exits 0.
	0
}

/// Parse and execute one statement at a time. Like GNU bc, a parse or runtime
/// error abandons that statement and execution continues with the next one.
fn interpret(
	mut machine: Machine,
	source: String,
	standard: bool,
	warn: bool,
	program_name: &str,
) -> (String, String) {
	machine.standard = standard;
	machine.warn = warn;
	let tokens = match lex(&source) {
		Ok(tokens) => tokens,
		Err(message) => {
			machine.diagnostics.push_str(&format!("{program_name} 1: {message}\n"));
			return (machine.output, machine.diagnostics);
		},
	};
	let mut parser = Parser {
		tokens,
		index: 0,
		line: 1,
		loop_depth: 0,
		function_depth: 0,
		extensions: Vec::new(),
		errors: Vec::new(),
		illegal: false,
	};
	loop {
		parser.illegal = false;
		let seen = parser.extensions.len();
		let outcome = parser.parse_statement();
		let mut stop = false;
		match outcome {
			Ok(Some(statement)) => {
				let features: Vec<_> = parser.extensions.drain(seen..).collect();
				let mut blocked = false;
				for (line, feature) in features {
					if standard {
						machine
							.diagnostics
							.push_str(&format!("{program_name} {line}: Error: {feature}\n"));
						blocked = true;
					} else if warn {
						machine
							.diagnostics
							.push_str(&format!("{program_name} {line}: (Warning) {feature}\n"));
					}
				}
				if blocked {
					parser.skip_to_line_end();
				} else {
					match machine.execute(&statement) {
						Ok(Flow::Normal) => {},
						Ok(Flow::Break | Flow::Continue) => {
							machine.report_runtime_error("Break outside a for/while");
						},
						Ok(Flow::Return(_)) => {
							machine.report_runtime_error("Return from main program.");
						},
						Err(message) => machine.report_runtime_error(&message),
					}
					if machine.quitting {
						stop = true;
					}
				}
			},
			Ok(None) => stop = true,
			Err(message) => {
				// An illegal byte already reported its own diagnostic; the
				// syntax error it provokes is noise (GNU does the same).
				if !parser.illegal {
					let line = parser.line;
					machine.diagnostics.push_str(&format!("{program_name} {line}: {message}\n"));
				}
				parser.recover();
			},
		}
		for (line, message) in parser.errors.drain(..) {
			machine.diagnostics.push_str(&format!("{program_name} {line}: {message}\n"));
		}
		if stop {
			break;
		}
	}
	(machine.output, machine.diagnostics)
}


#[derive(Clone, Debug, PartialEq)]
enum Token {
	Number(String),
	Ident(String),
	String(String),
	Plus,
	PlusPlus,
	Minus,
	MinusMinus,
	Star,
	Slash,
	Percent,
	Caret,
	Assign,
	PlusAssign,
	MinusAssign,
	StarAssign,
	SlashAssign,
	PercentAssign,
	CaretAssign,
	Eq,
	Ne,
	Lt,
	Le,
	Gt,
	Ge,
	And,
	Or,
	Not,
	LParen,
	RParen,
	Comma,
	Semicolon,
	Newline,
	/// A byte the lexer could not tokenize; reported and skipped.
	Invalid(char),
	LBrace,
	RBrace,
	LBracket,
	RBracket,
}

fn lex(source: &str) -> Result<Vec<Token>, String> {
	let bytes = source.as_bytes();
	let mut tokens = Vec::new();
	let mut index = 0;
	while index < bytes.len() {
		let byte = bytes[index];
		match byte {
			b' ' | b'\t' | b'\r' => index += 1,
			b'\n' => {
				tokens.push(Token::Newline);
				index += 1;
			},
			b'\\' if bytes.get(index + 1) == Some(&b'\n') => index += 2,
			b'#' => {
				while index < bytes.len() && bytes[index] != b'\n' {
					index += 1;
				}
			},
			b'/' if bytes.get(index + 1) == Some(&b'*') => {
				index += 2;
				let mut closed = false;
				while index + 1 < bytes.len() {
					if bytes[index] == b'*' && bytes[index + 1] == b'/' {
						index += 2;
						closed = true;
						break;
					}
					index += 1;
				}
				if !closed {
					return Err("unterminated comment".to_string());
				}
			},
			b'0'..=b'9' | b'A'..=b'Z' => {
				let mut number = String::new();
				while index < bytes.len() {
					let byte = bytes[index];
					if matches!(byte, b'0'..=b'9' | b'A'..=b'Z') || byte == b'.' {
						number.push(byte as char);
						index += 1;
					} else if byte == b'\\' && bytes.get(index + 1) == Some(&b'\n') {
						// A backslash-newline is whitespace inside a number.
						index += 2;
					} else {
						break;
					}
				}
				tokens.push(Token::Number(number));
			},
			b'.' => {
				let mut number = String::new();
				number.push('.');
				index += 1;
				while index < bytes.len() {
					let byte = bytes[index];
					if matches!(byte, b'0'..=b'9' | b'A'..=b'Z') {
						number.push(byte as char);
						index += 1;
					} else if byte == b'\\' && bytes.get(index + 1) == Some(&b'\n') {
						index += 2;
					} else {
						break;
					}
				}
				tokens.push(Token::Number(number));
			},
			b'a'..=b'z' | b'_' => {
				let start = index;
				while index < bytes.len() && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_') {
					index += 1;
				}
				tokens.push(Token::Ident(source[start..index].to_string()));
			},
			b'"' => {
				let start = index + 1;
				index += 1;
				while index < bytes.len() && bytes[index] != b'"' {
					index += 1;
				}
				if index >= bytes.len() {
					return Err("unterminated string".to_string());
				}
				tokens.push(Token::String(source[start..index].to_string()));
				index += 1;
			},
			b'+' => {
				if bytes.get(index + 1) == Some(&b'+') {
					tokens.push(Token::PlusPlus);
					index += 2;
				} else if bytes.get(index + 1) == Some(&b'=') {
					tokens.push(Token::PlusAssign);
					index += 2;
				} else {
					tokens.push(Token::Plus);
					index += 1;
				}
			},
			b'-' => {
				if bytes.get(index + 1) == Some(&b'-') {
					tokens.push(Token::MinusMinus);
					index += 2;
				} else if bytes.get(index + 1) == Some(&b'=') {
					tokens.push(Token::MinusAssign);
					index += 2;
				} else {
					tokens.push(Token::Minus);
					index += 1;
				}
			},
			b'*' => {
				if bytes.get(index + 1) == Some(&b'=') {
					tokens.push(Token::StarAssign);
					index += 2;
				} else {
					tokens.push(Token::Star);
					index += 1;
				}
			},
			b'/' => {
				if bytes.get(index + 1) == Some(&b'=') {
					tokens.push(Token::SlashAssign);
					index += 2;
				} else {
					tokens.push(Token::Slash);
					index += 1;
				}
			},
			b'%' => {
				if bytes.get(index + 1) == Some(&b'=') {
					tokens.push(Token::PercentAssign);
					index += 2;
				} else {
					tokens.push(Token::Percent);
					index += 1;
				}
			},
			b'^' => {
				if bytes.get(index + 1) == Some(&b'=') {
					tokens.push(Token::CaretAssign);
					index += 2;
				} else {
					tokens.push(Token::Caret);
					index += 1;
				}
			},
			b'=' => {
				if bytes.get(index + 1) == Some(&b'=') {
					tokens.push(Token::Eq);
					index += 2;
				} else {
					tokens.push(Token::Assign);
					index += 1;
				}
			},
			b'!' => {
				if bytes.get(index + 1) == Some(&b'=') {
					tokens.push(Token::Ne);
					index += 2;
				} else {
					tokens.push(Token::Not);
					index += 1;
				}
			},
			b'<' => {
				if bytes.get(index + 1) == Some(&b'=') {
					tokens.push(Token::Le);
					index += 2;
				} else {
					tokens.push(Token::Lt);
					index += 1;
				}
			},
			b'>' => {
				if bytes.get(index + 1) == Some(&b'=') {
					tokens.push(Token::Ge);
					index += 2;
				} else {
					tokens.push(Token::Gt);
					index += 1;
				}
			},
			b'&' if bytes.get(index + 1) == Some(&b'&') => {
				tokens.push(Token::And);
				index += 2;
			},
			b'|' if bytes.get(index + 1) == Some(&b'|') => {
				tokens.push(Token::Or);
				index += 2;
			},
			b'(' => {
				tokens.push(Token::LParen);
				index += 1;
			},
			b')' => {
				tokens.push(Token::RParen);
				index += 1;
			},
			b',' => {
				tokens.push(Token::Comma);
				index += 1;
			},
			b';' => {
				tokens.push(Token::Semicolon);
				index += 1;
			},
			b'{' => {
				tokens.push(Token::LBrace);
				index += 1;
			},
			b'}' => {
				tokens.push(Token::RBrace);
				index += 1;
			},
			b'[' => {
				tokens.push(Token::LBracket);
				index += 1;
			},
			b']' => {
				tokens.push(Token::RBracket);
				index += 1;
			},
			other => {
				tokens.push(Token::Invalid(other as char));
				index += 1;
			},
		}
	}
	Ok(tokens)
}

#[derive(Clone, Debug)]
enum Expr {
	Number(String),
	Text(String),
	Paren(Box<Expr>),
	Var(String),
	Array(String, Box<Expr>),
	ArrayRef(String),
	Neg(Box<Expr>),
	Not(Box<Expr>),
	Binary(BinOp, Box<Expr>, Box<Expr>),
	Assign(LValue, AssignOp, Box<Expr>),
	Incr(LValue, bool, bool),
	Call(String, Vec<Expr>),
}

#[derive(Clone, Debug)]
enum LValue {
	Var(String),
	Array(String, Box<Expr>),
}

#[derive(Clone, Copy, Debug)]
enum BinOp {
	Add,
	Sub,
	Mul,
	Div,
	Mod,
	Pow,
	Eq,
	Ne,
	Lt,
	Le,
	Gt,
	Ge,
	And,
	Or,
}

#[derive(Clone, Copy, Debug)]
enum AssignOp {
	Set,
	Add,
	Sub,
	Mul,
	Div,
	Mod,
	Pow,
}

#[derive(Clone, Debug)]
enum Param {
	Scalar(String),
	Array { name: String, by_variable: bool },
}

#[derive(Clone, Debug)]
struct Function {
	name: String,
	is_void: bool,
	params: Vec<Param>,
	autos: Vec<Param>,
	body: Vec<Statement>,
}

#[derive(Clone, Debug)]
enum Statement {
	Expr(Expr),
	Print(Vec<Expr>),
	Quit,
	Text(String),
	Block(Vec<Statement>),
	If {
		condition: Expr,
		then_branch: Box<Statement>,
		else_branch: Option<Box<Statement>>,
	},
	While {
		condition: Expr,
		body: Box<Statement>,
	},
	For {
		init: Option<Expr>,
		condition: Option<Expr>,
		step: Option<Expr>,
		body: Box<Statement>,
	},
	Break,
	Continue,
	Return(Option<Expr>),
	Define(Function),
	Limits,
	Warranty,
}

#[derive(Clone, Debug)]
enum Flow {
	Normal,
	Break,
	Continue,
	Return(Option<BigDecimal>),
}

struct Parser {
	tokens: Vec<Token>,
	index: usize,
	line: usize,
	loop_depth: usize,
	function_depth: usize,
	/// Non-standard features seen while parsing, with their source line.
	extensions: Vec<(usize, String)>,
	/// Illegal characters met while advancing, with their source line.
	errors: Vec<(usize, String)>,
	/// Set when the current statement ran into an illegal character; the
	/// follow-up syntax error is then suppressed like GNU's error recovery.
	illegal: bool,
}

impl Parser {
	fn peek(&self) -> Option<&Token> {
		self.tokens.get(self.index)
	}

	fn advance(&mut self) -> Option<Token> {
		let token = self.tokens.get(self.index).cloned();
		if let Some(token) = &token {
			self.index += 1;
			match token {
				Token::Invalid(character) => {
					// GNU bc reports each illegal byte and keeps going, so the
					// token carries its diagnostic into the error path.
					self.errors.push((self.line, format!("illegal character: {character}")));
					self.illegal = true;
				},
				Token::Newline => self.line += 1,
				_ => {},
			}
		}
		token
	}

	fn skip_separators(&mut self) {
		while matches!(self.peek(), Some(Token::Newline) | Some(Token::Semicolon)) {
			self.advance();
		}
	}

	fn expect(&mut self, expected: &Token, what: &str) -> Result<(), String> {
		match self.advance() {
			Some(token) if &token == expected => Ok(()),
			Some(token) => Err(format!("expected {what}, found {token:?}")),
			None => Err(format!("expected {what}, found end of input")),
		}
	}

	fn note_extension(&mut self, feature: impl Into<String>) {
		self.extensions.push((self.line, feature.into()));
	}

	fn note_name(&mut self, name: &str) {
		if name.len() > 1
			&& !matches!(
				name,
				"scale" | "ibase" | "obase" | "last" | "read" | "sqrt" | "length"
			)
		{
			self.note_extension(format!("multiple letter name - {name}"));
		}
	}

	/// Skip the rest of the current line. GNU bc discards a whole execution
	/// block (everything up to the next end of line) when a standard-mode
	/// violation sets had_error.
	fn skip_to_line_end(&mut self) {
		while let Some(token) = self.peek() {
			let newline = matches!(token, Token::Newline);
			self.advance();
			if newline {
				break;
			}
		}
	}

	/// Skip to the next statement boundary after a parse error, like yacc's
	/// error ENDOFLINE recovery.
	fn recover(&mut self) {
		while let Some(token) = self.peek() {
			if matches!(token, Token::Newline | Token::Semicolon) {
				self.advance();
				break;
			}
			self.advance();
		}
		self.loop_depth = 0;
		self.function_depth = 0;
	}

	fn parse_statement(&mut self) -> Result<Option<Statement>, String> {
		self.skip_separators();
		let Some(token) = self.peek().cloned() else {
			return Ok(None);
		};
		match token {
			Token::LBrace => {
				self.advance();
				Ok(Some(Statement::Block(self.parse_block()?)))
			},
			Token::String(text) => {
				self.advance();
				Ok(Some(Statement::Text(text)))
			},
			Token::Ident(word) => match word.as_str() {
				"if" => {
					self.advance();
					Ok(Some(self.parse_if()?))
				},
				"while" => {
					self.advance();
					Ok(Some(self.parse_while()?))
				},
				"for" => {
					self.advance();
					Ok(Some(self.parse_for()?))
				},
				"break" => {
					self.advance();
					if self.loop_depth == 0 {
						return Err("Break outside a for/while".to_string());
					}
					Ok(Some(Statement::Break))
				},
				"continue" => {
					self.advance();
					self.note_extension("Continue statement");
					if self.loop_depth == 0 {
						return Err("Continue outside a for".to_string());
					}
					Ok(Some(Statement::Continue))
				},
				"return" => {
					self.advance();
					Ok(Some(self.parse_return()?))
				},
				"define" => {
					self.advance();
					Ok(Some(Statement::Define(self.parse_define()?)))
				},
				"quit" | "halt" => {
					let halt = word == "halt";
					self.advance();
					if halt {
						self.note_extension("halt");
					}
					Ok(Some(Statement::Quit))
				},
				"print" => {
					self.advance();
					self.note_extension("print statement");
					Ok(Some(Statement::Print(self.parse_print_list()?)))
				},
				"limits" => {
					self.advance();
					Ok(Some(Statement::Limits))
				},
				"warranty" => {
					self.advance();
					Ok(Some(Statement::Warranty))
				},
				"auto" => Err("auto is only allowed at the start of a function body".to_string()),
				_ => Ok(Some(self.parse_expression_statement()?)),
			},
			_ => Ok(Some(self.parse_expression_statement()?)),
		}
	}

	fn parse_expression_statement(&mut self) -> Result<Statement, String> {
		let expression = self.parse_expression()?;
		// GNU only flags comparisons that reach the statement; an assignment
		// clears the comparison bit.
		if !matches!(expression, Expr::Assign(..)) && contains_comparison(&expression) {
			self.note_extension("comparison in expression");
		}
		Ok(Statement::Expr(expression))
	}

	fn parse_block(&mut self) -> Result<Vec<Statement>, String> {
		let mut statements = Vec::new();
		loop {
			self.skip_separators();
			match self.peek() {
				Some(Token::RBrace) => {
					self.advance();
					return Ok(statements);
				},
				None => return Err("unterminated block".to_string()),
				_ => {},
			}
			let Some(statement) = self.parse_statement()? else {
				return Err("unterminated block".to_string());
			};
			statements.push(statement);
		}
	}

	fn parse_if(&mut self) -> Result<Statement, String> {
		self.expect(&Token::LParen, "'(' after if")?;
		let condition = self.parse_expression()?;
		self.expect(&Token::RParen, "')' after if condition")?;
		let then_branch = self.parse_statement()?.ok_or_else(|| "missing statement after if".to_string())?;
		self.skip_separators();
		let else_branch = if matches!(self.peek(), Some(Token::Ident(word)) if word == "else") {
			self.advance();
			self.note_extension("else clause in if statement");
			Some(Box::new(
				self.parse_statement()?.ok_or_else(|| "missing statement after else".to_string())?,
			))
		} else {
			None
		};
		Ok(Statement::If {
			condition,
			then_branch: Box::new(then_branch),
			else_branch,
		})
	}

	fn parse_while(&mut self) -> Result<Statement, String> {
		self.expect(&Token::LParen, "'(' after while")?;
		let condition = self.parse_expression()?;
		self.expect(&Token::RParen, "')' after while condition")?;
		self.loop_depth += 1;
		let body = self.parse_statement()?.ok_or_else(|| "missing statement after while".to_string())?;
		self.loop_depth -= 1;
		Ok(Statement::While {
			condition,
			body: Box::new(body),
		})
	}

	fn parse_for(&mut self) -> Result<Statement, String> {
		self.expect(&Token::LParen, "'(' after for")?;
		let init = if matches!(self.peek(), Some(Token::Semicolon)) {
			self.note_extension("Missing expression in for statement");
			None
		} else {
			Some(self.parse_expression()?)
		};
		if init.as_ref().is_some_and(contains_comparison) {
			self.note_extension("Comparison in first for expression");
		}
		self.expect(&Token::Semicolon, "';' after for initializer")?;
		let condition = if matches!(self.peek(), Some(Token::Semicolon)) {
			self.note_extension("Missing expression in for statement");
			None
		} else {
			Some(self.parse_expression()?)
		};
		self.expect(&Token::Semicolon, "';' after for condition")?;
		let step = if matches!(self.peek(), Some(Token::RParen)) {
			self.note_extension("Missing expression in for statement");
			None
		} else {
			Some(self.parse_expression()?)
		};
		if step.as_ref().is_some_and(contains_comparison) {
			self.note_extension("Comparison in third for expression");
		}
		self.expect(&Token::RParen, "')' after for clauses")?;
		self.loop_depth += 1;
		let body = self.parse_statement()?.ok_or_else(|| "missing statement after for".to_string())?;
		self.loop_depth -= 1;
		Ok(Statement::For {
			init,
			condition,
			step,
			body: Box::new(body),
		})
	}

	fn parse_return(&mut self) -> Result<Statement, String> {
		if self.function_depth == 0 {
			return Err("Return outside of a function.".to_string());
		}
		if matches!(self.peek(), None | Some(Token::Newline) | Some(Token::Semicolon) | Some(Token::RBrace)) {
			return Ok(Statement::Return(None));
		}
		if matches!(self.peek(), Some(Token::LParen)) {
			self.advance();
			let value = self.parse_expression()?;
			self.expect(&Token::RParen, "')' after return value")?;
			if contains_comparison(&value) {
				self.note_extension("comparison in return expresion");
			}
			return Ok(Statement::Return(Some(value)));
		}
		self.note_extension("return expression requires parenthesis");
		let value = self.parse_expression()?;
		if contains_comparison(&value) {
			self.note_extension("comparison in return expresion");
		}
		Ok(Statement::Return(Some(value)))
	}

	fn parse_define(&mut self) -> Result<Function, String> {
		let mut is_void = false;
		if matches!(self.peek(), Some(Token::Ident(word)) if word == "void") {
			self.advance();
			is_void = true;
			self.note_extension("void functions");
		}
		let name = match self.advance() {
			Some(Token::Ident(name)) => name,
			other => return Err(format!("expected function name, found {other:?}")),
		};
		self.note_name(&name);
		self.expect(&Token::LParen, "'(' after function name")?;
		let params = self.parse_parameter_list(&Token::RParen)?;
		self.expect(&Token::RParen, "')' after parameters")?;
		self.skip_separators();
		self.expect(&Token::LBrace, "'{' to start the function body")?;

		self.function_depth += 1;
		let mut autos = Vec::new();
		self.skip_separators();
		while matches!(self.peek(), Some(Token::Ident(word)) if word == "auto") {
			self.advance();
			autos.extend(self.parse_parameter_list(&Token::Semicolon)?);
			self.skip_separators();
		}

		let mut body = Vec::new();
		loop {
			self.skip_separators();
			match self.peek() {
				Some(Token::RBrace) => {
					self.advance();
					break;
				},
				None => return Err("unterminated function body".to_string()),
				_ => {},
			}
			if matches!(self.peek(), Some(Token::Ident(word)) if word == "auto") {
				return Err("auto must appear before any other statement".to_string());
			}
			let Some(statement) = self.parse_statement()? else {
				return Err("unterminated function body".to_string());
			};
			body.push(statement);
		}

		self.function_depth -= 1;
		Ok(Function {
			name,
			is_void,
			params,
			autos,
			body,
		})
	}

	fn parse_parameter_list(&mut self, terminator: &Token) -> Result<Vec<Param>, String> {
		let mut params = Vec::new();
		if matches!(self.peek(), Some(token) if token == terminator) {
			return Ok(params);
		}
		loop {
			let by_variable = if matches!(self.peek(), Some(Token::Star)) {
				self.advance();
				true
			} else {
				false
			};
			let name = match self.advance() {
				Some(Token::Ident(name)) => name,
				other => return Err(format!("expected parameter name, found {other:?}")),
			};
			self.note_name(&name);
			if by_variable {
				self.note_extension("Call by variable arrays");
			}
			if matches!(self.peek(), Some(Token::LBracket)) {
				self.advance();
				self.expect(&Token::RBracket, "']' after '['")?;
				params.push(Param::Array { name, by_variable });
			} else if by_variable {
				return Err(format!("'*{name}' must be declared as an array (*{name}[])"));
			} else {
				params.push(Param::Scalar(name));
			}
			if matches!(self.peek(), Some(Token::Comma)) {
				self.advance();
				continue;
			}
			break;
		}
		Ok(params)
	}

	fn parse_print_list(&mut self) -> Result<Vec<Expr>, String> {
		let mut items = Vec::new();
		loop {
			if matches!(self.peek(), None | Some(Token::Newline) | Some(Token::Semicolon) | Some(Token::RBrace)) {
				break;
			}
			if matches!(self.peek(), Some(Token::String(_))) {
				let Some(Token::String(text)) = self.advance() else {
					unreachable!();
				};
				items.push(Expr::Text(text));
			} else {
				items.push(self.parse_expression()?);
			}
			if matches!(self.peek(), Some(Token::Comma)) {
				self.advance();
				continue;
			}
			break;
		}
		Ok(items)
	}

	fn parse_expression(&mut self) -> Result<Expr, String> {
		self.parse_assignment()
	}

	fn parse_assignment(&mut self) -> Result<Expr, String> {
		let left = self.parse_or()?;
		let operation = match self.peek() {
			Some(Token::Assign) => Some(AssignOp::Set),
			Some(Token::PlusAssign) => Some(AssignOp::Add),
			Some(Token::MinusAssign) => Some(AssignOp::Sub),
			Some(Token::StarAssign) => Some(AssignOp::Mul),
			Some(Token::SlashAssign) => Some(AssignOp::Div),
			Some(Token::PercentAssign) => Some(AssignOp::Mod),
			Some(Token::CaretAssign) => Some(AssignOp::Pow),
			_ => None,
		};
		let Some(operation) = operation else {
			return Ok(left);
		};
		let target = lvalue_of(left)
			.map_err(|_| "assignment target must be a variable or an array element".to_string())?;
		self.advance();
		let value = self.parse_assignment()?;
		Ok(Expr::Assign(target, operation, Box::new(value)))
	}

	fn parse_or(&mut self) -> Result<Expr, String> {
		let mut left = self.parse_and()?;
		while matches!(self.peek(), Some(Token::Or)) {
			self.advance();
			self.note_extension("|| operator");
			let right = self.parse_and()?;
			left = Expr::Binary(BinOp::Or, Box::new(left), Box::new(right));
		}
		Ok(left)
	}

	fn parse_and(&mut self) -> Result<Expr, String> {
		let mut left = self.parse_comparison()?;
		while matches!(self.peek(), Some(Token::And)) {
			self.advance();
			self.note_extension("&& operator");
			let right = self.parse_comparison()?;
			left = Expr::Binary(BinOp::And, Box::new(left), Box::new(right));
		}
		Ok(left)
	}

	fn parse_comparison(&mut self) -> Result<Expr, String> {
		let mut left = self.parse_additive()?;
		loop {
			let operation = match self.peek() {
				Some(Token::Eq) => BinOp::Eq,
				Some(Token::Ne) => BinOp::Ne,
				Some(Token::Lt) => BinOp::Lt,
				Some(Token::Le) => BinOp::Le,
				Some(Token::Gt) => BinOp::Gt,
				Some(Token::Ge) => BinOp::Ge,
				_ => break,
			};
			self.advance();
			let right = self.parse_additive()?;
			left = Expr::Binary(operation, Box::new(left), Box::new(right));
		}
		Ok(left)
	}

	fn parse_additive(&mut self) -> Result<Expr, String> {
		let mut left = self.parse_multiplicative()?;
		loop {
			let operation = match self.peek() {
				Some(Token::Plus) => BinOp::Add,
				Some(Token::Minus) => BinOp::Sub,
				_ => break,
			};
			self.advance();
			let right = self.parse_multiplicative()?;
			left = Expr::Binary(operation, Box::new(left), Box::new(right));
		}
		Ok(left)
	}

	fn parse_multiplicative(&mut self) -> Result<Expr, String> {
		let mut left = self.parse_unary()?;
		loop {
			let operation = match self.peek() {
				Some(Token::Star) => BinOp::Mul,
				Some(Token::Slash) => BinOp::Div,
				Some(Token::Percent) => BinOp::Mod,
				_ => break,
			};
			self.advance();
			let right = self.parse_unary()?;
			left = Expr::Binary(operation, Box::new(left), Box::new(right));
		}
		Ok(left)
	}

	fn parse_unary(&mut self) -> Result<Expr, String> {
		match self.peek() {
			Some(Token::Minus) => {
				self.advance();
				Ok(Expr::Neg(Box::new(self.parse_unary()?)))
			},
			Some(Token::Not) => {
				self.advance();
				self.note_extension("! operator");
				Ok(Expr::Not(Box::new(self.parse_unary()?)))
			},
			Some(Token::Plus) => {
				self.advance();
				self.parse_unary()
			},
			Some(Token::PlusPlus) => {
				self.advance();
				let target = self.parse_lvalue()?;
				Ok(Expr::Incr(target, true, true))
			},
			Some(Token::MinusMinus) => {
				self.advance();
				let target = self.parse_lvalue()?;
				Ok(Expr::Incr(target, false, true))
			},
			_ => self.parse_power(),
		}
	}

	fn parse_lvalue(&mut self) -> Result<LValue, String> {
		match self.advance() {
			Some(Token::Ident(name)) => {
				if name == "last" {
					self.note_extension("Last variable");
				} else {
					self.note_name(&name);
				}
				if matches!(self.peek(), Some(Token::LBracket)) {
					self.advance();
					let index = self.parse_expression()?;
					if contains_comparison(&index) {
						self.note_extension("comparison in subscript");
					}
					self.expect(&Token::RBracket, "']' after array index")?;
					Ok(LValue::Array(name, Box::new(index)))
				} else {
					Ok(LValue::Var(name))
				}
			},
			Some(Token::LParen) => {
				let value = self.parse_expression()?;
				self.expect(&Token::RParen, "')'")?;
				lvalue_of(value)
			},
			other => Err(format!("expected assignment target, found {other:?}")),
		}
	}

	fn parse_power(&mut self) -> Result<Expr, String> {
		let base = self.parse_postfix()?;
		if matches!(self.peek(), Some(Token::Caret)) {
			self.advance();
			let exponent = self.parse_unary()?;
			return Ok(Expr::Binary(BinOp::Pow, Box::new(base), Box::new(exponent)));
		}
		Ok(base)
	}

	fn parse_postfix(&mut self) -> Result<Expr, String> {
		let primary = self.parse_primary()?;
		match self.peek() {
			Some(Token::PlusPlus) => {
				self.advance();
				let target = lvalue_of(primary)?;
				Ok(Expr::Incr(target, true, false))
			},
			Some(Token::MinusMinus) => {
				self.advance();
				let target = lvalue_of(primary)?;
				Ok(Expr::Incr(target, false, false))
			},
			_ => Ok(primary),
		}
	}

	fn parse_primary(&mut self) -> Result<Expr, String> {
		// Do not consume the newline on an incomplete expression: the error
		// recovery relies on it to find the next statement boundary.
		if matches!(self.peek(), Some(Token::Newline)) {
			return Err("unexpected end of line".to_string());
		}
		match self.advance() {
			Some(Token::Number(text)) => Ok(Expr::Number(text)),
			Some(Token::String(text)) => Ok(Expr::Text(text)),
			Some(Token::Ident(name)) => {
				if name == "last" {
					self.note_extension("Last variable");
				} else {
					self.note_name(&name);
				}
				if matches!(self.peek(), Some(Token::LParen)) {
					self.advance();
					if name == "read" {
						self.note_extension("read function");
					}
					let mut arguments = Vec::new();
					if !matches!(self.peek(), Some(Token::RParen)) {
						loop {
							arguments.push(self.parse_argument()?);
							if matches!(self.peek(), Some(Token::Comma)) {
								self.advance();
								continue;
							}
							break;
						}
					}
					match self.advance() {
						Some(Token::RParen) => Ok(Expr::Call(name, arguments)),
						_ => Err("expected ')'".to_string()),
					}
				} else if matches!(self.peek(), Some(Token::LBracket)) {
					self.advance();
					if matches!(self.peek(), Some(Token::RBracket)) {
						self.advance();
						return Ok(Expr::ArrayRef(name));
					}
					let index = self.parse_expression()?;
					if contains_comparison(&index) {
						self.note_extension("comparison in subscript");
					}
					self.expect(&Token::RBracket, "']' after array index")?;
					Ok(Expr::Array(name, Box::new(index)))
				} else {
					Ok(Expr::Var(name))
				}
			},
			Some(Token::LParen) => {
				let value = self.parse_expression()?;
				match self.advance() {
					Some(Token::RParen) => Ok(Expr::Paren(Box::new(value))),
					_ => Err("expected ')'".to_string()),
				}
			},
			Some(Token::Invalid(character)) => Err(format!("illegal character: {character}")),
			Some(token) => Err(format!("unexpected token: {token:?}")),
			None => Err("unexpected end of input".to_string()),
		}
	}

	fn parse_argument(&mut self) -> Result<Expr, String> {
		if let Some(Token::Ident(name)) = self.peek().cloned()
			&& matches!(self.tokens.get(self.index + 1), Some(Token::LBracket))
			&& matches!(self.tokens.get(self.index + 2), Some(Token::RBracket))
		{
			self.index += 3;
			return Ok(Expr::ArrayRef(name));
		}
		let argument = self.parse_expression()?;
		if contains_comparison(&argument) {
			self.note_extension("comparison in argument");
		}
		Ok(argument)
	}
}

fn lvalue_of(expression: Expr) -> Result<LValue, String> {
	match expression {
		Expr::Paren(inner) => lvalue_of(*inner),
		Expr::Var(name) => Ok(LValue::Var(name)),
		Expr::Array(name, index) => Ok(LValue::Array(name, index)),
		_ => Err("increment target must be a variable or an array element".to_string()),
	}
}

/// GNU's EX_COMP bit: a comparison somewhere inside the expression. It is
/// cleared by assignment but survives arithmetic and parentheses.
fn contains_comparison(expression: &Expr) -> bool {
	match expression {
		Expr::Binary(operation, left, right) => {
			matches!(
				operation,
				BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge
			) || contains_comparison(left)
				|| contains_comparison(right)
		},
		Expr::Assign(_, _, value) => contains_comparison(value),
		Expr::Neg(inner) | Expr::Not(inner) | Expr::Paren(inner) => contains_comparison(inner),
		Expr::Array(_, index) => contains_comparison(index),
		Expr::Call(_, arguments) => arguments.iter().any(contains_comparison),
		Expr::Incr(..) | Expr::Number(_) | Expr::Text(_) | Expr::Var(_) | Expr::ArrayRef(_) => false,
	}
}

type ArrayValue = HashMap<i64, BigDecimal>;

struct Frame {
	name: String,
	saved_scalars: Vec<(String, Option<BigDecimal>)>,
	saved_arrays: Vec<(String, Option<ArrayValue>)>,
	aliases: HashMap<String, String>,
	captured_ibase: u32,
}

struct Machine {
	variables: HashMap<String, BigDecimal>,
	arrays: HashMap<String, ArrayValue>,
	functions: HashMap<String, Function>,
	frames: Vec<Frame>,
	scale: i64,
	ibase: u32,
	obase: u32,
	mathlib: bool,
	loop_depth: usize,
	void_result: bool,
	quitting: bool,
	ibase_override: Option<u32>,
	input: std::vec::IntoIter<String>,
	last: BigDecimal,
	output: String,
	diagnostics: String,
	error_function: Option<String>,
	line_length: usize,
	column: usize,
	wrap_strings: bool,
	/// -s / POSIXLY_CORRECT: extensions are errors and skip the line.
	standard: bool,
	/// -w: warn about non-standard features.
	warn: bool,
}

impl Machine {
	fn new(mathlib: bool, input: String, line_length: usize, wrap_strings: bool) -> Self {
		Self {
			variables: HashMap::new(),
			arrays: HashMap::new(),
			functions: HashMap::new(),
			frames: Vec::new(),
			scale: if mathlib { 20 } else { 0 },
			ibase: 10,
			obase: 10,
			mathlib,
			loop_depth: 0,
			void_result: false,
			quitting: false,
			ibase_override: None,
			last: BigDecimal::zero(),
			input: input.lines().map(str::to_string).collect::<Vec<_>>().into_iter(),
			output: String::new(),
			diagnostics: String::new(),
			error_function: None,
			line_length,
			column: 0,
			wrap_strings,
			standard: false,
			warn: false,
		}
	}

	/// GNU bc's out_char: wrap long lines with a trailing backslash.
	fn emit(&mut self, text: &str) {
		for character in text.chars() {
			if character == '\n' {
				self.column = 0;
				self.output.push('\n');
				continue;
			}
			self.column += 1;
			if self.line_length != 0 && self.column == self.line_length - 1 {
				self.output.push('\\');
				self.output.push('\n');
				self.column = 1;
			}
			self.output.push(character);
		}
	}

	fn emit_number(&mut self, text: &str) {
		self.emit(text);
	}

	fn emit_string(&mut self, text: &str) {
		if self.wrap_strings {
			self.emit(text);
			return;
		}
		// POSIX mode does not break strings, but newlines still reset the
		// output column (GNU out_schar).
		for character in text.chars() {
			if character == '\n' {
				self.column = 0;
			}
			self.output.push(character);
		}
	}

	fn current_function(&self) -> &str {
		self.frames.last().map(|frame| frame.name.as_str()).unwrap_or("(main)")
	}

	fn report_runtime_error(&mut self, message: &str) {
		let function = self
			.error_function
			.take()
			.unwrap_or_else(|| self.current_function().to_string());
		self.diagnostics
			.push_str(&format!("Runtime error (func={function}, adr=0): {message}\n"));
	}

	fn report_runtime_warning(&mut self, message: &str) {
		let function = self.current_function().to_string();
		self.diagnostics
			.push_str(&format!("Runtime warning (func={function}, adr=0): {message}\n"));
	}

	fn execute(&mut self, statement: &Statement) -> Result<Flow, String> {
		match statement {
			Statement::Quit => {
				self.quitting = true;
			},
			Statement::Text(text) => {
				self.emit_string(&unescape_string(text));
				self.emit_string("\n");
			},
			Statement::Print(items) => {
				for item in items {
					match item {
						Expr::Text(text) => self.emit_string(&unescape_string(text)),
						expression => {
							let value = self.eval(expression)?;
							let rendered = self.render(&value);
							self.emit_number(&rendered);
							self.last = value;
						},
					}
				}
			},
			Statement::Expr(expression) => {
				self.void_result = false;
				let value = self.eval(expression)?;
				if !self.void_result && !matches!(expression, Expr::Assign(..)) {
					let rendered = self.render(&value);
					self.emit_number(&rendered);
					self.emit_number("\n");
					self.last = value;
				}
			},
			Statement::Block(statements) => {
				for statement in statements {
					match self.execute(statement)? {
						Flow::Normal => {},
						other => return Ok(other),
					}
					if self.quitting {
						break;
					}
				}
			},
			Statement::If { condition, then_branch, else_branch } => {
				let condition = self.eval(condition)?;
				if !condition.is_zero() {
					return self.execute(then_branch);
				} else if let Some(else_branch) = else_branch {
					return self.execute(else_branch);
				}
			},
			Statement::While { condition, body } => {
				self.loop_depth += 1;
				let mut flow = Flow::Normal;
				loop {
					if self.quitting {
						break;
					}
					let condition = self.eval(condition)?;
					if condition.is_zero() {
						break;
					}
					match self.execute(body)? {
						Flow::Normal | Flow::Continue => {},
						Flow::Break => break,
						other => {
							flow = other;
							break;
						},
					}
				}
				self.loop_depth -= 1;
				return Ok(flow);
			},
			Statement::For { init, condition, step, body } => {
				if let Some(init) = init {
					self.eval(init)?;
				}
				self.loop_depth += 1;
				let mut flow = Flow::Normal;
				loop {
					if self.quitting {
						break;
					}
					if let Some(condition) = condition {
						let value = self.eval(condition)?;
						if value.is_zero() {
							break;
						}
					}
					match self.execute(body)? {
						Flow::Normal | Flow::Continue => {},
						Flow::Break => break,
						other => {
							flow = other;
							break;
						},
					}
					if let Some(step) = step {
						self.eval(step)?;
					}
				}
				self.loop_depth -= 1;
				return Ok(flow);
			},
			Statement::Break => {
				if self.loop_depth == 0 {
					return Err("break outside a loop".to_string());
				}
				return Ok(Flow::Break);
			},
			Statement::Continue => {
				if self.loop_depth == 0 {
					return Err("continue outside a loop".to_string());
				}
				return Ok(Flow::Continue);
			},
			Statement::Return(expression) => {
				if self.frames.is_empty() {
					return Err("return outside a function".to_string());
				}
				let value = match expression {
					Some(expression) => Some(self.eval(expression)?),
					None => None,
				};
				return Ok(Flow::Return(value));
			},
			Statement::Define(function) => {
				self.functions.insert(function.name.clone(), function.clone());
			},
			Statement::Warranty => {
				self.output.push_str("\nbc 1.07.1 (pi-builtins)\n");
				self.output.push_str(
					"\n    This program is free software; you can redistribute it and/or modify\n    it under the terms of the GNU General Public License as published by\n    the Free Software Foundation; either version 3 of the License , or\n    (at your option) any later version.\n\n    This program is distributed in the hope that it will be useful,\n    but WITHOUT ANY WARRANTY; without even the implied warranty of\n    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the\n    GNU General Public License for more details.\n\n    You should have received a copy of the GNU General Public License\n    along with this program. If not, write to\n\n       The Free Software Foundation, Inc.\n       51 Franklin Street, Fifth Floor\n       Boston, MA 02110-1335  USA\n\n",
				);
			},
			Statement::Limits => {
				self.output.push_str("BC_BASE_MAX     = 2147483647\n");
				self.output.push_str("BC_DIM_MAX      = 65535\n");
				self.output.push_str("BC_SCALE_MAX    = 1000000\n");
				self.output.push_str("BC_STRING_MAX   = unlimited\n");
				self.output.push_str("MAX Exponent    = 9223372036854775807\n");
				self.output.push_str("Number of vars  = unlimited\n");
			},
		}
		Ok(Flow::Normal)
	}

	fn eval(&mut self, expression: &Expr) -> Result<BigDecimal, String> {
		match expression {
			Expr::Number(text) => self.parse_number(text),
			Expr::Paren(inner) => self.eval(inner),
			Expr::Text(text) => Err(format!("unexpected string in expression: {text}")),
			Expr::Var(name) => self.read_variable(name),
			Expr::ArrayRef(name) => Err(format!("array '{name}' used as a scalar")),
			Expr::Array(name, index) => {
				let index = self.eval(index)?;
				self.read_array_element(name, &index)
			},
			Expr::Neg(inner) => Ok(-self.eval_operand(inner)?),
			Expr::Not(inner) => {
				let value = self.eval_operand(inner)?;
				Ok(if value.is_zero() { BigDecimal::one() } else { BigDecimal::zero() })
			},
			Expr::Binary(operation, left, right) => self.eval_binary(*operation, left, right),
			Expr::Assign(target, operation, value) => {
				let value = self.eval_operand(value)?;
				let assigned = match operation {
					AssignOp::Set => value,
					AssignOp::Add => self.read_lvalue(target)? + value,
					AssignOp::Sub => self.read_lvalue(target)? - value,
					AssignOp::Mul => self.read_lvalue(target)? * value,
					AssignOp::Div => {
						let current = self.read_lvalue(target)?;
						self.divide(&current, &value)?
					},
					AssignOp::Mod => {
						let current = self.read_lvalue(target)?;
						self.modulo(&current, &value)?
					},
					AssignOp::Pow => {
						let current = self.read_lvalue(target)?;
						self.power(&current, &value)?
					},
				};
				self.write_lvalue(target, assigned.clone())?;
				Ok(assigned)
			},
			Expr::Incr(target, increment, prefix) => {
				let old = self.read_lvalue(target)?;
				let new = if *increment { &old + BigDecimal::one() } else { &old - BigDecimal::one() };
				self.write_lvalue(target, new.clone())?;
				Ok(if *prefix { new } else { old })
			},
			Expr::Call(name, arguments) => self.call(name, arguments),
		}
	}

	fn eval_operand(&mut self, expression: &Expr) -> Result<BigDecimal, String> {
		self.void_result = false;
		let value = self.eval(expression)?;
		if self.void_result {
			return Err("void function used as a value".to_string());
		}
		Ok(value)
	}

	fn eval_binary(&mut self, operation: BinOp, left: &Expr, right: &Expr) -> Result<BigDecimal, String> {
		if matches!(operation, BinOp::And) {
			let left_value = self.eval_operand(left)?;
			if left_value.is_zero() {
				return Ok(BigDecimal::zero());
			}
			return Ok(if self.eval_operand(right)?.is_zero() {
				BigDecimal::zero()
			} else {
				BigDecimal::one()
			});
		}
		if matches!(operation, BinOp::Or) {
			let left_value = self.eval_operand(left)?;
			if !left_value.is_zero() {
				return Ok(BigDecimal::one());
			}
			return Ok(if self.eval_operand(right)?.is_zero() {
				BigDecimal::zero()
			} else {
				BigDecimal::one()
			});
		}

		let left_value = self.eval_operand(left)?;
		let right_value = self.eval_operand(right)?;
		match operation {
			BinOp::Add => Ok(left_value + right_value),
			BinOp::Sub => Ok(left_value - right_value),
			BinOp::Mul => Ok(left_value * right_value),
			BinOp::Div => self.divide(&left_value, &right_value),
			BinOp::Mod => self.modulo(&left_value, &right_value),
			BinOp::Pow => self.power(&left_value, &right_value),
			BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge => {
				let truth = match operation {
					BinOp::Eq => left_value == right_value,
					BinOp::Ne => left_value != right_value,
					BinOp::Lt => left_value < right_value,
					BinOp::Le => left_value <= right_value,
					BinOp::Gt => left_value > right_value,
					BinOp::Ge => left_value >= right_value,
					_ => unreachable!(),
				};
				Ok(if truth { BigDecimal::one() } else { BigDecimal::zero() })
			},
			BinOp::And | BinOp::Or => unreachable!(),
		}
	}

	fn read_lvalue(&mut self, target: &LValue) -> Result<BigDecimal, String> {
		match target {
			LValue::Var(name) => self.read_variable(name),
			LValue::Array(name, index) => {
				let index = self.eval(index)?;
				self.read_array_element(name, &index)
			},
		}
	}

	fn write_lvalue(&mut self, target: &LValue, value: BigDecimal) -> Result<(), String> {
		match target {
			LValue::Var(name) => self.write_variable(name, value),
			LValue::Array(name, index) => {
				let index = self.eval(index)?;
				self.write_array_element(name, &index, value)
			},
		}
	}

	fn read_array_element(&self, name: &str, index: &BigDecimal) -> Result<BigDecimal, String> {
		let key = array_index(name, index)?;
		let resolved = self.resolve_array(name);
		Ok(self
			.arrays
			.get(&resolved)
			.and_then(|array| array.get(&key))
			.cloned()
			.unwrap_or_else(BigDecimal::zero))
	}

	fn write_array_element(&mut self, name: &str, index: &BigDecimal, value: BigDecimal) -> Result<(), String> {
		let key = array_index(name, index)?;
		let resolved = self.resolve_array(name);
		self.arrays.entry(resolved).or_default().insert(key, value);
		Ok(())
	}

	fn resolve_array(&self, name: &str) -> String {
		let mut current = name.to_string();
		for frame in self.frames.iter().rev() {
			if let Some(target) = frame.aliases.get(&current) {
				current = target.clone();
				continue;
			}
			let shadows = frame.saved_arrays.iter().any(|(name, _)| name == &current)
				|| frame.saved_scalars.iter().any(|(name, _)| name == &current);
			if shadows {
				break;
			}
		}
		current
	}

	fn read_variable(&self, name: &str) -> Result<BigDecimal, String> {
		match name {
			"scale" => Ok(BigDecimal::from(self.scale)),
			"ibase" => Ok(BigDecimal::from(self.ibase)),
			"obase" => Ok(BigDecimal::from(self.obase)),
			"last" => Ok(self.last.clone()),
			_ => Ok(self.variables.get(name).cloned().unwrap_or_else(BigDecimal::zero)),
		}
	}

	fn write_variable(&mut self, name: &str, value: BigDecimal) -> Result<(), String> {
		// GNU bc truncates special variable assignments toward zero and clamps
		// them with a runtime warning instead of failing.
		let truncated = truncate(&value, 0);
		let number = truncated.to_i64().unwrap_or(i64::MAX);
		match name {
			"scale" => {
				if value.is_negative() {
					self.report_runtime_warning("negative scale, set to 0");
					self.scale = 0;
				} else if number > MAX_SCALE {
					self.report_runtime_warning(&format!("scale too large, set to {MAX_SCALE}"));
					self.scale = MAX_SCALE;
				} else {
					self.scale = number;
				}
			},
			"ibase" => {
				let limit = if self.standard { STANDARD_MAX_IBASE } else { MAX_IBASE };
				if value.is_negative() {
					self.report_runtime_warning("negative ibase, set to 2");
					self.ibase = 2;
				} else if number < 2 {
					self.report_runtime_warning("ibase too small, set to 2");
					self.ibase = 2;
				} else if number > limit {
					self.report_runtime_warning(&format!("ibase too large, set to {limit}"));
					self.ibase = limit as u32;
				} else {
					if number >= STANDARD_MAX_IBASE && !self.standard && self.warn {
						self.report_runtime_warning("ibase larger than 16 is non-standard");
					}
					self.ibase = number as u32;
				}
			},
			"obase" => {
				if value.is_negative() {
					self.report_runtime_warning("negative obase, set to 2");
					self.obase = 2;
				} else if number < 2 {
					self.report_runtime_warning("obase too small, set to 2");
					self.obase = 2;
				} else if number > MAX_OBASE {
					self.report_runtime_warning(&format!("obase too large, set to {MAX_OBASE}"));
					self.obase = MAX_OBASE as u32;
				} else {
					self.obase = number as u32;
				}
			},
			"last" => {
				self.last = value;
			},
			_ => {
				self.variables.insert(name.to_string(), value);
			},
		}
		Ok(())
	}
	fn call(&mut self, name: &str, arguments: &[Expr]) -> Result<BigDecimal, String> {
		if let Some(function) = self.functions.get(name).cloned() {
			return self.invoke(function, arguments);
		}
		let mut values = Vec::with_capacity(arguments.len());
		for argument in arguments {
			if matches!(argument, Expr::ArrayRef(_)) {
				return Err(format!("builtin {name}() does not take array arguments"));
			}
			values.push(self.eval(argument)?);
		}
		match name {
			"sqrt" => {
				let [value] = values.as_slice() else {
					return Err("sqrt() takes one argument".to_string());
				};
				self.sqrt(value)
			},
			"length" => {
				let [value] = values.as_slice() else {
					return Err("length() takes one argument".to_string());
				};
				Ok(BigDecimal::from(length_of(value)))
			},
			"scale" => {
				let [value] = values.as_slice() else {
					return Err("scale() takes one argument".to_string());
				};
				Ok(BigDecimal::from(scale_of(value)))
			},
			"read" => {
				let Some(line) = self.input.next() else {
					return Ok(BigDecimal::zero());
				};
				let tokens = lex(&line)?;
				let mut parser = Parser {
					tokens,
					index: 0,
					line: 1,
					loop_depth: 0,
					function_depth: 0,
					extensions: Vec::new(),
					errors: Vec::new(),
					illegal: false,
				};
				let expression = parser.parse_expression()?;
				self.ibase_override = Some(self.ibase);
				let value = self.eval(&expression);
				self.ibase_override = None;
				value
			},
			_ if self.mathlib => self.math_function(name, &values),
			_ => Err(format!("Function {name} not defined.")),
		}
	}

	fn invoke(&mut self, function: Function, arguments: &[Expr]) -> Result<BigDecimal, String> {
		if arguments.len() != function.params.len() {
			return Err(format!(
				"{}() takes {} argument(s), got {}",
				function.name,
				function.params.len(),
				arguments.len()
			));
		}
		if self.frames.len() >= 1000 {
			return Err("recursion too deep".to_string());
		}

		#[derive(Clone)]
		enum Argument {
			Scalar(BigDecimal),
			ByValue(ArrayValue),
			ByReference(String),
		}

		let mut prepared = Vec::with_capacity(function.params.len());
		for (param, argument) in function.params.iter().zip(arguments) {
			match param {
				Param::Scalar(_) => {
					if matches!(argument, Expr::ArrayRef(_)) {
						return Err("array passed to a scalar parameter".to_string());
					}
					prepared.push(Argument::Scalar(self.eval(argument)?));
				},
				Param::Array { by_variable, .. } => {
					let Expr::ArrayRef(source) = argument else {
						return Err("array parameter expects an array argument".to_string());
					};
					let resolved = self.resolve_array(source);
					if *by_variable {
						prepared.push(Argument::ByReference(resolved));
					} else {
						let value = self.arrays.get(&resolved).cloned().unwrap_or_default();
						prepared.push(Argument::ByValue(value));
					}
				},
			}
		}

		let mut frame = Frame {
			name: function.name.clone(),
			saved_scalars: Vec::new(),
			saved_arrays: Vec::new(),
			aliases: HashMap::new(),
			captured_ibase: self.ibase,
		};
		for (param, value) in function.params.iter().zip(prepared) {
			match (param, value) {
				(Param::Scalar(name), Argument::Scalar(value)) => {
					let previous = self.variables.insert(name.clone(), value);
					frame.saved_scalars.push((name.clone(), previous));
				},
				(Param::Array { name, .. }, Argument::ByValue(value)) => {
					let previous = self.arrays.insert(name.clone(), value);
					frame.saved_arrays.push((name.clone(), previous));
				},
				(Param::Array { name, .. }, Argument::ByReference(target)) => {
					frame.aliases.insert(name.clone(), target);
				},
				_ => return Err("internal argument mismatch".to_string()),
			}
		}
		for auto in &function.autos {
			match auto {
				Param::Scalar(name) => {
					let previous = self.variables.insert(name.clone(), BigDecimal::zero());
					frame.saved_scalars.push((name.clone(), previous));
				},
				Param::Array { name, .. } => {
					let previous = self.arrays.insert(name.clone(), ArrayValue::new());
					frame.saved_arrays.push((name.clone(), previous));
				},
			}
		}

		self.frames.push(frame);
		let outcome = self.execute_body(&function);
		if outcome.is_err() {
			self.error_function = Some(function.name.clone());
		}
		let frame = self.frames.pop().expect("function frame");
		self.restore_frame(frame);
		let value = outcome?;
		if function.is_void {
			self.void_result = true;
			return Ok(BigDecimal::zero());
		}
		Ok(value.unwrap_or_else(BigDecimal::zero))
	}

	fn execute_body(&mut self, function: &Function) -> Result<Option<BigDecimal>, String> {
		for statement in &function.body {
			if self.quitting {
				return Ok(None);
			}
			match self.execute(statement)? {
				Flow::Normal => {},
				Flow::Return(value) => return Ok(value),
				Flow::Break | Flow::Continue => {
					return Err("break/continue outside a loop".to_string());
				},
			}
		}
		Ok(None)
	}

	fn restore_frame(&mut self, frame: Frame) {
		for (name, previous) in frame.saved_scalars.into_iter().rev() {
			match previous {
				Some(value) => {
					self.variables.insert(name, value);
				},
				None => {
					self.variables.remove(&name);
				},
			}
		}
		for (name, previous) in frame.saved_arrays.into_iter().rev() {
			match previous {
				Some(value) => {
					self.arrays.insert(name, value);
				},
				None => {
					self.arrays.remove(&name);
				},
			}
		}
	}
	fn divide(&self, left: &BigDecimal, right: &BigDecimal) -> Result<BigDecimal, String> {
		if right.is_zero() {
			return Err("Divide by zero".to_string());
		}
		let quotient = left / right;
		Ok(truncate(&quotient, self.scale))
	}

	fn modulo(&self, left: &BigDecimal, right: &BigDecimal) -> Result<BigDecimal, String> {
		if right.is_zero() {
			return Err("Modulo by zero".to_string());
		}
		let quotient = truncate(&(left / right), self.scale);
		let remainder = left - &quotient * right;
		let target = (self.scale + scale_of(right)).max(scale_of(left));
		Ok(truncate(&remainder, target))
	}

	fn power(&mut self, base: &BigDecimal, exponent: &BigDecimal) -> Result<BigDecimal, String> {
		let mut exponent = exponent.clone();
		if scale_of(&exponent) != 0 {
			self.report_runtime_warning("non-zero scale in exponent");
			exponent = truncate(&exponent, 0);
		}
		let Some(exponent) = exponent.to_i64() else {
			return Err("exponent too large in raise".to_string());
		};
		if exponent == 0 {
			return Ok(BigDecimal::one());
		}
		let magnitude = exponent.unsigned_abs() as i32;
		let mut result = BigDecimal::one();
		let mut factor = base.clone();
		let mut remaining = magnitude;
		while remaining > 0 {
			if remaining & 1 == 1 {
				result *= &factor;
			}
			remaining >>= 1;
			if remaining > 0 {
				factor = &factor * &factor;
			}
		}
		if exponent < 0 {
			return self.divide(&BigDecimal::one(), &result);
		}
		let limit = scale_of(base) * i64::from(magnitude);
		let target = limit.min(self.scale.max(scale_of(base)));
		Ok(truncate(&result, target))
	}

	fn math_function(&self, name: &str, values: &[BigDecimal]) -> Result<BigDecimal, String> {
		let to_f64 = |value: &BigDecimal| value.to_f64().ok_or_else(|| "numeric overflow".to_string());
		let from_f64 = |value: f64| {
			BigDecimal::from_f64(value).ok_or_else(|| "numeric overflow".to_string())
		};
		// The math library truncates every result to the current scale.
		let finish = |value: f64| -> Result<BigDecimal, String> {
			let value = from_f64(value)?;
			Ok(truncate(&value, self.scale))
		};
		match name {
			"s" => finish(to_f64(expect_one(values, "s")?)?.sin()),
			"c" => finish(to_f64(expect_one(values, "c")?)?.cos()),
			"a" => finish(to_f64(expect_one(values, "a")?)?.atan()),
			"l" => {
				let value = to_f64(expect_one(values, "l")?)?;
				if value <= 0.0 {
					return Err("l(): argument must be positive".to_string());
				}
				finish(value.ln())
			},
			"e" => finish(to_f64(expect_one(values, "e")?)?.exp()),
			"j" => {
				let [order, argument] = values else {
					return Err("j() takes two arguments".to_string());
				};
				let order = order.to_i64().ok_or_else(|| "j(): order must be an integer".to_string())?;
				finish(bessel_j(order, to_f64(argument)?))
			},
			_ => Err(format!("Function {name} not defined.")),
		}
	}

	fn sqrt(&self, value: &BigDecimal) -> Result<BigDecimal, String> {
		if value.is_negative() {
			return Err("Square root of a negative number".to_string());
		}
		let target = self.scale.max(scale_of(value));
		if value.is_zero() {
			return Ok(BigDecimal::zero());
		}
		let mut guess = BigDecimal::from_f64(value.to_f64().map(f64::sqrt).unwrap_or(1.0))
			.unwrap_or_else(BigDecimal::one);
		for _ in 0..200 {
			let quotient = divide_to(value, &guess, target + 4)?;
			let next = truncate(&((guess.clone() + quotient) / BigDecimal::from(2)), target + 4);
			if next == guess {
				break;
			}
			guess = next;
		}
		Ok(truncate(&guess, target))
	}

	/// Constants are converted with the ibase that was in effect when the
	/// enclosing function was called (POSIX), not the current one.
	fn current_ibase(&self) -> u32 {
		if let Some(base) = self.ibase_override {
			return base;
		}
		self.frames.last().map(|frame| frame.captured_ibase).unwrap_or(self.ibase)
	}

	fn parse_number(&self, text: &str) -> Result<BigDecimal, String> {
		let (integer_text, fraction_text) = match text.split_once('.') {
			Some((integer, fraction)) => (integer, Some(fraction)),
			None => (text, None),
		};
		if integer_text.is_empty() && fraction_text.is_none() {
			return Err(format!("invalid number: {text}"));
		}
		let base = self.current_ibase();
		if base == 10 && text.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.') {
			let normalized = text.strip_suffix('.').unwrap_or(text);
			return normalized
				.parse::<BigDecimal>()
				.map_err(|_| format!("invalid number: {text}"));
		}
		let integer_clamp = integer_text.chars().count() > 1;
		let integer = digits_to_bigint(integer_text, base, integer_clamp);
		let mut value = BigDecimal::from(integer);
		if let Some(fraction_text) = fraction_text {
			if !fraction_text.is_empty() {
				let digits = fraction_text.chars().count();
				let numerator = digits_to_bigint(fraction_text, base, true);
				if numerator.is_zero() {
					value = value.with_scale(digits as i64);
				} else {
					let denominator = BigInt::from(base).pow(digits as u32);
					let fraction = divide_to(
						&BigDecimal::from(numerator),
						&BigDecimal::from(denominator),
						digits as i64,
					)?;
					value += fraction;
				}
			}
		}
		Ok(value)
	}

	fn render(&self, value: &BigDecimal) -> String {
		if self.obase == 10 {
			return strip_leading_zero(plain(value));
		}
		if value.is_zero() {
			return "0".to_string();
		}
		let negative = value.is_negative();
		let absolute = value.abs();
		let integer = absolute.with_scale(0).into_bigint_and_exponent().0;
		let mut digits = Vec::new();
		let mut current = integer;
		let base = BigInt::from(self.obase);
		while !current.is_zero() {
			let remainder = (&current % &base).to_u32().unwrap_or(0);
			digits.push(remainder);
			current /= &base;
		}
		digits.reverse();
		// GNU bc prints one base-10 number per digit for bases above 16, each
		// zero-padded to the width of obase - 1 and separated by spaces.
		let width = (self.obase - 1).to_string().len();
		let mut text = String::new();
		for digit in &digits {
			if self.obase <= 16 {
				text.push(digit_char(*digit));
			} else {
				text.push(' ');
				text.push_str(&format!("{:0width$}", digit, width = width));
			}
		}
		let fraction = &absolute - BigDecimal::from(absolute.with_scale(0).into_bigint_and_exponent().0);
		if !fraction.is_zero() {
			text.push('.');
			let scale = scale_of(value);
			let mut power = BigInt::from(1);
			let mut count = 0;
			while power.to_str_radix(10).len() as i64 <= scale {
				count += 1;
				power *= &base;
			}
			let mut current = fraction;
			for index in 0..count {
				current *= BigDecimal::from(self.obase);
				let digit = current.with_scale(0).into_bigint_and_exponent().0;
				let digit = digit.to_u32().unwrap_or(0);
				current -= BigDecimal::from(digit);
				if self.obase <= 16 {
					text.push(digit_char(digit));
				} else {
					if index > 0 {
						text.push(' ');
					}
					text.push_str(&format!("{:0width$}", digit, width = width));
				}
				if current.is_zero() {
					break;
				}
			}
		}
		if negative {
			text.insert(0, '-');
		}
		text
	}
}


/// bc processes escape sequences when a string is written to the output.
fn unescape_string(text: &str) -> String {
	let mut result = String::with_capacity(text.len());
	let mut characters = text.chars();
	while let Some(character) = characters.next() {
		if character != '\\' {
			result.push(character);
			continue;
		}
		match characters.next() {
			Some('a') => result.push('\u{7}'),
			Some('b') => result.push('\u{8}'),
			Some('f') => result.push('\u{c}'),
			Some('n') => result.push('\n'),
			Some('q') => result.push('"'),
			Some('r') => result.push('\r'),
			Some('t') => result.push('\t'),
			Some('\\') => result.push('\\'),
			// bc ignores the character (and the backslash) for unknown escapes.
			Some(_) | None => {},
		}
	}
	result
}

/// bc truncates the subscript toward zero and limits it to BC_DIM_MAX.
fn array_index(name: &str, index: &BigDecimal) -> Result<i64, String> {
	let truncated = index.with_scale_round(0, bigdecimal::RoundingMode::Down);
	let Some(key) = truncated.to_i64() else {
		return Err(format!("Array {name} subscript out of bounds."));
	};
	if !(0..=65535).contains(&key) || (key == 0 && !index.is_zero()) {
		return Err(format!("Array {name} subscript out of bounds."));
	}
	Ok(key)
}

fn expect_one<'a>(values: &'a [BigDecimal], name: &str) -> Result<&'a BigDecimal, String> {
	match values {
		[value] => Ok(value),
		_ => Err(format!("{name}() takes one argument")),
	}
}

/// J0(x), from the polynomial/asymptotic fits in Numerical Recipes.
fn bessel_j0(x: f64) -> f64 {
	let ax = x.abs();
	if ax < 8.0 {
		let y = x * x;
		let first = 57568490574.0
			+ y * (-13362590354.0 + y * (651619640.7 + y * (-11214424.18 + y * (77392.33017 + y * -184.9052456))));
		let second = 57568490411.0
			+ y * (1029532985.0 + y * (9494680.718 + y * (59272.64853 + y * (267.8532712 + y))));
		first / second
	} else {
		let z = 8.0 / ax;
		let y = z * z;
		let phase = ax - 0.785398164;
		let first = 1.0
			+ y * (-0.1098628627e-2
				+ y * (0.2734510407e-4 + y * (-0.2073370639e-5 + y * 0.2093887211e-6)));
		let second = -0.1562499995e-1
			+ y * (0.1430488765e-3 + y * (-0.6911147651e-5 + y * (0.7621095161e-6 - y * 0.934935152e-7)));
		(0.636619772 / ax).sqrt() * (phase.cos() * first - z * phase.sin() * second)
	}
}

/// J1(x), from the polynomial/asymptotic fits in Numerical Recipes.
fn bessel_j1(x: f64) -> f64 {
	let ax = x.abs();
	if ax < 8.0 {
		let y = x * x;
		let first = x
			* (72362614232.0
				+ y * (-7895059235.0
					+ y * (242396853.1 + y * (-2972611.439 + y * (15704.48260 + y * -30.16036606)))));
		let second = 144725228442.0
			+ y * (2300535178.0 + y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))));
		first / second
	} else {
		let z = 8.0 / ax;
		let y = z * z;
		let phase = ax - 2.356194491;
		let first = 1.0
			+ y * (0.183105e-2
				+ y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * -0.240337019e-6)));
		let second = 0.04687499995
			+ y * (-0.2002690873e-3
				+ y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)));
		let value = (0.636619772 / ax).sqrt() * (phase.cos() * first - z * phase.sin() * second);
		if x < 0.0 {
			-value
		} else {
			value
		}
	}
}

fn bessel_j(order: i64, x: f64) -> f64 {
	// Both recurrences and the J0/J1 fits follow Numerical Recipes; bc's -l
	// only needs double precision anyway (see docs/shell-commands/bc.md).
	let n = order.unsigned_abs() as i32;
	if n == 0 {
		return bessel_j0(x);
	}
	if n == 1 {
		return bessel_j1(x);
	}
	let ax = x.abs();
	if ax == 0.0 {
		return 0.0;
	}
	if ax > f64::from(n) {
		let tox = 2.0 / ax;
		let mut previous = bessel_j0(ax);
		let mut current = bessel_j1(ax);
		let mut value = 0.0;
		for index in 1..n {
			value = f64::from(index) * tox * current - previous;
			previous = current;
			current = value;
		}
		if x < 0.0 && n % 2 == 1 {
			-value
		} else {
			value
		}
	} else {
		let tox = 2.0 / ax;
		let m = 2 * ((n + (n as f64 * ax).sqrt() as i32) / 2);
		let mut parity = 0;
		let mut sum = 0.0;
		let mut answer = 0.0;
		let mut next = 0.0;
		let mut current = 1.0;
		for index in (1..=m).rev() {
			let previous = f64::from(index) * tox * current - next;
			next = current;
			current = previous;
			if current.abs() > 1.0e10 {
				current *= 1.0e-10;
				next *= 1.0e-10;
				answer *= 1.0e-10;
				sum *= 1.0e-10;
			}
			if parity != 0 {
				sum += current;
			}
			parity = 1 - parity;
			if index == n {
				answer = next;
			}
		}
		sum = 2.0 * sum - current;
		answer /= sum;
		if x < 0.0 && n % 2 == 1 {
			-answer
		} else {
			answer
		}
	}
}

fn digit_char(digit: u32) -> char {
	const DIGITS: [char; 16] = [
		'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F',
	];
	DIGITS[(digit as usize).min(15)]
}

fn digits_to_bigint(text: &str, base: u32, clamp: bool) -> BigInt {
	let mut value = BigInt::from(0);
	for character in text.chars() {
		let digit = character.to_digit(36).unwrap_or(0);
		let digit = if clamp { digit.min(base - 1) } else { digit };
		value = value * BigInt::from(base) + BigInt::from(digit);
	}
	value
}

fn scale_of(value: &BigDecimal) -> i64 {
	value.fractional_digit_count().max(0)
}

fn truncate(value: &BigDecimal, scale: i64) -> BigDecimal {
	value.with_scale_round(scale, bigdecimal::RoundingMode::Down)
}

fn divide_to(left: &BigDecimal, right: &BigDecimal, scale: i64) -> Result<BigDecimal, String> {
	if right.is_zero() {
		return Err("division by zero".to_string());
	}
	let factor = BigDecimal::from(BigInt::from(10).pow(scale as u32));
	let scaled = left * &factor;
	let quotient = (scaled / right).with_scale_round(0, bigdecimal::RoundingMode::Down);
	Ok((quotient / factor).with_scale_round(scale, bigdecimal::RoundingMode::Down))
}

/// GNU bc: for 0.xxx the leading 0 is not significant, so length is the
/// scale; otherwise it is the integer digits plus the scale.
fn length_of(value: &BigDecimal) -> i64 {
	let scale = scale_of(value);
	let integer = value.with_scale(0);
	if integer.is_zero() && scale > 0 {
		return scale;
	}
	let digits = plain(&integer)
		.trim_start_matches('-')
		.trim_start_matches('0')
		.chars()
		.count();
	digits.max(1) as i64 + scale
}

/// bc omits the leading zero of values below one (`.5`, `-.5`).
fn strip_leading_zero(text: String) -> String {
	if let Some(rest) = text.strip_prefix("0.") {
		format!(".{rest}")
	} else if let Some(rest) = text.strip_prefix("-0.") {
		format!("-.{rest}")
	} else {
		text
	}
}

fn plain(value: &BigDecimal) -> String {
	let mut text = format!("{value}");
	if let Some((mantissa, exponent)) = text.split_once(['e', 'E']) {
		if let Ok(exponent) = exponent.parse::<i64>() {
			let negative = mantissa.starts_with('-');
			let mantissa = mantissa.trim_start_matches('-');
			let (integer, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
			let digits: String = format!("{integer}{fraction}");
			let point = integer.len() as i64 + exponent;
			let rendered = if point <= 0 {
				format!("0.{}{}", "0".repeat((-point) as usize), digits)
			} else if point as usize >= digits.len() {
				format!("{}{}", digits, "0".repeat(point as usize - digits.len()))
			} else {
				format!("{}.{}", &digits[..point as usize], &digits[point as usize..])
			};
			text = if negative { format!("-{rendered}") } else { rendered };
		}
	}
	text
}

fn app() -> Command {
	Command::new("bc")
		.disable_help_flag(true)
		.disable_version_flag(true)
		.version("1.07.1")
		.about("Arbitrary precision calculator")
		.arg(Arg::new("help").short('h').long("help").action(ArgAction::SetTrue).help("display this help and exit"))
		.arg(Arg::new("version").short('v').long("version").action(ArgAction::SetTrue).help("output version information and exit"))
		.arg(Arg::new("version-alias").short('V').action(ArgAction::SetTrue).hide(true))
		.arg(Arg::new("mathlib").short('l').long("mathlib").action(ArgAction::SetTrue).help("load the math library and set scale to 20"))
		.arg(Arg::new("quiet").short('q').long("quiet").action(ArgAction::SetTrue).help("do not print the banner"))
		.arg(Arg::new("interactive").short('i').long("interactive").action(ArgAction::SetTrue).hide(true))
		.arg(Arg::new("standard").short('s').long("standard").action(ArgAction::SetTrue).help("process exactly the POSIX bc language"))
		.arg(Arg::new("warn").short('w').long("warn").action(ArgAction::SetTrue).help("warn about POSIX extensions"))
		.arg(
			Arg::new("FILE")
				.num_args(0..)
				.value_name("FILE")
				.value_parser(clap::builder::ValueParser::os_string()),
		)
}

#[cfg(test)]
mod tests {
	use tempfile::tempdir;

	use crate::host::{run_script, run_util};

	use super::Bc;

	fn run(arguments: &[&str], stdin: &str) -> (i32, String, String) {
		let dir = tempdir().unwrap();
		let (code, capture) = run_util::<Bc>(arguments, stdin, dir.path());
		(code, capture.out(), capture.err())
	}

	#[test]
	fn evaluates_arithmetic_with_precedence() {
		let (code, out, err) = run(&[], "1 + 2 * 3\n(1 + 2) * 3\n2 ^ 3 ^ 2\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "7\n9\n512\n");
	}

	#[test]
	fn division_uses_the_scale_variable() {
		let (code, out, err) = run(&[], "1 / 3\nscale = 5\n1 / 3\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "0\n.33333\n");
	}

	#[test]
	fn assignment_is_silent_and_variables_persist() {
		let (code, out, _) = run(&[], "x = 4\nx * x\nx += 1\nx\n");
		assert_eq!(code, 0);
		assert_eq!(out, "16\n5\n");
	}

	#[test]
	fn ibase_and_obase_convert_numbers() {
		// obase is read in the current ibase, so set it before switching ibase.
		let (code, out, err) = run(&[], "obase = 16\n255\nobase = 10\nibase = 16\nFF\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "FF\n255\n");
	}

	#[test]
	fn builtins_sqrt_length_scale() {
		let (code, out, err) = run(&[], "scale = 4\nsqrt(2)\nlength(1234)\nscale(0.125)\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "1.4142\n4\n3\n");
	}

	#[test]
	fn print_statement_keeps_text_and_omits_newline() {
		let (code, out, _) = run(&[], "print \"x=\", 2 + 2\n");
		assert_eq!(code, 0);
		assert_eq!(out, "x=4");
	}

	#[test]
	fn mathlib_functions_are_available_with_flag() {
		let (code, out, err) = run(&["-l"], "scale = 5\nsqrt(4)\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "2.00000\n");
	}

	#[test]
	fn division_by_zero_is_reported_and_execution_continues() {
		let (code, out, err) = run(&[], "1 / 0\n5\n");
		assert_eq!(code, 0);
		assert!(err.contains("Divide by zero"), "{err}");
		assert!(err.contains("Runtime error"), "{err}");
		assert_eq!(out, "5\n");
	}

	#[test]
	fn control_flow_if_while_for() {
		let (code, out, err) = run(
			&[],
			"if (1 < 2) 10 else 20\nif (0) 10 else 20\nx = 0\nwhile (x < 3) { x += 1 }\nx\nfor (i = 0; i < 3; i += 1) i\n",
		);
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "10\n20\n3\n0\n1\n2\n");
	}

	#[test]
	fn functions_support_recursion_and_returns() {
		let (code, out, err) = run(
			&[],
			"define fact(n) { if (n <= 1) return 1; return n * fact(n - 1); }\nfact(5)\n",
		);
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "120\n");
	}

	#[test]
	fn autos_and_dynamic_scope() {
		let (code, out, err) = run(
			&[],
			"define f(x) { auto y; y = x * 2; return y + z; }\nz = 1\nf(3)\ndefine g() { auto v; v = 99; return v; }\nv = 5\ng()\nv\n",
		);
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "7\n99\n5\n");
	}

	#[test]
	fn arrays_and_by_variable_parameters() {
		let (code, out, err) = run(
			&[],
			"a[0] = 1\na[1] = 2\ndefine sum(n[]) { auto i, s; for (i = 0; i < 2; i += 1) s += n[i]; return s; }\nsum(a[])\ndefine void setfirst(*n[]) { n[0] = 42 }\nsetfirst(a[])\na[0]\n",
		);
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "3\n42\n");
	}

	#[test]
	fn void_functions_print_nothing() {
		let (code, out, err) = run(&[], "define void hello() { \"hi\" }\nhello()\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "hi\n");
	}

	#[test]
	fn illegal_characters_are_reported_and_execution_continues() {
		let (code, out, err) = run(&[], "ibase=16\n@\n10\n@@\n");
		assert_eq!(code, 0);
		assert_eq!(out, "16\n");
		assert!(err.contains("(standard_in) 2: illegal character: @"), "{err}");
		assert_eq!(
			err.matches("(standard_in) 4: illegal character: @").count(),
			2,
			"{err}"
		);
	}

	#[test]
	fn break_and_continue_control_loops() {
		let (code, out, err) = run(
			&[],
			"for (i = 0; i < 10; i += 1) { if (i == 3) break; i }\nfor (i = 0; i < 5; i += 1) { if (i == 2) continue; i }\n",
		);
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "0\n1\n2\n0\n1\n3\n4\n");
	}

	#[test]
	fn return_without_value_yields_zero() {
		let (code, out, err) = run(&[], "define f() { return; }\nf()\nf() + 1\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "0\n1\n");
	}

	#[test]
	fn increment_operators_use_prefix_and_postfix_values() {
		let (code, out, err) = run(&[], "x = 5\nx++\nx\n++x\nx--\ny = x++\ny\nx\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "5\n6\n7\n7\n6\n7\n");
	}

	#[test]
	fn break_outside_a_loop_is_a_parse_error() {
		let (code, out, err) = run(&[], "break\n5\n");
		assert_eq!(code, 0);
		assert!(err.contains("Break outside a for/while"), "{err}");
		assert_eq!(out, "5\n");
	}

	#[test]
	fn void_function_cannot_be_used_as_a_value() {
		let (code, _, err) = run(&[], "define void f() { }\nf() + 1\n");
		assert_eq!(code, 0);
		assert!(err.contains("void function used as a value"), "{err}");
	}

	#[tokio::test]
	async fn runs_as_a_shell_builtin() {
		let dir = tempdir().unwrap();
		let (code, out, err) = run_script("echo '2 + 3' | bc", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "5\n");
	}

	#[test]
	fn string_escapes_are_processed() {
		let (code, out, err) = run(&[], concat!(r#""a\nb\tq\q""#, "\n"));
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "a\nb\tq\"\n");
	}

	#[test]
	fn read_function_reads_a_line_from_stdin() {
		let dir = tempdir().unwrap();
		let script = dir.path().join("program.bc");
		std::fs::write(&script, "read()\n").unwrap();
		let (code, capture) = run_util::<Bc>(&[script.to_str().unwrap()], "42\n", dir.path());
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.out(), "42\n");
	}

	#[test]
	fn recursion_survives_deep_calls() {
		let (code, out, err) = run(
			&[],
			"define fact(n) { if (n <= 1) return 1; return n * fact(n - 1); }\nlength(fact(100))\n",
		);
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "158\n");
	}

	#[test]
	fn halt_stops_the_program() {
		let (code, out, _) = run(&["-w"], "halt\n1\n");
		assert_eq!(code, 0);
		assert_eq!(out, "");
	}

	#[test]
	fn standard_mode_rejects_function_extensions() {
		let (code, out, err) = run(&["-s"], "define void f() { }\n5\n");
		assert_eq!(code, 0);
		assert!(err.contains("Error: void functions"), "{err}");
		assert_eq!(out, "5\n");
	}

	#[test]
	fn last_holds_the_previous_printed_value() {
		let (code, out, err) = run(&[], "5\nlast + 1\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "5\n6\n");
	}

	#[test]
	fn quit_stops_parsing() {
		let (code, out, _) = run(&[], "1\nquit\ngarbage!\n");
		assert_eq!(code, 0);
		assert_eq!(out, "1\n");
	}

	#[test]
	fn array_subscripts_truncate_and_check_bounds() {
		let (code, out, err) = run(&[], "a[1.9] = 7\na[1]\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "7\n");

		let (code, _, err) = run(&[], "a[-1] = 1\n");
		assert_eq!(code, 0);
		assert!(err.contains("Array a subscript out of bounds."), "{err}");
	}

	#[test]
	fn warranty_statement_prints_the_notice() {
		let (code, out, _) = run(&[], "warranty\n");
		assert_eq!(code, 0);
		assert!(out.contains("bc 1.07.1"), "{out}");
		assert!(out.contains("free software"), "{out}");
	}

	#[test]
	#[ignore]
	fn perf_probe() {
		let Ok(path) = std::env::var("BC_BENCH_FILE") else {
			return;
		};
		let source = std::fs::read_to_string(&path).unwrap();
		let started = std::time::Instant::now();
		let (code, out, err) = run(&[], &source);
		println!(
			"BENCH {} code={} elapsed_ms={}\n--out--\n{}\n--err--\n{}",
			path,
			code,
			started.elapsed().as_millis(),
			out,
			err
		);
	}

	#[test]
	fn limits_reports_the_implemented_limits() {
		let (code, out, err) = run(&[], "limits\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert!(out.contains("BC_BASE_MAX     = 2147483647"), "{out}");
		assert!(out.contains("BC_SCALE_MAX    = 1000000"), "{out}");
		assert!(out.contains("BC_DIM_MAX      = 65535"), "{out}");
	}

	#[test]
	fn ibase_above_16_only_warns_in_warn_mode() {
		let (code, out, err) = run(&["-w"], "ibase = 20\nK\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "20\n");
		assert!(err.contains("ibase larger than 16 is non-standard"), "{err}");

		let (code, out, err) = run(&[], "ibase = 20\nK\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "20\n");
		assert!(!err.contains("non-standard"), "{err}");
	}

	#[test]
	fn special_variables_truncate_like_gnu() {
		let (code, out, err) = run(&[], "scale = 2.7\n1/3\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, ".33\n");

		let (code, out, err) = run(&[], "ibase = 16.9\nFF\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "255\n");
	}

	#[test]
	fn out_of_range_bases_clamp_with_a_runtime_warning() {
		let (code, out, err) = run(&["-w"], "obase = 1000\n255\n");
		assert_eq!(code, 0);
		assert_eq!(out, " 255\n");
		assert!(!err.contains("obase too large"), "{err}");

		let (code, out, err) = run(&["-w"], "obase = 3000000000\n255\n");
		assert_eq!(code, 0);
		assert_eq!(out, " 0000000255\n");
		assert!(err.contains("obase too large, set to 2147483647"), "{err}");

		let (code, out, err) = run(&["-w"], "scale = -1\n1/3\n");
		assert_eq!(code, 0);
		assert_eq!(out, "0\n");
		assert!(err.contains("negative scale, set to 0"), "{err}");
	}

	#[test]
	fn bases_above_16_and_digit_clamping_match_gnu() {
		let (code, out, err) = run(&[], "ibase=36\nZ\nZZ\n10\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "35\n1295\n36\n");

		let (code, out, err) = run(&[], "1A\nA\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "19\n10\n");

		let (code, out, err) = run(&[], "ibase=16\n.8\n.B\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, ".5\n.6\n");
	}

	#[test]
	fn large_output_bases_use_multi_character_digits() {
		let (code, out, err) = run(&[], "obase = 100\n12345\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, " 01 23 45\n");

		let (code, out, err) = run(&[], "scale = 5\nobase = 17\n1/3\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, ".05 11 05 11 00\n");
	}

	#[test]
	fn long_numbers_wrap_with_a_backslash() {
		let (code, out, err) = run(&[], "2^400\n");
		assert_eq!(code, 0, "stderr: {err}");
		let first = out.lines().next().unwrap();
		assert_eq!(first.chars().count(), 69, "{out}");
		assert!(first.ends_with('\\'), "{out}");
		assert_eq!(out.lines().count(), 2, "{out}");
	}

	#[tokio::test]
	async fn bc_line_length_zero_disables_wrapping() {
		let dir = tempdir().unwrap();
		let (code, out, err) = run_script("printf '2^400\\n' | BC_LINE_LENGTH=0 bc", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert!(!out.contains('\\'), "{out}");
	}

	#[test]
	fn length_follows_gnu_significant_digit_rules() {
		let (code, out, err) = run(&[], "length(.001)\nlength(0.50)\nlength(10.00)\nlength(0)\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "3\n2\n4\n1\n");
	}

	#[test]
	fn parenthesized_assignment_prints_its_value() {
		let (code, out, err) = run(&[], "(a = 1)\na\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "1\n1\n");
	}

	#[test]
	fn last_can_be_assigned_and_warns_as_an_extension() {
		let (code, out, err) = run(&["-w"], "5\nlast = 9\nlast\n");
		assert_eq!(code, 0);
		assert_eq!(out, "5\n9\n");
		assert!(err.contains("(Warning) Last variable"), "{err}");
	}

	#[test]
	fn backslash_newline_continues_a_number() {
		let (code, out, err) = run(&[], concat!("1\\", "\n", "2\n"));
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "12\n");
	}

	#[test]
	fn comparisons_used_as_values_warn() {
		let (code, out, err) = run(&["-w"], "1 < 2\n");
		assert_eq!(code, 0);
		assert_eq!(out, "1\n");
		assert!(err.contains("(Warning) comparison in expression"), "{err}");
	}

	#[test]
	fn runtime_errors_name_the_current_function() {
		let (code, out, err) = run(&[], "define f() { return 1/0; }\n7\nf()\n");
		assert_eq!(code, 0);
		assert_eq!(out, "7\n");
		assert!(err.contains("func=f"), "{err}");
		assert!(err.contains("Divide by zero"), "{err}");
	}

	#[tokio::test]
	async fn bc_env_args_and_posixly_correct_are_honoured() {
		let dir = tempdir().unwrap();
		let (code, out, err) = run_script("printf 'print 1\\n' | BC_ENV_ARGS='-s' bc", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "");
		assert!(err.contains("Error: print statement"), "{err}");

		let (code, out, err) = run_script("printf 'print 1\\n' | POSIXLY_CORRECT=1 bc", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "");
		assert!(err.contains("Error: print statement"), "{err}");

		let (code, out, err) = run_script("printf 'e(1)\\n' | BC_ENV_ARGS='-l' bc", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert!(out.starts_with("2.71828"), "{out}");
	}

	#[test]
	fn version_flag_matches_gnu_spelling() {
		let (code, out, _) = run(&["-v"], "");
		assert_eq!(code, 0);
		assert!(out.starts_with("bc 1.07.1"), "{out}");
	}

	#[test]
	fn standard_mode_rejects_gnu_extensions() {
		let (code, out, err) = run(&["-s"], "print 1\n5\n");
		assert_eq!(code, 0);
		assert!(err.contains("Error: print statement"), "{err}");
		assert_eq!(out, "5\n");
	}

	#[test]
	fn standard_mode_skips_the_whole_line() {
		let (code, out, err) = run(&["-s"], "print 1; 2\n3\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "3\n");
		assert!(err.contains("Error: print statement"), "{err}");
	}

	#[test]
	fn warn_mode_keeps_gnu_extensions_but_warns() {
		let (code, out, err) = run(&["-w"], "print 1\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "1");
		assert!(err.contains("(Warning) print statement"), "{err}");
	}
}

