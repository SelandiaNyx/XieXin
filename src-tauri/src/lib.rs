//! 写心 · 本地小说写作工作台 —— 应用入口与 Tauri 命令注册。

pub mod app;
pub mod cover;
pub mod dialog;
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

/// 解析 `--data-dir <路径>`。
fn forced_data_dir(args: &[String]) -> Option<String> {
    args.iter()
        .position(|a| a == "--data-dir")
        .and_then(|i| args.get(i + 1).cloned())
}

/// 无头模式的数据目录：`--data-dir` 优先，其次环境变量，最后系统默认位置下的 `smoke/`。
fn headless_dir(forced: &Option<String>) -> std::path::PathBuf {
    let base = forced
        .clone()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(storage::default_data_dir);
    base.join("smoke")
}

/// `--self-check` / `--format-probe` / `--smoke-test`：跑完即退出，全程不碰 GUI。
///
/// 必须在 `tauri::Builder::default()` **之前**执行：tao 在 builder 初始化的同时就会去
/// 初始化 GTK，Linux 上没有显示服务时会直接 abort（core dumped）。此前这几个开关写在
/// setup 回调里，Windows 上碰巧能用，Linux 上必崩。
fn run_headless(args: &[String], forced: &Option<String>) -> ! {
    let text_only = args.iter().any(|a| a == "--self-check" || a == "--format-probe");
    let dir = headless_dir(forced);
    let _ = std::fs::remove_dir_all(&dir);

    let result: Result<String, String> = (|| {
        std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建自检目录 {}: {e}", dir.display()))?;
        let mut store = storage::Store::load(dir.clone())?;
        if text_only {
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
            smoke::run(&mut store)
        }
    })();

    let (ok, body) = match result {
        Ok(t) => (true, t),
        Err(e) => (false, format!("[FAIL] {e}")),
    };
    let report = format!("{}\n[status] {}\n", body, if ok { "OK" } else { "FAILED" });
    println!("{report}");

    // 报告写到 smoke/ 旁边（即数据目录的父目录），与自检目录区分开
    let log_dir = dir.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| dir.clone());
    let log_path = log_dir.join(if text_only { "self-check-report.txt" } else { "smoke-report.txt" });
    let _ = std::fs::write(&log_path, &report);
    println!("[log] {}", log_path.display());

    let _ = std::fs::remove_dir_all(&dir);
    std::process::exit(if ok { 0 } else { 1 });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let forced_dir = forced_data_dir(&args);

    if let Some(dir) = forced_dir.clone() {
        std::env::set_var("NOVEL_MANAGER_DATA_DIR", dir);
    }

    // 无头开关必须在创建 Tauri/GTK 之前处理掉（见 run_headless 的说明）
    if args.iter().any(|a| a == "--smoke-test" || a == "--self-check" || a == "--format-probe") {
        run_headless(&args, &forced_dir);
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
            app::set_storage_dir,
            app::set_book_cover,
            app::clear_book_cover,
            app::book_cover,
            app::preview_cover,
            app::book_stats,
            app::save_settings,
            app::set_last_position,
            app::add_volume,
            app::add_chapter,
            app::delete_chapter,
            app::delete_volume,
            app::rename_node,
            app::move_node,
            app::move_chapter_to,
            app::set_volume_expanded,
            app::read_chapter,
            app::search_book,
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
            let root = app::storage_dir_for_app(app.handle());
            let config_dir = app::config_dir_for_app(app.handle());
            let custom_webview_dir = std::env::var("NOVEL_MANAGER_DATA_DIR")
                .ok()
                .filter(|s| !s.trim().is_empty())
                .map(|_| root.join(".webview"));
            let store = storage::Store::load(root).map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            let forced_dir = app::forced_data_dir().is_some();
            app.manage(AppState::new(store, config_dir, forced_dir));

            // 正式启动不注入任何脚本：产品页面里也没有开发代码。
            // 只有显式给出下列开关时才把 ui/js/dev/inject.js 挂进去。
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
                .zoom_hotkeys_enabled(false);
            // 桌面端才指定窗口尺寸并居中：手机/平板上窗口本来就铺满屏幕，
            // 1040×640 的最小尺寸反而会把界面卡在桌面布局上。
            #[cfg(desktop)]
            {
                win = win.inner_size(1440.0, 900.0).min_inner_size(1040.0, 640.0).center();
            }
            if let Some(dir) = custom_webview_dir {
                win = win.data_directory(dir);
            }
            if selftest || uitest {
                let mut boot = String::from("window.__MOGE_DEV__ = true;");
                if selftest {
                    boot.push_str("window.__MOGE_SELFTEST__ = true;");
                }
                if uitest {
                    boot.push_str("window.__MOGE_UITEST__ = true;");
                    if std::env::var("NOVEL_MANAGER_CLOSETEST").is_ok() {
                        boot.push_str("window.__MOGE_CLOSETEST__ = true;");
                    }
                }
                boot.push_str("import('/js/dev/inject.js');");
                win = win.initialization_script(boot);
            }
            win.build()?;

            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("启动写心失败");
}
