import { useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { C, FONT_WEIGHT } from "../theme/colors";
import { FONT_MONO } from "../theme/scale";

/**
 * The three small presentational leaves the expanded hover CARD is built out of — a labelled
 * detail line, a reveal-in-Finder path, and the row's close button. Moved verbatim out of
 * AgentSidebar.tsx; no logic change.
 *
 * Grouped because they are one vocabulary rather than three features: every one of them is a
 * card-sized primitive with no state of its own beyond PathReveal's hover, and they are always
 * edited for the same reason.
 */

/** One "Label: value" line in the hover card (Location / Status / Progress). The label is a muted
 *  fixed-width-content prefix; the value flexes and is allowed to shrink (minWidth:0) so a long
 *  path or status button can ellipsize/wrap instead of forcing the card wider. */
export function DetailLine({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <span style={{ flex: "0 0 auto", color: C.muted, fontSize: 12, fontWeight: FONT_WEIGHT.semibold }}>
        {label}:
      </span>
      <span style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center" }}>{children}</span>
    </div>
  );
}

/** The agent's working-directory path in the expanded row. Click to reveal the folder in Finder
 *  (Tauri opener `revealItemInDir`); underlines on hover so it reads as clickable. */
export function PathReveal({ path }: { path: string }) {
  const [hover, setHover] = useState(false);
  return (
    <span
      onClick={(e) => {
        e.stopPropagation(); // don't also select the agent
        revealItemInDir(path).catch((err) => console.error("reveal in Finder failed:", err));
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Click to reveal this folder in Finder"
      style={{
        color: hover ? C.accentInk : C.muted,
        fontSize: 12,
        fontFamily: FONT_MONO,
        whiteSpace: "nowrap",
        cursor: "pointer",
        textDecoration: hover ? "underline" : "none",
        // Ellipsize a long path inside the DetailLine instead of forcing the card wider.
        overflow: "hidden",
        textOverflow: "ellipsis",
        maxWidth: "100%",
        display: "block",
      }}
    >
      {path}
    </span>
  );
}

/** Close (×) control that stands in for the leading kind glyph while a row is hovered. It takes
 *  the glyph's slot width so the name doesn't shift on hover, with a thin pill that fades in to
 *  make the hit target feel intentional. */
export function CloseAgentButton({ onClose, width }: { onClose: () => void; width: number }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title="Close agent"
      aria-label="Close agent"
      style={{
        color: hover ? C.accentInk : C.muted,
        fontSize: 17,
        lineHeight: 1,
        flex: "0 0 auto",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        // Width matches the glyph slot so the name stays put; the pill stays a comfortable 22 tall.
        width,
        height: 22,
        padding: 0,
        cursor: "pointer",
        borderRadius: 999,
        border: `1px solid ${hover ? C.muted : "transparent"}`,
        // `pillFill` — the token whose role IS a filled chip — not `deepForest`, which is a PLANE
        // and measured 1.079/1.248 against the hover card it opens on (`barSurface`), so the hover
        // pill was a fill you could not see. 2.098/2.537 now, and 2.449/2.795 on the `forest` card.
        // The hover ink is `accentInk`, which clears it comfortably (5.118/6.097).
        background: hover ? C.pillFill : "transparent",
        transition: "background 120ms ease, border-color 120ms ease, color 120ms ease",
      }}
    >
      ×
    </button>
  );
}
