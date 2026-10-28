use std::{
	collections::{HashMap, HashSet},
	io,
	path::{Path, PathBuf},
	time::SystemTime,
};

use pi_vfs::{BlockingFs, File, TempOptions};
use zip::{ZipArchive, ZipWriter, read::ZipFile};

use crate::host::Host;

use super::{
	Config, EMPTY_ARCHIVE, FAILURE, NOTHING_TO_DO, Operation, WRITE_ERROR, ZipResult, archive_base,
	entry, report,
};

pub(super) fn rewrite(
	host: &mut Host,
	archive_path: &Path,
	inputs: &[PathBuf],
	config: &Config,
) -> i32 {
	let fs = host.fs().clone();
	let existing = match open_archive(&fs, &config.archive) {
		Ok(archive) => archive,
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			return FAILURE;
		},
	};
	let (entries, failed) = entry::collect_all(host, inputs, config);

	let Some(archive) = existing else {
		if entries.is_empty() {
			return EMPTY_ARCHIVE;
		}
		if config.operation == Operation::Freshen {
			return NOTHING_TO_DO;
		}
		let status = entry::create_archive(host, archive_path, &entries, config);
		if status == 0 && config.latest_time {
			entry::set_archive_time(host, &config.archive, &entries);
		}
		if status == 0 && !failed && config.move_files {
			entry::remove_sources(host, &entries);
		}
		return if failed && status == 0 { FAILURE } else { status };
	};

	if entries.is_empty() {
		return if archive.len() == 0 {
			EMPTY_ARCHIVE
		} else {
			NOTHING_TO_DO
		};
	}
	if config.operation == Operation::Freshen && archive.len() == 0 {
		return NOTHING_TO_DO;
	}

	match rewrite_existing(host, archive, &entries, config) {
		Ok(outcome) if config.operation == Operation::Freshen && outcome.changed == 0 => NOTHING_TO_DO,
		Ok(_) if failed => FAILURE,
		Ok(outcome) => {
			if config.latest_time {
				if let Some(latest) = outcome.latest {
					entry::set_archive_time_value(host, &config.archive, latest);
				}
			}
			if config.move_files {
				entry::remove_paths(host, &outcome.moved);
			}
			0
		},
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			FAILURE
		},
	}
}

struct RewriteOutcome {
	changed: usize,
	moved:   Vec<PathBuf>,
	latest:  Option<SystemTime>,
}

fn rewrite_existing(
	host: &mut Host,
	mut archive: ZipArchive<File>,
	entries: &[entry::Entry],
	config: &Config,
) -> ZipResult<RewriteOutcome> {
	let fs = host.fs().clone();
	let existing_names: HashSet<String> = archive
		.file_names()
		.map(|name| name.map(|name| name.into_owned()))
		.collect::<Result<_, _>>()?;
	let source_by_name: HashMap<&str, &entry::Entry> = entries
		.iter()
		.map(|entry| (entry.name.as_str(), entry))
		.collect();

	let (temp_path, temp_file) = create_temp(&fs, &config.archive, config)?;
	let mut writer = ZipWriter::new(temp_file);
	let comment = config
		.comment
		.clone()
		.unwrap_or_else(|| archive.comment().to_vec());
	if let Err(error) = writer.set_raw_comment(comment.into_boxed_slice()) {
		let _ = fs.remove_file(&temp_path);
		return Err(error.into());
	}

	let result: ZipResult<RewriteOutcome> = (|| {
		let mut replaced = HashSet::new();
		let mut changed = 0;
		let mut moved = Vec::new();
		let mut latest = None;
		for index in 0..archive.len() {
			let file = archive.by_index_raw(index)?;
			let name = file.name()?.into_owned();
			let source = source_by_name.get(name.as_str());
			let keep = match config.operation {
				Operation::Update | Operation::Freshen => {
					source.is_none_or(|source| !is_newer(source, &file))
				},
				Operation::FileSync => source.is_some_and(|source| !is_changed(source, &file)),
				Operation::Grow => true,
				_ => true,
			};
			if keep {
				writer.raw_copy_file(file)?;
			} else {
				replaced.insert(name);
			}
		}

		for entry in entries {
			let exists = existing_names.contains(&entry.name);
			let add = match config.operation {
				Operation::Update => !exists || replaced.contains(&entry.name),
				Operation::Freshen => replaced.contains(&entry.name),
				Operation::Grow => !exists,
				Operation::FileSync => !exists || replaced.contains(&entry.name),
				_ => false,
			};
			if add {
				entry::write_entry(&mut writer, host, entry, config)?;
				changed += 1;
				moved.push(entry.native.clone());
				if let Ok(modified) = entry.metadata.modified() {
					latest = Some(latest.map_or(modified, |current: SystemTime| current.max(modified)));
				}
			}
		}
		Ok(RewriteOutcome { changed, moved, latest })
	})();

	let outcome = match result {
		Ok(outcome) => outcome,
		Err(error) => {
			let _ = fs.remove_file(&temp_path);
			return Err(error);
		},
	};

	finish(&fs, writer, &temp_path, &config.archive)?;
	Ok(outcome)
}

fn is_newer(source: &entry::Entry, archived: &ZipFile<'_, File>) -> bool {
	match (entry::zip_time(&source.metadata), archived.last_modified()) {
		(Some(source), Some(archived)) => source > archived,
		_ => true,
	}
}

fn is_changed(source: &entry::Entry, archived: &ZipFile<'_, File>) -> bool {
	if source.metadata.len() != archived.size() {
		return true;
	}
	match (entry::zip_time(&source.metadata), archived.last_modified()) {
		(Some(source), Some(archived)) => source != archived,
		_ => true,
	}
}

pub(super) fn comment(host: &mut Host, archive_path: &Path, config: &Config) -> i32 {
	let fs = host.fs().clone();
	let mut archive = match open_archive(&fs, &config.archive) {
		Ok(Some(archive)) => archive,
		Ok(None) => {
			report(host, &format!("{}: no such file", archive_path.display()));
			return 3;
		},
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			return 3;
		},
	};
	let (temp_path, temp_file) = match create_temp(&fs, &config.archive, config) {
		Ok(temp) => temp,
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			return WRITE_ERROR;
		},
	};
	let mut writer = ZipWriter::new(temp_file);
	let comment = config.comment.clone().unwrap_or_default();
	if let Err(error) = writer.set_raw_comment(comment.into_boxed_slice()) {
		let _ = fs.remove_file(&temp_path);
		report(host, &format!("{}: {error}", archive_path.display()));
		return FAILURE;
	}

	for index in 0..archive.len() {
		let file = match archive.by_index_raw(index) {
			Ok(file) => file,
			Err(error) => {
				let _ = fs.remove_file(&temp_path);
				report(host, &format!("{}: {error}", archive_path.display()));
				return FAILURE;
			},
		};
		if let Err(error) = writer.raw_copy_file(file) {
			let _ = fs.remove_file(&temp_path);
			report(host, &format!("{}: {error}", archive_path.display()));
			return FAILURE;
		}
	}

	if let Err(error) = finish(&fs, writer, &temp_path, &config.archive) {
		report(host, &format!("{}: {error}", archive_path.display()));
		return WRITE_ERROR;
	}
	0
}

pub(super) fn delete(
	host: &mut Host,
	archive_path: &Path,
	inputs: &[PathBuf],
	config: &Config,
) -> i32 {
	let fs = host.fs().clone();
	let mut archive = match open_archive(&fs, &config.archive) {
		Ok(Some(archive)) => archive,
		Ok(None) => return EMPTY_ARCHIVE,
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			return FAILURE;
		},
	};

	let total = archive.len();
	if total == 0 {
		return EMPTY_ARCHIVE;
	}

	let names: HashSet<String> = inputs
		.iter()
		.map(|input| {
			let name = archive_base(input, config.junk_paths, false, false);
			if config.ignore_case { name.to_lowercase() } else { name }
		})
		.collect();
	if names.is_empty() {
		return NOTHING_TO_DO;
	}

	let (temp_path, temp_file) = match create_temp(&fs, &config.archive, config) {
		Ok(temp) => temp,
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			return WRITE_ERROR;
		},
	};
	let mut writer = ZipWriter::new(temp_file);
	let comment = config
		.comment
		.clone()
		.unwrap_or_else(|| archive.comment().to_vec());
	if let Err(error) = writer.set_raw_comment(comment.into_boxed_slice()) {
		let _ = fs.remove_file(&temp_path);
		report(host, &format!("{}: {error}", archive_path.display()));
		return FAILURE;
	}

	let result: ZipResult<usize> = (|| {
		let mut removed = 0;
		for index in 0..archive.len() {
			let file = archive.by_index_raw(index)?;
			let name = file.name()?.into_owned();
			let matched = if config.ignore_case {
				names.contains(&name.to_lowercase())
			} else {
				names.contains(&name)
			};
			if matched {
				removed += 1;
			} else {
				writer.raw_copy_file(file)?;
			}
		}
		Ok(removed)
	})();

	let removed = match result {
		Ok(removed) => removed,
		Err(error) => {
			let _ = fs.remove_file(&temp_path);
			report(host, &format!("{}: {error}", archive_path.display()));
			return FAILURE;
		},
	};

	if removed == 0 {
		let _ = fs.remove_file(&temp_path);
		report(host, &format!("{}: name not matched", archive_path.display()));
		return NOTHING_TO_DO;
	}

	if let Err(error) = finish(&fs, writer, &temp_path, &config.archive) {
		report(host, &format!("{}: {error}", archive_path.display()));
		return WRITE_ERROR;
	}

	if removed == total {
		report(host, "warning: archive is empty");
	}
	0
}

pub(super) fn difference(
	host: &mut Host,
	archive_path: &Path,
	inputs: &[PathBuf],
	config: &Config,
) -> i32 {
	let fs = host.fs().clone();
	let mut archive = match open_archive(&fs, &config.archive) {
		Ok(Some(archive)) => archive,
		Ok(None) => return EMPTY_ARCHIVE,
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			return FAILURE;
		},
	};
	let Some(out) = config.out.as_deref() else {
		report(host, "--out requires an archive");
		return 16;
	};

	let mut existing = HashMap::new();
	for index in 0..archive.len() {
		let file = match archive.by_index_raw(index) {
			Ok(file) => file,
			Err(error) => {
				report(host, &format!("{}: {error}", archive_path.display()));
				return FAILURE;
			},
		};
		let name = match file.name() {
			Ok(name) => name.into_owned(),
			Err(error) => {
				report(host, &format!("{}: {error}", archive_path.display()));
				return FAILURE;
			},
		};
		existing.insert(name, (file.size(), file.last_modified()));
	}

	let (mut entries, failed) = entry::collect_all(host, inputs, config);
	entries.retain(|entry| {
		existing.get(&entry.name).is_none_or(|(size, time)| {
			*size != entry.metadata.len() || *time != entry::zip_time(&entry.metadata)
		})
	});
	if entries.is_empty() {
		return NOTHING_TO_DO;
	}

	let (temp_path, temp_file) = match create_temp(&fs, out, config) {
		Ok(temp) => temp,
		Err(error) => {
			report(host, &format!("{}: {error}", out.display()));
			return WRITE_ERROR;
		},
	};
	let mut writer = ZipWriter::new(temp_file);
	if let Some(comment) = &config.comment {
		if let Err(error) = writer.set_raw_comment(comment.clone().into_boxed_slice()) {
			let _ = fs.remove_file(&temp_path);
			report(host, &format!("{}: {error}", out.display()));
			return FAILURE;
		}
	}
	if let Err(error) = entry::write_entries(&mut writer, host, &entries, config) {
		let _ = fs.remove_file(&temp_path);
		report(host, &format!("{}: {error}", out.display()));
		return FAILURE;
	}
	if let Err(error) = finish(&fs, writer, &temp_path, out) {
		report(host, &format!("{}: {error}", out.display()));
		return WRITE_ERROR;
	}
	if failed { FAILURE } else { 0 }
}

pub(super) fn copy(
	host: &mut Host,
	archive_path: &Path,
	inputs: &[PathBuf],
	config: &Config,
) -> i32 {
	let fs = host.fs().clone();
	let mut archive = match open_archive(&fs, &config.archive) {
		Ok(Some(archive)) => archive,
		Ok(None) => return EMPTY_ARCHIVE,
		Err(error) => {
			report(host, &format!("{}: {error}", archive_path.display()));
			return FAILURE;
		},
	};
	let Some(out) = config.out.as_deref() else {
		report(host, "--out requires an archive");
		return 16;
	};

	let selected: HashSet<String> = if inputs.is_empty() {
		archive
			.file_names()
			.map(|name| name.map(|name| name.into_owned()))
			.collect::<Result<_, _>>()
			.unwrap_or_default()
	} else {
		let patterns: Vec<String> = inputs
			.iter()
			.map(|input| archive_base(input, false, false, false))
			.collect();
		archive
			.file_names()
			.filter_map(|name| name.ok())
			.filter(|name| patterns.iter().any(|pattern| entry::name_matches(pattern, name, config)))
			.map(|name| name.into_owned())
			.collect()
	};
	if selected.is_empty() {
		return NOTHING_TO_DO;
	}

	let (temp_path, temp_file) = match create_temp(&fs, out, config) {
		Ok(temp) => temp,
		Err(error) => {
			report(host, &format!("{}: {error}", out.display()));
			return WRITE_ERROR;
		},
	};
	let mut writer = ZipWriter::new(temp_file);
	let comment = config
		.comment
		.clone()
		.unwrap_or_else(|| archive.comment().to_vec());
	if let Err(error) = writer.set_raw_comment(comment.into_boxed_slice()) {
		let _ = fs.remove_file(&temp_path);
		report(host, &format!("{}: {error}", out.display()));
		return FAILURE;
	}

	let result: ZipResult<()> = (|| {
		for index in 0..archive.len() {
			let file = archive.by_index_raw(index)?;
			let name = file.name()?.into_owned();
			if selected.contains(&name) {
				writer.raw_copy_file(file)?;
			}
		}
		Ok(())
	})();
	if let Err(error) = result {
		let _ = fs.remove_file(&temp_path);
		report(host, &format!("{}: {error}", out.display()));
		return FAILURE;
	}

	if let Err(error) = finish(&fs, writer, &temp_path, out) {
		report(host, &format!("{}: {error}", out.display()));
		return WRITE_ERROR;
	}
	0
}

fn open_archive(fs: &BlockingFs, path: &Path) -> ZipResult<Option<ZipArchive<File>>> {
	match fs.open(path) {
		Ok(file) => Ok(Some(ZipArchive::new(file)?)),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
		Err(error) => Err(error.into()),
	}
}

fn create_temp(fs: &BlockingFs, archive: &Path, config: &Config) -> ZipResult<(PathBuf, File)> {
	let parent = config.temp_dir.as_deref().unwrap_or_else(|| {
		archive
			.parent()
			.filter(|parent| !parent.as_os_str().is_empty())
			.unwrap_or_else(|| Path::new("."))
	});
	let options = TempOptions::new().prefix(".zip-tmp-").suffix(".zip");
	Ok(fs.create_temp(parent, &options)?)
}

fn finish(
	fs: &BlockingFs,
	writer: ZipWriter<File>,
	temp_path: &Path,
	archive: &Path,
) -> ZipResult<()> {
	writer.finish()?;
	fs.rename(temp_path, archive)?;
	Ok(())
}
