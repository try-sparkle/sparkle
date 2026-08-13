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
import { getAgentScrollback } from "./terminalScrollback";
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
  // ══ A STALE SCROLLBACK MENU MUST NOT WAIVE A LIVE CREDENTIAL PROMPT (roborev 58529) ═══════════
  // THE ROW THE PREVIOUS GATE COULD NOT HAVE. `pickerOptions` parses the SCROLLBACK; the credential
  // check reads the VIEWPORT. Gating on "are there any options" therefore let a menu still sitting
  // in scrollback — not what the screen is waiting on — switch the guard off entirely.
  //
  // It reported SUCCESS while doing the harm: `CHOICE_KEYWORD` contains `enter`, so
  // `Enter your vault password:` under a still-visible numbered run parses as a menu, and a terse
  // "1" was submitted as `1\r` INTO THE CONCEALED FIELD with ok:true / path:"picker-option".
  //
  // The two sources are set to DIFFERENT text here on purpose — the earlier row sets them to the
  // same string and so cannot see this divergence at all.
  it("refuses a credential prompt even while a menu is still in scrollback", async () => {
    // THE REAL detector — with the file's default `[]` mock, `pickerOptions` is empty and the
    // option-count gate this row exists to forbid never fires, so the row would pass against it.
    const real = await vi.importActual<typeof import("./suggestions/heuristics")>(
      "./suggestions/heuristics",
    );
    vi.mocked(detectTerminalPrompts).mockImplementation(real.detectTerminalPrompts);
    vi.mocked(getAgentScrollback).mockReturnValue(
      "Pick a vault:\n1) personal\n2) work\nEnter your vault password:",
    );
    vi.mocked(getAgentViewport).mockReturnValue({
      text: "Enter your vault password:",
      alternateBuffer: false,
    });
    const r = await dispatchConciergeAnswer(AGENT, "1", OPTS);
    expect(r.path).toBe("blocked-prompt");
    expectNothingWritten();
  });

  // ssh's host-key prompt carries `(yes/no)` and the detector matches it — but it is NOT
  // picker-answerable: ssh requires the whole word `yes` while Approve sends `y`, so answering it
  // would report a delivery ssh rejected. The commit that added the yes/no waiver claimed this case
  // still blocked; it did not, which is why it is pinned here.
  it("refuses ssh's host-key confirmation rather than answering it as a picker", async () => {
    const HOSTKEY =
      "The authenticity of host 'x (1.2.3.4)' can't be established.\n" +
      "ED25519 key fingerprint is SHA256:abc.\n" +
      "Are you sure you want to continue connecting (yes/no/[fingerprint])? ";
    // Real detector, for the same reason as the row above: ssh's prompt has to actually PARSE as a
    // picker for this row to prove the waiver does not reach it.
    const real = await vi.importActual<typeof import("./suggestions/heuristics")>(
      "./suggestions/heuristics",
    );
    vi.mocked(detectTerminalPrompts).mockImplementation(real.detectTerminalPrompts);
    vi.mocked(getAgentScrollback).mockReturnValue(HOSTKEY);
    vi.mocked(getAgentViewport).mockReturnValue({ text: HOSTKEY, alternateBuffer: false });
    const r = await dispatchConciergeAnswer(AGENT, "yes", OPTS);
    expect(r.path).toBe("blocked-prompt");
    expectNothingWritten();
  });

  // ══ …BUT ONLY WHEN A PICKER IS ACTUALLY LIVE (roborev 58540) ══════════════════════════════════
  // The detector's YN arm only fires when `yes/no` sits in the last two non-empty lines. Three lines
  // up it misses, `pickerOptions` is empty, and an unconditional waiver let the send paste AND SUBMIT
  // prose into a live confirmation — which the goal auto-resume would hit every 15s.
  it("refuses a (yes/no) confirmation that scrolled out of the detector's reach", async () => {
    const real = await vi.importActual<typeof import("./suggestions/heuristics")>(
      "./suggestions/heuristics",
    );
    vi.mocked(detectTerminalPrompts).mockImplementation(real.detectTerminalPrompts);
    const SCREEN =
      "Overwrite existing config? (yes/no)\nWaiting for response…\nPress Ctrl-C to abort.";
    vi.mocked(getAgentScrollback).mockReturnValue(SCREEN);
    vi.mocked(getAgentViewport).mockReturnValue({ text: SCREEN, alternateBuffer: false });
    const r = await dispatchConciergeAnswer(AGENT, "continue", OPTS);
    expect(r.path).toBe("blocked-prompt");
    expectNothingWritten();
  });

  // ══ A STALE SCROLLBACK MENU MUST NOT WAIVE A LIVE yes/no PROMPT (roborev 58562) ═══════════════
  // The waiver used to be computed from the SCROLLBACK while the guard read the VIEWPORT, so a menu
  // still sitting in history waived a confirmation three lines up — and because
  // `detectTerminalPrompts` short-circuits on the menu branches before it ever evaluates YN, it did
  // not even have to be a yes/no menu. A terse answer matching a stale option was then written as a
  // keystroke into the live confirmation, returning ok:true / picker-option.
  it("refuses a live (yes/no) prompt while an unrelated menu sits in scrollback", async () => {
    const real = await vi.importActual<typeof import("./suggestions/heuristics")>(
      "./suggestions/heuristics",
    );
    vi.mocked(detectTerminalPrompts).mockImplementation(real.detectTerminalPrompts);
    // SCROLLBACK carries a numbered menu; the VIEWPORT is the confirmation with chatter under it.
    vi.mocked(getAgentScrollback).mockReturnValue(
      "Select a profile:\n1) staging\n2) prod\nOverwrite existing config? (yes/no)\nWaiting…\nPress Ctrl-C to abort.",
    );
    vi.mocked(getAgentViewport).mockReturnValue({
      text: "Overwrite existing config? (yes/no)\nWaiting…\nPress Ctrl-C to abort.",
      alternateBuffer: false,
    });
    const r = await dispatchConciergeAnswer(AGENT, "1", OPTS);
    expect(r.path).toBe("blocked-prompt");
    expectNothingWritten();
  });

  // ══ A STALE PICKER MUST NOT SUPPLY THE ANSWER THE WAIVER ALLOWED (roborev 58575) ══════════════
  // The mirror of the previous round: the waiver read the VIEWPORT while the answer was still parsed
  // from the SCROLLBACK. `detectClaudeCodePicker` scans 50 non-empty scrollback lines with no
  // near-the-end requirement, so a picker scrolled just above the visible area supplied `1\n`/`2\n`
  // for a screen whose live prompt is a shell confirmation — and a terse "2" pressed a digit into it.
  it("does not answer a live (yes/no) from a picker that scrolled out of the viewport", async () => {
    const real = await vi.importActual<typeof import("./suggestions/heuristics")>(
      "./suggestions/heuristics",
    );
    vi.mocked(detectTerminalPrompts).mockImplementation(real.detectTerminalPrompts);
    vi.mocked(getAgentScrollback).mockReturnValue(
      "❯ 1. Yes\n  2. No\nEsc to cancel · Tab to amend · ctrl+e to explain\n" +
        "$ rm -rf build\nOverwrite existing config? (yes/no)",
    );
    vi.mocked(getAgentViewport).mockReturnValue({
      text: "$ rm -rf build\nOverwrite existing config? (yes/no)",
      alternateBuffer: false,
    });
    // "2" is the STALE picker's option. The harm was that it reached the PTY as `2\r` — a digit
    // pressed into a shell confirmation that has no numbered options at all.
    await dispatchConciergeAnswer(AGENT, "2", OPTS);
    expect(writePtyChainedStrict).not.toHaveBeenCalledWith(AGENT, "2\r");
    // AND THE POSITIVE HALF, so this row cannot pass by the send simply failing: whatever went down
    // the wire was an answer to the prompt that is ACTUALLY on screen. `matchAnswerToOption` selects
    // ordinally, so "2" picks the live pair's second option — Deny — and `n\r` is a valid answer to
    // the confirmation the user is looking at, which is the whole point of answering from the text
    // the waiver read.
    expect(writePtyChainedStrict).toHaveBeenCalledWith(AGENT, "n\r");
  });

  // ══ AND A CLAUDE CODE PANE MERELY SHOWING (yes/no) STILL DELIVERS (roborev 58575) ══════════════
  // The previous round scoped the yes/no arm inside `screenIsYesNoPrompt` only — the NON-Claude-Code
  // path — while `screenBlocksWrite` still tested it unscoped for every screen where Claude Code
  // holds the alternate buffer, which is the most common state in the product. So a pane displaying
  // documentation refused every write. This row runs that dominant path.
  it("delivers on a busy Claude Code pane that merely displays (yes/no)", async () => {
    const SCREEN = [
      "⏺ Reading the guard's source.",
      "  ⎿  the pattern matches screens like (yes/no) — documentation, not a prompt",
      "     (ctrl+b to run in background)",
      "──────────────────────────────────────────────────────────────────────────────",
      "❯ ",
      "──────────────────────────────────────────────────────────────────────────────",
      "  ⏸ manual mode on · ? for shortcuts",
    ].join("\n");
    vi.mocked(getAgentScrollback).mockReturnValue(SCREEN);
    vi.mocked(getAgentViewport).mockReturnValue({ text: SCREEN, alternateBuffer: true });
    const r = await dispatchConciergeAnswer(AGENT, "carry on", OPTS);
    expect(r.path).toBe("free-text");
    expect(r.ok).toBe(true);
  });

  // ══ …AND THE `(y/n)` SPELLING TOO, WHICH IS THE ONE THAT CAME BACK (roborev 63208) ═════════════
  // The row above is the same claim for `(yes/no)`, and it is why this hole survived: EVERY fixture
  // in this suite uses that spelling, which `SHELL_PROMPTS`' `/[([]y\/n[)\]]/i` does not match. So
  // when `screenBlocksWrite` re-acquired an unscoped whole-snapshot scan of that list, this suite —
  // the one that owns exactly these delivering rows — stayed green while the dominant path in the
  // product started refusing every write: the concierge relay, the model-issued
  // `send_to_agent_terminal`, and the goal auto-resume, all `{ok:false, path:"blocked-prompt"}` with
  // no override, on any pane showing a `--help`, `AGENTS.md`, or a `git show` of the guard itself.
  //
  // The filler rows are load-bearing, not padding: `screenAwaitsInput`'s arm 3 scans the last 12
  // non-empty rows per line, so on a short fixture IT blocks and the assertion says nothing about
  // the arm under test.
  it("delivers on a busy Claude Code pane that merely displays (y/n)", async () => {
    const SCREEN = [
      "⏺ Reading the guard's source.",
      "  ⎿  the pattern matches screens like (y/n) — documentation, not a prompt",
      ...Array.from({ length: 15 }, (_, i) => `     step ${i} complete`),
      "⏺ Updated three files and ran the suite — all green.",
      "──────────────────────────────────────────────────────────────────────────────",
      "❯ ",
      "──────────────────────────────────────────────────────────────────────────────",
      "  ⏸ manual mode on · ? for shortcuts",
    ].join("\n");
    vi.mocked(getAgentScrollback).mockReturnValue(SCREEN);
    vi.mocked(getAgentViewport).mockReturnValue({ text: SCREEN, alternateBuffer: true });
    const r = await dispatchConciergeAnswer(AGENT, "carry on", OPTS);
    expect(r.path).toBe("free-text");
    expect(r.ok).toBe(true);
  });

  // ══ AND MERELY MENTIONING (yes/no) IS NOT A PROMPT (roborev 58562) ════════════════════════════
  // The delivering direction for the yes/no arm, which `screenIsYesNoPrompt` previously lacked: it
  // tested the WHOLE viewport, so any pane displaying the string — this source file, a `git show` of
  // it, a `--help` — refused every write until it scrolled off. Tail-scoped now.
  it("delivers to a screen that merely mentions (yes/no) above the prompt", async () => {
    const SCREEN =
      "The guard matches /\\(\\s*yes\\s*\\/\\s*no/i on screens like (yes/no).\n" +
      "That is documentation, not a prompt.\n\n\n\n\n$ ";
    vi.mocked(getAgentScrollback).mockReturnValue(SCREEN);
    vi.mocked(getAgentViewport).mockReturnValue({ text: SCREEN, alternateBuffer: false });
    const r = await dispatchConciergeAnswer(AGENT, "carry on", OPTS);
    expect(r.path).toBe("free-text");
    expect(r.ok).toBe(true);
  });

  // ══ AND "fingerprint" IS NOT A PROMPT (roborev 58540) ══════════════════════════════════════════
  // SSH_HOST_KEY tests the whole viewport, so a bare `\bfingerprint\b` alternative refused EVERY send
  // to any agent whose pane happened to show the word — a key listing, `git log --show-signature`, or
  // an agent reading this very diff — with no override until it scrolled off. This row is the
  // delivering direction, so the over-block cannot come back.
  it("delivers to a screen that merely mentions a fingerprint", async () => {
    const SCREEN = "ED25519 key fingerprint is SHA256:abc\n$ ";
    vi.mocked(getAgentScrollback).mockReturnValue(SCREEN);
    vi.mocked(getAgentViewport).mockReturnValue({ text: SCREEN, alternateBuffer: false });
    const r = await dispatchConciergeAnswer(AGENT, "carry on", OPTS);
    expect(r.path).toBe("free-text");
    expect(r.ok).toBe(true);
  });

  // ══ A `(yes/no)` PROMPT IS A PICKER, THROUGH THE REAL DETECTOR (roborev 58512) ════════════════
  // THE ROW THE FIRST CUT COULD NOT HAVE. `WRITE_BLOCKING_PROMPTS` carries `/\(\s*yes\s*\/\s*no/i`,
  // so `screenIsCredentialPrompt` is NOT purely the non-picker half — and `suggestions/heuristics`'
  // own `YN` emits the Approve/Deny pair for exactly that shape. The guard therefore refused
  // `Overwrite existing config? (yes/no)` instead of answering it, for every caller including the
  // nudge Approve relay, which is the very hazard the guard's doc claims to avoid.
  //
  // DRIVEN THROUGH THE REAL `detectTerminalPrompts`, not a mocked option list: the collision only
  // exists because the detector and the blocking list overlap on this shape, and a hand-built list
  // cannot see that. `getAgentScrollback` feeds it, so the same text drives both predicates.
  it("answers a (yes/no) confirmation rather than refusing it as a credential prompt", async () => {
    const YN = "Overwrite existing config? (yes/no) ";
    vi.mocked(getAgentScrollback).mockReturnValue(YN);
    // THE REAL detector, reached with `importActual` past this file's module mock. The `(yes/no)`
    // collision only exists because the detector's YN arm and WRITE_BLOCKING_PROMPTS match the same
    // screen, so a hand-built option list cannot express it.
    const real = await vi.importActual<typeof import("./suggestions/heuristics")>(
      "./suggestions/heuristics",
    );
    vi.mocked(detectTerminalPrompts).mockImplementation(real.detectTerminalPrompts);
    vi.mocked(getAgentViewport).mockReturnValue({ text: YN, alternateBuffer: false });
    const r = await dispatchConciergeAnswer(AGENT, "yes", OPTS);
    expect(r.path).toBe("picker-option");
    expect(r.ok).toBe(true);
  });

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
