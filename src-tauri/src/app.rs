//! Tauri 命令层：把 `storage` / `text` / `export` 包装成前端可 `invoke` 的命令。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};

use crate::dialog;
use crate::export::{self, ExportOptions, ExportResult, RecentExport};
pub use crate::fonts::FontEntry;
use crate::storage::{
    self, BookMeta, BookStats, Card, ChapterContent, ChapterStatus, Registry, SaveResult, SearchHit,
    Settings, StorageLocationInfo, Store, TrashEntry, Version, VersionMeta,
};
use crate::text::{self, FormatRule, ReplaceReport, TextCount};
use crate::text_decode::decode_text;

pub struct AppState {
    pub store: Mutex<Store>,
    /// 放 `storage-location.json` 的固定配置目录（不随稿件搬家）。
    pub config_dir: PathBuf,
    /// 启动时是否由 `--data-dir` / `NOVEL_MANAGER_DATA_DIR` 或移动端沙盒固定了目录。
    pub forced_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePayload {
    pub settings: Settings,
    pub registry: Registry,
    pub storage_dir: String,
    pub storage_bytes: u64,
    pub location: StorageLocationInfo,
    /// 当前平台有没有系统原生文件/目录选择器（Android 没有）。
    pub has_native_pickers: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenBookPayload {
    pub book: BookMeta,
    pub cards: Vec<Card>,
    /// 封面的 data URL（没设过或文件丢了就是 `None`，前端据此走原来的颜色 + 图标）。
    pub cover: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadChapterPayload {
    pub chapter_id: String,
    pub content: String,
    pub updated_at: i64,
    pub count: TextCount,
    pub versions: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionDetail {
    pub meta: VersionMeta,
    pub content: String,
    pub current: String,
    pub current_chars: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub path: String,
    pub bytes: u64,
    pub books: usize,
    pub trash: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfCheckReport {
    pub passed: usize,
    pub failed: Vec<String>,
    pub data_dir: String,
    pub sample_format: String,
}

fn lock<'a>(state: &'a State<'_, AppState>) -> Result<std::sync::MutexGuard<'a, Store>, String> {
    state.store.lock().map_err(|_| "存储锁异常".to_string())
}

// ---------------------------------------------------------------------------
// 启动 / 设置 / 稿件位置
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn workspace_state(state: State<'_, AppState>) -> Result<WorkspacePayload, String> {
    let store = lock(&state)?;
    let location = storage::location_info(&store.root, &state.config_dir, state.forced_dir);
    Ok(WorkspacePayload {
        settings: store.settings.clone(),
        registry: store.registry.clone(),
        storage_dir: store.root.to_string_lossy().to_string(),
        storage_bytes: store.storage_bytes(),
        location,
        has_native_pickers: dialog::FileFilter::has_native_pickers(),
    })
}

#[tauri::command]
pub fn storage_location(state: State<'_, AppState>) -> Result<StorageLocationInfo, String> {
    let store = lock(&state)?;
    Ok(storage::location_info(&store.root, &state.config_dir, state.forced_dir))
}

/// 更换稿件保存目录：
/// - `path` 为空串表示"恢复默认位置"；
/// - `move_existing` 为 `true` 时先把当前目录里的全部作品、正文、版本、封面、卡片搬过去；
///   为 `false` 时只在指针文件里记下新位置（用于首次启动还没写稿、或原目录已丢失的情况）。
/// - 当目标目录就是当前目录且处于首次确认位置（或 `move_existing == false`）时，直接写入位置指针，
///   避免用户在首次启动点击「用默认位置」时因同目录校验报错。
#[tauri::command]
pub fn set_storage_dir(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    move_existing: bool,
) -> Result<StorageLocationInfo, String> {
    if state.forced_dir {
        return Err("当前使用固定数据目录，不能在界面中更换位置".into());
    }
    let trimmed = path.trim();
    let is_reset = trimmed.is_empty();
    let target = if is_reset {
        default_data_dir_for_app(&app)
    } else {
        PathBuf::from(trimmed)
    };

    // 先把当前根路径拷出来，释放锁之后再搬文件；但真正换根时重新拿锁，保证没有并发写入
    let from = {
        let store = lock(&state)?;
        store.root.clone()
    };

    let same_dir = storage::is_same_location(&from, &target);
    let has_recorded = storage::read_location_record(&state.config_dir).is_some();

    if same_dir {
        if move_existing && has_recorded && !is_reset {
            return Err("这就是当前的位置".into());
        }
        fs::create_dir_all(&target).map_err(|e| format!("无法创建目标目录：{e}"))?;
        let record_val = if is_reset {
            String::new()
        } else {
            target.to_string_lossy().to_string()
        };
        storage::write_location_record(&state.config_dir, &record_val)?;
        let store = lock(&state)?;
        return Ok(storage::location_info(&store.root, &state.config_dir, state.forced_dir));
    }

    if move_existing {
        storage::move_data_dir(&from, &target)?;
    } else {
        storage::validate_new_location(&from, &target)?;
        fs::create_dir_all(&target).map_err(|e| format!("无法创建目标目录：{e}"))?;
    }

    let fresh = Store::load(target.clone())?;
    let record_val = if is_reset {
        // 恢复默认位置时也把默认目录记进指针，这样下次启动不会再当作"首次启动未选择"
        target.to_string_lossy().to_string()
    } else {
        target.to_string_lossy().to_string()
    };
    storage::write_location_record(&state.config_dir, &record_val)?;

    let mut store = lock(&state)?;
    *store = fresh;
    Ok(storage::location_info(&store.root, &state.config_dir, state.forced_dir))
}

#[tauri::command]
pub fn chapter_statuses() -> Vec<ChapterStatus> {
    storage::default_statuses()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, next: Settings) -> Result<Settings, String> {
    let mut store = lock(&state)?;
    store.settings = next;
    store.settings.history_depth = store.settings.history_depth.clamp(1, storage::MAX_HISTORY_HARD_CAP);
    store.settings.autosave_secs = store.settings.autosave_secs.max(5);
    store.settings.font_size = store.settings.font_size.clamp(12, 36);
    store.settings.line_height = store.settings.line_height.clamp(1.2, 3.0);
    store.settings.editor_width = store.settings.editor_width.clamp(520, 1400);
    store.save_settings()?;
    Ok(store.settings.clone())
}

/// 记住当前打开的书与章节（轻量写入，供切章时调用，下次启动直接定位）。
#[tauri::command]
pub fn set_last_position(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
) -> Result<(), String> {
    let mut store = lock(&state)?;
    if store.settings.last_book_id == book_id && store.settings.last_chapter_id == chapter_id {
        return Ok(());
    }
    store.settings.last_book_id = book_id;
    store.settings.last_chapter_id = chapter_id;
    store.save_settings()
}

#[tauri::command]
pub fn storage_info(state: State<'_, AppState>) -> Result<StorageInfo, String> {
    let store = lock(&state)?;
    Ok(StorageInfo {
        path: store.root.to_string_lossy().to_string(),
        bytes: store.storage_bytes(),
        books: store.registry.books.len(),
        trash: store.list_trash().len(),
    })
}

// ---------------------------------------------------------------------------
// 书籍
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn create_book(
    state: State<'_, AppState>,
    title: String,
    author: String,
    genre: String,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    let book = store.create_book(&title, &author, &genre)?;
    store.settings.last_book_id = book.id.clone();
    let _ = store.save_settings();
    Ok(book)
}

#[tauri::command]
pub fn create_sample_book(state: State<'_, AppState>) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    let book = store.create_sample_book()?;
    store.settings.last_book_id = book.id.clone();
    let _ = store.save_settings();
    Ok(book)
}

#[tauri::command]
pub fn open_book(state: State<'_, AppState>, book_id: String) -> Result<OpenBookPayload, String> {
    let mut store = lock(&state)?;
    let book = store.ensure_structure(&book_id)?;
    let cards = store.read_cards(&book_id)?;
    let cover = store
        .read_book_cover(&book_id)
        .map(|(ext, bytes)| crate::cover::data_url(&ext, &bytes));
    store.settings.last_book_id = book_id;
    let _ = store.save_settings();
    Ok(OpenBookPayload { book, cards, cover })
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
    store.update_book_meta(&book_id, title, author, genre, summary, cover_color)
}

#[tauri::command]
pub fn duplicate_book(state: State<'_, AppState>, book_id: String) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.duplicate_book(&book_id)
}

#[tauri::command]
pub fn delete_book(state: State<'_, AppState>, book_id: String) -> Result<Registry, String> {
    let mut store = lock(&state)?;
    store.delete_book(&book_id)?;
    Ok(store.registry.clone())
}

// ---------------------------------------------------------------------------
// 封面（可选：没设过就走默认颜色 + 图标）
// ---------------------------------------------------------------------------

/// 读取某本书的封面 data URL；没有封面或文件缺失时返回空串。
#[tauri::command]
pub fn book_cover(state: State<'_, AppState>, book_id: String) -> Result<String, String> {
    let store = lock(&state)?;
    Ok(store
        .read_book_cover(&book_id)
        .map(|(ext, bytes)| crate::cover::data_url(&ext, &bytes))
        .unwrap_or_default())
}

/// 预览一张尚未保存的图片（用户在资料弹层里刚选完、还没点"保存"时用）。
#[tauri::command]
pub fn preview_cover(path: String) -> Result<String, String> {
    let (ext, bytes) = crate::cover::read_image(&path)?;
    Ok(crate::cover::data_url(&ext, &bytes))
}

#[tauri::command]
pub fn set_book_cover(
    state: State<'_, AppState>,
    book_id: String,
    source_path: String,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.set_book_cover(&book_id, &source_path)
}

#[tauri::command]
pub fn clear_book_cover(state: State<'_, AppState>, book_id: String) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.clear_book_cover(&book_id)
}

#[tauri::command]
pub fn book_stats(state: State<'_, AppState>, book_id: String) -> Result<BookStats, String> {
    let store = lock(&state)?;
    let book = store.book(&book_id)?;
    store.book_stats(&book)
}

#[tauri::command]
pub fn verify_book(state: State<'_, AppState>, book_id: String) -> Result<Vec<String>, String> {
    let store = lock(&state)?;
    store.verify_book(&book_id)
}

// ---------------------------------------------------------------------------
// 卷 / 章结构
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn add_volume(
    state: State<'_, AppState>,
    book_id: String,
    title: String,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    let _ = store.add_volume(&book_id, &title)?;
    store.book(&book_id)
}

#[tauri::command]
pub fn add_chapter(
    state: State<'_, AppState>,
    book_id: String,
    volume_id: String,
    title: String,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    let _ = store.add_chapter(&book_id, &volume_id, &title)?;
    store.book(&book_id)
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
    store.book(&book_id)
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
    store.book(&book_id)
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
    store.book(&book_id)
}

#[tauri::command]
pub fn reorder_volumes(
    state: State<'_, AppState>,
    book_id: String,
    order: Vec<String>,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.reorder_volumes(&book_id, &order)?;
    store.book(&book_id)
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

#[tauri::command]
pub fn delete_chapter(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    store.delete_chapter(&book_id, &chapter_id)?;
    store.book(&book_id)
}

#[tauri::command]
pub fn delete_volume(
    state: State<'_, AppState>,
    book_id: String,
    volume_id: String,
    delete_chapters: bool,
) -> Result<BookMeta, String> {
    let mut store = lock(&state)?;
    let _ = store.delete_volume(&book_id, &volume_id, delete_chapters)?;
    store.book(&book_id)
}

// ---------------------------------------------------------------------------
// 章节内容与历史版本
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn read_chapter(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
) -> Result<ReadChapterPayload, String> {
    let store = lock(&state)?;
    let stored = store.read_content(&book_id, &chapter_id)?;
    let count = text::count_text(&stored.content);
    Ok(ReadChapterPayload {
        chapter_id,
        versions: stored.versions.len(),
        updated_at: stored.updated_at,
        content: stored.content,
        count,
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn save_chapter(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
    content: String,
    title: Option<String>,
    summary: Option<String>,
    status: Option<String>,
    manual_snapshot: bool,
    snapshot_label: Option<String>,
) -> Result<SaveResult, String> {
    let mut store = lock(&state)?;
    let label = snapshot_label.unwrap_or_default();
    let kind = if manual_snapshot { "manual" } else { "auto" };
    store.save_chapter(
        &book_id,
        &chapter_id,
        &content,
        title,
        summary,
        status,
        manual_snapshot,
        &label,
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
    store.list_versions(&book_id, &chapter_id)
}

#[tauri::command]
pub fn version_detail(
    state: State<'_, AppState>,
    book_id: String,
    chapter_id: String,
    version_id: String,
) -> Result<VersionDetail, String> {
    let store = lock(&state)?;
    let stored = store.read_content(&book_id, &chapter_id)?;
    let v = stored
        .versions
        .into_iter()
        .find(|v| v.id == version_id)
        .ok_or_else(|| "找不到该版本".to_string())?;
    let current_chars = text::count_text(&stored.content).total;
    Ok(VersionDetail {
        meta: VersionMeta {
            id: v.id,
            created_at: v.created_at,
            kind: v.kind,
            label: v.label,
            chars: v.chars,
        },
        content: v.content,
        current: stored.content,
        current_chars,
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
    store.read_cards(&book_id)
}

#[tauri::command]
pub fn upsert_card(
    state: State<'_, AppState>,
    book_id: String,
    card: Card,
) -> Result<Card, String> {
    let store = lock(&state)?;
    store.upsert_card(&book_id, card)
}

#[tauri::command]
pub fn delete_card(
    state: State<'_, AppState>,
    book_id: String,
    card_id: String,
) -> Result<Vec<Card>, String> {
    let store = lock(&state)?;
    store.delete_card(&book_id, &card_id)?;
    store.read_cards(&book_id)
}

// ---------------------------------------------------------------------------
// 排版 / 搜索 / 字数
// ---------------------------------------------------------------------------

/// 全书搜索：在 Rust 侧一次扫完所有章节的正文，返回命中列表与上下文片段。
#[tauri::command]
pub fn search_book(
    state: State<'_, AppState>,
    book_id: String,
    keyword: String,
) -> Result<Vec<SearchHit>, String> {
    let store = lock(&state)?;
    store.search_book(&book_id, &keyword, 50)
}

#[tauri::command]
pub fn count_text_cmd(text: String) -> TextCount {
    text::count_text(&text)
}

#[tauri::command]
pub fn smart_format_cmd(
    text: String,
    rule: String,
    chapter_title: Option<String>,
    ensure_title: bool,
) -> String {
    text::smart_format(&text, FormatRule::parse(&rule), chapter_title.as_deref(), ensure_title)
}

#[tauri::command]
pub fn replace_all_cmd(
    content: String,
    needle: String,
    replacement: String,
    case_sensitive: bool,
) -> (String, ReplaceReport) {
    text::replace_all(&content, &needle, &replacement, case_sensitive)
}

// ---------------------------------------------------------------------------
// 导入 / 导出
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn import_text_cmd(
    state: State<'_, AppState>,
    book_id: String,
    volume_id: String,
    file_path: Option<String>,
    raw_text: Option<String>,
    prefix: Option<String>,
) -> Result<BookMeta, String> {
    let text = if let Some(p) = file_path {
        let bytes = fs::read(&p).map_err(|e| format!("读取文件失败: {e}"))?;
        decode_text(&bytes)
    } else {
        raw_text.unwrap_or_default()
    };
    let mut store = lock(&state)?;
    let _ = store.import_text(&book_id, &volume_id, &text, &prefix.unwrap_or_default())?;
    store.book(&book_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupChapterIn {
    id: String,
    #[allow(dead_code)]
    title: Option<String>,
    content: String,
    #[serde(default)]
    versions: Vec<Version>,
}

/// 从 JSON 备份文件导入一整本书。
#[tauri::command]
pub fn import_backup_cmd(
    state: State<'_, AppState>,
    file_path: String,
    as_new_book: bool,
) -> Result<BookMeta, String> {
    let raw = fs::read_to_string(&file_path).map_err(|e| format!("读取备份失败: {e}"))?;
    let val: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("备份格式错误: {e}"))?;
    let book_val = val.get("book").ok_or("备份中缺少 book 字段")?;
    let mut book: BookMeta = serde_json::from_value(book_val.clone()).map_err(|e| e.to_string())?;
    let cards: Vec<Card> = val
        .get("cards")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let chapters: Vec<BackupChapterIn> = val
        .get("chapters")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let backup_cover = export::cover_from_backup(&val);

    let mut store = lock(&state)?;
    if as_new_book || store.registry.books.iter().any(|b| b.id == book.id) {
        book.id = uuid::Uuid::new_v4().to_string();
        book.title = format!("{}（导入）", book.title);
    }
    fs::create_dir_all(store.book_dir(&book.id)).map_err(|e| e.to_string())?;
    fs::create_dir_all(store.content_dir(&book.id)).map_err(|e| e.to_string())?;
    // 备份里带了封面字节就一并落盘；没带（或坏了）就把 cover_image 清空，免得指向不存在的文件
    match backup_cover {
        Some((ext, bytes)) if store.write_book_cover_file(&book.id, &ext, &bytes).is_ok() => {
            book.cover_image = format!("cover.{ext}");
        }
        _ => book.cover_image.clear(),
    }
    store.save_cards(&book.id, &cards)?;
    for c in chapters {
        store.write_content(
            &book.id,
            &ChapterContent {
                chapter_id: c.id,
                content: c.content,
                updated_at: text::now_ms(),
                versions: c.versions,
            },
        )?;
    }
    store.registry.books.push(book.clone());
    store.save_book(&book)?;
    store.save_registry()?;
    Ok(book)
}

#[tauri::command]
pub fn suggest_export_filename(
    state: State<'_, AppState>,
    book_id: String,
    options: ExportOptions,
) -> Result<String, String> {
    let store = lock(&state)?;
    export::suggest_filename(&store, &book_id, &options)
}

#[tauri::command]
pub fn pick_save_path_cmd(default_name: String, ext: String) -> Option<String> {
    export::pick_save_path(&default_name, &ext)
}

#[tauri::command]
pub fn pick_directory_cmd(title: Option<String>) -> Option<String> {
    export::pick_directory(&title.unwrap_or_else(|| "选择导出目录".into()))
}

#[tauri::command]
pub fn pick_open_file_cmd(kind: Option<String>) -> Option<String> {
    match kind.as_deref() {
        Some("json") => export::pick_open_file(&[("JSON 备份", &["json"])]),
        Some("image") => export::pick_open_file(&[(
            "封面图片",
            &["png", "jpg", "jpeg", "webp", "gif", "bmp"],
        )]),
        _ => export::pick_open_file(&[("文本文件", &["txt", "md", "markdown"]), ("所有文件", &["*"])]),
    }
}

#[tauri::command]
pub fn export_book(
    state: State<'_, AppState>,
    book_id: String,
    mut options: ExportOptions,
) -> Result<ExportResult, String> {
    let mut store = lock(&state)?;
    if options.file_path.trim().is_empty() && options.use_dialog {
        let suggested = export::suggest_filename(&store, &book_id, &options)?;
        let ext = match options.format.to_lowercase().as_str() {
            "md" | "markdown" => "md",
            "html" | "htm" => "html",
            "json" | "backup" => "json",
            "epub" => "epub",
            _ => "txt",
        };
        if let Some(chosen) = export::pick_save_path(&suggested, ext) {
            options.file_path = chosen;
        } else {
            return Err("已取消导出".into());
        }
    }
    let result = export::run_export(&store, &book_id, &options)?;
    if let Some(parent) = Path::new(&result.path).parent() {
        store.settings.last_export_dir = parent.to_string_lossy().to_string();
        let _ = store.save_settings();
    }
    let _ = store.push_recent_export(RecentExport {
        path: result.path.clone(),
        format: result.format.clone(),
        bytes: result.bytes,
        at: result.exported_at,
    });
    Ok(result)
}

#[tauri::command]
pub fn list_recent_exports(state: State<'_, AppState>) -> Result<Vec<RecentExport>, String> {
    let store = lock(&state)?;
    store.read_recent_exports()
}

// ---------------------------------------------------------------------------
// 回收站
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 系统字体枚举
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_fonts() -> Vec<FontEntry> {
    crate::fonts::scan_system_fonts()
}

// ---------------------------------------------------------------------------
// 打开资源管理器 / 诊断日志 / 自检
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    let target = if p.exists() {
        p.to_path_buf()
    } else if let Some(parent) = p.parent() {
        parent.to_path_buf()
    } else {
        return Err("路径不存在".into());
    };
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = target;
        return Err("当前平台不支持打开文件管理器".into());
    }
    Ok(())
}

#[tauri::command]
pub fn ui_ready(state: State<'_, AppState>) -> Result<String, String> {
    let store = lock(&state)?;
    let _ = append_ui_log(&store.root, "UI_READY");
    Ok(store.root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn ui_log(state: State<'_, AppState>, message: String) -> Result<(), String> {
    let store = lock(&state)?;
    append_ui_log(&store.root, &message)
}

#[tauri::command]
pub fn run_self_check(state: State<'_, AppState>) -> Result<SelfCheckReport, String> {
    let store = lock(&state)?;
    let (passed, failed) = text::self_check();
    let sample = text::format_probe(
        "第一章 山门\n\n他站在风里。\n\n\n  没有回头。  \n",
        FormatRule::CjkIndent,
    );
    Ok(SelfCheckReport {
        passed,
        failed,
        data_dir: store.root.to_string_lossy().to_string(),
        sample_format: sample,
    })
}

/// 在应用内直接跑完整端到端冒烟测试（使用独立临时目录，不动用户数据）。
#[tauri::command]
pub fn run_smoke_in_app() -> Result<String, String> {
    let tmp = std::env::temp_dir().join(format!("heartwrite-smoke-{}", text::now_ms()));
    let res = crate::smoke::run_smoke_at(&tmp);
    let _ = fs::remove_dir_all(&tmp);
    res
}

pub fn append_ui_log(root: &Path, line: &str) -> Result<(), String> {
    let path = ui_log_path(root);
    if let Some(p) = path.parent() {
        let _ = fs::create_dir_all(p);
    }
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "[{}] {line}", text::format_ms(text::now_ms())).map_err(|e| e.to_string())
}

pub fn ui_log_path(root: &Path) -> PathBuf {
    if let Ok(custom) = std::env::var("NOVEL_MANAGER_UI_LOG") {
        if !custom.trim().is_empty() {
            return PathBuf::from(custom);
        }
    }
    root.join("ui.log")
}

/// 启动参数或环境变量里是否显式锁死了数据目录。
pub fn forced_data_dir() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("NOVEL_MANAGER_DATA_DIR") {
        if !custom.trim().is_empty() {
            return Some(PathBuf::from(custom));
        }
    }
    None
}

/// 当前运行环境是否锁定稿件目录（包含 `--data-dir` 显式指定，以及无原生选择器的移动端沙盒）。
pub fn is_location_locked() -> bool {
    forced_data_dir().is_some() || !dialog::FileFilter::has_native_pickers()
}

/// 放 `storage-location.json` 的固定配置目录（不跟着稿件搬家）。
pub fn config_dir_for_app(app: &tauri::AppHandle) -> PathBuf {
    if let Some(dir) = forced_data_dir() {
        return dir;
    }
    app.path()
        .app_config_dir()
        .ok()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(storage::default_config_dir)
}

/// 当前宿主环境下的默认稿件目录：
/// - 优先读取 Tauri `app.path().app_data_dir()`（Android 上为应用私有可写目录，避免落到 `/` 只读根目录）；
/// - 移动端自动放入 `manuscripts` 子目录，与 WebView 缓存隔离；
/// - 拿不到宿主目录时退回 `storage::default_data_dir()`。
pub fn default_data_dir_for_app(app: &tauri::AppHandle) -> PathBuf {
    let isolate_subdir = !dialog::FileFilter::has_native_pickers();
    storage::resolve_app_data_dir(app.path().app_data_dir().ok(), isolate_subdir)
}

/// 决定这次启动该把稿件放在哪儿：
/// 1. `--data-dir` / `NOVEL_MANAGER_DATA_DIR` 显式指定 → 直接用；
/// 2. 桌面端指针文件里记着用户上次选的目录，且该目录可写 → 用它；
/// 3. 其余情况（首次启动、移动端沙盒、或记住的盘符/目录不可用）→ 用宿主默认数据目录。
pub fn storage_dir_for_app(app: &tauri::AppHandle) -> PathBuf {
    if let Some(dir) = forced_data_dir() {
        return dir;
    }
    if dialog::FileFilter::has_native_pickers() {
        let config = config_dir_for_app(app);
        if let Some(rec) = storage::read_location_record(&config) {
            let p = PathBuf::from(&rec.dir);
            if storage::is_dir_writable(&p) {
                return p;
            }
        }
    }
    default_data_dir_for_app(app)
}

/// 是否处于开发截图验收模式（`NOVEL_MANAGER_SELFTEST=1`）。
pub fn is_selftest() -> bool {
    std::env::var("NOVEL_MANAGER_SELFTEST")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// 是否处于界面自动化验收模式（`NOVEL_MANAGER_UITEST=1`）。
pub fn is_uitest() -> bool {
    std::env::var("NOVEL_MANAGER_UITEST")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// 返回主窗口的外部/内部物理尺寸与缩放比，用于诊断 DPI 与布局。
#[tauri::command]
pub fn window_diag(window: tauri::Window) -> Result<String, String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let inner = window.inner_size().map_err(|e| e.to_string())?;
    let outer = window.outer_size().map_err(|e| e.to_string())?;
    let pos = window
        .outer_position()
        .map(|p| format!("{},{}", p.x, p.y))
        .unwrap_or_else(|_| "n/a".into());
    Ok(format!(
        "scale={scale} inner={}x{} outer={}x{} pos={pos}",
        inner.width, inner.height, outer.width, outer.height
    ))
}
