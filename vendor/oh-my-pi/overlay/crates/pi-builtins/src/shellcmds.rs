//! Single registration point for the self-written shell commands.
//!
//! Every command lives in this module directory; the file only declares the
//! modules and registers their names. Adding a command therefore means: add
//! the module file, add one `mod` line, add its registration - no vendor patch
//! and no change to lib.rs / factory.rs.

mod bccmd;
mod envsubstcmd;
mod gzipcmd;
mod treecmd;
mod xzcmd;
mod zipcmd;
mod zstdcmd;

use brush_core::{
	ShellExtensions,
	builtins::Registration,
};

/// Registers every self-written utility.
pub(crate) fn register<SE: ShellExtensions>(
	builtins: &mut Vec<(&'static str, Registration<SE>)>,
) {
	builtins.push(("zip", zipcmd::zip_builtin::<SE>()));
	builtins.push(("tree", treecmd::tree_builtin::<SE>()));
	builtins.push(("gzip", gzipcmd::gzip_builtin::<SE>()));
	builtins.push(("gunzip", gzipcmd::gzip_builtin::<SE>()));
	builtins.push(("zcat", gzipcmd::gzip_builtin::<SE>()));
	builtins.push(("envsubst", envsubstcmd::envsubst_builtin::<SE>()));
	builtins.push(("zstd", zstdcmd::zstd_builtin::<SE>()));
	builtins.push(("unzstd", zstdcmd::zstd_builtin::<SE>()));
	builtins.push(("zstdcat", zstdcmd::zstd_builtin::<SE>()));
	builtins.push(("xz", xzcmd::xz_builtin::<SE>()));
	builtins.push(("unxz", xzcmd::xz_builtin::<SE>()));
	builtins.push(("xzcat", xzcmd::xz_builtin::<SE>()));
	builtins.push(("bc", bccmd::bc_builtin::<SE>()));
}