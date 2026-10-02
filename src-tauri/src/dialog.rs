//! 文件对话框的平台适配。
//!
//! 桌面端用 `rfd` 弹系统对话框；Android 上 `rfd` 根本没有实现（它只支持
//! Windows / Linux / macOS / Wasm），所以这里按目标平台分两套实现。
//! Android 的选择器需要一个正在运行的 Activity 来接收回调，无法像桌面那样
//! 同步返回路径，因此 Android 版返回 `None`，让调用方退回内置导出目录
//! （应用私有目录，仍然可以正常导出，只是不弹选择器）。

/// 一个文件类型过滤器：显示名 + 扩展名列表（不含点）。
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

impl FileFilter {
    pub fn new(name: &str, extensions: &[&str]) -> Self {
        Self {
            name: name.to_string(),
            extensions: extensions.iter().map(|e| e.to_string()).collect(),
        }
    }
}

// ---------------------------------------------------------------- 桌面实现

#[cfg(not(target_os = "android"))]
mod platform {
    use super::FileFilter;

    pub fn save_path(default_name: &str, filter: &FileFilter) -> Option<String> {
        let mut dialog = rfd::FileDialog::new().set_title("导出小说").set_file_name(default_name);
        let exts: Vec<&str> = filter.extensions.iter().map(String::as_str).collect();
        if !exts.is_empty() {
            dialog = dialog.add_filter(filter.name.clone(), &exts);
        }
        dialog
            .add_filter("所有文件", &["*"])
            .save_file()
            .map(|p| p.to_string_lossy().to_string())
    }

    pub fn directory(title: &str) -> Option<String> {
        rfd::FileDialog::new()
            .set_title(title)
            .pick_folder()
            .map(|p| p.to_string_lossy().to_string())
    }

    pub fn open_file(filters: &[FileFilter]) -> Option<String> {
        let mut dialog = rfd::FileDialog::new().set_title("打开文件");
        for f in filters {
            let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
            if !exts.is_empty() {
                dialog = dialog.add_filter(f.name.clone(), &exts);
            }
        }
        dialog.pick_file().map(|p| p.to_string_lossy().to_string())
    }
}

// --------------------------------------------------------------- Android 实现

#[cfg(target_os = "android")]
mod platform {
    use super::FileFilter;

    // Android 上不弹系统选择器：导出改由调用方写入应用私有导出目录，
    // 导入暂不支持。这样应用在手机上完全可用，只是这两个流程换了落点。
    pub fn save_path(_default_name: &str, _filter: &FileFilter) -> Option<String> {
        None
    }

    pub fn directory(_title: &str) -> Option<String> {
        None
    }

    pub fn open_file(_filters: &[FileFilter]) -> Option<String> {
        None
    }
}

impl FileFilter {
    /// 该平台是否有原生文件选择器（Android 没有，界面文案需要区别对待）。
    pub const fn has_native_pickers() -> bool {
        cfg!(not(target_os = "android"))
    }
}

pub use platform::{directory, open_file, save_path};
