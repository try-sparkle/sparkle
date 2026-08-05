// THE PICKER DETECTOR AND THE WRITE GUARD MUST AGREE ABOUT `(yes/no)`.
//
// ══ WHY THIS FILE EXISTS ════════════════════════════════════════════════════════════════════════
// Two modules match the same shape for opposite purposes:
//   • `suggestions/heuristics`' `YN` — "this is a confirmation the dispatcher can ANSWER".
//   • `voice/dictationTerminalRoute`'s `YES_NO_PROMPT` — "this is a prompt free text must not be
//     pasted into".
// `services/conciergeDispatch` reconciles them: it refuses the prompt UNLESS the detector reports
// the y/n pair, in which case it answers instead.
//
// That reconciliation is only sound while the two agree about what a `(yes/no)` screen IS. When they
// drifted apart it cost SIX review rounds (roborev 58512 → 58575), every one the same shape — a
// screen one of them recognised and the other did not, or the same screen read over a different
// region. Rounds 5 and 6 fixed the mechanism; PR #1296 documented the coupling in both files.
//
// A COMMENT IS THE WEAKEST FORM OF THAT GUARANTEE — nothing enforces it, and the previous rounds
// prove prose does not survive contact with a refactor. This is the enforceable form: ONE corpus,
// both predicates, and the agreement asserted per screen. Widen or narrow either pattern and a row
// here goes red naming the screen that changed meaning.
import { describe, expect, it } from "vitest";

import { YN, detectTerminalPrompts } from "./heuristics";
import { screenIsYesNoPrompt } from "../../voice/dictationTerminalRoute";

/** Does the DETECTOR consider this screen an answerable y/n confirmation? Asked the way
 *  `conciergeDispatch` asks it — through the real detector and the shape of what comes back, not by
 *  re-testing `YN` here, which would assert the regex against itself rather than against the branch
 *  order that decides whether `YN` is ever reached. */
function detectorOffersYesNo(screen: string): boolean {
  const options = detectTerminalPrompts(screen);
  return options.length === 2 && options.every((o) => /^[yn]\n?$/.test(o.value));
}

/** Screens where BOTH must say yes: a live confirmation, answerable and unsafe for free text. */
const LIVE_CONFIRMATIONS: Array<[name: string, screen: string]> = [
  ["a bare y/n", "Overwrite the existing branch? (y/n) "],
  ["a spelled-out yes/no", "Overwrite existing config? (yes/no) "],
  ["bracketed", "Continue? [y/n] "],
  ["bracketed and spelled out", "Continue? [yes/no] "],
  // The prompt with one line of chatter under it — still within both tails.
  ["with a trailing line", "Overwrite existing config? (yes/no)\nWaiting for response…"],
  // ══ WHITESPACE AND HARD WRAP (roborev 58717) ═══════════════════════════════════════════════════
  // A first cut widened the SPELLING and silently dropped the `\s*` classes, which was the same hole
  // in the other axis. These are the forms that went unguarded:
  ["space-padded", "Overwrite the branch? ( yes / no ) "],
  ["space-padded short form", "Overwrite the branch? ( y / n ) "],
  // THE ONE THAT MATTERS MOST. `screenTail` joins rows with a SPACE, so a prompt hard-wrapped by a
  // narrow column reaches both predicates looking like this — and the unspaced token matched none of
  // it. This file's guard header calls xterm hard-wrap in user-resizable columns a recurring miss
  // mode, and it was one again.
  ["hard-wrapped across rows", "Overwrite the existing branch? (yes\n/no) "],
];

/** Screens where BOTH must say no: the string is present but nothing is waiting on it. */
const NOT_PROMPTS: Array<[name: string, screen: string]> = [
  ["a plain shell prompt", "$ "],
  [
    // The case that made the guard refuse every write on a pane showing documentation.
    "documentation ABOVE a live shell prompt",
    "The guard matches (yes/no) on screens like this one.\nThat is prose, not a prompt.\n\n\n\n\n$ ",
  ],
  [
    "a busy Claude Code that merely quotes the shape",
    [
      "⏺ Reading the guard's source.",
      "  ⎿  it matches screens like (yes/no) — documentation, not a prompt",
      "     (ctrl+b to run in background)",
      "",
      "",
      "",
      "",
      "❯ ",
    ].join("\n"),
  ],
];

describe("the picker detector and the write guard agree about (yes/no)", () => {
  it.each(LIVE_CONFIRMATIONS)("both recognise %s", (_name, screen) => {
    expect(detectorOffersYesNo(screen)).toBe(true);
    expect(screenIsYesNoPrompt(screen)).toBe(true);
  });

  it.each(NOT_PROMPTS)("neither is fooled by %s", (_name, screen) => {
    expect(detectorOffersYesNo(screen)).toBe(false);
    expect(screenIsYesNoPrompt(screen)).toBe(false);
  });

  // ══ THE ASYMMETRY THAT IS DELIBERATE, STATED SO IT CANNOT DRIFT SILENTLY ═══════════════════════
  // ssh's host-key prompt carries `(yes/no)` and the DETECTOR matches it — but it is not
  // picker-answerable: ssh requires the literal word `yes` while Approve sends `y`, so answering it
  // would report a delivery ssh rejected. `conciergeDispatch` keeps it blocked through
  // `screenIsCredentialField`'s `SSH_HOST_KEY` arm rather than through disagreement here.
  //
  // So this is the ONE screen where the two predicates agreeing is not enough, and the row exists to
  // say that out loud: if someone later "fixes" the agreement by teaching one side to reject ssh,
  // they will have moved the protection out of the arm that actually carries it.
  it("agrees about ssh's host-key prompt — which is blocked elsewhere, not by disagreement", () => {
    const HOSTKEY =
      "The authenticity of host 'x (1.2.3.4)' can't be established.\n" +
      "Are you sure you want to continue connecting (yes/no/[fingerprint])? ";
    expect(detectorOffersYesNo(HOSTKEY)).toBe(true);
    expect(screenIsYesNoPrompt(HOSTKEY)).toBe(true);
  });

  // The regex itself, pinned separately from the branch order above. `detectTerminalPrompts` reaches
  // `YN` only after the menu branches decline, so a corpus row can pass because a BRANCH changed
  // rather than because the pattern did — this row tells those two apart.
  it.each(LIVE_CONFIRMATIONS)("YN itself still matches %s", (_name, screen) => {
    const lines = screen.split("\n").filter((l) => l.trim().length > 0);
    expect(YN.test(lines.slice(-2).join("\n"))).toBe(true);
  });
});
