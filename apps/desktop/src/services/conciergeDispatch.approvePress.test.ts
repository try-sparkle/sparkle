// THE BLOCKED ROW'S "APPROVE" BUTTON, PRESSED ON AN AGENT THAT IS SHOWING A PICKER
// (bead sparkle-voudj7).
//
// ══ THE BUG ═════════════════════════════════════════════════════════════════════════════════════
// The founder pressed Approve EIGHT times in a row on one agent and got the same refusal every
// time: "…is in a full-screen app right now, so I didn't send the approval — anything typed there
// would run as commands. Quit it and approve again."
//
// The "full-screen app" was that agent's OWN Claude Code picker. There was nothing of his to quit,
// and quitting it would have discarded the very question he was being asked to approve — so the
// refusal was not merely wrong, its remedy was unfollowable, which is why eight presses produced
// eight identical dead ends rather than one diagnosis.
//
// TWO INDEPENDENT DEFECTS, and either alone keeps the button dead — which is why this file asserts
// both ends rather than just the verdict:
//
//   1. IT TYPED INSTEAD OF PRESSING. `ConciergeHost`'s relay sent the word "approve" as ordinary
//      text with no `pickerPress`, so the alternate-screen guard refused it. `sparkle-jk8zt` had
//      already built the fingerprinted-press exemption for the model-facing tool; the button never
//      acquired it. The decisive field evidence was that `select_picker_option` SUCCEEDED on the
//      same agent in the same instant that `send_to_agent_terminal` was refused `alternate-screen`.
//
//   2. THE WORD "approve" MATCHED NO OPTION ANYWAY. `detectClaudeCodePicker` labels every option
//      with its own ordinal — "1 · Yes" — and `isAffirmative` tested `^yes\b` against the whole
//      label, so it could not fire on the most common picker in the app. Every unit fixture that
//      "proved" the yes-family arm worked was hand-built as `{ label: "Yes" }`, a shape production
//      cannot emit. So even past the guard, the press would have fallen through to
//      `ambiguous-picker`.
//
// ══ WHY THE REAL DETECTOR AND REAL CAPTURED SCREENS ═════════════════════════════════════════════
// Defect 2 was invisible for exactly as long as the fixtures were hand-built. A mocked
// `detectTerminalPrompts` here would reproduce that blindness precisely, so heuristics is NOT
// mocked and the screens are the captured 2.1.220 dialogs. Only the PTY and the two screen readers
// are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return {
    writePtyChainedStrict: vi.fn(async () => {}),
    submitPrompt: vi.fn(async () => {}),
    PtyGoneError,
  };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "") }));
vi.mock("./terminalViewport", () => ({ getAgentViewport: vi.fn(() => null) }));

import { submitPrompt, writePtyChainedStrict } from "../pty";
import { getAgentScrollback } from "./terminalScrollback";
import { getAgentViewport } from "./terminalViewport";
import { dispatchConciergeAnswer, liveOptionsFor, pickerPressFor } from "./conciergeDispatch";
import { APPROVAL_2_1_220, ASK_USER_QUESTION_2_1_220 } from "../engine/capturedScreens.fixture";
import { refusalCopy, refusedPath } from "../components/Concierge/refusalCopy";

const AGENT = "agent-1";

/** Exactly what `ConciergeHost`'s Approve relay passes — the same authority, the same literal text,
 *  and `pickerPress` derived the same way. A test that hand-rolled a different shape here would not
 *  be testing the button. */
const NUDGE_APPROVE = {
  authority: { kind: "nudge-approve", agentId: AGENT } as const,
  userPrompt: false,
};

/** Put a captured dialog on screen, on the ALTERNATE buffer — the state every one of the eight
 *  refusals happened in. A Claude Code dialog owns the alternate screen; that is not the bug. */
function showing(screen: string): void {
  vi.mocked(getAgentScrollback).mockReturnValue(screen);
  vi.mocked(getAgentViewport).mockReturnValue({ text: screen, alternateBuffer: true });
}

function ptyWrites(): string[] {
  return [
    ...vi.mocked(writePtyChainedStrict).mock.calls.map((c) => String(c[1])),
    ...vi.mocked(submitPrompt).mock.calls.map((c) => String(c[1])),
  ];
}

/** The Approve button's own call, verbatim: derive the press evidence, then dispatch with it. */
function pressApprove() {
  return dispatchConciergeAnswer(AGENT, "approve", {
    ...NUDGE_APPROVE,
    pickerPress: pickerPressFor(AGENT, "approve"),
  });
}

beforeEach(() => {
  vi.mocked(getAgentViewport).mockReturnValue(null);
  vi.mocked(getAgentScrollback).mockReturnValue("");
});
afterEach(() => {
  vi.clearAllMocks();
});

// ══ THE TRAP, PINNED ════════════════════════════════════════════════════════════════════════════
// Both defects are stated as properties of the REAL screens rather than assumed. If either of these
// drifts, every row below would still pass while guarding nothing.
describe("the trap", () => {
  it("a permission dialog's options carry the detector's ordinal, not a bare 'Yes'", () => {
    showing(APPROVAL_2_1_220);
    expect(liveOptionsFor(AGENT).map((o) => o.label)).toEqual(["1 · Yes", "2 · No"]);
  });

  it("the old call shape — no pickerPress — is refused on that very screen", async () => {
    showing(APPROVAL_2_1_220);
    const r = await dispatchConciergeAnswer(AGENT, "approve", NUDGE_APPROVE);
    expect(r.ok).toBe(false);
    expect(ptyWrites()).toEqual([]);
  });
});

describe("Approve PRESSES the option instead of typing at it", () => {
  it("answers a live permission dialog on the alternate screen", async () => {
    showing(APPROVAL_2_1_220);

    const r = await pressApprove();

    expect(r.ok).toBe(true);
    expect(r.path).toBe("picker-option");
    // THE SIDE EFFECT, not the verdict. An ok:true that wrote nothing is the same outage the
    // founder saw, and `path` alone cannot tell those apart. The press is the option's OWN value —
    // the keystroke his click would have produced — never the word "approve".
    expect(ptyWrites()).toEqual(["1\r"]);
  });

  it("presses the NARROW yes, never 'Yes, and don't ask again'", async () => {
    // The captured 2.1.220 dialog offers a plain Yes/No pair; a Bash-command dialog offers three,
    // where option 2 grants STANDING permission for every later invocation. One click on Approve
    // must never be able to spend that, whatever order Claude Code lists them in.
    const THREE_WAY = [
      "Bash command",
      "  rm -rf build/",
      "",
      "Do you want to proceed?",
      "  1. Yes, and don't ask again",
      "❯ 2. Yes",
      "  3. No, and tell Claude what to do",
      "",
      "Esc to cancel · Tab to amend · ctrl+e to explain",
    ].join("\n");
    showing(THREE_WAY);

    const r = await pressApprove();

    expect(r.ok).toBe(true);
    expect(ptyWrites()).toEqual(["2\r"]);
  });

  it("refuses itself if the menu MOVED between reading it and pressing", async () => {
    // The evidence is a fingerprint, never a flag: the relay reads the screen, then the dispatcher
    // re-derives and compares. Approve rides the same FIFO as every other PTY write, so this gap is
    // real time, and a menu that changed inside it must not be pressed on the old menu's reasoning.
    showing(APPROVAL_2_1_220);
    const stale = pickerPressFor(AGENT, "approve");
    expect(stale).toBeDefined();

    showing(ASK_USER_QUESTION_2_1_220); // a different question is up now
    const r = await dispatchConciergeAnswer(AGENT, "approve", {
      ...NUDGE_APPROVE,
      pickerPress: stale,
    });

    expect(r.ok).toBe(false);
    expect(ptyWrites()).toEqual([]);
  });
});

// ══ THE REFUSAL THAT REMAINS MUST BE FOLLOWABLE ═════════════════════════════════════════════════
// An interview picker ("Red / Blue / Type something…") has no affirmative option, so there is
// genuinely nothing for a plain Approve to press and a refusal is correct. What must never happen
// again is the refusal telling the founder to QUIT the picker: it is the agent's own question, he
// has nothing to quit, and quitting it would discard the thing he was answering.
describe("an unanswerable picker refuses followably", () => {
  it("does not claim a readable menu is a full-screen app to quit", async () => {
    showing(ASK_USER_QUESTION_2_1_220);
    // The premise: this screen really does show a menu, and "approve" really does map to none of it
    // (its options are "Red" / "Blue" / "Type something." — there is no affirmative to press).
    expect(liveOptionsFor(AGENT).length).toBeGreaterThan(0);
    expect(pickerPressFor(AGENT, "approve")).toBeUndefined();

    const r = await pressApprove();

    expect(r.ok).toBe(false);
    expect(ptyWrites()).toEqual([]);
    expect(r.path).not.toBe("alternate-screen");

    // ASSERT THE COPY, NOT THE PATH NAME. The founder never sees a path; he sees a sentence, and
    // the sentence is what failed him — eight presses, each answered with an instruction he could
    // not carry out. A path assertion would go green on a rename while the sentence stayed wrong.
    const said = refusalCopy(refusedPath(r), { id: AGENT, name: "Agent" }, "approval");
    for (const voice of [said.md, said.spoken]) {
      expect(voice).not.toMatch(/quit/i);
      // …and it still has to name an exit, or it is a dead end of a different shape.
      expect(voice).toMatch(/open|answer|pick|choose/i);
    }
  });
});

// ══ THE HALF THAT MUST NOT MOVE ═════════════════════════════════════════════════════════════════
// The alternate-screen guard exists because typed text in a real pager RUNS AS COMMANDS. Nothing
// above weakens that: a pager has no menu, so it yields no options and no fingerprint.
describe("a real full-screen app is still refused, and still says so", () => {
  it("refuses Approve in a pager, where there is no menu to press", async () => {
    showing("~\n~\n~");
    expect(pickerPressFor(AGENT, "approve")).toBeUndefined();

    const r = await pressApprove();

    expect(r.ok).toBe(false);
    // HERE the "quit it" advice is followable — there really is an app, and it really is his to
    // quit — so this is the one screen that keeps the copy the founder was wrongly shown.
    expect(r.path).toBe("alternate-screen");
    expect(ptyWrites()).toEqual([]);
  });

  it("still refuses prose on the screen a press is allowed through", async () => {
    showing(APPROVAL_2_1_220);

    const r = await dispatchConciergeAnswer(AGENT, "rebase onto main please", NUDGE_APPROVE);

    expect(r.ok).toBe(false);
    expect(ptyWrites()).toEqual([]);
  });
});
