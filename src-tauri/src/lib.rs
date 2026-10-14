//! 写心（HeartWrite）—— 极速本地小说创作与管理工作台（Rust + Tauri 2）。
//!
//! 模块划分：
//! - `text`：字数统计、中文数字、一键排版、章节切分、查找替换；
//! - `text_decode`：UTF-8 / UTF-16 / GB18030 文本解码；
//! - `storage`：本地 JSON 原子存储、版本历史、卡片、回收站、位置管理；
//! - `export` / `epub`：TXT / Markdown / HTML / JSON 备份 / EPUB 导出；
//! - `fonts`：系统字体扫描；
//! - `smoke`：无界面端到端冒烟与自检模式；
//! - `app`：Tauri 命令接口。

pub mod app;
pub mod cover;
pub mod dialog;
pub mod epub;
pub mod export;
pub mod fonts;
pub mod smoke;
pub mod storage;
pub mod text;
pub mod text_decode;
pub mod zip;

use tauri::Manager;

/// 命令行参数（支持自检/冒烟/排版探针，不启动 GUI 即可完成验证）。
#[derive(Default, Debug)]
pub struct CliArgs {
    pub self_check: bool,
    pub smoke_test: bool,
    pub format_probe: bool,
    pub data_dir: Option<String>,
}

pub fn parse_args<I: IntoIterator<Item = String>>(iter: I) -> CliArgs {
    let mut out = CliArgs::default();
    let mut it = iter.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--self-check" => out.self_check = true,
            "--smoke-test" => out.smoke_test = true,
            "--format-probe" => out.format_probe = true,
            "--data-dir" => out.data_dir = it.next(),
            _ => {}
        }
    }
    out
}

/// 附加到父控制台（Windows GUI 子系统下让 `--self-check` 能打印到终端）。
#[cfg(target_os = "windows")]
fn attach_parent_console() {
    extern "system" {
        fn AttachConsole(dw_process_id: u32) -> i32;
    }
    const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;
    unsafe {
        let _ = AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

#[cfg(not(target_os = "windows"))]
fn attach_parent_console() {}

/// CLI 无界面模式的输出：同时写标准输出与数据目录下的 `cli-report.txt`，
/// 这样即便 Windows GUI 子系统未附加到管道，脚本也能拿到完整报告。
fn emit_cli_report(dir: &std::path::Path, filename: &str, text: &str) {
    attach_parent_console();
    println!("{text}");
    let _ = std::fs::create_dir_all(dir);
    let _ = std::fs::write(dir.join(filename), text);
}

/// 移动端统一入口（Android 的 `MainActivity` 通过 JNI 调用这里；桌面端也复用同一套装配逻辑）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    run_entry(CliArgs::default());
}

/// 桌面端入口：先处理 `--self-check` / `--smoke-test` 等无界面命令，其余情况进入 `run_entry`。
pub fn run_with_cli() {
    let cli = parse_args(std::env::args().skip(1));
    run_entry(cli);
}

fn run_entry(cli: CliArgs) {
    if let Some(dir) = &cli.data_dir {
        std::env::set_var("NOVEL_MANAGER_DATA_DIR", dir);
    }

    if cli.format_probe {
        let root = storage::default_data_dir();
        let probe = text::format_probe(
            "第一章 山门\n\n他站在风里。\n\n\n  没有回头。  \n",
            text::FormatRule::CjkIndent,
        );
        emit_cli_report(&root, "format-probe.txt", &probe);
        return;
    }

    if cli.self_check {
        let root = storage::default_data_dir();
        let (passed, failed) = text::self_check();
        let mut report = format!("SELF_CHECK passed={passed} failed={}\n", failed.len());
        for f in &failed {
            report.push_str(&format!("  FAIL: {f}\n"));
        }
        emit_cli_report(&root, "self-check.txt", &report);
        if !failed.is_empty() {
            std::process::exit(1);
        }
        return;
    }

    if cli.smoke_test {
        let root = storage::default_data_dir();
        match smoke::run_smoke_at(&root) {
            Ok(report) => {
                emit_cli_report(&root, "smoke-report.txt", &report);
                return;
            }
            Err(e) => {
                let msg = format!("SMOKE_FAIL: {e}\n");
                emit_cli_report(&root, "smoke-report.txt", &msg);
                std::process::exit(1);
            }
        }
    }

    let selftest = app::is_selftest();
    let uitest = app::is_uitest();
    let start_url = std::env::var("NOVEL_MANAGER_START_URL").ok();

    tauri::Builder::default()
        .setup(move |app| {
            let root = app::storage_dir_for_app(app.handle());
            let forced_dir = app::is_location_locked();
            let config_dir = app::config_dir_for_app(app.handle());
            let mut store = match storage::Store::load(root.clone()) {
                Ok(store) => store,
                Err(err) if app::forced_data_dir().is_none() => {
                    // 非强制目录下若因权限或路径失效无法初始化，退回默认可写目录，绝不让手机/桌面启动直接崩溃。
                    let fallback = app::default_data_dir_for_app(app.handle());
                    storage::Store::load(fallback)
                        .or_else(|_| {
                            let tmp = std::env::temp_dir().join("com.heartwrite.novelmanager");
                            storage::Store::load(tmp)
                        })
                        .map_err(|e| format!("无法初始化数据目录 ({err}): {e}"))?
                }
                Err(e) => return Err(format!("无法初始化数据目录: {e}").into()),
            };
            let _ = app::append_ui_log(&store.root, "BACKEND_SETUP");
            if uitest {
                let _ = store.reset_for_uitest();
                let _ = app::append_ui_log(&store.root, "UITEST_RESET_OK");
            } else if selftest {
                let _ = store.seed_selftest_book();
                let _ = app::append_ui_log(&store.root, "SELFTEST_SEEDED_IN_RUST");
            }
            app.manage(app::AppState {
                store: std::sync::Mutex::new(store),
                config_dir,
                forced_dir,
            });
            // 只在开发自检/验收模式下才往 WebView 注入诊断脚本；
            // 正式使用时完全不挂这段脚本，也无需在 index.html 里引用 dev/*。
            if selftest || uitest || start_url.is_some() {
                if let Some(win) = app.get_webview_window("main") {
                    let mut script = format!(
                        "window.__MOGE_DEV__ = true; window.__MOGE_SELFTEST__ = {}; window.__MOGE_UITEST__ = {};\n",
                        if selftest { "true" } else { "false" },
                        if uitest { "true" } else { "false" }
                    );
                    if let Some(u) = &start_url {
                        if let Ok(q) = serde_json::to_string(u) {
                            script.push_str(&format!(
                                "if (!location.search && {q}.includes('?')) {{ history.replaceState(null, '', {q}); }}\n"
                            ));
                        }
                    }
                    script.push_str(
                        "window.addEventListener('DOMContentLoaded', () => { import('./js/dev/inject.js'); });\n",
                    );
                    let _ = win.eval(&script);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app::workspace_state,
            app::storage_location,
            app::set_storage_dir,
            app::chapter_statuses,
            app::save_settings,
            app::set_last_position,
            app::storage_info,
            app::create_book,
            app::create_sample_book,
            app::open_book,
            app::update_book_meta,
            app::duplicate_book,
            app::delete_book,
            app::book_cover,
            app::preview_cover,
            app::set_book_cover,
            app::clear_book_cover,
            app::book_stats,
            app::verify_book,
            app::add_volume,
            app::add_chapter,
            app::rename_node,
            app::move_node,
            app::move_chapter_to,
            app::reorder_volumes,
            app::set_volume_expanded,
            app::delete_chapter,
            app::delete_volume,
            app::read_chapter,
            app::save_chapter,
            app::list_versions,
            app::version_detail,
            app::restore_version,
            app::delete_version,
            app::list_cards,
            app::upsert_card,
            app::delete_card,
            app::search_book,
            app::count_text_cmd,
            app::smart_format_cmd,
            app::replace_all_cmd,
            app::import_text_cmd,
            app::import_backup_cmd,
            app::suggest_export_filename,
            app::pick_save_path_cmd,
            app::pick_directory_cmd,
            app::pick_open_file_cmd,
            app::export_book,
            app::list_recent_exports,
            app::list_trash,
            app::empty_trash,
            app::list_fonts,
            app::open_in_explorer,
            app::ui_ready,
            app::ui_log,
            app::run_self_check,
            app::run_smoke_in_app,
            app::window_diag,
        ])
        .run(tauri::generate_context!())
        .expect("启动写心失败");
}
