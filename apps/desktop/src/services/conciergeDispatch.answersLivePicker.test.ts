// `answersLivePicker` — "would this text be taken as an answer to a picker on screen right now?"
//
// It exists because the concierge compose box has to know the disposition BEFORE it builds a
// payload. `attachedPayload` prefixes the quoted temp paths of any staged attachment onto the text,
// and every arm of `matchAnswerToOption` is anchored (`YES_WORDS` is `^…$`), so with a file staged
// and a picker up, "Yes" reached the dispatcher as `"/tmp/shot.png" Yes`, matched nothing, and came
// back `ambiguous-picker` — draft and chips restored, retyping identical, no way out but guessing
// that the attachments were the problem, which the refusal copy never says.
//
// The predicate MIRRORS the dispatcher's own gate (a live-option match AND terseness). These rows
// pin that mirroring in both directions: if the two drift, the box builds the wrong payload for
// exactly the states this exists to catch.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { screen } = vi.hoisted(() => ({ screen: { text: "" } }));
vi.mock("../pty", () => ({
  writePtyChainedStrict: vi.fn(async () => {}),
  submitPrompt: vi.fn(async () => {}),
  PtyGoneError: class extends Error {},
}));
vi.mock("./terminalScrollback", () => ({ getAgentScrollback: () => screen.text }));
vi.mock("./trialMeter", () => ({ trialSendAllowed: () => true, recordTrialSend: vi.fn() }));

import {
  answersLivePicker,
  isTerseAnswer,
  liveOptionsFor,
  matchAnswerToOption,
} from "./conciergeDispatch";
import { attachedPayload } from "./conciergeAttach";
import type { Attachment } from "../components/composer/attachments";

// Two REAL screens, run through the REAL detector rather than a hand-built option list — the two
// picker shapes match by different arms of `matchAnswerToOption`, and only one of them takes a
// bare "Yes".
/** A y/n prompt. Detected as Approve/Deny with `y\n` / `n\n` values, so the yes/no FAMILY arm
 *  matches: "Yes" answers it. */
const YN = "Do you want to continue? (y/n) ";
/** A Claude Code numbered picker. Its labels carry the detector's own ordinal — "1 · Yes" — which
 *  `isAffirmative` strips before testing, so both the option NUMBER and a whole-phrase yes answer
 *  it (bead sparkle-voudj7; before that fix only the number did, which is what left the BLOCKED
 *  row's Approve button unable to answer a permission prompt). */
const NUMBERED = [
  "Bash command",
  "  rm -rf build/",
  "",
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again",
  "  3. No, and tell Claude what to do",
  "",
  "Esc to cancel · Tab to amend · ctrl+e to explain",
].join("\n");

const shot: Attachment = { id: "s1", kind: "image", path: "/tmp/shot.png", name: "shot.png" };

beforeEach(() => {
  screen.text = YN;
});

describe("answersLivePicker", () => {
  it("is FALSE when nothing is on screen — there is no picker to answer", () => {
    screen.text = "just some build output\n";
    expect(liveOptionsFor("ag1")).toEqual([]);
    expect(answersLivePicker("ag1", "Yes")).toBe(false);
  });

  it("is TRUE for a whole-phrase yes against a live y/n prompt", () => {
    expect(liveOptionsFor("ag1").length).toBeGreaterThan(0); // the fixture really is a picker
    expect(answersLivePicker("ag1", "Yes")).toBe(true);
  });

  it("is TRUE for a bare option number against a numbered picker", () => {
    screen.text = NUMBERED;
    expect(answersLivePicker("ag1", "2")).toBe(true);
  });

  // ══ REVERSED, BECAUSE IT WAS PINNING A DEFECT (bead sparkle-voudj7) ═════════════════════════
  // This row used to assert FALSE and called that "deliberate": a numbered picker's labels are
  // "1 · Yes", `isAffirmative` tested `^yes\b` against the WHOLE label including the detector's own
  // ordinal, so nothing matched. But `detectClaudeCodePicker` is the only thing that ever produces
  // these labels, and it ALWAYS prefixes them — so the `^yes\b` arm could not fire on the single
  // most common picker in the app, and the fixtures that "proved" it worked were hand-built as
  // `{ label: "Yes" }`, a shape production cannot emit.
  //
  // What made it expensive rather than merely untidy: the BLOCKED row's Approve button sends the
  // literal word "approve", a `YES_WORDS` member, so it fell through to `ambiguous-picker` on
  // exactly the dialogs it exists to answer. `isAffirmative` now strips the detector's ordinal, so
  // a whole-phrase yes answers a numbered picker the way a human reading it would expect.
  it("is TRUE for a bare yes against a NUMBERED picker, matching the dispatcher", () => {
    screen.text = NUMBERED;
    expect(answersLivePicker("ag1", "Yes")).toBe(true);
  });

  // …AND IT PRESSES THE NARROW ONE. This fixture offers two affirmatives — "1 · Yes" and
  // "2 · Yes, and don't ask again" — and they are not interchangeable: the second grants standing
  // permission for every later invocation. A yes-family answer must never be able to spend that.
  it("presses the bare Yes, never 'Yes, and don't ask again'", () => {
    screen.text = NUMBERED;
    const opts = liveOptionsFor("ag1");
    expect(opts.map((o) => o.label)).toEqual([
      "1 · Yes",
      "2 · Yes, and don't ask again",
      "3 · No, and tell Claude what to do",
    ]);
    expect(matchAnswerToOption("yes", opts)?.value).toBe("1\n");
    expect(matchAnswerToOption("approve", opts)?.value).toBe("1\n");
    // Order is not what protects this: reversing the two affirmatives must still pick the bare one.
    expect(matchAnswerToOption("yes", [opts[1]!, opts[0]!, opts[2]!])?.value).toBe("1\n");
    // And the deny family still reaches the negative option through the same ordinal strip.
    expect(matchAnswerToOption("no", opts)?.value).toBe("3\n");
  });

  // The dispatcher refuses an INSTRUCTION that merely opens with a yes word, because collapsing
  // "yes, but rename the flag first" onto `y\r` throws the rest of the sentence away. The predicate
  // has to agree, or the box would strip the attachments off a message that is not a picker answer.
  it("is FALSE for an instruction that merely starts with a yes word", () => {
    expect(isTerseAnswer("yes, but rename the flag first", liveOptionsFor("ag1"))).toBe(false);
    expect(answersLivePicker("ag1", "yes, but rename the flag first")).toBe(false);
  });

  it("is FALSE for an out-of-range option number", () => {
    screen.text = NUMBERED;
    expect(answersLivePicker("ag1", "9")).toBe(false);
  });

  it("is FALSE for empty text", () => {
    expect(answersLivePicker("ag1", "")).toBe(false);
  });

  // THE bug, stated directly: this is what the compose box used to send, and why the predicate has
  // to be consulted BEFORE the payload is built rather than after.
  it("shows why the attachment prefix had to be suppressed", () => {
    const prefixed = attachedPayload("Yes", [shot]);
    expect(prefixed).toContain("/tmp/shot.png"); // the payload really does carry the path
    // The bare answer is taken; the same answer wearing a path prefix is not.
    expect(answersLivePicker("ag1", "Yes")).toBe(true);
    expect(answersLivePicker("ag1", prefixed)).toBe(false);
  });

  it("leaves the text untouched when nothing is staged, so the normal path is unchanged", () => {
    expect(attachedPayload("Yes", [])).toBe("Yes");
    expect(answersLivePicker("ag1", attachedPayload("Yes", []))).toBe(true);
  });
});
