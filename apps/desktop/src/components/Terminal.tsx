import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Terminal as XTerm, type IMarker } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { openUrl } from "@tauri-apps/plugin-opener";
import { copyToClipboard } from "../clipboard";
import { C, termMinContrastRatio, xtermTheme } from "../theme/colors";
import { useResolvedTheme } from "../theme/theme";
import {
  TERM_HAIRLINE,
  TERM_PLANE,
  TERM_RADIUS,
  TERM_TYPE,
  TERM_UI,
  termInk,
  termMuted,
} from "./terminalChrome";
import type { AgentTabStatus, Runtime } from "../types";
import { getTransport, type AgentTransport } from "../services/agentTransport";
import { StatusEngine } from "../engine/statusEngine";
import { registerStatusEngine, unregisterStatusEngine } from "../engine/engineRegistry";
import { snapshotScreen } from "../engine/screenSnapshot";
import { bottomRowIndices } from "../engine/composerOcclusion";
import { registerScrollback, serializeScrollback } from "../services/terminalScrollback";
import { registerViewport } from "../services/terminalViewport";
import { useUiStore } from "../stores/uiStore";
import { useInteractionStore } from "../stores/interactionStore";
import { usePresenceStore } from "../stores/presenceStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useTerminalOverlayStore } from "../stores/terminalOverlayStore";
import { isComposerToggleKey } from "./composerToggle";
import { shouldReclaimPlainDrag } from "./terminalSelectionReclaim";
import { isCopySelectionKey } from "./copySelectionKey";
import { arrowKeySequence } from "./composerArrowOverflow";
import { wheelToScrollLines } from "./terminalScroll";
import { resolveTerminalOverlay } from "./terminalOverlay";
import { TERMINAL_AGENT_ATTR, TERMINAL_SURFACE_ATTR } from "../voice/dictationFocus";
import { makeLineScanState, scanSubmittedLines, hasPendingInput } from "./terminalSubmit";
import { useKeybindingsStore } from "../stores/keybindingsStore";
import { matchesChord } from "../keyboardHints/keybindings";
import { dismissibleSurfaceOpen } from "../engine/cable";
import { noteTerminalInteraction } from "../services/terminalFocusIntent";
import { noteTerminalEscape } from "../services/terminalEscapeRelease";
import { isMeasuredSize, spawnSize, type TermSize } from "./terminalSize";
import { PtyAckBatcher, PtyFlowController } from "./terminalFlow";
import { SelectionPopup } from "./SelectionPopup";
import {
  forceFullRepaint,
  settleRepaintPlan,
  releaseGlContext,
  findWebglCanvas,
  onWebglContextLostImmediately,
  guardWebglDrawPath,
  registerAtlasPeer,
  unregisterAtlasPeer,
  clearSharedAtlasEverywhere,
  type GlCanvasLike,
} from "./terminalWebgl";
import {
  acquireWebglPermit,
  releaseWebglPermit,
  liveWebglPermitCount,
  noteWebglCanvasUnfindable,
  noteWebglCanvasFound,
  isWebglCanvasUnfindable,
  type WebglPermit,
} from "./webglContextRegistry";
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

// Hand a link clicked in terminal output to the OS default browser. Shared by BOTH link paths —
// WebLinksAddon (bare URLs in the output) and xterm core's OSC 8 handler (escape-sequence
// hyperlinks) — because each ships a stock handler that dead-ends in the Tauri webview.
/** How many Terminal instances are mounted right now.
 *
 * Exists to make the resize fan-out MEASURABLE. Every open pane stays laid out at full size
 * (`paneVisibility.ts` uses `visibility: hidden`, never `display: none`) and each owns a
 * ResizeObserver, so one window or divider resize changes every pane's box at once and does the
 * fit/reflow/PTY-sync work below N times synchronously on the main thread — cost proportional to
 * open panes × scrollback, not to what is on screen. Without this number in the log, a slow resize
 * is indistinguishable from one slow pane, which is the difference between an O(1) and an O(N)
 * problem. See the span in the observer callback.
 */
let liveTerminalCount = 0;

function openLinkFromTerminal(event: MouseEvent, uri: string): void {
  event.preventDefault();
  openUrl(uri).catch((err) => console.error("Failed to open URL from terminal:", uri, err));
}

// Push the live xterm size to the PTY — but ONLY when it came from a genuinely laid-out
// container, and ONLY when it actually differs from what the child was last told.
//
// The measured-container guard: fit() on a display:none / pre-layout pane collapses to a tiny size
// (cols≈12), and sending that to the PTY makes the agent CLI hard-wrap its output into a thin
// column that no later resize can un-wrap. See terminalSize.ts. term.element exists once
// term.open() has run; its clientWidth is 0 while the pane is hidden.
//
// The UNCHANGED-SIZE guard (`sent`) is what makes a drag cheap, and the ordering of these three
// lines is the whole point. A divider drag moves the box by a few pixels per frame, which is far
// less than one cell: `fit.fit()` proposes the SAME cols/rows and early-returns, so no reflow
// happens — and this function used to go on to force a layout read and fire a `pty_resize` IPC
// telling the child a size it already had, every frame, for every on-screen pane. Measured on
// v0.68.0 that redundant push was 330-536 ms per frame (`terminal-resize.syncPty` was 534 ms of a
// 536 ms `terminal-resize`, while `.fit` and `.repaint` never once cleared the 16 ms span floor —
// see PRD/sparkle/resize-lag-measurement.md). Comparing FIRST costs two integer reads of xterm's
// own buffer dimensions, which is plain state and not a layout query, so the frame that changed
// nothing now pays nothing.
//
// `sent` is per-PTY and MUST be reset when a new one is spawned (the mount effect does this), or a
// restarted child would inherit the previous one's memo and never be told its real size.
function syncPtySize(
  transport: AgentTransport | null,
  term: XTerm,
  sent: { current: TermSize | null },
): void {
  const cols = term.cols;
  const rows = term.rows;
  if (sent.current && sent.current.cols === cols && sent.current.rows === rows) return;
  const laidOut = !!term.element && term.element.clientWidth > 0;
  if (!isMeasuredSize(laidOut, term)) return;
  transport?.resize(cols, rows);
  // Record only what we actually pushed. An unmeasured box returns above WITHOUT recording, so the
  // real size still gets sent once the pane is laid out.
  sent.current = { cols, rows };
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
  // Cell geometry, for turning the composer overlay's pixel height into a covered ROW count.
  // cellHeight is 0 until the terminal is genuinely laid out — callers must treat that as
  // "unknown" and decline to guess (see engine/composerOcclusion.ts).
  cellMetrics: () => { cellHeight: number; rows: number };
  // The bottom `count` rows currently ON SCREEN, top-to-bottom, as plain text. Reads the viewport
  // (not the end of the scrollback) so it reflects what is actually painted under the composer
  // even when the user has scrolled up.
  readBottomRows: (count: number) => string[];
  // Tear down and re-spawn this agent's PTY — the same path as the overlay's "Start again", but
  // callable by the parent. Used when a send discovers the PTY has exited: the agent is respawned
  // (resuming its Claude session) and the composer's queued prompt is delivered on the new PTY.
  restart: () => void;
}

/**
 * One xterm.js terminal bound to one agent's PTY (spec §3). Spawns the command on
 * mount, streams pty:output into the terminal AND the statusEngine, forwards
 * keystrokes back to the PTY, and tears the PTY down on unmount. Mouse-select + Cmd+C
 * copy are built into xterm.
 */
/** The two ways Terminal asks the pane for the composer caret, split by PROVENANCE.
 *
 *  Exported, and routed through rather than called inline, because which callback each site uses is
 *  the whole point and is otherwise untestable without standing up xterm and a PTY — it regressed
 *  three times on this branch while every test stayed green (roborev 54265). `chord` is the user
 *  asking for the box by name (⌘J); `reveal` is the app moving the caret because the pane appeared.
 *  Only the first may re-aim dictation; see SparkleAgentPane. */
export const composerFocusRequest = {
  chord: (h: ComposerFocusHandlers) => h.onUserRequestFocus?.(),
  reveal: (h: ComposerFocusHandlers) => h.onRequestFocus?.(),
};

export interface ComposerFocusHandlers {
  onRequestFocus?: () => void;
  onUserRequestFocus?: () => void;
}

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
  onUserRequestFocus,
  onSubmitLine,
  composerOverlay = false,
  focusRef,
  apiRef,
  resuming = false,
  calm = false,
  runtime = "local",
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
  // PRD §3 "calm": this agent has nothing for you (P2), so its text recedes to one gray while the
  // P0/P1 agents keep color. Applied as the terminal's OWN theme, not a filter over the pane — see
  // theme/colors.xtermTheme for why the filter had to go.
  calm?: boolean;
  // Which transport backs this terminal: "local" (a PTY on the Mac, today's behavior) or "cloud"
  // (a Sparkle-provisioned E2B sandbox, streamed over the relay). Selects LocalTransport vs
  // CloudTransport via getTransport — so a cloud agent never spawns a local PTY. Defaults to
  // "local" so every existing call site (and its tests) is unchanged.
  runtime?: Runtime;
  onStatus: (s: AgentTabStatus) => void;
  onReady?: () => void;
  onExit?: () => void;
  // Called when the active tab is shown, to put initial focus in the composer.
  /** The APP wants the caret in the composer — the reveal effect below, on pane show / agent
   *  change. Incidental: it must not re-aim dictation. */
  onRequestFocus?: () => void;
  /** The USER asked for the composer — the ⌘J chord. A separate callback rather than a flag on the
   *  one above, because provenance cannot be recovered downstream: the chord un-minimizes the
   *  composer, whose textarea is not rendered while minimized, so the caret does not arrive until a
   *  later, app-driven focus. Two call sites, two callbacks (roborev 54252 / 54259). */
  onUserRequestFocus?: () => void;
  // Called when the user submits a line to the agent by pressing Enter directly in the terminal
  // (a carriage return in USER input) — one call per submitted line. The parent uses this to meter
  // free-trial prompts for trial users who type into the raw terminal (no composer). Best-effort.
  onSubmitLine?: () => void;
  // Does a COMPOSER float over this terminal? True only for the Improve-Sparkle pane, which kept
  // its Composer when CM-U7 removed the builder panes' (SparkleAgentPane renders one as a sibling
  // over an absolutely-positioned Terminal). It gates the plain-drag selection reclaim below —
  // hardcoding it to `false` made that patch a provable no-op AND silently took Option-free
  // selection away from the one pane that still qualifies (roborev 46485-M).
  composerOverlay?: boolean;
  // The parent sets this to an imperative focus() so it can move focus into the terminal
  // (e.g. on ⌘J / when the composer minimizes) without the user clicking it.
  focusRef?: RefObject<(() => void) | null>;
  // Imperative bridge so the parent can drive this terminal (e.g. arrow hand-off from the composer).
  apiRef?: RefObject<TerminalApi | null>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // The transport backing this terminal (Local or Cloud), created in the mount effect and read by
  // the visibility/zoom effects (which need it to resize the PTY without re-subscribing). Nulled on
  // teardown so a late effect callback hits a null guard rather than a stale transport.
  const transportRef = useRef<AgentTransport | null>(null);
  // promptHistory entry id -> the xterm marker at the line where that prompt was sent. Drives
  // "jump to this prompt" (pinned-prompt dropdown + history search). Session-only.
  const markersRef = useRef<Map<string, IMarker>>(new Map());
  // The WebGL renderer (when available) caches colored glyphs in a texture atlas — kept so the
  // live re-theme effect can clear it and force already-painted cells to repaint.
  const webglRef = useRef<WebglAddon | null>(null);
  // The addon's own canvas, captured at attach time (it exposes no handle, and after dispose the
  // canvas is detached and unfindable). Needed to release the GPU context deterministically —
  // xterm's dispose() never does. See teardownWebgl.
  const webglCanvasRef = useRef<GlCanvasLike | null>(null);
  // Our slot in the process-wide concurrent-context cap; handed back on every teardown path.
  const webglPermitRef = useRef<WebglPermit | null>(null);
  // True once THIS pane's canvas probe has failed. Keeps a single pane to one stranded context and
  // one piece of latch evidence, no matter how many times attachWebgl re-runs for it.
  const probeFailedRef = useRef(false);
  // Unsubscriber for our immediate webglcontextlost listener.
  const webglLostUnlistenRef = useRef<(() => void) | null>(null);
  const webglDrawGuardRef = useRef<(() => void) | null>(null);
  // Lets the context-loss callbacks — registered once at attach and living for the addon's whole
  // lifetime — call the CURRENT detachWebgl without being re-registered on every render.
  const detachWebglRef = useRef<(() => void) | null>(null);
  // Set when a PTY chunk is written while this pane can't paint (hidden / 0-sized canvas): those
  // cells get cached as "drawn" by the WebGL renderer but never reach the GPU, so a bare refresh()
  // can't recover them (see forceFullRepaint). The next settle that lands while the pane IS
  // paintable consumes this with a full repaint — so we pay the (cold-repaint) cost once per
  // poisoning episode instead of on every settle. Become-active also clears it on reveal.
  const poisonedRef = useRef(false);
  // Latest `active`, read by the (agentId-keyed) mount effect's ResizeObserver without
  // re-subscribing. It is the ON-SCREEN signal: AgentPane passes the same boolean to
  // `paneVisibilityStyle(visible)` that it passes here, so `active === false` is exactly the pane
  // that is `visibility: hidden`. The effect's own `active` closure is captured at mount and would
  // be stale forever, which is why this is a ref and not the prop.
  const activeRef = useRef(active);
  activeRef.current = active;
  // Set when the ResizeObserver observed a box change on a HIDDEN pane and deliberately skipped the
  // fit/reflow/repaint (see the observer below). The become-active reveal effect — which already
  // re-fits and force-repaints unconditionally — is what pays that debt, and clears this.
  const resizeDirtyRef = useRef(false);
  // The size this pane's PTY was LAST TOLD, so a resize that didn't change the cell count costs
  // nothing (see syncPtySize). Null means "the child has never been told" — reset to null whenever
  // a new PTY is spawned, so the memo can never outlive the child it describes.
  const sentPtySizeRef = useRef<TermSize | null>(null);
  // Latest onRequestFocus, read by the (agentId-keyed) effect without re-subscribing.
  const onRequestFocusRef = useRef(onRequestFocus);
  onRequestFocusRef.current = onRequestFocus;
  const onUserRequestFocusRef = useRef(onUserRequestFocus);
  onUserRequestFocusRef.current = onUserRequestFocus;
  // Latest onSubmitLine, read by the (agentId-keyed) onData handler without re-subscribing.
  const onSubmitLineRef = useRef(onSubmitLine);
  onSubmitLineRef.current = onSubmitLine;
  // Latest composerOverlay, read by the (agentId-keyed) selection patch without re-subscribing.
  const composerOverlayRef = useRef(composerOverlay);
  composerOverlayRef.current = composerOverlay;
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

  // Release EVERY GPU resource this pane holds, in the one order that is safe. Used by all three
  // release paths — hide, unmount, and context-loss — deliberately as a single function: a second
  // teardown path that forgot to give the permit back would permanently shrink the cap (after
  // MAX_WEBGL_CONTEXTS leaks, no pane on this machine would ever get a WebGL renderer again).
  const teardownWebgl = useCallback(() => {
    // 1. Stop watching the canvas FIRST. We are about to deliberately lose its context below, which
    //    dispatches webglcontextlost — our own listener would otherwise re-enter this teardown.
    webglLostUnlistenRef.current?.();
    webglLostUnlistenRef.current = null;
    // Un-wrap renderRows too, for the same reason and in the same breath: the guard closes over
    // this pane's context, so leaving it installed on a renderer we are about to dispose would keep
    // that context reachable and re-enter teardown on the next frame.
    webglDrawGuardRef.current?.();
    webglDrawGuardRef.current = null;
    const webgl = webglRef.current;
    // Drop out of the shared-atlas broadcast FIRST. A peer clearing the atlas mid-teardown would
    // otherwise call clearTextureAtlas() on an addon we are about to dispose.
    unregisterAtlasPeer(webgl);
    const canvas = webglCanvasRef.current;
    webglCanvasRef.current = null;
    // 2. Null the ref BEFORE dispose so any repaint/re-theme effect that reads webglRef can't touch
    //    a half-disposed addon if it races in during teardown.
    webglRef.current = null;
    if (webgl) {
      try {
        webgl.dispose();
      } catch {
        /* already torn down — nothing to release */
      }
    }
    // 3. Hand the GPU context back EXPLICITLY, after dispose. xterm's dispose() only does
    //    removeChild(canvas) — it never calls WEBGL_lose_context.loseContext() (verified: the
    //    string does not appear in @xterm/addon-webgl 0.19.0), so without this the context survives
    //    until GC and keeps counting against the engine's measured 16-context budget. That is the
    //    leak that let 103 attaches in one session exhaust the budget and get the VISIBLE
    //    terminal's context evicted (the engine evicts the oldest), which is the garbage-glyph bug.
    releaseGlContext(canvas);
    // 4. Give the slot back so the next reveal can take it.
    releaseWebglPermit(webglPermitRef.current);
    webglPermitRef.current = null;
  }, []);

  // Attach the xterm WebGL renderer to the live terminal. Called ONLY when this pane is
  // visible/active (see the visibility effect below). The engine caps concurrent WebGL contexts at
  // a MEASURED 16 (scripts/measure-webgl-context-limit.mjs; WebKit 26.5 and Chromium 149 agree),
  // and the app keeps one xterm per open agent — including hidden panes, which stay laid out
  // (visibility:hidden, not display:none) and so used to keep a live context each. Past the cap the
  // engine evicts the OLDEST context, and an evicted renderer keeps drawing from a dead texture
  // atlas: right layout, right colors, wrong glyphs. Holding a context only for the visible pane —
  // and only up to MAX_WEBGL_CONTEXTS of them — keeps us far under the cap. The xterm core, its
  // scrollback, and the PTY are untouched: only the renderer addon is added. Idempotent.
  const attachWebgl = useCallback(() => {
    if (disposedRef.current) return;
    const term = termRef.current;
    if (!term || webglRef.current) return; // no terminal yet, or already attached
    // Claim a slot before allocating anything. Refused → stay on xterm's DOM renderer, which has no
    // GPU context and no texture atlas and therefore CANNOT produce corrupted glyphs. Slightly less
    // crisp box-drawing is the entire cost; taking a context we don't have budget for would evict
    // somebody else's and corrupt THEIR pane.
    // THIS pane already failed the probe. Bail before allocating anything: another addon means
    // another context we cannot release. This also makes the evidence unit a PANE rather than an
    // attach — attachWebgl runs twice for a pane that mounts active (mount effect + visibility
    // effect), and counting both would let one unlucky pane arm the process-wide latch by itself.
    if (probeFailedRef.current) return;
    // Some other panes already failed; WebGL is given up for the process (see
    // noteWebglCanvasUnfindable). Bail before allocating anything — this effect re-runs on every
    // activation.
    if (isWebglCanvasUnfindable()) return;
    const permit = acquireWebglPermit(agentId);
    if (!permit) {
      // Logged so a recurrence is self-diagnosing. If this appears, more panes believe they are
      // visible than MAX_WEBGL_CONTEXTS allows — either raise the cap (still far under the measured
      // 16) or find out why N panes think they are on screen. Silence here was how the original
      // exhaustion went unnoticed until it corrupted the screen.
      console.warn("webgl renderer capped; using DOM renderer", agentId, liveWebglPermitCount());
      return;
    }
    // WebGL renderer enables customGlyphs (the default DOM renderer does not), giving crisp,
    // exactly-aligned box-drawing. Fall back silently to the DOM renderer if WebGL is unavailable.
    try {
      // Time WebGL attach — a new GPU context per pane reveal (switching agents). If this shows up in
      // the jank window, context churn is the switch cost (perfTrace).
      const webgl = perfSpan(
        "Terminal.attachWebgl",
        () => {
          const w = new WebglAddon();
          // Belt-and-braces: the addon's own onContextLoss fires a full 3 SECONDS after the context
          // dies (and never at all if the engine restores it first) — far too late to prevent
          // corruption, which is why the canvas listener below exists. We still wire this so a loss
          // the listener somehow misses still releases the context and the permit.
          w.onContextLoss(() => detachWebglRef.current?.());
          term.loadAddon(w);
          return w;
        },
        { agentId },
      );
      webglRef.current = webgl;
      webglPermitRef.current = permit;
      // Capture the addon's canvas NOW: it exposes no handle to it, and after dispose the canvas is
      // detached from the DOM and can no longer be found. Needed to release the context (step 3 of
      // teardownWebgl) and to watch for loss.
      webglCanvasRef.current = findWebglCanvas(term.element ?? null);
      if (!webglCanvasRef.current) {
        // The probe found no webgl2 canvas even though the addon attached, so we can neither watch
        // this context for loss nor release it. BOTH failure modes are severe and silent:
        //
        //   · unreleasable → the context leaks, which is what exhausted the engine's 16-context
        //     budget and got the visible terminal's context evicted in the first place;
        //   · unwatchable  → on loss, xterm's own path takes over. It preventDefaults and waits 3s,
        //     and if the engine restores the context first it calls _initializeWebGLState() and
        //     _requestRedrawViewport() — which empties the glyph atlas but NEVER clears the
        //     renderer's per-cell model. _updateModel then skips every cell as already-drawn, so
        //     nothing is uploaded into the empty atlas and the pane goes SOLID BLACK, permanently,
        //     recoverable only by a remount. onContextLoss never fires either, because the restore
        //     cleared its timer, so nothing in the app ever learns.
        //
        // So a renderer we cannot manage is strictly worse than no renderer: xterm's DOM renderer
        // has no atlas and no model cache and therefore cannot fail either way. Give it up.
        // Record the failure BEFORE tearing down. Enough of these latches WebGL off for the whole
        // process (see noteWebglCanvasUnfindable) — deliberately NOT on the first one, because a
        // process-wide latch on a one-off timing failure would cost every pane its renderer.
        // Exactly ONE note per mounted pane, so the threshold counts panes and not attaches.
        probeFailedRef.current = true;
        noteWebglCanvasUnfindable(agentId);
        // Say which of the two things just happened: a single unmanageable pane, or WebGL being
        // given up session-wide. The second is far more consequential and must not read like the
        // first in the log.
        console.warn(
          isWebglCanvasUnfindable()
            ? "webgl canvas not found repeatedly; DISABLING WebGL process-wide, all panes now use the DOM renderer"
            : "webgl canvas not found; this pane uses the DOM renderer (cannot watch or release it)",
          agentId,
        );
        teardownWebgl();
        return;
      }
      // A successful probe refutes the "this build hides its canvas" hypothesis, so it clears that
      // hypothesis's evidence — the distinct-agent and consecutive-failure tallies. It deliberately
      // does NOT draw down the outstanding-leak estimate, and does NOT disarm a latch that has
      // already armed: a working probe does not un-strand the contexts earlier failures leaked, nor
      // undo a decision already taken. (That estimate decays on ELAPSED TIME, not on successes —
      // successes accrue per hide/show while leaks accrue per pane, so counting them would key the
      // decay to how fast the human switches agents. See the registry.)
      noteWebglCanvasFound();
      // THE FIX THAT MAKES CORRUPTED GLYPHS IMPOSSIBLE RATHER THAN MERELY RARER. Listen for
      // webglcontextlost ourselves and fall back within the same event dispatch, instead of waiting
      // out the addon's 3-second restore timer while it renders from a dead atlas. See
      // onWebglContextLostImmediately for the addon source this works around.
      webglLostUnlistenRef.current = onWebglContextLostImmediately(webglCanvasRef.current, () =>
        detachWebglRef.current?.(),
      );
      // ...and guard the DRAW ITSELF, because the listener above is still a race. Eviction flips
      // isContextLost() synchronously but dispatches webglcontextlost on a LATER task, so frames
      // painted in between go through a dead context: right cells, right colors, wrong glyphs. This
      // is what makes corruption IMPOSSIBLE rather than merely rare — a frame that is never drawn
      // cannot be drawn wrong, no matter when the event lands. See guardWebglDrawPath.
      // Join the shared-atlas broadcast: from here on, any pane clearing the atlas resyncs us too.
      registerAtlasPeer(webgl);
      webglDrawGuardRef.current = guardWebglDrawPath(webgl, webglCanvasRef.current, () =>
        detachWebglRef.current?.(),
      );
      // NOTE: we deliberately do NOT force a repaint here. attachWebgl is only ever called when this
      // pane is (becoming) active, and the become-active reveal effect below OWNS the repaint — it
      // waits for the box to lay out, then forceFullRepaints (clearing the fresh atlas so cells
      // buffered on the DOM renderer while hidden rasterize into the new WebGL model). Keeping a
      // single repaint path preserves the tested reveal-repaint contract (Terminal.revealRepaint).
    } catch {
      /* no WebGL — keep the default DOM renderer (TUI borders may be less crisp) */
      teardownWebgl(); // never hold the permit for a renderer that failed to attach
    }
    // agentId is stable for this component's life; it only labels the permit and the perf span.
  }, [agentId, teardownWebgl]);

  // Drop the WebGL renderer and fall back to xterm's DOM renderer, releasing the GPU context and
  // the permit. The content buffer, scrollback, and PTY all live on the xterm core and are
  // untouched, so the terminal keeps rendering. Called when this pane becomes hidden AND when its
  // context is lost — a lost context must reach a clean fallback, never corrupted output.
  // Idempotent.
  const detachWebgl = useCallback(() => {
    if (!webglRef.current) return;
    teardownWebgl();
    // Repaint via the now-active DOM renderer so the screen doesn't go stale after the swap. This is
    // what turns a lost context into a clean frame instead of leftover garbage. No-op once disposed.
    safeRefresh();
  }, [teardownWebgl, safeRefresh]);
  // Read by the context-loss callbacks registered at attach time, which must call the LATEST
  // detachWebgl without being re-registered (they live for the addon's lifetime).
  detachWebglRef.current = detachWebgl;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    disposedRef.current = false;
    let disposed = false;
    const unlistens: Array<() => void> = [];

    // Select the transport by runtime. Local → a PTY on the Mac (pty.ts, unchanged behavior); cloud
    // → the relay stream for the already-running server session (never spawns a local PTY). Every
    // verb below (spawn/write/resize/kill/output/exit) goes through this, not pty.ts directly.
    const transport = getTransport({ id: agentId, runtime });
    transportRef.current = transport;
    // A fresh PTY has been told nothing yet. Clearing the memo here (rather than trusting the size
    // handed to spawn) keeps the post-spawn re-sync below unconditional, which is what preserves the
    // spawn-time width invariant: the child is always told its real size once the box is measured.
    sentPtySizeRef.current = null;

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
      theme: xtermTheme(resolvedTheme, calm),
      // Light mode's safety net for every colour the palette cannot name — the 256-colour cube and
      // truecolor, which is where a TUI's file paths and URLs live. Takes `calm` for the same
      // reason `theme` does: calm is a different palette, with a lower floor of its own that this
      // must not override. See TERM_MIN_CONTRAST_RATIO.
      minimumContrastRatio: termMinContrastRatio(resolvedTheme, calm),
      // OSC 8 hyperlinks (the escape sequence CLIs use to make a WORD clickable, as opposed to a
      // bare URL in the output) are matched by xterm CORE, not by WebLinksAddon — so the addon
      // handler below never sees them. Core's stock handler calls window.confirm() and then
      // window.open(), and both are dead ends in the Tauri webview: confirm is shimmed onto
      // `plugin:dialog|confirm`, which our capability doesn't grant (`dialog:default` covers only
      // message/save/open), so it rejects as an unhandled rejection; window.open is blocked for
      // external URLs. Net effect: clicking an OSC 8 link did nothing at all. Route it through the
      // opener plugin, same as the addon path. `allowNonHttpProtocols` stays at its default
      // (false), so only http(s) targets reach the handler.
      linkHandler: { activate: openLinkFromTerminal },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Make bare http(s) URLs in terminal output clickable. The default addon handler uses
    // window.open, which the Tauri webview blocks for external URLs; route through the
    // opener plugin instead so links launch in the OS default browser.
    term.loadAddon(new WebLinksAddon(openLinkFromTerminal));
    term.open(container);

    // Reclaim plain (no-Option) drags as text selections while the composer is open, even when a
    // mouse-tracking TUI (Claude Code) owns the mouse. xterm gates all of that on ONE internal
    // method — SelectionService.shouldForceSelection(event) — which is the shared chokepoint for
    // both "forward this mousedown to the PTY?" and "start a drag-selection?". On macOS it stock-
    // returns `altKey && macOptionClickForcesSelection`, so a plain drag can never select over a
    // TUI without Option. There is no public hook, so we monkey-patch it (verified against
    // @xterm/xterm 6.0.0; identifiers are un-mangled in the shipped bundle). The patch widens the
    // decision: force selection when `shouldReclaimPlainDrag` says so (composer open), else defer
    // to the original Option rule — so Option-drag still works and a closed composer lets drags
    // fall through to the TUI. Guarded so a future xterm bump that reshapes internals degrades to
    // Option-only rather than throwing.
    try {
      const svc = (
        term as unknown as {
          _core?: { _selectionService?: { shouldForceSelection?: (e: MouseEvent) => boolean } };
        }
      )._core?._selectionService;
      if (svc && typeof svc.shouldForceSelection === "function") {
        const orig = svc.shouldForceSelection.bind(svc);
        svc.shouldForceSelection = (ev: MouseEvent) =>
          shouldReclaimPlainDrag(
            // True only where a composer actually overlays the terminal (the Improve-Sparkle
            // pane). Builder panes lost theirs with CM-U7, so there the policy is simply off.
            composerOverlayRef.current,
            useUiStore.getState().composerMinimized,
          ) || orig(ev);
      } else {
        console.warn(
          "Terminal: xterm SelectionService.shouldForceSelection not found; " +
            "plain-drag selection over a TUI will require Option (xterm internals changed?)",
        );
      }
    } catch (e) {
      console.warn("Terminal: failed to patch shouldForceSelection for plain-drag selection", e);
    }

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
      /* container not laid out yet. A VISIBLE pane is re-fit by the next ResizeObserver tick; a
         hidden one is not (that tick only records the debt now — see the observer below), so the
         spawn path explicitly aligns xterm with the size the child is given instead. */
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
    // Expose the RENDERED SCREEN, which is a different question from the history above and must not
    // be served by it: anything gating a WRITE (dictation routing) has to see what is on screen NOW,
    // because `screenAwaitsInput` matched against 300 lines of history latches true on the session's
    // first `(y/n)` and never clears. Both facts are read in ONE call so they can't straddle a `vim`
    // launch and describe different instants.
    const unregisterViewport = registerViewport(agentId, () => ({
      text: snapshotScreen(term.buffer.active, term.rows),
      alternateBuffer: term.buffer.active.type !== "normal",
    }));
    // Let the parent move focus into the terminal imperatively (⌘J / composer minimize).
    //
    // terminal-focus: user-driven — this line PROVIDES the capability, it does not exercise it, so the
    // provenance decision belongs at each CALLER (AgentPane and SparkleAgentPane both mark their
    // auto-focus; the drop path declares itself user-driven). Marking here would stamp every caller with
    // one answer and make the distinction unexpressible.
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
    // Publish this engine so the user-input submit paths (Composer / requery → submitPrompt) can
    // signal noteUserInput on it — the recovery signal for a stuck-red row (Bug B). Unregistered in
    // the cleanup below.
    registerStatusEngine(agentId, engine);

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
      // THE USER IS WORKING IN THIS TERMINAL. `onData` is the honest signal for that, and the only
      // one available: the pane parks the caret here automatically, and once this textarea is already
      // focused a click inside it raises no `focusin` while every keystroke is swallowed by xterm's
      // own handler before any window listener sees it. Without this, provenance stayed "the app put
      // you here" for a whole session of hand-driving an agent, and the wrong Escape ladder applied
      // (roborev 55722). Idempotent — it costs nothing once the verdict is already deliberate.
      noteTerminalInteraction();
      // Same signal, second consumer: this is the app's only evidence that a user typing into a
      // terminal — rather than into the compose box — is still at the keyboard. Without it the
      // presence store would call someone Away after five minutes of driving an agent by hand, and
      // the concierge would start acting alone with the user watching (stores/presenceStore).
      usePresenceStore.getState().noteInput();
      const submits = scanSubmittedLines(lineScan, d);
      for (let i = 0; i < submits; i += 1) onSubmitLineRef.current?.();
      // The same scan answers "is the user mid-line at the CLI prompt right now?", which is what
      // the terminal-anchored action pill hides on — there is no React `value` to read here, the
      // input line is painted by the CLI inside this canvas. Published rather than passed up as a
      // prop because the pill is owned by the concierge, not by this pane. The store no-ops unless
      // emptiness actually FLIPS, so this stays one write per word, not one per keystroke.
      useTerminalOverlayStore.getState().setDraft(agentId, hasPendingInput(lineScan));
      transport.write(d);
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
    //   • ⌘J is INTERCEPTED AND SWALLOWED, WITH NO FOCUS DESTINATION LEFT. It used to bounce focus
    //     back to the composer (restoring it if minimized); no pane has a composer any more — this
    //     is now the only place the chord does anything, and what it does is keep the keystroke away
    //     from the running process. Do not read the branch below as a focus move; see
    //     SHORTCUT_LABELS.toggleComposer, which describes the same behaviour to the user, and
    //     PRD/sparkle/improve-sparkle-mounting.md for the retirement follow-up.
    //   • ⌘C copies the current selection ourselves — xterm's selection isn't a native DOM
    //     selection, so without this the OS native copy finds nothing and just beeps. With no
    //     selection we pass ⌘C through unchanged.
    term.attachCustomKeyEventHandler((e) => {
      // Read the binding live (getState, not a captured value) so a rebind in Settings takes
      // effect without remounting the terminal.
      const toggle = useKeybindingsStore.getState().bindings.toggleComposer;
      if (isComposerToggleKey(e, toggle)) {
        // BOTH CALLS ARE INERT TODAY, and retained rather than deleted only so the ⌘J retirement is
        // one decision in one place instead of a slow amputation across three files:
        //  • `setComposerMinimized(false)` — nothing renders off that flag now; its one remaining
        //    reader is shouldReclaimPlainDrag, whose `composerOverlay` is false for every pane.
        //  • `composerFocusRequest.chord(…)` — both refs are undefined for every caller (AgentPane
        //    never passed them; SparkleAgentPane stopped when its composer went), so the map's chord
        //    branch runs and reaches nothing. It is kept because the chord/reveal DISTINCTION is
        //    still the contract if anything is ever wired here again — pinned by
        //    Terminal.composerFocusRequest.test.ts.
        // The `return false` is the part that still matters: it stops the chord reaching the PTY.
        useUiStore.getState().setComposerMinimized(false);
        composerFocusRequest.chord({
          onRequestFocus: onRequestFocusRef.current,
          onUserRequestFocus: onUserRequestFocusRef.current,
        });
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
      // ESCAPE — THE CABLE'S RELEASE GESTURE, DECIDED HERE BECAUSE NOWHERE ELSE CAN SEE IT.
      //
      // xterm's own keydown handler calls `cancel(ev, true)` for Escape — `preventDefault()` AND
      // `stopPropagation()` (`case 27: … o.cancel = !0`, then `i.cancel && this.cancel(e,!0)` in the
      // shipped bundle). So an Escape typed into a focused terminal NEVER reaches the `window`
      // listener in `Workspace`. The first version of this feature lived there and was unreachable;
      // its tests passed only because they fired `keyDown(window, …)` at a stub with no xterm handler
      // (roborev 55722).
      //
      // RETURNS `true` DELIBERATELY: the byte must still reach the PTY, so vim leaves insert mode,
      // `less` dismisses and Claude Code interrupts exactly as before. The cable's response happens
      // ALONGSIDE the keystroke, never instead of it — which is what makes the known Escape-Escape
      // collision affordable rather than a key we stole.
      // KEYDOWN ONLY, AND NOT AN AUTOREPEAT. Both guards are load-bearing and both were nearly missed:
      //
      //   - `attachCustomKeyEventHandler` is called for KEYUP AND KEYPRESS too, not just keydown —
      //     xterm's `_keyUp` and `_keyPress` both run `this._customKeyEventHandler(e)`, and `keyup` is
      //     bound on the textarea in `_bindKeys`. Without the type check, ONE physical press called
      //     this twice: the keydown paid the toll and the keyup of the SAME press found it paid and
      //     released the cable, collapsing "Escape twice" into one press. The toggle-chord block below
      //     already knew this ("incl. the keyup") — the lesson was there to be read.
      //   - macOS autorepeat delivers keydown #2 after ~120–500ms, far inside the toll's 5s window, so
      //     HOLDING Escape would pay and then release without the user ever pressing twice. `Workspace`
      //     carries the same guard for the same reason (roborev 55491); it was left behind when this
      //     decision changed layers.
      //
      // `dismissibleOpen` comes from the SHARED probe in `engine/cable`, not a local copy of the
      // selector — the predicate is only as shared as its input, and a duplicated selector would let a
      // new Escape-owning surface be registered in one path and not the other. It matters here because a
      // focused terminal means a surface's own window-level Escape handler never fires either (xterm
      // cancels propagation), so without it an Escape aimed at an open menu dropped the cable silently.
      if (e.key === "Escape" && e.type === "keydown" && !e.repeat) {
        noteTerminalEscape({ dismissibleOpen: dismissibleSurfaceOpen(document) });
        return true;
      }
      // THE UNMOUNT CHORD IS NOT PTY INPUT. It is handled by the `window` listener in `Workspace`,
      // which owns the cable — but that listener runs on the BUBBLE, i.e. after xterm has already
      // decided what to send, so its `preventDefault` cannot un-send a sequence xterm emitted on the
      // way past. `evaluateKeyboardEvent` folds `metaKey` into its modifier bitmask, so a ⌘⇧-letter
      // combo is not self-evidently inert, and a stray byte written into a live agent's stdin cannot
      // be taken back. Claim it here and let the window listener do the unmounting — the same
      // belt-and-braces the toggle chord above takes, for the same reason.
      //
      // Read LIVE from the store (not a captured value) so a rebind in Settings takes effect without
      // remounting the terminal, matching `toggle` above.
      if (matchesChord(e, useKeybindingsStore.getState().bindings.unmountCable)) {
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
          // terminal-focus: user-driven — the user pressed an arrow key to drive a menu in THIS
          // terminal. They are engaging with the running program, so the caret arriving here is their
          // intent; recording it as app-placed would let a single Escape drop the cable mid-menu.
          term.focus();
          // Encode against the app's cursor-key mode (DECCKM) so the bytes match a real keypress;
          // see arrowKeySequence. `term.modes` reflects whatever the running TUI last requested.
          const seq = arrowKeySequence(dir, term.modes.applicationCursorKeysMode);
          transport.write(seq);
        },
        enterFromComposer: () => {
          // terminal-focus: user-driven — same reasoning as `arrowFromComposer`: an Enter aimed at the
          // terminal's menu is the user acting on that program, not the app relocating their caret.
          term.focus();
          // \r is the byte a real Enter sends to a PTY (the running TUI translates it per its
          // input mode, exactly as it would a keyboard Enter). This confirms the highlighted menu
          // choice when the user presses Enter in an empty composer.
          transport.write("\r");
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
        cellMetrics: () => ({
          // Same derivation the wheel handler uses: the rendered box divided by the row count.
          // Reports 0 for an unmounted/collapsed element so callers can tell "not laid out yet"
          // apart from a real measurement.
          cellHeight: term.element ? term.element.clientHeight / term.rows : 0,
          rows: term.rows,
        }),
        readBottomRows: (count) => {
          const buf = term.buffer.active;
          // Index math lives in the engine so it's unit-tested (see bottomRowIndices) rather than
          // trusted inline — viewport-relative, so it stays honest while scrolled back.
          return bottomRowIndices({ viewportY: buf.viewportY, rows: term.rows, count }).map((i) => {
            const line = buf.getLine(i);
            return line ? line.translateToString(true) : "";
          });
        },
        restart: () => {
          // Same lever as the overlay's "Start again": bumping `attempt` is in the mount effect's
          // deps, so it tears down and re-spawns cleanly (resuming the Claude session).
          setSpawnFail(null);
          setAttempt((a) => a + 1);
        },
      };
    }

    // NOTE: this is deliberately NOT where rate-limit failover is detected. Phase 1 scraped a
    // rolling window of raw PTY text here for `rate limit|usage limit|…`, which cannot distinguish
    // a real limit from an agent printing those words — on a real machine it benched two healthy
    // accounts for 4h apiece purely from the agent's own diagnostic output, while never once firing
    // on the message Claude Code actually emits. Detection now reads the STRUCTURED
    // `error: "rate_limit"` record out of each account's own transcripts (Rust `accounts_limit_events`
    // → services/rateLimitWatch), which is unforgeable by terminal text. Do not reintroduce a text
    // matcher here.

    // Whether this terminal's canvas can actually paint right now (it's laid out and visible).
    // A display:none pane has a 0-width element; output written then is cache-poisoned (see
    // poisonedRef / forceFullRepaint).
    const isPaintable = () => !!term.element && term.element.clientWidth > 0;

    // Whether a repaint of this pane would be SEEN — i.e. it is laid out AND it is the pane on
    // screen. Both halves are load-bearing, and `isPaintable` alone is NOT enough:
    //
    //   `isPaintable` dates from the display:none era, when a backgrounded pane collapsed to a 0×0
    //   box and "measurable" and "on screen" were the same question. paneVisibility.ts retired that
    //   (every pane stays `display: flex` at full size, hidden only by `visibility`), and a
    //   `visibility: hidden` element keeps its layout box — so `clientWidth > 0` is TRUE for all
    //   sixty backgrounded panes. Gating the fan-out on it alone would have been a no-op.
    //
    // `activeRef` is the half that says on-screen; `isPaintable` is still the half that says the
    // box is real (a mid-teardown or pre-layout pane must not be treated as visible either).
    const isOnScreen = () => activeRef.current && isPaintable();

    // Apply the settle/resize repaint plan: a full forceFullRepaint to drain cache-poisoned cells
    // (once, when poisoned AND paintable), else a cheap refresh that marks rows dirty. Shared by
    // the output-settle timer AND the ResizeObserver — so a pane revealed by a *resize* (not the
    // active toggle) and with no further output still gets drained. settleRepaintPlan keeps the
    // expensive cold repaint to once per poisoning episode (see terminalWebgl.ts).
    const applyRepaintPlan = () => {
      // Gate on isOnScreen(), NOT isPaintable(): a backgrounded pane stays `display: flex` at full
      // size (paneVisibility.ts hides it with `visibility: hidden`), so `isPaintable()` — which is
      // just `clientWidth > 0` — is TRUE for it and the plan would `refresh` sixty hidden panes per
      // settle (bead sparkle-nwpf). `isOnScreen()` adds the `activeRef` half, so a hidden pane
      // resolves to `skip` (poisoned preserved); the become-active reveal force-repaints on show.
      const plan = settleRepaintPlan(poisonedRef.current, isOnScreen());
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
    // Pause/resume the PTY reader across the parse-backlog watermarks. The serialization that keeps
    // a `false` from overtaking an earlier `true` (roborev nit on ) now lives inside
    // LocalTransport.setPaused; a cloud transport omits setPaused entirely (the server owns its
    // sandbox PTY's backpressure), so the optional call is a no-op there.
    const flow = new PtyFlowController((paused) => {
      transport.setPaused?.(paused);
    });
    // The OTHER half of backpressure, and the one that bounds the IPC queue itself: Rust charges
    // every emitted chunk against a per-PTY credit ceiling and parks its flusher/reader once the
    // frontend falls behind. Returning that credit here — after xterm has PARSED the chunk, not
    // merely after we dequeued it — is what makes the producer's accounting reflect real progress.
    // Batched so a flood doesn't cost one invoke per chunk. See terminalFlow.ts / pty.rs. Cloud
    // transports omit ack (no local IPC credit to return), so the optional call is a no-op there.
    const acks = new PtyAckBatcher((bytes) => transport.ack?.(bytes));

    // Subscribe to output + exit BEFORE spawning (the transport's onOutput/onExit return a sync
    // unlisten but register their listener under the hood; transport.spawn awaits that registration
    // for the local PTY, preserving the pre-seam listen-before-spawn ordering). Registered
    // synchronously here, so cleanup always has both unlistens even if the spawn below is still in
    // flight when the component unmounts.
    const offOut = transport.onOutput((e) => {
      // THE LATE-EVENT GUARD, at the source (roborev 55107). Cleanup sets `disposed` and then calls
      // `void safeUnlisten(off)` — genuinely async and fire-and-forget — so these closures survive
      // the round trip to Rust and can still fire for a PTY this pane no longer owns — dead-PTY
      // bytes setting `gotOutputRef`/`firstOutput`/`spawnFail`, which also defeats the "exited with
      // no output" detection the ref exists for. Scope caveat: like the exit handler below, this
      // only covers an UNMOUNTED effect, not a re-spawn in the same component (roborev 55120).
      // Guarding here closes the whole class in one place, rather than hardening each downstream
      // consumer (engine.ingest, engine.exit, the witness setters) one race at a time.
      if (disposed) return;
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
      term.write(e.chunk, () => {
        flow.onParsed(chunkLen);
        // Ack Rust's OWN byte count (UTF-8), not chunkLen (UTF-16 units) — the two differ on any
        // non-ASCII output and drifting credit would eventually wedge or unbound the gate.
        acks.add(e.bytes);
      });
      engine.ingest(e.chunk);
      // Remember output that streamed in while we couldn't paint, so the next paintable settle
      // (or the become-active reveal) repaints it instead of leaving the top half blank.
      if (!isPaintable()) poisonedRef.current = true;
      scheduleSettleRepaint();
      bytesSinceSweep += chunkLen;
      scheduleIdleSweep();
    });
    // The transport filters exit to THIS agent's id (pty:exit is a global channel), so no id check
    // is needed here anymore.
    const offExit = transport.onExit(() => {
      // Same guard — and it covers LESS than the first version of this comment claimed (roborev
      // 55120). It stops an UNMOUNTED effect's handler from running `onExit?.()` and
      // `setSpawnFail("exited")`, which is real and worth closing.
      //
      // It does NOT close "Start again". That bumps `attempt`, an effect dep, so React runs the
      // cleanup and re-runs the effect in this SAME mounted component; the new effect's `disposed`
      // is false, and `LocalTransport.onExit` filters only on `e.id === this.id` with the agent id
      // identical across attempts. The dead PTY's late exit is therefore delivered to the NEW
      // handler and passes this check — still painting "Agent exited — Start again" over a healthy
      // agent. Closing that needs a spawn epoch echoed back from Rust (see the note on AgentPane's
      // onExit, roborev 55114). Do not read this guard as making the class safe.
      if (disposed) return;
      engine.exit();
      onExit?.();
      // If the process exited WITHOUT ever emitting output, don't leave a silent blank pane:
      // show an explicit "Agent exited — Start again" affordance (the spawnFail overlay) instead
      // of the lingering "Starting…". (If output streamed first, firstOutput already cleared the
      // overlay and this is a normal end-of-session — nothing to show.)
      if (!gotOutputRef.current) setSpawnFail("exited");
    });
    unlistens.push(offOut, offExit);

    (async () => {
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
      // KEEP XTERM AGREED WITH WHAT THE CHILD IS ABOUT TO BE TOLD (roborev 56083). When the box is
      // unmeasured, `fit.fit()` above no-ops (FitAddon proposes nothing for a 0-dimension box, so
      // xterm stays at its constructed 80×24) while spawnSize DELIBERATELY returns the 120×30
      // fallback — a 40-column disagreement, created on purpose by terminalSize.ts. That used to be
      // healed by the first ResizeObserver tick after layout; for a hidden pane it no longer is,
      // because that tick now just records the debt. Meanwhile output keeps arriving and being
      // written into the grid, so the mismatch would bake mis-positioned rows into the scrollback of
      // exactly the highest-volume case: backgrounded agents redrawing a --resume transcript at
      // launch. Aligning xterm here costs a reflow of an EMPTY buffer, and is a no-op when the box
      // was measured (fit already sized it to these very dimensions, and xterm early-returns).
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      // A mount→unmount inside this async window must not spawn an orphan PTY the cleanup's
      // detach (which already ran, on a not-yet-existing PTY) will never reap (roborev 46244).
      if (disposed) return;
      await transport.spawn({ command, args, cwd, cols, rows });
      // Layout may have settled — or a ResizeObserver resize may have been dropped because the
      // PTY didn't exist yet — during the async spawn. Now that the PTY exists, sync the true
      // size (no-op while still hidden; the become-active effect covers that).
      if (!disposed) {
        try {
          fit.fit();
        } catch {
          /* still not laid out */
        }
        syncPtySize(transport, term, sentPtySizeRef);
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

    // Copy-on-select: when the user finishes a mouse selection, copy it to the clipboard and show
    // the actions popup, so the (otherwise invisible) copy is obvious. A plain click leaves an
    // empty selection — nothing is copied, nothing pops, and nothing else happens: the composer
    // toggle that used to ride on it went with the pane composer (CM-U7 part 2).
    const onMouseUp = (e: MouseEvent) => {
      const sel = copySelectionToClipboard();
      if (sel) {
        // Open the action popup at the cursor regardless of clipboard timing.
        setPopup({ x: e.clientX, y: e.clientY, text: sel });
        return;
      }
    };
    // A new drag (mousedown) dismisses any open popup before the next selection.
    const onMouseDown = () => setPopup(null);
    container.addEventListener("mouseup", onMouseUp);
    container.addEventListener("mousedown", onMouseDown);

    // ── The resize fan-out (bead sparkle-atp1) ──────────────────────────────────────────────────
    // MEASURED, from one day of a real session's log: at 43 open panes this body cost 167ms per pane
    // (~7.2s per fan-out); at 55 panes, 499ms per pane (~27.4s). 1,245 spans summed to 299 SECONDS of
    // main-thread block across ~29 fan-outs, and the worst watchdog wedge of the day — 59.5s —
    // contained 106 of these spans totalling 52.9s, i.e. 89% of a one-minute freeze was this.
    //
    // The cost is structural, not a slow pane: every open pane stays laid out at full size
    // (paneVisibility.ts), so ONE window or divider change ticks every pane's observer, and each tick
    // did a forced layout, an xterm buffer reflow over the 8000-line scrollback, and a repaint.
    // At most two panes (one per pair) are ever on screen, so ~52 of 54 of those were invisible work.
    //
    // Two things cut it, in this order:
    //   1. a VISIBILITY gate — an off-screen pane records the debt and defers ALL of it (the fit,
    //      the reflow, the repaint AND the PTY resize) to its reveal, where the two widths move
    //      together. Do not "optimize" by keeping the child's width live off screen: that reads as
    //      harmless and is not — see the long note in the branch itself (roborev 56073);
    //   2. a per-pane rAF COALESCE — several observer ticks inside one frame do one pass, not one
    //      pass each (a pointer drag emits dozens of events per second).
    let resizeFrame = 0;
    let framePending = false;

    const runResize = () => {
      resizeFrame = 0;
      framePending = false;
      // The `disposed` bail the observer body used to carry, re-checked HERE because the work now
      // runs a frame LATER than the tick that asked for it. `ro.disconnect()` cannot un-queue an
      // already-scheduled frame any more than it could un-queue an already-dispatched callback, so
      // this is what keeps a queued pass off a freed renderer (the #231/#258 class of bug).
      // `disposed` is this effect's own sentinel; `disposedRef` also catches a teardown driven from
      // elsewhere in the component. The cleanup cancels the frame as well — belt and suspenders,
      // because cancelAnimationFrame cannot help a frame already being dispatched.
      if (disposed || disposedRef.current) return;
      // Instrumented because this is the per-pane half of that fan-out: `panes` is what turns a
      // tolerable per-pane cost into a freeze, and it is the field that says so. The outer span name
      // is unchanged so the historical samples above stay comparable; the three inner spans are new,
      // and answer the question the single span could not — whether the time goes to the forced
      // layout (`fit`), the PTY round-trip (`syncPty`), or the repaint/GPU upload (`repaint`).
      //
      // Free at rest: perfSpan emits nothing below one frame (SPAN_MIN_MS), so a healthy resize
      // stays silent and only a pane that actually ate a frame gets a line.
      perfSpan(
        "terminal-resize",
        () => {
          try {
            if (!isOnScreen()) {
              // OFF SCREEN — the ~52-of-54 case, and the whole win. Do NOTHING but record the debt:
              // no forced layout, no `term.resize()` (which is what re-wraps 8000 lines), no repaint,
              // and no PTY round-trip. The become-active effect settles all of it on reveal.
              //
              // THE PTY SIZE IS DEFERRED TOO, DELIBERATELY — and this is the part that is easy to get
              // wrong (roborev 56073 caught the first version doing it). Pushing the live size to the
              // child while xterm stays at the old one makes the two disagree for as long as the pane
              // stays hidden, and a hidden pane KEEPS INGESTING OUTPUT (the onOutput handler writes to
              // the buffer with no visibility gate). A TUI that reads the tty width — which is exactly
              // what the agent CLI in every one of these panes does — would then emit box drawing,
              // column alignment and absolute cursor addressing computed for the NEW width into a grid
              // still sized to the old one. Those rows are baked into the buffer as they are written;
              // the reveal's `fit()` only rejoins soft-wrapped lines, it cannot re-interpret escape
              // sequences that already landed on the wrong rows. That is the mirror image of the
              // thin-column bug terminalSize.ts exists to prevent, and it is permanent in scrollback.
              //
              // So the invariant is: what the child was told and what xterm is sized to never diverge
              // for a pane that can receive output. Both move together, once, on reveal.
              resizeDirtyRef.current = true;
              return;
            }
            // ON SCREEN — unchanged behaviour, now decomposed into its three stages.
            perfSpan("terminal-resize.fit", () => fit.fit(), { panes: liveTerminalCount });
            // Guard the push: a hide transition fires the observer with a 0×0 box, which fit()
            // collapses to a tiny size — sending that to the PTY re-creates the thin-column bug.
            perfSpan("terminal-resize.syncPty", () => syncPtySize(transport, term, sentPtySizeRef), {
              panes: liveTerminalCount,
            });
            // Repaint the viewport. When the container grows (the pane becoming visible after
            // display:none, or the window enlarging), rows newly brought into view can stay blank —
            // xterm only repaints on resize when fit() actually changed the dimensions.
            // applyRepaintPlan does a cheap refresh normally, OR drains a poisoned pane revealed by
            // this very resize (no active toggle, no further output) with a full forceFullRepaint.
            perfSpan("terminal-resize.repaint", () => applyRepaintPlan(), {
              panes: liveTerminalCount,
            });
          } catch {
            /* ignore transient fit errors while hidden */
          }
        },
        { panes: liveTerminalCount },
      );
    };

    const ro = new ResizeObserver(() => {
      // A ResizeObserver tick can still be queued when the component unmounts (ro.disconnect()
      // doesn't un-queue an already-dispatched callback); bail before scheduling anything.
      if (disposed) return;
      // Per-pane dedupe: N ticks inside one frame schedule ONE pass for this pane.
      if (framePending) return;
      framePending = true;
      resizeFrame = requestAnimationFrame(runResize);
    });
    ro.observe(container);
    // Join the census the span above reports. Paired with the decrement in this effect's cleanup so
    // the count tracks live observers exactly — it is the fan-out width, so an over-count would
    // overstate the very cost we are trying to measure.
    liveTerminalCount += 1;

    return () => {
      liveTerminalCount -= 1;
      disposed = true;
      // Flip the shared sentinel BEFORE disposing so any late callback in another effect (theme
      // re-render, a queued rAF/ResizeObserver tick) sees it and no-ops via safeFit/safeRefresh.
      disposedRef.current = true;
      unregisterScrollback();
      unregisterViewport();
      // The half-typed line dies with the PTY. Without this, an agent torn down mid-compose would
      // leave `drafts[agentId]` true forever, and the action pill would stay hidden on the fresh
      // terminal a "Start again" (or an account switch) remounts here.
      useTerminalOverlayStore.getState().clearDraft(agentId);
      if (focusRef) focusRef.current = null;
      if (apiRef) apiRef.current = null;
      ro.disconnect();
      // Drop the coalesced resize pass if one is queued for a frame that will now land after
      // teardown. `runResize` re-checks `disposed` anyway; cancelling just means we don't burn the
      // frame at all.
      if (resizeFrame) cancelAnimationFrame(resizeFrame);
      container.removeEventListener("mouseup", onMouseUp);
      container.removeEventListener("mousedown", onMouseDown);
      if (settleRepaintTimer) window.clearTimeout(settleRepaintTimer);
      if (idleSweepTimer) window.clearTimeout(idleSweepTimer);
      if (scrollRepaintTimer) window.clearTimeout(scrollRepaintTimer);
      if (copiedTimer.current) window.clearTimeout(copiedTimer.current);
      for (const off of unlistens) void safeUnlisten(off);
      // DETACH, never kill: unmount happens on tab close, StrictMode double-mount, and "Start
      // again" — for a cloud agent, kill() would DELETE the server session that is supposed to
      // outlive this pane (roborev 46244). Local detach == kill (pre-seam behavior).
      void transport.detach().catch((e) => console.debug("terminal detach failed", agentId, e));
      transportRef.current = null;
      unregisterStatusEngine(agentId, engine);
      engine.dispose();
      markersRef.current.clear(); // term.dispose() drops the markers; clear our handles too
      // Dispose the WebGL renderer BEFORE the terminal. Its render loop runs on
      // requestAnimationFrame; if we let term.dispose() tear down the core render service first, an
      // already-scheduled frame can still fire and read `this._renderer.value.dimensions` after it's
      // gone — the uncaught "undefined is not an object (this._renderer.value.dimensions)" TypeError
      // seen in the logs. Disposing the addon first stops its loop before the core disappears.
      // (dispose() is idempotent, so term.dispose()'s own addon teardown is a safe no-op after this.)
      // teardownWebgl (not a bare dispose): it also releases the GPU context — which xterm's
      // dispose() never does — and hands the concurrency permit back. A bare dispose here leaked
      // one context per closed pane, so contexts accumulated for the whole session and eventually
      // got the visible terminal's context evicted.
      teardownWebgl();
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
  // That single fit is ALSO where a resize this pane skipped while hidden gets paid (sparkle-atp1).
  // The observer does NOTHING for an off-screen pane but record the debt — not the reflow and not
  // the PTY resize, because the child's width and xterm's must never diverge for a pane that is
  // still receiving output. Both land here, together, once, for the one pane the user is actually
  // looking at — instead of N times, synchronously, for panes nobody can see.
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
      // PAY THE DEFERRED RESIZE. While this pane was hidden its ResizeObserver skipped the
      // fit/reflow and recorded the debt on `resizeDirtyRef` (see the observer above). This re-fit
      // is what settles it — it already ran unconditionally on every reveal, which is why the gate
      // could defer the work rather than needing a second mechanism to catch up. Clearing the flag
      // here is what makes "revealed" and "no longer stale" the same event.
      //
      // `deferredResize` is reported on the span because it is the field that separates the two
      // reveals that now cost different amounts: one that merely re-attaches WebGL, and one that
      // also owes a buffer reflow the resize handed forward. Without it the fix would move cost from
      // `terminal-resize` to `Terminal.revealFit` invisibly.
      const deferredResize = resizeDirtyRef.current;
      resizeDirtyRef.current = false;
      // safeFit() bails if disposed and swallows the not-laid-out / torn-down-core throw itself.
      perfSpan("Terminal.revealFit", () => safeFit(), { deferredResize });
      // Pane reveal / agent change — not the user asking, so this must NOT re-aim dictation.
      composerFocusRequest.reveal({
        onRequestFocus: onRequestFocusRef.current,
        onUserRequestFocus: onUserRequestFocusRef.current,
      });
      // Push the true size to the PTY so its wrap column matches xterm (no-op while unmeasured).
      syncPtySize(transportRef.current, term, sentPtySizeRef);
      // Defer the repaint one frame so the just-resized canvas has valid char dimensions before we
      // clear the WebGL model; otherwise the renderer bails (no valid dims) and wastes the clear.
      // disposedRef guards the deferred frame (#231/#258).
      handle = requestAnimationFrame(() => {
        if (cancelled || disposedRef.current) return;
        // TIMED, because this was the last unmeasured part of what switching agents costs. The
        // attach beside it is instrumented (`Terminal.attachWebgl`, p50 19ms in the field) but the
        // repaint that rasterizes the whole buffered scrollback into that freshly-attached, EMPTY
        // WebGL model was not — so "a switch takes ~286ms with a quiet main thread; where does it
        // go?" could not be answered from the logs at all. It matters more than the attach: this is
        // an 8000-line clearTextureAtlas + refresh, and it is paid once per REVEAL, which is once
        // per agent the pointer would cross under a hover-to-preview. See
        // PRD/sparkle/terminal-switch-latency.md for the measurement this closes the gap in.
        perfSpan("Terminal.revealRepaint", () => forceFullRepaint(webglRef.current, term));
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
        syncPtySize(transportRef.current, term, sentPtySizeRef);
      } catch {
        /* ignore transient fit errors */
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [zoom, agentId, safeFit]);

  // Re-theme the live terminal when the resolved theme (Light/Dark/Auto toggle, or an OS
  // appearance change while on Auto) or the calm state changes. xterm needs concrete hex, so it can't follow the CSS
  // var() flip the rest of the app rides on — we push a fresh theme object instead.
  useEffect(() => {
    const term = termRef.current;
    if (disposedRef.current || !term) return;
    term.options.theme = xtermTheme(resolvedTheme, calm);
    // Rides the SAME flip as the theme, and for the same two reasons: light needs the net and dark
    // does not, and CALM is a second palette with a deliberately lower floor the net must not
    // override. Leaving either at its mount value strands the live toggle with the wrong one — the
    // exact staleness this effect exists to prevent for `theme`.
    term.options.minimumContrastRatio = termMinContrastRatio(resolvedTheme, calm);
    // The WebGL renderer caches colored glyphs in a texture atlas; a bare options.theme set
    // can leave already-painted cells with stale colors until the next reflow. Clear the atlas
    // and force a full repaint so the live toggle is instantaneous like the rest of the app.
    // safeRefresh no-ops if a dispose raced in between the null check and here.
    // Broadcast: the atlas is shared process-wide, so a palette change invalidates EVERY pane's
    // per-cell model, not just this one's. Clearing only this pane left the others drawing stale
    // texture coordinates into a re-packed atlas (DEFECT #4 in terminalWebgl.ts).
    clearSharedAtlasEverywhere(webglRef.current);
    safeRefresh();
    // `calm` rides the SAME effect as the theme flip: both are "the palette changed", and both
    // need the atlas cleared. It flips on a priority change (rare) — unlike the CSS filter it
    // replaces, which re-composited the whole canvas on every frame of output.
  }, [resolvedTheme, calm, safeRefresh]);

  // What to paint over the blank xterm: a fail/exited affordance, a loading hint, or nothing once
  // output streams. Pure (see terminalOverlay.ts) so the "never a silent blank pane" rule is tested.
  const overlay = resolveTerminalOverlay(spawnFail, firstOutput, resuming);
  // The pane's own inks. `--c-forest` follows a `data-theme` flip through CSS, but the terminal's
  // ink register has no CSS variable (see terminalChrome), so these resolve in JS. That is a
  // re-render on a theme flip and MUST NOT become a remount — an unmount kills this PTY. Nothing
  // below is keyed or conditionally structured on the theme; Terminal.blueprint.test.tsx proves it.
  const ink = termInk(resolvedTheme);
  const quietInk = termMuted(resolvedTheme);

  return (
    // ph-no-capture: terminal panes render source code, command output, and
    // secrets — never include them in PostHog session replay.
    <div
      className={PH_NO_CAPTURE_CLASS}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        // THE PANE IS THE SPEC'S `term` PLANE. It was relying on an ancestor to paint it, which
        // held only as long as every ancestor agreed; declaring it here means the pane carries its
        // own register, and the overlays below are composited on the surface they were measured
        // against rather than on whatever happens to be behind them.
        background: TERM_PLANE,
        // NO BORDER ON THIS EDGE. Build and terminal are ONE thing inside a pair — the direction
        // says so in as many words ("NO divider inside a pair"), and the selected agent row bleeds
        // 9px across this boundary precisely so it reads as an opening INTO this pane. A 1px rule
        // here seals that: the row docks against the line instead of flowing through, and its
        // fillets curve into nothing. Do not add one back "for definition".
      }}
    >
      {/* DICTATION FOLLOWS FOCUS. This is the element xterm mounts into, so everything with a
          terminal caret — including xterm's hidden `.xterm-helper-textarea`, which is what actually
          holds focus — is a descendant of it. The marker is the APP-OWNED half of the match in
          voice/dictationFocus: xterm's class names are a vendor detail a major bump can rename,
          this attribute is ours. It sits on the xterm host rather than the outer pane on purpose —
          the pane also hosts the failure/loading overlays, and a "Start again" button is not a live
          PTY, so focusing it must not pause the mic. */}
      {/* …and WHICH agent that caret belongs to, so dictation can aim a spoken phrase at this
          terminal specifically. Same element as the surface marker so one `closest` from the
          focused node answers both questions — see voice/dictationFocus.focusedTerminalAgentId. */}
      <div
        ref={containerRef}
        {...{ [TERMINAL_SURFACE_ATTR]: "", [TERMINAL_AGENT_ATTR]: agentId }}
        style={{ width: "100%", height: "100%", overflow: "hidden" }}
      />
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
            color: ink,
            fontFamily: TERM_UI,
            fontSize: TERM_TYPE.body,
            zIndex: 5,
          }}
        >
          {/* Secondary by TOKEN, not by opacity. A dimmed primary ink composites to whatever the
              plane happens to be and is measured against nothing; `termMuted` is the register's
              own quiet tier. */}
          <span style={{ color: quietInk }}>{overlay.message}</span>
          <button
            onClick={retry}
            style={{
              all: "unset",
              cursor: "pointer",
              fontSize: TERM_TYPE.body,
              color: ink,
              // A rule drawn ON the terminal plane — `termHairline`, never the chrome hairline
              // (and never `muted`, which is an INK). See terminalChrome.
              border: `1px solid ${TERM_HAIRLINE}`,
              borderRadius: TERM_RADIUS.input,
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
            // The loading hint is secondary chrome: the pane's quiet ink, not a faded primary.
            color: quietInk,
            fontFamily: TERM_UI,
            fontSize: TERM_TYPE.body,
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
          borderRadius: TERM_RADIUS.modal,
          background: C.deepForest,
          color: C.cream,
          // A chip sitting on the terminal plane takes its OWN border. It carried
          // `CHAT_USER_BUBBLE` — a chrome FILL pressed into service as an edge, floored against the
          // shell's planes and not against this one.
          border: `1px solid ${TERM_HAIRLINE}`,
          fontFamily: TERM_UI,
          fontSize: TERM_TYPE.small,
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
