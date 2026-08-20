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
import {
  abandonScreenHeldSends,
  dispatchConciergeAnswer,
  flushScreenHeldSends,
  onDeferredSendOutcome,
  sweepExpiredScreenHeldSends,
} from "./conciergeDispatch";
import {
  MAX_AGE_MS,
  MAX_PER_AGENT,
  queueScreenHeldSend,
  resetScreenHeldSends,
} from "./screenHoldQueue";
import { conciergeToolAuthority } from "./dispatchAuthority";

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
  // The hold queue is module-level state shared across every test in the process — see the
  // describe block below, which is the only one in this file that populates it.
  resetScreenHeldSends();
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

// ══ A MOUNTED SEND HOLDS RATHER THAN REFUSES, WHEN ASKED (bead sparkle-tbsvf, reopened) ═══════════
// The founder: he mounts an agent's pane, types a message while it's mid-tool-call, and the send is
// refused with "Sparkle has a full-screen app open" — correct for a MODEL guessing at a screen it
// can't take a write back from, but not for him, looking straight at the pane he just typed into.
// His only channel to that agent then becomes filing a bead.
//
// `holdForScreenClear` is the opt-in only ConciergeHost's mounted composer sets. THE REGRESSION TEST
// below is the one that matters: it proves a message held here is later WRITTEN — not merely
// accepted with `ok: true` and forgotten, which would be the exact same bug wearing a friendlier
// status code.
describe("a mounted send holds instead of refusing, when asked to", () => {
  const MOUNT_OPTS = {
    authority: { kind: "mention", agentId: AGENT } as const,
    userPrompt: true,
    holdForScreenClear: true,
  };

  it("queues rather than refusing a full-screen app, and writes nothing yet", async () => {
    onFullScreenApp();
    const r = await dispatchConciergeAnswer(AGENT, "did you get my ask about more?", MOUNT_OPTS);
    expect(r.ok).toBe(true);
    expect(r.path).toBe("queued");
    expect(r.heldReason).toBe("screen");
    expectNothingWritten();
  });

  // THE REGRESSION TEST. Queuing with nothing to drain it would silently reproduce "file a bead is
  // the only channel" — the message would sit forever and the founder would never know why. This is
  // what hooks/useScreenHoldDrain calls once its poll sees the screen has cleared.
  it("reaches the agent once the screen clears and the queue is flushed", async () => {
    onFullScreenApp();
    const held = await dispatchConciergeAnswer(AGENT, "did you get my ask about more?", MOUNT_OPTS);
    expect(held.path).toBe("queued");
    expectNothingWritten();

    atAPrompt();
    const [flushed] = await flushScreenHeldSends(AGENT);
    expect(flushed?.ok).toBe(true);
    expect(flushed?.path).toBe("free-text");
    expect(submitPrompt).toHaveBeenCalledWith(
      AGENT,
      "did you get my ask about more?",
      expect.anything(),
    );
  });

  // The credential/`(yes/no)` refusal (`blocked-prompt`) is the OTHER screen-only reason a mounted
  // send is refused — see `terminalWriteBlocked`'s `awaiting-input`, which the composer maps to the
  // same hold. Same mechanism, same proof.
  it("also holds behind a credential prompt, and delivers once it clears", async () => {
    vi.mocked(getAgentViewport).mockReturnValue({
      text: "$ sudo -v\n[sudo] password for drodio:",
      alternateBuffer: false,
    });
    const held = await dispatchConciergeAnswer(AGENT, "carry on when you're able", MOUNT_OPTS);
    expect(held.ok).toBe(true);
    expect(held.path).toBe("queued");
    expectNothingWritten();

    atAPrompt();
    const [flushed] = await flushScreenHeldSends(AGENT);
    expect(flushed?.ok).toBe(true);
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "carry on when you're able", expect.anything());
  });

  // THE CARVE-OUT'S OTHER HALF: without `holdForScreenClear`, the exact same screen still refuses
  // outright — a model or an auto-resume calling this function gets no hold, because neither can
  // set the flag (see its own doc on `ConciergeDispatchOptions`).
  it("still refuses outright when the caller did not ask to hold", async () => {
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
  // than quietly pass the first. See `mayHoldForScreenClear`.
  describe("the human/programmatic split is read from the authority", () => {
    it("holds a MOUNTED send even when the caller never set the hold flag", async () => {
      onFullScreenApp();
      // No `holdForScreenClear` at all — the guarantee must not depend on ConciergeHost remembering
      // a boolean. Mutating `opts.authority.kind === "mount"` to `false` turns this row red.
      const r = await dispatchConciergeAnswer(AGENT, "test", {
        authority: { kind: "mount", agentId: AGENT },
        userPrompt: true,
      });
      expect(r.ok).toBe(true);
      expect(r.path).toBe("queued");
      expect(r.heldReason).toBe("screen");
      expectNothingWritten();
    });

    // AND IT REACHES THE AGENT — a hold with nothing proving it drains is the "file a bead is my
    // only channel" failure wearing a friendlier word. This is the founder's `test` landing.
    it("delivers that mounted send once the screen clears", async () => {
      onFullScreenApp();
      await dispatchConciergeAnswer(AGENT, "test", {
        authority: { kind: "mount", agentId: AGENT },
        userPrompt: true,
      });
      expectNothingWritten();

      atAPrompt();
      const [flushed] = await flushScreenHeldSends(AGENT);
      expect(flushed?.ok).toBe(true);
      expect(submitPrompt).toHaveBeenCalledWith(AGENT, "test", expect.anything());
    });

    // THE HALF THAT MUST NOT MOVE. `send_to_agent_terminal` is the concierge writing via MCP, and
    // the options bag is plain data — so the flag alone must not buy a machine-authored write the
    // founder's treatment on a screen it cannot see.
    it("refuses a concierge tool call even when it DOES set the hold flag", async () => {
      onFullScreenApp();
      const r = await dispatchConciergeAnswer(AGENT, "carry on", {
        // Built the way production builds it, so this is a genuinely well-formed tool authority —
        // an ill-formed one would be refused `unauthorized` by the gate above and would prove
        // nothing about the screen guard.
        authority: conciergeToolAuthority("call-1", { tier: "allow" })!,
        userPrompt: true,
        holdForScreenClear: true,
      });
      expect(r.ok).toBe(false);
      expect(r.path).toBe("alternate-screen");
      expectNothingWritten();
    });

    // ══ THE MOUNTED SEND THAT WENT THROUGH A COUNTDOWN (roborev 64466, Medium) ══════════════════
    // A mounted send made while presence is AWAY does not dispatch immediately — it arms an intent
    // and fires at expiry as `{kind: "countdown"}`, with `mentionAim.via` still `"mount"`. So the
    // `mount` exemption above does NOT cover it and the flag is what holds it. Without this row the
    // armed mounted path is pinned by nothing at this layer, and the doc's claim that the exemption
    // makes ConciergeHost's `via === "mount"` argument redundant would be acted on — reintroducing
    // the founder's bug for exactly the case where he stepped away while it counted down.
    it("holds a mounted send that arrives through the countdown, on the flag", async () => {
      onFullScreenApp();
      const r = await dispatchConciergeAnswer(AGENT, "test", {
        authority: { kind: "countdown", intentId: "intent-1" },
        userPrompt: true,
        holdForScreenClear: true,
      });
      expect(r.ok).toBe(true);
      expect(r.path).toBe("queued");
      expectNothingWritten();
    });

    it("refuses a goal-continue auto-resume that sets the hold flag too", async () => {
      onFullScreenApp();
      const r = await dispatchConciergeAnswer(AGENT, "carry on", {
        authority: { kind: "goal-continue", agentId: AGENT },
        holdForScreenClear: true,
      });
      expect(r.ok).toBe(false);
      expect(r.path).toBe("alternate-screen");
      expectNothingWritten();
    });
  });

  // roborev 64236's Medium: every outcome a screen hold produces carries `heldReason: "screen"`,
  // which is what lets a deferred-outcome reader (ConciergeHost) tell it apart from a PTY-not-ready
  // hold and say something true — the agent DID come up; it was its screen that was busy.
  it("tags every emitted outcome with heldReason: \"screen\"", async () => {
    onFullScreenApp();
    const held = await dispatchConciergeAnswer(AGENT, "carry on", MOUNT_OPTS);
    expect(held.heldReason).toBe("screen");

    atAPrompt();
    const [flushed] = await flushScreenHeldSends(AGENT);
    expect(flushed?.heldReason).toBe("screen");
  });

  // roborev 64268's Medium: the ONE emit site that got missed — a hold pruned from the queue for
  // being stale (not the live-count `queue-full` refusal, but genuinely aged past MAX_AGE_MS) still
  // has to say `heldReason: "screen"`, or ConciergeHost's deferred-outcome reader falls back to the
  // PTY-not-ready wording ("never came up… Send it again when it's running") for a hold whose agent
  // is up and whose screen the founder is looking at.
  it("tags a prune-dropped hold's outcome with heldReason too", async () => {
    onFullScreenApp();
    // Seeded directly (rather than aged by real time) — a stale entry already sitting in this
    // agent's queue when the next hold is queued.
    queueScreenHeldSend({
      agentId: AGENT,
      text: "stale",
      userPrompt: true,
      humanAuthored: true,
      at: 0,
    });
    const outcomes: Array<{ path: string; heldReason?: string }> = [];
    const unsubscribe = onDeferredSendOutcome((r) => outcomes.push(r));
    await dispatchConciergeAnswer(AGENT, "fresh", MOUNT_OPTS);
    unsubscribe();
    expect(outcomes).toEqual([
      expect.objectContaining({ path: "expired", heldReason: "screen" }),
    ]);
  });

  // ══ ONE DELIVERY PER FLUSH, NEVER A BATCH (roborev 64268's Medium) ═══════════════════════════
  // A prior version tried to re-check the viewport SYNCHRONOUSLY between writes within one flush
  // call, to stop a second held message pasting into a dialog the first write opened. That cannot
  // work: `submitPrompt`'s `await` resolves once the PTY has ACCEPTED the write, not once the
  // agent has processed it and xterm has redrawn — a dialog the first write raises appears well
  // after any synchronous re-read would have already passed, so the "re-check" would see the same
  // clear screen the caller already confirmed and paste into the dialog anyway. The actual fix is
  // simpler: deliver AT MOST ONE due entry per call, full stop, and let
  // hooks/useScreenHoldDrain's real 1500ms poll — which re-reads the viewport from scratch on its
  // own tick, giving the terminal genuine time to redraw — decide whether the next one is safe.
  it("delivers only the first due entry per flush, re-queuing the rest for the next poll tick", async () => {
    onFullScreenApp();
    await dispatchConciergeAnswer(AGENT, "first message", MOUNT_OPTS);
    await dispatchConciergeAnswer(AGENT, "second message", MOUNT_OPTS);
    expectNothingWritten();

    atAPrompt();
    const results = await flushScreenHeldSends(AGENT);
    expect(submitPrompt).toHaveBeenCalledTimes(1);
    expect(submitPrompt).toHaveBeenCalledWith(AGENT, "first message", expect.anything());
    expect(results.map((r) => r.sent)).toEqual(["first message"]);

    // The second message is still queued, not lost or reordered — a later flush (the next poll
    // tick, in production) delivers it.
    const [redelivered] = await flushScreenHeldSends(AGENT);
    expect(redelivered?.ok).toBe(true);
    expect(submitPrompt).toHaveBeenLastCalledWith(AGENT, "second message", expect.anything());
  });

  // ══ A THIRD MESSAGE ARRIVING MID-AWAIT MUST NOT JUMP THE RE-QUEUED ONE (roborev 64268's Medium)
  // `takeScreenHeldSends` empties this agent's queue at the top of the flush, so anything queued
  // by a SEPARATE `dispatchConciergeAnswer` call while the first write is in flight lands in a
  // fresh queue — and the re-queue of the older, still-due entry happens only AFTER that await
  // returns. A plain append would therefore put the newer arrival ahead of the older one,
  // delivering a follow-up before the message it follows. Driven through the real entry points
  // (`dispatchConciergeAnswer` queuing, `flushScreenHeldSends` draining) rather than the pure
  // queue function directly, per this file's own header: a held message must be WRITTEN in the
  // right order, not merely accepted.
  it("does not let a message queued mid-flush jump ahead of one re-queued from the same flush", async () => {
    vi.useFakeTimers();
    try {
      onFullScreenApp();
      vi.setSystemTime(1000);
      await dispatchConciergeAnswer(AGENT, "first message", MOUNT_OPTS);
      vi.setSystemTime(2000);
      await dispatchConciergeAnswer(AGENT, "second message", MOUNT_OPTS);
      expectNothingWritten();

      // Gate the first write so it stays "in flight" (PTY-accepted, not yet resolved) exactly as
      // long as this test needs — real `submitPrompt` behaves the same way: its promise resolves
      // once the write is handed to the PTY, independent of whatever else queues in the meantime.
      let resolveFirstWrite: () => void = () => {};
      const firstWriteGate = new Promise<void>((resolve) => {
        resolveFirstWrite = resolve;
      });
      vi.mocked(submitPrompt).mockImplementationOnce(async () => {
        await firstWriteGate;
      });

      // `flushScreenHeldSends` runs synchronously up to its `await submitPrompt(...)`, which is
      // where it suspends on the gate above — so by the time this line returns control, the queue
      // has already been taken (emptied) and the first write is in flight.
      const flushPromise = flushScreenHeldSends(AGENT);

      // A third message arrives from a SEPARATE dispatch call while the first write is still
      // pending — it queues into the now-empty queue, at a LATER system time than "second".
      vi.setSystemTime(3000);
      await dispatchConciergeAnswer(AGENT, "third message", MOUNT_OPTS);

      // Now let the first write resolve. `flushScreenHeldSends` re-queues "second" (at 2000) —
      // the older, still-due entry from THIS flush — after "third" (at 3000) already occupies the
      // queue. The fix must put "second" back ahead of it.
      resolveFirstWrite();
      await flushPromise;

      atAPrompt();
      const [redelivered1] = await flushScreenHeldSends(AGENT);
      expect(submitPrompt).toHaveBeenLastCalledWith(AGENT, "second message", expect.anything());
      expect(redelivered1?.sent).toBe("second message");

      const [redelivered2] = await flushScreenHeldSends(AGENT);
      expect(submitPrompt).toHaveBeenLastCalledWith(AGENT, "third message", expect.anything());
      expect(redelivered2?.sent).toBe("third message");
    } finally {
      vi.useRealTimers();
    }
  });

  // ══ ABANDONMENT DURING AN IN-FLIGHT FLUSH MUST NOT RESURRECT ANYTHING (roborev 64289's Medium)
  // `takeScreenHeldSends` empties the queue before the `await submitPrompt`. If the pane is
  // abandoned (torn down, spawn gave up) WHILE that write is in flight, `abandonScreenHeldSends`
  // finds an already-empty queue and reports nothing — and re-queuing the rest afterward would
  // resurrect it into a dead agent's queue, or a relaunch's under the same id that the founder
  // never typed into. Driven through the real entry points, per this file's own header.
  it("does not resurrect the rest of a flush's due entries if the agent is abandoned mid-flush", async () => {
    onFullScreenApp();
    await dispatchConciergeAnswer(AGENT, "first message", MOUNT_OPTS);
    await dispatchConciergeAnswer(AGENT, "second message", MOUNT_OPTS);
    expectNothingWritten();

    let resolveFirstWrite: () => void = () => {};
    const firstWriteGate = new Promise<void>((resolve) => {
      resolveFirstWrite = resolve;
    });
    vi.mocked(submitPrompt).mockImplementationOnce(async () => {
      await firstWriteGate;
    });

    const flushPromise = flushScreenHeldSends(AGENT);
    const outcomes: Array<{ path: string; heldReason?: string }> = [];
    const unsubscribe = onDeferredSendOutcome((r) => outcomes.push(r));

    // The pane tears down while the first write is still in flight — its screen hold queue is
    // already empty (this flush took it), so the abandon call itself reports nothing.
    abandonScreenHeldSends(AGENT);
    expect(outcomes).toEqual([]);

    resolveFirstWrite();
    const results = await flushPromise;
    unsubscribe();

    // The already-in-flight first write still lands (it cannot be recalled) and reports normally;
    // "second message" must be reported abandoned, NOT silently re-queued for a dead agent.
    expect(outcomes).toEqual([
      expect.objectContaining({ path: "free-text", ok: true, sent: "first message" }),
      expect.objectContaining({ path: "abandoned", heldReason: "screen", sent: "second message" }),
    ]);
    expect(results.map((r) => r.sent)).toEqual(["first message"]);

    // And critically: nothing was resurrected into the queue. A later flush finds nothing due.
    atAPrompt();
    expect(await flushScreenHeldSends(AGENT)).toEqual([]);
    expect(submitPrompt).toHaveBeenCalledTimes(1);
  });

  // ══ A NON-PtyGoneError THROW MUST NOT STRAND THE REST OF THE FLUSH (roborev 64312's Medium) ══
  // `takeScreenHeldSends` empties the queue before the write; if `submitPrompt` throws anything
  // other than `PtyGoneError`, the `try` around the first entry re-throws — and without a
  // `finally` around the re-queue, the still-due `rest` would vanish with no re-queue and no
  // outcome, an unobserved rejection on `useScreenHoldDrain`'s fire-and-forget caller.
  it("still reinstates the rest of the flush when the first write throws an unrelated error", async () => {
    onFullScreenApp();
    await dispatchConciergeAnswer(AGENT, "first message", MOUNT_OPTS);
    await dispatchConciergeAnswer(AGENT, "second message", MOUNT_OPTS);
    expectNothingWritten();

    vi.mocked(submitPrompt).mockImplementationOnce(async () => {
      throw new Error("ipc hiccup");
    });
    await expect(flushScreenHeldSends(AGENT)).rejects.toThrow("ipc hiccup");

    // "second message" survived the throw — reinstated, not stranded.
    atAPrompt();
    const [redelivered] = await flushScreenHeldSends(AGENT);
    expect(redelivered?.sent).toBe("second message");
    expect(redelivered?.ok).toBe(true);
  });

  // ══ THE queue-full / expired CALLBACKS ARE WIRED THROUGH THE REAL FLUSH (roborev 64312's
  // Medium) — driven through dispatchConciergeAnswer/flushScreenHeldSends, not by calling
  // reinstateScreenHeldSends directly, so a dropped or `undefined`-callback regression at the
  // conciergeDispatch.ts call site would fail this test even though screenHoldQueue.test.ts and
  // the ConciergeHost copy test both stay green (the exact "wired nowhere" gap the finding named).
  it("reports queue-full for the entry crowded out when a flush's re-queue overflows the cap", async () => {
    vi.useFakeTimers();
    try {
      onFullScreenApp();
      vi.setSystemTime(1000);
      await dispatchConciergeAnswer(AGENT, "first message", MOUNT_OPTS);
      vi.setSystemTime(2000);
      await dispatchConciergeAnswer(AGENT, "second message", MOUNT_OPTS);
      expectNothingWritten();

      let resolveFirstWrite: () => void = () => {};
      const firstWriteGate = new Promise<void>((resolve) => {
        resolveFirstWrite = resolve;
      });
      vi.mocked(submitPrompt).mockImplementationOnce(async () => {
        await firstWriteGate;
      });
      const flushPromise = flushScreenHeldSends(AGENT);

      // Fill the (now-empty, taken) queue to the cap with mid-flush arrivals — all newer than
      // "second message", which the flush is holding to re-queue once the gate releases.
      for (let i = 0; i < MAX_PER_AGENT; i++) {
        vi.setSystemTime(3000 + i);
        await dispatchConciergeAnswer(AGENT, `mid-flush-${i}`, MOUNT_OPTS);
      }

      const outcomes: Array<{ path: string; heldReason?: string; sent?: string }> = [];
      const unsubscribe = onDeferredSendOutcome((r) => outcomes.push(r));
      resolveFirstWrite();
      await flushPromise;
      unsubscribe();

      // "second message" (the oldest) survives; the NEWEST mid-flush arrival is crowded out and
      // reported — not silently dropped. The in-flight first write also reports normally.
      expect(outcomes).toEqual([
        expect.objectContaining({ path: "free-text", ok: true, sent: "first message" }),
        expect.objectContaining({
          path: "queue-full",
          heldReason: "screen",
          sent: `mid-flush-${MAX_PER_AGENT - 1}`,
        }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports expired for a stale mid-flush arrival pruned when a flush's re-queue runs", async () => {
    vi.useFakeTimers();
    try {
      onFullScreenApp();
      vi.setSystemTime(1000);
      await dispatchConciergeAnswer(AGENT, "first message", MOUNT_OPTS);
      vi.setSystemTime(2000);
      await dispatchConciergeAnswer(AGENT, "second message", MOUNT_OPTS);
      expectNothingWritten();

      let resolveFirstWrite: () => void = () => {};
      const firstWriteGate = new Promise<void>((resolve) => {
        resolveFirstWrite = resolve;
      });
      vi.mocked(submitPrompt).mockImplementationOnce(async () => {
        await firstWriteGate;
      });
      const flushPromise = flushScreenHeldSends(AGENT);

      // A mid-flush arrival that is already, at the moment it queues, older than MAX_AGE_MS —
      // seeded directly with a past `at` the way the existing sweep tests do.
      queueScreenHeldSend({
        agentId: AGENT,
        text: "stale-mid-flush",
        userPrompt: true,
        humanAuthored: true,
        at: 0,
      });
      // Advance real time past MAX_AGE_MS relative to that entry before the re-queue runs.
      vi.setSystemTime(MAX_AGE_MS + 5000);

      const outcomes: Array<{ path: string; heldReason?: string; sent?: string }> = [];
      const unsubscribe = onDeferredSendOutcome((r) => outcomes.push(r));
      resolveFirstWrite();
      await flushPromise;
      unsubscribe();

      expect(outcomes).toEqual([
        expect.objectContaining({ path: "free-text", ok: true, sent: "first message" }),
        expect.objectContaining({ path: "expired", heldReason: "screen", sent: "stale-mid-flush" }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("sweepExpiredScreenHeldSends", () => {
    it("reports and clears an expired hold without delivering it, while the screen is still blocked", async () => {
      // `at: 0` (epoch) is already far more than MAX_AGE_MS behind the real Date.now() this runs
      // against, so no clock mocking is needed to make it read as expired.
      queueScreenHeldSend({
        agentId: AGENT,
        text: "stale",
        userPrompt: true,
        humanAuthored: true,
        at: 0,
      });
      const outcomes: Array<{ ok: boolean; path: string }> = [];
      const unsubscribe = onDeferredSendOutcome((r) => outcomes.push(r));
      sweepExpiredScreenHeldSends(AGENT);
      unsubscribe();
      expect(outcomes).toEqual([
        expect.objectContaining({ ok: false, path: "expired", heldReason: "screen" }),
      ]);
      expectNothingWritten();
    });

    it("is a no-op when nothing has expired", () => {
      const outcomes: unknown[] = [];
      const unsubscribe = onDeferredSendOutcome((r) => outcomes.push(r));
      sweepExpiredScreenHeldSends(AGENT);
      unsubscribe();
      expect(outcomes).toEqual([]);
    });
  });

  describe("abandonScreenHeldSends", () => {
    it("reports every held send as abandoned and clears the queue", async () => {
      queueScreenHeldSend({
        agentId: AGENT,
        text: "orphaned",
        userPrompt: true,
        humanAuthored: true,
        at: 0,
      });
      const outcomes: Array<{ ok: boolean; path: string }> = [];
      const unsubscribe = onDeferredSendOutcome((r) => outcomes.push(r));
      abandonScreenHeldSends(AGENT);
      unsubscribe();
      expect(outcomes).toEqual([
        expect.objectContaining({ ok: false, path: "abandoned", heldReason: "screen" }),
      ]);
      expectNothingWritten();
      // Nothing left to flush — the queue was cleared, not merely reported.
      expect(await flushScreenHeldSends(AGENT)).toEqual([]);
    });

    it("is a no-op when nothing is held", () => {
      expect(() => abandonScreenHeldSends(AGENT)).not.toThrow();
    });
  });
});
