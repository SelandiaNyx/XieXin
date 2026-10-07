//! 封面图片：类型白名单、体积上限、base64 与 data URL 组装。
//!
//! 只做存储与展示所需的最小处理：**不改写图片本身**（不解码、不缩放、不重编码），
//! 这样既不用引入图像库（与 zip.rs 手写 ZIP 的做法一致），也不会掉画质。
//! 面向 WebView 的展示走 data URL（CSP 里已经允许 `data:`，不需要给 asset 协议开作用域），
//! 面向 EPUB 的展示直接塞原始字节。

/// 单张封面的体积上限：封面通常几百 KB，4MB 足够，也避免 data URL 撑爆 IPC。
pub const MAX_COVER_BYTES: u64 = 4 * 1024 * 1024;

/// 允许的扩展名：都是 WebView 与主流阅读器能直接渲染的格式。
pub const ALLOWED_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp"];

/// 取小写扩展名（不含点）；没有扩展名或不在白名单里时返回 `None`。
pub fn cover_ext(path: &str) -> Option<String> {
    let ext = std::path::Path::new(path)
        .extension()?
        .to_str()?
        .to_ascii_lowercase();
    ALLOWED_EXTS.contains(&ext.as_str()).then_some(ext)
}

/// 扩展名 → MIME。
pub fn mime_for(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "application/octet-stream",
    }
}

/// 标准 base64 编码（带 `=` 补位）。自己写十几行是为了不引依赖，和 zip.rs 同一个取舍。
pub fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

/// 标准 base64 解码；遇到非法字符返回 `None`（导入备份时用来还原封面）。
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for byte in text.bytes() {
        if byte == b'=' || byte == b'\n' || byte == b'\r' || byte == b' ' {
            continue;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        } as u32;
        buf = (buf << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

/// 组装 WebView 可以直接放进 `<img src>` 的 data URL。
pub fn data_url(ext: &str, data: &[u8]) -> String {
    format!("data:{};base64,{}", mime_for(ext), base64_encode(data))
}

/// 校验并读出用户选中的图片：白名单 + 体积上限 + 非空 + 确实是文件。
///
/// 校验只此一处：`set_book_cover` 与"选择后先预览"都走这里，任何入口都绕不过
/// （前端就算传了别的路径，也过不了这道关）。
pub fn read_image(path: &str) -> Result<(String, Vec<u8>), String> {
    let ext = cover_ext(path)
        .ok_or_else(|| format!("不支持的图片格式（支持 {}）", ALLOWED_EXTS.join(" / ")))?;
    let meta = std::fs::metadata(path).map_err(|e| format!("读不到这张图片：{e}"))?;
    if !meta.is_file() {
        return Err("请选择一张图片文件".into());
    }
    if meta.len() > MAX_COVER_BYTES {
        return Err(format!("图片太大了（上限 {}MB）", MAX_COVER_BYTES / 1024 / 1024));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("读不到这张图片：{e}"))?;
    if bytes.is_empty() {
        return Err("这张图片是空文件".into());
    }
    Ok((ext, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_known_vectors() {
        // RFC 4648 的示例向量，覆盖三种补位情况
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"Man"), "TWFu");
    }

    #[test]
    fn base64_round_trips_binary() {
        // 覆盖 0x00-0xFF 全字节，确保不是"只能编码 ASCII"
        let all: Vec<u8> = (0u8..=255).collect();
        let encoded = base64_encode(&all);
        assert_eq!(base64_decode(&encoded).unwrap(), all);
        for len in 1..8usize {
            let slice = &all[..len];
            assert_eq!(base64_decode(&base64_encode(slice)).unwrap(), slice);
        }
    }

    #[test]
    fn base64_decode_rejects_garbage() {
        assert!(base64_decode("不是 base64").is_none());
    }

    #[test]
    fn extension_whitelist() {
        assert_eq!(cover_ext("D:/图片/封面.PNG").as_deref(), Some("png"));
        assert_eq!(cover_ext("/tmp/a.jpeg").as_deref(), Some("jpeg"));
        assert_eq!(cover_ext("cover.webp").as_deref(), Some("webp"));
        assert_eq!(cover_ext("book.txt"), None);
        assert_eq!(cover_ext("noext"), None);
        assert_eq!(cover_ext("evil.exe"), None);
        // 只看最后一段扩展名，中间的点不影响
        assert_eq!(cover_ext("my.cover.v2.jpg").as_deref(), Some("jpg"));
    }

    #[test]
    fn mime_and_data_url() {
        assert_eq!(mime_for("png"), "image/png");
        assert_eq!(mime_for("jpeg"), "image/jpeg");
        assert_eq!(mime_for("exe"), "application/octet-stream");
        let url = data_url("png", b"Man");
        assert_eq!(url, "data:image/png;base64,TWFu");
        assert!(url.starts_with("data:image/png;base64,"));
    }

    #[test]
    fn read_image_rejects_bad_input() {
        // 格式不在白名单：连文件都不看就直接拒绝
        let err = read_image("D:/不存在的目录/note.txt").unwrap_err();
        assert!(err.contains("不支持的图片格式"), "{err}");

        // 扩展名合法但文件不存在
        let missing = std::env::temp_dir().join("heartwrite-cover-missing.png");
        let _ = std::fs::remove_file(&missing);
        assert!(read_image(missing.to_string_lossy().as_ref()).is_err());

        // 目录不能当封面
        let dir = std::env::temp_dir().join("heartwrite-cover-dir.png");
        let _ = std::fs::create_dir_all(&dir);
        assert!(read_image(dir.to_string_lossy().as_ref()).is_err());
        let _ = std::fs::remove_dir_all(&dir);

        // 正常图片能读出来
        let ok = std::env::temp_dir().join("heartwrite-cover-ok.PNG");
        std::fs::write(&ok, b"bytes").unwrap();
        let (ext, bytes) = read_image(ok.to_string_lossy().as_ref()).unwrap();
        assert_eq!((ext.as_str(), bytes.as_slice()), ("png", b"bytes".as_ref()));
        let _ = std::fs::remove_file(&ok);
    }
}
