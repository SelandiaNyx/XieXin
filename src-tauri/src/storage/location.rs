//! 稿件目录位置管理：默认目录、首次启动位置选择、指针文件与安全搬迁。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::storage::io::{read_json, write_json_atomic};
use crate::text::now_ms;

/// 指针文件名：只记一行用户选过的稿件目录路径，放在应用固定配置目录里（不跟着稿件搬家）。
pub const LOCATION_RECORD_FILE: &str = "storage-location.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StorageLocationRecord {
    pub dir: String,
    pub chosen_at: i64,
}

/// 告诉前端"现在稿件放哪儿、要不要让用户选一次位置"。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLocationInfo {
    /// 当前正在使用的稿件根目录
    pub dir: String,
    /// 首次启动给用户的推荐位置（如 `文档/写心稿件`）
    pub suggested: String,
    /// 是否需要弹"选个地方放稿子"（首次启动且还没写过稿，或上次记住的目录找不到了）
    pub needs_choice: bool,
    /// 是否由 `--data-dir` / `NOVEL_MANAGER_DATA_DIR` 或移动端沙盒固定位置锁定（锁定时界面不弹也不改）
    pub is_forced: bool,
    /// 上次记住的目录已经不存在/不可写（例如移动硬盘拔了），当前退回了默认位置
    pub missing: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
    pub from: String,
    pub to: String,
    pub moved: bool,
    pub cross_volume: bool,
    pub entries: usize,
}

pub fn default_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("NOVEL_MANAGER_DATA_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    let env_base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .or_else(|| std::env::var_os("USERPROFILE").map(|h| PathBuf::from(h).join("AppData/Roaming")));

    if let Some(base) = env_base {
        return base.join("com.heartwrite.novelmanager");
    }

    // Android 等无 HOME / APPDATA 环境下，当前工作目录往往是只读的 `/`；
    // 先试当前目录是否可写，不可写则退回系统临时目录，绝不落到只读根目录导致启动崩溃。
    let dot_candidate = PathBuf::from(".").join("com.heartwrite.novelmanager");
    if fs::create_dir_all(&dot_candidate).is_ok() {
        return dot_candidate;
    }
    std::env::temp_dir().join("com.heartwrite.novelmanager")
}

/// 根据宿主提供的应用数据目录解析稿件根目录：
/// - 若设置了 `NOVEL_MANAGER_DATA_DIR` 则优先使用；
/// - 移动端（`isolate_subdir = true`）下，`app_data_dir` 与 WebView 缓存同处 `activity.dataDir`，
///   因此将稿件隔离在 `manuscripts` 子目录中（若顶层已有老数据则保持原位兼容）；
/// - 桌面端直接使用 `app_data_dir`，拿不到时退回 `default_data_dir()`。
pub fn resolve_app_data_dir(app_data_dir: Option<PathBuf>, isolate_subdir: bool) -> PathBuf {
    if let Ok(custom) = std::env::var("NOVEL_MANAGER_DATA_DIR") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    if let Some(base) = app_data_dir {
        if !base.as_os_str().is_empty() {
            if isolate_subdir && !has_manuscripts(&base) {
                return base.join("manuscripts");
            }
            return base;
        }
    }
    default_data_dir()
}

/// 默认固定配置目录（放 `storage-location.json` 的地方，与稿件目录分开）。
/// Tauri 运行时会用 `app.path().app_config_dir()`；测试与命令行工具走这个兜底。
pub fn default_config_dir() -> PathBuf {
    default_data_dir()
}

/// 首次启动给用户的易找推荐位置：优先 `<用户目录>/Documents/写心稿件`，
/// 找不到 `Documents` 就退回 `<用户目录>/写心稿件`，再不行就用默认数据目录。
pub fn suggested_data_dir() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    if let Some(h) = home {
        let docs = h.join("Documents");
        if docs.is_dir() {
            return docs.join("写心稿件");
        }
        return h.join("写心稿件");
    }
    default_data_dir()
}

pub fn read_location_record(config_dir: &Path) -> Option<StorageLocationRecord> {
    let path = config_dir.join(LOCATION_RECORD_FILE);
    let rec: StorageLocationRecord = read_json(&path).ok().flatten()?;
    let trimmed = rec.dir.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(StorageLocationRecord {
        dir: trimmed.to_string(),
        chosen_at: rec.chosen_at,
    })
}

pub fn write_location_record(config_dir: &Path, dir: &str) -> Result<(), String> {
    let path = config_dir.join(LOCATION_RECORD_FILE);
    if dir.trim().is_empty() {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("无法清除位置记录：{e}"))?;
        }
        return Ok(());
    }
    let rec = StorageLocationRecord {
        dir: dir.trim().to_string(),
        chosen_at: now_ms(),
    };
    write_json_atomic(&path, &rec)
}

/// 这个目录里算不算"已经有用户的稿子"：看 `books.json` 或 `books/` 下有没有东西。
/// 只看 `settings.json` 不算 —— 空目录刚 `Store::load` 完也会生成一份默认设置。
pub fn has_manuscripts(dir: &Path) -> bool {
    if dir.join("books.json").is_file() {
        return true;
    }
    if let Ok(mut rd) = fs::read_dir(dir.join("books")) {
        if rd.next().is_some() {
            return true;
        }
    }
    false
}

/// 计算当前要不要让用户选一次稿件目录。
pub fn location_info(current: &Path, config_dir: &Path, forced: bool) -> StorageLocationInfo {
    let recorded = read_location_record(config_dir);
    let current_c = canonical_or_clean(current);
    let (chosen, missing) = match recorded {
        Some(ref r) => {
            let rec_path = PathBuf::from(&r.dir);
            let same = canonical_or_clean(&rec_path) == current_c;
            (same, !same)
        }
        None => (false, false),
    };
    // 老用户升级上来：虽然没写过指针文件，但默认目录里已经有书了 → 别打扰，接着用
    let already_used = has_manuscripts(current);
    let needs_choice = !forced && (missing || (!chosen && !already_used));
    let suggested = suggested_data_dir();
    StorageLocationInfo {
        dir: current.to_string_lossy().to_string(),
        suggested: suggested.to_string_lossy().to_string(),
        needs_choice,
        is_forced: forced,
        missing,
    }
}

pub(crate) fn canonical_or_clean(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| {
        // 目录还不存在时：把能 canonicalize 的父目录规范化，再接上剩余段
        let mut tail = Vec::new();
        let mut cur = p;
        while let Some(name) = cur.file_name() {
            tail.push(name.to_os_string());
            match cur.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => {
                    if let Ok(canon) = fs::canonicalize(parent) {
                        let mut out = canon;
                        for seg in tail.into_iter().rev() {
                            out.push(seg);
                        }
                        return out;
                    }
                    cur = parent;
                }
                _ => break,
            }
        }
        p.components().collect()
    })
}

/// 判断两个路径是否指向同一个位置。
pub fn is_same_location(a: &Path, b: &Path) -> bool {
    canonical_or_clean(a) == canonical_or_clean(b)
}

/// 忽略操作系统顺手塞进空目录的隐藏文件（Windows 的 `desktop.ini` / `Thumbs.db`、macOS 的 `.DS_Store`）。
fn is_ignorable_entry(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "desktop.ini" || lower == "thumbs.db" || lower == ".ds_store" || lower.starts_with('.')
}

/// 目录里第一个"正经"条目的名字；返回 `None` 表示目录不存在或可当作空目录使用。
fn first_meaningful_entry(dir: &Path) -> Result<Option<String>, String> {
    if !dir.exists() {
        return Ok(None);
    }
    let rd = fs::read_dir(dir).map_err(|e| format!("无法读取目录 {}：{e}", dir.display()))?;
    for entry in rd {
        let entry = entry.map_err(|e| format!("读取目录项失败：{e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_ignorable_entry(&name) {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// 校验用户选的新目录能不能当稿件根目录用（不能是原目录、不能互相包含、不能是非空杂物目录）。
pub fn validate_new_location(from: &Path, to: &Path) -> Result<(), String> {
    if to.as_os_str().is_empty() {
        return Err("请选择一个文件夹".into());
    }
    if to.exists() && !to.is_dir() {
        return Err("所选路径不是文件夹".into());
    }
    let from_c = canonical_or_clean(from);
    let to_c = canonical_or_clean(to);
    if from_c == to_c {
        return Err("这就是当前的位置".into());
    }
    if to_c.starts_with(&from_c) {
        return Err("新位置不能放在当前数据目录里面".into());
    }
    if from_c.starts_with(&to_c) {
        return Err("新位置不能是当前数据目录的上级文件夹（里面有其他文件）".into());
    }
    if let Some(found) = first_meaningful_entry(to)? {
        if has_manuscripts(to) {
            return Err("所选文件夹里已经有一份写心数据；为免互相覆盖，请选一个空文件夹".into());
        }
        return Err(format!("这个文件夹里还有别的东西（{found}），请选一个空文件夹"));
    }
    Ok(())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<usize, String> {
    fs::create_dir_all(dst).map_err(|e| format!("无法创建目录 {}：{e}", dst.display()))?;
    let mut count = 0usize;
    let rd = fs::read_dir(src).map_err(|e| format!("无法读取 {}：{e}", src.display()))?;
    for entry in rd {
        let entry = entry.map_err(|e| format!("读取目录项失败：{e}"))?;
        let ty = entry.file_type().map_err(|e| format!("读取文件类型失败：{e}"))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            count += copy_dir_recursive(&from, &to)?;
        } else if ty.is_file() {
            fs::copy(&from, &to).map_err(|e| format!("复制文件失败 {} -> {}：{e}", from.display(), to.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

/// 把整个稿件目录从 `from` 搬到 `to`：
/// - 同盘且 `to` 还是空的：直接 `fs::rename` 瞬间完成；
/// - 跨盘（如 C: → D:）：递归复制全部内容，校验关键文件都到位后再删旧目录。
///   任何一步出错都保留原目录不动，绝不出现"两边都半截"的丢稿状态。
pub fn move_data_dir(from: &Path, to: &Path) -> Result<MoveReport, String> {
    validate_new_location(from, to)?;
    let had_books = from.join("books.json").is_file();

    // 源目录根本没写过稿（比如首次启动还没建书就先选位置）：只建好目标目录即可
    if !from.exists() || !has_manuscripts(from) {
        fs::create_dir_all(to).map_err(|e| format!("无法创建目录 {}：{e}", to.display()))?;
        if from.exists() && from.join("settings.json").is_file() {
            let _ = fs::copy(from.join("settings.json"), to.join("settings.json"));
        }
        return Ok(MoveReport {
            from: from.to_string_lossy().to_string(),
            to: to.to_string_lossy().to_string(),
            moved: false,
            cross_volume: false,
            entries: 0,
        });
    }

    if let Some(parent) = to.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建上级目录 {}：{e}", parent.display()))?;
        }
    }
    // 如果目标目录已经存在（空目录），先清掉可忽略项再删掉空壳，好让同盘 rename 直接成功
    if to.exists() {
        if let Ok(rd) = fs::read_dir(to) {
            for e in rd.flatten() {
                let _ = fs::remove_file(e.path());
            }
        }
        let _ = fs::remove_dir(to);
    }
    if !to.exists() && fs::rename(from, to).is_ok() {
        return Ok(MoveReport {
            from: from.to_string_lossy().to_string(),
            to: to.to_string_lossy().to_string(),
            moved: true,
            cross_volume: false,
            entries: 0,
        });
    }

    // 跨盘：先完整复制，再核对，最后清理旧目录（清理失败也不算错——新目录已经是全的了）
    let entries = copy_dir_recursive(from, to)?;
    if had_books && !to.join("books.json").is_file() {
        return Err("复制后未在新位置找到书架索引，原目录已完整保留".into());
    }
    let _ = fs::remove_dir_all(from);
    Ok(MoveReport {
        from: from.to_string_lossy().to_string(),
        to: to.to_string_lossy().to_string(),
        moved: true,
        cross_volume: true,
        entries,
    })
}
