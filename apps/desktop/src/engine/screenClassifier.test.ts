import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { screenAwaitsInput, isSessionLimitPicker, PICKER_FOOTER } from "./screenClassifier";
import {
  APPROVAL_2_1_220,
  APPROVAL_OPTION_2_2_1_220,
  ASK_USER_QUESTION_2_1_220,
  MODEL_PICKER_2_1_220,
  IDLE_AFTER_TURN_2_1_220,
  NON_PICKER_HINT_LINES_2_1_220,
  OTHER_PICKER_FOOTERS_2_1_220,
  SESSION_LIMIT_PICKER,
} from "./capturedScreens.fixture";

// These fixtures are plain-text snapshots of the *rendered* terminal screen (the visible
// xterm grid, ANSI already resolved) — exactly what `snapshotScreen()` hands the engine.
// `screenAwaitsInput` must return true ONLY when Claude (or a shell) is blocked on a
// specific answer from the user, and false for a finished turn sitting at the idle prompt.

describe("screenAwaitsInput", () => {
  it("flags Claude's permission box (❯ numbered choice menu)", () => {
    const screen = [
      "╭──────────────────────────────────────────────────╮",
      "│ Edit file                                          │",
      "│ src/foo.ts                                         │",
      "│                                                    │",
      "│ Do you want to make this edit to foo.ts?           │",
      "│ ❯ 1. Yes                                           │",
      "│   2. Yes, allow all edits this session             │",
      "│   3. No, and tell Claude what to do differently    │",
      "╰──────────────────────────────────────────────────╯",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(true);
  });

  it("flags a plan-mode selection menu", () => {
    const screen = [
      "Would you like to proceed?",
      "❯ 1. Yes, and auto-accept edits",
      "  2. Yes, and manually approve edits",
      "  3. No, keep planning",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(true);
  });

  it("flags an AskUserQuestion menu (same ❯ numbered shape as the permission box) — sparkle-blpf", () => {
    // AskUserQuestion / ExitPlanMode are not intercepted by Sparkle — they render as Claude Code's
    // standard bordered ❯ numbered selection menu in the PTY, so the selection-cursor marker catches
    // them deterministically (no LLM needed). This pins that the question-tool shape stays red.
    const screen = [
      "╭─ Which date library should we use? ─────────────────╮",
      "│ ❯ 1. date-fns                                       │",
      "│   2. luxon                                          │",
      "│   3. dayjs                                          │",
      "╰─────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(true);
  });

  it("flags a command-approval prompt via its footer even when the cursor glyph is '>' (not ❯)", () => {
    // The founder-report bug: a blocked-on-approval agent showed GREEN/gray instead of RED because
    // the cursor rendered as ">" (not ❯), so the selection-cursor marker missed it. The picker
    // FOOTER is glyph-independent, so it catches the prompt regardless. Note: footer has NO
    // "Tab to amend" (Claude drops it when the highlighted option isn't the amendable "Yes").
    const screen = [
      "This command requires approval",
      "",
      "Do you want to proceed?",
      "  1. Yes",
      '> 2. Yes, and don\'t ask again for: echo "---- retry exit: $? ----"',
      "  3. No",
      "",
      "Esc to cancel · ctrl+e to explain",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(true);
  });

  it("flags a command-approval prompt whose footer keeps 'Tab to amend' (cursor on option 1)", () => {
    const screen = [
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. Yes, and don't ask again for: roborev show *",
      "  3. No",
      "",
      "Esc to cancel · Tab to amend · ctrl+e to explain",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(true);
  });

  it("does NOT flag prose that merely mentions 'esc to cancel' OR 'ctrl+e to explain' alone", () => {
    // The footer anchor requires BOTH phrases on one line, so an incidental prose mention of either
    // (a changelog note, a help snippet) must not trip a false red.
    expect(screenAwaitsInput("Tip: press esc to cancel the current operation.")).toBe(false);
    expect(screenAwaitsInput("The ctrl+e to explain shortcut opens the explainer.")).toBe(false);
  });

  it("flags a shell (y/n) prompt", () => {
    expect(screenAwaitsInput("Overwrite existing file? (y/n)")).toBe(true);
    expect(screenAwaitsInput("Continue? [Y/n]")).toBe(true);
  });

  it("flags a 'press enter to continue' prompt", () => {
    expect(screenAwaitsInput("Press enter to continue…")).toBe(true);
  });

  it("flags an ssh passphrase / password prompt", () => {
    expect(screenAwaitsInput("Enter passphrase for key '/Users/me/.ssh/id_ed25519':")).toBe(
      true,
    );
    expect(screenAwaitsInput("Password:")).toBe(true);
  });

  it("does NOT flag the idle input box (finished turn, awaiting your next prompt)", () => {
    const screen = [
      "╭────────────────────────────────────────────────────╮",
      "│ >                                                    │",
      "╰────────────────────────────────────────────────────╯",
      "  ? for shortcuts",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(false);
  });

  it("does NOT flag a conversational numbered list Claude wrote as prose", () => {
    // Claude listing options in chat is not a blocking TUI prompt — the turn ended and
    // it's awaiting your normal reply (gray), not a specific selection (red). The tell is
    // the absence of the ❯ selection cursor.
    const screen = [
      "Here are three approaches:",
      "1. Hybrid spinner + screen classifier",
      "2. Send everything to Haiku",
      "3. Pure regex",
      "Let me know which direction you'd like.",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(false);
  });

  it("does NOT flag prose that mentions a question mid-sentence", () => {
    const screen = [
      "I considered whether to proceed with the risky migration, but decided",
      "the safer path was to add a guard first. Done — tests pass.",
      "╭────────────────────────────────────────────────────╮",
      "│ >                                                    │",
      "╰────────────────────────────────────────────────────╯",
    ].join("\n");
    expect(screenAwaitsInput(screen)).toBe(false);
  });

  it("returns false on an empty snapshot", () => {
    expect(screenAwaitsInput("")).toBe(false);
    expect(screenAwaitsInput("   \n  \n")).toBe(false);
  });
});

// ── Regression pins against REAL Claude Code 2.1.220 screens ────────────────────────────────
// Everything below runs against verbatim captured viewports (see capturedScreens.fixture.ts for
// the capture recipe). They exist because the previous drift was found by a human noticing that
// agents looked calm — the cost of a missed picker is that the human is never told an agent is
// waiting on them, so the marker needs a test that fails the moment the TUI moves.
describe("screenAwaitsInput — captured Claude Code 2.1.220 screens", () => {
  it("flags the Bash command-approval dialog (footer: Esc to cancel · Tab to amend · ctrl+e to explain)", () => {
    expect(screenAwaitsInput(APPROVAL_2_1_220)).toBe(true);
    expect(PICKER_FOOTER.test(" Esc to cancel · Tab to amend · ctrl+e to explain")).toBe(true);
  });

  it("flags the approval dialog with the cursor on option 2", () => {
    expect(screenAwaitsInput(APPROVAL_OPTION_2_2_1_220)).toBe(true);
  });

  it("flags the AskUserQuestion picker (footer: Enter to select · ↑/↓ to navigate · Esc to cancel)", () => {
    expect(screenAwaitsInput(ASK_USER_QUESTION_2_1_220)).toBe(true);
    expect(PICKER_FOOTER.test("Enter to select · ↑/↓ to navigate · Esc to cancel")).toBe(true);
  });

  it("flags the /model picker, whose footer shares NO literal with the other two", () => {
    // "Enter to set as default · s to use this session only · Esc to cancel" — no "Enter to
    // select", no "ctrl+e to explain". A literal-anchored footer marker misses it entirely, which
    // is why the marker is matched by shape.
    expect(
      PICKER_FOOTER.test("   Enter to set as default · s to use this session only · Esc to cancel"),
    ).toBe(true);
    expect(screenAwaitsInput(MODEL_PICKER_2_1_220)).toBe(true);
  });

  it("does NOT flag a finished turn at the idle input box", () => {
    expect(screenAwaitsInput(IDLE_AFTER_TURN_2_1_220)).toBe(false);
  });

  it("does NOT flag ambient chrome or prose that carries '·'-separated key hints", () => {
    // The false-GREEN guard's mirror: a marker loose enough to match the persistent
    // permission-mode bar (or an "Update installed · Restart to apply" toast) pins every agent
    // red forever, which trains the human to ignore red.
    for (const line of NON_PICKER_HINT_LINES_2_1_220) {
      expect(PICKER_FOOTER.test(line), `PICKER_FOOTER must not match: ${line}`).toBe(false);
      expect(screenAwaitsInput(line), `screenAwaitsInput must not flag: ${line}`).toBe(false);
    }
  });

  it("flags the OTHER footers 2.1.220 can draw, including the diff-review approval bar", () => {
    // "Enter to approve · r to retry · ↑/↓ to navigate · Esc to cancel" is a blocking approval,
    // and the old literal-anchored marker missed it too — a second false-calm case.
    for (const footer of OTHER_PICKER_FOOTERS_2_1_220) {
      expect(PICKER_FOOTER.test(footer), `PICKER_FOOTER must match: ${footer}`).toBe(true);
      expect(screenAwaitsInput(footer), `screenAwaitsInput must flag: ${footer}`).toBe(true);
    }
  });

  it("knowingly does NOT flag two hint bars that are not blocking dialogs", () => {
    // Recorded, not accidental. The first is the slash-command autocomplete, drawn WHILE the
    // human types — they are already at the keyboard, so it needs no red. The second is the
    // /tui settings screen, whose segments aren't "<key> to <verb>" at all ("Enter save").
    // If either ever needs to go red, that is a deliberate widening, not a silent drift.
    expect(PICKER_FOOTER.test("Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear")).toBe(
      false,
    );
    expect(
      PICKER_FOOTER.test("Scroll to feel it · ←/→ adjust · r reset to auto · Enter save · Esc cancel"),
    ).toBe(false);
  });

  it("does NOT flag a lone key hint, however footer-like, without a second one", () => {
    // One hint is how prose and single-purpose chrome read ("Press Esc to cancel"); a dialog
    // footer always offers at least two.
    expect(PICKER_FOOTER.test("Esc to cancel")).toBe(false);
    expect(PICKER_FOOTER.test("   ● High effort (default) ←/→ to adjust")).toBe(false);
    expect(PICKER_FOOTER.test(" /permissions to update rules")).toBe(false);
  });

  // roborev 54749b: `to cycle` was REMOVED from the disqualifier, and these tests are what make that
  // removal a decision instead of a drift. The finding's complaint was that rule 2 is a literal
  // denylist bolted onto a matcher whose thesis is "literals drift, match by shape", and that it was
  // UNPROVEN: every pinned line carrying `to cycle` ALSO carries `to interrupt`, so nothing in the
  // suite failed when `to cycle` was deleted — and, measured, nothing failed when the whole
  // lookahead was deleted either. All three legs of that trade are pinned below.
  describe("rule 2 (the `to …` disqualifier) is pinned to what it actually buys", () => {
    it("drops `to cycle` because rule 1 rejects the permission-mode bar UNAIDED", () => {
      // The only real chrome we have carrying `to cycle` is the permission-mode bar, and it also
      // says "esc to interrupt" — so the full line proves nothing about WHICH rule rejected it.
      // Stripped of that segment, it is still rejected, and only rule 1 can be doing it: the line
      // opens on "▶▶", which is not a key atom, and `^[ \t]*[│|┃]?[ \t]*` admits nothing else.
      // That is the whole justification for dropping `to cycle`; if it ever stops holding, this
      // goes red rather than the removal quietly becoming a false red on a running agent.
      expect(PICKER_FOOTER.test("▶▶ bypass permissions on (shift+tab to cycle) · PR #730")).toBe(
        false,
      );
    });

    it("drops `to cycle` because it is a plausible verb for a REAL blocking footer", () => {
      // CONSTRUCTED, not captured — flagged as such deliberately. The shape argument is the
      // evidence: the sibling footers in OTHER_PICKER_FOOTERS_2_1_220 use "to switch", "to
      // navigate" and "to adjust" for exactly this move-between-options affordance, so "to cycle"
      // sits squarely inside the space Claude already draws from. Denylisting it blanks the ENTIRE
      // line on one segment — false calm on a dialog, which this file's header calls strictly worse
      // than a false red. No "enter to select…cancel" pair here on purpose, so FOOTER_LEGACY cannot
      // match and this pins the SHAPE arm specifically. Re-add `to cycle` and this goes red.
      const footer = "shift+tab to cycle modes · ↑/↓ to navigate · Esc to cancel";
      expect(PICKER_FOOTER.test(footer)).toBe(true);
      expect(screenAwaitsInput(footer)).toBe(true);
    });

    it("keeps `to interrupt` because it ALONE rejects an all-hints spinner bar", () => {
      // The same "don't keep an untested guard" standard, applied to the verb that survived. Every
      // other line pinned against rule 2 opens on a non-key glyph ("▶▶", "✻", "⏸") and so is already
      // rejected by rule 1 — which is why the entire lookahead could be deleted with the suite still
      // green. This line is the case that is NOT true of: every segment IS a well-formed
      // "<key> to <verb>" hint, so rule 1 admits it and only rule 2 stands between a RUNNING turn
      // and a false red. Delete the lookahead and this goes red.
      const spinnerBar = "esc to interrupt · ctrl+t to show todos";
      expect(PICKER_FOOTER.test(spinnerBar)).toBe(false);
      expect(screenAwaitsInput(spinnerBar)).toBe(false);
    });
  });

  // roborev 54749: the "to interrupt" disqualifier must be scoped to ONE RENDERED LINE.
  //
  // `m` makes ^/$ break on \r as well as \n, but the lookahead was written `[^\n]*`, which scans
  // across \r. The ingest path is where that bites: statusEngine splits chunks only on \n and hands
  // the classifier `this.partial` — the unterminated in-place-redraw tail, whose shape is
  // "frame\rframe\rframe". So a footer in the first frame was suppressed by a spinner in a LATER
  // frame, i.e. a false GRAY on an agent that is actually blocked on a dialog. That is the failure
  // direction the shape matcher exists to eliminate, so it is pinned here per-footer rather than by
  // a single example.
  describe("a \\r redraw frame must not suppress a footer from an earlier frame", () => {
    const SPINNER_FRAME = "✻ Thinking… (12s · ↑ 1.2k tokens · esc to interrupt)";

    for (const footer of OTHER_PICKER_FOOTERS_2_1_220) {
      it(`keeps matching ${JSON.stringify(footer.slice(0, 44))}… before a spinner frame`, () => {
        // Sanity: the footer alone matches, so a failure below is the \r leak and nothing else.
        expect(PICKER_FOOTER.test(footer)).toBe(true);
        expect(PICKER_FOOTER.test(`${footer}\r${SPINNER_FRAME}`)).toBe(true);
        // And in the other order — the tail is what statusEngine actually forwards.
        expect(PICKER_FOOTER.test(`${SPINNER_FRAME}\r${footer}`)).toBe(true);
      });
    }

    it("still suppresses a spinner frame on its OWN line", () => {
      // The disqualifier must keep doing its job within one line; scoping it to \r must not have
      // widened what counts as a picker.
      expect(PICKER_FOOTER.test(SPINNER_FRAME)).toBe(false);
      expect(screenAwaitsInput(SPINNER_FRAME)).toBe(false);
    });
  });
});

// ── isSessionLimitPicker ────────────────────────────────────────────────────────────────────────
//
// The one classifier whose answer PIERCES hook authority and whose reason code is a machine
// trigger, so its false-positive discipline is what these tests are mostly about. Three independent
// gates (co-presence, bottom-anchoring, two distinct remedy topics) — each is pinned below by
// removing exactly that gate from a screen the function otherwise accepts.

/** This repo's copy of the frozen contract. Read at TEST TIME so the assertion tracks the real
 *  file rather than a copy of it that drifts the moment someone edits the doc. */
const CONTRACT_DOC = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../PRD/sparkle/claude-account-identity-truth.md");

describe("isSessionLimitPicker", () => {
  it("flags a real session-limit viewport", () => {
    expect(isSessionLimitPicker(SESSION_LIMIT_PICKER)).toBe(true);
  });

  it("does NOT flag it when prose continues beneath it (the bottom-anchored rule)", () => {
    // The gate that keeps this function off documents, diffs and reviews that QUOTE the screen: a
    // live Ink dialog is the last thing on the grid, a quotation never is. Everything else about
    // this input is byte-identical to the accepted one above, so only anchoring can explain the
    // difference.
    const quoted = [
      SESSION_LIMIT_PICKER,
      "",
      "That is the screen the whole fleet was parked on. The classifier must not fire on this",
      "paragraph, or reviewing this file would pin the reviewer's own agent red.",
    ].join("\n");
    expect(isSessionLimitPicker(quoted)).toBe(false);
    // …and a bare code fence beneath it is enough, too — the common shape in a markdown file.
    expect(isSessionLimitPicker(`${SESSION_LIMIT_PICKER}\n\`\`\``)).toBe(false);
  });

  it("does NOT flag the frozen contract's own de-fanged reproduction of the screen", () => {
    // PRD §6c makes this a REQUIRED test, and the alarm it arms is specific: if a future edit puts
    // the live glyph or the real footer back into that fenced block, an agent that reviews the PRD
    // streams a live trigger through its own terminal and flags itself. This test is what goes red
    // first. Read out of the file so it cannot pass against a stale copy.
    const doc = readFileSync(CONTRACT_DOC, "utf8");
    const section = doc.slice(doc.indexOf("## 6. ADDENDUM"));
    // Guard against a vacuous pass: if the section or the block is ever restructured away, fail
    // here rather than quietly asserting `false` about an empty string.
    expect(section).not.toBe("");
    const block = /```\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
    expect(block).toContain("What do you want to do?");
    expect(isSessionLimitPicker(block)).toBe(false);
    // Stronger, and the actual guarantee the doc claims: the de-fanged block reads as no prompt at
    // all — neither the selection cursor nor the footer survives the de-fanging.
    expect(screenAwaitsInput(block)).toBe(false);
    // And the document as a whole is not a picker either (its last line is prose, not a footer).
    expect(isSessionLimitPicker(doc)).toBe(false);
  });

  it("does NOT flag any other captured picker", () => {
    // Every one of these is a genuine blocking dialog — `screenAwaitsInput` says true for all of
    // them. Only the session-limit one may pierce a frozen hook or arm a machine keystroke.
    for (const screen of [APPROVAL_2_1_220, APPROVAL_OPTION_2_2_1_220, ASK_USER_QUESTION_2_1_220, MODEL_PICKER_2_1_220]) {
      expect(screenAwaitsInput(screen)).toBe(true); // a real blocking dialog…
      expect(isSessionLimitPicker(screen)).toBe(false); // …but not THIS one
    }
    expect(isSessionLimitPicker(IDLE_AFTER_TURN_2_1_220)).toBe(false);
  });

  it("does NOT flag ambient chrome that merely mentions credits or a limit", () => {
    for (const line of NON_PICKER_HINT_LINES_2_1_220) expect(isSessionLimitPicker(line)).toBe(false);
    // The two nearest misses in the wild, verbatim from the 2.1.220 bundle.
    expect(isSessionLimitPicker("Usage credits are off · /usage-credits to turn them on")).toBe(false);
    expect(isSessionLimitPicker("← or → to adjust · Del to remove limit")).toBe(false);
  });

  it("requires the selection cursor — a menu nobody is sitting on is not it", () => {
    const noCursor = SESSION_LIMIT_PICKER.replace("❯ 1.", "  1.");
    expect(noCursor).not.toBe(SESSION_LIMIT_PICKER); // the substitution really landed
    expect(isSessionLimitPicker(noCursor)).toBe(false);
  });

  it("requires the picker footer", () => {
    const noFooter = SESSION_LIMIT_PICKER.replace(" Enter to confirm · Esc to cancel", " (limit reached)");
    expect(PICKER_FOOTER.test(noFooter)).toBe(false);
    expect(isSessionLimitPicker(noFooter)).toBe(false);
  });

  it("requires TWO distinct remedies, so one stray option line cannot carry it", () => {
    const oneRemedy = SESSION_LIMIT_PICKER.replace("   2. Switch to usage credits", "   2. Keep going").replace(
      "   3. Switch to Team plan",
      "   3. Cancel",
    );
    expect(oneRemedy).not.toContain("usage credits");
    expect(isSessionLimitPicker(oneRemedy)).toBe(false);
  });

  it("requires the options to be in the same frame as the footer, not far up the viewport", () => {
    const scrolledApart = SESSION_LIMIT_PICKER.replace(
      "\n\n Enter to confirm · Esc to cancel",
      `\n${Array(20).fill("⏺ …then twenty lines of transcript scrolled past.").join("\n")}\n Enter to confirm · Esc to cancel`,
    );
    expect(scrolledApart).not.toBe(SESSION_LIMIT_PICKER); // the substitution really landed
    expect(scrolledApart).toContain("Enter to confirm · Esc to cancel"); // …and the footer survived it
    expect(isSessionLimitPicker(scrolledApart)).toBe(false);
  });

  it("requires the RESET option — the two billing labels alone are not this screen", () => {
    // The mandatory label, and the one that exists on no other Claude Code picker. "Switch to usage
    // credits" and "Switch to Team plan" are generic enough to belong to some future settings
    // dialog, and this predicate gates a machine-initiated pane restart — so two billing labels
    // must not be able to carry it on their own.
    //
    // This is also the case that proves the delegation is live rather than decorative: the topic
    // matcher this file used to carry returned true here, while `hasSessionLimitOptions` (and the
    // Rust twin's `the_billing_options_without_the_reset_option_are_not_a_picker`) return false.
    const billingOnly = SESSION_LIMIT_PICKER.replace(
      " ❯ 1. Stop and wait for limit to reset",
      " ❯ 1. Keep the current plan",
    );
    expect(billingOnly).toContain("usage credits"); // the substitution left the billing labels alone
    expect(billingOnly).toContain("Team plan");
    expect(isSessionLimitPicker(billingOnly)).toBe(false);
  });

  it("the cursor must be on an OPTION ROW OF THIS DIALOG, not merely somewhere on the grid", () => {
    // Tested against the whole snapshot, an unrelated permission menu still in the viewport
    // satisfied the gate for a picker nobody was highlighted on. "A menu nobody is sitting on
    // cannot qualify" is the claim; this is the case that makes it true.
    const noHighlight = SESSION_LIMIT_PICKER.replace(" ❯ 1. Stop and", "   1. Stop and");
    const withStrayCursor = ["❯ 1. Yes", "  2. No", "", noHighlight].join("\n");
    expect(withStrayCursor).toContain("❯ 1."); // precondition: a cursor IS on the grid
    expect(isSessionLimitPicker(withStrayCursor)).toBe(false);
    // …and the same frame WITH its own highlight restored still classifies, so the assertion above
    // is about where the cursor is and not about the substitution having broken something else.
    expect(isSessionLimitPicker(["❯ 1. Yes", "  2. No", "", SESSION_LIMIT_PICKER].join("\n"))).toBe(true);
  });

  it("agrees with the Rust port on a `\\r`-framed grid", () => {
    // `nudge_gate::lines` splits on BOTH `\n` and `\r`, because the PTY redraws in place and a chunk
    // can carry several frames separated by carriage returns alone. Every rule here is line-INDEX
    // arithmetic, so a TS side that split on `/\r?\n/` would collapse the dialog into one array
    // element, find no footer below the options, and answer false while Rust answered TRUE — a
    // disagreement that hands out the Esc exemption on a screen this classifier never recognised.
    const crFramed = SESSION_LIMIT_PICKER.replace(/\n/g, "\r");
    expect(crFramed).not.toContain("\n"); // the substitution really landed
    expect(isSessionLimitPicker(crFramed)).toBe(true);
    // CRLF too — the character class yields Rust's empty element for each pair, so indices match.
    expect(isSessionLimitPicker(SESSION_LIMIT_PICKER.replace(/\n/g, "\r\n"))).toBe(true);
  });

  it("is false for an empty or whitespace screen", () => {
    expect(isSessionLimitPicker("")).toBe(false);
    expect(isSessionLimitPicker("   \n\n  ")).toBe(false);
  });

  it("THERE IS EXACTLY ONE MATCHER — this file spells no option literal of its own", () => {
    // Two independent implementations of this predicate briefly existed: one here, keyed on topic
    // regexes, and one in `services/sessionLimitScreen.ts`, keyed on the labels. Only the second is
    // read by `nudge_gate.rs`'s `ported_typescript_patterns_have_not_drifted`, so a widening of the
    // first would have been invisible to the test that keeps the Rust escape exemption honest — and
    // the Rust exemption is what licenses a keystroke at a BILLING dialog.
    //
    // So the labels live in exactly one module and this one delegates. Asserted against the source
    // because the failure mode is a well-meaning future edit that re-inlines "just this one
    // literal" for readability; a behavioural test cannot see that at all.
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "screenClassifier.ts"), "utf8");
    // The option ROWS are a regex shape, and that shape belongs to the shared module. Asserted on
    // the shape rather than on the words so this stays a delegation test and not a spelling test:
    // the header comment may (and does) describe the screen, and explain the shared anchor, in prose.
    //
    // COMMENTS ARE STRIPPED FIRST, and that is not a convenience — it is the difference between a
    // test about the code and a test about the documentation. Without it this assertion fired on
    // the header's own explanation of why a `//` prefix cannot match the anchor, which is exactly
    // the kind of prose the file should be free to carry.
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(code, "the option-row regex belongs in sessionLimitScreen.ts, not here").not.toMatch(
      /\[❯›\]\?\\s\*\\d\+\\\./,
    );
    // …and it really does delegate: the shared module is imported by value, not merely by type.
    expect(src).toMatch(/import \{[\s\S]*?hasSessionLimitOptions[\s\S]*?\} from "\.\.\/services\/sessionLimitScreen"/);
  });

  it("READING THIS FILE DOES NOT ARM THE FEATURE — no viewport of it is the picker", () => {
    // The same guarantee PRD §6 carries for the contract doc, and it matters MORE here: this file is
    // read, diffed and reviewed constantly, and its header draws the screen it exists to recognise.
    // A source copy that classified true would mean the agent reviewing the matcher pierces its own
    // row to `waiting` and becomes a candidate for an automated pane restart.
    //
    // WHAT THIS TEST CAN AND CANNOT CATCH (measured with two hand-mutations, not assumed):
    //   • Restoring the live `❯` and the real footer in the header comment — STAYS GREEN. The `//`
    //     prefix defeats every option pattern on its own, so that edit is not actually a hazard and
    //     this test rightly does not claim to catch it.
    //   • Injecting the same block as a template literal, with no `//` — GOES RED at the viewport
    //     ending on its footer. That is the real hazard shape (a fixture or example landing in this
    //     file), and it is what this test guards.
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "screenClassifier.ts"), "utf8");
    expect(src).toContain("What do you want to do?"); // guard against a vacuous pass
    expect(isSessionLimitPicker(src)).toBe(false);
    // NOT asserted: `screenAwaitsInput(src) === false`. It is true, and legitimately so — this file
    // documents three OTHER picker footers verbatim (see PICKER_FOOTER) and that exposure predates
    // the session-limit work by a long way. It is also bounded in a way the session-limit predicate
    // is not: `screenAwaitsInput` never pierces a frozen hook and never triggers a keystroke, so a
    // false positive there costs a red row, not a machine action on a billing dialog.
    // The strongest form, and the one that survives the file being viewed a screenful at a time:
    // no window of this source is the picker, however the viewport happens to be cut. `false` for
    // the whole file could otherwise rest entirely on the bottom-anchor rule, which a scrolled
    // viewport ending on the footer row would not have.
    const lines = src.split("\n");
    for (let end = 1; end <= lines.length; end++) {
      const window = lines.slice(Math.max(0, end - 60), end).join("\n");
      expect(isSessionLimitPicker(window), `viewport ending at line ${end} classifies as the picker`).toBe(false);
    }
  });
});
