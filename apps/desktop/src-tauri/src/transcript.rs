//! Read Claude Code's session transcript (, History Search Task C).
//!
//! Claude Code writes each session to a JSONL file (one JSON record per line) under
//! `~/.claude/projects/<slug>/<session>.jsonl`. Assistant turns are records with
//! `type:"assistant"` and a `message.content` array of blocks — `{type:"text", text}` plus
//! tool-use blocks. The Stop hook hands us the transcript path; we read back the LAST assistant
//! message's text so the History store can persist the Build agent's response.
//!
//! Tolerant by design: a missing/unreadable file returns `Err`, and partial/malformed lines are
//! skipped rather than panicking (the file may be mid-write when Stop fires).

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use serde_json::Value;

/// How far back from EOF we read on the first pass. Transcripts are appended, so the last
/// assistant record is almost always within the final few KB; a single 64 KB tail read covers
/// even long final turns without loading the whole (potentially many-MB) JSONL into memory.
const TAIL_CHUNK: u64 = 64 * 1024;
/// Hard cap on how much of the tail we're willing to buffer while searching backward. If no
/// assistant record is found within this window we give up rather than reading the entire file
/// (bounds worst-case memory/latency on a pathological transcript with a huge trailing turn).
const MAX_TAIL: u64 = 4 * 1024 * 1024;

/// Read the transcript at `path` and return the joined text of its LAST assistant message.
/// `Err` if the file can't be read; an empty string if it has no assistant text.
///
/// `async` + `spawn_blocking`: the bounded tail read + UTF-8 decode + JSONL scan is blocking work
/// that fires on EVERY agent turn-end (the Stop hook). Running it inline on the Tauri event-loop
/// thread would stall the whole UI; the blocking pool keeps it off the event loop. The sync core
/// lives in `read_transcript_last_assistant_sync` so the unit tests can drive it without a runtime.
#[tauri::command]
pub async fn read_transcript_last_assistant(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_transcript_last_assistant_sync(path))
        .await
        .map_err(|e| format!("read_transcript_last_assistant task failed: {e}"))?
}

/// Blocking core of [`read_transcript_last_assistant`]: open the file and tail-read the last
/// assistant record. Kept synchronous (and free of any Tauri runtime) so the unit tests exercise it
/// directly. The bounded-read logic lives entirely in `read_last_assistant_from_tail`.
fn read_transcript_last_assistant_sync(path: String) -> Result<String, String> {
    let mut file = File::open(&path).map_err(|e| format!("read {path}: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("read {path}: {e}"))?
        .len();
    read_last_assistant_from_tail(&mut file, len).map_err(|e| format!("read {path}: {e}"))
}

/// Read the tail of `file` backward in growing chunks, returning the joined text of the last
/// assistant record. Only the final window (up to `MAX_TAIL`) is ever loaded, so a huge transcript
/// costs one bounded read instead of a full slurp. We grow the window (64 KB → … → `MAX_TAIL`)
/// until the buffer starts at a line boundary AND contains an assistant record, guaranteeing we
/// never parse a partial first line as if it were complete.
fn read_last_assistant_from_tail(
    file: &mut (impl Read + Seek),
    len: u64,
) -> std::io::Result<String> {
    let mut window = TAIL_CHUNK.min(len.max(1));
    loop {
        let start = len.saturating_sub(window);
        file.seek(SeekFrom::Start(start))?;
        // Read raw bytes and decode lossily. When `start > 0` the window can begin in the middle
        // of a multi-byte UTF-8 sequence; `read_to_string` would fail with `InvalidData` on any
        // transcript whose non-ASCII char (smart quotes, emoji, CJK, accents) straddles the
        // boundary, failing this hot-path command intermittently. The broken leading bytes always
        // fall inside the partial first line we drop below, so lossy replacement is safe here.
        let mut bytes = Vec::new();
        file.take(len - start).read_to_end(&mut bytes)?;
        let buf = String::from_utf8_lossy(&bytes);

        // If `start > 0` the first line is (probably) truncated — it began before our window. Drop
        // it so we never treat a partial record as complete. When `start == 0` we have the whole
        // file and the first line is genuine, so keep it.
        let slice = if start > 0 {
            match buf.find('\n') {
                Some(i) => &buf[i + 1..],
                None => "", // window landed mid-line with no boundary — force a wider read
            }
        } else {
            &buf[..]
        };

        if let Some(text) = last_assistant_text_opt(slice) {
            return Ok(text);
        }

        // Not found (or no line boundary yet). Grow the window and retry; stop once we've covered
        // the whole file or hit the cap.
        if start == 0 || window >= MAX_TAIL {
            return Ok(String::new());
        }
        window = (window.saturating_mul(2)).min(MAX_TAIL).min(len);
    }
}

/// Pure core: given a chunk of JSONL transcript text, return the joined text of the last assistant
/// record, or `None` if the chunk contains no (parseable) assistant record. Scans lines from the
/// end so we stop at the first (newest) assistant turn. Text blocks are joined with blank lines;
/// tool-use (and any non-text) blocks are skipped. The `None` vs `Some("")` distinction lets the
/// tail reader tell "assistant not in this window, read more" apart from "assistant with no text".
fn last_assistant_text_opt(jsonl: &str) -> Option<String> {
    for line in jsonl.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // A half-written tail line (Stop can fire mid-flush) just doesn't parse — skip it.
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if is_assistant(&v) {
            return Some(join_text_blocks(&v));
        }
    }
    None
}

/// Convenience wrapper over [`last_assistant_text_opt`] that flattens "no assistant record" to the
/// empty string. Used by the tests (which pass whole transcripts).
#[cfg(test)]
fn last_assistant_text(jsonl: &str) -> String {
    last_assistant_text_opt(jsonl).unwrap_or_default()
}

/// True when a record is an assistant turn. Checks both the top-level `type` and the nested
/// `message.role` so we stay tolerant of minor schema variations across Claude Code versions.
fn is_assistant(v: &Value) -> bool {
    v.get("type").and_then(Value::as_str) == Some("assistant")
        || v.get("message").and_then(|m| m.get("role")).and_then(Value::as_str) == Some("assistant")
}

/// Join the `text` of every `{type:"text"}` block in `message.content`, skipping tool-use and
/// other block kinds. Defensive: a string `content` is returned as-is; anything else → "".
fn join_text_blocks(v: &Value) -> String {
    let content = match v.get("message").and_then(|m| m.get("content")) {
        Some(c) => c,
        None => return String::new(),
    };
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    let texts: Vec<&str> = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    texts.join("\n\n")
}

// ===========================================================================================
// Mounted-agent transcript reader — paging (`agent_transcript_page`) + tailing
// (`agent_transcript_tail`).
//
// The concierge pane, when mounted to a build agent, renders THAT AGENT'S conversation. The
// source of truth is the same JSONL Claude Code writes above, but the scale is different: one
// agent's worktree accrues 150+ session files totalling 70+ MB, with single files past 29 MB.
// So every read here is bounded — by records, by bytes, and by what crosses the IPC boundary.
//
// Two layers, deliberately split:
//   * Rust does STRUCTURE — record `type`, `isSidechain`/`isMeta`, tool_result-only turns,
//     `promptSource` provenance, block kinds, tool-run folding.
//   * TypeScript does SEMANTICS — `apps/desktop/src/engine/agentOriginated.ts` owns the marker
//     strings (auto-resume banner, goal-expiry banner, `<task-notification>`) and has a
//     round-trip test binding them to the code that GENERATES them. Duplicating those strings
//     here would recreate exactly the drift that module exists to prevent, so we do not filter
//     by message text — see `auto_resume_banner_survives_rust_filter`.
// ===========================================================================================

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Per-entry cap on the verbatim JSONL handed back in `raw`. `raw` is only a "view raw" escape
/// hatch, and a single assistant turn can be hundreds of KB; without this a page of 40 entries
/// could put megabytes on the IPC boundary for a feature nobody opened.
const MAX_RAW_BYTES: usize = 16 * 1024;

/// Cap on `ActivityItem::target` / `ActivityItem::detail`. A `Bash` command or a tool result can
/// be arbitrarily long; the activity row shows one line.
const MAX_ITEM_CHARS: usize = 200;

/// Bytes one page will pull from a single session file per read chunk. Chunks are read
/// newest-record-first and stitched, so this bounds peak memory per read, not per page.
const CHUNK_BYTES: u64 = 1024 * 1024;

/// Total bytes one page will pull from a single session file before giving up and returning a
/// cursor. Reaching this is pathological (it means ~8 MB of records folded to fewer than `limit`
/// entries); the caller just pages again from the returned cursor.
const MAX_PAGE_BYTES: u64 = 8 * 1024 * 1024;

/// Bytes one `agent_transcript_tail` poll will read. A poll normally sees a few KB of new
/// records; this only matters for a caller starting at byte 0 of a huge file, which then walks
/// forward one bounded poll at a time instead of slurping 29 MB into a Tauri response.
const MAX_TAIL_READ: u64 = 8 * 1024 * 1024;

/// Upper bound on `limit`, so a frontend bug cannot ask for a whole 70 MB history in one IPC call.
const MAX_PAGE_LIMIT: usize = 500;

/// How far `agent_transcript_tail` will rewind to re-read an in-flight tool run whole. Past this,
/// the run is emitted as-is (possibly split) rather than re-read on every poll forever.
const MAX_INFLIGHT_RUN_BYTES: u64 = 256 * 1024;

/// Position of a single record inside a single session file. `before` is EXCLUSIVE: paging with
/// `before = c` yields records with `line < c.line` in `c.file`, then older files.
///
/// `line` is a 0-based RECORD index (not a byte offset) so it survives the frontend's JSON number
/// round-trip and reads sensibly in a debugger.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    /// Absolute path of the session file.
    pub file: String,
    /// 0-based index of the record within that file.
    pub line: usize,
}

/// One folded tool call inside an [`Entry::Activity`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    /// Human verb for the tool (`read`, `edited`, `ran`, …); the raw tool name when unmapped.
    pub verb: String,
    /// The file path / command / pattern the call acted on, from the `tool_use` input.
    pub target: String,
    /// One line of the matching `tool_result`, when it happened to be in the same window.
    pub detail: String,
}

/// One renderable turn. `kind` discriminates on the wire (`human` / `agent` / `activity`).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Entry {
    /// A real human turn. `prompt_source` is carried through verbatim (including `None`, which
    /// older Claude Code versions and slash commands both produce) so the TypeScript layer can
    /// mark provenance without re-reading the transcript.
    #[serde(rename_all = "camelCase")]
    Human {
        id: String,
        text: String,
        timestamp: String,
        session_id: String,
        prompt_source: Option<String>,
        raw: String,
        cursor: Cursor,
    },
    /// An assistant text turn. `thinking` blocks are dropped.
    #[serde(rename_all = "camelCase")]
    Agent {
        id: String,
        text: String,
        timestamp: String,
        session_id: String,
        raw: String,
        cursor: Cursor,
    },
    /// A folded run of consecutive tool calls. `timestamp` is the run's first record,
    /// `end_timestamp` its last.
    #[serde(rename_all = "camelCase")]
    Activity {
        id: String,
        summary: String,
        items: Vec<ActivityItem>,
        timestamp: String,
        end_timestamp: String,
        session_id: String,
        raw: String,
        cursor: Cursor,
    },
}

impl Entry {
    /// The record timestamp entries are globally ordered by. ISO-8601 with a fixed-width date and
    /// a `Z` suffix, so a lexicographic compare IS a chronological compare.
    fn timestamp(&self) -> &str {
        match self {
            Entry::Human { timestamp, .. }
            | Entry::Agent { timestamp, .. }
            | Entry::Activity { timestamp, .. } => timestamp,
        }
    }

    #[cfg(test)]
    fn cursor(&self) -> &Cursor {
        match self {
            Entry::Human { cursor, .. }
            | Entry::Agent { cursor, .. }
            | Entry::Activity { cursor, .. } => cursor,
        }
    }

    #[cfg(test)]
    fn id(&self) -> &str {
        match self {
            Entry::Human { id, .. } | Entry::Agent { id, .. } | Entry::Activity { id, .. } => id,
        }
    }

    #[cfg(test)]
    fn text(&self) -> &str {
        match self {
            Entry::Human { text, .. } | Entry::Agent { text, .. } => text,
            Entry::Activity { summary, .. } => summary,
        }
    }
}

/// One backwards page of an agent's conversation.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    /// Ordered OLDEST → NEWEST by record timestamp **within this page**. NOT by file — sessions
    /// resume and interleave, so mtime is a wrong ordering.
    ///
    /// THIS IS A PER-PAGE GUARANTEE, NOT A GLOBAL ONE, and the caller must finish the job. The
    /// paging frontier is necessarily file-ordered (a `Cursor` names one file and one record in
    /// it), while sessions overlap in TIME: a real worktree right now has a session spanning
    /// 04:31→05:20:02 sitting at mtime rank 2 behind one spanning 05:19:59→05:22:09. Page 1 drains
    /// the first file; page 2 reaches into the second and legitimately contains records NEWER than
    /// page 1's oldest. Each page is internally sorted; concatenating pages is not.
    ///
    /// So the frontend must merge-sort accumulated pages by `timestamp` rather than prepending
    /// them — which it has to do anyway, since `agent_transcript_tail` appends into the same list.
    /// Making this global in Rust would mean either dropping the mandated `Cursor {file, line}`
    /// shape for a per-file frontier set, or opening every candidate session to peek at its newest
    /// timestamp — which costs the "a first page opens ONE file" property this design is built on.
    /// (roborev 56332)
    pub entries: Vec<Entry>,
    /// Feed back as `before` to page further backwards. `None` = start of history.
    pub next: Option<Cursor>,
    pub has_more: bool,
    /// How many of the directory's `*.jsonl` files are THIS AGENT'S (the candidate set, after the
    /// session filter). Not the directory's size: a worktree's session directory holds every
    /// `claude` that ever ran there, and only the agent's own sessions are candidates. `0` when the
    /// agent→session binding is unknown, which is also the only case that yields no `tail_file`
    /// alongside a directory that is not empty.
    pub sessions_scanned: usize,
    /// How many of those were actually opened. A first page should be 1.
    pub files_opened: usize,
    /// WHERE THE LIVE TAIL SHOULD START: the newest session file, and its length at page time.
    ///
    /// Carried on the PAGE because the alternative is a first `agent_transcript_tail(from_byte: 0)`
    /// that re-reads the whole newest session just to find its end — routinely multi-MB (29 MB
    /// measured), which would undo the point of a bounded reader on every mount. One round trip
    /// establishes both the history and the live cursor. `None`/`0` when the agent has no sessions.
    pub tail_file: Option<String>,
    pub tail_byte: u64,
}

/// New records appended to the newest session file since `from_byte`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptTail {
    pub entries: Vec<Entry>,
    /// The file these came from, returned EVERY time so the caller can notice a new session
    /// started (the newest file by mtime changed) and reset its offset.
    pub file: String,
    /// Where to resume. Never advances past a trailing partial line, so the next poll re-reads
    /// that line once it is complete.
    pub next_byte: u64,
}

// ---------------------------------------------------------------------------
// Session directory resolution
// ---------------------------------------------------------------------------

/// The directory Claude Code stores this worktree's transcripts in.
///
/// Composed from `claude.rs`'s own pieces on purpose — the slug rule (every non-ASCII-alphanumeric
/// char becomes `-`, which is what makes the SPACE in `Library/Application Support` work) and the
/// config-dir precedence (explicit account wins, empty counts as unset, else `$HOME/.claude`) both
/// live there. Re-deriving either here is how a reader ends up pointed at a different account's
/// history than the spawn used.
fn session_dir(worktree_path: &str, config_dir: Option<&str>) -> Option<PathBuf> {
    let env = std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);
    let config_dir = crate::claude::resolve_session_config_dir(config_dir, env);
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let root = crate::claude::claude_projects_root(config_dir.as_deref(), home.as_deref())?;
    Some(crate::claude::claude_session_dir_for(&root, worktree_path))
}

/// Every `*.jsonl` regular file in `dir`, newest mtime first.
///
/// METADATA ONLY — we never open a file to decide ordering. mtime is a good FILE-SELECTION
/// heuristic (the live session is the one being written) and a WRONG ordering one, which is why
/// the emitted entries are re-sorted by record timestamp afterwards.
fn session_files_by_mtime_desc(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_jsonl = path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
            && entry.file_type().map(|t| t.is_file()).unwrap_or(false);
        if !is_jsonl {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        files.push((mtime, path));
    }
    // Newest first; path as a deterministic tie-break so equal mtimes don't reorder between calls
    // (which would make a cursor's file position unstable mid-page).
    files.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    files.into_iter().map(|(_, p)| p).collect()
}

/// The session id a Claude Code transcript file belongs to: its file STEM.
///
/// Claude Code names each session's log `<session_id>.jsonl`, so the stem IS the id — no open
/// required, which is what lets the filter below stay metadata-only.
fn session_id_of(path: &Path) -> Option<&str> {
    path.file_stem().and_then(|s| s.to_str())
}

/// THE AGENT'S OWN session files in `dir`, newest mtime first — or `None` when we do not know which
/// sessions are the agent's.
///
/// ── WHY THIS EXISTS AT ALL, AND WHY IT FAILS CLOSED ──────────────────────────────────────────────
/// A session DIRECTORY is keyed by WORKTREE, never by agent. Every `claude` that has ever run in
/// that directory has a file in it — the interactive agent, each restart, every background one-shot,
/// every OTHER agent the app pointed at the same tree. Measured on this machine: the Improve Sparkle
/// worktree's directory holds 1,172 `*.jsonl` files, the main checkout 98, a busy agent worktree 41.
///
/// The reader used to take `files.first()` and page from there — i.e. render whichever session in
/// the directory had the newest mtime, with no agent id and no session id reaching the read at any
/// point. So a pane whose footer said "Chatting with Sparkle" rendered a DIFFERENT agent's roborev
/// review, because that agent's session happened to be the one being written. That is the defect
/// this function removes: any directory with more than one file could render the wrong conversation.
///
/// `None` means the agent→session binding is UNKNOWN, and it returns `None` rather than falling back
/// to "whatever is newest" — the fallback IS the bug. Showing someone else's conversation under this
/// agent's name is far worse than showing nothing, so an unknown binding renders an honest empty
/// pane. (Same convention as `agentId: null` in AGENTS.md: null is UNKNOWN, never "none".)
///
/// ── FILE-LEVEL, NOT RECORD-LEVEL, AND THAT IS DELIBERATE ─────────────────────────────────────────
/// Every `Entry` also carries the `sessionId` off its own record, so filtering the RECORDS was the
/// obvious alternative. It is wrong, and in the one direction that matters most here: when Claude
/// Code resumes a session it writes the prior conversation into the NEW session's file with the
/// records' ORIGINAL `sessionId` preserved. A record-level filter would therefore drop exactly the
/// resumed history the founder mounted the pane to read — the "drops history on resume" failure that
/// makes a single-id binding unacceptable in the first place. A file's stem answers a different and
/// better question: is this file one of THIS AGENT'S session logs? If it is, everything in it is
/// this agent's conversation, including the part it inherited.
///
/// It also keeps the load-bearing performance property intact. Filtering is metadata-only, so a
/// first page still opens exactly ONE file even in the 1,172-file directory; a record-level filter
/// would have to open candidates until it accumulated `limit` surviving entries, which in a
/// directory full of other agents' sessions is a scan of the whole directory.
fn own_session_files(dir: &Path, session_ids: Option<&[String]>) -> Option<Vec<PathBuf>> {
    let ids = session_ids?;
    let mut files = session_files_by_mtime_desc(dir);
    files.retain(|p| session_id_of(p).is_some_and(|id| ids.iter().any(|want| want == id)));
    Some(files)
}

// ---------------------------------------------------------------------------
// Line index — record index ⇄ byte offset
// ---------------------------------------------------------------------------

/// Byte offset of the start of every COMPLETE record in a file, plus how far we have scanned.
///
/// `starts.len()` is the record count; `scanned_to` is the offset just past the last complete
/// record, i.e. the start of any trailing partial line. Keeping `scanned_to` separate is what lets
/// an append be indexed incrementally: a partial line that later completes is re-scanned from its
/// own start, never skipped.
#[derive(Default, Clone)]
struct LineIndex {
    starts: Vec<u64>,
    scanned_to: u64,
}

/// Scan `file` from `idx.scanned_to` to `len`, appending the offsets of newly-complete records.
///
/// Chunked with a fixed buffer, so peak memory is the buffer — not the file. A file that SHRANK
/// (truncated/rotated) invalidates the index and is rescanned from 0.
fn extend_line_index(file: &mut File, idx: &mut LineIndex, len: u64) -> std::io::Result<()> {
    if len < idx.scanned_to {
        *idx = LineIndex::default();
    }
    if len <= idx.scanned_to {
        return Ok(());
    }
    file.seek(SeekFrom::Start(idx.scanned_to))?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut pos = idx.scanned_to;
    let mut line_start = idx.scanned_to;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for (i, b) in buf[..n].iter().enumerate() {
            if *b == b'\n' {
                idx.starts.push(line_start);
                line_start = pos + i as u64 + 1;
            }
        }
        pos += n as u64;
    }
    idx.scanned_to = line_start;
    Ok(())
}

/// [`extend_line_index`] behind a small process-global cache keyed by path.
///
/// Building the index is one sequential pass over the file, which for a 29 MB transcript is real
/// I/O to repeat on every page or every 2-second tail poll. The cache makes the steady state
/// O(bytes appended). Correct for an APPEND-ONLY file, which a Claude Code transcript is; a file
/// that shrinks is detected and rebuilt, and a file rewritten in place at the same length is the
/// one case this would get wrong (Claude Code never does that).
fn cached_line_index(path: &Path, file: &mut File, len: u64) -> std::io::Result<LineIndex> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<HashMap<PathBuf, LineIndex>>> =
        std::sync::OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let mut idx = cache
        .lock()
        .ok()
        .and_then(|m| m.get(path).cloned())
        .unwrap_or_default();
    extend_line_index(file, &mut idx, len)?;
    if let Ok(mut map) = cache.lock() {
        // Bounded: an agent has one live session, so a handful of hot files is the real working
        // set. Clearing wholesale (rather than evicting) keeps this to three lines; the cost of a
        // miss is one rescan.
        if map.len() >= 16 && !map.contains_key(path) {
            map.clear();
        }
        map.insert(path.to_path_buf(), idx.clone());
    }
    Ok(idx)
}

// ---------------------------------------------------------------------------
// Record parsing + the structural filter
// ---------------------------------------------------------------------------

/// A parsed JSONL record together with its absolute record index and verbatim line.
struct RawRecord {
    index: usize,
    line: String,
    v: Value,
}

/// One tool call lifted out of an assistant record's `tool_use` block.
struct ToolCall {
    name: String,
    id: String,
    input: Value,
}

/// What the structural filter made of a record.
enum RecordKind {
    /// Not renderable: wrong `type`, a sidechain/meta record, a tool_result-only user turn, an
    /// injected agent prompt, a harness notification, or a local-command wrapper artifact.
    Drop,
    Human {
        text: String,
        prompt_source: Option<String>,
    },
    Assistant {
        text: Option<String>,
        tools: Vec<ToolCall>,
    },
}

/// Parse a slice of JSONL into records, numbering them from `first_index`.
///
/// A line that does not parse is SKIPPED, never treated as complete — the file may be mid-write,
/// and the last line of a live transcript is routinely half-flushed. The index still advances for
/// skipped lines so record indices stay aligned with the file's own line numbering.
fn parse_records(text: &str, first_index: usize) -> Vec<RawRecord> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        out.push(RawRecord {
            index: first_index + i,
            line: trimmed.to_string(),
            v,
        });
    }
    out
}

/// The `type` values that carry actual conversation. EVERYTHING ELSE IS METADATA.
///
/// Allowlisting (rather than blocking the types we happen to have seen) is deliberate:
/// `attachment`, `last-prompt`, `permission-mode`, `mode`, `queue-operation`, `pr-link`, `system`,
/// `file-history-delta` and `file-history-snapshot` were 618 of 1741 records in one 4.2 MB session,
/// and **the list grows with every Claude Code release** — the vocabulary is Claude Code's, not
/// Sparkle's, so a blocklist is stale the moment it is written.
///
/// `pub(crate)` because `claude.rs` asks the same question for a different purpose — "does this
/// transcript hold a conversation at all, or is it a metadata-only file we must not resume into?"
/// Two copies of this rule would drift, and the drift would be silent in exactly the direction that
/// hurts: a type missing from one copy reads as conversation there and metadata here.
pub(crate) const CONVERSATION_TYPES: &[&str] = &["user", "assistant"];

/// How many lines from the START of a transcript we sniff for the first human turn.
///
/// Set from the same measurement that set [`crate::claude`]'s `SNIFF_LINES`: across 400 sampled
/// real transcripts the first `user`/`assistant` record was at line 12 at the WORST, median 8. 64
/// is >5x that worst case and bounds the read so this never walks a multi-MB file.
pub(crate) const FIRST_PROMPT_SNIFF_LINES: usize = 64;

/// The text of the FIRST human-role turn in the transcript at `path`, or None.
///
/// STRUCTURE ONLY — this deliberately does not look at what the text SAYS. It reuses [`classify`],
/// so a sidechain, an `isMeta` injection, a tool_result-only turn, an `sdk`/`system` prompt source
/// and a `<local-command-*>` wrapper are all dropped by the same rule the renderer uses, and cannot
/// drift from it. Judging the text is the caller's job and, per this module's header, TypeScript's:
/// `engine/agentOriginated.ts` owns the marker strings.
///
/// ── WHY THE *FIRST* TURN, AND WHY ANYONE WANTS IT ────────────────────────────────────────────
/// Claude Code derives a session's `ai-title` on the first turn and then re-emits that same value
/// verbatim forever (measured 58/58 in [`crate::claude::latest_ai_title_in`]'s notes). So the first
/// human turn is the title's BASIS: if Sparkle's own automated ping is what opened the transcript,
/// every title that session will ever report was summarized from Sparkle talking to itself, and the
/// staleness is permanent — a human typing later does not retitle it. Callers that adopt a title as
/// a NAME need that provenance, which is why this is read alongside the title rather than inferred
/// from the title's wording (the wording varies: "Sparkle-nudge #8", "Resume sparkle-nudge task",
/// and — for 39 measured sessions — nothing recognisable at all).
///
/// Best-effort: an unreadable file, a malformed line, or no human turn inside the sniff window all
/// yield None. None means "no evidence", NOT "the transcript is clean" — see the caller for which
/// direction that has to fail in.
pub(crate) fn first_human_prompt_in(path: &Path, max_lines: usize) -> Option<String> {
    use std::io::BufRead;
    let file = File::open(path).ok()?;
    for line in std::io::BufReader::new(file).lines().take(max_lines) {
        let Ok(line) = line else { return None }; // a read error is no evidence, not a clean file
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(trimmed) else {
            continue; // half-flushed line: skip it, keep looking
        };
        if let RecordKind::Human { text, .. } = classify(&v) {
            return Some(text);
        }
    }
    None
}

/// The structural filter. An ALLOWLIST on `type` (see [`CONVERSATION_TYPES`]), then per-role
/// structural drops.
fn classify(v: &Value) -> RecordKind {
    let ty = v.get("type").and_then(Value::as_str).unwrap_or_default();
    if !CONVERSATION_TYPES.contains(&ty) {
        return RecordKind::Drop;
    }
    // A subagent's inner transcript — somebody else's conversation, not this agent's.
    if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
        return RecordKind::Drop;
    }
    // Skill injections, `<local-command-caveat>`, "Continue from where you left off."
    if v.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return RecordKind::Drop;
    }
    if ty == "user" {
        classify_user(v)
    } else {
        classify_assistant(v)
    }
}

/// User-role structural filter. 816 of 869 user records across 20 real sessions were tool results.
fn classify_user(v: &Value) -> RecordKind {
    if v.get("toolUseResult").is_some() {
        return RecordKind::Drop;
    }
    let content = v.get("message").and_then(|m| m.get("content"));
    if let Some(arr) = content.and_then(Value::as_array) {
        if !arr.is_empty()
            && arr
                .iter()
                .all(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
        {
            return RecordKind::Drop;
        }
    }
    let prompt_source = v.get("promptSource").and_then(Value::as_str);
    match prompt_source {
        // An injected agent prompt ("You are a code reviewer…") belonging to a DIFFERENT `claude`
        // process that shares this worktree.
        Some("sdk") => return RecordKind::Drop,
        // Harness `<task-notification>` blocks.
        Some("system") => return RecordKind::Drop,
        // KEEP "typed" and KEEP the ABSENT case. Older Claude Code versions omit the field, and
        // slash commands (`/compact`, `/goal`) arrive without it — allowlisting strictly on
        // "typed" silently drops real human turns from older sessions.
        _ => {}
    }
    let text = join_content_text(content);
    let head = text.trim_start();
    if head.starts_with("<local-command-stdout>") || head.starts_with("<local-command-caveat>") {
        return RecordKind::Drop;
    }
    if text.trim().is_empty() {
        // Nothing renderable (e.g. an image-only turn). Structural, not textual.
        return RecordKind::Drop;
    }
    RecordKind::Human {
        text,
        prompt_source: prompt_source.map(str::to_string),
    }
}

/// Assistant-role structural filter. `message.content` is an array of single-kind blocks; we keep
/// `text` and `tool_use` and drop everything else (notably `thinking`).
fn classify_assistant(v: &Value) -> RecordKind {
    let content = v.get("message").and_then(|m| m.get("content"));
    let Some(blocks) = content.and_then(Value::as_array) else {
        return match content.and_then(Value::as_str) {
            Some(s) if !s.trim().is_empty() => RecordKind::Assistant {
                text: Some(s.to_string()),
                tools: Vec::new(),
            },
            _ => RecordKind::Drop,
        };
    };
    let mut texts: Vec<&str> = Vec::new();
    let mut tools = Vec::new();
    for b in blocks {
        match b.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(t) = b.get("text").and_then(Value::as_str) {
                    if !t.trim().is_empty() {
                        texts.push(t);
                    }
                }
            }
            Some("tool_use") => tools.push(ToolCall {
                name: b
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                id: b
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                input: b.get("input").cloned().unwrap_or(Value::Null),
            }),
            // `thinking`, `redacted_thinking`, and anything a future release adds.
            _ => {}
        }
    }
    if texts.is_empty() && tools.is_empty() {
        return RecordKind::Drop;
    }
    RecordKind::Assistant {
        text: (!texts.is_empty()).then(|| texts.join("\n\n")),
        tools,
    }
}

/// Join the `text` of a `message.content` value, tolerating the string form older records use.
fn join_content_text(content: Option<&Value>) -> String {
    let Some(content) = content else {
        return String::new();
    };
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n\n")
}

// ---------------------------------------------------------------------------
// Folding records into entries
// ---------------------------------------------------------------------------

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Truncate on a char boundary, marking the cut. Byte-limited (the cap exists to bound IPC size).
fn cap_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = s[..end].to_string();
    out.push('…');
    out
}

/// Truncate to `max` CHARS, for the short display fields.
fn cap_chars(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// Human verb for a tool name; the raw name (e.g. `mcp__linear__create_issue`) when unmapped, so
/// a tool we have never seen still reads as something rather than vanishing.
fn verb_for(name: &str) -> &str {
    match name {
        "Read" | "NotebookRead" => "read",
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => "edited",
        "Bash" => "ran",
        "Grep" | "Glob" => "searched",
        other => other,
    }
}

/// Plural noun pairing with a verb in a counted summary phrase ("read 3 files").
fn noun_for(verb: &str) -> &str {
    match verb {
        "read" | "edited" => "files",
        "ran" => "commands",
        "searched" => "searches",
        _ => "calls",
    }
}

/// The thing a call acted on, from its `tool_use` input.
fn target_for(name: &str, input: &Value) -> String {
    let preferred = match name {
        "Bash" => "command",
        "Read" | "Edit" | "Write" | "MultiEdit" | "NotebookEdit" | "NotebookRead" => "file_path",
        "Grep" | "Glob" => "pattern",
        _ => "",
    };
    if !preferred.is_empty() {
        if let Some(s) = input.get(preferred).and_then(Value::as_str) {
            return cap_chars(s, MAX_ITEM_CHARS);
        }
    }
    for key in [
        "file_path",
        "path",
        "command",
        "pattern",
        "query",
        "url",
        "description",
        "prompt",
    ] {
        if let Some(s) = input.get(key).and_then(Value::as_str) {
            return cap_chars(s, MAX_ITEM_CHARS);
        }
    }
    String::new()
}

/// Shorten a target for the one-line summary: basename of a path, first word of a command.
fn short_target(target: &str) -> String {
    let first = target.split_whitespace().next().unwrap_or_default();
    let base = first.rsplit('/').next().unwrap_or(first);
    cap_chars(base, 40)
}

/// A short verbed, counted phrase over a run's calls, e.g. `read 3 files · edited retry.ts · ran cargo`.
/// Verbs appear in first-use order so the phrase reads chronologically.
fn build_summary(items: &[ActivityItem]) -> String {
    let mut order: Vec<&str> = Vec::new();
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut first_target: HashMap<&str, &str> = HashMap::new();
    for item in items {
        let verb = item.verb.as_str();
        if !counts.contains_key(verb) {
            order.push(verb);
            first_target.insert(verb, item.target.as_str());
        }
        *counts.entry(verb).or_insert(0) += 1;
    }
    order
        .iter()
        .map(|verb| {
            let n = counts[verb];
            if n == 1 {
                let t = short_target(first_target[verb]);
                if t.is_empty() {
                    format!("{verb} 1 {}", noun_for(verb))
                } else {
                    format!("{verb} {t}")
                }
            } else {
                format!("{verb} {n} {}", noun_for(verb))
            }
        })
        .collect::<Vec<_>>()
        .join(" · ")
}

/// Map `tool_use_id` → a one-line result, for any `tool_result` block in this window.
///
/// Best-effort by design: the matching result may live outside the window we read, in which case
/// `detail` is simply empty. We scan every record (including ones the filter drops) because the
/// results live precisely in the tool_result-only user turns the filter throws away.
/// Is the LAST tool run in this window still running?
///
/// True when some `tool_use` in the trailing run has no matching `tool_result` anywhere in the
/// window. Claude Code writes a call's result as a later record, so a missing result means the call
/// has not come back yet — the run will grow, and the tail should re-read it whole next poll rather
/// than emit a fragment.
///
/// False for a run whose results are all present, INCLUDING the run a session ended on. That
/// distinction is the whole point: rewinding on an ended run pins the read offset forever (see the
/// call site in `transcript_tail_sync`).
fn trailing_run_is_in_flight(recs: &[RawRecord]) -> bool {
    let results = collect_tool_results(recs);
    // Walk back over the trailing run — the maximal suffix of records contributing tool calls,
    // ignoring the tool_result-only turns interleaved between them.
    for r in recs.iter().rev() {
        match classify(&r.v) {
            RecordKind::Assistant { tools, .. } if !tools.is_empty() => {
                if tools.iter().any(|t| !results.contains_key(&t.id)) {
                    return true;
                }
            }
            // A tool_result-only turn sits BETWEEN a run's calls; it does not end the run.
            RecordKind::Drop => continue,
            // Any renderable non-tool record (a human turn, an assistant text turn) is the run's
            // upper boundary — everything before it belongs to an earlier run.
            _ => break,
        }
    }
    false
}

fn collect_tool_results(recs: &[RawRecord]) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for r in recs {
        let Some(blocks) = r
            .v
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for b in blocks {
            if b.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = b.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            let text = tool_result_text(b)
                .or_else(|| r.v.get("toolUseResult").and_then(Value::as_str).map(str::to_string));
            if let Some(text) = text {
                let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or_default();
                map.insert(id.to_string(), cap_chars(line, MAX_ITEM_CHARS));
            }
        }
    }
    map
}

fn tool_result_text(block: &Value) -> Option<String> {
    let content = block.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let parts: Vec<&str> = content
        .as_array()?
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// Fold a window of records into renderable entries, oldest → newest in FILE order.
///
/// A maximal run of consecutive `tool_use` records collapses into ONE [`Entry::Activity`]. Only an
/// agent text turn or a human turn breaks a run — records the filter DROPS do not, because the
/// tool_result user turns that carry each call's output sit between the calls in every real
/// transcript, and letting them break the run would produce one Activity per tool call.
fn build_entries(file: &str, recs: &[RawRecord]) -> Vec<Entry> {
    let results = collect_tool_results(recs);
    let mut out: Vec<Entry> = Vec::new();
    let mut run: Vec<(usize, ToolCall)> = Vec::new();

    for (pos, r) in recs.iter().enumerate() {
        match classify(&r.v) {
            RecordKind::Drop => {}
            RecordKind::Human {
                text,
                prompt_source,
            } => {
                flush_run(file, recs, &mut run, &results, &mut out);
                out.push(Entry::Human {
                    id: str_field(&r.v, "uuid"),
                    text,
                    timestamp: str_field(&r.v, "timestamp"),
                    session_id: str_field(&r.v, "sessionId"),
                    prompt_source,
                    raw: cap_bytes(&r.line, MAX_RAW_BYTES),
                    cursor: Cursor {
                        file: file.to_string(),
                        line: r.index,
                    },
                });
            }
            RecordKind::Assistant { text, tools } => {
                if let Some(text) = text {
                    flush_run(file, recs, &mut run, &results, &mut out);
                    out.push(Entry::Agent {
                        id: str_field(&r.v, "uuid"),
                        text,
                        timestamp: str_field(&r.v, "timestamp"),
                        session_id: str_field(&r.v, "sessionId"),
                        raw: cap_bytes(&r.line, MAX_RAW_BYTES),
                        cursor: Cursor {
                            file: file.to_string(),
                            line: r.index,
                        },
                    });
                }
                for call in tools {
                    run.push((pos, call));
                }
            }
        }
    }
    flush_run(file, recs, &mut run, &results, &mut out);
    out
}

/// Emit the pending tool run (if any) as a single [`Entry::Activity`].
fn flush_run(
    file: &str,
    recs: &[RawRecord],
    run: &mut Vec<(usize, ToolCall)>,
    results: &HashMap<String, String>,
    out: &mut Vec<Entry>,
) {
    if run.is_empty() {
        return;
    }
    let calls = std::mem::take(run);
    let first = &recs[calls[0].0];
    let last = &recs[calls[calls.len() - 1].0];

    let items: Vec<ActivityItem> = calls
        .iter()
        .map(|(_, c)| ActivityItem {
            verb: verb_for(&c.name).to_string(),
            target: target_for(&c.name, &c.input),
            detail: results.get(&c.id).cloned().unwrap_or_default(),
        })
        .collect();

    // One record can carry several tool_use blocks; join each contributing record's line ONCE.
    let mut raw = String::new();
    let mut seen = Vec::new();
    for (pos, _) in &calls {
        if seen.contains(pos) {
            continue;
        }
        seen.push(*pos);
        if !raw.is_empty() {
            raw.push('\n');
        }
        raw.push_str(&recs[*pos].line);
    }

    out.push(Entry::Activity {
        id: str_field(&first.v, "uuid"),
        summary: build_summary(&items),
        items,
        timestamp: str_field(&first.v, "timestamp"),
        end_timestamp: str_field(&last.v, "timestamp"),
        session_id: str_field(&first.v, "sessionId"),
        raw: cap_bytes(&raw, MAX_RAW_BYTES),
        cursor: Cursor {
            file: file.to_string(),
            line: first.index,
        },
    });
}

// ---------------------------------------------------------------------------
// Paging one file
// ---------------------------------------------------------------------------

/// What one file contributed to a page.
struct FileSlice {
    /// At most `want` entries, the NEWEST ones below the requested bound, in file order.
    entries: Vec<Entry>,
    /// `Some(k)` = records with index `< k` in this file are still unread. `None` = fully consumed.
    frontier: Option<usize>,
}

/// Read backwards through one session file until `want` entries are folded (or the file / the byte
/// budget is exhausted).
///
/// The line index turns a record bound into an exact byte offset, so every chunk begins on a real
/// record boundary — there is no partial-first-line to discard, unlike the EOF-anchored
/// [`read_last_assistant_from_tail`] above which cannot know where lines start.
///
/// Chunks are stitched as RECORDS and folded once at the end. Folding per chunk would split a
/// tool run that straddles a chunk boundary into two Activity entries; collecting first means the
/// only boundary that can mis-fold is the window's OLDEST entry — which is discarded whenever the
/// window did not reach record 0, and re-read whole on the next page.
fn page_from_file(path: &Path, upper: Option<usize>, want: usize) -> std::io::Result<FileSlice> {
    page_from_file_with(path, upper, want, CHUNK_BYTES, MAX_PAGE_BYTES)
}

/// [`page_from_file`] with its byte budgets injected.
///
/// The budgets exist so the chunk loop can be TESTED. With the production values (1 MB per chunk,
/// 8 MB total) no fixture small enough to keep the suite fast will ever take a second lap, so the
/// stitching, the geometric span growth, the `CHUNK_BYTES` clamp and the budget bail would all be
/// dead code in the suite — and they are precisely the paths a 29 MB transcript hits.
fn page_from_file_with(
    path: &Path,
    upper: Option<usize>,
    want: usize,
    chunk_bytes: u64,
    max_page_bytes: u64,
) -> std::io::Result<FileSlice> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    let idx = cached_line_index(path, &mut file, len)?;
    let total = idx.starts.len();
    let upper = upper.unwrap_or(total).min(total);
    if upper == 0 || want == 0 {
        return Ok(FileSlice {
            entries: Vec::new(),
            frontier: None,
        });
    }
    let file_str = path.to_string_lossy().into_owned();

    let mut recs: Vec<RawRecord> = Vec::new();
    let mut entries: Vec<Entry> = Vec::new();
    let mut hi = upper;
    let mut bytes_read: u64 = 0;
    // Records per chunk. ~4 records per renderable entry is what the structural filter costs on
    // real transcripts (tool_use + its tool_result + the assistant wrapper); the chunk grows
    // geometrically if that guess is low.
    let mut span = want.saturating_mul(4).max(64);

    while hi > 0 {
        let chunk_end = if hi >= total {
            idx.scanned_to
        } else {
            idx.starts[hi]
        };
        // Never read more than CHUNK_BYTES in one go — but always at least one record, so a single
        // oversized record (a giant tool result) is its own chunk rather than stalling the walk.
        let byte_floor = idx
            .starts
            .partition_point(|&s| s < chunk_end.saturating_sub(chunk_bytes));
        let lo = hi.saturating_sub(span).max(byte_floor).min(hi - 1);
        let start = idx.starts[lo];

        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        file.by_ref().take(chunk_end - start).read_to_end(&mut bytes)?;
        bytes_read += bytes.len() as u64;
        // Lossy: a chunk always starts on a record boundary, so this can only replace bytes inside
        // a record that was already invalid UTF-8 on disk.
        let text = String::from_utf8_lossy(&bytes);

        let mut chunk = parse_records(&text, lo);
        chunk.append(&mut recs);
        recs = chunk;
        entries = build_entries(&file_str, &recs);
        hi = lo;

        if lo == 0 || entries.len() > want || bytes_read >= max_page_bytes {
            break;
        }
        span = span.saturating_mul(4);
    }

    // Two independent reasons to drop entries off the FRONT, and they must not be conflated:
    //
    //  1. `want` is a hard cap and always applies — reaching record 0 does not entitle a page to
    //     overshoot. (Folding them into one condition made a first page return the whole file.)
    //  2. If the window did NOT reach record 0, its oldest entry is additionally SUSPECT: a tool
    //     run that began before `hi` is folded short, and the missing calls would reappear as a
    //     second Activity on the next page. Discarding it means the next page re-reads the run
    //     whole. This used to happen only on the trim path, which left the byte-budget bail
    //     returning exactly the mis-fold the trim exists to absorb (roborev 56332).
    let reached_start = hi == 0;
    let trimmed = entries.len() > want;
    if trimmed {
        entries.drain(..entries.len() - want);
    } else if !reached_start && entries.len() > 1 {
        entries.remove(0);
        // `entries.len() <= 1` is left alone: dropping it would hand back an empty page and stall
        // a caller with no way to tell "nothing here" from "budget exhausted". Only reachable via
        // the byte-budget bail (8 MB of records folding to one entry), and the frontier below still
        // advances, so the caller keeps making progress.
    }
    // The oldest entry we KEPT bounds what the caller has seen. Exclusive, so re-paging from it can
    // neither overlap nor skip. Only a file we walked to record 0 without trimming is finished.
    let frontier = if reached_start && !trimmed {
        None
    } else {
        entries
            .first()
            .map(|e| match e {
                Entry::Human { cursor, .. }
                | Entry::Agent { cursor, .. }
                | Entry::Activity { cursor, .. } => cursor.line,
            })
            // No entries survived the window at all — resume below everything we read.
            .or(Some(hi))
    };
    // A frontier at record 0 means "nothing below" — normalise it away so the caller advances to
    // the next file instead of spending an open proving 0 records exist.
    let frontier = frontier.filter(|&k| k > 0);

    Ok(FileSlice { entries, frontier })
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// One backwards page of the conversation in `worktree_path`.
///
/// `before` is an EXCLUSIVE upper bound (pass back the previous page's `next`); `None` starts at
/// the newest turn. Files are selected newest-mtime-first and read tail-first, so a first page
/// typically opens exactly ONE file even when the worktree has 156 sessions and 70 MB of history.
///
/// `async` + `spawn_blocking`, mandatory: a sync `#[tauri::command]` body runs on the MAIN thread,
/// and this one does directory scans plus multi-MB reads. `assert_async_command` in the tests
/// holds the shape at compile time.
/// `session_ids` NAMES WHOSE CONVERSATION THIS IS, and `None` renders nothing. A session directory
/// belongs to a WORKTREE, so it holds every `claude` that ever ran there; without this the read
/// returned whichever session had the newest mtime, under the mounted agent's name. See
/// [`own_session_files`] for the full reasoning and why an unknown binding must not fall back.
#[tauri::command]
pub async fn agent_transcript_page(
    worktree_path: String,
    config_dir: Option<String>,
    before: Option<Cursor>,
    limit: usize,
    session_ids: Option<Vec<String>>,
) -> Result<TranscriptPage, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transcript_page_sync(
            &worktree_path,
            config_dir.as_deref(),
            before,
            limit,
            session_ids.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("agent_transcript_page task failed: {e}"))?
}

/// Blocking core of [`agent_transcript_page`], driven directly by the tests.
fn transcript_page_sync(
    worktree_path: &str,
    config_dir: Option<&str>,
    before: Option<Cursor>,
    limit: usize,
    session_ids: Option<&[String]>,
) -> Result<TranscriptPage, String> {
    let dir = session_dir(worktree_path, config_dir)
        .ok_or_else(|| "no Claude projects root: neither CLAUDE_CONFIG_DIR nor HOME is set".to_string())?;
    // UNKNOWN binding → an empty page, never the newest stranger in the directory. Reported as a
    // page with nothing in it and no tail anchor, so the caller renders its ordinary empty state and
    // the live tail has nowhere to start.
    let Some(files) = own_session_files(&dir, session_ids) else {
        return Ok(TranscriptPage {
            entries: Vec::new(),
            next: None,
            has_more: false,
            sessions_scanned: 0,
            files_opened: 0,
            tail_file: None,
            tail_byte: 0,
        });
    };
    let sessions_scanned = files.len();
    let limit = limit.clamp(1, MAX_PAGE_LIMIT);

    let start = match &before {
        Some(c) => match files.iter().position(|p| p.to_string_lossy() == c.file) {
            Some(i) => i,
            // The anchor file is gone (deleted, or the account/worktree changed under us). Report
            // an empty end-of-history rather than silently restarting from the newest turn, which
            // would loop the caller forever.
            None => {
                return Ok(TranscriptPage {
                    entries: Vec::new(),
                    next: None,
                    has_more: false,
                    sessions_scanned,
                    files_opened: 0,
                    tail_file: None,
                    tail_byte: 0,
                })
            }
        },
        None => 0,
    };

    let mut collected: Vec<Entry> = Vec::new();
    let mut files_opened = 0usize;
    let mut next: Option<Cursor> = None;

    for (i, path) in files.iter().enumerate().skip(start) {
        let upper = if i == start {
            before.as_ref().map(|c| c.line)
        } else {
            None
        };
        let want = limit - collected.len();
        let Ok(slice) = page_from_file(path, upper, want) else {
            // An unreadable session file must not sink the whole pane; skip it.
            continue;
        };
        files_opened += 1;
        let mut merged = slice.entries;
        merged.append(&mut collected);
        collected = merged;

        if let Some(line) = slice.frontier {
            next = Some(Cursor {
                file: path.to_string_lossy().into_owned(),
                line,
            });
            break;
        }
        if collected.len() >= limit {
            // This file is fully consumed; older files may still hold history. Anchoring at
            // `line: 0` of the consumed file costs one cheap open next time (its index is cached)
            // and keeps the cursor a small, JSON-safe number.
            if i + 1 < files.len() {
                next = Some(Cursor {
                    file: path.to_string_lossy().into_owned(),
                    line: 0,
                });
            }
            break;
        }
    }

    // Order by RECORD TIMESTAMP, not by file. Sessions resume and interleave, so mtime is a good
    // file-selection heuristic and a wrong ordering one. Stable sort keeps same-timestamp records
    // in file order. Computed AFTER `next`, which must stay a file-order frontier.
    collected.sort_by(|a, b| a.timestamp().cmp(b.timestamp()));

    // The live edge, taken from the file list we already have — metadata only, nothing reopened.
    // `files` is mtime-descending, so the newest session is the head.
    let (tail_file, tail_byte) = match files.first() {
        Some(p) => (
            Some(p.to_string_lossy().into_owned()),
            std::fs::metadata(p).map(|m| m.len()).unwrap_or(0),
        ),
        None => (None, 0),
    };

    Ok(TranscriptPage {
        entries: collected,
        has_more: next.is_some(),
        next,
        sessions_scanned,
        files_opened,
        tail_file,
        tail_byte,
    })
}

/// New records appended to the agent's NEWEST session file since `from_byte`.
///
/// Returns the resolved `file` every time: when a new session starts it becomes the newest by
/// mtime, and the caller compares paths to know its offset belongs to a different file. A
/// `from_byte` past EOF (rotated/truncated file) restarts from 0 rather than erroring.
///
/// `async` + `spawn_blocking` for the same reason as [`agent_transcript_page`].
/// `session_ids` NAMES WHOSE CONVERSATION THIS IS — same rule and same stakes as
/// [`agent_transcript_page`], and it matters here for a second reason: "the newest session file" is
/// the tail's whole file-selection strategy, so an unfiltered tail follows whichever OTHER agent in
/// the worktree is being written to right now. `None` returns nothing rather than borrowing it.
#[tauri::command]
pub async fn agent_transcript_tail(
    worktree_path: String,
    config_dir: Option<String>,
    from_byte: u64,
    // `from_file`: the file `from_byte` was measured in, or `None` to trust the offset against
    // whatever is newest. See `transcript_tail_sync` for why an offset without its file is unsafe.
    from_file: Option<String>,
    session_ids: Option<Vec<String>>,
) -> Result<TranscriptTail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transcript_tail_sync(
            &worktree_path,
            config_dir.as_deref(),
            from_byte,
            from_file.as_deref(),
            session_ids.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("agent_transcript_tail task failed: {e}"))?
}

/// Blocking core of [`agent_transcript_tail`], driven directly by the tests.
fn transcript_tail_sync(
    worktree_path: &str,
    config_dir: Option<&str>,
    from_byte: u64,
    from_file: Option<&str>,
    session_ids: Option<&[String]>,
) -> Result<TranscriptTail, String> {
    let dir = session_dir(worktree_path, config_dir)
        .ok_or_else(|| "no Claude projects root: neither CLAUDE_CONFIG_DIR nor HOME is set".to_string())?;
    // UNKNOWN binding → follow nothing. Identical shape to "the agent has no sessions yet", which is
    // the honest answer in both cases: we have no file we can attribute to this agent.
    let files = own_session_files(&dir, session_ids).unwrap_or_default();
    let Some(path) = files.first() else {
        return Ok(TranscriptTail {
            entries: Vec::new(),
            file: String::new(),
            next_byte: 0,
        });
    };
    let file_str = path.to_string_lossy().into_owned();
    let mut file = File::open(path).map_err(|e| format!("read {file_str}: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("read {file_str}: {e}"))?
        .len();

    // The line index also tells us the absolute record index at `from_byte`, so tail entries carry
    // cursors that are valid `before` bounds for `agent_transcript_page`.
    let idx = cached_line_index(path, &mut file, len).map_err(|e| format!("read {file_str}: {e}"))?;

    // WHICH FILE THE OFFSET BELONGS TO, checked before the offset is trusted at all.
    //
    // The caller's `from_byte` was measured in whatever file was newest LAST poll. An agent that is
    // restarted (or resumed with `--continue`) starts a brand-new `<uuid>.jsonl`, which immediately
    // becomes the newest by mtime — so the very next poll resolves a DIFFERENT file and the old
    // offset means nothing in it. The past-EOF guard below does not cover this: a new session that
    // has already grown past the old offset is not past EOF, so the read would silently seek into
    // the middle of it and skip every record before that point. Those records are then missing from
    // the pane until it is remounted, and nothing reports an error.
    //
    // So a file change restarts from 0. `from_file` is `None` on the first poll after a page load,
    // which is exactly when the caller has no prior file to claim and the offset came from the page.
    let rotated = from_file.is_some_and(|f| f != file_str);
    // Past EOF means the file was truncated under us — restart rather than error.
    let from = if rotated || from_byte > len { 0 } else { from_byte };
    let span = (len - from).min(MAX_TAIL_READ);
    file.seek(SeekFrom::Start(from))
        .map_err(|e| format!("read {file_str}: {e}"))?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(span)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read {file_str}: {e}"))?;

    // Drop a trailing partial line and do NOT count its bytes, so the next poll re-reads it once
    // the writer has finished flushing.
    let complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let mut next_byte = from + complete as u64;
    let text = String::from_utf8_lossy(&bytes[..complete]);

    let first_index = idx.starts.partition_point(|&s| s < from);
    let recs = parse_records(&text, first_index);
    let entries = build_entries(&file_str, &recs);

    // A partial RECORD is not the only thing a poll can catch mid-flight — a partial tool RUN is
    // the same problem one level up. A run's later calls, and every call's `tool_result`, land in
    // LATER polls; advancing past a trailing Activity would therefore split one run into a string
    // of one-item rows whose `detail` is permanently empty, while the very same records read back
    // through `agent_transcript_page` fold into a single row with details. Same content, different
    // shape depending on how it arrived (roborev 56332).
    //
    // So we rewind to the run's first record and re-read it whole next poll. The Activity is still
    // returned NOW (an in-flight run should be visible), and its `id` is its first record's uuid —
    // stable across re-reads — so a caller that replaces by id watches the run grow in place
    // rather than accumulating fragments.
    // ONLY FOR A RUN THAT IS ACTUALLY IN FLIGHT — the condition, not merely "the last entry is an
    // Activity" (roborev 56340).
    //
    // A session can END on a tool run: an interrupt, a crash, a usage limit. That run is COMPLETE
    // and no further record is ever appended. Rewinding on the shape alone pinned `next_byte` at
    // `run_start` on every subsequent poll — `run_start >= from` stays satisfied with
    // `run_start == from` forever — so the tail never reached EOF and each poll re-read up to
    // MAX_INFLIGHT_RUN_BYTES and re-emitted the identical Activity, once a second, for as long as
    // the pane stayed mounted. The file could only unstick if a non-Activity record arrived, which
    // for an ended session never happens.
    //
    // "In flight" is decidable from the records themselves: a `tool_use` whose `tool_result` has not
    // been written yet. A completed run has every result present, so it is emitted once and the
    // offset advances past it.
    if let Some(Entry::Activity { cursor, .. }) = entries.last() {
        if let Some(&run_start) = idx.starts.get(cursor.line) {
            // Bounded: a pathologically long run must not make every poll re-read it forever.
            if trailing_run_is_in_flight(&recs)
                && run_start >= from
                && next_byte.saturating_sub(run_start) <= MAX_INFLIGHT_RUN_BYTES
            {
                next_byte = run_start;
            }
        }
    }

    Ok(TranscriptTail {
        entries,
        file: file_str,
        next_byte,
    })
}

/// The newest of `worktree_path`'s transcripts that belongs to THIS AGENT, or `None`.
///
/// The session-filtered twin of [`crate::claude::claude_latest_session_path`], and the difference
/// between the two is the whole reason this exists rather than a `session_ids` parameter being bolted
/// onto that one. They answer different questions:
///
///   * `claude_latest_session_path` answers "which session is being written in this tree" — the
///     LEARN seam. It has to be unfiltered, because its caller is trying to DISCOVER an id it does
///     not have yet (`services/sparkleTranscript`'s `bindWorktreeSession`).
///   * this one answers "which of this agent's OWN sessions is newest" — the READ seam.
///
/// Adding an optional filter to the first would have collapsed them into one command with two modes,
/// where omitting the argument silently gives you the unfiltered scan. That is precisely the defect
/// (roborev 63135): a reader that forgets the filter reports a stranger's conversation as this
/// agent's, and nothing about the call site would look wrong. Two commands, two names, and the
/// READ one fails closed.
///
/// FAILS CLOSED, via the same [`own_session_files`] the page and tail commands use: an unknown
/// binding (`None`) yields `None`, never the newest file in the directory. So a caller that omits
/// `session_ids` entirely gets no path at all — the default is CLOSED, which is the property the
/// merged-command shape could not have had.
///
/// Returning `None` for "we do not know" and for "the agent has no sessions yet" is deliberate: both
/// mean there is no file this reader may attribute to this agent, which is the only thing the caller
/// can act on.
#[tauri::command]
pub async fn agent_own_session_path(
    worktree_path: String,
    session_ids: Option<Vec<String>>,
    config_dir: Option<String>,
) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        own_session_path_sync(&worktree_path, session_ids.as_deref(), config_dir.as_deref())
    })
    .await
    .unwrap_or_default()
}

/// Blocking core of [`agent_own_session_path`], driven directly by the tests.
fn own_session_path_sync(
    worktree_path: &str,
    session_ids: Option<&[String]>,
    config_dir: Option<&str>,
) -> Option<String> {
    let dir = session_dir(worktree_path, config_dir)?;
    let files = own_session_files(&dir, session_ids)?;
    Some(files.first()?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Compile-time guard that a one-argument `#[tauri::command]` is still an `async fn`.
    ///
    /// A non-async `#[tauri::command]` runs INLINE on the Tauri event-loop thread, so any blocking
    /// IO inside it freezes the entire UI (menu bar, window drag, every `invoke` from every
    /// window). Coercing the command to `fn(A) -> Fut where Fut: Future` only type-checks while it
    /// returns a future: revert `pub async fn` to `pub fn` and the return type becomes a plain
    /// `Result`/`bool`, which is not a `Future`, and THIS STOPS COMPILING. Every other test here
    /// drives the *sync core*, so without this guard such a regression would pass silently.
    fn assert_async_command<A, Fut: std::future::Future>(_f: fn(A) -> Fut) {}

    #[test]
    fn read_transcript_last_assistant_stays_async() {
        assert_async_command(read_transcript_last_assistant);
    }

    #[test]
    fn async_command_reads_end_to_end() {
        // Scope, stated honestly: drives the real `async` command rather than the sync core, so the
        // command is reachable and its Ok/Err travel back out through the await correctly. The
        // `err.starts_with("read ")` assertion below is the one genuine bit of wiring coverage — it
        // distinguishes the inner `Err` from the task-failure wrapper.
        //
        // It does NOT prove the body reached the blocking pool. An earlier comment claimed a broken
        // JoinError mapping "shows up here"; it does not (roborev 55742). Rewrite the body as
        // `pub async fn read_transcript_last_assistant(p) -> Result<String, String> {
        // read_transcript_last_assistant_sync(p) }` — blocking IO inline on an async worker — and
        // this test still passes. The compile-time coercion guard above is what holds the shape.
        let dir = std::env::temp_dir().join(format!("sparkle_transcript_async_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        std::fs::write(&path, FIXTURE).unwrap();

        let out = tauri::async_runtime::block_on(read_transcript_last_assistant(
            path.to_string_lossy().to_string(),
        ))
        .unwrap();
        assert_eq!(out, "Part one.\n\nPart two.");

        // An unreadable path still surfaces the inner Err (not a task-failure string).
        let missing = dir.join("nope.jsonl").to_string_lossy().to_string();
        let err = tauri::async_runtime::block_on(read_transcript_last_assistant(missing)).unwrap_err();
        assert!(err.starts_with("read "), "expected the inner read error, got: {err}");

        std::fs::remove_dir_all(&dir).ok();
    }

    // Two assistant turns separated by a tool_result user turn; the final assistant message mixes
    // text and a tool_use block. Mirrors the real `~/.claude/projects/.../<session>.jsonl` shape.
    const FIXTURE: &str = concat!(
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"First answer."}]}}"#,
        "\n",
        r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}"#,
        "\n",
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Part one."},{"type":"tool_use","id":"t1","name":"Read","input":{}},{"type":"text","text":"Part two."}]}}"#,
        "\n",
    );

    #[test]
    fn returns_last_assistant_text_skipping_tool_use() {
        let out = last_assistant_text(FIXTURE);
        assert_eq!(out, "Part one.\n\nPart two.");
        // Not the earlier assistant turn.
        assert!(!out.contains("First answer."));
    }

    #[test]
    fn empty_string_when_no_assistant_record() {
        let jsonl = concat!(
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
            "\n",
            r#"{"type":"summary"}"#,
            "\n",
        );
        assert_eq!(last_assistant_text(jsonl), "");
    }

    #[test]
    fn skips_malformed_tail_line_without_panicking() {
        // A trailing half-written line (Stop fired mid-flush) must not throw off the scan.
        let jsonl = concat!(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Done."}]}}"#,
            "\n",
            r#"{"type":"assist"#, // truncated, unparseable
        );
        assert_eq!(last_assistant_text(jsonl), "Done.");
    }

    #[test]
    fn missing_file_returns_err() {
        let missing = std::env::temp_dir().join("sparkle_transcript_does_not_exist.jsonl");
        let r = read_transcript_last_assistant_sync(missing.to_string_lossy().to_string());
        assert!(r.is_err());
    }

    #[test]
    fn reads_real_file_and_returns_last_turn() {
        let dir = std::env::temp_dir().join(format!("sparkle_transcript_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        std::fs::write(&path, FIXTURE).unwrap();

        let out = read_transcript_last_assistant_sync(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(out, "Part one.\n\nPart two.");

        std::fs::remove_dir_all(&dir).ok();
    }

    use std::io::Cursor;

    // Build a transcript whose bulk (many large user turns) sits far before the final assistant
    // record, so the answer lives well past the first 64 KB tail window — exercising the
    // grow-the-window path of `read_last_assistant_from_tail`.
    fn big_transcript(pad_bytes: usize) -> String {
        let filler = "x".repeat(1024);
        let mut s = String::new();
        s.push_str(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OLD — must not be returned."}]}}"#,
        );
        s.push('\n');
        let mut written = 0usize;
        while written < pad_bytes {
            let line = format!(
                r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","content":"{filler}"}}]}}}}"#
            );
            written += line.len() + 1;
            s.push_str(&line);
            s.push('\n');
        }
        s.push_str(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"FINAL ANSWER."}]}}"#,
        );
        s.push('\n');
        s
    }

    #[test]
    fn tail_reader_finds_last_assistant_within_first_chunk() {
        // Small transcript (< TAIL_CHUNK): the very first read covers the whole file.
        let mut cur = Cursor::new(FIXTURE.as_bytes().to_vec());
        let len = FIXTURE.len() as u64;
        let out = read_last_assistant_from_tail(&mut cur, len).unwrap();
        assert_eq!(out, "Part one.\n\nPart two.");
    }

    #[test]
    fn tail_reader_finds_answer_beyond_first_window() {
        // ~200 KB of padding sits between the final answer and everything before it, so the answer
        // is inside the last window but the OLD record is far outside it. The window must grow past
        // 64 KB to keep scanning, and must never surface the OLD record.
        let data = big_transcript(200 * 1024);
        let len = data.len() as u64;
        let mut cur = Cursor::new(data.into_bytes());
        let out = read_last_assistant_from_tail(&mut cur, len).unwrap();
        assert_eq!(out, "FINAL ANSWER.");
        assert!(!out.contains("OLD"));
    }

    #[test]
    fn tail_reader_never_parses_a_truncated_first_line() {
        // Force a mid-line window start: > TAIL_CHUNK of filler precedes the final answer, so the
        // very first 64 KB tail read begins in the middle of a preceding line. Dropping that partial
        // first line must not corrupt the result, and the answer (within the first window) is found
        // without needing to grow.
        let data = big_transcript(TAIL_CHUNK as usize + 8 * 1024);
        let len = data.len() as u64;
        let mut cur = Cursor::new(data.into_bytes());
        let out = read_last_assistant_from_tail(&mut cur, len).unwrap();
        assert_eq!(out, "FINAL ANSWER.");
    }

    #[test]
    fn tail_reader_survives_multibyte_utf8_window_boundary() {
        // Padding is 4-byte UTF-8 (emoji), so the 64 KB window start almost certainly lands in the
        // middle of a character. Regression guard: an arbitrary-offset `read_to_string` errored
        // with InvalidData on a split char, failing this hot-path command on any non-ASCII
        // transcript. The read must succeed AND the final answer (itself non-ASCII) come back whole.
        let filler = "😀".repeat(256); // 1024 bytes of 4-byte chars
        let mut data = String::new();
        data.push_str(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OLD"}]}}"#,
        );
        data.push('\n');
        let mut written = 0usize;
        while written < TAIL_CHUNK as usize + 8 * 1024 {
            let line = format!(
                r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","content":"{filler}"}}]}}}}"#
            );
            written += line.len() + 1;
            data.push_str(&line);
            data.push('\n');
        }
        data.push_str(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"FÍNAL — café ☕ 完了"}]}}"#,
        );
        data.push('\n');
        let len = data.len() as u64;
        let mut cur = Cursor::new(data.into_bytes());
        let out = read_last_assistant_from_tail(&mut cur, len).unwrap();
        assert_eq!(out, "FÍNAL — café ☕ 完了");
    }

    #[test]
    fn tail_reader_empty_when_no_assistant() {
        let data = concat!(
            r#"{"type":"user","message":{"role":"user","content":"hi"}}"#,
            "\n",
            r#"{"type":"summary"}"#,
            "\n",
        );
        let len = data.len() as u64;
        let mut cur = Cursor::new(data.as_bytes().to_vec());
        assert_eq!(read_last_assistant_from_tail(&mut cur, len).unwrap(), "");
    }

    #[test]
    fn tail_reader_handles_empty_file() {
        let mut cur = Cursor::new(Vec::<u8>::new());
        assert_eq!(read_last_assistant_from_tail(&mut cur, 0).unwrap(), "");
    }

    // =======================================================================================
    // Mounted-agent transcript reader (`agent_transcript_page` / `agent_transcript_tail`)
    // =======================================================================================

    use std::path::PathBuf as StdPathBuf;

    /// `assert_async_command` for the 3- and 4-argument commands. Same contract as the
    /// one-argument version above: reverting `pub async fn` to `pub fn` makes the return type a
    /// plain `Result`, which is not a `Future`, and THIS STOPS COMPILING. Both new commands do
    /// directory scans and multi-MB reads — inline on the main thread that is a whole-UI freeze.
    fn assert_async_command5<A, B, C, D, E, Fut: std::future::Future>(_f: fn(A, B, C, D, E) -> Fut) {}

    #[test]
    fn agent_transcript_page_stays_async() {
        assert_async_command5(agent_transcript_page);
    }

    #[test]
    fn agent_transcript_tail_stays_async() {
        assert_async_command5(agent_transcript_tail);
    }

    /// A temp `CLAUDE_CONFIG_DIR` laid out exactly as Claude Code lays one out, so the tests drive
    /// the REAL resolver (`claude::encode_project_slug` → `claude_projects_root` →
    /// `claude_session_dir_for`) rather than a hand-built path. The worktree deliberately contains
    /// the `Library/Application Support` space + the `ai.sparkle.desktop` dots: those are what the
    /// slug encoding exists for, and a reader that re-derived the slug would miss this directory
    /// entirely.
    struct Fixture {
        _tmp: tempfile::TempDir,
        config: StdPathBuf,
        sessions: StdPathBuf,
        worktree: String,
        /// Every session stem this fixture has written, in write order.
        ///
        /// The reads below are keyed on a SESSION SET now (see `own_session_files`), so a test has to
        /// say whose sessions it is asking for. The default — `page`/`tail` — claims all of them,
        /// which is what every pre-existing test means: one agent, and every file in the directory is
        /// its own. Tests about the filter itself name the set explicitly via `page_for`/`tail_for`,
        /// and `page_unknown`/`tail_unknown` ask with no binding at all.
        ids: std::cell::RefCell<Vec<String>>,
    }

    fn fixture() -> Fixture {
        let tmp = tempfile::tempdir().unwrap();
        let config = tmp.path().join("claude-config");
        let worktree =
            "/Users/tester/Library/Application Support/ai.sparkle.desktop/worktrees/wt-1"
                .to_string();
        let sessions = config
            .join("projects")
            .join(crate::claude::encode_project_slug(&worktree));
        std::fs::create_dir_all(&sessions).unwrap();
        Fixture {
            _tmp: tmp,
            config,
            sessions,
            worktree,
            ids: std::cell::RefCell::new(Vec::new()),
        }
    }

    /// `&[&str]` → the owned session-id slice the reader takes.
    fn sess(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| (*s).to_string()).collect()
    }

    impl Fixture {
        fn config_arg(&self) -> String {
            self.config.to_string_lossy().into_owned()
        }

        /// Write a session file with an EXPLICIT mtime, so file ordering is a controlled input
        /// rather than a race against the filesystem clock.
        fn session(&self, name: &str, lines: &[String], mtime_secs: u64) -> StdPathBuf {
            let path = self.sessions.join(name);
            let mut body = lines.join("\n");
            if !body.is_empty() {
                body.push('\n');
            }
            std::fs::write(&path, body).unwrap();
            set_mtime(&path, mtime_secs);
            self.remember(&path);
            path
        }

        /// Write raw bytes (for the truncated-line and tail tests, which need byte control).
        fn session_raw(&self, name: &str, body: &str, mtime_secs: u64) -> StdPathBuf {
            let path = self.sessions.join(name);
            std::fs::write(&path, body).unwrap();
            set_mtime(&path, mtime_secs);
            self.remember(&path);
            path
        }

        fn remember(&self, path: &Path) {
            let id = super::session_id_of(path).unwrap().to_string();
            let mut ids = self.ids.borrow_mut();
            if !ids.contains(&id) {
                ids.push(id);
            }
        }

        /// Every session written so far — the default binding for tests that are not about the
        /// filter.
        fn all_ids(&self) -> Vec<String> {
            self.ids.borrow().clone()
        }

        fn page(&self, before: Option<super::Cursor>, limit: usize) -> TranscriptPage {
            self.page_for(&self.all_ids(), before, limit)
        }

        /// Page as an agent bound to exactly `session_ids`.
        fn page_for(
            &self,
            session_ids: &[String],
            before: Option<super::Cursor>,
            limit: usize,
        ) -> TranscriptPage {
            transcript_page_sync(
                &self.worktree,
                Some(&self.config_arg()),
                before,
                limit,
                Some(session_ids),
            )
            .unwrap()
        }

        /// Page with NO session binding — the fail-closed path.
        fn page_unknown(&self, limit: usize) -> TranscriptPage {
            transcript_page_sync(&self.worktree, Some(&self.config_arg()), None, limit, None).unwrap()
        }

        fn tail(&self, from_byte: u64) -> TranscriptTail {
            self.tail_for(&self.all_ids(), from_byte, None)
        }

        /// Tail while CLAIMING the offset belongs to `from_file` — the shape the live poll actually
        /// uses, and the only one that can exercise the rotation guard.
        fn tail_from(&self, from_byte: u64, from_file: &str) -> TranscriptTail {
            self.tail_for(&self.all_ids(), from_byte, Some(from_file))
        }

        /// Tail as an agent bound to exactly `session_ids`.
        fn tail_for(
            &self,
            session_ids: &[String],
            from_byte: u64,
            from_file: Option<&str>,
        ) -> TranscriptTail {
            transcript_tail_sync(
                &self.worktree,
                Some(&self.config_arg()),
                from_byte,
                from_file,
                Some(session_ids),
            )
            .unwrap()
        }

        /// Tail with NO session binding — the fail-closed path.
        fn tail_unknown(&self, from_byte: u64) -> TranscriptTail {
            transcript_tail_sync(&self.worktree, Some(&self.config_arg()), from_byte, None, None)
                .unwrap()
        }
    }

    fn set_mtime(path: &Path, secs: u64) {
        let f = std::fs::File::options().write(true).open(path).unwrap();
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
        f.set_times(std::fs::FileTimes::new().set_modified(t))
            .unwrap();
    }

    fn j(s: &str) -> String {
        serde_json::to_string(s).unwrap()
    }

    // --- record builders, shaped like the real JSONL ---

    fn human_rec(uuid: &str, ts: &str, text: &str) -> String {
        human_rec_in(uuid, ts, text, "sess")
    }

    /// A human record carrying an EXPLICIT `sessionId`, for the tests about what the session filter
    /// keys on. Records inside one file can name different sessions — a resume carries the prior
    /// conversation across with its original ids — so this is a real shape, not a contrived one.
    fn human_rec_in(uuid: &str, ts: &str, text: &str, session: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"{uuid}","timestamp":"{ts}","sessionId":"{session}","promptSource":"typed","message":{{"role":"user","content":[{{"type":"text","text":{}}}]}}}}"#,
            j(text)
        )
    }

    fn agent_rec(uuid: &str, ts: &str, text: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"{uuid}","timestamp":"{ts}","sessionId":"sess","message":{{"role":"assistant","content":[{{"type":"text","text":{}}}]}}}}"#,
            j(text)
        )
    }

    fn tool_use_rec(uuid: &str, ts: &str, id: &str, name: &str, target: &str) -> String {
        let input = match name {
            "Bash" => format!(r#"{{"command":{}}}"#, j(target)),
            _ => format!(r#"{{"file_path":{}}}"#, j(target)),
        };
        format!(
            r#"{{"type":"assistant","uuid":"{uuid}","timestamp":"{ts}","sessionId":"sess","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"{id}","name":"{name}","input":{input}}}]}}}}"#
        )
    }

    fn tool_result_rec(uuid: &str, ts: &str, id: &str, out: &str) -> String {
        format!(
            r#"{{"type":"user","uuid":"{uuid}","timestamp":"{ts}","sessionId":"sess","toolUseResult":{},"message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"{id}","content":{}}}]}}}}"#,
            j(out),
            j(out)
        )
    }

    fn texts(page: &TranscriptPage) -> Vec<&str> {
        page.entries.iter().map(|e| e.text()).collect()
    }

    fn ids(page: &TranscriptPage) -> Vec<&str> {
        ids_of(&page.entries)
    }

    fn ids_of(entries: &[Entry]) -> Vec<&str> {
        entries.iter().map(|e| e.id()).collect()
    }

    // --- 1. ordering is by TIMESTAMP, not by file ---

    #[test]
    fn entries_are_ordered_by_timestamp_not_by_file_mtime() {
        let f = fixture();
        // mtime order (newest first):      a, b, c
        // timestamp order (oldest first):  b, c, a
        // The two disagree, so sorting by file yields C,B,A and sorting by timestamp yields B,C,A.
        f.session(
            "a.jsonl",
            &[human_rec("ua", "2026-07-01T00:00:03Z", "A")],
            3_000,
        );
        f.session(
            "b.jsonl",
            &[human_rec("ub", "2026-07-01T00:00:01Z", "B")],
            2_000,
        );
        f.session(
            "c.jsonl",
            &[human_rec("uc", "2026-07-01T00:00:02Z", "C")],
            1_000,
        );

        let page = f.page(None, 10);
        assert_eq!(
            texts(&page),
            vec!["B", "C", "A"],
            "entries must be ordered by record timestamp; file/mtime order here is C,B,A"
        );
        assert_eq!(page.sessions_scanned, 3);
        assert!(!page.has_more);
        assert!(page.next.is_none());
    }

    // --- 2. a first page opens exactly ONE file ---

    #[test]
    fn first_page_of_forty_opens_exactly_one_file() {
        let f = fixture();
        // Two older sessions that must NOT be touched, plus a newest one that alone can satisfy 40.
        f.session(
            "old-1.jsonl",
            &(0..30)
                .map(|i| human_rec(&format!("o1-{i}"), "2026-06-01T00:00:00Z", "old"))
                .collect::<Vec<_>>(),
            1_000,
        );
        f.session(
            "old-2.jsonl",
            &(0..30)
                .map(|i| human_rec(&format!("o2-{i}"), "2026-06-02T00:00:00Z", "old"))
                .collect::<Vec<_>>(),
            2_000,
        );
        f.session(
            "live.jsonl",
            &(0..50)
                .map(|i| {
                    human_rec(
                        &format!("live-{i}"),
                        &format!("2026-07-01T00:{:02}:00Z", i),
                        "live",
                    )
                })
                .collect::<Vec<_>>(),
            3_000,
        );

        let page = f.page(None, 40);
        assert_eq!(page.entries.len(), 40);
        assert_eq!(
            page.files_opened, 1,
            "a 40-entry first page must satisfy itself from the newest session alone"
        );
        assert_eq!(page.sessions_scanned, 3, "all three are still CANDIDATES");
        assert!(page.entries.iter().all(|e| e.text() == "live"));
        assert!(page.has_more);
    }

    // --- 3. cursor round-trip: strictly older, no overlap, no gap ---

    #[test]
    fn cursor_round_trip_pages_backwards_without_overlap_or_gap() {
        let f = fixture();
        let lines: Vec<String> = (0..10)
            .map(|i| human_rec(&format!("e{i}"), &format!("2026-07-01T00:{:02}:00Z", i), "x"))
            .collect();
        f.session("s.jsonl", &lines, 1_000);

        let p1 = f.page(None, 4);
        assert_eq!(ids(&p1), vec!["e6", "e7", "e8", "e9"]);
        assert!(p1.has_more);
        let c1 = p1.next.clone().expect("page 1 must hand back a cursor");
        // The cursor is EXCLUSIVE and points at the oldest entry we were given — the same record
        // that entry carries in its OWN cursor, so the frontend can anchor on either.
        assert_eq!(c1.line, 6);
        assert_eq!(p1.entries[0].cursor(), &c1);
        assert_eq!(p1.entries[3].cursor().line, 9, "cursors track record index");

        let p2 = f.page(Some(c1), 4);
        assert_eq!(
            ids(&p2),
            vec!["e2", "e3", "e4", "e5"],
            "page 2 must be strictly older, contiguous with page 1"
        );
        let c2 = p2.next.clone().expect("page 2 must hand back a cursor");

        let p3 = f.page(Some(c2), 4);
        assert_eq!(ids(&p3), vec!["e0", "e1"]);
        assert!(!p3.has_more, "start of history");
        assert!(p3.next.is_none());

        // No id appears twice across the three pages, and together they are the whole history.
        let mut all: Vec<String> = p3
            .entries
            .iter()
            .chain(p2.entries.iter())
            .chain(p1.entries.iter())
            .map(|e| e.id().to_string())
            .collect();
        let n = all.len();
        all.sort();
        all.dedup();
        assert_eq!(all.len(), n, "pages overlapped");
        assert_eq!(n, 10, "pages left a gap");
    }

    // --- 4. every structural filter rule ---

    #[test]
    fn structural_filter_drops_exactly_the_non_conversation_records() {
        let f = fixture();
        let lines = vec![
            // Wrong top-level `type` — and the one that can be megabytes.
            r#"{"type":"file-history-snapshot","uuid":"snap","timestamp":"2026-07-01T00:00:01Z","message":{"role":"user","content":[{"type":"text","text":"SNAPSHOT"}]}}"#.to_string(),
            r#"{"type":"system","uuid":"sys","timestamp":"2026-07-01T00:00:02Z","message":{"role":"user","content":[{"type":"text","text":"SYSTEMTYPE"}]}}"#.to_string(),
            // A subagent's inner transcript.
            r#"{"type":"user","uuid":"side","timestamp":"2026-07-01T00:00:03Z","isSidechain":true,"promptSource":"typed","message":{"role":"user","content":[{"type":"text","text":"SIDECHAIN"}]}}"#.to_string(),
            // Skill injection / caveat / "Continue from where you left off."
            r#"{"type":"user","uuid":"meta","timestamp":"2026-07-01T00:00:04Z","isMeta":true,"promptSource":"typed","message":{"role":"user","content":[{"type":"text","text":"META"}]}}"#.to_string(),
            // A tool result — 816 of 869 real user records across 20 sessions.
            tool_result_rec("tres", "2026-07-01T00:00:05Z", "t9", "TOOLRESULT"),
            // tool_result-only content WITHOUT the `toolUseResult` field.
            r#"{"type":"user","uuid":"tres2","timestamp":"2026-07-01T00:00:06Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t8","content":"TOOLRESULTONLY"}]}}"#.to_string(),
            // An injected agent prompt from a different `claude` sharing the worktree.
            r#"{"type":"user","uuid":"sdk","timestamp":"2026-07-01T00:00:07Z","promptSource":"sdk","message":{"role":"user","content":[{"type":"text","text":"SDK"}]}}"#.to_string(),
            // A harness `<task-notification>` block.
            r#"{"type":"user","uuid":"sysps","timestamp":"2026-07-01T00:00:08Z","promptSource":"system","message":{"role":"user","content":[{"type":"text","text":"SYSTEMSOURCE"}]}}"#.to_string(),
            // Wrapper artifacts, not human speech.
            r#"{"type":"user","uuid":"stdout","timestamp":"2026-07-01T00:00:09Z","promptSource":"typed","message":{"role":"user","content":[{"type":"text","text":"<local-command-stdout>ok</local-command-stdout>"}]}}"#.to_string(),
            r#"{"type":"user","uuid":"caveat","timestamp":"2026-07-01T00:00:10Z","message":{"role":"user","content":[{"type":"text","text":"<local-command-caveat>x</local-command-caveat>"}]}}"#.to_string(),
            // KEPT: an explicitly typed human turn.
            human_rec("typed", "2026-07-01T00:00:11Z", "TYPED"),
            // KEPT: no `promptSource` at all — older Claude Code versions, and slash commands.
            r#"{"type":"user","uuid":"nops","timestamp":"2026-07-01T00:00:12Z","sessionId":"sess","message":{"role":"user","content":[{"type":"text","text":"NOSOURCE"}]}}"#.to_string(),
            // KEPT: an assistant text turn; its `thinking` block must not leak.
            r#"{"type":"assistant","uuid":"asst","timestamp":"2026-07-01T00:00:13Z","sessionId":"sess","message":{"role":"assistant","content":[{"type":"thinking","thinking":"THINKING"},{"type":"text","text":"ANSWER"}]}}"#.to_string(),
        ];
        f.session("s.jsonl", &lines, 1_000);

        let page = f.page(None, 50);
        let out = texts(&page);
        assert_eq!(
            out,
            vec!["TYPED", "NOSOURCE", "ANSWER"],
            "only the real conversation survives"
        );

        // Named individually so a regression says WHICH rule broke.
        for banned in [
            "SNAPSHOT",
            "SYSTEMTYPE",
            "SIDECHAIN",
            "META",
            "TOOLRESULT",
            "TOOLRESULTONLY",
            "SDK",
            "SYSTEMSOURCE",
            "local-command-stdout",
            "local-command-caveat",
            "THINKING",
        ] {
            assert!(
                !out.iter().any(|t| t.contains(banned)),
                "{banned} must be filtered out, got {out:?}"
            );
        }

        // `promptSource` is carried through, including the absent case, so TypeScript can mark
        // provenance without re-reading the transcript.
        let sources: Vec<Option<&str>> = page
            .entries
            .iter()
            .filter_map(|e| match e {
                Entry::Human { prompt_source, .. } => Some(prompt_source.as_deref()),
                _ => None,
            })
            .collect();
        assert_eq!(sources, vec![Some("typed"), None]);
    }

    // --- 5. the layering contract: Rust does NOT filter by text ---

    #[test]
    fn auto_resume_banner_survives_rust_filter() {
        // The auto-resume banner genuinely arrives as `promptSource:"typed"` with a human origin,
        // because Sparkle types it into the PTY. It is matched in TypeScript by
        // `apps/desktop/src/engine/agentOriginated.ts`, which owns the marker strings and has a
        // round-trip test binding them to the code that GENERATES them. If Rust ever started
        // filtering it here, that module's single source of truth would silently fork.
        let f = fixture();
        let banner = "Your turn ended but your goal is not met yet. Keep going.";
        f.session(
            "s.jsonl",
            &[
                human_rec("b", "2026-07-01T00:00:01Z", banner),
                human_rec("h", "2026-07-01T00:00:02Z", "a real turn"),
            ],
            1_000,
        );

        let page = f.page(None, 10);
        assert_eq!(
            texts(&page),
            vec![banner, "a real turn"],
            "Rust does STRUCTURE; TypeScript does SEMANTICS — the banner must reach TS intact"
        );
    }

    // --- 6. consecutive tool_use records fold into ONE activity ---

    #[test]
    fn consecutive_tool_uses_fold_into_one_activity() {
        let f = fixture();
        f.session(
            "s.jsonl",
            &[
                agent_rec("a0", "2026-07-01T00:00:00Z", "starting"),
                tool_use_rec("t1", "2026-07-01T00:00:01Z", "c1", "Read", "/src/retry.ts"),
                // A tool_result between calls must NOT break the run — it is dropped, not a turn.
                tool_result_rec("r1", "2026-07-01T00:00:02Z", "c1", "42 lines\nmore"),
                tool_use_rec("t2", "2026-07-01T00:00:03Z", "c2", "Edit", "/src/retry.ts"),
                tool_result_rec("r2", "2026-07-01T00:00:04Z", "c2", "edited"),
                tool_use_rec("t3", "2026-07-01T00:00:05Z", "c3", "Bash", "cargo test --lib"),
                agent_rec("a1", "2026-07-01T00:00:06Z", "done"),
            ],
            1_000,
        );

        let page = f.page(None, 10);
        assert_eq!(page.entries.len(), 3, "agent text, ONE activity, agent text");

        let Entry::Activity {
            items,
            timestamp,
            end_timestamp,
            summary,
            ..
        } = &page.entries[1]
        else {
            panic!("expected the middle entry to be an Activity");
        };
        assert_eq!(items.len(), 3, "three calls folded into one entry");
        assert_eq!(timestamp, "2026-07-01T00:00:01Z", "run starts at its FIRST call");
        assert_eq!(end_timestamp, "2026-07-01T00:00:05Z", "and ends at its LAST");
        assert!(
            end_timestamp > timestamp,
            "end_timestamp must be later than timestamp"
        );

        // Verbs, targets and best-effort details all survive the fold.
        assert_eq!(
            items.iter().map(|i| i.verb.as_str()).collect::<Vec<_>>(),
            vec!["read", "edited", "ran"]
        );
        assert_eq!(items[0].target, "/src/retry.ts");
        assert_eq!(items[2].target, "cargo test --lib");
        assert_eq!(items[0].detail, "42 lines", "first line of the tool result");
        assert_eq!(
            summary, "read retry.ts · edited retry.ts · ran cargo",
            "a short verbed, counted phrase"
        );
        // The raw escape hatch carries the run's records, not just one.
        let Entry::Activity { raw, .. } = &page.entries[1] else {
            unreachable!()
        };
        assert_eq!(raw.lines().count(), 3);
    }

    #[test]
    fn a_text_turn_breaks_a_tool_run_into_two_activities() {
        // The complement of the test above: only an agent text turn or a human turn ends a run.
        let f = fixture();
        f.session(
            "s.jsonl",
            &[
                tool_use_rec("t1", "2026-07-01T00:00:01Z", "c1", "Read", "/a.ts"),
                agent_rec("a1", "2026-07-01T00:00:02Z", "thinking out loud"),
                tool_use_rec("t2", "2026-07-01T00:00:03Z", "c2", "Read", "/b.ts"),
            ],
            1_000,
        );
        let page = f.page(None, 10);
        let kinds: Vec<&str> = page
            .entries
            .iter()
            .map(|e| match e {
                Entry::Activity { .. } => "activity",
                Entry::Agent { .. } => "agent",
                Entry::Human { .. } => "human",
            })
            .collect();
        assert_eq!(kinds, vec!["activity", "agent", "activity"]);
    }

    // --- 7. a truncated final line is skipped, not parsed ---

    #[test]
    fn truncated_final_line_is_skipped_not_parsed() {
        let f = fixture();
        let mut body = String::new();
        body.push_str(&human_rec("h1", "2026-07-01T00:00:01Z", "first"));
        body.push('\n');
        body.push_str(&agent_rec("a1", "2026-07-01T00:00:02Z", "second"));
        body.push('\n');
        // Mid-write: the writer flushed half a record. It must not become an entry, and must not
        // corrupt the two complete records before it.
        body.push_str(r#"{"type":"user","uuid":"partial","timestamp":"2026-07-01T00:00:03Z","pro"#);
        f.session_raw("s.jsonl", &body, 1_000);

        let page = f.page(None, 10);
        assert_eq!(texts(&page), vec!["first", "second"]);
        assert!(
            !ids(&page).contains(&"partial"),
            "a half-written record must never be emitted"
        );

        // Honest scope note: a TRAILING partial is guarded twice over — the line index only records
        // lines that ended in a newline, so the chunk read never even contains it, AND
        // `parse_records` would skip it anyway. No single mutation can turn this test red, which is
        // exactly why the mid-file case below is its own test: there, parse tolerance is the ONLY
        // thing standing between a corrupt line and the output.
    }

    #[test]
    fn an_unparseable_mid_file_record_is_skipped_without_shifting_the_records_after_it() {
        // A corrupt line in the MIDDLE of a file ends in a newline, so the line index counts it as
        // a record and the chunk read hands it to `parse_records`. Only the tolerant parse keeps it
        // out of the output — and the surviving records must keep their TRUE indices, or every
        // cursor after the corruption points at the wrong record.
        let f = fixture();
        let mut body = String::new();
        body.push_str(&human_rec("h1", "2026-07-01T00:00:01Z", "first"));
        body.push('\n');
        body.push_str(r#"{"type":"user","uuid":"corrupt","timestamp":"2026-07-01T00:00:02Z","mess"#);
        body.push('\n');
        body.push_str(&agent_rec("a1", "2026-07-01T00:00:03Z", "third"));
        body.push('\n');
        f.session_raw("s.jsonl", &body, 1_000);

        let page = f.page(None, 10);
        assert_eq!(texts(&page), vec!["first", "third"]);
        assert!(!ids(&page).contains(&"corrupt"));
        assert_eq!(page.entries[0].cursor().line, 0);
        assert_eq!(
            page.entries[1].cursor().line,
            2,
            "the record AFTER the corrupt line keeps index 2 — skipping must not renumber"
        );
    }

    // --- 8. tailing from a byte offset ---

    #[test]
    fn tail_returns_only_new_records_and_stops_before_a_partial_line() {
        let f = fixture();
        let mut body = String::new();
        body.push_str(&human_rec("h1", "2026-07-01T00:00:01Z", "first"));
        body.push('\n');
        body.push_str(&agent_rec("a1", "2026-07-01T00:00:02Z", "second"));
        body.push('\n');
        let complete_len = body.len() as u64;
        // A partial third record, still being flushed.
        let partial = r#"{"type":"assistant","uuid":"a2","timestamp":"2026-07-01T00:00:03Z","sess"#;
        body.push_str(partial);
        let path = f.session_raw("s.jsonl", &body, 1_000);

        let t0 = f.tail(0);
        assert_eq!(
            t0.entries.iter().map(|e| e.text()).collect::<Vec<_>>(),
            vec!["first", "second"]
        );
        assert_eq!(
            t0.next_byte, complete_len,
            "next_byte must stop at the last COMPLETE line so the partial is re-read"
        );
        assert_eq!(t0.file, path.to_string_lossy(), "the file is always reported");

        // Polling again with nothing appended yields nothing and does not move.
        let t_idle = f.tail(t0.next_byte);
        assert!(t_idle.entries.is_empty());
        assert_eq!(t_idle.next_byte, complete_len);

        // The writer finishes the record and appends another.
        let mut rest = agent_rec("a2", "2026-07-01T00:00:03Z", "third");
        rest.push('\n');
        rest.push_str(&human_rec("h2", "2026-07-01T00:00:04Z", "fourth"));
        rest.push('\n');
        // Replace the partial tail with the completed record + the new one.
        let mut full = String::new();
        full.push_str(&body[..complete_len as usize]);
        full.push_str(&rest);
        std::fs::write(&path, &full).unwrap();

        let t1 = f.tail(t0.next_byte);
        assert_eq!(
            t1.entries.iter().map(|e| e.text()).collect::<Vec<_>>(),
            vec!["third", "fourth"],
            "only the NEW records, not a re-read of the whole file"
        );
        assert_eq!(t1.next_byte, full.len() as u64);
    }

    #[test]
    fn tail_restarts_when_a_new_session_became_the_newest_file() {
        // THE ROTATION BUG. An agent that restarts (or resumes with `--continue`) opens a brand-new
        // `<uuid>.jsonl`, which immediately becomes the newest by mtime. The caller's `from_byte`
        // was measured in the PREVIOUS file and means nothing in this one.
        //
        // This is NOT covered by the past-EOF guard: the new session here is already LONGER than the
        // stale offset, so the offset is a valid seek into the middle of it. Without the file check
        // the read starts there and every record before it is skipped — silently, with no error, and
        // permanently absent from the pane until it is remounted.
        let f = fixture();
        // The old session the caller last polled, and the offset it stopped at.
        f.session(
            "old.jsonl",
            &[human_rec("o1", "2026-07-01T00:00:01Z", "older session")],
            1_000,
        );
        let stale = f.tail(0);
        let stale_file = stale.file.clone();
        let stale_offset = stale.next_byte;
        assert!(stale_offset > 0, "the old session must have advanced the offset");

        // A new session starts and grows PAST that offset, so it is not past EOF.
        f.session(
            "new.jsonl",
            &[
                human_rec("n1", "2026-07-01T01:00:01Z", "first line of the new session"),
                human_rec("n2", "2026-07-01T01:00:02Z", "second line of the new session"),
                human_rec("n3", "2026-07-01T01:00:03Z", "third line of the new session"),
            ],
            2_000,
        );

        let t = f.tail_from(stale_offset, &stale_file);
        let texts = t.entries.iter().map(|e| e.text()).collect::<Vec<_>>();
        // The FIRST record of the new session is the one a stale seek would eat. Asserting the full
        // set (not merely "non-empty") is what makes this fail against the unfixed reader.
        assert_eq!(
            texts,
            vec![
                "first line of the new session",
                "second line of the new session",
                "third line of the new session"
            ],
        );
        assert_ne!(t.file, stale_file, "the tail must have followed the new session");
    }

    #[test]
    fn a_session_that_ended_on_a_tool_run_advances_instead_of_re_reading_forever() {
        // THE PINNED-OFFSET BUG (roborev 56340). A session can end ON a tool run — an interrupt, a
        // crash, a usage limit — and that run is COMPLETE: every result is written and no further
        // record ever arrives.
        //
        // Rewinding on the SHAPE alone ("the last entry is an Activity") re-pinned `next_byte` to
        // the run's start on every poll, because `run_start >= from` stays satisfied with
        // `run_start == from` forever. The tail then never reached EOF: each poll re-read the run
        // and re-emitted the identical Activity, once a second, for as long as the pane stayed
        // mounted, for every mounted agent.
        //
        // The fix gates on whether the run is actually IN FLIGHT, so a finished run is emitted once
        // and the offset moves past it.
        let f = fixture();
        f.session(
            "s.jsonl",
            &[
                human_rec("h1", "2026-07-01T00:00:01Z", "go"),
                tool_use_rec("t1", "2026-07-01T00:00:02Z", "u1", "Bash", "cargo test"),
                // The result IS present — the run completed before the session ended.
                tool_result_rec("r1", "2026-07-01T00:00:03Z", "u1", "ok"),
            ],
            1_000,
        );

        let first = f.tail(0);
        assert!(
            first.entries.iter().any(|e| matches!(e, Entry::Activity { .. })),
            "the completed run should still be reported once",
        );
        let after_first = first.next_byte;

        // THE ASSERTION THAT FAILS AGAINST THE BUG: a second poll from the returned offset must
        // make progress and return nothing new, rather than handing back the same Activity again.
        let second = f.tail_from(after_first, &first.file);
        assert!(
            second.entries.is_empty(),
            "a finished run must not be re-emitted; got {} entries",
            second.entries.len(),
        );
        assert_eq!(
            second.next_byte, after_first,
            "the offset must stay at EOF rather than rewinding into the run again",
        );
    }

    #[test]
    fn a_run_still_awaiting_its_result_is_re_read_whole_next_poll() {
        // The other side of the same gate: a genuinely in-flight run (a tool_use whose tool_result
        // has not been written) must still rewind, or the run is split into fragments whose details
        // are permanently empty.
        let f = fixture();
        f.session(
            "s.jsonl",
            &[
                human_rec("h1", "2026-07-01T00:00:01Z", "go"),
                tool_use_rec("t1", "2026-07-01T00:00:02Z", "u1", "Bash", "cargo test"),
            ],
            1_000,
        );
        let t = f.tail(0);
        assert!(t.entries.iter().any(|e| matches!(e, Entry::Activity { .. })));
        // Rewound to before the run, so the NEXT poll re-reads it whole once the result lands —
        // asserted by re-polling from the returned offset and seeing the run again, which is the
        // rewind's entire purpose (and the opposite of the finished-run case above).
        let again = f.tail_from(t.next_byte, &t.file);
        assert!(
            again.entries.iter().any(|e| matches!(e, Entry::Activity { .. })),
            "an in-flight run must be re-read whole on the next poll",
        );
    }

    #[test]
    fn tail_restarts_when_the_offset_is_past_eof() {
        // A rotated/truncated file must restart from 0 rather than erroring.
        let f = fixture();
        f.session(
            "s.jsonl",
            &[human_rec("h1", "2026-07-01T00:00:01Z", "only")],
            1_000,
        );
        let t = f.tail(999_999);
        assert_eq!(t.entries.iter().map(|e| e.text()).collect::<Vec<_>>(), vec!["only"]);
        assert!(t.next_byte > 0);
    }

    #[test]
    fn tail_follows_the_newest_session_file() {
        // A new session becomes the newest by mtime; the caller learns via the returned `file`.
        let f = fixture();
        f.session(
            "old.jsonl",
            &[human_rec("o", "2026-07-01T00:00:01Z", "old")],
            1_000,
        );
        let newest = f.session(
            "new.jsonl",
            &[human_rec("n", "2026-07-01T00:00:02Z", "new")],
            5_000,
        );
        let t = f.tail(0);
        assert_eq!(t.file, newest.to_string_lossy());
        assert_eq!(t.entries.iter().map(|e| e.text()).collect::<Vec<_>>(), vec!["new"]);
    }

    // --- WHOSE CONVERSATION IS THIS? (the session filter) --------------------------------------
    //
    // A session directory belongs to a WORKTREE, so it accumulates every `claude` that ever ran
    // there. Before these tests the reader took the newest file by mtime with no agent id and no
    // session id reaching the read, so a pane mounted to one agent rendered whichever session was
    // most recently written — the founder saw a `pr-checks.sh` code review from an unrelated run
    // under the footer "Chatting with Sparkle".
    //
    // Every assertion below is on the RENDERED entries (their text) or on the resolved tail FILE,
    // never on the binding that was passed in.

    /// Two agents, one session directory, and the OTHER agent's session is the newest one — the exact
    /// arrangement that produced the defect. THIS FAILS AGAINST THE OLD READER: it took `files[0]`,
    /// which is `other`, and rendered the stranger's turns.
    #[test]
    fn two_agents_in_one_session_dir_render_only_the_mounted_agents_turns() {
        let f = fixture();
        f.session(
            "mine-1111.jsonl",
            &[
                human_rec("h1", "2026-07-01T00:00:01Z", "MY QUESTION"),
                agent_rec("a1", "2026-07-01T00:00:02Z", "MY ANSWER"),
            ],
            1_000,
        );
        // Newest mtime, so the unfiltered reader reaches for this one first.
        f.session(
            "theirs-2222.jsonl",
            &[
                human_rec("h2", "2026-07-01T00:01:01Z", "run pr-checks.sh"),
                agent_rec("a2", "2026-07-01T00:01:02Z", "THEIR ROBOREV REVIEW"),
            ],
            9_000,
        );

        let page = f.page_for(&sess(&["mine-1111"]), None, 40);
        let texts: Vec<&str> = page.entries.iter().map(|e| e.text()).collect();
        assert_eq!(
            texts,
            vec!["MY QUESTION", "MY ANSWER"],
            "the mounted agent's own turns, and nothing else",
        );
        assert!(
            !texts.iter().any(|t| t.contains("ROBOREV")),
            "another agent's conversation must never render under this agent's name: {texts:?}",
        );
        // The live edge must belong to us too — otherwise the tail immediately imports the stranger.
        assert!(
            page.tail_file.as_deref().is_some_and(|p| p.ends_with("mine-1111.jsonl")),
            "tail anchored to {:?}, expected the agent's own session",
            page.tail_file,
        );
        assert_eq!(
            page.sessions_scanned, 1,
            "only the agent's own files are candidates, not the directory's",
        );
    }

    /// An UNKNOWN binding must render NOTHING. Fail-closed is the whole point: falling back to
    /// "whatever is newest in the directory" is precisely the defect, and an empty pane under a
    /// correct name beats a full pane under the wrong one.
    #[test]
    fn an_unknown_session_binding_renders_empty_instead_of_borrowing_the_newest_file() {
        let f = fixture();
        f.session(
            "someone-else.jsonl",
            &[agent_rec("a1", "2026-07-01T00:00:02Z", "NOT YOURS")],
            9_000,
        );

        let page = f.page_unknown(40);
        assert!(
            page.entries.is_empty(),
            "unknown binding rendered {} entries: {:?}",
            page.entries.len(),
            page.entries.iter().map(|e| e.text()).collect::<Vec<_>>(),
        );
        assert!(
            page.tail_file.is_none(),
            "unknown binding must not hand the live tail a file to follow: {:?}",
            page.tail_file,
        );
        assert_eq!(page.sessions_scanned, 0);
        assert_eq!(page.files_opened, 0);

        // NOT VACUOUS: the same directory, read WITH a binding for that file, does return it. So the
        // empty result above is the filter refusing, not an empty directory.
        let bound = f.page_for(&sess(&["someone-else"]), None, 40);
        assert_eq!(
            bound.entries.iter().map(|e| e.text()).collect::<Vec<_>>(),
            vec!["NOT YOURS"],
            "the content is readable when it is claimed — the empty page above is the filter",
        );
    }

    /// The tail's whole file-selection strategy is "the newest file", so it needs the filter at least
    /// as much as the page does: unfiltered, a mounted pane live-follows whichever OTHER agent in the
    /// worktree is being written to right now.
    #[test]
    fn the_live_tail_follows_the_mounted_agents_session_not_the_newest_stranger() {
        let f = fixture();
        f.session(
            "mine-1111.jsonl",
            &[agent_rec("a1", "2026-07-01T00:00:02Z", "MY WORDS")],
            1_000,
        );
        f.session(
            "theirs-2222.jsonl",
            &[agent_rec("a2", "2026-07-01T00:01:02Z", "THEIR WORDS")],
            9_000,
        );

        let tail = f.tail_for(&sess(&["mine-1111"]), 0, None);
        assert!(
            tail.file.ends_with("mine-1111.jsonl"),
            "tail resolved {}, expected the agent's own session",
            tail.file,
        );
        assert_eq!(
            tail.entries.iter().map(|e| e.text()).collect::<Vec<_>>(),
            vec!["MY WORDS"],
        );
    }

    #[test]
    fn an_unknown_binding_tails_nothing() {
        let f = fixture();
        f.session(
            "someone-else.jsonl",
            &[agent_rec("a1", "2026-07-01T00:00:02Z", "NOT YOURS")],
            9_000,
        );

        let tail = f.tail_unknown(0);
        assert!(
            tail.entries.is_empty(),
            "unknown binding tailed {} entries",
            tail.entries.len(),
        );
        assert_eq!(tail.file, "", "and named no file to resume against");
        assert_eq!(tail.next_byte, 0);
    }

    /// A BINDING IS A SET, NOT A VALUE. An agent that resumes gets a new session id and a new file,
    /// and both are its own — reading only the latest would silently drop the history the founder
    /// mounted the pane to read.
    #[test]
    fn every_session_the_agent_has_owned_renders_as_one_thread() {
        let f = fixture();
        f.session(
            "mine-first.jsonl",
            &[human_rec("h1", "2026-07-01T00:00:01Z", "BEFORE RESUME")],
            1_000,
        );
        f.session(
            "mine-second.jsonl",
            &[human_rec("h2", "2026-07-01T00:05:01Z", "AFTER RESUME")],
            5_000,
        );
        f.session(
            "theirs.jsonl",
            &[human_rec("h3", "2026-07-01T00:09:01Z", "STRANGER")],
            9_000,
        );

        let page = f.page_for(&sess(&["mine-first", "mine-second"]), None, 40);
        assert_eq!(
            page.entries.iter().map(|e| e.text()).collect::<Vec<_>>(),
            vec!["BEFORE RESUME", "AFTER RESUME"],
            "both of the agent's own sessions, in time order, and no one else's",
        );
        assert_eq!(page.sessions_scanned, 2);
    }

    /// THE FILTER IS PER FILE, NOT PER RECORD — and this test is what stops someone "tightening" it
    /// onto `Entry::session_id`. When Claude Code resumes, it writes the prior conversation into the
    /// NEW session's file with each record's ORIGINAL `sessionId` intact. A record-level filter keyed
    /// on the current session would drop exactly that inherited history.
    #[test]
    fn resumed_history_inside_our_file_survives_though_its_records_name_an_older_session() {
        let f = fixture();
        f.session(
            "mine-second.jsonl",
            &[
                // Carried over by the resume: our file, an older session's id on the record.
                human_rec_in("h1", "2026-07-01T00:00:01Z", "INHERITED TURN", "an-older-session"),
                human_rec_in("h2", "2026-07-01T00:05:01Z", "FRESH TURN", "mine-second"),
            ],
            5_000,
        );

        // Bound ONLY to the current session id — the state after an app restart that saw one
        // SessionStart. The inherited turn must still render: it is in our file.
        let page = f.page_for(&sess(&["mine-second"]), None, 40);
        assert_eq!(
            page.entries.iter().map(|e| e.text()).collect::<Vec<_>>(),
            vec!["INHERITED TURN", "FRESH TURN"],
            "history inherited by a resumed session is this agent's own conversation",
        );
    }

    /// A file whose stem is not a session id we know is not ours, no matter how it is named — the
    /// filter is an exact match, not a prefix or substring one.
    #[test]
    fn the_session_match_is_exact_not_a_prefix() {
        let f = fixture();
        f.session(
            "mine.jsonl",
            &[agent_rec("a1", "2026-07-01T00:00:02Z", "MINE")],
            1_000,
        );
        f.session(
            "mine-but-actually-another.jsonl",
            &[agent_rec("a2", "2026-07-01T00:01:02Z", "NOT MINE")],
            9_000,
        );

        let page = f.page_for(&sess(&["mine"]), None, 40);
        assert_eq!(
            page.entries.iter().map(|e| e.text()).collect::<Vec<_>>(),
            vec!["MINE"],
        );
    }

    // --- boundary / degradation ---

    #[test]
    fn missing_session_dir_is_an_empty_page_not_an_error() {
        let f = fixture();
        let page = transcript_page_sync(
            "/no/such/worktree",
            Some(&f.config_arg()),
            None,
            40,
            Some(&sess(&["whatever"])),
        )
        .unwrap();
        assert!(page.entries.is_empty());
        assert_eq!(page.sessions_scanned, 0);
        assert_eq!(page.files_opened, 0);
        assert!(!page.has_more);
    }

    #[test]
    fn a_cursor_into_a_vanished_file_ends_history_instead_of_looping() {
        let f = fixture();
        f.session(
            "s.jsonl",
            &[human_rec("h1", "2026-07-01T00:00:01Z", "x")],
            1_000,
        );
        let page = f.page(
            Some(super::Cursor {
                file: "/gone/forever.jsonl".to_string(),
                line: 5,
            }),
            10,
        );
        assert!(page.entries.is_empty());
        assert!(!page.has_more, "must not silently restart from the newest turn");
    }

    #[test]
    fn raw_is_capped_so_a_huge_record_cannot_cross_the_ipc_boundary() {
        let f = fixture();
        let huge = "z".repeat(200 * 1024);
        f.session("s.jsonl", &[human_rec("h", "2026-07-01T00:00:01Z", &huge)], 1_000);
        let page = f.page(None, 10);
        let Entry::Human { raw, text, .. } = &page.entries[0] else {
            panic!("expected a human entry")
        };
        assert!(
            raw.len() <= MAX_RAW_BYTES + 4,
            "raw must be capped at {MAX_RAW_BYTES} bytes, got {}",
            raw.len()
        );
        assert!(text.len() > MAX_RAW_BYTES, "the TEXT itself is not capped");
    }

    #[test]
    fn paging_crosses_session_files_without_gaps() {
        // Two sessions, limit smaller than either: the cursor must walk out of the newest file and
        // into the older one, covering everything exactly once.
        let f = fixture();
        f.session(
            "older.jsonl",
            &(0..3)
                .map(|i| human_rec(&format!("o{i}"), &format!("2026-07-01T00:0{i}:00Z"), "o"))
                .collect::<Vec<_>>(),
            1_000,
        );
        f.session(
            "newer.jsonl",
            &(0..3)
                .map(|i| human_rec(&format!("n{i}"), &format!("2026-07-01T01:0{i}:00Z"), "n"))
                .collect::<Vec<_>>(),
            2_000,
        );

        let mut seen: Vec<String> = Vec::new();
        let mut cursor = None;
        for _ in 0..10 {
            let page = f.page(cursor.clone(), 2);
            let mut batch: Vec<String> = page.entries.iter().map(|e| e.id().to_string()).collect();
            batch.extend(seen);
            seen = batch;
            cursor = page.next.clone();
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            seen,
            vec!["o0", "o1", "o2", "n0", "n1", "n2"],
            "every record exactly once, in timestamp order, across the file boundary"
        );
    }

    #[test]
    fn line_index_extends_incrementally_across_an_append() {
        // The cached index must pick up a completed partial line rather than skipping it — that is
        // the whole reason `scanned_to` is tracked separately from the record count.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("grow.jsonl");
        std::fs::write(&path, "aaa\nbb").unwrap();
        let mut file = File::open(&path).unwrap();
        let len = file.metadata().unwrap().len();
        let idx = cached_line_index(&path, &mut file, len).unwrap();
        assert_eq!(idx.starts, vec![0], "only the complete record is indexed");
        assert_eq!(idx.scanned_to, 4, "and we resume at the partial line's start");

        std::fs::write(&path, "aaa\nbbbb\ncc\n").unwrap();
        let mut file = File::open(&path).unwrap();
        let len = file.metadata().unwrap().len();
        let idx = cached_line_index(&path, &mut file, len).unwrap();
        assert_eq!(
            idx.starts,
            vec![0, 4, 9],
            "the once-partial record is indexed from its own start, not skipped"
        );
        assert_eq!(idx.scanned_to, 12);
    }

    // --- the chunk loop: stitching, span growth, straddled runs, the byte budget ---

    #[test]
    fn a_tool_run_straddling_a_chunk_boundary_still_folds_into_one_activity() {
        // The production budgets mean no fast fixture ever takes a second lap through the chunk
        // loop, so this drives `page_from_file_with` directly with tiny budgets. 40 human records
        // then a 30-call tool run: with a 1-record initial reach the loop MUST stitch several
        // chunks, and the run MUST straddle at least one boundary. Folding per chunk (rather than
        // stitching records and folding once) would yield several Activities of a few items each.
        let f = fixture();
        let mut lines: Vec<String> = (0..40)
            .map(|i| human_rec(&format!("h{i}"), &format!("2026-07-01T00:{:02}:00Z", i), "h"))
            .collect();
        for i in 0..30 {
            lines.push(tool_use_rec(
                &format!("t{i}"),
                &format!("2026-07-01T01:{:02}:00Z", i),
                &format!("c{i}"),
                "Read",
                &format!("/f{i}.ts"),
            ));
        }
        let path = f.session("s.jsonl", &lines, 1_000);

        // 200-byte chunks force many laps over ~70 records of ~180 bytes each.
        let slice = page_from_file_with(&path, None, 3, 200, 10 * 1024 * 1024).unwrap();
        let last = slice.entries.last().expect("expected entries");
        let Entry::Activity { items, .. } = last else {
            panic!("the newest entry must be the folded tool run, got {last:?}");
        };
        assert_eq!(
            items.len(),
            30,
            "all 30 calls must fold into ONE Activity across the chunk boundaries"
        );
        assert_eq!(
            slice.entries.iter().filter(|e| matches!(e, Entry::Activity { .. })).count(),
            1,
            "exactly one Activity — a per-chunk fold would produce several"
        );
    }

    #[test]
    fn the_byte_budget_bail_discards_its_suspect_oldest_entry_and_still_advances() {
        // When the loop stops on the byte budget rather than at record 0, the window's oldest entry
        // may be a tool run folded short. It must NOT be returned as-is (it would reappear as a
        // second Activity on the next page), and the frontier must still point below it so the
        // caller keeps making progress.
        let f = fixture();
        let lines: Vec<String> = (0..40)
            .map(|i| human_rec(&format!("h{i}"), &format!("2026-07-01T00:{:02}:00Z", i), "h"))
            .collect();
        let path = f.session("s.jsonl", &lines, 1_000);

        // Budget smaller than one chunk: the loop reads a lap, blows the budget, and bails.
        let slice = page_from_file_with(&path, None, 40, 400, 400).unwrap();
        assert!(!slice.entries.is_empty(), "the bail must still return what it read");
        assert!(
            slice.entries.len() < 40,
            "the budget bail cannot have collected the whole file"
        );
        // THE discriminating assertion. With these budgets the loop folds records 36..=39 and then
        // bails; the oldest of those (h36) is the suspect one and must be dropped, leaving three.
        // Drop the discard and this reads ["h36", "h37", "h38", "h39"] with frontier 36.
        //
        // (The exact boundary is a function of the fixture's record size — if `human_rec` changes
        // shape these ids shift and the test must be re-pinned from the new window. Asserting only
        // "frontier == oldest returned" instead would be VACUOUS: that self-consistency holds
        // whether or not anything was discarded, which is how this test was first written.)
        assert_eq!(
            ids_of(&slice.entries),
            vec!["h37", "h38", "h39"],
            "the window's OLDEST entry is suspect and must not be returned"
        );
        let frontier = slice.frontier.expect("a bail must hand back a frontier");
        assert_eq!(frontier, 37, "and the frontier is the oldest entry KEPT, not the oldest read");
        assert_eq!(
            frontier,
            slice.entries[0].cursor().line,
            "so re-paging from it neither overlaps nor gaps"
        );
    }

    // --- the ordering contract is PER PAGE, and the doc must not overclaim ---

    #[test]
    fn ordering_is_per_page_only_because_the_frontier_is_file_ordered() {
        // Sessions that OVERLAP in time — the real on-disk shape, where a long-running session
        // sits at a lower mtime rank than a short recent one but ends INSIDE its window.
        //
        // `a` alone cannot fill page 1, so the page spans `a` AND `b` — and `b`'s records
        // interleave with `a`'s in time. That is what makes the per-page sort do real work here:
        // in FILE order page 1 is [b1, b2, a1]; in TIMESTAMP order it is [b1, a1, b2]. (The first
        // version of this test gave each page a single file, so file order already matched
        // timestamp order and the sort was a no-op — it passed with the sort deleted.)
        let f = fixture();
        f.session("a.jsonl", &[human_rec("a1", "2026-07-01T05:22:00Z", "a1")], 9_000);
        f.session(
            "b.jsonl",
            &[
                human_rec("b1", "2026-07-01T05:19:00Z", "b1"),
                human_rec("b2", "2026-07-01T05:23:00Z", "b2"),
            ],
            8_000,
        );
        f.session(
            "c.jsonl",
            &[
                human_rec("c1", "2026-07-01T04:00:00Z", "c1"),
                human_rec("c2", "2026-07-01T05:30:00Z", "c2"),
            ],
            7_000,
        );

        let p1 = f.page(None, 3);
        assert_eq!(
            ids(&p1),
            vec!["b1", "a1", "b2"],
            "WITHIN a page, entries are ordered by timestamp across the files it spans"
        );

        let p2 = f.page(p1.next.clone(), 3);
        assert_eq!(ids(&p2), vec!["c1", "c2"]);
        assert!(!p2.has_more, "start of history");

        // The inversion, asserted rather than hidden: page 2 contains a record NEWER than every
        // record page 1 returned. This is inherent — the frontier is file-ordered because a Cursor
        // names one file — and it is why the contract is per-page.
        assert!(
            p2.entries[1].timestamp() > p1.entries[2].timestamp(),
            "a later page can legitimately hold newer records; ordering is NOT global"
        );

        // A caller that merge-sorts accumulated pages — which the frontend must do anyway, since
        // `agent_transcript_tail` appends into the same list — recovers the true order, no gaps.
        let mut all: Vec<&Entry> = p1.entries.iter().chain(p2.entries.iter()).collect();
        all.sort_by(|a, b| a.timestamp().cmp(b.timestamp()));
        assert_eq!(
            all.iter().map(|e| e.id()).collect::<Vec<_>>(),
            vec!["c1", "b1", "a1", "b2", "c2"]
        );
    }

    // --- the tail must not split an in-flight tool run ---

    #[test]
    fn tail_rewinds_rather_than_splitting_an_in_flight_tool_run() {
        // A run's later calls and every call's tool_result arrive in LATER polls. Advancing past a
        // trailing Activity would emit a string of one-item rows with permanently empty details,
        // while the same records read through `agent_transcript_page` fold into one row.
        let f = fixture();
        let mut body = String::new();
        body.push_str(&agent_rec("a0", "2026-07-01T00:00:00Z", "starting"));
        body.push('\n');
        let run_start = body.len() as u64;
        body.push_str(&tool_use_rec("t1", "2026-07-01T00:00:01Z", "c1", "Read", "/a.ts"));
        body.push('\n');
        body.push_str(&tool_use_rec("t2", "2026-07-01T00:00:02Z", "c2", "Read", "/b.ts"));
        body.push('\n');
        let path = f.session_raw("s.jsonl", &body, 1_000);

        let t0 = f.tail(0);
        assert_eq!(t0.entries.len(), 2, "the agent turn plus the in-flight run");
        let Entry::Activity { items, .. } = &t0.entries[1] else {
            panic!("expected the run to be visible while in flight");
        };
        assert_eq!(items.len(), 2);
        assert_eq!(
            t0.next_byte, run_start,
            "next_byte rewinds to the run's FIRST record so it is re-read whole"
        );

        // The writer finishes: results for both calls, a third call, then a text turn closing it.
        let mut more = String::new();
        more.push_str(&tool_result_rec("r1", "2026-07-01T00:00:03Z", "c1", "12 lines"));
        more.push('\n');
        more.push_str(&tool_result_rec("r2", "2026-07-01T00:00:04Z", "c2", "34 lines"));
        more.push('\n');
        more.push_str(&tool_use_rec("t3", "2026-07-01T00:00:05Z", "c3", "Bash", "cargo test"));
        more.push('\n');
        more.push_str(&agent_rec("a1", "2026-07-01T00:00:06Z", "done"));
        more.push('\n');
        let full = format!("{body}{more}");
        std::fs::write(&path, &full).unwrap();

        let t1 = f.tail(t0.next_byte);
        assert_eq!(
            t1.entries.len(),
            2,
            "ONE re-folded Activity plus the closing agent turn — not three activity fragments"
        );
        let Entry::Activity { items, id, .. } = &t1.entries[0] else {
            panic!("expected the re-read run");
        };
        assert_eq!(items.len(), 3, "all three calls now fold together");
        assert_eq!(
            id, "t1",
            "the Activity id is the run's FIRST record, stable across the re-read, so a caller \
             replaces the fragment rather than appending a duplicate"
        );
        // And the details, which the first poll could not possibly have had, are now filled in.
        assert_eq!(items[0].detail, "12 lines");
        assert_eq!(items[1].detail, "34 lines");
        // The run has closed, so the tail finally advances to EOF.
        assert_eq!(t1.next_byte, full.len() as u64);
    }

    #[test]
    fn async_page_command_reaches_the_core() {
        let f = fixture();
        f.session(
            "s.jsonl",
            &[human_rec("h1", "2026-07-01T00:00:01Z", "hello")],
            1_000,
        );
        let page = tauri::async_runtime::block_on(agent_transcript_page(
            f.worktree.clone(),
            Some(f.config_arg()),
            None,
            40,
            Some(sess(&["s"])),
        ))
        .unwrap();
        assert_eq!(texts(&page), vec!["hello"]);

        let tail = tauri::async_runtime::block_on(agent_transcript_tail(
            f.worktree.clone(),
            Some(f.config_arg()),
            0,
            None,
            Some(sess(&["s"])),
        ))
        .unwrap();
        assert_eq!(tail.entries.len(), 1);
    }

    /// The COMMANDS fail closed too, not just their sync cores — the fail-closed rule has to hold at
    /// the surface the frontend actually calls, since that is where a `null` from the wire arrives.
    #[test]
    fn the_async_commands_fail_closed_on_an_unknown_binding() {
        let f = fixture();
        f.session(
            "s.jsonl",
            &[human_rec("h1", "2026-07-01T00:00:01Z", "hello")],
            1_000,
        );

        let page = tauri::async_runtime::block_on(agent_transcript_page(
            f.worktree.clone(),
            Some(f.config_arg()),
            None,
            40,
            None,
        ))
        .unwrap();
        assert!(page.entries.is_empty(), "an unbound page command must render nothing");
        assert!(page.tail_file.is_none());

        let tail = tauri::async_runtime::block_on(agent_transcript_tail(
            f.worktree.clone(),
            Some(f.config_arg()),
            0,
            None,
            None,
        ))
        .unwrap();
        assert!(tail.entries.is_empty(), "an unbound tail command must follow nothing");
        assert_eq!(tail.file, "");
    }

    // --- the READ seam for the concierge's tool path (roborev 63135) ------------------------------
    //
    // The page and tail commands above got the session filter; `readAgentTerminal`'s tier (d) did
    // not, and kept resolving through the unfiltered `claude_latest_session_path`. Same directory,
    // same stranger, same wrong attribution — except that instead of rendering in a pane it is
    // quoted back to the concierge as "here is what this agent last said", which then repeats it to
    // the founder as fact. `agent_own_session_path` is that seam, filtered.

    /// The defect, at the resolution seam: the stranger's session holds the NEWEST mtime, so an
    /// unfiltered resolve hands back their file. THIS FAILS AGAINST `claude_latest_session_path`,
    /// which is what tier (d) called before.
    ///
    /// Asserts the resolved PATH — the thing the caller then opens and quotes — not the ids passed in.
    #[test]
    fn the_read_seam_resolves_this_agents_newest_session_not_the_newest_stranger() {
        let f = fixture();
        f.session(
            "mine-old-1111.jsonl",
            &[agent_rec("a0", "2026-07-01T00:00:01Z", "MY OLDER ANSWER")],
            1_000,
        );
        f.session(
            "mine-new-3333.jsonl",
            &[agent_rec("a1", "2026-07-01T00:00:02Z", "MY LATEST ANSWER")],
            5_000,
        );
        // Newest in the whole directory, and not ours.
        f.session(
            "theirs-2222.jsonl",
            &[agent_rec("a2", "2026-07-01T00:01:02Z", "THEIR ROBOREV REVIEW")],
            9_000,
        );

        let got = own_session_path_sync(
            &f.worktree,
            Some(&sess(&["mine-old-1111", "mine-new-3333"])),
            Some(&f.config_arg()),
        )
        .expect("the agent has sessions of its own, so a path must resolve");

        assert!(
            got.ends_with("mine-new-3333.jsonl"),
            "expected this agent's NEWEST own session, got {got}",
        );
        assert!(
            !got.contains("theirs"),
            "another agent's session must never be resolved as this agent's: {got}",
        );

        // PAIRED, so the assertion above cannot pass for the wrong reason: the stranger's file is
        // genuinely the newest in the directory, which is what the old unfiltered resolve returned.
        let unfiltered = crate::claude::claude_latest_session_path_sync(&f.worktree, Some(&f.config_arg()))
            .expect("the directory is not empty");
        assert!(
            unfiltered.ends_with("theirs-2222.jsonl"),
            "the fixture must reproduce the defect for the test above to mean anything, got {unfiltered}",
        );
    }

    /// An UNKNOWN binding resolves NOTHING. Same rule as the page and tail commands, and for the
    /// same reason: the fallback IS the bug.
    ///
    /// Paired with a positive resolve over the identical directory, so "returned None" is pinned to
    /// the filter rather than to an empty or unreadable directory — an absence with two possible
    /// causes proves neither.
    #[test]
    fn the_read_seam_returns_nothing_when_the_binding_is_unknown() {
        let f = fixture();
        f.session(
            "s-1111.jsonl",
            &[agent_rec("a1", "2026-07-01T00:00:02Z", "hello")],
            1_000,
        );

        assert_eq!(
            own_session_path_sync(&f.worktree, None, Some(&f.config_arg())),
            None,
            "an unknown binding must not borrow the newest file in the directory",
        );

        assert!(
            own_session_path_sync(&f.worktree, Some(&sess(&["s-1111"])), Some(&f.config_arg()))
                .is_some_and(|p| p.ends_with("s-1111.jsonl")),
            "the same directory DOES resolve once the binding is known, so the None above is the filter",
        );
    }

    /// An agent that is bound but has written nothing yet is the normal state of a brand-new agent,
    /// not a fault — and it must not fall through to a sibling's file either.
    #[test]
    fn the_read_seam_resolves_nothing_for_a_bound_agent_with_no_files_yet() {
        let f = fixture();
        f.session(
            "theirs-2222.jsonl",
            &[agent_rec("a2", "2026-07-01T00:01:02Z", "THEIR REVIEW")],
            9_000,
        );

        assert_eq!(
            own_session_path_sync(&f.worktree, Some(&sess(&["mine-1111"])), Some(&f.config_arg())),
            None,
            "a bound agent with no sessions of its own resolves nothing, never a sibling's file",
        );
    }

    /// The COMMAND fails closed too, not just its sync core — that is the surface the frontend calls
    /// and where a `null` off the wire arrives. A Rust `Option` crosses as `null`, never as an absent
    /// key, so this is the shape the TS side can actually produce.
    #[test]
    fn the_read_seam_command_fails_closed_on_an_unknown_binding() {
        let f = fixture();
        f.session(
            "s-1111.jsonl",
            &[agent_rec("a1", "2026-07-01T00:00:02Z", "hello")],
            1_000,
        );

        assert_eq!(
            tauri::async_runtime::block_on(agent_own_session_path(
                f.worktree.clone(),
                None,
                Some(f.config_arg()),
            )),
            None,
            "an unbound resolve command must hand back no path",
        );

        assert!(
            tauri::async_runtime::block_on(agent_own_session_path(
                f.worktree.clone(),
                Some(sess(&["s-1111"])),
                Some(f.config_arg()),
            ))
            .is_some_and(|p| p.ends_with("s-1111.jsonl")),
            "and the bound call through the same command does resolve",
        );
    }
}
