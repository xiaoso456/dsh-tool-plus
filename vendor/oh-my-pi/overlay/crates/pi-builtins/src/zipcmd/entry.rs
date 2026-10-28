use std::{
	collections::VecDeque,
	io::{self, Read, Write},
	path::{Path, PathBuf},
	time::SystemTime,
};

use pi_vfs::{BlockingFs, File, FileTime, Metadata, TempOptions};
use regex::RegexBuilder;
use zip::{AesMode, DateTime, ZipWriter, write::{FileOptions, FullFileOptions}};

use crate::host::Host;

use super::{Config, ZipError, ZipResult, archive_base, child_archive_name, report};

/// One file, directory, or symlink that will become an archive entry.
pub(super) struct Entry {
	pub(super) native: PathBuf,
	pub(super) name: String,
	pub(super) metadata: Metadata,
	pub(super) symlink_target: Option<PathBuf>,
	pub(super) comment: Option<String>,
}

pub(super) fn collect_operand(
	host: &Host,
	operand: &Path,
	config: &Config,
) -> ZipResult<Vec<Entry>> {
	let native = host.resolve(operand);
	let name = archive_base(
		operand,
		config.junk_paths,
		config.preserve_paths,
		config.absolute_paths,
		config.dos_names,
	);
	let mut entries = Vec::new();
	collect_path(host.fs(), &native, &name, config, &mut entries)?;
	Ok(entries)
}

pub(super) fn collect_all(
	host: &mut Host,
	inputs: &[PathBuf],
	config: &Config,
) -> (Vec<Entry>, bool) {
	let mut entries = Vec::new();
	let mut failed = false;
	let mut comments = if config.entry_comments {
		let mut input = String::new();
		match host.stdin.read_to_string(&mut input) {
			Ok(_) => Some(input.lines().map(str::to_owned).collect::<VecDeque<_>>()),
			Err(error) => {
				report(host, &format!("standard input: {error}"));
				failed = true;
				None
			},
		}
	} else {
		None
	};
	for input in inputs {
		match collect_operand(host, input, config) {
			Ok(mut found) => {
				if let Some(comments) = comments.as_mut() {
					for entry in &mut found {
						entry.comment = comments.pop_front();
					}
				}
				entries.append(&mut found);
			},
			Err(error) => {
				report(host, &format!("{}: {error}", input.display()));
				failed = true;
			}
		}
	}
	entries.retain(|entry| config.date_filter.allows(entry.metadata.modified().ok()));
	if !config.include.is_empty() || !config.exclude.is_empty() {
		entries.retain(|entry| keep_name(&entry.name, config));
	}
	if !config.recurse_patterns.is_empty() {
		entries.retain(|entry| {
			config
				.recurse_patterns
				.iter()
				.any(|pattern| name_matches(pattern, &entry.name, config))
		});
	}
	(entries, failed)
}

/// Removes the source files of entries that were written to the archive.
/// Directories stay in place; only file and symlink entries are moved.
pub(super) fn remove_sources(host: &mut Host, entries: &[Entry]) {
	for entry in entries {
		if !entry.metadata.file_type().is_dir() {
			remove_file(host, &entry.native);
		}
	}
}

pub(super) fn remove_paths(host: &mut Host, paths: &[PathBuf]) {
	for path in paths {
		remove_file(host, path);
	}
}

fn remove_file(host: &mut Host, path: &Path) {
	if let Err(error) = host.fs().remove_file(path) {
		report(host, &format!("{}: {error}", path.display()));
	}
}

/// Info-ZIP -o: stamp the archive with the newest input file time.
pub(super) fn set_archive_time(host: &mut Host, archive: &Path, entries: &[Entry]) {
	let latest = entries
		.iter()
		.filter_map(|entry| entry.metadata.modified().ok())
		.max();
	if let Some(latest) = latest {
		set_archive_time_value(host, archive, latest);
	}
}

pub(super) fn set_archive_time_value(host: &mut Host, archive: &Path, latest: SystemTime) {
	let time = FileTime::from(latest);
	if let Err(error) = host.fs().set_times(archive, time, time, true) {
		report(host, &format!("{}: {error}", archive.display()));
	}
}

fn keep_name(name: &str, config: &Config) -> bool {
	let included = config.include.is_empty()
		|| config.include.iter().any(|pattern| name_matches(pattern, name, config));
	let excluded = config.exclude.iter().any(|pattern| name_matches(pattern, name, config));
	included && !excluded
}

pub(super) fn name_matches(pattern: &str, name: &str, config: &Config) -> bool {
	if config.regex {
		return RegexBuilder::new(pattern)
			.case_insensitive(config.ignore_case)
			.build()
			.is_ok_and(|pattern| pattern.is_match(name));
	}
	if config.no_wild {
		pattern == name
	} else {
		glob_match(pattern, name, config.ignore_case)
	}
}

fn glob_match(pattern: &str, name: &str, ignore_case: bool) -> bool {
	let options = glob::MatchOptions {
		case_sensitive: !ignore_case,
		..glob::MatchOptions::new()
	};
	glob::Pattern::new(pattern).is_ok_and(|pattern| pattern.matches_with(name, options))
}

fn collect_path(
	fs: &BlockingFs,
	native: &Path,
	name: &str,
	config: &Config,
	entries: &mut Vec<Entry>,
) -> ZipResult<()> {
	if native == config.archive {
		return Ok(());
	}

	let metadata = if config.symlinks {
		fs.symlink_metadata(native)?
	} else {
		fs.metadata(native)?
	};
	let file_type = metadata.file_type();
	if !config.system_hidden && hidden_or_system(&metadata) {
		return Ok(());
	}

	if file_type.is_symlink() {
		entries.push(Entry {
			native: native.to_owned(),
			name: name.to_owned(),
			metadata,
			symlink_target: Some(fs.read_link(native)?),
			comment: None,
		});
		return Ok(());
	}

	if file_type.is_dir() {
		if !name.is_empty() && config.store_dirs {
			entries.push(Entry {
				native: native.to_owned(),
				name: name.to_owned(),
				metadata,
				symlink_target: None,
				comment: None,
			});
		}
		if config.recurse {
			let mut children = fs.read_dir(native)?.collect::<Result<Vec<_>, _>>()?;
			children.sort_by_key(|entry| entry.file_name());
			for child in children {
				let child_path = child.path();
				let child_name = child.file_name().to_string_lossy().into_owned();
				let child_name = child_archive_name(name, &child_name, config.junk_paths);
				collect_path(fs, &child_path, &child_name, config, entries)?;
			}
		}
		return Ok(());
	}

	if file_type.is_file() {
		if config.archive_set && !has_archive_bit(&metadata) {
			return Ok(());
		}
		entries.push(Entry {
			native: native.to_owned(),
			name: name.to_owned(),
			metadata,
			symlink_target: None,
			comment: None,
		});
		return Ok(());
	}

	Err(ZipError::Message(format!(
		"unsupported file type: {}",
		native.display()
	)))
}

pub(super) fn create_archive(
	host: &mut Host,
	archive: &Path,
	entries: &[Entry],
	config: &Config,
) -> i32 {
	let (output, file, temporary) = match config.temp_dir.as_deref() {
		Some(directory) => match host.fs().create_temp(
			directory,
			&TempOptions::new().prefix(".zip-tmp-").suffix(".zip"),
		) {
			Ok((path, file)) => (path, file, true),
			Err(error) => {
				host.error(format!("{}: {error}", archive.display()), super::WRITE_ERROR);
				return super::WRITE_ERROR;
			},
		},
		None => match host.fs().create(&config.archive) {
			Ok(file) => (config.archive.clone(), file, false),
			Err(error) => {
				host.error(format!("{}: {error}", archive.display()), super::WRITE_ERROR);
				return super::WRITE_ERROR;
			},
		},
	};

	let mut writer = ZipWriter::new(file);
	if let Some(comment) = &config.comment {
		if let Err(error) = writer.set_raw_comment(comment.clone().into_boxed_slice()) {
			report(host, &format!("{}: {error}", archive.display()));
			return super::FAILURE;
		}
	}
	if let Err(error) = write_entries(&mut writer, host, entries, config) {
		report(host, &format!("{}: {error}", archive.display()));
		return super::FAILURE;
	}

	if let Err(error) = writer.finish() {
		host.error(format!("{}: {error}", archive.display()), super::WRITE_ERROR);
		return super::WRITE_ERROR;
	}

	if temporary {
		if let Err(error) = host.fs().rename(&output, &config.archive) {
			host.error(format!("{}: {error}", archive.display()), super::WRITE_ERROR);
			return super::WRITE_ERROR;
		}
	}

	0
}

pub(super) fn write_entries(
	writer: &mut ZipWriter<File>,
	host: &mut Host,
	entries: &[Entry],
	config: &Config,
) -> ZipResult<()> {
	for entry in entries {
		write_entry(writer, host, entry, config)?;
	}
	Ok(())
}

pub(super) fn write_entry(
	writer: &mut ZipWriter<File>,
	host: &mut Host,
	entry: &Entry,
	config: &Config,
) -> ZipResult<()> {
	if let Some(target) = &entry.symlink_target {
		let target = target.to_string_lossy().replace('\\', "/");
		writer.add_symlink(
			&entry.name,
			target,
			options(&entry.metadata, &entry.name, config, true, entry.comment.as_deref()),
		)?;
		progress(host, config, &entry.name);
		return Ok(());
	}

	if entry.metadata.file_type().is_dir() {
		writer.add_directory(
			&entry.name,
			options(&entry.metadata, &entry.name, config, false, entry.comment.as_deref()),
		)?;
		progress(host, config, &entry.name);
		return Ok(());
	}

	let file = host.fs().open(&entry.native)?;
	writer.start_file(
		&entry.name,
		options(&entry.metadata, &entry.name, config, true, entry.comment.as_deref()),
	)?;
	match config.line_endings {
		Some(mode) => io::copy(&mut super::line_endings::LineEndingReader::new(&file, mode), writer)?,
		None => io::copy(&mut &file, writer)?,
	};
	progress(host, config, &entry.name);
	Ok(())
}

fn progress(host: &mut Host, config: &Config, name: &str) {
	if !config.quiet {
		let _ = writeln!(host.stdout_writer(), "adding: {name}");
	}
}

fn options<'a>(
	metadata: &Metadata,
	name: &str,
	config: &'a Config,
	encrypt: bool,
	comment: Option<&str>,
) -> FullFileOptions<'a, 'static> {
	let large_file = config
		.zip64
		.unwrap_or(metadata.len() > u32::MAX as u64);
	let mut options: FullFileOptions<'a, 'static> = FileOptions::default().large_file(large_file);
	if config.exclude_extra {
		options = options.external_attributes(0);
	} else {
		options = options.unix_permissions(metadata.permissions().mode());
	}

	if let Some(modified) = zip_time(metadata) {
		options = options.last_modified_time(modified);
	}

	let mut options = if config.level == 0
		|| config.method == zip::CompressionMethod::Stored
		|| config
			.no_compress
			.iter()
			.any(|suffix| name.ends_with(suffix))
	{
		options.compression_method(zip::CompressionMethod::Stored)
	} else {
		options
			.compression_method(zip::CompressionMethod::Deflated)
			.compression_level(Some(config.level))
	};

	if encrypt {
		if let Some(password) = config.password.as_deref() {
			options = options.with_aes_encryption_bytes(AesMode::Aes256, password);
		}
	}
	if let Some(comment) = comment {
		options = options.with_file_comment(comment);
	}
	options
}

fn has_archive_bit(metadata: &Metadata) -> bool {
	#[cfg(windows)]
	{
		return metadata
			.file_attributes()
			.is_some_and(|attributes| attributes & 0x20 != 0);
	}
	#[cfg(not(windows))]
	{
		let _ = metadata;
		true
	}
}

pub(super) fn clear_archive_bits(host: &mut Host, entries: &[Entry]) {
	for entry in entries {
		if entry.metadata.file_type().is_file() {
			clear_archive_bit(host, &entry.native);
		}
	}
}

pub(super) fn clear_archive_bits_paths(host: &mut Host, paths: &[PathBuf]) {
	for path in paths {
		clear_archive_bit(host, path);
	}
}

fn clear_archive_bit(host: &mut Host, path: &Path) {
	#[cfg(windows)]
	{
		use std::os::windows::ffi::OsStrExt;
		use windows_sys::Win32::Storage::FileSystem::{GetFileAttributesW, SetFileAttributesW};

		let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
		let attributes = unsafe { GetFileAttributesW(wide.as_ptr()) };
		if attributes == u32::MAX {
			report(host, &format!("{}: cannot read attributes", path.display()));
			return;
		}
		if attributes & 0x20 == 0 {
			return;
		}
		if unsafe { SetFileAttributesW(wide.as_ptr(), attributes & !0x20) } == 0 {
			report(host, &format!("{}: cannot clear archive bit", path.display()));
		}
	}
	#[cfg(not(windows))]
	{
		let _ = (host, path);
	}
}

fn hidden_or_system(metadata: &Metadata) -> bool {
	#[cfg(windows)]
	{
		return metadata
			.file_attributes()
			.is_some_and(|attributes| attributes & 0x2 != 0 || attributes & 0x4 != 0);
	}
	#[cfg(not(windows))]
	{
		let _ = metadata;
		false
	}
}

pub(super) fn zip_time(metadata: &Metadata) -> Option<DateTime> {
	let system = metadata.modified().ok()?;
	let local: chrono::DateTime<chrono::Local> =
		chrono::DateTime::<chrono::Utc>::from(system).with_timezone(&chrono::Local);
	use chrono::{Datelike, Timelike};
	let (year, month, day, hour, minute, second) =
		(local.year(), local.month(), local.day(), local.hour(), local.minute(), local.second());
	DateTime::from_date_and_time(
		year as u16,
		month as u8,
		day as u8,
		hour as u8,
		minute as u8,
		second as u8,
	)
	.ok()
}
