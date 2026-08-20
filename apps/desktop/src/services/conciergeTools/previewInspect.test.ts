// The PREVIEW_INSPECT domain — "agent eyes" over an already-open live preview.
//
// TWO INVARIANTS carry this file:
//
//   1. IT IS `read-only`, NOT `privacy-sensitive` LIKE `screenshot.ts`. Both ops read the agent's
//      own dev-server output, never the human's screen — see previewInspect.ts's header. The
//      assertion that matters is the one run through the REAL policy evaluator (not just the risk
//      constant), because a translation table that quietly remapped `read-only` to `ask` would
//      leave the constant intact while making every call require human approval it doesn't need.
//
//   2. A FAILED RUST CALL BECOMES A CLASSIFIED REFUSAL, not a thrown exception the caller has to
//      catch. `attempt()` sorts the Rust side's error strings into `no-preview` /
//      `preview-not-ready` / `headless-browser-missing` / `capture-failed` so a concierge reading
//      the reply can act on WHICH failure it was without string-matching the message itself.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  PREVIEW_INSPECT_OPS,
  PREVIEW_INSPECT_RISK,
  previewScreenshot,
  previewQueryDom,
  type PreviewCapture,
  type DomMatch,
} from "./previewInspect";
import { evaluateToolPolicy, NO_TOOL_POLICY_OVERRIDES } from "./policy";
import { usePreviewStore } from "../../stores/previewStore";

const invokeMock = vi.mocked(invoke);

const CAPTURE: PreviewCapture = { path: "/tmp/sparkle-captures/sparkle-preview-1.png", width: 1280, height: 800, bytes: 120_000 };
const MATCHES: DomMatch[] = [
  { tag: "button", id: "submit", className: "btn primary", text: "Save", rect: { x: 10, y: 20, width: 80, height: 32 } },
];

beforeEach(() => {
  invokeMock.mockReset();
});

// ---------------------------------------------------------------------------------------------

describe("the domain is read-only, not privacy-sensitive", () => {
  it("classifies every op read-only, and the map covers exactly the op list", () => {
    expect(Object.values(PREVIEW_INSPECT_RISK).every((r) => r === "read-only")).toBe(true);
    expect(Object.keys(PREVIEW_INSPECT_RISK).sort()).toEqual([...PREVIEW_INSPECT_OPS].sort());
  });

  // THE ASSERTION THAT MATTERS — see the header. Goes through the real evaluator, not the constant.
  it.each([...PREVIEW_INSPECT_OPS])("%s defaults to allow, through the real policy evaluator", (op) => {
    const decision = evaluateToolPolicy(op, { overrides: NO_TOOL_POLICY_OVERRIDES });
    expect(decision.decision).toBe("allow");
    expect(decision.riskClass).toBe("read-only");
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.domain).toBe("preview_inspect");
  });

  it("still lets the human turn a call off entirely", () => {
    expect(
      evaluateToolPolicy("screenshot", { overrides: { screenshot: "deny" } } as never).decision,
    ).toBe("deny");
  });
});

// ---------------------------------------------------------------------------------------------

describe("previewScreenshot", () => {
  it("invokes preview_screenshot with the agent id and returns the capture", async () => {
    invokeMock.mockResolvedValue(CAPTURE);
    const r = await previewScreenshot("agent-1");
    expect(invokeMock).toHaveBeenCalledWith("preview_screenshot", { agentId: "agent-1" });
    expect(r).toEqual({ ok: true, op: "screenshot", risk: "read-only", data: CAPTURE });
  });

  it("refuses bad-args without calling invoke when agentId is blank", async () => {
    const r = await previewScreenshot("  ");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("bad-args");
  });

  it.each([
    ["no preview is open for agent agent-1 — open one first", "no-preview"],
    ["this agent's preview is Starting, not yet serving anything to look at", "preview-not-ready"],
    ["this preview has no port yet — it may still be starting", "preview-not-ready"],
    [
      "preview eyes: no chrome-headless-shell binary — Playwright's headless Chromium isn't installed. Run `npx playwright install chromium`.",
      "headless-browser-missing",
    ],
    ["preview eyes: CDP connection error: broken pipe", "capture-failed"],
  ])("classifies the Rust error %j as reason %j", async (message, reason) => {
    invokeMock.mockRejectedValue(new Error(message));
    const r = await previewScreenshot("agent-1");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe(reason);
  });
});

describe("previewQueryDom", () => {
  it("invokes preview_query_dom with the agent id and selector, returning the matches", async () => {
    invokeMock.mockResolvedValue(MATCHES);
    const r = await previewQueryDom("agent-1", ".btn");
    expect(invokeMock).toHaveBeenCalledWith("preview_query_dom", { agentId: "agent-1", selector: ".btn" });
    expect(r).toEqual({ ok: true, op: "query_dom", risk: "read-only", data: MATCHES });
  });

  it("refuses bad-args without calling invoke when the selector is blank", async () => {
    const r = await previewQueryDom("agent-1", "   ");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("bad-args");
  });

  it("refuses bad-args without calling invoke when agentId is blank", async () => {
    const r = await previewQueryDom("", ".btn");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("bad-args");
  });

  it("surfaces a Rust in-page exception (a bad selector) as capture-failed, not a thrown error", async () => {
    invokeMock.mockRejectedValue(new Error("preview eyes: Failed to execute 'querySelectorAll'"));
    const r = await previewQueryDom("agent-1", ":::bad");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("capture-failed");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// BOTH OPS STAMP ACTIVITY — roborev 65689, and this suite could not see it
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// `previewIdleGrace` stops a dev server that has shown no sign of life for `idle_grace_min`, and
// `supervise()` in preview.rs emits nothing once a server is `Ready` — so an agent driving its own
// preview through this domain is INVISIBLE to that clock unless these ops say so. Without these
// rows the stamp could be deleted from either op and every test here stays green (this file mocks
// only `invoke` and never touches the store), which is exactly the seam-goes-dead shape the
// surrounding work exists to prevent — and how the asymmetry between the two ops got in.
describe("preview_inspect stamps activity, so an agent's own loop is not reaped under it", () => {
  const AGENT = "agent-activity";

  function seedLivePreview() {
    usePreviewStore.setState({
      byAgent: {
        [AGENT]: {
          id: "srv-1",
          agentId: AGENT,
          projectId: "p1",
          url: "http://127.0.0.1:5173",
          port: 5173,
          status: "serving",
          error: null,
          startedAt: 1_000,
          surfacedAt: 1_000,
          lastActivityAt: 1_000,
          reloadNonce: 0,
        } as never,
      },
      capability: {},
      openedProjects: {},
    });
  }

  it("screenshot stamps BEFORE the capture, so a FAILED capture still counts", async () => {
    // The ordering claim the comment makes, asserted rather than asserted-in-prose. A rejected
    // invoke is the ordinary case (no headless Chromium is a perfectly normal machine), and someone
    // asking for a picture they did not get is still someone using the preview.
    seedLivePreview();
    vi.mocked(invoke).mockRejectedValueOnce(new Error("headless browser not installed"));
    const at = 999_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      const r = await previewScreenshot(AGENT);
      expect(r.ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(usePreviewStore.getState().byAgent[AGENT]?.lastActivityAt).toBe(at);
  });

  it("query_dom stamps too — the op an inspect LOOP actually uses", async () => {
    // The asymmetry that was the bug: an agent polling for an element with query_dom produced no
    // stamp at all, so the clock reaped the server out from under it and its next call refused
    // with `no-preview`.
    seedLivePreview();
    vi.mocked(invoke).mockResolvedValueOnce([]);
    const at = 1_234_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      await previewQueryDom(AGENT, "#root");
    } finally {
      spy.mockRestore();
    }
    expect(usePreviewStore.getState().byAgent[AGENT]?.lastActivityAt).toBe(at);
  });

  it("a REFUSED call stamps nothing — a bad-args typo is not use", async () => {
    // The paired negative. Without it both rows above are satisfied by stamping unconditionally at
    // the top of the function, which would let a malformed call keep a dead preview alive.
    seedLivePreview();
    const at = 5_555_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(at);
    try {
      expect((await previewScreenshot("   ")).ok).toBe(false);
      expect((await previewQueryDom(AGENT, "  ")).ok).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(usePreviewStore.getState().byAgent[AGENT]?.lastActivityAt).toBe(1_000);
  });
});
