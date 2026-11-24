//! Tauri 命令层：把 `storage` / `text` / `export` / `sync` / `ai` 包装成前端可 `invoke` 的统一命令。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

use crate::ai::{
    self, AiChatHistory, AiChatMessage, AiContextPayload, AiRuntime, AiStreamEvent, AiTestResult,
};
use crate::dialog;
use crate::export::{self, ExportOptions, ExportResult, RecentExport};
pub use crate::fonts::FontEntry;
use crate::storage::{
    self, AiProfile, BookMeta, BookStats, Card, ChapterContent, ChapterStatus, Registry,
    SaveResult, SearchHit, Settings, StorageLocationInfo, Store, TrashEntry, Version, VersionMeta,
    WebDavConfig,
};
use crate::sync::lan::{LanHostContext, LanPeerInfo, LanRuntime, LanServerStatus, PingResponse};
use crate::sync::webdav::WebDavTestResult;
use crate::sync::{SyncDirection, SyncReport};
use crate::text::{self, FormatReport, FormatRule, ReplaceReport, TextCount};
use crate::text_decode::decode_text;

pub struct AppState {
    pub store: Arc<Mutex<Store>>,
    /// 放 `storage-location.json` 的固定配置目录（不随稿件搬家）。
    pub config_dir: PathBuf,
    /// 启动时是否由 `--data-dir` / `NOVEL_MANAGER_DATA_DIR` 或移动端沙盒固定了目录。
    pub forced_dir: bool,
    /// 局域网同步运行期管理器
    pub lan: Arc<LanRuntime>,
    /// AI 助手流式请求中止管理器
    pub ai: Arc<AiRuntime>,
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
    /// 当前平台标识（windows / linux / macos / android）
    pub platform: String,
    /// 局域网服务当前状态
    pub lan_status: LanServerStatus,
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

/// 构造局域网同步服务端上下文（可在启动与手动开启时复用）。
pub fn build_lan_context(
    app: tauri::AppHandle,
    store_arc: Arc<Mutex<Store>>,
) -> Result<(u16, Arc<LanHostContext>), String> {
    let (root, device_id, device_name, pin, port) = {
        let store = store_arc.lock().map_err(|_| "存储锁异常".to_string())?;
        let port = if store.settings.lan.port == 0 {
            crate::sync::lan::DEFAULT_LAN_PORT
        } else {
            store.settings.lan.port
        };
        (
            store.root.clone(),
            store.settings.device_id.clone(),
            store.settings.device_name.clone(),
            store.settings.lan.pin.clone(),
            port,
        )
    };

    let root_for_commit = root.clone();
    let store_for_commit = store_arc.clone();
    let app_for_commit = app.clone();
    let store_for_count = store_arc.clone();

    let ctx = Arc::new(LanHostContext {
        root,
        device_id,
        device_name,
        pin,
        on_commit: Arc::new(move || {
            let fresh = crate::sync::rebuild_registry_from_disk(&root_for_commit)?;
            if let Ok(mut guard) = store_for_commit.lock() {
                *guard = fresh;
            }
            let _ = app_for_commit.emit("sync:remote-updated", serde_json::json!({ "source": "lan" }));
            Ok(())
        }),
        book_count: Arc::new(move || {
            store_for_count
                .lock()
                .map(|s| s.registry.books.len())
                .unwrap_or(0)
        }),
    });
    Ok((port, ctx))
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
        platform: crate::sync::current_platform().to_string(),
        lan_status: state.lan.status(),
    })
}

#[tauri::command]
pub fn storage_location(state: State<'_, AppState>) -> Result<StorageLocationInfo, String> {
    let store = lock(&state)?;
    Ok(storage::location_info(&store.root, &state.config_dir, state.forced_dir))
}

#[tauri::command]
pub fn set_storage_dir(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    path: String,
    move_data: Option<bool>,
    move_existing: Option<bool>,
) -> Result<StorageLocationInfo, String> {
    if state.forced_dir {
        return Err("当前使用固定数据目录，不能在界面中更换位置".into());
    }
    let should_move = move_data.or(move_existing).unwrap_or(true);
    let trimmed = path.trim();
    let is_reset = trimmed.is_empty();
    let target = if is_reset {
        default_data_dir_for_app(&app)
    } else {
        PathBuf::from(trimmed)
    };

    let from = {
        let store = lock(&state)?;
        store.root.clone()
    };

    let same_dir = storage::is_same_location(&from, &target);
    let has_recorded = storage::read_location_record(&state.config_dir).is_some();

    if same_dir {
        if should_move && has_recorded && !is_reset {
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

    // 换目录前先停止局域网服务，避免写入旧根路径
    state.lan.stop();

    if should_move {
        storage::move_data_dir(&from, &target)?;
    } else {
        storage::validate_new_location(&from, &target)?;
        fs::create_dir_all(&target).map_err(|e| format!("无法创建目标目录：{e}"))?;
    }

    let fresh = Store::load(target.clone())?;
    let record_val = target.to_string_lossy().to_string();
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
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<Settings, String> {
    let mut store = lock(&state)?;
    let prev_device_id = store.settings.device_id.clone();
    store.settings = settings;
    if store.settings.device_id.trim().is_empty() {
        store.settings.device_id = if prev_device_id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            prev_device_id
        };
    }
    if store.settings.lan.pin.trim().is_empty() {
        store.settings.lan.pin = crate::sync::lan::generate_pin();
    }
    store.settings.history_depth = store.settings.history_depth.clamp(1, storage::MAX_HISTORY_HARD_CAP);
    store.settings.autosave_secs = store.settings.autosave_secs.max(5);
    store.settings.font_size = store.settings.font_size.clamp(12, 36);
    store.settings.line_height = store.settings.line_height.clamp(1.2, 3.0);
    store.settings.editor_width = store.settings.editor_width.clamp(520, 1400);
    store.save_settings()?;
    Ok(store.settings.clone())
}

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
// 封面（支持桌面文件路径 + 移动端 base64 上传）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn book_cover(state: State<'_, AppState>, book_id: String) -> Result<String, String> {
    let store = lock(&state)?;
    Ok(store
        .read_book_cover(&book_id)
        .map(|(ext, bytes)| crate::cover::data_url(&ext, &bytes))
        .unwrap_or_default())
}

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
pub fn set_book_cover_bytes(
    state: State<'_, AppState>,
    book_id: String,
    ext: String,
    base64_data: String,
) -> Result<BookMeta, String> {
    let bytes = crate::cover::base64_decode(&base64_data).ok_or("图片数据解码失败")?;
    let mut store = lock(&state)?;
    store.set_book_cover_bytes(&book_id, &ext, &bytes)
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
pub fn add_volume(state: State<'_, AppState>, book_id: String, title: String) -> Result<BookMeta, String> {
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
    let mut store = lock(&state)?;
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

#[tauri::command]
pub fn search_book(
    state: State<'_, AppState>,
    book_id: String,
    needle: Option<String>,
    keyword: Option<String>,
    max_per_chapter: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let kw = needle.or(keyword).unwrap_or_default();
    let store = lock(&state)?;
    store.search_book(&book_id, &kw, max_per_chapter.unwrap_or(50))
}

#[tauri::command]
pub fn count(text: String) -> TextCount {
    text::count_text(&text)
}

#[tauri::command]
pub fn one_click_format(
    text: String,
    rule: String,
    chapter_title: Option<String>,
    ensure_title: bool,
) -> FormatReport {
    text::smart_format_report(&text, FormatRule::parse(&rule), chapter_title.as_deref(), ensure_title)
}

#[tauri::command]
pub fn replace_all(
    text: String,
    needle: String,
    replacement: String,
    case_sensitive: bool,
) -> (String, ReplaceReport) {
    text::replace_all(&text, &needle, &replacement, case_sensitive)
}

// ---------------------------------------------------------------------------
// 导入 / 导出
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn import_text(
    state: State<'_, AppState>,
    book_id: String,
    volume_id: String,
    source_path: Option<String>,
    text: Option<String>,
    prefix: Option<String>,
) -> Result<BookMeta, String> {
    let body = if let Some(p) = source_path.filter(|s| !s.trim().is_empty()) {
        let bytes = fs::read(&p).map_err(|e| format!("读取文件失败: {e}"))?;
        decode_text(&bytes)
    } else {
        text.unwrap_or_default()
    };
    let mut store = lock(&state)?;
    let _ = store.import_text(&book_id, &volume_id, &body, &prefix.unwrap_or_default())?;
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

fn import_backup_raw(store: &mut Store, raw: &str, as_new_book: bool) -> Result<BookMeta, String> {
    let val: serde_json::Value = serde_json::from_str(raw).map_err(|e| format!("备份格式错误: {e}"))?;
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

    if as_new_book || store.registry.books.iter().any(|b| b.id == book.id) {
        book.id = uuid::Uuid::new_v4().to_string();
        book.title = format!("{}（导入）", book.title);
    }
    fs::create_dir_all(store.book_dir(&book.id)).map_err(|e| e.to_string())?;
    fs::create_dir_all(store.content_dir(&book.id)).map_err(|e| e.to_string())?;
    match backup_cover {
        Some((ext, bytes)) if store.write_book_cover_file(&book.id, &ext, &bytes).is_ok() => {
            book.cover_image = format!("cover.{ext}");
        }
        _ => book.cover_image.clear(),
    }
    store.save_cards(&book.id, &cards)?;
    for c in chapters {
        let ver_count = c.versions.len();
        let char_count = text::count_text(&c.content).total;
        for vol in book.volumes.iter_mut() {
            if let Some(meta) = vol.chapters.iter_mut().find(|ch| ch.id == c.id) {
                meta.versions = ver_count;
                meta.char_count = char_count;
            }
        }
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
pub fn import_backup(
    state: State<'_, AppState>,
    source_path: Option<String>,
    raw_json: Option<String>,
    as_new_book: bool,
) -> Result<BookMeta, String> {
    let raw = if let Some(json) = raw_json.filter(|s| !s.trim().is_empty()) {
        json
    } else if let Some(path) = source_path.filter(|s| !s.trim().is_empty()) {
        fs::read_to_string(&path).map_err(|e| format!("读取备份失败: {e}"))?
    } else {
        return Err("请提供备份文件或 JSON 内容".into());
    };
    let mut store = lock(&state)?;
    import_backup_raw(&mut store, &raw, as_new_book)
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
pub fn pick_save_path(default_name: String, ext: String) -> Option<String> {
    export::pick_save_path(&default_name, &ext)
}

#[tauri::command]
pub fn pick_directory(title: Option<String>) -> Option<String> {
    export::pick_directory(&title.unwrap_or_else(|| "选择导出目录".into()))
}

#[tauri::command]
pub fn pick_open_file(kind: Option<String>) -> Option<String> {
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
// 局域网同步（LAN Sync）
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn lan_status(state: State<'_, AppState>) -> LanServerStatus {
    state.lan.status()
}

#[tauri::command]
pub async fn lan_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    port: Option<u16>,
    pin: Option<String>,
    device_name: Option<String>,
) -> Result<LanServerStatus, String> {
    {
        let mut store = lock(&state)?;
        if let Some(p) = port.filter(|&v| v > 0) {
            store.settings.lan.port = p;
        }
        if let Some(code) = pin.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            store.settings.lan.pin = code;
        }
        if let Some(name) = device_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            store.settings.device_name = name;
        }
        store.settings.lan.server_enabled = true;
        store.save_settings()?;
    }
    let (bind_port, ctx) = build_lan_context(app, state.store.clone())?;
    state.lan.start(bind_port, ctx).await
}

#[tauri::command]
pub fn lan_stop(state: State<'_, AppState>) -> Result<LanServerStatus, String> {
    state.lan.stop();
    if let Ok(mut store) = lock(&state) {
        store.settings.lan.server_enabled = false;
        let _ = store.save_settings();
    }
    Ok(state.lan.status())
}

#[tauri::command]
pub async fn lan_regenerate_pin(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<LanServerStatus, String> {
    let was_running = state.lan.status().running;
    let new_pin = crate::sync::lan::generate_pin();
    {
        let mut store = lock(&state)?;
        store.settings.lan.pin = new_pin.clone();
        store.save_settings()?;
    }
    if was_running {
        let (bind_port, ctx) = build_lan_context(app, state.store.clone())?;
        return state.lan.start(bind_port, ctx).await;
    }
    let mut st = state.lan.status();
    st.pin = new_pin;
    Ok(st)
}

#[tauri::command]
pub async fn lan_scan_peers(state: State<'_, AppState>) -> Result<Vec<LanPeerInfo>, String> {
    let self_id = lock(&state)?.settings.device_id.clone();
    Ok(state.lan.scan_peers(&self_id).await)
}

#[tauri::command]
pub async fn lan_ping_peer(url: String) -> Result<PingResponse, String> {
    crate::sync::lan::ping_lan_peer(&url).await
}

#[tauri::command]
pub async fn lan_sync_peer(
    state: State<'_, AppState>,
    url: String,
    pin: String,
    direction: Option<String>,
) -> Result<SyncReport, String> {
    let (root, device_id, device_name) = {
        let store = lock(&state)?;
        (
            store.root.clone(),
            store.settings.device_id.clone(),
            store.settings.device_name.clone(),
        )
    };
    let dir = SyncDirection::parse(direction.as_deref().unwrap_or("bidirectional"));
    let (report, mut fresh_store) =
        crate::sync::lan::sync_with_lan_peer(&root, &device_id, &device_name, &url, &pin, dir).await?;
    fresh_store.settings.lan.last_peer_url = url;
    fresh_store.settings.lan.last_peer_pin = pin;
    fresh_store.settings.lan.last_sync_at = report.finished_at;
    let _ = fresh_store.save_settings();
    let mut guard = lock(&state)?;
    *guard = fresh_store;
    Ok(report)
}

// ---------------------------------------------------------------------------
// WebDAV 云同步
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn webdav_test(config: WebDavConfig) -> Result<WebDavTestResult, String> {
    crate::sync::webdav::test_webdav_connection(&config).await
}

#[tauri::command]
pub async fn webdav_sync(
    state: State<'_, AppState>,
    config: Option<WebDavConfig>,
    direction: Option<String>,
) -> Result<SyncReport, String> {
    let (root, device_id, device_name, cfg) = {
        let mut store = lock(&state)?;
        if let Some(c) = config {
            store.settings.webdav = c;
            store.save_settings()?;
        }
        (
            store.root.clone(),
            store.settings.device_id.clone(),
            store.settings.device_name.clone(),
            store.settings.webdav.clone(),
        )
    };
    let dir = SyncDirection::parse(direction.as_deref().unwrap_or("bidirectional"));
    let (report, mut fresh_store) =
        crate::sync::webdav::sync_with_webdav(&root, &device_id, &device_name, &cfg, dir).await?;
    fresh_store.settings.webdav.last_sync_at = report.finished_at;
    let _ = fresh_store.save_settings();
    let mut guard = lock(&state)?;
    *guard = fresh_store;
    Ok(report)
}

// ---------------------------------------------------------------------------
// AI 创作助手
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_chat_stream(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    messages: Vec<AiChatMessage>,
    context: AiContextPayload,
    profile: Option<AiProfile>,
) -> Result<String, String> {
    let resolved_profile = match profile {
        Some(p) => p,
        None => lock(&state)?.settings.ai.active_profile(),
    };
    let cancel_rx = state.ai.register(&request_id);
    let rid = request_id.clone();
    let app_for_emit = app.clone();

    let result = ai::stream_chat(&resolved_profile, &messages, &context, cancel_rx, |delta, reasoning| {
        let _ = app_for_emit.emit(
            "ai:stream",
            AiStreamEvent {
                request_id: rid.clone(),
                kind: "delta".into(),
                text: delta.to_string(),
                reasoning: reasoning.to_string(),
            },
        );
    })
    .await;

    state.ai.finish(&request_id);

    match result {
        Ok(full) => {
            let _ = app.emit(
                "ai:stream",
                AiStreamEvent {
                    request_id,
                    kind: "done".into(),
                    text: full.clone(),
                    reasoning: String::new(),
                },
            );
            Ok(full)
        }
        Err(e) if e == "__ABORTED__" => {
            let _ = app.emit(
                "ai:stream",
                AiStreamEvent {
                    request_id,
                    kind: "aborted".into(),
                    text: String::new(),
                    reasoning: String::new(),
                },
            );
            Ok(String::new())
        }
        Err(e) => {
            let _ = app.emit(
                "ai:stream",
                AiStreamEvent {
                    request_id,
                    kind: "error".into(),
                    text: e.clone(),
                    reasoning: String::new(),
                },
            );
            Err(e)
        }
    }
}

#[tauri::command]
pub fn ai_cancel(state: State<'_, AppState>, request_id: String) -> bool {
    state.ai.cancel(&request_id)
}

#[tauri::command]
pub async fn ai_list_models(
    provider: String,
    base_url: String,
    api_key: String,
) -> Result<Vec<String>, String> {
    ai::fetch_models(&provider, &base_url, &api_key).await
}

#[tauri::command]
pub async fn ai_test_connection(profile: AiProfile) -> Result<AiTestResult, String> {
    ai::test_connection(&profile).await
}

#[tauri::command]
pub fn ai_load_history(state: State<'_, AppState>, book_id: String) -> Result<AiChatHistory, String> {
    let store = lock(&state)?;
    ai::load_chat_history(&store.root, &book_id)
}

#[tauri::command]
pub fn ai_save_history(
    state: State<'_, AppState>,
    book_id: String,
    messages: Vec<AiChatMessage>,
) -> Result<(), String> {
    let store = lock(&state)?;
    ai::save_chat_history(&store.root, &book_id, messages)
}

// ---------------------------------------------------------------------------
// 回收站 / 字体 / 系统辅助
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

#[tauri::command]
pub fn list_fonts() -> Vec<FontEntry> {
    crate::fonts::scan_system_fonts()
}

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

#[tauri::command]
pub fn dev_smoke_test() -> Result<String, String> {
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

pub fn forced_data_dir() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("NOVEL_MANAGER_DATA_DIR") {
        if !custom.trim().is_empty() {
            return Some(PathBuf::from(custom));
        }
    }
    None
}

pub fn is_location_locked() -> bool {
    forced_data_dir().is_some() || !dialog::FileFilter::has_native_pickers()
}

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

pub fn default_data_dir_for_app(app: &tauri::AppHandle) -> PathBuf {
    let isolate_subdir = !dialog::FileFilter::has_native_pickers();
    storage::resolve_app_data_dir(app.path().app_data_dir().ok(), isolate_subdir)
}

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

pub fn is_selftest() -> bool {
    std::env::var("NOVEL_MANAGER_SELFTEST")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

pub fn is_uitest() -> bool {
    std::env::var("NOVEL_MANAGER_UITEST")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

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
