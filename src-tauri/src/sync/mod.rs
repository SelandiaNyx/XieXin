//! 跨设备同步核心引擎：为局域网同步（LAN）与 WebDAV 云同步提供统一的数据清单、
//! 三向差异对比、零丢稿智能冲突合并与同步状态持久化。

pub mod lan;
pub mod webdav;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::storage::{
    read_json, write_json_atomic, BookMeta, Card, ChapterContent, Store, Version,
    MAX_HISTORY_HARD_CAP,
};
use crate::text::{count_text, now_ms};

pub const SYNC_PROTOCOL_VERSION: u32 = 1;
const SYNC_STATE_FILE: &str = "sync-state.json";
const TOMBSTONE_TTL_MS: i64 = 90 * 24 * 3600 * 1000;

/// 同步方向策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncDirection {
    /// 智能双向合并（默认推荐）：按三向基线自动上传/下载，冲突时保留双方内容到历史版本。
    Bidirectional,
    /// 仅上传：以本地为准推送到远端。
    PushOnly,
    /// 仅下载：以远端为准拉取到本地。
    PullOnly,
}

impl SyncDirection {
    pub fn parse(s: &str) -> Self {
        match s {
            "push" | "push-only" | "upload" => SyncDirection::PushOnly,
            "pull" | "pull-only" | "download" => SyncDirection::PullOnly,
            _ => SyncDirection::Bidirectional,
        }
    }
}

/// 单个被同步文件的元数据条目。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncEntry {
    /// SHA-256 十六进制摘要
    pub hash: String,
    pub size: u64,
    /// 逻辑修改时间戳（毫秒）
    pub modified_at: i64,
    /// 文件类型："book" | "cards" | "chapter" | "cover"
    pub kind: String,
}

/// 一端完整的稿件同步清单（不含本机 settings.json，确保设备偏好与密钥隔离）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncManifest {
    pub protocol: u32,
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub generated_at: i64,
    pub entries: BTreeMap<String, SyncEntry>,
    pub tombstones: BTreeMap<String, i64>,
}

/// 每个远端目标（按 peer_key 区分，如 `webdav:<url>` 或 `lan:<device_id>`）上次同步完成后的快照基线。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncStateFile {
    /// peer_key -> (rel_path -> last_synced_hash)
    pub baselines: BTreeMap<String, BTreeMap<String, String>>,
    /// 本机删除墓碑：rel_path -> deleted_at_ms
    pub tombstones: BTreeMap<String, i64>,
}

/// 同步计划中的单项动作。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncActionKind {
    Upload,
    Download,
    Merge,
    DeleteLocal,
    DeleteRemote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAction {
    pub path: String,
    pub entry_kind: String,
    pub action: SyncActionKind,
    pub reason: String,
}

/// 同步执行结果报告（返给前端展示清晰摘要）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub ok: bool,
    pub mode: String,
    pub peer_name: String,
    pub uploaded: usize,
    pub downloaded: usize,
    pub merged: usize,
    pub conflicts: usize,
    pub deleted_local: usize,
    pub deleted_remote: usize,
    pub skipped: usize,
    pub duration_ms: u64,
    pub finished_at: i64,
    pub details: Vec<String>,
}

/// 当前平台标签。
pub fn current_platform() -> &'static str {
    if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
}

/// 校验同步相对路径是否合法（严格白名单，彻底杜绝路径穿越）。
pub fn validate_sync_rel_path(rel: &str) -> Result<String, String> {
    let cleaned = rel.trim().replace('\\', "/");
    if cleaned.is_empty()
        || cleaned.starts_with('/')
        || cleaned.contains("..")
        || cleaned.contains('\0')
    {
        return Err(format!("非法同步路径：{rel}"));
    }
    let parts: Vec<&str> = cleaned.split('/').collect();
    if parts.len() != 3 {
        return Err(format!("不支持的同步路径层级：{rel}"));
    }
    let valid_seg = |s: &str| {
        !s.is_empty()
            && s.len() <= 128
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    if !parts.iter().all(|p| valid_seg(p)) {
        return Err(format!("同步路径包含不允许的字符：{rel}"));
    }
    match (parts[0], parts[2]) {
        ("books", "book.json") | ("books", "cards.json") => Ok(cleaned),
        ("books", name) if name.starts_with("cover.") => {
            if crate::cover::cover_ext(name).is_some() {
                Ok(cleaned)
            } else {
                Err(format!("不支持的封面格式：{rel}"))
            }
        }
        ("content", name) if name.ends_with(".json") => Ok(cleaned),
        _ => Err(format!("路径不在同步白名单内：{rel}")),
    }
}

pub fn entry_kind_of(rel: &str) -> &'static str {
    if rel.starts_with("content/") {
        "chapter"
    } else if rel.ends_with("/book.json") {
        "book"
    } else if rel.ends_with("/cards.json") {
        "cards"
    } else {
        "cover"
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// 读取同步状态文件（基线 + 墓碑）。
pub fn load_sync_state(root: &Path) -> SyncStateFile {
    let mut st: SyncStateFile = read_json(&root.join(SYNC_STATE_FILE))
        .ok()
        .flatten()
        .unwrap_or_default();
    let cutoff = now_ms() - TOMBSTONE_TTL_MS;
    st.tombstones.retain(|_, ts| *ts >= cutoff);
    st
}

pub fn save_sync_state(root: &Path, state: &SyncStateFile) -> Result<(), String> {
    write_json_atomic(&root.join(SYNC_STATE_FILE), state)
}

/// 记录一条删除墓碑，让双向同步知道这是一次刻意删除而非"远端还没下载"。
pub fn record_tombstone(root: &Path, rel_paths: &[String]) {
    let mut st = load_sync_state(root);
    let ts = now_ms();
    for p in rel_paths {
        if let Ok(clean) = validate_sync_rel_path(p) {
            st.tombstones.insert(clean, ts);
        }
    }
    let _ = save_sync_state(root, &st);
}

/// 清除某路径的墓碑（重新创建或恢复时）。
pub fn clear_tombstone(root: &Path, rel_path: &str) {
    let mut st = load_sync_state(root);
    if st.tombstones.remove(rel_path).is_some() {
        let _ = save_sync_state(root, &st);
    }
}

/// 扫描本地数据目录，构建完整同步清单。
pub fn build_local_manifest(root: &Path, device_id: &str, device_name: &str) -> Result<SyncManifest, String> {
    let mut entries = BTreeMap::new();
    let books_dir = root.join("books");
    if books_dir.is_dir() {
        if let Ok(rd) = fs::read_dir(&books_dir) {
            for book_ent in rd.filter_map(Result::ok) {
                if !book_ent.path().is_dir() {
                    continue;
                }
                let book_id = book_ent.file_name().to_string_lossy().to_string();
                if let Ok(files) = fs::read_dir(book_ent.path()) {
                    for f in files.filter_map(Result::ok) {
                        let path = f.path();
                        if !path.is_file() {
                            continue;
                        }
                        let fname = f.file_name().to_string_lossy().to_string();
                        let rel = format!("books/{book_id}/{fname}");
                        if validate_sync_rel_path(&rel).is_err() {
                            continue;
                        }
                        if let Ok(entry) = scan_sync_entry(&path, &rel) {
                            entries.insert(rel, entry);
                        }
                    }
                }
            }
        }
    }

    let content_dir = root.join("content");
    if content_dir.is_dir() {
        if let Ok(rd) = fs::read_dir(&content_dir) {
            for book_ent in rd.filter_map(Result::ok) {
                if !book_ent.path().is_dir() {
                    continue;
                }
                let book_id = book_ent.file_name().to_string_lossy().to_string();
                if let Ok(files) = fs::read_dir(book_ent.path()) {
                    for f in files.filter_map(Result::ok) {
                        let path = f.path();
                        if !path.is_file() {
                            continue;
                        }
                        let fname = f.file_name().to_string_lossy().to_string();
                        let rel = format!("content/{book_id}/{fname}");
                        if validate_sync_rel_path(&rel).is_err() {
                            continue;
                        }
                        if let Ok(entry) = scan_sync_entry(&path, &rel) {
                            entries.insert(rel, entry);
                        }
                    }
                }
            }
        }
    }

    let sync_state = load_sync_state(root);
    // 如果某个文件当前依然存在，就去掉陈旧墓碑
    let mut tombstones = sync_state.tombstones;
    tombstones.retain(|k, _| !entries.contains_key(k));

    Ok(SyncManifest {
        protocol: SYNC_PROTOCOL_VERSION,
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
        platform: current_platform().to_string(),
        generated_at: now_ms(),
        entries,
        tombstones,
    })
}

fn file_mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn scan_sync_entry(path: &Path, rel: &str) -> Result<SyncEntry, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取同步文件失败 {}: {e}", path.display()))?;
    let kind = entry_kind_of(rel).to_string();
    let hash = sha256_hex(&bytes);
    let mtime = file_mtime_ms(path);
    let logical_ts = match kind.as_str() {
        "book" => serde_json::from_slice::<BookMeta>(&bytes)
            .ok()
            .map(|b| b.updated_at)
            .filter(|&t| t > 0)
            .unwrap_or(mtime),
        "chapter" => serde_json::from_slice::<ChapterContent>(&bytes)
            .ok()
            .map(|c| c.updated_at)
            .filter(|&t| t > 0)
            .unwrap_or(mtime),
        "cards" => serde_json::from_slice::<Vec<Card>>(&bytes)
            .ok()
            .and_then(|list| list.iter().map(|c| c.updated_at).max())
            .filter(|&t| t > 0)
            .unwrap_or(mtime),
        _ => mtime,
    };
    Ok(SyncEntry {
        hash,
        size: bytes.len() as u64,
        modified_at: logical_ts,
        kind,
    })
}

/// 计算三向同步计划（纯函数，可直接用于预览与单元测试）。
pub fn compute_sync_plan(
    local: &SyncManifest,
    remote: &SyncManifest,
    baseline: &BTreeMap<String, String>,
    direction: SyncDirection,
) -> (Vec<SyncAction>, usize) {
    let mut all_paths: BTreeSet<&str> = BTreeSet::new();
    for k in local.entries.keys() {
        all_paths.insert(k.as_str());
    }
    for k in remote.entries.keys() {
        all_paths.insert(k.as_str());
    }

    let mut actions = Vec::new();
    let mut skipped = 0usize;

    for rel in all_paths {
        let loc = local.entries.get(rel);
        let rem = remote.entries.get(rel);
        let base_hash = baseline.get(rel).map(String::as_str);
        let kind = entry_kind_of(rel).to_string();

        match (loc, rem) {
            (Some(l), Some(r)) if l.hash == r.hash => {
                skipped += 1;
            }
            (Some(l), Some(r)) => match direction {
                SyncDirection::PushOnly => actions.push(SyncAction {
                    path: rel.to_string(),
                    entry_kind: kind,
                    action: SyncActionKind::Upload,
                    reason: "本地覆盖远端".into(),
                }),
                SyncDirection::PullOnly => actions.push(SyncAction {
                    path: rel.to_string(),
                    entry_kind: kind,
                    action: SyncActionKind::Download,
                    reason: "远端覆盖本地".into(),
                }),
                SyncDirection::Bidirectional => {
                    if base_hash == Some(l.hash.as_str()) {
                        actions.push(SyncAction {
                            path: rel.to_string(),
                            entry_kind: kind,
                            action: SyncActionKind::Download,
                            reason: "仅远端有更新".into(),
                        });
                    } else if base_hash == Some(r.hash.as_str()) {
                        actions.push(SyncAction {
                            path: rel.to_string(),
                            entry_kind: kind,
                            action: SyncActionKind::Upload,
                            reason: "仅本地有更新".into(),
                        });
                    } else if kind == "cover" {
                        if l.modified_at >= r.modified_at {
                            actions.push(SyncAction {
                                path: rel.to_string(),
                                entry_kind: kind,
                                action: SyncActionKind::Upload,
                                reason: "本地封面较新".into(),
                            });
                        } else {
                            actions.push(SyncAction {
                                path: rel.to_string(),
                                entry_kind: kind,
                                action: SyncActionKind::Download,
                                reason: "远端封面较新".into(),
                            });
                        }
                    } else {
                        actions.push(SyncAction {
                            path: rel.to_string(),
                            entry_kind: kind,
                            action: SyncActionKind::Merge,
                            reason: "双端均有修改，智能合并并保留冲突备份".into(),
                        });
                    }
                }
            },
            (Some(l), None) => match direction {
                SyncDirection::PullOnly => {
                    if base_hash.is_some() || remote.tombstones.contains_key(rel) {
                        actions.push(SyncAction {
                            path: rel.to_string(),
                            entry_kind: kind,
                            action: SyncActionKind::DeleteLocal,
                            reason: "远端已删除".into(),
                        });
                    } else {
                        skipped += 1;
                    }
                }
                SyncDirection::PushOnly => actions.push(SyncAction {
                    path: rel.to_string(),
                    entry_kind: kind,
                    action: SyncActionKind::Upload,
                    reason: "上传新增文件".into(),
                }),
                SyncDirection::Bidirectional => {
                    let remote_deleted = remote
                        .tombstones
                        .get(rel)
                        .copied()
                        .map(|ts| ts >= l.modified_at)
                        .unwrap_or(false);
                    if remote_deleted && base_hash == Some(l.hash.as_str()) {
                        actions.push(SyncAction {
                            path: rel.to_string(),
                            entry_kind: kind,
                            action: SyncActionKind::DeleteLocal,
                            reason: "远端已删除且本地未改动".into(),
                        });
                    } else {
                        actions.push(SyncAction {
                            path: rel.to_string(),
                            entry_kind: kind,
                            action: SyncActionKind::Upload,
                            reason: "本地新增或较新".into(),
                        });
                    }
                }
            },
            (None, Some(r)) => match direction {
                SyncDirection::PushOnly => {
                    if base_hash.is_some() || local.tombstones.contains_key(rel) {
                        actions.push(SyncAction {
                            path: rel.to_string(),
                            entry_kind: kind,
                            action: SyncActionKind::DeleteRemote,
                            reason: "本地已删除".into(),
                        });
                    } else {
                        skipped += 1;
                    }
                }
                SyncDirection::PullOnly => actions.push(SyncAction {
                    path: rel.to_string(),
                    entry_kind: kind,
                    action: SyncActionKind::Download,
                    reason: "下载远端新增文件".into(),
                }),
                SyncDirection::Bidirectional => {
                    let local_deleted = local
                        .tombstones
                        .get(rel)
                        .copied()
                        .map(|ts| ts >= r.modified_at)
                        .unwrap_or(false);
                    if local_deleted && base_hash == Some(r.hash.as_str()) {
                        actions.push(SyncAction {
                            path: rel.to_string(),
                            entry_kind: kind,
                            action: SyncActionKind::DeleteRemote,
                            reason: "本地已删除且远端未改动".into(),
                        });
                    } else {
                        actions.push(SyncAction {
                            path: rel.to_string(),
                            entry_kind: kind,
                            action: SyncActionKind::Download,
                            reason: "远端新增或较新".into(),
                        });
                    }
                }
            },
            (None, None) => {}
        }
    }

    // 确保 book.json 排在章节之前，便于远端先建好书目结构
    actions.sort_by_key(|a| match a.entry_kind.as_str() {
        "book" => 0,
        "cards" => 1,
        "cover" => 2,
        _ => 3,
    });

    (actions, skipped)
}

/// 智能合并章节正文与历史版本：绝不丢稿！
/// 较新的内容成为当前正文，另一侧正文自动保存为 `kind = "conflict"` 的历史版本。
pub fn merge_chapter_content(
    local: &ChapterContent,
    remote: &ChapterContent,
    peer_name: &str,
) -> (ChapterContent, bool) {
    let local_newer = local.updated_at >= remote.updated_at;
    let (winner, loser, loser_origin) = if local_newer {
        (local, remote, format!("同步冲突保留 · 来自 {peer_name}"))
    } else {
        (remote, local, "同步冲突保留 · 本机旧稿".to_string())
    };

    let mut version_map: BTreeMap<String, Version> = BTreeMap::new();
    for v in local.versions.iter().chain(remote.versions.iter()) {
        version_map.entry(v.id.clone()).or_insert_with(|| v.clone());
    }

    let mut had_conflict = false;
    if winner.content != loser.content && !loser.content.trim().is_empty() {
        had_conflict = true;
        let already_saved = version_map.values().any(|v| v.content == loser.content);
        if !already_saved {
            let conflict_v = Version {
                id: uuid::Uuid::new_v4().to_string(),
                created_at: loser.updated_at.max(now_ms()),
                kind: "conflict".into(),
                label: loser_origin,
                chars: count_text(&loser.content).total,
                content: loser.content.clone(),
            };
            version_map.insert(conflict_v.id.clone(), conflict_v);
        }
    }

    let mut versions: Vec<Version> = version_map.into_values().collect();
    versions.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    versions.truncate(MAX_HISTORY_HARD_CAP);

    let merged = ChapterContent {
        chapter_id: if !winner.chapter_id.is_empty() {
            winner.chapter_id.clone()
        } else {
            loser.chapter_id.clone()
        },
        content: winner.content.clone(),
        updated_at: local.updated_at.max(remote.updated_at).max(now_ms()),
        versions,
    };
    (merged, had_conflict)
}

/// 智能合并书籍目录树（卷/章取并集，不丢失任一端新建的章节）。
pub fn merge_book_meta(local: &BookMeta, remote: &BookMeta) -> BookMeta {
    let (primary, secondary) = if local.updated_at >= remote.updated_at {
        (local, remote)
    } else {
        (remote, local)
    };
    let mut out = primary.clone();
    out.updated_at = local.updated_at.max(remote.updated_at).max(now_ms());

    // 收集已存在的章节位置，用于比较新旧
    let mut known_chapters: BTreeSet<String> = out
        .volumes
        .iter()
        .flat_map(|v| v.chapters.iter().map(|c| c.id.clone()))
        .collect();

    // 更新已有章节元数据（谁的 updated_at 更新就用谁的）
    for sec_vol in &secondary.volumes {
        for sec_ch in &sec_vol.chapters {
            if known_chapters.contains(&sec_ch.id) {
                for v in out.volumes.iter_mut() {
                    if let Some(ch) = v.chapters.iter_mut().find(|c| c.id == sec_ch.id) {
                        if sec_ch.updated_at > ch.updated_at {
                            *ch = sec_ch.clone();
                        }
                    }
                }
            }
        }
    }

    // 补入另一端独有的卷或章
    for sec_vol in &secondary.volumes {
        if let Some(dst_vol) = out.volumes.iter_mut().find(|v| v.id == sec_vol.id) {
            for sec_ch in &sec_vol.chapters {
                if !known_chapters.contains(&sec_ch.id) {
                    dst_vol.chapters.push(sec_ch.clone());
                    known_chapters.insert(sec_ch.id.clone());
                }
            }
        } else {
            let mut new_vol = sec_vol.clone();
            new_vol.chapters.retain(|c| !known_chapters.contains(&c.id));
            for c in &new_vol.chapters {
                known_chapters.insert(c.id.clone());
            }
            out.volumes.push(new_vol);
        }
    }
    out
}

/// 智能合并卡片列表（按 id 取并集，较新的 updated_at 胜出）。
pub fn merge_cards(local: &[Card], remote: &[Card]) -> Vec<Card> {
    let mut by_id: BTreeMap<String, Card> = BTreeMap::new();
    for c in local {
        by_id.insert(c.id.clone(), c.clone());
    }
    for c in remote {
        match by_id.get(&c.id) {
            Some(existing) if existing.updated_at >= c.updated_at => {}
            _ => {
                by_id.insert(c.id.clone(), c.clone());
            }
        }
    }
    let mut list: Vec<Card> = by_id.into_values().collect();
    list.sort_by(|a, b| b.pinned.cmp(&a.pinned).then(b.updated_at.cmp(&a.updated_at)));
    list
}

/// 原子写入同步字节到数据目录指定相对路径。
pub fn write_blob_atomic(root: &Path, rel: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let clean = validate_sync_rel_path(rel)?;
    let full = root.join(clean.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建同步目录失败 {}: {e}", parent.display()))?;
    }
    let tmp = full.with_extension("sync.tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("写入同步临时文件失败 {}: {e}", tmp.display()))?;
    if fs::rename(&tmp, &full).is_err() {
        fs::write(&full, bytes).map_err(|e| format!("替换同步文件失败 {}: {e}", full.display()))?;
        let _ = fs::remove_file(&tmp);
    }
    clear_tombstone(root, &clean);
    Ok(full)
}

/// 读取同步字节。
pub fn read_blob(root: &Path, rel: &str) -> Result<Vec<u8>, String> {
    let clean = validate_sync_rel_path(rel)?;
    let full = root.join(clean.replace('/', std::path::MAIN_SEPARATOR_STR));
    fs::read(&full).map_err(|e| format!("读取本地文件失败 {clean}: {e}"))
}

/// 将本地被同步删除的文件移入回收站（不直接永久销毁）。
pub fn trash_synced_blob(root: &Path, rel: &str) -> Result<(), String> {
    let clean = validate_sync_rel_path(rel)?;
    let full = root.join(clean.replace('/', std::path::MAIN_SEPARATOR_STR));
    if !full.exists() {
        return Ok(());
    }
    let trash_dir = root.join("trash");
    let _ = fs::create_dir_all(&trash_dir);
    let safe_name = format!("{}_sync_{}", now_ms(), clean.replace('/', "_"));
    let dst = trash_dir.join(safe_name);
    if fs::rename(&full, &dst).is_err() {
        let _ = fs::remove_file(&full);
    }
    Ok(())
}

/// 同步结束后重新扫描 `books/*/book.json`，重建 `books.json` 并校准章节字数与版本数。
pub fn rebuild_registry_from_disk(root: &Path) -> Result<Store, String> {
    let books_dir = root.join("books");
    let mut books: Vec<BookMeta> = Vec::new();
    if books_dir.is_dir() {
        if let Ok(rd) = fs::read_dir(&books_dir) {
            for entry in rd.filter_map(Result::ok) {
                let bfile = entry.path().join("book.json");
                if bfile.is_file() {
                    if let Ok(Some(mut book)) = read_json::<BookMeta>(&bfile) {
                        // 顺便校准章节字数与版本数（合并后可能变化）
                        let mut dirty = false;
                        for vol in book.volumes.iter_mut() {
                            for ch in vol.chapters.iter_mut() {
                                let cpath = root.join("content").join(&book.id).join(format!("{}.json", ch.id));
                                if let Ok(Some(c)) = read_json::<ChapterContent>(&cpath) {
                                    let chars = count_text(&c.content).total;
                                    if ch.char_count != chars || ch.versions != c.versions.len() {
                                        ch.char_count = chars;
                                        ch.versions = c.versions.len();
                                        dirty = true;
                                    }
                                }
                            }
                        }
                        if dirty {
                            let _ = write_json_atomic(&bfile, &book);
                        }
                        books.push(book);
                    }
                }
            }
        }
    }
    books.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    let reg = crate::storage::Registry { books };
    write_json_atomic(&root.join("books.json"), &reg)?;
    Store::load(root.to_path_buf())
}

/// 根据合并动作，在本地与远端字节之间生成合并后的字节。
pub fn merge_blob_bytes(
    entry_kind: &str,
    local_bytes: &[u8],
    remote_bytes: &[u8],
    peer_name: &str,
) -> Result<(Vec<u8>, bool), String> {
    match entry_kind {
        "chapter" => {
            let l: ChapterContent = serde_json::from_slice(local_bytes)
                .map_err(|e| format!("解析本地章节失败: {e}"))?;
            let r: ChapterContent = serde_json::from_slice(remote_bytes)
                .map_err(|e| format!("解析远端章节失败: {e}"))?;
            let (merged, conflict) = merge_chapter_content(&l, &r, peer_name);
            let out = serde_json::to_vec_pretty(&merged).map_err(|e| e.to_string())?;
            Ok((out, conflict))
        }
        "book" => {
            let l: BookMeta = serde_json::from_slice(local_bytes)
                .map_err(|e| format!("解析本地书目失败: {e}"))?;
            let r: BookMeta = serde_json::from_slice(remote_bytes)
                .map_err(|e| format!("解析远端书目失败: {e}"))?;
            let merged = merge_book_meta(&l, &r);
            let out = serde_json::to_vec_pretty(&merged).map_err(|e| e.to_string())?;
            Ok((out, false))
        }
        "cards" => {
            let l: Vec<Card> = serde_json::from_slice(local_bytes)
                .map_err(|e| format!("解析本地卡片失败: {e}"))?;
            let r: Vec<Card> = serde_json::from_slice(remote_bytes)
                .map_err(|e| format!("解析远端卡片失败: {e}"))?;
            let merged = merge_cards(&l, &r);
            let out = serde_json::to_vec_pretty(&merged).map_err(|e| e.to_string())?;
            Ok((out, false))
        }
        _ => Ok((local_bytes.to_vec(), false)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_validation_blocks_traversal_and_allows_manuscripts() {
        assert!(validate_sync_rel_path("books/b1/book.json").is_ok());
        assert!(validate_sync_rel_path("books/b1/cards.json").is_ok());
        assert!(validate_sync_rel_path("books/b1/cover.png").is_ok());
        assert!(validate_sync_rel_path("content/b1/c1.json").is_ok());

        assert!(validate_sync_rel_path("../settings.json").is_err());
        assert!(validate_sync_rel_path("settings.json").is_err());
        assert!(validate_sync_rel_path("books/b1/evil.exe").is_err());
        assert!(validate_sync_rel_path("/books/b1/book.json").is_err());
        assert!(validate_sync_rel_path("books/../../etc/passwd").is_err());
    }

    #[test]
    fn chapter_conflict_merge_never_loses_either_side() {
        let local = ChapterContent {
            chapter_id: "c1".into(),
            content: "本机写的新段落".into(),
            updated_at: 2000,
            versions: vec![Version {
                id: "v-local".into(),
                created_at: 1000,
                kind: "auto".into(),
                label: "旧版".into(),
                chars: 3,
                content: "旧内容".into(),
            }],
        };
        let remote = ChapterContent {
            chapter_id: "c1".into(),
            content: "手机上写的另一版".into(),
            updated_at: 1800,
            versions: vec![Version {
                id: "v-remote".into(),
                created_at: 1500,
                kind: "manual".into(),
                label: "手机快照".into(),
                chars: 4,
                content: "手机快照稿".into(),
            }],
        };
        let (merged, conflict) = merge_chapter_content(&local, &remote, "Android 手机");
        assert!(conflict);
        assert_eq!(merged.content, "本机写的新段落");
        assert!(merged.versions.iter().any(|v| v.kind == "conflict" && v.content == "手机上写的另一版"));
        assert!(merged.versions.iter().any(|v| v.id == "v-local"));
        assert!(merged.versions.iter().any(|v| v.id == "v-remote"));
    }

    #[test]
    fn three_way_plan_detects_upload_download_merge_and_tombstone() {
        let mut local = SyncManifest::default();
        let mut remote = SyncManifest::default();
        let mut base = BTreeMap::new();

        // 1. unchanged -> skip
        local.entries.insert("content/b/c0.json".into(), SyncEntry { hash: "h0".into(), size: 1, modified_at: 10, kind: "chapter".into() });
        remote.entries.insert("content/b/c0.json".into(), SyncEntry { hash: "h0".into(), size: 1, modified_at: 10, kind: "chapter".into() });
        base.insert("content/b/c0.json".into(), "h0".into());

        // 2. local changed -> upload
        local.entries.insert("content/b/c1.json".into(), SyncEntry { hash: "h1-new".into(), size: 1, modified_at: 20, kind: "chapter".into() });
        remote.entries.insert("content/b/c1.json".into(), SyncEntry { hash: "h1".into(), size: 1, modified_at: 10, kind: "chapter".into() });
        base.insert("content/b/c1.json".into(), "h1".into());

        // 3. remote changed -> download
        local.entries.insert("content/b/c2.json".into(), SyncEntry { hash: "h2".into(), size: 1, modified_at: 10, kind: "chapter".into() });
        remote.entries.insert("content/b/c2.json".into(), SyncEntry { hash: "h2-new".into(), size: 1, modified_at: 20, kind: "chapter".into() });
        base.insert("content/b/c2.json".into(), "h2".into());

        // 4. both changed -> merge
        local.entries.insert("content/b/c3.json".into(), SyncEntry { hash: "h3-l".into(), size: 1, modified_at: 20, kind: "chapter".into() });
        remote.entries.insert("content/b/c3.json".into(), SyncEntry { hash: "h3-r".into(), size: 1, modified_at: 25, kind: "chapter".into() });
        base.insert("content/b/c3.json".into(), "h3".into());

        // 5. deleted remotely (unchanged locally) -> delete local
        local.entries.insert("content/b/c4.json".into(), SyncEntry { hash: "h4".into(), size: 1, modified_at: 10, kind: "chapter".into() });
        remote.tombstones.insert("content/b/c4.json".into(), 30);
        base.insert("content/b/c4.json".into(), "h4".into());

        let (plan, skipped) = compute_sync_plan(&local, &remote, &base, SyncDirection::Bidirectional);
        assert_eq!(skipped, 1);
        let find = |p: &str| plan.iter().find(|a| a.path == p).map(|a| a.action.clone());
        assert_eq!(find("content/b/c1.json"), Some(SyncActionKind::Upload));
        assert_eq!(find("content/b/c2.json"), Some(SyncActionKind::Download));
        assert_eq!(find("content/b/c3.json"), Some(SyncActionKind::Merge));
        assert_eq!(find("content/b/c4.json"), Some(SyncActionKind::DeleteLocal));
    }
}
