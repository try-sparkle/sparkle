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
