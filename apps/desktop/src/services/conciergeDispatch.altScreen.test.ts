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
import { conciergeToolAuthority } from "./dispatchAuthority";
// For the evidence-logging case: the refusal's diagnostic record is the deliverable, so it is
// asserted rather than assumed.
import { log } from "../logger";

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

  // ══ A THIRD SCREEN THAT REPLACES THE COMPOSER: THE BACKGROUND-TASK LIST (sparkle-tbsvf) ═══════
  // The founder's own report — typing into the mounted Improve Sparkle pane silently failed — and
  // the concierge's own `send_to_agent_terminal` toward that same pane were both refused
  // `alternate-screen` while the pane was doing nothing but listing its live background subagents.
  // This is THE chokepoint every text→PTY path shares (the mounted composer's route included, per
  // `Concierge/composerRoute`), so a fix at `engine/claudeCodeScreen` only counts once it lands
  // here too.
  it("delivers into a pane showing only its own background-task list, no composer visible", async () => {
    vi.mocked(getAgentViewport).mockReturnValue({
      text: ["⏺ main", "◯ general-purpose  Concierge agents as clickable rows  21m 55s"].join(
        "\n",
      ),
      alternateBuffer: true,
    });
    const r = await dispatchConciergeAnswer(AGENT, "give me an update after you do", OPTS);
    expect(r.path).not.toBe("alternate-screen");
    expect(r.ok).toBe(true);
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

// ══ THE MENU VERDICT THE ESCALATION READS (bead sparkle-j2gase) ═════════════════════════════════
// Both states reach the SAME `alternate-screen` path, and until now the auto-resume escalation could
// not tell them apart: it told the human "usually a permission dialog or menu waiting on an answer"
// for a no-menu pager, sending them to hunt for a dialog that was not there (four agents, one
// morning). The dispatcher already KNOWS which it is — the same `liveOptionsFor` read the refusal
// used — so it carries the labels (or undefined) on the result for the escalation to branch on. This
// is the SEAM the runner test cannot cover: it mocks `dispatchConciergeAnswer` whole, so the line
// that PRODUCES this field is exercised by nothing but these rows.
describe("an alternate-screen refusal carries its menu verdict", () => {
  it("carries the live menu's labels when a dialog is on the alternate screen", async () => {
    // A Claude Code permission dialog reached by a free-text send: the composer box is replaced, so
    // it is NOT recognised as Claude Code and takes the alternate-screen path — but `read_picker`
    // finds its options. The escalation must be able to name them, so they ride on the result.
    onFullScreenApp();
    vi.mocked(detectTerminalPrompts).mockReturnValue([
      { label: "Yes", value: "y" } as unknown as SuggestionButton,
      { label: "No, and tell Claude what to do differently", value: "n" } as unknown as SuggestionButton,
    ]);
    const r = await dispatchConciergeAnswer(AGENT, "continue with the plan", {
      authority: { kind: "goal-continue", agentId: AGENT },
    });
    expect(r.path).toBe("alternate-screen");
    // THE SIDE EFFECT: the labels, in order, so the escalation names the actual question.
    expect(r.altScreenMenuLabels).toEqual(["Yes", "No, and tell Claude what to do differently"]);
    expectNothingWritten();
  });

  it("carries NO menu labels when a pager or editor holds the screen (blind:'no-menu')", async () => {
    // `onFullScreenApp` is a vim screen and `detectTerminalPrompts` defaults to `[]` — the exact
    // `blind:'no-menu'` case the four stalled agents hit. `undefined`, not `[]`, is what the runner
    // branch keys "a pager/editor is holding it — quitting is safe" off, so pin the distinction.
    onFullScreenApp();
    const r = await dispatchConciergeAnswer(AGENT, "continue with the plan", {
      authority: { kind: "goal-continue", agentId: AGENT },
    });
    expect(r.path).toBe("alternate-screen");
    expect(r.altScreenMenuLabels).toBeUndefined();
    expectNothingWritten();
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

// ══ A MOUNTED SEND IS DELIVERED, NOT REFUSED AND NOT HELD (beads sparkle-tbsvf, sparkle-93wnu3) ═══
// The founder: he mounts an agent's pane, types a message while it's mid-tool-call, and the send is
// refused with "Sparkle has a full-screen app open" — correct for a MODEL guessing at a screen it
// can't take a write back from, but not for him, looking straight at the pane he just typed into.
// His only channel to that agent then becomes filing a bead.
//
// AN EARLIER FIX MADE THIS BLOCK HOLD RATHER THAN REFUSE, AND THAT WAS THE WRONG READING. A hold
// whose release condition is the SAME predicate that caused it never clears when that predicate is
// wrong — the message waited out MAX_AGE_MS and was dropped, fifteen minutes after he was promised
// it would arrive. Asked directly (2026-08-20) whether a mounted send may ever be held, he chose
// "Never hold — just send it". So these rows pin DELIVERY, and the only thing that can make them
// pass vacuously — a guard that let everything through — is refuted by the machine-sender rows
// beside them, which assert the identical screen still refuses.
//
// `mountedSend` is the opt-in only ConciergeHost's mounted composer sets.
describe("a mounted send is delivered, whatever the screen shows", () => {
  const MOUNT_OPTS = {
    authority: { kind: "mention", agentId: AGENT } as const,
    userPrompt: true,
    mountedSend: true,
  };

  // THE FOUNDER'S CASE. The screen the guard cannot vouch for is the one he is looking at.
  it("writes into a full-screen app rather than refusing or queueing", async () => {
    onFullScreenApp();
    const r = await dispatchConciergeAnswer(AGENT, "did you get my ask about more?", MOUNT_OPTS);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("free-text");
    // NOT "queued" — the whole point. A `queued` here is the old bug wearing a friendlier status.
    expect(submitPrompt).toHaveBeenCalledWith(
      AGENT,
      "did you get my ask about more?",
      expect.anything(),
    );
  });

  // The credential/`(yes/no)` refusal (`blocked-prompt`) is the OTHER screen-only reason a mounted
  // send used to be refused — see `terminalWriteBlocked`'s `awaiting-input`. Same rule, same proof.
  //
  // ⚠️ THIS ROW IS A DELIBERATE, FOUNDER-DECIDED TRADE, not an oversight. Offered the narrower
  // "deliver everywhere EXCEPT a concealed credential field" he chose "just send it": a mounted
  // send is his, and he can see what the pane is showing. If that ever bites, the carve-out goes
  // back HERE — as an immediate, visible refusal that hands the words back, never as a queue.
  it("writes at a credential prompt too, because the founder can see the pane", async () => {
    vi.mocked(getAgentViewport).mockReturnValue({
      text: "$ sudo -v\n[sudo] password for someone:",
      alternateBuffer: false,
    });
    const r = await dispatchConciergeAnswer(AGENT, "carry on when you're able", MOUNT_OPTS);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("free-text");
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "carry on when you're able", expect.anything());
  });

  // THE CARVE-OUT'S OTHER HALF: without `mountedSend`, the exact same screen still refuses
  // outright — a model or an auto-resume calling this function gets nothing, because neither can
  // set the flag (see its own doc on `ConciergeDispatchOptions`).
  it("still refuses outright when the caller is not a mounted human send", async () => {
    onFullScreenApp();
    const r = await dispatchConciergeAnswer(AGENT, "did you get my ask about more?", {
      authority: { kind: "goal-continue", agentId: AGENT },
    });
    expect(r.ok).toBe(false);
    expect(r.path).toBe("alternate-screen");
    expectNothingWritten();
  });

  // ══ THE REFUSAL SCOPE IS THE AUTHORITY'S, NOT THE CALLER'S (bead sparkle-tbsvf) ═══════════════
  // The founder's rule: the alternate-screen refusal stays for PROGRAMMATIC senders and must NEVER
  // apply to him typing into a pane he deliberately mounted. Both halves are asserted here against
  // ONE screen, so a change that relaxed the guard for everyone would fail the second row rather
  // than quietly pass the first. See `mountedHumanSend`.
  describe("the human/programmatic split is read from the authority", () => {
    it("delivers a MOUNTED send even when the caller never set the flag", async () => {
      onFullScreenApp();
      // No `mountedSend` at all — the guarantee must not depend on ConciergeHost remembering
      // a boolean. Mutating `opts.authority.kind === "mount"` to `false` turns this row red.
      const r = await dispatchConciergeAnswer(AGENT, "test", {
        authority: { kind: "mount", agentId: AGENT },
        userPrompt: true,
      });
      expect(r.ok).toBe(true);
      expect(r.path).toBe("free-text");
      expect(submitPrompt).toHaveBeenCalledWith(AGENT, "test", expect.anything());
    });

    it("refuses a concierge tool call even when it DOES set the flag", async () => {
      onFullScreenApp();
      const r = await dispatchConciergeAnswer(AGENT, "test", {
        // Built the way production builds it, so this is a genuinely well-formed tool authority —
        // an ill-formed one would be refused `unauthorized` by the gate above and would prove
        // nothing about the screen guard.
        authority: conciergeToolAuthority("call-1", { tier: "allow" })!,
        userPrompt: true,
        mountedSend: true,
      });
      expect(r.ok).toBe(false);
      expect(r.path).toBe("alternate-screen");
      expectNothingWritten();
    });

    // ══ THE MOUNTED SEND THAT WENT THROUGH A COUNTDOWN (roborev 64466, Medium) ══════════════════
    // A mounted send made while presence is AWAY does not dispatch immediately — it arms an intent
    // and fires at expiry as `{kind: "countdown"}`, with `mentionAim.via` still `"mount"`. So the
    // `mount` exemption above does NOT cover it and the FLAG is what exempts it. Without this row
    // the armed mounted path is pinned by nothing at this layer, and the doc's claim that the
    // exemption makes ConciergeHost's `via === "mount"` argument redundant would be acted on —
    // reintroducing the founder's bug for exactly the case where he stepped away while it counted
    // down.
    it("delivers a mounted send that arrives through the countdown, on the flag", async () => {
      onFullScreenApp();
      const r = await dispatchConciergeAnswer(AGENT, "test", {
        authority: { kind: "countdown", intentId: "intent-1" },
        userPrompt: true,
        mountedSend: true,
      });
      expect(r.ok).toBe(true);
      expect(r.path).toBe("free-text");
      expect(submitPrompt).toHaveBeenCalledWith(AGENT, "test", expect.anything());
    });

    it("refuses a goal-continue auto-resume that sets the flag too", async () => {
      onFullScreenApp();
      const r = await dispatchConciergeAnswer(AGENT, "test", {
        authority: { kind: "goal-continue", agentId: AGENT },
        userPrompt: true,
        mountedSend: true,
      });
      expect(r.ok).toBe(false);
      expect(r.path).toBe("alternate-screen");
      expectNothingWritten();
    });
  });
});

// ══ …AND NEITHER IS A LIVE PERMISSION DIALOG (bead sparkle-d6a5r) ═══════════════════════════════
//
// THE REPORTED DEFECT, six occurrences: `send_to_agent_terminal` refused `alternate-screen` against
// a pane a human had VISUALLY CONFIRMED was sitting on an ordinary Claude Code permission dialog —
// no editor, no pager — leaving `restart_agent`, which destroys in-flight context, as the only
// remaining way to reach that agent.
//
// THE MECHANISM. Claude Code holds the alternate buffer at all times on a modern fleet, so
// `alternateBuffer` excludes nothing and the whole decision rests on `isClaudeCodeScreen`. That
// predicate's family D (the composer box) is MANDATORY, and a permission dialog is exactly what
// REPLACES the composer box. Its family E covers the dialog case, but earns its standing by
// POSITION: the picker footer must TERMINATE the grid. A dialog whose `↑↓ to select` footer is not
// drawn — a short column, a dialog taller than the pane — falls back through E, scores 1 on the
// tool-call glyph alone, fails `>= 2`, and is reported as vim. The captured
// `APPROVAL_2_1_220` fixtures all DO terminate the grid, which is why the suite never saw this.
//
// WHAT THESE CASES ASSERT IS THE CLASSIFICATION AND THE SIDE EFFECT TOGETHER. The reclassification
// must not be a licence: the pair below pins that the dialog is no longer called a full-screen app
// AND that free text still reaches no PTY. A version of this fix that merely relabelled the refusal
// passes the first; a version that let prose through fails the second.
describe("a live permission dialog is not a full-screen app either", () => {
  /** A Claude Code Bash-permission dialog with its footer BELOW the visible grid — the shape the
   *  bead reports and the one family E's below-footer walk cannot recognise. Nothing here is a
   *  pager or an editor: the tool-call glyph above the box is Claude Code's own. */
  const PERMISSION_DIALOG_NO_FOOTER = [
    "⏺ Bash(git status --short)",
    "  ⎿  M apps/desktop/src/services/conciergeDispatch.ts",
    "",
    "╭───────────────────────────────────────────────╮",
    "│ Bash command                                  │",
    "│                                               │",
    "│   git push origin HEAD                        │",
    "│   Push the branch                             │",
    "│                                               │",
    "│ Do you want to proceed?                       │",
    "│ ❯ 1. Yes                                      │",
    "│   2. Yes, and don't ask again                 │",
    "│   3. No, and tell Claude what to do differently│",
    "╰───────────────────────────────────────────────╯",
  ].join("\n");

  const DIALOG_OPTIONS = [
    { id: "1", label: "Yes", value: "1\n", kind: "terminal", source: "heuristic" },
    { id: "2", label: "No", value: "3\n", kind: "terminal", source: "heuristic" },
  ] as unknown as SuggestionButton[];

  function onPermissionDialog(): void {
    vi.mocked(getAgentViewport).mockReturnValue({
      text: PERMISSION_DIALOG_NO_FOOTER,
      alternateBuffer: true,
    });
    vi.mocked(detectTerminalPrompts).mockReturnValue(DIALOG_OPTIONS);
  }

  // ── THE BEAD'S OWN CASE. Red before the fix: the path was `alternate-screen`. ─────────────────
  it("classifies it as a blocked prompt, not a full-screen app", async () => {
    onPermissionDialog();
    const r = await dispatchConciergeAnswer(AGENT, "please push it when you can", OPTS);
    expect(r.path).not.toBe("alternate-screen");
    expect(r.path).toBe("blocked-prompt");
  });

  // ── AND THE OTHER HALF OF THE CONTRACT, which is what makes the change safe to make at all. ───
  // The reclassification is interlocked on `screenBlocksWrite`, so the write is refused by the very
  // next arm. If a later edit drops that conjunct, free text falls through to the picker block and
  // a terse answer PRESSES an option on a dialog nobody read — and this case goes red.
  it("still writes nothing to the PTY", async () => {
    onPermissionDialog();
    await dispatchConciergeAnswer(AGENT, "please push it when you can", OPTS);
    expectNothingWritten();
  });

  // The auto-resume is the caller that burned its retry budget on this refusal every 15 seconds and
  // escalated a human out of bed naming an editor that was not there.
  it("gives the machine-authored auto-resume the same corrected classification", async () => {
    onPermissionDialog();
    const r = await dispatchConciergeAnswer(AGENT, "continue", {
      authority: { kind: "goal-continue", agentId: AGENT },
    });
    expect(r.path).toBe("blocked-prompt");
    expectNothingWritten();
  });

  // ── A PAGER SHOWING A MENU-SHAPED TRANSCRIPT IS STILL A PAGER ────────────────────────────────
  // The widening needs a Claude Code marker family as well as a live menu. A pager or an editor has
  // neither, so `onFullScreenApp` keeps its `alternate-screen` verdict even with options on screen
  // — which the "stale option" case at the top of this file already pins, and this restates against
  // the NEW conjunction so a future edit that drops the marker-family half goes red here.
  it("does not reclassify a full-screen app that happens to show options", async () => {
    onFullScreenApp();
    vi.mocked(detectTerminalPrompts).mockReturnValue(DIALOG_OPTIONS);
    const r = await dispatchConciergeAnswer(AGENT, "please push it when you can", OPTS);
    expect(r.path).toBe("alternate-screen");
    expectNothingWritten();
  });

  // ══ THE EVIDENCE THE REFUSAL WAS BASED ON — the second half of the bead's ask ═════════════════
  // Every one of the six reported occurrences was undiagnosable after the fact, because the only
  // thing this branch logged was the agent id. STRUCTURAL FACTS ONLY: a refused screen is by
  // construction one sitting at a prompt, and some of those prompts are credential fields that echo
  // nothing, so a log line carrying the viewport text would write a password into the app log.
  it("logs the evidence a full-screen-app refusal was based on", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    try {
      onFullScreenApp();
      await dispatchConciergeAnswer(AGENT, "please push it when you can", OPTS);
      const entry = warn.mock.calls.find(
        (c) => c[1] === "refused a write into a full-screen app",
      );
      expect(entry).toBeDefined();
      const fields = entry?.[2] as Record<string, unknown>;
      expect(fields).toMatchObject({
        agentId: AGENT,
        alternateBuffer: true,
        markerFamilies: 0,
        composerBox: false,
        recognisedAsClaudeCode: false,
        dialogOnScreen: false,
      });
      expect(fields).toHaveProperty("viewportOptions");
      expect(fields).toHaveProperty("scrollbackOptions");
      expect(fields).toHaveProperty("rows");
      // NOT the screen text, under any key. This is the assertion that keeps a future "just log the
      // viewport, it's easier to read" edit from leaking a credential field into the log.
      for (const v of Object.values(fields)) expect(typeof v).not.toBe("undefined");
      expect(JSON.stringify(fields)).not.toContain("~");
    } finally {
      warn.mockRestore();
    }
  });
});
