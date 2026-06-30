import { C, AGENT_STATUS } from "@sparkle/ui";
import type { Counts, TrayRoster } from "./trayRoster";

const RED = C.sienna;    // #e0533f
const GREY = C.muted;    // #8aa0c4
const GREEN = C.success; // #34c759

// Derive the bucket from the shared AGENT_STATUS color table so a newly added status
// can't silently land in grey without updating tokens.ts.
export function bucketCounts(roster: TrayRoster): Counts {
  const c = { red: 0, grey: 0, green: 0 };
  for (const p of roster.projects) {
    for (const a of p.agents) {
      const color = AGENT_STATUS[a.status as keyof typeof AGENT_STATUS]?.color;
      if (color === GREEN) c.green++;
      else if (color === RED) c.red++;
      else c.grey++;
    }
  }
  return c;
}

// Menu-bar geometry, in logical px (multiplied by `scale` for retina). Tuned to the ~22pt bar.
const H = 22, DOT = 7, GAP = 3, PAD = 4, SEG_GAP = 9, FONT_PX = 12;

/** Draw "● n  ● n  ● n" in the brand palette into ctx. Returns the logical pixel size used. */
export function drawTrayIcon(
  ctx: CanvasRenderingContext2D,
  counts: Counts,
  scale: number,
): { width: number; height: number } {
  const segs = [
    { color: RED, n: counts.red },
    { color: GREY, n: counts.grey },
    { color: GREEN, n: counts.green },
  ];
  const FONT = `600 ${FONT_PX * scale}px "IBM Plex Sans", sans-serif`;
  ctx.font = FONT;
  // First pass: measure total width.
  let w = PAD;
  for (const s of segs) {
    w += DOT + GAP + ctx.measureText(String(s.n)).width / scale + SEG_GAP;
  }
  w = w - SEG_GAP + PAD;
  ctx.canvas.width = Math.ceil(w * scale);
  ctx.canvas.height = Math.ceil(H * scale);
  // Assigning canvas.width/height resets the 2D context state (including font) — re-apply.
  ctx.font = FONT;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.textBaseline = "middle";
  const cy = (H / 2) * scale;
  let x = PAD * scale;
  for (const s of segs) {
    ctx.globalAlpha = s.n === 0 ? 0.3 : 1;
    ctx.beginPath();
    ctx.fillStyle = s.color;
    ctx.arc(x + (DOT / 2) * scale, cy, (DOT / 2) * scale, 0, Math.PI * 2);
    ctx.fill();
    x += (DOT + GAP) * scale;
    const label = String(s.n);
    ctx.fillText(label, x, cy);
    x += ctx.measureText(label).width + SEG_GAP * scale;
    ctx.globalAlpha = 1;
  }
  return { width: w, height: H };
}
