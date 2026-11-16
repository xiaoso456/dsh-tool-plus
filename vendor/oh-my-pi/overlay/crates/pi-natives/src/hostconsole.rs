//! 把宿主的控制台窗口变成不可见，让 console 子进程继承它而不再各自新建窗口。
//!
//! WHY：桌面端宿主是 GUI 子系统镜像（`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1`），
//! Windows 从不给它分配控制台；父进程没有控制台时，`console` 子系统子进程会**新建**一个，
//! 而默认终端是 Windows Terminal —— 于是每条命令闪一个窗口。宿主自己
//! `AllocConsole()` + `ShowWindow(SW_HIDE)` 之后，子进程只是继承，不再新建。
//!
//! 三条硬约束：只在 win32 生效；宿主已有控制台时零副作用；`AllocConsole` 会把标准句柄
//! 重指到新控制台，而宿主的 stdio 是启动方给的 pipe，所以必须先存后还。任何失败只降级
//! 不抛 —— 这段代码在插件启动路径上，不能因为拿不到控制台就让整个插件起不来。

/// 安装结果，与 JS 侧日志词汇一致。
pub fn hide_host_console() -> String {
	#[cfg(target_os = "windows")]
	{
		windows::hide()
	}
	#[cfg(not(target_os = "windows"))]
	{
		"not-windows".to_string()
	}
}

#[cfg(target_os = "windows")]
mod windows {
	use windows_sys::Win32::{
		Foundation::HANDLE,
		System::Console::{
			AllocConsole, GetConsoleCP, GetConsoleWindow, GetStdHandle, STD_ERROR_HANDLE,
			STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, SetStdHandle,
		},
		UI::WindowsAndMessaging::{SW_HIDE, ShowWindow},
	};

	/// 三个标准句柄的 Win32 编号，顺序即存还顺序。
	const STD_HANDLES: [u32; 3] = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE];

	pub fn hide() -> String {
		// 用 `GetConsoleCP` 而不是 `GetConsoleWindow` 判断「有没有控制台」：ConPTY
		// （Windows Terminal、VS Code、桌面端）下窗口句柄为 null，但控制台确实存在；只看
		// 窗口会把「已有控制台」误判成「没有」，接着 `AllocConsole` 以
		// ERROR_ACCESS_DENIED 失败。子进程会不会新建窗口，取决于控制台对象本身。
		// SAFETY: `GetConsoleCP` takes no parameters and returns 0 exactly when this
		// process has no console; any other value is the console's input code page.
		if unsafe { GetConsoleCP() } != 0 {
			return "console-present".to_string();
		}

		// 先存再分配：`AllocConsole` 会把标准句柄指向新控制台，而宿主的 stdio 是启动方
		// 给的 pipe，覆盖掉就再也回不来了。
		// SAFETY: `GetStdHandle` accepts any integer and returns either a valid handle or
		// `INVALID_HANDLE_VALUE`/`null`; both are stored and handed back verbatim.
		let saved: [HANDLE; 3] = unsafe {
			[
				GetStdHandle(STD_INPUT_HANDLE),
				GetStdHandle(STD_OUTPUT_HANDLE),
				GetStdHandle(STD_ERROR_HANDLE),
			]
		};

		// SAFETY: takes no parameters. A `false` return means the process already owns a
		// console (checked above) or allocation failed; both are reported, not unwrapped.
		let allocated = unsafe { AllocConsole() } != 0;
		if !allocated {
			restore(&saved);
			return "alloc-failed".to_string();
		}

		// SAFETY: the process now owns the console allocated above, so this returns its
		// window (or null when the console has no window, e.g. detached services).
		let window = unsafe { GetConsoleWindow() };
		if !window.is_null() {
			// SAFETY: `window` is the console window handle for this process; `SW_HIDE`
			// is a valid `nCmdShow`. Failure only means the window stays visible.
			let _ = unsafe { ShowWindow(window, SW_HIDE) };
		}

		restore(&saved);
		"allocated".to_string()
	}

	/// 把标准句柄还回去。
	fn restore(saved: &[HANDLE; 3]) {
		for (at, handle) in STD_HANDLES.iter().zip(saved.iter()) {
			// SAFETY: `*at` is one of the three StdHandle constants and `*handle` is either
			// the value `GetStdHandle` returned earlier or `INVALID_HANDLE_VALUE`; both are
			// accepted by `SetStdHandle`. The return value is intentionally ignored.
			let _ = unsafe { SetStdHandle(*at, *handle) };
		}
	}
}
