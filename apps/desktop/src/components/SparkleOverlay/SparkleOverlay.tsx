// The Living Sparkle Overlay — a full-window canvas particle swarm that IS Sparkle's
// presence: an edge-on galaxy resting in the top bar, rippling while you talk, sweeping
// front-and-center to answer, pouring into a card/row to point at it. Ported from the
// canonical prototype (PRD/sparkle/living-sparkle-overlay/prototype.html); the pure
// math lives in ./engine + ./state + ./presize so it stays unit-testable, and this file
// owns only the DOM: canvas painting, the orb-text bubble, and the controller surface.
//
// Flag-gated (VITE_SPARKLE_OVERLAY, off by default) and driven entirely from outside
// via SparkleOverlayController — this component reads no app stores, so Batch 2 can
// wire real mic/TTS/attention sources without touching this file's internals.
import {
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
// Brand constants (amber/accent are literal hex — canvas can't consume var()); the
// themed forest/cream vars flip with light/dark for the DOM pieces below.
import { C } from "../../theme/colors";
import {
  applyTransition,
  computeTargets,
  createParticles,
  galaxyDim,
  galaxySizeFactor,
  hexToRgba,
  particleCount,
  seedAtPerch,
  stepParticle,
  syntheticMicLevel,
  syntheticVoiceLevel,
  type LevelSource,
  type Particle,
  type Point,
  type Rect,
} from "./engine";
import { deriveFlags, type Anchor, type Mode, type OverlayState } from "./state";
import { orbTextMaxWidth, orbTextPosition, presize } from "./presize";
import { sparkleOverlayEnabled } from "./flag";

// The prototype's gold/hot/cool sprite trio. The gold and hot core are now the prototype's own
// `--gold` / `--gold-hot` (they were `lightenHex(C.amber, …)` re-derivations only because the
// palette had no gold token); the brand cyan accent replaces the prototype's periwinkle as the
// cool minority sparkle. All three stay literal hex — the sprite canvas can't consume var().
const GOLD_HEX = C.gold;
const HOT_HEX = C.goldHot;
const COOL_HEX = C.accent;

export interface SparkleOverlayController {
  /** Move the swarm (anchor) and set what it's doing (mode). Zip-flash on every call. */
  setState(anchor: Anchor, mode: Mode): void;
  /** Type what Sparkle HEARD ("you ·" prefix, fast stream) into the bubble. */
  hear(text: string): Promise<void>;
  /** Type Sparkle's reply (serif, caret) into the bubble. Resolves when typing ends. */
  reply(text: string): Promise<void>;
  /** Cancel any typing, clear the bubble, and send the swarm home motionless. */
  dismiss(): void;
  getState(): OverlayState;
}

export interface SparkleOverlayProps {
  /** Receives the imperative controller — pass `useSparkleOverlayController().ref`. */
  controllerRef?: Ref<SparkleOverlayController>;
  /** Live mic level 0..1 (sampled per frame while listening). Default: synthetic sine. */
  micLevelSource?: LevelSource;
  /** Live TTS output level 0..1 (sampled while speaking). Default: synthetic sine. */
  voiceLevelSource?: LevelSource;
  /** Where the galaxy home sits. Default: top-center of the window (prototype slot). */
  getPerchRect?: () => Rect | null;
  /** The card the 'card' anchor points at — Batch 2 passes the real element's rect. */
  getCardRect?: () => Rect | null;
  /** The agent row the 'row' anchor pours into (handoff). */
  getRowRect?: () => Rect | null;
  /** Called when a click-anywhere dismisses the front-and-center swarm. */
  onDismiss?: () => void;
  /** Test/demo override for the env flag. */
  enabled?: boolean;
}

/** The default perch: the prototype's galaxy slot, centered in the top bar. */
function defaultPerchRect(): Rect {
  return { left: window.innerWidth / 2 - 132, top: 7, width: 264, height: 24 };
}

function rectCenter(r: Rect): Point {
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** matchMedia is absent under jsdom — treat "can't ask" as "no reduction requested". */
function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** 64px radial-gradient star sprite (returns null where 2d canvas is unavailable, e.g. jsdom). */
function makeSprite(hex: string): HTMLCanvasElement | null {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  if (!g) return null;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, hex + "ff");
  grad.addColorStop(0.25, hex + "aa");
  grad.addColorStop(0.6, hex + "33");
  grad.addColorStop(1, hex + "00");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

/**
 * Hook returning a stable controller you can hold BEFORE the overlay mounts (and
 * across flag-off renders): every method safely no-ops until the component attaches.
 * Usage: `const sparkle = useSparkleOverlayController();`
 *        `<SparkleOverlay controllerRef={sparkle.ref} />` … `sparkle.reply("…")`.
 */
export function useSparkleOverlayController(): SparkleOverlayController & {
  ref: (c: SparkleOverlayController | null) => void;
} {
  const inst = useRef<SparkleOverlayController | null>(null);
  return useMemo(
    () => ({
      ref: (c: SparkleOverlayController | null) => {
        inst.current = c;
      },
      setState: (a: Anchor, m: Mode) => inst.current?.setState(a, m),
      hear: (text: string) => inst.current?.hear(text) ?? Promise.resolve(),
      reply: (text: string) => inst.current?.reply(text) ?? Promise.resolve(),
      dismiss: () => inst.current?.dismiss(),
      getState: () =>
        inst.current?.getState() ?? { anchor: "perch" as const, mode: "still" as const },
    }),
    [],
  );
}

/** Flag gate: renders nothing at all unless enabled (prop override, else VITE_SPARKLE_OVERLAY). */
export function SparkleOverlay(props: SparkleOverlayProps) {
  const enabled = props.enabled ?? sparkleOverlayEnabled();
  if (!enabled) return null;
  return <SparkleOverlayInner {...props} />;
}

function SparkleOverlayInner({
  controllerRef,
  micLevelSource = syntheticMicLevel,
  voiceLevelSource = syntheticVoiceLevel,
  getPerchRect,
  getCardRect,
  getRowRect,
  onDismiss,
}: SparkleOverlayProps) {
  const [ui, setUi] = useState<OverlayState>({ anchor: "perch", mode: "still" });
  const flags = deriveFlags(ui.anchor, ui.mode);
  const reduced = useMemo(() => prefersReducedMotion(), []);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const orbRef = useRef<HTMLDivElement | null>(null);
  const heardRef = useRef<HTMLDivElement | null>(null);
  const replyRef = useRef<HTMLDivElement | null>(null);

  // The rAF loop reads these refs directly — routing per-frame values through React
  // state would re-render the whole overlay 60×/s (same pattern as LogoWaveform).
  const stateRef = useRef<OverlayState>(ui);
  const partsRef = useRef<Particle[]>([]);
  const tRef = useRef(0);
  const burstRef = useRef(0);
  const micRef = useRef(0);
  const voiceRef = useRef(0);
  const typingRef = useRef(false);
  const seqRef = useRef(0);
  const typeTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Latest injected sources/rect-getters, without re-arming the rAF effect on change.
  const sourcesRef = useRef({ micLevelSource, voiceLevelSource, getPerchRect, getCardRect, getRowRect });
  useEffect(() => {
    sourcesRef.current = { micLevelSource, voiceLevelSource, getPerchRect, getCardRect, getRowRect };
  });

  const perchRect = (): Rect => sourcesRef.current.getPerchRect?.() ?? defaultPerchRect();

  const typeResolveRef = useRef<(() => void) | null>(null);
  const stopTyping = () => {
    if (typeTimerRef.current !== null) {
      clearInterval(typeTimerRef.current);
      typeTimerRef.current = null;
    }
    typingRef.current = false;
    // Resolve (never reject) whatever hear/reply run is in flight, so an external
    // driver awaiting it can't hang when a dismiss/supersede cancels the typing.
    const res = typeResolveRef.current;
    typeResolveRef.current = null;
    res?.();
  };

  const resetText = () => {
    stopTyping();
    for (const el of [heardRef.current, replyRef.current]) {
      if (!el) continue;
      el.style.display = "none";
      el.textContent = "";
      el.style.minWidth = "";
      el.style.minHeight = "";
    }
  };

  // Cached orb-text box so the render loop never measures per frame. The orb only
  // moves on state transitions, presize, and resize — placeOrb() refreshes this each
  // of those times, and frame() reads the cache instead of forcing a reflow 60×/s.
  const orbBoxRef = useRef<Rect | null>(null);

  const placeOrb = () => {
    const orb = orbRef.current;
    if (!orb) return;
    const { anchor } = stateRef.current;
    const home = perchRect();
    const pos = orbTextPosition(anchor, {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      homeBottom: home.top + home.height,
      orbHeight: orb.offsetHeight,
      cardBox: sourcesRef.current.getCardRect?.() ?? null,
      rowBox: sourcesRef.current.getRowRect?.() ?? null,
    });
    orb.style.left = `${pos.x}px`;
    orb.style.top = `${pos.y}px`;
    // Cache the orb's DESTINATION box analytically rather than measuring it. The orb
    // animates top/left via a .28s CSS transition, so getBoundingClientRect() right after
    // the write returns the pre-transition (starting) rect — and since placeOrb() no longer
    // runs per frame, that stale value would persist and particles would hug where the orb
    // *was*. transform: translate(-50%,-50%) makes (pos.x,pos.y) the center; offsetWidth/
    // Height are transition-independent (size is locked by presize before typing), so this
    // is the settled box the orb is heading to. Layout read only on transition/presize/
    // resize — never per frame.
    const w = orb.offsetWidth;
    const h = orb.offsetHeight;
    orbBoxRef.current = { left: pos.x - w / 2, top: pos.y - h / 2, width: w, height: h };
  };

  const setSwarmState = (anchor: Anchor, mode: Mode) => {
    stateRef.current = { anchor, mode };
    burstRef.current = 1; // zip flash on every transition
    const spawn =
      anchor === "perch"
        ? rectCenter(perchRect())
        : { x: window.innerWidth / 2, y: window.innerHeight / 2 - 60 };
    applyTransition(partsRef.current, anchor, spawn);
    setUi({ anchor, mode });
    placeOrb();
  };

  // Typing shared by hear/reply. Each keystroke is a direct textContent write (no
  // re-render per character); `seq` cancels superseded runs, and every run resolves
  // through stopTyping — completion, supersede, and dismiss all release the awaiter.
  const typeInto = (
    el: HTMLElement,
    text: string,
    step: number,
    intervalMs: number,
    caret: HTMLElement | null,
  ): Promise<void> => {
    const mySeq = seqRef.current;
    stopTyping(); // release any previous run before starting this one
    return new Promise((res) => {
      typeResolveRef.current = res;
      typingRef.current = caret !== null; // only replies count as "Sparkle is talking"
      let i = 0;
      typeTimerRef.current = setInterval(() => {
        if (mySeq !== seqRef.current) {
          stopTyping();
          return;
        }
        i += step;
        el.textContent = text.slice(0, i);
        if (i < text.length) {
          if (caret) el.appendChild(caret);
        } else {
          stopTyping();
        }
      }, intervalMs);
    });
  };

  const controller = useMemo<SparkleOverlayController>(() => {
    const doPresize = (el: HTMLElement, text: string) => {
      presize(el, text, orbTextMaxWidth(window.innerWidth));
      placeOrb();
    };
    return {
      setState: setSwarmState,
      hear(text: string) {
        const el = heardRef.current;
        if (!el) return Promise.resolve();
        doPresize(el, text);
        return typeInto(el, text, 3, 22, null);
      },
      reply(text: string) {
        const el = replyRef.current;
        if (!el) return Promise.resolve();
        doPresize(el, text);
        const caret = document.createElement("span");
        caret.style.cssText =
          `display:inline-block;width:7px;height:15px;vertical-align:-2px;margin-left:2px;` +
          `background:${C.amber};` +
          // Reduced motion: the caret holds steady instead of blinking (prototype parity).
          (reduced ? "" : "animation:sparkle-caret-blink .8s steps(1) infinite;");
        return typeInto(el, text, 2, 26, caret);
      },
      dismiss() {
        seqRef.current++;
        resetText();
        setSwarmState("perch", "still");
      },
      getState: () => stateRef.current,
    };
    // The controller closes over refs only — stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  useImperativeHandle(controllerRef, () => controller, [controller]);

  // Click anywhere (outside nothing — the overlay is pointer-transparent) returns
  // Sparkle to its perch, exactly like the prototype's document-level dismiss.
  useEffect(() => {
    if (ui.anchor === "perch") return;
    const onDown = () => {
      seqRef.current++;
      resetText();
      setSwarmState("perch", "still");
      onDismiss?.();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.anchor, onDismiss]);

  // The render loop. Mounted once; everything it needs lives in refs.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;
    partsRef.current = createParticles(particleCount(reduced));
    seedAtPerch(partsRef.current, rectCenter(perchRect()));

    if (!canvas || !ctx) return; // jsdom / no-2d: state machine still works, no painting

    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    let W = 0;
    let H = 0;
    const resize = () => {
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = W * DPR;
      canvas.height = H * DPR;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      // Reposition the orb (and refresh its cached box) for the new viewport size.
      placeOrb();
    };
    window.addEventListener("resize", resize);
    resize();

    const sprites: Record<Particle["sprite"], HTMLCanvasElement | null> = {
      gold: makeSprite(GOLD_HEX),
      hot: makeSprite(HOT_HEX),
      cool: makeSprite(COOL_HEX),
    };
    const streakStyle = hexToRgba(GOLD_HEX, 0.55);

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      tRef.current += dt;
      const t = tRef.current;
      burstRef.current = Math.max(0, burstRef.current - dt * 2.6);
      const { anchor, mode } = stateRef.current;

      // Mic: sample the injected source only while listening; decay to 0 otherwise.
      micRef.current =
        mode === "listening"
          ? sourcesRef.current.micLevelSource(t)
          : Math.max(0, micRef.current - dt * 3);
      // Voice: track the source while speaking or while a reply is typing (typing
      // stands in for voice until the TTS unit lands); decay to silence otherwise.
      if (mode === "speaking" || typingRef.current) {
        voiceRef.current +=
          (sourcesRef.current.voiceLevelSource(t) - voiceRef.current) * 0.35;
      } else {
        voiceRef.current = Math.max(0, voiceRef.current - dt * 3);
      }
      const mic = micRef.current;
      const voice = voiceRef.current;
      const burst = burstRef.current;

      const orbBox: Rect =
        orbRef.current && flagsOf(anchor, mode).orbTextVisible && orbBoxRef.current
          ? orbBoxRef.current
          : { left: W / 2 - 90, top: H / 2 - 120, width: 180, height: 120 };
      computeTargets(partsRef.current, {
        anchor,
        mode,
        t,
        micLevel: mic,
        voiceLevel: voice,
        perch: rectCenter(perchRect()),
        orbBox,
        cardBox: sourcesRef.current.getCardRect?.() ?? null,
        rowBox: sourcesRef.current.getRowRect?.() ?? null,
      });

      ctx.clearRect(0, 0, W, H);
      // Additive compositing: overlapping sparkles brighten instead of occlude.
      ctx.globalCompositeOperation = "lighter";

      const level = mode === "listening" ? mic : voice;
      for (const p of partsRef.current) {
        const sp2 = stepParticle(p, dt);

        // Absorbed / fully-faded particles are invisible — skip before any drawing,
        // so a resting absorbed particle can never emit a stray streak.
        if (p.absorbed || p.fade <= 0) continue;

        // Streak while zipping — the comet tail during fast transit only.
        if (sp2 > 90000) {
          ctx.globalAlpha = 0.5;
          ctx.strokeStyle = streakStyle;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - p.vx * 0.045, p.y - p.vy * 0.045);
          ctx.stroke();
        }

        p.tw +=
          p.twS * dt * (mode === "listening" ? 2.2 : mode === "speaking" ? 1.6 : 0.45);
        const gDim = anchor === "perch" ? galaxyDim(p.gBoost) : 1;
        const a =
          ((0.4 + 0.5 * (Math.sin(p.tw) * 0.5 + 0.5)) * (0.7 + level * 0.3) +
            burst * 0.3) *
          p.fade *
          gDim;
        const s =
          p.size *
          (anchor === "perch" ? galaxySizeFactor(p.gBoost) : 1) *
          (1 + level * 0.35 + burst * 0.5);
        const sprite = sprites[p.sprite];
        if (!sprite) continue;
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(sprite, p.x - s, p.y - s, s * 2, s * 2);
      }

      // Listening halo hugs the shell while Sparkle is out front hearing you.
      if (mode === "listening" && anchor !== "perch") {
        const cx = orbBox.left + orbBox.width / 2;
        const cy = orbBox.top + orbBox.height / 2;
        const r = Math.max(120, orbBox.width / 2 + 70) + mic * 26;
        const g = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r);
        g.addColorStop(0, hexToRgba(C.amber, 0));
        g.addColorStop(0.82, hexToRgba(C.amber, 0.08 + mic * 0.12));
        g.addColorStop(1, hexToRgba(C.amber, 0));
        ctx.globalAlpha = 1;
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 7);
        ctx.fill();
      }

      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced]);

  // Clear any orphaned typing interval on unmount.
  useEffect(() => stopTyping, []);

  const infusedGlow = (r: Rect, key: string) => (
    <div
      key={key}
      aria-hidden
      style={{
        position: "fixed",
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        zIndex: 38,
        pointerEvents: "none",
        borderRadius: 12,
        // "Infused with sparkle energy": a pure, motionless amber glow — no orbiting.
        boxShadow: `0 0 0 1px ${hexToRgba(C.amber, 0.5)}, 0 0 46px ${hexToRgba(C.amber, 0.34)}, inset 0 0 34px ${hexToRgba(C.amber, 0.14)}`,
        transition: "box-shadow .5s ease",
      }}
    />
  );
  const cardRect = flags.cardInfused ? (getCardRect?.() ?? null) : null;
  const rowRect = flags.rowInfused ? (getRowRect?.() ?? null) : null;

  return (
    <div data-sparkle-overlay data-anchor={ui.anchor} data-mode={ui.mode}>
      {/* Component-local CSS (no existing stylesheet is edited): caret blink keyframes
          plus the "you ·" attribution prefix on the heard line, prototype-style. */}
      <style>{
        `@keyframes sparkle-caret-blink { 50% { opacity: 0; } }` +
        `[data-sparkle-heard]::before { content: "you · "; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; opacity: .75; }`
      }</style>

      {/* Dim veil: the app recedes ONLY while Sparkle answers front-and-center. */}
      {flags.dimmed && (
        <div
          data-sparkle-veil
          aria-hidden
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 39,
            pointerEvents: "none",
            background: "rgba(0,0,0,.45)",
            transition: "background .35s ease",
          }}
        />
      )}

      {cardRect && infusedGlow(cardRect, "card")}
      {rowRect && infusedGlow(rowRect, "row")}

      <canvas
        ref={canvasRef}
        aria-hidden
        style={{ position: "fixed", inset: 0, zIndex: 40, pointerEvents: "none" }}
      />

      {/* Text INSIDE the sparkle. The bubble resizes to the text (presize locks the
          final box before typing); themed surface so it holds up in light mode too. */}
      <div
        ref={orbRef}
        data--text
        style={{
          position: "fixed",
          zIndex: 45,
          pointerEvents: "none",
          width: "max-content",
          maxWidth: "min(480px, 72vw)",
          transform: "translate(-50%, -50%)",
          display: flags.orbTextVisible ? "flex" : "none",
          flexDirection: "column",
          gap: 8,
          alignItems: "center",
          textAlign: "center",
          padding: "26px 34px",
          borderRadius: 26,
          background: `radial-gradient(ellipse at center, color-mix(in srgb, ${C.forest} 92%, transparent) 40%, color-mix(in srgb, ${C.forest} 55%, transparent) 75%, transparent 100%)`,
          transition:
            "top .28s cubic-bezier(.3,1.1,.35,1), left .28s cubic-bezier(.3,1.1,.35,1)",
        }}
      >
        {/* What it heard. The "you ·" attribution rides as a ::before (see the style
            tag above) so it sits outside the presized typing target, prototype-style. */}
        <div
          ref={heardRef}
          data-sparkle-heard
          style={{
            display: "none",
            color: C.muted,
            fontSize: 13,
            letterSpacing: ".01em",
            textAlign: "left",
          }}
        />
        <div
          ref={replyRef}
          data-sparkle-reply
          style={{
            display: "none",
            fontFamily: '"Iowan Old Style", "Palatino", "Georgia", serif',
            fontSize: 17.5,
            lineHeight: 1.45,
            color: C.amber,
            textShadow: `0 0 18px ${hexToRgba(C.amber, 0.3)}`,
            textAlign: "left",
          }}
        />
      </div>
    </div>
  );
}

// Local helpers kept below the component for readability.
function flagsOf(anchor: Anchor, mode: Mode) {
  return deriveFlags(anchor, mode);
}
