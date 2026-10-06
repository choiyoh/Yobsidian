//! Desktop shell. The UI is the same React bundle as the web build; native
//! capabilities (local vault filesystem, file watching, Google OAuth loopback)
//! are added here as Tauri plugins and commands in later stages.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Yobsidian");
}
