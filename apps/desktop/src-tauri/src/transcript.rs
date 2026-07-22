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

#[cfg(test)]
mod tests {
    use super::*;

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
}
