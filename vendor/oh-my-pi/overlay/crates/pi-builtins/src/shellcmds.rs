//! Single registration point for the self-written shell commands.
//!
//! Every command lives in its own module under the overlay; this file is the
//! only wiring that names them. Adding a command therefore means: add the
//! module, add one push here - no new vendor patch, no extra hunk in
//! factory.rs.

use brush_core::{
	ShellExtensions,
	builtins::Registration,
};

/// Registers every self-written utility that its feature enables.
pub(crate) fn register<SE: ShellExtensions>(
	builtins: &mut Vec<(&'static str, Registration<SE>)>,
) {
	#[cfg(feature = "util.zip")]
	builtins.push(("zip", crate::zipcmd::zip_builtin::<SE>()));
	#[cfg(feature = "util.tree")]
	builtins.push(("tree", crate::treecmd::tree_builtin::<SE>()));
	#[cfg(feature = "util.gzip")]
	{
		builtins.push(("gzip", crate::gzipcmd::gzip_builtin::<SE>()));
		builtins.push(("gunzip", crate::gzipcmd::gzip_builtin::<SE>()));
		builtins.push(("zcat", crate::gzipcmd::gzip_builtin::<SE>()));
	}
	#[cfg(feature = "util.envsubst")]
	builtins.push(("envsubst", crate::envsubstcmd::envsubst_builtin::<SE>()));
	#[cfg(feature = "util.zstd")]
	{
		builtins.push(("zstd", crate::zstdcmd::zstd_builtin::<SE>()));
		builtins.push(("unzstd", crate::zstdcmd::zstd_builtin::<SE>()));
		builtins.push(("zstdcat", crate::zstdcmd::zstd_builtin::<SE>()));
	}
	#[cfg(feature = "util.xz")]
	{
		builtins.push(("xz", crate::xzcmd::xz_builtin::<SE>()));
		builtins.push(("unxz", crate::xzcmd::xz_builtin::<SE>()));
		builtins.push(("xzcat", crate::xzcmd::xz_builtin::<SE>()));
	}
}
