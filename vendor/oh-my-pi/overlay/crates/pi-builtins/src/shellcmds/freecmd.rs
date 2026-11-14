//! free builtin: display the amount of free and used memory.
//!
//! Windows has no free(1) and no /proc/meminfo. This implementation reports
//! Windows memory through GlobalMemoryStatusEx/GetPerformanceInfo and reads
//! /proc/meminfo on Unix, sharing one procps-compatible formatter.

use std::{
	collections::HashMap,
	io::{BufWriter, Write},
	time::Duration,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, parser::ValueSource};

use crate::host::{Host, Utility, matches_parser, util};

/// Display free and used memory.
pub(crate) struct Free {
	matches: ArgMatches,
}

matches_parser!(Free, app);

impl Utility for Free {
	const NAME: &'static str = "free";

	fn run(self, host: &mut Host) -> i32 {
		if self.matches.get_flag("version") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = writeln!(out, "free from procps-ng 4.0.4 (pi-builtins)");
			let _ = out.flush();
			return 0;
		}
		if self.matches.get_flag("help") {
			let mut out = BufWriter::new(host.stdout_clone());
			let _ = write!(out, "{}", app().render_help());
			let _ = out.flush();
			return 0;
		}

		let scale = match selected_scale(&self.matches) {
			Ok(scale) => scale,
			Err(message) => {
				host.error(message, 1);
				return 1;
			},
		};
		let lohi = self.matches.get_flag("lohi");
		if lohi && cfg!(windows) {
			host.error("-l/--lohi is not supported on Windows: there is no low/high memory split", 1);
			return 1;
		}

		let seconds = match self.matches.get_one::<String>("seconds") {
			Some(text) => match text.parse::<f64>() {
				Ok(value) if value.is_finite() && value > 0.0 => Some(value),
				_ => {
					host.error(format!("seconds argument '{text}' is not a positive number"), 1);
					return 1;
				},
			},
			None => None,
		};
		let count = match self.matches.get_one::<u64>("count").copied() {
			Some(0) => {
				host.error("count must be at least 1", 1);
				return 1;
			},
			other => other,
		};
		let interval = seconds.unwrap_or(1.0);
		let repeat = seconds.is_some() || count.is_some();
		let wide = self.matches.get_flag("wide");
		let line = self.matches.get_flag("line");
		let total = self.matches.get_flag("total");
		let committed = self.matches.get_flag("committed");

		let mut out = BufWriter::new(host.stdout_clone());
		let mut printed = 0u64;
		loop {
			let snapshot = match sample() {
				Ok(snapshot) => snapshot,
				Err(message) => {
					host.error(message, 1);
					return 1;
				},
			};
			let block = render(&snapshot, scale, wide, lohi, line, total, committed);
			if out.write_all(block.as_bytes()).is_err() || out.flush().is_err() {
				return 1;
			}
			printed += 1;
			if let Some(limit) = count {
				if printed >= limit {
					break;
				}
			}
			if !repeat {
				break;
			}
			let _ = out.write_all(b"\n");
			let _ = out.flush();
			std::thread::sleep(Duration::from_secs_f64(interval));
		}
		0
	}
}

pub(crate) fn free_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Free, SE>()
}

fn app() -> Command {
	Command::new("free")
		.disable_help_flag(true)
		.disable_version_flag(true)
		.about("Display amount of free and used memory in the system")
		.arg(
			Arg::new("bytes")
				.short('b')
				.long("bytes")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("kibi")
				.short('k')
				.long("kibi")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("mebi")
				.short('m')
				.long("mebi")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("gibi")
				.short('g')
				.long("gibi")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("tebi").long("tebi").action(ArgAction::SetTrue))
		.arg(Arg::new("pebi").long("pebi").action(ArgAction::SetTrue))
		.arg(Arg::new("kilo").long("kilo").action(ArgAction::SetTrue))
		.arg(Arg::new("mega").long("mega").action(ArgAction::SetTrue))
		.arg(Arg::new("giga").long("giga").action(ArgAction::SetTrue))
		.arg(Arg::new("tera").long("tera").action(ArgAction::SetTrue))
		.arg(Arg::new("peta").long("peta").action(ArgAction::SetTrue))
		.arg(
			Arg::new("human")
				.short('h')
				.long("human")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("si").long("si").action(ArgAction::SetTrue))
		.arg(
			Arg::new("lohi")
				.short('l')
				.long("lohi")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("line")
				.short('L')
				.long("line")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("total")
				.short('t')
				.long("total")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("committed")
				.short('v')
				.long("committed")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new("seconds")
				.short('s')
				.long("seconds")
				.value_name("seconds"),
		)
		.arg(
			Arg::new("count")
				.short('c')
				.long("count")
				.value_name("count")
				.value_parser(clap::value_parser!(u64)),
		)
		.arg(
			Arg::new("wide")
				.short('w')
				.long("wide")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::SetTrue))
		.arg(
			Arg::new("version")
				.short('V')
				.long("version")
				.action(ArgAction::SetTrue),
		)
}

#[derive(Clone, Copy)]
struct Scale {
	exponent: u32,
	si:       bool,
	human:    bool,
}

fn selected_scale(matches: &ArgMatches) -> Result<Scale, &'static str> {
	let units = [
		("bytes", 1, false),
		("kibi", 2, false),
		("mebi", 3, false),
		("gibi", 4, false),
		("tebi", 5, false),
		("pebi", 6, false),
		("kilo", 2, true),
		("mega", 3, true),
		("giga", 4, true),
		("tera", 5, true),
		("peta", 6, true),
	];
	let mut chosen = None;
	for (id, exponent, si) in units {
		if matches.value_source(id) != Some(ValueSource::CommandLine) {
			continue;
		}
		if chosen.is_some() {
			return Err("Multiple unit options don't make sense.");
		}
		chosen = Some((exponent, si));
	}
	let (exponent, si) = chosen.unwrap_or((0, matches.get_flag("si")));
	Ok(Scale { exponent, si, human: matches.get_flag("human") })
}

#[derive(Clone, Copy, Default)]
struct Region {
	total: u64,
	used:  u64,
	free:  u64,
}

struct Snapshot {
	total:        u64,
	free:         u64,
	used:         u64,
	shared:       u64,
	buffers:      u64,
	cached:       u64,
	available:    u64,
	swap_total:   u64,
	swap_used:    u64,
	swap_free:    u64,
	low:          Region,
	high:         Region,
	commit_limit: u64,
	committed:    u64,
}

fn render(
	snapshot: &Snapshot,
	scale: Scale,
	wide: bool,
	lohi: bool,
	line: bool,
	total: bool,
	committed: bool,
) -> String {
	let mut out = String::new();
	if line {
		let values = [
			snapshot.swap_used,
			snapshot.buffers.saturating_add(snapshot.cached),
			snapshot.used,
			snapshot.free,
		];
		let labels = ["SwapUse", "CachUse", " MemUse", "MemFree"];
		for (label, value) in labels.iter().zip(values) {
			out.push_str(&format!("{label} {:>11} ", scale_size(value, scale)));
		}
		out.push('\n');
		return out;
	}

	let labels: &[&str] = if wide {
		&["total", "used", "free", "shared", "buffers", "cache", "available"]
	} else {
		&["total", "used", "free", "shared", "buff/cache", "available"]
	};
	out.push_str(&format!("{:<9}{:>11}", "", labels[0]));
	for label in &labels[1..] {
		out.push_str(&format!(" {:>11}", label));
	}
	out.push('\n');

	let memory: Vec<u64> = if wide {
		vec![
			snapshot.total,
			snapshot.used,
			snapshot.free,
			snapshot.shared,
			snapshot.buffers,
			snapshot.cached,
			snapshot.available,
		]
	} else {
		vec![
			snapshot.total,
			snapshot.used,
			snapshot.free,
			snapshot.shared,
			snapshot.buffers.saturating_add(snapshot.cached),
			snapshot.available,
		]
	};
	push_row(&mut out, "Mem:", &memory, scale);
	if lohi {
		push_row(
			&mut out,
			"Low:",
			&[snapshot.low.total, snapshot.low.used, snapshot.low.free],
			scale,
		);
		push_row(
			&mut out,
			"High:",
			&[snapshot.high.total, snapshot.high.used, snapshot.high.free],
			scale,
		);
	}
	push_row(
		&mut out,
		"Swap:",
		&[snapshot.swap_total, snapshot.swap_used, snapshot.swap_free],
		scale,
	);
	if total {
		push_row(
			&mut out,
			"Total:",
			&[
				snapshot.total.saturating_add(snapshot.swap_total),
				snapshot.used.saturating_add(snapshot.swap_used),
				snapshot.free.saturating_add(snapshot.swap_free),
			],
			scale,
		);
	}
	if committed {
		push_row(
			&mut out,
			"Comm:",
			&[
				snapshot.commit_limit,
				snapshot.committed,
				snapshot.commit_limit.saturating_sub(snapshot.committed),
			],
			scale,
		);
	}
	out
}

fn push_row(out: &mut String, label: &str, values: &[u64], scale: Scale) {
	out.push_str(&format!("{label:<9}"));
	for (index, value) in values.iter().enumerate() {
		let separator = if index == 0 { "" } else { " " };
		out.push_str(&format!("{separator}{:>11}", scale_size(*value, scale)));
	}
	out.push('\n');
}

fn scale_size(bytes: u64, scale: Scale) -> String {
	if scale.human {
		return human_size(bytes, scale.si);
	}
	let base: u64 = if scale.si { 1000 } else { 1024 };
	let value = match scale.exponent {
		0 => bytes / base,
		1 => bytes,
		exponent => bytes / base.pow(exponent - 1),
	};
	value.to_string()
}

fn human_size(bytes: u64, si: bool) -> String {
	let suffixes = ['B', 'K', 'M', 'G', 'T', 'P'];
	let base: f64 = if si { 1000.0 } else { 1024.0 };
	let plain = format!("{bytes}B");
	if plain.len() <= 4 {
		return plain;
	}
	let limit = if si { 4 } else { 5 };
	for (index, letter) in suffixes.iter().enumerate().skip(1) {
		let suffix = if si {
			letter.to_string()
		} else {
			format!("{letter}i")
		};
		let scaled = bytes as f64 / base.powi(index as i32);
		let one_decimal = format!("{scaled:.1}{suffix}");
		if one_decimal.len() <= limit {
			return one_decimal;
		}
		let integer = format!("{}{suffix}", scaled as u64);
		if integer.len() <= limit {
			return integer;
		}
	}
	format!("{:.1}Pi", bytes as f64 / base.powi(5))
}

#[cfg(windows)]
fn sample() -> Result<Snapshot, String> {
	use windows_sys::Win32::System::{
		ProcessStatus::{GetPerformanceInfo, PERFORMANCE_INFORMATION},
		SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
	};

	let mut status = MEMORYSTATUSEX {
		dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
		..Default::default()
	};
	if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
		return Err(format!("GlobalMemoryStatusEx failed: {}", std::io::Error::last_os_error()));
	}
	let mut performance = PERFORMANCE_INFORMATION {
		cb: std::mem::size_of::<PERFORMANCE_INFORMATION>() as u32,
		..Default::default()
	};
	if unsafe { GetPerformanceInfo(&mut performance, performance.cb) } == 0 {
		return Err(format!("GetPerformanceInfo failed: {}", std::io::Error::last_os_error()));
	}

	let page = performance.PageSize as u64;
	let total = status.ullTotalPhys;
	let available = status.ullAvailPhys;
	let used = total.saturating_sub(available);
	// Windows has no MemFree/Buffers equivalent; SystemCache is reclaimable, so
	// report it as buff/cache and keep free + buff/cache equal to available.
	let cached = (performance.SystemCache as u64)
		.saturating_mul(page)
		.min(available);
	let free = available.saturating_sub(cached);
	let swap_total = status.ullTotalPageFile.saturating_sub(total);
	let swap_free = status
		.ullAvailPageFile
		.saturating_sub(available)
		.min(swap_total);
	let commit_limit = (performance.CommitLimit as u64).saturating_mul(page);
	let committed = (performance.CommitTotal as u64)
		.saturating_mul(page)
		.min(commit_limit);
	Ok(Snapshot {
		total,
		free,
		used,
		shared: 0,
		buffers: 0,
		cached,
		available,
		swap_total,
		swap_used: swap_total.saturating_sub(swap_free),
		swap_free,
		low: Region::default(),
		high: Region::default(),
		commit_limit,
		committed,
	})
}

#[cfg(not(windows))]
fn sample() -> Result<Snapshot, String> {
	let text = std::fs::read_to_string("/proc/meminfo")
		.map_err(|error| format!("/proc/meminfo: {error}"))?;
	parse_meminfo(&text)
}

#[cfg_attr(windows, allow(dead_code))]
fn parse_meminfo(text: &str) -> Result<Snapshot, String> {
	let mut values = HashMap::new();
	for line in text.lines() {
		let Some((key, rest)) = line.split_once(':') else {
			continue;
		};
		let Some(raw) = rest.split_whitespace().next() else {
			continue;
		};
		let Ok(value) = raw.parse::<u64>() else {
			continue;
		};
		values.insert(key.trim().to_string(), value.saturating_mul(1024));
	}
	let get = |key: &str| values.get(key).copied().unwrap_or(0);
	let total = get("MemTotal");
	if total == 0 {
		return Err("cannot read MemTotal from /proc/meminfo".to_string());
	}
	let free = get("MemFree");
	let buffers = get("Buffers");
	let cached = get("Cached").saturating_add(get("SReclaimable"));
	let shared = get("Shmem");
	let mut available = get("MemAvailable");
	if available == 0 {
		available = free
			.saturating_add(buffers)
			.saturating_add(cached)
			.saturating_sub(shared)
			.min(total);
	}
	let used = total.saturating_sub(available);
	let swap_total = get("SwapTotal");
	let swap_free = get("SwapFree");
	let low_total = get("LowTotal");
	let high_total = get("HighTotal");
	Ok(Snapshot {
		total,
		free,
		used,
		shared,
		buffers,
		cached,
		available,
		swap_total,
		swap_used: swap_total.saturating_sub(swap_free),
		swap_free,
		low: Region {
			total: low_total,
			free:  get("LowFree"),
			used:  low_total.saturating_sub(get("LowFree")),
		},
		high: Region {
			total: high_total,
			free:  get("HighFree"),
			used:  high_total.saturating_sub(get("HighFree")),
		},
		commit_limit: get("CommitLimit"),
		committed: get("Committed_AS"),
	})
}

#[cfg(test)]
mod tests {
	use super::{Free, Scale, Snapshot, human_size, parse_meminfo, render, scale_size};
	use crate::host::run_util;

	fn scale(exponent: u32, si: bool) -> Scale {
		Scale { exponent, si, human: false }
	}

	#[test]
	fn scales_bytes_like_procps() {
		assert_eq!(scale_size(1536, scale(0, false)), "1");
		assert_eq!(scale_size(1536, scale(1, false)), "1536");
		assert_eq!(scale_size(1536, scale(2, false)), "1");
		assert_eq!(scale_size(1536, scale(3, false)), "0");
		assert_eq!(scale_size(1536, scale(0, true)), "1");
		assert_eq!(scale_size(1536, scale(2, true)), "1");
	}

	#[test]
	fn human_sizes_match_the_reference_shape() {
		assert_eq!(human_size(0, false), "0B");
		assert_eq!(human_size(999, false), "999B");
		assert_eq!(human_size(1000, false), "1.0Ki");
		assert_eq!(human_size(1024, false), "1.0Ki");
		assert_eq!(human_size(16 * 1024 * 1024 * 1024, false), "16Gi");
		assert_eq!(human_size(1000, true), "1.0K");
		assert_eq!(human_size(1_000_000, true), "1.0M");
	}

	fn fixture() -> Snapshot {
		Snapshot {
			total:        8 * 1024 * 1024 * 1024,
			free:         1024 * 1024 * 1024,
			used:         2 * 1024 * 1024 * 1024,
			shared:       0,
			buffers:      0,
			cached:       5 * 1024 * 1024 * 1024,
			available:    6 * 1024 * 1024 * 1024,
			swap_total:   2 * 1024 * 1024 * 1024,
			swap_used:    512 * 1024 * 1024,
			swap_free:    1536 * 1024 * 1024,
			low:          super::Region::default(),
			high:         super::Region::default(),
			commit_limit: 10 * 1024 * 1024 * 1024,
			committed:    3 * 1024 * 1024 * 1024,
		}
	}

	#[test]
	fn header_and_rows_follow_the_procps_layout() {
		let out = render(&fixture(), scale(0, false), false, false, false, false, false);
		let mut lines = out.lines();
		assert_eq!(
			lines.next().unwrap(),
			"               total        used        free      shared  buff/cache   available"
		);
		assert_eq!(
			lines.next().unwrap(),
			"Mem:         8388608     2097152     1048576           0     5242880     6291456"
		);
		assert_eq!(lines.next().unwrap(), "Swap:        2097152      524288     1572864");
	}

	#[test]
	fn wide_total_and_committed_columns_are_rendered() {
		let out = render(&fixture(), scale(0, false), true, false, false, true, true);
		assert!(out.contains("buffers       cache"), "{out}");
		assert!(out.contains("Total:"), "{out}");
		assert!(out.contains("Comm:"), "{out}");
		assert!(out.contains("10485760"), "{out}");
	}

	#[test]
	fn line_mode_prints_the_short_labels() {
		let out = render(&fixture(), scale(1, false), false, false, true, false, false);
		assert!(out.starts_with("SwapUse "), "{out}");
		assert!(out.contains("CachUse"), "{out}");
		assert!(out.contains("MemUse"), "{out}");
		assert!(out.contains("MemFree"), "{out}");
	}

	#[test]
	fn meminfo_parsing_derives_the_free_columns() {
		let text = "MemTotal:       16384000 kB\nMemFree:         1048576 kB\nMemAvailable:    \
		            6291456 kB\nBuffers:               0 kB\nCached:          5242880 \
		            kB\nSReclaimable:          0 kB\nShmem:                 0 kB\nSwapTotal:       \
		            2097152 kB\nSwapFree:        1572864 kB\nCommitLimit:    10240000 \
		            kB\nCommitted_AS:    3072000 kB\n";
		let snapshot = parse_meminfo(text).unwrap();
		assert_eq!(snapshot.total, 16384000 * 1024);
		assert_eq!(snapshot.used, (16384000 - 6291456) * 1024);
		assert_eq!(snapshot.available, 6291456 * 1024);
		assert_eq!(snapshot.cached, 5242880 * 1024);
		assert_eq!(snapshot.swap_used, (2097152 - 1572864) * 1024);
		assert_eq!(snapshot.commit_limit, 10240000 * 1024);
	}

	#[test]
	fn unit_options_are_exclusive_and_validated() {
		let (code, capture) = run_util::<Free>(&["-k", "-m"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("Multiple unit options"), "{}", capture.err());

		let (code, capture) = run_util::<Free>(&["-s", "0"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("not a positive number"), "{}", capture.err());

		let (code, capture) = run_util::<Free>(&["-c", "0"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("at least 1"), "{}", capture.err());
	}

	#[test]
	fn repeats_for_count_iterations() {
		let (code, capture) = run_util::<Free>(&["-c", "2", "-s", "0.01"], "", "/");
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert_eq!(capture.out().matches("Mem:").count(), 2, "{}", capture.out());
	}

	#[test]
	fn help_and_version_are_handled() {
		let (code, capture) = run_util::<Free>(&["--help"], "", "/");
		assert_eq!(code, 0);
		assert!(capture.out().contains("Display amount of free"));
		let (code, capture) = run_util::<Free>(&["-V"], "", "/");
		assert_eq!(code, 0);
		assert!(capture.out().contains("procps-ng"));
	}

	#[test]
	fn reads_real_memory() {
		let (code, capture) = run_util::<Free>(&[], "", "/");
		assert_eq!(code, 0, "stderr: {}", capture.err());
		let out = capture.out();
		assert!(out.contains("Mem:"), "{out}");
		assert!(out.contains("Swap:"), "{out}");
		assert!(out.contains("buff/cache"), "{out}");
	}

	#[cfg(windows)]
	#[test]
	fn lohi_is_rejected_on_windows() {
		let (code, capture) = run_util::<Free>(&["-l"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("no low/high"), "{}", capture.err());
	}

	#[cfg(not(windows))]
	#[test]
	fn lohi_prints_low_and_high_rows_on_unix() {
		let (code, capture) = run_util::<Free>(&["-l"], "", "/");
		assert_eq!(code, 0, "stderr: {}", capture.err());
		assert!(capture.out().contains("Low:"), "{}", capture.out());
		assert!(capture.out().contains("High:"), "{}", capture.out());
	}

	#[tokio::test]
	async fn runs_as_a_shell_builtin() {
		let dir = tempfile::tempdir().unwrap();
		let (code, out, err) = crate::host::run_script("free -h", "", dir.path()).await;
		assert_eq!(code, 0, "stderr: {err}");
		assert!(out.contains("Mem:"), "{out}");
		assert!(out.contains("buff/cache"), "{out}");
	}

	#[test]
	#[ignore = "performance probe"]
	fn perf_probe() {
		let iterations = 1000;
		let started = std::time::Instant::now();
		for _ in 0..iterations {
			let snapshot = super::sample().unwrap();
			let _ = render(&snapshot, scale(0, false), false, false, false, false, false);
		}
		println!("free: {iterations} samples in {:.1} ms", started.elapsed().as_secs_f64() * 1000.0);
	}

	#[cfg(windows)]
	#[test]
	fn windows_snapshot_is_consistent() {
		let snapshot = super::sample().unwrap();
		assert!(snapshot.total > 0);
		assert!(snapshot.available <= snapshot.total);
		assert!(snapshot.free <= snapshot.available);
		assert_eq!(
			snapshot.free + snapshot.cached,
			snapshot.available,
			"free + buff/cache must equal available"
		);
		assert!(snapshot.swap_free <= snapshot.swap_total);
	}
}
