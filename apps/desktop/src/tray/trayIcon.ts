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
// The strip is a translucent 4px-radius pill wrapping [sparkle glyph + three colored numbers]
// ("✦ n n n", red/grey/green, no dots). Zero counts are dimmed so a live count stands out.
const H = 22, PAD = 6, SEG_GAP = 8, FONT_PX = 13;
const PILL_INSET = 2;   // pill breathes inside the 22px strip
const GLYPH = 11;       // sparkle glyph square, logical px
const GLYPH_GAP = 6;    // glyph → first count
const PILL_BG = "rgba(127, 138, 160, 0.28)"; // neutral translucent — legible on light & dark bars
const GLYPH_COLOR = C.cream;

// IoSparkles from react-icons/io5 (Ionicons v5, MIT), inlined as raw path data so the canvas
// painter can fill it as a Path2D — no emoji glyphs in the menu bar. viewBox is 512x512.
export const IO_SPARKLES_PATH =
  "M208 512a24.84 24.84 0 0 1-23.34-16l-39.84-103.6a16.06 16.06 0 0 0-9.19-9.19L32 343.34a25 25 0 0 1 0-46.68l103.6-39.84a16.06 16.06 0 0 0 9.19-9.19L184.66 144a25 25 0 0 1 46.68 0l39.84 103.6a16.06 16.06 0 0 0 9.19 9.19l103 39.63a25.49 25.49 0 0 1 16.63 24.1 24.82 24.82 0 0 1-16 22.82l-103.6 39.84a16.06 16.06 0 0 0-9.19 9.19L231.34 496A24.84 24.84 0 0 1 208 512zm66.85-254.84zM88 176a14.67 14.67 0 0 1-13.69-9.4l-16.86-43.84a7.28 7.28 0 0 0-4.21-4.21L9.4 101.69a14.67 14.67 0 0 1 0-27.38l43.84-16.86a7.31 7.31 0 0 0 4.21-4.21L74.16 9.79A15 15 0 0 1 86.23.11a14.67 14.67 0 0 1 15.46 9.29l16.86 43.84a7.31 7.31 0 0 0 4.21 4.21l43.84 16.86a14.67 14.67 0 0 1 0 27.38l-43.84 16.86a7.28 7.28 0 0 0-4.21 4.21l-16.86 43.84A14.67 14.67 0 0 1 88 176zm312 80a16 16 0 0 1-14.93-10.26l-22.84-59.37a8 8 0 0 0-4.6-4.6l-59.37-22.84a16 16 0 0 1 0-29.86l59.37-22.84a8 8 0 0 0 4.6-4.6l22.67-58.95a16.45 16.45 0 0 1 13.17-10.57 16 16 0 0 1 16.86 10.15l22.84 59.37a8 8 0 0 0 4.6 4.6l59.37 22.84a16 16 0 0 1 0 29.86l-59.37 22.84a8 8 0 0 0-4.6 4.6l-22.84 59.37A16 16 0 0 1 400 256z";

const SPARKLES_VIEWBOX = 512;

// Lazily built + cached; Path2D is absent in jsdom/node, where the glyph is simply skipped
// (layout still reserves its slot, so tests and browsers agree on geometry).
let sparklesPath: Path2D | null | undefined;
function getSparklesPath(): Path2D | null {
  if (sparklesPath === undefined) {
    sparklesPath = typeof Path2D === "function" ? new Path2D(IO_SPARKLES_PATH) : null;
  }
  return sparklesPath;
}

/** The pill's rounded-rect geometry for a strip of `width` logical px. r is ALWAYS 4 —
 *  never h/2 — per the no-capsule rule. Exported for tests. */
export function pillRect(width: number): { x: number; y: number; w: number; h: number; r: number } {
  return { x: 0, y: PILL_INSET, w: width, h: H - PILL_INSET * 2, r: 4 };
}

// Manual rounded-rect trace (arcTo per corner) — ctx.roundRect is missing in older webviews
// and in the test stubs.
function tracePill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Paint the menu-bar strip: translucent 4px pill, IoSparkles glyph, then the red/grey/green
 *  counts. Returns the logical pixel size used. */
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
  // First pass: measure total width (logical px). measureText returns device px, so /scale.
  let w = PAD + GLYPH + GLYPH_GAP;
  for (const s of segs) {
    w += ctx.measureText(String(s.n)).width / scale + SEG_GAP;
  }
  w = w - SEG_GAP + PAD;
  ctx.canvas.width = Math.ceil(w * scale);
  ctx.canvas.height = Math.ceil(H * scale);
  // Assigning canvas.width/height resets the 2D context state (including font) — re-apply.
  ctx.font = FONT;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // 1. Pill background.
  const pill = pillRect(w);
  tracePill(ctx, pill.x * scale, pill.y * scale, pill.w * scale, pill.h * scale, pill.r * scale);
  ctx.fillStyle = PILL_BG;
  ctx.fill();

  // 2. Sparkle glyph (skipped where Path2D is unavailable; slot width is reserved either way).
  const glyphPath = getSparklesPath();
  if (glyphPath) {
    ctx.save();
    ctx.fillStyle = GLYPH_COLOR;
    ctx.translate(PAD * scale, ((H - GLYPH) / 2) * scale);
    const k = (GLYPH * scale) / SPARKLES_VIEWBOX;
    ctx.scale(k, k);
    ctx.fill(glyphPath);
    ctx.restore();
  }

  // 3. Counts.
  ctx.textBaseline = "middle";
  const cy = (H / 2) * scale;
  let x = (PAD + GLYPH + GLYPH_GAP) * scale;
  for (const s of segs) {
    ctx.globalAlpha = s.n === 0 ? 0.35 : 1;
    ctx.fillStyle = s.color;
    const label = String(s.n);
    ctx.fillText(label, x, cy);
    x += ctx.measureText(label).width + SEG_GAP * scale;
    ctx.globalAlpha = 1;
  }
  return { width: w, height: H };
}
