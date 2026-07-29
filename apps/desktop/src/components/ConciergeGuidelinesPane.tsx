// Settings → Concierge: the editor for the user's own communication guidelines.
//
// THE FILE IS THE FEATURE, and this pane is what makes it true. The founder's reason for wanting an
// app-owned markdown file rather than model memory was, in their words, that "you can read and edit
// it; my memory is invisible to you" — so a guidelines file with no editor would be the same
// invisible thing wearing a different hat.
//
// It matters twice over because of how rules get IN. The founder chose auto-append-then-announce:
// the concierge writes a rule the moment they state a preference and tells them it did, with no
// approval step. Every appended rule records who added it and when, and THIS is where a rule they
// did not want gets found and deleted. The editor is a requirement of that choice.
//
// Deliberately modelled on AdvancedConfigMenu (the config.toml raw editor): same load-on-mount,
// same Save / Reset / Reveal row, same error discipline — Rust validates, a rejected save leaves
// both the file and the live behaviour untouched, and the error is SHOWN rather than swallowed.
// Two differences, both because this is prose and not TOML:
//   • the textarea soft-wraps (`whiteSpace: pre-wrap`) instead of scrolling horizontally, because
//     sentences wrap and TOML lines do not;
//   • there is no syntax to be invalid, so the only rejection is the size cap — which is real, not
//     bureaucratic: this text is concatenated onto a process argument on EVERY concierge turn.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { C, ON_BRAND_FILL } from "../theme/colors";
import { FONT_MONO, FONT_UI } from "../theme/scale";
import {
  conciergeGuidelinesPath,
  readConciergeGuidelines,
  writeConciergeGuidelines,
} from "../services/conciergeGuidelines";

const btn: CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: 6,
  padding: "6px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: FONT_UI,
  whiteSpace: "nowrap",
};

const help: CSSProperties = { color: C.muted, fontSize: 12, lineHeight: 1.45, margin: "2px 0 8px" };

export function ConciergeGuidelinesPane() {
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const filePath = useRef<string | null>(null);
  /** The file's text as it was when this pane last read it. The baseline a Save is checked against
   *  — see `onSave`. */
  const baseline = useRef("");
  const dirty = loaded && text !== baseline.current;

  // Load the file text + resolve its path once when the pane mounts. `readConciergeGuidelines`
  // returns the SEED when the file does not exist yet, so the box is never blank on first open —
  // a blank box would read as "there are no rules" when the truth is "here are the five you already
  // have".
  useEffect(() => {
    let cancelled = false;
    void readConciergeGuidelines()
      .then((t) => {
        if (cancelled) return;
        setText(t);
        baseline.current = t;
        setLoaded(true);
      })
      .catch((e) => !cancelled && setError(String(e)));
    void conciergeGuidelinesPath()
      .then((p) => (filePath.current = p))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const onSave = async () => {
    setError(null);
    setStatus(null);
    try {
      // ══ STALENESS CHECK — Save is a whole-file overwrite (roborev 54895) ═══════════════════════
      // The concierge appends rules on its OWN initiative, mid-turn, while this pane sits open —
      // the case the Reload button exists for. Without this, a user who edits and presses Save
      // replaces the file with what was on screen at mount, silently destroying every rule appended
      // since, and is told "Saved." That is the same silent amputation of accumulated rules the
      // Rust side was just hardened against (roborev 54859), re-entering through the UI.
      //
      // Re-read and compare against the baseline rather than locking or diffing: the file is small,
      // the window is short, and the honest answer to "someone else changed this" is to stop and
      // let the human decide, not to guess a merge for prose they own.
      const onDisk = await readConciergeGuidelines();
      if (onDisk !== baseline.current) {
        // ══ THE BASELINE DOES NOT ADVANCE HERE (roborev 55029) ═══════════════════════════════════
        // It did, and that disarmed the gate on the SECOND press: the next Save found
        // `onDisk === baseline.current`, wrote the on-screen text over the file, erased the rule
        // Sparkle had appended, and said "Saved." Two clicks to the exact data loss this check
        // exists to prevent — and reachable by accident, because typing in the box clears the error
        // message, so a user who follows the advice to copy their changes out loses the warning
        // before pressing Save again.
        //
        // Only a real Reload (or a remount) may move the baseline, because only those put the
        // user's screen back in step with the file. Until then every Save keeps refusing.
        setError(
          "Sparkle added a rule to this file while you had it open, so saving now would erase it. " +
            "Copy your changes somewhere safe, press “Reload from disk”, and reapply them.",
        );
        return;
      }
      await writeConciergeGuidelines(text);
      baseline.current = text;
      // "next turn", not "applied": Rust re-reads the file per turn, so an in-flight reply the user
      // is watching right now was already built from the old text. Saying "applied" would invite
      // them to judge the change against a reply that predates it.
      setStatus("Saved. Sparkle will use these from its next reply.");
    } catch (e) {
      // Rust refused (over the size cap). The file and the live behaviour are untouched.
      setError(String(e));
    }
  };

  const onReload = async () => {
    // A one-click discard of unsaved edits, gated the way the sibling config editor gates its
    // destructive action (roborev 54895). This commit's own reason for dropping "Reset to defaults"
    // was that discarding user-accumulated text "has no honest undo" — which applies just as much
    // to Reload over a dirty buffer, and the moment it is most likely is exactly the one Reload
    // exists for: Sparkle appended a rule while the user was mid-edit.
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    setConfirmDiscard(false);
    setError(null);
    setStatus(null);
    try {
      const t = await readConciergeGuidelines();
      setText(t);
      baseline.current = t;
      // MUST set `loaded` (roborev 54895). Reload is reachable after a FAILED initial load, which
      // leaves `loaded` false — and without this the file appears in the box while the textarea
      // stays read-only and Save stays disabled, permanently, with nothing on screen saying why.
      // The editor would be bricked until the whole dialog is reopened, in precisely the transient
      // failure Reload is there to recover from.
      setLoaded(true);
      setStatus("Reloaded from disk.");
    } catch (e) {
      setError(String(e));
    }
  };

  const onReveal = () => {
    if (filePath.current) {
      revealItemInDir(filePath.current).catch((e) =>
        console.error("reveal concierge guidelines failed", e),
      );
    }
  };

  return (
    <div data-testid="concierge-guidelines-pane">
      <p style={help}>
        How Sparkle talks to you. These rules are added to Sparkle&rsquo;s instructions on every
        reply, so preferences you state once keep applying instead of needing to be repeated. It is
        an ordinary markdown file you own &mdash; edit it, delete from it, or keep it in version
        control.
      </p>
      <p style={help}>
        Sparkle appends rules here itself when you state a preference, and tells you when it does.
        Each one records that Sparkle added it and on what date, so anything you did not want is
        easy to find and remove.
      </p>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setStatus(null);
          setError(null);
        }}
        spellCheck={false}
        aria-label="Concierge communication guidelines (Markdown)"
        readOnly={!loaded}
        style={{
          width: "100%",
          minHeight: 320,
          resize: "vertical",
          background: C.deepForest,
          color: C.cream,
          border: `1px solid ${error ? "#d66" : C.muted}`,
          borderRadius: 6,
          padding: 10,
          fontSize: 12,
          lineHeight: 1.5,
          fontFamily: FONT_MONO,
          // Prose, not TOML: wrap long sentences instead of forcing a horizontal scroll.
          whiteSpace: "pre-wrap",
          overflowWrap: "break-word",
        }}
      />

      {error && (
        <div
          data-testid="concierge-guidelines-error"
          style={{
            color: "#e88",
            fontSize: 12,
            marginTop: 6,
            fontFamily: FONT_MONO,
          }}
        >
          {error}
        </div>
      )}
      {status && !error && (
        <div data-testid="concierge-guidelines-status" style={{ color: C.tealInk, fontSize: 12, marginTop: 6 }}>
          {status}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!loaded}
          style={{ ...btn, borderColor: C.teal, background: C.teal, color: ON_BRAND_FILL }}
        >
          Save
        </button>
        {/* Reload, NOT "reset to defaults". The config editor offers a reset because its defaults
            are the app's; these rules are the USER'S, accumulated over time, and a one-click button
            that discards them has no honest undo. Reload exists for the real case: Sparkle appended
            a rule while this pane was open, and the box is now stale. */}
        <button type="button" onClick={() => void onReload()} style={btn}>
          {confirmDiscard ? "Click again to discard your edits" : "Reload from disk"}
        </button>
        {confirmDiscard && (
          <button type="button" onClick={() => setConfirmDiscard(false)} style={btn}>
            Cancel
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button type="button" onClick={onReveal} style={btn}>
          Reveal in Finder
        </button>
      </div>
    </div>
  );
}
