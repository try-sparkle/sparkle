import { C, FONT_WEIGHT } from "../theme/colors";

/**
 * Always-visible header showing the agent's most recent prompt (spec §7) — so you
 * never have to scroll up through terminal output to find what you last asked.
 */
export function PinnedPrompt({ prompt }: { prompt: string }) {
  return (
    <div
      style={{
        padding: "8px 14px",
        background: C.deepForest,
        borderBottom: `1px solid ${C.forest}`,
        display: "flex",
        gap: 8,
        alignItems: "center",
        minHeight: 20,
      }}
    >
      <span style={{ color: C.accent, flex: "0 0 auto" }}>⤷</span>
      <span
        title={prompt || undefined}
        style={{
          color: prompt ? C.cream : C.muted,
          fontWeight: prompt ? FONT_WEIGHT.medium : FONT_WEIGHT.regular,
          fontSize: 13,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {prompt || "No prompt yet — type below to start your agent"}
      </span>
    </div>
  );
}
