//! 系统字体目录扫描：提取本机安装的字体族名供设置与预览面板使用。

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontEntry {
    pub name: String,
    pub file: String,
    pub path: String,
}

pub fn scan_system_fonts() -> Vec<FontEntry> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(win) = std::env::var_os("WINDIR") {
        dirs.push(PathBuf::from(win).join("Fonts"));
    } else {
        dirs.push(PathBuf::from(r"C:\Windows\Fonts"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join(r"Microsoft\Windows\Fonts"));
    }
    if let Some(home) = std::env::var_os("HOME") {
        let h = PathBuf::from(&home);
        dirs.push(h.join(".local/share/fonts"));
        dirs.push(h.join(".fonts"));
        dirs.push(h.join("Library/Fonts"));
    }
    for sys in [
        "/usr/share/fonts",
        "/usr/local/share/fonts",
        "/Library/Fonts",
        "/System/Library/Fonts",
        "/system/fonts",
    ] {
        dirs.push(PathBuf::from(sys));
    }

    let mut seen = std::collections::BTreeMap::<String, FontEntry>::new();
    for dir in dirs {
        collect_fonts_in(&dir, 0, &mut seen);
    }
    seen.into_values().collect()
}

fn collect_fonts_in(
    dir: &Path,
    depth: usize,
    out: &mut std::collections::BTreeMap<String, FontEntry>,
) {
    if depth > 2 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    for entry in rd.filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.is_dir() {
            collect_fonts_in(&p, depth + 1, out);
            continue;
        }
        let Some(ext) = p.extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()) else {
            continue;
        };
        if !matches!(ext.as_str(), "ttf" | "otf" | "ttc") {
            continue;
        }
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else { continue };
        let family = font_family_from_filename(stem);
        let file = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        out.entry(family.to_lowercase()).or_insert(FontEntry {
            name: family,
            file,
            path: p.to_string_lossy().to_string(),
        });
    }
}

/// 从字体文件名推断更易读的族名，并映射常见 Windows 字体文件名。
fn font_family_from_filename(stem: &str) -> String {
    let lower = stem.to_lowercase();
    let mapped = match lower.as_str() {
        "msyh" | "msyhbd" | "msyhl" => Some("Microsoft YaHei"),
        "simsun" | "simsunb" => Some("SimSun"),
        "nsimsun" => Some("NSimSun"),
        "simhei" => Some("SimHei"),
        "simkai" => Some("KaiTi"),
        "simfang" => Some("FangSong"),
        "deng" | "dengb" | "dengl" => Some("DengXian"),
        "stkaia" | "stkaiti" => Some("STKaiti"),
        "stsong" => Some("STSong"),
        "stfangso" => Some("STFangsong"),
        "stxihei" => Some("STXihei"),
        "stzhongsong" => Some("STZhongsong"),
        "fzshusong-z01" | "fzshusong" => Some("FZShuSong-Z01"),
        "fzkai-z03" | "fzkai" => Some("FZKai-Z03"),
        "consola" | "consolab" | "consolai" | "consolaz" => Some("Consolas"),
        "cour" | "courbd" => Some("Courier New"),
        "times" | "timesbd" => Some("Times New Roman"),
        "georgia" | "georgiab" => Some("Georgia"),
        "segoeui" | "segoeuib" | "segoeuil" => Some("Segoe UI"),
        "arial" | "arialbd" => Some("Arial"),
        "calibri" | "calibrib" => Some("Calibri"),
        "cambria" | "cambriab" => Some("Cambria"),
        _ => None,
    };
    if let Some(m) = mapped {
        return m.to_string();
    }
    let mut cleaned = stem.to_string();
    for suf in [
        "-Regular",
        "-Bold",
        "-Italic",
        "-Light",
        "-Medium",
        "-SemiBold",
        "-ExtraBold",
        "-Thin",
        "-Black",
        "_Regular",
        "_Bold",
        " Regular",
        " Bold",
    ] {
        if let Some(stripped) = cleaned.strip_suffix(suf) {
            cleaned = stripped.to_string();
        }
    }
    cleaned
}
