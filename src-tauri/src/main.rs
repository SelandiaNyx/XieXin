// Windows 下隐藏控制台窗口，正式运行时只显示窗口本体。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    novel_manager_lib::run()
}
