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

use std::fs;

use serde_json::Value;

/// Read the transcript at `path` and return the joined text of its LAST assistant message.
/// `Err` if the file can't be read; an empty string if it has no assistant text.
#[tauri::command]
pub fn read_transcript_last_assistant(path: String) -> Result<String, String> {
    let contents = fs::read_to_string(&path).map_err(|e| format!("read {path}: {e}"))?;
    Ok(last_assistant_text(&contents))
}

/// Pure core: given the full JSONL transcript text, return the joined text of the last assistant
/// record. Scans lines from the end so we stop at the first (newest) assistant turn. Text blocks
/// are joined with blank lines; tool-use (and any non-text) blocks are skipped. Returns "" when
/// there is no assistant record with text.
fn last_assistant_text(jsonl: &str) -> String {
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
            return join_text_blocks(&v);
        }
    }
    String::new()
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
        let r = read_transcript_last_assistant(missing.to_string_lossy().to_string());
        assert!(r.is_err());
    }

    #[test]
    fn reads_real_file_and_returns_last_turn() {
        let dir = std::env::temp_dir().join(format!("sparkle_transcript_{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        std::fs::write(&path, FIXTURE).unwrap();

        let out = read_transcript_last_assistant(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(out, "Part one.\n\nPart two.");

        std::fs::remove_dir_all(&dir).ok();
    }
}
