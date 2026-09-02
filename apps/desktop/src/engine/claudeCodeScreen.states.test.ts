// EVERY STATE THIS PREDICATE MUST SERVE, NAMED — bead sparkle-ekoeo.
//
// ══ THE DEFECT CLASS THIS FILE EXISTS TO CLOSE ══════════════════════════════════════════════════
// `isClaudeCodeScreen` is a CONTENT-BASED SAFETY PREDICATE with one family held MANDATORY (family
// D, the composer box) plus corroboration. The permission dialog — the single state where a human
// most needs to reach a blocked agent — is exactly the state that REMOVES the composer box, because
// the dialog is what replaces it. So the carve-out meant to serve that state was structurally
// incapable of firing: an approval screen scored one family, failed `>= 2`, and read as a foreign
// full-screen app. The suite did not catch it. It did worse — it PINNED the refusal
// (`expect(isClaudeCodeScreen(APPROVAL_2_1_220)).toBe(false)`) and called both roads a correct
// answer, which documented a total outage of picker answering as intended behaviour.
//
// A verdict-shaped test cannot see that. `toBe(false)` is a perfectly good assertion about a
// pager, an editor, and an approval dialog alike; nothing in its text says which of those the
// caller is entitled to have served. The bead's remedy is therefore about the SHAPE of the suite,
// not about one more case:
//
//   • ENUMERATE THE STATES the feature must serve, and assert the predicate over a CAPTURED fixture
//     for each. A fixture that returns false in a state the caller must handle is a DESIGN DEFECT,
//     not a safe default.
//   • NAME THE STATE in the test, not merely the verdict — "the approval dialog, whose box is gone"
//     is reviewable; "returns false" is not.
//   • Make the enumeration NON-OPTIONAL, or it decays the moment someone captures a new screen. The
//     last block here fails when a captured fixture is not classified by any table below, so a
//     state cannot enter this repo unexamined — which is precisely how the approval dialog sat
//     unasked while its fixture was already on disk.
//
// ══ WHY THE THREE TABLES ARE NOT ONE ════════════════════════════════════════════════════════════
// `SERVED` and `REFUSED` are the two verdicts. `NOT_SERVED_HERE` is the interesting third: a real
// Claude Code state this predicate deliberately does NOT recognise, because the evidence genuinely
// is not on the screen — and which is therefore only acceptable while ANOTHER guard serves it. Each
// of those rows asserts BOTH halves. Asserting the `false` alone would be the original mistake
// wearing a new comment; asserting the other guard alongside it is what turns a hole into a
// documented boundary, and what goes red if that other guard ever stops covering the state.
import { describe, expect, it } from "vitest";
import {
  claudeCodeMarkerFamilies,
  hasClaudeCodeComposerBox,
  isClaudeCodeScreen,
} from "./claudeCodeScreen";
import { screenOffersAnswer } from "./screenAnswerable";
import * as captured from "./capturedScreens.fixture";
import * as onboardingFixtures from "./onboardingScreens.fixture";
import * as incident from "./incidentScreens.fixture";

const {
  APPROVAL_2_1_220,
  APPROVAL_OPTION_2_2_1_220,
  ASK_USER_QUESTION_2_1_220,
  MODEL_PICKER_2_1_220,
  SESSION_LIMIT_PICKER,
  IDLE_AFTER_TURN_2_1_220,
  PERSISTENT_CHROME_TAIL_2_1_220,
  CLAUDE_COMPOSER_WRAPPED_TEXT_2_1_231,
  CLAUDE_COMPOSER_PADDED_TEXT_2_1_231,
  CLAUDE_COMPOSER_PASTED_TEXT_2_1_231,
  PLAN_MODE_COMPOSER_2_1_237,
  PLAN_MODE_SETTLED_2_1_237,
  ACCEPT_EDITS_COMPOSER_2_1_237,
  BYPASS_COMPOSER_2_1_237,
  MANUAL_MODE_COMPOSER_2_1_237,
  VIM_ON_A_MARKDOWN_FILE,
  LESS_ON_A_MARKDOWN_FILE,
} = captured;

const {
  ONBOARDING_THEME_PICKER_2_1_229,
  ONBOARDING_LOGIN_METHOD_2_1_229,
  SECURITY_NOTES_2_1_229,
  LOGIN_SUCCESS_CONTINUE_2_1_229,
} = onboardingFixtures;

const { FOOTER_ONLY_SCREEN } = incident;

/** One row of an enumeration: the FIXTURE NAME (so the exhaustiveness check below can key on it),
 *  the STATE in the words a reader would use to describe the pane, and the snapshot. */
type StateRow = readonly [fixture: string, state: string, snapshot: string];

// ══ THE STATES THIS PREDICATE MUST SERVE ════════════════════════════════════════════════════════
// Read this list as the answer to "what can a Claude Code pane be showing when a human tries to
// reach it?" Every row is a captured screen, and every row must be TRUE — a false here means the
// concierge refuses that pane as a foreign full-screen app and the human is told to quit an app
// that does not exist.
const SERVED: readonly StateRow[] = [
  // ── The states that REMOVE the composer box. This is the bead. ────────────────────────────────
  ["APPROVAL_2_1_220", "a Bash permission dialog, waiting on yes/no", APPROVAL_2_1_220],
  [
    "APPROVAL_OPTION_2_2_1_220",
    "the same permission dialog after ↓, with 'No' highlighted",
    APPROVAL_OPTION_2_2_1_220,
  ],
  ["ASK_USER_QUESTION_2_1_220", "an AskUserQuestion picker", ASK_USER_QUESTION_2_1_220],
  ["MODEL_PICKER_2_1_220", "the /model picker", MODEL_PICKER_2_1_220],
  ["SESSION_LIMIT_PICKER", "the session-limit picker", SESSION_LIMIT_PICKER],
  [
    "FOOTER_ONLY_SCREEN",
    "a permission dialog whose options have scrolled off, leaving only its footer",
    FOOTER_ONLY_SCREEN,
  ],
  // ── The ordinary composer states. ─────────────────────────────────────────────────────────────
  ["IDLE_AFTER_TURN_2_1_220", "an idle prompt after a finished turn", IDLE_AFTER_TURN_2_1_220],
  [
    "PERSISTENT_CHROME_TAIL_2_1_220",
    "the persistent chrome tail alone, as it renders under any live dialog",
    PERSISTENT_CHROME_TAIL_2_1_220,
  ],
  [
    "CLAUDE_COMPOSER_WRAPPED_TEXT_2_1_231",
    "a composer holding a soft-wrapped message",
    CLAUDE_COMPOSER_WRAPPED_TEXT_2_1_231,
  ],
  [
    "CLAUDE_COMPOSER_PADDED_TEXT_2_1_231",
    "a composer holding a message with a reserved blank row",
    CLAUDE_COMPOSER_PADDED_TEXT_2_1_231,
  ],
  [
    "CLAUDE_COMPOSER_PASTED_TEXT_2_1_231",
    "a composer holding a paste, with the chrome bar replaced by the paste hint",
    CLAUDE_COMPOSER_PASTED_TEXT_2_1_231,
  ],
  // ── The permission MODES, whose status bars family C did not know. ────────────────────────────
  ["PLAN_MODE_COMPOSER_2_1_237", "a prompt in plan mode", PLAN_MODE_COMPOSER_2_1_237],
  ["PLAN_MODE_SETTLED_2_1_237", "a settled plan-mode prompt with no effort row", PLAN_MODE_SETTLED_2_1_237],
  ["ACCEPT_EDITS_COMPOSER_2_1_237", "a prompt in accept-edits mode", ACCEPT_EDITS_COMPOSER_2_1_237],
  ["BYPASS_COMPOSER_2_1_237", "a prompt in bypass-permissions mode", BYPASS_COMPOSER_2_1_237],
  ["MANUAL_MODE_COMPOSER_2_1_237", "a prompt in manual mode", MANUAL_MODE_COMPOSER_2_1_237],
];

// ══ THE STATES THAT MUST STAY REFUSED ═══════════════════════════════════════════════════════════
// A false positive here is a line pasted AND SUBMITTED into whatever owns the screen. `less` on
// AGENTS.md is the adversarial one: the document it is paging QUOTES Claude Code's own chrome, so
// every widening above has to keep clearing it on POSITION rather than on wording.
const REFUSED: readonly StateRow[] = [
  ["VIM_ON_A_MARKDOWN_FILE", "a real vim session, where typed text runs as commands", VIM_ON_A_MARKDOWN_FILE],
  [
    "LESS_ON_A_MARKDOWN_FILE",
    "a real less pager on a document that quotes Claude Code's chrome",
    LESS_ON_A_MARKDOWN_FILE,
  ],
];

// ══ REAL CLAUDE CODE, DELIBERATELY NOT SERVED BY THIS PREDICATE ═════════════════════════════════
// Claude Code's ONBOARDING screens are unmistakably Claude Code to a human and carry ZERO marker
// families to this predicate: no tool glyph, no busy line, no chrome bar, no composer box. There is
// nothing on the grid that separates the theme picker from any other numbered TUI menu, so
// recognising them here would mean recognising ANY full-screen app — which is the one widening this
// module's header rules out outright.
//
// That is only tolerable because the answer path does not run through this predicate:
// `screenOffersAnswer` reads the menu itself, and it serves all four. Each row asserts BOTH facts.
// If the second ever goes false, onboarding has become a state NOTHING serves — which is this
// bead's defect returning through a different door, and this is where it goes red.
const NOT_SERVED_HERE: readonly StateRow[] = [
  ["ONBOARDING_THEME_PICKER_2_1_229", "the onboarding theme picker", ONBOARDING_THEME_PICKER_2_1_229],
  [
    "ONBOARDING_LOGIN_METHOD_2_1_229",
    "the onboarding login-method picker",
    ONBOARDING_LOGIN_METHOD_2_1_229,
  ],
  ["SECURITY_NOTES_2_1_229", "the onboarding security-notes screen", SECURITY_NOTES_2_1_229],
  [
    "LOGIN_SUCCESS_CONTINUE_2_1_229",
    "the login-success screen asking for Enter",
    LOGIN_SUCCESS_CONTINUE_2_1_229,
  ],
];

describe("the states isClaudeCodeScreen must serve", () => {
  it.each(SERVED.map((r) => [r[1], r[2]] as const))("serves %s", (_state, snapshot) => {
    expect(isClaudeCodeScreen(snapshot)).toBe(true);
  });

  // ══ THE BEAD, STATED AS THE THING THE OLD RULE COULD NOT DO ═══════════════════════════════════
  // Not "the dialog is recognised" — that alone would also pass under a predicate that happened to
  // find a composer box on it. This asserts the dialog is served WHILE the mandatory family is
  // absent and the corroboration bar is unmet: no composer box, one marker family, `>= 2` failed.
  // Reinstating the box as a precondition, or restoring the `>= 2` bar in front of the live-dialog
  // arm, turns exactly these two rows red and nothing else in the suite would notice.
  it.each([
    ["the approval dialog with 'No' highlighted", APPROVAL_OPTION_2_2_1_220],
    ["the /model picker", MODEL_PICKER_2_1_220],
  ])("serves %s even though the dialog has REPLACED the composer box", (_state, snapshot) => {
    expect(hasClaudeCodeComposerBox(snapshot)).toBe(false);
    expect(claudeCodeMarkerFamilies(snapshot)).toBe(1);
    expect(isClaudeCodeScreen(snapshot)).toBe(true);
  });

  it.each(REFUSED.map((r) => [r[1], r[2]] as const))("refuses %s", (_state, snapshot) => {
    expect(isClaudeCodeScreen(snapshot)).toBe(false);
  });

  it.each(NOT_SERVED_HERE.map((r) => [r[1], r[2]] as const))(
    "does not recognise %s — and the answer path still serves it",
    (_state, snapshot) => {
      expect(isClaudeCodeScreen(snapshot)).toBe(false);
      expect(screenOffersAnswer(snapshot)).toBe(true);
    },
  );
});

// ══ THE ENUMERATION IS NOT OPTIONAL ═════════════════════════════════════════════════════════════
// The approval dialog's fixture existed BEFORE the outage and nothing asked this predicate about
// it. Prose asking a future author to keep the tables above complete would have failed the same
// way, so the completeness is asserted instead: every captured screen in this repo is a state some
// agent was really in, and each must be classified as served, refused, or served-elsewhere.
//
// Classifying a new screen is one line. If it is Claude Code and returns false, that is the design
// defect this bead is about — widen the predicate or name the guard that serves it; do not add the
// row to REFUSED to quiet this test.
describe("every captured screen is classified", () => {
  const CLASSIFIED = new Set([...SERVED, ...REFUSED, ...NOT_SERVED_HERE].map(([fixture]) => fixture));

  /** Only the whole-screen fixtures. The modules also export line FRAGMENTS (footer wordings, hint
   *  lines) as arrays, which are not screens and have no verdict to state. */
  const screenFixtures = Object.entries({ ...captured, ...onboardingFixtures, ...incident })
    .filter(([, value]) => typeof value === "string")
    .map(([name]) => name);

  it("leaves no captured screen without a stated verdict", () => {
    const unclassified = screenFixtures.filter((name) => !CLASSIFIED.has(name));
    expect(
      unclassified,
      `Captured screen fixture(s) with no verdict in claudeCodeScreen.states.test.ts: ${unclassified.join(
        ", ",
      )}. Add each to SERVED, REFUSED or NOT_SERVED_HERE, naming the STATE it shows.`,
    ).toEqual([]);
  });

  it("names no fixture that no longer exists", () => {
    const known = new Set(screenFixtures);
    const dangling = [...CLASSIFIED].filter((name) => !known.has(name));
    expect(dangling, `Classified fixture(s) that are gone: ${dangling.join(", ")}`).toEqual([]);
  });
});
