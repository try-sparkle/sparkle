import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Terminal as XTerm, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyToClipboard } from "../clipboard";
import { C, CHAT_USER_BUBBLE, xtermTheme } from "../theme/colors";
import { useResolvedTheme } from "../theme/theme";
import type { AgentTabStatus } from "../types";
import { spawnPty, writePty, killPty, resizePty, setPtyPaused, onPtyOutput, onPtyExit, ignorePtyGone } from "../pty";
import { StatusEngine } from "../engine/statusEngine";
import { snapshotScreen } from "../engine/screenSnapshot";
import { registerScrollback, serializeScrollback } from "../services/terminalScrollback";
import { useUiStore } from "../stores/uiStore";
import { useInteractionStore } from "../stores/interactionStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { isComposerToggleKey } from "./composerToggle";
import { isCopySelectionKey } from "./copySelectionKey";
import { arrowKeySequence } from "./composerArrowOverflow";
import { wheelToScrollLines } from "./terminalScroll";
import { resolveTerminalOverlay } from "./terminalOverlay";
import { makeLineScanState, scanSubmittedLines } from "./terminalSubmit";
import { useKeybindingsStore } from "../stores/keybindingsStore";
import { isMeasuredSize, spawnSize } from "./terminalSize";
import { PtyFlowController } from "./terminalFlow";
import { SelectionPopup } from "./SelectionPopup";
import { recoverFromWebglContextLoss, forceFullRepaint, settleRepaintPlan } from "./terminalWebgl";
import { detectRateLimitReset } from "../services/rateLimitWatch";
import { safeUnlisten } from "../services/safeUnlisten";
import { PH_NO_CAPTURE_CLASS } from "@sparkle/core";
import { perfMark, perfSpan } from "../perfTrace";

// Terminal font size at 100%. The ⋯-menu "Text size" control (and Cmd +/-) multiplies
// this by the `zoom` factor, so it scales the terminal text only — not the UI chrome.
const BASE_FONT_SIZE = 13;

// When jumping to a prompt's marker, scroll a few rows above it so the matched turn has lead-in
// context rather than sitting flush at the viewport top.
const SCROLL_LEAD_IN_ROWS = 2;

// After live output goes fully quiet, sweep the WebGL renderer once with a full, atlas-clearing
// repaint. The 80ms settle path only does a bare term.refresh() (cheap, for the common visible-
// streaming case), which the renderer's per-cell model cache SKIPS — so a cell that got mis-
// rasterized mid-stream (the "WThe" artifact: a stray glyph left in a cell) survives every later
// refresh() and stays wrong until a scroll / pane-switch / mouse-hover forces those rows to redraw.
// This longer, separately-debounced sweep clears the texture atlas so stray glyphs self-heal within
// ~half a second instead of persisting until the user mouses over them. The delay sits well past the
// settle window so active streaming (chunks arriving <IDLE_SWEEP_MS apart) keeps pushing it out and
// never pays the cold repaint — it fires ONCE, when output stops.
const IDLE_SWEEP_MS = 500;

// ...but only when enough output has accumulated since the last sweep to make a mis-rasterized cell
// plausible. A stray glyph is a heavy-streaming artifact; a keystroke echo or a one-line status
// update won't produce one. Without this gate the sweep would pay a full (comparatively heavy) atlas
// clear after EVERY interactive lull — type → tiny echo → pause, repeat — repainting the visible
// viewport on routine pauses for no benefit (roborev Low #35218). Bytes accumulate across sub-
// threshold bursts (the counter only resets on an actual sweep), so small outputs still heal
// eventually once their cumulative volume crosses the bar — just not on every trivial pause. ~one
// screenful of a default terminal.
const IDLE_SWEEP_MIN_BYTES = 2048;

// Push the live xterm size to the PTY — but ONLY when it came from a genuinely laid-out
// container. fit() on a display:none / pre-layout pane collapses to a tiny size (cols≈12), and
// sending that to the PTY makes the agent CLI hard-wrap its output into a thin column that no
// later resize can un-wrap. See terminalSize.ts. term.element exists once term.open() has run;
// its clientWidth is 0 while the pane is hidden.
function syncPtySize(agentId: string, term: XTerm): void {
  const laidOut = !!term.element && term.element.clientWidth > 0;
  if (!isMeasuredSize(laidOut, term)) return;
  void resizePty(agentId, term.cols, term.rows).catch(ignorePtyGone);
}

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
  onSubmitLine,
  focusRef,
  apiRef,
  resuming = false,
}: {
  agentId: string;
  projectId: string;
  projectRootPath: string;
  command: string;
  args: string[];
  // The child's working directory. Optional: a PTY doesn't require one, and some spawns (e.g. the
  // first-run `claude login`, which runs before any worktree exists) deliberately pass none so
  // pty_spawn opens without a cwd. When set, it must resolve inside the managed worktrees tree.
  cwd?: string;
  active: boolean;
  // Whether this spawn resumes a prior Claude session (`claude --resume`) vs starts fresh. Drives
  // the loading affordance shown until the first PTY byte: a `--resume` redraw of a large transcript
  // (or a fresh Claude's banner load) leaves the pane blank for seconds, which — next to a sidebar
  // already showing a named, working agent — reads as broken. Defaults false (fresh).
  resuming?: boolean;
  onStatus: (s: AgentTabStatus) => void;
  onReady?: () => void;
  onExit?: () => void;
  // Best-effort (Phase 1) multi Claude Max failover: invoked with an epoch-ms reset instant the
  // first time this PTY's output looks like a usage/rate-limit message, so the parent can flag the
  // chosen account exhausted. Detection is isolated and wrapped so it can never break rendering.
  onRateLimit?: (untilEpoch: number) => void;
  // Called when the active tab is shown, to put initial focus in the composer.
  onRequestFocus?: () => void;
  // Called when the user submits a line to the agent by pressing Enter directly in the terminal
  // (a carriage return in USER input) — one call per submitted line. The parent uses this to meter
  // free-trial prompts for trial users who type into the raw terminal (no composer). Best-effort.
  onSubmitLine?: () => void;
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
  // Set when a PTY chunk is written while this pane can't paint (hidden / 0-sized canvas): those
  // cells get cached as "drawn" by the WebGL renderer but never reach the GPU, so a bare refresh()
  // can't recover them (see forceFullRepaint). The next settle that lands while the pane IS
  // paintable consumes this with a full repaint — so we pay the (cold-repaint) cost once per
  // poisoning episode instead of on every settle. Become-active also clears it on reveal.
  const poisonedRef = useRef(false);
  // Latest onRequestFocus, read by the (agentId-keyed) effect without re-subscribing.
  const onRequestFocusRef = useRef(onRequestFocus);
  onRequestFocusRef.current = onRequestFocus;
  // Latest onRateLimit, read by the (agentId-keyed) output effect without re-subscribing.
  const onRateLimitRef = useRef(onRateLimit);
  onRateLimitRef.current = onRateLimit;
  // Latest onSubmitLine, read by the (agentId-keyed) onData handler without re-subscribing.
  const onSubmitLineRef = useRef(onSubmitLine);
  onSubmitLineRef.current = onSubmitLine;
  const zoom = useUiStore((s) => s.zoom);
  const resolvedTheme = useResolvedTheme();
  // Brief "Copied to clipboard" flash shown after a mouse selection is copied.
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | null>(null);
  // Floating actions for the current selection — anchored at the mouse-up point.
  const [popup, setPopup] = useState<{ x: number; y: number; text: string } | null>(null);
  // False until the first PTY byte lands for this agent. While false we overlay a "Resuming…/
  // Starting…" affordance so the unavoidable blank between spawn and Claude's first output (a
  // `--resume` transcript redraw can take seconds) reads as loading, not broken. agentId is stable
  // for this component's life, so this flips once and stays.
  const [firstOutput, setFirstOutput] = useState(false);
  // Whether ANY output streamed for this attempt, read synchronously inside the exit handler (the
  // firstOutput STATE there would be the stale mount-time `false`). Reset per attempt.
  const gotOutputRef = useRef(false);
  // When the spawn never produces a running terminal we surface an explicit state instead of a
  // silent blank pane: "failed" = the spawn chain threw (e.g. claude/shell not found, worktree
  // guard); "exited" = the PTY exited before emitting any output. Both offer "Start again".
  const [spawnFail, setSpawnFail] = useState<null | "failed" | "exited">(null);
  // Bumped by "Start again"; in the mount effect's deps so a retry tears down and re-spawns cleanly.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    gotOutputRef.current = false;
    setSpawnFail(null);
    setFirstOutput(false);
    setAttempt((a) => a + 1);
  }, []);

  // Set true the instant the terminal is disposed (in the mount effect's cleanup). The mount effect
  // nulls termRef/fitRef/webglRef right after, so any LATE callback — a queued ResizeObserver tick,
  // a theme re-render, an already-scheduled rAF in another effect — sees disposed and freed refs and
  // bails instead of calling fit()/refresh() on a torn-down xterm core. That post-dispose path is
  // the source of the uncaught "undefined is not an object (this._renderer.value.dimensions)" crash.
  const disposedRef = useRef(false);

  // Guarded terminal ops: no-op once disposed or the refs are freed. Stable identity (reads refs, so
  // no deps) so effects can use them without re-subscribing. Both swallow the torn-down-core throw.
  const safeFit = useCallback(() => {
    if (disposedRef.current) return;
    const fit = fitRef.current;
    if (!fit) return;
    try {
      fit.fit();
    } catch {
      /* container not laid out yet / terminal torn down — the next observer/effect retries */
    }
  }, []);
  const safeRefresh = useCallback(() => {
    if (disposedRef.current) return;
    const term = termRef.current;
    if (!term) return;
    try {
      term.refresh(0, term.rows - 1);
    } catch {
      /* terminal torn down mid-callback — nothing to repaint */
    }
  }, []);

  // Attach the xterm WebGL renderer to the live terminal. Called ONLY when this pane is
  // visible/active (see the visibility effect below). WKWebView caps the number of concurrent
  // WebGL contexts (~8–16), and the app keeps one xterm per open agent — including hidden panes,
  // which stay laid out (visibility:hidden, not display:none) and so used to keep a live context
  // each. Past the cap the engine force-loses and restores contexts in a thrash loop that blocks
  // the main thread (the "spinning beachball" that got worse the more agents were open). Holding a
  // context only for the visible pane keeps us far under the cap. The xterm core, its scrollback,
  // and the PTY are untouched — only the renderer addon is added. Idempotent; safe once disposed.
  const attachWebgl = useCallback(() => {
    if (disposedRef.current) return;
    const term = termRef.current;
    if (!term || webglRef.current) return; // no terminal yet, or already attached
    // WebGL renderer enables customGlyphs (the default DOM renderer does not), giving crisp,
    // exactly-aligned box-drawing. Fall back silently to the DOM renderer if WebGL is unavailable.
    try {
      // Time WebGL attach — a new GPU context per pane reveal (switching agents). If this shows up in
      // the jank window, context churn is the switch cost (perfTrace).
      const webgl = perfSpan(
        "Terminal.attachWebgl",
        () => {
          const w = new WebglAddon();
          // On a lost GPU context the default renderer must take over and the screen must be
          // repainted, else it stays blank/stale until the next PTY write.
          // recoverFromWebglContextLoss disposes the addon, nulls the ref (so the re-theme effect
          // doesn't touch a disposed addon), and refreshes.
          w.onContextLoss(() => {
            recoverFromWebglContextLoss(w, termRef.current, () => {
              webglRef.current = null;
            });
          });
          term.loadAddon(w);
          return w;
        },
        { agentId },
      );
      webglRef.current = webgl;
      // NOTE: we deliberately do NOT force a repaint here. attachWebgl is only ever called when this
      // pane is (becoming) active, and the become-active reveal effect below OWNS the repaint — it
      // waits for the box to lay out, then forceFullRepaints (clearing the fresh atlas so cells
      // buffered on the DOM renderer while hidden rasterize into the new WebGL model). Keeping a
      // single repaint path preserves the tested reveal-repaint contract (Terminal.revealRepaint).
    } catch {
      /* no WebGL — keep the default DOM renderer (TUI borders may be less crisp) */
    }
  }, []);

  // Detach + dispose the WebGL renderer, releasing its GPU context. xterm falls back to its DOM
  // renderer when no WebGL addon is loaded (the same fallback recoverFromWebglContextLoss relies
  // on), so the terminal keeps rendering; the content buffer, scrollback, and PTY all live on the
  // xterm core and are untouched. Called when this pane becomes hidden. Idempotent.
  const detachWebgl = useCallback(() => {
    const webgl = webglRef.current;
    if (!webgl) return;
    // Null the ref BEFORE dispose so any repaint/re-theme effect that reads webglRef can't touch a
    // half-disposed addon if it races in during teardown.
    webglRef.current = null;
    try {
      webgl.dispose();
    } catch {
      /* already torn down — nothing to release */
    }
    // Repaint via the now-active DOM renderer so the screen doesn't go stale after the swap
    // (mirrors recoverFromWebglContextLoss). No-op once disposed.
    safeRefresh();
  }, [safeRefresh]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposedRef.current = false;
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
      // Let ⌥-drag force a text selection even while a TUI (Claude Code) has mouse tracking on.
      // With mouse tracking active xterm disables its SelectionService and forwards drags to the
      // PTY, so a plain drag can't select — and copy-on-select + the selection popup never fire.
      // ⌥-drag is the standard terminal escape hatch (matches iTerm) for selecting over a TUI.
      macOptionClickForcesSelection: true,
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
    // Spawn waterfall milestone (perfTrace): xterm core + addons constructed and attached to the DOM.
    // Keyed by agentId — appends to the "spawn" trace started at the click; no-op for a boot-restored
    // pane with no active trace.
    perfMark(agentId, "xterm constructed");
    // NOTE: the WebGL renderer is NOT loaded here anymore. It is attached lazily — only while this
    // pane is the visible/active one — by attachWebgl (via the mount-time call below and the
    // visibility effect further down), and disposed when the pane is hidden. This caps the app at
    // one live WebGL context (WKWebView's context cap is ~8–16; keeping one per open agent thrashed
    // the GPU and froze the main thread). Until WebGL attaches, xterm uses its DOM renderer.
    try {
      fit.fit();
    } catch {
      /* container not laid out yet; the ResizeObserver will fit shortly */
    }
    termRef.current = term;
    fitRef.current = fit;
    // Attach the WebGL renderer straight away if this pane mounts active/visible. (Placed after
    // termRef is set so attachWebgl can find the terminal.) A pane that mounts hidden stays on the
    // DOM renderer and gets WebGL on its first reveal via the visibility effect. `active` is read at
    // mount/retry only; every later hide/show transition is handled by the visibility effect.
    if (active) attachWebgl();
    // The terminal opens — and starts writing PTY output — BEFORE the async webfont (Source Code
    // Pro, loaded from Google Fonts with display=swap) necessarily finishes downloading; on a cold
    // launch a lot of output can stream in that window. The WebGL renderer rasterizes those glyphs
    // with the FALLBACK font into its texture atlas and never rebuilds it when the real font swaps
    // in (xterm doesn't invalidate the atlas on font load), so they render with wrong metrics or
    // drop out entirely. Force one full repaint (clears the atlas → every cell re-rasterizes with
    // the now-loaded font) once fonts are ready. Guarded so a late resolve can't paint into a
    // disposed terminal. document.fonts is absent in some test/headless envs — skip there.
    if (typeof document !== "undefined" && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (disposedRef.current) return;
        forceFullRepaint(webglRef.current, termRef.current);
      });
    }
    // Expose this agent's terminal history so the relay can send it to a watching phone.
    const unregisterScrollback = registerScrollback(agentId, () =>
      serializeScrollback(term.buffer.active),
    );
    // Let the parent move focus into the terminal imperatively (⌘J / composer minimize).
    if (focusRef) focusRef.current = () => term.focus();

    // Engine owns the tab status. It reads the rendered screen on settle (via getScreen)
    // to decide red-vs-gray, so it must be created after the terminal exists.
    // For the two "ask" statuses (waiting/approval), capture the current screen FIRST so the
    // notification path can summarize WHAT the agent is asking; then forward to the real onStatus.
    const onStatusWithCapture = (s: AgentTabStatus): void => {
      if (s === "waiting" || s === "approval") {
        useRuntimeStore
          .getState()
          .setAttentionScreen(agentId, snapshotScreen(term.buffer.active, term.rows));
      }
      onStatus(s);
    };
    const engine = new StatusEngine({
      agentId,
      onStatus: onStatusWithCapture,
      getScreen: () => snapshotScreen(term.buffer.active, term.rows),
    });

    // Forward keystrokes typed directly in the terminal to the PTY. onData fires for USER input
    // only (never programmatic agent output), so it's our signal that the user just interacted —
    // record it (throttled) to reset the sidebar's "running without my interaction" timer.
    //
    // Tracks the user's input line so onSubmitLine (the raw-terminal analogue of the composer's
    // per-send boundary) fires only when the user submits NON-EMPTY content — a bare Enter, a
    // permission/y-n confirmation pressed without typing, or menu navigation (arrow keys + Enter)
    // must not burn a free trial prompt. See terminalSubmit.ts. onData never sees programmatic
    // agent output, so this can't be triggered by the agent itself.
    const lineScan = makeLineScanState();
    term.onData((d) => {
      useInteractionStore.getState().touch(agentId);
      const submits = scanSubmittedLines(lineScan, d);
      for (let i = 0; i < submits; i += 1) onSubmitLineRef.current?.();
      void writePty(agentId, d).catch(ignorePtyGone);
    });

    // Copy the current xterm selection to the clipboard and flash the "Copied" confirmation.
    // Returns the selected text (so callers can also act on it, e.g. open the actions popup), or
    // null when there's no non-empty selection. xterm paints its selection on a canvas/WebGL layer
    // rather than as a native DOM selection, so the browser's own Cmd+C finds nothing to copy and
    // macOS just beeps — every copy path (mouse-select and ⌘C) has to go through this explicitly.
    const copySelectionToClipboard = (): string | null => {
      const sel = term.getSelection();
      if (!sel || sel.trim().length === 0) return null;
      void copyToClipboard(sel).then((ok) => {
        // The async clipboard write can resolve after this terminal unmounts (e.g. the user
        // switched agents mid-copy); don't touch state or schedule a timer if so.
        if (disposed || !ok) return;
        setCopied(true);
        if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
        copiedTimer.current = window.setTimeout(() => setCopied(false), 1100);
      });
      return sel;
    };

    // The terminal is a real terminal: every keystroke reaches the PTY, so Claude's menus
    // (number picks, arrows, Enter, Esc) all work directly. Two chords are intercepted here:
    //   • ⌘J bounces focus back to the composer (restoring it if minimized) instead of the PTY.
    //   • ⌘C copies the current selection ourselves — xterm's selection isn't a native DOM
    //     selection, so without this the OS native copy finds nothing and just beeps. With no
    //     selection we pass ⌘C through unchanged.
    term.attachCustomKeyEventHandler((e) => {
      // Read the binding live (getState, not a captured value) so a rebind in Settings takes
      // effect without remounting the terminal.
      const toggle = useKeybindingsStore.getState().bindings.toggleComposer;
      if (isComposerToggleKey(e, toggle)) {
        useUiStore.getState().setComposerMinimized(false);
        onRequestFocusRef.current?.();
        return false;
      }
      // Swallow the whole toggle chord (incl. the keyup) so no stray sequence reaches the PTY.
      if (
        toggle.kind === "chord" &&
        e.key.toLowerCase() === toggle.key &&
        e.metaKey === toggle.meta &&
        e.ctrlKey === toggle.ctrl &&
        e.altKey === toggle.alt &&
        e.shiftKey === toggle.shift
      ) {
        return false;
      }
      // ⌘C copies the selection ourselves. ⌘C is never a PTY control (that's Ctrl+C, which carries
      // ctrlKey and still SIGINTs), so we always handle it AND call preventDefault() — otherwise
      // xterm returns from _keyDown without preventing the event, WebKit runs its native Copy, finds
      // no DOM selection (xterm paints selection on canvas), and macOS beeps. copySelectionToClipboard
      // copies + flashes when there's a selection and is a harmless no-op otherwise.
      if (isCopySelectionKey(e)) {
        e.preventDefault();
        copySelectionToClipboard();
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
    // A scrollback scroll can leave stale glyph fragments behind under the WebGL renderer (its
    // per-cell model cache + glyph atlas aren't fully invalidated by scrollLines/scrollToLine),
    // showing as leftover characters in the margins. Force a full repaint shortly after scrolling
    // settles — debounced so a flick of the wheel pays one repaint, not one per tick. The
    // disposedRef guard + forceFullRepaint's own try/catch keep a late timer off a torn-down term.
    let scrollRepaintTimer: number | null = null;
    const scheduleScrollRepaint = () => {
      if (scrollRepaintTimer) window.clearTimeout(scrollRepaintTimer);
      scrollRepaintTimer = window.setTimeout(() => {
        if (disposedRef.current) return;
        forceFullRepaint(webglRef.current, termRef.current);
      }, 80);
    };
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
      if (lines !== 0) {
        term.scrollLines(lines);
        scheduleScrollRepaint();
      }
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
          scheduleScrollRepaint(); // clear any stale cells the jump leaves behind (WebGL)
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

    // Whether this terminal's canvas can actually paint right now (it's laid out and visible).
    // A display:none pane has a 0-width element; output written then is cache-poisoned (see
    // poisonedRef / forceFullRepaint).
    const isPaintable = () => !!term.element && term.element.clientWidth > 0;

    // Apply the settle/resize repaint plan: a full forceFullRepaint to drain cache-poisoned cells
    // (once, when poisoned AND paintable), else a cheap refresh that marks rows dirty. Shared by
    // the output-settle timer AND the ResizeObserver — so a pane revealed by a *resize* (not the
    // active toggle) and with no further output still gets drained. settleRepaintPlan keeps the
    // expensive cold repaint to once per poisoning episode (see terminalWebgl.ts).
    const applyRepaintPlan = () => {
      const plan = settleRepaintPlan(poisonedRef.current, isPaintable());
      if (plan.action === "full") forceFullRepaint(webglRef.current, term);
      else if (plan.action === "refresh") term.refresh(0, term.rows - 1);
      // "skip": the pane is hidden (not paintable) — don't spend a refresh on an off-screen pane
      // (wasted with many background agents streaming). The become-active reveal repaints it on show.
      poisonedRef.current = plan.poisoned;
    };

    // Repaint shortly after output stops arriving (debounced: streaming pays one repaint after it
    // settles, not one per chunk).
    let settleRepaintTimer: number | null = null;
    const scheduleSettleRepaint = () => {
      if (settleRepaintTimer) window.clearTimeout(settleRepaintTimer);
      settleRepaintTimer = window.setTimeout(() => {
        try {
          applyRepaintPlan();
        } catch {
          /* terminal disposed mid-timer — ignore */
        }
      }, 80);
    };

    // Idle sweep: one full, atlas-clearing repaint after output goes quiet, to heal any stray glyph
    // the cheap settle-refresh can't (a cell mis-rasterized mid-stream sticks under the WebGL per-
    // cell cache — see IDLE_SWEEP_MS). On its OWN, longer-debounced timer so it fires once when
    // streaming stops, not per chunk. Gated on IDLE_SWEEP_MIN_BYTES of accumulated output so routine
    // interactive pauses don't pay the cold repaint. Skipped while the pane is hidden — the become-
    // active reveal owns that repaint, and a full atlas clear on an off-screen pane is pure wasted
    // GPU work (mirrors applyRepaintPlan's "skip"). disposedRef + forceFullRepaint's own try/catch
    // keep a late timer off a torn-down term.
    let idleSweepTimer: number | null = null;
    let bytesSinceSweep = 0;
    const scheduleIdleSweep = () => {
      if (idleSweepTimer) window.clearTimeout(idleSweepTimer);
      idleSweepTimer = window.setTimeout(() => {
        if (disposedRef.current || !isPaintable()) return;
        // Below the volume bar: leave bytesSinceSweep intact so it accrues across bursts and a
        // series of small outputs still heals once cumulatively substantial — just not per pause.
        if (bytesSinceSweep < IDLE_SWEEP_MIN_BYTES) return;
        bytesSinceSweep = 0;
        forceFullRepaint(webglRef.current, term);
      }, IDLE_SWEEP_MS);
    };

    // PTY read backpressure (): count bytes written-but-not-yet-parsed by xterm and, past
    // the high-water mark, pause the PTY reader (the child then blocks on its own write) until the
    // backlog drains below the low-water mark. Bounds xterm + IPC memory under a runaway-verbose
    // child without dropping bytes or touching normal interactive output. See terminalFlow.ts.
    // Serialize pause/resume onto a single promise chain: Tauri may service sync commands
    // concurrently, so firing two independent invokes could let a `false` land before an
    // earlier `true` and park the reader forever. Chaining guarantees the Rust side sees them
    // in issue order (roborev nit on ).
    let flowChain: Promise<void> = Promise.resolve();
    const flow = new PtyFlowController((paused) => {
      flowChain = flowChain.then(() => setPtyPaused(agentId, paused)).catch(ignorePtyGone);
    });

    (async () => {
      const offOut = await onPtyOutput((e) => {
        if (e.id !== agentId) return;
        // First byte for this agent — drop the loading overlay. setState bails on an unchanged
        // value, so calling this on every subsequent chunk costs nothing.
        // Load-bearing ordering: set gotOutputRef SYNCHRONOUSLY here, before any exit can be
        // observed, so the exit handler's `!gotOutputRef.current` check correctly distinguishes
        // "exited after output" (normal end) from "exited with no output" (show the retry state).
        gotOutputRef.current = true;
        setFirstOutput(true);
        setSpawnFail(null); // output means it's alive — clear any prior failed/exited state
        // Flow control: register the chunk BEFORE writing, then release it when xterm finishes
        // parsing (the write callback). string length is a fine byte proxy for the watermarks.
        const chunkLen = e.chunk.length;
        flow.onEnqueue(chunkLen);
        term.write(e.chunk, () => flow.onParsed(chunkLen));
        engine.ingest(e.chunk);
        watchRateLimit(e.chunk);
        // Remember output that streamed in while we couldn't paint, so the next paintable settle
        // (or the become-active reveal) repaints it instead of leaving the top half blank.
        if (!isPaintable()) poisonedRef.current = true;
        scheduleSettleRepaint();
        bytesSinceSweep += chunkLen;
        scheduleIdleSweep();
      });
      const offExit = await onPtyExit((e) => {
        if (e.id !== agentId) return;
        engine.exit();
        onExit?.();
        // If the process exited WITHOUT ever emitting output, don't leave a silent blank pane:
        // show an explicit "Agent exited — Start again" affordance (the spawnFail overlay) instead
        // of the lingering "Starting…". (If output streamed first, firstOutput already cleared the
        // overlay and this is a normal end-of-session — nothing to show.)
        if (!gotOutputRef.current) setSpawnFail("exited");
      });
      if (disposed) {
        void safeUnlisten(offOut);
        void safeUnlisten(offExit);
        return;
      }
      unlistens.push(offOut, offExit);
      // Re-fit right before spawning to capture the freshest measurement, then guard it: a pane
      // that's still display:none / pre-layout fits to a tiny size (cols≈12), which would make
      // the CLI hard-wrap into a thin column. spawnSize() falls back to safe defaults in that
      // case; the true size is synced below (and by the ResizeObserver / become-active effect)
      // once the container is laid out.
      try {
        fit.fit();
      } catch {
        /* container not laid out yet */
      }
      const laidOut = !!term.element && term.element.clientWidth > 0;
      const { cols, rows } = spawnSize(laidOut, term);
      await spawnPty({ id: agentId, command, args, cwd, cols, rows });
      // Layout may have settled — or a ResizeObserver resize may have been dropped because the
      // PTY didn't exist yet — during the async spawn. Now that the PTY exists, sync the true
      // size (no-op while still hidden; the become-active effect covers that).
      if (!disposed) {
        try {
          fit.fit();
        } catch {
          /* still not laid out */
        }
        syncPtySize(agentId, term);
        onReady?.();
      }
    })().catch((e) => {
      // A rejected spawn chain (e.g. pty_spawn's worktree-scope guard, claude/shell not found, or a
      // teardown race on the listener registrations) must not surface as an uncaught rejection.
      // Swallow the rejection, but surface it to the user as an explicit "Couldn't start the agent —
      // Start again" state rather than a silent blank pane. (Guarded by `disposed` so a teardown-race
      // rejection on an unmounting terminal doesn't set state on a dead component.)
      console.debug("terminal spawn chain failed", agentId, e);
      if (!disposed) setSpawnFail("failed");
    });

    // Copy-on-select: when the user finishes a mouse selection, copy it to the clipboard
    // and flash a confirmation so the (otherwise invisible) copy is obvious. A plain click
    // leaves an empty selection — nothing is copied and no toast shows.
    const onMouseUp = (e: MouseEvent) => {
      const sel = copySelectionToClipboard();
      if (!sel) return;
      // Open the action popup at the cursor regardless of clipboard timing.
      setPopup({ x: e.clientX, y: e.clientY, text: sel });
    };
    // A new drag (mousedown) dismisses any open popup before the next selection.
    const onMouseDown = () => setPopup(null);
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("mousedown", onMouseDown);

    const ro = new ResizeObserver(() => {
      // A ResizeObserver tick can still be queued when the component unmounts (ro.disconnect()
      // doesn't un-queue an already-dispatched callback); bail before touching the freed renderer.
      if (disposed) return;
      try {
        fit.fit();
        // Guard the push: a hide transition fires the observer with a 0×0 box, which fit()
        // collapses to a tiny size — sending that to the PTY re-creates the thin-column bug.
        syncPtySize(agentId, term);
        // Repaint the viewport. When the container grows (the pane becoming visible after
        // display:none, or the window enlarging), rows newly brought into view can stay blank —
        // xterm only repaints on resize when fit() actually changed the dimensions. applyRepaintPlan
        // does a cheap refresh normally, OR drains a poisoned pane revealed by this very resize
        // (no active toggle, no further output) with a full forceFullRepaint.
        applyRepaintPlan();
      } catch {
        /* ignore transient fit errors while hidden */
      }
    });
    ro.observe(container);

    return () => {
      disposed = true;
      // Flip the shared sentinel BEFORE disposing so any late callback in another effect (theme
      // re-render, a queued rAF/ResizeObserver tick) sees it and no-ops via safeFit/safeRefresh.
      disposedRef.current = true;
      unregisterScrollback();
      if (focusRef) focusRef.current = null;
      if (apiRef) apiRef.current = null;
      ro.disconnect();
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("mousedown", onMouseDown);
      if (settleRepaintTimer) window.clearTimeout(settleRepaintTimer);
      if (idleSweepTimer) window.clearTimeout(idleSweepTimer);
      if (scrollRepaintTimer) window.clearTimeout(scrollRepaintTimer);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      for (const off of unlistens) void safeUnlisten(off);
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
      // Null the refs so a late callback that slipped past the sentinel still hits a null guard
      // (safeFit/safeRefresh and the active/zoom/theme effects all bail on a null ref) rather than
      // dereferencing the freed renderer.
      termRef.current = null;
      fitRef.current = null;
    };
    // agentId is stable for the life of this component; `attempt` bumps on "Start again" to tear
    // down and re-spawn the terminal from scratch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, attempt]);

  // Visibility-driven WebGL renderer lifecycle — the core fix for WebGL-context-exhaustion latency.
  // Hold a live WebGL context ONLY for the visible pane: attach when this pane becomes active,
  // dispose (releasing the GPU context) when it becomes hidden. With one xterm per open agent and
  // WKWebView capping concurrent contexts (~8–16), keeping a live context per hidden pane exhausted
  // the cap and the engine thrashed force-lose/restore on the main thread — the beachball that got
  // worse the more agents were open. The initial attach for a pane that MOUNTS active is done in
  // the mount effect above (which owns termRef's creation); this effect drives every later hide/show
  // and re-attaches after a "Start again" remount. The xterm core, scrollback, and PTY are never
  // touched — only the renderer addon is attached/detached, so content and the connection survive.
  useEffect(() => {
    if (active) attachWebgl();
    else detachWebgl();
  }, [active, attachWebgl, detachWebgl]);

  // Re-fit + repaint when this tab becomes the active one. Focus goes to the composer, not the
  // terminal — all input lives in the composer overlay.
  //
  // Every pane stays LAID OUT at full size even while backgrounded (visibility:hidden, not
  // display:none — see paneVisibility.ts), so its box is already measured the instant it's revealed.
  // That retired the old multi-frame size-convergence loop (a backgrounded display:none pane used to
  // take a frame or two to lay out on reveal, so we had to retry fit()/syncPtySize across frames
  // until the box appeared): there is no 0-width reveal window to race against anymore. A single
  // fit + size-sync is enough; syncPtySize itself no-ops if the box is somehow still unmeasured, and
  // the ResizeObserver remains the long-term backstop for any late layout.
  //
  // The repaint IS still needed: while hidden this pane ran on the DOM renderer (its WebGL context is
  // released when backgrounded — see attach/detachWebgl), so on reveal WebGL re-attaches with an
  // EMPTY model and only forceFullRepaint (clearTextureAtlas) rasterizes the buffered output into it.
  useEffect(() => {
    if (!active) return;
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    // Cancel any pending rAF on cleanup. fit.fit()/forceFullRepaint schedule an xterm-INTERNAL
    // RenderService frame; if the component unmounts (agent closed, webview reload) in the window
    // between scheduling and the frame firing, term.dispose() runs first and xterm's own queued
    // frame then reads `this._renderer.value.dimensions` on a torn-down core — the uncaught
    // "undefined is not an object (this._renderer.value.dimensions)" TypeError still in the logs
    // after the #231 dispose-ordering fix. The `cancelled` guard + cancelAnimationFrame mean we
    // never queue a paint inside the teardown window.
    let cancelled = false;
    let handle = 0;
    handle = requestAnimationFrame(() => {
      if (cancelled || disposedRef.current) return;
      // safeFit() bails if disposed and swallows the not-laid-out / torn-down-core throw itself.
      safeFit();
      onRequestFocusRef.current?.();
      // Push the true size to the PTY so its wrap column matches xterm (no-op while unmeasured).
      syncPtySize(agentId, term);
      // Defer the repaint one frame so the just-resized canvas has valid char dimensions before we
      // clear the WebGL model; otherwise the renderer bails (no valid dims) and wastes the clear.
      // disposedRef guards the deferred frame (#231/#258).
      handle = requestAnimationFrame(() => {
        if (cancelled || disposedRef.current) return;
        forceFullRepaint(webglRef.current, term);
        poisonedRef.current = false; // the reveal repaint cleared any cache-poisoned cells
      });
    });
    return () => {
      cancelled = true;
      if (handle) cancelAnimationFrame(handle);
    };
  }, [active, agentId, safeFit]);

  // "Text size" scales the terminal font only (not the UI chrome). Update the live font
  // size, then re-fit so the terminal's cols/rows and PTY size track the new cell
  // dimensions instead of going stale.
  useEffect(() => {
    const fit = fitRef.current;
    const term = termRef.current;
    if (!fit || !term) return;
    term.options.fontSize = Math.round(BASE_FONT_SIZE * zoom);
    const raf = requestAnimationFrame(() => {
      if (disposedRef.current) return;
      try {
        safeFit();
        syncPtySize(agentId, term);
      } catch {
        /* ignore transient fit errors */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [zoom, agentId, safeFit]);

  // Re-theme the live terminal when the resolved theme changes (Light/Dark/Auto toggle or an
  // OS appearance change while on Auto). xterm needs concrete hex, so it can't follow the CSS
  // var() flip the rest of the app rides on — we push a fresh theme object instead.
  useEffect(() => {
    const term = termRef.current;
    if (disposedRef.current || !term) return;
    term.options.theme = xtermTheme(resolvedTheme);
    // The WebGL renderer caches colored glyphs in a texture atlas; a bare options.theme set
    // can leave already-painted cells with stale colors until the next reflow. Clear the atlas
    // and force a full repaint so the live toggle is instantaneous like the rest of the app.
    // safeRefresh no-ops if a dispose raced in between the null check and here.
    webglRef.current?.clearTextureAtlas();
    safeRefresh();
  }, [resolvedTheme, safeRefresh]);

  // What to paint over the blank xterm: a fail/exited affordance, a loading hint, or nothing once
  // output streams. Pure (see terminalOverlay.ts) so the "never a silent blank pane" rule is tested.
  const overlay = resolveTerminalOverlay(spawnFail, firstOutput, resuming);

  return (
    // ph-no-capture: terminal panes render source code, command output, and
    // secrets — never include them in PostHog session replay.
    <div
      className={PH_NO_CAPTURE_CLASS}
      style={{ position: "relative", width: "100%", height: "100%" }}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%", overflow: "hidden" }} />
      {/* Affordance over the still-blank terminal. Loading: from spawn until the first PTY byte
          (a `claude --resume` redraw or a fresh banner leaves the pane empty for a few seconds;
          with the sidebar already showing a named, working agent, that blank reads as broken).
          Fail/exited: an explicit, retryable state instead of a silent blank. */}
      {overlay.kind === "fail" ? (
        // Explicit failed/exited state — never a silent blank pane. Pointer events ON so the
        // "Start again" button is clickable (unlike the loading overlay below).
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            color: C.cream,
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontSize: 13,
            zIndex: 5,
          }}
        >
          <span style={{ opacity: 0.8 }}>{overlay.message}</span>
          <button
            onClick={retry}
            style={{
              all: "unset",
              cursor: "pointer",
              fontSize: 13,
              color: C.cream,
              border: `1px solid ${C.muted}`,
              borderRadius: 8,
              padding: "6px 16px",
            }}
          >
            ▶ Start again
          </button>
        </div>
      ) : overlay.kind === "loading" ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: C.cream,
            fontFamily: '"IBM Plex Sans", sans-serif',
            fontSize: 13,
            opacity: 0.6,
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          {overlay.message}
        </div>
      ) : null}
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
