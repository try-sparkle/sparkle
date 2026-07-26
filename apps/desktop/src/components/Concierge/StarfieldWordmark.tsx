// The "Sparkle" wordmark with a dense star field living THROUGH it — no background box or
// shading; the stars are part of the column. Still at rest (slow firefly drift + twinkle),
// a buzzy waveform only while listening/speaking. Ported from the canonical prototype
// (PRD/sparkle/concierge-mode/prototype.html); all motion math lives in ./starfieldMath so
// this file owns only the canvas painting and the brand text.
import { useEffect, useRef, useState } from "react";
// Brand amber is a literal hex constant (canvas can't consume var()); the gold/hot tints are
// re-derived from it the same way SparkleOverlay maps the prototype's gold palette.
import { C, FONT_WEIGHT } from "../../theme/colors";
import { lightenHex } from "../SparkleOverlay/engine";
import {
  advanceTwinkle,
  buzzLevel,
  createStars,
  REDUCED_STAR_COUNT,
  STAR_COUNT,
  starFrame,
  stepActiveAmt,
  stepFlick,
  type Star,
} from "./starfieldMath";
import type { WordmarkMode } from "./types";

const GOLD_HEX = lightenHex(C.amber, 0.45);
const HOT_HEX = lightenHex(C.amber, 0.8);

/** matchMedia is absent under jsdom — treat "can't ask" as "no reduction requested". */
function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Soft radial star sprite (returns null where 2d canvas is unavailable, e.g. jsdom). */
function makeStarSprite(): HTMLCanvasElement | null {
  const c = document.createElement("canvas");
  c.width = c.height = 22;
  const g = c.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(11, 11, 0, 11, 11, 11);
  grad.addColorStop(0, HOT_HEX + "ff");
  grad.addColorStop(0.35, HOT_HEX + "aa");
  grad.addColorStop(0.75, GOLD_HEX + "22");
  grad.addColorStop(1, GOLD_HEX + "00");
  g.fillStyle = grad;
  g.fillRect(0, 0, 22, 22);
  return c;
}

export function StarfieldWordmark({
  mode,
  height = 50,
  text = "Sparkle",
}: {
  mode: WordmarkMode;
  height?: number;
  text?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Long-lived animation state in refs so a mode change re-targets the loop WITHOUT rebuilding it
  // (no sprite/rect/listener churn per transition): same stars, same envelope, new drive only.
  const starsRef = useRef<Star[] | null>(null);
  const activeAmtRef = useRef(0);
  const flickRef = useRef(0);
  const tRef = useRef(0);
  const modeRef = useRef<WordmarkMode>(mode); // the rAF loop reads the latest mode (updated in an effect)
  const reducedRef = useRef(false);
  const redrawStaticRef = useRef<(() => void) | null>(null);
  // Bumped when the OS reduced-motion preference flips at runtime, to re-arm the field.
  const [reducedTick, setReducedTick] = useState(0);

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedTick((x) => x + 1);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return; // jsdom / headless — the brand text still renders
    const sprite = makeStarSprite();
    if (!sprite) return;

    const reduced = prefersReducedMotion();
    reducedRef.current = reduced;
    // (Re)build the field to the count the current preference calls for (also picks up a live toggle).
    starsRef.current = createStars(reduced ? REDUCED_STAR_COUNT : STAR_COUNT);
    const stars = starsRef.current;

    let cw = 0;
    let ch = 0;
    const size = () => {
      const r = cv.getBoundingClientRect();
      cw = r.width;
      ch = r.height;
      cv.width = cw * 2;
      cv.height = ch * 2;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
    };
    size();
    addEventListener("resize", size);

    const draw = (activeAmt: number, level: number, t: number) => {
      const cx = cw / 2;
      const cy = ch * 0.5;
      const rx = cw * 0.46;
      const ry = ch * 0.4;
      ctx.clearRect(0, 0, cw, ch);
      ctx.globalCompositeOperation = "lighter";
      for (const s of stars) {
        const f = starFrame(s, t, activeAmt, level, cx, cy, rx, ry);
        ctx.globalAlpha = f.alpha;
        ctx.drawImage(sprite, f.x - f.size, f.y - f.size, f.size * 2, f.size * 2);
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = 1;
    };

    if (reduced) {
      // Reduced motion: no loop — draw one static frame, and expose a redraw the mode-effect calls
      // so a mode change still updates the (static) field without any animation.
      const redraw = () =>
        draw(modeRef.current === "idle" ? 0 : 1, buzzLevel(modeRef.current, 0.5), tRef.current);
      // `size` clears the canvas on resize; with no loop to repaint it, redraw the static frame.
      const onResize = () => redraw();
      addEventListener("resize", onResize);
      redraw();
      redrawStaticRef.current = redraw;
      return () => {
        removeEventListener("resize", size);
        removeEventListener("resize", onResize);
        redrawStaticRef.current = null;
      };
    }

    redrawStaticRef.current = null;
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      tRef.current += dt;
      const m = modeRef.current;
      activeAmtRef.current = stepActiveAmt(activeAmtRef.current, m);
      flickRef.current = stepFlick(flickRef.current);
      const level = buzzLevel(m, flickRef.current);
      for (const s of stars) s.tw = advanceTwinkle(s.tw, s.tws, dt, activeAmtRef.current);
      draw(activeAmtRef.current, level, tRef.current);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener("resize", size);
    };
  }, [reducedTick]);

  // Keep the loop's mode ref current, and (reduced motion only, loop off) redraw the static frame.
  useEffect(() => {
    modeRef.current = mode;
    if (reducedRef.current) redrawStaticRef.current?.();
  }, [mode]);

  return (
    <div
      style={{
        position: "relative",
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden
        style={{
          position: "absolute",
          inset: "-6px -8px",
          width: "calc(100% + 16px)",
          height: "calc(100% + 12px)",
        }}
      />
      {/* The wordmark sits IN the field: a soft same-as-column shadow lifts the letters off
          the stars without any box/shading behind them. */}
      <div
        style={{
          position: "relative",
          zIndex: 2,
          fontWeight: FONT_WEIGHT.bold,
          fontSize: 16,
          letterSpacing: "0.08em",
          color: HOT_HEX,
          textShadow: `0 0 10px ${C.deepForest}, 0 0 6px ${C.deepForest}, 0 0 3px ${C.deepForest}`,
        }}
      >
        {text}
      </div>
    </div>
  );
}
