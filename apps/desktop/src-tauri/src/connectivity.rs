//! Reachability probe for the offline banner. The webview can't fetch an arbitrary probe URL
//! (CORS), so we check from Rust with `ureq` — mirroring naming.rs. Any HTTP *response* (even an
//! error status) means the network path is up; only a transport failure (DNS/connect/timeout)
//! counts as offline. (bead )
use std::sync::OnceLock;
use std::time::Duration;

/// A tiny, unauthenticated, widely-reachable endpoint that returns 204 No Content — cheap to hit
/// on the heartbeat and not tied to any one vendor's auth.
const PROBE_URL: &str = "https://www.google.com/generate_204";

/// True if the network is reachable. Best-effort and fast: short connect/read timeouts so a dead
/// link is reported as offline within a few seconds rather than hanging the heartbeat.
#[tauri::command]
pub async fn probe_connectivity() -> bool {
    // ureq is blocking; keep it off the async runtime's worker (same pattern as naming.rs).
    tauri::async_runtime::spawn_blocking(probe_blocking)
        .await
        .unwrap_or(false)
}

/// A ureq `Agent` is a cheap-to-clone handle over a shared connection pool, so build it once and
/// reuse it across every heartbeat rather than tearing down and re-creating the pool each probe.
/// The connect/read timeouts (baked into the agent) are preserved.
fn probe_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(3))
            .timeout_read(Duration::from_secs(3))
            .build()
    })
}

fn probe_blocking() -> bool {
    match probe_agent().head(PROBE_URL).call() {
        Ok(_) => true,                          // server answered → online
        Err(ureq::Error::Status(_, _)) => true, // answered with an error status → still online
        Err(ureq::Error::Transport(_)) => false, // DNS/connect/timeout → offline
    }
}
