import { C, FONT_WEIGHT } from "../theme/colors";

/**
 * Shown inside an agent pane when the user's own Claude Code (`claude`) isn't found
 * (spec §8). We never auto-install — we guide. Sparkle runs the user's OWN claude
 * locally (ToS-compliant terminal-emulator model); it never handles the auth token.
 */
export function Onboarding({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        alignItems: "center",
        justifyContent: "center",
        padding: 32,
        textAlign: "center",
        color: C.cream,
      }}
    >
      <div style={{ fontSize: 40 }}>✨</div>
      <div style={{ fontSize: 18, fontWeight: FONT_WEIGHT.semibold }}>
        Let's connect Claude
      </div>
      <div style={{ color: C.muted, maxWidth: 460, lineHeight: 1.5 }}>
        Sparkle runs Claude on your own Mac. We couldn't find Claude Code yet. Install it,
        then come back and we'll sign you in.
      </div>
      <a
        href="https://docs.claude.com/en/docs/claude-code/setup"
        target="_blank"
        rel="noreferrer"
        style={{ color: C.accent, fontWeight: FONT_WEIGHT.medium }}
      >
        How to install Claude Code →
      </a>
      <button
        onClick={onRetry}
        style={{
          background: C.teal,
          color: C.cream,
          border: "none",
          borderRadius: 8,
          padding: "10px 20px",
          fontWeight: FONT_WEIGHT.semibold,
          cursor: "pointer",
        }}
      >
        I've installed it — check again
      </button>
    </div>
  );
}
