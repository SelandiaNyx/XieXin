//! 写心 · 本地小说写作工作台 —— 应用入口与 Tauri 命令注册。

pub mod app;
pub mod export;
pub mod smoke;
pub mod storage;
pub mod text;
pub mod text_decode;
pub mod zip;

use app::AppState;
use tauri::Manager;

/// 前端启动后调用，确认 WebView 与 IPC 已经可用。
#[tauri::command]
fn ui_ready() -> String {
    format!("ui-ready {}", env!("CARGO_PKG_VERSION"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let smoke_mode = args.iter().any(|a| a == "--smoke-test" || a == "--self-check" || a == "--format-probe");
    let text_only = args.iter().any(|a| a == "--self-check" || a == "--format-probe");
    let forced_dir = args
        .iter()
        .position(|a| a == "--data-dir")
        .and_then(|i| args.get(i + 1).cloned());

    if let Some(dir) = forced_dir.clone() {
        std::env::set_var("NOVEL_MANAGER_DATA_DIR", dir);
    }

    let builder = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            ui_ready,
            app::workspace_state,
            app::storage_info,
            app::create_book,
            app::open_book,
            app::delete_book,
            app::update_book_meta,
            app::book_stats,
            app::save_settings,
            app::add_volume,
            app::add_chapter,
            app::delete_chapter,
            app::delete_volume,
            app::rename_node,
            app::move_node,
            app::move_chapter_to,
            app::set_volume_expanded,
            app::read_chapter,
            app::save_chapter,
            app::list_versions,
            app::version_detail,
            app::restore_version,
            app::delete_version,
            app::list_cards,
            app::upsert_card,
            app::delete_card,
            app::count,
            app::one_click_format,
            app::replace_all,
            app::pick_directory,
            app::pick_open_file,
            app::pick_save_path,
            app::suggest_filename,
            app::export_book,
            app::list_recent_exports,
            app::push_recent_export,
            app::import_text,
            app::import_backup,
            app::verify_book,
            app::list_trash,
            app::empty_trash,
            app::open_in_explorer,
            app::list_fonts,
            app::ui_log,
            app::chapter_statuses,
            app::window_diag,
            app::dev_smoke_test,
        ])
        .setup(move |app| {
            let root = if smoke_mode {
                let base = forced_dir
                    .clone()
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(storage::default_data_dir);
                let dir = base.join("smoke");
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir)?;
                dir
            } else {
                app::storage_dir_for_app(app.handle())
            };

            let store = storage::Store::load(root).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            app.manage(AppState::new(store));

            if smoke_mode {
                let result = if text_only {
                    if args.iter().any(|a| a == "--format-probe") {
                        let a = "雪落下来了。\n他站在城墙上，看着远处。\n\n“你还是来了。”身后传来一个声音。\n他没有回头。";
                        let b = "\u{3000}\u{3000}雪落下来了。\n\u{3000}\u{3000}他站在城墙上。";
                        let c = "第一章 雪夜\n\n雪落下来了。\n\n第二章 旧约\n\n城南的酒肆。";
                        Ok(format!(
                            "=== A 普通中文段落 / cjk-indent ===\n{}\n=== B 已缩进再排版 / cjk-indent ===\n{}\n=== C 含标题 / cjk-indent ===\n{}\n=== D 普通段落 / blank-line ===\n{}",
                            text::format_probe(a, text::FormatRule::CjkIndent),
                            text::format_probe(b, text::FormatRule::CjkIndent),
                            text::format_probe(c, text::FormatRule::CjkIndent),
                            text::format_probe(a, text::FormatRule::BlankLine),
                        ))
                    } else {
                        let (passed, failures) = text::self_check();
                        if failures.is_empty() {
                            Ok(format!("[self-check] 纯函数检查 {passed} 项全部通过"))
                        } else {
                            Err(format!("[self-check] {passed} 项通过，失败：{}", failures.join("、")))
                        }
                    }
                } else {
                    let state = app.state::<AppState>();
                    let mut guard = state.store.lock().expect("state lock");
                    smoke::run(&mut guard)
                };
                let (ok, text) = match result {
                    Ok(t) => (true, t),
                    Err(e) => (false, format!("[FAIL] {e}")),
                };
                let report = format!("{}\n[status] {}\n", text, if ok { "OK" } else { "FAILED" });
                println!("{report}");
                let log_path = std::path::PathBuf::from(forced_dir.clone().unwrap_or_else(|| ".".into()))
                    .join(if text_only { "self-check-report.txt" } else { "smoke-report.txt" });                if let Some(parent) = log_path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&log_path, &report);
                println!("[log] {}", log_path.display());
                std::process::exit(if ok { 0 } else { 1 });
            }

            // 正常模式才创建窗口（自检模式是无头的）。
            // NOVEL_MANAGER_START_URL / NOVEL_MANAGER_SELFTEST 便于开发时用示例数据验收界面。
            if !smoke_mode {
                let start_url = std::env::var("NOVEL_MANAGER_START_URL").unwrap_or_default();
                let selftest = std::env::var("NOVEL_MANAGER_SELFTEST").is_ok();
                let uitest = std::env::var("NOVEL_MANAGER_UITEST").is_ok();
                let url = if start_url.trim().is_empty() {
                    "index.html".to_string()
                } else {
                    start_url.trim().to_string()
                };
                let mut win = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App(url.into()))
                    .title("写心 · 小说写作工作台")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(1040.0, 640.0)
                    .center()
                    .zoom_hotkeys_enabled(false);
                if selftest {
                    win = win.initialization_script(
                        "window.__MOGE_SELFTEST__ = true; console.log('[写心] selftest flag injected');",
                    );
                }
                if uitest {
                    win = win.initialization_script("window.__MOGE_UITEST__ = true;");
                }
                win.build()?;
            }

            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("启动写心失败");
}
