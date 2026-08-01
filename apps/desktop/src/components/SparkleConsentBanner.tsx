import { useState } from "react";
import { FiChevronDown, FiInfo } from "react-icons/fi";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { useSettingsStore, type SparkleImprovementConsent } from "../stores/settingsStore";
import { setImprovementConsent } from "../services/configActions";
import { useColumnZoom } from "../hooks/useZoomColumn";
import { zoomColumnFor } from "../engine/columnZoom";
import { SPARKLE_PANE_SIDE } from "../stores/uiStore";

/**
 * Consent banner for the Sparkle self-improvement agent. Sits at the top of the Sparkle pane
 * (below the pinned prompt) and lets the user choose how their logs may be used to
 * improve the open-source Sparkle client: Always (auto-submit), Case by case (review + approve
 * each PR — the default), or Never (don't evaluate logs at all). The choice is persisted in
 * settingsStore and gates the hourly log evaluation + PR submission, AND the crash-report upload
 * tiers enforced in Rust (src-tauri/src/crash.rs `upload_allowed` / `logs_allowed`):
 *   - "never"        → nothing uploaded.
 *   - "case_by_case" → the scrubbed crash report only (message + backtrace), no recent-logs tail.
 *   - "always"       → the crash report plus the scrubbed ~1h recent-logs tail.
 *
 * The explanatory copy below the control changes with the selected mode so the user always sees
 * exactly what that mode does. consentCopy is pure + exported so the wording is unit-tested.
 *
 * THE COPY IS A PROMISE. Those bullets are the only place the user is told what leaves their
 * machine, so they and the Rust gate are one contract: if the gate changes, the copy changes in the
 * same commit. This banner once said crash reports were "only uploaded on 'Always'" while the gate
 * said otherwise — the tests below pin each mode's wording precisely so that can't drift again.
 */

const MODES: { value: SparkleImprovementConsent; label: string }[] = [
  { value: "always", label: "Always" },
  { value: "case_by_case", label: "Case by case" },
  { value: "never", label: "Never" },
];

export interface ConsentCopy {
  /** The lead line above the bullets. */
  lead: string;
  /** The explanatory bullets for this mode. */
  bullets: string[];
}

/** The explanatory copy shown under the question for each consent mode. Pure + exported for tests. */
export function consentCopy(mode: SparkleImprovementConsent): ConsentCopy {
  switch (mode) {
    case "always":
      return {
        lead: "Here's how it works:",
        bullets: [
          "Once per hour, we use a small amount of your Claude Code subscription to evaluate your logs.",
          "If we see failures or performance issues, we automatically craft a PR to submit to the Sparkle OSS project to improve it",
          'On "Always" mode, these PRs will be submitted automatically. No action required from you.',
          "On 'Always', the improvement agent also starts with the app, so it's already working when you open it — on 'Case by case' that's opt-in.",
          "If Sparkle crashes, we securely upload a scrubbed crash report so we can find and fix the crash fast — the error message and backtrace only, never any PII, secrets, or code.",
          "That report says which install and which build it came from, and — only if you are signed in — which Sparkle account, so we can tell whose crash it is and follow up. Signed out, it stays anonymous.",
          "On 'Always', that crash report also carries your recent logs (last ~hour), scrubbed the same way, which gives us the context around the crash.",
          "We scrub the PR for anything sensitive: No PII, secrets, code snippets, etc will be sent",
        ],
      };
    case "never":
      return {
        lead: "Sparkle will not evaluate your logs.",
        bullets: [
          "Your logs stay on your device — the improvement agent won't read them or craft any PRs.",
          "Crash reports are still captured locally to your device, but nothing is uploaded — on 'Never' we send no crash reports, no logs, and no account or build information.",
          "You can switch this back on at any time.",
        ],
      };
    case "case_by_case":
    default:
      return {
        lead: "Here's how it works:",
        bullets: [
          "Once per hour, we use a small amount of your Claude Code subscription to evaluate your logs.",
          "If we see failures or performance issues, we automatically craft a proposed PR to submit upon your approval to the Sparkle OSS project to improve it",
          "You review and approve every PR before it is submitted",
          "If Sparkle crashes, we securely upload a scrubbed crash report so we can find and fix the crash fast — the error message and backtrace only, never any PII, secrets, or code.",
          "That report says which install and which build it came from, and — only if you are signed in — which Sparkle account, so we can tell whose crash it is and follow up. Signed out, it stays anonymous.",
          "Your recent logs are NOT sent on this setting — the crash report travels on its own. Uploading the last ~hour of logs alongside it is 'Always' only.",
          "We scrub the PR for anything sensitive: No PII, secrets, code snippets, etc will be sent",
        ],
      };
  }
}

export function SparkleConsentBanner() {
  // ── IT SCALES WITH THE COLUMN IT LIVES IN ────────────────────────────────────────────────────
  //
  // THE LOCKOUT THIS FIXES. The founder: "I can't zoom the right terminal … zoomed out enough to be
  // able to log back in because it's the always / case by case / never row that's keeping it from
  // zooming." He was locked out of an agent by a consent banner.
  //
  // The cause is that `Cmd -` on a terminal column only ever shrank xterm's FONT (Terminal.tsx
  // multiplies BASE_FONT_SIZE by the level). This banner is React chrome, not xterm, so it kept its
  // full size while the terminal beneath it got smaller — meaning zooming out bought fewer usable
  // rows than it should have, and past a point bought none at all: the banner's fixed height was
  // simply subtracted from the pane, and the login prompt further down the terminal stayed off
  // screen.
  //
  // Reading the same per-column level the terminal reads makes "zoom this column out" mean the whole
  // column, which is what the founder asked for in the first place. `SPARKLE_PANE_SIDE` because
  // there is exactly one Improve-Sparkle pane and it lives in the primary pair.
  const columnZoom = useColumnZoom(zoomColumnFor("terminal", SPARKLE_PANE_SIDE));
  const mode = useSettingsStore((s) => s.sparkleImprovementConsent);
  // Route through the configAction (not the raw store setter) so the choice is MIRRORED to
  // [improvement].consent in config.toml — that file is the only path headless agents have to it.
  // The action updates the store optimistically, so the control still responds instantly.
  const setMode = (m: SparkleImprovementConsent) => void setImprovementConsent(m);
  const launchWarm = useSettingsStore((s) => s.improvementLaunchWarm);
  const setLaunchWarm = useSettingsStore((s) => s.setImprovementLaunchWarm);
  const copy = consentCopy(mode);
  // The "how it works" detail is collapsed by default — the pinned bar shows only the question +
  // control. It expands as an OVERLAY (so the terminal below never resizes) on two independent
  // paths: hover (desktop discovery) and clicking/tapping the ⓘ disclosure (sticky `pinned`, for
  // touch + click users — informed consent must not be hover-only). The disclosure is a real
  // <button aria-expanded>, so keyboard users Tab to it and press Enter/Space; we deliberately do
  // NOT tie `open` to region focus-within, which on Chromium webviews races the click (focus fires
  // before click) and would make a fresh tap net to closed.
  const [hovering, setHovering] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovering || pinned;

  return (
    <div
      role="region"
      aria-label="Sparkle improvement consent"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        position: "relative",
        flex: "0 0 auto",
        // ── NO CHILD MAY SET ITS COLUMN'S FLOOR ──────────────────────────────────────────────
        //
        // This banner was doing exactly that, and it locked the founder out of an agent. The
        // Always / Case by case / Never row is an `inline-flex` of three unbreakable buttons, so
        // its min-content width — ~230px — became a floor the whole PANE could not shrink below.
        // Zooming the right terminal out therefore stopped early, and the login prompt further down
        // that terminal stayed off screen: a consent banner denying access to the thing behind it.
        //
        // Every box from here down now carries `minWidth: 0`. A flex item's default
        // `min-width: auto` is what refuses to shrink below its content; without overriding it, no
        // amount of wrapping downstream helps, because the ancestor never gets smaller in the first
        // place. The only floor in the cockpit is `COLUMN_MIN_WIDTH` (engine/columnResize).
        minWidth: 0,
        // Shrinks the whole banner — text, buttons and padding together — so zooming the column out
        // hands the terminal the vertical space back. It also reduces this row's min-content width
        // by the same factor, which is the second half of "stop propping the column open".
        zoom: columnZoom,
        padding: "10px 14px",
        background: C.deepForest,
        borderBottom: `1px solid ${CHAT_USER_BUBBLE}`,
        color: C.cream,
        zIndex: 2,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          minWidth: 0,
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, flex: "1 1 auto" }}>
          <span style={{ fontStyle: "italic", fontWeight: FONT_WEIGHT.semibold, fontSize: 13, minWidth: 0 }}>
            Can we use your logs &amp; crash reports to automatically improve Sparkle?
          </span>
          {/* Disclosure toggle: a real button so the detail is reachable by click/tap (not just
              hover/focus) — important for touch users and for informed consent. */}
          <button
            type="button"
            aria-expanded={open}
            // Only reference the detail while it's actually in the DOM (it's rendered only when
            // open) — otherwise aria-controls is a dangling IDREF in the default collapsed state.
            aria-controls={open ? "sparkle-consent-detail" : undefined}
            aria-label="How it works"
            // A plain sticky toggle. No focus coupling, so tap-to-open and tap-to-collapse both
            // behave identically across WKWebView and Chromium/WebView2. While the mouse is over
            // the bar, `hovering` keeps the detail open regardless — that's hover behavior.
            onClick={() => setPinned((p) => !p)}
            style={{
              border: "none",
              background: "transparent",
              color: C.muted,
              fontSize: 12,
              lineHeight: 1,
              padding: 2,
              cursor: "pointer",
            }}
          >
            {open ? <FiChevronDown size={13} aria-hidden /> : <FiInfo size={13} aria-hidden />}
          </button>
        </span>
        <div
          role="group"
          aria-label="Consent mode"
          style={{
            display: "inline-flex",
            border: `1px solid ${C.teal}`,
            borderRadius: 6,
            overflow: "hidden",
            // WRAPS INSTEAD OF PROPPING THE COLUMN OPEN. Three side-by-side buttons are ~230px of
            // unbreakable row; allowing the group to wrap lets them stack, and `minWidth: 0` is what
            // permits the group to be asked to. The segmented look survives at every width that can
            // afford it, which is every width the user is likely to sit at.
            flexWrap: "wrap",
            minWidth: 0,
          }}
        >
          {MODES.map((m) => {
            const selected = mode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                aria-pressed={selected}
                onClick={() => setMode(m.value)}
                style={{
                  border: "none",
                  background: selected ? C.teal : "transparent",
                  color: selected ? ON_BRAND_FILL : C.cream,
                  fontWeight: selected ? FONT_WEIGHT.semibold : FONT_WEIGHT.regular,
                  fontSize: 12,
                  padding: "5px 12px",
                  cursor: "pointer",
                  // DELIBERATELY NOT `whiteSpace: nowrap`. "Case by case" wrapping to two or three
                  // lines is ugly at 60px and READABLE; the alternative is a 85px floor per button
                  // that the column can never go below. Legible-but-cramped beats locked-out.
                  minWidth: 0,
                  flex: "1 1 auto",
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Launch-warm opt-in. "Case by case" means ASK ME, so the agent must not greet the user
          already running at startup unless they turned that on — hence a checkbox here rather than
          a silent default. The other two modes need no control: "Always" is standing authority (it
          warms, and the bullets say so) and "Never" runs nothing at all. See
          sparkleAgent.shouldWarmSparkleAtLaunch, which is the one place these rules are resolved. */}
      {mode === "case_by_case" && (
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            marginTop: 6,
            color: C.muted,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={launchWarm === true}
            onChange={(e) => setLaunchWarm(e.target.checked)}
            style={{ cursor: "pointer" }}
          />
          Start the improvement agent when Sparkle opens (instead of when you click this row)
        </label>
      )}

      {open && (
        <div
          id="sparkle-consent-detail"
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            padding: "10px 14px 12px",
            color: C.muted,
            fontSize: 12,
            lineHeight: 1.5,
            background: C.deepForest,
            borderBottom: `1px solid ${CHAT_USER_BUBBLE}`,
            boxShadow: "0 8px 18px rgba(0,0,0,0.35)",
          }}
        >
          <div>{copy.lead}</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {copy.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
