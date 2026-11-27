//! Opt-in browser transport over loopback HTTP or HTTPS on a selected network interface.

use std::collections::{HashMap, VecDeque};
use std::net::Ipv4Addr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade, close_code};
use axum::extract::{DefaultBodyLimit, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{Value, json};
use subtle::ConstantTimeEq;
use tokio::sync::watch;

use crate::host::{BoxFuture, Host};
use crate::remote_tls::{self, CertificateAuthority};

const SESSION_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const LOGIN_WINDOW: Duration = Duration::from_secs(60);
const MAX_CLIENTS: usize = 8;
// One 64 Ki UTF-16 input piece can use six JSON bytes per code unit when escaped.
const MAX_MESSAGE: usize = 512 * 1024;
const MAX_CONTROLLER_MESSAGE: usize = tc_core::workspace::limits::BYTES as usize + 4096;
// Startup sends the workspace and up to 2 MiB of replay before JSON escaping.
const SNAPSHOT_WRITE_TIMEOUT: Duration = Duration::from_secs(15);
const EVENT_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

pub type Assets = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;

fn secret() -> String {
    // Two independent OS-random UUIDs: 244 random bits. Never persisted or placed in a URL.
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

#[derive(Clone, Copy)]
enum Role {
    Control,
    View,
}

struct Session {
    role: Role,
    created: Instant,
    active: Arc<AtomicBool>,
    connected: bool,
}

struct Security {
    control: String,
    view: String,
    sessions: HashMap<String, Session>,
    failures: VecDeque<Instant>,
}

impl Security {
    fn new() -> Self {
        Self {
            control: secret(),
            view: secret(),
            sessions: HashMap::new(),
            failures: VecDeque::new(),
        }
    }

    fn expire(&mut self) {
        self.expire_at(Instant::now());
    }

    fn expire_at(&mut self, now: Instant) {
        self.sessions.retain(|_, session| {
            let live = now.duration_since(session.created) < SESSION_TTL && session.active.load(Ordering::Acquire);
            if !live {
                session.active.store(false, Ordering::Release);
            }
            live
        });
    }

    fn revoke(&mut self) {
        for session in self.sessions.values() {
            session.active.store(false, Ordering::Release);
        }
        self.sessions.clear();
    }

    fn login(&mut self, token: &str) -> Result<String, StatusCode> {
        self.login_at(token, Instant::now())
    }

    fn login_at(&mut self, token: &str, now: Instant) -> Result<String, StatusCode> {
        self.expire_at(now);
        self.failures.retain(|time| now.duration_since(*time) < LOGIN_WINDOW);
        if self.failures.len() >= 5 {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let control = self.control.as_bytes().ct_eq(token.as_bytes()).into();
        let view: bool = self.view.as_bytes().ct_eq(token.as_bytes()).into();
        let role = if control {
            Role::Control
        } else if view {
            Role::View
        } else {
            self.failures.push_back(now);
            return Err(StatusCode::UNAUTHORIZED);
        };
        if self.sessions.len() >= MAX_CLIENTS {
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        let id = secret();
        self.sessions.insert(
            id.clone(),
            Session {
                role,
                created: now,
                active: Arc::new(AtomicBool::new(true)),
                connected: false,
            },
        );
        Ok(id)
    }
}

struct Server {
    host: Arc<Host>,
    authority: String,
    origin: String,
    https: bool,
    cookie: String,
    assets: Assets,
    security: Mutex<Security>,
    stop: watch::Sender<bool>,
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl Server {
    fn status(&self, tokens: bool) -> Value {
        let mut security = self.security.lock().unwrap_or_else(|e| e.into_inner());
        security.expire();
        let mut status = json!({ "running": !*self.stop.borrow(), "url": self.origin, "https": self.https,
            "clients": security.sessions.values().filter(|s| s.connected).count() });
        if tokens {
            status["controlToken"] = json!(security.control);
            status["viewToken"] = json!(security.view);
        }
        status
    }

    fn notify(&self) {
        let mut event = self.status(false);
        event["type"] = json!("remote-status");
        self.host.emit(event);
    }

    fn cookie_id<'a>(&self, headers: &'a HeaderMap) -> Option<&'a str> {
        headers.get(header::COOKIE)?.to_str().ok()?.split(';').find_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            (name == self.cookie).then_some(value)
        })
    }

    fn session(&self, headers: &HeaderMap) -> Option<String> {
        let id = self.cookie_id(headers)?;
        let mut security = self.security.lock().unwrap_or_else(|e| e.into_inner());
        security.expire();
        security.sessions.contains_key(id).then(|| id.to_owned())
    }

    fn controller(&self, headers: &HeaderMap) -> Option<Arc<AtomicBool>> {
        let id = self.cookie_id(headers)?;
        let mut security = self.security.lock().unwrap_or_else(|error| error.into_inner());
        security.expire();
        let session = security.sessions.get(id)?;
        (session.connected && matches!(session.role, Role::Control)).then(|| session.active.clone())
    }

    fn valid_headers(&self, headers: &HeaderMap, require_origin: bool) -> bool {
        let single = |name| {
            let mut values = headers.get_all(name).iter();
            let value = values.next()?.to_str().ok()?;
            values.next().is_none().then_some(value)
        };
        single(header::HOST).is_some_and(|host| {
            host == self.authority
                || (self.https && self.authority.strip_suffix(":443") == Some(host))
                || (!self.https && self.authority.strip_suffix(":80") == Some(host))
        }) && match single(header::ORIGIN) {
            Some(origin) => origin == self.origin,
            None => !require_origin && !headers.contains_key(header::ORIGIN),
        } && headers.get("sec-fetch-site").is_none_or(|v| v != "cross-site")
    }
}

/// Lifetime belongs to the app, with all lifecycle changes serialized. Constructing it never listens.
pub struct Remote {
    host: Arc<Host>,
    assets: Assets,
    server: tokio::sync::Mutex<Option<Arc<Server>>>,
    certificate: Mutex<Option<CertificateAuthority>>,
}

impl Remote {
    pub fn new(host: Arc<Host>, assets: Assets) -> Self {
        Self {
            host,
            assets,
            server: tokio::sync::Mutex::new(None),
            certificate: Mutex::new(None),
        }
    }

    pub async fn command(&self, action: &str, payload: Option<&Value>) -> Result<Value, String> {
        let mut current = self.server.lock().await;
        if current.as_ref().is_some_and(|server| *server.stop.borrow()) {
            current.take();
            self.host.remote_detach().await;
        }
        match action {
            "remote-start" => {
                if current.is_some() {
                    return Err("The browser server is already running.".into());
                }
                let port = payload
                    .and_then(|p| p.get("port"))
                    .and_then(Value::as_u64)
                    .filter(|p| *p <= u16::MAX as u64)
                    .ok_or("Choose a port from 0 to 65535.")?;
                let address = network_address(payload.and_then(|p| p.get("address")))?;
                let listener = tokio::net::TcpListener::bind((address.unwrap_or(Ipv4Addr::LOCALHOST), port as u16))
                    .await
                    .map_err(|e| format!("Could not start the browser server: {e}"))?;
                let port = listener.local_addr().map_err(|e| e.to_string())?.port();
                let ip = address.unwrap_or(Ipv4Addr::LOCALHOST);
                let authority = format!("{ip}:{port}");
                let (scheme, default_port) = if address.is_some() {
                    ("https", 443)
                } else {
                    ("http", 80)
                };
                let origin = if port == default_port {
                    format!("{scheme}://{ip}")
                } else {
                    format!("{scheme}://{authority}")
                };
                let tls = if let Some(address) = address {
                    let mut certificate = self.certificate.lock().unwrap_or_else(|error| error.into_inner());
                    if certificate.is_none() {
                        *certificate = Some(
                            CertificateAuthority::new()
                                .map_err(|error| format!("Could not create the browser certificate: {error}"))?,
                        );
                    }
                    Some(
                        certificate
                            .as_ref()
                            .expect("certificate initialized")
                            .acceptor(address)?,
                    )
                } else {
                    None
                };
                let (stop, _) = watch::channel(false);
                let server = Arc::new(Server {
                    host: self.host.clone(),
                    origin,
                    https: tls.is_some(),
                    authority,
                    cookie: format!("tc_remote_{port}"),
                    assets: self.assets.clone(),
                    security: Mutex::new(Security::new()),
                    stop,
                    task: Mutex::new(None),
                });
                self.host.remote_begin(secret()).await;
                let router = router(server.clone());
                let mut stopping = server.stop.subscribe();
                let serving = server.clone();
                let task = tauri::async_runtime::spawn(async move {
                    let stop = async move {
                        let _ = stopping.changed().await;
                    };
                    let result = match tls {
                        Some(tls) => {
                            axum::serve(remote_tls::Listener::new(listener, tls), router)
                                .with_graceful_shutdown(stop)
                                .await
                        }
                        None => axum::serve(listener, router).with_graceful_shutdown(stop).await,
                    };
                    if let Err(error) = result {
                        serving.security.lock().unwrap_or_else(|e| e.into_inner()).revoke();
                        serving.stop.send_replace(true);
                        serving.notify();
                        serving
                            .host
                            .emit(json!({ "type": "error", "message": format!("Browser server stopped: {error}") }));
                    }
                });
                *server.task.lock().unwrap_or_else(|e| e.into_inner()) = Some(task);
                let status = server.status(true);
                server.notify();
                *current = Some(server);
                Ok(status)
            }
            "remote-certificate" => {
                let certificate = self
                    .certificate
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .as_ref()
                    .ok_or("Start network browser access first.")?
                    .certificate()
                    .to_vec();
                drop(current);
                self.host.save_browser_certificate(certificate).await
            }
            "remote-stop" => {
                if let Some(server) = current.take() {
                    server.security.lock().unwrap_or_else(|e| e.into_inner()).revoke();
                    server.stop.send_replace(true);
                    let task = server.task.lock().unwrap_or_else(|e| e.into_inner()).take();
                    if let Some(mut task) = task
                        && tokio::time::timeout(Duration::from_secs(4), &mut task).await.is_err()
                    {
                        task.abort();
                    }
                    self.host.remote_detach().await;
                }
                self.host
                    .emit(json!({ "type": "remote-status", "running": false, "clients": 0 }));
                Ok(json!({ "running": false, "clients": 0 }))
            }
            "remote-rotate" | "remote-revoke" => {
                let server = current.as_ref().ok_or("The browser server is stopped.")?;
                {
                    let mut security = server.security.lock().unwrap_or_else(|e| e.into_inner());
                    security.revoke();
                    if action == "remote-rotate" {
                        security.control = secret();
                        security.view = secret();
                    }
                }
                server.notify();
                Ok(server.status(true))
            }
            "remote-status" => Ok(current
                .as_ref()
                .map_or(json!({ "running": false, "clients": 0 }), |s| s.status(true))),
            _ => Err("Unsupported browser server command.".into()),
        }
    }
}

fn network_address(value: Option<&Value>) -> Result<Option<Ipv4Addr>, String> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let address = value
                .as_str()
                .and_then(|address| address.trim().parse::<Ipv4Addr>().ok())
                .filter(|address| {
                    address.is_private() || address.is_link_local() || matches!(address.octets(), [100, 64..=127, _, _])
                })
                .ok_or("Enter this computer's private IPv4 address on the network.")?;
            Ok(Some(address))
        }
    }
}

impl Drop for Remote {
    fn drop(&mut self) {
        if let Some(server) = self.server.get_mut().take() {
            server.security.lock().unwrap_or_else(|e| e.into_inner()).revoke();
            server.stop.send_replace(true);
            if let Some(task) = server.task.lock().unwrap_or_else(|e| e.into_inner()).take() {
                task.abort();
            }
        }
    }
}

fn router(server: Arc<Server>) -> Router {
    Router::new()
        .route("/login", post(login).layer(DefaultBodyLimit::max(1024)))
        .route("/ws", get(upgrade))
        .route("/upload-image", post(upload_image))
        .route(
            "/workspace-copy",
            post(workspace_copy).layer(DefaultBodyLimit::max(1024)),
        )
        .fallback(get(files))
        .layer(middleware::from_fn_with_state(server.clone(), boundary))
        .with_state(server)
}

async fn upload_image(State(server): State<Arc<Server>>, request: Request) -> Response {
    let Some(active) = server.controller(request.headers()) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let Ok(bytes) = axum::body::to_bytes(request.into_body(), tc_core::assets::IMAGE_BYTES).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    Json(
        server
            .host
            .store_remote_image(bytes.to_vec(), active)
            .await
            .unwrap_or_else(|error| json!({"error":error})),
    )
    .into_response()
}

async fn workspace_copy(State(server): State<Arc<Server>>, headers: HeaderMap, Json(portable): Json<bool>) -> Response {
    let Some(active) = server.controller(&headers) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    Json(
        server
            .host
            .remote_workspace_copy(portable, active)
            .await
            .unwrap_or_else(|error| json!({"error": error})),
    )
    .into_response()
}

async fn boundary(State(server): State<Arc<Server>>, request: Request, next: Next) -> Response {
    let require_origin = request.method() != axum::http::Method::GET || request.uri().path() == "/ws";
    let mut response = if *server.stop.borrow() || !server.valid_headers(request.headers(), require_origin) {
        StatusCode::FORBIDDEN.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(CSP));
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    response
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Login {
    token: String,
}

async fn login(State(server): State<Arc<Server>>, Json(login): Json<Login>) -> Response {
    let result = server
        .security
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .login(&login.token);
    match result {
        Ok(id) => {
            let cookie = format!(
                "{}={id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200{}",
                server.cookie,
                if server.https { "; Secure" } else { "" }
            );
            ([(header::SET_COOKIE, cookie)], StatusCode::NO_CONTENT).into_response()
        }
        Err(status) => status.into_response(),
    }
}

// Explicit package assets only. Never serve a directory, user path, workspace, hook, or source map.
fn static_path(path: &str) -> Option<&str> {
    match path {
        "/" | "/index.html" => Some("index.html"),
        "/styles.css"
        | "/typography.css"
        | "/chrome.css"
        | "/bridge.js"
        | "/remote-bridge.js"
        | "/remote-ui.js"
        | "/remote.css"
        | "/remote-login.js"
        | "/minimap.js"
        | "/canvas-geometry.js"
        | "/canvases.js"
        | "/terminal-pointer.js"
        | "/item-styles.js"
        | "/terminal-themes.js"
        | "/hook-pointers.js"
        | "/items.js"
        | "/history.js"
        | "/clipboard.js"
        | "/renderer.js"
        | "/vendor/xterm.js"
        | "/vendor/xterm.css"
        | "/vendor/addon-fit.js"
        | "/vendor/addon-serialize.js"
        | "/assets/logo.svg" => path.strip_prefix('/'),
        _ => None,
    }
}

async fn files(State(server): State<Arc<Server>>, request: Request) -> Response {
    let path = request.uri().path();
    if path == "/remote-login.js" || path == "/remote.css" {
        return packaged(&server, &path[1..]);
    }
    if server.session(request.headers()).is_none() {
        if path == "/" || path == "/index.html" {
            return (
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                include_str!("../../src/remote-login.html"),
            )
                .into_response();
        }
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if let Some(name) = path.strip_prefix("/images/") {
        // Reuse the desktop's content-addressed asset validation and response headers.
        let assets = server.host.assets_folder();
        let uri = format!("tc-asset://images/{name}");
        return tokio::task::spawn_blocking(move || {
            crate::protocol::asset_response(&assets, &uri)
                .map(Body::from)
                .into_response()
        })
        .await
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    match static_path(path) {
        Some(path) => packaged(&server, path),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn packaged(server: &Server, path: &str) -> Response {
    match (server.assets)(path) {
        Some((bytes, mime)) => ([(header::CONTENT_TYPE, mime)], bytes).into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn upgrade(State(server): State<Arc<Server>>, headers: HeaderMap, ws: WebSocketUpgrade) -> Response {
    let Some(id) = server.session(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let role = {
        let mut security = server.security.lock().unwrap_or_else(|e| e.into_inner());
        let Some(session) = security.sessions.get(&id) else {
            return StatusCode::UNAUTHORIZED.into_response();
        };
        if session.connected
            || (matches!(session.role, Role::Control)
                && security
                    .sessions
                    .values()
                    .any(|s| matches!(s.role, Role::Control) && s.connected))
        {
            return StatusCode::CONFLICT.into_response();
        }
        let session = security.sessions.get_mut(&id).expect("session exists while locked");
        session.connected = true;
        session.role
    };
    let failure_server = server.clone();
    let failure_id = id.clone();
    let message_limit = if matches!(role, Role::Control) {
        MAX_CONTROLLER_MESSAGE
    } else {
        MAX_MESSAGE
    };
    ws.max_message_size(message_limit)
        .max_frame_size(message_limit)
        .on_failed_upgrade(move |_| disconnect(&failure_server, &failure_id))
        .on_upgrade(move |socket| connected(server, id, role, socket))
        .into_response()
}

fn disconnect(server: &Server, id: &str) {
    if let Some(session) = server
        .security
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .sessions
        .get_mut(id)
    {
        session.connected = false;
    }
    server.notify();
}

async fn connected(server: Arc<Server>, id: String, role: Role, mut socket: WebSocket) {
    let active = {
        let security = server.security.lock().unwrap_or_else(|e| e.into_inner());
        security.sessions.get(&id).map(|s| s.active.clone())
    };
    let Some(active) = active else {
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    server.notify();
    let Some((mut snapshot, mut events)) = server.host.remote_attach().await else {
        disconnect(&server, &id);
        return;
    };
    snapshot["type"] = json!("remote-initialize");
    snapshot["role"] = json!(if matches!(role, Role::Control) {
        "control"
    } else {
        "view"
    });
    // A cancelled or timed-out write can leave part of the snapshot buffered in
    // the socket. Drop it without flushing if the session ends during startup.
    let initialized = tokio::select! {
        biased;
        _ = session_ended(&server, &active) => false,
        result = send(&mut socket, snapshot, SNAPSHOT_WRITE_TIMEOUT) => result.is_ok(),
    };
    if initialized {
        let close = stream_events(&server, &active, role, &mut socket, &mut events).await;
        let _ = tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Close(close))).await;
    }
    disconnect(&server, &id);
}

async fn session_ended(server: &Server, active: &AtomicBool) {
    let mut stop = server.stop.subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
    while active.load(Ordering::Acquire) && !*stop.borrow() {
        tokio::select! {
            _ = stop.changed() => return,
            _ = heartbeat.tick() => {
                server.security.lock().unwrap_or_else(|e| e.into_inner()).expire();
            }
        }
    }
}

async fn stream_events(
    server: &Server,
    active: &Arc<AtomicBool>,
    role: Role,
    socket: &mut WebSocket,
    events: &mut tokio::sync::broadcast::Receiver<Value>,
) -> Option<CloseFrame> {
    let ended = session_ended(server, active);
    tokio::pin!(ended);
    let mut messages = 0;
    let mut started = Instant::now();
    let mut next_sequence = 0u64;
    let mut pending: Option<BoxFuture<Value>> = None;
    'connection: loop {
        if !active.load(Ordering::Acquire) || *server.stop.borrow() {
            break;
        }
        tokio::select! {
            _ = &mut ended => break,
            event = events.recv() => {
                // Lagging clients reconnect for a fresh snapshot; never pause the desktop PTY.
                if !active.load(Ordering::Acquire) { break; }
                match event {
                    Ok(event) => if send(socket, event, EVENT_WRITE_TIMEOUT).await.is_err() { break; },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        return Some(CloseFrame {
                            code: close_code::AGAIN,
                            reason: "Browser connection fell behind terminal output. Reload to reconnect.".into(),
                        });
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
            result = async { pending.as_mut().expect("pending command").await }, if pending.is_some() => {
                pending = None;
                // Deliver the lifecycle changes queued by the desktop before its reply.
                for _ in 0..events.len() {
                    let Ok(event) = events.try_recv() else { break 'connection; };
                    if !active.load(Ordering::Acquire) || send(socket, event, EVENT_WRITE_TIMEOUT).await.is_err() { break 'connection; }
                }
                if !active.load(Ordering::Acquire) || send(socket, result, EVENT_WRITE_TIMEOUT).await.is_err() { break; }
            }
            message = socket.recv() => {
                let Some(Ok(message)) = message else { break; };
                if started.elapsed() >= Duration::from_secs(1) { started = Instant::now(); messages = 0; }
                messages += 1;
                if messages > 200 { break; }
                let message = match message {
                    Message::Text(message) => message,
                    // The WebSocket implementation automatically writes the pong.
                    Message::Ping(_) | Message::Pong(_) => continue,
                    _ => break,
                };
                let response = match serde_json::from_str::<RequestMessage>(&message) {
                    Ok(RequestMessage::Terminal { request, epoch, command }) => {
                        if !matches!(role, Role::Control) {
                            Some(terminal_result(request, Err("This session is read-only.".into())))
                        } else if pending.is_some() {
                            Some(terminal_result(request, Err("A terminal request is already in progress.".into())))
                        } else if let Ok(command) = serde_json::from_value::<TerminalCommand>(command) {
                            let (host, active) = (server.host.clone(), active.clone());
                            pending = Some(Box::pin(async move {
                                terminal_result(request, host.remote_terminal(epoch, command, active).await)
                            }));
                            None
                        } else {
                            Some(terminal_result(request, Err("Unsupported browser terminal request.".into())))
                        }
                    }
                    Ok(RequestMessage::Input { id, data, seq }) => {
                        input(&server.host, role, active, id, data, seq, &mut next_sequence).await.err()
                            .map(|message| json!({ "type": "error", "message": message }))
                    }
                    Err(_) => Some(json!({ "type": "error", "message": "Unsupported browser request." })),
                };
                if let Some(response) = response
                    && send(socket, response, EVENT_WRITE_TIMEOUT).await.is_err() { break; }
            }
        }
    }
    None
}

async fn send(socket: &mut WebSocket, event: Value, timeout: Duration) -> Result<(), ()> {
    tokio::time::timeout(timeout, socket.send(Message::Text(event.to_string().into())))
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "kebab-case", deny_unknown_fields)]
enum RequestMessage {
    Input { id: String, data: String, seq: u64 },
    Terminal { request: u64, epoch: u64, command: Value },
}

#[derive(Deserialize, serde::Serialize)]
#[serde(
    tag = "action",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum TerminalCommand {
    Launch {
        canvas_id: Option<String>,
        options: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        claude_account: Option<String>,
    },
    Start {
        id: String,
        fresh: bool,
    },
    Stop {
        id: String,
    },
    Close {
        id: String,
    },
    Rename {
        id: String,
        mode: String,
        title: Option<String>,
    },
    Duplicate {
        id: String,
    },
    Layout {
        base: String,
        workspace: Value,
    },
    NewWorkspace,
    OpenWorkspace {
        workspace: Value,
    },
    WorkspaceAction {
        name: WorkspaceAction,
        payload: Option<Value>,
    },
}

#[derive(Deserialize, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum WorkspaceAction {
    AgentSetup,
    ClaudeAccounts,
    DeleteUnusedImages,
    KeepRunning,
    PointerCheck,
    PointerConfigure,
    TmuxSetup,
    UnusedImages,
}

fn terminal_result(request: u64, result: Result<Value, String>) -> Value {
    let result = result.unwrap_or_else(|error| json!({ "error": error }));
    json!({ "type": "remote-terminal-result", "request": request, "result": result })
}

async fn input(
    host: &Host,
    role: Role,
    active: &Arc<AtomicBool>,
    id: String,
    data: String,
    seq: u64,
    next: &mut u64,
) -> Result<(), String> {
    if !matches!(role, Role::Control) {
        return Err("This session is read-only.".into());
    }
    if id.len() > 128 || seq != *next {
        return Err("Invalid browser input sequence.".into());
    }
    *next = next.checked_add(1).ok_or("Input sequence exhausted.")?;
    host.remote_input(id, data, active.clone()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{BoxFuture, FileKind, Paths, Platform};
    use futures_util::{SinkExt, StreamExt};
    use std::path::PathBuf;
    use tc_pty::manager::{Backend, Config, EventSink, Process, SessionKey, SpawnRequest};
    use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};
    use tower::ServiceExt;

    struct NoPlatform;
    impl Platform for NoPlatform {
        fn pick_folder(&self, _: Option<PathBuf>) -> BoxFuture<Option<PathBuf>> {
            Box::pin(async { panic!("remote dialog") })
        }
        fn save_file(&self, _: &'static str, _: String) -> BoxFuture<Option<PathBuf>> {
            Box::pin(async { panic!("remote save") })
        }
        fn open_file(&self, _: &'static str, _: FileKind) -> BoxFuture<Option<PathBuf>> {
            Box::pin(async { panic!("remote open") })
        }
        fn read_clipboard(&self) -> BoxFuture<Result<String, String>> {
            Box::pin(async { panic!("remote clipboard") })
        }
        fn write_clipboard(&self, _: String) -> BoxFuture<Result<(), String>> {
            Box::pin(async { panic!("remote clipboard") })
        }
        fn open_link(&self, _: String) -> BoxFuture<Result<(), String>> {
            Box::pin(async { panic!("remote link") })
        }
        fn close_window(&self) {
            panic!("remote close");
        }
    }
    struct NoBackend;
    impl Backend for NoBackend {
        fn spawn(&mut self, _: &SpawnRequest, _: SessionKey, _: EventSink) -> std::io::Result<Box<dyn Process>> {
            panic!("remote spawn");
        }
        fn watch_directory(&mut self, _: u32, _: tc_core::Platform, _: SessionKey, _: EventSink) -> Box<dyn Send> {
            panic!("remote directory polling");
        }
    }

    fn host() -> Arc<Host> {
        let data = std::env::temp_dir().join(format!("tc-remote-{}", uuid::Uuid::new_v4()));
        Host::new(
            Paths {
                data,
                hook: None,
                agents: None,
                tmux: None,
            },
            Arc::new(NoPlatform),
            Box::new(NoBackend),
            Config::from_environment(),
        )
    }

    fn server(host: Arc<Host>, port: u16) -> Arc<Server> {
        let authority = format!("127.0.0.1:{port}");
        Arc::new(Server {
            host,
            origin: format!("http://{authority}"),
            https: false,
            authority,
            cookie: format!("tc_remote_{port}"),
            security: Mutex::new(Security::new()),
            stop: watch::channel(false).0,
            task: Mutex::new(None),
            assets: Arc::new(|path| Some((path.as_bytes().to_vec(), "text/plain".into()))),
        })
    }

    fn request(server: &Server, method: &str, path: &str, cookie: Option<&str>, body: &str) -> Request {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, &server.authority)
            .header(header::ORIGIN, &server.origin)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        request.body(Body::from(body.to_owned())).unwrap()
    }

    #[test]
    fn tokens_are_independent_and_logins_are_bounded_expiring_and_revocable() {
        let mut security = Security::new();
        let now = Instant::now();
        assert_eq!(security.control.len(), 64);
        assert_ne!(security.control, security.view);
        for _ in 0..5 {
            assert_eq!(security.login_at("wrong", now), Err(StatusCode::UNAUTHORIZED));
        }
        let token = security.control.clone();
        assert_eq!(security.login_at(&token, now), Err(StatusCode::TOO_MANY_REQUESTS));
        assert_eq!(
            security.login_at(&token, now + LOGIN_WINDOW - Duration::from_nanos(1)),
            Err(StatusCode::TOO_MANY_REQUESTS)
        );
        let created = now + LOGIN_WINDOW;
        let id = security.login_at(&token, created).unwrap();
        assert!(security.failures.is_empty());
        let active = security.sessions[&id].active.clone();
        // Advance the clock: subtracting the TTL can underflow on freshly booted Windows.
        let expired = created + SESSION_TTL;
        security.expire_at(expired - Duration::from_nanos(1));
        assert!(active.load(Ordering::Acquire));
        assert!(security.sessions.contains_key(&id));
        security.expire_at(expired);
        assert!(!active.load(Ordering::Acquire));
        assert!(!security.sessions.contains_key(&id));
        for _ in 0..MAX_CLIENTS {
            security.login_at(&token, expired).unwrap();
        }
        assert_eq!(security.login_at(&token, expired), Err(StatusCode::TOO_MANY_REQUESTS));
        let active = security.sessions.values().next().unwrap().active.clone();
        security.revoke();
        assert!(!active.load(Ordering::Acquire));
        assert!(security.sessions.is_empty());
    }

    #[test]
    fn renderer_dependencies_are_explicitly_allowlisted() {
        let html = include_str!("../../src/index.html");
        for attribute in ["src=\"", "href=\""] {
            for reference in html.split(attribute).skip(1) {
                let asset = reference.split('"').next().unwrap().trim_start_matches("./");
                let path = format!("/{asset}");
                assert_eq!(static_path(&path), Some(asset), "Renderer dependency: {asset}");
            }
        }
        for reference in include_str!("../../src/styles.css").split("url('").skip(1) {
            let asset = reference.split('\'').next().unwrap().trim_start_matches("./");
            let path = format!("/{asset}");
            assert_eq!(static_path(&path), Some(asset), "Stylesheet dependency: {asset}");
        }
    }

    #[tokio::test]
    async fn http_rejects_unauthenticated_cross_origin_and_rebinding_requests() {
        let server = server(host(), 4312);
        let app = router(server.clone());
        let response = app
            .clone()
            .oneshot(request(&server, "GET", "/", None, ""))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_SECURITY_POLICY], CSP);
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        for path in ["/renderer.js", "/images/test.png", "/ws"] {
            let response = app
                .clone()
                .oneshot(request(&server, "GET", path, None, ""))
                .await
                .unwrap();
            // WebSocketUpgrade rejects requests without upgrade headers before the handler.
            assert!(response.status().is_client_error(), "{path}");
        }
        for (name, value) in [
            (header::ORIGIN, "https://evil.test"),
            (header::ORIGIN, "null"),
            (header::HOST, "evil.test:4312"),
            (header::HOST, "127.0.0.1:4313"),
        ] {
            let mut req = request(&server, "POST", "/login", None, "{\"token\":\"wrong\"}");
            req.headers_mut().insert(name, value.parse().unwrap());
            assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
        }
        let mut req = request(&server, "POST", "/login", None, "{\"token\":\"wrong\"}");
        req.headers_mut().remove(header::ORIGIN);
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
        let mut req = request(&server, "GET", "/", None, "");
        req.headers_mut()
            .append(header::HOST, server.authority.parse().unwrap());
        assert_eq!(app.clone().oneshot(req).await.unwrap().status(), StatusCode::FORBIDDEN);
        let token = server.security.lock().unwrap().control.clone();
        let response = app
            .clone()
            .oneshot(request(
                &server,
                "POST",
                "/login",
                None,
                &json!({"token": token}).to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        assert!(cookie.contains("HttpOnly; SameSite=Strict"));
        let cookie = cookie.split(';').next().unwrap();
        assert_eq!(
            app.clone()
                .oneshot(request(&server, "GET", "/renderer.js", Some(cookie), ""))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        for path in [
            "/../Cargo.toml",
            "/Cargo.toml",
            "/assets/",
            "/images/..%2fworkspace.terminalcanvas",
            "/remote-login.html",
            "/vendor/xterm.js.map",
        ] {
            assert_eq!(
                app.clone()
                    .oneshot(request(&server, "GET", path, Some(cookie), ""))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND,
                "{path}"
            );
        }
        server.security.lock().unwrap().revoke();
        assert_eq!(
            app.oneshot(request(&server, "GET", "/renderer.js", Some(cookie), ""))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn login_limits_attempts_and_body_size_at_the_http_boundary() {
        let server = server(host(), 4312);
        let app = router(server.clone());
        for _ in 0..5 {
            assert_eq!(
                app.clone()
                    .oneshot(request(&server, "POST", "/login", None, "{\"token\":\"wrong\"}"))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        assert_eq!(
            app.clone()
                .oneshot(request(&server, "POST", "/login", None, "{\"token\":\"wrong\"}"))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            app.oneshot(request(
                &server,
                "POST",
                "/login",
                None,
                &json!({"token": "x".repeat(2048)}).to_string()
            ))
            .await
            .unwrap()
            .status(),
            StatusCode::PAYLOAD_TOO_LARGE
        );
    }

    #[tokio::test]
    async fn real_websockets_share_live_state_and_enforce_controller_and_viewer_roles() {
        let listener = tokio::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let server = server(host(), listener.local_addr().unwrap().port());
        server.host.remote_begin("test".into()).await;
        let (requests, mut desktop) = tokio::sync::mpsc::unbounded_channel();
        server.host.connect(Arc::new(move |event| {
            if event["type"] == "remote-terminal-request" {
                let _ = requests.send(event);
            }
        }));
        let app = router(server.clone());
        let mut stop = server.stop.subscribe();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = stop.changed().await;
                })
                .await
                .unwrap();
        });
        let make_request = |token: String| {
            let id = server.security.lock().unwrap().login(&token).unwrap();
            let mut request = format!("ws://{}/ws", server.authority).into_client_request().unwrap();
            request
                .headers_mut()
                .insert(header::ORIGIN, server.origin.parse().unwrap());
            request
                .headers_mut()
                .insert(header::COOKIE, format!("{}={id}", server.cookie).parse().unwrap());
            request
        };
        let control = server.security.lock().unwrap().control.clone();
        let view = server.security.lock().unwrap().view.clone();
        let mut unauthenticated = format!("ws://{}/ws", server.authority).into_client_request().unwrap();
        unauthenticated
            .headers_mut()
            .insert(header::ORIGIN, server.origin.parse().unwrap());
        assert!(matches!(tokio_tungstenite::connect_async(unauthenticated).await,
            Err(tungstenite::Error::Http(response)) if response.status() == StatusCode::UNAUTHORIZED));
        for (name, value) in [(header::ORIGIN, "https://evil.test"), (header::HOST, "evil.test")] {
            let mut invalid = make_request(view.clone());
            invalid.headers_mut().insert(name, value.parse().unwrap());
            assert!(matches!(tokio_tungstenite::connect_async(invalid).await,
                Err(tungstenite::Error::Http(response)) if response.status() == StatusCode::FORBIDDEN));
        }
        let (mut controller, _) = tokio_tungstenite::connect_async(make_request(control.clone()))
            .await
            .unwrap();
        let event = socket_event(&mut controller, "remote-initialize").await;
        assert_eq!(event["role"], "control");
        let epoch = event["titleEpoch"].as_u64().unwrap();
        let result = tokio_tungstenite::connect_async(make_request(control)).await;
        assert!(matches!(result, Err(tungstenite::Error::Http(response)) if response.status() == StatusCode::CONFLICT));
        let (mut viewer, _) = tokio_tungstenite::connect_async(make_request(view)).await.unwrap();
        assert_eq!(socket_event(&mut viewer, "remote-initialize").await["role"], "view");
        let ping = b"still connected".to_vec();
        viewer
            .send(tungstenite::Message::Ping(ping.clone().into()))
            .await
            .unwrap();
        let pong = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match viewer.next().await.unwrap().unwrap() {
                    tungstenite::Message::Pong(pong) => break pong,
                    tungstenite::Message::Text(_) => continue,
                    other => panic!("expected pong, received {other:?}"),
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(pong.as_ref(), ping.as_slice());
        viewer
            .send(tungstenite::Message::Text(
                json!({"action":"input","id":"x","data":"danger","seq":0})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let error = socket_event(&mut viewer, "error").await;
        assert_eq!(error["message"], "This session is read-only.");

        let launch = json!({"action":"launch", "canvasId":null, "options":{"title":"From browser"}});
        let command = |request: u64, epoch: u64, command: Value| {
            tungstenite::Message::Text(
                json!({"action":"terminal", "request":request, "epoch":epoch, "command":command})
                    .to_string()
                    .into(),
            )
        };
        viewer.send(command(1, epoch, launch.clone())).await.unwrap();
        assert_eq!(
            socket_event(&mut viewer, "remote-terminal-result").await["result"]["error"],
            "This session is read-only."
        );
        controller
            .send(command(2, epoch, json!({"action":"remote-stop"})))
            .await
            .unwrap();
        assert_eq!(
            socket_event(&mut controller, "remote-terminal-result").await["result"]["error"],
            "Unsupported browser terminal request."
        );
        controller.send(command(3, epoch + 1, launch.clone())).await.unwrap();
        assert!(
            socket_event(&mut controller, "remote-terminal-result").await["result"]["error"]
                .as_str()
                .unwrap()
                .contains("workspace changed")
        );
        assert!(desktop.try_recv().is_err());

        controller.send(command(4, epoch, launch.clone())).await.unwrap();
        let event = tokio::time::timeout(Duration::from_secs(3), desktop.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event["command"], launch);
        let id = &event["requestId"];
        server
            .host
            .command("remote-terminal-reply", Some(&json!({"id":id})))
            .await
            .unwrap();
        assert!(
            server
                .host
                .command("remote-terminal-reply", Some(&json!({"id":id})))
                .await
                .is_err()
        );
        server
            .host
            .command(
                "remote-terminal-reply",
                Some(&json!({"id":id, "result":{"id":"new-terminal"}})),
            )
            .await
            .unwrap();
        let reply = socket_event(&mut controller, "remote-terminal-result").await;
        assert_eq!(reply["request"], 4);
        assert_eq!(reply["result"]["id"], "new-terminal");

        controller.send(command(5, epoch, launch)).await.unwrap();
        let event = tokio::time::timeout(Duration::from_secs(3), desktop.recv())
            .await
            .unwrap()
            .unwrap();
        server.security.lock().unwrap().revoke();
        assert!(
            server
                .host
                .command("remote-terminal-reply", Some(&json!({"id":event["requestId"]})))
                .await
                .is_err()
        );
        // Revocation closes existing sockets, even when they send no new requests.
        tokio::time::timeout(Duration::from_secs(3), async {
            while let Some(Ok(message)) = controller.next().await {
                if message.is_close() {
                    break;
                }
            }
        })
        .await
        .unwrap();
        server.stop.send_replace(true);
        drop(viewer);
        drop(controller);
        tokio::time::timeout(Duration::from_secs(4), task)
            .await
            .unwrap()
            .unwrap();
    }

    async fn socket_event(
        socket: &mut tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        kind: &str,
    ) -> Value {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let message = socket.next().await.unwrap().unwrap().into_text().unwrap();
                let event: Value = serde_json::from_str(&message).unwrap();
                if event["type"] == kind {
                    return event;
                }
            }
        })
        .await
        .unwrap()
    }
}
