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
use std::io::{ErrorKind, Write};
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
    /// 封面图片的文件名（`books/<id>/cover.<ext>`）；空串表示没设过，界面退回纯色 + 图标。
    pub cover_image: String,
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
            cover_image: String::new(),
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
    /// 封面（data URL，可直接放进 <img src>）；没设过是 None。
    pub cover: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceState {
    pub settings: Settings,
    pub registry: Registry,
    pub storage_dir: String,
    pub storage_bytes: u64,
    /// 该平台有没有原生文件选择器（Android 上没有，界面要藏掉"选择封面图片"这类按钮）
    pub has_native_pickers: bool,
    /// 稿件目录的位置信息（首次启动要不要让用户选位置）
    pub location: StorageLocation,
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

/// 全书搜索的一条命中（片段是原样文本，前端负责转义）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub chapter_id: String,
    pub chapter_title: String,
    pub volume_title: String,
    pub count: usize,
    pub head: String,
    pub hit: String,
    pub tail: String,
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

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读取失败 {}: {e}。原文件未修改。", path.display())),
    };
    serde_json::from_str(&raw).map(Some)
        .map_err(|e| format!("数据文件损坏 {}: {e}。请先备份并检查该文件，原文件未修改。", path.display()))
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(value).map_err(|e| format!("序列化失败: {e}"))?;
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)
        .map_err(|e| format!("创建临时文件失败 {}: {e}", tmp.display()))?;
    file.write_all(body.as_bytes()).and_then(|_| file.sync_all())
        .map_err(|e| format!("写入失败 {}: {e}。原文件保留。", tmp.display()))?;
    drop(file);
    // 同目录直接替换，绝不先删旧文件；Windows 的 fs::rename 使用替换语义。
    fs::rename(&tmp, path).map_err(|e| format!(
        "替换文件失败 {}: {e}。原文件保留，新内容位于 {}。", path.display(), tmp.display()))?;
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

/// 全新安装时建议的位置：优先放到「文档」里（用户一眼能找到自己的稿子），
/// 找不到「文档」就退回平台默认数据目录。
pub fn suggested_data_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from);
    if let Some(home) = home {
        let docs = home.join("Documents");
        if docs.is_dir() {
            return docs.join("写心稿件");
        }
    }
    default_data_dir()
}

/// 当前位置信息。判定集中在这里（而不是散在命令里），便于测试：
///
/// * 记过位置且目录就是它 → 不用问；
/// * 记过位置但当前用的不是它（目录不可用，退回默认）→ 重新问，并标出 `missing`；
/// * 从没记过、这个目录里也还没有稿件 → 全新安装，首次启动该问一次；
/// * 位置由 `--data-dir` / 环境变量指定 → 从来不问（自检、截图、测试都靠这个不被弹窗打断）。
pub fn location_info(dir: &Path, config_dir: &Path, forced: bool) -> StorageLocation {
    let record = read_location_record(config_dir);
    let missing = record
        .as_ref()
        .map(|r| Path::new(r.dir.trim()) != dir)
        .unwrap_or(false);
    let needs_choice = !forced && (missing || record.is_none()) && !has_manuscripts(dir);
    StorageLocation {
        dir: dir.to_string_lossy().to_string(),
        suggested: suggested_data_dir().to_string_lossy().to_string(),
        needs_choice,
        is_forced: forced,
        missing,
    }
}

// ---------------------------------------------------------------- 稿件目录的位置

/// 记住"稿件存在哪"的指针文件。它必须放在**数据目录之外**（数据目录正是要定位的东西），
/// 所以放进应用配置目录：Windows 上是 `%APPDATA%\com.heartwrite.novelmanager`，
/// Linux 上是 `~/.config/com.heartwrite.novelmanager`。
pub const LOCATION_FILE: &str = "storage-location.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationRecord {
    pub dir: String,
    pub changed_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageLocation {
    /// 当前实际在用的稿件目录
    pub dir: String,
    /// 首次启动时建议的位置（界面上的"使用默认位置"）
    pub suggested: String,
    /// 该让用户选一次位置了：全新安装，或记住的位置不见了
    pub needs_choice: bool,
    /// 位置由 `--data-dir` / 环境变量指定：界面不再提供更改
    pub is_forced: bool,
    /// 记住的位置不见了（U 盘拔了、文件夹被删），当前临时退回默认目录
    pub missing: bool,
}

/// 记下用户选的稿件目录。传空串表示"忘掉这个选择"，下次启动会重新问。
pub fn write_location_record(config_dir: &Path, dir: &str) -> Result<(), String> {
    let record = LocationRecord { dir: dir.to_string(), changed_at: now_ms() };
    let path = config_dir.join(LOCATION_FILE);
    if dir.trim().is_empty() {
        let _ = fs::remove_file(&path);
        return Ok(());
    }
    fs::create_dir_all(config_dir).map_err(|e| format!("无法创建配置目录：{e}"))?;
    write_json_atomic(&path, &record)
}

/// 读回记住的位置。文件损坏、内容为空都当作"没记过"。
pub fn read_location_record(config_dir: &Path) -> Option<LocationRecord> {
    read_json::<LocationRecord>(&config_dir.join(LOCATION_FILE))
        .ok()
        .flatten()
        .filter(|r| !r.dir.trim().is_empty())
}

/// 这个目录里已经有写心的稿件了吗（`books.json` 是"用过"的标志，
/// `settings.json` 不算 —— 空目录被加载一次就会生成它）。
pub fn has_manuscripts(dir: &Path) -> bool {
    dir.join("books.json").is_file()
}

/// 目录里第一样"真正的东西"（忽略 `.` 开头的隐藏文件和 Windows 的两个老面孔）。
fn first_meaningful_entry(dir: &Path) -> Option<String> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        if name.starts_with('.') || lower == "desktop.ini" || lower == "thumbs.db" {
            continue;
        }
        return Some(name);
    }
    None
}

/// 换目录前的检查。把这些坑挡在前面，界面就只需要把错误原样显示出来：
/// 空路径、原地不动、目录互相嵌套、目标里已经有一份稿件、目标是有人家东西的文件夹。
pub fn validate_new_location(from: &Path, to: &Path) -> Result<(), String> {
    if to.as_os_str().is_empty() {
        return Err("没有选择文件夹".into());
    }
    if to == from {
        return Err("这就是当前的位置".into());
    }
    // 互相嵌套时"移动"会变成把目录搬进自己里面（或把父目录搬进子目录）
    if to.starts_with(from) {
        return Err("不能选当前目录里面的子文件夹".into());
    }
    if from.starts_with(to) {
        return Err("不能选当前目录的上级文件夹".into());
    }
    if to.exists() {
        if looks_like_writing_data(to) {
            return Err("这个文件夹里已经有一份稿件数据，换一个空的吧".into());
        }
        if let Some(name) = first_meaningful_entry(to) {
            return Err(format!("这个文件夹里还有别的东西（{name}），请选一个空文件夹"));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveReport {
    /// 真的搬了东西（新位置本来就空着、或旧位置还没建过，都是 false）
    pub moved: bool,
    /// 跨盘复制：旧目录里的文件是复制过去的，删不掉时会两处都在
    pub cross_volume: bool,
    /// 搬过去的顶层条目数
    pub entries: usize,
}

/// 把稿件目录整体搬走。同卷直接改名（快、失败也能原样退回）；
/// 跨卷先逐个复制，全部成功后再删旧目录；删不掉就让两份都留着（宁可占地方，不能丢稿）。
pub fn move_data_dir(from: &Path, to: &Path) -> Result<MoveReport, String> {
    validate_new_location(from, to)?;
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建 {}：{e}", parent.display()))?;
    }
    if !from.exists() {
        fs::create_dir_all(to).map_err(|e| format!("无法创建 {}：{e}", to.display()))?;
        return Ok(MoveReport { moved: false, cross_volume: false, entries: 0 });
    }
    // 目标还不存在时，整个目录一次改名最干净
    if !to.exists() && fs::rename(from, to).is_ok() {
        return Ok(MoveReport { moved: true, cross_volume: false, entries: 0 });
    }
    fs::create_dir_all(to).map_err(|e| format!("无法创建 {}：{e}", to.display()))?;
    let mut entries = 0usize;
    let mut cross_volume = false;
    for entry in fs::read_dir(from).map_err(|e| format!("读不到旧目录：{e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        entries += 1;
        if fs::rename(&src, &dst).is_ok() {
            continue;
        }
        // 同卷改名失败多半是跨卷：退回复制
        cross_volume = true;
        if src.is_dir() {
            copy_dir_all(&src, &dst).map_err(|e| format!("复制 {} 失败：{e}", src.display()))?;
        } else {
            fs::copy(&src, &dst).map_err(|e| format!("复制 {} 失败：{e}", src.display()))?;
        }
    }
    if cross_volume {
        let _ = fs::remove_dir_all(from);
    }
    Ok(MoveReport { moved: true, cross_volume, entries })
}

/// 应用改名前用过的数据目录名（墨阁 → 写心）。
const LEGACY_APP_DIRS: [&str; 2] = ["com.moge.novelmanager", "com.heartwrite.novelmanager"];

fn looks_like_writing_data(dir: &Path) -> bool {
    dir.join("books.json").is_file()
        || dir.join("settings.json").is_file()
        || dir.join("content").is_dir()
}

/// 首次以新名字启动时，把旧数据目录整体搬过来（只在目标还不存在时执行，避免覆盖）。
/// 找不到可搬的目录、或搬不动时都只是安静地返回，不影响启动。
///
/// 只对默认数据目录生效：用户自己挑的位置旁边不该被我们翻出别的目录搬进来。
fn try_migrate_legacy_data(root: &Path) {
    if root.file_name().and_then(|n| n.to_str()) != Some(APP_DIR) {
        return;
    }
    if root.exists() || root.as_os_str().is_empty() {
        return;
    }
    let Some(parent) = root.parent() else { return };
    let target_name = root.file_name().and_then(|n| n.to_str()).unwrap_or_default();
    for legacy_name in LEGACY_APP_DIRS {
        if legacy_name == target_name {
            continue;
        }
        let legacy = parent.join(legacy_name);
        if !looks_like_writing_data(&legacy) {
            continue;
        }
        // 先在同一卷内改名（快、原子）；跨卷时退回递归复制，两个目录都不删。
        let moved = fs::rename(&legacy, root).is_ok();
        if !moved && copy_dir_all(&legacy, root).is_err() {
            let _ = fs::remove_dir_all(root);
            continue;
        }
        eprintln!(
            "[写心] 已把原「{}」的稿件迁移到「{}」{}",
            legacy_name,
            target_name,
            if moved { "" } else { "（跨盘复制，旧目录请自行确认后删除）" }
        );
        return;
    }
}

fn copy_dir_all(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

impl Store {
    pub fn load(root: PathBuf) -> Result<Self, String> {
        // 改名前的老用户：把稿件搬过来，再继续正常加载
        try_migrate_legacy_data(&root);
        fs::create_dir_all(&root).map_err(|e| format!("无法创建数据目录 {}: {e}", root.display()))?;
        let content_dir = root.join("content");
        fs::create_dir_all(&content_dir).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("books")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("exports")).map_err(|e| e.to_string())?;
        fs::create_dir_all(root.join("trash")).map_err(|e| e.to_string())?;

        let mut settings: Settings = read_json(&root.join("settings.json"))?.unwrap_or_default();
        settings = settings.normalized();
        let registry: Registry = read_json(&root.join("books.json"))?.unwrap_or_default();

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
        read_json(&self.book_path(id))?.ok_or_else(|| format!("找不到书籍 {id}"))
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

    pub fn read_content(&self, book_id: &str, chapter_id: &str) -> Result<ChapterContent, String> {
        let chapter = self.require_book(book_id)?.volumes.iter()
            .flat_map(|v| &v.chapters).find(|c| c.id == chapter_id)
            .ok_or_else(|| format!("找不到章节 {chapter_id}"))?;
        let path = self.chapter_path(book_id, chapter_id);
        let stored = read_json(&path)?;
        if stored.is_none() && (chapter.char_count > 0 || chapter.versions > 0) {
            return Err(format!("章节文件缺失 {}。已停止读取和覆盖，请检查备份。", path.display()));
        }
        let mut c: ChapterContent = stored.unwrap_or_default();
        if c.chapter_id.is_empty() {
            c.chapter_id = chapter_id.to_string();
        }
        if c.chapter_id != chapter_id {
            return Err(format!("章节标识不匹配 {}，原文件未修改。", path.display()));
        }
        Ok(c)
    }

    pub fn write_content(&self, book_id: &str, c: &ChapterContent) -> Result<(), String> {
        write_json_atomic(&self.chapter_path(book_id, &c.chapter_id), c)
    }

    /// 全书搜索：在 Rust 侧一次遍历完成，避免前端"每章一次 IPC + 每章解析全部历史版本"。
    /// 返回命中章节、命中次数与一段上下文片段（原样文本，转义交给前端）。
    pub fn search_book(&self, book_id: &str, needle: &str, max_per_chapter: usize) -> Result<Vec<SearchHit>, String> {
        if needle.trim().is_empty() {
            return Ok(Vec::new());
        }
        let book = self.require_book(book_id)?;
        let pat = needle.to_lowercase();
        let mut hits = Vec::new();
        for vol in &book.volumes {
            for ch in &vol.chapters {
                let content = match self.read_content(book_id, &ch.id) {
                    Ok(c) => c.content,
                    // 单章读不了（损坏/缺失）不该让整次搜索失败，跳过即可
                    Err(_) => continue,
                };
                let hay = content.to_lowercase();
                let mut offsets = Vec::new();
                let mut from = 0usize;
                while let Some(pos) = hay[from..].find(&pat) {
                    let abs = from + pos;
                    if offsets.len() >= max_per_chapter {
                        break;
                    }
                    offsets.push(abs);
                    from = abs + pat.len().max(1);
                }
                if offsets.is_empty() {
                    continue;
                }
                // 小写化可能改变字节长度，所以用字符数换算回原串
                let original: Vec<char> = content.chars().collect();
                let first = hay[..offsets[0]].chars().count();
                let needle_chars = pat.chars().count();
                let start = first.saturating_sub(30);
                let end = (first + needle_chars + 40).min(original.len());
                let head: String = original[start..first].iter().collect();
                let hit: String = original[first..(first + needle_chars).min(original.len())].iter().collect();
                let tail: String = original[(first + needle_chars).min(original.len())..end].iter().collect();
                hits.push(SearchHit {
                    chapter_id: ch.id.clone(),
                    chapter_title: ch.title.clone(),
                    volume_title: vol.title.clone(),
                    count: offsets.len(),
                    head,
                    hit,
                    tail,
                });
            }
        }
        Ok(hits)
    }

    pub fn read_cards(&self, book_id: &str) -> Result<Vec<Card>, String> {
        Ok(read_json(&self.cards_path(book_id))?.unwrap_or_default())
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

    // -- 封面（可选功能：没设过就一切照旧）------------------------------------

    /// 封面的落盘路径：固定叫 `cover.<ext>`，扩展名记在 `cover_image` 里。
    pub fn cover_path(&self, book_id: &str, ext: &str) -> PathBuf {
        self.root.join("books").join(book_id).join(format!("cover.{ext}"))
    }

    /// 读封面原始字节。没设过、或文件被外面删掉了，都返回 `None`：
    /// 界面据此安静地退回默认外观，而不是报错打断用户。
    pub fn read_book_cover(&self, book_id: &str) -> Option<(String, Vec<u8>)> {
        let book = self.book(book_id).ok()?;
        let ext = crate::cover::cover_ext(&book.cover_image)?;
        let bytes = fs::read(self.cover_path(book_id, &ext)).ok()?;
        (!bytes.is_empty()).then_some((ext, bytes))
    }

    /// 设置封面：把用户选中的图片复制进 `books/<id>/cover.<ext>` 并记进 book.json。
    /// 校验（白名单 / 体积 / 非空）统一在 `cover::read_image` 里，任何入口都绕不过。
    pub fn set_book_cover(&mut self, book_id: &str, source: &str) -> Result<BookMeta, String> {
        let (ext, bytes) = crate::cover::read_image(source)?;
        if let Some(dir) = self.cover_path(book_id, &ext).parent() {
            fs::create_dir_all(dir).map_err(|e| format!("无法创建封面目录：{e}"))?;
        }
        // 换了格式就删掉旧封面，避免目录里同时躺着两张
        let previous = self.book(book_id).map(|b| b.cover_image).unwrap_or_default();
        if !previous.is_empty() && previous != format!("cover.{ext}") {
            let _ = fs::remove_file(self.root.join("books").join(book_id).join(&previous));
        }
        fs::write(self.cover_path(book_id, &ext), &bytes).map_err(|e| format!("保存封面失败：{e}"))?;
        let snapshot = {
            let book = self.book_mut(book_id)?;
            book.cover_image = format!("cover.{ext}");
            book.updated_at = now_ms();
            book.clone()
        };
        self.save_book(&snapshot)?;
        self.save_registry()?;
        Ok(snapshot)
    }

    /// 清除封面：删文件 + 清字段。本来就没有封面时也当成功（幂等）。
    pub fn clear_book_cover(&mut self, book_id: &str) -> Result<BookMeta, String> {
        let previous = self.book(book_id).map(|b| b.cover_image).unwrap_or_default();
        if !previous.is_empty() {
            let _ = fs::remove_file(self.root.join("books").join(book_id).join(&previous));
        }
        let snapshot = {
            let book = self.book_mut(book_id)?;
            book.cover_image.clear();
            book.updated_at = now_ms();
            book.clone()
        };
        self.save_book(&snapshot)?;
        self.save_registry()?;
        Ok(snapshot)
    }

    /// 导入备份时用：备份里存的是 base64，解出来的字节直接落盘（字段由调用方写进 book.json）。
    pub fn write_book_cover_file(&self, book_id: &str, ext: &str, bytes: &[u8]) -> Result<(), String> {
        let dst = self.cover_path(book_id, ext);
        if let Some(dir) = dst.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("无法创建封面目录：{e}"))?;
        }
        fs::write(&dst, bytes).map_err(|e| format!("写入封面失败：{e}"))
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

    pub fn book_stats(&self, book: &BookMeta) -> Result<BookStats, String> {
        let mut stats = BookStats {
            char_count: 0,
            words: 0,
            cjk: 0,
            chapters: 0,
            volumes: book.volumes.len(),
            cards: self.read_cards(&book.id)?.len(),
            versions: 0,
            today_chars: 0,
        };
        let today = crate::text::today_start_ms();
        for vol in &book.volumes {
            for ch in &vol.chapters {
                stats.chapters += 1;
                stats.char_count += ch.char_count;
                stats.versions += ch.versions;
                let content = self.read_content(&book.id, &ch.id)?;
                let c = count_text(&content.content);
                stats.words += c.words;
                stats.cjk += c.cjk;
                if content.updated_at >= today {
                    stats.today_chars += c.total;
                }
            }
        }
        Ok(stats)
    }

    pub fn storage_bytes(&self) -> u64 {
        dir_size(&self.root)
    }

    // -- 最近导出记录 --------------------------------------------------------

    pub fn read_recent_exports(&self) -> Result<Vec<crate::export::RecentExport>, String> {
        Ok(read_json(&self.root.join("recent-exports.json"))?.unwrap_or_default())
    }

    pub fn push_recent_export(
        &self,
        item: crate::export::RecentExport,
    ) -> Result<Vec<crate::export::RecentExport>, String> {
        let mut list = self.read_recent_exports()?;
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
        let mut stored = self.read_content(book_id, chapter_id)?;
        let previous = stored.content.clone();
        let previous_chars = count_text(&previous).total;
        let changed = previous != content;

        stored.content = content.to_string();
        stored.updated_at = now;

        let depth = self.settings.history_depth.clamp(1, MAX_HISTORY_HARD_CAP);
        let delta = self.settings.snapshot_char_delta;
        let snapshot_chars = stored.versions.first().map(|v| v.chars).unwrap_or(previous_chars);
        let big_enough = snapshot_chars.abs_diff(count.total) >= delta;
        let has_versions = !stored.versions.is_empty();

        let mut created = false;
        let mut version_id = String::new();
        let manual = force_version && version_kind == "manual";
        if manual || (changed && (force_version || big_enough || !has_versions)) {
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
                chars: if manual { count.total } else { previous_chars },
                content: if manual { content.to_string() } else { previous },
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

    pub fn list_versions(&self, book_id: &str, chapter_id: &str) -> Result<Vec<VersionMeta>, String> {
        Ok(self.read_content(book_id, chapter_id)?
            .versions
            .into_iter()
            .map(|v| VersionMeta {
                id: v.id,
                created_at: v.created_at,
                kind: v.kind,
                label: v.label,
                chars: v.chars,
            })
            .collect())
    }

    pub fn version_content(&self, book_id: &str, chapter_id: &str, version_id: &str) -> Result<Option<Version>, String> {
        Ok(self.read_content(book_id, chapter_id)?
            .versions
            .into_iter()
            .find(|v| v.id == version_id))
    }

    pub fn restore_version(
        &mut self,
        book_id: &str,
        chapter_id: &str,
        version_id: &str,
    ) -> Result<SaveResult, String> {
        let target = self
            .version_content(book_id, chapter_id, version_id)?
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
        let mut stored = self.read_content(book_id, chapter_id)?;
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
        let mut cards = self.read_cards(book_id)?;
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
        let mut cards = self.read_cards(book_id)?;
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
        if !book.cover_image.is_empty() && self.read_book_cover(book_id).is_none() {
            fixed.push(format!("封面文件不见了（{}）", book.cover_image));
        }
        for vol in &book.volumes {
            for ch in &vol.chapters {
                let c = self.read_content(book_id, &ch.id)?;
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

#[cfg(test)]
mod reliability_tests {
    use super::*;

    struct Workspace(PathBuf);
    impl Workspace {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("heartwrite-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn store(&self) -> Store { Store::load(self.0.clone()).unwrap() }
    }
    impl Drop for Workspace {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }
    fn draft(store: &mut Store) -> (String, String) {
        let book = store.create_book("测试作品", "", "").unwrap();
        (book.id, book.volumes[0].chapters[0].id.clone())
    }
    fn save(store: &mut Store, book: &str, chapter: &str, text: &str, manual: bool) -> Result<SaveResult, String> {
        store.save_chapter(book, chapter, text, None, None, None, manual, "", if manual { "manual" } else { "auto" })
    }

    #[test]
    fn cover_round_trip_swap_format_and_clear() {
        let ws = Workspace::new();
        let mut store = ws.store();
        let (book_id, _) = draft(&mut store);

        // 内容不重要（这里不做图像解码），扩展名才决定格式；顺便覆盖大写扩展名
        let first = ws.0.join("我的封面.PNG");
        fs::write(&first, b"fake-png-bytes").unwrap();
        let book = store.set_book_cover(&book_id, first.to_string_lossy().as_ref()).unwrap();
        assert_eq!(book.cover_image, "cover.png");
        assert_eq!(store.book(&book_id).unwrap().cover_image, "cover.png");
        let (ext, bytes) = store.read_book_cover(&book_id).unwrap();
        assert_eq!((ext.as_str(), bytes.as_slice()), ("png", b"fake-png-bytes".as_ref()));
        // 封面记进了 registry，书架列表拿得到
        assert_eq!(store.registry.books[0].cover_image, "cover.png");

        // 换成 jpg：旧文件必须被清掉，目录里不能留两张
        let second = ws.0.join("cover2.jpg");
        fs::write(&second, b"fake-jpg").unwrap();
        store.set_book_cover(&book_id, second.to_string_lossy().as_ref()).unwrap();
        assert_eq!(store.book(&book_id).unwrap().cover_image, "cover.jpg");
        assert!(!ws.0.join("books").join(&book_id).join("cover.png").exists());
        assert_eq!(store.read_book_cover(&book_id).unwrap().1, b"fake-jpg");

        // 不支持的类型、空文件都拒绝
        let text = ws.0.join("note.txt");
        fs::write(&text, b"x").unwrap();
        assert!(store.set_book_cover(&book_id, text.to_string_lossy().as_ref()).is_err());
        let empty = ws.0.join("empty.png");
        fs::write(&empty, b"").unwrap();
        assert!(store.set_book_cover(&book_id, empty.to_string_lossy().as_ref()).is_err());
        // 被拒绝之后仍然是原来那张 jpg
        assert_eq!(store.book(&book_id).unwrap().cover_image, "cover.jpg");

        // 清除后回到"没有封面"的状态，重复清除也安全
        store.clear_book_cover(&book_id).unwrap();
        assert!(store.book(&book_id).unwrap().cover_image.is_empty());
        assert!(store.read_book_cover(&book_id).is_none());
        assert!(store.clear_book_cover(&book_id).is_ok());
    }

    #[test]
    fn missing_cover_file_degrades_quietly_and_is_reported() {
        let ws = Workspace::new();
        let mut store = ws.store();
        let (book_id, _) = draft(&mut store);
        let src = ws.0.join("cover.png");
        fs::write(&src, b"bytes").unwrap();
        store.set_book_cover(&book_id, src.to_string_lossy().as_ref()).unwrap();

        // 模拟用户在资源管理器里把封面删了：读取返回 None，体检报告里能看到
        fs::remove_file(ws.0.join("books").join(&book_id).join("cover.png")).unwrap();
        assert!(store.read_book_cover(&book_id).is_none());
        let report = store.verify_book(&book_id).unwrap();
        assert!(report.iter().any(|line| line.contains("封面文件不见了")), "体检没报出缺失的封面：{report:?}");
    }

    #[test]
    fn empty_dir_with_settings_is_not_manuscripts() {
        // 空目录被加载过一次就会生成 settings.json —— 那不算"用户已经有稿件"
        let ws = Workspace::new();
        let store = ws.store();
        assert!(!has_manuscripts(&store.root), "只有 settings.json 时不该认为已有稿件");
    }

    #[test]
    fn location_decision_covers_fresh_recorded_missing_and_forced() {
        let ws = Workspace::new();
        let config = ws.0.join("config");
        let data = ws.0.join("data");
        fs::create_dir_all(&data).unwrap();

        // 全新安装：没记过位置、目录里也没稿件 → 首次启动要问
        let fresh = location_info(&data, &config, false);
        assert!(fresh.needs_choice, "全新安装应该让用户选一次位置");
        assert!(!fresh.is_forced);
        assert!(!fresh.missing);
        assert!(!fresh.suggested.is_empty(), "应该给出一个建议位置");

        // 记过位置且正用着 → 不再问
        write_location_record(&config, &data.to_string_lossy()).unwrap();
        assert!(!location_info(&data, &config, false).needs_choice);

        // 记的位置不是当前目录（U 盘拔了那种）→ 重新问，并标出 missing
        let other = ws.0.join("elsewhere");
        let info = location_info(&other, &config, false);
        assert!(info.missing && info.needs_choice, "记住的位置不可用时应该重新问");

        // --data-dir 指定 → 从来不问，也不允许界面改
        let forced = location_info(&other, &config, true);
        assert!(forced.is_forced && !forced.needs_choice);
    }

    #[test]
    fn storage_location_validation_catches_the_dangerous_choices() {
        let ws = Workspace::new();
        let base = &ws.0;
        let current = base.join("current");
        fs::create_dir_all(&current).unwrap();

        // 原地不动、互相嵌套、空路径都要挡住
        assert!(validate_new_location(&current, &current).is_err());
        assert!(validate_new_location(&current, &current.join("inner")).is_err());
        assert!(validate_new_location(&current, base).is_err());
        assert!(validate_new_location(&current, Path::new("")).is_err());

        // 空目录可以，还不存在的目录也可以（会自动创建）
        let empty = base.join("empty");
        fs::create_dir_all(&empty).unwrap();
        assert!(validate_new_location(&current, &empty).is_ok());
        assert!(validate_new_location(&current, &base.join("brand-new")).is_ok());

        // 别人家的文件夹要挡住，错误信息里带上那个文件的名字
        let busy = base.join("busy");
        fs::create_dir_all(&busy).unwrap();
        fs::write(busy.join("taxes.pdf"), b"x").unwrap();
        let err = validate_new_location(&current, &busy).unwrap_err();
        assert!(err.contains("taxes.pdf"), "错误信息应该指出冲突的文件：{err}");

        // Windows 的 desktop.ini、以及 . 开头的隐藏文件不算"东西"
        fs::write(busy.join("desktop.ini"), b"x").unwrap();
        fs::write(busy.join(".DS_Store"), b"x").unwrap();
        fs::remove_file(busy.join("taxes.pdf")).unwrap();
        assert!(validate_new_location(&current, &busy).is_ok());

        // 目标里已经有一份写心数据：搬过去会互相覆盖，直接拒绝
        let other = base.join("other-data");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("books.json"), b"{}").unwrap();
        assert!(validate_new_location(&current, &other).is_err());
    }

    #[test]
    fn move_data_dir_takes_the_manuscripts_along() {
        let ws = Workspace::new();
        // 数据放子目录里，好让"新位置"是它的兄弟目录（互相嵌套会被校验拦掉）
        let from = ws.0.join("data");
        let mut store = Store::load(from.clone()).unwrap();
        let (book_id, chapter) = draft(&mut store);
        save(&mut store, &book_id, &chapter, "第一章 雪夜", true).unwrap();
        let card = store
            .upsert_card(&book_id, Card { kind: "character".into(), title: "沈孤鸿".into(), ..Default::default() })
            .unwrap();

        let to = ws.0.join("搬到这儿");
        let report = move_data_dir(&from, &to).unwrap();
        assert!(report.moved);
        assert_eq!(report.entries, 0, "整目录改名时不需要逐个条目搬");
        assert!(!from.exists(), "同卷搬家应该把旧目录挪空");

        // 换根之后稿件、正文、卡片、设置都在
        let moved = Store::load(to.clone()).unwrap();
        assert_eq!(moved.root, to);
        assert!(has_manuscripts(&to));
        assert_eq!(moved.book(&book_id).unwrap().title, "测试作品");
        assert_eq!(moved.read_content(&book_id, &chapter).unwrap().content, "第一章 雪夜");
        let cards = moved.read_cards(&book_id).unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].id, card.id);
    }

    #[test]
    fn replaces_existing_file_and_reloads_latest_text() {
        let ws = Workspace::new();
        let mut store = ws.store();
        let (book, chapter) = draft(&mut store);
        save(&mut store, &book, &chapter, "旧正文", false).unwrap();
        save(&mut store, &book, &chapter, "新正文 hello 123", false).unwrap();
        let reopened = ws.store();
        assert_eq!(reopened.read_content(&book, &chapter).unwrap().content, "新正文 hello 123");
    }

    #[test]
    fn corrupt_chapter_is_never_read_as_empty_or_overwritten() {
        let ws = Workspace::new();
        let mut store = ws.store();
        let (book, chapter) = draft(&mut store);
        save(&mut store, &book, &chapter, "珍贵正文", true).unwrap();
        let path = store.chapter_path(&book, &chapter);
        let damaged = "{\"content\":\"truncated";
        fs::write(&path, damaged).unwrap();
        assert!(store.read_content(&book, &chapter).unwrap_err().contains("损坏"));
        assert!(save(&mut store, &book, &chapter, "", false).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), damaged);
        let options = crate::export::ExportOptions::default();
        assert!(crate::export::run_export(&store, &book, &options).is_err());
    }

    #[test]
    fn missing_saved_chapter_is_an_error_but_new_chapter_is_empty() {
        let ws = Workspace::new();
        let mut store = ws.store();
        let (book, chapter) = draft(&mut store);
        assert_eq!(store.read_content(&book, &chapter).unwrap().content, "");
        save(&mut store, &book, &chapter, "保存过的正文", false).unwrap();
        fs::remove_file(store.chapter_path(&book, &chapter)).unwrap();
        assert!(store.read_content(&book, &chapter).unwrap_err().contains("缺失"));
        assert!(save(&mut store, &book, &chapter, "", false).is_err());
    }

    #[test]
    fn corrupt_registry_and_cards_are_preserved() {
        let ws = Workspace::new();
        let mut store = ws.store();
        let (book, _) = draft(&mut store);
        let path = store.cards_path(&book);
        fs::write(&path, "broken").unwrap();
        assert!(store.upsert_card(&book, Card::default()).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "broken");
        fs::write(ws.0.join("books.json"), "broken").unwrap();
        assert!(Store::load(ws.0.clone()).is_err());
        assert_eq!(fs::read_to_string(ws.0.join("books.json")).unwrap(), "broken");
    }

    #[test]
    fn manual_snapshot_contains_current_text_even_after_autosave() {
        let ws = Workspace::new();
        let mut store = ws.store();
        let (book, chapter) = draft(&mut store);
        save(&mut store, &book, &chapter, "自动保存后的正文", false).unwrap();
        assert!(save(&mut store, &book, &chapter, "自动保存后的正文", true).unwrap().created_version);
        let stored = store.read_content(&book, &chapter).unwrap();
        assert_eq!(stored.versions[0].content, stored.content);
        assert_eq!(stored.versions[0].kind, "manual");
    }

    #[test]
    fn invalid_chapter_save_does_not_create_orphan_file() {
        let ws = Workspace::new();
        let mut store = ws.store();
        let (book, _) = draft(&mut store);
        assert!(save(&mut store, &book, "missing", "orphan", false).is_err());
        assert!(!store.chapter_path(&book, "missing").exists());
    }

    #[cfg(windows)]
    #[test]
    fn failed_replacement_preserves_old_file_and_new_temporary_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let ws = Workspace::new();
        let path = ws.0.join("locked.json");
        write_json_atomic(&path, &"old manuscript").unwrap();
        // Deny delete sharing to reproduce a failed replacement on Windows.
        let _locked = fs::OpenOptions::new().read(true).share_mode(1).open(&path).unwrap();
        assert!(write_json_atomic(&path, &"new manuscript").is_err());
        assert_eq!(read_json::<String>(&path).unwrap().unwrap(), "old manuscript");
        let temp = fs::read_dir(&ws.0).unwrap().filter_map(Result::ok)
            .find(|e| e.path().extension().is_some_and(|x| x == "tmp")).unwrap();
        assert_eq!(read_json::<String>(&temp.path()).unwrap().unwrap(), "new manuscript");
    }
}
