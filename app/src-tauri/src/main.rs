// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|a| a == "--debug-snapshot") {
        claude_pulse_lib::debug_snapshot();
        return;
    }
    claude_pulse_lib::run();
}
