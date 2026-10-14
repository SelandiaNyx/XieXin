//! EPUB 3 电子书生成（ZIP 结构，含 mimetype / container.xml / OPF / NAV / 各章 XHTML）。

use crate::export::{body_paragraphs, esc_html, ExportOptions};
use crate::storage::{BookMeta, Store};
use crate::text::now_ms;
use crate::zip::ZipWriter;

/// 生成 EPUB 3 电子书字节流与导出章节数。
pub fn render_epub(book: &BookMeta, store: &Store, opt: &ExportOptions) -> Result<(Vec<u8>, usize), String> {
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
            let content = store.read_content(&book.id, &ch.id)?.content;
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
               .vol{text-align:center;font-size:1.3em;margin:2em 0 1em;}\n\
               .cover{text-align:center;text-indent:0;margin:0 0 1.2em;}\n\
               .cover img{max-width:100%;height:auto;}\n";

    // 封面（可选）：设过就原样塞进 EPUB，并让阅读器把它当封面用
    let cover = store.read_book_cover(&book.id);
    let cover_href = cover.as_ref().map(|(ext, _)| format!("cover.{ext}"));
    let cover_meta = if cover_href.is_some() {
        "    <meta name=\"cover\" content=\"cover-image\"/>\n".to_string()
    } else {
        String::new()
    };

    let mut zip = ZipWriter::new();
    // mimetype 必须是第一个条目且不压缩
    zip.add("mimetype", "application/epub+zip");
    if let (Some((ext, bytes)), Some(href)) = (cover.as_ref(), cover_href.as_ref()) {
        zip.add(format!("OEBPS/{href}"), bytes);
        let _ = ext;
    }
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
    if let Some(href) = cover_href.as_ref() {
        front.push_str(&format!(
            "<p class=\"cover\"><img src=\"{}\" alt=\"封面\"/></p>",
            esc_html(href)
        ));
    }
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
    // 封面：manifest 里标 properties="cover-image"，metadata 里再挂 name="cover"，
    // 这样微信读书 / 多看 / Apple Books 都会拿它当书封而不是正文插图。
    if let (Some((ext, _)), Some(href)) = (cover.as_ref(), cover_href.as_ref()) {
        manifest.push_str(&format!(
            "    <item id=\"cover-image\" href=\"{href}\" media-type=\"{}\" properties=\"cover-image\"/>\n",
            crate::cover::mime_for(ext)
        ));
    }
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
            "    <meta property=\"dcterms:modified\">{modified}</meta>\n    <meta name=\"heartwrite:volumes\" content=\"{}\"/>\n{cover_meta}",
            esc_html(&vols.join(" / ")),
            cover_meta = cover_meta
        )
    } else {
        format!("    <meta property=\"dcterms:modified\">{modified}</meta>\n{cover_meta}")
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
