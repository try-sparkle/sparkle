// THE SCREEN GUARD AT THE CHOKEPOINT — nothing may be written into a full-screen app.
//
// `vim`, `less`, `htop` and friends run on the alternate screen buffer, where pasted text is read as
// COMMANDS rather than as input. Two separate callers had built this guard for themselves (dictation,
// then the concierge composer) and each new caller arrived unguarded, so it now lives in
// `dispatchConciergeAnswer` — the one function every text→PTY path in the app goes through.
//
// WHAT THESE TESTS ASSERT IS THE SIDE EFFECT, NOT THE VERDICT. A refusal that still wrote to the PTY
// would satisfy any `result.path` assertion and would be the exact bug this guard exists to prevent,
// so every refusal case below also pins that BOTH write primitives were never called. The delivering
// cases exist to keep the guard from passing vacuously: a version of this file that refused
// everything would be green on the refusals alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuggestionButton } from "./suggestions/types";

vi.mock("../pty", () => {
  class PtyGoneError extends Error {}
  return {
    writePtyChainedStrict: vi.fn(async () => {}),
    submitPrompt: vi.fn(async () => {}),
    PtyGoneError,
  };
});
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: vi.fn(() => "SCREEN") }));
vi.mock("./suggestions/heuristics", () => ({
  detectTerminalPrompts: vi.fn((): SuggestionButton[] => []),
}));
vi.mock("./terminalViewport", () => ({ getAgentViewport: vi.fn(() => null) }));

import { submitPrompt, writePtyChainedStrict } from "../pty";
import { detectTerminalPrompts } from "./suggestions/heuristics";
import { getAgentViewport } from "./terminalViewport";
import { dispatchConciergeAnswer } from "./conciergeDispatch";

const AGENT = "agent-1";
/** A real gesture, so the authority gate (which runs first) is never what refuses here. */
const OPTS = { authority: { kind: "mention", agentId: AGENT } as const, userPrompt: false };

/** Put the agent on the alternate screen buffer — a `vim` session, as far as the guard can tell. */
function onFullScreenApp(): void {
  vi.mocked(getAgentViewport).mockReturnValue({ text: "~\n~\n~", alternateBuffer: true });
}
/** A readable, ordinary screen at a shell prompt. */
function atAPrompt(): void {
  vi.mocked(getAgentViewport).mockReturnValue({ text: "$ ", alternateBuffer: false });
}

/** The assertion the whole file is about: not one byte reached the PTY, by either primitive. */
function expectNothingWritten(): void {
  expect(submitPrompt).not.toHaveBeenCalled();
  expect(writePtyChainedStrict).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.mocked(getAgentViewport).mockReturnValue(null);
  vi.mocked(detectTerminalPrompts).mockReturnValue([]);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("a full-screen app refuses every write", () => {
  it("refuses free text and writes nothing", async () => {
    onFullScreenApp();
    const r = await dispatchConciergeAnswer(AGENT, "rebase onto main please", OPTS);
    expect(r.ok).toBe(false);
    expect(r.path).toBe("alternate-screen");
    expectNothingWritten();
  });

  // ORDERING, and it is load-bearing. The guard sits AHEAD of the picker branch on purpose: the
  // options come from the SCROLLBACK, which still holds whatever prompt the agent printed before it
  // launched the editor. Behind the picker branch, a terse "yes" would match that stale option and
  // be framed as `y\r` — a keystroke delivered into `vim` normal mode. This test fails if the guard
  // is moved below the branch, which a reviewer tidying the function could easily do.
  it("refuses a terse answer that matches a stale option, rather than pressing it", async () => {
    onFullScreenApp();
    vi.mocked(detectTerminalPrompts).mockReturnValue([
      { label: "Yes", value: "y" } as unknown as SuggestionButton,
    ]);
    const r = await dispatchConciergeAnswer(AGENT, "yes", OPTS);
    expect(r.path).toBe("alternate-screen");
    expectNothingWritten();
  });

  // Whoever authored the text, the screen executes it the same way. `goal-continue` is the
  // auto-resume caller that never had this guard and never could have inherited one written in the
  // composer.
  it("refuses a machine-authored auto-resume too", async () => {
    onFullScreenApp();
    const r = await dispatchConciergeAnswer(AGENT, "continue", {
      authority: { kind: "goal-continue", agentId: AGENT },
    });
    expect(r.path).toBe("alternate-screen");
    expectNothingWritten();
  });
});

// ══ …EXCEPT A BUSY CLAUDE CODE, WHICH IS NOT A FULL-SCREEN APP (bead sparkle-v7k3y) ═════════════
// THIS IS THE CHOKEPOINT, and it is where the founder's send was actually being refused. Relaxing
// only `terminalWriteRefusal` (the caller-side pre-check in ConciergeHost) changed nothing he could
// see: the send fell through the loosened pre-check and died HERE, and `refusalCopy` posted the same
// "full-screen app" sentence from the `alternate-screen` path below (roborev 57704).
//
// Claude Code holds the alternate buffer while it works, and every agent in this app runs Claude
// Code — so an unconditional refusal here fires on the most common state in the product.
describe("a busy Claude Code is not a full-screen app", () => {
  /** Claude Code mid-command: the founder's screen. Its live composer box is what distinguishes it
   *  from a pager showing a transcript of one — see engine/claudeCodeScreen. */
  function onBusyClaudeCode(): void {
    vi.mocked(getAgentViewport).mockReturnValue({
      text: [
        "⏺ I'll run the test suite and commit.",
        "  ⎿  $ bash scripts/tests/run.sh (1m 23s)",
        "     (ctrl+b to run in background)",
        "──────────────────────────────────────────────────────────────────────────────",
        "❯ ",
        "──────────────────────────────────────────────────────────────────────────────",
        "  ⏸ manual mode on · ? for shortcuts",
      ].join("\n"),
      alternateBuffer: true,
    });
  }

  it("delivers free text into it rather than refusing", async () => {
    onBusyClaudeCode();
    const r = await dispatchConciergeAnswer(AGENT, "give me an update after you do", OPTS);
    expect(r.path).not.toBe("alternate-screen");
    expect(r.ok).toBe(true);
  });

  // ══ RECOGNISING CLAUDE CODE IS NOT A SAFETY VERDICT (roborev 57718) ═══════════════════════════
  // The regression this pins: skipping the alternate-screen arm for a recognised Claude Code took
  // only HALF of what `terminalWriteRefusal` does, and the other two callers of this function
  // (`conciergeTools/terminal`, the goal auto-resume) have no screen guard of their own — they were
  // relying entirely on the unconditional refusal that was removed.
  //
  // A Claude Code pane running a Bash tool that stopped at a sudo prompt STILL draws its composer
  // box and its busy bar, so it is recognised; `liveOptionsFor` is a picker detector and does not
  // match a credential prompt. Without the restored `screenBlocksWrite` this pastes AND SUBMITS
  // prose into a field that echoes nothing.
  it("refuses a credential prompt sitting on a recognised Claude Code screen", async () => {
    vi.mocked(getAgentViewport).mockReturnValue({
      text: [
        "⏺ Installing the dependency.",
        "  ⎿  $ sudo make install",
        "     (ctrl+b to run in background)",
        "[sudo] password for drodio:",
        "──────────────────────────────────────────────────────────────────────────────",
        "❯ ",
        "──────────────────────────────────────────────────────────────────────────────",
        "  ⏸ manual mode on · ? for shortcuts",
      ].join("\n"),
      alternateBuffer: true,
    });
    const r = await dispatchConciergeAnswer(AGENT, "give me an update after you do", OPTS);
    expect(r.ok).toBe(false);
    expect(r.path).toBe("blocked-prompt");
    expectNothingWritten();
  });

  // The refusal the bead insists on keeping is the row this one is paired with: `onFullScreenApp`
  // above is a real vim screen and still takes the `alternate-screen` path.
  it("still refuses a genuine full-screen app on the same code path", async () => {
    onFullScreenApp();
    const r = await dispatchConciergeAnswer(AGENT, "give me an update after you do", OPTS);
    expect(r.path).toBe("alternate-screen");
    expectNothingWritten();
  });
});

// ══ A CREDENTIAL PROMPT BLOCKS ON ANY BUFFER (bead sparkle-p9hs5) ═══════════════════════════════
// PRE-EXISTING hazard, not a regression. Only the alternate-buffer arms ran here, so a NORMAL-buffer
// screen reached `submitPrompt` with no screen check at all. ConciergeHost has its own pre-check —
// but `conciergeTools/terminal` (the model-issued send_to_agent_terminal) and the goal auto-resume
// do NOT, and for them this chokepoint is the only guard there is.
describe("a credential prompt refuses on the normal buffer too", () => {
  /** A shell at a sudo prompt: NORMAL buffer, no Claude Code, no picker. */
  function atASudoPrompt(): void {
    vi.mocked(getAgentViewport).mockReturnValue({
      text: "$ sudo -v\n[sudo] password for drodio:",
      alternateBuffer: false,
    });
  }

  it("refuses free text rather than pasting into a field that echoes nothing", async () => {
    atASudoPrompt();
    const r = await dispatchConciergeAnswer(AGENT, "continue with the retry work", OPTS);
    expect(r.ok).toBe(false);
    expect(r.path).toBe("blocked-prompt");
    expectNothingWritten();
  });

  // WHOEVER AUTHORED IT. The goal auto-resume sends "continue" every 15s with no screen guard of its
  // own, which is precisely the caller this chokepoint has to cover.
  it("refuses a machine-authored auto-resume at the same prompt", async () => {
    atASudoPrompt();
    const r = await dispatchConciergeAnswer(AGENT, "continue", {
      authority: { kind: "goal-continue", agentId: AGENT },
    });
    expect(r.path).toBe("blocked-prompt");
    expectNothingWritten();
  });

  // ══ AND A LIVE PICKER IS STILL *ANSWERED*, NOT REFUSED ════════════════════════════════════════
  // THE ROW THAT CONSTRAINS THE FIX. The obvious implementation — calling `screenBlocksWrite` here —
  // would refuse every live picker, because that predicate is a SUPERSET of `screenAwaitsInput` and
  // this guard sits ABOVE the picker branch. This file's own header calls that out as something that
  // must not be hoisted. So the guard calls `screenIsCredentialPrompt`, the non-picker half, and
  // this row fails the moment someone "simplifies" it back.
  it("still answers a live picker instead of refusing it", async () => {
    // A REAL PICKER SCREEN, not the bare `$ ` fixture with options mocked on top. The first cut of
    // this row used `atAPrompt()`, and it was VACUOUS: `screenAwaitsInput("$ ")` is false, so the
    // naive `screenBlocksWrite` implementation this row exists to forbid passed it. The text below
    // makes `screenAwaitsInput` true, which is the only way the row can see the difference between
    // the two predicates.
    vi.mocked(getAgentViewport).mockReturnValue({
      text: "Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend",
      alternateBuffer: false,
    });
    vi.mocked(detectTerminalPrompts).mockReturnValue([
      { label: "Yes", value: "y" } as unknown as SuggestionButton,
    ]);
    const r = await dispatchConciergeAnswer(AGENT, "yes", OPTS);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("picker-option");
  });
});

describe("the guard is narrow — it blocks the alternate buffer and nothing else", () => {
  it("delivers free text at an ordinary prompt", async () => {
    atAPrompt();
    const r = await dispatchConciergeAnswer(AGENT, "run the tests", OPTS);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("free-text");
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "run the tests", expect.anything());
  });

  // An UNREADABLE viewport is not the same fact as a full-screen app, and refusing it here would
  // break shipped paths: an `@Name` address at an agent whose pane is mounted in another window, and
  // an auto-resume with no window open at all, both read null. The callers that must refuse null
  // weigh it themselves.
  it("delivers when the terminal isn't mounted in this window", async () => {
    vi.mocked(getAgentViewport).mockReturnValue(null);
    const r = await dispatchConciergeAnswer(AGENT, "run the tests", OPTS);
    expect(r.path).toBe("free-text");
    expect(submitPrompt).toHaveBeenCalled();
  });
});
