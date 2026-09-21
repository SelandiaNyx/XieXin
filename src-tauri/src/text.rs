//! 文字统计、中文数字、一键排版与章节切分等纯函数工具。

use chrono::{Local, TimeZone};

pub const CJK_IDEOGRAPHS: &str = "\u{4E00}-\u{9FFF}";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextCount {
    /// 中文字符 + 英文单词 + 数字串，即"字数"。
    pub total: usize,
    /// 含空白在内的全部字符数。
    pub chars_with_space: usize,
    pub cjk: usize,
    pub words: usize,
    pub latin_chars: usize,
    pub digits: usize,
    pub paragraphs: usize,
}

pub fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x3400..=0x4DBF      // 扩展 A
        | 0x4E00..=0x9FFF    // 基本区
        | 0xF900..=0xFAFF    // 兼容表意
        | 0x3040..=0x30FF    // 日文假名
        | 0xAC00..=0xD7AF    // 韩文
        | 0x20000..=0x2FA1F  // 扩展 B~F
    )
}

/// 字数统计：与常见写作软件保持一致 —— 一个汉字计 1 字，
/// 一段连续的西文/数字（不含标点与空白）计 1 字，标点与空白不计入总字数。
pub fn count_text(text: &str) -> TextCount {
    let mut c = TextCount::default();
    let mut paragraphs = 0usize;
    let mut line_has_content = false;
    // 当前正在累积的“西文/数字串”
    let mut run = String::new();

    // 结算一段西文/数字串：含数字则计 1 个字，纯字母同样计 1 个字
    fn flush(c: &mut TextCount, run: &mut String) {
        if run.is_empty() {
            return;
        }
        if run.chars().any(|ch| ch.is_ascii_digit()) {
            c.digits += 1;
        } else {
            c.words += 1;
        }
        c.latin_chars += run.chars().count();
        run.clear();
    }

    for ch in text.chars() {
        c.chars_with_space += 1;
        if ch == '\n' {
            if line_has_content {
                paragraphs += 1;
            }
            line_has_content = false;
        } else if !ch.is_whitespace() {
            line_has_content = true;
        }

        if is_cjk(ch) {
            flush(&mut c, &mut run);
            c.cjk += 1;
        } else if ch.is_whitespace() {
            flush(&mut c, &mut run);
        } else if ch.is_alphanumeric() {
            // 汉字已在上面处理，其余字母数字都进入西文串
            run.push(ch);
        } else {
            // 标点等符号：终止当前串，本身不计数
            flush(&mut c, &mut run);
        }
    }
    flush(&mut c, &mut run);

    if line_has_content {
        paragraphs += 1;
    }
    c.paragraphs = paragraphs;
    c.total = c.cjk + c.words + c.digits;
    c
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn today_start_ms() -> i64 {
    let now = Local::now();
    let start = now.date_naive().and_hms_opt(0, 0, 0).unwrap_or_default();
    Local
        .from_local_datetime(&start)
        .single()
        .map(|d| d.timestamp_millis())
        .unwrap_or_else(now_ms)
}

pub fn format_ms(ms: i64) -> String {
    if ms <= 0 {
        return "-".into();
    }
    Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|d| d.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "-".into())
}

pub fn now_iso() -> String {
    Local::now().format("%Y%m%d-%H%M%S").to_string()
}

const CN_DIGITS: [&str; 10] = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/// 1..=99 的中文数字（用于"第一卷"）。
pub fn cn_number(n: usize) -> String {
    if n == 0 {
        return "零".into();
    }
    if n < 10 {
        return CN_DIGITS[n].to_string();
    }
    if n < 20 {
        return format!("十{}", if n % 10 == 0 { "" } else { CN_DIGITS[n % 10] });
    }
    if n < 100 {
        let tens = n / 10;
        let ones = n % 10;
        return format!(
            "{}{}{}",
            CN_DIGITS[tens],
            "十",
            if ones == 0 { "" } else { CN_DIGITS[ones] }
        );
    }
    n.to_string()
}

pub fn volume_title(index: usize) -> String {
    format!("第{}卷", cn_number(index))
}

pub fn chapter_title(index: usize) -> String {
    format!("第{index}章")
}

// ---------------------------------------------------------------------------
// 一键排版
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormatRule {
    /// 中文习惯：段首缩进两个全角空格。
    CjkIndent,
    /// 段首不缩进，段间空一行（网文/出版常见）。
    BlankLine,
    /// 只清理行尾空格与多余空行，不动缩进。
    TidyOnly,
}

impl FormatRule {
    pub fn parse(s: &str) -> Self {
        match s {
            "blank-line" => FormatRule::BlankLine,
            "tidy-only" => FormatRule::TidyOnly,
            _ => FormatRule::CjkIndent,
        }
    }
}

fn is_heading_like(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() {
        return false;
    }
    if t.starts_with('第') {
        // 第一章 / 第一节 / 第一卷 …
        let rest = &t[3.min(t.len())..];
        let _ = rest;
        for kw in ["章", "节", "卷", "回", "部", "篇"] {
            if t.contains(kw) && t.chars().count() <= 24 {
                return true;
            }
        }
    }
    for p in ["序章", "楔子", "尾声", "后记", "番外", "引子", "前言", "终章"] {
        if t.starts_with(p) && t.chars().count() <= 16 {
            return true;
        }
    }
    if t.starts_with('#') {
        return true;
    }
    if t.chars().count() <= 14 && (t.starts_with('【') && t.ends_with('】')) {
        return true;
    }
    false
}

/// 一键排版：返回整理后的正文。
pub fn smart_format(text: &str, rule: FormatRule, chapter_title: Option<&str>, ensure_title: bool) -> String {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut blocks: Vec<String> = Vec::new();
    let mut in_fence = false;
    for raw in normalized.split('\n') {
        let fence = raw.trim_start().starts_with("```");
        if fence {
            in_fence = !in_fence;
        }
        if in_fence || fence {
            blocks.push(raw.trim_end().to_string());
            continue;
        }
        // 行尾空白（含全角空格）
        let mut line = raw.trim_end().trim_end_matches('\u{3000}').to_string();
        if line.trim().is_empty() {
            blocks.push(String::new());
            continue;
        }
        if line.starts_with('\t') {
            line = line.replace('\t', "    ");
        }
        let leading_len = line.chars().take_while(|c| *c == ' ' || *c == '\u{3000}').count();
        let body: String = line.chars().skip(leading_len).collect();
        let body = body.to_string();
        if is_heading_like(&body) {
            blocks.push(body);
            continue;
        }
        let out = match rule {
            FormatRule::TidyOnly => format!("{}{}", " ".repeat(leading_len), body),
            FormatRule::CjkIndent => format!("\u{3000}\u{3000}{body}"),
            FormatRule::BlankLine => body,
        };
        blocks.push(out);
    }

    // 合并连续空行
    let mut lines: Vec<String> = Vec::new();
    let mut blank_run = 0usize;
    for b in blocks {
        if b.trim().is_empty() {
            blank_run += 1;
            if blank_run > 1 {
                continue;
            }
            lines.push(String::new());
        } else {
            blank_run = 0;
            lines.push(b);
        }
    }
    while lines.first().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.remove(0);
    }
    while lines.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        lines.pop();
    }

    let mut body = if rule == FormatRule::BlankLine {
        // 段间空一行
        let mut out: Vec<String> = Vec::new();
        for l in &lines {
            if l.trim().is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push(String::new());
            }
            out.push(l.clone());
        }
        out.join("\n")
    } else {
        lines.join("\n")
    };

    if ensure_title {
        if let Some(t) = chapter_title {
            let t = t.trim();
            if !t.is_empty() {
                let first = body.lines().next().unwrap_or("").trim().to_string();
                if first != t {
                    if body.trim().is_empty() {
                        body = t.to_string();
                    } else {
                        body = format!("{t}\n\n{body}");
                    }
                }
            }
        }
    }
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    body
}

// ---------------------------------------------------------------------------
// 章节切分（导入 TXT）
// ---------------------------------------------------------------------------

/// 判断一行是否是章节标题（"第X章"、"序章"、"Chapter 3" 等）。
pub fn heading_of(line: &str) -> Option<String> {
    let t = line.trim().trim_start_matches(|c: char| c == '\u{FEFF}');
    if t.is_empty() || t.chars().count() > 30 {
        return None;
    }
    if t.starts_with("第") {
        let mut chars = t.chars();
        let _ = chars.next(); // 跳过 "第"
        let mut mid = String::new();
        let mut found = false;
        for ch in chars.by_ref().take(8) {
            if matches!(ch, '章' | '节' | '回' | '话') {
                found = true;
                break;
            }
            mid.push(ch);
        }
        if found
            && !mid.is_empty()
            && mid
                .chars()
                .all(|c| c.is_ascii_digit() || "零一二三四五六七八九十百千万两".contains(c))
        {
            return Some(t.to_string());
        }
    }
    for p in ["序章", "楔子", "尾声", "后记", "番外", "引子", "终章", "Chapter ", "CHAPTER "] {
        if t.starts_with(p) {
            return Some(t.to_string());
        }
    }
    None
}

/// 把整本书的纯文本切成 (标题, 正文) 列表。没有标题时按空行分块（每块一章）。
pub fn split_into_chapters(text: &str, prefix: &str) -> Vec<(String, String)> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let normalized = normalized.trim_start_matches('\u{FEFF}');
    let mut chapters: Vec<(String, String)> = Vec::new();
    let mut current_title: Option<String> = None;
    let mut buffer: Vec<String> = Vec::new();

    for line in normalized.split('\n') {
        if heading_of(line).is_some() {
            if let Some(title) = current_title.take() {
                let body = buffer.join("\n").trim().to_string();
                chapters.push((title, body));
                buffer.clear();
            } else if !buffer.join("").trim().is_empty() {
                let body = buffer.join("\n").trim().to_string();
                chapters.push((format!("{prefix}前言"), body));
                buffer.clear();
            }
            current_title = Some(line.trim().to_string());
        } else {
            buffer.push(line.to_string());
        }
    }
    if let Some(title) = current_title.take() {
        chapters.push((title, buffer.join("\n").trim().to_string()));
    } else {
        let body = buffer.join("\n").trim().to_string();
        if !body.is_empty() {
            // 无标题：按空行分块
            let blocks: Vec<&str> = body.split("\n\n").map(|b| b.trim()).filter(|b| !b.is_empty()).collect();
            for (i, b) in blocks.iter().enumerate() {
                chapters.push((format!("{prefix}{}", i + 1), (*b).to_string()));
            }
        }
    }
    chapters
        .into_iter()
        .filter(|(t, b)| !(t.trim().is_empty() && b.trim().is_empty()))
        .collect()
}

// ---------------------------------------------------------------------------
// 查找 / 替换（含正则式的简单实现）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceReport {
    pub replaced: usize,
    pub before_chars: usize,
    pub after_chars: usize,
}

pub fn replace_all(content: &str, needle: &str, replacement: &str, case_sensitive: bool) -> (String, ReplaceReport) {
    if needle.is_empty() {
        return (
            content.to_string(),
            ReplaceReport {
                replaced: 0,
                before_chars: count_text(content).total,
                after_chars: count_text(content).total,
            },
        );
    }
    let (hay, pat) = if case_sensitive {
        (content.to_string(), needle.to_string())
    } else {
        (content.to_lowercase(), needle.to_lowercase())
    };
    let mut out = String::with_capacity(content.len());
    let mut idx = 0usize;
    let mut replaced = 0usize;
    while let Some(pos) = hay[idx..].find(&pat) {
        let abs = idx + pos;
        out.push_str(&content[idx..abs]);
        out.push_str(replacement);
        idx = abs + pat.len();
        replaced += 1;
    }
    out.push_str(&content[idx..]);
    let report = ReplaceReport {
        replaced,
        before_chars: count_text(content).total,
        after_chars: count_text(&out).total,
    };
    (out, report)
}

/// 诊断：打印排版前后的逐行对照，用于确认缩进/空行处理是否符合预期。
pub fn format_probe(input: &str, rule: FormatRule) -> String {
    let out = smart_format(input, rule, None, false);
    let mut s = String::new();
    s.push_str("---- 输入 ----\n");
    for l in input.split('\n') {
        s.push_str(&format!("|{l}|\n"));
    }
    s.push_str("---- 输出 ----\n");
    for l in out.split('\n') {
        s.push_str(&format!("|{l}|\n"));
    }
    s
}

/// 让纯函数单元测试在应用内也能跑（避免依赖测试可执行文件的运行库）。
/// 返回 (通过数, 失败信息列表)。
pub fn self_check() -> (usize, Vec<String>) {    let mut checks: Vec<(&str, bool, String)> = Vec::new();
    let mut expect = |name: &'static str, ok: bool, detail: String| checks.push((name, ok, detail));

    let c = count_text("你好 world 123，再见！");
    expect("count_text 中文字数=4", c.cjk == 4, format!("cjk={}", c.cjk));
    expect("count_text 西文词数=1", c.words == 1, format!("words={}", c.words));
    expect("count_text 数字串=1", c.digits == 1, format!("digits={}", c.digits));
    expect("count_text 总字数=6", c.total == 6, format!("total={}", c.total));
    let multi = count_text("hello world");
    expect("count_text 两个英文单词", multi.total == 2, format!("total={}", multi.total));

    expect("cn_number 1", cn_number(1) == "一", cn_number(1));
    expect("cn_number 10", cn_number(10) == "十", cn_number(10));
    expect("cn_number 11", cn_number(11) == "十一", cn_number(11));
    expect("cn_number 21", cn_number(21) == "二十一", cn_number(21));

    let h1 = heading_of("第一章 落雪");
    expect("heading_of 第一章", h1.is_some(), format!("{h1:?}"));
    let h2 = heading_of("第12章");
    expect("heading_of 第12章", h2.is_some(), format!("{h2:?}"));
    let h3 = heading_of("他走了很久");
    expect("heading_of 普通段落", h3.is_none(), format!("{h3:?}"));
    let h4 = heading_of("Chapter 1");
    expect("heading_of Chapter", h4.is_some(), format!("{h4:?}"));

    let split = split_into_chapters("第一章 起\n内容一\n\n第二章 承\n内容二", "");
    expect("split 数量=2", split.len() == 2, format!("len={}", split.len()));
    let t0 = split.first().map(|c| c.0.clone()).unwrap_or_default();
    expect("split 首章标题", t0 == "第一章 起", t0);
    let b1 = split.get(1).map(|c| c.1.clone()).unwrap_or_default();
    expect("split 次章正文", b1 == "内容二", b1);

    let formatted = smart_format(
        "第一章 起\n\n他没有说话。\n\n\n  风很大。\n",
        FormatRule::CjkIndent,
        None,
        false,
    );
    let wanted = "第一章 起\n\n\u{3000}\u{3000}他没有说话。\n\n\u{3000}\u{3000}风很大。\n";
    expect("smart_format 缩进与空行", formatted == wanted, format!("{formatted:?}"));
    let blank = smart_format("第一段\n第二段", FormatRule::BlankLine, None, false);
    expect("smart_format 段间空行", blank == "第一段\n\n第二段\n", format!("{blank:?}"));

    let (out, report) = replace_all("abc ABC", "abc", "x", false);
    expect("replace_all 结果", out == "x x", out.clone());
    expect("replace_all 计数=2", report.replaced == 2, format!("{}", report.replaced));

    let failures: Vec<String> = checks
        .iter()
        .filter(|(_, ok, _)| !ok)
        .map(|(name, _, detail)| format!("{name}（实际 {detail}）"))
        .collect();
    (checks.len() - failures.len(), failures)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_chinese_and_words() {
        let c = count_text("你好 world 123，再见！");
        assert_eq!(c.cjk, 4);
        assert_eq!(c.words, 1);
        assert_eq!(c.digits, 1);
        assert_eq!(c.total, 6);
    }

    #[test]
    fn cn_numbers() {
        assert_eq!(cn_number(1), "一");
        assert_eq!(cn_number(10), "十");
        assert_eq!(cn_number(11), "十一");
        assert_eq!(cn_number(21), "二十一");
        assert_eq!(cn_number(100), "100");
    }

    #[test]
    fn heading_detection() {
        assert!(heading_of("第一章 落雪").is_some());
        assert!(heading_of("第12章").is_some());
        assert!(heading_of("他走了很久").is_none());
        assert!(heading_of("Chapter 1").is_some());
    }

    #[test]
    fn split_chapters() {
        let text = "第一章 起\n内容一\n\n第二章 承\n内容二";
        let ch = split_into_chapters(text, "");
        assert_eq!(ch.len(), 2);
        assert_eq!(ch[0].0, "第一章 起");
        assert_eq!(ch[1].1, "内容二");
    }

    #[test]
    fn format_cjk_indent() {
        let out = smart_format("第一章 起\n\n他没有说话。\n\n\n  风很大。\n", FormatRule::CjkIndent, None, false);
        assert_eq!(out, "第一章 起\n\n\u{3000}\u{3000}他没有说话。\n\n\u{3000}\u{3000}风很大。\n");
    }

    #[test]
    fn format_blank_line() {
        let out = smart_format("第一段\n第二段", FormatRule::BlankLine, None, false);
        assert_eq!(out, "第一段\n\n第二段\n");
    }

    #[test]
    fn replace_is_counted() {
        let (out, r) = replace_all("abc ABC", "abc", "x", false);
        assert_eq!(out, "x x");
        assert_eq!(r.replaced, 2);
    }
}
