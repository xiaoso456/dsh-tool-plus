use std::io::{self, Read};

use super::LineEndings;

/// Streams a file through Info-ZIP's `-l` / `-ll` line-ending conversion.
/// A CR immediately before LF is never doubled, so already-CRLF input is
/// stable under `-l`; `-ll` turns CRLF into LF and leaves lone CR untouched.
pub(super) struct LineEndingReader<R> {
	inner:       R,
	mode:        LineEndings,
	output:      Vec<u8>,
	position:    usize,
	last_was_cr: bool,
	pending_cr:  bool,
}

impl<R: Read> LineEndingReader<R> {
	pub(super) fn new(inner: R, mode: LineEndings) -> Self {
		Self {
			inner,
			mode,
			output: Vec::with_capacity(16 * 1024),
			position: 0,
			last_was_cr: false,
			pending_cr: false,
		}
	}

	fn translate(&mut self, input: &[u8]) {
		for &byte in input {
			match self.mode {
				LineEndings::LfToCrlf => {
					if byte == b'\n' && !self.last_was_cr {
						self.output.push(b'\r');
					}
					self.output.push(byte);
					self.last_was_cr = byte == b'\r';
				},
				LineEndings::CrlfToLf => {
					if self.pending_cr {
						if byte == b'\n' {
							self.output.push(b'\n');
							self.pending_cr = false;
							continue;
						}
						self.output.push(b'\r');
						self.pending_cr = false;
					}
					if byte == b'\r' {
						self.pending_cr = true;
					} else {
						self.output.push(byte);
					}
				},
			}
		}
	}
}

impl<R: Read> Read for LineEndingReader<R> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		let mut input = [0u8; 8192];
		while self.position == self.output.len() {
			self.output.clear();
			self.position = 0;
			let read = self.inner.read(&mut input)?;
			if read == 0 {
				if self.pending_cr {
					self.output.push(b'\r');
					self.pending_cr = false;
					continue;
				}
				return Ok(0);
			}
			self.translate(&input[..read]);
		}
		let available = self.output.len() - self.position;
		let count = available.min(buf.len());
		buf[..count].copy_from_slice(&self.output[self.position..self.position + count]);
		self.position += count;
		Ok(count)
	}
}
