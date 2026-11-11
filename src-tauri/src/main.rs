// Release builds on Windows are GUI programs with no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    terminal_canvas::run();
}
