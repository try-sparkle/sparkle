// straude.com consent + sign-in modal (bead sparkle-862tw9).
//
// This is the ONLY place `[tools].straude` gets turned ON. The Tools switch opens this dialog
// rather than writing the flag, because turning it on means publishing something about the user to
// a third party — that needs a screen that says exactly what, not a switch that has already done
// it. Modeled on BuilderIndexConsentModal, with one difference that shapes the whole component:
// straude has no API key. Auth is a browser round trip, so "sign in" is a two-step flow the user
// leaves and comes back from, not a field they paste into.
import { useCallback, useEffect, useRef, useState } from "react";
import { C, ON_GOLD_FILL } from "../theme/colors";
import { FONT_UI, LABEL, LINE_READ, RADIUS, TYPE, WEIGHT } from "../theme/scale";
import { ModalShell } from "./ModalShell";
import { useSettingsStore } from "../stores/settingsStore";
import { setToolEnabled } from "../services/configActions";
import {
  forgetStraude,
  straudeConsent,
  straudeLoginBegin,
  straudeLoginPoll,
  straudeReportNow,
  straudeStatus,
  STRAUDE_URL,
  type StraudeStatus,
} from "../services/straude";

/** Exactly what leaves the machine, itemized. Vague reassurance is worse than a list.
 *
 *  THIS LIST IS PART OF THE FEATURE, not a description of it — it is the only thing the user reads
 *  before consenting, so anything the reporter starts publishing has to arrive here in the SAME
 *  change. Mirrors straude.rs's module header; if you change one, change both.
 *
 *  Two claims here were MEASURED against the operator's public source rather than assumed, and
 *  both were wrong in an earlier draft. straude does NOT render the device label publicly (the
 *  table is owner-scoped, the public model has no device column, and the post title is
 *  date + models + cost) — so this list must not say it does. What IS true is that the value is
 *  transmitted and stored, which is why Sparkle sends a constant instead of the hostname. */
const SENDS = [
  "One row per day: your input / output / cache token counts, the total, and an estimated cost in dollars.",
  "The names of the models you used that day, with each one's share of the cost.",
  'A per-machine id, and a device label that defaults to "Sparkle". Your computer’s real name is never sent unless you type it in below.',
  "That the usage came from Claude Code. Never an agent, project, or session name.",
];
const NEVER = "Never your code, prompts, file paths, project names, or API keys.";

/** The consequence that is NOT about data leaving the machine, and so does not belong in the list
 *  above — but is the thing a user is most likely to be surprised by, so it gets its own line. */
const PUBLIC_POST =
  "Each day you report becomes a public post on straude.com — the date, the models you used, and " +
  "what you spent — plus a place on the leaderboard. Whether your profile is public is set on " +
  "straude.com, not in Sparkle.";

/** How long to keep asking whether the browser sign-in finished before giving up. The server's own
 *  code expires in ten minutes, so polling past that is asking a question with a known answer. */
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const LOGIN_POLL_MS = 3000;

export function StraudeConsentModal() {
  const open = useSettingsStore((s) => s.straudeModalOpen);
  const setOpen = useSettingsStore((s) => s.setStraudeModalOpen);
  const enabled = useSettingsStore((s) => s.straudeEnabled);

  const [status, setStatus] = useState<StraudeStatus | null>(null);
  const [deviceName, setDeviceName] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [challenge, setChallenge] = useState<{ code: string; verifyUrl: string } | null>(null);
  // The REAL concurrency guard. `busy` is presentational and gets cleared by `close()` so a
  // dismissal can never leave the dialog wedged. This ref is cleared by `close()` TOO — otherwise a
  // dismissal mid-request wedges every later open — so on its own it does NOT stop a dismiss-then-
  // reopen from starting a second request. What stops that is the generation below: every handler
  // captures the generation it started in and only clears this ref while it is still the current
  // one, so a request that outlived its dialog can never clear the flag a newer one is holding.
  const inFlight = useRef(false);
  // A GENERATION token, not a boolean. A `cancelled` flag that the open-effect reset to false was
  // resurrectable: dismiss while the poll loop is parked in its sleep, reopen before that await
  // settles, and the flag flipped back under the orphaned loop — which then ran for the rest of its
  // ten-minute budget with `inFlight` pinned true. `close()` clears `busy`, so every button
  // rendered ENABLED while all four handlers hit `if (inFlight.current) return` and silently did
  // nothing. A generation only ever moves forward, so a stale loop can never be revived.
  const generation = useRef(0);

  useEffect(() => {
    if (!open) return;
    let live = true;
    setMessage(null);
    void straudeStatus()
      .then((s) => {
        if (!live) return;
        setStatus(s);
        setDeviceName(s.deviceName);
      })
      .catch((e) => {
        console.warn("straude: status failed", e);
        if (!live) return;
        // Say so. Silently leaving `status === null` reads as "not consented", which would show a
        // configured user the first-run copy and hide the manage controls with no explanation.
        setMessage("Couldn’t read your straude settings — showing what Sparkle knows.");
      });
    return () => {
      live = false;
    };
  }, [open]);

  // Deliberately NOT gated on `busy`. This component is mounted for the app's whole life, so any
  // path that can leave `busy` stuck would also make Escape and the backdrop dead and the dialog
  // unrecoverable until restart. A dismissal is always allowed.
  //
  // Dismissing BEFORE confirming is a "no": nothing was written, so the feature stays as it was.
  const close = useCallback(() => {
    // Retire this generation. Any loop still running belongs to an older one and will exit.
    generation.current += 1;
    inFlight.current = false;
    setBusy(false);
    setChallenge(null);
    setOpen(false);
  }, [setOpen]);

  if (!open) return null;

  const consented = !!status?.consented;
  const signedIn = !!status?.hasToken;
  // Manage controls follow `enabled || consented`, so a failed status fetch cannot hide "Report
  // now" from someone whose toggle is demonstrably on.
  const showManage = enabled || consented;
  // "Save" alone would silently re-enable reporting for a consented user who had turned the switch
  // off and re-opened just to correct the device label — confirm() writes the flag either way, so
  // the label has to admit it.
  const saveLabel = !consented ? "Publish my totals" : enabled ? "Save" : "Save and turn on";

  const signIn = async () => {
    if (inFlight.current) return;
    const mine = generation.current;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const c = await straudeLoginBegin();
      if (generation.current !== mine) return;
      setChallenge(c);
      // The browser is where the user actually approves. Opening it for them is the difference
      // between a flow they finish and a URL they never click.
      window.open(c.verifyUrl, "_blank", "noopener,noreferrer");
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (true) {
        if (generation.current !== mine) return;
        if (Date.now() > deadline) {
          setMessage("That sign-in expired before it was approved. Try again.");
          return;
        }
        await new Promise((r) => setTimeout(r, LOGIN_POLL_MS));
        if (generation.current !== mine) return;
        const username = await straudeLoginPoll();
        if (generation.current !== mine) return;
        if (username != null) {
          setChallenge(null);
          setStatus(await straudeStatus());
          setMessage(`Signed in as ${username}.`);
          return;
        }
      }
    } catch (e) {
      if (generation.current === mine) setMessage(`Sign-in failed: ${String(e)}`);
    } finally {
      // Only if we are still the current generation: a stale loop must never clear the `inFlight`
      // a NEWER request is relying on, which would let two sign-ins run at once.
      if (generation.current === mine) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  const confirm = async () => {
    if (inFlight.current || !signedIn) return;
    const mine = generation.current;
    inFlight.current = true;
    setBusy(true);
    try {
      // Consent and the label in ONE call, then the flag — so a failure cannot leave the toggle on
      // with consent unrecorded.
      await straudeConsent(deviceName.trim(), true);
      await setToolEnabled("straude", true);
      if (generation.current !== mine) return;
      setStatus(await straudeStatus());
      setMessage("Reporting to straude is on.");
    } catch (e) {
      if (generation.current === mine) setMessage(`Couldn’t save: ${String(e)}`);
    } finally {
      if (generation.current === mine) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  const reportNow = async () => {
    if (inFlight.current) return;
    const mine = generation.current;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await straudeReportNow();
      if (generation.current !== mine) return;
      setMessage(result);
      setStatus(await straudeStatus());
    } catch (e) {
      if (generation.current === mine) setMessage(String(e));
    } finally {
      if (generation.current === mine) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  const turnOffAndForget = async () => {
    if (inFlight.current) return;
    const mine = generation.current;
    inFlight.current = true;
    setBusy(true);
    try {
      await setToolEnabled("straude", false);
      await forgetStraude();
      // The writes above are deliberately NOT generation-gated — a dismissal mid-forget must still
      // finish clearing the credential. Only the UI updates below are, and closing a dialog the
      // user already closed would stomp a reopen.
      if (generation.current !== mine) return;
      setStatus(null);
      setDeviceName("");
      setOpen(false);
    } catch (e) {
      if (generation.current === mine) setMessage(`Couldn’t clear: ${String(e)}`);
    } finally {
      // `finally`, not just the catch: the success path would otherwise leave `busy` true, and
      // because this component never unmounts the NEXT open would render every control disabled.
      // Generation-gated for the same reason as the others: a request that outlived its dialog
      // must not clear the `inFlight` a newer one is relying on.
      if (generation.current === mine) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <ModalShell width={480} zIndex={300} onCancel={close}>
      <h2
        style={{
          margin: "0 0 10px",
          fontSize: TYPE.title,
          fontWeight: WEIGHT.bold,
          letterSpacing: "-0.015em",
          color: C.cream,
        }}
      >
        Publish your token totals to Straude?
      </h2>
      <p style={{ margin: "0 0 12px", fontSize: TYPE.body, color: C.muted, lineHeight: LINE_READ }}>
        <a href={STRAUDE_URL} target="_blank" rel="noopener noreferrer" style={{ color: C.cream }}>
          straude.com
        </a>{" "}
        is a public leaderboard for how much builders actually spend on AI coding. Sparkle can report
        your daily totals every couple of hours. It is separate from the Builder Index — turning this
        on does not change that, and you can run either, both, or neither.
      </p>
      <ul
        style={{
          margin: "0 0 6px",
          paddingLeft: 18,
          fontSize: TYPE.small,
          color: C.muted,
          lineHeight: LINE_READ,
        }}
      >
        {SENDS.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p style={{ margin: "0 0 10px", fontSize: TYPE.small, color: C.cream, lineHeight: LINE_READ }}>
        {NEVER}
      </p>
      <p style={{ margin: "0 0 16px", fontSize: TYPE.small, color: C.amberInk, lineHeight: LINE_READ }}>
        {PUBLIC_POST}
      </p>

      <label style={labelStyle} htmlFor="straude-device-name">
        Device label
      </label>
      <input
        id="straude-device-name"
        type="text"
        value={deviceName}
        onChange={(e) => setDeviceName(e.target.value)}
        placeholder="Sparkle"
        disabled={busy}
        style={inputStyle}
      />
      <div style={{ fontSize: TYPE.small, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
        Sent with each report so you can tell machines apart. Defaults to &ldquo;Sparkle&rdquo;.
      </div>

      {!signedIn && (
        <div style={{ marginBottom: 12 }}>
          <button type="button" onClick={() => void signIn()} disabled={busy} style={secondaryStyle}>
            {busy ? "Waiting for approval…" : "Sign in to Straude"}
          </button>
          {challenge && (
            <div style={{ fontSize: TYPE.small, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
              Approve <strong style={{ color: C.cream }}>{challenge.code}</strong> in the browser tab
              that just opened. Check the code matches before approving.
            </div>
          )}
        </div>
      )}
      {signedIn && (
        <div style={{ fontSize: TYPE.small, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
          Signed in{status?.username ? ` as ${status.username}` : ""}. Your sign-in is stored in your
          system keychain, never in Sparkle&apos;s config or logs.
          {status?.expired && " It has expired — sign in again to resume reporting."}
          {!status?.expired &&
            status?.expiresInDays != null &&
            ` It expires in ${status.expiresInDays} day(s); reporting renews it automatically.`}
        </div>
      )}

      {message && (
        <div style={{ fontSize: TYPE.small, color: C.amberInk, marginBottom: 12 }}>{message}</div>
      )}
      {!message && status?.lastStatus && (
        <div style={{ fontSize: TYPE.small, color: C.muted, marginBottom: 12 }}>
          {status.lastStatus}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", alignItems: "center" }}>
        {showManage && (
          <button
            type="button"
            onClick={() => void turnOffAndForget()}
            disabled={busy}
            style={dangerStyle}
          >
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
        <button
          type="button"
          onClick={() => void confirm()}
          disabled={busy || !signedIn}
          style={{ ...primaryStyle, opacity: busy || !signedIn ? 0.5 : 1 }}
        >
          {saveLabel}
        </button>
      </div>
    </ModalShell>
  );
}

// ── styles ──────────────────────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  ...LABEL,
  display: "block",
  color: C.muted,
  marginBottom: 4,
};

// A FIELD, so it takes the FIELD TOKENS — `inputSurface` for the ground, `inputEdge` for the rule.
// The modal plane separates by LINE, not by fill (see BuilderIndexConsentModal's note and
// theme/dialogContrast.test.ts); these tokens re-theme with `--k-input` rather than with the
// shell's column seam.
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

// `goldFill`/`ON_GOLD_FILL` are the opaque-accent PAIR the palette maintains so that picking one
// picks the other; their contrast is held in theme/dialogContrast.test.ts. Do not substitute an
// accent ink for the fill.
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
