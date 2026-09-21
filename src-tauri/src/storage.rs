//! 本地持久化层：书籍 / 卷 / 章 / 人物剧情灵光卡片 / 历史版本 / 设置。
//!
//! 目录结构（默认位于 `%APPDATA%/com.heartwrite.novelmanager`）：
//! ```text
//! settings.json                 全局设置（字体、主题、自动保存间隔…）
//! books.json                     书籍注册表
//! books/<book_id>/book.json      卷章目录树
//! books/<book_id>/cards.json     人物 / 剧情 / 灵光卡片
//! content/<book_id>/<chapter_id>.json   章节正文 + 历史版本快照
//! ```

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::text::{count_text, now_ms};

pub const APP_DIR: &str = "com.heartwrite.novelmanager";
pub const MAX_HISTORY_HARD_CAP: usize = 200;

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------

fn default_theme() -> String {
    "light".into()
}
fn default_font_family() -> String {
    "霞鹜文楷, 思源宋体, 宋体, Microsoft YaHei, serif".into()
}
fn default_font_size() -> f64 {
    18.0
}
fn default_line_height() -> f64 {
    1.9
}
fn default_letter_spacing() -> f64 {
    0.02
}
fn default_autosave_secs() -> u64 {
    20
}
fn default_history_depth() -> usize {
    30
}
fn default_snapshot_char_delta() -> usize {
    120
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub font_family: String,
    pub font_size: f64,
    pub line_height: f64,
    pub letter_spacing: f64,
    pub autosave_secs: u64,
    pub history_depth: usize,
    /// 与上一版本相比正文变化超过该字数才生成新版本，避免版本爆炸。
    pub snapshot_char_delta: usize,
    pub editor_width: u32,
    pub focus_mode: bool,
    pub typewriter_sound: bool,
    pub daily_goal: u32,
    pub last_book_id: String,
    pub last_chapter_id: String,
    pub last_export_dir: String,
    pub one_click_format_rule: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: default_theme(),
            font_family: default_font_family(),
            font_size: default_font_size(),
            line_height: default_line_height(),
            letter_spacing: default_letter_spacing(),
            autosave_secs: default_autosave_secs(),
            history_depth: default_history_depth(),
            snapshot_char_delta: default_snapshot_char_delta(),
            editor_width: 860,
            focus_mode: false,
            typewriter_sound: false,
            daily_goal: 3000,
            last_book_id: String::new(),
            last_chapter_id: String::new(),
            last_export_dir: String::new(),
            one_click_format_rule: "cjk-indent".into(),
        }
    }
}

impl Settings {
    pub fn normalized(mut self) -> Self {
        self.history_depth = self.history_depth.clamp(1, MAX_HISTORY_HARD_CAP);
        self.autosave_secs = self.autosave_secs.clamp(5, 3600);
        self.font_size = self.font_size.clamp(12.0, 42.0);
        self.line_height = self.line_height.clamp(1.2, 3.0);
        self.letter_spacing = self.letter_spacing.clamp(-0.05, 0.30);
        self.editor_width = self.editor_width.clamp(520, 1600);
        if self.font_family.trim().is_empty() {
            self.font_family = default_font_family();
        }
        self
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Registry {
    pub books: Vec<BookMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BookMeta {
    pub id: String,
    pub title: String,
    pub author: String,
    pub genre: String,
    pub summary: String,
    pub cover_color: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub volumes: Vec<Volume>,
    pub settings: Settings,
}

impl Default for BookMeta {
    fn default() -> Self {
        let t = now_ms();
        Self {
            id: String::new(),
            title: "未命名作品".into(),
            author: String::new(),
            genre: String::new(),
            summary: String::new(),
            cover_color: "#7c6bd6".into(),
            created_at: t,
            updated_at: t,
            volumes: Vec::new(),
            settings: Settings::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Volume {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub expanded: bool,
    pub created_at: i64,
    pub chapters: Vec<Chapter>,
}

impl Default for Volume {
    fn default() -> Self {
        Self {
            id: String::new(),
            title: String::new(),
            summary: String::new(),
            expanded: true,
            created_at: now_ms(),
            chapters: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Chapter {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub status: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub char_count: usize,
    pub versions: usize,
}

impl Default for Chapter {
    fn default() -> Self {
        let t = now_ms();
        Self {
            id: String::new(),
            title: String::new(),
            summary: String::new(),
            status: "draft".into(),
            created_at: t,
            updated_at: t,
            char_count: 0,
            versions: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Card {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub color: String,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
    /// 人物卡专用：身份 / 阵营 / 外貌 / 目标等自由字段。
    pub fields: BTreeMap<String, String>,
}

impl Default for Card {
    fn default() -> Self {
        let t = now_ms();
        Self {
            id: String::new(),
            kind: "character".into(),
            title: String::new(),
            content: String::new(),
            tags: Vec::new(),
            color: "#8ab4f8".into(),
            pinned: false,
            created_at: t,
            updated_at: t,
            fields: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    pub id: String,
    pub created_at: i64,
    /// auto | manual | restore | import
    pub kind: String,
    pub label: String,
    pub chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub created_at: i64,
    pub kind: String,
    pub label: String,
    pub chars: usize,
    pub content: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChapterContent {
    pub chapter_id: String,
    pub content: String,
    pub updated_at: i64,
    #[serde(default)]
    pub versions: Vec<Version>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub chapter_id: String,
    pub char_count: usize,
    pub words: usize,
    pub cjk: usize,
    pub chars_with_space: usize,
    pub created_version: bool,
    pub version_id: String,
    pub versions: usize,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookStats {
    pub char_count: usize,
    pub words: usize,
    pub cjk: usize,
    pub chapters: usize,
    pub volumes: usize,
    pub cards: usize,
    pub versions: usize,
    pub today_chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookPayload {
    pub book: BookMeta,
    pub cards: Vec<Card>,
    pub storage_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub settings: Settings,
    pub registry: Registry,
    pub storage_dir: String,
    pub storage_bytes: u64,
    pub card_kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub deleted_at: i64,
}

// ---------------------------------------------------------------------------
// 存储引擎
// ---------------------------------------------------------------------------

pub struct Store {
    pub root: PathBuf,
    pub content_dir: PathBuf,
    pub registry: Registry,
    pub settings: Settings,
    pub save_count: u64,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let raw = fs::read_to_string(path).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    serde_json::from_str(&raw).ok()
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body.as_bytes()).map_err(|e| format!("写入失败 {}: {e}", tmp.display()))?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| format!("替换文件失败 {}: {e}", path.display()))?;
    Ok(())
}

fn dir_size(path: &Path) -> u64 {
    walkdir::WalkDir::new(path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

pub fn sanitize_filename(name: &str, fallback: &str) -> String {
    let mut out = String::new();
    for ch in name.chars() {
        if matches!(ch, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\n' | '\r' | '\t') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let trimmed = out.trim().trim_end_matches('.').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

pub fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("NOVEL_MANAGER_DATA_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .ok()
        .filter(|p| p.is_dir())
        .or_else(|| std::env::var("HOME").map(PathBuf::from).ok())
        .unwrap_or_else(|| PathBuf::from("."));
    base.join(APP_DIR)
}

impl Store {
    pub fn load(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(|e| format!("无法创建数据目录 {}: {e}", root.display()))?;
        let content_dir = root.join("content");
        fs::create_dir_all(&content_dir).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("books")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("exports")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("trash")).map_err(|e| e.to_string())?;

        let mut settings: Settings = read_json(&root.join("settings.json")).unwrap_or_default();
        settings = settings.normalized();
        let registry: Registry = read_json(&root.join("books.json")).unwrap_or_default();

        let mut store = Store {
            root,
            content_dir,
            registry,
            settings,
            save_count: 0,
        };
        if let Some(first) = store.registry.books.first().map(|b| b.id.clone()) {
            if store.settings.last_book_id.is_empty() {
                store.settings.last_book_id = first;
            }
        }
        store.save_settings()?;
        // 老数据的章节状态迁移到新状态集
        let migrated = store.migrate_statuses()?;
        if migrated > 0 {
            eprintln!("[写心] 已迁移 {migrated} 个章节状态到新状态集");
        }
        Ok(store)
    }

    // -- 通用 ---------------------------------------------------------------

    pub fn book_path(&self, id: &str) -> PathBuf {
        self.root.join("books").join(id).join("book.json")
    }
    pub fn cards_path(&self, id: &str) -> PathBuf {
        self.root.join("books").join(id).join("cards.json")
    }
    pub fn chapter_path(&self, book_id: &str, chapter_id: &str) -> PathBuf {
        self.content_dir.join(book_id).join(format!("{chapter_id}.json"))
    }

    pub fn save_settings(&self) -> Result<(), String> {
        write_json_atomic(&self.root.join("settings.json"), &self.settings)
    }

    pub fn save_registry(&self) -> Result<(), String> {
        write_json_atomic(&self.root.join("books.json"), &self.registry)
    }

    pub fn save_book(&self, book: &BookMeta) -> Result<(), String> {
        let mut book = book.clone();
        book.settings = book.settings.clone().normalized();
        write_json_atomic(&self.book_path(&book.id), &book)
    }

    pub fn book(&self, id: &str) -> Result<BookMeta, String> {
        read_json(&self.book_path(id)).ok_or_else(|| format!("找不到书籍 {id}"))
    }

    pub fn book_mut<'a>(&'a mut self, id: &str) -> Result<&'a mut BookMeta, String> {
        self.registry
            .books
            .iter_mut()
            .find(|b| b.id == id)
            .ok_or_else(|| format!("找不到书籍 {id}"))
    }

    pub fn require_book(&self, id: &str) -> Result<&BookMeta, String> {
        self.registry
            .books
            .iter()
            .find(|b| b.id == id)
            .ok_or_else(|| format!("找不到书籍 {id}"))
    }

    /// 卷 / 章结构改动后统一落盘：内存注册表、book.json、books.json 三者保持一致。
    fn persist_structure(&mut self, book_id: &str, book: BookMeta) -> Result<(), String> {
        if let Some(slot) = self.registry.books.iter_mut().find(|b| b.id == book_id) {
            *slot = book.clone();
        }
        self.save_book(&book)?;
        self.save_registry()
    }

    /// 旧版本用过的章节状态，迁移到新的状态集（草稿/初稿/修订中/已定稿/待发布/已发布/待返修）。
    pub fn migrate_statuses(&mut self) -> Result<usize, String> {
        let mut migrated = 0usize;
        let mut changed_books: Vec<BookMeta> = Vec::new();
        for book in self.registry.books.iter_mut() {
            let mut touched = false;
            for vol in book.volumes.iter_mut() {
                for ch in vol.chapters.iter_mut() {
                    let mapped = match ch.status.as_str() {
                        "done" | "locked" | "complete" | "completed" => Some("final"),
                        "drafting" | "" => Some("draft"),
                        "edit" | "editing" | "revision" => Some("revising"),
                        _ => None,
                    };
                    if let Some(new_status) = mapped {
                        if ch.status != new_status {
                            ch.status = new_status.to_string();
                            migrated += 1;
                            touched = true;
                        }
                    }
                }
            }
            if touched {
                changed_books.push(book.clone());
            }
        }
        for book in &changed_books {
            self.save_book(book)?;
        }
        if !changed_books.is_empty() {
            self.save_registry()?;
        }
        Ok(migrated)
    }

    pub fn read_content(&self, book_id: &str, chapter_id: &str) -> ChapterContent {
        let path = self.chapter_path(book_id, chapter_id);
        let mut c: ChapterContent = read_json(&path).unwrap_or_default();
        if c.chapter_id.is_empty() {
            c.chapter_id = chapter_id.to_string();
        }
        c
    }

    pub fn write_content(&self, book_id: &str, c: &ChapterContent) -> Result<(), String> {
        write_json_atomic(&self.chapter_path(book_id, &c.chapter_id), c)
    }

    pub fn read_cards(&self, book_id: &str) -> Vec<Card> {
        read_json(&self.cards_path(book_id)).unwrap_or_default()
    }

    // -- 书籍 ---------------------------------------------------------------

    pub fn create_book(&mut self, title: &str, author: &str, genre: &str) -> Result<BookMeta, String> {
        let mut book = BookMeta {
            id: uuid::Uuid::new_v4().to_string(),
            title: if title.trim().is_empty() { "未命名作品".into() } else { title.trim().into() },
            author: author.to_string(),
            genre: genre.to_string(),
            ..Default::default()
        };
        book.settings = self.settings.clone();
        let vol_id = uuid::Uuid::new_v4().to_string();
        let ch_id = uuid::Uuid::new_v4().to_string();
        book.volumes.push(Volume {
            id: vol_id,
            title: "第一卷".into(),
            expanded: true,
            chapters: vec![Chapter {
                id: ch_id,
                title: "第一章".into(),
                ..Default::default()
            }],
            ..Default::default()
        });
        self.registry.books.push(book.clone());
        self.save_book(&book)?;
        self.save_registry()?;
        Ok(book)
    }

    pub fn touch_book(&mut self, book_id: &str) -> Result<(), String> {
        let now = now_ms();
        let snapshot = {
            let book = self.book_mut(book_id)?;
            book.updated_at = now;
            book.clone()
        };
        self.persist_structure(book_id, snapshot)
    }

    pub fn delete_book(&mut self, book_id: &str) -> Result<(), String> {
        self.registry.books.retain(|b| b.id != book_id);
        self.move_to_trash(&format!("books/{book_id}"));
        self.move_to_trash(&format!("content/{book_id}"));
        self.save_registry()?;
        if self.settings.last_book_id == book_id {
            self.settings.last_book_id.clear();
            self.save_settings()?;
        }
        Ok(())
    }

    fn move_to_trash(&self, relative: &str) -> Option<PathBuf> {
        let src = self.root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
        if !src.exists() {
            return None;
        }
        let name = relative.replace('/', "_");
        let dst = self.root.join("trash").join(format!("{}_{}", now_ms(), name));
        fs::rename(&src, &dst).ok().map(|_| dst)
    }

    pub fn list_trash(&self) -> Vec<TrashEntry> {
        let dir = self.root.join("trash");
        let mut out = Vec::new();
        if let Ok(rd) = fs::read_dir(&dir) {
            for entry in rd.filter_map(|e| e.ok()) {
                let meta = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let size = if meta.is_dir() { dir_size(&entry.path()) } else { meta.len() };
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0);
                out.push(TrashEntry {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: entry.path().to_string_lossy().to_string(),
                    size,
                    deleted_at: modified,
                });
            }
        }
        out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
        out
    }

    pub fn empty_trash(&self) -> Result<usize, String> {
        let dir = self.root.join("trash");
        let mut n = 0;
        if let Ok(rd) = fs::read_dir(&dir) {
            for entry in rd.filter_map(|e| e.ok()) {
                let p = entry.path();
                let ok = if p.is_dir() {
                    fs::remove_dir_all(&p).is_ok()
                } else {
                    fs::remove_file(&p).is_ok()
                };
                if ok {
                    n += 1;
                }
            }
        }
        Ok(n)
    }

    /// 导入纯文本，按“第X章”等标题切分后追加到指定卷。
    pub fn import_text(
        &mut self,
        book_id: &str,
        volume_id: &str,
        text: &str,
        prefix: &str,
    ) -> Result<usize, String> {
        let chapters = crate::text::split_into_chapters(text, prefix);
        if chapters.is_empty() {
            return Err("没有可导入的内容".into());
        }
        let target_volume = {
            let book = self.book_mut(book_id)?;
            if volume_id.is_empty() {
                book.volumes.first().map(|v| v.id.clone())
            } else {
                Some(volume_id.to_string())
            }
        }
        .ok_or_else(|| "目标卷不存在".to_string())?;

        let mut created = Vec::new();
        for (title, body) in chapters {
            // 先建章节拿到真实 id，再把正文写进对应文件
            let chapter = self.add_chapter(book_id, &target_volume, &title)?;
            let chars = count_text(&body).total;
            let now = now_ms();
            let stored = ChapterContent {
                chapter_id: chapter.id.clone(),
                content: body.clone(),
                updated_at: now,
                versions: vec![Version {
                    id: uuid::Uuid::new_v4().to_string(),
                    created_at: now,
                    kind: "import".into(),
                    label: "导入初始版本".into(),
                    chars,
                    content: body,
                }],
            };
            self.write_content(book_id, &stored)?;

            let snapshot = {
                let book = self.book_mut(book_id)?;
                for vol in book.volumes.iter_mut() {
                    if let Some(ch) = vol.chapters.iter_mut().find(|c| c.id == chapter.id) {
                        ch.char_count = chars;
                        ch.versions = 1;
                    }
                }
                book.updated_at = now;
                book.clone()
            };
            self.persist_structure(book_id, snapshot)?;
            created.push(chapter.id);
        }
        Ok(created.len())
    }

    // -- 统计 ---------------------------------------------------------------

    pub fn book_stats(&self, book: &BookMeta) -> BookStats {
        let mut stats = BookStats {
            char_count: 0,
            words: 0,
            cjk: 0,
            chapters: 0,
            volumes: book.volumes.len(),
            cards: self.read_cards(&book.id).len(),
            versions: 0,
            today_chars: 0,
        };
        let today = crate::text::today_start_ms();
        for vol in &book.volumes {
            for ch in &vol.chapters {
                stats.chapters += 1;
                stats.char_count += ch.char_count;
                stats.versions += ch.versions;
                let content = self.read_content(&book.id, &ch.id);
                let c = count_text(&content.content);
                stats.words += c.words;
                stats.cjk += c.cjk;
                if content.updated_at >= today {
                    stats.today_chars += c.total;
                }
            }
        }
        stats
    }

    pub fn storage_bytes(&self) -> u64 {
        dir_size(&self.root)
    }

    // -- 最近导出记录 --------------------------------------------------------

    pub fn read_recent_exports(&self) -> Vec<crate::export::RecentExport> {
        read_json(&self.root.join("recent-exports.json")).unwrap_or_default()
    }

    pub fn push_recent_export(
        &self,
        item: crate::export::RecentExport,
    ) -> Result<Vec<crate::export::RecentExport>, String> {
        let mut list = self.read_recent_exports();
        list.retain(|r| r.path != item.path);
        list.insert(0, item);
        list.truncate(20);
        write_json_atomic(&self.root.join("recent-exports.json"), &list)?;
        Ok(list)
    }

    // -- 章节保存 / 历史版本 -------------------------------------------------

    #[allow(clippy::too_many_arguments)]
    pub fn save_chapter(
        &mut self,
        book_id: &str,
        chapter_id: &str,
        content: &str,
        title: Option<String>,
        summary: Option<String>,
        status: Option<String>,
        force_version: bool,
        version_label: &str,
        version_kind: &str,
    ) -> Result<SaveResult, String> {
        let now = now_ms();
        let count = count_text(content);
        let mut stored = self.read_content(book_id, chapter_id);
        let previous = stored.content.clone();
        let previous_chars = count_text(&previous).total;
        let changed = previous != content;

        stored.content = content.to_string();
        stored.updated_at = now;

        let depth = self.settings.history_depth.clamp(1, MAX_HISTORY_HARD_CAP);
        let delta = self.settings.snapshot_char_delta;
        let big_enough = previous_chars.abs_diff(count.total) >= delta;
        let has_versions = !stored.versions.is_empty();

        let mut created = false;
        let mut version_id = String::new();
        if changed && (force_version || big_enough || !has_versions) {
            let kind = if version_kind.is_empty() { "auto" } else { version_kind };
            let label = if version_label.is_empty() {
                match kind {
                    "manual" => "手动快照".to_string(),
                    "restore" => "回滚前存档".to_string(),
                    "import" => "导入初始版本".to_string(),
                    _ => "自动存档".to_string(),
                }
            } else {
                version_label.to_string()
            };
            let v = Version {
                id: uuid::Uuid::new_v4().to_string(),
                created_at: now,
                kind: kind.to_string(),
                label,
                chars: previous_chars,
                content: previous,
            };
            version_id = v.id.clone();
            stored.versions.insert(0, v);
            created = true;
        }
        while stored.versions.len() > depth {
            stored.versions.pop();
        }
        let version_count = stored.versions.len();
        self.write_content(book_id, &stored)?;

        // 更新目录树
        let snapshot = {
            let book = self.book_mut(book_id)?;
            let mut found = false;
            for vol in book.volumes.iter_mut() {
                if let Some(ch) = vol.chapters.iter_mut().find(|c| c.id == chapter_id) {
                    ch.char_count = count.total;
                    ch.updated_at = now;
                    ch.versions = version_count;
                    if let Some(t) = title.as_ref() {
                        if !t.trim().is_empty() {
                            ch.title = t.trim().to_string();
                        }
                    }
                    if let Some(s) = summary.as_ref() {
                        ch.summary = s.clone();
                    }
                    if let Some(s) = status.as_ref() {
                        if !s.is_empty() {
                            ch.status = s.clone();
                        }
                    }
                    found = true;
                    break;
                }
            }
            if !found {
                return Err(format!("找不到章节 {chapter_id}"));
            }
            book.updated_at = now;
            book.clone()
        };
        self.save_count += 1;
        self.persist_structure(book_id, snapshot)?;

        Ok(SaveResult {
            chapter_id: chapter_id.to_string(),
            char_count: count.total,
            words: count.words,
            cjk: count.cjk,
            chars_with_space: count.chars_with_space,
            created_version: created,
            version_id,
            versions: version_count,
            updated_at: now,
        })
    }

    pub fn list_versions(&self, book_id: &str, chapter_id: &str) -> Vec<VersionMeta> {
        self.read_content(book_id, chapter_id)
            .versions
            .into_iter()
            .map(|v| VersionMeta {
                id: v.id,
                created_at: v.created_at,
                kind: v.kind,
                label: v.label,
                chars: v.chars,
            })
            .collect()
    }

    pub fn version_content(&self, book_id: &str, chapter_id: &str, version_id: &str) -> Option<Version> {
        self.read_content(book_id, chapter_id)
            .versions
            .into_iter()
            .find(|v| v.id == version_id)
    }

    pub fn restore_version(
        &mut self,
        book_id: &str,
        chapter_id: &str,
        version_id: &str,
    ) -> Result<SaveResult, String> {
        let target = self
            .version_content(book_id, chapter_id, version_id)
            .ok_or_else(|| "找不到该历史版本".to_string())?;
        self.save_chapter(
            book_id,
            chapter_id,
            &target.content,
            None,
            None,
            None,
            true,
            "回滚前存档",
            "restore",
        )
    }

    pub fn delete_version(&self, book_id: &str, chapter_id: &str, version_id: &str) -> Result<usize, String> {
        let mut stored = self.read_content(book_id, chapter_id);
        stored.versions.retain(|v| v.id != version_id);
        let n = stored.versions.len();
        self.write_content(book_id, &stored)?;
        Ok(n)
    }

    // -- 卡片 ---------------------------------------------------------------

    pub fn save_cards(&self, book_id: &str, cards: &[Card]) -> Result<(), String> {
        write_json_atomic(&self.cards_path(book_id), &cards.to_vec())
    }

    pub fn upsert_card(&self, book_id: &str, mut card: Card) -> Result<Card, String> {
        let mut cards = self.read_cards(book_id);
        let now = now_ms();
        if card.id.is_empty() {
            card.id = uuid::Uuid::new_v4().to_string();
            card.created_at = now;
        } else if !cards.iter().any(|c| c.id == card.id) {
            card.created_at = now;
        }
        card.updated_at = now;
        if card.kind.is_empty() {
            card.kind = "character".into();
        }
        match cards.iter_mut().find(|c| c.id == card.id) {
            Some(slot) => *slot = card.clone(),
            None => cards.push(card.clone()),
        }
        self.save_cards(book_id, &cards)?;
        Ok(card)
    }

    pub fn delete_card(&self, book_id: &str, card_id: &str) -> Result<(), String> {
        let mut cards = self.read_cards(book_id);
        cards.retain(|c| c.id != card_id);
        self.save_cards(book_id, &cards)
    }

    // -- 卷 / 章结构 ---------------------------------------------------------

    pub fn add_volume(&mut self, book_id: &str, title: &str) -> Result<Volume, String> {
        let snapshot = {
            let book = self.book_mut(book_id)?;
            let idx = book.volumes.len() + 1;
            let vol = Volume {
                id: uuid::Uuid::new_v4().to_string(),
                title: if title.trim().is_empty() {
                    crate::text::volume_title(idx)
                } else {
                    title.trim().to_string()
                },
                expanded: true,
                ..Default::default()
            };
            book.volumes.push(vol.clone());
            (book.clone(), vol)
        };
        self.persist_structure(book_id, snapshot.0)?;
        Ok(snapshot.1)
    }

    pub fn add_chapter(
        &mut self,
        book_id: &str,
        volume_id: &str,
        title: &str,
    ) -> Result<Chapter, String> {
        let (snapshot, chapter) = {
            let book = self.book_mut(book_id)?;
            let vol = book
                .volumes
                .iter_mut()
                .find(|v| v.id == volume_id)
                .ok_or_else(|| "找不到该卷".to_string())?;
            let idx = vol.chapters.len() + 1;
            let chapter = Chapter {
                id: uuid::Uuid::new_v4().to_string(),
                title: if title.trim().is_empty() {
                    crate::text::chapter_title(idx)
                } else {
                    title.trim().to_string()
                },
                ..Default::default()
            };
            vol.chapters.push(chapter.clone());
            (book.clone(), chapter)
        };
        self.persist_structure(book_id, snapshot)?;
        self.write_content(
            book_id,
            &ChapterContent {
                chapter_id: chapter.id.clone(),
                content: String::new(),
                updated_at: now_ms(),
                versions: Vec::new(),
            },
        )?;
        Ok(chapter)
    }

    pub fn delete_chapter(&mut self, book_id: &str, chapter_id: &str) -> Result<(), String> {
        let snapshot = {
            let book = self.book_mut(book_id)?;
            for vol in book.volumes.iter_mut() {
                vol.chapters.retain(|c| c.id != chapter_id);
            }
            book.clone()
        };
        self.persist_structure(book_id, snapshot)?;
        let p = self.chapter_path(book_id, chapter_id);
        if p.exists() {
            let trash = self
                .root
                .join("trash")
                .join(format!("{}_{}_{}.json", now_ms(), book_id, chapter_id));
            let _ = fs::rename(&p, trash);
        }
        Ok(())
    }

    pub fn delete_volume(
        &mut self,
        book_id: &str,
        volume_id: &str,
        delete_chapters: bool,
    ) -> Result<Vec<String>, String> {
        let (snapshot, removed) = {
            let book = self.book_mut(book_id)?;
            let mut removed = Vec::new();
            if let Some(pos) = book.volumes.iter().position(|v| v.id == volume_id) {
                let vol = book.volumes.remove(pos);
                for ch in &vol.chapters {
                    removed.push(ch.id.clone());
                }
            }
            (book.clone(), removed)
        };
        self.persist_structure(book_id, snapshot)?;
        if delete_chapters {
            for cid in &removed {
                let p = self.chapter_path(book_id, cid);
                if p.exists() {
                    let trash = self.root.join("trash").join(format!("{}_{}.json", now_ms(), cid));
                    let _ = fs::rename(&p, trash);
                }
            }
        }
        Ok(removed)
    }

    /// `kind` = volume | chapter；`direction` = up | down。
    /// 章节可跨卷移动：到顶 / 到底后进入相邻卷。
    pub fn move_node(
        &mut self,
        book_id: &str,
        kind: &str,
        id: &str,
        direction: &str,
    ) -> Result<(), String> {
        let up = direction != "down";
        let snapshot = {
            let book = self.book_mut(book_id)?;
            if kind == "volume" {
                let idx = book
                    .volumes
                    .iter()
                    .position(|v| v.id == id)
                    .ok_or_else(|| "找不到该卷".to_string())?;
                if up {
                    if idx > 0 {
                        book.volumes.swap(idx, idx - 1);
                    }
                } else if idx + 1 < book.volumes.len() {
                    book.volumes.swap(idx, idx + 1);
                }
            } else {
                let mut found: Option<(usize, usize)> = None;
                'outer: for (i, vol) in book.volumes.iter().enumerate() {
                    for (j, ch) in vol.chapters.iter().enumerate() {
                        if ch.id == id {
                            found = Some((i, j));
                            break 'outer;
                        }
                    }
                }
                let (vi, ci) = found.ok_or_else(|| "找不到该章节".to_string())?;
                if up {
                    if ci > 0 {
                        book.volumes[vi].chapters.swap(ci, ci - 1);
                    } else if vi > 0 {
                        let ch = book.volumes[vi].chapters.remove(ci);
                        book.volumes[vi - 1].chapters.push(ch);
                    }
                } else if ci + 1 < book.volumes[vi].chapters.len() {
                    book.volumes[vi].chapters.swap(ci, ci + 1);
                } else if vi + 1 < book.volumes.len() {
                    let ch = book.volumes[vi].chapters.remove(ci);
                    book.volumes[vi + 1].chapters.insert(0, ch);
                }
            }
            book.clone()
        };
        self.persist_structure(book_id, snapshot)
    }

    pub fn move_chapter_to(
        &mut self,
        book_id: &str,
        chapter_id: &str,
        target_volume_id: &str,
        position: usize,
    ) -> Result<(), String> {
        let snapshot = {
            let book = self.book_mut(book_id)?;
            let mut taken: Option<Chapter> = None;
            for vol in book.volumes.iter_mut() {
                if let Some(pos) = vol.chapters.iter().position(|c| c.id == chapter_id) {
                    taken = Some(vol.chapters.remove(pos));
                    break;
                }
            }
            let chapter = taken.ok_or_else(|| "找不到该章节".to_string())?;
            let vol = book
                .volumes
                .iter_mut()
                .find(|v| v.id == target_volume_id)
                .ok_or_else(|| "找不到目标卷".to_string())?;
            let pos = position.min(vol.chapters.len());
            vol.chapters.insert(pos, chapter);
            book.clone()
        };
        self.persist_structure(book_id, snapshot)
    }

    pub fn rename_node(
        &mut self,
        book_id: &str,
        kind: &str,
        id: &str,
        title: &str,
        summary: Option<String>,
        status: Option<String>,
    ) -> Result<(), String> {
        let snapshot = {
            let book = self.book_mut(book_id)?;
            if kind == "volume" {
                if let Some(v) = book.volumes.iter_mut().find(|v| v.id == id) {
                    v.title = title.to_string();
                    if let Some(s) = summary.clone() {
                        v.summary = s;
                    }
                }
            } else {
                for vol in book.volumes.iter_mut() {
                    if let Some(ch) = vol.chapters.iter_mut().find(|c| c.id == id) {
                        ch.title = title.to_string();
                        if let Some(s) = summary.clone() {
                            ch.summary = s;
                        }
                        if let Some(s) = status.clone() {
                            ch.status = s;
                        }
                    }
                }
            }
            book.updated_at = now_ms();
            book.clone()
        };
        self.persist_structure(book_id, snapshot)
    }

    pub fn set_volume_expanded(
        &mut self,
        book_id: &str,
        volume_id: &str,
        expanded: bool,
    ) -> Result<(), String> {
        let snapshot = {
            let book = self.book_mut(book_id)?;
            if let Some(v) = book.volumes.iter_mut().find(|v| v.id == volume_id) {
                v.expanded = expanded;
            }
            book.clone()
        };
        self.persist_structure(book_id, snapshot)
    }

    /// 数据体检：核对目录树字数与正文实际字数是否一致。
    pub fn verify_book(&self, book_id: &str) -> Result<Vec<String>, String> {
        let book = self.book(book_id)?;
        let mut fixed = Vec::new();
        for vol in &book.volumes {
            for ch in &vol.chapters {
                let c = self.read_content(book_id, &ch.id);
                let actual = count_text(&c.content).total;
                if actual != ch.char_count {
                    fixed.push(format!("{} 字数 {} -> {}", ch.title, ch.char_count, actual));
                }
                if c.versions.len() != ch.versions {
                    fixed.push(format!("{} 版本数 {} -> {}", ch.title, ch.versions, c.versions.len()));
                }
            }
        }
        Ok(fixed)
    }
}
