//! WebView2 settings Tauri does not expose. Without them, WebView2 would change how the app behaves
//! compared with the Electron build.
//!
//! - Browser shortcuts (F5, Ctrl+R, Ctrl+F, Ctrl+P, and the DevTools keys such as Ctrl+Shift+C) are
//!   turned off, so they reach the canvas and the terminals.
//! - Every permission request (camera, microphone, location, notifications, clipboard) is denied.
//! - When the renderer process dies, the host saves what it knows and closes, as Electron's
//!   `render-process-gone` handler did.
#![allow(unsafe_code)]

use std::sync::Arc;

use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_STATE_DENY, COREWEBVIEW2_PROCESS_FAILED_KIND,
    COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE, ICoreWebView2Settings3,
};
use webview2_com::{PermissionRequestedEventHandler, ProcessFailedEventHandler};
use windows::core::Interface;

use crate::host::Host;

pub fn configure(window: &WebviewWindow, host: Arc<Host>) -> tauri::Result<()> {
    window.with_webview(move |webview| {
        // SAFETY: the controller and its interfaces are valid on the webview's thread, where
        // `with_webview` runs this closure.
        let result = unsafe {
            (|| -> windows::core::Result<()> {
                let core = webview.controller().CoreWebView2()?;
                core.Settings()?
                    .cast::<ICoreWebView2Settings3>()?
                    .SetAreBrowserAcceleratorKeysEnabled(false)?;
                let mut token = Default::default();
                core.add_PermissionRequested(
                    &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                        if let Some(args) = args {
                            args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
                let renderer_host = Arc::clone(&host);
                core.add_ProcessFailed(
                    &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                        args.ProcessFailedKind(&mut kind)?;
                        let renderer_gone = [
                            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
                            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
                            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
                        ]
                        .contains(&kind);
                        if renderer_gone {
                            let host = Arc::clone(&renderer_host);
                            tauri::async_runtime::spawn(async move { host.renderer_crashed().await });
                        }
                        Ok(())
                    })),
                    &mut token,
                )?;
                Ok(())
            })()
        };
        if let Err(error) = result {
            eprintln!("Could not configure WebView2: {error}");
            tauri::async_runtime::spawn(async move { host.renderer_crashed().await });
        }
    })
}
