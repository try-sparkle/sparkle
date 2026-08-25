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

/// Is this a ROUTE on the dev server — `/dashboard` — rather than a URL, an origin-relative escape,
/// or something that would change what `preview_url_with_route` builds an origin out of?
///
/// **This is a security check, not validation politeness, and it is the mirror of `previewArgs`'s
/// regex in `apps/mcp-control/src/tools.ts`.** `preview_url_with_route` builds its URL by
/// CONCATENATION, which is where the danger is:
///
///   * A route not starting with `/` is an authority continuation. `"@evil.example"` appended to
///     `http://127.0.0.1:5173` yields `http://127.0.0.1:5173@evil.example`, whose host is
///     `evil.example` — the userinfo trick `preview_url_is_loopback` already documents. The leading
///     `/` is what terminates the authority, so it is load-bearing rather than cosmetic.
///   * `//host` and `/\host` are protocol-relative and resolve to another origin for any consumer
///     that re-resolves the route against a base (`new URL(path, base)`, `history.pushState`).
///   * ASCII tab/newline/CR are REMOVED by the WHATWG URL parser BEFORE parsing, so `"/\t/evil"`
///     becomes `"//evil"` at parse time and the `(?![/\\])` lookahead alone does not catch it.
///     That is why the whole control range is rejected rather than "printable characters only".
///
/// `preview_open` is a Tauri command the frontend can call directly, so this check cannot live only
/// in the TypeScript that happens to be in front of it today. Rejected routes are dropped (the
/// preview still opens, at the origin) rather than failing the open: a bad route is a bad link, not
/// a reason to withhold a working dev server.
pub fn is_preview_route(route: &str) -> bool {
    let mut chars = route.chars();
    if chars.next() != Some('/') {
        return false;
    }
    if matches!(chars.clone().next(), Some('/') | Some('\\')) {
        return false;
    }
    !chars.any(|c| c.is_whitespace() || c.is_control() || c == '\u{7f}')
}

/// The URL for a preview on `port`, landing on `route` if one was asked for.
///
/// `route` is the caller's `path` argument, and it is a ROUTE — it belongs in the URL the card and
/// `openUrl` use, and nowhere else. It used to be joined onto the SPAWN CWD instead
/// (`real.join(p)`), which made the documented call `{ op: "open", path: "/settings" }` fail every
/// time: `Path::join` with an absolute argument REPLACES the base, so `/settings` became the cwd
/// and then failed `validate_worktree`. A cwd subpath is what `[preview].path` is for; it is not
/// re-added under the route's name.
///
/// Guarded, not trusted: a route failing [`is_preview_route`] is dropped and the bare origin is
/// returned, so this function cannot emit a URL naming another host.
pub fn preview_url_with_route(port: u16, route: &str) -> String {
    let base = preview_url_for(port);
    if route.is_empty() || !is_preview_route(route) {
        return base;
    }
    format!("{base}{route}")
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
/// `preferred` IS "A PORT SOMEBODY ASKED FOR", NOT "a port we allocated and told no one about".
/// It is `Some` only when [`build_spawn`] says so — either Sparkle injected port flags, or the user
/// PINNED `[preview].port` — and `None` for everything else, which includes the ordinary `[preview]`
/// config override (`Framework::Unknown` injects no flags, and most overrides pin no port).
///
/// It was called `requested` while `open_reserved` fed it an allocated ephemeral port that reached
/// the child through no channel whatsoever, so the rule below was reasoning from a fiction on every
/// override project — bead `sparkle-cdq5de`, where the founder's agent announced port 52459 for a
/// dev server sitting on 5173.
///
/// **THIS IS THE WEAKER OF THE TWO PORT CLAIMS `build_spawn` COMPUTES, AND DELIBERATELY SO.** Its
/// `PortClaim::forced()` is the subset we can prove — flags we put on the command line — and is the
/// only one anything may publish as an ADDRESS, or turn into the claim-driven v6 refusal below. A
/// pin is the user's assertion about where their server binds, unverified by construction, which is
/// enough to break a tie between sockets here but not enough to print. (The TAIL refusal, when
/// there is no v4 candidate at all, is separate and applies at every level.)
///
/// Three outcomes, and they are three because collapsing any two loses information the pane has to
/// render:
///   * `Ok(None)` — nothing is listening yet. Keep waiting.
///   * `Ok(Some(port))` — a loopback listener. The `preferred` port wins when it is ONE OF THEM, so
///     a framework's second socket (HMR) cannot displace it. It does NOT win merely by being
///     passed: a forced port that has not bound yet loses to the lowest v4 loopback port in the
///     tree. See the caveat below — this bullet claimed the forced case was "deterministic" for one
///     commit after the fall-through stopped being conditional, which is the overclaim the caveat
///     exists to correct.
///   * `Err(msg)` — the tree IS listening, but not on loopback. **Refused, not depreferred**, and
///     the message NAMES the offending address so the pane can say what it refused rather than
///     showing a generic failure.
///
/// **A PORT THAT MATCHES NEITHER LIST FALLS THROUGH TO THE FIRST v4 LOOPBACK SOCKET, WHATEVER IT
/// IS — and passing a `preferred` port does not change that.** The rule is uniform: `preferred` wins
/// when it appears in one of the lists, and otherwise the v4 list is consulted first, so any
/// unrelated socket in the tree (Node's inspector on 9229 is the one you will actually meet) is
/// handed back as the preview's port. Nothing about that is an error, and the pane frames the
/// debugger.
///
/// An UNFORCED target (`None`) takes that fall-through by definition — there is nothing to prefer,
/// and pretending otherwise is what `sparkle-cdq5de` was. But it bites the DRIVEN frameworks too:
/// if the forced port has not appeared by the discovery tick on which some other v4 socket already
/// has, that socket is what comes back — and `supervise` latches the first answer (`if
/// bound.is_none()`), so discovery never revisits it. Refusing instead is not the fix: it kills
/// servers that are merely slow, which is the regression bead `sparkle-dnvaq` records. Identifying
/// the app's socket is.
///
/// **AND THE NON-DESTRUCTIVE ANSWER IS ONLY AVAILABLE WHILE SOMETHING IS ON v4 LOOPBACK.** With an
/// empty v4 list the fall-through has nothing to hand back, so the v6-only refusal below fires and
/// `supervise` treats an `Err` as terminal — it KILLS the child. That is the destructive outcome
/// this function otherwise avoids, and a forced port reaches it: a driven framework whose port has
/// not bound yet, in a tree whose only socket so far is a helper on a bare `localhost` (Node >= 17
/// resolves that to `::1`), is refused and killed for being slow. The refusal is right when the v6
/// socket IS the app and wrong when it is a helper, and — the whole of `sparkle-dnvaq` — nothing
/// here can tell those apart. It is kept because with no v4 candidate at all the app is more likely
/// than not the thing we can see, not because the case is unambiguous.
pub fn choose_listener(listeners: &[Listener], claim: PortClaim) -> Result<Option<u16>, String> {
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

    // THE NAMED PORT DECIDES when it is actually listening, whatever the strength of the claim:
    // somebody asked for this number, so among sockets that ARE up it is the best candidate for
    // being the app's. This branch only ever picks BETWEEN OBSERVED SOCKETS — it never invents an
    // address, which is what `sparkle-cdq5de` was.
    if let Some(want) = claim.port() {
        if loopback.contains(&want) {
            return Ok(Some(want));
        }
        // THE HARD REFUSAL IS RESERVED FOR A *FORCED* PORT, and that gate is the whole reason
        // `PortClaim` has three levels instead of two. `supervise` treats an `Err` here as terminal:
        // it kills the child and marks the preview `Failed`. That is the right answer when we put
        // `--port <want>` on the command line ourselves — the app really is on `want`, and a
        // v6-only bind there is unreachable. It is the WRONG answer for a `[preview].port` pin,
        // which reaches the child through no channel at all: any unrelated helper on `[::1]:<pin>`
        // would kill a dev server that is healthy on some other v4 port. An unverified pin may
        // prefer, but may not refuse ON ITS OWN ACCOUNT — so it falls through to the v4 list below.
        // NOTE WHAT THAT DOES NOT SAY: the TAIL refusal further down ("nothing on v4, something on
        // v6") still applies at every claim level, `Unknown` included. This gate removes the
        // claim-driven kill, not every kill.
        if claim.forced() == Some(want) {
            if let Some(addr) = v6_only.get(&want) {
                return Err(v6_refusal(addr));
            }
        }
        // A PREFERRED PORT THAT MATCHED NEITHER LIST FALLS THROUGH ON PURPOSE — see the caveat in
        // the docblock. A previous version of this function refused here whenever any v6-only socket
        // was in the tree, on the theory that it must be the app. (That reasoning was written when
        // an unforced `Framework::Unknown` still arrived here carrying a port; it no longer does —
        // an override that pins nothing arrives as `None` and never enters this block at all.) That
        // was REVERTED, because the
        // theory is a coin flip and the two outcomes are not equally bad:
        //
        //   * guess wrong toward refusing — an app on `127.0.0.1:3000` with any helper on a bare
        //     `localhost` (Node >= 17 resolves that to `::1`) is refused, and `supervise` treats a
        //     refusal as terminal: it KILLS the working dev server. The refusal text then tells the
        //     user to bind 127.0.0.1, which that server already did, so following it cannot help.
        //   * guess wrong toward accepting — the pane frames some other socket in the tree (the
        //     inspector on 9229 is the one you will meet). Wrong page, nothing destroyed, Reload
        //     and Stop both still work.
        //
        // Nothing here can tell the two shapes apart: same lists, same emptiness, different truth.
        // Until the app's socket can be IDENTIFIED rather than guessed (bead sparkle-dnvaq), the
        // non-destructive wrong answer is the right default.
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
///
/// TAKES A [`PortClaim`], AND `PortClaim::Unknown` IS A REAL ANSWER RATHER THAN A CARELESS ONE. It
/// used to take a bare `u16`, on the reasoning that "asking with no port at all" was the mistake worth putting
/// in front of the compiler. That guard was aimed at the wrong failure: the value the only
/// production caller had to pass was an ALLOCATED port that had been injected nowhere, so the type
/// forced the caller to state a preference it had no basis for, and `choose_listener`'s "somebody
/// asked for this port" rule was being fed a fiction on every `[preview]` config override
/// (bead `sparkle-cdq5de`). A `None` that means "nobody asked for a port" is strictly more honest
/// than a number that means "we allocated something and told no one".
///
/// **THE PROVENANCE IS THE GUARD NOW: `claim` MUST COME FROM [`Spawn::claim`]**, which is computed
/// by the same function that builds the argv, so it cannot claim a port nobody ever asked for. Do
/// not hand-write a `PortClaim::Forced(port)` here from a port you merely allocated — that is
/// precisely the bug this parameter's type used to institutionalize.
///
/// IT TAKES THE WHOLE CLAIM, NOT A BARE PORT, and [`choose_listener`] reads BOTH halves of it.
/// `claim.port()` is the discovery preference — safe at any strength, because choosing between
/// sockets that are ALREADY LISTENING can only ever pick the wrong observed socket, never invent
/// one. `claim.forced()` is the subset that may additionally turn a v6-only bind into a TERMINAL
/// refusal, which `supervise` answers by killing the child; restricting that to a port we really
/// put on the command line is the whole reason the claim travels intact rather than as a bare
/// `Option<u16>`.
///
/// **PASSING A `Some` STILL DOES NOT GUARANTEE THE ANSWER IS THE APP.** Even a DRIVEN framework
/// loses the guarantee whenever its port has not bound yet and another v4 socket has:
/// `choose_listener` falls through to the first v4 loopback socket, which is bead `sparkle-dnvaq`
/// — the alternative, refusing on a guess, kills working servers.
pub fn discover_port(
    procs: &dyn ProcessTable,
    listen: &dyn ListenTable,
    root_pid: u32,
    claim: PortClaim,
) -> Result<Option<u16>, String> {
    // `None` from either seam means we could not look — NOT that nothing is listening.
    let Some(rows) = procs.rows() else { return Ok(None) };
    let tree = descendant_pids(&rows, root_pid);
    let Some(listeners) = listen.listeners(&tree) else { return Ok(None) };
    choose_listener(&listeners, claim)
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
    /// candidate is named and the caller picks one — per call with `target`, or project-wide via
    /// `[preview]` in the project's config.
    Ambiguous(Vec<String>),
    /// A per-call `target` that matches NONE of the enumerated candidates.
    ///
    /// Its own variant rather than folding into `Ambiguous`, because the two say opposite things to
    /// the caller: `Ambiguous` means "you did not choose", this means "what you chose does not
    /// exist here". It carries BOTH halves — the value asked for and the list actually available —
    /// so an agent can correct itself in one round trip instead of guessing a second time
    /// (bead `sparkle-syzpei`: a decline that names no remedy the caller can perform is a decline
    /// nobody acts on).
    ///
    /// It is also the ONLY outcome for an unmatched target. There is deliberately no fallback to
    /// "detect something anyway": `target` selects from the enumerated list and can do nothing
    /// else, so a value naming no candidate must never reach a program, an argv or a path.
    UnknownTarget { requested: String, candidates: Vec<String> },
    /// A `[preview]` override that pins a CONSTANT port and carries no `{port}` token anywhere, so
    /// it would hand every agent on this machine the same number. Carries the offending flag as it
    /// was written, because a refusal that does not name the line to edit is a refusal nobody acts
    /// on. Bead `sparkle-ne230x`: this repo's own block pinned `--port 5173` and the founder opened
    /// one agent's preview card to find a DIFFERENT agent's app behind it.
    ConstantPortPin(String),
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
            Decline::UnknownTarget { .. } => "unknown-target",
            Decline::ConstantPortPin(_) => "constant-port-pin",
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
            // NAMES A REMEDY THE CALLER CAN ACTUALLY PERFORM, and the per-call one comes FIRST.
            // This message used to offer only `[preview]` in the project's .sparkle/config.toml —
            // shared, checked-in config that an agent's own contract forbids it to edit
            // unilaterally. So every agent that hit this was told to do the one thing it was not
            // allowed to do, and stopped there: that deadlock IS bead `sparkle-syzpei`, and it is
            // why `target` exists. Keep both remedies named, in this order.
            Decline::Ambiguous(candidates) => format!(
                "more than one thing here could be previewed ({}) — pick one for THIS call with \
                 {{ op: \"open\", target: \"<one of those>\" }}, or name a project-wide default \
                 under [preview] in this project's .sparkle/config.toml",
                candidates.join(", ")
            ),
            Decline::UnknownTarget { requested, candidates } => format!(
                "no previewable target here is called {requested:?} — this worktree offers {}",
                if candidates.is_empty() {
                    "nothing to pick from, so there is no target to name".to_string()
                } else {
                    candidates.join(", ")
                }
            ),
            Decline::ConstantPortPin(flag) => format!(
                "this project's [preview] command pins a constant port (`{flag}`), which hands \
                 EVERY agent the same one — so one agent's dev server ends up serving another \
                 agent's preview. Write the value as `{PORT_PLACEHOLDER}` instead (e.g. `--port \
                 {PORT_PLACEHOLDER}`) and Sparkle substitutes the port it allocated for this agent",
            ),
        }
    }
}

/// The token a `[preview]` override writes to receive the port Sparkle allocated for THIS agent.
pub const PORT_PLACEHOLDER: &str = "{port}";

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

/// A planned spawn: what to run, and whether Sparkle actually FORCED the port it was planned with.
///
/// THE TWO HALVES ARE COMPUTED TOGETHER ON PURPOSE. "Did the child get told which port to use" is
/// answerable only from the argv that was built, and while it lived in the caller's head it was
/// wrong: `open_reserved` allocated an ephemeral port, built an argv that mentioned it nowhere, and
/// then published `http://127.0.0.1:<that port>` as the preview's address (bead `sparkle-cdq5de`).
/// The founder read one of those numbers out of his agent's chat — 52459 — while the dev server was
/// on 5173 and the concierge card said so correctly. Returning the verdict from the same function
/// that builds the argv is what makes the two unable to disagree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spawn {
    /// The program to spawn, with any `{port}` token already substituted. Computed HERE rather
    /// than read off the target for the same reason the claim is: `command = "serve-on-{port}"` is
    /// a channel the port can reach the child through, so whoever decides the claim has to be the
    /// one that resolves it, or the two can disagree.
    pub program: String,
    /// The full argument vector to spawn with.
    pub argv: Vec<String>,
    /// How much Sparkle actually knows about the port this child will bind. See [`PortClaim`] —
    /// the whole point is that "we injected it" and "the user asserted it" are DIFFERENT claims,
    /// and only the first may become an address.
    pub claim: PortClaim,
}

/// How strong Sparkle's claim on a preview's port is. Three levels, because collapsing the middle
/// one into either neighbour is what bead `sparkle-cdq5de` was.
///
/// The distinction is not academic — it decides two things with very different blast radii:
///   * MAY WE PUBLISH IT AS AN ADDRESS before anything has bound a socket? Only `Forced`. Being
///     wrong here invents a URL out of nothing, which is the bug this bead is about.
///   * MAY THIS NUMBER *BY ITSELF* TRIGGER THE HARD v6 REFUSAL in [`choose_listener`]? Only
///     `Forced`. `supervise` treats that refusal as terminal and KILLS the child, so letting an
///     unverified number reach it means a healthy dev server on some other port dies because an
///     unrelated helper happened to sit on `[::1]:<pin>`.
/// Preferring a port among sockets that ARE listening is safe at any level, and that is all
/// `Preferred` is allowed to do.
///
/// **THIS IS NOT A PROMISE THAT A NON-FORCED CLAIM CANNOT KILL ANYTHING, AND THE DIFFERENCE MATTERS.**
/// [`choose_listener`]'s TAIL refusal — "nothing on v4 loopback, but something IS on v6" — fires at
/// EVERY level, `Unknown` included; `a_v6_only_bind_is_refused_because_the_frame_is_pointed_at_v4`
/// pins exactly that. So a pinned override whose child has not bound yet, in a tree where some
/// helper sits on a bare `localhost` (Node >= 17 resolves that to `::1`), still dies — over a socket
/// that is not even the pinned port. What the gate below removes is the *claim-driven* kill, not
/// every kill. Refusing when there is no v4 candidate at all is bead `sparkle-dnvaq`'s deliberate
/// coin-flip, and it is unchanged here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PortClaim {
    /// Nobody named a port. Discovery reports whatever it finds.
    Unknown,
    /// The user PINNED `[preview].port`, and Sparkle put it on NO command line. `target.port` is
    /// `Some` only in `detect_preview_target`'s `[preview]` override branch, which is always
    /// `Framework::Unknown`, so `port_args` contributes nothing there — and the pin itself is not a
    /// channel, so the number reaches the child through none. It is the user's assertion about
    /// where their server binds: good enough to break a tie between observed sockets, not good
    /// enough to print or to kill a process over.
    ///
    /// AN OVERRIDE IS NO LONGER TRAPPED AT THIS LEVEL, and that is bead `sparkle-ne230x`. Writing
    /// [`PORT_PLACEHOLDER`] anywhere in `command` or `args` puts the allocated port ON the command
    /// line, which is proof rather than assertion, so such a config promotes to `Forced` below.
    /// What is left here is the config that names a port but offers Sparkle no way to convey one.
    Preferred(u16),
    /// This number is ON THE COMMAND LINE — either `Framework::port_args` returned flags carrying
    /// it, or the override wrote [`PORT_PLACEHOLDER`] and `build_spawn` substituted it in. The only
    /// claim we can prove the child received, and the only one distinct per agent.
    Forced(u16),
}

impl PortClaim {
    /// The port named, at whatever strength. Use for DISCOVERY PREFERENCE only.
    pub fn port(self) -> Option<u16> {
        match self {
            PortClaim::Unknown => None,
            PortClaim::Preferred(p) | PortClaim::Forced(p) => Some(p),
        }
    }

    /// The port we can PROVE the child was told. The only value publishable as an address, and the
    /// only one that may trigger a terminal refusal ON ITS OWN ACCOUNT.
    ///
    /// That last qualifier is load-bearing, and the unqualified form of this sentence was wrong.
    /// `choose_listener`'s no-v4-candidate TAIL refusal — "nothing on v4 loopback, but something IS
    /// on v6" — fires at EVERY claim level, `Unknown` included, over a socket that need not be the
    /// claimed port at all. See [`PortClaim`]'s own docblock, which this accessor used to
    /// contradict: a reader at the `claim.forced()` call site would have concluded the terminal-kill
    /// branch was unreachable without a forced port, which is backwards.
    pub fn forced(self) -> Option<u16> {
        match self {
            PortClaim::Forced(p) => Some(p),
            _ => None,
        }
    }
}

/// Every `{port}` in `text` replaced with `port`. EVERY occurrence, not the first: a token honoured
/// once and silently ignored the second time looks correct in the config and produces one real port
/// and one fiction.
fn substitute_port(text: &str, port: u16) -> String {
    if !text.contains(PORT_PLACEHOLDER) {
        return text.to_string();
    }
    text.replace(PORT_PLACEHOLDER, &port.to_string())
}

/// All ASCII digits, so it is a number this config would hand to every agent alike. Anything
/// carrying a substitution — `{port}`, a shell `$PORT` — is not a constant and is left alone.
fn is_constant_port(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}

/// A port flag in an override's args whose value is a literal constant, rendered AS WRITTEN so the
/// decline can name the exact thing to edit. `None` when no port flag names a constant.
///
/// Three spellings, because a rule that catches two of the three ways to write the same mistake is
/// one a config walks around by accident: `--port 5173`, `--port=5173`, and the `-p` short form of
/// both. The value is checked rather than assumed, so `--port {port}` is NOT a constant.
fn constant_port_flag(args: &[String]) -> Option<String> {
    for (i, arg) in args.iter().enumerate() {
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) => (n, Some(v)),
            None => (arg.as_str(), None),
        };
        if !matches!(name, "--port" | "-p") {
            continue;
        }
        match inline {
            Some(value) if is_constant_port(value) => return Some(arg.clone()),
            Some(_) => {}
            None => {
                let value = args.get(i + 1).map(String::as_str).unwrap_or_default();
                if is_constant_port(value) {
                    return Some(format!("{arg} {value}"));
                }
            }
        }
    }
    None
}

/// The full argument vector for a spawn on `port`, plus whether `port` was forced onto the child.
pub fn build_spawn(target: &PreviewTarget, port: u16) -> Spawn {
    // THE TOKEN IS AN OVERRIDE'S ONLY CHANNEL, and substituting it is what turns the claim below
    // from a guess into proof. `port_args` gives `Framework::Unknown` nothing, so before this a
    // hand-written command could not be handed the allocated port through anything at all.
    let conveyed = target.program.contains(PORT_PLACEHOLDER)
        || target.args.iter().any(|a| a.contains(PORT_PLACEHOLDER));
    let program = substitute_port(&target.program, port);
    let mut argv: Vec<String> = target.args.iter().map(|a| substitute_port(a, port)).collect();
    let flags = target.framework.port_args(port);
    let injected = !flags.is_empty();
    if injected {
        if target.needs_arg_separator {
            argv.push("--".into());
        }
        argv.extend(flags);
    }
    // `== Some(port)`, not `.is_some()`: the pin only vouches for the port we are ACTUALLY spawning
    // with. A pin we declined to honour (the reserved-port refusal above bails out before this, but
    // the type does not know that) would otherwise vouch for a different number entirely.
    let pinned = target.port == Some(port);
    // `conveyed` sits beside `injected` and not below `pinned` ON PURPOSE: both are the same kind
    // of fact — this number is ON THE COMMAND LINE — and only that kind may be published. A pin is
    // an assertion about someone else's server and stays the weaker claim.
    let claim = if injected || conveyed {
        PortClaim::Forced(port)
    } else if pinned {
        PortClaim::Preferred(port)
    } else {
        PortClaim::Unknown
    };
    Spawn { program, argv, claim }
}

/// The full argument vector for a spawn on `port`. A thin view over [`build_spawn`] — call that one
/// when you also need to know whether the port was real.
pub fn build_argv(target: &PreviewTarget, port: u16) -> Vec<String> {
    build_spawn(target, port).argv
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

/// One enumerated candidate, resolved to the SHAPE it will be built as.
///
/// Two shapes, because enumeration produces two: a workspace package directory (`apps/web`,
/// displayed as `apps/web (dev)`) and a root `dev:*` script name (`dev:desktop`). Naming the shape
/// here rather than re-deriving it from the display string is what lets the requested-target path
/// and the exactly-one-candidate path share one builder — see `build_enumerated`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Chosen {
    /// A workspace sub-package, as a path relative to the worktree root.
    Package(String),
    /// A root `dev:<x>` script, by its script name.
    RootScript(String),
}

/// Resolve a caller-supplied `target` to one ENUMERATED candidate, or nothing.
///
/// *** THIS IS THE WHOLE OF WHAT `target` CAN DO. *** The string never reaches a program, an argv,
/// a path or a shell: it is compared against strings this process just enumerated from the
/// worktree, and the value that travels onward is the ENUMERATED one, never the caller's. A value
/// matching no candidate returns `None`, which the caller turns into `Decline::UnknownTarget` — a
/// refusal, never a fallback and never a spawn. So a hostile value (`"; rm -rf /"`, `"../../etc"`,
/// `"/etc/passwd"`) is refused by construction rather than by a filter that has to anticipate it.
///
/// Two spellings are accepted for a package, because both are things the caller has plausibly been
/// shown: the exact candidate string the `Ambiguous` decline printed (`"apps/web (dev)"`) and the
/// bare package directory (`"apps/web"`). Root scripts are matched verbatim only — that IS their
/// displayed form.
fn choose_candidate(want: &str, root_variants: &[String], packages: &[String]) -> Option<Chosen> {
    let want = want.trim();
    if want.is_empty() {
        return None;
    }
    if let Some(pkg) = packages.iter().find(|p| p.as_str() == want || format!("{p} (dev)") == want) {
        return Some(Chosen::Package(pkg.clone()));
    }
    root_variants.iter().find(|s| s.as_str() == want).map(|s| Chosen::RootScript(s.clone()))
}

/// Decide whether — and how — a worktree can be previewed. Priority order is §7's.
///
/// `enabled` is passed in rather than read here so the function stays pure w.r.t. app state and can
/// be driven from a test both ways.
///
/// `requested` is a PER-CALL target — one enumerated candidate, named by the caller for this open
/// only. When it is `Some`, detection SKIPS steps 1-3 and goes straight to enumeration, and that
/// ordering is the entire point of the argument rather than an implementation detail:
///
///   * If `[preview]` still won, the argument would be INERT in every project that has a
///     `[preview]` block — including this repo, which has one — so the deadlock it exists to break
///     (bead `sparkle-eqbtqg`, filed eight times) would survive the fix.
///   * It is allowed to beat shared config precisely because it is CALLER-SCOPED: it lives for one
///     `preview_open` and cannot be observed by, or affect, any other agent. Editing
///     `.sparkle/config.toml` is the opposite — checked-in, shared, and something an agent must not
///     do unilaterally, which is why being told to do it was a dead end.
///   * Steps 2 and 3 are skipped for the same reason `target` is refused on close/list: they return
///     a single answer that ignores the request, which would let a caller believe its target did
///     something. An unmatched target is `Decline::UnknownTarget`, naming what IS available.
pub fn detect_preview_target(
    worktree: &Path,
    enabled: bool,
    requested: Option<&str>,
) -> Result<PreviewTarget, Decline> {
    if !enabled {
        return Err(Decline::Disabled);
    }

    // ── 1. Explicit project config wins — UNLESS this call named its own target (see above).
    // The escape hatch for when detection is wrong, and the
    // only thing the founder should ever have to write. It needs no package.json and no lockfile:
    // by writing it, he has already answered every question detection would ask.
    let over = if requested.is_none() { read_preview_override(worktree) } else { PreviewOverride::default() };
    if let Some(command) = over.command.as_ref().map(|c| c.trim()).filter(|c| !c.is_empty()) {
        let args = over.args.unwrap_or_default();
        // REFUSE A CONSTANT PORT BEFORE IT CAN COLLIDE. A config that names a fixed number and
        // gives Sparkle no `{port}` token to substitute PROVABLY hands every agent on the machine
        // the same port, and the collision is invisible at the point it happens — a dev server that
        // steps aside to the next free port serves the wrong app behind a URL that looks right.
        // Failing loudly here is the founder's explicit instruction (bead `sparkle-ne230x`).
        let conveyable = command.contains(PORT_PLACEHOLDER)
            || args.iter().any(|a| a.contains(PORT_PLACEHOLDER));
        if !conveyable {
            if let Some(flag) = constant_port_flag(&args) {
                return Err(Decline::ConstantPortPin(flag));
            }
        }
        return Ok(PreviewTarget {
            // Unknown, not a guess: we do not know which framework a hand-written command starts,
            // so `port_args` injects nothing and discovery + the loopback refusal do the work. The
            // one channel that IS available is the `{port}` token, which `build_spawn` substitutes
            // into whatever the config wrote it in.
            framework: Framework::Unknown,
            program: command.to_string(),
            args,
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
    // Skipped when this call named a target: a lone root `dev` is not an enumerated candidate, so
    // returning it here would silently ignore the request.
    if requested.is_none() && root_scripts.contains_key("dev") {
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
    // Skipped when this call named a target, for the same reason as step 2.
    if requested.is_none() && framework != Framework::Unknown {
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
    // The two enumerated shapes are kept APART as well as joined: `candidates` is the display list
    // a decline prints, `root_variants`/`packages` are what a requested target is matched against.
    // Re-deriving the shape from the display string ("does it end in ` (dev)`?") would be a parser
    // over text we control on both sides, and would misread a script literally named that way.
    let root_variants: Vec<String> =
        root_scripts.keys().filter(|k| k.starts_with("dev:")).cloned().collect();
    let packages =
        if is_workspace_root(worktree, Some(&root_manifest)) { workspace_dev_packages(worktree) } else { Vec::new() };
    let candidates: Vec<String> =
        root_variants.iter().cloned().chain(packages.iter().map(|p| format!("{p} (dev)"))).collect();

    // WHICH candidate this run builds. The requested path and the exactly-one path both end at a
    // single `Chosen`, and everything below is shared: a per-call target therefore cannot reach a
    // spawn by any route the ordinary single-candidate case does not already use.
    let chosen = match requested {
        Some(want) => choose_candidate(want, &root_variants, &packages).ok_or_else(|| {
            Decline::UnknownTarget { requested: want.to_string(), candidates: candidates.clone() }
        })?,
        None => {
            if candidates.len() > 1 {
                return Err(Decline::Ambiguous(candidates));
            }
            if candidates.is_empty() {
                return Err(Decline::NoDevScript);
            }
            // Exactly one candidate: either a lone root `dev:<x>`, or one package with `dev`.
            match packages.first() {
                Some(pkg) => Chosen::Package(pkg.clone()),
                None => Chosen::RootScript(candidates[0].clone()),
            }
        }
    };

    let pm = pm.ok_or(Decline::NoPackageManager)?;
    if !pm.forwards_run_args_verified() {
        return Err(Decline::UnsupportedPackageManager(pm));
    }
    match chosen {
        Chosen::Package(pkg) => {
            let pkg_dir = worktree.join(&pkg);
            let pkg_framework = root_framework(&pkg_dir);
            if !pkg_framework.is_driven() {
                return Err(Decline::UnsupportedFramework(pkg_framework));
            }
            let (args, needs_arg_separator) = run_script_invocation(pm, "dev");
            Ok(PreviewTarget {
                framework: pkg_framework,
                program: pm.program().to_string(),
                args,
                needs_arg_separator,
                path: pkg,
                source: "workspace-package",
                port: None,
            })
        }
        Chosen::RootScript(script) => {
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
    }
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
    /// THE PORT SOMEBODY ASKED FOR — `PortClaim::port()`: flags Sparkle injected, or a pin the user
    /// wrote in `[preview].port`. NEVER the one we merely allocated, which is what this field used
    /// to hold and is bead `sparkle-cdq5de`.
    ///
    /// **THIS IS THE WEAKER OF THE TWO CLAIMS, SO IT IS NOT PUBLISHABLE AS AN ADDRESS.** It stores
    /// `PortClaim::port()`, not `PortClaim::forced()`, so a `Some` here may be an unverified pin —
    /// the user's assertion about where their server binds, conveyed to the child through no
    /// channel. Only `bound_port` below is an observed fact. A future reader wanting "the address
    /// this preview answers at" wants that field, every time.
    ///
    /// `None` is the ordinary case for a `[preview]` config override, which injects no port flags
    /// and usually pins none either.
    ///
    /// The FIELD NAME is deliberately left alone. It is a serde-serialized key in the on-disk
    /// registry that previous launches have already written; renaming it would make every existing
    /// entry fail to deserialize, and the registry's whole job is to survive a hard kill.
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
    /// Waiting on `node_modules` to materialize before the dev server can even be spawned — see
    /// `open_reserved`'s deps-wait step. Reachable only when a lockfile names a manager this module
    /// drives and `node_modules` is not yet on disk; a worktree whose `deps_bootstrap` fire-and-forget
    /// install already finished (the common case) never passes through here at all.
    Installing,
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
///
/// `url: ""` / `port: 0` IS A REAL, CONTRACTED ANSWER — "started, no address yet" — not a bug to
/// paper over. `reserve_or_reattach` already sent it for a re-attach landing before the port
/// existed, and `controlListener.handlePreview` has always stripped an empty address rather than
/// forwarding it. A fresh open of an UNFORCED target now sends it too (see `opened_reply`), which
/// is the whole of bead `sparkle-cdq5de`: the alternative was a URL naming a port nothing binds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOpened {
    pub id: String,
    pub url: String,
    pub port: u16,
    pub state: PreviewState,
}

/// The pre-discovery `preview_open` reply for a server whose port was `forced` (or was not).
///
/// Pure, and separate from `open_reserved` for one reason: `open_reserved` needs a live
/// `AppHandle` and cannot be unit-tested at all, so the decision that actually reaches the agent —
/// "do we name an address before anything has bound one?" — would otherwise be untestable. This is
/// the side effect a test can assert on.
pub fn opened_reply(id: String, forced: Option<u16>, route: &str, state: PreviewState) -> PreviewOpened {
    match forced {
        // The route rides the FORCED-port reply for the same reason it rides `transition`'s: an
        // agent that gets an address back at all must get the one it asked for, or `path` would
        // work through the event channel and silently not through the call's own answer.
        Some(port) => PreviewOpened { id, url: preview_url_with_route(port, route), port, state },
        // NOT `preview_url_for(0)`: an empty string is the sentinel the frontend guard keys on, and
        // `http://127.0.0.1:0` would sail through it as a perfectly well-formed loopback URL.
        None => PreviewOpened { id, url: String::new(), port: 0, state },
    }
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
    /// The route this preview was opened on (`"/settings"`), or empty for the origin.
    ///
    /// HELD HERE rather than passed to each publish site, because the port arrives LATER than the
    /// route does: `open_reserved` knows the route immediately and does not learn the real port
    /// until `supervise` discovers it, and `transition` is the one place that turns a port into a
    /// URL. Keeping it on the entry is what lets the address the card finally shows carry the route
    /// the caller asked for, without the route having to travel through the supervisor thread.
    ///
    /// A RE-ATTACH KEEPS THE ORIGINAL ROUTE. A second `preview_open` with a different `path` does
    /// not restart anything (that is the whole point of re-attach), so it cannot move a running
    /// server's published address either — the caller is handed the live preview, on the route it
    /// was opened with.
    route: String,
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
        PreviewState::Installing
        | PreviewState::Starting
        | PreviewState::Listening
        | PreviewState::Ready
        | PreviewState::Serving => true,
        PreviewState::Failed | PreviewState::Crashed | PreviewState::Stopped => false,
    }
}

/// THE MACHINE-READABLE HALF OF THE IN-FLIGHT REFUSAL, and the only part the frontend may match on.
///
/// The message crosses the IPC boundary as a bare string, so the seam is an English substring that
/// two languages hand-copy — reword either side and both suites stay green while the pane paints its
/// TERMINAL `failed` state over a start that is healthy and still running. `services/preview.ts`
/// exports the same literal as `PREVIEW_ALREADY_STARTING`, and `previewSeam.test.ts` reads THIS FILE
/// and asserts the two agree, so a reword on either side is a red test rather than a silent
/// regression. Keep it a hyphenated token: prose gets edited, tokens get left alone.
const ALREADY_STARTING: &str = "already-starting";

/// Holds one agent's start reservation for as long as it is alive, and gives it back on Drop.
///
/// RAII RATHER THAN A TRAILING STATEMENT, and the difference is not style. `open_reserved` runs an
/// unbounded login-shell lookup and a process spawn; an unwind anywhere in there skips a trailing
/// release, tokio turns the panic into a `JoinError` and the process survives — so the reservation
/// survives too, and that agent's preview button is dead for the rest of the session with NO
/// feedback, because the frontend deliberately swallows this refusal. A guard cannot be forgotten by
/// a future early return and cannot be skipped by an unwind.
///
/// STILL NOT COVERED: a start that HANGS. `spawn_blocking` tasks are never cancelled, so a
/// `resolve_program` parked forever in a user's `.zshrc` holds this guard for the life of the
/// process. The fix for that is bounding `preflight::run_in_login_shell`, not anything here —
/// tracked separately, since it is an unbounded call this code merely inherits.
struct StartReservation<'a> {
    mgr: &'a PreviewManager,
    agent_id: String,
}

impl Drop for StartReservation<'_> {
    fn drop(&mut self) {
        self.mgr.release_starting(&self.agent_id);
    }
}

/// What [`PreviewManager::reserve_or_reattach`] decided.
enum ReserveOutcome<'a> {
    /// This agent already has a usable server; hand it back rather than spawning.
    Reattached(PreviewOpened),
    /// The caller owns the start. The reservation lasts exactly as long as this guard.
    Reserved(StartReservation<'a>),
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

    /// The one place that decides whether a `preview_open` SPAWNS. `Reattached` = this agent already
    /// has a usable server; `Reserved(guard)` = the caller must spawn, and the RESERVATION LIVES AS
    /// LONG AS THAT GUARD; `Err` = another start is already in flight.
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
    fn reserve_or_reattach(&self, agent_id: &str) -> Result<ReserveOutcome<'_>, String> {
        let mut starting = self.starting.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) =
            self.lock().values().find(|s| s.status.agent_id == agent_id && live_for_reattach(s.status.state))
        {
            return Ok(ReserveOutcome::Reattached(PreviewOpened {
                id: existing.status.id.clone(),
                url: existing.status.url.clone().unwrap_or_else(|| {
                    existing.status.port.map(|p| preview_url_with_route(p, &existing.route)).unwrap_or_default()
                }),
                port: existing.status.port.unwrap_or(0),
                state: existing.status.state,
            }));
        }
        if !starting.insert(agent_id.to_string()) {
            return Err(format!("preview: a server for this agent is {ALREADY_STARTING}"));
        }
        Ok(ReserveOutcome::Reserved(StartReservation { mgr: self, agent_id: agent_id.to_string() }))
    }

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
                // THE ROUTE IS APPLIED HERE, at the single place a port becomes a URL, so the
                // address every consumer sees (event, `preview_status`, `preview_list`, the card)
                // is the same string. Applying it downstream instead would make a card's held
                // address differ from a freshly-read one and read as `moved`.
                server.status.url = Some(preview_url_with_route(p, &server.route));
            }
            if error.is_some() {
                server.status.error = error;
            }
            server.status.clone()
        };
        let _ = app.emit("preview:state", status);
    }

    /// Attach the REAL pgid once the dev server actually spawns. The entry is created with `pgid: 0`
    /// at `Installing`/`Starting` time (see `open_reserved`), before there is a child to name — a
    /// stop requested during that window has nothing to signal (`stop_one`'s `pgid > 1` guard makes
    /// `0` inert on purpose) and only starts meaning something once this runs.
    fn set_pgid(&self, id: &str, pgid: u32) {
        if let Some(server) = self.lock().get_mut(id) {
            server.pgid = pgid;
        }
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
/// How long `open_reserved` waits in the `Installing` state for `node_modules` to appear before
/// giving up. Generous on purpose: this is a full dependency install, not a compile — measured at
/// ~27s on a warm pnpm store (`services/depsBootstrap.ts`'s own module comment), and a cold store or
/// an npm/yarn project can run well past that. Longer than any `deps_bootstrap` timeout on the TS
/// side, deliberately: this is a fallback for the case that install was slow or never started, not a
/// race with it.
const INSTALL_WAIT_TIMEOUT: Duration = Duration::from_secs(300);
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

/// Canonicalize a path the frontend named as a PROJECT ROOT, for READ-ONLY inspection.
///
/// DELIBERATELY NOT `validate_worktree`, and the difference is what made the feature work at all. A
/// project root is the user's own chosen repo folder (`types.ts`'s `rootPath`); agent worktrees live
/// under `<app_data>/worktrees/<projectId>/<agentId>`. So a project root is NEVER inside the managed
/// worktrees directory, and running the containment check against one rejected EVERY real project —
/// `preview_capability` errored, the frontend's catch recorded `previewable: false`, and every
/// preview affordance was permanently absent in every session with only a `console.debug`. Both
/// halves passed their own tests; the seam was dead (the `sparkle-16y6h` shape).
///
/// The containment check belongs to `preview_open`, which SPAWNS A PROCESS in the directory. This
/// path only reads manifests, so it asks the two things a read actually needs: the path resolves,
/// and it is a directory.
pub fn validate_project_dir(path: &str) -> Result<PathBuf, String> {
    let real =
        std::fs::canonicalize(path).map_err(|e| format!("preview: invalid project path: {e}"))?;
    if !real.is_dir() {
        return Err("preview: the project path is not a directory".into());
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

/// Re-attach, or reserve and run `spawn`. THE WHOLE WIRING, with the `AppHandle` factored out.
///
/// `open_blocking` is untestable by construction — it needs a live `AppHandle` — so keeping the
/// orchestration here is what lets a test drive reserve→spawn→release for real, including the paths
/// that matter: a spawn that ERRORS and a spawn that PANICS must both leave the agent startable
/// again. The release is the guard's `Drop`, so there is no statement left for a future edit to skip.
fn open_with_reservation<F>(
    mgr: &PreviewManager,
    agent_id: &str,
    spawn: F,
) -> Result<PreviewOpened, String>
where
    F: FnOnce(&StartReservation<'_>) -> Result<PreviewOpened, String>,
{
    match mgr.reserve_or_reattach(agent_id)? {
        ReserveOutcome::Reattached(existing) => Ok(existing),
        // The guard is BOUND and then HANDED to the spawn — `let _ = guard` would drop it
        // immediately and release the reservation before the spawn it is meant to cover, and
        // passing it on is what lets `open_reserved` demand proof rather than trust a comment.
        ReserveOutcome::Reserved(guard) => spawn(&guard),
    }
}

/// Does this directory need `PreviewState::Installing` before a dev server can be spawned in it?
///
/// PURE AND FILESYSTEM-ONLY, deliberately — extracted from `open_reserved` (which needs a live
/// `AppHandle` and so cannot be unit tested directly) precisely so this one decision can be. Mirrors
/// `deps_bootstrap::plan_for`'s own "already installed" short-circuit: a lockfile a manager THIS
/// MODULE ACTUALLY DRIVES (`PackageManager::is_supported`), with no `node_modules` yet, means either
/// an install has never run or one is still in flight — either way, spawning `<manager> run dev`
/// right now would fail with a missing-module error that reads as a broken preview rather than as
/// "give it a moment".
///
/// GATED ON `is_supported()`, NOT JUST `manager_for().is_some()` — `manager_for` also recognizes
/// yarn and bun by their lockfile, but `bootstrap_worktree_deps` never drives either (`is_supported`
/// is pnpm/npm only), so a yarn/bun worktree's `node_modules` will NEVER appear on its own. Waiting
/// on it anyway would burn the full `INSTALL_WAIT_TIMEOUT` for an install nothing ever attempts, and
/// then fail with a message that reads as "the install broke" when nothing was ever running.
fn needs_deps_wait(cwd: &Path) -> bool {
    matches!(crate::deps_bootstrap::manager_for(cwd), Some(pm) if pm.is_supported())
        && !cwd.join("node_modules").is_dir()
}

/// Has the install the deps-wait loop is polling for actually FINISHED, as opposed to merely
/// started?
///
/// `node_modules` existing is NOT that signal, and using it as one was the bug: both pnpm and npm
/// create the directory near the START of an install (pnpm creates the virtual store directory
/// before linking a single package; npm creates it before its first extraction), so a poll loop
/// keyed on the bare directory can break within one `DISCOVERY_INTERVAL` of the install beginning —
/// exactly the "one is still in flight" case `Installing` exists to cover, defeated by its own
/// readiness check. `<manager> run dev` then spawns against a partially populated tree and produces
/// the missing-module failure this state was built to prevent.
///
/// So this waits on each manager's own completion marker instead — a file each one writes ONCE, at
/// the end of a successful install, as its own source of truth for "is this tree consistent with
/// the lockfile": pnpm's `node_modules/.modules.yaml` (pnpm itself reads this to decide whether a
/// reinstall can be skipped) and npm's `node_modules/.package-lock.json` (npm's cached snapshot of
/// the resolved tree, rewritten once the tree matches it). Gated on `manager_for`, not
/// `is_supported()` — the caller (`needs_deps_wait`) already restricted entry to the wait to pnpm/npm,
/// so any other arm here is unreachable in production; it stays honest rather than assuming that by
/// reading as "not ready" instead of guessing.
fn deps_install_ready(cwd: &Path) -> bool {
    match crate::deps_bootstrap::manager_for(cwd) {
        Some(crate::deps_bootstrap::PackageManager::Pnpm) => cwd.join("node_modules/.modules.yaml").is_file(),
        Some(crate::deps_bootstrap::PackageManager::Npm) => cwd.join("node_modules/.package-lock.json").is_file(),
        _ => false,
    }
}

/// What the deps-wait loop found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DepsWaitOutcome {
    /// The completion marker appeared — safe to spawn the dev server now.
    Ready,
    /// A stop was requested while nothing had spawned yet.
    Stopped,
    /// The deadline passed with no marker in sight.
    TimedOut,
}

/// The deps-wait poll loop, extracted from `open_reserved` so its three outcomes are unit-testable
/// without a real filesystem, a real clock, or a real thread sleep — `open_reserved` itself needs a
/// live `AppHandle` and cannot be. `is_ready`/`now`/`sleep` are injected for exactly that: production
/// calls this with `deps_install_ready`/`Instant::now`/`std::thread::sleep(DISCOVERY_INTERVAL)`;
/// tests substitute a scripted readiness sequence and a fake clock that never actually sleeps.
fn wait_for_deps(
    stop: &AtomicBool,
    deadline: Instant,
    mut is_ready: impl FnMut() -> bool,
    mut now: impl FnMut() -> Instant,
    mut sleep: impl FnMut(),
) -> DepsWaitOutcome {
    loop {
        // A stop requested while nothing has spawned yet. `stop_one` already handles this entry
        // fine (its child is `None`, so it reports "already-stopped" and drops the map entry) —
        // this loop's job is only to notice and get out of the way rather than keep polling an
        // entry `stop_one` may be mid-removal on.
        if stop.load(Ordering::Acquire) {
            return DepsWaitOutcome::Stopped;
        }
        if is_ready() {
            return DepsWaitOutcome::Ready;
        }
        if now() >= deadline {
            return DepsWaitOutcome::TimedOut;
        }
        sleep();
    }
}

/// RE-ATTACH, OR RESERVE AND SPAWN. Blocking — callers wrap it in `spawn_blocking`.
fn open_blocking(
    app: AppHandle,
    agent_id: String,
    project_id: String,
    worktree: String,
    route: Option<String>,
    target: Option<String>,
) -> Result<PreviewOpened, String> {
    let state = app.state::<PreviewManager>();
    open_with_reservation(&state, &agent_id, |reservation| {
        open_reserved(reservation, app.clone(), agent_id.clone(), project_id, worktree, route.clone(), target.clone())
    })
}

/// Spawn the dev server and start supervising it.
///
/// TAKES THE RESERVATION AS A PARAMETER even though it does not read it: the guard is the proof that
/// this agent's start is reserved, so a caller cannot reach the spawn without holding one. The rule
/// used to be a sentence ("call ONLY while holding…"), which is exactly the kind of enforcement that
/// let the original leak in — and `open_blocking` is untestable by construction, so no test could
/// have pinned the wiring either. The type can.
fn open_reserved(
    _reservation: &StartReservation<'_>,
    app: AppHandle,
    agent_id: String,
    project_id: String,
    worktree: String,
    route_arg: Option<String>,
    target_arg: Option<String>,
) -> Result<PreviewOpened, String> {
    let app_data = crate::dev_identity::app_data_dir(&app)?;
    let real = validate_worktree(&app_data.join("worktrees"), &worktree)?;

    let cfg = crate::config::for_project(&real.to_string_lossy()).config.preview;
    // `idle_grace_min` is enforced FRONTEND-side (`services/previewIdleGrace.ts`), not here — "is a
    // human looking at this pane" is React layout state Rust has no channel to observe, and the stop
    // path it needs (`stopPreviewForAgent`) already exists. Logged so the value being read is a
    // visible fact rather than something the next agent has to infer.
    tracing::info!(idle_grace_min = cfg.idle_grace_min, "preview: idle grace configured (enforced in TS)");
    // A per-call `target`, if one was named. Empty/blank is treated as absent: an argument spelled
    // `""` is the caller not choosing, and turning that into `UnknownTarget` would refuse an open
    // that had asked for nothing in particular.
    let requested = target_arg.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let target = detect_preview_target(&real, cfg.enabled, requested).map_err(|d| d.message())?;

    // THE ROUTE IS NOT A CWD. `route_arg` is the caller's `path` — `/settings` — and it travels to
    // the URL (via the `Server` entry below), never onto the spawn directory. It used to be
    // `real.join(p)` here, and because `Path::join` with an ABSOLUTE argument replaces the base,
    // the documented call `{ op: "open", path: "/settings" }` produced cwd `/settings` and then
    // failed `validate_worktree` as "preview: invalid worktree path" — every single time. A cwd
    // subpath is `[preview].path`'s job, which `target.path` below already carries.
    let route = route_arg
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty() && is_preview_route(r))
        .unwrap_or_default()
        .to_string();
    let cwd = if target.path.is_empty() { real.clone() } else { real.join(&target.path) };
    // `target.path` can come from a hand-written `[preview].path`, so it gets the containment check.
    let cwd = validate_worktree(&app_data.join("worktrees"), &cwd.to_string_lossy())?;

    // THE ENTRY IS CREATED HERE, BEFORE THE PORT IS EVEN ALLOCATED — earlier than every previous
    // Phase-1 comment claimed ("written immediately after spawn, before readiness"), and that is the
    // whole point of the Installing state: the deps-wait below needs somewhere to publish an event
    // BEFORE there is a process to describe. `id`/`stop`/`child` are created once and reused for the
    // life of the server; the deps-wait, if it runs, updates this SAME entry rather than creating a
    // second one, so a `preview_open` retry during either phase re-attaches via `live_for_reattach`
    // instead of starting a competing install or a competing spawn.
    let id = new_id();
    let stop = Arc::new(AtomicBool::new(false));
    let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));
    // Decided BEFORE the entry is inserted, not checked-then-transitioned, so the very first event a
    // deps-waiting agent sees is `Installing` — never a `Starting` flash immediately superseded by
    // it. `deps_bootstrap::manager_for` recognizes the SAME lockfiles `bootstrapWorktreeDeps`
    // (`services/depsBootstrap.ts`) fires off at worktree-creation time — that install is
    // fire-and-forget and this module has no channel into its TS-side tracking, so this checks the
    // one thing both sides agree means "not ready yet": `node_modules` is not on disk. The common
    // case (bootstrap already finished, which is most of the time by the point anyone clicks
    // Preview) starts straight at `Starting` and never touches the deps-wait loop below at all.
    let awaiting_deps = needs_deps_wait(&cwd);
    {
        let manager = app.state::<PreviewManager>();
        manager.set_app_data(app_data.clone());
        let status = PreviewStatus {
            id: id.clone(),
            agent_id: agent_id.clone(),
            project_id: project_id.clone(),
            url: None,
            port: None,
            state: if awaiting_deps { PreviewState::Installing } else { PreviewState::Starting },
            error: None,
        };
        manager
            .lock()
            .insert(id.clone(), Server { status: status.clone(), route: route.clone(), child: Arc::clone(&child), pgid: 0, stop: Arc::clone(&stop) });
        let _ = app.emit("preview:state", status);
    }

    if awaiting_deps {
        let manager = app.state::<PreviewManager>();
        let deadline = Instant::now() + INSTALL_WAIT_TIMEOUT;
        let outcome = wait_for_deps(
            &stop,
            deadline,
            || deps_install_ready(&cwd),
            Instant::now,
            || std::thread::sleep(DISCOVERY_INTERVAL),
        );
        match outcome {
            DepsWaitOutcome::Ready => manager.transition(&app, &id, PreviewState::Starting, None, None),
            DepsWaitOutcome::Stopped => {
                return Err(format!("preview: a server for this agent is {ALREADY_STARTING}"));
            }
            DepsWaitOutcome::TimedOut => {
                // NOT "a missing node_modules usually means it failed" — that was true when this
                // waited on the bare directory, but `deps_install_ready` now waits on each manager's
                // completion marker, so `node_modules` can be fully present and this can still time
                // out (an interrupted install that created the directory and some packages but never
                // wrote pnpm's `.modules.yaml` / npm's `.package-lock.json`). Point at the install
                // rather than at a specific missing path that may not be missing.
                let msg = format!(
                    "dependencies did not finish installing within {}s — check the worktree's own \
                     install (this usually means it stalled or failed partway through, not that it \
                     is merely slow)",
                    INSTALL_WAIT_TIMEOUT.as_secs()
                );
                finish(&app, &id, PreviewState::Failed, None, Some(msg.clone()), &app_data);
                return Err(format!("preview: {msg}"));
            }
        }
    }

    // From here on, EVERY early return must clean up the entry created above — unlike Phase 1, where
    // nothing existed in the map yet at this point, so a bare `?`/`return Err` was enough.
    macro_rules! fail {
        ($msg:expr) => {{
            let msg = $msg;
            finish(&app, &id, PreviewState::Failed, None, Some(msg.clone()), &app_data);
            return Err(format!("preview: {msg}"));
        }};
    }

    let port = match target.port {
        Some(p) if !is_reserved_port(p) => p,
        Some(p) => fail!(format!(
            "this project pins port {p}, which is Sparkle's own dev port and would frame Sparkle \
             inside Sparkle"
        )),
        None => match allocate_port() {
            Ok(p) => p,
            Err(e) => fail!(e),
        },
    };
    // BUILD ARGV AND THE PORT VERDICTS TOGETHER — see `build_spawn`. TWO verdicts, because they
    // answer two different questions and only one of them may become an address:
    //   * `forced`    — Sparkle put this port on the command line. The ONLY value publishable
    //                   (status, reply) before a socket exists, because it is the only one we can
    //                   prove the child was told.
    //   * `preferred` — that, OR a `[preview].port` pin. A hint for discovery only. A pin always
    //                   arrives with no flags injected, so it is the user's assertion about where
    //                   their server binds, not a fact about what we told it.
    // A `[preview]` config override is `None` UNLESS it writes `{port}`. Without the token the
    // allocated `port` above reaches the child through no flag at all, so a URL built from it names
    // a socket nothing will ever bind; with it, the number is on the command line and publishable.
    let spawn = build_spawn(&target, port);
    let program = match resolve_program(&spawn.program) {
        Ok(p) => p,
        Err(e) => fail!(e),
    };
    let args = spawn.argv;
    let claim = spawn.claim;
    let forced = claim.forced();

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

    let mut spawned = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => fail!(format!("failed to start {program}: {e}")),
    };
    let pid = spawned.id();
    let (_out_drain, _out_thread) = crate::worktree::spawn_drain(spawned.stdout.take());
    let (err_drain, _err_thread) = crate::worktree::spawn_drain(spawned.stderr.take());

    let identity = PsIdentity.identity(pid);
    let pgid = identity.as_ref().map(|i| i.pgid).unwrap_or(pid);
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
            // The port we ASKED FOR — flags we injected, or a pin the user wrote — never the one
            // we merely allocated. `None` records the truth for a target where we asked for
            // nothing, and `bound_port` below is what discovery later fills in with the socket it
            // really took.
            requested_port: claim.port(),
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

    // ATTACH the real process to the entry created (and possibly already shown as `Installing`)
    // above, rather than inserting a second one — `id`/`child`/`stop` are the SAME instances a
    // `preview_open` re-attach during either phase would have observed.
    {
        let mut slot = child.lock().unwrap_or_else(|e| e.into_inner());
        *slot = Some(spawned);
    }
    let manager = app.state::<PreviewManager>();

    // RE-CHECK, now that the child is attached and visible to a concurrent `stop_one`. See
    // `cancel_if_stopped_during_spawn`'s own doc for why this is needed at all.
    if cancel_if_stopped_during_spawn(&child, &stop, &app_data, &id) {
        return Err(format!("preview: a server for this agent is {ALREADY_STARTING}"));
    }

    manager.set_pgid(&id, pgid);
    // The URL is knowable before the server is ready ONLY when the port was genuinely FORCED, and
    // `claim.forced()` is the fact rather than the assumption — an unforced target publishes
    // NOTHING here and waits for discovery, because a port we injected nowhere is not an address.
    // (`transition` leaves `port`/`url` untouched on `None`, so the entry keeps the `None`s it was
    // inserted with.) Discovery may still replace a forced port if the framework ignored us. State
    // stays `Starting` — this is an attribute update (port/url), not a phase change, so it reuses
    // `transition` rather than a second `insert`.
    manager.transition(&app, &id, PreviewState::Starting, forced, None);

    let supervisor_app = app.clone();
    let supervisor_id = id.clone();
    std::thread::spawn(move || {
        supervise(supervisor_app, supervisor_id, child, stop, err_drain, pid, claim, app_data);
    });

    Ok(opened_reply(id, forced, &route, PreviewState::Starting))
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
    // WHAT SPARKLE KNOWS about this child's port, straight from `Spawn::claim` — flags Sparkle
    // injected (`Forced`), a `[preview].port` the user pinned (`Preferred`), or nothing at all
    // (`Unknown`, the honest answer for an ordinary `[preview]` config override). Never an
    // allocated-but-uninjected number: that is bead `sparkle-cdq5de`.
    //
    // THE WHOLE CLAIM TRAVELS, not just the port, because `choose_listener` needs both halves: the
    // number to prefer among listening sockets, and whether it is strong enough to justify a
    // terminal refusal — which this function answers by KILLING the child. `open_reserved` keeps
    // `claim.forced()` for its own address-publishing sites.
    claim: PortClaim,
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
            match discover_port(&PsProcessTable, &LsofListenTable, pid, claim) {
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

/// Extracted from `open_reserved` so this specific race-closing check has a return value a test
/// can assert on, rather than being buried in `AppHandle`-bound control flow: `true` means a
/// concurrent `stop_one` beat the spawn to it and the caller must fail the open; `false` means the
/// spawn is clear to proceed.
///
/// `stop_one` sets `stop = true` BEFORE it does anything else, on the SAME `Arc` cloned into the
/// `Server` at insert time. So between the reservation `open_reserved` takes and the point it calls
/// this — port allocation, `resolve_program`'s login-shell PATH lookup, and `cmd.spawn()` itself,
/// none of which re-check `stop` — a stop requested in that window found `child == None`, read that
/// (correctly, at the time) as "already-stopped", and — per `stop_one`'s own contract — already
/// removed the id from `servers` AND its on-disk registry row. Without this re-check the dev server
/// that finished spawning during that window would be attached to an `Arc` no
/// `preview_stop`/`preview_stop_for_agent`/`stop_all` can reach: a live 400 MB–1 GB Node process
/// holding a port, invisible to every stop path, reapable only by the next app-launch registry
/// sweep (roborev 63963, High).
fn cancel_if_stopped_during_spawn(
    child: &Arc<Mutex<Option<Child>>>,
    stop: &AtomicBool,
    app_data: &Path,
    id: &str,
) -> bool {
    if !stop.load(Ordering::Acquire) {
        return false;
    }
    kill_now(child);
    // `stop_one` already removed the registry row it saw (before the caller ever wrote one); the
    // caller's own `registry_upsert` ran AFTER that removal and re-added a row for a process about
    // to be killed here — undo it, or the next app launch's sweep finds a row for a pid already gone.
    registry_remove(app_data, id);
    true
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
pub async fn preview_capability(worktree: String) -> Result<PreviewCapability, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // A PROJECT ROOT, not a managed worktree — see `validate_project_dir`. Detection is a
        // property of the project's own manifests, so the frontend asks with `rootPath`, which is
        // never inside `<app_data>/worktrees`.
        let real = validate_project_dir(&worktree)?;
        let enabled = crate::config::for_project(&real.to_string_lossy()).config.preview.enabled;
        // `None`: capability answers "could this worktree be previewed AT ALL", which is a
        // property of the tree rather than of one call, so it must see the project's `[preview]`
        // override exactly as an ordinary open does.
        Ok(match detect_preview_target(&real, enabled, None) {
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
    // A ROUTE on the dev server (`/settings`), not a directory — see `preview_url_with_route`.
    path: Option<String>,
    // WHICH enumerated candidate to run, for THIS call only, in a worktree where detection finds
    // more than one. It selects from the enumerated list and can do nothing else: see
    // `choose_candidate`, which is the only thing that reads it.
    target: Option<String>,
) -> Result<PreviewOpened, String> {
    tauri::async_runtime::spawn_blocking(move || open_blocking(app, agent_id, project_id, worktree, path, target))
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

    /// `path` IS A ROUTE AND IT HAS TO REACH THE URL. The documented call
    /// `{ op: "open", path: "/settings" }` used to be joined onto the SPAWN CWD instead
    /// (`real.join("/settings")`), where `Path::join` replaced the base outright and the open then
    /// failed `validate_worktree` — so the one call the agent brief instructs verbatim could never
    /// succeed, and nothing appended the route to the URL either.
    #[test]
    fn a_route_lands_on_the_url_rather_than_on_the_spawn_directory() {
        assert_eq!(preview_url_with_route(5173, "/settings"), "http://127.0.0.1:5173/settings");
        assert_eq!(preview_url_with_route(5173, "/a/b?c=1#d"), "http://127.0.0.1:5173/a/b?c=1#d");
        // No route asked for: the bare origin, byte-identical to what every earlier caller got.
        assert_eq!(preview_url_with_route(5173, ""), preview_url_for(5173));
        // …and it is still loopback with a route on it, which is what the frontend guard re-asks.
        assert!(preview_url_is_loopback(&preview_url_with_route(5173, "/settings")));
    }

    /// *** THE ORIGIN-ESCAPE HALF, AND IT IS NOT HYGIENE. *** `preview_url_with_route` builds by
    /// CONCATENATION, so a route that does not begin with `/` continues the AUTHORITY instead of
    /// starting a path: `"@evil.example"` turns `http://127.0.0.1:5173` into a URL whose host is
    /// `evil.example`. The tab case is the one a `(?![/\\])` lookahead alone misses — the WHATWG
    /// parser strips U+0009/000A/000D BEFORE parsing, so `"/\t/evil.example"` is `"//evil.example"`
    /// by the time anyone resolves it.
    ///
    /// A rejected route is DROPPED, not fatal: the preview still opens, at the origin. Every case
    /// is asserted to still be loopback, because "we refused it" and "the URL is safe" are
    /// different claims and only the second one matters.
    #[test]
    fn a_route_that_could_name_another_origin_is_refused_and_the_url_stays_loopback() {
        let hostile = [
            "@evil.example",
            "evil.example",
            "//evil.example/x",
            "/\\evil.example",
            "/\t/evil.example",
            "/\n/evil.example",
            "/\r/evil.example",
            "http://evil.example",
            "/ /evil.example",
            "/x\u{7f}y",
            "/x\u{0}y",
        ];
        for route in hostile {
            assert!(!is_preview_route(route), "{route:?} must not be accepted as a route");
            let url = preview_url_with_route(5173, route);
            assert_eq!(url, preview_url_for(5173), "{route:?} must fall back to the bare origin, got {url}");
            assert!(preview_url_is_loopback(&url), "{route:?} produced a non-loopback url: {url}");
        }
        // The paired half: an ordinary route IS accepted, so the assertions above cannot be passing
        // by the guard refusing everything.
        for route in ["/", "/settings", "/a/b", "/a?b=c", "/a#b", "/%20", "/a:b"] {
            assert!(is_preview_route(route), "{route:?} is an ordinary route and must be accepted");
        }
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
        assert_eq!(choose_listener(&listeners, PortClaim::Forced(5200)), Ok(Some(5200)));
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
            choose_listener(&found, PortClaim::Forced(port)),
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
        assert_eq!(discover_port(&procs, &listen, 100, PortClaim::Forced(5200)), Ok(Some(5200)));

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
        let err = choose_listener(&[listener(7, "[::1]:5173")], PortClaim::Unknown)
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
        assert!(choose_listener(&[listener(7, "[::1]:5173")], PortClaim::Forced(5173)).is_err());
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
        let err = choose_listener(&ls, PortClaim::Forced(5173))
            .expect_err("the REQUESTED port is v6-only; the debugger's port is not a substitute");
        assert!(err.contains("[::1]:5173"), "must name the app's address; got: {err}");

        // THE OTHER HALF: without a requested port nothing says which socket is the app, and the
        // debugger IS handed back. This pins `choose_listener`'s `None` semantics — nothing more.
        // An earlier version of this comment claimed it also guarded the CALL SITE ("rewriting it
        // to pass None shows up as this test going red"), which was false: changing `supervise`
        // cannot change what this function returns, so the test would have stayed green while the
        // pane framed a JSON blob. The call site was then guarded by making `discover_port` take a
        // bare `u16` — which held the wrong invariant, since the only value the caller could pass
        // was an allocated port it had injected nowhere (bead `sparkle-cdq5de`). `None` is
        // expressible again, and it is the CORRECT value for an unforced target; what holds the
        // call site now is provenance — `supervise` gets `Spawn::claim`, computed by the same
        // function that builds the argv — pinned by `open_reserved_publishes_only_the_forced_port`.
        //
        // (The assertion before that — `!err.contains("9229")` — could not fail at all: it ran only
        // after `expect_err` had established the value was the v6 refusal, whose only interpolation
        // is the app's own address.)
        assert_eq!(
            choose_listener(&ls, PortClaim::Unknown),
            Ok(Some(9229)),
            "with no requested port the first v4 loopback socket wins, debugger included"
        );
    }

    /// A FORCED PORT THAT HAS NOT BOUND YET, AND WHY WE ACCEPT RATHER THAN REFUSE. A driven
    /// framework's `--port` is real but slow to appear, so it matches neither list on this tick,
    /// and the two trees below are INDISTINGUISHABLE from the socket list alone.
    ///
    /// (This case used to be reached by `Framework::Unknown` as well, whose "requested" port was
    /// one the child was never told about. It no longer is — an unforced target passes `None` and
    /// takes the fall-through directly, which is bead `sparkle-cdq5de`.)
    ///
    /// A version of this refused whenever any v6-only socket was present, reading it as "the app is
    /// on v6 and unreachable". The second case is why that was reverted: refusing there kills a
    /// working dev server (`supervise` treats a refusal as terminal) and tells its owner to bind an
    /// address it is already bound to. Framing the wrong socket is recoverable; killing the server
    /// is not. Both rows are asserted so the trade-off is a decision on the record, not a default
    /// nobody chose — bead `sparkle-dnvaq` tracks identifying the app's socket properly.
    #[test]
    fn a_requested_port_that_nothing_took_falls_through_rather_than_guessing() {
        // App v6-only, an unrelated v4 socket (Node's inspector). We hand back 9229 and the pane
        // frames a JSON blob: the WRONG page, and the known cost of not guessing.
        assert_eq!(
            choose_listener(&[listener(7, "[::1]:4000"), listener(7, "127.0.0.1:9229")], PortClaim::Forced(5173)),
            Ok(Some(9229)),
            "wrong socket, but nothing is destroyed and Reload/Stop still work"
        );

        // The mirror image, and the expensive one: app on v4, a helper on a bare `localhost` that
        // Node >= 17 resolved to `[::1]`. This MUST resolve — refusing would kill it.
        assert_eq!(
            choose_listener(&[listener(7, "127.0.0.1:3000"), listener(7, "[::1]:9230")], PortClaim::Forced(5173)),
            Ok(Some(3000)),
            "a working v4 app must never be vetoed by an unidentified v6 socket"
        );

        // And with NO v4 candidate at all, the existing refusal still fires — AND THIS ONE IS
        // DESTRUCTIVE, which the two cases above are not. `supervise` treats an `Err` as terminal
        // and kills the child, so a driven framework whose forced port (5173) has simply not bound
        // yet, in a tree whose only socket so far is a helper on a bare `localhost`, is killed for
        // being slow. It is NOT the unambiguous case an earlier version of this comment claimed:
        // the v6 socket may be the app or may be a helper, and nothing here can tell (sparkle-dnvaq).
        // Pinned as the known cost of keeping the refusal, not as evidence it is right.
        let err = choose_listener(&[listener(7, "[::1]:4000")], PortClaim::Forced(5173))
            .expect_err("nothing on v4 loopback: the v6 socket is the only candidate");
        assert!(err.contains("[::1]:4000"), "must name it; got: {err}");
    }

    /// The other direction, or the refusal above would break every ordinary dual-stack server.
    /// A framework that binds BOTH reports two rows; the v4 one is usable and must win.
    #[test]
    fn a_dual_stack_server_is_accepted_on_its_v4_address() {
        assert_eq!(
            choose_listener(
                &[listener(7, "[::1]:5173"), listener(7, "127.0.0.1:5173")],
                PortClaim::Unknown
            ),
            Ok(Some(5173)),
        );
        // And with the port explicitly requested.
        assert_eq!(
            choose_listener(
                &[listener(7, "[::1]:5173"), listener(7, "127.0.0.1:5173")],
                PortClaim::Forced(5173)
            ),
            Ok(Some(5173)),
        );
    }

    /// A wildcard bind exposes the app's source maps and dev endpoints to the LAN. It is REFUSED,
    /// and the refusal NAMES the address so the pane can say what it refused.
    #[test]
    fn a_wildcard_bind_is_refused_by_name() {
        let err = choose_listener(&[listener(7, "*:3000")], PortClaim::Forced(3000))
            .expect_err("a non-loopback bind must be refused, not previewed");
        assert!(err.contains("*:3000"), "the refusal must name the offending address, got: {err}");
        // The same for an explicit all-interfaces bind, which is what `--host 0.0.0.0` produces.
        let err = choose_listener(&[listener(7, "0.0.0.0:3000")], PortClaim::Unknown).expect_err("0.0.0.0 is not loopback");
        assert!(err.contains("0.0.0.0:3000"), "got: {err}");
    }

    #[test]
    fn the_requested_port_wins_and_nothing_listening_is_not_an_error() {
        // A framework may open a second socket (HMR); the forced port is the one to frame.
        let ls = vec![listener(1, "127.0.0.1:5300"), listener(1, "127.0.0.1:5200")];
        assert_eq!(choose_listener(&ls, PortClaim::Forced(5200)), Ok(Some(5200)));
        // With no request, the lowest loopback port is a deterministic answer.
        assert_eq!(choose_listener(&ls, PortClaim::Unknown), Ok(Some(5200)));
        // Still settling is NOT a failure.
        assert_eq!(choose_listener(&[], PortClaim::Forced(5200)), Ok(None));
        // A loopback listener alongside a foreign one is fine: the foreign one is not what we frame.
        let mixed = vec![listener(1, "*:3000"), listener(1, "127.0.0.1:5200")];
        assert_eq!(choose_listener(&mixed, PortClaim::Forced(5200)), Ok(Some(5200)));
    }

    /// "We could not look" must never read as "nothing is listening" — a broken probe would
    /// otherwise present as a server that never starts.
    #[test]
    fn an_unavailable_seam_reports_pending_not_a_refusal() {
        let procs = FixedProcessTable(None);
        assert_eq!(discover_port(&procs, &FixedListenTable(None), 100, PortClaim::Forced(5200)), Ok(None));
        let procs = FixedProcessTable(Some(vec![ProcRow { pid: 100, ppid: 1, rss_bytes: 0 }]));
        assert_eq!(discover_port(&procs, &FixedListenTable(None), 100, PortClaim::Forced(5200)), Ok(None));
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
        let t = detect_preview_target(&dir, true, None).expect("a plain `dev` + next.config is the common case");
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
        let t = detect_preview_target(&dir, true, None).unwrap();
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
            let d = detect_preview_target(&dir, true, None).expect_err("not driven in Phase 1");
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
        let t = detect_preview_target(&dir, true, None).expect("an explicit override is always previewable");
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

    /// A CONFIG THAT PINS A LITERAL PORT MAKES EVERY AGENT COLLIDE, AND IT DOES SO SILENTLY — so
    /// it is refused at detection rather than honoured. This repo's own `[preview]` block carried
    /// `--port 5173` for exactly as long as it took the founder to open one agent's preview card
    /// and be served a DIFFERENT agent's app (bead `sparkle-ne230x`). Nothing anywhere reported a
    /// collision: `--no-strictPort` made vite step quietly aside to 5174, so the only symptom was
    /// the wrong UI behind the right URL.
    ///
    /// Both spellings of the flag AND the short one, because a refusal that catches two of the
    /// three ways to write the same mistake is a refusal a config can walk around by accident.
    #[test]
    fn a_constant_port_in_an_override_is_refused_and_the_message_names_the_flag() {
        for (args, flag) in [
            (r#"["exec", "vite", "--port", "5173"]"#, "--port 5173"),
            (r#"["exec", "vite", "--port=5173"]"#, "--port=5173"),
            (r#"["exec", "vite", "-p", "5173"]"#, "-p 5173"),
        ] {
            let dir = tempdir("constant-port");
            write(
                &dir.join(".sparkle").join("config.toml"),
                &format!("[preview]\ncommand = \"pnpm\"\nargs = {args}\npath = \"apps/desktop\"\n"),
            );
            let d = detect_preview_target(&dir, true, None).expect_err("a constant port must be refused");
            assert_eq!(d.code(), "constant-port-pin");
            let msg = d.message();
            assert!(msg.contains(flag), "the decline must name the offending flag `{flag}`: {msg}");
            assert!(
                msg.contains(PORT_PLACEHOLDER),
                "and must name the token to write instead, or it is a refusal nobody can act on: {msg}"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }

        // THE PAIR — without it, "refuses every override carrying a port flag" would pass too, and
        // that would make the feature unusable rather than safe. The SAME flag carrying the token
        // is the sanctioned fix and must be accepted AND forced.
        let dir = tempdir("placeholder-port");
        write(
            &dir.join(".sparkle").join("config.toml"),
            "[preview]\ncommand = \"pnpm\"\nargs = [\"exec\", \"vite\", \"--port\", \"{port}\"]\n",
        );
        let t = detect_preview_target(&dir, true, None).expect("`{port}` is the sanctioned spelling");
        assert_eq!(build_spawn(&t, 52459).claim, PortClaim::Forced(52459));
        let _ = std::fs::remove_dir_all(&dir);

        // …and an override naming no port at all is untouched: this rule fires on a pin, not on the
        // absence of one. Sparkle allocates, nothing is conveyed, and the claim stays honest.
        let dir = tempdir("no-port-flag");
        write(
            &dir.join(".sparkle").join("config.toml"),
            "[preview]\ncommand = \"bin/serve\"\nargs = [\"--dev\"]\n",
        );
        let t = detect_preview_target(&dir, true, None).expect("no port flag, nothing to refuse");
        assert_eq!(build_spawn(&t, 52459).claim, PortClaim::Unknown);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_master_switch_declines_before_any_detection_runs() {
        let dir = tempdir("disabled");
        write(&dir.join("package.json"), r#"{"scripts":{"dev":"next dev"}}"#);
        write(&dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        write(&dir.join("next.config.ts"), "export default {}\n");
        assert!(detect_preview_target(&dir, true, None).is_ok(), "…it would otherwise be previewable");
        assert_eq!(detect_preview_target(&dir, false, None).unwrap_err().code(), "disabled");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_repo_with_no_package_json_declines_rather_than_scanning() {
        let dir = tempdir("rust");
        write(&dir.join("Cargo.toml"), "[package]\nname = \"x\"\n");
        assert_eq!(detect_preview_target(&dir, true, None).unwrap_err().code(), "not-a-js-project");
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
        let t = detect_preview_target(&dir, true, None).expect("exactly one candidate is unambiguous");
        assert_eq!(t.source, "workspace-package");
        assert_eq!(t.path, "apps/site");
        assert_eq!(t.framework, Framework::Vite, "the framework is read from the PACKAGE, not the root");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// SPARKLE ITSELF MUST DECLINE, ABSENT ITS OVERRIDE. Four `dev:*` scripts at the root and no
    /// plain `dev` — guessing among them is worse than declining (§7 rule 4), and the decline has to
    /// NAME them or the user cannot act on it. Driven by the REAL root manifest, copied in, because
    /// a hand-written fixture that merely resembles it would stop testing this the moment the real
    /// scripts changed.
    #[test]
    fn sparkles_own_root_manifest_would_decline_and_name_all_four_dev_scripts() {
        // THE REAL MANIFEST, IN A TREE WITH NO `[preview]` BLOCK. This used to point straight at
        // the repo root, and went red the day this repo grew a `[preview]` override: step 1 of
        // detection reads that block BEFORE enumeration, so the repo no longer declines at all —
        // which is the POINT of the override, and is pinned by
        // `two_concurrent_previews_of_this_repo_are_handed_different_ports_on_their_command_lines`.
        // What THIS test protects is the reason the override has to exist, and that fact lives in
        // the root manifest rather than in the config: four `dev:*` scripts, no plain `dev`, so
        // enumeration cannot pick one and guessing would be worse than declining.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
        assert!(repo.join("pnpm-workspace.yaml").is_file(), "sanity: this is the Sparkle repo root");
        let dir = tempdir("sparkle-root-manifest");
        std::fs::copy(repo.join("package.json"), dir.join("package.json"))
            .expect("the real root manifest is what makes this test about Sparkle");
        let decline = detect_preview_target(&dir, true, None).expect_err("Sparkle must refuse to guess");
        assert_eq!(decline.code(), "ambiguous");
        let msg = decline.message();
        for script in ["dev:web", "dev:orchestration", "dev:desktop", "dev:mobile"] {
            assert!(msg.contains(script), "the decline must name {script}: {msg}");
        }
        // AND IT MUST NAME A REMEDY THE READER IS ALLOWED TO PERFORM. An agent's own contract
        // forbids it to edit shared checked-in config unilaterally, so a decline offering only
        // `[preview]` in .sparkle/config.toml told every agent to do the one thing it could not do
        // — the deadlock of bead `sparkle-syzpei`. The per-call form is the one that has to be
        // here; the config line stays for the human.
        assert!(
            msg.contains("{ op: \"open\", target: \"<one of those>\" }"),
            "the decline must name the per-call escape hatch verbatim, so an agent can act on it: {msg}"
        );
        assert!(
            msg.contains(".sparkle/config.toml"),
            "…without dropping the project-wide remedy a human would reach for: {msg}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------- §4b per-call `target`

    /// A workspace with TWO previewable things, which is the only situation `target` exists for.
    /// Two `dev:*` scripts at the root and one package with a plain `dev`, so enumeration finds
    /// three candidates and cannot pick.
    fn ambiguous_workspace(tag: &str) -> PathBuf {
        let dir = tempdir(tag);
        write(
            &dir.join("package.json"),
            r#"{"private":true,"scripts":{"dev:web":"vite","dev:docs":"vite"}}"#,
        );
        // NO framework config at the ROOT, on purpose: a root signature would make step 3 answer
        // before enumeration ever ran, and this fixture is about enumeration.
        write(&dir.join("pnpm-workspace.yaml"), "packages:\n  - \"apps/*\"\n");
        write(&dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        write(&dir.join("apps").join("site").join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir.join("apps").join("site").join("vite.config.ts"), "export default {}\n");
        dir
    }

    /// THE BEAD. Without a target the tree declines (that is the precondition, asserted here so the
    /// rest cannot pass by the tree having been unambiguous all along); with one, the named
    /// candidate is built — and BOTH spellings a caller has plausibly been shown resolve to it.
    #[test]
    fn a_per_call_target_picks_one_candidate_where_detection_would_otherwise_decline() {
        let dir = ambiguous_workspace("target-picks");

        let decline = detect_preview_target(&dir, true, None).expect_err("three candidates cannot be guessed");
        assert_eq!(decline.code(), "ambiguous", "the precondition: this tree is genuinely ambiguous");

        // The exact string the decline printed.
        let t = detect_preview_target(&dir, true, Some("apps/site (dev)"))
            .expect("the candidate the decline named must be selectable");
        assert_eq!(t.source, "workspace-package");
        assert_eq!(t.path, "apps/site");
        assert_eq!(t.framework, Framework::Vite, "read from the PACKAGE, as the un-targeted path does");

        // The bare package dir, which is what an agent naturally types.
        let bare = detect_preview_target(&dir, true, Some("apps/site"))
            .expect("the bare package dir is the other spelling a caller has been shown");
        assert_eq!(bare, t, "both spellings must resolve to the SAME target, not two similar ones");

        // A root `dev:*` variant, by its script name.
        let root = detect_preview_target(&dir, true, Some("dev:docs")).expect("a root dev:* is a candidate too");
        assert_eq!(root.source, "root-dev-variant");
        assert_eq!(root.path, "", "a root script runs at the root");
        assert!(root.args.iter().any(|a| a == "dev:docs"), "…and it is THAT script that runs: {:?}", root.args);
        assert!(
            !root.args.iter().any(|a| a == "dev:web"),
            "…not the other candidate, which would make the argument decorative: {:?}",
            root.args
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// (c) OF THE BEAD, AND THE REASON THE WHOLE THING WORKS. A `[preview]` block wins over
    /// enumeration for an ordinary open — but a per-call target skips it. If config always won, the
    /// argument would be INERT in every project carrying a `[preview]` block, this repo included,
    /// and the deadlock would survive its own fix. It is allowed to win because it is caller-scoped:
    /// it lives for one open and no other agent can observe it.
    #[test]
    fn a_per_call_target_skips_the_project_config_override_that_would_otherwise_win() {
        let dir = ambiguous_workspace("target-beats-config");
        write(
            &dir.join(".sparkle").join("config.toml"),
            "[preview]\ncommand = \"my-server\"\nargs = [\"--port\", \"{port}\"]\n",
        );

        // The precondition, and it is the half that makes the assertion below mean anything: with
        // no target, config wins outright and enumeration never runs.
        let configured = detect_preview_target(&dir, true, None).expect("an override is always previewable");
        assert_eq!(configured.source, "config");
        assert_eq!(configured.program, "my-server");

        let targeted = detect_preview_target(&dir, true, Some("apps/site"))
            .expect("a per-call target must reach enumeration even here");
        assert_eq!(targeted.source, "workspace-package", "config must NOT have won: {targeted:?}");
        assert_ne!(targeted.program, "my-server");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// *** THE SECURITY PROPERTY. *** `target` selects from the enumerated list and can do nothing
    /// else. A value naming no candidate is a DECLINE — never a fallback, never a spawn — so a
    /// hostile string cannot become a program, an argv entry or a path.
    ///
    /// `detect_preview_target` is the ONLY thing that reads a caller's target, and a `PreviewTarget`
    /// is the only thing `build_spawn` can turn into an argv, so `Err` here IS "nothing spawns":
    /// there is no other route from this argument to a process. Each value is asserted twice —
    /// refused, and no target produced — because the second is the one that stays true if someone
    /// later adds a fallback arm.
    #[test]
    fn a_target_naming_no_candidate_is_refused_and_can_never_reach_a_spawn() {
        let dir = ambiguous_workspace("target-hostile");
        let hostile = [
            "; rm -rf /",
            "apps/site; rm -rf /",
            "apps/site (dev) && curl evil.example",
            "../../etc",
            "../../../etc/passwd",
            "/etc/passwd",
            "/",
            "$(whoami)",
            "`id`",
            "apps/site\n dev:web",
            "",
            "   ",
            "APPS/SITE",
            "apps/site/",
            "dev:doc",
            "dev",
        ];
        for want in hostile {
            let out = detect_preview_target(&dir, true, Some(want));
            assert!(out.is_err(), "{want:?} names no candidate and must not produce a target: {out:?}");
            let decline = out.unwrap_err();
            assert_eq!(decline.code(), "unknown-target", "{want:?} must be refused BY NAME: {decline:?}");
        }

        // …and the refusal has to be actionable in one round trip: it names the value asked for AND
        // the list that would have worked. An agent that gets only "no" guesses again.
        let decline = detect_preview_target(&dir, true, Some("apps/web")).unwrap_err();
        let msg = decline.message();
        assert!(msg.contains("apps/web"), "the refusal must quote what was asked for: {msg}");
        for candidate in ["dev:docs", "dev:web", "apps/site (dev)"] {
            assert!(msg.contains(candidate), "…and name {candidate}, which WOULD have worked: {msg}");
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE ARGV IS BUILT FROM THE ENUMERATED STRING, NOT THE CALLER'S. The bare-dir spelling
    /// `apps/site` resolves to the package, and nothing the caller typed survives into the spawn —
    /// which is what makes the match a SELECTION rather than a sanitised pass-through.
    #[test]
    fn a_matched_target_spawns_the_enumerated_candidate_not_the_string_the_caller_typed() {
        let dir = ambiguous_workspace("target-argv");
        let t = detect_preview_target(&dir, true, Some("apps/site (dev)")).expect("a real candidate");
        let spawn = build_spawn(&t, 5200);
        assert_eq!(t.program, "pnpm", "the program comes from the lockfile, never from the argument");
        assert!(
            !spawn.argv.iter().any(|a| a.contains("apps/site")),
            "the caller's spelling must not appear in the argv at all: {:?}",
            spawn.argv
        );
        assert!(spawn.argv.iter().any(|a| a == "dev"), "the package's own `dev` script runs: {:?}", spawn.argv);
        assert_eq!(t.path, "apps/site", "the DIRECTORY is the enumerated path, which is a separate field");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------- §5b Installing / deps-wait

    /// A lockfile with no `node_modules` yet is exactly the case `PreviewState::Installing` exists
    /// for — this is the condition, pinned in isolation from the `AppHandle`-requiring flow around
    /// it, so it can be unit tested at all.
    #[test]
    fn a_lockfile_with_no_node_modules_needs_the_deps_wait() {
        let dir = tempdir("needs-wait");
        write(&dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        assert!(needs_deps_wait(&dir), "a lockfile with no node_modules must wait for the install");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The common case — `deps_bootstrap` already finished by the time anyone clicks Preview — must
    /// skip the wait entirely rather than re-checking an install that is already done.
    #[test]
    fn node_modules_already_present_skips_the_deps_wait() {
        let dir = tempdir("no-wait-installed");
        write(&dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        assert!(!needs_deps_wait(&dir), "node_modules already exists — nothing to wait for");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No lockfile this module drives (or none at all) is not this module's install to wait on —
    /// mirrors `deps_bootstrap::plan_for`'s own refusal to resolve a fresh graph for a project with
    /// no lockfile, or to drive a manager it does not recognize.
    #[test]
    fn no_recognized_lockfile_never_waits() {
        let dir = tempdir("no-lockfile");
        write(&dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        assert!(!needs_deps_wait(&dir), "no lockfile at all — nothing this module would have installed");
        let _ = std::fs::remove_dir_all(&dir);

        let dir2 = tempdir("unsupported-manager");
        write(&dir2.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir2.join("yarn.lock"), "# yarn lockfile v1\n");
        assert!(
            !needs_deps_wait(&dir2),
            "yarn is recognized by manager_for but is_supported() is pnpm/npm only — \
             bootstrap_worktree_deps never drives it, so waiting on its node_modules would hang \
             for the full timeout over an install that was never going to run"
        );
        let _ = std::fs::remove_dir_all(&dir2);
    }

    /// The bug this predicate exists to fix: `node_modules` appearing is NOT "the install
    /// finished" — both managers create the directory near the start of an install, so a bare
    /// directory with neither manager's completion marker must read as still-installing.
    #[test]
    fn a_bare_node_modules_directory_with_no_marker_is_not_ready() {
        let dir = tempdir("bare-node-modules");
        write(&dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        assert!(
            !deps_install_ready(&dir),
            "node_modules exists but pnpm's own completion marker does not — install is still in flight"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pnpms_own_completion_marker_is_ready() {
        let dir = tempdir("pnpm-marker");
        write(&dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        write(&dir.join("node_modules/.modules.yaml"), "hoistedDependencies: {}\n");
        assert!(deps_install_ready(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn npms_own_completion_marker_is_ready() {
        let dir = tempdir("npm-marker");
        write(&dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir.join("package-lock.json"), "{}\n");
        write(&dir.join("node_modules/.package-lock.json"), "{}\n");
        assert!(deps_install_ready(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn npms_marker_does_not_satisfy_a_pnpm_project_or_vice_versa() {
        // pnpm project, but only npm's marker is on disk (e.g. a stale directory from a manager
        // switch) — must not read as ready off the wrong manager's file.
        let dir = tempdir("pnpm-project-npm-marker");
        write(&dir.join("package.json"), r#"{"scripts":{"dev":"vite"}}"#);
        write(&dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
        write(&dir.join("node_modules/.package-lock.json"), "{}\n");
        assert!(!deps_install_ready(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `wait_for_deps`'s three outcomes, extracted from `open_reserved` precisely so they are
    /// testable without a real filesystem, clock, or thread sleep — the gap roborev 63963 named:
    /// "the timeout constant, the finish cleanup, and the stop check could each be deleted and the
    /// suite would stay green."
    #[test]
    fn wait_for_deps_returns_ready_once_is_ready_answers_true() {
        let stop = AtomicBool::new(false);
        let mut ticks = 0;
        let outcome = wait_for_deps(
            &stop,
            Instant::now() + Duration::from_secs(999), // never reached — is_ready wins first
            || {
                ticks += 1;
                ticks >= 3
            },
            Instant::now,
            || {},
        );
        assert_eq!(outcome, DepsWaitOutcome::Ready);
        assert_eq!(ticks, 3, "must have actually polled, not guessed ready on the first check");
    }

    #[test]
    fn wait_for_deps_returns_stopped_the_moment_stop_is_set_even_if_ready_would_answer_true() {
        let stop = AtomicBool::new(true);
        let outcome = wait_for_deps(
            &stop,
            Instant::now() + Duration::from_secs(999),
            || true, // would be ready immediately — stop must still win
            Instant::now,
            || {},
        );
        assert_eq!(outcome, DepsWaitOutcome::Stopped);
    }

    #[test]
    fn wait_for_deps_returns_timed_out_once_the_deadline_passes_with_no_marker() {
        let stop = AtomicBool::new(false);
        // A fake clock that starts before the deadline and crosses it after a few polls, so the
        // loop actually iterates rather than timing out on its very first check.
        let base = Instant::now();
        let deadline = base + Duration::from_secs(10);
        let mut elapsed_secs = 0u64;
        let outcome = wait_for_deps(
            &stop,
            deadline,
            || false, // never ready
            || {
                let now = base + Duration::from_secs(elapsed_secs);
                elapsed_secs += 5;
                now
            },
            || {},
        );
        assert_eq!(outcome, DepsWaitOutcome::TimedOut);
    }

    /// The High fix (roborev 63963): a `stop` that won the race against a spawn must actually kill
    /// the process and undo the registry write, not merely report `true`. A REAL spawned process,
    /// because the whole bug was the DIFFERENCE between "the map entry says stopped" and "the OS
    /// process is still running" — an assertion against a fake `Child` could not see that gap.
    #[cfg(unix)]
    #[test]
    fn cancel_if_stopped_during_spawn_kills_the_process_and_clears_the_registry_row() {
        let dir = tempdir("cancel-race-stopped");
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("sleep 30").stdout(Stdio::null()).stderr(Stdio::null());
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let spawned = cmd.spawn().expect("spawn sleep");
        let pid = spawned.id();
        let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(spawned)));
        let stop = AtomicBool::new(true); // `stop_one` already won the race before we got here

        registry_upsert(
            &dir,
            PreviewEntry {
                id: "race-id".into(),
                agent_id: "ag".into(),
                project_id: "proj".into(),
                worktree: "/tmp/does-not-matter".into(),
                requested_port: Some(5555),
                bound_port: None,
                pid,
                pgid: pid,
                pid_start_time: String::new(),
                owner_pid: std::process::id(),
                owner_epoch: "epoch".into(),
                started_at: 0,
                cmd: "sleep 30".into(),
            },
        );

        let cancelled = cancel_if_stopped_during_spawn(&child, &stop, &dir, "race-id");
        assert!(cancelled, "a stop that already fired must be reported, not silently swallowed");

        // THE LOAD-BEARING ASSERTION: the process must actually be dead, not just the map entry.
        // `kill(pid, 0)` asks the kernel rather than trusting `Child`'s own cached state (same
        // reasoning as `exited_without_reaping_reports_exit_but_leaves_the_child_waitable` in
        // worktree.rs). Polled and bounded, because a SIGKILL is not synchronous.
        let started = Instant::now();
        loop {
            let alive = unsafe { libc::kill(pid as libc::pid_t, 0) };
            if alive != 0 {
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(5), "the process was never actually killed");
            std::thread::sleep(Duration::from_millis(10));
        }

        let entries = load_registry(&dir);
        assert!(
            !entries.iter().any(|e| e.id == "race-id"),
            "the registry row written for the about-to-be-killed process must be undone"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn cancel_if_stopped_during_spawn_leaves_a_live_process_alone_when_stop_was_never_set() {
        let dir = tempdir("cancel-race-not-stopped");
        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c").arg("sleep 30").stdout(Stdio::null()).stderr(Stdio::null());
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let spawned = cmd.spawn().expect("spawn sleep");
        let pid = spawned.id();
        let child: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(Some(spawned)));
        let stop = AtomicBool::new(false);

        let cancelled = cancel_if_stopped_during_spawn(&child, &stop, &dir, "not-a-race");
        assert!(!cancelled, "no stop was requested — the normal spawn path must proceed");

        let alive = unsafe { libc::kill(pid as libc::pid_t, 0) };
        assert_eq!(alive, 0, "the process must be left running when there was no race to lose");

        // Clean up the process this test itself spawned.
        {
            let mut slot = child.lock().unwrap();
            if let Some(c) = slot.as_mut() {
                crate::proc::kill_process_group(c);
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// roborev 64017: the two tests above prove `cancel_if_stopped_during_spawn` WORKS — they call
    /// it directly — but neither proves `open_reserved` actually CALLS it. Deleting the `if
    /// cancel_if_stopped_during_spawn(…) { … }` line at its post-spawn tail would leave every other
    /// `preview::` test green while fully restoring the High-severity orphaned-server bug (the exact
    /// "defaulted/unexercised production call site" shape named in `AGENTS.md`, bead
    /// `sparkle-lgbwf`). `open_reserved` needs a live `AppHandle` and a real spawned `Child` and
    /// cannot be driven end-to-end from a unit test (documented elsewhere in this file), so this
    /// pins the call SOURCE-TEXTUALLY instead — the same technique `previewSeam.test.ts` uses across
    /// the Rust/TS boundary, applied here within one file.
    ///
    /// `include_str!` on this file's own path (relative to itself, so it resolves regardless of
    /// where the crate root is) — NOT a hand-copied excerpt, which would just be a second place for
    /// the two to drift apart.
    ///
    /// SCOPED TO `open_reserved`'S OWN BODY — not just the production half. Two earlier drafts each
    /// fixed one leak and left another (roborev 64029, then 64039, both High/Medium):
    ///
    /// 1. Scanning the WHOLE FILE matched the test module's own source (this test's body contains
    ///    the same three anchor strings — its two direct calls to the helper, and prose mentioning
    ///    `set_pgid`). Fixed by cutting at `mod tests`.
    /// 2. Scanning the whole PRODUCTION HALF (~2,300 lines) pinned nothing to `open_reserved`
    ///    itself: the three needles happening to live inside it was incidental, so a refactor that
    ///    extracted `open_reserved`'s post-spawn tail into a helper defined ANYWHERE ELSE in the
    ///    file and then forgot to call it would still find all three needles, in the same order,
    ///    and pass — while fully restoring the orphaned-server race. Fixed by narrowing to the
    ///    function's own body before searching at all.
    ///
    /// Each anchor is still found INDEPENDENTLY against that one narrowed slice, not nested inside
    /// the previous match's remainder — nesting is what made an even earlier draft's ordering assert
    /// tautological (`upsert <= cancel <= set_pgid` held by construction no matter the real order).
    #[test]
    fn open_reserved_calls_cancel_if_stopped_during_spawn_between_the_registry_write_and_set_pgid() {
        let whole = include_str!("preview.rs");
        let test_mod = whole.find("#[cfg(test)]\nmod tests {").expect(
            "preview.rs no longer carries its `#[cfg(test)] mod tests` marker — this guard cannot \
             scope itself to the production half, and an unscoped scan can be satisfied by this \
             very test's own source",
        );
        let prod = &whole[..test_mod];
        // Same discipline as `previewSeam.test.ts`'s own scoping check: both bounds are properties
        // the slice does not guarantee, so assert them rather than trust `find` succeeded silently.
        assert!(prod.len() > 1000, "the production half must not have been truncated to nothing");
        assert!(whole.len() - prod.len() > 1000, "the test module cut away must be substantial too");

        // Narrow further to `open_reserved`'s OWN body: from its signature to the next top-level
        // (zero-indent) closing brace. Every brace INSIDE the function — including the local
        // `macro_rules! fail { … }` it defines — is indented at least one level, so the first
        // `"\n}\n"` after the signature is the function's own close, not an inner block's.
        let fn_start = prod.find("fn open_reserved(").expect("open_reserved must still exist");
        let after_sig = &prod[fn_start..];
        let fn_end = after_sig
            .find("\n}\n")
            .expect("open_reserved must still have a top-level closing brace to bound the search");
        let body = &after_sig[..fn_end];
        assert!(body.len() > 500, "open_reserved's body must not have been truncated to nothing");

        // Each anchor found INDEPENDENTLY against `body`, not nested inside the previous match's
        // remainder — nesting is what made an earlier draft's ordering assert vacuous.
        let upsert = body
            .find("registry_upsert(\n        &app_data,\n        PreviewEntry {")
            .expect("open_reserved's registry_upsert call must still exist in this exact shape");
        let cancel = body
            .find("cancel_if_stopped_during_spawn(&child, &stop, &app_data, &id)")
            .expect(
                "open_reserved must still call cancel_if_stopped_during_spawn after writing the \
                 registry row it needs to be able to undo",
            );
        let set_pgid = body
            .find("manager.set_pgid(&id, pgid);")
            .expect("set_pgid must still be called after the cancel check, not before it");

        assert!(
            upsert < cancel && cancel < set_pgid,
            "call order must be registry_upsert -> cancel_if_stopped_during_spawn -> set_pgid, \
             all inside open_reserved's own body"
        );
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

    // ------------------------------------------------- §4 the port we FORCED (bead sparkle-cdq5de)

    /// A `[preview]` config-override target — exactly what this repo's own `.sparkle/config.toml`
    /// produces, and what the founder was running when his agent announced port 52459 for a dev
    /// server sitting on 5173.
    fn override_target(port: Option<u16>) -> PreviewTarget {
        PreviewTarget {
            framework: Framework::Unknown,
            program: "pnpm".into(),
            args: vec!["exec".into(), "vite".into(), "--port".into(), "5173".into()],
            needs_arg_separator: false,
            path: "apps/desktop".into(),
            source: "config",
            port,
        }
    }

    fn driven_target(framework: Framework) -> PreviewTarget {
        PreviewTarget {
            framework,
            program: "pnpm".into(),
            args: vec!["run".into(), "dev".into()],
            needs_arg_separator: false,
            path: String::new(),
            source: "test",
            port: None,
        }
    }

    /// AN ALLOCATED PORT IS NOT A FORCED PORT, and the difference is the whole bug.
    ///
    /// `Framework::Unknown` — every `[preview]` override — gets no flags from `port_args`, so an
    /// allocated ephemeral port reaches the child through NO channel: not a flag, not an env var,
    /// nothing. Publishing it produced a URL for a socket nothing will ever bind. The verdict comes
    /// back from the same call that builds the argv precisely so the two cannot disagree.
    #[test]
    fn an_unforced_target_forces_no_port_and_an_injected_one_does() {
        // The measured production case: nothing injected, no pin.
        let spawn = build_spawn(&override_target(None), 52459);
        assert_eq!(spawn.claim, PortClaim::Unknown, "nothing told the child about 52459");
        assert!(
            !spawn.argv.iter().any(|a| a == "52459"),
            "and it appears nowhere in the argv either: {:?}",
            spawn.argv
        );
        // The project's own `--port 5173` is still passed through untouched — we inject nothing,
        // we also strip nothing.
        assert_eq!(spawn.argv, vec!["exec", "vite", "--port", "5173"]);

        // A PIN IS THE USER'S OWN ASSERTION about where their server binds, and it is NOT a forced
        // port: `target.port` is `Some` only in the `[preview]` override branch, which is always
        // `Framework::Unknown`, so a pin ALWAYS arrives with nothing injected. It steers discovery
        // and is never published as an address.
        let pinned = build_spawn(&override_target(Some(5173)), 5173);
        assert_eq!(pinned.claim, PortClaim::Preferred(5173), "a pin PREFERS, it does not force");
        assert_eq!(pinned.claim.forced(), None, "so nothing may publish or refuse on it");
        assert_eq!(pinned.claim.port(), Some(5173), "but discovery may still prefer it");

        // THE CASE THAT MAKES THE DISTINCTION LOAD-BEARING: a pin whose port the argv never
        // mentions. Trusting it would publish `http://127.0.0.1:3000` for a server binding 5173 —
        // `sparkle-cdq5de` again, on the one path that could still reach it.
        let unconveyed = build_spawn(&override_target(Some(3000)), 3000);
        assert_eq!(unconveyed.claim, PortClaim::Preferred(3000));
        assert_eq!(unconveyed.claim.forced(), None);
        assert!(
            !unconveyed.argv.iter().any(|a| a == "3000"),
            "the pinned port reaches the child through no channel: {:?}",
            unconveyed.argv
        );
        assert_eq!(
            opened_reply("pv1".into(), unconveyed.claim.forced(), "", PreviewState::Starting).url,
            "",
            "so nothing may be announced for it before discovery runs"
        );

        // …and a pin for some OTHER number than the one being spawned with vouches for nothing at
        // all, not even a preference.
        let mismatched = build_spawn(&override_target(Some(5173)), 52459);
        assert_eq!(mismatched.claim, PortClaim::Unknown);

        // THE PAIR: a driven framework really does force it, and still reports it.
        for framework in [Framework::Next, Framework::Vite] {
            let spawn = build_spawn(&driven_target(framework), 5200);
            assert_eq!(spawn.claim, PortClaim::Forced(5200), "{framework:?} injects --port");
            assert_eq!(spawn.claim.forced(), Some(5200), "so it may be published and may refuse");
            let at = spawn.argv.iter().position(|a| a == "--port").expect("the flag must be there");
            assert_eq!(spawn.argv.get(at + 1).map(String::as_str), Some("5200"));
        }

        // `build_argv` is the same computation, so the two views can never drift.
        assert_eq!(build_argv(&override_target(None), 52459), build_spawn(&override_target(None), 52459).argv);
    }

    /// THE `{port}` TOKEN IS THE ONLY CHANNEL AN OVERRIDE HAS. `Framework::Unknown` — every
    /// `[preview]` override — gets no flags from `port_args`, so before this token existed a
    /// hand-written command COULD NOT BE HANDED the port Sparkle allocated at all: the number was
    /// allocated, published, and dropped on the floor by `build_spawn`.
    ///
    /// Substituted in `command` as well as in the args, and at EVERY occurrence, because a token
    /// honoured in one position and silently ignored in another is worse than no token: the config
    /// looks correct and one of the two ports is a fiction.
    #[test]
    fn the_port_token_is_substituted_in_the_command_in_every_arg_and_at_every_occurrence() {
        let target = PreviewTarget {
            framework: Framework::Unknown,
            program: "serve-on-{port}".into(),
            args: vec![
                "--port".into(),
                "{port}".into(),
                "--inspect=127.0.0.1:{port}".into(),
                "--label".into(),
                "agent-{port}-of-{port}".into(),
                "--mode".into(),
                "preview".into(),
            ],
            needs_arg_separator: false,
            path: "apps/desktop".into(),
            source: "config",
            port: None,
        };
        let spawn = build_spawn(&target, 52459);
        assert_eq!(spawn.program, "serve-on-52459", "the token is live in `command`, not only in args");
        assert_eq!(
            spawn.argv,
            vec![
                "--port".to_string(),
                "52459".to_string(),
                "--inspect=127.0.0.1:52459".to_string(),
                "--label".to_string(),
                "agent-52459-of-52459".to_string(),
                "--mode".to_string(),
                "preview".to_string(),
            ],
            "every occurrence in every arg, including two in one arg and one inside an `=` value"
        );
        assert!(
            !spawn.argv.iter().any(|a| a.contains(PORT_PLACEHOLDER)),
            "no token may survive into the argv: {:?}",
            spawn.argv
        );
    }

    /// THE PROMOTION IS THE WHOLE FEATURE. An override carrying the token has PROVABLY been handed
    /// the port — it is on the command line — so it is `Forced`, which is the one claim that may
    /// become a published address. A bare `[preview].port` pin is still only `Preferred`: the user
    /// asserting where their server binds is not Sparkle knowing what it told the child.
    #[test]
    fn an_override_carrying_the_token_forces_the_port_where_a_bare_pin_only_prefers_it() {
        let mut tokened = override_target(None);
        tokened.args = vec!["exec".into(), "vite".into(), "--port".into(), "{port}".into()];
        let spawn = build_spawn(&tokened, 52459);
        assert_eq!(spawn.claim, PortClaim::Forced(52459), "the token PROVES the child was told");
        assert_eq!(spawn.claim.forced(), Some(52459));
        assert_eq!(
            opened_reply("pv1".into(), spawn.claim.forced(), "", PreviewState::Starting).url,
            "http://127.0.0.1:52459",
            "which is exactly what makes the address publishable before a socket exists"
        );

        // THE PAIR: the same shape minus the token is the old, weaker claim, and must stay weak.
        let bare = build_spawn(&override_target(Some(5173)), 5173);
        assert_eq!(bare.claim, PortClaim::Preferred(5173), "a pin PREFERS, it does not force");
        assert_eq!(bare.claim.forced(), None);

        // A pin ALONGSIDE the token is still Forced: the token is proof, a pin is only an
        // assertion, and proof outranks it.
        let mut both = override_target(Some(4321));
        both.args = vec!["--port".into(), "{port}".into()];
        assert_eq!(build_spawn(&both, 4321).claim, PortClaim::Forced(4321));
    }

    /// REQUIREMENT 4, ASSERTED ON THE SIDE EFFECT: two agents previewing at once are handed
    /// DIFFERENT ports ON THEIR COMMAND LINES — not merely by `allocate_port`, which is where the
    /// founder's bug hid. The allocator was already correct and already returned two different
    /// numbers; `build_spawn` then threw both away and every child ran the config's hardcoded
    /// `--port 5173`. A test that stops at `allocate_port` is GREEN against that bug.
    ///
    /// Runs against THIS REPO'S OWN SHIPPED `.sparkle/config.toml`, so the config and the code are
    /// pinned by one test. A future edit that drops the token from that file fails here.
    #[test]
    fn two_concurrent_previews_of_this_repo_are_handed_different_ports_on_their_command_lines() {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..").canonicalize().unwrap();
        assert!(repo.join("pnpm-workspace.yaml").is_file(), "sanity: this is the Sparkle repo root");
        let target = detect_preview_target(&repo, true, None)
            .expect("this repo's own [preview] override must be previewable");
        assert_eq!(target.source, "config");

        // Two REAL allocations, with agent A's port held open across agent B's — otherwise this
        // asserts nothing about concurrency, only that the kernel happens to rotate.
        let a = allocate_port().expect("agent A gets a port");
        let hold = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), a))
            .expect("hold agent A's port the way its dev server would");
        let b = allocate_port().expect("agent B gets a port");
        assert_ne!(a, b, "the kernel must not offer a second agent a port that is already bound");

        let sa = build_spawn(&target, a);
        let sb = build_spawn(&target, b);
        drop(hold);

        assert_eq!(sa.claim, PortClaim::Forced(a), "agent A's port reached agent A's command line");
        assert_eq!(sb.claim, PortClaim::Forced(b), "agent B's port reached agent B's command line");
        assert!(sa.argv.iter().any(|x| x == &a.to_string()), "A's argv names A's port: {:?}", sa.argv);
        assert!(sb.argv.iter().any(|x| x == &b.to_string()), "B's argv names B's port: {:?}", sb.argv);
        assert_ne!(sa.argv, sb.argv, "two agents must not be spawned with the SAME argv");
        for (argv, other) in [(&sa.argv, b), (&sb.argv, a)] {
            assert!(
                !argv.iter().any(|x| x == &other.to_string()),
                "and neither may carry the other agent's port: {argv:?}"
            );
        }

        // THE CONSTANT THAT CAUSED THE BUG, named explicitly. `5173` on both command lines is the
        // measured production state this test exists to keep from coming back.
        for argv in [&sa.argv, &sb.argv] {
            assert!(
                !argv.iter().any(|x| x == "5173"),
                "no shared constant port may survive into a spawn: {argv:?}"
            );
        }

        // A collision must now FAIL rather than drift. `--no-strictPort` is what made the founder's
        // collision invisible: vite stepped aside to 5174 and served the wrong app behind the right
        // URL. With a per-agent port there is nothing to step aside FOR.
        assert!(
            sa.argv.iter().any(|x| x == "--strictPort"),
            "the shipped config must fail loudly on a taken port: {:?}",
            sa.argv
        );
        assert!(
            !sa.argv.iter().any(|x| x == "--no-strictPort"),
            "the silent-drift flag must be gone: {:?}",
            sa.argv
        );
    }

    /// AN UNVERIFIED PIN MAY PREFER, BUT IT MAY NOT REFUSE ON ITS OWN ACCOUNT. THE PAIR IS THE POINT.
    ///
    /// Note the qualifier, which the last two rows below are what force: the no-v4-candidate
    /// refusal at the end of `choose_listener` applies at EVERY claim level, so a pin can still end
    /// in a terminal kill. What is restricted here is the CLAIM-DRIVEN refusal.
    ///
    /// `choose_listener`'s v6-only branch returns `Err`, and `supervise` treats that as terminal:
    /// it kills the child and marks the preview `Failed`. That is correct for a port SPARKLE PUT ON
    /// THE COMMAND LINE — the app really is on it, and a v6-only bind there is unreachable. It is
    /// wrong for a `[preview].port` pin, which reaches the child through no channel at all: an
    /// unrelated helper on `[::1]:<pin>` would then kill a dev server that is healthy on v4.
    ///
    /// Both cases below see the IDENTICAL socket list. Only the provenance differs, so a gate keyed
    /// on anything else — or no gate, which is what this replaced — cannot pass both rows.
    #[test]
    fn only_a_forced_port_may_refuse_on_its_own_account_over_a_v6_only_bind() {
        // The app is healthy on v4:3000; something unrelated holds [::1]:5173.
        let tree = [listener(7, "[::1]:5173"), listener(7, "127.0.0.1:3000")];

        // FORCED: we wrote `--port 5173` ourselves, so 5173 IS the app and v6-only is the failure.
        let err = choose_listener(&tree, PortClaim::Forced(5173))
            .expect_err("a forced port bound v6-only must refuse");
        assert!(err.contains("[::1]:5173"), "and must name the address; got: {err}");

        // PREFERRED: the user asserted 5173 and we told the child nothing. Refusing here would kill
        // the working server on 3000 over a socket that may not be the app at all.
        assert_eq!(
            choose_listener(&tree, PortClaim::Preferred(5173)),
            Ok(Some(3000)),
            "an unverified pin must fall through to the v4 socket, never refuse"
        );

        // A pin that IS listening on v4 still wins — preferring is exactly what it may do.
        let bound = [listener(7, "127.0.0.1:5173"), listener(7, "127.0.0.1:3000")];
        assert_eq!(choose_listener(&bound, PortClaim::Preferred(5173)), Ok(Some(5173)));

        // THE RESIDUAL KILL PATH, ON THE RECORD RATHER THAN IMPLIED. The gate above removes the
        // CLAIM-DRIVEN refusal; it does not make a non-forced claim harmless. With NO v4 candidate
        // at all, the tail refusal fires at every level — so a pinned override whose child has not
        // bound yet, beside a helper on a bare `localhost` (Node >= 17 resolves that to `::1`),
        // still dies, over a socket that is not even the pinned port. That is bead `sparkle-dnvaq`'s
        // deliberate coin flip and is unchanged here; the docblocks say so, and this row is what
        // stops the next reader believing "may prefer, never refuse" is absolute.
        let no_v4 = [listener(7, "[::1]:9230")];
        assert!(
            choose_listener(&no_v4, PortClaim::Preferred(5173)).is_err(),
            "with nothing on v4, even an unverified pin ends in the terminal refusal"
        );
        assert!(
            choose_listener(&no_v4, PortClaim::Unknown).is_err(),
            "and so does no claim at all — the tail refusal is not claim-driven"
        );
    }

    /// THE DOCS AND THE TYPE MUST NOT DRIFT. `Spawn` carried two parallel `Option<u16>` fields
    /// before `PortClaim` replaced them, and deleting them left SEVEN docblocks describing the old
    /// model — two of which asserted the opposite of the code (roborev 67855). A comment naming a
    /// field that no longer exists is not a stale nicety here: the whole bead is about a comment
    /// that claimed a port had been forced when it had not.
    ///
    /// SCANS THE WHOLE FILE, and the `concat!` is what lets it. A first draft truncated the input at
    /// this test's own definition so the needles would not match themselves — which left the last
    /// ~550 lines, including three sibling tests and the entire registry block, structurally
    /// unscanned (roborev 67878). Splitting each needle across a `concat!` makes it absent from the
    /// source at rest, so nothing has to be excluded and there is no blind half to reason about.
    #[test]
    fn no_comment_still_describes_the_deleted_two_field_spawn() {
        let whole = include_str!("preview.rs");
        assert!(whole.len() > 100_000, "the scan must not be running against a truncated file");
        let dead = [
            concat!("Spawn", "::forced_port"),
            concat!("Spawn", "::preferred_port"),
            concat!("spawn", ".preferred_port"),
            // The unqualified over-claim this file was corrected for. It read as a guarantee the
            // code does not give: the no-v4-candidate refusal kills at every claim level.
            concat!("MAY PREFER, BUT IT ", "MAY NOT KILL"),
            // The pre-`{port}` claim that an override could never be handed a port. Writing the
            // token IS putting one on the command line, so a comment still saying this describes a
            // hole that has been closed (bead `sparkle-ne230x`).
            concat!("a pin arrives with ", "nothing injected, by construction"),
            concat!("config override `forced` is ", "`None`: the allocated"),
            // The same over-claim in its accessor-docblock spelling. The needle list is the
            // mechanism meant to stop this recurring, and it is a list of LITERAL strings — so a
            // differently-worded absolute claim passes by construction. That is exactly how the
            // sweep that retired the test name missed `PortClaim::forced()`'s own docblock.
            concat!("only one allowed to trigger a terminal ", "refusal"),
        ];
        for needle in dead {
            assert!(
                !whole.contains(needle),
                "`{needle}` is retired — the comment carrying it must be rewritten, not left behind"
            );
        }
    }

    /// WHAT THE AGENT IS ACTUALLY TOLD. `open_reserved` needs an `AppHandle` and cannot be called
    /// from a test at all, so this pins the pure decision it delegates to — the one that decides
    /// whether a URL is announced before anything has bound a socket.
    #[test]
    fn opened_reply_names_an_address_only_for_a_forced_port() {
        let unforced = opened_reply("pv1".into(), None, "", PreviewState::Starting);
        assert_eq!(unforced.url, "", "an unforced open must name no address at all");
        assert_eq!(unforced.port, 0);
        assert_eq!(unforced.state, PreviewState::Starting);
        // Specifically NOT a well-formed URL for port 0: `controlListener.handlePreview`'s guard and
        // `isLoopbackPreviewUrl` would both wave `http://127.0.0.1:0` straight through.
        assert!(!unforced.url.contains("127.0.0.1"));

        let forced = opened_reply("pv1".into(), Some(5200), "", PreviewState::Starting);
        assert_eq!(forced.url, "http://127.0.0.1:5200");
        assert_eq!(forced.port, 5200);
    }

    /// THE WIRING, because the three places the fiction escaped from are all inside a function no
    /// test can call: the `Starting` transition (which is what the pane and the card render), the
    /// `requested` argument handed to discovery (which decides `choose_listener`'s fast path), and
    /// the `PreviewOpened` reply (which is what the agent prints).
    ///
    /// Source-level, and scoped to `open_reserved`'s OWN body, for exactly the reasons the
    /// `cancel_if_stopped_during_spawn` guard above documents: an unscoped scan matches this test's
    /// own text, and a whole-file scan pins nothing to the function. Two of the three sites are also
    /// held by the compiler now (`supervise` and `discover_port` take `Option<u16>`, so the bare
    /// allocated `u16` no longer type-checks there) — this is what holds the third, `transition`,
    /// whose `Some(port)` would compile perfectly.
    #[test]
    fn open_reserved_publishes_only_the_forced_port() {
        let whole = include_str!("preview.rs");
        let test_mod = whole
            .find("#[cfg(test)]\nmod tests {")
            .expect("preview.rs no longer carries its `#[cfg(test)] mod tests` marker");
        let prod = &whole[..test_mod];
        assert!(prod.len() > 1000, "the production half must not have been truncated to nothing");
        let fn_start = prod.find("fn open_reserved(").expect("open_reserved must still exist");
        let after_sig = &prod[fn_start..];
        let fn_end = after_sig.find("\n}\n").expect("open_reserved must still have a top-level close");
        let body = &after_sig[..fn_end];
        assert!(body.len() > 500, "open_reserved's body must not have been truncated to nothing");

        assert!(
            body.contains("let spawn = build_spawn(&target, port);"),
            "the argv and the forced-port verdict must be built together"
        );
        assert!(
            body.contains("let forced = claim.forced();"),
            "and the PUBLISHABLE claim must be the value the address sites read"
        );
        assert!(
            body.contains("let claim = spawn.claim;"),
            "with the full claim kept separate for discovery"
        );
        assert!(
            body.contains("requested_port: claim.port(),"),
            "the registry records what was ASKED FOR, never the allocated port"
        );
        // THE THREE PUBLISH SITES, each named explicitly. `Some(port)` at any of them is the bug.
        assert!(
            body.contains("manager.transition(&app, &id, PreviewState::Starting, forced, None);"),
            "the Starting transition must publish the FORCED port, not the allocated one"
        );
        assert!(
            body.contains("pid, claim, app_data)"),
            "supervise/discover_port gets the CLAIM, never the port we merely allocated"
        );
        assert!(
            !body.contains("pid, port, app_data)"),
            "and never the allocated port itself"
        );
        assert!(
            body.contains("Ok(opened_reply(id, forced, &route, PreviewState::Starting))"),
            "the agent-facing reply must go through opened_reply"
        );
        // And the allocated port must not be published anywhere by name.
        assert!(
            !body.contains("Some(port), None)") && !body.contains("preview_url_for(port)"),
            "no publish site may name the allocated `port` again: {body}"
        );
    }

    // ------------------------------------------------- §4c what `supervise` can actually emit

    /// `supervise`'s OWN body, sliced the same way `open_reserved`'s is above. Shared by the two
    /// tests below so the slicing discipline — and its two asserted bounds — exists once.
    fn supervise_body() -> &'static str {
        let whole = include_str!("preview.rs");
        let test_mod = whole
            .find("#[cfg(test)]\nmod tests {")
            .expect("preview.rs no longer carries its `#[cfg(test)] mod tests` marker");
        let prod = &whole[..test_mod];
        assert!(prod.len() > 1000, "the production half must not have been truncated to nothing");
        assert!(whole.len() - prod.len() > 1000, "the test module cut away must be substantial too");
        let fn_start = prod.find("fn supervise(").expect("supervise must still exist");
        let after_sig = &prod[fn_start..];
        let fn_end = after_sig.find("\n}\n").expect("supervise must still have a top-level close");
        let body = &after_sig[..fn_end];
        assert!(body.len() > 500, "supervise's body must not have been truncated to nothing");
        body
    }

    /// *** A STRUCTURAL TEST, DELIBERATELY, AND HERE IS WHY. *** `supervise` takes a live
    /// `AppHandle` and a real `Child` and spawns no seam for either: `transition` and `finish` both
    /// go straight to `app.emit`, and `discover_port`/`http_probe` read the actual process table
    /// and the actual socket. There is no injection point to drive it through, so a behavioural
    /// test of this loop is not reachable without a refactor larger than the finding — and the
    /// function has therefore had NO test of any kind. This follows
    /// `open_reserved_calls_cancel_if_stopped_during_spawn_between_the_registry_write_and_set_pgid`
    /// directly above, which is this file's precedent for pinning an untestable function's shape
    /// against its own source.
    ///
    /// WHAT IT PINS — three verified facts about the loop's reachability graph, each of which is
    /// currently true and none of which anything else asserts:
    ///
    ///   1. The discovery/transition block is guarded by `if bound.is_none()`, so it runs AT MOST
    ///      ONCE for the life of the server. Every subsequent iteration only re-checks liveness.
    ///   2. After binding, the ONLY reachable state change is the `Crashed` finish on exit. Both
    ///      `transition` calls and both in-block `finish` calls live inside the once-only block.
    ///   3. `http_probe` is called exactly once and is NEVER retried — so a dev server that binds
    ///      its socket before it can answer HTTP LATCHES AT `Listening` FOREVER. That is a real
    ///      behaviour of this loop (see the notes at the top of this file and on `http_probe`), not
    ///      an oversight this test is smuggling in as correct; it is pinned so that a future edit
    ///      which adds a retry is a deliberate, visible change rather than an accident.
    ///
    /// It goes RED if the loop is made to re-emit, if a second transition is added after bind, or
    /// if `PreviewState::Serving` is written from here.
    #[test]
    fn supervise_binds_once_and_can_emit_nothing_further_except_the_crash() {
        let body = supervise_body();

        let guard = body.find("if bound.is_none() {").expect("the once-only guard must still exist");
        assert_eq!(
            body.matches("if bound.is_none() {").count(),
            1,
            "one guard, or 'at most once' stops being a property of the loop"
        );
        assert_eq!(
            body.matches("bound = Some(port);").count(),
            1,
            "`bound` is latched in exactly one place — a second write is a second discovery"
        );
        assert!(body.find("bound = Some(port);").unwrap() > guard, "…and it happens inside the guard");

        // 2. EVERY state change, located by position relative to the guard.
        let transitions: Vec<usize> = body.match_indices("transition(&app, &id,").map(|(i, _)| i).collect();
        assert_eq!(transitions.len(), 2, "exactly two transitions — Listening, then Ready: {transitions:?}");
        for at in &transitions {
            assert!(*at > guard, "a transition outside the once-only block would re-emit every poll");
        }
        assert!(body.contains("PreviewState::Listening, Some(port), None)"), "the first is Listening");
        assert!(body.contains("PreviewState::Ready, Some(port), None)"), "the second is Ready");

        let finishes: Vec<usize> = body.match_indices("finish(").map(|(i, _)| i).collect();
        assert_eq!(finishes.len(), 3, "exactly three terminal finishes: {finishes:?}");
        assert_eq!(
            finishes.iter().filter(|at| **at < guard).count(),
            1,
            "exactly ONE of them is reachable after binding — the `Crashed`/`Failed` exit check at \
             the top of the loop. The other two are inside the once-only block."
        );
        assert!(
            body.contains("(PreviewState::Crashed, format!(\"the dev server exited. {tail}\"))"),
            "and that one is the crash, which is the only post-bind state change there is"
        );

        // 3. ONE probe, never retried. This is what makes `Listening` a latch.
        assert_eq!(
            body.matches("http_probe(").count(),
            1,
            "a second `http_probe` call would be a retry, which this loop deliberately does not do"
        );
        assert!(body.find("http_probe(").unwrap() > guard, "…and it is inside the once-only block");

        // Nothing here may write the dead variant. See the test below for the finding.
        assert!(!body.contains("PreviewState::Serving"), "supervise must not be the thing that revives Serving");
    }

    /// A RECORDED FINDING, NOT A FIX. `PreviewState::Serving` has NO production writer anywhere:
    /// nothing in this file's production half constructs it (the one mention is
    /// `live_for_reattach`'s match arm, which READS it), and `supervise` — the only thing that
    /// advances a running server's state — stops at `Ready`. Yet both `live_for_reattach` here and
    /// `is_framable` in preview_capture.rs treat it as a live, framable state.
    ///
    /// So the variant is dead in one direction and load-bearing in the other, and this test does
    /// NOT resolve that: deleting the variant or narrowing those two predicates is a product
    /// decision about what "serving" is supposed to mean, taken by whoever owns those files. What
    /// this pins is that the situation stays VISIBLE — if someone adds a writer, the count moves
    /// and this test says so by name rather than the change landing silently.
    #[test]
    fn preview_state_serving_still_has_no_production_writer() {
        let whole = include_str!("preview.rs");
        let test_mod = whole.find("#[cfg(test)]\nmod tests {").expect("the test module marker must exist");
        let prod = &whole[..test_mod];
        assert!(prod.len() > 1000, "the production half must not have been truncated to nothing");

        let mentions: Vec<usize> = prod.match_indices("PreviewState::Serving").map(|(i, _)| i).collect();
        assert_eq!(
            mentions.len(),
            1,
            "exactly one production mention of PreviewState::Serving is expected — `live_for_reattach`'s \
             match arm, which READS it. A second mention means someone gave it a writer (good — then \
             update this test and the note on the variant) or another reader: {mentions:?}"
        );
        assert!(
            prod[mentions[0]..].starts_with("PreviewState::Serving => true,"),
            "…and that one mention is still the read in live_for_reattach"
        );

        // The behavioural half, so the finding is not purely textual: the two predicates DO treat it
        // as live today, and that is the fact that makes the missing writer worth recording.
        assert!(live_for_reattach(PreviewState::Serving), "reattach treats Serving as live — unchanged here");
        assert!(!live_for_reattach(PreviewState::Crashed), "…and the predicate is not simply always true");
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
            route: String::new(),
            child: Arc::new(Mutex::new(None)),
            pgid: 0,
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Paired with the reservation test below, and the pair is the point: this one shows a live
    /// server IS handed back (so the assertion cannot pass by nothing ever happening), the next
    /// shows an in-flight start is REFUSED rather than duplicated.
    /// `reserve_or_reattach` returns a borrow of the manager, so unwrapping it in a test needs the
    /// outcome flattened to the two things a caller cares about.
    fn reattached(out: ReserveOutcome<'_>) -> Option<PreviewOpened> {
        match out {
            ReserveOutcome::Reattached(o) => Some(o),
            ReserveOutcome::Reserved(_) => None,
        }
    }

    fn opened(port: u16) -> PreviewOpened {
        PreviewOpened {
            id: "spawned".into(),
            url: preview_url_for(port),
            port,
            state: PreviewState::Starting,
        }
    }

    #[test]
    fn a_second_open_re_attaches_to_the_agents_live_server_instead_of_spawning() {
        let mgr = PreviewManager::default();
        mgr.lock().insert("srv-1".into(), seeded("agent-1", "srv-1", 5173, PreviewState::Ready));

        let out = mgr.reserve_or_reattach("agent-1").expect("a live server is not an error");
        let out = reattached(out).expect("the caller must be handed the RUNNING server, not a reservation");
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
    fn a_start_already_in_flight_refuses_a_second_spawn() {
        let mgr = PreviewManager::default();

        let Ok(held) = mgr.reserve_or_reattach("agent-1") else { panic!("first caller spawns") };
        assert!(matches!(held, ReserveOutcome::Reserved(_)), "…with a reservation, not a re-attach");
        // The map is still EMPTY here — this is precisely the window the old check could not see.
        assert!(mgr.lock().is_empty());
        let err = match mgr.reserve_or_reattach("agent-1") {
            Err(e) => e,
            Ok(_) => panic!("the second caller must not spawn too"),
        };
        assert!(err.contains(ALREADY_STARTING), "and it must say why, in the token the frontend matches: {err}");

        // A different agent is unaffected — the reservation is per agent, not a global lock.
        assert!(matches!(mgr.reserve_or_reattach("agent-2"), Ok(ReserveOutcome::Reserved(_))));

        // Dropping the guard is what frees it — there is no release statement to call.
        drop(held);
        assert!(
            matches!(mgr.reserve_or_reattach("agent-1"), Ok(ReserveOutcome::Reserved(_))),
            "a retry must be allowed once the first start's guard is gone"
        );
    }

    /// THE HALF THAT WAS UNPINNED. The release used to be a trailing statement in `open_blocking`,
    /// which no test reached (it needs an `AppHandle`), so deleting it left every test green while
    /// wedging that agent's preview button for the session — silently, because the frontend
    /// deliberately swallows this refusal. These drive the real wiring through the same seam
    /// `open_blocking` uses.
    #[test]
    fn a_spawn_that_fails_or_panics_still_gives_the_reservation_back() {
        let mgr = PreviewManager::default();

        let err = open_with_reservation(&mgr, "agent-1", |_| Err("boom".into())).expect_err("propagates");
        assert_eq!(err, "boom", "the spawn's own error reaches the caller unchanged");
        assert!(!mgr.starting.lock().unwrap().contains("agent-1"), "an errored start must be retryable");

        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            open_with_reservation(&mgr, "agent-1", |_| panic!("the dev server spawn blew up"))
        }));
        assert!(panicked.is_err(), "the panic is not swallowed");
        assert!(
            !mgr.starting.lock().unwrap().contains("agent-1"),
            "…and unwinding released the reservation, which a trailing statement could not do"
        );

        // Still functional afterwards: the next start really does get through.
        let out = open_with_reservation(&mgr, "agent-1", |_| Ok(opened(5173))).expect("a retry runs");
        assert_eq!(out.port, 5173);
        assert!(!mgr.starting.lock().unwrap().contains("agent-1"));
    }

    /// A re-attach must NOT take a reservation — nothing would ever release it.
    #[test]
    fn re_attaching_runs_no_spawn_and_holds_no_reservation() {
        let mgr = PreviewManager::default();
        mgr.lock().insert("srv-1".into(), seeded("agent-1", "srv-1", 5173, PreviewState::Ready));

        let out = open_with_reservation(&mgr, "agent-1", |_| panic!("must not spawn")).expect("re-attaches");
        assert_eq!(out.id, "srv-1");
        assert!(!mgr.starting.lock().unwrap().contains("agent-1"));
    }

    /// A corpse is not re-attachable: answering a second click with the dead server would make the
    /// button permanently dead instead of retrying.
    #[test]
    fn a_dead_server_is_not_re_attached_but_a_live_one_is() {
        for state in [PreviewState::Failed, PreviewState::Crashed, PreviewState::Stopped] {
            let mgr = PreviewManager::default();
            mgr.lock().insert("srv-1".into(), seeded("agent-1", "srv-1", 5173, state));
            assert!(
                matches!(mgr.reserve_or_reattach("agent-1"), Ok(ReserveOutcome::Reserved(_))),
                "{state:?} must fall through to a fresh spawn"
            );
        }
        for state in [
            PreviewState::Installing,
            PreviewState::Starting,
            PreviewState::Listening,
            PreviewState::Ready,
            PreviewState::Serving,
        ] {
            let mgr = PreviewManager::default();
            mgr.lock().insert("srv-1".into(), seeded("agent-1", "srv-1", 5173, state));
            assert!(
                matches!(mgr.reserve_or_reattach("agent-1"), Ok(ReserveOutcome::Reattached(_))),
                "{state:?} must re-attach"
            );
        }
    }

    /// Pins the classification itself, so the two loops above cannot both be satisfied by a
    /// predicate that got a variant wrong in the same direction twice.
    #[test]
    fn live_for_reattach_names_every_state_exactly_once() {
        let live = [
            PreviewState::Installing,
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
        assert_eq!(live.len() + dead.len(), 8, "every PreviewState variant is classified above");
    }

    /// The wire name of a state, as an EXHAUSTIVE match. Rust cannot enumerate variants, so a
    /// hand-written array of pairs is satisfied by any 7 rows and a new variant leaves it green
    /// while the TypeScript union goes stale — and the frontend's fall-through then renders a live
    /// server as "No preview running". This match is the tie: adding a variant fails to compile
    /// here, which is the prompt to add it to `previewStore.ts`'s union too.
    fn wire_name(state: PreviewState) -> &'static str {
        match state {
            PreviewState::Installing => "installing",
            PreviewState::Starting => "starting",
            PreviewState::Listening => "listening",
            PreviewState::Ready => "ready",
            PreviewState::Serving => "serving",
            PreviewState::Failed => "failed",
            PreviewState::Crashed => "crashed",
            PreviewState::Stopped => "stopped",
        }
    }

    #[test]
    fn every_state_serializes_to_the_string_the_frontend_is_typed_against() {
        let pairs = [
            (PreviewState::Installing, "installing"),
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
            // …and the same value through the exhaustive match, so the hand-written table above
            // cannot drift from the classification a new variant is forced to join.
            assert_eq!(wire_name(state), wire);
        }
    }

    /// THE SEAM THAT WAS DEAD. `preview_capability` is asked with the project's `rootPath` — the
    /// user's own repo folder — because detection is a property of the project's manifests. That
    /// path is NEVER inside `<app_data>/worktrees`, so running the spawn path's containment check
    /// against it refused every real project: the invoke errored, the frontend recorded
    /// `previewable: false`, and every preview affordance was permanently absent, in every session,
    /// with only a `console.debug`. Both halves were green; only the seam was broken.
    ///
    /// The two validators are asserted TOGETHER on one path, which is the only way to state the
    /// distinction: the read-only probe accepts a plain project directory that the spawn path
    /// refuses, and the spawn path's refusal is still intact.
    #[test]
    fn a_project_root_passes_the_read_only_probe_and_is_still_refused_by_the_spawn_path() {
        let dir = std::env::temp_dir().join(format!("sparkle-preview-root-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.to_string_lossy().to_string();

        let probed = validate_project_dir(&path).expect("a project root is a legitimate thing to READ");
        assert_eq!(probed, std::fs::canonicalize(&dir).unwrap(), "…canonicalized");

        // The same path through the spawn path's check, whose base it is not under.
        let managed = std::env::temp_dir().join(format!("sparkle-preview-wts-{}", new_id()));
        std::fs::create_dir_all(&managed).unwrap();
        let err = validate_worktree(&managed, &path)
            .expect_err("spawning a process in an arbitrary directory is still refused");
        assert!(err.contains("outside the managed worktrees directory"), "got: {err}");

        // And a non-directory is not a project root either.
        let file = dir.join("package.json");
        std::fs::write(&file, "{}").unwrap();
        assert!(validate_project_dir(&file.to_string_lossy()).is_err(), "a file is not a project");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&managed);
    }

    /// DRIVES THE COMMAND, which is the only thing that pins WHICH validator it uses. The test
    /// above asserts the two validators disagree; it does not assert `preview_capability` picked
    /// the read-only one, so reverting that single line restored the bug verbatim with all 42 tests
    /// green — the "production call site untested by construction" shape (`sparkle-lgbwf`). Removing
    /// the `AppHandle` parameter is what made this reachable: it is now a plain `async fn(String)`.
    #[test]
    fn preview_capability_answers_for_a_real_project_root() {
        let dir = std::env::temp_dir().join(format!("sparkle-preview-cap-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        // A single-package Vite app: the shape §7 says is the common case.
        std::fs::write(
            dir.join("package.json"),
            r#"{"name":"probe-fixture","scripts":{"dev":"vite"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("vite.config.ts"), "export default {}\n").unwrap();
        // A LOCKFILE IS PART OF THE CONTRACT, not fixture noise: detection declines a repo it cannot
        // pick a package manager for, and this test found that out by failing with that exact
        // decline. Naming pnpm here is also what makes the argument-separator path deterministic.
        std::fs::write(dir.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'\n").unwrap();

        let cap = tauri::async_runtime::block_on(preview_capability(dir.to_string_lossy().to_string()))
            .expect("a project root is a legitimate thing to probe");
        assert!(
            cap.previewable,
            "the probe must ANSWER for a path shaped like a real rootPath; decline was {:?}",
            cap.decline_reason
        );

        let _ = std::fs::remove_dir_all(&dir);
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
