// APPROVE WITH NOTHING TO APPROVE — the row says "Approve?" and no dialog is renderable.
//
// The founder hit this on two agents at once: `status: "approval"`, `needsYou: true`, and
// `read_picker_options` answering `present: false, options: []`. A row that looks actionable and is
// not is the worst shape available — worse than a plain red, because the human taps it, finds
// nothing, and learns to distrust the dot.
//
// THE FAILURE ASYMMETRY, stated before any code (house rule, cf. movementRetraction.test.ts):
// a prompt we fail to recognize is an agent blocked on a human who is never told, which the
// screenClassifier header calls strictly worse than a false red. So the fix here must NOT quiet the
// row. It must keep it RED and stop it claiming there is a button to press. Under-informing is
// recoverable; a silently-dropped question is not.
//
// THE MECHANISM. Two detectors read the same screen and disagree, and each of the two symptoms is
// one of them:
//   • `screenAwaitsInput` (screenClassifier.ts) is true on ANY of three signals — the `❯ 1.`
//     selection cursor, the picker FOOTER ALONE, or a bare shell prompt like `(y/n)`. Only the
//     first implies pressable options.
//   • the option parser (heuristics.parsePickerOptions) requires >= 2 options counting DOWN to 1
//     within PICKER_SPAN lines above the footer, else it returns [].
// A footer whose option block has scrolled out of the window satisfies the first and fails the
// second. `screenClassifier.ts:44` claims the two "can never desync on what marks a picker" — true
// of the FOOTER, false of the OPTIONS, and this file is the counterexample.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusEngine } from "./statusEngine";
import { screenAwaitsInput } from "./screenClassifier";
import { detectClaudeCodePicker } from "../services/suggestions/heuristics";
import { classifyApproval } from "../services/suggestions/approvalClassifier";
import type { AgentTabStatus } from "../types";
import { FOOTER_ONLY_SCREEN } from "./incidentScreens.fixture";

// FOOTER_ONLY_SCREEN — the dialog whose option block scrolled off — lives in
// `incidentScreens.fixture.ts`, shared with the concierge terminal suite. Its provenance (a
// RECONSTRUCTION from the founder's screenshot, not a PTY capture) travels with it there; it is
// deliberately not in `capturedScreens.fixture.ts`, whose header promises every entry is a verbatim
// capture (roborev 61864).

// The control: the SAME dialog with its options still on screen. Every assertion below is paired
// against this, or the test proves nothing about the missing options specifically.
const FULL_DIALOG_SCREEN = [
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. No",
  "",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

// The same stranded footer, but with the agent's own markdown list sitting above it — the shape a
// naive "count numbered rows anywhere" gate mistakes for a menu.
const PROSE_LIST_ABOVE_FOOTER = [
  "⏺ Here is my plan:",
  "  1. Read the file",
  "  2. Patch it",
  "  3. Run the suite",
  "",
  "  Called sparkle-control 2 times",
  " Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

const RISKY = "Bash(rm -rf build/)\n"; // classifies as approval_needed → arms the risk flag

function makeEngine(getScreen: () => string) {
  const statuses: AgentTabStatus[] = [];
  const engine = new StatusEngine({ agentId: "dead-end", onStatus: (s) => statuses.push(s), getScreen });
  return { engine, last: () => statuses[statuses.length - 1] };
}

describe("the two detectors disagree — this is the dead end, characterized", () => {
  it("CONTROL: a full dialog satisfies BOTH detectors, so it is answerable", () => {
    expect(screenAwaitsInput(FULL_DIALOG_SCREEN)).toBe(true);
    expect(detectClaudeCodePicker(FULL_DIALOG_SCREEN).length).toBeGreaterThanOrEqual(2);
    expect(classifyApproval(FULL_DIALOG_SCREEN)).not.toBeNull();
  });

  it("a footer with no option block reads as awaiting input but yields NOTHING to press", () => {
    // This is the exact state behind `present: false, options: []`.
    expect(screenAwaitsInput(FOOTER_ONLY_SCREEN)).toBe(true);
    expect(detectClaudeCodePicker(FOOTER_ONLY_SCREEN)).toEqual([]);
  });

  it("and so the approvals POLICY is never consulted — classifyApproval bails before it is read", () => {
    // ROOT CAUSE A, at its source. maybeAutoApprove reads the [approvals] rule on its line 57, but
    // returns at line 51 when this is null — so `approvals.mcp = "always"` is not overridden or
    // ignored, it is never reached at all. No auto-answer can fire for a prompt in this shape.
    expect(classifyApproval(FOOTER_ONLY_SCREEN)).toBeNull();
  });
});

describe("StatusEngine — `approval` must mean there is something to approve", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("CONTROL: a risky action + a full dialog on screen really does reach `approval`", () => {
    // Without this the assertion below could pass for the wrong reason (e.g. risk never armed).
    const { engine, last } = makeEngine(() => FULL_DIALOG_SCREEN);
    engine.ingest(RISKY);
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("approval");
  });

  it("does NOT claim `approval` when the screen offers no pressable option", () => {
    // THE BUG. Same risky action, same footer, but nothing to press — so the band that means
    // "approve this destructive thing" is a lie. It must stay RED (the agent really is blocked),
    // just not in the band that promises a button.
    const { engine, last } = makeEngine(() => FOOTER_ONLY_SCREEN);
    engine.ingest(RISKY);
    vi.advanceTimersByTime(2500);
    expect(last()).not.toBe("approval");
  });

  it("stays RED when the screen offers no pressable option — it must not go quiet", () => {
    // The other half, and the one that keeps the fix honest. Dropping this to idle/gray would
    // silence a live question, which this file's header calls strictly worse than the bug.
    const { engine, last } = makeEngine(() => FOOTER_ONLY_SCREEN);
    engine.ingest(RISKY);
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("waiting");
  });

  it("does NOT let the agent's own numbered PROSE above a stranded footer pass as options", () => {
    // The first draft counted numbered rows anywhere in the snapshot, so a markdown list the agent
    // had printed earlier satisfied the gate and `approval` was claimed with nothing to press —
    // the dead end, reopened. FOOTER_ONLY_SCREEN happens to contain no digits at all, so it cannot
    // catch this on its own; this fixture is the one that can.
    const { engine, last } = makeEngine(() => PROSE_LIST_ABOVE_FOOTER);
    engine.ingest(RISKY);
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("waiting");
  });

  it("STILL says `approval` for a bare (y/n) confirmation — answerable without a menu", () => {
    // The gate must mean "pressable", not "numbered". A shell confirmation after a destructive
    // command has no menu and never will, but it is answerable by typing — and it is exactly the
    // shape the one-tap Approve relay exists for (ConciergeHost.actionsFor returns [] for any band
    // but `approval`). Demoting it would strip that relay from the riskiest prompts there are.
    const { engine, last } = makeEngine(() => "rm -rf build/\nOverwrite? (y/n)");
    engine.ingest(RISKY);
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("approval");
  });
});

// The three call sites are separately reachable, and the first draft pinned only the first — so
// deleting the gate from either of the other two left the whole suite green. One case each.
describe("StatusEngine — every call site that can claim `approval` is gated", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("LATE RE-CHECK: a dialog that paints after settle, with its options gone, is not `approval`", () => {
    let screen = "⏺ Working on it.";
    const { engine, last } = makeEngine(() => screen);
    engine.ingest(RISKY);
    vi.advanceTimersByTime(2500); // settle reads a calm screen → idle
    screen = FOOTER_ONLY_SCREEN; // the stranded footer paints late
    vi.advanceTimersByTime(25000); // past SCREEN_RECHECK_MS
    expect(last()).not.toBe("approval");
    expect(last()).toBe("waiting");
  });

  it("MID-STREAM: a footer streaming past with no cursor-marked option is not `approval`", () => {
    const { engine, last } = makeEngine(() => FOOTER_ONLY_SCREEN);
    engine.ingest(RISKY);
    engine.ingest(" Esc to cancel · Tab to amend · ctrl+e to explain\n");
    expect(last()).not.toBe("approval");
  });

  it("MID-STREAM CARRY: an existing `approval` drops once the options are gone", () => {
    // The carry branch re-asserts the band on a redraw and does NOT itself require risk, so stale
    // evidence there re-pins the dead end. Reach `approval` legitimately, then take the options away.
    let screen = FULL_DIALOG_SCREEN;
    const { engine, last } = makeEngine(() => screen);
    engine.ingest(RISKY);
    vi.advanceTimersByTime(2500);
    expect(last()).toBe("approval"); // control: really got there
    screen = FOOTER_ONLY_SCREEN; // options scroll away, viewport still "awaiting"
    engine.ingest(" Esc to cancel · Tab to amend · ctrl+e to explain\n");
    expect(last()).not.toBe("approval");
  });
});
