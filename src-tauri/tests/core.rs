// Exercise persistence, export, LAN/WebDAV sync, and AI core logic without linking the desktop event loop.
#![allow(dead_code)]
#[path = "../src/cover.rs"] mod cover;
#[path = "../src/storage/mod.rs"] mod storage;
#[path = "../src/sync/mod.rs"] mod sync;
#[path = "../src/ai.rs"] mod ai;
#[path = "../src/text.rs"] mod text;
#[path = "../src/dialog.rs"] mod dialog;
#[path = "../src/epub.rs"] mod epub;
#[path = "../src/export.rs"] mod export;
#[path = "../src/zip.rs"] mod zip;

#[test]
fn main_window_is_configured_or_built_in_setup() {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid tauri.conf.json");
    let static_windows = conf["app"]["windows"].as_array().map(|a| a.len()).unwrap_or(0);
    if static_windows == 0 {
        let lib_src = include_str!("../src/lib.rs");
        assert!(
            lib_src.contains("WebviewWindowBuilder::new")
                && lib_src.contains("\"main\"")
                && lib_src.contains(".build()?"),
            "tauri.conf.json declares windows: [], so lib.rs setup must build the \"main\" WebviewWindow",
        );
    }
}

#[test]
fn legacy_v0_settings_with_float_font_size_loads_in_place() {
    let dir = std::env::temp_dir().join(format!(
        "heartwrite-legacy-settings-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let legacy = r#"{
  "theme": "light",
  "fontFamily": "霞鹜文楷, 思源宋体, 宋体, Microsoft YaHei, serif",
  "fontSize": 18.0,
  "lineHeight": 1.9,
  "letterSpacing": 0.02,
  "autosaveSecs": 20,
  "historyDepth": 30,
  "snapshotCharDelta": 120,
  "editorWidth": 860,
  "focusMode": false,
  "typewriterSound": false,
  "dailyGoal": 3000,
  "lastBookId": "",
  "lastChapterId": "",
  "lastExportDir": "",
  "oneClickFormatRule": "cjk-indent"
}"#;
    std::fs::write(dir.join("settings.json"), legacy).unwrap();
    let store = storage::Store::load(dir.clone())
        .expect("legacy settings.json with float fontSize must load cleanly");
    assert_eq!(store.settings.font_size, 18);
    assert_eq!(store.settings.theme, "light");
    assert_eq!(store.settings.editor_width, 860);
    assert!(!store.settings.device_id.is_empty());
    assert!(!store.settings.lan.pin.is_empty());
    assert!(!store.settings.ai.profiles.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
