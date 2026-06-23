import { C, FONT } from "@sparkle/ui";

// §10.1 — macOS-only raw PTY stream, slides out from the bottom of a card.
export function ExpertModeDrawer({ lines }: { lines: string[] }) {
  return (
    <div
      style={{
        background: "#0a0f0c",
        borderTop: `1px solid ${C.status.paused}`,
        borderRadius: "0 0 12px 12px",
        padding: 12,
        marginTop: -2,
        fontFamily: FONT.mono,
        fontSize: 12,
        color: C.muted,
        maxHeight: 160,
        overflowY: "auto",
      }}
    >
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}
