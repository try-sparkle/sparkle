// First-run + trial-exhausted screen (anonymous-free-trial design §Welcome). Two pill-boxes:
// left = the paid "Sparkle + AI enhancements" pitch (gradient stroke) with Log in / Sign up;
// right = the free 100-prompt trial with Try it now. Copy is verbatim from the spec. Pure
// presentational — the parent (AuthGate) owns the auth/trial side effects.
import type { CSSProperties } from "react";
import { C, ON_BRAND_FILL, DANGER } from "../theme/colors";
import { C as BRAND } from "@sparkle/ui";
import { AiEnhancementsBadge, AI_ENHANCEMENTS_GRADIENT } from "./AiEnhancementsBadge";

const screen: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 20,
  background: C.forest,
  color: C.cream,
  padding: 32,
  textAlign: "center",
  zIndex: 9999,
};
const boxes: CSSProperties = {
  display: "flex",
  gap: 20,
  alignItems: "stretch",
  flexWrap: "wrap",
  justifyContent: "center",
  maxWidth: 920,
};
const baseBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  alignItems: "flex-start",
  textAlign: "left",
  padding: 24,
  borderRadius: 16,
  width: 380,
  boxSizing: "border-box",
  background: C.deepForest,
};
const paidBox: CSSProperties = {
  ...baseBox,
  border: "1.5px solid transparent",
  background: `linear-gradient(${C.deepForest}, ${C.deepForest}) padding-box, ${AI_ENHANCEMENTS_GRADIENT} border-box`,
};
const freeBox: CSSProperties = { ...baseBox, border: `1px solid ${C.muted}` };
const primaryBtn: CSSProperties = {
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  borderRadius: 8,
  padding: "12px 22px",
  fontSize: 16,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: '"IBM Plex Sans", sans-serif',
  alignSelf: "stretch",
};
const ul: CSSProperties = {
  margin: "4px 0 0",
  paddingLeft: 18,
  color: C.muted,
  fontSize: 13,
  lineHeight: 1.6,
};
const fine: CSSProperties = { color: C.cream, fontSize: 13, marginTop: "auto", paddingTop: 8 };

export function WelcomeScreen({
  onSignIn,
  onTryFree,
  signInFailedUrl,
  banner,
}: {
  onSignIn: () => void;
  /** When omitted, the free-trial box is hidden — used by the exhausted upsell, where the
   *  only actionable control is "Log in / Sign up" (no dead "Try it now" beside the banner). */
  onTryFree?: () => void;
  signInFailedUrl: string | null;
  banner?: string;
}) {
  return (
    <div style={screen}>
      <h1 style={{ fontSize: 34, margin: 0 }}>Welcome to Sparkle</h1>
      <p style={{ color: C.muted, maxWidth: 620, margin: 0, fontSize: 16 }}>
        You are <strong style={{ color: C.cream }}>$99</strong> away from unlocking the full power of
        Sparkle. Unsure? Try it free for your first 100 prompts.
      </p>
      {banner && <p role="alert" style={{ color: BRAND.accent, margin: 0, fontWeight: 600 }}>{banner}</p>}
      <div style={boxes}>
        <div style={paidBox}>
          <AiEnhancementsBadge />
          <button style={primaryBtn} onClick={onSignIn}>
            Log in / Sign up
          </button>
          <ul style={ul}>
            <li>Voice-first with realtime streaming &amp; noise filtering</li>
            <li>Save + search up to a month of your prompt history (indefinite cloud backup available)</li>
            <li>Orchestrator spins up worker agents in separate worktrees</li>
            <li>Auto-renaming of agents</li>
            <li>Terminal help tips</li>
            <li>&ldquo;Think&rdquo; mode to help you build more effectively</li>
          </ul>
          <p style={fine}>$99 one-time fee. New users get $200 in AI enhancement credits.</p>
        </div>
        {onTryFree && (
          <div style={freeBox}>
            <h2 style={{ fontSize: 18, margin: 0 }}>Try it free for 100 prompts</h2>
            <button style={primaryBtn} onClick={onTryFree}>
              Try it now
            </button>
            <ul style={ul}>
              <li>Base Sparkle app, free for your first 100 prompts</li>
              <li>No AI enhancement features</li>
              <li>Log in or sign up when you&apos;re ready to unlock the full power of Sparkle</li>
            </ul>
          </div>
        )}
      </div>
      {signInFailedUrl && (
        <p style={{ color: DANGER, fontSize: 13, margin: 0, maxWidth: 480 }} role="alert">
          Couldn&apos;t open your browser. Open this link manually:{" "}
          <span style={{ color: C.cream, userSelect: "text", wordBreak: "break-all" }}>{signInFailedUrl}</span>
        </p>
      )}
    </div>
  );
}
