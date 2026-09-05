// REPAIR THE FRAME BEFORE BELIEVING WHAT IS ON IT — bead sparkle-4utugq.
//
// ══ THE TWO ARMS THIS FILE OWES, AND WHY BOTH ARE MANDATORY ═════════════════════════════════════
// The gate under test both BLOCKS and ALLOWS, so a test of one direction alone is worth nothing:
//
//   • WIDENING it (retry on any redraw, or on `redrawn` rather than `recovered`) must RED a case
//     proving a real pager is STILL refused with nothing on the wire.
//   • NARROWING it (never retry) must RED a case proving a legitimate Claude Code prompt behind a
//     wedged frame IS written to.
//
// Both are asserted on the SIDE EFFECT — the bytes that reached the PTY — never on `ok` alone. A
// refusal that mislabels a write it already made would pass an `ok: false` assertion.
//
// ══ THE SCREENS ARE REAL, NOT INVENTED ═════════════════════════════════════════════════════════
// `WEDGED_FRAME_SCREEN` is a real Claude Code 2.1.261 byte log replayed into a grid of the wrong
// size (see its own provenance note): a completed turn, an idle session, and no composer box left
// to recognise. `IDLE_AFTER_TURN_2_1_220` is a verbatim capture of what the same session looks like
// once it has repainted. `LESS_ON_A_MARKDOWN_FILE` is a verbatim capture of a genuine pager. The
// production predicates run unmocked over all three, so this suite is testing the shipping
// classifier's real answers rather than a stub's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../pty", () => ({
  writePtyChainedStrict: vi.fn(async () => {}),
  submitPrompt: vi.fn(async () => {}),
  resizePty: vi.fn(async () => {}),
  PtyGoneError: class extends Error {},
}));
vi.mock("../terminalScrollback", async (orig) => ({
  ...(await orig<typeof import("../terminalScrollback")>()),
  getAgentScrollback: vi.fn<(id: string) => string | null>(() => null),
}));
vi.mock("../trialMeter", () => ({ trialSendAllowed: () => true, recordTrialSend: vi.fn() }));
vi.mock("../history", () => ({ searchHistory: vi.fn(async () => []) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));
// THE REPAINT ITSELF. Mocked at the module, not spied on the binding: `sendToAgentTerminal`
// reaches it through a DEFAULTED PARAMETER whose value is the imported function, so replacing the
// module is what puts a stub in front of the production wiring without adding a seam to the tool
// surface that only tests would ever set.
vi.mock("../forceRedraw", () => ({ forceAgentRedraw: vi.fn() }));
// REAL BY DEFAULT — the factory wraps the shipping function so every case runs the production
// dispatcher, and the wrapper exists only so a case can COUNT the calls. How many times the
// dispatcher runs is the property that separates a preflight from a retry, and it is invisible
// from the bytes on the wire.
vi.mock("../conciergeDispatch", async (orig) => {
  const real = await orig<typeof import("../conciergeDispatch")>();
  return { ...real, dispatchConciergeAnswer: vi.fn(real.dispatchConciergeAnswer) };
});
vi.mock("../../stores/runtimeStore", () => ({
  useRuntimeStore: {
    getState: vi.fn(() => ({ attentionScreen: {}, attentionScreenAt: {}, status: {} })),
  },
  mergeOpenAgentIds: (inMemory: string[], persisted: string[]) => [
    ...new Set([...inMemory, ...persisted]),
  ],
  readPersistedOpenAgentIds: vi.fn((): string[] => []),
}));

import { submitPrompt, writePtyChainedStrict } from "../../pty";
import { useProjectStore } from "../../stores/projectStore";
import { registerViewport, resetViewportRegistry } from "../terminalViewport";
import { conciergeToolAuthority } from "../dispatchAuthority";
import { forceAgentRedraw } from "../forceRedraw";
import { dispatchConciergeAnswer } from "../conciergeDispatch";
import {
  onPromptGraceChanged,
  resetPromptGraceLedgerForTests,
  windowPromptGraceLedger,
  type PromptAnswerOutcome,
} from "../../engine/blockedPromptGrace";
import { hasClaudeCodeLiveTui, isClaudeCodeScreen } from "../../engine/claudeCodeScreen";
import {
  APPROVAL_2_1_220,
  IDLE_AFTER_TURN_2_1_220,
  LESS_ON_A_MARKDOWN_FILE,
} from "../../engine/capturedScreens.fixture";
import { WEDGED_FRAME_SCREEN } from "../../engine/incidentScreens.fixture";
import type { RedrawOutcome } from "../forceRedraw";
import { repairUnrecognisedFrameBeforeSending, sendToAgentTerminal } from "./terminal";

const AGENT = "ag-1";
const ALLOWED = conciergeToolAuthority("call-1", { tier: "allow" })!;

function seedAgent() {
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/p1",
        agents: [{ id: AGENT, name: "Retry logic", runtime: "local" } as never],
      } as never,
    ],
  });
}

/** Mount a viewport whose text a case can swap, which is how a REPAINT is modelled: the redraw
 *  stub changes what the next read sees, exactly as a real SIGWINCH repaint would. */
function mountScreen(text: string) {
  let cur = { text, alternateBuffer: true, cols: 120, rows: 40 };
  registerViewport(AGENT, () => cur);
  return (next: Partial<typeof cur>) => {
    cur = { ...cur, ...next };
  };
}

/** Everything that reached the terminal, from EITHER write primitive. A free-text send goes out
 *  through `submitPrompt`; asserting only on `writePtyChainedStrict` would report a delivered
 *  message as "wrote nothing". */
/** A repaint that went out and left a readable pane. Shared so a case that is not ABOUT the
 *  outcome shape does not restate it. */
const OK_REDRAW = { redrawn: true, recovered: true, reason: null } as const;

const wrote = () =>
  vi.mocked(submitPrompt).mock.calls.length + vi.mocked(writePtyChainedStrict).mock.calls.length;

beforeEach(() => {
  vi.clearAllMocks();
  seedAgent();
  resetViewportRegistry();
  resetPromptGraceLedgerForTests();
});
afterEach(() => resetViewportRegistry());

// ── THE PREMISE, ASSERTED RATHER THAN ASSUMED ────────────────────────────────────────────────────
// Every case below rests on the shipping classifier answering these three ways. If Claude Code's
// TUI drifts and the wedged frame starts classifying TRUE, the arms stop testing what they claim
// to and this case says so first, at the premise, instead of leaving them green over nothing.
describe("the screens this suite rests on", () => {
  it("the wedged frame is unrecognised, the repainted one is Claude Code, the pager is neither", () => {
    expect(isClaudeCodeScreen(WEDGED_FRAME_SCREEN)).toBe(false);
    expect(isClaudeCodeScreen(IDLE_AFTER_TURN_2_1_220)).toBe(true);
    expect(isClaudeCodeScreen(LESS_ON_A_MARKDOWN_FILE)).toBe(false);
  });
});

describe("send_to_agent_terminal repairs a wedged frame before refusing", () => {
  // ── ARM 1 — NARROWING MUST RED THIS. A LEGITIMATE IDLE PROMPT IS WRITABLE. ──────────────────
  it("delivers the text once a repaint reveals an ordinary Claude Code prompt", async () => {
    const set = mountScreen(WEDGED_FRAME_SCREEN);
    // The repaint: what `forceAgentRedraw` does for real, modelled by the one observable effect it
    // has — the next viewport read returns a fully drawn frame.
    const redraw = vi.fn(async (): Promise<RedrawOutcome> => {
      set({ text: IDLE_AFTER_TURN_2_1_220 });
      return { redrawn: true, recovered: true, reason: null };
    });

    const first = await runSend("ship it", redraw);

    expect(first.ok).toBe(true);
    expect(first.path).not.toBe("alternate-screen");
    // THE SIDE EFFECT. `ok: true` alone would pass on a result that lied about a write it never
    // made, which is the inversion this whole bead is about.
    expect(vi.mocked(submitPrompt).mock.calls.map(([, t]) => t)).toEqual(["ship it"]);
  });

  // ── ARM 2 — WIDENING MUST RED THIS. A REAL PAGER IS STILL REFUSED, WITH NOTHING WRITTEN. ────
  it("still refuses a real pager, and writes nothing, even though it repainted it", async () => {
    mountScreen(LESS_ON_A_MARKDOWN_FILE);
    // A pager repaints beautifully and is exactly as unwritable afterwards. `redrawn: true` with
    // `recovered: false` is the shape `forceRedraw` keeps apart on purpose.
    const redraw = vi.fn(async (): Promise<RedrawOutcome> => ({
      redrawn: true,
      recovered: false,
      reason: null,
    }));

    const r = await runSend("ship it", redraw);

    expect([r.ok, r.path]).toEqual([false, "alternate-screen"]);
    expect(wrote()).toBe(0);
    // It DID try, which is what makes the refusal's own sentence true. Asserting the attempt as
    // well as the outcome is what separates "repainted and still refused" from "never looked".
    expect(redraw).toHaveBeenCalledTimes(1);
  });

  // ── THE UNIT, DRIVEN DIRECTLY: WHAT IT REPAIRS AND WHAT IT LEAVES ALONE ────────────────────
  // Four cases, each isolating ONE conjunct. Driving the exported function rather than the whole
  // send is what makes the isolation possible: through `sendToAgentTerminal` a wrong answer here
  // is masked by the dispatcher agreeing with it for its own reasons.
  it("repaints an unrecognised full-screen frame", async () => {
    const redraw = vi.fn(async (): Promise<RedrawOutcome> => OK_REDRAW);
    await repairUnrecognisedFrameBeforeSending(
      AGENT,
      false,
      { text: WEDGED_FRAME_SCREEN, alternateBuffer: true, cols: 120, rows: 40 },
      redraw,
    );
    expect(redraw).toHaveBeenCalledTimes(1);
  });

  // A LIVE CLAUDE CODE DIALOG IS A SCREEN WE DID RECOGNISE. The dispatcher routes it to
  // `blocked-prompt`, whose remedy is a human answering it; repainting changes nothing about whose
  // question it is, and would spend a PTY resize on every permission dialog in the fleet.
  it("does not repaint a live Claude Code dialog", async () => {
    const redraw = vi.fn(async (): Promise<RedrawOutcome> => OK_REDRAW);
    await repairUnrecognisedFrameBeforeSending(
      AGENT,
      false,
      { text: APPROVAL_2_1_220, alternateBuffer: true, cols: 120, rows: 40 },
      redraw,
    );
    expect(hasClaudeCodeLiveTui(APPROVAL_2_1_220), "premise: this screen shows a live TUI").toBe(true);
    expect(redraw).not.toHaveBeenCalled();
  });

  // ⚠️ NEVER REPAINT UNDER A FINGERPRINTED PRESS. The dispatcher re-derives the fingerprint from
  // the CURRENT screen, so moving the menu underneath one makes it stop matching and refuses a
  // press the caller had already read. This case is what a widening mutant reds.
  it("never repaints under a picker press, even on an unrecognised frame", async () => {
    const redraw = vi.fn(async (): Promise<RedrawOutcome> => OK_REDRAW);
    await repairUnrecognisedFrameBeforeSending(
      AGENT,
      true,
      { text: WEDGED_FRAME_SCREEN, alternateBuffer: true, cols: 120, rows: 40 },
      redraw,
    );
    expect(redraw).not.toHaveBeenCalled();
  });

  // NORMAL BUFFER, AND NO PANE AT ALL: neither is a wedged frame, and neither has anything a
  // resize could repair.
  it.each([
    ["a normal-buffer screen", { text: "$ ", alternateBuffer: false, cols: 120, rows: 40 }],
    ["an unmounted pane", null],
  ] as const)("does not repaint %s", async (_label, screen) => {
    const redraw = vi.fn(async (): Promise<RedrawOutcome> => OK_REDRAW);
    await repairUnrecognisedFrameBeforeSending(AGENT, false, screen, redraw);
    expect(redraw).not.toHaveBeenCalled();
  });

  // ── NO PROVISIONAL OUTCOME IS EVER REPORTED — THE PROPERTY, NOT A PROXY FOR IT ─────────────
  // roborev 81248 (High) against the first cut: dispatching, then repairing a refusal, then
  // re-dispatching reports the FIRST outcome to `engine/blockedPromptGrace`, where
  // `alternate-screen` maps to `unreachable`, which `isGiveUp` LATCHES for the life of the ask —
  // so the founder was surfaced a "Needs you" for a prompt the concierge answered 500ms later and
  // the successful retry could not retract it.
  //
  // ⚠️ THE FIRST ATTEMPT AT PINNING THIS WAS VACUOUS, and roborev 81252 caught it: it asserted ONE
  // `submitPrompt` call, which the OLD architecture also produced — its first dispatch returned
  // through the byte-free `alternate-screen` arm and only the retry wrote. The write count was
  // never the defect. Two things DO separate the designs, and both are asserted here:
  //
  //   • HOW MANY TIMES THE DISPATCHER RAN. One, always: a preflight has nothing to retry.
  //   • WHAT REACHED THE GRACE LEDGER, which is the defect itself. Every outcome recorded for this
  //     agent DURING the send is collected through `onPromptGraceChanged` — not just the final
  //     one, because the final one is `handled` under BOTH designs and it is the transient
  //     give-up in between that latches.
  it("reports no give-up to the grace ledger, and dispatches exactly once", async () => {
    const seen: PromptAnswerOutcome[] = [];
    const unsubscribe = onPromptGraceChanged(() => {
      const row = windowPromptGraceLedger().outcome.get(AGENT);
      if (row) seen.push(row.outcome);
    });
    const set = mountScreen(WEDGED_FRAME_SCREEN);
    try {
      await runSend("ship it", async () => {
        set({ text: IDLE_AFTER_TURN_2_1_220 });
        return OK_REDRAW;
      });
    } finally {
      unsubscribe();
    }

    expect(seen, "the send must report SOMETHING, or this case proves nothing").not.toEqual([]);
    expect(seen, "a give-up latches for the life of the ask and the later handled cannot retract it")
      .not.toContain("unreachable");
    expect(seen).not.toContain("declined");
    expect(vi.mocked(dispatchConciergeAnswer)).toHaveBeenCalledTimes(1);
  });
});

// ── THE REFUSAL'S OWN SENTENCE STOPPED ASSERTING A PAGER ───────────────────────────────────────
// PAIRED, per AGENTS.md: the negative alone is green over copy that says nothing at all, and the
// positive alone is green over copy that also still claims a pager. Both halves are needed, and the
// measured incident is why — that sentence stated as fact something the path cannot know, and which
// was false on the screen it was printed about.
describe("the alternate-screen refusal names what it actually knows", () => {
  it("does not claim a pager or an editor holds the screen, and says what it could not tell", async () => {
    mountScreen(LESS_ON_A_MARKDOWN_FILE);
    const r = await runSend("ship it", async () => ({
      redrawn: true,
      recovered: false,
      reason: null,
    }));
    expect(r.detail, "must not assert WHICH program holds the screen").not.toMatch(
      /what holds the screen there is a pager/i,
    );
    expect(r.detail, "must say it could not tell").toMatch(/can.t tell what holds the screen/i);
    expect(r.detail, "must say the frame may simply never have been drawn").toMatch(
      /never fully drawn/i,
    );
    // The receipt line splits on this separator, so a reason carrying one is unreadable.
    expect(r.detail).not.toContain(" — ");
  });
});

/** Drive the REAL exported entry point with the repaint stubbed, so these cases exercise the
 *  shipping `sendToAgentTerminal` rather than a re-implementation of it. */
async function runSend(text: string, redraw: () => Promise<RedrawOutcome>) {
  vi.mocked(forceAgentRedraw).mockImplementation(redraw);
  return sendToAgentTerminal(AGENT, text, ALLOWED);
}
