// Monochrome glyph tinted by status color. build→⚒, worker→corner-down-right, shell→terminal.
// The build glyph is the ⚒ hammer-and-pick CHARACTER (U+2692), rendered the same way the main-window
// agent rows render it (apps/desktop/src/components/AgentSidebar.tsx, kindGlyph "⚒") so the tray
// dropdown and the in-app sidebar show the identical pickaxe glyph — keep them in sync if either changes.
export function TrayKindIcon({ kind, color, size = 17 }: { kind: string; color: string; size?: number }) {
  const stroke = color || "#8aa0c4";
  const common = { stroke, strokeWidth: 2, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (kind !== "worker" && kind !== "shell") {
    // build → ⚒ hammer-and-pick, matching the main app's agent-row glyph. fontSize is ~1.4× the slot
    // (same proportion as the sidebar's 28.8px glyph in its 24px slot); lineHeight 0 keeps the enlarged
    // glyph centered without driving row height.
    return (
      <span aria-hidden style={{ fontSize: Math.round(size * 1.4), lineHeight: 0, color: stroke }}>⚒</span>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {kind === "worker" ? (
        <path d="M15 10l5 5-5 5 M4 4v7a4 4 0 0 0 4 4h12" {...common} />
      ) : (
        <path d="M4 17l6-6-6-6 M12 19h8" {...common} />
      )}
    </svg>
  );
}
