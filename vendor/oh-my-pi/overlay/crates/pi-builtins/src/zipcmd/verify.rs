use std::{io, io::Write};

use zip::ZipArchive;

use crate::host::Host;

use super::report;

/// Read every entry once so the zip crate validates headers, CRCs, and
/// decompression streams. This is the Rust equivalent of zip -T.
pub(super) fn test(host: &mut Host, archive_path: &std::path::Path, config: &super::Config) -> i32 {
	let fs = host.fs().clone();
	let file = match fs.open(&config.archive) {
		Ok(file) => file,
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			return 3;
		},
	};
	let mut archive = match ZipArchive::new(file) {
		Ok(archive) => archive,
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			return 3;
		},
	};

	for index in 0..archive.len() {
		let entry = match config.password.as_deref() {
			Some(password) => archive.by_index_decrypt(index, password),
			None => archive.by_index(index),
		};
		let mut entry = match entry {
			Ok(entry) => entry,
			Err(error) => {
				report(host, &format!("{}: {error}", archive_path.display()));
				return 8;
			},
		};
		if let Err(error) = io::copy(&mut entry, &mut io::sink()) {
			report(host, &format!("{}: {error}", archive_path.display()));
			return 8;
		}
	}
	0
}

pub(super) fn list(host: &mut Host, archive_path: &std::path::Path, config: &super::Config) -> i32 {
	let fs = host.fs().clone();
	let file = match fs.open(&config.archive) {
		Ok(file) => file,
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			return 3;
		},
	};
	let mut archive = match ZipArchive::new(file) {
		Ok(archive) => archive,
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			return 3;
		},
	};

	let _ = writeln!(host.stdout_writer(), "Archive contains:");
	for index in 0..archive.len() {
		match archive.by_index(index).and_then(|entry| entry.name().map(|name| name.into_owned())) {
			Ok(name) => {
				let _ = writeln!(host.stdout_writer(), "  {name}");
			},
			Err(error) => {
				report(host, &format!("{}: {error}", archive_path.display()));
				return 8;
			},
		}
	}
	0
}
