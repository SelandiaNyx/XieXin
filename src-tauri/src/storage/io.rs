//! 原子文件读写、目录体积统计与文件名清洗工具。

use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;

/// 原子写 JSON：先写 `.tmp` 并 fsync，再覆盖目标文件。
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!("{s}.tmp"))
        .unwrap_or_else(|| "tmp".into());
    let tmp = path.with_extension(ext);
    let data = serde_json::to_vec_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;
    {
        let mut f = File::create(&tmp).map_err(|e| format!("写入临时文件失败 {}: {e}", tmp.display()))?;
        f.write_all(&data).map_err(|e| format!("写入失败: {e}"))?;
        let _ = f.sync_all();
    }
    if fs::rename(&tmp, path).is_ok() {
        return Ok(());
    }
    // Windows File::create truncates in place and respects delete-sharing locks,
    // unlike remove_file + rename which can delete the old file and then fail.
    let result = (|| -> std::io::Result<()> {
        let mut dst = File::create(path)?;
        dst.write_all(&data)?;
        dst.sync_all()
    })();
    match result {
        Ok(()) => {
            let _ = fs::remove_file(&tmp);
            Ok(())
        }
        Err(e) => Err(format!(
            "替换文件失败 {}: {e}（新内容仍保留在 {}）",
            path.display(),
            tmp.display()
        )),
    }
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<T>(&raw)
            .map(Some)
            .map_err(|e| format!("数据文件损坏 {}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取失败 {}: {e}", path.display())),
    }
}

pub fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(path) {
        for e in entries.filter_map(|e| e.ok()) {
            let p = e.path();
            if let Ok(meta) = e.metadata() {
                if meta.is_dir() {
                    total += dir_size(&p);
                } else {
                    total += meta.len();
                }
            }
        }
    }
    total
}

/// 检查目录是否可作为稿件根目录创建与写入（排除 Android 根目录 `/` 等只读路径）。
pub fn is_dir_writable(path: &Path) -> bool {
    if path.as_os_str().is_empty() {
        return false;
    }
    fs::create_dir_all(path.join("books")).is_ok()
}

pub fn sanitize_filename(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string();
    let base = if cleaned.is_empty() { fallback.to_string() } else { cleaned };
    base.chars().take(64).collect()
}
