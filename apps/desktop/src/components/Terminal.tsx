import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { C, CHAT_USER_BUBBLE, xtermTheme } from "../theme/colors";
import { useResolvedTheme } from "../theme/theme";
import type { AgentTabStatus } from "../types";
import { spawnPty, writePty, killPty, resizePty, onPtyOutput, onPtyExit } from "../pty";
import { StatusEngine } from "../engine/statusEngine";
import { snapshotScreen } from "../engine/screenSnapshot";
import { useUiStore } from "../stores/uiStore";
import { shouldRouteToComposer } from "./terminalInput";
import { wheelToScrollLines } from "./terminalScroll";

// Terminal font size at 100%. The ⋯-menu "Text size" control (and Cmd +/-) multiplies
// this by the `zoom` factor, so it scales the terminal text only — not the UI chrome.
const BASE_FONT_SIZE = 13;

/**
 * Copy text to the system clipboard. Prefers the async Clipboard API (available in the
 * Tauri webview under a user gesture); falls back to a hidden-textarea execCommand for
 * environments where the async API is blocked. Returns whether the copy succeeded.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the execCommand path */
  }
  try {
    // Selecting the temp textarea steals focus from xterm; remember the focused element
    // (xterm's hidden input) so we can hand focus straight back after copying.
    const prevActive = document.activeElement as HTMLElement | null;
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    prevActive?.focus?.();
    return ok;
  } catch {
    return false;
  }
}

/**
 * One xterm.js terminal bound to one agent's PTY (spec §3). Spawns the command on
 * mount, streams pty:output into the terminal AND the statusEngine, forwards
 * keystrokes back to the PTY, and tears the PTY down on unmount. Mouse-select + Cmd+C
 * copy are built into xterm.
 */
export function Terminal({
  agentId,
  command,
  args,
  cwd,
  active,
  onStatus,
  onReady,
  onExit,
  onRequestFocus,
  onComposerType,
}: {
  agentId: string;
  command: string;
  args: string[];
  cwd: string;
  active: boolean;
  onStatus: (s: AgentTabStatus) => void;
  onReady?: () => void;
  onExit?: () => void;
  // Called when the active tab is shown, to put initial focus in the composer.
  onRequestFocus?: () => void;
  // Called when the user types a printable character in the terminal — the parent routes
  // it into the composer (carrying the char). Mouse selection, Cmd+C copy, and arrow/enter
  // TUI-menu navigation still work directly in the terminal.
  onComposerType?: (ch: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // The WebGL renderer (when available) caches colored glyphs in a texture atlas — kept so the
  // live re-theme effect can clear it and force already-painted cells to repaint.
  const webglRef = useRef<WebglAddon | null>(null);
  // Latest onRequestFocus, read by the (agentId-keyed) effect without re-subscribing.
  const onRequestFocusRef = useRef(onRequestFocus);
  onRequestFocusRef.current = onRequestFocus;
  const onComposerTypeRef = useRef(onComposerType);
  onComposerTypeRef.current = onComposerType;
  const zoom = useUiStore((s) => s.zoom);
  const resolvedTheme = useResolvedTheme();
  // Brief "Copied to clipboard" flash shown after a mouse selection is copied.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    const unlistens: Array<() => void> = [];

    const term = new XTerm({
      // System monospaces (Menlo/SF Mono) carry full box-drawing glyphs as a fallback;
      // the Google-Fonts subset of Source Code Pro drops U+2500-block glyphs.
      fontFamily: '"Source Code Pro", "SF Mono", Menlo, ui-monospace, monospace',
      // Initial size; the zoom effect below keeps this in sync as the user adjusts it.
      fontSize: Math.round(BASE_FONT_SIZE * zoom),
      // Must be 1.0 so box-drawing verticals (│ ╭ ╰) connect across rows with no gap.
      lineHeight: 1.0,
      // Draw box-drawing / block glyphs as exact-cell vectors (renderer-level), so they
      // align regardless of the font — fixes misaligned TUI borders (e.g. Claude's box).
      customGlyphs: true,
      cursorBlink: true,
      scrollback: 8000,
      // Concrete hex (xterm can't read CSS var()); the effect below keeps it in sync when the
      // resolved theme changes. Initial value captured at mount.
      theme: xtermTheme(resolvedTheme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // WebGL renderer enables customGlyphs (the default DOM renderer does not), giving
    // crisp, exactly-aligned box-drawing. Fall back silently if WebGL is unavailable.
    try {
      const webgl = new WebglAddon();
      // On context loss the addon disposes itself and the default renderer takes over; null the
      // ref too so the re-theme effect doesn't call clearTextureAtlas() on a disposed addon
      // (term.refresh alone repaints under the default renderer).
      webgl.onContextLoss(() => {
        webgl.dispose();
        webglRef.current = null;
      });
      term.loadAddon(webgl);
      webglRef.current = webgl;
    } catch {
      /* no WebGL — keep the default renderer (TUI borders may be less crisp) */
    }
    try {
      fit.fit();
    } catch {
      /* container not laid out yet; the ResizeObserver will fit shortly */
    }
    termRef.current = term;
    fitRef.current = fit;

    // Engine owns the tab status. It reads the rendered screen on settle (via getScreen)
    // to decide red-vs-gray, so it must be created after the terminal exists.
    const engine = new StatusEngine({
      agentId,
      onStatus,
      getScreen: () => snapshotScreen(term.buffer.active, term.rows),
    });

    // Forward keystrokes typed directly in the terminal to the PTY.
    term.onData((d) => {
      void writePty(agentId, d);
    });

    // Keep the terminal fully usable for text selection, copy, and TUI menu navigation,
    // but route prompt-typing to the composer: a bare printable character pops the user
    // into the composer (carrying that character). Modifier combos (Cmd+C copy/paste,
    // etc.), arrows, Enter, Tab, Esc and other control keys stay in the terminal so menus
    // and selection keep working underneath.
    term.attachCustomKeyEventHandler((e) => {
      if (shouldRouteToComposer(e, term.buffer.active.type)) {
        onComposerTypeRef.current?.(e.key);
        return false;
      }
      return true;
    });

    // Mouse-wheel scrollback. Because the PTY runs with TERM=xterm-256color, agent
    // CLIs enable mouse tracking, and xterm hands the wheel to the app — which stops
    // the wheel from scrolling output history. On the NORMAL buffer (where scrollback
    // lives) we take the wheel back and scroll xterm ourselves; on the ALTERNATE
    // buffer (full-screen TUIs with no scrollback) we let the app keep the wheel so
    // its own mouse handling still works.
    let wheelCarry = 0;
    term.attachCustomWheelEventHandler((e) => {
      if (term.buffer.active.type !== "normal") {
        // Don't carry a partial-line remainder into the next normal-buffer scroll;
        // the alternate buffer owns the wheel here.
        wheelCarry = 0;
        return true;
      }
      // clientHeight / rows ≈ one cell's CSS height; used to turn pixels into lines.
      const cellHeight = term.element ? term.element.clientHeight / term.rows : 0;
      const { lines, carry } = wheelToScrollLines(e, cellHeight, term.rows, wheelCarry);
      wheelCarry = carry;
      if (lines !== 0) term.scrollLines(lines);
      return false; // handled here — don't forward the wheel to the app
    });

    void (async () => {
      const offOut = await onPtyOutput((e) => {
        if (e.id !== agentId) return;
        term.write(e.chunk);
        engine.ingest(e.chunk);
      });
      const offExit = await onPtyExit((e) => {
        if (e.id !== agentId) return;
        engine.exit();
        onExit?.();
      });
      if (disposed) {
        offOut();
        offExit();
        return;
      }
      unlistens.push(offOut, offExit);
      await spawnPty({ id: agentId, command, args, cwd, cols: term.cols, rows: term.rows });
      if (!disposed) onReady?.();
    })();

    // Copy-on-select: when the user finishes a mouse selection, copy it to the clipboard
    // and flash a confirmation so the (otherwise invisible) copy is obvious. A plain click
    // leaves an empty selection — nothing is copied and no toast shows.
    const onMouseUp = () => {
      const sel = term.getSelection();
      if (!sel || sel.trim().length === 0) return;
      void copyToClipboard(sel).then((ok) => {
        // The async clipboard write can resolve after this terminal unmounts (e.g. the
        // user switched agents mid-copy); don't touch state or schedule a timer if so.
        if (disposed || !ok) return;
        setCopied(true);
        if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1100);
      });
    };
    container.addEventListener("mouseup", onMouseUp);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        void resizePty(agentId, term.cols, term.rows);
      } catch {
        /* ignore transient fit errors while hidden */
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      container.removeEventListener("mouseup", onMouseUp);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      for (const off of unlistens) off();
      void killPty(agentId);
      engine.dispose();
      term.dispose();
      webglRef.current = null;
    };
    // agentId is stable for the life of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Re-fit when this tab becomes the active one (was display:none). Focus goes to the
  // composer, not the terminal — all input lives in the composer overlay.
  useEffect(() => {
    if (!active) return;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    requestAnimationFrame(() => {
      try {
        fit.fit();
        onRequestFocusRef.current?.();
        void resizePty(agentId, term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
  }, [active, agentId]);

  // "Text size" scales the terminal font only (not the UI chrome). Update the live font
  // size, then re-fit so the terminal's cols/rows and PTY size track the new cell
  // dimensions instead of going stale.
  useEffect(() => {
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    term.options.fontSize = Math.round(BASE_FONT_SIZE * zoom);
    const raf = requestAnimationFrame(() => {
      try {
        fit.fit();
        void resizePty(agentId, term.cols, term.rows);
      } catch {
        /* ignore transient fit errors */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [zoom, agentId]);

  // Re-theme the live terminal when the resolved theme changes (Light/Dark/Auto toggle or an
  // OS appearance change while on Auto). xterm needs concrete hex, so it can't follow the CSS
  // var() flip the rest of the app rides on — we push a fresh theme object instead.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme(resolvedTheme);
    // The WebGL renderer caches colored glyphs in a texture atlas; a bare options.theme set
    // can leave already-painted cells with stale colors until the next reflow. Clear the atlas
    // and force a full repaint so the live toggle is instantaneous like the rest of the app.
    webglRef.current?.clearTextureAtlas();
    term.refresh(0, term.rows - 1);
  }, [resolvedTheme]);

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%", overflow: "hidden" }} />
      {/* Copy-to-clipboard flash. Fades out via opacity; pointer-events:none so it never
          intercepts a selection drag underneath it. */}
      <div
        style={{
          position: "absolute",
          top: 10,
          left: "50%",
          transform: "translateX(-50%)",
          padding: "6px 14px",
          borderRadius: 8,
          background: C.deepForest,
          color: C.cream,
          border: `1px solid ${CHAT_USER_BUBBLE}`,
          fontFamily: '"IBM Plex Sans", sans-serif',
          fontSize: 13,
          boxShadow: "0 4px 12px rgba(0,0,0,0.35)",
          pointerEvents: "none",
          opacity: copied ? 1 : 0,
          transition: "opacity 160ms ease",
          zIndex: 10,
        }}
      >
        ✓ Copied to clipboard
      </div>
    </div>
  );
}
