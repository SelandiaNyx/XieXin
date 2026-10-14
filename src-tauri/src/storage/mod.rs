//! 本地存储层：原子写入、作品注册表、章节内容与版本快照、人物/剧情/灵光卡片、回收站。
//!
//! 磁盘结构（位于 `%APPDATA%/com.heartwrite.novelmanager/` 或 `NOVEL_MANAGER_DATA_DIR`）：
//! ```text
//! settings.json
//! books.json                        -- 书架索引（也同步保存每本书的目录树）
//! recent-exports.json
//! books/<bookId>/book.json          -- 作品完整结构（卷/章元数据）
//! books/<bookId>/cards.json         -- 人物/剧情/灵光/设定 卡片
//! content/<bookId>/<chapterId>.json -- 正文 + 历史版本快照
//! trash/<timestamp>_<name>          -- 软删除的书与章节
//! exports/                          -- 默认导出目录
//! ```

pub mod io;
pub mod location;
pub mod models;

pub use io::*;
pub use location::*;
pub use models::*;

use std::fs;
use std::path::PathBuf;

use crate::text::{count_text, now_ms};

/// 应用核心状态：管理磁盘根目录、设置与书架注册表。
pub struct Store {
    pub root: PathBuf,
    pub settings: Settings,
    pub registry: Registry,
    /// 本进程累计完成了多少次保存，用来触发"每隔 N 次顺手留一份结构快照"。
    pub save_count: u64,
}

/// 每完成多少次保存就给当前书的 `book.json` 留一份滚动备份。
const BACKUP_EVERY_SAVES: u64 = 15;
/// 每本书最多留几份滚动备份（超出就把最老的那份删掉）。
const BACKUP_KEEP_PER_BOOK: usize = 5;

impl Store {
    pub fn load(root: PathBuf) -> Result<Self, String> {
        for sub in ["books", "content", "trash", "exports", "backups"] {
            fs::create_dir_all(root.join(sub))
                .map_err(|e| format!("无法初始化数据目录 {}: {e}", root.display()))?;
        }
        let settings_path = root.join("settings.json");
        let settings: Settings = read_json(&settings_path)?.unwrap_or_default();
        if !settings_path.exists() {
            let _ = write_json_atomic(&settings_path, &settings);
        }
        let registry_path = root.join("books.json");
        let registry: Registry = read_json(&registry_path)?.unwrap_or_default();

        let mut store = Self {
            root,
            settings,
            registry,
            save_count: 0,
        };
        store.reconcile()?;
        Ok(store)
    }

    /// 每次启动把 `books/<id>/book.json` 里的最新目录树同步回 `books.json`，
    /// 防止某一次退出只写了单本文件而索引滞后。
    pub fn reconcile(&mut self) -> Result<(), String> {
        let mut changed = false;
        let books_dir = self.root.join("books");
        for slot in self.registry.books.iter_mut() {
            let book_file = books_dir.join(&slot.id).join("book.json");
            match read_json::<BookMeta>(&book_file)? {
                Some(fresh) => *slot = fresh,
                None => {
                    write_json_atomic(&book_file, slot)?;
                    changed = true;
                }
            }
        }
        if changed {
            self.save_registry()?;
        }
        Ok(())
    }

    pub fn book_dir(&self, book_id: &str) -> PathBuf {
        self.root.join("books").join(book_id)
    }

    pub fn content_dir(&self, book_id: &str) -> PathBuf {
        self.root.join("content").join(book_id)
    }

    pub fn chapter_path(&self, book_id: &str, chapter_id: &str) -> PathBuf {
        self.content_dir(book_id).join(format!("{chapter_id}.json"))
    }

    pub fn cards_path(&self, book_id: &str) -> PathBuf {
        self.book_dir(book_id).join("cards.json")
    }

    pub fn save_settings(&self) -> Result<(), String> {
        write_json_atomic(&self.root.join("settings.json"), &self.settings)
    }

    pub fn save_registry(&self) -> Result<(), String> {
        write_json_atomic(&self.root.join("books.json"), &self.registry)
    }

    pub fn save_book(&self, book: &BookMeta) -> Result<(), String> {
        write_json_atomic(&self.book_dir(&book.id).join("book.json"), book)
    }

    pub fn book(&self, book_id: &str) -> Result<BookMeta, String> {
        self.registry
            .books
            .iter()
            .find(|b| b.id == book_id)
            .cloned()
            .ok_or_else(|| format!("找不到作品 {book_id}"))
    }

    pub fn book_mut(&mut self, book_id: &str) -> Result<&mut BookMeta, String> {
        self.registry
            .books
            .iter_mut()
            .find(|b| b.id == book_id)
            .ok_or_else(|| format!("找不到作品 {book_id}"))
    }

    /// 持久化某本书的结构变更（同时写 `books/<id>/book.json` 与 `books.json`）。
    /// 每累计 `BACKUP_EVERY_SAVES` 次保存，顺手留一份结构快照（失败不影响主流程）。
    pub fn persist_structure(&self, book_id: &str, snapshot: BookMeta) -> Result<(), String> {
        self.save_book(&snapshot)?;
        self.save_registry()?;
        let _ = self.write_backup_if_due(&snapshot);
        let _ = book_id;
        Ok(())
    }

    /// 给当前书的目录结构留一份带时间戳的快照，只留最近 `BACKUP_KEEP_PER_BOOK` 份。
    /// 只备份 `BookMeta`（几 KB），不复制正文 —— 正文每章自带多达 200 个历史版本。
    fn write_backup_if_due(&self, book: &BookMeta) -> Result<(), String> {
        if self.save_count == 0 || self.save_count % BACKUP_EVERY_SAVES != 0 {
            return Ok(());
        }
        let dir = self.root.join("backups").join(&book.id);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = crate::text::now_iso();
        let file = dir.join(format!("book-{stamp}.json"));
        write_json_atomic(&file, book)?;

        // 按文件名排序（时间戳天然递增），只留最新的几份
        if let Ok(rd) = fs::read_dir(&dir) {
            let mut files: Vec<PathBuf> = rd
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
                .collect();
            files.sort();
            while files.len() > BACKUP_KEEP_PER_BOOK {
                let oldest = files.remove(0);
                let _ = fs::remove_file(oldest);
            }
        }
        Ok(())
    }

    pub fn read_cards(&self, book_id: &str) -> Result<Vec<Card>, String> {
        Ok(read_json(&self.cards_path(book_id))?.unwrap_or_default())
    }

    pub fn read_content(&self, book_id: &str, chapter_id: &str) -> Result<ChapterContent, String> {
        let path = self.chapter_path(book_id, chapter_id);
        if let Some(mut c) = read_json::<ChapterContent>(&path)? {
            if c.chapter_id.is_empty() {
                c.chapter_id = chapter_id.to_string();
            }
            return Ok(c);
        }
        if let Ok(book) = self.book(book_id) {
            if let Some(ch) = book.volumes.iter().flat_map(|v| &v.chapters).find(|c| c.id == chapter_id) {
                if ch.char_count > 0 || ch.versions > 0 {
                    return Err(format!("章节内容文件缺失 {}: 《{}》", path.display(), ch.title));
                }
            }
        }
        Ok(ChapterContent {
            chapter_id: chapter_id.to_string(),
            ..Default::default()
        })
    }

    /// 全书正文搜索：在 Rust 侧一次遍历本作品全部章节，返回命中列表。
    ///
    /// 为什么不让前端一章章调 `read_chapter`：
    /// `read_chapter` 返回的 JSON 带着整章所有历史版本（每章最多 200 份完整正文），
    /// 一百章的书搜一次就要跨 IPC 搬几千份快照；在 Rust 里直接扫则不经过前端。
    pub fn search_book(&self, book_id: &str, keyword: &str, max_per_chapter: usize) -> Result<Vec<SearchHit>, String> {
        let kw = keyword.trim();
        if kw.is_empty() {
            return Ok(Vec::new());
        }
        let book = self.book(book_id)?;
        let pat = kw.to_lowercase();
        let cap = max_per_chapter.max(1);
        let mut out = Vec::new();

        for vol in &book.volumes {
            for ch in &vol.chapters {
                let content = self.read_content(book_id, &ch.id)?.content;
                if content.is_empty() {
                    continue;
                }
                let matches = find_case_insensitive(&content, &pat, cap);
                if matches.is_empty() {
                    continue;
                }
                let (start, end) = matches[0];
                let (head, hit, tail) = snippet_around(&content, start, end, 24, 48);
                out.push(SearchHit {
                    chapter_id: ch.id.clone(),
                    chapter_title: ch.title.clone(),
                    volume_title: vol.title.clone(),
                    count: matches.len(),
                    head,
                    hit,
                    tail,
                });
            }
        }
        Ok(out)
    }

    pub fn write_content(&self, book_id: &str, content: &ChapterContent) -> Result<(), String> {
        let path = self.chapter_path(book_id, &content.chapter_id);
        write_json_atomic(&path, content)
    }

    // -- 书籍 CRUD ----------------------------------------------------------

    pub fn create_book(&mut self, title: &str, author: &str, genre: &str) -> Result<BookMeta, String> {
        let mut book = BookMeta {
            title: if title.trim().is_empty() { "未命名作品".into() } else { title.trim().into() },
            author: author.trim().into(),
            genre: genre.trim().into(),
            ..Default::default()
        };
        let first_chapter = Chapter {
            title: "第一章".into(),
            ..Default::default()
        };
        let first_volume = Volume {
            title: "第一卷".into(),
            chapters: vec![first_chapter.clone()],
            ..Default::default()
        };
        book.volumes.push(first_volume);

        fs::create_dir_all(self.book_dir(&book.id)).map_err(|e| e.to_string())?;
        fs::create_dir_all(self.content_dir(&book.id)).map_err(|e| e.to_string())?;
        self.write_content(
            &book.id,
            &ChapterContent {
                chapter_id: first_chapter.id.clone(),
                content: String::new(),
                updated_at: now_ms(),
                versions: Vec::new(),
            },
        )?;
        write_json_atomic(&self.cards_path(&book.id), &Vec::<Card>::new())?;

        self.registry.books.push(book.clone());
        self.save_book(&book)?;
        self.save_registry()?;
        Ok(book)
    }

    /// 创建示例作品（用于首次启动或自动化验收）。
    pub fn create_sample_book(&mut self) -> Result<BookMeta, String> {
        let mut book = BookMeta {
            title: "山有木兮".into(),
            author: "佚名".into(),
            genre: "古风 · 奇幻".into(),
            summary: "少年自北境雪原走出，携一卷残破山海图，寻回失落的四时之名。".into(),
            cover_color: "#5b6be1".into(),
            ..Default::default()
        };
        let c1_body = "\u{3000}\u{3000}北境的雪已经下了整整七日。\n\n\u{3000}\u{3000}沈照站在破庙门口，把最后半截松枝添进火堆。火光映着他手里的那卷羊皮——边角焦黑，只剩“山有木兮”四个古篆还算清晰。\n\n\u{3000}\u{3000}“天亮之前，得走出这片林子。”他对自己说。\n";
        let c2_body = "\u{3000}\u{3000}山道尽头有一座无人看守的石桥，桥下云雾翻涌，听不见水声。\n\n\u{3000}\u{3000}桥头立着一块风化的界碑，碑上刻着小字：入此门者，当忘旧名。\n";
        let c1 = Chapter {
            title: "第一章 残图".into(),
            summary: "破庙避雪，初见山海残图。".into(),
            status: "final".into(),
            char_count: count_text(c1_body).total,
            versions: 1,
            ..Default::default()
        };
        let c2 = Chapter {
            title: "第二章 无名桥".into(),
            summary: "踏入界碑，旧名将忘。".into(),
            status: "draft".into(),
            char_count: count_text(c2_body).total,
            versions: 1,
            ..Default::default()
        };
        let v1 = Volume {
            title: "第一卷 朔雪行".into(),
            summary: "自北境南下，入山海界。".into(),
            expanded: true,
            chapters: vec![c1.clone(), c2.clone()],
            ..Default::default()
        };
        book.volumes.push(v1);

        fs::create_dir_all(self.book_dir(&book.id)).map_err(|e| e.to_string())?;
        fs::create_dir_all(self.content_dir(&book.id)).map_err(|e| e.to_string())?;
        for (ch, body) in [(&c1, c1_body), (&c2, c2_body)] {
            let now = now_ms();
            let content = ChapterContent {
                chapter_id: ch.id.clone(),
                content: body.to_string(),
                updated_at: now,
                versions: vec![Version {
                    id: uuid::Uuid::new_v4().to_string(),
                    created_at: now,
                    kind: "manual".into(),
                    label: "初稿留存".into(),
                    chars: count_text(body).total,
                    content: body.to_string(),
                }],
            };
            self.write_content(&book.id, &content)?;
        }

        let mut fields = std::collections::BTreeMap::new();
        fields.insert("年龄".into(), "十七".into());
        fields.insert("信物".into(), "山海残图".into());
        let cards = vec![
            Card {
                kind: "character".into(),
                title: "沈照".into(),
                content: "北境猎户养子，性情沉静，识古篆。".into(),
                tags: vec!["主角".into(), "北境".into()],
                color: "#8ab4f8".into(),
                pinned: true,
                fields,
                ..Default::default()
            },
            Card {
                kind: "plot".into(),
                title: "四时失名".into(),
                content: "山海界每逢甲子便有一季之名被抹去，百姓随之遗忘那段岁月。".into(),
                tags: vec!["主线".into(), "世界观".into()],
                color: "#f5a623".into(),
                pinned: false,
                ..Default::default()
            },
            Card {
                kind: "inspiration".into(),
                title: "桥下无水声".into(),
                content: "不是因为深，而是桥下流淌的是尚未写完的年月。".into(),
                tags: vec!["意象".into()],
                color: "#7ad1a6".into(),
                pinned: false,
                ..Default::default()
            },
            Card {
                kind: "world".into(),
                title: "山海界碑".into(),
                content: "凡过界碑者，须以一件旧事换取通行；归来时若无人记得，便永留界内。".into(),
                tags: vec!["规则".into()],
                color: "#c792ea".into(),
                pinned: false,
                ..Default::default()
            },
        ];
        write_json_atomic(&self.cards_path(&book.id), &cards)?;

        self.registry.books.push(book.clone());
        self.save_book(&book)?;
        self.save_registry()?;
        Ok(book)
    }

    /// 供 `NOVEL_MANAGER_SELFTEST=1` 截图验收使用的示例作品：《青城剑歌》。
    /// 与前端原先的 `seed.js` 内容保持一致，启动即在 Rust 侧直接落盘，
    /// 无需等 WebView 跑完一串异步 IPC 再刷新界面。
    pub fn seed_selftest_book(&mut self) -> Result<BookMeta, String> {
        let mut book = BookMeta {
            title: "青城剑歌".into(),
            author: "林间客".into(),
            genre: "仙侠 · 武侠".into(),
            summary: "青城山下的一把旧铁剑，牵出三十年前蜀道断魂崖的旧案。".into(),
            cover_color: "#5b6be1".into(),
            ..Default::default()
        };
        let c1_body = [
            "\u{3000}\u{3000}雪落下来了。",
            "\u{3000}\u{3000}沈孤鸿站在青城山门前的石阶上，看着远处镇子里一盏接一盏亮起的灯火。北风沿着山脊刮过来，卷起他衣角的一片霜色。",
            "\u{3000}\u{3000}“你还是来了。”身后有人说话，声音很轻，却刚好压过风声。",
            "\u{3000}\u{3000}他没有回头，只是把右手按在那柄缠着旧布条的铁剑上：“我等这一天，等了整整十年。”",
            "\u{3000}\u{3000}石阶下的松林里走出一道青衫身影，手里提着一盏早已熄灭的纸灯笼。灯笼纸上用朱砂写着一个“陆”字，墨迹被雪水洇开，像一道未干的血痕。",
            "\u{3000}\u{3000}“十年前断魂崖那一战，活着下山的人只有三个。”青衫人停在七步之外，“掌门闭关，师叔远走西域，剩下的那一个——就是你师父。”",
            "\u{3000}\u{3000}沈孤鸿指节微微发白：“我师父三年前已经葬在后山。”",
            "\u{3000}\u{3000}“那口棺材里只有一柄断剑。”青衫人把纸灯笼放在雪地上，“真正的陆掌峰，上个月在洛阳城南出现过。”",
        ]
        .join("\n\n");
        let c2_body = "\u{3000}\u{3000}山腰的望云亭里有一口古钟，钟身裂了一道寸许宽的缝。\n\n\u{3000}\u{3000}守钟的老道士双目已盲，却能在风雪声里听出每一柄剑的来历。\n";
        let c3_body = "\u{3000}\u{3000}剑谱只剩最后三页，每一页背面都记着一个名字与一处地名。\n";
        let c1_prev = "\u{3000}\u{3000}雪落下来了。\n\n\u{3000}\u{3000}沈孤鸿站在青城山门前的石阶上，看着远处的灯火。\n\n\u{3000}\u{3000}“你还是来了。”身后有人说话。\n";

        let now = now_ms();
        let c1 = Chapter {
            title: "第一章 山门夜雪".into(),
            summary: "旧客携朱砂灯笼夜访青城，道出师父未死之秘。".into(),
            status: "published".into(),
            char_count: count_text(&c1_body).total,
            versions: 2,
            ..Default::default()
        };
        let c2 = Chapter {
            title: "第二章 断钟人".into(),
            summary: "望云亭盲眼道人辨剑识人。".into(),
            status: "revising".into(),
            char_count: count_text(c2_body).total,
            versions: 1,
            ..Default::default()
        };
        let c3 = Chapter {
            title: "第三章 残谱三页".into(),
            summary: "三页剑谱背后的名单。".into(),
            status: "outline".into(),
            char_count: count_text(c3_body).total,
            versions: 1,
            ..Default::default()
        };
        let v1 = Volume {
            title: "第一卷 风起青城".into(),
            summary: "".into(),
            expanded: true,
            chapters: vec![c1.clone(), c2.clone(), c3.clone()],
            ..Default::default()
        };
        let v2 = Volume {
            title: "第二卷 蜀道行".into(),
            summary: "".into(),
            expanded: true,
            chapters: Vec::new(),
            ..Default::default()
        };
        book.volumes.push(v1);
        book.volumes.push(v2);

        fs::create_dir_all(self.book_dir(&book.id)).map_err(|e| e.to_string())?;
        fs::create_dir_all(self.content_dir(&book.id)).map_err(|e| e.to_string())?;

        self.write_content(
            &book.id,
            &ChapterContent {
                chapter_id: c1.id.clone(),
                content: c1_body.clone(),
                updated_at: now,
                versions: vec![
                    Version {
                        id: uuid::Uuid::new_v4().to_string(),
                        created_at: now,
                        kind: "manual".into(),
                        label: "定稿 · 补入洛阳线索".into(),
                        chars: count_text(&c1_body).total,
                        content: c1_body,
                    },
                    Version {
                        id: uuid::Uuid::new_v4().to_string(),
                        created_at: now - 3600_000,
                        kind: "auto".into(),
                        label: "初稿".into(),
                        chars: count_text(c1_prev).total,
                        content: c1_prev.to_string(),
                    },
                ],
            },
        )?;
        for (ch, body) in [(&c2, c2_body), (&c3, c3_body)] {
            self.write_content(
                &book.id,
                &ChapterContent {
                    chapter_id: ch.id.clone(),
                    content: body.to_string(),
                    updated_at: now,
                    versions: vec![Version {
                        id: uuid::Uuid::new_v4().to_string(),
                        created_at: now,
                        kind: "auto".into(),
                        label: "自动存档".into(),
                        chars: count_text(body).total,
                        content: body.to_string(),
                    }],
                },
            )?;
        }

        let mut f1 = std::collections::BTreeMap::new();
        f1.insert("身份".into(), "青城弃徒".into());
        f1.insert("佩剑".into(), "无名铁剑（剑脊藏字）".into());
        f1.insert("目标".into(), "查清师父假死与断魂崖真相".into());
        let mut f2 = std::collections::BTreeMap::new();
        f2.insert("身份".into(), "旧友 / 暗线信使".into());
        f2.insert("信物".into(), "朱砂“陆”字纸灯笼".into());
        let cards = vec![
            Card {
                kind: "character".into(),
                title: "沈孤鸿".into(),
                content: "青城派掌峰弟子，沉静寡言。十年前师门变故后守山至今。".into(),
                tags: vec!["主角".into(), "剑客".into(), "青城".into()],
                color: "#8ab4f8".into(),
                pinned: true,
                fields: f1,
                ..Default::default()
            },
            Card {
                kind: "character".into(),
                title: "苏晚灯".into(),
                content: "提着熄灭纸灯笼登门的不速之客，知晓断魂崖之战的内情。".into(),
                tags: vec!["青衫客".into(), "洛阳线".into()],
                color: "#7ad1a6".into(),
                pinned: false,
                fields: f2,
                ..Default::default()
            },
            Card {
                kind: "plot".into(),
                title: "断魂崖旧案".into(),
                content: "三十年前蜀道截杀，三派高手尽殁，唯余三人生还；棺中空剑指向洛阳。".into(),
                tags: vec!["主线".into(), "伏笔".into()],
                color: "#f5a623".into(),
                pinned: true,
                ..Default::default()
            },
            Card {
                kind: "inspiration".into(),
                title: "盲眼听剑".into(),
                content: "每一柄剑出鞘时的风声都不一样，杀过人的剑会慢半拍。".into(),
                tags: vec!["意象".into(), "台词".into()],
                color: "#c792ea".into(),
                pinned: false,
                ..Default::default()
            },
            Card {
                kind: "world".into(),
                title: "青城七十二峰戒律".into(),
                content: "凡弟子下山，须在望云亭敲钟三声；钟裂之后，再无人敢敲第三声。".into(),
                tags: vec!["门派".into(), "规矩".into()],
                color: "#80deea".into(),
                pinned: false,
                ..Default::default()
            },
        ];
        write_json_atomic(&self.cards_path(&book.id), &cards)?;

        // 把“山有木兮”退到书架第二位，《青城剑歌》设为当前打开的作品
        self.registry.books.insert(0, book.clone());
        self.settings.last_book_id = book.id.clone();
        self.save_book(&book)?;
        self.save_registry()?;
        self.save_settings()?;
        Ok(book)
    }

    /// 供 `NOVEL_MANAGER_UITEST=1` 自动化验收使用的最小书架（只有一章空文）。
    pub fn reset_for_uitest(&mut self) -> Result<BookMeta, String> {
        for sub in ["books", "content", "trash"] {
            let p = self.root.join(sub);
            let _ = fs::remove_dir_all(&p);
            fs::create_dir_all(&p).map_err(|e| e.to_string())?;
        }
        self.registry.books.clear();
        self.settings.theme = "light".into();
        let book = self.create_book("验收作品", "测试作者", "武侠")?;
        self.settings.last_book_id = book.id.clone();
        self.save_settings()?;
        Ok(book)
    }

    pub fn update_book_meta(
        &mut self,
        book_id: &str,
        title: Option<String>,
        author: Option<String>,
        genre: Option<String>,
        summary: Option<String>,
        cover_color: Option<String>,
    ) -> Result<BookMeta, String> {
        let now = now_ms();
        let snapshot = {
            let book = self.book_mut(book_id)?;
            if let Some(t) = title {
                if !t.trim().is_empty() {
                    book.title = t.trim().into();
                }
            }
            if let Some(a) = author {
                book.author = a.trim().into();
            }
            if let Some(g) = genre {
                book.genre = g.trim().into();
            }
            if let Some(s) = summary {
                book.summary = s;
            }
            if let Some(c) = cover_color {
                if !c.trim().is_empty() {
                    book.cover_color = c;
                }
            }
            book.updated_at = now;
            book.clone()
        };
        self.persist_structure(book_id, snapshot.clone())?;
        Ok(snapshot)
    }

    pub fn reorder_volumes(&mut self, book_id: &str, order: &[String]) -> Result<(), String> {
        let snapshot = {
            let book = self.book_mut(book_id)?;
            let mut next = Vec::with_capacity(book.volumes.len());
            for id in order {
                if let Some(pos) = book.volumes.iter().position(|v| &v.id == id) {
                    next.push(book.volumes.remove(pos));
                }
            }
            next.append(&mut book.volumes);
            book.volumes = next;
            book.updated_at = now_ms();
            book.clone()
        };
        self.persist_structure(book_id, snapshot)
    }

    /// 如果作品没有任何卷/章，补齐一个默认卷与第一章，避免界面出现无法落笔的空壳。
    pub fn ensure_structure(&mut self, book_id: &str) -> Result<BookMeta, String> {
        let current = self.book(book_id)?;
        if !current.volumes.is_empty() {
            return Ok(current);
        }
        let ch = Chapter {
            title: "第一章".into(),
            ..Default::default()
        };
        let vol = Volume {
            title: "第一卷".into(),
            chapters: vec![ch.clone()],
            ..Default::default()
        };
        self.write_content(
            book_id,
            &ChapterContent {
                chapter_id: ch.id.clone(),
                content: String::new(),
                updated_at: now_ms(),
                versions: Vec::new(),
            },
        )?;
        let snapshot = {
            let b = self.book_mut(book_id)?;
            b.volumes.push(vol);
            b.updated_at = now_ms();
            b.clone()
        };
        self.persist_structure(book_id, snapshot.clone())?;
        Ok(snapshot)
    }

    /// 复制一本作品（测试或作为模板用）。
    pub fn duplicate_book(&mut self, book_id: &str) -> Result<BookMeta, String> {
        let src = self.book(book_id)?;
        let mut book = BookMeta {
            title: format!("{}（副本）", src.title),
            author: src.author.clone(),
            genre: src.genre.clone(),
            summary: src.summary.clone(),
            cover_color: src.cover_color.clone(),
            ..Default::default()
        };
        fs::create_dir_all(self.book_dir(&book.id)).map_err(|e| e.to_string())?;
        fs::create_dir_all(self.content_dir(&book.id)).map_err(|e| e.to_string())?;
        write_json_atomic(&self.cards_path(&book.id), &self.read_cards(book_id)?)?;
        book.volumes.push(Volume {
            title: "第一卷".into(),
            chapters: vec![Chapter {
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
        if !self
            .book(book_id)?
            .volumes
            .iter()
            .any(|v| v.chapters.iter().any(|c| c.id == chapter_id))
        {
            return Err(format!("找不到章节 {chapter_id}"));
        }
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

/// 在 `content` 里不区分大小写地查找 `pat_lower`（已是小写），
/// 返回原串里的 `(start_byte, end_byte)` 列表（最多 `cap` 条）。
/// 逐字符累加小写字节数来反查原串偏移，避免 `İ` 等变长小写字符越界。
fn find_case_insensitive(content: &str, pat_lower: &str, cap: usize) -> Vec<(usize, usize)> {
    if pat_lower.is_empty() {
        return Vec::new();
    }
    let hay = content.to_lowercase();
    let mut hits = Vec::new();
    let mut from = 0usize;
    while from <= hay.len() && hits.len() < cap {
        let Some(rel) = hay[from..].find(pat_lower) else { break };
        let abs = from + rel;
        let end_abs = abs + pat_lower.len();
        let mut consumed = 0usize;
        let mut orig_start: Option<usize> = None;
        let mut orig_end = content.len();
        for (byte, ch) in content.char_indices() {
            if orig_start.is_none() && consumed >= abs {
                orig_start = Some(byte);
            }
            if consumed >= end_abs {
                orig_end = byte;
                break;
            }
            consumed += ch.to_lowercase().map(char::len_utf8).sum::<usize>();
        }
        let s = orig_start.unwrap_or(content.len());
        if s <= orig_end && orig_end <= content.len() {
            hits.push((s, orig_end));
        }
        from = end_abs.max(from + 1);
    }
    hits
}

/// 取 `content[start..end]` 前 `before_chars` 个字符与后 `after_chars` 个字符，
/// 把换行替换成空格，方便在搜索结果列表里单行展示。
fn snippet_around(
    content: &str,
    start: usize,
    end: usize,
    before_chars: usize,
    after_chars: usize,
) -> (String, String, String) {
    let head_full = &content[..start];
    let hit = content[start..end].replace('\n', " ");
    let tail_full = &content[end..];
    let head: String = head_full
        .chars()
        .rev()
        .take(before_chars)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>()
        .replace('\n', " ");
    let tail: String = tail_full.chars().take(after_chars).collect::<String>().replace('\n', " ");
    (head, hit, tail)
}

#[cfg(test)]
mod reliability_tests {
    use super::*;
    use std::path::Path;

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

        // --data-dir 指定或移动端固定目录 → 从来不问，也不允许界面改
        let forced = location_info(&other, &config, true);
        assert!(forced.is_forced && !forced.needs_choice);
    }

    #[test]
    fn mobile_app_data_dir_isolates_manuscripts_from_webview_cache() {
        let ws = Workspace::new();
        let android_data = ws.0.join("com.heartwrite.novelmanager");
        fs::create_dir_all(android_data.join("cache")).unwrap();
        fs::create_dir_all(android_data.join("app_webview")).unwrap();

        // 移动端全新启动：应隔离到 manuscripts 子目录，避开 WebView 缓存目录
        let resolved = resolve_app_data_dir(Some(android_data.clone()), true);
        assert_eq!(resolved, android_data.join("manuscripts"));
        let mut store = Store::load(resolved.clone()).unwrap();
        let (book_id, _) = draft(&mut store);
        assert_eq!(store.book(&book_id).unwrap().title, "测试作品");

        // 若顶层已经有老版本留下的 books.json，则兼容保留在原位
        fs::write(android_data.join("books.json"), b"{\"books\":[]}").unwrap();
        assert_eq!(resolve_app_data_dir(Some(android_data.clone()), true), android_data);
    }

    #[test]
    fn storage_location_validation_catches_the_dangerous_choices() {
        let ws = Workspace::new();
        let base = &ws.0;
        let current = base.join("current");
        fs::create_dir_all(&current).unwrap();

        // 原地不动、互相嵌套、空路径都要挡住
        assert!(validate_new_location(&current, &current).is_err());
        assert!(is_same_location(&current, &current));
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
