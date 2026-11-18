//! Opt-in loopback HTTP/WebSocket transport. No Tauri IPC or OS commands are exposed to browsers.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
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

use crate::host::Host;

const SESSION_TTL: Duration = Duration::from_secs(12 * 60 * 60);
const LOGIN_WINDOW: Duration = Duration::from_secs(60);
const MAX_CLIENTS: usize = 8;
// One 64 Ki UTF-16 input piece can use six JSON bytes per code unit when escaped.
const MAX_MESSAGE: usize = 512 * 1024;
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
        let mut status = json!({ "running": !*self.stop.borrow(), "url": self.origin,
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

    fn valid_headers(&self, headers: &HeaderMap, require_origin: bool) -> bool {
        let single = |name| {
            let mut values = headers.get_all(name).iter();
            let value = values.next()?.to_str().ok()?;
            values.next().is_none().then_some(value)
        };
        single(header::HOST) == Some(self.authority.as_str())
            && match single(header::ORIGIN) {
                Some(origin) => origin == self.origin,
                None => !require_origin && !headers.contains_key(header::ORIGIN),
            }
            && headers.get("sec-fetch-site").is_none_or(|v| v != "cross-site")
    }
}

/// Lifetime belongs to the app, with all lifecycle changes serialized. Constructing it never listens.
pub struct Remote {
    host: Arc<Host>,
    assets: Assets,
    server: tokio::sync::Mutex<Option<Arc<Server>>>,
}

impl Remote {
    pub fn new(host: Arc<Host>, assets: Assets) -> Self {
        Self {
            host,
            assets,
            server: tokio::sync::Mutex::new(None),
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
                let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port as u16))
                    .await
                    .map_err(|e| format!("Could not start the browser server: {e}"))?;
                let port = listener.local_addr().map_err(|e| e.to_string())?.port();
                let authority = format!("127.0.0.1:{port}");
                let (stop, _) = watch::channel(false);
                let server = Arc::new(Server {
                    host: self.host.clone(),
                    origin: format!("http://{authority}"),
                    authority,
                    cookie: format!("tc_remote_{port}"),
                    assets: self.assets.clone(),
                    security: Mutex::new(Security::new()),
                    stop,
                    task: Mutex::new(None),
                });
                self.host.remote_attach().await;
                let router = router(server.clone());
                let mut stopping = server.stop.subscribe();
                let serving = server.clone();
                let task = tauri::async_runtime::spawn(async move {
                    let result = axum::serve(listener, router)
                        .with_graceful_shutdown(async move {
                            let _ = stopping.changed().await;
                        })
                        .await;
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
        .route("/login", post(login))
        .route("/ws", get(upgrade))
        .fallback(get(files))
        .layer(DefaultBodyLimit::max(1024))
        .layer(middleware::from_fn_with_state(server.clone(), boundary))
        .with_state(server)
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
                "{}={id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200",
                server.cookie
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
        | "/chrome.css"
        | "/bridge.js"
        | "/remote-bridge.js"
        | "/remote-ui.js"
        | "/remote.css"
        | "/remote-login.js"
        | "/minimap.js"
        | "/canvas-geometry.js"
        | "/terminal-pointer.js"
        | "/item-styles.js"
        | "/items.js"
        | "/history.js"
        | "/clipboard.js"
        | "/renderer.js"
        | "/vendor/xterm.js"
        | "/vendor/xterm.css"
        | "/vendor/addon-fit.js"
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
    ws.max_message_size(MAX_MESSAGE)
        .max_frame_size(MAX_MESSAGE)
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
    let (mut snapshot, mut events) = server.host.remote_attach().await;
    snapshot["type"] = json!("remote-initialize");
    snapshot["role"] = json!(if matches!(role, Role::Control) {
        "control"
    } else {
        "view"
    });
    let mut stop = server.stop.subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
    let mut messages = 0;
    let mut started = Instant::now();
    let mut next_sequence = 0u64;
    if active.load(Ordering::Acquire) && !*stop.borrow() && send(&mut socket, snapshot).await.is_ok() {
        loop {
            if !active.load(Ordering::Acquire) || *stop.borrow() {
                break;
            }
            tokio::select! {
                _ = stop.changed() => break,
                _ = heartbeat.tick() => {
                    server.security.lock().unwrap_or_else(|e| e.into_inner()).expire();
                }
                event = events.recv() => {
                    // Lagging clients reconnect for a fresh snapshot; never pause the desktop PTY.
                    let Ok(event) = event else { break; };
                    if !active.load(Ordering::Acquire) || send(&mut socket, event).await.is_err() { break; }
                }
                message = socket.recv() => {
                    let Some(Ok(Message::Text(message))) = message else { break; };
                    if started.elapsed() >= Duration::from_secs(1) { started = Instant::now(); messages = 0; }
                    messages += 1;
                    if messages > 200 { break; }
                    let result = input(&server.host, role, &active, &message, &mut next_sequence).await;
                    if let Err(error) = result
                        && send(&mut socket, json!({ "type": "error", "message": error })).await.is_err() { break; }
                }
            }
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), socket.send(Message::Close(None))).await;
    disconnect(&server, &id);
}

async fn send(socket: &mut WebSocket, event: Value) -> Result<(), ()> {
    tokio::time::timeout(
        Duration::from_secs(2),
        socket.send(Message::Text(event.to_string().into())),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    action: String,
    id: String,
    data: String,
    seq: u64,
}

async fn input(host: &Host, role: Role, active: &Arc<AtomicBool>, text: &str, next: &mut u64) -> Result<(), String> {
    if !matches!(role, Role::Control) {
        return Err("This session is read-only.".into());
    }
    let message: Input = serde_json::from_str(text).map_err(|_| "Unsupported browser request.")?;
    if message.action != "input" || message.id.len() > 128 || message.seq != *next {
        return Err("Invalid browser input sequence.".into());
    }
    *next = next.checked_add(1).ok_or("Input sequence exhausted.")?;
    host.remote_input(message.id, message.data, active.clone()).await?;
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
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let server = server(host(), listener.local_addr().unwrap().port());
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
        let event = controller.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&event).unwrap()["role"], "control");
        let result = tokio_tungstenite::connect_async(make_request(control)).await;
        assert!(matches!(result, Err(tungstenite::Error::Http(response)) if response.status() == StatusCode::CONFLICT));
        let (mut viewer, _) = tokio_tungstenite::connect_async(make_request(view)).await.unwrap();
        // Discard initial snapshot and any initial layout/terminal updates before the error.
        viewer
            .send(tungstenite::Message::Text(
                json!({"action":"input","id":"x","data":"danger","seq":0})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let error = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let message = viewer.next().await.unwrap().unwrap().into_text().unwrap();
                let event: Value = serde_json::from_str(&message).unwrap();
                if event["type"] == "error" {
                    break event;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(error["message"], "This session is read-only.");
        server.security.lock().unwrap().revoke();
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
}
