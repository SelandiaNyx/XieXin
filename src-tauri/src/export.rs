//! 本地导出：TXT / Markdown / HTML / JSON 备份，以及最近导出记录。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::storage::{sanitize_filename, BookMeta, Store};
use crate::text::{count_text, format_ms, now_iso, now_ms};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ExportOptions {
    pub format: String,          // txt | md | html | json | epub
    pub include_volume_title: bool,
    pub include_chapter_title: bool,
    pub include_meta_header: bool,
    pub indent_paragraphs: bool,
    /// EPUB 元数据
    pub epub_title: String,
    pub epub_author: String,
    pub epub_language: String,
    /// 仅导出单章时的章节 id（可选）
    pub chapter_id: String,
    pub volume_id: String,
    pub file_path: String,
    pub use_dialog: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            format: "txt".into(),
            include_volume_title: true,
            include_chapter_title: true,
            include_meta_header: true,
            indent_paragraphs: true,
            epub_title: String::new(),
            epub_author: String::new(),
            epub_language: "zh-CN".into(),
            chapter_id: String::new(),
            volume_id: String::new(),
            file_path: String::new(),
            use_dialog: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub bytes: u64,
    pub chars: usize,
    pub format: String,
    pub chapters: usize,
    pub exported_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentExport {
    pub path: String,
    pub format: String,
    pub bytes: u64,
    pub at: i64,
}

fn esc_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn body_paragraphs(content: &str, indent: bool) -> Vec<String> {
    content
        .replace("\r\n", "\n")
        .split('\n')
        .map(|l| l.trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n")
        .split("\n\n")
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .map(|p| if indent { p } else { p.trim_start_matches(['\u{3000}', ' ']).to_string() })
        .collect()
}

fn render_txt(book: &BookMeta, store: &Store, opt: &ExportOptions) -> (String, usize) {
    let mut out = String::new();
    let mut chapters = 0usize;
    if opt.include_meta_header {
        out.push_str(&format!("《{}》\n", book.title));
        if !book.author.is_empty() {
            out.push_str(&format!("作者：{}\n", book.author));
        }
        if !book.genre.is_empty() {
            out.push_str(&format!("类型：{}\n", book.genre));
        }
        let stats = store.book_stats(book);
        out.push_str(&format!(
            "总字数：{}　章节：{}　导出时间：{}\n",
            stats.char_count,
            stats.chapters,
            format_ms(now_ms())
        ));
        if !book.summary.trim().is_empty() {
            out.push_str(&format!("\n【简介】\n{}\n", book.summary.trim()));
        }
        out.push_str("\n\n");
    }
    for vol in &book.volumes {
        if !opt.volume_id.is_empty() && vol.id != opt.volume_id {
            continue;
        }
        if opt.include_volume_title {
            out.push_str(&format!("{}\n\n", vol.title));
        }
        for ch in &vol.chapters {
            if !opt.chapter_id.is_empty() && ch.id != opt.chapter_id {
                continue;
            }
            if opt.include_chapter_title {
                out.push_str(&format!("{}\n\n", ch.title));
            }
            let content = store.read_content(&book.id, &ch.id).content;
            chapters += 1;
            for p in body_paragraphs(&content, opt.indent_paragraphs) {
                out.push_str(&p);
                out.push('\n');
            }
            out.push_str("\n\n");
        }
    }
    (out, chapters)
}

fn render_md(book: &BookMeta, store: &Store, opt: &ExportOptions) -> (String, usize) {
    let mut out = String::new();
    let mut chapters = 0usize;
    if opt.include_meta_header {
        out.push_str(&format!("# 《{}》\n\n", book.title));
        if !book.author.is_empty() {
            out.push_str(&format!("- 作者：{}\n", book.author));
        }
        if !book.genre.is_empty() {
            out.push_str(&format!("- 类型：{}\n", book.genre));
        }
        let stats = store.book_stats(book);
        out.push_str(&format!("- 总字数：{}\n- 章节数：{}\n\n", stats.char_count, stats.chapters));
        if !book.summary.trim().is_empty() {
            out.push_str(&format!("> {}\n\n", book.summary.trim().replace('\n', "\n> ")));
        }
        out.push_str("---\n\n");
    }
    for vol in &book.volumes {
        if !opt.volume_id.is_empty() && vol.id != opt.volume_id {
            continue;
        }
        if opt.include_volume_title {
            out.push_str(&format!("## {}\n\n", vol.title));
        }
        for ch in &vol.chapters {
            if !opt.chapter_id.is_empty() && ch.id != opt.chapter_id {
                continue;
            }
            if opt.include_chapter_title {
                out.push_str(&format!("### {}\n\n", ch.title));
            }
            let content = store.read_content(&book.id, &ch.id).content;
            chapters += 1;
            for p in body_paragraphs(&content, false) {
                out.push_str(&format!("{}\n\n", p));
            }
        }
    }
    (out, chapters)
}

fn render_html(book: &BookMeta, store: &Store, opt: &ExportOptions) -> (String, usize) {
    let mut out = String::new();
    let mut chapters = 0usize;
    out.push_str("<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n");
    out.push_str(&format!("<title>{}</title>\n", esc_html(&book.title)));
    out.push_str(
        "<style>\n\
         :root{--ink:#1c1c1e;--muted:#6b6b76;}\n\
         body{margin:0;background:#f6f5f2;color:var(--ink);}\n\
         .page{max-width:46rem;margin:0 auto;padding:3rem 1.6rem 6rem;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);}\n\
         h1{font-size:2rem;text-align:center;letter-spacing:.1em;}\n\
         h2{margin-top:2.6rem;font-size:1.3rem;border-left:4px solid #7c6bd6;padding-left:.6rem;}\n\
         h3{margin-top:2rem;font-size:1.05rem;color:#4b4b57;}\n\
         p{font-size:1.05rem;line-height:2;text-indent:2em;margin:.7em 0;}\n\
         .meta{color:var(--muted);text-align:center;font-size:.9rem;}\n\
         .summary{background:#faf9f7;border:1px dashed #ddd;padding:1rem;text-indent:0;}\n\
         hr{border:none;border-top:1px solid #eee;margin:2rem 0;}\n\
         </style>\n</head>\n<body>\n<div class=\"page\">\n",
    );
    out.push_str(&format!("<h1>《{}》</h1>\n", esc_html(&book.title)));
    if opt.include_meta_header {
        let mut meta = Vec::new();
        if !book.author.is_empty() {
            meta.push(format!("作者：{}", esc_html(&book.author)));
        }
        if !book.genre.is_empty() {
            meta.push(format!("类型：{}", esc_html(&book.genre)));
        }
        let stats = store.book_stats(book);
        meta.push(format!("总字数：{}", stats.char_count));
        meta.push(format!("章节：{}", stats.chapters));
        out.push_str(&format!("<p class=\"meta\">{}</p>\n", meta.join(" · ")));
        if !book.summary.trim().is_empty() {
            out.push_str(&format!(
                "<p class=\"summary\">{}</p>\n",
                esc_html(book.summary.trim()).replace('\n', "<br>")
            ));
        }
        out.push_str("<hr>\n");
    }
    for vol in &book.volumes {
        if !opt.volume_id.is_empty() && vol.id != opt.volume_id {
            continue;
        }
        if opt.include_volume_title {
            out.push_str(&format!("<h2>{}</h2>\n", esc_html(&vol.title)));
        }
        for ch in &vol.chapters {
            if !opt.chapter_id.is_empty() && ch.id != opt.chapter_id {
                continue;
            }
            if opt.include_chapter_title {
                out.push_str(&format!("<h3>{}</h3>\n", esc_html(&ch.title)));
            }
            let content = store.read_content(&book.id, &ch.id).content;
            chapters += 1;
            for p in body_paragraphs(&content, false) {
                out.push_str(&format!("<p>{}</p>\n", esc_html(&p).replace('\n', "<br>")));
            }
        }
    }
    out.push_str("</div>\n</body>\n</html>\n");
    (out, chapters)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupPayload<'a> {    kind: &'a str,
    version: &'a str,
    exported_at: i64,
    book: &'a BookMeta,
    cards: Vec<crate::storage::Card>,
    chapters: Vec<BackupChapter>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupChapter {
    id: String,
    title: String,
    content: String,
    versions: Vec<crate::storage::Version>,
}

fn render_json(book: &BookMeta, store: &Store) -> Result<(String, usize), String> {
    let mut chapters = Vec::new();
    for vol in &book.volumes {
        for ch in &vol.chapters {
            let c = store.read_content(&book.id, &ch.id);
            chapters.push(BackupChapter {
                id: ch.id.clone(),
                title: ch.title.clone(),
                content: c.content,
                versions: c.versions,
            });
        }
    }
    let payload = BackupPayload {
        kind: "heartwrite-novel-backup",
        version: env!("CARGO_PKG_VERSION"),
        exported_at: now_ms(),
        book,
        cards: store.read_cards(&book.id),
        chapters,
    };
    let n = payload.chapters.len();
    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    Ok((body, n))
}

/// 生成 EPUB 3 电子书（ZIP 结构，含 mimetype / container.xml / OPF / NAV / 各章 XHTML）。
fn render_epub(book: &BookMeta, store: &Store, opt: &ExportOptions) -> Result<(Vec<u8>, usize), String> {
    use crate::zip::ZipWriter;

    let title = if opt.epub_title.trim().is_empty() {
        book.title.clone()
    } else {
        opt.epub_title.trim().to_string()
    };
    let author = if opt.epub_author.trim().is_empty() {
        if book.author.trim().is_empty() {
            "佚名".to_string()
        } else {
            book.author.clone()
        }
    } else {
        opt.epub_author.trim().to_string()
    };
    let lang = if opt.epub_language.trim().is_empty() {
        "zh-CN".to_string()
    } else {
        opt.epub_language.trim().to_string()
    };
    let uid = format!("urn:heartwrite:{}", book.id);
    let modified = crate::text::format_ms(now_ms()).replace(' ', "T");

    // 收集章节
    struct Item {
        id: String,
        title: String,
        vol_title: String,
        html_body: String,
    }
    let mut items: Vec<Item> = Vec::new();
    for vol in &book.volumes {
        if !opt.volume_id.is_empty() && vol.id != opt.volume_id {
            continue;
        }
        for ch in &vol.chapters {
            if !opt.chapter_id.is_empty() && ch.id != opt.chapter_id {
                continue;
            }
            let content = store.read_content(&book.id, &ch.id).content;
            let mut body = String::new();
            if opt.include_chapter_title {
                body.push_str(&format!("<h2>{}</h2>\n", esc_html(&ch.title)));
            }
            for p in body_paragraphs(&content, false) {
                body.push_str(&format!("<p>{}</p>\n", esc_html(&p).replace('\n', "<br/>")));
            }
            items.push(Item {
                id: format!("chap{:03}", items.len() + 1),
                title: ch.title.clone(),
                vol_title: vol.title.clone(),
                html_body: body,
            });
        }
    }
    if items.is_empty() {
        return Err("没有可导出的章节".into());
    }

    let css = "body{font-family:serif;line-height:1.9;margin:0;padding:0 0.6em;}\n\
               h1{font-size:1.5em;text-align:center;margin:1.4em 0 1em;}\n\
               h2{font-size:1.2em;margin:1.4em 0 0.8em;}\n\
               p{text-indent:2em;margin:0.6em 0;}\n\
               .meta{text-align:center;color:#666;text-indent:0;}\n\
               .summary{color:#444;text-indent:0;background:#f6f6f4;padding:0.8em;}\n\
               .vol{text-align:center;font-size:1.3em;margin:2em 0 1em;}\n";

    let mut zip = ZipWriter::new();
    // mimetype 必须是第一个条目且不压缩
    zip.add("mimetype", "application/epub+zip");
    zip.add(
        "META-INF/container.xml",
        r#"<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#,
    );
    zip.add("OEBPS/style.css", css);

    // 封面页 / 书名页
    let mut front = String::from(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n\
         <html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"",
    );
    front.push_str(&lang);
    front.push_str("\"><head><title>");
    front.push_str(&esc_html(&title));
    front.push_str("</title><link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\"/></head><body>");
    front.push_str(&format!("<h1>{}</h1>", esc_html(&title)));
    front.push_str(&format!("<p class=\"meta\">{}</p>", esc_html(&author)));
    if !book.summary.trim().is_empty() {
        front.push_str(&format!(
            "<p class=\"summary\">{}</p>",
            esc_html(book.summary.trim()).replace('\n', "<br/>")
        ));
    }
    front.push_str("</body></html>\n");
    zip.add("OEBPS/front.xhtml", front);

    // 各章
    let mut nav_points = String::new();
    for it in &items {
        let mut doc = String::from(
            "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n\
             <html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"",
        );
        doc.push_str(&lang);
        doc.push_str("\"><head><title>");
        doc.push_str(&esc_html(&it.title));
        doc.push_str("</title><link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\"/></head><body>");
        doc.push_str(&it.html_body);
        doc.push_str("</body></html>\n");
        zip.add(format!("OEBPS/{}.xhtml", it.id), doc);
        nav_points.push_str(&format!(
            "      <li><a href=\"{}.xhtml\">{}</a></li>\n",
            it.id,
            esc_html(&it.title)
        ));
    }

    let nav = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n\
         <html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"{lang}\">\
         <head><title>目录</title><link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\"/></head><body>\
         <nav epub:type=\"toc\" id=\"toc\"><h1>目录</h1><ol>\n\
         <li><a href=\"front.xhtml\">{title}</a></li>\n{nav_points}</ol></nav></body></html>\n",
        lang = lang,
        title = esc_html(&title),
        nav_points = nav_points
    );
    zip.add("OEBPS/nav.xhtml", nav);

    // OPF
    let mut manifest = String::new();
    let mut spine = String::new();
    manifest.push_str("    <item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n");
    manifest.push_str("    <item id=\"css\" href=\"style.css\" media-type=\"text/css\"/>\n");
    manifest.push_str("    <item id=\"front\" href=\"front.xhtml\" media-type=\"application/xhtml+xml\"/>\n");
    spine.push_str("    <itemref idref=\"front\"/>\n");
    for it in &items {
        manifest.push_str(&format!(
            "    <item id=\"{id}\" href=\"{id}.xhtml\" media-type=\"application/xhtml+xml\"/>\n",
            id = it.id
        ));
        spine.push_str(&format!("    <itemref idref=\"{}\"/>\n", it.id));
    }

    let volume_note = if opt.include_volume_title {
        let vols: Vec<String> = {
            let mut seen = Vec::new();
            for it in &items {
                if !it.vol_title.is_empty() && !seen.contains(&it.vol_title) {
                    seen.push(it.vol_title.clone());
                }
            }
            seen
        };
        format!(
            "    <meta property=\"dcterms:modified\">{modified}</meta>\n    <meta name=\"heartwrite:volumes\" content=\"{}\"/>\n",
            esc_html(&vols.join(" / "))
        )
    } else {
        format!("    <meta property=\"dcterms:modified\">{modified}</meta>\n")
    };

    let opf = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
         <package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"bookid\" xml:lang=\"{lang}\">\n\
         \x20 <metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n\
         \x20   <dc:identifier id=\"bookid\">{uid}</dc:identifier>\n\
         \x20   <dc:title>{title}</dc:title>\n\
         \x20   <dc:creator>{author}</dc:creator>\n\
         \x20   <dc:language>{lang}</dc:language>\n\
         \x20   <dc:publisher>写心</dc:publisher>\n\
         {volume_note}\
         \x20 </metadata>\n\
         \x20 <manifest>\n{manifest}\x20 </manifest>\n\
         \x20 <spine>\n{spine}\x20 </spine>\n\
         </package>\n",
        lang = lang,
        uid = esc_html(&uid),
        title = esc_html(&title),
        author = esc_html(&author),
        volume_note = volume_note,
        manifest = manifest,
        spine = spine
    );
    zip.add("OEBPS/content.opf", opf);

    let count = items.len();
    Ok((zip.finish(), count))
}

pub fn render(book: &BookMeta, store: &Store, opt: &ExportOptions) -> Result<(String, usize, String), String> {
    let format = opt.format.to_lowercase();
    match format.as_str() {
        "md" | "markdown" => {
            let (s, n) = render_md(book, store, opt);
            Ok((s, n, "md".into()))
        }
        "html" | "htm" => {
            let (s, n) = render_html(book, store, opt);
            Ok((s, n, "html".into()))
        }
        "json" | "backup" => {
            let (s, n) = render_json(book, store)?;
            Ok((s, n, "json".into()))
        }
        _ => {
            let (s, n) = render_txt(book, store, opt);
            Ok((s, n, "txt".into()))
        }
    }
}

fn default_name(book: &BookMeta, opt: &ExportOptions, ext: &str) -> String {
    let base = sanitize_filename(&book.title, "novel");
    if !opt.chapter_id.is_empty() {
        if let Some(ch) = book
            .volumes
            .iter()
            .flat_map(|v| v.chapters.iter())
            .find(|c| c.id == opt.chapter_id)
        {
            return format!("{}-{}-{}.{}", base, sanitize_filename(&ch.title, "chapter"), now_iso(), ext);
        }
    }
    if !opt.volume_id.is_empty() {
        if let Some(vol) = book.volumes.iter().find(|v| v.id == opt.volume_id) {
            return format!("{}-{}-{}.{}", base, sanitize_filename(&vol.title, "volume"), now_iso(), ext);
        }
    }
    format!("{}-{}.{}", base, now_iso(), ext)
}

fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let p = Path::new(filename);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    for i in 1..1000 {
        let name = if ext.is_empty() {
            format!("{stem}({i})")
        } else {
            format!("{stem}({i}).{ext}")
        };
        let c = dir.join(name);
        if !c.exists() {
            return c;
        }
    }
    candidate
}

pub fn run_export(store: &Store, book_id: &str, opt: &ExportOptions) -> Result<ExportResult, String> {
    let book = store.book(book_id)?;
    let format = opt.format.to_lowercase();
    let (data, chars, chapters, ext): (Vec<u8>, usize, usize, String) = if format == "epub" {
        let (bytes, chapters) = render_epub(&book, store, opt)?;
        let chars = store.book_stats(&book).char_count;
        (bytes, chars, chapters, "epub".into())
    } else {
        let (body, chapters, ext) = render(&book, store, opt)?;
        let chars = count_text(&body).total;
        let mut data = body.into_bytes();
        // 给 Windows 记事本加上 UTF-8 BOM，中文才不乱码
        if ext == "txt" {
            let mut with_bom = vec![0xEF, 0xBB, 0xBF];
            with_bom.append(&mut data);
            data = with_bom;
        }
        (data, chars, chapters, ext)
    };

    let target: PathBuf = if !opt.file_path.trim().is_empty() {
        PathBuf::from(opt.file_path.trim())
    } else {
        let dir = if !store.settings.last_export_dir.trim().is_empty() {
            PathBuf::from(store.settings.last_export_dir.trim())
        } else {
            store.root.join("exports")
        };
        fs::create_dir_all(&dir).map_err(|e| format!("无法创建导出目录: {e}"))?;
        unique_path(&dir, &default_name(&book, opt, &ext))
    };

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建目录 {}: {e}", parent.display()))?;
    }
    fs::write(&target, &data).map_err(|e| format!("写入失败 {}: {e}", target.display()))?;
    let bytes = data.len() as u64;
    let path_str = target.to_string_lossy().to_string();
    Ok(ExportResult {
        path: path_str,
        bytes,
        chars,
        format: ext,
        chapters,
        exported_at: now_ms(),
    })
}

/// 弹出系统"另存为"对话框，返回用户选择的路径。
pub fn pick_save_path(default_name: &str, ext: &str) -> Option<String> {
    let dialog = rfd::FileDialog::new()
        .set_title("导出小说")
        .set_file_name(default_name)
        .add_filter(ext.to_uppercase(), &[ext])
        .add_filter("所有文件", &["*"]);
    dialog.save_file().map(|p| p.to_string_lossy().to_string())
}

pub fn pick_directory(title: &str) -> Option<String> {
    rfd::FileDialog::new()
        .set_title(title)
        .pick_folder()
        .map(|p| p.to_string_lossy().to_string())
}

pub fn pick_open_file(filters: &[(&str, &[&str])]) -> Option<String> {
    let mut d = rfd::FileDialog::new().set_title("打开文件");
    for (name, exts) in filters {
        d = d.add_filter(*name, exts);
    }
    d.pick_file().map(|p| p.to_string_lossy().to_string())
}

pub fn suggest_filename(store: &Store, book_id: &str, opt: &ExportOptions) -> Result<String, String> {
    let book = store.book(book_id)?;
    let ext = match opt.format.to_lowercase().as_str() {
        "md" | "markdown" => "md",
        "html" | "htm" => "html",
        "json" | "backup" => "json",
        "epub" => "epub",
        _ => "txt",
    };
    Ok(default_name(&book, opt, ext))
}
