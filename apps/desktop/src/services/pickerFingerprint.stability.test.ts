// A STATIC QUESTION MUST HASH THE SAME EVERY TIME IT IS READ (bead sparkle-saoe3).
//
// THE FIELD SYMPTOM. `select_picker_option` refused press after press with code `changed` while the
// screen showed one unmoving prompt. Two shapes, both reported the same day: consecutive
// `read_picker_options` calls on ONE static `sed` approval alternated between two fingerprints, and
// a caller that echoed back the fingerprint it had just been handed was STILL refused as `changed`
// — twice. The second shape is the diagnostic one: `selectPickerOption` re-derives the fingerprint
// from the live screen at press time, so a hash that moves on its own can never be matched, however
// promptly the caller answers. A menu the concierge could read was permanently unanswerable.
//
// THE CAUSE. `questionBlock` took a fixed QUESTION_CONTEXT_LINES window above the option run, and
// that window does not stop at the dialog. In a real session the 50-line picker window is
// SATURATED, so on a dialog with fewer than ten lines of its own above its options the context
// reached PAST the dialog's top border into the live transcript — Claude Code's spinner glyph, its
// elapsed readout and its token counter, all of which move on their own while nothing about the
// question changes.
//
// WHY THE CAPTURED APPROVAL SCREEN HID IT, and why these tests use the AskUserQuestion shape as
// well: APPROVAL_2_1_220 happens to carry exactly ten non-empty lines above its first option, so
// the old window landed one line short of the moving material and that fixture stayed stable by
// coincidence. Pinning only the shape that accidentally passes is how this survived.
//
// THE FIX these pin: the block is bounded by the dialog's OWN top rule, reported by the parser as
// `bounds.top` — never re-derived here (heuristics.ts's standing rule). Nothing above the dialog is
// hashed, so no amount of live output beneath it can move the identity of the question inside it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  APPROVAL_2_1_220,
  ASK_USER_QUESTION_2_1_220,
  MODEL_PICKER_2_1_220,
  PERSISTENT_CHROME_TAIL_2_1_220,
} from "../engine/capturedScreens.fixture";
import { detectTerminalPrompts, pickerBlockBounds } from "./suggestions/heuristics";
import { ONBOARDING_LOGIN_METHOD_2_1_229 } from "../engine/onboardingScreens.fixture";

// The one ambient read `pickerFingerprint` makes. Driving it is what lets a test move the screen
// under a caller the way a live agent does.
let screen = "";
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: () => screen }));
import { pickerFingerprint } from "./pickerFingerprint";

/** Enough prior output to SATURATE the 50-line picker window, which is the condition under which
 *  the context walk reaches past the dialog at all. A short screen clamps at index 0 and cannot
 *  reproduce this — see the header. */
const SATURATING_TRANSCRIPT = Array.from(
  { length: 40 },
  (_, i) => `⏺ Earlier turn line ${i}`,
).join("\n");

/** Claude Code's live status rows, which move on their own while a dialog is up: the spinner glyph
 *  cycles, the elapsed readout ticks, the token counter climbs. Verbatim shapes from the TUI. */
function movingStatusRows(spinner: string, elapsed: string, tokens: string): string {
  return [
    `⎿  $ sed -i '' s/a/b/ file.ts (${elapsed})`,
    `${spinner} Simmering… (${elapsed} · ↓ ${tokens} tokens · esc to interrupt)`,
  ].join("\n");
}

function screenWith(dialog: string, spinner: string, elapsed: string, tokens: string): string {
  return [
    SATURATING_TRANSCRIPT,
    movingStatusRows(spinner, elapsed, tokens),
    dialog,
    PERSISTENT_CHROME_TAIL_2_1_220,
  ].join("\n");
}

/** The fingerprints one unmoving dialog produces across three successive reads, while only the
 *  status rows ABOVE it move. `options` is read ONCE, from the first frame, exactly as a caller
 *  that read the menu and then pressed would hold it. */
function fingerprintsAcrossTicks(dialog: string): string[] {
  const frames: [string, string, string][] = [
    ["✻", "12s", "1.2k"],
    ["✽", "13s", "1.4k"],
    ["✳", "1m 20s", "2.1k"],
  ];
  screen = screenWith(dialog, ...frames[0]!);
  const options = detectTerminalPrompts(screen);
  expect(options.length).toBeGreaterThan(0);
  return frames.map((f) => {
    screen = screenWith(dialog, ...f);
    return pickerFingerprint("agent-1", options);
  });
}

describe("pickerFingerprint is stable while the question is static", () => {
  beforeEach(() => {
    screen = "";
  });

  // THE REPRODUCTION. Four non-empty lines sit above this dialog's first option, so the old
  // ten-line context walk cleared the dialog's top border by six lines and hashed the moving
  // status rows above it. Against the pre-fix code the three reads produce three different hashes.
  it("an AskUserQuestion picker hashes the same while the spinner and clock move", () => {
    const [a, b, c] = fingerprintsAcrossTicks(ASK_USER_QUESTION_2_1_220);
    expect(a).not.toBe("");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  // The /model picker's top border is `▔`, not `─`. A boundary rule that knows only one glyph
  // passes the test above and still leaves this dialog churning.
  it("the /model picker hashes the same across ticks", () => {
    const [a, b, c] = fingerprintsAcrossTicks(MODEL_PICKER_2_1_220);
    expect(a).not.toBe("");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  // The shape that accidentally passed before. Kept so the fix cannot regress it.
  it("the Bash approval dialog hashes the same across ticks", () => {
    const [a, b, c] = fingerprintsAcrossTicks(APPROVAL_2_1_220);
    expect(a).not.toBe("");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  // THE OTHER HALF OF THE PROPERTY, and the reason this is not simply "hash less material".
  //
  // A block bounded by the dialog's top border must still contain what DISTINGUISHES one ask from
  // another, or the fix trades a permanent refusal for a permanent collision — pressing a button on
  // a prompt nobody read, which is the exact failure the fingerprint exists to prevent. Two Bash
  // approvals differing only in the command they are asking about must NOT hash alike.
  it("two different asks with the same options still hash differently", () => {
    const approvalFor = (cmd: string) =>
      [
        "────────────────────────────────────────────────────────────────────────────",
        " Bash command",
        "",
        `   ${cmd}`,
        `   Run ${cmd}`,
        "",
        " Permission rule Bash requires confirmation for this command.",
        "",
        " Do you want to proceed?",
        " ❯ 1. Yes",
        "   2. No",
        "",
        " Esc to cancel · Tab to amend · ctrl+e to explain",
      ].join("\n");

    screen = screenWith(approvalFor("git status"), "✻", "12s", "1.2k");
    const options = detectTerminalPrompts(screen);
    const benign = pickerFingerprint("agent-1", options);

    screen = screenWith(approvalFor("rm -rf build/"), "✻", "12s", "1.2k");
    const destructive = pickerFingerprint("agent-1", options);

    expect(benign).not.toBe("");
    expect(destructive).not.toBe(benign);
  });

  // A moving line INSIDE the dialog is normalised rather than dropped — the standing rule in
  // `promptTextNormalize`. The elapsed readout Claude Code draws inside a long-running approval
  // must not move the identity of the question it is attached to.
  it("a clock inside the dialog does not move the fingerprint", () => {
    const withElapsed = (elapsed: string) =>
      [
        "────────────────────────────────────────────────────────────────────────────",
        " Bash command",
        "",
        "   pnpm test",
        `   Running for ${elapsed}`,
        "",
        " Do you want to proceed?",
        " ❯ 1. Yes",
        "   2. No",
        "",
        " Esc to cancel · Tab to amend · ctrl+e to explain",
      ].join("\n");

    screen = screenWith(withElapsed("1m 20s"), "✻", "12s", "1.2k");
    const options = detectTerminalPrompts(screen);
    const first = pickerFingerprint("agent-1", options);
    screen = screenWith(withElapsed("2m 40s"), "✻", "13s", "1.4k");
    expect(pickerFingerprint("agent-1", options)).toBe(first);
  });
});

// ══ THE OPTION LABEL IS SEMANTIC TOO — A MOVING SPAN INSIDE IT MUST NOT MOVE THE FINGERPRINT ════
// (bead sparkle-jniddo.)
//
// THE GAP THE TESTS ABOVE LEAVE. `fingerprintsAcrossTicks` reads the options ONCE, from the first
// frame, then re-fingerprints the SAME options array against each later screen. That pins the
// QUESTION half — which reads the live scrollback — but never the SHAPE half, because the shape is
// derived from the fixed options and cannot move when they don't. The REAL press path does not hold
// the options still: `selectPickerOption` calls `liveOptionsFor` at press time, RE-DETECTING them
// from whatever the screen shows then. So an option label that carries a moving span — Claude Code's
// per-option elapsed readout, an AskUserQuestion option quoting a size — re-detects to a different
// string at press time, the shape half churns, and the press is refused as `changed` though the menu
// is the same one. That is the deadlock the bead records, and it lives on the axis these ticks-tests
// do not drive.
//
// So this block re-detects the options from each repainted frame, the way the press path does, and
// asserts the CAPABILITY the fingerprint gates: an unchanged menu still MATCHES across the repaint
// (the press would proceed), and a genuinely different menu still does NOT (the press is still
// refused). The `changed` guard fires on `now !== expectFingerprint`, so fingerprint equality across
// the read→press window is exactly the boolean that decides whether the press is answered.
describe("the fingerprint survives a repaint that moves a span INSIDE an option label", () => {
  beforeEach(() => {
    screen = "";
  });

  /** A numbered picker whose FIRST option carries a live elapsed readout. The question and the set
   *  of options are static; only the clock inside option 1 ticks between repaints. Bordered, so the
   *  question half is already pinned by `bounds.top` — isolating the option-label axis. */
  const rebuildDialog = (elapsed: string) =>
    [
      "────────────────────────────────────────────────────────────────────────────",
      " Rebuild preview?",
      "",
      " Do you want to proceed?",
      ` ❯ 1. Yes, rebuild now (last build ${elapsed})`,
      "   2. No, keep the current preview",
      "",
      " Esc to cancel · Tab to amend",
    ].join("\n");

  /** Read the options from ONE frame and fingerprint them, exactly as `read_picker_options` does. */
  function readFingerprint(dialog: string, spinner: string, elapsed: string, tokens: string): string {
    screen = screenWith(dialog, spinner, elapsed, tokens);
    return pickerFingerprint("agent-1", detectTerminalPrompts(screen));
  }

  it("an UNCHANGED menu re-detected at press time still matches the read (press would PROCEED)", () => {
    // READ: the caller reads the menu and holds this fingerprint.
    const read = readFingerprint(rebuildDialog("1m 20s"), "✻", "12s", "1.2k");
    expect(read).not.toBe("");

    // PRESS: the screen repainted — the spinner and clock above the dialog moved AND the elapsed
    // readout inside option 1 ticked — and the press re-derives the fingerprint from the live screen,
    // just as `selectPickerOption` does before comparing it to what the caller echoed back.
    const atPress = readFingerprint(rebuildDialog("2m 40s"), "✽", "13s", "1.4k");

    // The `changed` refusal fires on inequality; equality here is the press proceeding. Against the
    // pre-fix code (raw, un-steadied option label) these differ and the menu is unanswerable.
    expect(atPress).toBe(read);
  });

  it("a GENUINELY CHANGED menu still does NOT match — the protection is not weakened (press REFUSED)", () => {
    // Same option shape, DIFFERENT question — a distinct ask that must never be answered with a
    // fingerprint read from the first. This is the paired half: steadying the volatile span must not
    // collapse two different asks onto one hash.
    const read = readFingerprint(rebuildDialog("1m 20s"), "✻", "12s", "1.2k");

    const differentAsk = [
      "────────────────────────────────────────────────────────────────────────────",
      " Delete build cache?",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes, rebuild now (last build 1m 20s)",
      "   2. No, keep the current preview",
      "",
      " Esc to cancel · Tab to amend",
    ].join("\n");
    screen = screenWith(differentAsk, "✻", "12s", "1.2k");
    const atPress = pickerFingerprint("agent-1", detectTerminalPrompts(screen));

    expect(read).not.toBe("");
    expect(atPress).not.toBe("");
    expect(atPress).not.toBe(read);
  });

  it("two options differing ONLY in real (non-volatile) label text still hash differently", () => {
    // The narrow correctness claim under the fix: `steady` removes moving SPANS, not real words. Two
    // menus whose option 2 names a different target must stay distinguishable, or a press could land
    // on a button nobody read.
    const menu = (target: string) =>
      [
        "────────────────────────────────────────────────────────────────────────────",
        " Choose a target",
        "",
        " Do you want to proceed?",
        " ❯ 1. Yes",
        `   2. Deploy to ${target}`,
        "",
        " Esc to cancel · Tab to amend",
      ].join("\n");

    screen = screenWith(menu("staging"), "✻", "12s", "1.2k");
    const staging = pickerFingerprint("agent-1", detectTerminalPrompts(screen));
    screen = screenWith(menu("production"), "✻", "12s", "1.2k");
    const production = pickerFingerprint("agent-1", detectTerminalPrompts(screen));

    expect(staging).not.toBe("");
    expect(production).not.toBe(staging);
  });
});

// ══ THE UPPER SIDE OF THE TOP-BORDER BOUND — THE SIDE THE DEFECT LIVES ON (roborev 63294) ═══════
// Every fixture above is a BORDERED dialog whose rule sits within `DIALOG_TOP_SPAN` of its first
// option, so all of them stay green if the bound is widened back to `PICKER_SPAN` (30). That leaves
// the actual defect untested: `DIALOG_RULE` cannot tell a dialog's border from the TUI's full-width
// transcript divider, so with a loose bound a BORDERLESS menu locks onto that divider and hashes
// every moving status row between them — the churning fingerprint the bound exists to prevent, and
// the one that made a readable menu permanently unanswerable.
//
// A borderless menu is not hypothetical: it is exactly what Claude Code's onboarding draws, which
// this same work taught the parser to accept. So the pin uses the real captured one.
describe("a borderless menu does not adopt the transcript divider as its border", () => {
  beforeEach(() => {
    screen = "";
  });

  /** The login menu with a full-width divider well above it — far enough that only a loose bound
   *  would reach up and claim it. `SATURATING_TRANSCRIPT` supplies the moving rows in between. */
  const borderlessUnderDivider = [
    "────────────────────────────────────────────────────────────────────────────",
    ...Array.from({ length: 10 }, (_, i) => `  ⏺ earlier transcript line ${i + 1}`),
    ONBOARDING_LOGIN_METHOD_2_1_229,
  ].join("\n");

  it("reports no top border rather than the divider above it", () => {
    const bounds = pickerBlockBounds(borderlessUnderDivider);
    expect(bounds).not.toBeNull();
    // -1 is the honest answer, and it is what sends `questionBlock` to its own bounded fallback
    // instead of hashing everything down from the divider.
    expect(bounds!.top).toBe(-1);
  });

  it("and so keeps one fingerprint while the status rows above it move", () => {
    expect(new Set(fingerprintsAcrossTicks(borderlessUnderDivider)).size).toBe(1);
  });
});

// ══ ARROWING A BOXED MENU MUST NOT MOVE THE FINGERPRINT (roborev 74270, High) ═══════════════════
// Claude Code draws EVERY dialog boxed, so a real option row reads `│ ❯ 1. Local files`. The
// pointer strip in `questionBlock` was anchored at `^\s*[❯›>]`, which never matches a row that
// starts with `│` — so the moving pointer stayed in the hashed material and merely ARROWING changed
// two lines of the block.
//
// That is not cosmetic. `verifiedPickerPress` re-derives the fingerprint from the CURRENT screen
// and compares it to the one taken BEFORE the arrow walk, so on a boxed dialog the two disagreed
// and the press took the `blocked-prompt` arm: arrows landed, highlight moved, nothing ticked,
// press refused — the very defect the multi-select fix exists to remove.
//
// The existing suite could not see it: its widget fixture renders UNBOXED rows, where the old strip
// does succeed. So this test asserts on BOXED material specifically.
describe("a boxed menu's fingerprint survives the cursor walk", () => {
  beforeEach(() => {
    screen = "";
  });

  /** A boxed multi-select dialog with the pointer on `at`, drawn the way Claude Code draws it. */
  const boxedMenu = (at: number): string =>
    [
      SATURATING_TRANSCRIPT,
      "╭──────────────────────────────────────────╮",
      "│ Which sources should I read?             │",
      "│                                          │",
      ...["Local files", "The web", "Both"].map(
        (label, i) => `│ ${i === at ? "❯" : " "} ${i + 1}. [ ] ${label}`.padEnd(43) + "│",
      ),
      "╰──────────────────────────────────────────╯",
    ].join("\n");

  it("moving the pointer between boxed rows leaves the fingerprint UNCHANGED", () => {
    screen = boxedMenu(0);
    const options = detectTerminalPrompts(screen);
    expect(options.length).toBeGreaterThan(0); // the fixture must actually parse, or this is vacuous

    const atTop = pickerFingerprint("agent-1", options);
    screen = boxedMenu(1);
    const atSecond = pickerFingerprint("agent-1", options);
    screen = boxedMenu(2);
    const atThird = pickerFingerprint("agent-1", options);

    expect(atSecond).toBe(atTop);
    expect(atThird).toBe(atTop);
  });

  it("PAIRED: a changed QUESTION on the same boxed shape still moves the fingerprint", () => {
    // Otherwise the assertion above would be satisfied by a fingerprint that ignores the box
    // entirely — stability is only meaningful beside a demonstration that identity still bites.
    screen = boxedMenu(0);
    const options = detectTerminalPrompts(screen);
    const before = pickerFingerprint("agent-1", options);
    screen = boxedMenu(0).replace("Which sources should I read?", "Delete every source?        ");
    const after = pickerFingerprint("agent-1", options);
    expect(after).not.toBe(before);
  });
});
