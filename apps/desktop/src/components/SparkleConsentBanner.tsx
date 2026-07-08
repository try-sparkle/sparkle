import { useState } from "react";
import { C, CHAT_USER_BUBBLE, FONT_WEIGHT, ON_BRAND_FILL } from "../theme/colors";
import { useSettingsStore, type SparkleImprovementConsent } from "../stores/settingsStore";

/**
 * Consent banner for the Sparkle self-improvement agent. Sits at the top of the Sparkle pane
 * (below the pinned prompt) and lets the user choose how their anonymous logs may be used to
 * improve the open-source Sparkle client: Always (auto-submit), Case by case (review + approve
 * each PR — the default), or Never (don't evaluate logs at all). The choice is persisted in
 * settingsStore and gates the hourly log evaluation + PR submission.
 *
 * The explanatory copy below the control changes with the selected mode so the user always sees
 * exactly what that mode does. consentCopy is pure + exported so the wording is unit-tested.
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
          "On 'Always', we also securely upload scrubbed crash reports and your recent logs (last ~hour) so we can find and fix crashes fast — always anonymized, never any PII, secrets, or code.",
          "We scrub the PR for anything sensitive: No PII, secrets, code snippets, etc will be sent",
        ],
      };
    case "never":
      return {
        lead: "Sparkle will not evaluate your logs.",
        bullets: [
          "Your logs stay on your device — the improvement agent won't read them or craft any PRs.",
          "Crash reports are still captured locally to your device, but never uploaded — crash reports are only sent on 'Always'.",
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
          "Crash reports are captured locally either way, but only uploaded on 'Always' — on this setting they stay on your device.",
          "We scrub the PR for anything sensitive: No PII, secrets, code snippets, etc will be sent",
        ],
      };
  }
}

export function SparkleConsentBanner() {
  const mode = useSettingsStore((s) => s.sparkleImprovementConsent);
  const setMode = useSettingsStore((s) => s.setSparkleImprovementConsent);
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
        }}
      >
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontStyle: "italic", fontWeight: FONT_WEIGHT.semibold, fontSize: 13.5 }}>
            Can we use your anonymous logs &amp; crash reports to automatically improve Sparkle?
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
            {open ? "▾" : "ⓘ"}
          </button>
        </span>
        <div
          role="group"
          aria-label="Consent mode"
          style={{
            display: "inline-flex",
            border: `1px solid ${C.teal}`,
            borderRadius: 8,
            overflow: "hidden",
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
                  fontSize: 12.5,
                  padding: "5px 12px",
                  cursor: "pointer",
                }}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

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
            fontSize: 12.5,
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
