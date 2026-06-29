import { useEffect, useRef, useState, type RefObject } from "react";
import { Terminal as XTerm, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyToClipboard } from "../clipboard";
import { C, CHAT_USER_BUBBLE, xtermTheme } from "../theme/colors";
import { useResolvedTheme } from "../theme/theme";
import type { AgentTabStatus } from "../types";
import { spawnPty, writePty, killPty, resizePty, onPtyOutput, onPtyExit, ignorePtyGone } from "../pty";
import { StatusEngine } from "../engine/statusEngine";
import { snapshotScreen } from "../engine/screenSnapshot";
import { useUiStore } from "../stores/uiStore";
import { useInteractionStore } from "../stores/interactionStore";
import { isComposerToggleKey } from "./composerToggle";
import { arrowKeySequence } from "./composerArrowOverflow";
import { wheelToScrollLines } from "./terminalScroll";
import { SelectionPopup } from "./SelectionPopup";
import { recoverFromWebglContextLoss } from "./terminalWebgl";
import { detectRateLimitReset } from "../services/rateLimitWatch";
import { PH_NO_CAPTURE_CLASS } from "@sparkle/core";

// Terminal font size at 100%. The ⋯-menu "Text size" control (and Cmd +/-) multiplies
// this by the `zoom` factor, so it scales the terminal text only — not the UI chrome.
const BASE_FONT_SIZE = 13;

// When jumping to a prompt's marker, scroll a few rows above it so the matched turn has lead-in
// context rather than sitting flush at the viewport top.
const SCROLL_LEAD_IN_ROWS = 2;

/**
 * Imperative handle the parent uses to drive this terminal without the user clicking it.
 */
export interface TerminalApi {
  // Hand a vertical arrow off from the composer: focus the terminal AND inject the keypress in
  // one shot, so a single Down (off the composer's last line) or Up (off its first line) both
  // moves focus here and drives whatever's waiting — e.g. Claude's permission menu. The escape
  // sequence honors the app's cursor-key mode (DECCKM) so it lands the same as a real keypress.
  arrowFromComposer: (dir: "up" | "down") => void;
  // Hand an Enter off from the composer: focus the terminal AND inject a carriage return, so that
  // pressing Enter in an EMPTY composer confirms whatever's highlighted in the terminal (e.g. the
  // option the user just moved to with the arrow keys in Claude's menu) without clicking into it.
  // CR (\r) is exactly what a real Enter keypress sends to a PTY.
  enterFromComposer: () => void;
  // Drop an xterm marker at the current line under `promptId`, so a later scrollToPrompt can jump
  // the viewport back to where this prompt was sent. No-op on the ALTERNATE buffer (a full-screen
  // TUI has no scrollback to mark). Markers are session-only: they live with this xterm instance
  // and are trimmed once their line falls off the 8000-line scrollback.
  markPrompt: (promptId: string) => void;
  // Scroll the viewport to a prompt's marker. "scrolled" on success; "missing" when the marker is
  // unknown or has been trimmed out (a different session, or scrolled out of scrollback).
  scrollToPrompt: (promptId: string) => "scrolled" | "missing";
}

/**
 * One xterm.js terminal bound to one agent's PTY (spec §3). Spawns the command on
 * mount, streams pty:output into the terminal AND the statusEngine, forwards
 * keystrokes back to the PTY, and tears the PTY down on unmount. Mouse-select + Cmd+C
 * copy are built into xterm.
 */
export function Terminal({
  agentId,
  projectId,
  projectRootPath,
  command,
  args,
  cwd,
  active,
  onStatus,
  onReady,
  onExit,
  onRateLimit,
  onRequestFocus,
  focusRef,
  apiRef,
}: {
  agentId: string;
  projectId: string;
  projectRootPath: string;
  command: string;
  args: string[];
  cwd: string;
  active: boolean;
  onStatus: (s: AgentTabStatus) => void;
  onReady?: () => void;
  onExit?: () => void;
  // Best-effort (Phase 1) multi Claude Max failover: invoked with an epoch-ms reset instant the
  // first time this PTY's output looks like a usage/rate-limit message, so the parent can flag the
  // chosen account exhausted. Detection is isolated and wrapped so it can never break rendering.
  onRateLimit?: (untilEpoch: number) => void;
  // Called when the active tab is shown, to put initial focus in the composer.
  onRequestFocus?: () => void;
  // The parent sets this to an imperative focus() so it can move focus into the terminal
  // (e.g. on ⌘J / when the composer minimizes) without the user clicking it.
  focusRef?: RefObject<(() => void) | null>;
  // Imperative bridge so the parent can drive this terminal (e.g. arrow hand-off from the composer).
  apiRef?: RefObject<TerminalApi | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // promptHistory entry id -> the xterm marker at the line where that prompt was sent. Drives
  // "jump to this prompt" (pinned-prompt dropdown + history search). Session-only.
  const markersRef = useRef<Map<string, IMarker>>(new Map());
  // The WebGL renderer (when available) caches colored glyphs in a texture atlas — kept so the
  // live re-theme effect can clear it and force already-painted cells to repaint.
  const webglRef = useRef<WebglAddon | null>(null);
  // Latest onRequestFocus, read by the (agentId-keyed) effect without re-subscribing.
  const onRequestFocusRef = useRef(onRequestFocus);
  onRequestFocusRef.current = onRequestFocus;
  // Latest onRateLimit, read by the (agentId-keyed) output effect without re-subscribing.
  const onRateLimitRef = useRef(onRateLimit);
  onRateLimitRef.current = onRateLimit;
  const zoom = useUiStore((s) => s.zoom);
  const resolvedTheme = useResolvedTheme();
  // Brief "Copied to clipboard" flash shown after a mouse selection is copied.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  // Floating actions for the current selection — anchored at the mouse-up point.
  const [popup, setPopup] = useState<{ x: number; y: number; text: string } | null>(null);

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
    // Make http(s) URLs in terminal output clickable. The default addon handler uses
    // window.open, which the Tauri webview blocks for external URLs; route through the
    // opener plugin instead so links launch in the OS default browser.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        openUrl(uri).catch((err) =>
          console.error("Failed to open URL from terminal:", uri, err),
        );
      }),
    );
    term.open(container);
    // WebGL renderer enables customGlyphs (the default DOM renderer does not), giving
    // crisp, exactly-aligned box-drawing. Fall back silently if WebGL is unavailable.
    try {
      const webgl = new WebglAddon();
      // On a lost GPU context the default renderer must take over and the screen must be
      // repainted, else it stays blank/stale until the next PTY write. recoverFromWebglContextLoss
      // disposes the addon, nulls the ref (so the re-theme effect doesn't touch a disposed addon),
      // and forces a full refresh.
      webgl.onContextLoss(() => {
        recoverFromWebglContextLoss(webgl, termRef.current, () => {
          webglRef.current = null;
        });
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
    // Let the parent move focus into the terminal imperatively (⌘J / composer minimize).
    if (focusRef) focusRef.current = () => term.focus();

    // Engine owns the tab status. It reads the rendered screen on settle (via getScreen)
    // to decide red-vs-gray, so it must be created after the terminal exists.
    const engine = new StatusEngine({
      agentId,
      onStatus,
      getScreen: () => snapshotScreen(term.buffer.active, term.rows),
    });

    // Forward keystrokes typed directly in the terminal to the PTY. onData fires for USER input
    // only (never programmatic agent output), so it's our signal that the user just interacted —
    // record it (throttled) to reset the sidebar's "running without my interaction" timer.
    term.onData((d) => {
      useInteractionStore.getState().touch(agentId);
      void writePty(agentId, d).catch(ignorePtyGone);
    });

    // The terminal is a real terminal: every keystroke reaches the PTY, so Claude's menus
    // (number picks, arrows, Enter, Esc) and mouse-select + Cmd+C copy all work directly.
    // The one exception is ⌘J — it bounces focus back to the composer (and restores it if
    // minimized) instead of going to the PTY, so the user can hop back to the prompt box.
    term.attachCustomKeyEventHandler((e) => {
      if (isComposerToggleKey(e)) {
        useUiStore.getState().setComposerMinimized(false);
        onRequestFocusRef.current?.();
        return false;
      }
      // Swallow the whole ⌘J chord (incl. the keyup) so no stray sequence reaches the PTY.
      if (e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "j") return false;
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

    // Imperative bridge: registered after `term` exists so the closures capture this instance.
    if (apiRef) {
      apiRef.current = {
        arrowFromComposer: (dir) => {
          term.focus();
          // Encode against the app's cursor-key mode (DECCKM) so the bytes match a real keypress;
          // see arrowKeySequence. `term.modes` reflects whatever the running TUI last requested.
          const seq = arrowKeySequence(dir, term.modes.applicationCursorKeysMode);
          void writePty(agentId, seq).catch(ignorePtyGone);
        },
        enterFromComposer: () => {
          term.focus();
          // \r is the byte a real Enter sends to a PTY (the running TUI translates it per its
          // input mode, exactly as it would a keyboard Enter). This confirms the highlighted menu
          // choice when the user presses Enter in an empty composer.
          void writePty(agentId, "\r").catch(ignorePtyGone);
        },
        markPrompt: (promptId) => {
          // Scrollback lives on the normal buffer only; a full-screen TUI (alternate buffer) has
          // nothing to mark, so skip — the prompt simply won't be jump-to-able.
          if (term.buffer.active.type !== "normal") return;
          const marker = term.registerMarker(0);
          if (!marker) return;
          markersRef.current.get(promptId)?.dispose(); // replace a re-run prompt's stale marker
          markersRef.current.set(promptId, marker);
          // Drop markers trimmed out of scrollback so the map can't grow unbounded over a session.
          for (const [id, m] of markersRef.current) {
            if (m.isDisposed) markersRef.current.delete(id);
          }
        },
        scrollToPrompt: (promptId) => {
          const marker = markersRef.current.get(promptId);
          if (!marker || marker.isDisposed) {
            markersRef.current.delete(promptId); // drop a trimmed marker as we discover it
            return "missing";
          }
          // Land the turn a couple rows below the top edge so there's a little lead-in context
          // instead of the prompt sitting flush against the viewport top.
          term.scrollToLine(Math.max(0, marker.line - SCROLL_LEAD_IN_ROWS));
          return "scrolled";
        },
      };
    }

    // Best-effort multi Claude Max failover (Phase 1): scan output for a usage/rate-limit message
    // and fire onRateLimit ONCE per spawn. A small rolling buffer catches a message split across
    // chunks; `rateLimitFired` debounces repeats. Wrapped so a detection error can never disrupt
    // term.write/engine.ingest — terminal rendering must stay bulletproof.
    let rateLimitBuf = "";
    let rateLimitFired = false;
    const watchRateLimit = (chunk: string) => {
      if (rateLimitFired || !onRateLimitRef.current) return;
      try {
        rateLimitBuf = (rateLimitBuf + chunk).slice(-4096);
        const until = detectRateLimitReset(rateLimitBuf, Date.now());
        if (until != null) {
          rateLimitFired = true;
          onRateLimitRef.current(until);
        }
      } catch {
        /* detection is best-effort; never let it break the output pipeline */
      }
    };

    // Force a full repaint shortly after output stops arriving. The WebGL renderer only
    // repaints cells it tracks as dirty, so rows that were revealed at the TOP of the viewport
    // when it grew — or that a full-screen redraw (alternate-buffer TUI) rewrote — can stay
    // blank until a scroll marks them dirty (the recurring "top half of the terminal is blank
    // until I scroll" bug). The resize/become-active paths already refresh, but a settled turn
    // with no resize was uncovered. Debounce so streaming output pays one repaint after it
    // settles, not one per chunk; refresh() only marks rows dirty (cheap, no scroll change).
    let settleRepaintTimer: number | null = null;
    const scheduleSettleRepaint = () => {
      if (settleRepaintTimer) window.clearTimeout(settleRepaintTimer);
      settleRepaintTimer = window.setTimeout(() => {
        try {
          term.refresh(0, term.rows - 1);
        } catch {
          /* terminal disposed mid-timer — ignore */
        }
      }, 80);
    };

    void (async () => {
      const offOut = await onPtyOutput((e) => {
        if (e.id !== agentId) return;
        term.write(e.chunk);
        engine.ingest(e.chunk);
        watchRateLimit(e.chunk);
        scheduleSettleRepaint();
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
    const onMouseUp = (e: MouseEvent) => {
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
      // Open the action popup at the cursor regardless of clipboard timing.
      setPopup({ x: e.clientX, y: e.clientY, text: sel });
    };
    // A new drag (mousedown) dismisses any open popup before the next selection.
    const onMouseDown = () => setPopup(null);
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("mousedown", onMouseDown);

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        void resizePty(agentId, term.cols, term.rows).catch(ignorePtyGone);
        // Force a full repaint of the viewport. When the container grows (the pane becoming
        // visible after display:none, or the window enlarging), the rows newly brought into
        // view can stay blank — xterm only repaints on resize when fit() actually changed the
        // dimensions, and the WebGL renderer in particular leaves the freshly-revealed rows
        // unpainted. Without this, buffered history shows blank until a scroll marks the rows
        // dirty (the reported bug). Same remedy as the theme/WebGL-recovery paths below.
        term.refresh(0, term.rows - 1);
      } catch {
        /* ignore transient fit errors while hidden */
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      if (focusRef) focusRef.current = null;
      if (apiRef) apiRef.current = null;
      ro.disconnect();
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("mousedown", onMouseDown);
      if (settleRepaintTimer) window.clearTimeout(settleRepaintTimer);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      for (const off of unlistens) off();
      void killPty(agentId).catch(ignorePtyGone);
      engine.dispose();
      markersRef.current.clear(); // term.dispose() drops the markers; clear our handles too
      // Dispose the WebGL renderer BEFORE the terminal. Its render loop runs on
      // requestAnimationFrame; if we let term.dispose() tear down the core render service first, an
      // already-scheduled frame can still fire and read `this._renderer.value.dimensions` after it's
      // gone — the uncaught "undefined is not an object (this._renderer.value.dimensions)" TypeError
      // seen in the logs. Disposing the addon first stops its loop before the core disappears.
      // (dispose() is idempotent, so term.dispose()'s own addon teardown is a safe no-op after this.)
      webglRef.current?.dispose();
      webglRef.current = null;
      term.dispose();
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
        void resizePty(agentId, term.cols, term.rows).catch(ignorePtyGone);
        // The ResizeObserver may have already fit this terminal to the right size while it was
        // hidden, making the fit() above a no-op — so xterm never repaints and the buffered
        // history stays blank until the user scrolls. Force a full repaint of the now-visible
        // viewport. (Repaint is cheap and idempotent; doing it here guarantees the becoming-
        // active transition is covered regardless of which path won the resize race.)
        term.refresh(0, term.rows - 1);
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
        void resizePty(agentId, term.cols, term.rows).catch(ignorePtyGone);
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
    // ph-no-capture: terminal panes render source code, command output, and
    // secrets — never include them in PostHog session replay.
    <div
      className={PH_NO_CAPTURE_CLASS}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
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
      {popup && (
        <SelectionPopup
          x={popup.x}
          y={popup.y}
          text={popup.text}
          agentId={agentId}
          projectId={projectId}
          projectRootPath={projectRootPath}
          onClose={() => setPopup(null)}
        />
      )}
    </div>
  );
}
