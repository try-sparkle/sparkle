// Builder Index consent + settings modal (bead sparkle-s3g2.6).
//
// This is the ONLY place `[tools].builder_index` gets turned ON. The Tools switch opens this
// dialog rather than writing the flag, because turning it on means publishing something about the
// user to a third party — that needs a screen that says exactly what, not a switch that has
// already done it. Modeled on RoborevConsentModal (one-time, explicit, either answer is final),
// with two additions roborev doesn't need: credentials, and a verify-it-worked button.
//
// The API key travels one way. It lives in this component's state only until Confirm hands it to
// Rust (keychain); `status.hasApiKey` is what comes back, never the key.
import { useCallback, useEffect, useRef, useState } from "react";
import { C, ON_GOLD_FILL } from "../theme/colors";
import { FONT_UI, LABEL, LINE_READ, RADIUS, TYPE, WEIGHT } from "../theme/scale";
import { ModalShell } from "./ModalShell";
import { useSettingsStore } from "../stores/settingsStore";
import { setToolEnabled } from "../services/configActions";
import {
  builderIndexReportNow,
  builderIndexStatus,
  forgetBuilderIndex,
  setBuilderIndexIdentity,
  type BuilderIndexStatus,
} from "../services/builderIndex";

/** Exactly what leaves the machine, itemized. Vague reassurance is worse than a list. */
const SENDS = [
  "One row per day, per model: input / output / cache tokens and an estimated cost.",
  "Your tokenmaxxing username and a per-machine id.",
];
const NEVER = "Never your code, prompts, file paths, project names, or API keys.";

/** What a successful report reads as. A capped (partial) scan MUST say so here: the modal shows
 *  this fresh message and hides the stored `lastStatus`, so a PARTIAL marker that lived only in
 *  the stored status would never be seen on the surface the user is actually looking at.
 *  (roborev 47899) */
function postedMessage(
  rows: number,
  days: number,
  truncated: boolean,
  notice?: string | null,
): string {
  let base = `Reported ${rows} row(s) across ${days} day(s).`;
  // The server's warning, verbatim. It arrives on a report that LANDED, which is exactly the
  // moment it is still actionable: tkmx-server nags about an outdated client for a while before
  // it starts freezing that client's data and discarding every row. Swallowing the nag here is
  // how a machine ends up publishing zero for months with the modal reading "Reported 21 row(s)".
  if (notice) base = `${base} The server says: ${notice}`;
  return truncated
    ? `${base} PARTIAL — the transcript scan hit its file cap, so this understates your usage.`
    : base;
}

export function BuilderIndexConsentModal() {
  const open = useSettingsStore((s) => s.builderIndexModalOpen);
  const setOpen = useSettingsStore((s) => s.setBuilderIndexModalOpen);
  const enabled = useSettingsStore((s) => s.builderIndexEnabled);

  const [status, setStatus] = useState<BuilderIndexStatus | null>(null);
  const [username, setUsername] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // The REAL concurrency guard. `busy` is presentational and gets cleared by `close()` so a
  // dismissal can never leave the dialog wedged; this ref is not, so dismissing mid-request and
  // re-opening can't fire a second identity write + POST alongside the first (two keychain writes
  // and two cycles racing ensure_client_id / record_outcome). (roborev 47904/47899)
  const inFlight = useRef(false);

  // Pull the stored identity when the dialog opens so re-opening it shows what's already set up
  // (and so the username field isn't blank for someone who just wants to hit "Report now").
  useEffect(() => {
    if (!open) return;
    let live = true;
    setMessage(null);
    void builderIndexStatus()
      .then((s) => {
        if (!live) return;
        setStatus(s);
        setUsername(s.username);
      })
      .catch((e) => {
        console.warn("builder index: status failed", e);
        if (!live) return;
        // Say so. Silently leaving `status === null` reads as "not consented", which would show
        // a configured user first-run copy and hide Report now with no explanation.
        // (roborev 47904)
        setMessage("Couldn't read your Builder Index settings — showing what Sparkle knows.");
      });
    return () => {
      live = false;
    };
  }, [open]);

  // Deliberately NOT gated on `busy`. This component is mounted for the app's whole life, so any
  // path that can leave `busy` stuck also makes Escape and the backdrop dead and the dialog
  // unrecoverable until restart. A dismissal is always allowed; the in-flight promise just
  // resolves into an unmounted view. (roborev 47458)
  // Dismissing BEFORE confirming is a "no": nothing was written, so the feature stays as it was.
  // Dismissing DURING a confirm does not cancel it — the identity write and the POST are already
  // in flight — it only closes the view; `inFlight` keeps a re-open from starting a second one.
  const close = useCallback(() => {
    setApiKey("");
    setBusy(false);
    setOpen(false);
  }, [setOpen]);

  if (!open) return null;

  const trimmedUser = username.trim();
  // A key is required the first time only — afterwards the stored one is reused, so the field can
  // stay empty when the user is just correcting a username.
  const canConfirm = trimmedUser.length > 0 && (apiKey.trim().length > 0 || !!status?.hasApiKey);
  // Consent mode vs manage mode keys off CONSENT, not the toggle. Keying it off `enabled` left two
  // broken states: an enabled install could edit the username/key fields with no action that saved
  // them, and an enabled-but-unconsented one (reachable by hand-editing config.toml) had no way to
  // record consent at all. (roborev 47458)
  const consented = !!status?.consented;
  // "Save" alone would silently re-enable reporting for a consented user who had turned the switch
  // off and re-opened just to correct a username — confirm() writes the flag either way, so the
  // label has to admit it. (roborev 47904)
  const saveLabel = !consented ? "Publish my totals" : enabled ? "Save" : "Save and turn on";
  // Manage controls follow `enabled || consented`, so a failed status fetch (consented === false)
  // can't hide Report now from someone whose toggle is demonstrably on. (roborev 47904)
  const showManage = enabled || consented;

  const confirm = async () => {
    if (inFlight.current || !canConfirm) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      // One call records credentials AND consent, so the two can never land out of step.
      await setBuilderIndexIdentity(trimmedUser, apiKey.trim(), true);
      await setToolEnabled("builderIndex", true);
      setApiKey("");
      // Report straight away: the whole point of the button is that the user can go look at their
      // profile now rather than trusting a background timer they can't see. (A "Save" in manage
      // mode reports too — a changed username re-keys the machine, so proving the new identity
      // works is exactly as valuable as proving the first one did.)
      const outcome = await builderIndexReportNow();
      setMessage(
        outcome.status === "posted"
          ? postedMessage(outcome.rows, outcome.days, outcome.truncated, outcome.notice)
          : `Not reported yet — ${outcome.reason}.`,
      );
      setStatus(await builderIndexStatus());
    } catch (e) {
      // Leave the dialog open and say what happened: a failed first report usually means a bad
      // key, and silently closing would leave the toggle on with nothing ever appearing.
      setMessage(`Couldn't report: ${String(e)}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const reportNow = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const outcome = await builderIndexReportNow();
      setMessage(
        outcome.status === "posted"
          ? postedMessage(outcome.rows, outcome.days, outcome.truncated, outcome.notice)
          : `Not reported — ${outcome.reason}.`,
      );
      setStatus(await builderIndexStatus());
    } catch (e) {
      setMessage(`Couldn't report: ${String(e)}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const turnOffAndForget = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      await setToolEnabled("builderIndex", false);
      await forgetBuilderIndex();
      setApiKey("");
      setStatus(null);
      setUsername("");
      setOpen(false);
    } catch (e) {
      setMessage(`Couldn't clear: ${String(e)}`);
    } finally {
      // `finally`, not just the catch: the success path left `busy` true, and because this
      // component never unmounts the NEXT open rendered every control disabled — permanently.
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <ModalShell width={480} zIndex={300} onCancel={close}>
      <h2 style={{ margin: "0 0 10px", fontSize: TYPE.title, fontWeight: WEIGHT.bold, letterSpacing: "-0.015em", color: C.cream }}>
        Publish your token totals to the Builder Index?
      </h2>
      <p style={{ margin: "0 0 12px", fontSize: TYPE.body, color: C.muted, lineHeight: LINE_READ }}>
        The tokenmaxxing leaderboard is a public ranking of how much builders actually spend. Sparkle
        can report your daily totals every couple of hours.
      </p>
      <ul style={{ margin: "0 0 6px", paddingLeft: 18, fontSize: TYPE.small, color: C.muted, lineHeight: LINE_READ }}>
        {SENDS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p style={{ margin: "0 0 16px", fontSize: TYPE.small, color: C.cream, lineHeight: LINE_READ }}>{NEVER}</p>

      <label style={labelStyle} htmlFor="bi-username">
        tokenmaxxing username
      </label>
      <input
        id="bi-username"
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="your-name"
        disabled={busy}
        style={inputStyle}
      />

      <label style={labelStyle} htmlFor="bi-api-key">
        API key{status?.hasApiKey ? " (stored — leave blank to keep it)" : ""}
      </label>
      <input
        id="bi-api-key"
        // type=password so the key isn't shoulder-surfable and browsers/screenshots don't capture it.
        type="password"
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        placeholder={status?.hasApiKey ? "••••••••" : "from your tokenmaxxing registration"}
        disabled={busy}
        autoComplete="off"
        style={inputStyle}
      />
      <div style={{ fontSize: TYPE.small, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
        Stored in your system keychain, never in Sparkle&apos;s config or logs.
      </div>

      {message && <div style={{ fontSize: TYPE.small, color: C.amberInk, marginBottom: 12 }}>{message}</div>}
      {!message && status?.lastStatus && (
        <div style={{ fontSize: TYPE.small, color: C.muted, marginBottom: 12 }}>{status.lastStatus}</div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
        {showManage && (
          <button type="button" onClick={() => void turnOffAndForget()} disabled={busy} style={dangerStyle}>
            Turn off and forget
          </button>
        )}
        {showManage && (
          <button type="button" onClick={() => void reportNow()} disabled={busy} style={secondaryStyle}>
            Report now
          </button>
        )}
        <button type="button" onClick={close} style={secondaryStyle}>
          {consented ? "Close" : "Not now"}
        </button>
        {/* Always present, so credentials are editable in every state — including an
            enabled-but-unconsented install, where this is the ONLY way to record consent. */}
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy || !canConfirm}
          style={{ ...primaryStyle, opacity: busy || !canConfirm ? 0.5 : 1 }}
        >
          {saveLabel}
        </button>
      </div>
    </ModalShell>
  );
}

// ── styles ──────────────────────────────────────────────────────────────────────────────────

// The LABEL treatment, from the spec — mono, uppercase, 10px, 0.1em. It was a 12px semibold SANS
// label with 0.8px of tracking, i.e. the same idea approximated by eye.
const labelStyle: React.CSSProperties = {
  ...LABEL,
  display: "block",
  color: C.muted,
  marginBottom: 4,
};

// A FIELD, so it takes the FIELD TOKENS: `inputSurface` for the ground, `inputEdge` for the rule.
//
// THE REASON IS TOKEN ROLE, NOT APPEARANCE, and the first version of this comment got that wrong in
// a way worth recording (roborev 54710). It claimed the previous `background: "transparent"` made the
// input "read as a bordered region of the modal rather than as a well you type into" — implying the
// new fill separates the field from the dialog. It does not, and cannot: `inputSurface` IS the dialog
// surface in light (both #ffffff, 1.000:1) and a hair off it in dark (1.042:1), and in light
// `inputEdge` is byte-identical to `hairline`. The field renders exactly as it did.
//
// That is the DESIGN, not a shortfall — `dialogContrast.test.ts` states and enforces it: the modal
// plane separates by LINE, not by fill. A field here is meant to sit flush with the dialog and be
// carried entirely by its rule. Anyone who believed the old comment would have gone looking for the
// missing "well" and darkened `--k-input` to produce it, tripping a ceiling test whose message points
// at the rail rather than at them.
//
// What the swap actually buys: the field now re-themes with `--k-input` / `--k-input-edge` instead of
// with the shell's column seam, so retuning the seam no longer restyles every form control in the app.
const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: C.inputSurface,
  border: `1px solid ${C.inputEdge}`,
  borderRadius: RADIUS.input,
  padding: "8px 10px",
  color: C.cream,
  fontSize: TYPE.body,
  fontFamily: FONT_UI,
  marginBottom: 12,
};

const secondaryStyle: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.hairline}`,
  color: C.muted,
  borderRadius: RADIUS.input,
  padding: "9px 16px",
  fontSize: TYPE.body,
  fontFamily: FONT_UI,
  cursor: "pointer",
};

const dangerStyle: React.CSSProperties = {
  ...secondaryStyle,
  marginRight: "auto",
};

// THE PRIMARY BUTTON IS A THEMED PAIR, and this one had been assembled from two halves that do not
// belong together: an accent INK as the fill, with the BUILDER COLUMN's plane as the text on top of
// it. `goldFill`/`ON_GOLD_FILL` are the opaque-accent pair the palette maintains precisely so that
// picking one picks the other — see the note on `goldFill` in theme/colors.ts. Their contrast is
// held in theme/dialogContrast.test.ts.
const primaryStyle: React.CSSProperties = {
  background: C.goldFill,
  border: "none",
  color: ON_GOLD_FILL,
  borderRadius: RADIUS.input,
  padding: "9px 18px",
  fontSize: TYPE.body,
  fontWeight: WEIGHT.bold,
  fontFamily: FONT_UI,
  cursor: "pointer",
};
