//! Desktop shell. The UI is the same React bundle as the web build; this crate adds what a
//! browser cannot do: read and write a vault folder on disk, receive Google's OAuth redirect
//! on a loopback port, and keep the refresh token in the OS keychain.

mod oauth;
mod secrets;
mod vault_fs;

use std::net::TcpListener;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};

// ---- vault folder -------------------------------------------------------------------------

#[tauri::command(async)]
fn fs_list(root: String) -> Result<Vec<vault_fs::Entry>, String> {
    vault_fs::list(&root)
}

#[tauri::command(async)]
fn fs_stat(root: String, path: String) -> Result<Option<vault_fs::Entry>, String> {
    vault_fs::stat(&root, &path)
}

/// Returns the raw bytes (the frontend receives an `ArrayBuffer`).
#[tauri::command(async)]
fn fs_read(root: String, path: String) -> Result<Response, String> {
    vault_fs::read(&root, &path).map(Response::new)
}

/// The body is the raw file bytes; `root` and `path` travel percent-encoded in headers because
/// they may contain non-ASCII characters.
#[tauri::command(async)]
fn fs_write(request: Request<'_>) -> Result<(), String> {
    let header = |name: &str| -> Result<String, String> {
        let v = request.headers().get(name).ok_or_else(|| format!("missing header {name}"))?;
        vault_fs::percent_decode(v.to_str().map_err(|e| e.to_string())?)
    };
    let (root, path) = (header("x-root")?, header("x-path")?);
    match request.body() {
        InvokeBody::Raw(bytes) => vault_fs::write(&root, &path, bytes),
        InvokeBody::Json(_) => Err("expected a raw body".into()),
    }
}

#[tauri::command(async)]
fn fs_mkdir(root: String, path: String) -> Result<(), String> {
    vault_fs::mkdir(&root, &path)
}

#[tauri::command(async)]
fn fs_rename(root: String, from: String, to: String) -> Result<(), String> {
    vault_fs::rename(&root, &from, &to)
}

#[tauri::command(async)]
fn fs_remove(root: String, path: String) -> Result<(), String> {
    vault_fs::remove(&root, &path)
}

// ---- Google sign-in (loopback redirect) ---------------------------------------------------

#[derive(Default)]
struct OAuthState(Mutex<Option<TcpListener>>);

/// Start listening on a free loopback port and return it, so the frontend can build the
/// authorization URL with `redirect_uri=http://127.0.0.1:<port>`.
#[tauri::command]
fn oauth_listen(state: tauri::State<'_, OAuthState>) -> Result<u16, String> {
    let (listener, port) = oauth::listen().map_err(|e| e.to_string())?;
    *state.0.lock().map_err(|e| e.to_string())? = Some(listener);
    Ok(port)
}

/// Wait (up to five minutes) for the browser to be redirected back; returns the query string.
#[tauri::command]
async fn oauth_wait(state: tauri::State<'_, OAuthState>) -> Result<String, String> {
    let listener = state.0.lock().map_err(|e| e.to_string())?.take().ok_or("sign-in was not started")?;
    tauri::async_runtime::spawn_blocking(move || oauth::wait(listener, Duration::from_secs(300)))
        .await
        .map_err(|e| e.to_string())?
}

// ---- keychain -----------------------------------------------------------------------------

#[tauri::command(async)]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value)
}

#[tauri::command(async)]
fn secret_get(key: String) -> Result<Option<String>, String> {
    secrets::get(&key)
}

#[tauri::command(async)]
fn secret_delete(key: String) -> Result<(), String> {
    secrets::delete(&key)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .manage(OAuthState::default())
        .invoke_handler(tauri::generate_handler![
            fs_list,
            fs_stat,
            fs_read,
            fs_write,
            fs_mkdir,
            fs_rename,
            fs_remove,
            oauth_listen,
            oauth_wait,
            secret_set,
            secret_get,
            secret_delete
        ])
        .run(tauri::generate_context!())
        .expect("error while running Yobsidian");
}
