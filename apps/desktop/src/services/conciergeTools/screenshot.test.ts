// @vitest-environment jsdom
//
// jsdom, unlike this directory's other domain tests, because `capture_agent` reads the STAGE'S DOM
// RECT — locating that element and refusing a collapsed one is behaviour under test, not a detail.
//
// The SCREENSHOT domain (concierge PRD section L).
//
// TWO INVARIANTS carry this file, and neither is "does it call screencapture":
//
//   1. IT NEVER RETURNS A PICTURE OF THE WRONG AGENT. Panes stack at `inset: 0` and only the
//      selected one is painted, so a capture aimed at a backgrounded agent would silently return
//      the ACTIVE agent's pane. Every refusal test below therefore asserts that `invoke` was NOT
//      CALLED — a test that only checked `ok === false` would pass just as happily against an
//      implementation that took the wrong screenshot and then discarded it, which is the same bug.
//
//   2. IT IS `ask`, NOT `allow`. A capture reads the human's screen. The risk word is the only
//      thing standing between that and a silently-permitted tool, so it is pinned here AND through
//      the real policy evaluator — asserting the string alone would not notice a vocabulary
//      translation that quietly mapped it back to `allow`.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useProjectStore } from "../../stores/projectStore";
import { useUiStore } from "../../stores/uiStore";
import { TERMINAL_STAGE_DND_TARGET } from "../dndTargets";
import {
  SCREENSHOT_OPS,
  SCREENSHOT_RISK,
  captureAgent,
  captureWindow,
  paneBlocker,
  stageRect,
} from "./screenshot";
import { evaluateToolPolicy, NO_TOOL_POLICY_OVERRIDES } from "./policy";

const invokeMock = vi.mocked(invoke);

const AGENT = "agent-1";
const OTHER = "agent-2";

const CAPTURE = { path: "/tmp/sparkle-captures/x.png", width: 1600, height: 1000, bytes: 240_000, downscaled: true };

/** Two agents in one project, with `selectedAgentId` naming whichever is on screen. */
function seed(opts: { selectedAgentId?: string | null; selectedProjectId?: string | null } = {}) {
  useProjectStore.setState({
    selectedProjectId: opts.selectedProjectId === undefined ? "p1" : opts.selectedProjectId,
    projects: [
      {
        id: "p1",
        name: "sparkle",
        rootPath: "/repo",
        defaultBranch: "main",
        selectedAgentId: opts.selectedAgentId === undefined ? AGENT : opts.selectedAgentId,
        agents: [
          { id: AGENT, name: "Retry logic" } as never,
          { id: OTHER, name: "Parser" } as never,
        ],
      } as never,
    ],
  });
  useUiStore.setState({ activeSpecial: null });
}

/** Mount a stage element whose rect is `rect`. jsdom always reports a 0×0 box, so
 *  `getBoundingClientRect` is stubbed — the geometry is the thing under test, not jsdom's layout. */
function mountStage(rect = { x: 240, y: 60, width: 1160, height: 900 }): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-dnd-target", TERMINAL_STAGE_DND_TARGET);
  const box = {
    ...rect,
    top: rect.y,
    left: rect.x,
    right: rect.x + rect.width,
    bottom: rect.y + rect.height,
  } as DOMRect;
  el.getBoundingClientRect = () => box;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(CAPTURE);
  seed();
  mountStage();
});

afterEach(() => {
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------------------------

describe("the domain is privacy-gated, not read-only", () => {
  it("classifies every op privacy-sensitive, and the map covers exactly the op list", () => {
    expect(Object.values(SCREENSHOT_RISK).every((r) => r === "privacy-sensitive")).toBe(true);
    expect(Object.keys(SCREENSHOT_RISK).sort()).toEqual([...SCREENSHOT_OPS].sort());
  });

  // THE ASSERTION THAT MATTERS. The risk word is only useful if the policy layer turns it into
  // `ask` — a translation table that mapped `privacy-sensitive` back onto `read-only` would leave
  // the word above intact while making the tool silently permitted. So this goes through the real
  // evaluator rather than re-stating the constant.
  it.each([...SCREENSHOT_OPS])("%s defaults to ask, through the real policy evaluator", (op) => {
    const decision = evaluateToolPolicy(op, { overrides: NO_TOOL_POLICY_OVERRIDES });
    expect(decision.decision).toBe("ask");
    expect(decision.riskClass).toBe("privacy-sensitive");
    expect(decision.requiresConfirmation).toBe(true);
    expect(decision.domain).toBe("screenshot");
  });

  it("still lets the human turn a capture off entirely", () => {
    expect(
      evaluateToolPolicy("capture_window", { overrides: { capture_window: "deny" } }).decision,
    ).toBe("deny");
  });
});

// ---------------------------------------------------------------------------------------------

describe("capture_window", () => {
  it("captures the window and reports the file rather than the pixels", async () => {
    const r = await captureWindow();

    expect(invokeMock).toHaveBeenCalledWith("capture_main_window");
    expect(r).toEqual({ ok: true, op: "capture_window", risk: "privacy-sensitive", data: CAPTURE });
  });

  // The whole point of the path-not-payload decision: nothing in a reply may carry image bytes.
  it("returns no image data — only a path and measurements", async () => {
    const r = await captureWindow();
    if (!r.ok) throw new Error("expected a capture");

    expect(r.data.path).toBe(CAPTURE.path);
    expect(JSON.stringify(r.data)).not.toMatch(/base64|data:image/);
    expect(Object.keys(r.data).sort()).toEqual(
      ["bytes", "downscaled", "height", "path", "width"],
    );
  });

  it("takes no target — there is nothing for a caller to aim somewhere else", async () => {
    await captureWindow();
    // A second argument would be a rect, and a rect is what window_screenshot.rs's clamp exists to
    // refuse from a caller.
    expect(invokeMock.mock.calls[0]).toEqual(["capture_main_window"]);
  });

  it("refuses, without capturing, when the window is minimised or covered", async () => {
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      const r = await captureWindow();

      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe("window-hidden");
      // Capturing anyway would photograph whatever app is in front — a wrong answer AND a leak.
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("reports a missing Screen Recording grant as the permission problem it is", async () => {
    invokeMock.mockRejectedValue(
      new Error("screencapture produced no file — Sparkle most likely lacks the macOS Screen Recording permission"),
    );

    const r = await captureWindow();

    expect(r.ok).toBe(false);
    // Distinguished from a transient failure because the remedy is a System Settings toggle the
    // concierge cannot perform and must therefore ask the human for.
    expect(r.ok === false && r.reason).toBe("screen-recording-permission");
    expect(r.ok === false && r.message).toMatch(/System Settings/);
  });

  it("reports any other capture failure without pretending it succeeded", async () => {
    invokeMock.mockRejectedValue(new Error("screencapture exited with 1"));

    const r = await captureWindow();

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("capture-failed");
    expect(r.ok === false && r.message).toMatch(/exited with 1/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("capture_agent captures the agent it was asked for, or nothing", () => {
  it("captures the stage when the named agent is the one on screen", async () => {
    const r = await captureAgent(AGENT);

    expect(r).toEqual({ ok: true, op: "capture_agent", risk: "privacy-sensitive", data: CAPTURE });
    // The rect goes over in VIEWPORT coordinates, exactly as the DOM reported it — every screen
    // conversion and the clamp happen in Rust (window_screenshot.rs), so nothing here has to be right
    // about where the window is.
    expect(invokeMock).toHaveBeenCalledWith("capture_main_window_region", {
      rect: { x: 240, y: 60, width: 1160, height: 900 },
    });
  });

  it("sends the stage's actual geometry, not a hardcoded box", async () => {
    document.body.innerHTML = "";
    mountStage({ x: 12, y: 34, width: 500, height: 400 });

    await captureAgent(AGENT);

    expect(invokeMock).toHaveBeenCalledWith("capture_main_window_region", {
      rect: { x: 12, y: 34, width: 500, height: 400 },
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // THE CENTRAL PROPERTY. Each of these would otherwise return a picture of a DIFFERENT agent,
  // labelled as the one asked for. `invoke` not being called is the assertion — `ok: false` alone
  // would also hold for an implementation that captured first and threw the result away.
  // ─────────────────────────────────────────────────────────────────────────────────────────────

  it("refuses, WITHOUT capturing, when another agent is the one on screen", async () => {
    seed({ selectedAgentId: OTHER });

    const r = await captureAgent(AGENT);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("another-agent-showing");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses, WITHOUT capturing, when the agent's project is not the one on screen", async () => {
    seed({ selectedProjectId: "p-other" });

    const r = await captureAgent(AGENT);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("project-not-selected");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses, WITHOUT capturing, when a full-stage view covers the panes", async () => {
    useUiStore.setState({ activeSpecial: "board" });

    const r = await captureAgent(AGENT);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("special-view-showing");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses, WITHOUT capturing, for an agent no project holds", async () => {
    const r = await captureAgent("ghost");

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("unknown-agent");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses a blank agent id before touching the store", async () => {
    const r = await captureAgent("   ");

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("bad-args");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses, WITHOUT capturing, when the pane has not rendered", async () => {
    document.body.innerHTML = "";

    const r = await captureAgent(AGENT);

    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe("pane-not-rendered");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("refuses, WITHOUT capturing, when the window is hidden", async () => {
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      const r = await captureAgent(AGENT);

      expect(r.ok).toBe(false);
      expect(r.ok === false && r.reason).toBe("window-hidden");
      expect(invokeMock).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // Each blocker names a DIFFERENT remedy, which is the reason they are distinguished at all: a
  // concierge told "select the project" can fix it in one call, where a generic "not visible" would
  // leave it guessing. The remedies must also be safe — each names a visible, reversible navigation
  // and never a way to bypass the check.
  it("names a remedy the concierge can actually perform, per blocker", async () => {
    seed({ selectedAgentId: OTHER });
    const other = await captureAgent(AGENT);
    expect(other.ok === false && other.message).toMatch(/select it first/i);

    seed({ selectedProjectId: "p-other" });
    const project = await captureAgent(AGENT);
    expect(project.ok === false && project.message).toMatch(/workspace\.select_project/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("paneBlocker — the visibility rule, in isolation", () => {
  it("clears only when the agent is the painted one in the selected project", () => {
    expect(paneBlocker(AGENT)).toBeNull();
  });

  it("distinguishes the three ways an agent can be off screen", () => {
    seed({ selectedAgentId: OTHER });
    expect(paneBlocker(AGENT)).toEqual({ kind: "another-agent-showing" });

    seed({ selectedProjectId: "p-other" });
    expect(paneBlocker(AGENT)).toEqual({ kind: "project-not-selected", projectName: "sparkle" });

    seed();
    useUiStore.setState({ activeSpecial: "sparkle" });
    expect(paneBlocker(AGENT)).toEqual({ kind: "special-view-showing", special: "sparkle" });
  });

  it("reports an unheld id as unknown rather than as merely hidden", () => {
    expect(paneBlocker("ghost")).toEqual({ kind: "unknown-agent" });
  });

  // A project with NO agent selected paints no pane at all, so the answer must not be "yes, go
  // ahead" just because nothing contradicts the id.
  it("refuses when the project has no agent selected", () => {
    seed({ selectedAgentId: null });
    expect(paneBlocker(AGENT)).toEqual({ kind: "another-agent-showing" });
  });
});

describe("stageRect", () => {
  it("finds the stage by the marker the drag-and-drop hit-testing already uses", () => {
    expect(stageRect()).toEqual({ x: 240, y: 60, width: 1160, height: 900 });
  });

  it("is null when no stage is mounted", () => {
    document.body.innerHTML = "";
    expect(stageRect()).toBeNull();
  });

  // A collapsed stage is the thin-terminal bug's signature (paneVisibility.ts). Capturing a 2px
  // sliver and calling it a screenshot would hide exactly the failure someone is asking about.
  it("is null for a stage too small to be a real pane", () => {
    document.body.innerHTML = "";
    mountStage({ x: 0, y: 0, width: 4, height: 900 });
    expect(stageRect()).toBeNull();
  });

  it("accepts a stage exactly at the minimum edge", () => {
    document.body.innerHTML = "";
    mountStage({ x: 0, y: 0, width: 8, height: 8 });
    expect(stageRect()).toEqual({ x: 0, y: 0, width: 8, height: 8 });
  });
});
