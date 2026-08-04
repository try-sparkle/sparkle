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

use std::io::{self, Write};

use tracing::Metadata;
use tracing_subscriber::fmt::MakeWriter;

use crate::support::redact_secrets;

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
        let redacted = redact_secrets(&text);
        self.inner.write_all(redacted.as_bytes())?;
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
}
