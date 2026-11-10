//! The [`Platform`] the app uses: Tauri's dialogs and link opener, and the system clipboard.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::host::{BoxFuture, FileKind, Platform};

pub struct TauriPlatform {
    app: AppHandle,
    // X11 clipboard contents are served by their owner; dropping a Clipboard after set_text
    // would discard the copied text unless another clipboard manager had already requested it.
    clipboard: Arc<Mutex<Option<arboard::Clipboard>>>,
}

impl TauriPlatform {
    pub fn new(app: AppHandle) -> Self {
        TauriPlatform {
            app,
            clipboard: Arc::new(Mutex::new(None)),
        }
    }

    fn dialog(&self, title: &str) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
        let dialog = self.app.dialog().file().set_title(title);
        match self.app.get_webview_window("main") {
            Some(window) => dialog.set_parent(&window),
            None => dialog,
        }
    }

    fn clipboard<T: Send + 'static>(
        &self,
        action: impl FnOnce(&mut arboard::Clipboard) -> Result<T, arboard::Error> + Send + 'static,
    ) -> BoxFuture<Result<T, String>> {
        let clipboard = Arc::clone(&self.clipboard);
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut clipboard = clipboard.lock().unwrap_or_else(|error| error.into_inner());
                if clipboard.is_none() {
                    *clipboard = Some(arboard::Clipboard::new().map_err(clipboard_error)?);
                }
                action(clipboard.as_mut().expect("clipboard initialized")).map_err(clipboard_error)
            })
            .await
            .map_err(|error| error.to_string())?
        })
    }
}

type Chosen = tokio::sync::oneshot::Sender<Option<PathBuf>>;

fn chosen() -> (
    impl FnOnce(Option<tauri_plugin_dialog::FilePath>) + Send + 'static,
    BoxFuture<Option<PathBuf>>,
) {
    let (sender, receiver): (Chosen, _) = tokio::sync::oneshot::channel();
    let callback = move |path: Option<tauri_plugin_dialog::FilePath>| {
        let _ = sender.send(path.and_then(|path| path.into_path().ok()));
    };
    (callback, Box::pin(async move { receiver.await.ok().flatten() }))
}

fn clipboard_error(error: arboard::Error) -> String {
    format!("The clipboard is unavailable: {error}")
}

impl Platform for TauriPlatform {
    fn pick_folder(&self, default: Option<PathBuf>) -> BoxFuture<Option<PathBuf>> {
        #[cfg(feature = "e2e")]
        if let Some(run) = self.app.try_state::<crate::e2e::TestRun>() {
            run.dialogs
                .lock()
                .unwrap()
                .push(serde_json::json!({"kind":"folder", "default":default}));
            // An explicit queued null cancels; with no queued choice, keep the real dialog
            // available for manual checks in an isolated profile.
            if let Some(chosen) = run.choices.lock().unwrap().pop_front() {
                return Box::pin(async move { chosen });
            }
        }
        let (callback, result) = chosen();
        let mut dialog = self.dialog("Choose a project folder");
        if let Some(default) = default {
            dialog = dialog.set_directory(default);
        }
        dialog.pick_folder(callback);
        result
    }

    fn save_file(&self, title: &'static str, file_name: String) -> BoxFuture<Option<PathBuf>> {
        #[cfg(feature = "e2e")]
        if let Some(run) = self.app.try_state::<crate::e2e::TestRun>() {
            run.dialogs
                .lock()
                .unwrap()
                .push(serde_json::json!({"kind":"save", "title":title, "name":file_name}));
            // An explicit queued null cancels; with no queued choice, keep the real dialog
            // available for manual checks in an isolated profile.
            if let Some(chosen) = run.choices.lock().unwrap().pop_front() {
                return Box::pin(async move { chosen });
            }
        }
        let (callback, result) = chosen();
        self.dialog(title)
            .set_file_name(file_name)
            .add_filter("Terminal Canvas workspace", &["terminalcanvas"])
            .save_file(callback);
        result
    }

    fn open_file(&self, title: &'static str, kind: FileKind) -> BoxFuture<Option<PathBuf>> {
        #[cfg(feature = "e2e")]
        if let Some(run) = self.app.try_state::<crate::e2e::TestRun>() {
            run.dialogs
                .lock()
                .unwrap()
                .push(serde_json::json!({"kind":format!("{kind:?}"), "title":title}));
            // An explicit queued null cancels; with no queued choice, keep the real dialog
            // available for manual checks in an isolated profile.
            if let Some(chosen) = run.choices.lock().unwrap().pop_front() {
                return Box::pin(async move { chosen });
            }
        }
        let (callback, result) = chosen();
        let dialog = match kind {
            FileKind::Workspace => self
                .dialog(title)
                .add_filter("Terminal Canvas workspace", &["terminalcanvas", "json"]),
            FileKind::Image => self
                .dialog(title)
                .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"]),
        };
        dialog.pick_file(callback);
        result
    }

    fn read_clipboard(&self) -> BoxFuture<Result<String, String>> {
        self.clipboard(|clipboard| {
            match clipboard.get_text() {
                // An empty clipboard pastes nothing, as Electron's readText returned "".
                Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
                result => result,
            }
        })
    }

    fn write_clipboard(&self, text: String) -> BoxFuture<Result<(), String>> {
        self.clipboard(move |clipboard| clipboard.set_text(text))
    }

    fn open_link(&self, url: String) -> BoxFuture<Result<(), String>> {
        #[cfg(feature = "e2e")]
        if let Some(run) = self.app.try_state::<crate::e2e::TestRun>() {
            run.links.lock().unwrap().push(url);
            return Box::pin(async { Ok(()) });
        }
        let result = self
            .app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|error| error.to_string());
        Box::pin(async move { result })
    }

    fn close_window(&self) {
        // macOS keeps an app alive after its last window closes. The host has already flushed
        // recovery and waited for terminal exits, so finish the app explicitly on every OS.
        self.app.exit(0);
    }
}
