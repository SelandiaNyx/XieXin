//! Tauri 应用状态与全部 IPC 命令。

use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Manager, State};

use crate::export::{self, ExportOptions, ExportResult, RecentExport};
use crate::smoke;
use crate::storage::{
    default_data_dir, sanitize_filename, BookMeta, BookPayload, BookStats, Card, SaveResult,
    Settings, Store, TrashEntry, Version, VersionMeta, WorkspaceState,
};
use crate::text::{count_text, format_ms, now_ms, FormatRule, ReplaceReport, TextCount};

pub struct AppState {
    pub store: Mutex<Store>,
    pub started_at: i64,
}

impl AppState {
    pub fn new(store: Store) -> Self {
        Self {
            store: Mutex::new(store),
            started_at: now_ms(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub dir: String,
    pub bytes: u64,
    pub started_at: i64,
}

/// 前端把运行期日志写到数据目录，便于排查 WebView 里的异常。
#[tauri::command]
pub fn ui_log(state: State<'_, AppState>, message: String) -> Result<(), String> {
    let store = lock(&state)?;
    let line = format!("[{}] {}\n", crate::text::format_ms(now_ms()), message);
    let path = store.root.join("ui-log.txt");
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatReport {
    pub content: String,
    pub before: TextCount,
    pub after: TextCount,
    pub rule: String,
    pub changed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDetail {
    pub meta: VersionMeta,
    pub content: String,
    pub current: String,
    pub title: String,
}

fn lock<'a>(state: &'a State<'_, AppState>) -> Result<std::sync::MutexGuard<'a, Store>, String> {
    state.store.lock().map_err(|e| format!("状态锁异常: {e}"))
}

// ---------------------------------------------------------------------------
// 工作区 / 书籍
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn workspace_state(state: State<'_, AppState>) -> Result<WorkspaceState, String> {
    let store = lock(&state)?;
    Ok(WorkspaceState {
        settings: store.settings.clone(),
        registry: store.registry.clone(),
        storage_dir: store.root.to_string_lossy().to_string(),
        storage_bytes: store.storage_bytes(),
        card_kinds: vec![
            "character".into(),
            "plot".into(),
            "inspiration".into(),
            "world".into(),
        ],
    })
}

#[tauri::command]
pub fn storage_info(state: State<'_, AppState>) -> Result<StorageInfo, String> {
    let store = lock(&state)?;
    Ok(StorageInfo {
        dir: store.root.to_string_lossy().to_string(),
        bytes: store.storage_bytes(),
        started_at: state.started_at,
    })
}

#[tauri::command]
pub fn create_book(
    state: State<'_, AppState>,
    title: String,
    author: Option<String>,
    genre: Option<String>,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    let book = store.create_book(&title, author.as_deref().unwrap_or(""), genre.as_deref().unwrap_or(""))?;
    store.settings.last_book_id = book.id.clone();
    store.settings.last_chapter_id =
        book.volumes.first().and_then(|v| v.chapters.first()).map(|c| c.id.clone()).unwrap_or_default();
    store.save_settings()?;
    Ok(book)
}

#[tauri::command]
pub fn open_book(state: State<'_, AppState>, book_id: String) -> Result<BookPayload, String> {
    let mut store = lock(&state)?;
    let book = store.book(&book_id)?;
    store.settings.last_book_id = book_id.clone();
    store.save_settings()?;
    let cards = store.read_cards(&book_id);
    Ok(BookPayload {
        book,
        cards,
        storage_dir: store.root.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn delete_book(state: State<'_, AppState>, book_id: String) -> Result<(), String> {
    let mut store = lock(&state)?;
    store.delete_book(&book_id)
}

#[tauri::command]
pub fn update_book_meta(
    state: State<'_, AppState>,
    book_id: String,
    title: Option<String>,
    author: Option<String>,
    genre: Option<String>,
    summary: Option<String>,
    cover_color: Option<String>,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    {
        let book = store.book_mut(&book_id)?;
        if let Some(t) = title {
            if !t.trim().is_empty() {
                book.title = t.trim().to_string();
            }
        }
        if let Some(a) = author {
            book.author = a;
        }
        if let Some(g) = genre {
            book.genre = g;
        }
        if let Some(s) = summary {
            book.summary = s;
        }
        if let Some(c) = cover_color {
            book.cover_color = c;
        }
        book.updated_at = now_ms();
    }
    let snap = store.require_book(&book_id)?.clone();
    store.save_book(&snap)?;
    store.save_registry()?;
    Ok(snap)
}

#[tauri::command]
pub fn book_stats(state: State<'_, AppState>, book_id: String) -> Result<BookStats, String> {
    let store = lock(&state)?;
    let book = store.book(&book_id)?;
    Ok(store.book_stats(&book))
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<Settings, String> {
    let mut store = lock(&state)?;
    let normalized = settings.normalized();
    store.settings = normalized.clone();
    store.save_settings()?;
    Ok(normalized)
}

// ---------------------------------------------------------------------------
// 卷 / 章
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn add_volume(state: State<'_, AppState>, book_id: String, title: String) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.add_volume(&book_id, &title)?;
    Ok(store.book(&book_id)?)
}

#[tauri::command]
pub fn add_chapter(
    state: State<'_, AppState>,
    book_id: String,
    volume_id: String,
    title: String,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.add_chapter(&book_id, &volume_id, &title)?;
    Ok(store.book(&book_id)?)
}

#[tauri::command]
pub fn delete_chapter(state: State<'_, AppState>, book_id: String, chapter_id: String) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.delete_chapter(&book_id, &chapter_id)?;
    Ok(store.book(&book_id)?)
}

#[tauri::command]
pub fn delete_volume(
    state: State<'_, AppState>,
    book_id: String,
    volume_id: String,
    delete_chapters: Option<bool>,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.delete_volume(&book_id, &volume_id, delete_chapters.unwrap_or(true))?;
    Ok(store.book(&book_id)?)
}

#[tauri::command]
pub fn rename_node(
    state: State<'_, AppState>,
    book_id: String,
    kind: String,
    id: String,
    title: String,
    summary: Option<String>,
    status: Option<String>,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.rename_node(&book_id, &kind, &id, &title, summary, status)?;
    Ok(store.book(&book_id)?)
}

#[tauri::command]
pub fn move_node(
    state: State<'_, AppState>,
    book_id: String,
    kind: String,
    id: String,
    direction: String,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.move_node(&book_id, &kind, &id, &direction)?;
    Ok(store.book(&book_id)?)
}

#[tauri::command]
pub fn move_chapter_to(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
    target_volume_id: String,
    position: usize,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.move_chapter_to(&book_id, &chapter_id, &target_volume_id, position)?;
    Ok(store.book(&book_id)?)
}

#[tauri::command]
pub fn set_volume_expanded(
    state: State<'_, AppState>,
    book_id: String,
    volume_id: String,
    expanded: bool,
) -> Result<(), String> {
    let mut store = lock(&state)?;
    store.set_volume_expanded(&book_id, &volume_id, expanded)
}

// ---------------------------------------------------------------------------
// 正文 / 历史版本
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn read_chapter(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
) -> Result<Version, String> {
    let store = lock(&state)?;
    let c = store.read_content(&book_id, &chapter_id);
    Ok(Version {
        id: chapter_id,
        created_at: c.updated_at,
        kind: "current".into(),
        label: String::new(),
        chars: count_text(&c.content).total,
        content: c.content,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_chapter(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
    content: String,
    title: Option<String>,
    summary: Option<String>,
    status: Option<String>,
    manual_snapshot: Option<bool>,
    snapshot_label: Option<String>,
) -> Result<SaveResult, String> {
    let mut store = lock(&state)?;
    let manual = manual_snapshot.unwrap_or(false);
    // 距离上一版本超过 3 分钟时自动补一个版本；内容差异阈值之外的连续保存不刷版本。
    let recent = store
        .read_content(&book_id, &chapter_id)
        .versions
        .first()
        .map(|v| now_ms() - v.created_at)
        .unwrap_or(i64::MAX);
    let time_due = recent > 180_000;
    let force = manual || time_due;
    let kind = if manual { "manual" } else { "auto" };
    store.save_chapter(
        &book_id,
        &chapter_id,
        &content,
        title,
        summary,
        status,
        force,
        snapshot_label.as_deref().unwrap_or(""),
        kind,
    )
}

#[tauri::command]
pub fn list_versions(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
) -> Result<Vec<VersionMeta>, String> {
    let store = lock(&state)?;
    Ok(store.list_versions(&book_id, &chapter_id))
}

#[tauri::command]
pub fn version_detail(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
    version_id: String,
) -> Result<VersionDetail, String> {
    let store = lock(&state)?;
    let v = store
        .version_content(&book_id, &chapter_id, &version_id)
        .ok_or_else(|| "找不到该版本".to_string())?;
    let meta = VersionMeta {
        id: v.id.clone(),
        created_at: v.created_at,
        kind: v.kind.clone(),
        label: v.label.clone(),
        chars: v.chars,
    };
    let current = store.read_content(&book_id, &chapter_id).content;
    let title = store
        .book(&book_id)?
        .volumes
        .iter()
        .flat_map(|vol| vol.chapters.iter())
        .find(|c| c.id == chapter_id)
        .map(|c| c.title.clone())
        .unwrap_or_default();
    Ok(VersionDetail {
        meta,
        content: v.content,
        current,
        title,
    })
}

#[tauri::command]
pub fn restore_version(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
    version_id: String,
) -> Result<SaveResult, String> {
    let mut store = lock(&state)?;
    store.restore_version(&book_id, &chapter_id, &version_id)
}

#[tauri::command]
pub fn delete_version(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
    version_id: String,
) -> Result<usize, String> {
    let store = lock(&state)?;
    store.delete_version(&book_id, &chapter_id, &version_id)
}

// ---------------------------------------------------------------------------
// 卡片
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_cards(state: State<'_, AppState>, book_id: String) -> Result<Vec<Card>, String> {
    let store = lock(&state)?;
    Ok(store.read_cards(&book_id))
}

#[tauri::command]
pub fn upsert_card(state: State<'_, AppState>, book_id: String, card: Card) -> Result<Card, String> {
    let store = lock(&state)?;
    store.upsert_card(&book_id, card)
}

#[tauri::command]
pub fn delete_card(state: State<'_, AppState>, book_id: String, card_id: String) -> Result<(), String> {
    let store = lock(&state)?;
    store.delete_card(&book_id, &card_id)
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn count(text: String) -> TextCount {
    count_text(&text)
}

#[tauri::command]
pub fn one_click_format(
    state: State<'_, AppState>,
    text: String,
    rule: Option<String>,
    chapter_title: Option<String>,
    ensure_title: Option<bool>,
) -> Result<FormatReport, String> {
    let rule_str = match rule {
        Some(r) if !r.is_empty() => r,
        _ => {
            let store = lock(&state)?;
            store.settings.one_click_format_rule.clone()
        }
    };
    let before = count_text(&text);
    let out = crate::text::smart_format(
        &text,
        FormatRule::parse(&rule_str),
        chapter_title.as_deref(),
        ensure_title.unwrap_or(false),
    );
    let after = count_text(&out);
    Ok(FormatReport {
        changed: out != text,
        content: out,
        before,
        after,
        rule: rule_str,
    })
}

#[tauri::command]
pub fn replace_all(
    text: String,
    needle: String,
    replacement: String,
    case_sensitive: Option<bool>,
) -> (String, ReplaceReport) {
    crate::text::replace_all(&text, &needle, &replacement, case_sensitive.unwrap_or(false))
}

// ---------------------------------------------------------------------------
// 导入 / 导出
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pick_directory(title: Option<String>) -> Result<Option<String>, String> {
    let t = title.unwrap_or_else(|| "选择文件夹".into());
    tauri::async_runtime::spawn_blocking(move || export::pick_directory(&t))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pick_open_file(kind: Option<String>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match kind.as_deref() {
        Some("json") => export::pick_open_file(&[("写心备份", &["json"]), ("所有文件", &["*"])]),
        _ => export::pick_open_file(&[("文本文件", &["txt", "md"]), ("所有文件", &["*"])]),
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pick_save_path(default_name: Option<String>, ext: Option<String>) -> Result<Option<String>, String> {
    let name = default_name.unwrap_or_else(|| format!("novel-{}.txt", crate::text::now_iso()));
    let e = ext.unwrap_or_else(|| "txt".into());
    tauri::async_runtime::spawn_blocking(move || export::pick_save_path(&name, &e))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn suggest_filename(
    state: State<'_, AppState>,
    book_id: String,
    options: ExportOptions,
) -> Result<String, String> {
    let store = lock(&state)?;
    export::suggest_filename(&store, &book_id, &options)
}

#[tauri::command]
pub async fn export_book(
    state: State<'_, AppState>,
    book_id: String,
    options: ExportOptions,
) -> Result<ExportResult, String> {
    let store = lock(&state)?;
    let result = export::run_export(&store, &book_id, &options)?;
    store.push_recent_export(RecentExport {
        path: result.path.clone(),
        format: result.format.clone(),
        bytes: result.bytes,
        at: result.exported_at,
    })?;
    Ok(result)
}

#[tauri::command]
pub fn list_recent_exports(state: State<'_, AppState>) -> Result<Vec<RecentExport>, String> {
    let store = lock(&state)?;
    Ok(store.read_recent_exports())
}

#[tauri::command]
pub fn push_recent_export(
    state: State<'_, AppState>,
    path: String,
    format: String,
    bytes: u64,
) -> Result<Vec<RecentExport>, String> {
    let store = lock(&state)?;
    store.push_recent_export(RecentExport {
        path,
        format,
        bytes,
        at: now_ms(),
    })
}

#[tauri::command]
pub fn import_text(
    state: State<'_, AppState>,
    book_id: String,
    volume_id: String,
    source_path: Option<String>,
    text: Option<String>,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    let raw = if let Some(t) = text {
        t
    } else if let Some(p) = source_path {
        let bytes = std::fs::read(&p).map_err(|e| format!("读取失败 {p}: {e}"))?;
        crate::text_decode::decode_text(&bytes)
    } else {
        return Err("没有可导入的内容".into());
    };
    store.import_text(&book_id, &volume_id, &raw, "")?;
    Ok(store.book(&book_id)?)
}

#[tauri::command]
pub fn import_backup(
    state: State<'_, AppState>,
    source_path: String,
    as_new_book: Option<bool>,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    let raw = std::fs::read_to_string(&source_path).map_err(|e| format!("读取失败: {e}"))?;
    let payload: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("不是有效的写心备份: {e}"))?;
    // 兼容早期版本（墨阁）导出的备份
    let kind_ok = payload
        .get("kind")
        .and_then(|k| k.as_str())
        .map(|k| k.starts_with("heartwrite-") || k.starts_with("moge-"))
        .unwrap_or(false);
    if !kind_ok {
        return Err("这不是写心的备份文件".into());
    }
    let book_val = payload.get("book").ok_or_else(|| "备份缺少 book 字段".to_string())?.clone();
    let mut book: BookMeta = serde_json::from_value(book_val).map_err(|e| format!("书籍数据损坏: {e}"))?;
    if as_new_book.unwrap_or(true) {
        book.id = uuid::Uuid::new_v4().to_string();
        book.title = format!("{}（导入）", book.title);
    }
    for vol in book.volumes.iter_mut() {
        for ch in vol.chapters.iter_mut() {
            ch.versions = 0;
        }
    }
    let chapters = payload
        .get("chapters")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let cards: Vec<Card> = payload
        .get("cards")
        .and_then(|c| serde_json::from_value(c.clone()).ok())
        .unwrap_or_default();
    store.registry.books.retain(|b| b.id != book.id);
    store.registry.books.push(book.clone());
    store.save_book(&book)?;
    store.save_cards(&book.id, &cards)?;
    for item in chapters {
        let cid = item.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let content = item.get("content").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let versions: Vec<Version> = item
            .get("versions")
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default();
        if cid.is_empty() {
            continue;
        }
        store.write_content(
            &book.id,
            &crate::storage::ChapterContent {
                chapter_id: cid,
                content,
                updated_at: now_ms(),
                versions,
            },
        )?;
    }
    store.save_registry()?;
    Ok(book)
}

#[tauri::command]
pub fn verify_book(state: State<'_, AppState>, book_id: String) -> Result<Vec<String>, String> {
    let store = lock(&state)?;
    store.verify_book(&book_id)
}

#[tauri::command]
pub fn list_trash(state: State<'_, AppState>) -> Result<Vec<TrashEntry>, String> {
    let store = lock(&state)?;
    Ok(store.list_trash())
}

#[tauri::command]
pub fn empty_trash(state: State<'_, AppState>) -> Result<usize, String> {
    let store = lock(&state)?;
    store.empty_trash()
}

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let target = if path.trim().is_empty() {
        return Err("路径为空".into());
    } else {
        path
    };
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target.replace('/', "\\"))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub name: String,
    pub file: String,
    pub path: String,
}

/// 扫描系统字体目录，抓取字体名（用于字体选择器）。
#[tauri::command]
pub fn list_fonts() -> Result<Vec<FontFamily>, String> {
    let mut dirs: Vec<PathBuf> = vec![
        PathBuf::from("C:/Windows/Fonts"),
        PathBuf::from(std::env::var("LOCALAPPDATA").unwrap_or_default()).join("Microsoft/Windows/Fonts"),
    ];
    if let Ok(home) = std::env::var("HOME") {
        dirs.push(PathBuf::from(&home).join("AppData/Local/Microsoft/Windows/Fonts"));
    }
    let mut seen = std::collections::BTreeMap::<String, FontFamily>::new();
    for dir in dirs {
        if !dir.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&dir).max_depth(2).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if ext != "ttf" && ext != "otf" && ext != "ttc" {
                continue;
            }
            let file = path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default();
            let name = font_family_name(&file);
            seen.entry(name.clone()).or_insert(FontFamily {
                name,
                file,
                path: path.to_string_lossy().to_string(),
            });
        }
    }
    let mut list: Vec<FontFamily> = seen.into_values().collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    if list.is_empty() {
        return Err("未在系统字体目录中找到可用字体".into());
    }
    Ok(list)
}

/// 由文件名猜测字体族名（Windows 字体文件名与字体族名高度一致）。
fn font_family_name(file: &str) -> String {
    let stem = file.rsplit_once('.').map(|(s, _)| s).unwrap_or(file);
    let cleaned = stem
        .replace('-', " ")
        .replace('_', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    cleaned.trim().to_string()
}

/// 开发诊断：报告窗口与缩放信息（用于排查界面尺寸问题）。
#[tauri::command]
pub fn window_diag(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let window = app.get_webview_window("main").ok_or_else(|| "找不到主窗口".to_string())?;
    let size = window.inner_size().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    Ok(format!(
        "inner={}x{} outer={}x{} scale={}",
        size.width, size.height, outer.width, outer.height, scale
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStatus {
    pub id: String,
    pub label: String,
    pub group: String,
    pub color: String,
    pub hint: String,
}

/// 章节状态：创作阶段（草稿→初稿→修订→定稿）+ 发布阶段（待发布→已发布→待返修）。
/// 参考 Scrivener 的 first/revised/final draft 与中文网文"大纲→章纲→草稿→初稿→修改→发布"流程。
#[tauri::command]
pub fn chapter_statuses() -> Vec<ChapterStatus> {
    let mk = |id: &str, label: &str, group: &str, color: &str, hint: &str| ChapterStatus {
        id: id.into(),
        label: label.into(),
        group: group.into(),
        color: color.into(),
        hint: hint.into(),
    };
    vec![
        mk("draft", "草稿", "创作", "#9aa0b4", "随手记下的段落，还没成形"),
        mk("first", "初稿", "创作", "#5b8def", "第一次完整写下来"),
        mk("revising", "修订中", "创作", "#e0a33e", "正在改结构、补情节"),
        mk("final", "已定稿", "创作", "#7c6bd6", "内容定稿，可以发布"),
        mk("ready", "待发布", "发布", "#2f9e6f", "已定稿，排队等待发布"),
        mk("published", "已发布", "发布", "#1f9d63", "已经发布给读者"),
        mk("rework", "待返修", "发布", "#d9534f", "读者反馈或自查后需要返工"),
    ]
}

#[tauri::command]
pub fn dev_smoke_test(app: tauri::AppHandle) -> Result<String, String> {
    let state = app.state::<AppState>();
    let mut store = lock(&state)?;
    let report = smoke::run(&mut store)?;
    println!("[SMOKE]\n{report}");
    Ok(report)
}

pub fn storage_dir_for_app(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .ok()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(default_data_dir)
}

pub fn timestamp_label(ms: i64) -> String {
    format_ms(ms)
}

pub fn file_name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|f| sanitize_filename(&f.to_string_lossy(), "file"))
        .unwrap_or_default()
}
