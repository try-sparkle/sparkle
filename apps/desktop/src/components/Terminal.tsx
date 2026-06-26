import { useEffect, useRef, useState, type RefObject } from "react";
import { Terminal as XTerm, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { C, CHAT_USER_BUBBLE, xtermTheme } from "../theme/colors";
import { useResolvedTheme } from "../theme/theme";
import type { AgentTabStatus } from "../types";
import { spawnPty, writePty, killPty, resizePty, onPtyOutput, onPtyExit, ignorePtyGone } from "../pty";
import { StatusEngine } from "../engine/statusEngine";
import { snapshotScreen } from "../engine/screenSnapshot";
import { useUiStore } from "../stores/uiStore";
import { isComposerToggleKey } from "./composerToggle";
import { arrowKeySequence } from "./composerArrowOverflow";
import { wheelToScrollLines } from "./terminalScroll";
import { SelectionPopup } from "./SelectionPopup";
import { recoverFromWebglContextLoss } from "./terminalWebgl";
import { PH_NO_CAPTURE_CLASS } from "@sparkle/core";

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
 * Imperative handle the parent uses to tie the pinned-prompt history to the terminal's
 * scrollback. On submit it drops a marker at the current cursor line (`markPrompt`); clicking
 * a history entry scrolls back to that marker (`scrollToPrompt`). Markers live on the xterm
 * instance, so they're session-only — `scrollToPrompt` returns false once a line has scrolled
 * out of the 8000-line buffer (marker auto-disposed) or was never marked (e.g. after a restart).
 */
export interface TerminalApi {
  markPrompt: (id: string) => void;
  scrollToPrompt: (id: string) => boolean;
  // Hand a vertical arrow off from the composer: focus the terminal AND inject the keypress in
  // one shot, so a single Down (off the composer's last line) or Up (off its first line) both
  // moves focus here and drives whatever's waiting — e.g. Claude's permission menu. The escape
  // sequence honors the app's cursor-key mode (DECCKM) so it lands the same as a real keypress.
  arrowFromComposer: (dir: "up" | "down") => void;
}

/**
 * Briefly highlight the marked row so a scroll-to lands somewhere obvious. An xterm decoration
 * tracks the marker's line as the buffer scrolls; we tint it with the translucent brand accent
 * and fade it out, then dispose. Best-effort — the scroll already happened, so any failure here
 * is swallowed. (The decoration API only accepts #RRGGBB, so the translucent pulse is applied to
 * the DOM element in onRender rather than via the backgroundColor option.)
 *
 * The cleanup timeout id is tracked in `timers` so the terminal's unmount can clear it — otherwise
 * a tab closed within the flash window would fire the timer after `term.dispose()`. (`term.dispose`
 * already tears decorations down, so clearing the timer is enough; we don't re-dispose here.)
 */
function flashRow(term: XTerm, marker: IMarker, timers: Set<number>): void {
  try {
    const dec = term.registerDecoration({ marker, width: term.cols, height: 1, layer: "top" });
    if (!dec) return;
    let painted = false;
    const sub = dec.onRender((el) => {
      if (painted) return;
      painted = true;
      el.style.pointerEvents = "none";
      el.style.backgroundColor = "rgba(52, 224, 240, 0.28)"; // brand accent (#34e0f0), translucent
      el.style.transition = "background-color 1100ms ease";
      // Fade on the next frame so the transition has a start value to animate from.
      requestAnimationFrame(() => {
        el.style.backgroundColor = "rgba(52, 224, 240, 0)";
      });
    });
    const t = window.setTimeout(() => {
      timers.delete(t);
      sub.dispose();
      dec.dispose();
    }, 1300);
    timers.add(t);
  } catch {
    /* highlight is a nice-to-have; the scroll already landed */
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
  projectId,
  projectRootPath,
  command,
  args,
  cwd,
  active,
  onStatus,
  onReady,
  onExit,
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
  // Called when the active tab is shown, to put initial focus in the composer.
  onRequestFocus?: () => void;
  // The parent sets this to an imperative focus() so it can move focus into the terminal
  // (e.g. on ⌘J / when the composer minimizes) without the user clicking it.
  focusRef?: RefObject<(() => void) | null>;
  // Imperative bridge so the pinned-prompt history can mark/scroll-to points in this terminal.
  apiRef?: RefObject<TerminalApi | null>;
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
  // Scroll markers for the pinned-prompt history, keyed by the history entry's id. Lives on the
  // component (not the store) because xterm markers are tied to this terminal instance.
  const markersRef = useRef<Map<string, IMarker>>(new Map());
  // Pending highlight-flash cleanup timers, cleared on unmount so none fire post-dispose.
  const flashTimersRef = useRef<Set<number>>(new Set());
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

    // Forward keystrokes typed directly in the terminal to the PTY.
    term.onData((d) => {
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

    // Pinned-prompt history bridge: mark where each prompt was sent, and scroll back to it on
    // demand. Registered after `term` exists so the closures capture this instance.
    if (apiRef) {
      const markers = markersRef.current;
      apiRef.current = {
        markPrompt: (id) => {
          try {
            // Mark the current cursor line — where the agent is about to echo this prompt.
            const m = term.registerMarker(0);
            if (!m) return;
            markers.get(id)?.dispose(); // replace any stale marker under this id
            markers.set(id, m);
            m.onDispose(() => {
              // Drop it when the line scrolls out of the buffer, but only if it's still the
              // marker we stored (markPrompt may have already replaced it).
              if (markers.get(id) === m) markers.delete(id);
            });
          } catch {
            /* marking is best-effort; the prompt still sent */
          }
        },
        scrollToPrompt: (id) => {
          const m = markers.get(id);
          if (!m || m.isDisposed || m.line < 0) return false;
          // Land a few rows above the prompt so there's a little context above it.
          term.scrollToLine(Math.max(0, m.line - 3));
          flashRow(term, m, flashTimersRef.current);
          return true;
        },
        arrowFromComposer: (dir) => {
          term.focus();
          // Encode against the app's cursor-key mode (DECCKM) so the bytes match a real keypress;
          // see arrowKeySequence. `term.modes` reflects whatever the running TUI last requested.
          const seq = arrowKeySequence(dir, term.modes.applicationCursorKeysMode);
          void writePty(agentId, seq).catch(ignorePtyGone);
        },
      };
    }

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
      } catch {
        /* ignore transient fit errors while hidden */
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      if (focusRef) focusRef.current = null;
      if (apiRef) apiRef.current = null;
      flashTimersRef.current.forEach((t) => window.clearTimeout(t));
      flashTimersRef.current.clear();
      markersRef.current.forEach((m) => m.dispose());
      markersRef.current.clear();
      ro.disconnect();
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("mousedown", onMouseDown);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      for (const off of unlistens) off();
      void killPty(agentId).catch(ignorePtyGone);
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
        void resizePty(agentId, term.cols, term.rows).catch(ignorePtyGone);
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
