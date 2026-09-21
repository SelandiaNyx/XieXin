//! 内置自检：用真实数据目录跑一遍“建书 → 写作 → 版本 → 排版 → 导出 → 卡片”全流程。
//! 通过 `--smoke-test` 启动或前端命令 `dev_smoke_test` 触发。

use crate::export::{run_export, ExportOptions};
use crate::storage::{Card, Store};
use crate::text::{count_text, smart_format, FormatRule};
use std::collections::BTreeMap;

fn line(tag: &str, msg: impl AsRef<str>) -> String {
    format!("[{tag}] {}", msg.as_ref())
}

pub fn run(store: &mut Store) -> Result<String, String> {
    run_inner(store)
}

fn run_inner(store: &mut Store) -> Result<String, String> {
    let mut log: Vec<String> = Vec::new();
    log.push(line("env", format!("数据目录 {}", store.root.display())));

    // 失败时把已完成的步骤一起输出，方便定位断在哪一步
    macro_rules! fail {
        ($($arg:tt)*) => {{
            let message = format!($($arg)*);
            return Err(format!("{}\n[FAIL] {message}\n[status] FAILED", log.join("\n")));
        }};
    }

    let book = store.create_book("自检作品", "测试作者", "玄幻")?;
    log.push(line("book", format!("创建《{}》 id={}", book.title, book.id)));

    let ch_id = book
        .volumes
        .first()
        .and_then(|v| v.chapters.first())
        .map(|c| c.id.clone())
        .ok_or("缺少默认章节")?;

    let vol2 = store.add_volume(&book.id, "")?;
    log.push(line("volume", format!("新增卷 {}", vol2.title)));
    let ch2 = store.add_chapter(&book.id, &vol2.id, "")?;
    log.push(line("chapter", format!("新增章 {}", ch2.title)));

    // ---- 写作与保存 -----------------------------------------------------
    let body1 = "第一章 落雪\n\n雪落下来了。\n他站在城墙上，看着远处。\n\n风很大。\n";
    let s1 = store.save_chapter(
        &book.id,
        &ch_id,
        body1,
        Some("第一章 落雪".into()),
        None,
        None,
        true,
        "初始稿",
        "manual",
    )?;
    log.push(line(
        "save",
        format!(
            "首次保存 字数={} 版本={} 新建版本={}",
            s1.char_count, s1.versions, s1.created_version
        ),
    ));
    if s1.char_count != count_text(body1).total {
        fail!("字数统计不一致：{} != {}", s1.char_count, count_text(body1).total);
    }
    if s1.versions != 1 {
        fail!("首次保存应生成 1 个版本，实际 {}", s1.versions);
    }

    let body2 = format!("{body1}\n新增一段：{}", "测试内容".repeat(40));
    let s2 = store.save_chapter(&book.id, &ch_id, &body2, None, None, None, true, "第二稿", "manual")?;
    log.push(line("save", format!("二次保存 字数={} 版本={}", s2.char_count, s2.versions)));
    if s2.versions != 2 {
        fail!("版本快照未累积，实际 {}", s2.versions);
    }
    if s2.char_count != count_text(&body2).total {
        fail!("二次保存字数不一致：{} != {}", s2.char_count, count_text(&body2).total);
    }

    // ---- 一键排版 -------------------------------------------------------
    let messy = "第一章 落雪\n\n\n\n   雪落下来了。   \n\n\n\n他站在城墙上。\n";
    let formatted = smart_format(messy, FormatRule::CjkIndent, None, false);
    if !formatted.contains("\u{3000}\u{3000}雪落下来了。") {
        fail!("一键排版未加段首缩进: {formatted:?}");
    }
    if formatted.contains("\n\n\n") {
        fail!("一键排版未合并多余空行: {formatted:?}");
    }
    if formatted.contains("   ") {
        fail!("一键排版未清理行尾空格: {formatted:?}");
    }
    let with_title = smart_format("正文第一段。\n", FormatRule::CjkIndent, Some("第一章 起"), true);
    if !with_title.starts_with("第一章 起\n") {
        fail!("一键排版未补章节标题: {with_title:?}");
    }
    log.push(line("format", format!("排版后 {} 字", count_text(&formatted).total)));

    // ---- 历史版本：新版本保存的是“改动前”的正文 -------------------------
    let versions = store.list_versions(&book.id, &ch_id);
    log.push(line("versions", format!("共 {} 个历史版本", versions.len())));
    if versions.len() != 2 {
        fail!("应有 2 个历史版本，实际 {}", versions.len());
    }
    let newest = versions.first().ok_or("版本列表为空")?;
    let detail = store
        .version_content(&book.id, &ch_id, &newest.id)
        .ok_or("读取版本内容失败")?;
    if detail.content != body1 {
        fail!(
            "最新历史版本应为第二次保存前的正文（{} 字节），实际 {} 字节",
            body1.len(),
            detail.content.len()
        );
    }
    log.push(line("version", "最新版本内容 = 第二次保存前的正文"));

    let restored = store.restore_version(&book.id, &ch_id, &newest.id)?;
    log.push(line(
        "restore",
        format!("回滚完成 字数={} 版本={}", restored.char_count, restored.versions),
    ));
    if restored.char_count != count_text(body1).total {
        fail!("回滚后字数应为 {}，实际 {}", count_text(body1).total, restored.char_count);
    }
    if store.read_content(&book.id, &ch_id).content != body1 {
        fail!("回滚后正文与所选历史版本不一致");
    }

    // ---- 卡片 -----------------------------------------------------------
    let mut fields = BTreeMap::new();
    fields.insert("身份".to_string(), "剑客".to_string());
    let card = store.upsert_card(
        &book.id,
        Card {
            kind: "character".into(),
            title: "沈孤鸿".into(),
            content: "主角，沉默寡言。".into(),
            tags: vec!["主角".into(), "剑客".into()],
            fields,
            ..Default::default()
        },
    )?;
    store.upsert_card(
        &book.id,
        Card {
            kind: "plot".into(),
            title: "雪夜伏击".into(),
            content: "第 3 章伏笔回收。".into(),
            ..Default::default()
        },
    )?;
    let cards = store.read_cards(&book.id);
    log.push(line("cards", format!("卡片 {} 张，首张={}", cards.len(), card.title)));
    if cards.len() != 2 {
        fail!("卡片数量不正确：{}", cards.len());
    }

    // ---- 导出五种格式（含 EPUB 电子书）---------------------------------
    let out_dir = store.root.join("exports").join("smoke");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    for fmt in ["txt", "md", "html", "json", "epub"] {
        let opt = ExportOptions {
            format: fmt.into(),
            file_path: out_dir.join(format!("smoke.{fmt}")).to_string_lossy().to_string(),
            use_dialog: false,
            ..Default::default()
        };
        let res = run_export(store, &book.id, &opt)?;
        let exists = std::path::Path::new(&res.path).is_file();
        log.push(line(
            "export",
            format!(
                "{} -> {} ({} 字节, {} 章, 文件存在={})",
                fmt, res.path, res.bytes, res.chapters, exists
            ),
        ));
        if !exists || res.bytes == 0 {
            fail!("导出 {fmt} 失败");
        }
        if fmt == "epub" {
            // 校验 EPUB 是合法 ZIP 且以 mimetype 开头
            let bytes = std::fs::read(&res.path).map_err(|e| e.to_string())?;
            if &bytes[0..4] != b"PK\x03\x04" {
                fail!("EPUB 不是合法的 ZIP 容器");
            }
            let head = &bytes[30..30 + 8.min(bytes.len().saturating_sub(30))];
            if head != b"mimetype" {
                fail!("EPUB 第一个条目不是 mimetype");
            }
            let tail = &bytes[bytes.len() - 22..bytes.len() - 18];
            if tail != b"PK\x05\x06" {
                fail!("EPUB 缺少中央目录结束记录");
            }
            log.push(line("epub", format!("ZIP 结构校验通过（{} 字节）", bytes.len())));
        }
        if fmt == "json" {
            let raw = std::fs::read_to_string(&res.path).map_err(|e| e.to_string())?;
            if !raw.contains("\"kind\": \"heartwrite-novel-backup\"") {
                fail!("JSON 备份缺少标识字段");
            }
        }
    }

    // ---- 统计（重新从磁盘读取，确保目录树与正文一致）--------------------
    let live_book = store.book(&book.id).map_err(|e| e.to_string())?;
    let stats = store.book_stats(&live_book);
    log.push(line(
        "stats",
        format!(
            "总字数={} 今日={} 章节={} 卷={} 卡片={} 版本={}",
            stats.char_count, stats.today_chars, stats.chapters, stats.volumes, stats.cards, stats.versions
        ),
    ));
    if stats.chapters != 2 {
        fail!("章节统计错误：{}", stats.chapters);
    }
    if stats.cards != 2 {
        fail!("卡片统计错误：{}", stats.cards);
    }
    if stats.char_count == 0 {
        fail!("总字数为 0");
    }

    // ---- 导入 TXT -------------------------------------------------------
    let import_src = "\u{FEFF}第一章 导入一\n内容甲。\n\n第二章 导入二\n内容乙。\n";
    let imported = store.import_text(&book.id, &vol2.id, import_src, "")?;
    log.push(line("import", format!("按标题切分出 {imported} 章")));
    if imported != 2 {
        fail!("导入分章数量应为 2，实际 {imported}");
    }

    // ---- 回收站 ---------------------------------------------------------
    let trash_before = store.list_trash().len();
    let target_ch = store
        .book(&book.id)?
        .volumes
        .iter()
        .flat_map(|v| v.chapters.iter())
        .map(|c| c.id.clone())
        .next()
        .ok_or("没有可删除的章节")?;    store.delete_chapter(&book.id, &target_ch)?;
    let trash_after = store.list_trash().len();
    log.push(line(
        "trash",
        format!("删除章节后回收站 {} -> {} 项", trash_before, trash_after),
    ));
    if trash_after <= trash_before {
        fail!("删除章节后应移入回收站");
    }

    // ---- 重载校验（模拟重启应用）：核对保留下来的章节正文与回收站 ---------
    let reload_root = store.root.clone();
    let reopened = Store::load(reload_root).map_err(|e| format!("重新加载数据失败: {e}"))?;
    let books = reopened.registry.books.len();
    let rebook = reopened.book(&book.id).map_err(|e| e.to_string())?;
    let kept: Vec<(String, String, usize)> = rebook
        .volumes
        .iter()
        .flat_map(|v| {
            v.chapters
                .iter()
                .map(|c| (c.id.clone(), c.title.clone(), c.char_count))
        })
        .collect();
    if kept.iter().any(|(id, _, _)| id == &target_ch) {
        fail!("被删除的章节仍在目录树中");
    }
    let (survivor, survivor_title, survivor_chars) = kept
        .iter()
        .max_by_key(|(_, _, n)| *n)
        .cloned()
        .ok_or("删除后应仍有章节")?;
    let re_content = reopened.read_content(&book.id, &survivor).content;
    let re_trash = reopened.list_trash().len();
    log.push(line(
        "reload",
        format!(
            "重新加载：书架 {} 本，《{}》{} 卷 {} 章，回收站 {} 项，最长幸存章节《{}》目录 {} 字 / 正文 {} 字",
            books,
            rebook.title,
            rebook.volumes.len(),
            kept.len(),
            re_trash,
            survivor_title,
            survivor_chars,
            count_text(&re_content).total
        ),
    ));
    if re_content.trim().is_empty() || survivor_chars == 0 {
        fail!("重新加载后导入章节正文为空");
    }
    if count_text(&re_content).total != survivor_chars {
        fail!(
            "重新加载后目录字数（{}）与正文实际字数（{}）不一致",
            survivor_chars,
            count_text(&re_content).total
        );
    }
    if re_trash == 0 {
        fail!("重新加载后回收站记录丢失");
    }

    log.push(line("result", "全部通过"));
    Ok(log.join("\n"))
}
