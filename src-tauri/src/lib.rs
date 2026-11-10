//! Terminal Canvas, the desktop app: a Tauri 2 host for the web UI in `src/`.
//!
//! The host logic is in [`host`], testable without a window. This module wires it to Tauri: one
//! command per renderer action, the `tc-asset` image scheme, the window, and the app lifecycle.

#[cfg(feature = "e2e")]
mod e2e;
pub mod host;
pub mod platform;
pub mod protocol;
#[cfg(all(feature = "e2e", not(debug_assertions)))]
compile_error!("The e2e feature must never be enabled in release builds.");
#[cfg(windows)]
mod webview2;

use std::path::PathBuf;
use std::sync::Arc;

#[cfg(feature = "e2e")]
use e2e::{e2e_dialog, e2e_focus, e2e_request_close, e2e_state};
use serde_json::Value;
use tauri::ipc::{Channel, InvokeBody, Request};
use tauri::webview::{NewWindowResponse, PermissionResponse};
use tauri::{LogicalSize, Manager, RunEvent, State, Url, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tc_pty::PtyBackend;
use tc_pty::manager::{Backend, Config};

use host::{Host, Paths};

/// Only the app's own pages: `tauri://localhost` on macOS and Linux, `http://tauri.localhost` on Windows.
pub fn is_app_url(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() || url.port().is_some() {
        return false;
    }
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    }
}

/// Every command checks that it comes from the main window showing the app's own page.
fn authorized(webview: &Webview) -> Result<(), String> {
    let main = webview.label() == "main" && webview.url().is_ok_and(|url| is_app_url(&url));
    if main {
        Ok(())
    } else {
        Err("Unauthorized caller.".into())
    }
}

/// The `payload` argument, keeping the difference between an absent payload and `null`.
fn payload(request: &Request<'_>) -> Option<Value> {
    match request.body() {
        InvokeBody::Json(Value::Object(arguments)) => arguments.get("payload").cloned(),
        _ => None,
    }
}

macro_rules! actions {
    ($($name:ident => $action:literal),* $(,)?) => {
        $(
            #[tauri::command]
            async fn $name(webview: Webview, host: State<'_, Arc<Host>>, request: Request<'_>) -> Result<Value, String> {
                authorized(&webview)?;
                host.command($action, payload(&request).as_ref()).await
            }
        )*
    };
}

actions! {
    create_card => "create-card",
    autosave => "autosave",
    save => "save",
    save_as => "save-as",
    export => "export",
    open => "open",
    new => "new",
    close => "close",
    duplicate_directory => "duplicate-directory",
    start => "start",
    stop => "stop",
    pick_folder => "pick-folder",
    pick_image => "pick-image",
    unused_images => "unused-images",
    delete_unused_images => "delete-unused-images",
    open_link => "open-link",
    clipboard_read => "clipboard-read",
    clipboard_write => "clipboard-write",
}

/// Connects the renderer's event channel and returns the restored workspace.
#[tauri::command]
async fn initialize(webview: Webview, host: State<'_, Arc<Host>>, events: Channel<Value>) -> Result<Value, String> {
    authorized(&webview)?;
    host.connect(Arc::new(move |event| {
        let _ = events.send(event);
    }));
    host.command("initialize", None).await
}

/// The image arrives as the raw IPC body, not as a JSON array of numbers.
#[tauri::command]
async fn import_image(webview: Webview, host: State<'_, Arc<Host>>, request: Request<'_>) -> Result<Value, String> {
    authorized(&webview)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => Some(bytes.clone()),
        InvokeBody::Json(_) => None,
    };
    host.import_image(bytes).await
}

#[tauri::command]
async fn input(webview: Webview, host: State<'_, Arc<Host>>, id: String, data: String, seq: u64) -> Result<(), String> {
    authorized(&webview)?;
    host.input(&id, data, seq);
    Ok(())
}

#[tauri::command]
async fn resize(
    webview: Webview,
    host: State<'_, Arc<Host>>,
    id: String,
    cols: Value,
    rows: Value,
) -> Result<(), String> {
    authorized(&webview)?;
    host.resize(&id, &cols, &rows);
    Ok(())
}

#[tauri::command]
async fn ack(webview: Webview, host: State<'_, Arc<Host>>, id: String, amount: Value) -> Result<(), String> {
    authorized(&webview)?;
    host.acknowledge(&id, &amount);
    Ok(())
}

/// `tc-hook` ships next to the app's executable.
fn sidecar(name: &str) -> Option<PathBuf> {
    let file = format!("{name}{}", std::env::consts::EXE_SUFFIX);
    let hook = std::env::current_exe().ok()?.parent()?.join(file);
    if hook.is_file() {
        Some(hook)
    } else {
        eprintln!(
            "{} was not found, so AI sessions will not be captured. Build it with: cargo build -p tc-hook",
            hook.display()
        );
        None
    }
}

fn create_window(app: &tauri::App, host: &Arc<Host>) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Terminal Canvas")
        .visible(false)
        .inner_size(1500.0, 960.0)
        .background_color(tauri::window::Color(0x11, 0x13, 0x18, 0xff))
        // OS file drops must reach the canvas as images.
        .disable_drag_drop_handler()
        // Ctrl+wheel and Ctrl+= belong to the canvas.
        .zoom_hotkeys_enabled(false)
        .on_navigation(is_app_url)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_permission_request(|_, _| PermissionResponse::Deny);
    #[cfg(feature = "e2e")]
    let builder = if let Some(run) = app.try_state::<e2e::TestRun>() {
        builder.data_directory(run.profile.join("webview"))
    } else {
        builder
    };
    let window = builder.build()?;
    // Electron's width/height (and minima) include native decorations. Tauri's sizing
    // methods address the content area. Measure the actual frame at this display's DPI
    // rather than making the canvas larger by a platform-specific title bar and border.
    let scale = window.scale_factor()?;
    let outer = window.outer_size()?.to_logical::<f64>(scale);
    let inner = window.inner_size()?.to_logical::<f64>(scale);
    let frame = LogicalSize::new(
        (outer.width - inner.width).max(0.0),
        (outer.height - inner.height).max(0.0),
    );
    window.set_min_size(Some(content_size_for_outer(LogicalSize::new(1000.0, 680.0), frame)))?;
    window.set_size(content_size_for_outer(LogicalSize::new(1500.0, 960.0), frame))?;
    window.show()?;
    let closing = Arc::clone(host);
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } if closing.close_requested() => api.prevent_close(),
        // Unexpected native destruction can skip the renderer handshake. macOS does not request
        // app exit automatically when its last window closes.
        WindowEvent::Destroyed if !closing.quitting() => {
            let host = Arc::clone(&closing);
            tauri::async_runtime::spawn(async move { host.renderer_crashed().await });
        }
        _ => {}
    });
    #[cfg(windows)]
    webview2::configure(&window, Arc::clone(host))?;
    Ok(())
}

fn content_size_for_outer(outer: LogicalSize<f64>, frame: LogicalSize<f64>) -> LogicalSize<f64> {
    LogicalSize::new(
        (outer.width - frame.width).max(1.0),
        (outer.height - frame.height).max(1.0),
    )
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .register_asynchronous_uri_scheme_protocol("tc-asset", |context, request, responder| {
            let assets = context.app_handle().state::<Arc<Host>>().assets_folder();
            let uri = request.uri().to_string();
            std::thread::spawn(move || {
                let response = protocol::asset_response(&assets, &uri);
                #[cfg(feature = "e2e")]
                eprintln!("tc-asset {uri} -> {} (assets: {})", response.status(), assets.display());
                responder.respond(response);
            });
        })
        .invoke_handler(tauri::generate_handler![
            initialize,
            create_card,
            autosave,
            save,
            save_as,
            export,
            open,
            new,
            close,
            duplicate_directory,
            start,
            stop,
            pick_folder,
            import_image,
            pick_image,
            unused_images,
            delete_unused_images,
            open_link,
            clipboard_read,
            clipboard_write,
            input,
            resize,
            ack,
            #[cfg(feature = "e2e")]
            e2e_state,
            #[cfg(feature = "e2e")]
            e2e_focus,
            #[cfg(feature = "e2e")]
            e2e_dialog,
            #[cfg(feature = "e2e")]
            e2e_request_close,
        ])
        .setup(|app| {
            #[cfg(not(feature = "e2e"))]
            let data = tc_core::dirs::app_data_dir().ok_or("The app data folder is unavailable.")?;
            #[cfg(feature = "e2e")]
            let data = {
                let run = e2e::TestRun::from_args(std::env::args())?;
                let profile = run.profile.clone();
                eprintln!("Using isolated test profile: {}", profile.display());
                app.manage(run);
                app.add_capability(
                    tauri::ipc::CapabilityBuilder::new("e2e")
                        .window("main")
                        .permission("allow-e2e-state")
                        .permission("allow-e2e-focus")
                        .permission("allow-e2e-dialog")
                        .permission("allow-e2e-request-close"),
                )?;
                profile
            };
            let paths = Paths {
                data,
                hook: sidecar("tc-hook"),
            };
            let platform = Arc::new(platform::TauriPlatform::new(app.handle().clone()));
            #[cfg(not(feature = "e2e"))]
            let backend: Box<dyn Backend> = Box::new(PtyBackend);
            #[cfg(feature = "e2e")]
            let backend: Box<dyn Backend> = Box::new(e2e::TestBackend(PtyBackend));
            let host = Host::new(paths, platform, backend, Config::from_environment());
            app.manage(Arc::clone(&host));
            create_window(app, &host)?;
            Ok(())
        })
        .build(tauri::generate_context!());
    let app = match app {
        Ok(app) => app,
        Err(error) => {
            eprintln!("Terminal Canvas could not start: {error}");
            std::process::exit(1);
        }
    };
    app.run(|app, event| match event {
        // Quitting asks the renderer to confirm first, like closing the window.
        RunEvent::ExitRequested { api, .. }
            if app.try_state::<Arc<Host>>().is_some_and(|host| host.exit_requested()) =>
        {
            api.prevent_exit();
        }
        RunEvent::Exit => {
            if let Some(host) = app.try_state::<Arc<Host>>() {
                host.stop_all();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_content_preserves_the_electron_outer_dimensions_at_each_display_scale() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            // A Windows frame: 16 logical pixels across and 39 including its title bar.
            let physical_frame = tauri::PhysicalSize::new(16.0 * scale, 39.0 * scale);
            let frame = physical_frame.to_logical::<f64>(scale);
            assert_eq!(
                content_size_for_outer(LogicalSize::new(1500.0, 960.0), frame),
                LogicalSize::new(1484.0, 921.0)
            );
            assert_eq!(
                content_size_for_outer(LogicalSize::new(1000.0, 680.0), frame),
                LogicalSize::new(984.0, 641.0)
            );
        }
        let mac_frame = LogicalSize::new(0.0, 22.0);
        assert_eq!(
            content_size_for_outer(LogicalSize::new(1500.0, 960.0), mac_frame),
            LogicalSize::new(1500.0, 938.0)
        );
    }

    #[test]
    fn windows_bundle_overlay_is_valid_and_ships_the_hook_with_webview_installation() {
        let mut base: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let overlay: Value = serde_json::from_str(include_str!("../bundle.windows.json")).unwrap();
        base["mainBinaryName"] = overlay["mainBinaryName"].clone();
        base["bundle"] = overlay["bundle"].clone();
        let config: tauri::Config = serde_json::from_value(base).unwrap();
        assert_eq!(config.main_binary_name.as_deref(), Some("Terminal Canvas"));
        assert_eq!(config.bundle.external_bin.unwrap(), ["binaries/tc-hook"]);
        assert_eq!(overlay["bundle"]["targets"], serde_json::json!(["nsis"]));
        assert_eq!(
            overlay["bundle"]["windows"]["webviewInstallMode"]["type"],
            "downloadBootstrapper"
        );
        assert_eq!(overlay["bundle"]["windows"]["nsis"]["installMode"], "currentUser");
    }

    #[test]
    fn navigation_accepts_only_the_local_app_origins() {
        for url in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
        ] {
            assert!(is_app_url(&Url::parse(url).unwrap()), "{url}");
        }
        for url in [
            "https://example.com/",
            "file:///index.html",
            "javascript:alert(1)",
            "http://localhost/",
            "http://tauri.localhost:4174/",
            "http://user:password@tauri.localhost/",
            "tauri://other/index.html",
        ] {
            assert!(!is_app_url(&Url::parse(url).unwrap()), "{url}");
        }
    }
}
