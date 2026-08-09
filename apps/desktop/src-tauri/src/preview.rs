//! Live in-app browser preview — the supervisor half (Phase 1 of `docs/live-browser-preview.md`).
//!
//! Sparkle spawns a project's dev server as a SUPERVISED child, discovers the loopback port it
//! actually bound, and hands the frontend a `http://127.0.0.1:<port>` URL to frame. The rendering
//! half is an `<iframe>` (Phase 0 spike PASSED — see the design doc); everything expensive about
//! this feature is process and port lifecycle, which is what this module is.
//!
//! ── FOUR THINGS HERE ARE LOAD-BEARING, AND EACH ONE FAILS SILENTLY IF GOT WRONG ────────────────
//!
//! **1. Discovery must walk the process TREE.** The listening socket is never held by the child we
//! spawned: `pnpm` execs `node`, which forks the framework CLI, which forks the server — measured
//! four levels for `next dev`. A probe that inspected the direct child would find no listener and
//! time out on EVERY preview, with nothing red anywhere. Hence [`memwatch::descendant_pids`].
//!
//! **2. `lsof` exits 1 when ANY requested pid is invalid — while correctly reporting the others.**
//! Measured on this machine: `exit=1` alongside a complete, correct listing. A settling process
//! tree ALWAYS contains pids that have since exited, so keying readiness on the exit status yields a
//! probe that can never succeed. Readiness is keyed on the PARSED OUTPUT only; the status is
//! deliberately discarded. (`-a` is load-bearing for a different reason: without it `lsof` ORs the
//! `-i` and `-p` selections and reports every listener on the machine — measured 85 vs 2.)
//!
//! **3. A non-loopback bind is REFUSED, not depreferred.** `--port N` alone leaves a framework free
//! to default to `0.0.0.0`, which publishes the app's source maps and dev endpoints to the LAN. The
//! host flag is passed unconditionally AND the discovered address is re-checked, so this is correct
//! whichever way a given version defaults and survives a default changing under us.
//!
//! **4. Nothing is killed on a pid alone.** A pgid is recycled once its leader exits, so a stale
//! registry entry plus `kill(-pgid)` SIGKILLs an unrelated process group. This repo shipped exactly
//! that bug once (v0.44.0; see the note at `worktree.rs`'s reaping hazard), and the startup sweep is
//! its worst case because an entry can be arbitrarily old. Every reclaim requires the full
//! `(pid, pgid, kernel start time)` triple to still match; **anything unverifiable is DISCARDED
//! WITHOUT A SIGNAL.** [`plan_sweep`] is pure over two oracles precisely so both directions are
//! testable — that a verified triple IS killed, and that a recycled pid is NOT.
//!
//! ── WHAT IS DELIBERATELY NOT HERE ─────────────────────────────────────────────────────────────
//! No `max_servers`/LRU (a `PreviewSlot` covers one pair and there are two pairs, so the layout IS
//! the ceiling — §4). No idle-grace timer (Phase 2; `[preview].idle_grace_min` is read and LOGGED
//! here so the value is visibly plumbed, and acted on by nothing). No stdout URL parsing (§3 calls
//! it the weakest option). No `memwatch`/`agent_footprints` registration of preview pids — §4
//! forbids it by name, because `agent_footprints` takes its roots exclusively from
//! `PtyManager::session_pids()` and a preview server does not belong to a per-AGENT accounting.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::deps_bootstrap::PackageManager;
use crate::memwatch::{descendant_pids, ProcessTable, PsProcessTable};

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §1  PURE LOOPBACK GATES
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// The only hosts a preview may ever point at. Not a policy knob: the whole containment story —
/// `frame-src http://localhost:* http://127.0.0.1:*`, cross-origin isolation from the Tauri bridge,
/// "the cleartext never leaves the machine" — rests on this list being exactly these three.
pub const PREVIEW_LOOPBACK_HOSTS: &[&str] = &["localhost", "127.0.0.1", "::1"];

/// Is this the HOST half of a listen address, or of a URL authority, one of the loopback names?
///
/// Accepts a bracketed IPv6 host as well as a bare one, because the two shapes arrive from different
/// places (`lsof` prints `[::1]:5173`, a URL authority is also bracketed, a hand-written config may
/// not be).
pub fn is_loopback_listen_host(host: &str) -> bool {
    PREVIEW_LOOPBACK_HOSTS.contains(&unbracket_host(host))
}

/// Strip a bracketed IPv6 host down to its literal, leaving anything else untouched.
fn unbracket_host(host: &str) -> &str {
    let h = host.trim();
    h.strip_prefix('[').and_then(|rest| rest.split(']').next()).unwrap_or(h)
}

/// Is this host one the preview can actually REACH, as opposed to merely loopback?
///
/// The distinction exists because loopback is not one address. `preview_url_for` emits
/// `http://127.0.0.1:{port}` and `http_probe` connects to `Ipv4Addr::LOCALHOST`, so a server bound
/// only to `::1` is loopback and unreachable at the same time — accepting it yields a preview stuck
/// at Listening with a frame showing ERR_CONNECTION_REFUSED. `[::1]` is also deliberately absent
/// from the CSP's `frame-src`, so switching the URL to the v6 literal would not rescue it.
///
/// `localhost` counts as v4 here: it is what we ASK for (`--host 127.0.0.1` resolves to it) and it
/// is in `frame-src`. A server that resolved `localhost` to `::1` instead reports itself to `lsof`
/// as `[::1]`, which is the case this excludes.
pub fn is_ipv4_loopback_listen_host(host: &str) -> bool {
    matches!(unbracket_host(host), "localhost" | "127.0.0.1")
}

/// Split a listen address — `127.0.0.1:5200`, `*:5201`, `[::1]:5173` — into `(host, port)`.
///
/// **`rsplit_once`, never `split`.** An IPv6 host CONTAINS colons, so a forward split turns `[::1]`
/// into a bare `[` and the loopback case becomes unreachable — the same trap `builder_index`'s
/// `is_safe_override` records at roborev 47899, reached here by a different route. The port is the
/// last colon-separated field by construction, so splitting from the right is also simply correct.
///
/// `None` for anything that is not `<host>:<port>` with a non-zero port: a malformed row from a
/// racing `lsof` must be skipped, never guessed at.
pub fn parse_listen_addr(addr: &str) -> Option<(String, u16)> {
    let (host, port) = addr.trim().rsplit_once(':')?;
    let port: u16 = port.trim().parse().ok()?;
    if port == 0 {
        return None;
    }
    let host = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port))
}

/// Is this a URL a preview pane may be pointed at?
///
/// **Do NOT reuse `builder_index::is_safe_override` for this.** That function returns `true` for ANY
/// non-empty `https://` origin — correct for its own job (an API base whose request carries a bearer
/// token, where TLS is the requirement) and catastrophically wrong here, where the requirement is
/// that the framed document is a local process this app started. `preview_url_is_loopback` accepts
/// **only** `http://` at one of [`PREVIEW_LOOPBACK_HOSTS`], and nothing else — no https, no remote
/// host, no other scheme. A test asserts the two functions disagree on `https://evil.example`, so a
/// future "just reuse the existing one" refactor goes red rather than silently widening this gate.
///
/// **SCOPE — this has no production call site on the Rust side, and that is deliberate rather than
/// an oversight.** See `preview_url_for`: the Rust URL is CONSTRUCTED from a literal host and a
/// `u16`, so a check on it cannot fail, and an earlier version of this docblock implied a guard
/// that was not wired to anything. What this function is, honestly: the REFERENCE IMPLEMENTATION
/// of the rule, kept beside the constructor and pinned by tests so the rule itself (including the
/// userinfo and IPv6 traps below) has one authoritative statement — and so the anti-reuse test
/// above keeps documenting the `is_safe_override` trap. The live enforcement is on the frontend,
/// where a URL is RECEIVED rather than built: `services/preview.ts::isLoopbackPreviewUrl`, which
/// `PreviewSlot` uses to refuse rendering a non-loopback src.
///
/// `#[allow(dead_code)]` rather than deleted: the rule outlives any one caller, and re-deriving
/// these traps from scratch is how the userinfo case gets missed.
#[allow(dead_code)]
pub fn preview_url_is_loopback(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("http://") else {
        return false;
    };
    // Authority = everything before the path/query/fragment.
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return false;
    }
    // Userinfo (`user@host`) would let `127.0.0.1@evil.example` read as loopback to a naive split.
    if authority.contains('@') {
        return false;
    }
    let host = if let Some(after) = authority.strip_prefix('[') {
        match after.split(']').next() {
            Some(h) => h,
            None => return false,
        }
    } else {
        // Safe to split forward here: an unbracketed authority cannot be IPv6.
        authority.split(':').next().unwrap_or("")
    };
    is_loopback_listen_host(host)
}

/// The URL for a preview on `port`. `127.0.0.1` rather than `localhost` on purpose: `localhost` can
/// resolve to `::1` first, and a server that bound only the IPv4 loopback then refuses the frame.
/// **This is where loopback containment actually comes from on the Rust side: CONSTRUCTION, not
/// validation.** The host is a literal here and the only caller-supplied part is a `u16` port, so
/// there is no input that could name another origin. Together with `choose_listener` refusing a
/// non-loopback (or v6-only) bind, nothing downstream ever has a foreign URL to reject.
///
/// That is why `preview_url_is_loopback` below is documented as a gate for the FRONTEND rather than
/// used here: a Rust-side check on a string this function just built cannot fail, and an earlier
/// version of that function had no production call site at all while its test claimed to stop "a
/// refactor silently letting a preview pane load a remote site". The place a URL is *received*
/// rather than *constructed* is `services/preview.ts`, and that is where the live check lives
/// (`isLoopbackPreviewUrl`, enforced by `PreviewSlot` refusing to render a non-loopback src).
pub fn preview_url_for(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §2  SOCKET DISCOVERY
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// One listening TCP socket, as `lsof` reported it. `addr` is kept as the raw string because that is
/// what a refusal has to name back to the user (`*:3000` means something to them; a parsed struct
/// does not).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listener {
    pub pid: u32,
    pub addr: String,
}

/// The seam for "which sockets is this process tree listening on", mirroring
/// [`crate::memwatch::ProcessTable`] so discovery is unit-tested without running `lsof`.
///
/// `None` means WE COULD NOT LOOK (the binary is missing, the run timed out). That is deliberately
/// distinct from `Some(vec![])`, which means we looked and the tree is not listening yet — the first
/// must not be read as "not ready", or a broken probe would present as a server that never starts.
pub trait ListenTable: Send + Sync {
    fn listeners(&self, pids: &BTreeSet<u32>) -> Option<Vec<Listener>>;
}

/// A fixed table, for tests. Mirrors `memwatch::FixedProcessTable`, including the `dead_code`
/// allowance: the app itself only ever uses [`LsofListenTable`].
#[allow(dead_code)]
pub struct FixedListenTable(pub Option<Vec<Listener>>);

impl ListenTable for FixedListenTable {
    fn listeners(&self, _pids: &BTreeSet<u32>) -> Option<Vec<Listener>> {
        self.0.clone()
    }
}

/// Absolute path on purpose: `lsof` lives in `/usr/sbin`, which a Finder-launched app's PATH may not
/// carry, and this must not resolve to something a repo put earlier on PATH.
const LSOF: &str = "/usr/sbin/lsof";

/// `lsof` has NO timeout flag of its own and can block indefinitely on a wedged NFS/SMB mount, so it
/// never runs as a bare `Command::output()`. Five seconds is far past a healthy run (milliseconds).
const LSOF_TIMEOUT: Duration = Duration::from_secs(5);

/// Parse `lsof -F pn` field output.
///
/// The format is a `p<pid>` line followed by `f<fd>`/`n<addr>` pairs, one set per process. Verbatim
/// capture from this machine:
///
/// ```text
/// p20226
/// f3
/// n127.0.0.1:5200
/// p20228
/// f3
/// n*:5201
/// ```
///
/// An `n` line before any `p` line is dropped rather than guessed at, and unknown field letters are
/// ignored so adding a field to the request cannot corrupt the parse.
pub fn parse_lsof_fields(text: &str) -> Vec<Listener> {
    let mut out = Vec::new();
    let mut pid: Option<u32> = None;
    for line in text.lines() {
        let mut chars = line.trim_end().chars();
        let Some(kind) = chars.next() else { continue };
        let value = chars.as_str().trim();
        match kind {
            // A malformed pid CLEARS the current one: attributing the sockets that follow to the
            // previous process would be worse than dropping them.
            'p' => pid = value.parse().ok(),
            'n' if !value.is_empty() => {
                if let Some(p) = pid {
                    out.push(Listener { pid: p, addr: value.to_string() });
                }
            }
            _ => {}
        }
    }
    out
}

/// Turn one `lsof` RUN into listeners. `status_ok` is taken and **deliberately discarded**.
///
/// This exists as its own function purely so that discarding is a testable contract rather than an
/// absence. Measured on this machine, twice, and reproducible:
///
/// ```text
/// -p <live>            -> exit=0, stdout "p11488\nf3\nn127.0.0.1:56288\n"
/// -p <live>,<dead pid> -> exit=1, stdout "p11488\nf3\nn127.0.0.1:56288\n"   ← SAME OUTPUT
/// ```
///
/// A settling process tree ALWAYS contains pids that have since exited, so a caller that gated on
/// the status would discard a perfectly good listing on nearly every poll and the preview would
/// never reach `listening`. The parameter is kept (rather than not passed at all) so a reader sees
/// that the status was considered and rejected, and so a test can assert `status_ok = false` still
/// yields the listener.
pub fn listeners_from_lsof(status_ok: bool, stdout: &str) -> Vec<Listener> {
    let _ = status_ok;
    parse_lsof_fields(stdout)
}

/// The real table, via `lsof`.
pub struct LsofListenTable;

impl ListenTable for LsofListenTable {
    #[cfg(unix)]
    fn listeners(&self, pids: &BTreeSet<u32>) -> Option<Vec<Listener>> {
        if pids.is_empty() {
            return Some(Vec::new());
        }
        let csv = pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
        let mut cmd = Command::new(LSOF);
        // `-a` ANDs the `-i` and `-p` selections. Without it lsof ORs them and returns every
        // listener on the machine — measured 2 with, 85 without.
        cmd.args(["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", &csv, "-F", "pn"]);
        let captured = crate::worktree::output_with_timeout_lenient(cmd, LSOF_TIMEOUT).ok()?;
        // THE EXIT STATUS IS DELIBERATELY IGNORED — see `listeners_from_lsof`, which is where that
        // decision lives so it can be tested rather than inferred from a missing `if`.
        Some(listeners_from_lsof(
            captured.output.status.success(),
            &String::from_utf8_lossy(&captured.output.stdout),
        ))
    }
    #[cfg(not(unix))]
    fn listeners(&self, _pids: &BTreeSet<u32>) -> Option<Vec<Listener>> {
        None
    }
}

/// The v6-only refusal, as ONE string so the two call sites cannot drift.
///
/// **THE REMEDY NAMES SOMETHING THAT EXISTS.** An earlier version said "pin a host in the project's
/// `[preview]` config" — there is no `host` key, and serde ignores unknown keys, so a user who
/// followed that instruction would get no load error, no warning and no change: advice that
/// silently does nothing. `command`/`args` are the keys that do exist and are how a user actually
/// forces the bind. A remedy is an instruction someone will follow, so it gets the same scrutiny as
/// the code path it replaces.
fn v6_refusal(addr: &str) -> String {
    format!(
        "the dev server is listening only on the IPv6 loopback ({addr}), which the preview frame \
         cannot reach — Sparkle points the frame at 127.0.0.1, and the CSP admits only that and \
         localhost. Make the server bind IPv4: set `command`/`args` under [preview] in this \
         project's .sparkle/config.toml so its dev script gets an explicit `--host 127.0.0.1` (or \
         the framework's equivalent)."
    )
}

/// Pick the port a preview should be framed at, from everything the tree is listening on.
///
/// KEEP THIS DOCBLOCK ADJACENT TO THE `fn` BELOW. It has been detached twice by inserting a helper
/// between the two, and misattributed docs are still valid docs — `cargo check` cannot see it.
///
/// Three outcomes, and they are three because collapsing any two loses information the pane has to
/// render:
///   * `Ok(None)` — nothing is listening yet. Keep waiting.
///   * `Ok(Some(port))` — a loopback listener. The `requested` port wins when present, so the common
///     forced-port case is deterministic even while a framework opens a second socket (HMR).
///   * `Err(msg)` — the tree IS listening, but not on loopback. **Refused, not depreferred**, and
///     the message NAMES the offending address so the pane can say what it refused rather than
///     showing a generic failure.
pub fn choose_listener(listeners: &[Listener], requested: Option<u16>) -> Result<Option<u16>, String> {
    let mut loopback: Vec<u16> = Vec::new();
    let mut foreign: Vec<String> = Vec::new();
    // Bound on the IPv6 loopback ONLY. Tracked separately from `loopback` because every consumer
    // of the chosen port is IPv4: `preview_url_for` emits `http://127.0.0.1:{port}` and
    // `http_probe` connects to `Ipv4Addr::LOCALHOST`. Accepting a v6-only bind therefore produces
    // a preview that latches at Listening forever while the frame gets ERR_CONNECTION_REFUSED —
    // nothing is listening on the address we told it to load.
    //
    // Not hypothetical: `Framework::Unknown` is driven and injects NO host flag, so a plain root
    // `dev` script (`node server.js`, express, fastify, or an override `command`) binds wherever
    // the runtime chooses — and Node >= 17 resolves a bare `localhost` listen to `::1` first on
    // macOS. Emitting the v6 URL instead is not an option either: `[::1]` is deliberately absent
    // from the CSP's `frame-src`, so the frame could not load it. Hence a REFUSAL, by name.
    // Keyed BY PORT, not as a flat list, because the refusal has to be about the port we would
    // actually choose. An earlier version asked "is there any v4 socket in this tree at all", and
    // that was worse than the bug it fixed: Node's inspector on 127.0.0.1:9229 is an unrelated v4
    // loopback socket in the SAME process tree, so its presence skipped the refusal — and the
    // app's own v6-only port then fell through to `loopback.first()` and framed :9229. A wrong
    // page, silently, instead of an error.
    let mut v6_only: std::collections::BTreeMap<u16, String> = std::collections::BTreeMap::new();
    for l in listeners {
        match parse_listen_addr(&l.addr) {
            Some((host, port)) if is_ipv4_loopback_listen_host(&host) => loopback.push(port),
            Some((host, port)) if is_loopback_listen_host(&host) => {
                v6_only.insert(port, l.addr.trim().to_string());
            }
            Some(_) => foreign.push(l.addr.trim().to_string()),
            // Unparseable rows are skipped, not treated as foreign: a racing `lsof` can truncate a
            // line, and refusing a healthy preview over that would be worse than waiting.
            None => {}
        }
    }
    // A dual-stack server appears on the SAME PORT in both, and the v4 entry is the usable one, so
    // a port reachable over v4 is never treated as v6-only.
    for port in &loopback {
        v6_only.remove(port);
    }

    // THE REQUESTED PORT DECIDES when there is one: we forced it, so it is the app's port, and a
    // v6-only bind on it is the failure whatever else happens to be listening.
    if let Some(want) = requested {
        if loopback.contains(&want) {
            return Ok(Some(want));
        }
        if let Some(addr) = v6_only.get(&want) {
            return Err(v6_refusal(addr));
        }
    }
    loopback.sort_unstable();
    if let Some(&port) = loopback.first() {
        return Ok(Some(port));
    }
    // Nothing on v4 loopback, but something IS on v6: that is the app, and it is unreachable.
    if let Some((_, addr)) = v6_only.iter().next() {
        return Err(v6_refusal(addr));
    }
    foreign.sort();
    if let Some(addr) = foreign.first() {
        return Err(format!(
            "refusing to preview a dev server listening on {addr}: it is not bound to loopback, so \
             its source maps and dev endpoints are reachable from the whole local network"
        ));
    }
    Ok(None)
}

/// The whole discovery step: process tree → listening sockets → a verdict. Split out from the
/// supervisor loop so it can be driven from a test with both seams fixed.
pub fn discover_port(
    procs: &dyn ProcessTable,
    listen: &dyn ListenTable,
    root_pid: u32,
    requested: Option<u16>,
) -> Result<Option<u16>, String> {
    // `None` from either seam means we could not look — NOT that nothing is listening.
    let Some(rows) = procs.rows() else { return Ok(None) };
    let tree = descendant_pids(&rows, root_pid);
    let Some(listeners) = listen.listeners(&tree) else { return Ok(None) };
    choose_listener(&listeners, requested)
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §3  PREVIEWABILITY DETECTION
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// A framework we can recognise from a root config file. Recognising one is NOT the same as driving
/// it — see [`Framework::is_driven`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Framework {
    Next,
    Vite,
    Astro,
    Nuxt,
    Remix,
    /// No recognised signature. Driven with no injected flags, relying on discovery plus the
    /// loopback refusal — see [`Framework::port_args`].
    Unknown,
}

impl Framework {
    /// Map a ROOT directory entry name to the framework its presence implies. Extension-agnostic
    /// (`next.config.ts`, `.js`, `.mjs`, `.cjs` all occur in the founder's own projects).
    pub fn for_config_file(name: &str) -> Option<Framework> {
        let stem = name.split('.').next().unwrap_or("");
        if name.split('.').count() < 2 {
            return None;
        }
        match stem {
            "next" if name.starts_with("next.config.") => Some(Framework::Next),
            "vite" if name.starts_with("vite.config.") => Some(Framework::Vite),
            "astro" if name.starts_with("astro.config.") => Some(Framework::Astro),
            "nuxt" if name.starts_with("nuxt.config.") => Some(Framework::Nuxt),
            "remix" if name.starts_with("remix.config.") => Some(Framework::Remix),
            _ => None,
        }
    }

    /// Whether Phase 1 will actually RUN this, as opposed to merely recognising it.
    ///
    /// Only Next and Vite, and the reason is the one `deps_bootstrap::PackageManager::is_supported`
    /// records from a bug it already shipped: writing a tool's flags out of its documentation
    /// instead of out of a run is how you get an arm that fails before it does anything. Astro, Nuxt
    /// and Remix are recognised so the decline can NAME them — "we don't drive Astro yet" and "we
    /// have no idea what this project is" call for completely different follow-ups.
    ///
    /// `Unknown` is driven: it is reached from a plain root `dev` script on a project with no
    /// framework signature, which the design's rule 2 calls previewable. No flags are injected for
    /// it, so its bind is whatever the project chose — and a non-loopback bind is refused at
    /// discovery, which is the guard that makes this safe rather than hopeful.
    pub fn is_driven(self) -> bool {
        matches!(self, Framework::Next | Framework::Vite | Framework::Unknown)
    }

    /// The framework's own name, for messages.
    pub fn label(self) -> &'static str {
        match self {
            Framework::Next => "Next.js",
            Framework::Vite => "Vite",
            Framework::Astro => "Astro",
            Framework::Nuxt => "Nuxt",
            Framework::Remix => "Remix",
            Framework::Unknown => "this project",
        }
    }

    /// Flags forcing BOTH the port and the loopback bind.
    ///
    /// **The host flag is unconditional, and that is the point.** `--port N` alone leaves the
    /// framework free to default to `0.0.0.0`, publishing source maps and dev endpoints to the LAN.
    /// Passing the host every time is correct whichever way a given version defaults, and survives a
    /// default changing under us. `--strictPort` on Vite makes a taken port fail loudly instead of
    /// drifting to the next one, which keeps the forced case deterministic.
    pub fn port_args(self, port: u16) -> Vec<String> {
        match self {
            Framework::Next => {
                vec!["--port".into(), port.to_string(), "--hostname".into(), "127.0.0.1".into()]
            }
            Framework::Vite => vec![
                "--port".into(),
                port.to_string(),
                "--strictPort".into(),
                "--host".into(),
                "127.0.0.1".into(),
            ],
            // Not driven (the caller declines first) or unrecognised: inject nothing rather than
            // guess a flag. Discovery finds whatever it bound; a non-loopback bind is refused.
            _ => Vec::new(),
        }
    }

    /// The dev binary to `exec` when a project has a framework config but no `dev` script.
    pub fn dev_bin(self) -> Option<&'static str> {
        match self {
            Framework::Next => Some("next"),
            Framework::Vite => Some("vite"),
            _ => None,
        }
    }
}

/// Why a worktree is not previewable. A TYPED decline, never a bare `Option`: the pane has to render
/// a reason, and "not previewable" with no cause is the shape that makes a mis-detection
/// undebuggable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decline {
    /// `[preview].enabled = false`.
    Disabled,
    /// No `package.json` at the root. Sparkle opens agents on Rust/Go/Python repos too.
    NotAJsProject,
    /// A `package.json` we could not read or parse.
    UnreadableManifest(String),
    /// Recognised, but not driven in Phase 1.
    UnsupportedFramework(Framework),
    /// A lockfile naming a manager whose argument forwarding has not been verified by running it.
    UnsupportedPackageManager(PackageManager),
    /// A `package.json` with no lockfile of any kind: we cannot tell which manager to invoke.
    NoPackageManager,
    /// Nothing that looks like a dev server anywhere in scan range.
    NoDevScript,
    /// More than one candidate. Guessing among them is worse than declining (§7 rule 4), so every
    /// candidate is named and the user picks one via `[preview]` in the project's config.
    Ambiguous(Vec<String>),
}

impl Decline {
    /// A stable discriminant, for logs and for a frontend that wants to branch without matching
    /// prose.
    pub fn code(&self) -> &'static str {
        match self {
            Decline::Disabled => "disabled",
            Decline::NotAJsProject => "not-a-js-project",
            Decline::UnreadableManifest(_) => "unreadable-manifest",
            Decline::UnsupportedFramework(_) => "unsupported-framework",
            Decline::UnsupportedPackageManager(_) => "unsupported-package-manager",
            Decline::NoPackageManager => "no-package-manager",
            Decline::NoDevScript => "no-dev-script",
            Decline::Ambiguous(_) => "ambiguous",
        }
    }

    /// The sentence the pane shows. Names the specific thing wherever there is one to name — a
    /// decline the user cannot act on is the same as no message.
    pub fn message(&self) -> String {
        match self {
            Decline::Disabled => "previews are turned off ([preview].enabled = false)".into(),
            Decline::NotAJsProject => {
                "no package.json at the repo root, so there is no dev server to preview".into()
            }
            Decline::UnreadableManifest(e) => format!("could not read this project's package.json: {e}"),
            Decline::UnsupportedFramework(f) => format!(
                "{} is recognised but not driven yet — add a [preview] command to this project's \
                 .sparkle/config.toml to preview it",
                f.label()
            ),
            Decline::UnsupportedPackageManager(pm) => format!(
                "this repo's lockfile names {}, whose argument forwarding Sparkle has not verified \
                 by running it — add a [preview] command to this project's .sparkle/config.toml",
                pm.program()
            ),
            Decline::NoPackageManager => {
                "this repo has a package.json but no lockfile, so Sparkle cannot tell which package \
                 manager to run"
                    .into()
            }
            Decline::NoDevScript => {
                "no dev script and no framework config found, so there is nothing to preview".into()
            }
            Decline::Ambiguous(candidates) => format!(
                "more than one thing here could be previewed ({}) — name the one you want under \
                 [preview] in this project's .sparkle/config.toml",
                candidates.join(", ")
            ),
        }
    }
}

/// What to run, and where, to bring a preview up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewTarget {
    pub framework: Framework,
    /// The program, as a name (`pnpm`) — resolved to an absolute path at spawn, because a
    /// Finder-launched Sparkle inherits a PATH with no nvm/corepack on it.
    pub program: String,
    /// Everything before the injected port flags, e.g. `["run", "dev"]`.
    pub args: Vec<String>,
    /// Whether a `--` must separate the script's own args from the flags we inject.
    ///
    /// MEASURED, not read: `pnpm run dev --port 5555` forwards the flags verbatim while
    /// `pnpm run dev -- --port 5555` passes the literal `--` THROUGH to the script; `npm run dev
    /// --port 5555` swallows the flag NAMES and delivers only `5555`. So the separator is
    /// package-manager dependent, it is silent when wrong, and it cannot be written from
    /// documentation.
    pub needs_arg_separator: bool,
    /// Directory to run in, relative to the worktree root. Empty = the root.
    pub path: String,
    /// Which detection rule produced this, so a wrong answer is traceable to a rule.
    pub source: &'static str,
    /// A port pinned by project config. `None` = Sparkle allocates one.
    pub port: Option<u16>,
}

/// The full argument vector for a spawn on `port`.
pub fn build_argv(target: &PreviewTarget, port: u16) -> Vec<String> {
    let mut args = target.args.clone();
    let flags = target.framework.port_args(port);
    if flags.is_empty() {
        return args;
    }
    if target.needs_arg_separator {
        args.push("--".into());
    }
    args.extend(flags);
    args
}

/// A project's `[preview]` override, read straight off the worktree's own `.sparkle/config.toml`.
/// Deliberately not routed through the merged `SparkleConfig`: detection runs against an arbitrary
/// worktree path, which is not necessarily the project the app config was merged for.
#[derive(Debug, Default, Deserialize)]
struct PreviewOverride {
    command: Option<String>,
    args: Option<Vec<String>>,
    path: Option<String>,
    port: Option<u16>,
}

fn read_preview_override(worktree: &Path) -> PreviewOverride {
    let path = worktree.join(".sparkle").join("config.toml");
    let Ok(text) = std::fs::read_to_string(path) else { return PreviewOverride::default() };
    let Ok(value) = text.parse::<toml::Value>() else { return PreviewOverride::default() };
    value
        .get("preview")
        .cloned()
        .and_then(|v| v.try_into::<PreviewOverride>().ok())
        .unwrap_or_default()
}

/// A package.json's `scripts` table, or a read/parse error. Sorted, so a decline names its
/// candidates in a stable order.
fn read_scripts(dir: &Path) -> Result<Option<BTreeMap<String, String>>, String> {
    let manifest = dir.join("package.json");
    if !manifest.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&manifest).map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut out = BTreeMap::new();
    if let Some(scripts) = value.get("scripts").and_then(|s| s.as_object()) {
        for (k, v) in scripts {
            if let Some(s) = v.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    Ok(Some(out))
}

/// The framework signature at the ROOT of a worktree, if any.
fn root_framework(worktree: &Path) -> Framework {
    let Ok(entries) = std::fs::read_dir(worktree) else { return Framework::Unknown };
    let mut found = Framework::Unknown;
    for entry in entries.flatten() {
        if let Some(f) = Framework::for_config_file(&entry.file_name().to_string_lossy()) {
            // First match wins in enum order only by accident; a repo with two framework configs at
            // its root is pathological, and either answer is a guess. Take the first and move on.
            found = f;
            break;
        }
    }
    found
}

/// Is this a workspace root?
fn is_workspace_root(worktree: &Path, root_manifest: Option<&serde_json::Value>) -> bool {
    if worktree.join("pnpm-workspace.yaml").is_file() {
        return true;
    }
    root_manifest.and_then(|m| m.get("workspaces")).is_some()
}

/// Sub-packages (below the root) whose `package.json` has a `dev` script, as paths relative to the
/// root. Uses `preflight`'s bounded walker — same `MAX_SCAN_DIRS`/depth/skip-list as the language
/// scan — rather than a second walk with its own bounds to get wrong.
fn workspace_dev_packages(worktree: &Path) -> Vec<String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    crate::preflight::bounded_scan(worktree, &mut |dir: &Path, name: &str, _is_dir: bool| {
        if name == "package.json" && dir != worktree {
            dirs.push(dir.to_path_buf());
        }
        crate::preflight::ScanFlow::Continue
    });
    let mut out: Vec<String> = Vec::new();
    for dir in dirs {
        if matches!(read_scripts(&dir), Ok(Some(ref s)) if s.contains_key("dev")) {
            if let Ok(rel) = dir.strip_prefix(worktree) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// How to invoke a package-manager script, given the measured forwarding rules.
fn run_script_invocation(pm: PackageManager, script: &str) -> (Vec<String>, bool) {
    match pm {
        // Measured: pnpm forwards trailing args verbatim and passes a literal `--` through.
        PackageManager::Pnpm => (vec!["run".into(), script.into()], false),
        // Measured: npm needs the `--`, and without it eats the flag NAMES.
        PackageManager::Npm => (vec!["run".into(), script.into()], true),
        // Never reached — the caller declines an unsupported manager first. The arm exists so the
        // match stays exhaustive if that ever changes.
        PackageManager::Yarn | PackageManager::Bun => (vec!["run".into(), script.into()], true),
    }
}

/// How to invoke a framework binary directly, when there is no script to run.
fn exec_invocation(pm: PackageManager, bin: &str) -> (Vec<String>, bool) {
    match pm {
        // Measured: `pnpm exec node ./x.js --port 5555` delivers the flags verbatim.
        PackageManager::Pnpm => (vec!["exec".into(), bin.into(), "dev".into()], false),
        // Measured: `npm exec -- node ./x.js --port 5555` delivers the flags verbatim.
        PackageManager::Npm => (vec!["exec".into(), "--".into(), bin.into(), "dev".into()], false),
        PackageManager::Yarn | PackageManager::Bun => (vec!["exec".into(), bin.into(), "dev".into()], false),
    }
}

/// Decide whether — and how — a worktree can be previewed. Priority order is §7's.
///
/// `enabled` is passed in rather than read here so the function stays pure w.r.t. app state and can
/// be driven from a test both ways.
pub fn detect_preview_target(worktree: &Path, enabled: bool) -> Result<PreviewTarget, Decline> {
    if !enabled {
        return Err(Decline::Disabled);
    }

    // ── 1. Explicit project config wins. The escape hatch for when detection is wrong, and the
    // only thing the founder should ever have to write. It needs no package.json and no lockfile:
    // by writing it, he has already answered every question detection would ask.
    let over = read_preview_override(worktree);
    if let Some(command) = over.command.as_ref().map(|c| c.trim()).filter(|c| !c.is_empty()) {
        return Ok(PreviewTarget {
            // Unknown, not a guess: we do not know which framework a hand-written command starts,
            // so nothing is injected and discovery + the loopback refusal do the work.
            framework: Framework::Unknown,
            program: command.to_string(),
            args: over.args.unwrap_or_default(),
            needs_arg_separator: false,
            path: over.path.unwrap_or_default(),
            source: "config",
            port: over.port,
        });
    }

    let root_manifest_text = match std::fs::read_to_string(worktree.join("package.json")) {
        Ok(t) => t,
        Err(_) => return Err(Decline::NotAJsProject),
    };
    let root_manifest: serde_json::Value =
        serde_json::from_str(&root_manifest_text).map_err(|e| Decline::UnreadableManifest(e.to_string()))?;
    let root_scripts = read_scripts(worktree).map_err(Decline::UnreadableManifest)?.unwrap_or_default();

    let pm = crate::deps_bootstrap::manager_for(worktree);
    let framework = root_framework(worktree);

    // ── 2. A single unambiguous root `dev` script. Six of the founder's eleven projects.
    if root_scripts.contains_key("dev") {
        if !framework.is_driven() {
            return Err(Decline::UnsupportedFramework(framework));
        }
        let pm = pm.ok_or(Decline::NoPackageManager)?;
        if !pm.forwards_run_args_verified() {
            return Err(Decline::UnsupportedPackageManager(pm));
        }
        let (args, needs_arg_separator) = run_script_invocation(pm, "dev");
        return Ok(PreviewTarget {
            framework,
            program: pm.program().to_string(),
            args,
            needs_arg_separator,
            path: String::new(),
            source: "root-dev-script",
            port: None,
        });
    }

    // ── 3. Framework signature at the root, with an unconventional script name (or none). Only for
    // a framework we actually drive; a recognised-but-undriven one declines BY NAME here.
    if framework != Framework::Unknown {
        if !framework.is_driven() {
            return Err(Decline::UnsupportedFramework(framework));
        }
        if let Some(bin) = framework.dev_bin() {
            let pm = pm.ok_or(Decline::NoPackageManager)?;
            if !pm.forwards_run_args_verified() {
                return Err(Decline::UnsupportedPackageManager(pm));
            }
            let (args, needs_arg_separator) = exec_invocation(pm, bin);
            return Ok(PreviewTarget {
                framework,
                program: pm.program().to_string(),
                args,
                needs_arg_separator,
                path: String::new(),
                source: "framework-signature",
                port: None,
            });
        }
    }

    // ── 4. Monorepo. Candidates are the root's `dev:*` variants AND every sub-package with a plain
    // `dev`. Both count, and that is what makes Sparkle itself decline: its root carries four
    // `dev:*` scripts and three of its packages have a `dev`, so enumerating only the packages would
    // have found "exactly one" in a repo where the right answer is obviously unknowable.
    let mut candidates: Vec<String> =
        root_scripts.keys().filter(|k| k.starts_with("dev:")).cloned().collect();
    let packages =
        if is_workspace_root(worktree, Some(&root_manifest)) { workspace_dev_packages(worktree) } else { Vec::new() };
    candidates.extend(packages.iter().map(|p| format!("{p} (dev)")));

    if candidates.len() > 1 {
        return Err(Decline::Ambiguous(candidates));
    }
    if candidates.is_empty() {
        return Err(Decline::NoDevScript);
    }

    let pm = pm.ok_or(Decline::NoPackageManager)?;
    if !pm.forwards_run_args_verified() {
        return Err(Decline::UnsupportedPackageManager(pm));
    }
    // Exactly one candidate: either a lone root `dev:<x>`, or one package with `dev`.
    if let Some(pkg) = packages.first() {
        let pkg_dir = worktree.join(pkg);
        let pkg_framework = root_framework(&pkg_dir);
        if !pkg_framework.is_driven() {
            return Err(Decline::UnsupportedFramework(pkg_framework));
        }
        let (args, needs_arg_separator) = run_script_invocation(pm, "dev");
        return Ok(PreviewTarget {
            framework: pkg_framework,
            program: pm.program().to_string(),
            args,
            needs_arg_separator,
            path: pkg.clone(),
            source: "workspace-package",
            port: None,
        });
    }
    let script = candidates[0].clone();
    if !framework.is_driven() {
        return Err(Decline::UnsupportedFramework(framework));
    }
    let (args, needs_arg_separator) = run_script_invocation(pm, &script);
    Ok(PreviewTarget {
        framework,
        program: pm.program().to_string(),
        args,
        needs_arg_separator,
        path: String::new(),
        source: "root-dev-variant",
        port: None,
    })
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §4  PORT ALLOCATION
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// Ports a preview may never be handed.
///
/// **Re-exported from `preview_csp`, deliberately NOT a second copy.** Both modules independently
/// grew this constant with the same value, which is worse than either alone: `preview_csp`'s test
/// asserts that Sparkle's `devUrl` port is a member, so a duplicate here would let someone delete
/// the reservation the ALLOCATOR reads while that test stayed green — guarding a constant nobody
/// uses. One definition, and the test now guards the one this function reads.
///
/// **1420 is Sparkle's own dev URL** (`vite.config.ts`, `tauri.conf.json`). Two independent reasons
/// it is disqualifying: Tauri REWRITES External URLs matching the configured devUrl, so a preview
/// there would frame Sparkle inside Sparkle; and — the serious one — in a dev build the app
/// document's own origin IS `http://localhost:1420`, so the frame would be SAME-ORIGIN with the
/// host and could reach `parent.__TAURI_INTERNALS__`. The kernel hands out ephemeral ports well
/// above this, so the collision is rare and correspondingly baffling when it happens.
pub use crate::preview_csp::RESERVED_PORTS;

pub fn is_reserved_port(port: u16) -> bool {
    RESERVED_PORTS.contains(&port)
}

/// The first port in `candidates` that may actually be used. Pure, so the reservation is tested
/// without depending on which port the kernel happens to hand out.
pub fn first_unreserved(candidates: &[u16]) -> Option<u16> {
    candidates.iter().copied().find(|p| *p != 0 && !is_reserved_port(*p))
}

/// Allocate a free loopback port: bind `127.0.0.1:0`, read it back, drop the listener.
///
/// There is a TOCTOU window between the drop and the child's own bind; the design absorbs it with
/// discovery (whatever the child really bound is what gets framed) rather than with a lock nothing
/// else respects.
pub fn allocate_port() -> Result<u16, String> {
    let mut seen: Vec<u16> = Vec::new();
    for _ in 0..8 {
        let listener = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .map_err(|e| format!("could not allocate a preview port: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("could not read the allocated preview port: {e}"))?
            .port();
        drop(listener);
        seen.push(port);
        if let Some(p) = first_unreserved(&seen[seen.len() - 1..]) {
            return Ok(p);
        }
    }
    Err(format!(
        "the kernel only offered reserved ports ({seen:?}); Sparkle will not preview on its own dev port"
    ))
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §5  REGISTRY + ORPHAN SWEEP
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// A process's identity: enough to tell "still the process I spawned" from "a recycled pid".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcIdentity {
    pub pid: u32,
    pub pgid: u32,
    /// The kernel start time, as `ps -o lstart=` prints it, whitespace-normalised.
    pub lstart: String,
}

/// Collapse whitespace runs to single spaces.
///
/// `ps` right-aligns the day of month, so the SAME instant prints as `Aug  6` on the 6th and
/// `Aug 16` on the 16th — and a byte comparison between a stored `Aug  6` and a freshly read
/// `Aug 6` reads as a recycled pid, which would turn every reclaim into a discard and leave orphans
/// forever. It also trims the trailing padding `ps` emits.
pub fn normalize_lstart(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Parse `ps -o pid=,pgid=,lstart= -p <pid>`.
///
/// **`lstart` MUST be last in the format string** — it contains spaces (`Sat Aug  8 10:58:10 2026`),
/// so anything after it would be unparseable. And it must be `lstart`, not `start`: `ps -o start=`
/// prints `Thu11AM` for a process older than a day, which cannot discriminate a recycled pid from
/// the original at all.
pub fn parse_ps_identity(text: &str) -> Option<ProcIdentity> {
    let line = text.lines().find(|l| !l.trim().is_empty())?;
    let mut fields = line.split_whitespace();
    let pid: u32 = fields.next()?.parse().ok()?;
    let pgid: u32 = fields.next()?.parse().ok()?;
    let rest: Vec<&str> = fields.collect();
    if rest.is_empty() {
        return None;
    }
    Some(ProcIdentity { pid, pgid, lstart: rest.join(" ") })
}

/// One supervised server, as persisted. Written IMMEDIATELY after spawn — before readiness — so a
/// hard kill in the settling window still leaves something the next launch's sweep can reason about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEntry {
    pub id: String,
    pub agent_id: String,
    pub project_id: String,
    pub worktree: String,
    pub requested_port: Option<u16>,
    pub bound_port: Option<u16>,
    pub pid: u32,
    pub pgid: u32,
    pub pid_start_time: String,
    pub owner_pid: u32,
    /// The Sparkle LAUNCH that spawned this, not just its pid. Liveness is decided by the
    /// flock-backed `babysit_lease::epoch_is_alive`, never by a bare pid — a zombie and a recycled
    /// pid both answer "alive" to a pid probe.
    pub owner_epoch: String,
    pub started_at: u64,
    pub cmd: String,
}

/// Is the Sparkle launch that minted `epoch` still running?
pub trait OwnerLiveness {
    fn epoch_alive(&self, epoch: &str) -> bool;
}

/// What is process `pid` right now, if anything?
pub trait IdentityOracle {
    fn identity(&self, pid: u32) -> Option<ProcIdentity>;
}

/// What the sweep decided about one entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SweepAction {
    /// Ours, or another LIVE Sparkle's. Leave the process alone and keep the entry.
    Keep { id: String, why: &'static str },
    /// The owner is gone AND the full `(pid, pgid, start-time)` triple still matches. Reclaim.
    Kill { id: String, pgid: u32 },
    /// The owner is gone and identity could NOT be verified. Drop the entry, signal NOTHING.
    Discard { id: String, why: &'static str },
}

/// Decide what to do with every persisted entry. **Pure** over the two oracles, which is the whole
/// point: the dangerous direction (killing on a stale pid) and the useless direction (never
/// reclaiming anything) are both testable, and a change that hardens this into always-discard leaves
/// orphans forever with nothing red.
pub fn plan_sweep(
    entries: &[PreviewEntry],
    current_epoch: &str,
    live: &dyn OwnerLiveness,
    ident: &dyn IdentityOracle,
) -> Vec<SweepAction> {
    entries
        .iter()
        .map(|e| {
            let id = e.id.clone();
            if e.owner_epoch == current_epoch {
                return SweepAction::Keep { id, why: "own-epoch" };
            }
            if live.epoch_alive(&e.owner_epoch) {
                // Another Sparkle is running and owns this. Its previews are not ours to kill.
                return SweepAction::Keep { id, why: "another-live-instance" };
            }
            // `kill(-0, …)` signals OUR OWN process group, and pid 0/1 are never a preview server.
            if e.pid <= 1 || e.pgid <= 1 {
                return SweepAction::Discard { id, why: "unusable-pid-or-pgid" };
            }
            let Some(now) = ident.identity(e.pid) else {
                return SweepAction::Discard { id, why: "pid-gone" };
            };
            if now.pgid != e.pgid {
                return SweepAction::Discard { id, why: "pgid-mismatch" };
            }
            if normalize_lstart(&now.lstart) != normalize_lstart(&e.pid_start_time) {
                // Same pid, same pgid, DIFFERENT start time: the pid was recycled. Killing this
                // group would SIGKILL somebody else's work.
                return SweepAction::Discard { id, why: "start-time-mismatch" };
            }
            SweepAction::Kill { id, pgid: e.pgid }
        })
        .collect()
}

/// The registry file. One JSON array, rewritten whole — it holds at most a couple of entries, so
/// there is nothing to gain from anything cleverer, and a partial write is the failure mode that
/// would make the sweep read garbage.
pub fn registry_path(app_data: &Path) -> PathBuf {
    app_data.join("preview").join("servers.json")
}

/// Serializes every read-modify-write of the registry within this process.
fn registry_lock() -> &'static Mutex<()> {
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

pub fn load_registry(app_data: &Path) -> Vec<PreviewEntry> {
    let Ok(text) = std::fs::read_to_string(registry_path(app_data)) else { return Vec::new() };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save_registry(app_data: &Path, entries: &[PreviewEntry]) -> Result<(), String> {
    let path = registry_path(app_data);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    // Write-then-rename, so a crash mid-write cannot leave the sweep a truncated array.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

fn registry_upsert(app_data: &Path, entry: PreviewEntry) {
    let _guard = registry_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_registry(app_data);
    entries.retain(|e| e.id != entry.id);
    entries.push(entry);
    if let Err(e) = save_registry(app_data, &entries) {
        tracing::warn!("preview: could not write the server registry: {e}");
    }
}

fn registry_remove(app_data: &Path, id: &str) {
    let _guard = registry_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_registry(app_data);
    let before = entries.len();
    entries.retain(|e| e.id != id);
    if entries.len() != before {
        if let Err(e) = save_registry(app_data, &entries) {
            tracing::warn!("preview: could not write the server registry: {e}");
        }
    }
}

/// Liveness via the flock-backed instance lock. See [`crate::babysit_lease::epoch_is_alive`] for why
/// a bare pid probe is not good enough.
struct EpochLiveness<'a> {
    app_data: &'a Path,
}

impl OwnerLiveness for EpochLiveness<'_> {
    fn epoch_alive(&self, epoch: &str) -> bool {
        crate::babysit_lease::epoch_is_alive(self.app_data, epoch)
    }
}

/// Identity via `/bin/ps`, bounded (a wedged `ps` must not hang startup).
pub struct PsIdentity;

impl IdentityOracle for PsIdentity {
    fn identity(&self, pid: u32) -> Option<ProcIdentity> {
        let mut cmd = Command::new("/bin/ps");
        cmd.args(["-o", "pid=,pgid=,lstart=", "-p", &pid.to_string()]);
        let captured = crate::worktree::output_with_timeout_lenient(cmd, Duration::from_secs(5)).ok()?;
        parse_ps_identity(&String::from_utf8_lossy(&captured.output.stdout))
    }
}

/// Reclaim preview servers left behind by a launch that is gone. Called from `.setup()`.
///
/// This is the PRIMARY orphan path, not a backstop: managed state leaks on the ordinary Cmd+Q path,
/// so a hard kill leaves the child running with nothing else that would ever stop it.
pub fn sweep_orphans(app_data: &Path) {
    let entries = load_registry(app_data);
    if entries.is_empty() {
        return;
    }
    let epoch = crate::babysit_lease::process_epoch();
    let actions = plan_sweep(&entries, epoch, &EpochLiveness { app_data }, &PsIdentity);
    let mut keep: Vec<PreviewEntry> = Vec::new();
    for (entry, action) in entries.iter().zip(actions.iter()) {
        match action {
            SweepAction::Keep { why, .. } => {
                tracing::info!(id = %entry.id, why, "preview sweep: keeping an entry");
                keep.push(entry.clone());
            }
            SweepAction::Kill { pgid, .. } => {
                tracing::info!(id = %entry.id, pid = entry.pid, pgid, "preview sweep: reclaiming an orphan");
                kill_pgid(*pgid);
            }
            SweepAction::Discard { why, .. } => {
                // NOT killed. See the module header: a pgid is recycled once its leader exits.
                tracing::info!(id = %entry.id, pid = entry.pid, why, "preview sweep: discarding an unverifiable entry WITHOUT signalling");
            }
        }
    }
    if keep.len() != entries.len() {
        let _guard = registry_lock().lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = save_registry(app_data, &keep) {
            tracing::warn!("preview: could not rewrite the server registry after the sweep: {e}");
        }
    }
}

/// SIGKILL a whole process group by pgid. Only ever reached after [`plan_sweep`] verified the full
/// identity triple.
fn kill_pgid(pgid: u32) {
    #[cfg(unix)]
    {
        if pgid > 1 {
            // SAFETY: a negative pid signals the process GROUP. `plan_sweep` guarantees pgid > 1, so
            // this can never degenerate into `kill(0, …)` — which would signal Sparkle's own group.
            unsafe {
                libc::kill(-(pgid as i32), libc::SIGKILL);
            }
        }
    }
    #[cfg(not(unix))]
    let _ = pgid;
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// §6  THE SUPERVISOR
// ══════════════════════════════════════════════════════════════════════════════════════════════

/// The lifecycle a pane renders. `serving` is set by the frontend once its frame is actually showing
/// the page; Rust drives everything up to `ready` and the two terminal failure states.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreviewState {
    Starting,
    Listening,
    Ready,
    Serving,
    Failed,
    Crashed,
    Stopped,
}

/// One preview, as it crosses into the frontend.
///
/// **Every `Option` here serializes as an explicit `null`, and that is required.** serde's derive
/// emits the key with a null value for `None`; it omits the key only under
/// `skip_serializing_if`. The frontend is typed `field?: T | null` against exactly that, so adding
/// `skip_serializing_if` here would make the payload describe a shape the wire cannot produce — and
/// an all-or-nothing parser that rejects one field discards the WHOLE payload and falls back to its
/// "we did not look" default, silently, forever (bead `sparkle-16y6h`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStatus {
    pub id: String,
    pub agent_id: String,
    pub project_id: String,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub state: PreviewState,
    pub error: Option<String>,
}

/// What `preview_open` answers with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOpened {
    pub id: String,
    pub url: String,
    pub port: u16,
    pub state: PreviewState,
}

/// What `preview_capability` answers with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCapability {
    pub previewable: bool,
    pub target: Option<PreviewTarget>,
    pub decline_reason: Option<String>,
}

/// What every stop path answers with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewStopOutcome {
    /// `"stopped"` | `"already-stopped"` | `"not-found"`.
    pub outcome: &'static str,
}

/// A live supervised server.
struct Server {
    status: PreviewStatus,
    /// Shared with the supervisor thread so a stop can kill while the thread is mid-poll.
    child: Arc<Mutex<Option<Child>>>,
    pgid: u32,
    stop: Arc<AtomicBool>,
}

/// Which states are worth re-attaching a second `preview_open` to.
///
/// EXHAUSTIVE ON PURPOSE — no `_` arm. Rust cannot enumerate a plain enum's variants, so an
/// exhaustive `match` is the only thing that ties this predicate to `PreviewState`: adding a
/// variant is then a compile error here rather than a silent fall-through to "spawn a second dev
/// server", which is exactly the bug the re-attach path exists to prevent.
///
/// A `failed`/`crashed`/`stopped` server is NOT re-attached — answering a second click with the
/// corpse makes the button permanently dead instead of retrying. Those arms are belt-and-braces
/// today, because every terminal transition also REMOVES the entry (`finish`, `stop_one`), so a
/// dead server is not in the map to be found; they exist so the intent survives that changing.
fn live_for_reattach(state: PreviewState) -> bool {
    match state {
        PreviewState::Starting
        | PreviewState::Listening
        | PreviewState::Ready
        | PreviewState::Serving => true,
        PreviewState::Failed | PreviewState::Crashed | PreviewState::Stopped => false,
    }
}

/// Managed state: every preview this launch owns.
#[derive(Default)]
pub struct PreviewManager {
    servers: Mutex<HashMap<String, Server>>,
    app_data: Mutex<Option<PathBuf>>,
    /// Agents whose first `preview_open` is IN FLIGHT — reserved between the re-attach decision and
    /// the moment the spawned server lands in `servers`. See [`PreviewManager::reserve_or_reattach`].
    starting: Mutex<HashSet<String>>,
}

impl PreviewManager {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Server>> {
        self.servers.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set_app_data(&self, dir: PathBuf) {
        *self.app_data.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir);
    }

    fn app_data(&self) -> Option<PathBuf> {
        self.app_data.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Every live preview's status, for `preview_list`.
    pub fn statuses(&self) -> Vec<PreviewStatus> {
        let mut out: Vec<PreviewStatus> = self.lock().values().map(|s| s.status.clone()).collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn status_for_agent(&self, agent_id: &str) -> Option<PreviewStatus> {
        self.lock().values().find(|s| s.status.agent_id == agent_id).map(|s| s.status.clone())
    }

    /// The one place that decides whether a `preview_open` SPAWNS. `Ok(Some(_))` = re-attach to what
    /// this agent already has; `Ok(None)` = the caller holds the reservation and must spawn, then
    /// call [`PreviewManager::release_starting`]; `Err` = another start is already in flight.
    ///
    /// A RESERVATION, not a check, and that is the whole point. `open_blocking` does seconds of work
    /// before the new server lands in `servers` — target detection, a login-shell PATH lookup, the
    /// spawn itself — so a plain "is one in the map?" test leaves that entire window open: two
    /// clicks on the pane action run on two `spawn_blocking` threads, both find an empty map, and
    /// each starts a dev server. That costs 400 MB to 1 GB of resident Node per extra copy, and the
    /// older one is orphaned from every stop path, because the frontend store keys by agent (the
    /// newer entry overwrites it) and `preview_stop`/`preview_stop_for_agent` key by id or by agent.
    ///
    /// `servers` is consulted BEFORE the reservation deliberately: in the brief window after a
    /// spawn lands and before its reservation is released, re-attaching is the better answer than
    /// refusing. Lock order is `starting` then `servers`, and this is the only place that takes both.
    fn reserve_or_reattach(&self, agent_id: &str) -> Result<Option<PreviewOpened>, String> {
        let mut starting = self.starting.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) =
            self.lock().values().find(|s| s.status.agent_id == agent_id && live_for_reattach(s.status.state))
        {
            return Ok(Some(PreviewOpened {
                id: existing.status.id.clone(),
                url: existing
                    .status
                    .url
                    .clone()
                    .unwrap_or_else(|| existing.status.port.map(preview_url_for).unwrap_or_default()),
                port: existing.status.port.unwrap_or(0),
                state: existing.status.state,
            }));
        }
        if !starting.insert(agent_id.to_string()) {
            return Err("preview: a server for this agent is already starting".into());
        }
        Ok(None)
    }

    /// Drop the reservation taken by [`PreviewManager::reserve_or_reattach`]. Called on BOTH the
    /// success and the failure path — a start that errored must leave the button retryable.
    fn release_starting(&self, agent_id: &str) {
        self.starting.lock().unwrap_or_else(|e| e.into_inner()).remove(agent_id);
    }

    /// Move a preview to a new state and TELL THE FRONTEND. Every transition goes through here, so
    /// there is exactly one place a state can change without an event being emitted — and it does
    /// emit, which is what lets the pane never poll.
    fn transition(
        &self,
        app: &AppHandle,
        id: &str,
        state: PreviewState,
        port: Option<u16>,
        error: Option<String>,
    ) {
        let status = {
            let mut servers = self.lock();
            let Some(server) = servers.get_mut(id) else { return };
            server.status.state = state;
            if let Some(p) = port {
                server.status.port = Some(p);
                server.status.url = Some(preview_url_for(p));
            }
            if error.is_some() {
                server.status.error = error;
            }
            server.status.clone()
        };
        let _ = app.emit("preview:state", status);
    }

    /// Stop one preview. Idempotent by construction: a second call finds nothing to take.
    fn stop_one(&self, app: Option<&AppHandle>, id: &str) -> &'static str {
        let (child, pgid, present) = {
            let mut servers = self.lock();
            match servers.get_mut(id) {
                Some(server) => {
                    server.stop.store(true, Ordering::Release);
                    (Arc::clone(&server.child), server.pgid, true)
                }
                None => (Arc::new(Mutex::new(None)), 0, false),
            }
        };
        if !present {
            return "not-found";
        }
        let mut slot = child.lock().unwrap_or_else(|e| e.into_inner());
        let outcome = match slot.as_mut() {
            Some(c) => {
                // `exited_without_reaping` BEFORE the group kill: `try_wait` would REAP, releasing
                // the pid and — once the group is empty — the pgid with it, so a later
                // `kill(-pid, …)` could land on an unrelated group. This is a brand-new kill call
                // site, so it honours the same invariant every other one does.
                match crate::worktree::exited_without_reaping(c) {
                    Ok(true) => {
                        let _ = c.wait();
                        "already-stopped"
                    }
                    _ => {
                        crate::proc::kill_process_group(c);
                        "stopped"
                    }
                }
            }
            None => "already-stopped",
        };
        *slot = None;
        drop(slot);
        let _ = pgid;
        if let Some(app) = app {
            self.transition(app, id, PreviewState::Stopped, None, None);
        }
        if let Some(dir) = self.app_data() {
            registry_remove(&dir, id);
        }
        self.lock().remove(id);
        outcome
    }

    /// App teardown. Wired from `RunEvent::Exit` — NOT from `Drop` — because on macOS the ordinary
    /// Cmd+Q path never drops managed state (tao's loop ends in `process::exit()`), which is exactly
    /// the path a user quits by. `Drop` stays as an idempotent backstop for the paths that DO drop.
    pub fn stop_all(&self) {
        let ids: Vec<String> = self.lock().keys().cloned().collect();
        for id in ids {
            let outcome = self.stop_one(None, &id);
            tracing::info!(%id, outcome, "preview: stopped at app teardown");
        }
    }
}

/// Best-effort backstop; see [`PreviewManager::stop_all`] for why the live path is `RunEvent::Exit`.
impl Drop for PreviewManager {
    fn drop(&mut self) {
        self.stop_all();
    }
}

/// How long a dev server gets to open a listening socket before the preview is called failed. A cold
/// Next compile is 10–30s; this is generous enough to cover a slow one and short enough that a
/// genuinely broken start does not leave a spinner up forever.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
const DISCOVERY_INTERVAL: Duration = Duration::from_millis(500);
/// After it is up, how often to notice the process died.
const LIVENESS_INTERVAL: Duration = Duration::from_secs(2);
/// How much of stderr to put in a failure message.
const STDERR_TAIL: usize = 1200;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn new_id() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// One HTTP GET against the discovered port. ANY response counts as alive — a dev server serving its
/// own error overlay is exactly the case the pane should show rather than hide behind a spinner.
///
/// Hand-rolled over `TcpStream` rather than pulled through an HTTP client: the whole question is
/// "did a byte come back", and a client would add redirect/TLS/proxy behaviour that can only get in
/// the way of that.
fn http_probe(port: u16) -> bool {
    let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let request = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 16];
    matches!(stream.read(&mut buf), Ok(n) if n > 0)
}

/// Canonicalize a worktree path from the frontend and require it strictly inside the managed
/// worktrees directory.
///
/// Mirrors `sparkle_improve::validate_run_inner`. The path arrives across the IPC boundary, so it is
/// an untrusted string until this has run; without it, `current_dir` would run an arbitrary command
/// in an arbitrary directory.
pub fn validate_worktree(worktrees_base: &Path, worktree: &str) -> Result<PathBuf, String> {
    let base = worktrees_base
        .canonicalize()
        .map_err(|e| format!("preview: the managed worktrees directory is unavailable: {e}"))?;
    let real = std::fs::canonicalize(worktree)
        .map_err(|e| format!("preview: invalid worktree path: {e}"))?;
    if !real.is_dir() {
        return Err("preview: the worktree path is not a directory".into());
    }
    if !real.starts_with(&base) || real == base {
        return Err("preview: that path is outside the managed worktrees directory".into());
    }
    Ok(real)
}

/// Resolve the program to run. A bare name is looked up the same way every other user-scope binary
/// in this app is, because a Finder/Dock-launched Sparkle inherits a PATH with no nvm or corepack.
fn resolve_program(program: &str) -> Result<String, String> {
    if Path::new(program).is_absolute() {
        return Ok(program.to_string());
    }
    if let Some(pm) = [PackageManager::Pnpm, PackageManager::Npm, PackageManager::Yarn, PackageManager::Bun]
        .into_iter()
        .find(|pm| pm.program() == program)
    {
        return crate::deps_bootstrap::program_or_error(crate::deps_bootstrap::resolve_manager(pm), pm);
    }
    #[cfg(unix)]
    {
        if let Some(found) = crate::preflight::run_in_login_shell(&format!("command -v {program}")) {
            return Ok(found);
        }
    }
    Err(format!("preview: could not find `{program}` on this machine's PATH"))
}

/// RE-ATTACH, OR RESERVE AND SPAWN. Blocking — callers wrap it in `spawn_blocking`.
///
/// The decision and the reservation both happen inside
/// [`PreviewManager::reserve_or_reattach`]; everything after it is the spawn, in `open_reserved`.
/// Splitting them is what makes the reservation releasable on EVERY exit — `open_reserved` has a
/// dozen `?` early returns, and a reservation leaked by any one of them would wedge that agent's
/// preview button for the rest of the session.
fn open_blocking(
    app: AppHandle,
    agent_id: String,
    project_id: String,
    worktree: String,
    path_override: Option<String>,
) -> Result<PreviewOpened, String> {
    if let Some(existing) = app.state::<PreviewManager>().reserve_or_reattach(&agent_id)? {
        return Ok(existing);
    }
    let out = open_reserved(app.clone(), agent_id.clone(), project_id, worktree, path_override);
    app.state::<PreviewManager>().release_starting(&agent_id);
    out
}

/// Spawn the dev server and start supervising it. Call ONLY while holding this agent's reservation.
fn open_reserved(
    app: AppHandle,
    agent_id: String,
    project_id: String,
    worktree: String,
    path_override: Option<String>,
) -> Result<PreviewOpened, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    let real = validate_worktree(&app_data.join("worktrees"), &worktree)?;

    let cfg = crate::config::for_project(&real.to_string_lossy()).config.preview;
    // Read and LOGGED, acted on by nothing: the idle-grace timer is Phase 2 and explicitly out of
    // scope here. Logging it is what makes "the value is plumbed but inert" a visible fact rather
    // than something the next agent has to infer from the absence of a timer.
    tracing::info!(
        idle_grace_min = cfg.idle_grace_min,
        "preview: idle grace is configured but NOT enforced yet (Phase 2)"
    );
    let target = detect_preview_target(&real, cfg.enabled).map_err(|d| d.message())?;

    let cwd = match path_override.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => real.join(p),
        None if target.path.is_empty() => real.clone(),
        None => real.join(&target.path),
    };
    // The override arrives from the frontend too, so it gets the same containment check.
    let cwd = validate_worktree(&app_data.join("worktrees"), &cwd.to_string_lossy())?;

    let port = match target.port {
        Some(p) if !is_reserved_port(p) => p,
        Some(p) => {
            return Err(format!(
                "preview: this project pins port {p}, which is Sparkle's own dev port and would \
                 frame Sparkle inside Sparkle"
            ))
        }
        None => allocate_port()?,
    };
    let program = resolve_program(&target.program)?;
    let args = build_argv(&target, port);

    let mut cmd = Command::new(&program);
    cmd.current_dir(&cwd)
        .args(&args)
        // Vite and CRA otherwise launch the user's REAL Chrome on start, which steals the screen —
        // the exact thing §10's whole auto-open design refuses to do.
        .env("BROWSER", "none")
        .env("FORCE_COLOR", "0")
        .stdin(Stdio::null())
        // PIPED **AND DRAINED** (below). Piping without draining deadlocks a chatty Next server at
        // the first full 64 KiB pipe, and it presents as "the preview just spins" — the likeliest
        // Phase 1 hang there is.
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Deliberately NOT `CI=1`. That is right for an install (it suppresses prompts) and wrong here:
    // it changes Next's and Vite's dev behaviour.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // MANDATORY. `proc::kill_process_group` sends `kill(-pid, SIGKILL)`, so a child spawned
        // without its own group would have that signal land on SPARKLE'S OWN GROUP.
        cmd.process_group(0);
        if let Some(path) = crate::deps_bootstrap::install_path_env(
            crate::preflight::resolve_node_path_cached().as_deref(),
            std::env::var("PATH").ok().as_deref(),
        ) {
            cmd.env("PATH", path);
        }
    }

    let mut child = cmd.spawn().map_err(|e| format!("preview: failed to start {program}: {e}"))?;
    let pid = child.id();
    let (_out_drain, _out_thread) = crate::worktree::spawn_drain(child.stdout.take());
    let (err_drain, _err_thread) = crate::worktree::spawn_drain(child.stderr.take());

    let identity = PsIdentity.identity(pid);
    let pgid = identity.as_ref().map(|i| i.pgid).unwrap_or(pid);
    let id = new_id();
    let cmdline = format!("{program} {}", args.join(" "));

    // WRITTEN IMMEDIATELY, before readiness: a hard kill in the settling window must still leave the
    // next launch's sweep something to reason about.
    registry_upsert(
        &app_data,
        PreviewEntry {
            id: id.clone(),
            agent_id: agent_id.clone(),
            project_id: project_id.clone(),
            worktree: real.to_string_lossy().to_string(),
            requested_port: Some(port),
            bound_port: None,
            pid,
            pgid,
            pid_start_time: identity.map(|i| i.lstart).unwrap_or_default(),
            owner_pid: std::process::id(),
            owner_epoch: crate::babysit_lease::process_epoch().to_string(),
            started_at: now_ms(),
            cmd: cmdline,
        },
    );

    let status = PreviewStatus {
        id: id.clone(),
        agent_id,
        project_id,
        // The URL is knowable before the server is ready precisely because the port was FORCED;
        // discovery may still replace it if the framework ignored us.
        url: Some(preview_url_for(port)),
        port: Some(port),
        state: PreviewState::Starting,
        error: None,
    };
    let child = Arc::new(Mutex::new(Some(child)));
    let stop = Arc::new(AtomicBool::new(false));
    {
        let manager = app.state::<PreviewManager>();
        manager.set_app_data(app_data.clone());
        manager.lock().insert(
            id.clone(),
            Server {
                status: status.clone(),
                child: Arc::clone(&child),
                pgid,
                stop: Arc::clone(&stop),
            },
        );
    }
    let _ = app.emit("preview:state", status);

    let supervisor_app = app.clone();
    let supervisor_id = id.clone();
    std::thread::spawn(move || {
        supervise(supervisor_app, supervisor_id, child, stop, err_drain, pid, port, app_data);
    });

    Ok(PreviewOpened { id, url: preview_url_for(port), port, state: PreviewState::Starting })
}

/// Watch one server: discover its port, probe it, then keep noticing whether it died.
#[allow(clippy::too_many_arguments)]
fn supervise(
    app: AppHandle,
    id: String,
    child: Arc<Mutex<Option<Child>>>,
    stop: Arc<AtomicBool>,
    stderr: crate::worktree::Drain,
    pid: u32,
    requested: u16,
    app_data: PathBuf,
) {
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut bound: Option<u16> = None;

    loop {
        if stop.load(Ordering::Acquire) {
            return;
        }
        // Did it exit? Checked WITHOUT reaping, for the same pgid-reservation reason `stop_one`
        // does: something else may still need `-pid` to name this group.
        let exited = {
            let mut slot = child.lock().unwrap_or_else(|e| e.into_inner());
            match slot.as_mut() {
                Some(c) => crate::worktree::exited_without_reaping(c).unwrap_or(true),
                // Taken by a stop.
                None => return,
            }
        };
        if exited {
            let tail = stderr_tail(&stderr);
            let (state, msg) = if bound.is_some() {
                (PreviewState::Crashed, format!("the dev server exited. {tail}"))
            } else {
                // The case §2 calls out: a config syntax error or a missing dependency kills the
                // server BEFORE it listens. Show the stderr tail rather than a blank frame.
                (PreviewState::Failed, format!("the dev server exited before it started listening. {tail}"))
            };
            finish(&app, &id, state, None, Some(msg), &app_data);
            return;
        }

        if bound.is_none() {
            match discover_port(&PsProcessTable, &LsofListenTable, pid, Some(requested)) {
                Ok(Some(port)) => {
                    bound = Some(port);
                    app.state::<PreviewManager>().transition(&app, &id, PreviewState::Listening, Some(port), None);
                    if http_probe(port) {
                        app.state::<PreviewManager>().transition(&app, &id, PreviewState::Ready, Some(port), None);
                    }
                    mark_bound(&app_data, &id, port);
                }
                Ok(None) => {
                    if Instant::now() >= deadline {
                        kill_now(&child);
                        finish(
                            &app,
                            &id,
                            PreviewState::Failed,
                            None,
                            Some(format!(
                                "no listening socket appeared within {}s. {}",
                                READY_TIMEOUT.as_secs(),
                                stderr_tail(&stderr)
                            )),
                            &app_data,
                        );
                        return;
                    }
                }
                Err(refusal) => {
                    // REFUSED, not depreferred: stop the server rather than leave a LAN-visible dev
                    // server running that we merely declined to frame.
                    kill_now(&child);
                    finish(&app, &id, PreviewState::Failed, None, Some(refusal), &app_data);
                    return;
                }
            }
        }

        std::thread::sleep(if bound.is_some() { LIVENESS_INTERVAL } else { DISCOVERY_INTERVAL });
    }
}

fn stderr_tail(drain: &crate::worktree::Drain) -> String {
    let bytes = drain.snapshot();
    let text = String::from_utf8_lossy(&bytes);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "It printed nothing to stderr.".into();
    }
    let tail: String = trimmed.chars().rev().take(STDERR_TAIL).collect::<Vec<_>>().into_iter().rev().collect();
    format!("Last output: {tail}")
}

fn kill_now(child: &Arc<Mutex<Option<Child>>>) {
    let mut slot = child.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(c) = slot.as_mut() {
        if !matches!(crate::worktree::exited_without_reaping(c), Ok(true)) {
            crate::proc::kill_process_group(c);
        } else {
            let _ = c.wait();
        }
    }
    *slot = None;
}

/// A terminal transition: emit it, and drop the registry entry so no sweep ever considers a process
/// that is already gone.
fn finish(
    app: &AppHandle,
    id: &str,
    state: PreviewState,
    port: Option<u16>,
    error: Option<String>,
    app_data: &Path,
) {
    app.state::<PreviewManager>().transition(app, id, state, port, error);
    registry_remove(app_data, id);
    app.state::<PreviewManager>().lock().remove(id);
}

fn mark_bound(app_data: &Path, id: &str, port: u16) {
    let _guard = registry_lock().lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_registry(app_data);
    if let Some(e) = entries.iter_mut().find(|e| e.id == id) {
        e.bound_port = Some(port);
        if let Err(err) = save_registry(app_data, &entries) {
            tracing::warn!("preview: could not record the bound port: {err}");
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// TAURI COMMANDS
//
// Every one is `async fn` + `spawn_blocking`. A plain `fn` compiles to `body_blocking` and runs
// INLINE on the AppKit main thread (`cmd_timing.rs`), and every one of these touches the filesystem
// or spawns a subprocess.
// ══════════════════════════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn preview_capability(app: AppHandle, worktree: String) -> Result<PreviewCapability, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let app_data = crate::dev_identity::app_data_dir(&app)?;
        let real = validate_worktree(&app_data.join("worktrees"), &worktree)?;
        let enabled = crate::config::for_project(&real.to_string_lossy()).config.preview.enabled;
        Ok(match detect_preview_target(&real, enabled) {
            Ok(target) => PreviewCapability { previewable: true, target: Some(target), decline_reason: None },
            Err(decline) => {
                tracing::info!(code = decline.code(), "preview: declined");
                PreviewCapability {
                    previewable: false,
                    target: None,
                    decline_reason: Some(decline.message()),
                }
            }
        })
    })
    .await
    .map_err(|e| format!("preview_capability task failed: {e}"))?
}

#[tauri::command]
pub async fn preview_open(
    app: AppHandle,
    agent_id: String,
    project_id: String,
    worktree: String,
    path: Option<String>,
) -> Result<PreviewOpened, String> {
    tauri::async_runtime::spawn_blocking(move || open_blocking(app, agent_id, project_id, worktree, path))
        .await
        .map_err(|e| format!("preview_open task failed: {e}"))?
}

#[tauri::command]
pub async fn preview_stop(app: AppHandle, id: String) -> Result<PreviewStopOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let outcome = app.state::<PreviewManager>().stop_one(Some(&app), &id);
        Ok(PreviewStopOutcome { outcome })
    })
    .await
    .map_err(|e| format!("preview_stop task failed: {e}"))?
}

#[tauri::command]
pub async fn preview_stop_for_agent(app: AppHandle, agent_id: String) -> Result<PreviewStopOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = app
            .state::<PreviewManager>()
            .lock()
            .values()
            .find(|s| s.status.agent_id == agent_id)
            .map(|s| s.status.id.clone());
        let outcome = match id {
            Some(id) => app.state::<PreviewManager>().stop_one(Some(&app), &id),
            None => "not-found",
        };
        Ok(PreviewStopOutcome { outcome })
    })
    .await
    .map_err(|e| format!("preview_stop_for_agent task failed: {e}"))?
}

#[tauri::command]
pub async fn preview_status(app: AppHandle, agent_id: String) -> Result<Option<PreviewStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(app.state::<PreviewManager>().status_for_agent(&agent_id)))
        .await
        .map_err(|e| format!("preview_status task failed: {e}"))?
}

#[tauri::command]
pub async fn preview_list(app: AppHandle) -> Result<Vec<PreviewStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(app.state::<PreviewManager>().statuses()))
        .await
        .map_err(|e| format!("preview_list task failed: {e}"))?
}

/// Startup wiring: remember where app data is (the supervisor threads need it) and reclaim orphans.
pub fn init(app: &AppHandle) {
    let Ok(app_data) = crate::dev_identity::app_data_dir(app) else {
        tracing::warn!("preview: no app data dir; skipping the orphan sweep");
        return;
    };
    // Register THIS launch's liveness lock before anything reads it. Without this every entry we
    // write reads as orphaned to our own next-launch sweep — and worse, a sibling instance's sweep
    // would classify our LIVE previews as reclaimable and kill them.
    crate::babysit_lease::hold_instance_lock(&app_data, crate::babysit_lease::process_epoch());
    app.state::<PreviewManager>().set_app_data(app_data.clone());
    std::thread::spawn(move || sweep_orphans(&app_data));
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// TESTS
// ══════════════════════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memwatch::{FixedProcessTable, ProcRow};

    fn listener(pid: u32, addr: &str) -> Listener {
        Listener { pid, addr: addr.to_string() }
    }

    // ---------------------------------------------------------------- §1 loopback gates

    /// `[::1]:5173` must survive the split. A FORWARD split on ':' turns the host into a bare `[`
    /// and makes the documented IPv6 loopback case unreachable — the trap `builder_index` records
    /// at roborev 47899, reached here by a different route.
    #[test]
    fn an_ipv6_loopback_listen_address_parses_and_is_accepted() {
        let (host, port) = parse_listen_addr("[::1]:5173").expect("bracketed IPv6 must parse");
        assert_eq!(host, "::1", "the brackets are peeled, leaving the bare host");
        assert_eq!(port, 5173);
        assert!(is_loopback_listen_host(&host));
        // The forward-split answer, pinned so a regression to it is visibly wrong.
        assert_ne!(host, "[", "a forward split would produce this and silently reject every IPv6 bind");
    }

    #[test]
    fn ordinary_and_wildcard_listen_addresses_parse() {
        assert_eq!(parse_listen_addr("127.0.0.1:5200"), Some(("127.0.0.1".into(), 5200)));
        assert_eq!(parse_listen_addr("*:5201"), Some(("*".into(), 5201)));
        assert!(!is_loopback_listen_host("*"), "a wildcard bind is NOT loopback");
        assert!(!is_loopback_listen_host("192.168.1.10"));
        assert!(!is_loopback_listen_host("0.0.0.0"));
        // Malformed rows are skipped, never guessed at.
        assert_eq!(parse_listen_addr("127.0.0.1"), None);
        assert_eq!(parse_listen_addr("127.0.0.1:0"), None);
        assert_eq!(parse_listen_addr(":5200"), None);
    }

    /// THE ANTI-REUSE TEST. `is_safe_override` is right for its own job and catastrophically wrong
    /// for this one, so the two are asserted TOGETHER on the same input: a future "just reuse the
    /// existing URL check" refactor makes this go red instead of silently letting a preview pane
    /// load a remote site with none of the iframe's containment.
    #[test]
    fn the_builder_index_url_gate_would_accept_a_remote_origin_that_the_preview_gate_refuses() {
        let remote = "https://evil.example";
        assert!(
            crate::builder_index::is_safe_override(remote),
            "is_safe_override accepts ANY non-empty https:// origin — that is its job"
        );
        assert!(
            !preview_url_is_loopback(remote),
            "…and it is exactly why it must never become the preview gate"
        );
        // The same disagreement in the other direction is not required, but the preview gate must
        // still accept what it exists for.
        assert!(preview_url_is_loopback("http://127.0.0.1:5173"));
        assert!(preview_url_is_loopback("http://localhost:3000/"));
        assert!(preview_url_is_loopback("http://[::1]:5173/some/path"));
    }

    #[test]
    fn the_preview_url_gate_refuses_everything_that_is_not_a_loopback_http_url() {
        for bad in [
            "https://127.0.0.1:5173",   // right host, wrong scheme
            "http://192.168.1.10:5173", // LAN
            "http://evil.example",
            "http://127.0.0.1@evil.example", // userinfo smuggling the loopback name
            "file:///etc/passwd",
            "tauri://localhost",
            "",
        ] {
            assert!(!preview_url_is_loopback(bad), "{bad} must be refused");
        }
    }

    #[test]
    fn the_preview_url_is_the_ipv4_loopback_literal() {
        // `localhost` can resolve to ::1 first, and a server bound only to the IPv4 loopback then
        // refuses the frame.
        assert_eq!(preview_url_for(5173), "http://127.0.0.1:5173");
        assert!(preview_url_is_loopback(&preview_url_for(5173)));
    }

    // ---------------------------------------------------------------- §2 discovery

    /// Verbatim capture from this machine — the format the parser is written against.
    const REAL_LSOF: &str = "p20226\nf3\nn127.0.0.1:5200\np20228\nf3\nn*:5201\n";

    #[test]
    fn lsof_field_output_parses_into_one_listener_per_n_line() {
        assert_eq!(
            parse_lsof_fields(REAL_LSOF),
            vec![listener(20226, "127.0.0.1:5200"), listener(20228, "*:5201")]
        );
        // An `n` line with no preceding `p` is dropped rather than attributed to nobody.
        assert!(parse_lsof_fields("n127.0.0.1:5200\n").is_empty());
        // Unknown field letters are ignored, so adding a field to the request cannot corrupt this.
        assert_eq!(parse_lsof_fields("p1\nc node\nf3\nn127.0.0.1:80\n"), vec![listener(1, "127.0.0.1:80")]);
    }

    /// THE ONE THAT DECIDES WHETHER DISCOVERY EVER SUCCEEDS. Measured: `lsof` exits 1 when any
    /// requested pid is invalid while still reporting the surviving ones correctly, and a settling
    /// process tree ALWAYS contains pids that have since exited. Keying readiness on the exit status
    /// therefore yields a probe that can never succeed.
    ///
    /// Driven through `listeners_from_lsof`, which is the function the real call site uses and which
    /// TAKES the status — so adding `if !status_ok { return vec![] }` to it turns this red. A test
    /// that only called `parse_lsof_fields` would stay green through that change, because the parser
    /// never sees a status at all.
    #[test]
    fn a_non_zero_lsof_status_with_valid_stdout_still_yields_the_listener() {
        let listeners = listeners_from_lsof(false, REAL_LSOF);
        assert_eq!(
            listeners,
            vec![listener(20226, "127.0.0.1:5200"), listener(20228, "*:5201")],
            "exit=1 must not discard a listing lsof reported correctly"
        );
        assert_eq!(choose_listener(&listeners, Some(5200)), Ok(Some(5200)));
    }

    /// The same property against the REAL binary, so a status gate added anywhere in the call path —
    /// not only in `listeners_from_lsof` — is caught.
    ///
    /// The test process binds a loopback socket and then asks `LsofListenTable` about ITSELF plus a
    /// pid that does not exist; measured, that combination exits 1 while still reporting our socket.
    /// Only the positive is asserted: if the dead pid happened to be alive the run would exit 0 and
    /// the test would merely be weaker, never wrong.
    #[test]
    #[cfg(unix)]
    fn the_real_lsof_still_reports_our_socket_when_another_requested_pid_is_dead() {
        if !Path::new(LSOF).exists() {
            // Linux CI has no /usr/sbin/lsof; the pure test above still pins the contract there.
            return;
        }
        let socket = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap();
        let port = socket.local_addr().unwrap().port();
        // macOS pids top out below 100000, so this is syntactically valid and almost certainly dead.
        let pids = BTreeSet::from([std::process::id(), 99997]);
        let found = LsofListenTable
            .listeners(&pids)
            .expect("lsof is present, so the probe must produce a listing rather than 'could not look'");
        assert_eq!(
            choose_listener(&found, Some(port)),
            Ok(Some(port)),
            "our own listening socket must survive the invalid pid; got {found:?}"
        );
        drop(socket);
    }

    /// THE MOST LIKELY WAY THIS SILENTLY DOES NOT WORK. `pnpm` → `node` → `next` → `next-server` is
    /// four levels; the listening socket belongs to the great-grandchild. A discovery that only
    /// inspected the direct child would find nothing and time out on every Next preview.
    #[test]
    fn a_grandchilds_listening_port_is_found_not_the_direct_childs() {
        let rows = vec![
            ProcRow { pid: 100, ppid: 1, rss_bytes: 0 },   // pnpm — the child we spawned
            ProcRow { pid: 101, ppid: 100, rss_bytes: 0 }, // node
            ProcRow { pid: 102, ppid: 101, rss_bytes: 0 }, // next
            ProcRow { pid: 103, ppid: 102, rss_bytes: 0 }, // next-server — holds the socket
        ];
        let procs = FixedProcessTable(Some(rows));
        // ONLY the great-grandchild listens. If the walk stopped at the direct child, `lsof` would
        // be asked about pid 100 alone and this would be `Ok(None)` forever.
        let listen = FixedListenTable(Some(vec![listener(103, "127.0.0.1:5200")]));
        assert_eq!(discover_port(&procs, &listen, 100, Some(5200)), Ok(Some(5200)));

        // Pin the mechanism, not just the outcome: the pid set handed to lsof must contain the
        // great-grandchild. Without this, a walk that returned every pid on the machine would also
        // pass the assertion above.
        let tree = descendant_pids(&FixedProcessTable(Some(vec![
            ProcRow { pid: 100, ppid: 1, rss_bytes: 0 },
            ProcRow { pid: 101, ppid: 100, rss_bytes: 0 },
            ProcRow { pid: 102, ppid: 101, rss_bytes: 0 },
            ProcRow { pid: 103, ppid: 102, rss_bytes: 0 },
            ProcRow { pid: 900, ppid: 1, rss_bytes: 0 },
        ]))
        .rows()
        .unwrap(), 100);
        assert!(tree.contains(&103), "the socket-holder must be in the probed set");
        assert!(!tree.contains(&900), "…and an unrelated process must not be");
    }

    /// A v6-ONLY bind is loopback and UNREACHABLE at the same time, so it must be refused rather
    /// than accepted.
    ///
    /// Every consumer of the chosen port is IPv4 — `preview_url_for` emits `http://127.0.0.1:{p}`
    /// and `http_probe` connects to `Ipv4Addr::LOCALHOST` — so accepting `[::1]` produces a preview
    /// that sits at Listening forever while the frame shows ERR_CONNECTION_REFUSED. Nothing about
    /// that failure points at its cause. `[::1]` is also absent from `frame-src`, so emitting the
    /// v6 URL instead would not rescue it.
    ///
    /// Reachable in practice rather than in theory: `Framework::Unknown` is driven and injects no
    /// host flag, and Node >= 17 resolves a bare `localhost` listen to `::1` first on macOS.
    #[test]
    fn a_v6_only_bind_is_refused_because_the_frame_is_pointed_at_v4() {
        let err = choose_listener(&[listener(7, "[::1]:5173")], None)
            .expect_err("a v6-only listener must be refused, not accepted");
        assert!(
            err.contains("[::1]:5173"),
            "the refusal must NAME the address so the pane can say what it refused; got: {err}"
        );
        assert!(
            err.contains("IPv6"),
            "and say why it is unusable rather than reading as a generic failure; got: {err}"
        );
        // Even when it is the port we asked for — the requested-port fast path must not smuggle it
        // through ahead of the loopback classification.
        assert!(choose_listener(&[listener(7, "[::1]:5173")], Some(5173)).is_err());
    }

    /// AN UNRELATED v4 SOCKET IN THE SAME TREE MUST NOT RESCUE A v6-ONLY APP PORT.
    ///
    /// Node's inspector listens on `127.0.0.1:9229` inside the very process tree we walk, so a
    /// refusal conditioned on "is there any v4 loopback socket here" is skipped exactly when a dev
    /// server bound v6-only — and the chosen port then falls through to the FIRST v4 socket, which
    /// is the debugger. The preview frames :9229 and shows a JSON blob or nothing at all: a wrong
    /// page, silently, instead of an error. That is worse than the failure the refusal was added
    /// for, which is why the classification is keyed by PORT rather than by set-emptiness.
    #[test]
    fn an_unrelated_v4_socket_does_not_rescue_a_v6_only_app_port() {
        let ls = [listener(7, "[::1]:5173"), listener(7, "127.0.0.1:9229")];
        let err = choose_listener(&ls, Some(5173))
            .expect_err("the REQUESTED port is v6-only; the debugger's port is not a substitute");
        assert!(err.contains("[::1]:5173"), "must name the app's address; got: {err}");

        // THE OTHER HALF, and the load-bearing one: WITHOUT the requested port there is nothing
        // that says which socket is the app, and the debugger IS handed back. That is not a defect
        // to fix here — it is the constraint on the caller, and `supervise` satisfies it by always
        // passing the port it forced (`discover_port(.., Some(requested))`). Pinned so that
        // rewriting the call site to pass `None` shows up as this test going red with the port
        // number in the message, rather than as a preview quietly framing a JSON blob.
        //
        // (The previous assertion here — `!err.contains("9229")` — could not fail: it ran only
        // after `expect_err` had already established the value was the v6 refusal, whose only
        // interpolation is the app's own address.)
        assert_eq!(
            choose_listener(&ls, None),
            Ok(Some(9229)),
            "with no requested port the first v4 loopback socket wins, debugger included"
        );
    }

    /// The other direction, or the refusal above would break every ordinary dual-stack server.
    /// A framework that binds BOTH reports two rows; the v4 one is usable and must win.
    #[test]
    fn a_dual_stack_server_is_accepted_on_its_v4_address() {
        assert_eq!(
            choose_listener(
                &[listener(7, "[::1]:5173"), listener(7, "127.0.0.1:5173")],
                None
            ),
            Ok(Some(5173)),
        );
        // And with the port explicitly requested.
        assert_eq!(
            choose_listener(
                &[listener(7, "[::1]:5173"), listener(7, "127.0.0.1:5173")],
                Some(5173)
            ),
            Ok(Some(5173)),
        );
    }

    /// A wildcard bind exposes the app's source maps and dev endpoints to the LAN. It is REFUSED,
    /// and the refusal NAMES the address so the pane can say what it refused.
    #[test]
    fn a_wildcard_bind_is_refused_by_name() {
        let err = choose_listener(&[listener(7, "*:3000")], Some(3000))
            .expect_err("a non-loopback bind must be refused, not previewed");
        assert!(err.contains("*:3000"), "the refusal must name the offending address, got: {err}");
        // The same for an explicit all-interfaces bind, which is what `--host 0.0.0.0` produces.
        let err = choose_listener(&[listener(7, "0.0.0.0:3000")], None).expect_err("0.0.0.0 is not loopback");
        assert!(err.contains("0.0.0.0:3000"), "got: {err}");
    }

    #[test]
    fn the_requested_port_wins_and_nothing_listening_is_not_an_error() {
        // A framework may open a second socket (HMR); the forced port is the one to frame.
        let ls = vec![listener(1, "127.0.0.1:5300"), listener(1, "127.0.0.1:5200")];
        assert_eq!(choose_listener(&ls, Some(5200)), Ok(Some(5200)));
        // With no request, the lowest loopback port is a deterministic answer.
        assert_eq!(choose_listener(&ls, None), Ok(Some(5200)));
        // Still settling is NOT a failure.
        assert_eq!(choose_listener(&[], Some(5200)), Ok(None));
        // A loopback listener alongside a foreign one is fine: the foreign one is not what we frame.
        let mixed = vec![listener(1, "*:3000"), listener(1, "127.0.0.1:5200")];
        assert_eq!(choose_listener(&mixed, Some(5200)), Ok(Some(5200)));
    }

    /// "We could not look" must never read as "nothing is listening" — a broken probe would
    /// otherwise present as a server that never starts.
    #[test]
    fn an_unavailable_seam_reports_pending_not_a_refusal() {
        let procs = FixedProcessTable(None);
        assert_eq!(discover_port(&procs, &FixedListenTable(None), 100, None), Ok(None));
        let procs = FixedProcessTable(Some(vec![ProcRow { pid: 100, ppid: 1, rss_bytes: 0 }]));
        assert_eq!(discover_port(&procs, &FixedListenTable(None), 100, None), Ok(None));
    }

    // ---------------------------------------------------------------- §3 detection

    fn write(path: &Path, body: &str) {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).unwrap();
        }
        std::fs::write(path, body).unwrap();
    }

    fn tempdir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join("sparkle-preview-tests")
            .join(format!("{tag}-{:016x}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_single_root_dev_script_with_a_next_signature_is_previewable() {
        let dir = tempdir("next");
        write(&dir.join("package.json"), r#"{"scripts":{"dev":"next dev","build":"next build"}}"#);
        write(&dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        write(&dir.join("next.config.ts"), "export default {}\n");
        let t = detect_preview_target(&dir, true).expect("a plain `dev` + next.config is the common case");
        assert_eq!(t.framework, Framework::Next);
        assert_eq!(t.program, "pnpm");
        assert_eq!(t.args, vec!["run".to_string(), "dev".to_string()]);
        assert_eq!(t.source, "root-dev-script");
        assert!(!t.needs_arg_separator, "pnpm forwards trailing args verbatim (measured)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// npm needs the `--` and pnpm must NOT have it. Measured, not read: `npm run dev --port 5555`
    /// delivers only `5555` (the flag NAME is eaten) and `pnpm run dev -- --port 5555` passes the
    /// literal `--` through to the script. Getting this backwards is silent in both directions.
    #[test]
    fn the_argument_separator_follows_the_package_manager_that_was_measured() {
        let dir = tempdir("npm");
        write(&dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir.join("package-lock.json"), "{}");
        write(&dir.join("vite.config.ts"), "export default {}\n");
        let t = detect_preview_target(&dir, true).unwrap();
        assert_eq!(t.program, "npm");
        assert!(t.needs_arg_separator, "npm eats the flag NAMES without a `--`");
        let argv = build_argv(&t, 5200);
        let sep = argv.iter().position(|a| a == "--").expect("npm's argv must carry the separator");
        let port = argv.iter().position(|a| a == "--port").unwrap();
        assert!(sep < port, "the separator must come BEFORE the flags it protects");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A recognised-but-undriven framework declines BY NAME. `deps_bootstrap::is_supported` records
    /// why this matters: writing a tool's flags out of documentation instead of out of a run is how
    /// you ship an arm that fails before it does anything.
    #[test]
    fn astro_nuxt_and_remix_are_recognised_and_declined_by_name() {
        for (file, label) in
            [("astro.config.mjs", "Astro"), ("nuxt.config.ts", "Nuxt"), ("remix.config.js", "Remix")]
        {
            let dir = tempdir("undriven");
            write(&dir.join("package.json"), r#"{"scripts":{"dev":"astro dev"}}"#);
            write(&dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
            write(&dir.join(file), "export default {}\n");
            let d = detect_preview_target(&dir, true).expect_err("not driven in Phase 1");
            assert_eq!(d.code(), "unsupported-framework");
            assert!(d.message().contains(label), "the decline must name {label}: {}", d.message());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn a_project_config_override_wins_over_everything_and_needs_no_manifest() {
        let dir = tempdir("override");
        // No package.json and no lockfile at all: by writing the override the user has already
        // answered every question detection would ask.
        write(
            &dir.join(".sparkle").join("config.toml"),
            "[preview]\ncommand = \"bin/serve\"\nargs = [\"--dev\"]\npath = \"site\"\nport = 4321\n",
        );
        let t = detect_preview_target(&dir, true).expect("an explicit override is always previewable");
        assert_eq!(t.source, "config");
        assert_eq!(t.program, "bin/serve");
        assert_eq!(t.args, vec!["--dev".to_string()]);
        assert_eq!(t.path, "site");
        assert_eq!(t.port, Some(4321));
        // Nothing is injected into a hand-written command: we do not know its flags, so discovery
        // plus the loopback refusal do the work instead of a guess.
        assert_eq!(build_argv(&t, 5200), vec!["--dev".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_master_switch_declines_before_any_detection_runs() {
        let dir = tempdir("disabled");
        write(&dir.join("package.json"), r#"{"scripts":{"dev":"next dev"}}"#);
        write(&dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        write(&dir.join("next.config.ts"), "export default {}\n");
        assert!(detect_preview_target(&dir, true).is_ok(), "…it would otherwise be previewable");
        assert_eq!(detect_preview_target(&dir, false).unwrap_err().code(), "disabled");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_repo_with_no_package_json_declines_rather_than_scanning() {
        let dir = tempdir("rust");
        write(&dir.join("Cargo.toml"), "[package]\nname = \"x\"\n");
        assert_eq!(detect_preview_target(&dir, true).unwrap_err().code(), "not-a-js-project");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_workspace_with_exactly_one_dev_package_is_previewable_at_that_path() {
        let dir = tempdir("mono");
        write(&dir.join("package.json"), r#"{"private":true,"scripts":{"build":"turbo build"}}"#);
        write(&dir.join("pnpm-workspace.yaml"), "packages:\n  - \"apps/*\"\n");
        write(&dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        write(&dir.join("apps").join("site").join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir.join("apps").join("site").join("vite.config.ts"), "export default {}\n");
        write(&dir.join("packages").join("core").join("package.json"), r#"{"scripts":{"test":"vitest"}}"#);
        let t = detect_preview_target(&dir, true).expect("exactly one candidate is unambiguous");
        assert_eq!(t.source, "workspace-package");
        assert_eq!(t.path, "apps/site");
        assert_eq!(t.framework, Framework::Vite, "the framework is read from the PACKAGE, not the root");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// SPARKLE ITSELF MUST DECLINE. Four `dev:*` scripts at the root and no plain `dev` — guessing
    /// among them is worse than declining (§7 rule 4), and the decline has to NAME them or the user
    /// cannot act on it. Run against the REAL repo, because a fixture that merely resembles it would
    /// stop testing this the moment the real scripts changed.
    #[test]
    fn sparkles_own_repo_declines_and_names_all_four_dev_scripts() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
        assert!(repo.join("pnpm-workspace.yaml").is_file(), "sanity: this is the Sparkle repo root");
        let decline = detect_preview_target(&repo, true).expect_err("Sparkle must refuse to guess");
        assert_eq!(decline.code(), "ambiguous");
        let msg = decline.message();
        for script in ["dev:web", "dev:orchestration", "dev:desktop", "dev:mobile"] {
            assert!(msg.contains(script), "the decline must name {script}: {msg}");
        }
    }

    // ---------------------------------------------------------------- §4 ports + argv

    /// 1420 is Sparkle's own devUrl and Tauri REWRITES External URLs matching it, so a preview there
    /// frames Sparkle inside Sparkle.
    #[test]
    fn port_1420_is_never_handed_out() {
        assert!(is_reserved_port(1420));
        assert_eq!(first_unreserved(&[1420]), None, "a reserved port alone yields nothing");
        assert_eq!(first_unreserved(&[1420, 5300]), Some(5300), "…and the next candidate is taken");
        assert_eq!(first_unreserved(&[0, 5300]), Some(5300), "port 0 is not a port");
        // The live allocator must agree with the pure rule.
        let port = allocate_port().expect("the kernel must offer a loopback port");
        assert!(!is_reserved_port(port), "allocate_port handed out {port}");
        assert!(port > 1024, "an ephemeral port, not a privileged one");
    }

    /// FLAG-PRESENT IS NOT BEHAVIOR-CORRECT, so this asserts the HOST VALUE, not just `--port`.
    /// `--port N` alone leaves a framework free to default to `0.0.0.0` and publish the app's source
    /// maps to the LAN, which is the whole reason the host flag is unconditional.
    #[test]
    fn every_driven_frameworks_argv_carries_its_loopback_host_flag() {
        for (framework, host_flag) in [(Framework::Next, "--hostname"), (Framework::Vite, "--host")] {
            let target = PreviewTarget {
                framework,
                program: "pnpm".into(),
                args: vec!["run".into(), "dev".into()],
                needs_arg_separator: false,
                path: String::new(),
                source: "test",
                port: None,
            };
            let argv = build_argv(&target, 5200);
            let at = argv
                .iter()
                .position(|a| a == host_flag)
                .unwrap_or_else(|| panic!("{framework:?} must pass {host_flag}: {argv:?}"));
            assert_eq!(
                argv.get(at + 1).map(String::as_str),
                Some("127.0.0.1"),
                "{framework:?}: the flag must actually CARRY the loopback host, not merely appear"
            );
            let port_at = argv.iter().position(|a| a == "--port").expect("the port must be forced too");
            assert_eq!(argv.get(port_at + 1).map(String::as_str), Some("5200"));
        }
        // Vite additionally fails loudly rather than drifting to the next port.
        assert!(Framework::Vite.port_args(5200).iter().any(|a| a == "--strictPort"));
        // An undriven framework gets nothing injected — a guessed flag is worse than none.
        assert!(Framework::Astro.port_args(5200).is_empty());
        assert!(Framework::Unknown.port_args(5200).is_empty());
    }

    // ---------------------------------------------------------------- §5 registry + sweep

    struct Dead;
    impl OwnerLiveness for Dead {
        fn epoch_alive(&self, _epoch: &str) -> bool {
            false
        }
    }
    struct Alive;
    impl OwnerLiveness for Alive {
        fn epoch_alive(&self, _epoch: &str) -> bool {
            true
        }
    }
    struct FixedIdentity(Option<ProcIdentity>);
    impl IdentityOracle for FixedIdentity {
        fn identity(&self, _pid: u32) -> Option<ProcIdentity> {
            self.0.clone()
        }
    }

    fn entry(lstart: &str) -> PreviewEntry {
        PreviewEntry {
            id: "abc".into(),
            agent_id: "agent-1".into(),
            project_id: "proj-1".into(),
            worktree: "/tmp/wt".into(),
            requested_port: Some(5200),
            bound_port: Some(5200),
            pid: 4242,
            pgid: 4242,
            pid_start_time: lstart.into(),
            owner_pid: 900,
            owner_epoch: "a-previous-launch".into(),
            started_at: 1,
            cmd: "pnpm run dev".into(),
        }
    }

    #[test]
    fn ps_identity_parses_pid_pgid_and_a_start_time_containing_spaces() {
        // Verbatim shape from `/bin/ps -o pid=,pgid=,lstart= -p <pid>` on this machine, trailing
        // padding included. `lstart` MUST be last in the format string because of those spaces.
        let id = parse_ps_identity("12228 12228 Sat Aug  8 10:58:10 2026    \n").unwrap();
        assert_eq!(id.pid, 12228);
        assert_eq!(id.pgid, 12228);
        assert_eq!(id.lstart, "Sat Aug 8 10:58:10 2026", "whitespace runs and padding are normalised");
    }

    /// `ps` right-aligns the day of month, so ONE instant prints two ways. A byte compare would read
    /// that as a recycled pid, turn every reclaim into a discard, and leave orphans forever.
    #[test]
    fn a_start_time_written_two_ways_is_one_instant() {
        assert_eq!(normalize_lstart("Thu Aug  6 09:00:00 2026"), normalize_lstart("Thu Aug 6 09:00:00 2026"));
        let live = ProcIdentity { pid: 4242, pgid: 4242, lstart: "Thu Aug 6 09:00:00 2026".into() };
        let actions = plan_sweep(&[entry("Thu Aug  6 09:00:00 2026")], "now", &Dead, &FixedIdentity(Some(live)));
        assert_eq!(actions, vec![SweepAction::Kill { id: "abc".into(), pgid: 4242 }]);
    }

    /// THE BUG THIS REPO ALREADY SHIPPED ONCE (v0.44.0). Same pid, same pgid, DIFFERENT start time
    /// means the pid was recycled, and `kill(-pgid)` would SIGKILL an unrelated process group.
    #[test]
    fn a_recycled_pid_is_discarded_without_a_kill() {
        let recycled =
            ProcIdentity { pid: 4242, pgid: 4242, lstart: "Sat Aug 8 11:11:11 2026".into() };
        let actions = plan_sweep(
            &[entry("Thu Aug 6 09:00:00 2026")],
            "now",
            &Dead,
            &FixedIdentity(Some(recycled)),
        );
        assert_eq!(actions, vec![SweepAction::Discard { id: "abc".into(), why: "start-time-mismatch" }]);
        assert!(
            !matches!(actions[0], SweepAction::Kill { .. }),
            "a recycled pid must never be signalled"
        );
    }

    /// THE OTHER DIRECTION, and it is why the test above is not enough on its own: without this, a
    /// change that hardened the sweep into always-discard would leave orphaned dev servers running
    /// forever with nothing red.
    #[test]
    fn a_fully_matching_triple_is_killed() {
        let same = ProcIdentity { pid: 4242, pgid: 4242, lstart: "Thu Aug 6 09:00:00 2026".into() };
        let actions =
            plan_sweep(&[entry("Thu Aug 6 09:00:00 2026")], "now", &Dead, &FixedIdentity(Some(same)));
        assert_eq!(actions, vec![SweepAction::Kill { id: "abc".into(), pgid: 4242 }]);
    }

    #[test]
    fn a_gone_pid_is_discarded_and_a_live_owner_is_left_alone() {
        // The process is gone entirely: nothing to reclaim, and nothing to signal.
        assert_eq!(
            plan_sweep(&[entry("Thu Aug 6 09:00:00 2026")], "now", &Dead, &FixedIdentity(None)),
            vec![SweepAction::Discard { id: "abc".into(), why: "pid-gone" }]
        );
        // Another Sparkle is running and owns it. Its previews are not ours to kill — and the
        // identity oracle is not even consulted.
        let same = ProcIdentity { pid: 4242, pgid: 4242, lstart: "Thu Aug 6 09:00:00 2026".into() };
        assert_eq!(
            plan_sweep(&[entry("Thu Aug 6 09:00:00 2026")], "now", &Alive, &FixedIdentity(Some(same.clone()))),
            vec![SweepAction::Keep { id: "abc".into(), why: "another-live-instance" }]
        );
        // Our own launch's entry is kept without a liveness question at all.
        let mut mine = entry("Thu Aug 6 09:00:00 2026");
        mine.owner_epoch = "now".into();
        assert_eq!(
            plan_sweep(&[mine], "now", &Dead, &FixedIdentity(Some(same))),
            vec![SweepAction::Keep { id: "abc".into(), why: "own-epoch" }]
        );
    }

    /// `kill(-0, …)` signals SPARKLE'S OWN PROCESS GROUP. A corrupt or truncated registry entry must
    /// never reach the kill path, however well the rest of it matches.
    #[test]
    fn a_zero_pgid_is_discarded_rather_than_signalled() {
        let mut e = entry("Thu Aug 6 09:00:00 2026");
        e.pgid = 0;
        let live = ProcIdentity { pid: 4242, pgid: 0, lstart: "Thu Aug 6 09:00:00 2026".into() };
        assert_eq!(
            plan_sweep(&[e], "now", &Dead, &FixedIdentity(Some(live))),
            vec![SweepAction::Discard { id: "abc".into(), why: "unusable-pid-or-pgid" }]
        );
    }

    #[test]
    fn the_registry_round_trips_and_an_absent_or_corrupt_file_reads_as_empty() {
        let dir = tempdir("registry");
        assert!(load_registry(&dir).is_empty(), "no file yet");
        let e = entry("Thu Aug 6 09:00:00 2026");
        save_registry(&dir, std::slice::from_ref(&e)).unwrap();
        assert_eq!(load_registry(&dir), vec![e]);
        // A truncated file must not panic the sweep — it reads as "nothing to reclaim".
        std::fs::write(registry_path(&dir), "[{\"id\":").unwrap();
        assert!(load_registry(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A `None` on this struct must cross the wire as an explicit `null` KEY, never as an absent
    /// one. The frontend is typed `field?: T | null` against exactly that; a `skip_serializing_if`
    /// here would describe a shape the wire cannot produce, and an all-or-nothing parser that
    /// rejects one field discards the WHOLE payload — silently, forever (bead `sparkle-16y6h`).
    #[test]
    fn a_none_field_serializes_as_an_explicit_null_key() {
        let status = PreviewStatus {
            id: "abc".into(),
            agent_id: "agent-1".into(),
            project_id: "proj-1".into(),
            url: None,
            port: None,
            state: PreviewState::Starting,
            error: None,
        };
        let json: serde_json::Value = serde_json::to_value(&status).unwrap();
        for key in ["url", "port", "error"] {
            assert!(json.get(key).is_some(), "the `{key}` KEY must be present");
            assert!(json[key].is_null(), "…and its value must be null");
        }
        assert_eq!(json["state"], "starting", "the state is a lowercase string the frontend switches on");
        assert_eq!(json["agentId"], "agent-1", "camelCase on the wire");
    }

    // ---------------------------------------------------------------- re-attach / reservation

    fn seeded(agent: &str, id: &str, port: u16, state: PreviewState) -> Server {
        Server {
            status: PreviewStatus {
                id: id.into(),
                agent_id: agent.into(),
                project_id: "proj-1".into(),
                url: Some(preview_url_for(port)),
                port: Some(port),
                state,
                error: None,
            },
            child: Arc::new(Mutex::new(None)),
            pgid: 0,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Paired with the reservation test below, and the pair is the point: this one shows a live
    /// server IS handed back (so the assertion cannot pass by nothing ever happening), the next
    /// shows an in-flight start is REFUSED rather than duplicated.
    #[test]
    fn a_second_open_re_attaches_to_the_agents_live_server_instead_of_spawning() {
        let mgr = PreviewManager::default();
        mgr.lock().insert("srv-1".into(), seeded("agent-1", "srv-1", 5173, PreviewState::Ready));

        let out = mgr.reserve_or_reattach("agent-1").expect("a live server is not an error");
        let out = out.expect("the caller must be handed the RUNNING server, not a reservation");
        assert_eq!(out.id, "srv-1", "…and it is that server's id, so the stop paths can reach it");
        assert_eq!(out.port, 5173);
        assert_eq!(out.url, preview_url_for(5173));
        assert_eq!(out.state, PreviewState::Ready);
        assert!(
            !mgr.starting.lock().unwrap().contains("agent-1"),
            "a re-attach takes no reservation — nothing would ever release it"
        );
    }

    /// THE RACE THIS EXISTS TO CLOSE. `open_reserved` spends seconds in detection, a login-shell
    /// PATH lookup and the spawn before its server lands in `servers`, so a check that only reads
    /// the map leaves that whole window open and two clicks each start a dev server.
    #[test]
    fn a_start_already_in_flight_refuses_a_second_spawn_and_frees_up_after_it_finishes() {
        let mgr = PreviewManager::default();

        assert!(mgr.reserve_or_reattach("agent-1").unwrap().is_none(), "first caller spawns");
        // The map is still EMPTY here — this is precisely the window the old check could not see.
        assert!(mgr.lock().is_empty());
        let err = mgr.reserve_or_reattach("agent-1").expect_err("the second caller must not spawn too");
        assert!(err.contains("already starting"), "and it must say why: {err}");

        // A different agent is unaffected — the reservation is per agent, not a global lock.
        assert!(mgr.reserve_or_reattach("agent-2").unwrap().is_none());

        // Released on BOTH paths, so a start that failed leaves the button retryable.
        mgr.release_starting("agent-1");
        assert!(mgr.reserve_or_reattach("agent-1").unwrap().is_none(), "a retry must be allowed");
    }

    /// A corpse is not re-attachable: answering a second click with the dead server would make the
    /// button permanently dead instead of retrying.
    #[test]
    fn a_dead_server_is_not_re_attached_but_a_live_one_is() {
        for state in [PreviewState::Failed, PreviewState::Crashed, PreviewState::Stopped] {
            let mgr = PreviewManager::default();
            mgr.lock().insert("srv-1".into(), seeded("agent-1", "srv-1", 5173, state));
            assert!(
                mgr.reserve_or_reattach("agent-1").unwrap().is_none(),
                "{state:?} must fall through to a fresh spawn"
            );
        }
        for state in
            [PreviewState::Starting, PreviewState::Listening, PreviewState::Ready, PreviewState::Serving]
        {
            let mgr = PreviewManager::default();
            mgr.lock().insert("srv-1".into(), seeded("agent-1", "srv-1", 5173, state));
            assert!(
                mgr.reserve_or_reattach("agent-1").unwrap().is_some(),
                "{state:?} must re-attach"
            );
        }
    }

    /// Pins the classification itself, so the two loops above cannot both be satisfied by a
    /// predicate that got a variant wrong in the same direction twice.
    #[test]
    fn live_for_reattach_names_every_state_exactly_once() {
        let live = [
            PreviewState::Starting,
            PreviewState::Listening,
            PreviewState::Ready,
            PreviewState::Serving,
        ];
        let dead = [PreviewState::Failed, PreviewState::Crashed, PreviewState::Stopped];
        for s in live {
            assert!(live_for_reattach(s), "{s:?} is usable");
        }
        for s in dead {
            assert!(!live_for_reattach(s), "{s:?} is a corpse");
        }
        assert_eq!(live.len() + dead.len(), 7, "every PreviewState variant is classified above");
    }

    #[test]
    fn every_state_serializes_to_the_string_the_frontend_is_typed_against() {
        let pairs = [
            (PreviewState::Starting, "starting"),
            (PreviewState::Listening, "listening"),
            (PreviewState::Ready, "ready"),
            (PreviewState::Serving, "serving"),
            (PreviewState::Failed, "failed"),
            (PreviewState::Crashed, "crashed"),
            (PreviewState::Stopped, "stopped"),
        ];
        for (state, wire) in pairs {
            assert_eq!(serde_json::to_value(state).unwrap(), wire);
        }
    }

    /// The path arrives from the frontend, so it is untrusted until this has run.
    #[test]
    fn a_worktree_outside_the_managed_directory_is_refused() {
        let base = tempdir("worktrees");
        let inside = base.join("agent-1");
        std::fs::create_dir_all(&inside).unwrap();
        let outside = tempdir("elsewhere");
        assert!(validate_worktree(&base, &inside.to_string_lossy()).is_ok());
        assert!(validate_worktree(&base, &outside.to_string_lossy()).is_err(), "a sibling directory");
        assert!(validate_worktree(&base, &base.to_string_lossy()).is_err(), "the base itself is not a worktree");
        // ..-traversal is defeated by canonicalizing BEFORE the prefix check.
        let traversal = inside.join("..").join("..").to_string_lossy().to_string();
        assert!(validate_worktree(&base, &traversal).is_err());
        let _ = std::fs::remove_dir_all(&base);
        let _ = std::fs::remove_dir_all(&outside);
    }
}
