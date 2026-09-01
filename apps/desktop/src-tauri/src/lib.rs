/// The desktop shell.
///
/// It deliberately owns no logic: the engine is the single writer, and the
/// window renders what the engine reports. The only native capability the app
/// needs is opening an Axiom link in the user's real browser.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .run(tauri::generate_context!())
        .expect("error while running Cryptonix");
}
