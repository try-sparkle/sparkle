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
import { C, FONT_WEIGHT } from "../theme/colors";
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
function postedMessage(rows: number, days: number, truncated: boolean): string {
  const base = `Reported ${rows} row(s) across ${days} day(s).`;
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
          ? postedMessage(outcome.rows, outcome.days, outcome.truncated)
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
          ? postedMessage(outcome.rows, outcome.days, outcome.truncated)
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
      <h2 style={{ margin: "0 0 10px", fontSize: 18, fontWeight: FONT_WEIGHT.semibold, color: C.cream }}>
        Publish your token totals to the Builder Index?
      </h2>
      <p style={{ margin: "0 0 12px", fontSize: 13.5, color: C.muted, lineHeight: 1.6 }}>
        The tokenmaxxing leaderboard is a public ranking of how much builders actually spend. Sparkle
        can report your daily totals every couple of hours.
      </p>
      <ul style={{ margin: "0 0 6px", paddingLeft: 18, fontSize: 12.5, color: C.muted, lineHeight: 1.6 }}>
        {SENDS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p style={{ margin: "0 0 16px", fontSize: 12.5, color: C.cream, lineHeight: 1.6 }}>{NEVER}</p>

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
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
        Stored in your system keychain, never in Sparkle&apos;s config or logs.
      </div>

      {message && <div style={{ fontSize: 12, color: C.amber, marginBottom: 12 }}>{message}</div>}
      {!message && status?.lastStatus && (
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>{status.lastStatus}</div>
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

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 0.8,
  color: C.muted,
  fontWeight: FONT_WEIGHT.semibold,
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "transparent",
  border: `1px solid ${C.hairline}`,
  borderRadius: 8,
  padding: "8px 10px",
  color: C.cream,
  fontSize: 13,
  fontFamily: '"IBM Plex Sans", sans-serif',
  marginBottom: 12,
};

const secondaryStyle: React.CSSProperties = {
  background: "transparent",
  border: `1px solid ${C.hairline}`,
  color: C.muted,
  borderRadius: 8,
  padding: "9px 16px",
  fontSize: 13.5,
  fontFamily: '"IBM Plex Sans", sans-serif',
  cursor: "pointer",
};

const dangerStyle: React.CSSProperties = {
  ...secondaryStyle,
  marginRight: "auto",
};

const primaryStyle: React.CSSProperties = {
  background: C.accentInk,
  border: "none",
  color: C.deepForest,
  borderRadius: 8,
  padding: "9px 18px",
  fontSize: 13.5,
  fontWeight: FONT_WEIGHT.semibold,
  fontFamily: '"IBM Plex Sans", sans-serif',
  cursor: "pointer",
};
