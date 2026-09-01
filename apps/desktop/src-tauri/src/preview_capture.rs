//! Preview "agent eyes" — the Phase 3 slice of `docs/live-browser-preview.md`: an agent-readable
//! screenshot of a running preview, and a bounded DOM query over it. Click-to-instruct is
//! deliberately NOT here (see bead sparkle-51pwp — it needs its own design pass and touches the
//! surface the human watches, which this module never does. That surface is the concierge preview
//! CARD, `components/Concierge/PreviewCards.tsx` over `services/previewCards.ts`; the
//! `PreviewSlot.tsx` this line used to name no longer exists anywhere in the repo).
//! # guard-ok — tombstone: names the deleted file on purpose, which is what a tombstone is for.
//!
//! WHY A FRESH HEADLESS BROWSER PER CALL, NOT A LONG-LIVED ONE: no lifecycle to leak, no
//! orphan-sweep to write a second copy of (`preview.rs`'s supervisor already owns that problem for
//! the dev server itself), and a stale page can never survive between calls. The cost is roughly a
//! second of browser startup per call; that trade is deliberate, so nobody "optimizes" it into a
//! shared instance without re-solving the orphan-cleanup problem preview.rs already solved once.
//!
//! WHY NOT `window_screenshot.rs`'s mechanism (`screencapture -R`): it photographs a SCREEN
//! REGION, so it only works while the pane is on screen and unoccluded. This has to work when the
//! preview is closed, minimized, or behind another window — off-screen capture is exactly what a
//! headless engine is for (see the design doc's Phase 3 section).
//!
//! WHY THE PLAYWRIGHT-DOWNLOADED BINARY, NOT SYSTEM CHROME: `apps/desktop/scripts/visual/cdp.mjs`
//! (the visual test harness) drives system Chrome because it is dev-only. This ships inside the
//! app and cannot depend on the user having Chrome at a guessed path — Playwright's
//! `chromium_headless_shell` is already fetched to disk (`~/Library/Caches/ms-playwright`) for the
//! visual harness, so using it is "not a new browser dependency", per the design doc's own framing.
//!
//! ARTIFACT HYGIENE mirrors `window_screenshot.rs` exactly: a screenshot lands in that module's
//! `capture_dir()`, as a PATH, never inline pixels — see that module's header for why a tool reply
//! must never carry image bytes.
//!
//! macOS-only, like the rest of this crate's capture code (`screencapture`, NSPanel, etc.).

use std::io::ErrorKind;
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket};

use crate::preview::{PreviewState, PreviewStatus};
use crate::window_screenshot::{capture_dir, capture_path, within_byte_cap, CAPTURE_MAX_BYTES};

/// The viewport every capture/query runs at. Fixed rather than caller-supplied — same reasoning as
/// `capture_main_window`'s lack of a size argument: a model-authored size is not a knob this
/// surface needs, and a fixed size keeps screenshots comparable call to call.
const PREVIEW_CAPTURE_VIEWPORT_WIDTH: u32 = 1280;
const PREVIEW_CAPTURE_VIEWPORT_HEIGHT: u32 = 800;

/// Bounds on the DOM query result. Both exist for the same reason the screenshot path returns a
/// file instead of pixels: an unbounded reply is a cost and a context-window spend the caller did
/// not ask for and the model cannot see coming.
const DOM_QUERY_MAX_MATCHES: usize = 20;
const DOM_QUERY_TEXT_MAX_CHARS: usize = 300;

const LAUNCH_TIMEOUT: Duration = Duration::from_secs(10);
const NAV_TIMEOUT: Duration = Duration::from_secs(10);
const CDP_CALL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long to wait for `Page.frameNavigated` after a `net::ERR_ABORTED` result, before deciding
/// nothing is going to commit. Short, not the full `NAV_TIMEOUT`: a racing redirect that IS going
/// to commit does so on response headers, not on `load` — see `open_page`. 2s rather than 1s:
/// this covers the response headers for a REDIRECT TARGET, which can be a slower origin or a
/// cold-start route, not just the loopback dev server itself — a bound too tight here reads as a
/// false refusal on a perfectly good preview URL. Still ~5x faster than the `NAV_TIMEOUT` a true
/// abort used to cost. (roborev 64133, 64142)
const ABORT_RECOMMIT_WAIT: Duration = Duration::from_secs(2);

// ---------------------------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------------------------

/// What a screenshot produced. Deliberately measurements + a path, never pixels — see the header.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCapture {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// A viewport-relative rect in CSS pixels, exactly as `getBoundingClientRect` reports it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DomRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// One matched element. `id`/`className` are `Option`, which serializes as an explicit `null` for
/// `None` (serde's derive default — no `skip_serializing_if` here), matching the frontend's
/// `field?: T | null` contract for a Rust `Option` crossing the wire.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DomMatch {
    pub tag: String,
    pub id: Option<String>,
    pub class_name: Option<String>,
    pub text: String,
    pub rect: DomRect,
}

// ---------------------------------------------------------------------------------------------
// Locating Playwright's headless Chromium
// ---------------------------------------------------------------------------------------------

/// Where Playwright caches downloaded browsers. `PLAYWRIGHT_BROWSERS_PATH` overrides it (Playwright
/// itself honours this env var, so a dev machine or CI runner that set it gets a consistent answer
/// rather than this module guessing a second location).
fn playwright_browsers_dir() -> Result<PathBuf, String> {
    if let Ok(custom) = std::env::var("PLAYWRIGHT_BROWSERS_PATH") {
        if !custom.trim().is_empty() {
            return Ok(PathBuf::from(custom));
        }
    }
    let home = std::env::var("HOME")
        .map_err(|_| "preview eyes: $HOME is not set, can't locate Playwright's browsers".to_string())?;
    Ok(PathBuf::from(home).join("Library/Caches/ms-playwright"))
}

/// Find `chromium_headless_shell-<rev>/chrome-headless-shell-mac-*/chrome-headless-shell` under the
/// Playwright cache, preferring the NEWEST revision on disk. `npx playwright install` can leave more
/// than one revision behind across an upgrade, and picking the highest revision number is the same
/// rule Playwright's own resolver uses — picking the first readdir hit would be arbitrary.
fn find_headless_shell(cache_dir: &Path) -> Result<PathBuf, String> {
    let not_installed = || {
        format!(
            "preview eyes: no chrome-headless-shell binary under {} — Playwright's headless \
             Chromium isn't installed. Run `npx playwright install chromium` from the repo root.",
            cache_dir.display()
        )
    };
    let entries = std::fs::read_dir(cache_dir).map_err(|_| not_installed())?;
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(rev) = name.strip_prefix("chromium_headless_shell-") else {
            continue;
        };
        let Ok(rev_num) = rev.parse::<u64>() else {
            continue;
        };
        let Ok(children) = std::fs::read_dir(entry.path()) else {
            continue;
        };
        for child in children.flatten() {
            let candidate = child.path().join("chrome-headless-shell");
            if candidate.is_file() && best.as_ref().map(|(r, _)| rev_num > *r).unwrap_or(true) {
                best = Some((rev_num, candidate));
            }
        }
    }
    best.map(|(_, p)| p).ok_or_else(not_installed)
}

// ---------------------------------------------------------------------------------------------
// Launching the headless browser
// ---------------------------------------------------------------------------------------------

/// Ask the OS for a free loopback port. Racy in principle (the port could be taken between close
/// and the browser's own bind) — acceptable here exactly as it is in the visual harness's identical
/// trick (`cdp.mjs`'s `getFreePort`), since a losing race just fails one call, which the caller
/// already has to handle as a launch failure.
fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("preview eyes: couldn't reserve a port: {e}"))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| format!("preview eyes: couldn't read the reserved port: {e}"))
}

/// Flags chosen for a throwaway, non-interactive capture: no GPU, no first-run UI, no network
/// side-chatter. `chrome-headless-shell` is headless BY CONSTRUCTION (unlike full Chrome, it takes
/// no `--headless` flag — there is no other mode to opt out of).
///
/// DELIBERATELY NO `--no-sandbox`. This process runs as an ordinary logged-in macOS user, not
/// root-in-a-container, so the renderer sandbox works and is worth keeping: the page loaded is
/// arbitrary web content (the agent's dev server, its npm dependencies, anything those pull in
/// over the network), and dropping the sandbox for an `allow`-tier, no-approval-required op would
/// mean a renderer compromise runs unsandboxed as the user at the agent's discretion. (roborev
/// 64071)
fn launch_flags(debug_port: u16, user_data_dir: &Path, width: u32, height: u32) -> Vec<String> {
    vec![
        format!("--remote-debugging-port={debug_port}"),
        format!("--user-data-dir={}", user_data_dir.display()),
        format!("--window-size={width},{height}"),
        "--disable-gpu".to_string(),
        "--hide-scrollbars".to_string(),
        "--force-device-scale-factor=1".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-extensions".to_string(),
        "--disable-background-networking".to_string(),
        "--disable-sync".to_string(),
        "--mute-audio".to_string(),
    ]
}

/// A launched headless browser plus its lifetime. `Drop` is the teardown guarantee — every early
/// `?` return before this is deliberately dropped still kills the process group and removes the
/// scratch profile, matching `preview.rs`'s "nothing is killed on a pid alone" rule via
/// `proc::kill_process_group` (whole-process-group SIGKILL, keyed off `process_group(0)` at spawn).
struct HeadlessBrowser {
    child: Child,
    user_data_dir: PathBuf,
}

impl Drop for HeadlessBrowser {
    fn drop(&mut self) {
        crate::proc::kill_process_group(&mut self.child);
        let _ = std::fs::remove_dir_all(&self.user_data_dir);
    }
}

fn launch_browser() -> Result<(HeadlessBrowser, u16), String> {
    let cache_dir = playwright_browsers_dir()?;
    let binary = find_headless_shell(&cache_dir)?;
    let port = free_port()?;
    let user_data_dir =
        std::env::temp_dir().join(format!("sparkle-preview-eyes-{}-{port}", std::process::id()));
    std::fs::create_dir_all(&user_data_dir)
        .map_err(|e| format!("preview eyes: couldn't create a scratch profile dir: {e}"))?;

    let mut cmd = Command::new(&binary);
    cmd.args(launch_flags(
        port,
        &user_data_dir,
        PREVIEW_CAPTURE_VIEWPORT_WIDTH,
        PREVIEW_CAPTURE_VIEWPORT_HEIGHT,
    ));
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    // MANDATORY, mirroring preview.rs: `proc::kill_process_group` SIGKILLs the whole group, so a
    // child spawned into the app's OWN group would take Sparkle's teardown logic down with it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("preview eyes: failed to start {}: {e}", binary.display()))?;
    Ok((HeadlessBrowser { child, user_data_dir }, port))
}

/// Poll Chrome's HTTP endpoint until it hands back a browser-level CDP websocket URL.
fn wait_for_debugger(port: u16, timeout: Duration) -> Result<String, String> {
    let deadline = Instant::now() + timeout;
    let mut last_err = String::new();
    while Instant::now() < deadline {
        match ureq::get(&format!("http://127.0.0.1:{port}/json/version")).call() {
            Ok(resp) => {
                if let Ok(body) = resp.into_string() {
                    if let Ok(v) = serde_json::from_str::<Value>(&body) {
                        if let Some(ws) = v.get("webSocketDebuggerUrl").and_then(Value::as_str) {
                            return Ok(ws.to_string());
                        }
                    }
                }
            }
            Err(e) => last_err = e.to_string(),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!(
        "preview eyes: headless Chromium's debugger never came up on port {port}\
         {}",
        if last_err.is_empty() { String::new() } else { format!(" (last error: {last_err})") }
    ))
}

// ---------------------------------------------------------------------------------------------
// A minimal, blocking CDP client — the Rust twin of the visual harness's `cdp.mjs`
// ---------------------------------------------------------------------------------------------

fn connect_cdp(ws_url: &str) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
    let req = ws_url
        .into_client_request()
        .map_err(|e| format!("preview eyes: bad CDP url: {e}"))?;
    let host = req
        .uri()
        .host()
        .ok_or_else(|| "preview eyes: CDP url has no host".to_string())?
        .to_string();
    let port = req
        .uri()
        .port_u16()
        .ok_or_else(|| "preview eyes: CDP url has no port".to_string())?;
    let addr = (host.as_str(), port)
        .to_socket_addrs()
        .map_err(|e| format!("preview eyes: dns: {e}"))?
        .next()
        .ok_or_else(|| "preview eyes: no address for the CDP url".to_string())?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(5))
        .map_err(|e| format!("preview eyes: couldn't connect to headless Chromium's debugger: {e}"))?;
    // The WS upgrade handshake below reads over THIS SAME blocking stream, so it needs a timeout
    // generous enough for the handshake itself — 5s, matching the connect timeout above — not the
    // short poll tick `read_until` needs afterward. Installing the short timeout first (as this
    // used to) made any handshake response slower than 250ms — a cold browser, a loaded machine, a
    // busy CI runner — surface as `HandshakeError::Interrupted`, which this function maps to a
    // hard, misleading "CDP handshake failed", non-deterministically. (roborev 64071)
    tcp.set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("preview eyes: couldn't set the CDP handshake read timeout: {e}"))?;
    tcp.set_write_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| format!("preview eyes: couldn't set the CDP handshake write timeout: {e}"))?;
    let (socket, _resp) = tungstenite::client(req, MaybeTlsStream::Plain(tcp))
        .map_err(|e| format!("preview eyes: CDP handshake failed: {e}"))?;
    // NOW shorten it, on the ESTABLISHED connection: `read_until` polls in a loop and needs to
    // re-check its own deadline frequently, rather than block for one long socket-level timeout
    // regardless of what the caller asked for.
    if let MaybeTlsStream::Plain(tcp) = socket.get_ref() {
        tcp.set_read_timeout(Some(Duration::from_millis(250)))
            .map_err(|e| format!("preview eyes: couldn't lower the post-handshake read timeout: {e}"))?;
    }
    Ok(socket)
}

/// One websocket, one request in flight at a time — this module never pipelines, so there is no
/// need for `cdp.mjs`'s id-multiplexed pending map.
struct CdpSession {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl CdpSession {
    fn connect(ws_url: &str) -> Result<Self, String> {
        Ok(Self { socket: connect_cdp(ws_url)?, next_id: 1 })
    }

    fn send(&mut self, method: &str, params: Value, session_id: Option<&str>) -> Result<u64, String> {
        let id = self.next_id;
        self.next_id += 1;
        let mut payload = json!({ "id": id, "method": method, "params": params });
        if let Some(sid) = session_id {
            payload["sessionId"] = json!(sid);
        }
        self.socket
            .send(Message::Text(payload.to_string().into()))
            .map_err(|e| format!("preview eyes: CDP send failed: {e}"))?;
        Ok(id)
    }

    /// Read raw CDP messages until `want` accepts one, or `deadline` passes. A read timeout
    /// (WouldBlock/TimedOut — see the 250ms socket timeout above) is NOT an error here; it is the
    /// polling tick that lets this loop re-check its own deadline. Any other socket error is fatal
    /// and propagates immediately — a closed connection cannot recover by retrying.
    fn read_until(
        &mut self,
        deadline: Instant,
        mut want: impl FnMut(&Value) -> bool,
    ) -> Result<Value, String> {
        loop {
            if Instant::now() > deadline {
                return Err("preview eyes: timed out waiting for the headless browser".to_string());
            }
            match self.socket.read() {
                Ok(Message::Text(text)) => {
                    if let Ok(v) = serde_json::from_str::<Value>(text.as_str()) {
                        if want(&v) {
                            return Ok(v);
                        }
                    }
                }
                Ok(_) => {}
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    continue;
                }
                Err(e) => return Err(format!("preview eyes: CDP connection error: {e}")),
            }
        }
    }

    fn call(
        &mut self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.send(method, params, session_id)?;
        let deadline = Instant::now() + timeout;
        let msg = self.read_until(deadline, |v| v.get("id").and_then(Value::as_u64) == Some(id))?;
        if let Some(err) = msg.get("error") {
            return Err(format!("preview eyes: {method} failed: {err}"));
        }
        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Wait for an EVENT (no `id`) scoped to one attached session. Never fatal on timeout to the
    /// caller by itself — see `open_page`'s use of this for why a load event that never fires must
    /// not fail the whole operation.
    fn wait_for_event(&mut self, method: &str, session_id: &str, timeout: Duration) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        self.read_until(deadline, |v| {
            v.get("method").and_then(Value::as_str) == Some(method)
                && v.get("sessionId").and_then(Value::as_str) == Some(session_id)
        })
    }
}

/// Evaluate a JS expression in-page and return its value. Distinguishes a CDP-protocol error (the
/// `call` above) from an IN-PAGE exception (`result.exceptionDetails` on an otherwise-successful
/// response) — a bad selector throws the latter, and both must surface as readable errors rather
/// than a null value the caller misreads as "no matches".
fn evaluate(session: &mut CdpSession, session_id: &str, expression: &str) -> Result<Value, String> {
    let result = session.call(
        "Runtime.evaluate",
        json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
        Some(session_id),
        CDP_CALL_TIMEOUT,
    )?;
    if let Some(exc) = result.get("exceptionDetails") {
        let desc = exc
            .pointer("/exception/description")
            .and_then(Value::as_str)
            .or_else(|| exc.get("text").and_then(Value::as_str))
            .unwrap_or("evaluation failed");
        return Err(format!("preview eyes: {desc}"));
    }
    Ok(result.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null))
}

/// The final verdict for one navigation attempt, given what `Page.navigate` reported (`err_text`)
/// and where the frame ended up (`href`). Pure and browser-free ON PURPOSE: this is the exact
/// decision three prior rounds got wrong in the two different ways roborev 64071/64105/64123 each
/// found, and it used to be inlined in `open_page` where only the FAILING half of the
/// `ERR_ABORTED` case could ever be exercised without a live browser plus a fixture that reliably
/// reproduces a commit-then-abort race. Both halves are unit-tested below. (roborev 64133)
///
/// `Page.navigate` ACKs successfully even when the navigation itself fails — a dev server that
/// died between `preview_status` and this call answers with `net::ERR_CONNECTION_REFUSED` here,
/// not as a CDP protocol error — so a caller must not be handed a screenshot of Chrome's own error
/// page (or an empty DOM query) with no signal that happened. `net::ERR_ABORTED` is the one
/// exception: Chromium reports it for TWO different outcomes through the same field — a
/// client-side redirect racing this navigation (commits a new document, benign) and a
/// `Content-Disposition: attachment` response (commits NOTHING, stays on `about:blank`) — so it is
/// the one case whose verdict depends on `href` rather than on `err_text` alone.
fn nav_verdict(url: &str, err_text: Option<&str>, href: Option<&str>) -> Result<(), String> {
    match err_text {
        None => Ok(()),
        Some("net::ERR_ABORTED") => {
            let committed = href.is_some_and(|h| h != "about:blank");
            if committed {
                Ok(())
            } else {
                Err(format!(
                    "preview eyes: navigating to {url} failed: net::ERR_ABORTED (no document committed)"
                ))
            }
        }
        Some(other) => Err(format!("preview eyes: navigating to {url} failed: {other}")),
    }
}

/// Open a fresh page target, point it at `url`, and wait (best-effort) for it to finish loading.
/// Returns the CDP session id the caller uses for every subsequent per-page command.
fn open_page(session: &mut CdpSession, url: &str) -> Result<String, String> {
    let created = session.call(
        "Target.createTarget",
        json!({ "url": "about:blank" }),
        None,
        CDP_CALL_TIMEOUT,
    )?;
    let target_id = created
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or_else(|| "preview eyes: Target.createTarget returned no targetId".to_string())?
        .to_string();

    let attached = session.call(
        "Target.attachToTarget",
        json!({ "targetId": target_id, "flatten": true }),
        None,
        CDP_CALL_TIMEOUT,
    )?;
    let session_id = attached
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "preview eyes: Target.attachToTarget returned no sessionId".to_string())?
        .to_string();

    session.call("Page.enable", json!({}), Some(&session_id), CDP_CALL_TIMEOUT)?;
    session.call("Runtime.enable", json!({}), Some(&session_id), CDP_CALL_TIMEOUT)?;
    session.call(
        "Emulation.setDeviceMetricsOverride",
        json!({
            "width": PREVIEW_CAPTURE_VIEWPORT_WIDTH,
            "height": PREVIEW_CAPTURE_VIEWPORT_HEIGHT,
            "deviceScaleFactor": 1,
            "mobile": false,
        }),
        Some(&session_id),
        CDP_CALL_TIMEOUT,
    )?;

    let nav_deadline = Instant::now() + NAV_TIMEOUT;
    let nav_result =
        session.call("Page.navigate", json!({ "url": url }), Some(&session_id), NAV_TIMEOUT)?;
    let err_text = nav_result.get("errorText").and_then(Value::as_str).map(str::to_string);

    match err_text.as_deref() {
        None => {
            // Best-effort: a dev server that never fires `load` (an infinite XHR poll, a WS-only
            // app) must not fail the whole op — proceed with whatever painted. Mirrors `cdp.mjs`'s
            // `navigate()`, which resolves on the same timeout rather than rejecting.
            let remaining = nav_deadline.saturating_duration_since(Instant::now());
            let _ = session.wait_for_event("Page.loadEventFired", &session_id, remaining);
        }
        Some("net::ERR_ABORTED") => {
            // A racing client-side redirect commits FAST — on response headers, well before
            // `load` fires — so COMMIT is detected with only a SHORT window, not the full nav
            // budget. A true abort (a download, a 204) can never fire ANY frame event, and
            // waiting the full `NAV_TIMEOUT` for it would hang every failing preview URL for ~10s
            // before refusing — the regression roborev 64133 fixed. (roborev 64133, 64142)
            if session.wait_for_event("Page.frameNavigated", &session_id, ABORT_RECOMMIT_WAIT).is_ok() {
                // A document committed — give it the SAME best-effort load wait every successful
                // navigation gets below. Without this, a redirect-racing capture ran immediately
                // after commit, on a document that had parsed nothing: an empty screenshot or a
                // zero-match DOM query, reported `Ok` with no signal — exactly the "blank capture"
                // failure this whole `errorText` guard exists to prevent (roborev 64142, the
                // regression the 1s latency fix introduced on the path it was trying to preserve).
                let remaining = nav_deadline.saturating_duration_since(Instant::now());
                let _ = session.wait_for_event("Page.loadEventFired", &session_id, remaining);
            }
            // Else: nothing committed within the short window — `href` below will still read
            // `about:blank` (or fail to read at all) and `nav_verdict` reports the refusal. No
            // further waiting: a true abort can never fire `frameNavigated`, so there is nothing
            // left to wait FOR.
        }
        Some(_) => {} // a real failure — nav_verdict below reports it immediately, no wait needed
    }

    // Only read `location.href` for the ERR_ABORTED case: it is the one case whose verdict depends
    // on it, and skipping the extra CDP round-trip otherwise keeps the common (successful) path at
    // its previous cost.
    let href = if err_text.as_deref() == Some("net::ERR_ABORTED") {
        evaluate(session, &session_id, "location.href").ok().and_then(|v| v.as_str().map(str::to_string))
    } else {
        None
    };
    nav_verdict(url, err_text.as_deref(), href.as_deref())?;
    Ok(session_id)
}

fn take_screenshot(session: &mut CdpSession, session_id: &str) -> Result<Vec<u8>, String> {
    let result = session.call(
        "Page.captureScreenshot",
        json!({ "format": "png", "fromSurface": true, "captureBeyondViewport": false }),
        Some(session_id),
        Duration::from_secs(10),
    )?;
    let b64 = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "preview eyes: Page.captureScreenshot returned no data".to_string())?;
    STANDARD
        .decode(b64)
        .map_err(|e| format!("preview eyes: couldn't decode the screenshot: {e}"))
}

/// The in-page JS `Runtime.evaluate` runs for a DOM query. Pure and independently testable — see
/// the tests below for the selector-escaping case this shape exists to get right.
fn dom_query_expression(selector: &str) -> String {
    // JSON-encoding the selector is what makes this safe against a selector containing a `"`, a
    // backslash, or (via ` `/` ` escaping, which serde_json performs) a line terminator —
    // any of which would otherwise break out of the string literal this gets spliced into.
    let selector_json = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(() => {{
            const nodes = Array.from(document.querySelectorAll({selector_json})).slice(0, {DOM_QUERY_MAX_MATCHES});
            return nodes.map((el) => {{
                const r = el.getBoundingClientRect();
                const raw = el.innerText != null ? el.innerText : (el.textContent || '');
                return {{
                    tag: el.tagName.toLowerCase(),
                    id: el.id || null,
                    className: (typeof el.className === 'string' && el.className) || null,
                    text: raw.trim().slice(0, {DOM_QUERY_TEXT_MAX_CHARS}),
                    rect: {{ x: r.x, y: r.y, width: r.width, height: r.height }},
                }};
            }});
        }})()"
    )
}

fn stamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------------------------
// The two ops, blocking (run on a `spawn_blocking` task by the Tauri commands below)
// ---------------------------------------------------------------------------------------------

fn capture_screenshot_blocking(url: &str) -> Result<PreviewCapture, String> {
    let (_browser, debug_port) = launch_browser()?;
    let ws_url = wait_for_debugger(debug_port, LAUNCH_TIMEOUT)?;
    let mut session = CdpSession::connect(&ws_url)?;
    let session_id = open_page(&mut session, url)?;
    let png = take_screenshot(&mut session, &session_id)?;

    let bytes = png.len() as u64;
    if !within_byte_cap(bytes) {
        return Err(format!(
            "preview eyes: the screenshot came to {bytes} bytes, over the {CAPTURE_MAX_BYTES}-byte cap"
        ));
    }
    let dir = capture_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("preview eyes: couldn't create {}: {e}", dir.display()))?;
    let path = capture_path("preview", stamp());
    std::fs::write(&path, &png)
        .map_err(|e| format!("preview eyes: couldn't write {}: {e}", path.display()))?;

    Ok(PreviewCapture {
        path: path.display().to_string(),
        width: PREVIEW_CAPTURE_VIEWPORT_WIDTH,
        height: PREVIEW_CAPTURE_VIEWPORT_HEIGHT,
        bytes,
    })
}

fn query_dom_blocking(url: &str, selector: &str) -> Result<Vec<DomMatch>, String> {
    let (_browser, debug_port) = launch_browser()?;
    let ws_url = wait_for_debugger(debug_port, LAUNCH_TIMEOUT)?;
    let mut session = CdpSession::connect(&ws_url)?;
    let session_id = open_page(&mut session, url)?;
    let expr = dom_query_expression(selector);
    let value = evaluate(&mut session, &session_id, &expr)?;
    serde_json::from_value(value)
        .map_err(|e| format!("preview eyes: couldn't parse the DOM query result: {e}"))
}

// ---------------------------------------------------------------------------------------------
// Resolving an agent's preview to a URL — shared gate for both commands
// ---------------------------------------------------------------------------------------------

/// The "framable" states — `listening`/`ready`/`serving`. Anything else has nothing rendered yet
/// (or ever) to look at.
///
/// This set is ONE MEMBER OF A FAMILY OF PEER PREDICATES, and the authoritative statement of the
/// family lives on `stores/previewStore.ts`'s `SURFACING_STATES` doc comment — which names this
/// function explicitly, along with `services/previewIdleGrace.ts`'s `LIVE_STATES`, `AgentRow`'s
/// preview affordance, and `preview.rs`'s `live_for_reattach`. Read that comment before narrowing
/// any of them; in particular `serving` stays in every one of them even though nothing writes it
/// today (bead `sparkle-l7cihu`).
///
/// **The members are deliberately NOT the same set**, so this is a sibling to consult, not a
/// definition to copy: `SURFACING_STATES` is `ready`/`serving` only (a bound port shows the
/// framework's "compiling" page, which is not worth surfacing to a human), while this one admits
/// `listening` because an agent asking to look is asking about whatever is there.
///
/// (The reference this used to carry — `PreviewSlot.tsx`'s `PREVIEW_PANE_FOR_STATE` — pointed at a
/// file that no longer exists anywhere in the repo.)
/// # guard-ok — tombstone: names the deleted file on purpose, which is what a tombstone is for.
fn is_framable(state: PreviewState) -> bool {
    matches!(state, PreviewState::Listening | PreviewState::Ready | PreviewState::Serving)
}

/// The whole `Option<PreviewStatus>` → URL decision, pulled out of `resolve_preview_url` so it is
/// callable — and testable — without an `AppHandle`. This is the gate `previewInspect.ts`'s
/// `no-preview`/`preview-not-ready` refusals are keyed on (by string-matching these exact
/// messages), so a test on the async `AppHandle`-bound version alone could never cover it without
/// standing up a Tauri app. (roborev 64071)
fn resolve_url_from_status(status: Option<PreviewStatus>, agent_id: &str) -> Result<String, String> {
    let status = status
        .ok_or_else(|| format!("preview eyes: no preview is open for agent {agent_id} — open one first"))?;
    if !is_framable(status.state) {
        return Err(format!(
            "preview eyes: this agent's preview is {:?}, not yet serving anything to look at",
            status.state
        ));
    }
    let port = status
        .port
        .ok_or_else(|| "preview eyes: this preview has no port yet — it may still be starting".to_string())?;

    // THE TWO GATES ABOVE RUN FIRST, AND THAT ORDER IS LOAD-BEARING — see this function's own
    // docblock: `previewInspect.ts` string-matches "not yet serving anything" and "no port yet" to
    // pick which refusal kind it reports. Reading `url` earlier would let a preview with a url but
    // no port resolve, and the `preview-not-ready` refusal it is supposed to raise would silently
    // stop firing.
    //
    // PREFER `status.url` OVER THE PORT ORIGIN: the url is where the ROUTE lives.
    // `preview.rs`'s `preview_url_with_route(port, &server.route)` is the single place a port
    // becomes a URL, so `{ op: "open", path: "/settings" }` is already carried here as
    // `http://127.0.0.1:<port>/settings`. Deriving the origin from the port instead threw the
    // route away and made this tool structurally incapable of looking at anything but the app
    // ROOT — bead `sparkle-dlrqb8.1`.
    //
    // RE-VALIDATED, NOT TRUSTED. Unlike `preview_url_for`'s output this is a string this function
    // RECEIVED (from a status that crossed an await, and whose shape an older or newer build on
    // the other side of the IPC boundary can also produce), so the loopback-only property of this
    // whole surface has to be re-established here rather than assumed. A non-loopback url falls
    // back to the port origin — a bad url is a bad route, not a reason to withhold a working
    // preview, which is the same call `preview_url_with_route` makes about a bad route.
    let origin = crate::preview::preview_url_for(port);
    match status.url {
        Some(url) if crate::preview::preview_url_is_loopback(&url) => Ok(url),
        // `None` is the ordinary reattach/legacy shape: a status assembled from a rediscovered
        // listener knows the port before it knows a url.
        _ => Ok(origin),
    }
}

async fn resolve_preview_url(app: AppHandle, agent_id: String) -> Result<String, String> {
    let status = crate::preview::preview_status(app, agent_id.clone()).await?;
    resolve_url_from_status(status, &agent_id)
}

// ---------------------------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------------------------

#[tauri::command]
pub async fn preview_screenshot(app: AppHandle, agent_id: String) -> Result<PreviewCapture, String> {
    let url = resolve_preview_url(app, agent_id).await?;
    tauri::async_runtime::spawn_blocking(move || capture_screenshot_blocking(&url))
        .await
        .map_err(|e| format!("preview eyes: capture task failed: {e}"))?
}

#[tauri::command]
pub async fn preview_query_dom(
    app: AppHandle,
    agent_id: String,
    selector: String,
) -> Result<Vec<DomMatch>, String> {
    if selector.trim().is_empty() {
        return Err("preview eyes: selector must not be empty".to_string());
    }
    let url = resolve_preview_url(app, agent_id).await?;
    tauri::async_runtime::spawn_blocking(move || query_dom_blocking(&url, &selector))
        .await
        .map_err(|e| format!("preview eyes: query task failed: {e}"))?
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ----- is_framable -----

    #[test]
    fn framable_names_every_preview_state_exactly_once() {
        // Named for what it asserts, not for a file: the old name was
        // `framable_states_match_preview_slot_tsx`, and `PreviewSlot.tsx` no longer exists — a test
        // name pointing at a deleted file is a claim nobody can check. It never compared against
        // any TypeScript anyway; it exhausts the enum, which is the property worth pinning (a new
        // `PreviewState` variant forces a decision here rather than defaulting to non-framable).
        // See `is_framable`'s docblock for the peer predicates this set deliberately differs from.
        // # guard-ok — tombstone: names the deleted file, and the retired test name, on purpose.
        assert!(is_framable(PreviewState::Listening));
        assert!(is_framable(PreviewState::Ready));
        assert!(is_framable(PreviewState::Serving));
        assert!(!is_framable(PreviewState::Starting));
        assert!(!is_framable(PreviewState::Failed));
        assert!(!is_framable(PreviewState::Crashed));
        assert!(!is_framable(PreviewState::Stopped));
    }

    // ----- find_headless_shell -----

    fn touch(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"#!/bin/sh\n").unwrap();
    }

    #[test]
    fn finds_the_binary_under_a_single_revision() {
        let dir = std::env::temp_dir().join(format!("sparkle-pe-test-{}-a", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let bin = dir
            .join("chromium_headless_shell-1228")
            .join("chrome-headless-shell-mac-arm64")
            .join("chrome-headless-shell");
        touch(&bin);

        let found = find_headless_shell(&dir).expect("should find the binary");
        assert_eq!(found, bin);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prefers_the_newest_revision_when_more_than_one_is_on_disk() {
        let dir = std::env::temp_dir().join(format!("sparkle-pe-test-{}-b", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let old = dir
            .join("chromium_headless_shell-1100")
            .join("chrome-headless-shell-mac-arm64")
            .join("chrome-headless-shell");
        let new = dir
            .join("chromium_headless_shell-1228")
            .join("chrome-headless-shell-mac-arm64")
            .join("chrome-headless-shell");
        touch(&old);
        touch(&new);

        let found = find_headless_shell(&dir).expect("should find a binary");
        assert_eq!(found, new, "should prefer the higher revision number");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn errors_with_an_actionable_message_when_nothing_is_installed() {
        let dir = std::env::temp_dir().join(format!("sparkle-pe-test-{}-missing", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let err = find_headless_shell(&dir).unwrap_err();
        assert!(err.contains("playwright install chromium"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ignores_a_directory_that_does_not_match_the_revision_prefix() {
        let dir = std::env::temp_dir().join(format!("sparkle-pe-test-{}-c", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // A sibling Playwright download that is NOT chromium_headless_shell must not be picked up.
        touch(&dir.join("webkit-2311").join("chrome-headless-shell"));

        let err = find_headless_shell(&dir).unwrap_err();
        assert!(err.contains("not installed") || err.contains("isn't installed"), "got: {err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    // ----- dom_query_expression -----

    #[test]
    fn embeds_the_selector_as_a_json_string_literal() {
        let expr = dom_query_expression(".card");
        assert!(expr.contains("querySelectorAll(\".card\")"), "got: {expr}");
    }

    #[test]
    fn escapes_a_selector_containing_a_quote_so_it_cannot_break_out() {
        // A selector like `[data-x="y"]` contains a literal `"` — if this were spliced in
        // unescaped, the generated expression would fail to parse (or worse, execute attacker-
        // shaped JS). serde_json::to_string must escape it.
        let expr = dom_query_expression(r#"[data-x="y"]"#);
        assert!(expr.contains(r#"[data-x=\"y\"]"#), "got: {expr}");
        // The whole thing must still be one balanced expression a JS engine can parse: reuse
        // serde_json's own tokenizer as a cheap sanity check that the string literal is well-formed
        // by re-extracting exactly the JSON string we embedded and round-tripping it.
        let selector_json = serde_json::to_string(r#"[data-x="y"]"#).unwrap();
        let round_tripped: String = serde_json::from_str(&selector_json).unwrap();
        assert_eq!(round_tripped, r#"[data-x="y"]"#);
    }

    #[test]
    fn caps_the_match_count_and_text_length_in_the_generated_expression() {
        let expr = dom_query_expression("div");
        assert!(expr.contains(&format!("slice(0, {DOM_QUERY_MAX_MATCHES})")), "got: {expr}");
        assert!(expr.contains(&format!("slice(0, {DOM_QUERY_TEXT_MAX_CHARS})")), "got: {expr}");
    }

    // ----- launch_flags -----

    #[test]
    fn launch_flags_carry_the_debug_port_and_profile_dir() {
        let dir = PathBuf::from("/tmp/sparkle-preview-eyes-test");
        let flags = launch_flags(54321, &dir, 1280, 800);
        assert!(flags.iter().any(|f| f == "--remote-debugging-port=54321"));
        assert!(flags.iter().any(|f| f.starts_with("--user-data-dir=") && f.contains("sparkle-preview-eyes-test")));
        assert!(flags.iter().any(|f| f == "--window-size=1280,800"));
        // No `--headless` flag: chrome-headless-shell is headless by construction, and passing an
        // unrecognised flag to it is a silent no-op that would mask the day this stops being true.
        assert!(!flags.iter().any(|f| f.starts_with("--headless")));
        // A RATCHET, not just prose: the renderer sandbox must stay on, since this loads arbitrary
        // web content at auto-allow risk tier — see the header comment above `launch_flags`. The
        // sibling harness (`cdp.mjs:138`) still passes `--no-sandbox`, which is exactly the place a
        // future reader copies from without this assertion. (roborev 64105)
        assert!(
            !flags.iter().any(|f| f == "--no-sandbox"),
            "the renderer sandbox must stay on — see the launch_flags header"
        );
    }

    // ----- free_port -----

    #[test]
    fn free_port_returns_a_bindable_port() {
        let port = free_port().expect("should reserve a port");
        // Prove it back out: a genuinely free port can be bound again immediately.
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    }

    // ----- live-binary integration tests -----
    //
    // These exercise the REAL headless browser end to end rather than only the pure helpers above.
    // SKIPPED (not failed) when Playwright's browsers aren't installed — libtest has no runtime-
    // skip primitive, so this is the same "announce a skip, don't fail" idiom used elsewhere in
    // this crate for tests that need a real external binary.
    //
    // STRICT UNDER CI: a missing browser there PANICS instead of skipping. A silent skip left the
    // whole HTTP-navigation/errorText/load-event line of coverage running on nothing in CI once
    // already (roborev 64105) — the `desktop-rust` job installs the browser precisely so these
    // tests are load-bearing there, and a future regression in `find_headless_shell`, a
    // `PLAYWRIGHT_BROWSERS_PATH` override, or a `HOME` difference on the runner must fail loudly
    // rather than quietly return CI to a green job testing nothing. (roborev 64123)

    fn headless_shell_available() -> bool {
        playwright_browsers_dir().ok().and_then(|d| find_headless_shell(&d).ok()).is_some()
    }

    macro_rules! require_headless_shell_or_skip {
        ($test_name:expr) => {
            if !headless_shell_available() {
                if std::env::var("CI").is_ok() {
                    panic!(
                        "{}: CI must have Playwright's chrome-headless-shell installed (see the \
                         desktop-rust job's install step) — a live test cannot silently skip here",
                        $test_name
                    );
                }
                eprintln!(
                    "SKIPPED {}: no chrome-headless-shell installed — run \
                     `npx playwright install chromium` to exercise this test",
                    $test_name
                );
                return;
            }
        };
    }

    #[test]
    fn a_live_headless_browser_can_answer_a_dom_query() {
        require_headless_shell_or_skip!("a_live_headless_browser_can_answer_a_dom_query");
        let matches = query_dom_blocking("about:blank", "body").expect("query should succeed");
        assert_eq!(matches.len(), 1, "about:blank has exactly one <body>");
        assert_eq!(matches[0].tag, "body");
    }

    #[test]
    fn a_live_headless_browser_can_screenshot_a_page() {
        require_headless_shell_or_skip!("a_live_headless_browser_can_screenshot_a_page");
        let capture = capture_screenshot_blocking("about:blank").expect("screenshot should succeed");
        assert!(Path::new(&capture.path).is_file(), "capture file should exist at {}", capture.path);
        let on_disk = std::fs::metadata(&capture.path).unwrap().len();
        assert_eq!(on_disk, capture.bytes, "reported byte count should match the file on disk");
        assert_eq!(capture.width, PREVIEW_CAPTURE_VIEWPORT_WIDTH);
        assert_eq!(capture.height, PREVIEW_CAPTURE_VIEWPORT_HEIGHT);
        std::fs::remove_file(&capture.path).ok();
    }

    #[test]
    fn a_bad_selector_surfaces_as_a_readable_error_not_a_null_result() {
        require_headless_shell_or_skip!("a_bad_selector_surfaces_as_a_readable_error_not_a_null_result");
        let err = query_dom_blocking("about:blank", ":::not-a-selector").unwrap_err();
        assert!(err.contains("preview eyes:"), "got: {err}");
    }

    /// A minimal single-page HTTP fixture server — real markup over a real socket, so the live
    /// tests below exercise `Page.navigate` against an actual `http://127.0.0.1:<port>` URL, not
    /// only `about:blank`. `about:blank` alone left the HTTP navigation path, and the
    /// `errorText`/load-event handling in `open_page`, exercised by nothing. (roborev 64071)
    struct FixtureServer {
        port: u16,
        handle: Option<std::thread::JoinHandle<()>>,
        shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl FixtureServer {
        fn start(body: &'static str) -> Self {
            Self::start_response(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\n\
                 Connection: close\r\n\r\n{}",
                body.len(),
                body
            ))
        }

        /// A response Chromium treats as a DOWNLOAD, not a page — `Content-Disposition: attachment`
        /// makes ITS OWN navigation abort with `net::ERR_ABORTED`, which is the exact benign case
        /// `open_page`'s `errorText` check must not treat as fatal (both Puppeteer and Playwright
        /// special-case the same value for the same reason). (roborev 64105)
        fn start_download() -> Self {
            let body = "just a file, not a page";
            Self::start_response(format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\
                 Content-Disposition: attachment; filename=\"x.txt\"\r\nContent-Length: {}\r\n\
                 Connection: close\r\n\r\n{}",
                body.len(),
                body
            ))
        }

        fn start_response(response: String) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind fixture server");
            let port = listener.local_addr().unwrap().port();
            listener.set_nonblocking(true).expect("set nonblocking");
            let shutdown = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let shutdown_bg = shutdown.clone();
            let handle = std::thread::spawn(move || {
                use std::io::{Read, Write};
                while !shutdown_bg.load(std::sync::atomic::Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let mut buf = [0u8; 1024];
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                            let _ = stream.read(&mut buf); // discard the request; one fixed response
                            let _ = stream.write_all(response.as_bytes());
                        }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self { port, handle: Some(handle), shutdown }
        }

        fn url(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }
    }

    impl Drop for FixtureServer {
        fn drop(&mut self) {
            self.shutdown.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(h) = self.handle.take() {
                let _ = h.join();
            }
        }
    }

    #[test]
    fn a_live_headless_browser_can_query_a_real_http_page() {
        require_headless_shell_or_skip!("a_live_headless_browser_can_query_a_real_http_page");
        let server = FixtureServer::start(
            r#"<!doctype html><html><body><button id="submit" class="btn primary">Save</button></body></html>"#,
        );
        let matches = query_dom_blocking(&server.url(), "#submit").expect("query should succeed");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].tag, "button");
        assert_eq!(matches[0].id.as_deref(), Some("submit"));
        assert_eq!(matches[0].text, "Save");
    }

    #[test]
    fn a_live_headless_browser_can_screenshot_a_real_http_page() {
        require_headless_shell_or_skip!("a_live_headless_browser_can_screenshot_a_real_http_page");
        let server =
            FixtureServer::start(r#"<!doctype html><html><body><h1>hello preview</h1></body></html>"#);
        let capture = capture_screenshot_blocking(&server.url()).expect("screenshot should succeed");
        assert!(Path::new(&capture.path).is_file());
        std::fs::remove_file(&capture.path).ok();
    }

    #[test]
    fn a_connection_refused_navigation_surfaces_as_an_error_not_a_blank_capture() {
        require_headless_shell_or_skip!("a_connection_refused_navigation_surfaces_as_an_error_not_a_blank_capture");
        // Reserve then release a port, so nothing is listening on it — the dev server "died
        // between preview_status and the capture" case the errorText check exists for.
        let port = free_port().expect("reserve a port");
        let dead_url = format!("http://127.0.0.1:{port}");
        let err = capture_screenshot_blocking(&dead_url).unwrap_err();
        assert!(err.contains("navigating") && err.contains("failed"), "got: {err}");
    }

    #[test]
    fn a_download_response_aborts_and_commits_nothing_so_it_still_fails_loudly() {
        require_headless_shell_or_skip!("a_download_response_aborts_and_commits_nothing_so_it_still_fails_loudly");
        // A `Content-Disposition: attachment` response makes Chromium abort ITS OWN navigation
        // with `net::ERR_ABORTED` — but unlike a redirect racing the navigation, NOTHING commits:
        // the frame stays on `about:blank`. A round-2 fix wrongly treated every `ERR_ABORTED` as
        // benign, which would have silently returned a blank capture here (roborev 64123). The
        // assertion pins BOTH halves: this reaches the `ERR_ABORTED` branch at all (not some other
        // error), AND the committed-document check catches it as a real failure.
        let server = FixtureServer::start_download();
        let started = Instant::now();
        let err = capture_screenshot_blocking(&server.url()).unwrap_err();
        assert!(err.contains("net::ERR_ABORTED"), "got: {err}");
        assert!(err.contains("no document committed"), "got: {err}");
        // Must fail FAST — a true abort can never fire `Page.frameNavigated`, so waiting the full
        // `NAV_TIMEOUT` (10s) for it would hang every failing preview URL that long before
        // refusing. The bound is deliberately loose: `started` includes `launch_browser()` +
        // `wait_for_debugger` (a Chromium cold start `LAUNCH_TIMEOUT` allows up to 10s for, though
        // the module header estimates ~1s in practice), not just the navigation itself — a tight
        // bound here would read ordinary CI machine load as a latency regression. 8s still
        // excludes the ~10s+ regression this guards against with real margin, since the fixed
        // navigation cost is now `ABORT_RECOMMIT_WAIT` (2s) rather than `NAV_TIMEOUT` (10s).
        // (roborev 64133, 64142)
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "took {:?} — the aborted-no-commit path must not wait the full NAV_TIMEOUT",
            started.elapsed()
        );
    }

    // ----- nav_verdict -----

    #[test]
    fn no_error_is_always_ok() {
        assert!(nav_verdict("http://x", None, None).is_ok());
        assert!(nav_verdict("http://x", None, Some("about:blank")).is_ok());
    }

    #[test]
    fn a_connection_level_failure_is_always_an_error() {
        let err = nav_verdict("http://x", Some("net::ERR_CONNECTION_REFUSED"), Some("about:blank"))
            .unwrap_err();
        assert!(err.contains("net::ERR_CONNECTION_REFUSED"), "got: {err}");
    }

    #[test]
    fn aborted_with_a_committed_document_is_ok() {
        // The benign case: a racing redirect that DID commit somewhere other than about:blank.
        assert!(nav_verdict("http://x", Some("net::ERR_ABORTED"), Some("http://x/after-redirect")).is_ok());
    }

    #[test]
    fn aborted_with_nothing_committed_is_an_error() {
        let err = nav_verdict("http://x", Some("net::ERR_ABORTED"), Some("about:blank")).unwrap_err();
        assert!(err.contains("net::ERR_ABORTED"), "got: {err}");
        assert!(err.contains("no document committed"), "got: {err}");
    }

    #[test]
    fn aborted_with_no_href_reading_at_all_is_an_error() {
        // `evaluate()` failing (or the CDP call erroring) must fail CLOSED, not treat an unreadable
        // href as a committed document.
        let err = nav_verdict("http://x", Some("net::ERR_ABORTED"), None).unwrap_err();
        assert!(err.contains("no document committed"), "got: {err}");
    }

    // ----- resolve_url_from_status -----

    /// A status carrying BOTH a port and a url, which is the shape `preview.rs` actually emits —
    /// `preview_url_with_route` sets `url` at the one place a port becomes a URL. The fixture used
    /// to hardcode `url: None`, which made the whole suite structurally incapable of expressing
    /// the defect in bead `sparkle-dlrqb8.1` (the route being thrown away): every assertion below
    /// was about a field nothing ever populated. `preview_status_no_url` keeps the `None` shape
    /// for the reattach/legacy case, which is real but is not the common one.
    fn preview_status_with_url(state: PreviewState, port: Option<u16>, url: Option<&str>) -> PreviewStatus {
        PreviewStatus {
            id: "preview-1".to_string(),
            agent_id: "agent-1".to_string(),
            project_id: "project-1".to_string(),
            url: url.map(|u| u.to_string()),
            port,
            state,
            error: None,
        }
    }

    /// The default fixture: a port, and the origin-only url `preview.rs` builds when no route was
    /// asked for.
    fn preview_status(state: PreviewState, port: Option<u16>) -> PreviewStatus {
        let url = port.map(|p| format!("http://127.0.0.1:{p}"));
        preview_status_with_url(state, port, url.as_deref())
    }

    #[test]
    fn no_status_refuses_with_no_preview() {
        let err = resolve_url_from_status(None, "agent-1").unwrap_err();
        assert!(err.contains("no preview is open"), "got: {err}");
    }

    #[test]
    fn a_non_framable_state_refuses_as_not_ready() {
        let err =
            resolve_url_from_status(Some(preview_status(PreviewState::Starting, Some(3000))), "agent-1")
                .unwrap_err();
        assert!(err.contains("not yet serving"), "got: {err}");
    }

    #[test]
    fn a_framable_state_with_no_port_refuses() {
        let err = resolve_url_from_status(Some(preview_status(PreviewState::Ready, None)), "agent-1")
            .unwrap_err();
        assert!(err.contains("no port yet"), "got: {err}");
    }

    #[test]
    fn a_framable_state_resolves_the_url_the_status_carries_including_its_route() {
        // THE POINT OF THE WHOLE BEAD (`sparkle-dlrqb8.1`). `{ op: "open", path: "/settings" }`
        // reaches `status.url` as a full route-bearing URL, and a screenshot has to land THERE.
        // Asserting the port-derived origin instead — which is what this test used to do — is
        // exactly what held the defect in place: the assertion passed for a function that could
        // only ever capture the app root.
        let url = resolve_url_from_status(
            Some(preview_status_with_url(
                PreviewState::Ready,
                Some(4321),
                Some("http://127.0.0.1:4321/settings"),
            )),
            "agent-1",
        )
        .unwrap();
        assert_eq!(url, "http://127.0.0.1:4321/settings");
    }

    #[test]
    fn a_deep_route_with_a_query_survives_intact() {
        // Nothing here re-parses or re-joins the URL, and nothing should: the query string is part
        // of what the agent asked to look at.
        let url = resolve_url_from_status(
            Some(preview_status_with_url(
                PreviewState::Serving,
                Some(4321),
                Some("http://127.0.0.1:4321/a/b?q=1#frag"),
            )),
            "agent-1",
        )
        .unwrap();
        assert_eq!(url, "http://127.0.0.1:4321/a/b?q=1#frag");
    }

    #[test]
    fn a_non_loopback_url_is_refused_and_falls_back_to_the_port_origin() {
        // `status.url` is RECEIVED, not constructed here, so the loopback-only property of this
        // surface is re-established rather than assumed. Falling back keeps a working preview
        // usable; returning the string would point a headless browser at a remote site.
        let url = resolve_url_from_status(
            Some(preview_status_with_url(
                PreviewState::Ready,
                Some(4321),
                Some("http://evil.example/settings"),
            )),
            "agent-1",
        )
        .unwrap();
        assert_eq!(url, "http://127.0.0.1:4321");
    }

    #[test]
    fn a_userinfo_url_that_only_looks_loopback_falls_back_too() {
        // `127.0.0.1@evil.example`'s host is `evil.example` — the trap `preview_url_is_loopback`'s
        // own docblock records. Pinned here so a future "just check the prefix" shortcut on this
        // side of the call goes red.
        let url = resolve_url_from_status(
            Some(preview_status_with_url(
                PreviewState::Ready,
                Some(4321),
                Some("http://127.0.0.1@evil.example/settings"),
            )),
            "agent-1",
        )
        .unwrap();
        assert_eq!(url, "http://127.0.0.1:4321");
    }

    #[test]
    fn an_https_url_falls_back_too() {
        // The anti-reuse case `preview_url_is_loopback` exists to hold: `is_safe_override` would
        // accept any `https://` origin, and that is catastrophically wrong for this gate.
        let url = resolve_url_from_status(
            Some(preview_status_with_url(
                PreviewState::Ready,
                Some(4321),
                Some("https://evil.example/settings"),
            )),
            "agent-1",
        )
        .unwrap();
        assert_eq!(url, "http://127.0.0.1:4321");
    }

    #[test]
    fn no_url_with_a_port_still_resolves_the_port_origin() {
        // The reattach/legacy path: a status assembled from a rediscovered listener knows the port
        // before it knows a url. That must keep working, not become a refusal.
        let url = resolve_url_from_status(
            Some(preview_status_with_url(PreviewState::Ready, Some(4321), None)),
            "agent-1",
        )
        .unwrap();
        assert_eq!(url, "http://127.0.0.1:4321");
    }

    #[test]
    fn a_url_without_a_port_still_refuses_with_no_port_yet() {
        // ORDER, ASSERTED. `previewInspect.ts` maps "no port yet" to its `preview-not-ready`
        // refusal, so a url arriving before a port must NOT be allowed to short-circuit that gate
        // — reading `url` first would turn this refusal into a successful resolve.
        let err = resolve_url_from_status(
            Some(preview_status_with_url(
                PreviewState::Ready,
                None,
                Some("http://127.0.0.1:4321/settings"),
            )),
            "agent-1",
        )
        .unwrap_err();
        assert!(err.contains("no port yet"), "got: {err}");
    }

    #[test]
    fn a_non_framable_state_refuses_even_with_a_route_bearing_url() {
        // The other half of the same ordering property: the `is_framable` gate stays ahead of the
        // url, so `previewInspect.ts` still sees "not yet serving anything".
        let err = resolve_url_from_status(
            Some(preview_status_with_url(
                PreviewState::Starting,
                Some(4321),
                Some("http://127.0.0.1:4321/settings"),
            )),
            "agent-1",
        )
        .unwrap_err();
        assert!(err.contains("not yet serving"), "got: {err}");
    }
}
