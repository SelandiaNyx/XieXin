//! 简单的文本编码嗅探：UTF-8 BOM / UTF-8 / GBK 兜底（导入 TXT 时很常见）。

use encoding_rs::{GB18030, UTF_8};

pub fn decode_text(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).to_string();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (s, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return s.to_string();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (s, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        return s.to_string();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => {
            let (s, _, _) = GB18030.decode(bytes);
            if s.contains('\u{FFFD}') {
                let (u, _, _) = UTF_8.decode(bytes);
                u.to_string()
            } else {
                s.to_string()
            }
        }
    }
}
