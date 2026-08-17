// The bead's comment thread and its compose box — the human-facing half of bead comments.
//
// ══ WHY HUMANS COMMENT HERE INSTEAD OF FILING A NEW BEAD ═══════════════════════════════════════
// The founder's ask: a bead should be a thread that accumulates signal, so humans and agents add to
// the SAME bead rather than everyone filing a near-duplicate. The write path (`beadsComment`) shipped
// with no caller; this box is the caller. Each comment is also a point in the relevance/severity
// score, which is why the score becomes meaningful only once this exists.
//
// ══ PHRASING CONTENT, LIKE THE REST OF `BeadCard` ══════════════════════════════════════════════
// `BeadCard` may mount inside the concierge's `<Markdown>` `<p>`, where a `<div>` is invalid nesting
// and gets reparented out of the sentence. So this uses `<span style={{display:block}}>` everywhere a
// block is wanted, and `<textarea>`/`<button>` which are already phrasing content. No `<div>`.
import { useState, type CSSProperties } from "react";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../../theme/scale";
import type { BeadComment } from "../../services/beadsCommands";

const block = (extra: CSSProperties = {}): CSSProperties => ({ display: "block", ...extra });

/** Format a comment's ISO timestamp for the thread. Null (a comment with no recorded time) shows
 *  nothing rather than "Invalid Date". Pure; date only — the thread does not need minutes. */
function when(createdAt: string | null): string {
  if (createdAt === null) return "";
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

export function CommentThread({
  comments,
  onComment,
  testId,
}: {
  /** Existing comments, oldest-first. `undefined` means "not loaded" (thread omitted by the caller);
   *  an empty array means "loaded, none yet" and shows the empty state. */
  comments: BeadComment[] | undefined;
  /** Post a comment. Absent → read-only thread, no compose box. */
  onComment?: (text: string) => Promise<void>;
  testId: string;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit() {
    const text = draft.trim();
    // Guard the empty send the same way the Rust side does — an all-whitespace comment is rejected
    // there too, so never dispatch one.
    if (onComment === undefined || busy || text === "") return;
    setErr("");
    setBusy(true);
    try {
      await onComment(text);
      // Clear only on success — a failed send must keep the draft so the reader can retry it.
      setDraft("");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span data-testid={testId} style={block({ display: "flex", flexDirection: "column", gap: 8 })}>
      <span
        style={{
          fontSize: TYPE.small,
          color: C.muted,
          fontWeight: FONT_WEIGHT.semibold,
        }}
      >
        Comments
      </span>

      {/* ── EXISTING COMMENTS ──────────────────────────────────────────────────────────────────── */}
      {comments !== undefined && comments.length === 0 && (
        <span
          data-testid={`${testId}-empty`}
          style={block({ color: C.conciergeMuted, fontSize: TYPE.small })}
        >
          No comments yet.
        </span>
      )}
      {comments !== undefined && comments.length > 0 && (
        <span data-testid={`${testId}-list`} style={block({ display: "flex", flexDirection: "column", gap: 8 })}>
          {comments.map((c, i) => (
            <span
              key={c.id || i}
              data-testid={`${testId}-item`}
              style={block({
                borderLeft: `2px solid ${C.hairline}`,
                paddingLeft: 8,
              })}
            >
              <span style={{ display: "flex", gap: 8, fontSize: TYPE.small, color: C.muted }}>
                <span style={{ fontWeight: FONT_WEIGHT.semibold }}>{c.author ?? "unknown"}</span>
                {when(c.createdAt) !== "" && <span>{when(c.createdAt)}</span>}
              </span>
              <span
                data-testid={`${testId}-item-text`}
                style={block({ color: C.cream, fontSize: TYPE.small, lineHeight: 1.5, whiteSpace: "pre-wrap" })}
              >
                {c.text}
              </span>
            </span>
          ))}
        </span>
      )}

      {/* ── COMPOSE ─────────────────────────────────────────────────────────────────────────────
          Present only when the caller can actually write. */}
      {onComment !== undefined && (
        <span style={block({ display: "flex", flexDirection: "column", gap: 6 })}>
          <textarea
            data-testid={`${testId}-input`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            placeholder="Add a comment…"
            rows={2}
            style={{
              width: "100%",
              boxSizing: "border-box",
              resize: "vertical",
              // THE FORM-CONTROL TOKENS, not the shell's. `C.forest` + `C.hairline` are the column
              // seam; a field painted with them re-styles every time that seam is retuned, which is
              // what `modalChrome.test.ts`'s ratchet exists to stop spreading. This field was the
              // 29th borrower against a ceiling of 28, so it is also what has been failing that
              // test — and through it every open PR's merged-with-main run — since it landed.
              background: C.inputSurface,
              color: C.cream,
              border: `1px solid ${C.inputEdge}`,
              borderRadius: RADIUS.input,
              padding: "6px 8px",
              fontFamily: FONT_UI,
              fontSize: TYPE.small,
              lineHeight: 1.4,
            }}
          />
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              data-testid={`${testId}-submit`}
              onClick={() => void submit()}
              disabled={busy || draft.trim() === ""}
              style={{
                flex: "0 0 auto",
                background: C.teal,
                color: ON_BRAND_FILL,
                border: "none",
                borderRadius: RADIUS.modal,
                padding: "4px 12px",
                fontSize: TYPE.small,
                fontWeight: FONT_WEIGHT.semibold,
                cursor: busy || draft.trim() === "" ? "default" : "pointer",
                opacity: busy || draft.trim() === "" ? 0.6 : 1,
                fontFamily: FONT_UI,
              }}
            >
              {busy ? "Posting…" : "Comment"}
            </button>
          </span>
        </span>
      )}

      {err !== "" && (
        <span
          data-testid={`${testId}-error`}
          role="alert"
          style={block({ color: C.dangerInk, fontSize: TYPE.small })}
        >
          {err}
        </span>
      )}
    </span>
  );
}
