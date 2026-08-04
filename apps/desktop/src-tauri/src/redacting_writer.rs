//! Sink-level secret redaction for the unified log (bead ).
//!
//! `logging.rs` funnels ALL backend + frontend output into ONE daily-rolling plaintext file that the
//! app explicitly invites the user to share ("hand it to a developer or Claude to debug"). Redaction
//! used to live only at individual CALL SITES (crash.rs / support.rs / github.rs), so any *other* log
//! statement — present or future — that happens to carry a token, bearer, or `KEY=secret` reached the
//! file/stderr sink in plaintext. This wraps the sink's `MakeWriter` so every formatted event is run
//! through the SAME `support::redact_secrets` matcher before its bytes hit disk/stderr, regardless of
//! which call site emitted it. This is DEFENSE IN DEPTH: it complements — and does not replace — the
//! per-call-site redaction (which stays in place).
//!
//! Why redacting per-write is safe for line structure: `tracing_subscriber`'s fmt layer formats each
//! event into a buffer and emits it with a SINGLE `write_all`, so a secret is never split across two
//! writes. We therefore redact the whole buffer as one UTF-8 string per event. `redact_secrets` only
//! rewrites secret-shaped spans and leaves everything else byte-for-byte, so the trailing newline and
//! all surrounding text (timestamp, level, target, message) are preserved.

use std::borrow::Cow;
use std::io::{self, Write};

use tracing::Metadata;
use tracing_subscriber::fmt::MakeWriter;

use crate::support::redact_secrets;

/// Escape the `\r`/`\n` INSIDE one formatted event, keeping its single trailing newline.
///
/// A log message can carry line breaks: the frontend renders an Error as `name: message\n<stack>`,
/// `crash.rs` logs `"PANIC: {message}\n{backtrace}"`, and any `tracing::error!("{e}")` over a
/// multi-line error string does the same. `tracing` writes the message verbatim, which splits ONE
/// record across several physical lines — the head line carries the timestamp/level/target, the
/// continuation lines carry nothing, and the record's own trailing fields (`scope="…"`, `crash_id=…`)
/// end up stranded on the LAST line, detached from the head they belong to.
///
/// Every consumer of this file reads it a line at a time — the support tail, `grep`, and the humans
/// and agents we hand it to — so those orphans are unattributable to a time or a level, and
/// aggregating by level silently mis-attributes them to whatever record came before. Seen in the
/// field as a console stack trace landing as three lines with only the last one holding
/// `scope="console"`, and the panic record — the highest-value line in the file — is the worst case.
///
/// This belongs at the SINK for the same reason redaction does: it holds for every emitter, present
/// and future, instead of one command. The full multi-line backtrace is not lost — `crash.rs` also
/// writes the dedicated artifact under `crashes/`, which is where a human reads a panic anyway.
///
/// Escaping to the literal two-character forms keeps a stack readable and greppable on one line
/// rather than dropping frames. Backslashes are deliberately NOT doubled: the log is read, not
/// parsed back, and our structured payloads are rendered with `JSON.stringify`, whose output is
/// already full of `\"` and `\n` escapes that doubling would mangle on the most common path.
///
/// Scope is exactly `\r` and `\n`. Other Unicode line breaks (U+0085, U+2028/9) and C0 controls pass
/// through: they don't split a line for `grep` or the tail, and widening the scan to every event on
/// the hot path isn't worth pre-empting a break nothing has hit.
fn flatten_record(text: &str) -> Cow<'_, str> {
    // The fmt layer terminates each event with exactly one newline; that one is the record
    // separator and must survive, so only the body is escaped.
    let (body, tail) = match text.strip_suffix('\n') {
        Some(body) => (body, "\n"),
        None => (text, ""),
    };
    // Overwhelmingly the common case, and this now runs for EVERY log event — don't allocate to
    // hand back what we were given.
    if !body.contains(['\r', '\n']) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len() + 16);
    for ch in body.chars() {
        match ch {
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            c => out.push(c),
        }
    }
    out.push_str(tail);
    Cow::Owned(out)
}

/// A [`MakeWriter`] adapter that redacts secrets from every event before delegating to `inner`.
///
/// Wrap the file and stderr sink writers with this so the redaction is enforced at the SINK, not at
/// each call site — no log statement can leak a token/bearer/secret to the shared log regardless of
/// where it was emitted.
pub struct RedactingMakeWriter<M> {
    inner: M,
}

impl<M> RedactingMakeWriter<M> {
    pub fn new(inner: M) -> Self {
        Self { inner }
    }
}

impl<'a, M> MakeWriter<'a> for RedactingMakeWriter<M>
where
    M: MakeWriter<'a>,
{
    type Writer = RedactingWriter<M::Writer>;

    fn make_writer(&'a self) -> Self::Writer {
        RedactingWriter {
            inner: self.inner.make_writer(),
        }
    }

    fn make_writer_for(&'a self, meta: &Metadata<'_>) -> Self::Writer {
        RedactingWriter {
            inner: self.inner.make_writer_for(meta),
        }
    }
}

/// Wraps an [`io::Write`] sink and passes every write through [`redact_secrets`] before it lands.
pub struct RedactingWriter<W> {
    inner: W,
}

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // One fmt event == one buffer here (see module docs), so redacting the whole buffer as a
        // string neither splits a secret across writes nor reorders the line. `from_utf8_lossy`
        // borrows unchanged for valid UTF-8 (all our log text is UTF-8), so a benign line costs only
        // the matcher scan and is written back byte-identical.
        let text = String::from_utf8_lossy(buf);
        // Redact FIRST, on the text exactly as the fmt layer produced it, so the matcher sees the
        // same spans it always has; then flatten, so one record stays one physical line.
        let redacted = redact_secrets(&text);
        let line = flatten_record(&redacted);
        self.inner.write_all(line.as_bytes())?;
        // Report the INPUT length as consumed: the fmt layer accounts against the bytes it handed us,
        // not the — possibly shorter or longer — redacted output actually written downstream. Since
        // `write_all` above wrote every redacted byte, the whole event is durably flushed downstream.
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A shared in-memory sink that is both a `MakeWriter` and an `io::Write`, so a test can install
    /// it behind a real fmt subscriber and then read back exactly what reached the sink.
    #[derive(Clone, Default)]
    struct SharedBuf(Arc<Mutex<Vec<u8>>>);

    impl SharedBuf {
        fn contents(&self) -> String {
            String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
        }
    }

    impl Write for SharedBuf {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl<'a> MakeWriter<'a> for SharedBuf {
        type Writer = SharedBuf;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    /// The one that matters: a secret-shaped string logged through the NORMAL `tracing` path (no
    /// per-call-site `redact_secrets`) must arrive REDACTED at the sink — and a plain sink must leak
    /// it, proving the assertion is non-vacuous (it fails without the wrapper).
    #[test]
    fn secret_logged_through_tracing_is_redacted_at_sink() {
        // Obviously-fake secret; `..._TOKEN=<value>` is exactly the spawn-arg shape the bead calls out.
        let secret_value = "notarealsecretvalue12345";
        let line = format!("spawn env SPARKLE_BRIDGE_TOKEN={secret_value} ready");

        // (1) Redacting sink — the ONLY redaction in play. Emit through the plain `info!` macro.
        let redacting_buf = SharedBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(RedactingMakeWriter::new(redacting_buf.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("{line}");
        });
        let redacted_out = redacting_buf.contents();

        // (2) Non-vacuity: the SAME event through a PLAIN sink leaks the secret in cleartext.
        let plain_buf = SharedBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(plain_buf.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("{line}");
        });
        let plain_out = plain_buf.contents();

        assert!(
            plain_out.contains(secret_value),
            "test is vacuous: the plain sink did not even carry the secret: {plain_out}"
        );
        // Side effect: the wrapped sink masks the secret value entirely...
        assert!(
            !redacted_out.contains(secret_value),
            "SECRET LEAKED to sink despite RedactingWriter: {redacted_out}"
        );
        // ...replacing it with the shared redaction marker, while keeping the surrounding context so
        // the log stays legible (no over-redaction of the line).
        assert!(
            redacted_out.contains('\u{ab}') && redacted_out.contains("redacted"),
            "expected the «redacted» marker at the sink: {redacted_out}"
        );
        assert!(
            redacted_out.contains("spawn env") && redacted_out.contains("ready"),
            "over-redacted: surrounding context was lost: {redacted_out}"
        );
    }

    /// A benign line with correlation fields (a support engineer needs these) must pass through the
    /// sink UNCHANGED — no over-redaction.
    #[test]
    fn benign_line_passes_through_unredacted() {
        let benign = "agent ready worktree=abc-123 requestId=r-42 status=ok";

        let buf = SharedBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(RedactingMakeWriter::new(buf.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!("{benign}");
        });
        let out = buf.contents();

        assert!(
            out.contains(benign),
            "benign line was altered at the sink (over-redaction): {out}"
        );
        assert!(
            !out.contains("redacted"),
            "benign line was falsely redacted: {out}"
        );
    }

    // ── one record, one line ──────────────────────────────────────────────────

    /// THE contract, pinned where it actually holds: a multi-line message emitted through the
    /// NORMAL `tracing` path must reach the sink as ONE physical line, with its trailing fields
    /// still attached to the head. Asserted at the event level, so deleting the flatten call in
    /// `write` fails here even if the helper below still passes.
    #[test]
    fn multi_line_event_reaches_the_sink_as_one_line() {
        // The shape a frontend-forwarded console error arrives in: `name: message\n<stack>`.
        let message = "TypeError: Load failed\njson@[native code]\n@user-script:3:94:35";

        let buf = SharedBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(RedactingMakeWriter::new(buf.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(target: "ui", scope = "console", "{message}");
        });
        let out = buf.contents();

        assert_eq!(out.lines().count(), 1, "record split across lines: {out:?}");
        assert!(out.ends_with('\n'), "record separator was eaten: {out:?}");
        // The stranding this exists to prevent: the field must still be on the same line as the head.
        let head = out.lines().next().unwrap();
        assert!(head.contains("TypeError: Load failed"), "head missing: {out:?}");
        assert!(head.contains(r#"scope="console""#), "field stranded: {out:?}");
        // Frames are escaped, not dropped.
        assert!(head.contains("\\n@user-script:3:94:35"), "frame lost: {out:?}");
    }

    /// Non-vacuity for the above: the SAME event through a PLAIN sink really does split.
    #[test]
    fn plain_sink_splits_the_same_event_across_lines() {
        let buf = SharedBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(buf.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(target: "ui", scope = "console", "a\nb");
        });
        assert!(buf.contents().lines().count() > 1, "assertion would be vacuous");
    }

    /// The panic record is the highest-value line in the file and the worst case for stranding —
    /// `crash.rs` logs `"PANIC: {message}\n{backtrace}"` with `crash_id` as a field.
    #[test]
    fn panic_style_backtrace_keeps_its_crash_id_on_the_head_line() {
        let buf = SharedBuf::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .with_writer(RedactingMakeWriter::new(buf.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(crash_id = "abc123", "PANIC: boom\n  0: frame_one\n  1: frame_two");
        });
        let out = buf.contents();
        assert_eq!(out.lines().count(), 1, "panic record split: {out:?}");
        assert!(out.contains("crash_id=\"abc123\""), "crash_id lost: {out:?}");
        assert!(out.contains("frame_two"), "backtrace frames lost: {out:?}");
    }

    #[test]
    fn single_line_record_is_passed_through_without_allocating() {
        let text = "2026-01-01 INFO ui: policy resolved\n";
        assert!(matches!(flatten_record(text), Cow::Borrowed(_)));
        assert_eq!(flatten_record(text), text);
    }

    #[test]
    fn only_the_trailing_newline_survives() {
        assert_eq!(flatten_record("a\nb\n"), "a\\nb\n");
        // No trailing separator (a partial write) — nothing is invented.
        assert_eq!(flatten_record("a\nb"), "a\\nb");
    }

    #[test]
    fn carriage_returns_are_escaped_too() {
        // A bare \r would let a record overwrite the head of the line it prints on.
        assert_eq!(flatten_record("first\r\nsecond\n"), "first\\r\\nsecond\n");
    }

    #[test]
    fn json_payload_escapes_are_left_intact() {
        // `JSON.stringify` output already carries literal `\"` / `\n`; doubling backslashes here
        // would mangle every structured payload we log.
        let payload = "sent prompt {\"text\":\"a\\nb\",\"q\":\"\\\"\"}\n";
        assert!(matches!(flatten_record(payload), Cow::Borrowed(_)));
        assert_eq!(flatten_record(payload), payload);
    }
}
