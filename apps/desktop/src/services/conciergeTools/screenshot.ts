// The SCREENSHOT domain — "show me what this actually looks like" (concierge PRD section L).
//
// Every other domain answers in text. That is usually better — `list_changed_files` beats a picture
// of a diff — but there is a class of question text cannot answer at all: is the layout broken, is
// the pane blank, did the dialog render off-screen, what is the agent's terminal ACTUALLY showing
// right now including the parts no scrollback read reports. `read_agent_terminal` returns the PTY's
// text; it cannot tell you the pane is 11 columns wide, which is a bug this repo has shipped more
// than once (see paneVisibility.ts). A screenshot is the only tool here that observes the RENDER.
//
// ---------------------------------------------------------------------------------------------
// WHERE THE BYTES GO: A PATH, NOT A PAYLOAD. The Rust side writes a PNG to `<temp>/sparkle-captures`
// and this returns `{ path, width, height, bytes, downscaled }`. The image itself never crosses the
// tool envelope, and that is the module's most consequential decision.
//
// A reply here lands in an LLM context window and is metered on the way in. A retina main window is
// ~3200×2000; as PNG that is commonly 5–15 MB, and base64 adds a third again. Returning it inline
// would spend a large slice of a context window — and real money — on EVERY call, including the many
// where the concierge only wanted to know whether the window was showing a login screen. A path
// costs ~80 bytes and the reader opens the file only if it genuinely needs to look; the Claude Code
// CLI reads image paths natively, so nothing is lost. `screenshot.ts` at the src root (the human's
// crosshair picker) does return a data URL, because a UI thumbnail has to have the pixels — that is
// a different caller with a different budget, not a precedent for this one.
//
// THE SIZE CAP IS THE RUST SIDE'S, NOT THE CALLER'S. Captures are downscaled to a 1600px long edge
// and refused outright above a hard byte ceiling. There is deliberately no argument to raise either:
// a model cannot ask for a bigger screenshot than the module is willing to produce.
//
// ---------------------------------------------------------------------------------------------
// WHY THIS IS `ask` AND NOT `allow` — the whole domain, both ops, by default.
//
// This is the one domain that reads the HUMAN'S SCREEN rather than the app's own data. Everything
// else here reads things Sparkle owns: a git tree, a bead, a PTY buffer. A capture reads whatever
// is being displayed, and macOS's `screencapture -R` photographs a screen REGION, not a window
// buffer — so anything drawn over Sparkle at that moment is in the file too: a notification banner
// with a message preview, a password manager's autofill popover, a video call. It then leaves that
// on disk, and hands its path to a model.
//
// None of that is a "write" in the sense the other domains mean, so classifying it `read-only`
// would be defensible on the letter and badly wrong in effect — `read-only` derives to `allow`, and
// the concierge would be silently photographing the user's screen whenever it felt like looking.
// The risk vocabulary gained a `privacy-sensitive` class for exactly this (see policy.ts): it
// changes nothing, and it still requires the human to say yes.
//
// ---------------------------------------------------------------------------------------------
// THE CORRECTNESS PROBLEM `capture_agent` HAS TO SOLVE, and it is not obvious.
//
// Agent panes are `position: absolute; inset: 0` and STACK on one another; the inactive ones hide
// with `visibility: hidden`, never `display: none` (paneVisibility.ts explains why — a collapsed box
// cannot be measured, which is the thin-terminal bug). So every agent's pane occupies THE SAME
// SCREEN RECT, and only one of them is painted.
//
// A capture of "agent X's pane rect" is therefore a picture of whichever agent is ACTIVE, whatever
// X is. Photographing that and labelling it X would be a confident, plausible lie — the worst kind
// of wrong answer, because nothing downstream can detect it. So this module refuses unless X is
// genuinely the agent on screen, and says how to make it so. It does NOT select the agent itself:
// moving the human's window out from under them to satisfy a read is a side effect a read has no
// business having, and it would make a refusal-free path that silently rearranges the UI.
import { invoke } from "@tauri-apps/api/core";

import { useProjectStore } from "../../stores/projectStore";
import { useUiStore } from "../../stores/uiStore";
import { TERMINAL_STAGE_DND_TARGET } from "../dndTargets";

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

export const SCREENSHOT_OPS = ["capture_window", "capture_agent"] as const;

export type ScreenshotOp = (typeof SCREENSHOT_OPS)[number];

/** This domain's own risk word. One value, because both ops read the same thing — the screen. */
export type ScreenshotRisk = "privacy-sensitive";

/**
 * EXHAUSTIVE by construction — a `Record<ScreenshotOp, …>`, so an op added to `SCREENSHOT_OPS`
 * without a classification fails `tsc` rather than defaulting to something permissive.
 *
 * Both ops are `privacy-sensitive`, which derives to `ask`. See the header for why `read-only` —
 * true on the letter, since a capture changes nothing — is the wrong classification: it derives to
 * `allow`, and "the concierge may photograph my screen without asking" is not a default anyone
 * should acquire by accident.
 */
export const SCREENSHOT_RISK: Record<ScreenshotOp, ScreenshotRisk> = {
  capture_window: "privacy-sensitive",
  capture_agent: "privacy-sensitive",
};

// ---------------------------------------------------------------------------------------------
// Results — the board/diff convention
// ---------------------------------------------------------------------------------------------

export interface ScreenshotOk<T> {
  ok: true;
  op: ScreenshotOp;
  risk: ScreenshotRisk;
  data: T;
}

export interface ScreenshotRefusal {
  ok: false;
  op: ScreenshotOp;
  risk: ScreenshotRisk;
  reason: string;
  message: string;
}

export type ScreenshotResult<T> = ScreenshotOk<T> | ScreenshotRefusal;

function ok<T>(op: ScreenshotOp, data: T): ScreenshotOk<T> {
  return { ok: true, op, risk: SCREENSHOT_RISK[op], data };
}

function refuse(op: ScreenshotOp, reason: string, message: string): ScreenshotRefusal {
  return { ok: false, op, risk: SCREENSHOT_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// Wire shapes (mirrors of the Rust structs)
// ---------------------------------------------------------------------------------------------

/** What a capture produced. Measurements plus a path — never the pixels. See the header. */
export interface Capture {
  /** Absolute path to the PNG. */
  path: string;
  /** Dimensions of the FILE, after any downscale — not of the region requested. */
  width: number;
  height: number;
  bytes: number;
  /** True when the 1600px cap bit. Part of the answer: it tells the reader the image is not at
   *  native resolution, before they conclude from a soft screenshot that the UI renders blurrily. */
  downscaled: boolean;
}

/** A viewport-relative rect, in CSS pixels, exactly as `getBoundingClientRect` reports it. The Rust
 *  side owns every coordinate conversion from here — see window_screenshot.rs's `viewport_to_screen`. */
interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Anything smaller than this is a layout bug in the caller, not a screenshot worth taking. Mirrors
 *  `CAPTURE_MIN_EDGE` in window_screenshot.rs; the Rust side re-checks, so this is the early, better
 *  message rather than the guard. */
const MIN_CAPTURE_EDGE = 8;

// ---------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------

/**
 * Is Sparkle's window actually on screen right now?
 *
 * `screencapture -R` photographs a screen REGION. When the window is minimised or fully occluded,
 * that region still exists — it just contains someone else's app. Capturing anyway would return a
 * picture of whatever the human happens to have in front, presented as a picture of Sparkle: both a
 * wrong answer and a privacy leak, which is a strictly worse outcome than a refusal.
 *
 * `visibilityState` is a best-effort signal (WKWebView reports `hidden` for a minimised window, and
 * commonly for a fully-occluded one). It is a guard, not a proof — the header's occlusion caveat
 * still stands for the partially-covered case.
 */
function windowIsVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function notVisible(op: ScreenshotOp): ScreenshotRefusal {
  return refuse(
    op,
    "window-hidden",
    "Sparkle's window is minimised or covered, so a screenshot would photograph whatever is in " +
      "front of it rather than the app. Bring Sparkle forward and ask again.",
  );
}

// ---------------------------------------------------------------------------------------------
// Locating the agent's pane
// ---------------------------------------------------------------------------------------------

/** Why a named agent's pane cannot be photographed, or null when it can. Split out from the capture
 *  so the whole rule is one pure, exhaustively-testable function over store state. */
export type PaneBlocker =
  /** No project holds this id. */
  | { kind: "unknown-agent" }
  /** The agent exists, but its project is not the one on screen. */
  | { kind: "project-not-selected"; projectName: string }
  /** The project is on screen, but a different one of its agents is. */
  | { kind: "another-agent-showing" }
  /** A full-stage view (Improve Sparkle, the board) is covering the panes. */
  | { kind: "special-view-showing"; special: string };

/**
 * Decide whether `agentId` is the agent currently PAINTED in the terminal stage.
 *
 * Three ways to fail, and they are deliberately distinguished rather than collapsed into one "not
 * visible": each has a different remedy, and a concierge that is told which one applies can fix it
 * in a single follow-up call instead of guessing. Reads the stores only — pure with respect to the
 * DOM, so the rule is testable without rendering the app.
 */
export function paneBlocker(agentId: string): PaneBlocker | null {
  const state = useProjectStore.getState();
  const project = state.projects.find((p) => p.agents?.some((a) => a.id === agentId));
  if (!project) return { kind: "unknown-agent" };
  if (state.selectedProjectId !== project.id) {
    return { kind: "project-not-selected", projectName: project.name ?? "that project" };
  }
  // A special view (Improve Sparkle, the board) is stacked over the same stage, so the panes are
  // there but nothing of the agent is painted.
  const special = useUiStore.getState().activeSpecial;
  if (special) return { kind: "special-view-showing", special };
  if (project.selectedAgentId !== agentId) return { kind: "another-agent-showing" };
  return null;
}

/** The refusal each blocker produces. The remedy named is always one the concierge can perform and
 *  that is safe to perform — selecting a project or an agent is a visible, reversible navigation. */
function blockerRefusal(agentId: string, blocker: PaneBlocker): ScreenshotRefusal {
  switch (blocker.kind) {
    case "unknown-agent":
      return refuse(
        "capture_agent",
        "unknown-agent",
        `I don't have an agent with id ${agentId} in any open project — it may already be closed.`,
      );
    case "project-not-selected":
      return refuse(
        "capture_agent",
        "project-not-selected",
        `That agent is in ${blocker.projectName}, which isn't the project on screen. Every agent's ` +
          `pane sits in the same place, so a screenshot now would show a different project's agent. ` +
          `Switch to that project first (workspace.select_project), then ask again.`,
      );
    case "special-view-showing":
      return refuse(
        "capture_agent",
        "special-view-showing",
        `The ${blocker.special} view is covering the agent panes, so there is nothing of that agent ` +
          `on screen to photograph. Open the agent first, then ask again.`,
      );
    case "another-agent-showing":
      return refuse(
        "capture_agent",
        "another-agent-showing",
        "That agent isn't the one on screen. Agent panes are stacked in one place and only the " +
          "selected one is painted, so a screenshot now would show a DIFFERENT agent — I won't hand " +
          "you that labelled as this one. Select it first (workspace.open_project_tab with its " +
          "agentId), then ask again.",
      );
  }
}

/**
 * The terminal stage's rect, in viewport CSS pixels.
 *
 * The stage is the `position: relative` container every pane is absolutely inset into, so its rect
 * IS the active pane's rect — there is no need for a per-agent DOM hook, and adding one would be a
 * second source of truth for the same geometry. It is found by the marker the drag-and-drop
 * hit-testing already relies on (`services/dndTargets`), so this module introduces no new attribute
 * that a refactor could quietly drop without anything failing.
 */
export function stageRect(): ViewportRect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector(`[data-dnd-target="${TERMINAL_STAGE_DND_TARGET}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!(r.width >= MIN_CAPTURE_EDGE) || !(r.height >= MIN_CAPTURE_EDGE)) return null;
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

async function attempt<T>(
  op: ScreenshotOp,
  run: () => Promise<T>,
): Promise<ScreenshotResult<T>> {
  try {
    return ok(op, await run());
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // The permission case gets its own reason because its remedy is a System Settings toggle the
    // concierge cannot perform and must therefore ASK THE HUMAN for — quite different from a
    // transient failure it should just retry or report.
    if (message.includes("Screen Recording")) {
      return refuse(
        op,
        "screen-recording-permission",
        "macOS hasn't granted Sparkle permission to record the screen, so I can't take a " +
          "screenshot. You can turn it on in System Settings → Privacy & Security → Screen " +
          "Recording, then ask again.",
      );
    }
    return refuse(op, "capture-failed", message);
  }
}

// ---------------------------------------------------------------------------------------------
// The ops
// ---------------------------------------------------------------------------------------------

/**
 * Photograph the whole main window.
 *
 * No arguments and no target: the window is whatever and wherever it is, and the Rust side reads its
 * own geometry rather than accepting a rect. There is nothing here a caller could aim somewhere else.
 */
export async function captureWindow(): Promise<ScreenshotResult<Capture>> {
  if (!windowIsVisible()) return notVisible("capture_window");
  return attempt("capture_window", () => invoke<Capture>("capture_main_window"));
}

/**
 * Photograph one agent's pane.
 *
 * Refuses unless that agent is the one actually painted — see the header. The rect handed to Rust is
 * the stage's, in viewport coordinates, and is clamped there to the window's own content area, so
 * even a wrong rect can only ever photograph part of Sparkle.
 */
export async function captureAgent(agentId: string): Promise<ScreenshotResult<Capture>> {
  if (!agentId?.trim()) {
    return refuse(
      "capture_agent",
      "bad-args",
      "Which agent? Pass the `agentId` of the agent whose pane you want.",
    );
  }
  const blocker = paneBlocker(agentId);
  if (blocker) return blockerRefusal(agentId, blocker);
  if (!windowIsVisible()) return notVisible("capture_agent");

  const rect = stageRect();
  if (!rect) {
    return refuse(
      "capture_agent",
      "pane-not-rendered",
      "I can't find that agent's pane on screen — it may not have finished rendering. Try again in " +
        "a moment.",
    );
  }
  return attempt("capture_agent", () => invoke<Capture>("capture_main_window_region", { rect }));
}

// NO DESCRIPTOR ARRAY HERE, for the reason diff.ts states: the registry derives this domain's ops
// and write flags from `SCREENSHOT_OPS` and `SCREENSHOT_RISK`, so a local descriptor list would have
// no consumer, and the prose a model actually reads before calling is the `sparkle_screenshot`
// description in mcp-control's server.ts. A second, unread copy is how those two drift apart.
