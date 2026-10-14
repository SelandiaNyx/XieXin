//! 数据模型：设置、书籍、卷、章节、版本历史、卡片与统计结构。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::text::now_ms;

/// 单章历史版本数硬上限：防止用户在设置里填超大值撑爆单章 JSON。
pub const MAX_HISTORY_HARD_CAP: usize = 200;

fn default_theme() -> String {
    "light".into()
}
fn default_font_family() -> String {
    "\"霞鹜文楷\", \"LXGW WenKai\", \"Source Han Serif SC\", \"思源宋体\", \"Songti SC\", \"SimSun\", serif".into()
}
fn default_font_size() -> u32 {
    18
}
fn default_line_height() -> f32 {
    1.9
}
fn default_autosave_secs() -> u32 {
    20
}
fn default_history_depth() -> usize {
    30
}
fn default_snapshot_char_delta() -> usize {
    120
}
fn default_editor_width() -> u32 {
    860
}
fn default_daily_goal() -> usize {
    3000
}
fn default_format_rule() -> String {
    "cjk-indent".into()
}
fn default_letter_spacing() -> f32 {
    0.02
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub font_family: String,
    pub font_size: u32,
    pub line_height: f32,
    pub letter_spacing: f32,
    pub autosave_secs: u32,
    pub history_depth: usize,
    pub snapshot_char_delta: usize,
    pub editor_width: u32,
    pub daily_goal: usize,
    pub last_book_id: String,
    /// 上次打开的章节 id（启动时用于直接定位到离开前那一章）。
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
            editor_width: default_editor_width(),
            daily_goal: default_daily_goal(),
            last_book_id: String::new(),
            last_chapter_id: String::new(),
            last_export_dir: String::new(),
            one_click_format_rule: default_format_rule(),
        }
    }
}

/// 章节状态定义：内置十余种常见写作阶段，供下拉菜单分组选择与着色。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChapterStatus {
    pub id: &'static str,
    pub label: &'static str,
    pub group: &'static str,
    pub color: &'static str,
    pub hint: &'static str,
}

pub fn default_statuses() -> Vec<ChapterStatus> {
    vec![
        // 构思阶段
        ChapterStatus { id: "idea",       label: "灵光 / 点子", group: "构思", color: "#b39ddb", hint: "只有一个念头或一句话" },
        ChapterStatus { id: "outline",    label: "大纲已列",   group: "构思", color: "#90caf9", hint: "章纲、冲突与转折已排好" },
        ChapterStatus { id: "material",   label: "资料待补",   group: "构思", color: "#80deea", hint: "需查设定或补人物卡" },
        // 写作阶段
        ChapterStatus { id: "draft",      label: "草稿",       group: "写作", color: "#9aa0b4", hint: "正在顺着往下写" },
        ChapterStatus { id: "writing",    label: "连载写作中", group: "写作", color: "#64b5f6", hint: "今日主攻章节" },
        ChapterStatus { id: "stuck",      label: "卡文待破",   group: "写作", color: "#ef9a9a", hint: "节奏或动机需要重想" },
        ChapterStatus { id: "tofill",     label: "留白待补",   group: "写作", color: "#ffcc80", hint: "先跳过、回头补写场面" },
        // 打磨阶段
        ChapterStatus { id: "revising",   label: "修订中",     group: "打磨", color: "#f5a623", hint: "顺词句、删水分、埋伏笔" },
        ChapterStatus { id: "polishing",  label: "润色精修",   group: "打磨", color: "#ffd54f", hint: "对白、意象与节奏最后一遍" },
        ChapterStatus { id: "proofread",  label: "校对错字",   group: "打磨", color: "#aed581", hint: "标点、错别字与人名核对" },
        // 完成阶段
        ChapterStatus { id: "final",      label: "定稿待发",   group: "完成", color: "#81c784", hint: "可随时发布或存稿" },
        ChapterStatus { id: "scheduled",  label: "定时存稿",   group: "完成", color: "#4db6ac", hint: "放入存稿箱按日更发出" },
        ChapterStatus { id: "published",  label: "已发布",     group: "完成", color: "#5cb85c", hint: "已发出到连载平台" },
        // 特殊
        ChapterStatus { id: "extra",      label: "番外 / 特典", group: "特殊", color: "#f48fb1", hint: "番外、小剧场或人物志" },
        ChapterStatus { id: "archived",   label: "废稿留档",   group: "特殊", color: "#78909c", hint: "不入正篇但保留素材" },
    ]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Chapter {
    pub id: String,
    pub title: String,
    pub summary: String,
    pub status: String, // 见 default_statuses()
    pub char_count: usize,
    pub created_at: i64,
    pub updated_at: i64,
    pub versions: usize,
}

impl Default for Chapter {
    fn default() -> Self {
        let now = now_ms();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: "新章节".into(),
            summary: String::new(),
            status: "draft".into(),
            char_count: 0,
            created_at: now,
            updated_at: now,
            versions: 0,
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
    pub chapters: Vec<Chapter>,
}

impl Default for Volume {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: "第一卷".into(),
            summary: String::new(),
            expanded: true,
            chapters: Vec::new(),
        }
    }
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
    /// 封面文件名（如 `"cover.png"`），存放在 `books/<id>/` 下。
    /// 空串表示没设封面 —— 老数据的 `book.json` 没有这个字段，反序列化自然是空串，完全兼容。
    pub cover_image: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub volumes: Vec<Volume>,
}

impl Default for BookMeta {
    fn default() -> Self {
        let now = now_ms();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            title: "未命名作品".into(),
            author: String::new(),
            genre: String::new(),
            summary: String::new(),
            cover_color: "#5b6be1".into(),
            cover_image: String::new(),
            created_at: now,
            updated_at: now,
            volumes: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Version {
    pub id: String,
    pub created_at: i64,
    pub kind: String, // auto | manual | restore | import
    pub label: String,
    pub chars: usize,
    pub content: String,
}

impl Default for Version {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now_ms(),
            kind: "auto".into(),
            label: String::new(),
            chars: 0,
            content: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    pub id: String,
    pub created_at: i64,
    pub kind: String,
    pub label: String,
    pub chars: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ChapterContent {
    pub chapter_id: String,
    pub content: String,
    pub updated_at: i64,
    pub versions: Vec<Version>,
}

impl Default for ChapterContent {
    fn default() -> Self {
        Self {
            chapter_id: String::new(),
            content: String::new(),
            updated_at: now_ms(),
            versions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Card {
    pub id: String,
    pub kind: String, // character | plot | inspiration | world
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub color: String,
    pub pinned: bool,
    pub fields: BTreeMap<String, String>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Default for Card {
    fn default() -> Self {
        let now = now_ms();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            kind: "character".into(),
            title: String::new(),
            content: String::new(),
            tags: Vec::new(),
            color: "#8ab4f8".into(),
            pinned: false,
            fields: BTreeMap::new(),
            created_at: now,
            updated_at: now,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Registry {
    pub books: Vec<BookMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub deleted_at: i64,
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

/// 全书搜索的单条命中：只返回片段与命中次数，避免把整本正文搬到前端。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub chapter_id: String,
    pub chapter_title: String,
    pub volume_title: String,
    pub count: usize,
    /// 首个命中位置前后的纯文本片段（分三段，方便前端安全高亮）
    pub head: String,
    pub hit: String,
    pub tail: String,
}
