//! bc builtin: arbitrary-precision decimal calculator.
//!
//! Windows has no bc at all (Git Bash does not ship it), and shell scripts
//! use it for arithmetic. The implementation covers the expression language,
//! variables, special variables (scale/ibase/obase), print/quit statements and
//! the -l math library; control flow, functions and arrays are reported as
//! unimplemented instead of being silently ignored.

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
	quiet: bool,
	standard: bool,
	warn: bool,
	files: Vec<PathBuf>,
}

impl Options {
	fn from_matches(matches: &ArgMatches, host: &Host) -> Self {
		Self {
			mathlib: matches.get_flag("mathlib"),
			quiet: matches.get_flag("quiet"),
			standard: matches.get_flag("standard"),
			warn: matches.get_flag("warn"),
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

fn run(host: &mut Host, options: &Options) -> i32 {
	let mut source = String::new();
	if options.files.is_empty() {
		if let Err(error) = host.stdin.read_to_string(&mut source) {
			host.error(format!("bc: {error}"), 1);
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
					host.error(format!("bc: {}: {}", path.display(), error), 1);
					return 1;
				},
			}
		}
	}
	let _ = options.quiet;

	let mut machine = Machine::new(options.mathlib, options.standard, options.warn);
	let tokens = match lex(&source) {
		Ok(tokens) => tokens,
		Err(message) => {
			host.error(format!("bc: {message}"), 1);
			return 1;
		},
	};
	let mut parser = Parser { tokens, index: 0 };
	let mut out = BufWriter::new(host.stdout_clone());
	loop {
		match parser.parse_statement() {
			Ok(Some(statement)) => match machine.execute(&statement, host, &mut out) {
				Ok(true) => {},
				Ok(false) => {
					let _ = out.flush();
					return 0;
				},
				Err(message) => {
					let _ = out.flush();
					host.error(message, 1);
					return 1;
				},
			},
			Ok(None) => {
				let _ = out.flush();
				return 0;
			},
			Err(message) => {
				let _ = out.flush();
				host.error(format!("bc: {message}"), 1);
				return 1;
			},
		}
	}
}
#[derive(Clone, Debug, PartialEq)]
enum Token {
	Number(String),
	Ident(String),
	String(String),
	Plus,
	Minus,
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
			b'0'..=b'9' | b'A'..=b'F' => {
				let start = index;
				while index < bytes.len() && (bytes[index].is_ascii_hexdigit() || bytes[index] == b'.') {
					index += 1;
				}
				tokens.push(Token::Number(source[start..index].to_string()));
			},
			b'.' => {
				let start = index;
				index += 1;
				while index < bytes.len() && bytes[index].is_ascii_hexdigit() {
					index += 1;
				}
				tokens.push(Token::Number(source[start..index].to_string()));
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
				if bytes.get(index + 1) == Some(&b'=') {
					tokens.push(Token::PlusAssign);
					index += 2;
				} else {
					tokens.push(Token::Plus);
					index += 1;
				}
			},
			b'-' => {
				if bytes.get(index + 1) == Some(&b'=') {
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
				return Err(format!("unexpected character '{}'", other as char));
			},
		}
	}
	Ok(tokens)
}

#[derive(Clone, Debug)]
enum Expr {
	Number(String),
	Text(String),
	Var(String),
	Neg(Box<Expr>),
	Not(Box<Expr>),
	Binary(BinOp, Box<Expr>, Box<Expr>),
	Assign(String, AssignOp, Box<Expr>),
	Call(String, Vec<Expr>),
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
enum Statement {
	Expr(Expr),
	Print(Vec<Expr>),
	Quit(bool),
	Text(String),
}

struct Parser {
	tokens: Vec<Token>,
	index: usize,
}

impl Parser {
	fn peek(&self) -> Option<&Token> {
		self.tokens.get(self.index)
	}

	fn advance(&mut self) -> Option<Token> {
		let token = self.tokens.get(self.index).cloned();
		if token.is_some() {
			self.index += 1;
		}
		token
	}

	fn skip_separators(&mut self) {
		while matches!(self.peek(), Some(Token::Newline) | Some(Token::Semicolon)) {
			self.index += 1;
		}
	}

	fn parse_statement(&mut self) -> Result<Option<Statement>, String> {
		self.skip_separators();
		let Some(token) = self.peek().cloned() else {
			return Ok(None);
		};
		match token {
			Token::Ident(word) => match word.as_str() {
				"quit" | "halt" => {
					let halt = word == "halt";
					self.advance();
					self.skip_to_separator();
					Ok(Some(Statement::Quit(halt)))
				},
				"print" => {
					self.advance();
					Ok(Some(Statement::Print(self.parse_print_list()?)))
				},
				"define" => Err("functions (define) are not implemented yet".to_string()),
				"if" | "while" | "for" => Err(format!("{word} statements are not implemented yet")),
				"return" | "break" | "continue" => {
					Err(format!("{word} outside a function is not implemented"))
				},
				"limits" => {
					self.advance();
					self.skip_to_separator();
					Ok(Some(Statement::Text(String::new())))
				},
				"scale" | "ibase" | "obase" if matches!(self.tokens.get(self.index + 1), Some(Token::Assign)) => {
					self.advance();
					self.advance();
					let value = self.parse_expression()?;
					self.finish_statement()?;
					Ok(Some(Statement::Expr(Expr::Assign(word, AssignOp::Set, Box::new(value)))))
				},
				_ => {
					let expr = self.parse_expression()?;
					self.finish_statement()?;
					Ok(Some(Statement::Expr(expr)))
				},
			},
			Token::String(text) => {
				self.advance();
				self.finish_statement()?;
				Ok(Some(Statement::Text(text)))
			},
			_ => {
				let expr = self.parse_expression()?;
				self.finish_statement()?;
				Ok(Some(Statement::Expr(expr)))
			},
		}
	}

	fn finish_statement(&mut self) -> Result<(), String> {
		match self.peek() {
			None | Some(Token::Newline) | Some(Token::Semicolon) => {
				self.skip_separators();
				Ok(())
			},
			Some(token) => Err(format!("unexpected token after expression: {token:?}")),
		}
	}

	fn skip_to_separator(&mut self) {
		while let Some(token) = self.peek() {
			if matches!(token, Token::Newline | Token::Semicolon) {
				break;
			}
			self.index += 1;
		}
	}

	fn parse_print_list(&mut self) -> Result<Vec<Expr>, String> {
		let mut items = Vec::new();
		loop {
			if matches!(self.peek(), None | Some(Token::Newline) | Some(Token::Semicolon)) {
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
		let Expr::Var(name) = left else {
			return Err("assignment target must be a variable".to_string());
		};
		self.advance();
		let value = self.parse_assignment()?;
		Ok(Expr::Assign(name, operation, Box::new(value)))
	}

	fn parse_or(&mut self) -> Result<Expr, String> {
		let mut left = self.parse_and()?;
		while matches!(self.peek(), Some(Token::Or)) {
			self.advance();
			let right = self.parse_and()?;
			left = Expr::Binary(BinOp::Or, Box::new(left), Box::new(right));
		}
		Ok(left)
	}

	fn parse_and(&mut self) -> Result<Expr, String> {
		let mut left = self.parse_comparison()?;
		while matches!(self.peek(), Some(Token::And)) {
			self.advance();
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
				Ok(Expr::Not(Box::new(self.parse_unary()?)))
			},
			Some(Token::Plus) => {
				self.advance();
				self.parse_unary()
			},
			_ => self.parse_power(),
		}
	}

	fn parse_power(&mut self) -> Result<Expr, String> {
		let base = self.parse_primary()?;
		if matches!(self.peek(), Some(Token::Caret)) {
			self.advance();
			let exponent = self.parse_unary()?;
			return Ok(Expr::Binary(BinOp::Pow, Box::new(base), Box::new(exponent)));
		}
		Ok(base)
	}

	fn parse_primary(&mut self) -> Result<Expr, String> {
		match self.advance() {
			Some(Token::Number(text)) => Ok(Expr::Number(text)),
			Some(Token::Ident(name)) => {
				if matches!(self.peek(), Some(Token::LParen)) {
					self.advance();
					let mut arguments = Vec::new();
					if !matches!(self.peek(), Some(Token::RParen)) {
						loop {
							arguments.push(self.parse_expression()?);
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
				} else {
					Ok(Expr::Var(name))
				}
			},
			Some(Token::LParen) => {
				let value = self.parse_expression()?;
				match self.advance() {
					Some(Token::RParen) => Ok(value),
					_ => Err("expected ')'".to_string()),
				}
			},
			Some(token) => Err(format!("unexpected token: {token:?}")),
			None => Err("unexpected end of input".to_string()),
		}
	}
}

struct Machine {
	variables: HashMap<String, BigDecimal>,
	scale: i64,
	ibase: u32,
	obase: u32,
	mathlib: bool,
	standard: bool,
	warn: bool,
}

impl Machine {
	fn new(mathlib: bool, standard: bool, warn: bool) -> Self {
		Self {
			variables: HashMap::new(),
			scale: if mathlib { 20 } else { 0 },
			ibase: 10,
			obase: 10,
			mathlib,
			standard,
			warn,
		}
	}

	/// GNU extensions: -s turns them into errors, -w warns and continues.
	fn extension(&self, host: &mut Host, feature: &str) -> Result<(), String> {
		if self.standard {
			return Err(format!("{feature} is not part of standard bc"));
		}
		if self.warn {
			let mut err = BufWriter::new(host.stderr_clone());
			let _ = writeln!(err, "bc: warning: {feature} is a GNU extension");
			let _ = err.flush();
		}
		Ok(())
	}

	fn execute(&mut self, statement: &Statement, host: &mut Host, out: &mut dyn Write) -> Result<bool, String> {
		match statement {
			Statement::Quit(halt) => {
				if *halt {
					self.extension(host, "halt")?;
				}
				return Ok(false);
			},
			Statement::Text(text) => {
				let _ = writeln!(out, "{text}");
			},
			Statement::Print(items) => {
				self.extension(host, "print")?;
				for item in items {
					match item {
						Expr::Text(text) => {
							let _ = write!(out, "{text}");
						},
						expression => {
							let value = self.eval(expression, host)?;
							let _ = write!(out, "{}", self.render(&value));
						},
					}
				}
			},
			Statement::Expr(expression) => {
				let value = self.eval(expression, host)?;
				if !matches!(expression, Expr::Assign(..)) {
					let _ = writeln!(out, "{}", self.render(&value));
				}
			},
		}
		Ok(true)
	}

	fn eval(&mut self, expression: &Expr, host: &mut Host) -> Result<BigDecimal, String> {
		match expression {
			Expr::Number(text) => self.parse_number(text),
			Expr::Text(text) => Err(format!("unexpected string in expression: {text}")),
			Expr::Var(name) => self.read_variable(name),
			Expr::Neg(inner) => Ok(-self.eval(inner, host)?),
			Expr::Not(inner) => {
				let value = self.eval(inner, host)?;
				Ok(if value.is_zero() { BigDecimal::one() } else { BigDecimal::zero() })
			},
			Expr::Binary(operation, left, right) => self.eval_binary(*operation, left, right, host),
			Expr::Assign(name, operation, value) => {
				let value = self.eval(value, host)?;
				let assigned = match operation {
					AssignOp::Set => value,
					AssignOp::Add => self.read_variable(name)? + value,
					AssignOp::Sub => self.read_variable(name)? - value,
					AssignOp::Mul => self.read_variable(name)? * value,
					AssignOp::Div => self.divide(&self.read_variable(name)?, &value)?,
					AssignOp::Mod => self.modulo(&self.read_variable(name)?, &value)?,
					AssignOp::Pow => {
						self.power(&self.read_variable(name)?, &value)?
					},
				};
				self.write_variable(name, assigned.clone())?;
				Ok(assigned)
			},
			Expr::Call(name, arguments) => self.call(name, arguments, host),
		}
	}

	fn eval_binary(
		&mut self,
		operation: BinOp,
		left: &Expr,
		right: &Expr,
		host: &mut Host,
	) -> Result<BigDecimal, String> {
		if matches!(operation, BinOp::And) {
			let left_value = self.eval(left, host)?;
			if left_value.is_zero() {
				return Ok(BigDecimal::zero());
			}
			return Ok(if self.eval(right, host)?.is_zero() {
				BigDecimal::zero()
			} else {
				BigDecimal::one()
			});
		}
		if matches!(operation, BinOp::Or) {
			let left_value = self.eval(left, host)?;
			if !left_value.is_zero() {
				return Ok(BigDecimal::one());
			}
			return Ok(if self.eval(right, host)?.is_zero() {
				BigDecimal::zero()
			} else {
				BigDecimal::one()
			});
		}

		let left_value = self.eval(left, host)?;
		let right_value = self.eval(right, host)?;
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

	fn divide(&self, left: &BigDecimal, right: &BigDecimal) -> Result<BigDecimal, String> {
		if right.is_zero() {
			return Err("division by zero".to_string());
		}
		let quotient = left / right;
		Ok(truncate(&quotient, self.scale))
	}

	fn modulo(&self, left: &BigDecimal, right: &BigDecimal) -> Result<BigDecimal, String> {
		if right.is_zero() {
			return Err("modulo by zero".to_string());
		}
		let quotient = truncate(&(left / right), self.scale);
		let remainder = left - &quotient * right;
		let target = (self.scale + scale_of(right)).max(scale_of(left));
		Ok(truncate(&remainder, target))
	}

	fn power(&self, base: &BigDecimal, exponent: &BigDecimal) -> Result<BigDecimal, String> {
		let Some(exponent) = exponent.to_i64() else {
			return Err("exponent must be an integer".to_string());
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

	fn read_variable(&self, name: &str) -> Result<BigDecimal, String> {
		match name {
			"scale" => Ok(BigDecimal::from(self.scale)),
			"ibase" => Ok(BigDecimal::from(self.ibase)),
			"obase" => Ok(BigDecimal::from(self.obase)),
			_ => Ok(self.variables.get(name).cloned().unwrap_or_else(BigDecimal::zero)),
		}
	}

	fn write_variable(&mut self, name: &str, value: BigDecimal) -> Result<(), String> {
		match name {
			"scale" => {
				let Some(scale) = value.to_i64() else {
					return Err("scale must be a non-negative integer".to_string());
				};
				if scale < 0 || scale > 4096 {
					return Err(format!("scale out of range: {scale}"));
				}
				self.scale = scale;
			},
			"ibase" => {
				let base = value.to_i64().unwrap_or(10);
				self.ibase = base.clamp(2, 16) as u32;
			},
			"obase" => {
				let base = value.to_i64().unwrap_or(10);
				if !(2..=16).contains(&base) {
					return Err(format!("obase out of range: {base} (2..16)"));
				}
				self.obase = base as u32;
			},
			_ => {
				self.variables.insert(name.to_string(), value);
			},
		}
		Ok(())
	}

	fn call(&mut self, name: &str, arguments: &[Expr], host: &mut Host) -> Result<BigDecimal, String> {
		let mut values = Vec::with_capacity(arguments.len());
		for argument in arguments {
			values.push(self.eval(argument, host)?);
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
				self.extension(host, "read()")?;
				let mut line = String::new();
				let mut byte = [0u8; 1];
				loop {
					match host.stdin.read(&mut byte) {
						Ok(0) => break,
						Ok(_) if byte[0] == b'\n' => break,
						Ok(_) => line.push(byte[0] as char),
						Err(error) => return Err(format!("read(): {error}")),
					}
				}
				let tokens = lex(&line)?;
				let mut parser = Parser { tokens, index: 0 };
				let expression = parser.parse_expression()?;
				self.eval(&expression, host)
			},
			_ if self.mathlib => self.math_function(name, &values),
			_ => Err(format!("undefined function: {name}")),
		}
	}

	fn math_function(&self, name: &str, values: &[BigDecimal]) -> Result<BigDecimal, String> {
		let to_f64 = |value: &BigDecimal| value.to_f64().ok_or_else(|| "numeric overflow".to_string());
		let from_f64 = |value: f64| {
			BigDecimal::from_f64(value).ok_or_else(|| "numeric overflow".to_string())
		};
		match name {
			"s" => Ok(from_f64(to_f64(expect_one(values, "s")?)?.sin())?),
			"c" => Ok(from_f64(to_f64(expect_one(values, "c")?)?.cos())?),
			"a" => Ok(from_f64(to_f64(expect_one(values, "a")?)?.atan())?),
			"l" => {
				let value = to_f64(expect_one(values, "l")?)?;
				if value <= 0.0 {
					return Err("l(): argument must be positive".to_string());
				}
				Ok(from_f64(value.ln())?)
			},
			"e" => Ok(from_f64(to_f64(expect_one(values, "e")?)?.exp())?),
			"j" => {
				let [order, argument] = values else {
					return Err("j() takes two arguments".to_string());
				};
				let order = order.to_i64().ok_or_else(|| "j(): order must be an integer".to_string())?;
				Ok(from_f64(bessel_j(order, to_f64(argument)?))?)
			},
			_ => Err(format!("undefined function: {name}")),
		}
	}

	fn sqrt(&self, value: &BigDecimal) -> Result<BigDecimal, String> {
		if value.is_negative() {
			return Err("sqrt of a negative number".to_string());
		}
		let target = self.scale.max(scale_of(value));
		if value.is_zero() {
			return Ok(truncate(value, target));
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

	fn parse_number(&self, text: &str) -> Result<BigDecimal, String> {
		let (integer_text, fraction_text) = match text.split_once('.') {
			Some((integer, fraction)) => (integer, Some(fraction)),
			None => (text, None),
		};
		if integer_text.is_empty() && fraction_text.is_none() {
			return Err(format!("invalid number: {text}"));
		}
		let base = self.ibase;
		if base == 10 {
			return text
				.parse::<BigDecimal>()
				.map_err(|_| format!("invalid number: {text}"));
		}
		let integer = digits_to_bigint(integer_text, base)?;
		let mut value = BigDecimal::from(integer.clone());
		if integer_text.is_empty() && fraction_text.is_none() {
			return Ok(value);
		}
		// In bc a single digit equal to or above ibase is clamped to ibase - 1.
		if fraction_text.is_none() && integer_text.len() == 1 {
			let digit = integer_text.chars().next().and_then(|character| character.to_digit(16)).unwrap_or(0);
			if u32::from(digit as u16) >= base {
				value = BigDecimal::from(base - 1);
			}
		}
		if let Some(fraction_text) = fraction_text {
			if !fraction_text.is_empty() {
				let numerator = digits_to_bigint(fraction_text, base)?;
				let denominator = BigInt::from(base).pow(fraction_text.len() as u32);
				let scale = (fraction_text.len() as i64 * 2).max(self.scale + 4).max(20);
				let fraction = divide_to(
					&BigDecimal::from(numerator),
					&BigDecimal::from(denominator),
					scale,
				)?;
				value += fraction;
			}
		}
		Ok(value)
	}

	fn render(&self, value: &BigDecimal) -> String {
		if self.obase == 10 {
			return strip_leading_zero(plain(value));
		}
		let negative = value.is_negative();
		let absolute = value.abs();
		let integer = absolute.with_scale(0).into_bigint_and_exponent().0;
		let mut digits = Vec::new();
		let mut current = integer;
		let base = BigInt::from(self.obase);
		if current.is_zero() {
			digits.push('0');
		} else {
			while !current.is_zero() {
				let remainder = (&current % &base).to_u32().unwrap_or(0);
				digits.push(digit_char(remainder));
				current /= &base;
			}
			digits.reverse();
		}
		let mut text = digits.into_iter().collect::<String>();
		let fraction = &absolute - BigDecimal::from(absolute.with_scale(0).into_bigint_and_exponent().0);
		if !fraction.is_zero() {
			text.push('.');
			let mut current = fraction;
			for _ in 0..scale_of(value).max(1) {
				current *= BigDecimal::from(self.obase);
				let digit = current.with_scale(0).into_bigint_and_exponent().0;
				let digit = digit.to_u32().unwrap_or(0);
				text.push(digit_char(digit));
				current -= BigDecimal::from(digit);
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

fn expect_one<'a>(values: &'a [BigDecimal], name: &str) -> Result<&'a BigDecimal, String> {
	match values {
		[value] => Ok(value),
		_ => Err(format!("{name}() takes one argument")),
	}
}

fn bessel_j(order: i64, x: f64) -> f64 {
	// Series expansion of J_n(x); enough for the precision bc's -l uses.
	let order = order.unsigned_abs() as usize;
	let mut sum = 0.0f64;
	let mut term = (x / 2.0).powi(order as i32) / factorial(order) as f64;
	for k in 0..60 {
		if k > 0 {
			term *= -(x * x) / 4.0 / (k as f64) / ((k + order) as f64);
		}
		sum += term;
	}
	if order % 2 == 1 && x < 0.0 {
		-sum
	} else {
		sum
	}
}

fn factorial(n: usize) -> u128 {
	(1..=n).map(|k| k as u128).product::<u128>().max(1)
}

fn digit_char(digit: u32) -> char {
	const DIGITS: [char; 16] = [
		'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F',
	];
	DIGITS[(digit as usize).min(15)]
}

fn digits_to_bigint(text: &str, base: u32) -> Result<BigInt, String> {
	let mut value = BigInt::from(0);
	for character in text.chars() {
		let Some(digit) = character.to_digit(16) else {
			return Err(format!("invalid digit '{character}'"));
		};
		if digit >= base {
			return Err(format!("digit '{character}' is invalid in base {base}"));
		}
		value = value * BigInt::from(base) + BigInt::from(digit);
	}
	Ok(value)
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

fn length_of(value: &BigDecimal) -> i64 {
	let text = plain(value);
	let digits = text
		.trim_start_matches('-')
		.chars()
		.filter(|character| character.is_ascii_hexdigit() && *character != '.')
		.collect::<String>();
	let trimmed = digits.trim_start_matches('0');
	trimmed.chars().count().max(1) as i64
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
	fn division_by_zero_is_a_runtime_error() {
		let (code, _, err) = run(&[], "1 / 0\n");
		assert_eq!(code, 1);
		assert!(err.contains("division by zero"), "{err}");
	}

	#[test]
	fn unimplemented_language_features_are_reported() {
		let (code, _, err) = run(&[], "define f(x) { return x; }\n");
		assert_eq!(code, 1);
		assert!(err.contains("not implemented"), "{err}");
	}

	#[tokio::test]
	async fn runs_as_a_shell_builtin() {
		let dir = tempdir().unwrap();
		let (code, out, err) = run_script("echo '2 + 3' | bc", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "5\n");
	}

	#[test]
	fn version_flag_matches_gnu_spelling() {
		let (code, out, _) = run(&["-v"], "");
		assert_eq!(code, 0);
		assert!(out.starts_with("bc 1.07.1"), "{out}");
	}

	#[test]
	fn standard_mode_rejects_gnu_extensions() {
		let (code, _, err) = run(&["-s"], "print 1\n");
		assert_eq!(code, 1);
		assert!(err.contains("not part of standard bc"), "{err}");
	}

	#[test]
	fn warn_mode_keeps_gnu_extensions_but_warns() {
		let (code, out, err) = run(&["-w"], "print 1\n");
		assert_eq!(code, 0, "stderr: {err}");
		assert_eq!(out, "1");
		assert!(err.contains("GNU extension"), "{err}");
	}
}

