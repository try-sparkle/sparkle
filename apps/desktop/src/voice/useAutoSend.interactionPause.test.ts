// @vitest-environment jsdom
//
// THE FOUNDER'S REPORT, ENFORCED (bead sparkle-wfwypy):
//
//   *"when I start by talking, and then I start typing in the compose window, it's not pausing the
//    auto send. So if I start to type there's something already in the compose window from me,
//    having spoken It should pause the auto send and then reevaluate it."*
//
// He asked explicitly for this to be enforced in the product rather than promised, so each of the
// three claims he made gets its own describe block below:
//
//   1. a deliberate interaction PAUSES the countdown — for typing, caret gestures and mention picks,
//      through the one shared predicate rather than a per-gesture branch;
//   2. when the interaction settles the countdown RE-EVALUATES — a full fresh threshold recomputed
//      from the current draft, NOT the remainder it was holding when the keys started moving;
//   3. it CANNOT FIRE while an interaction is in flight, however long the user takes.
//
// ── WHAT MAKES THESE ROWS NON-VACUOUS ─────────────────────────────────────────────────────────
// Every row here asserts a SIDE EFFECT that was available before the change and read the other way:
// `onFire` (the message actually leaving) and `remainingFraction` (the fill the user watches). The
// pre-change behaviour is a send, so a row that passed against the old code would have to catch a
// send that no longer happens. The "would have fired" comments name the instant each row is pinned
// against, and `it fires on the ORIGINAL schedule with no interaction` is the paired positive
// control — without it, every not-fired assertion below is equally satisfied by a countdown that is
// simply broken.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { thresholdMs } from "./confidence";
import { TYPED_EDIT_MIN_THRESHOLD_MS } from "./sendMode";

const HIGH = thresholdMs("high");

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("../analytics", () => ({ capture: vi.fn() }));

import { useDictationStore } from "../stores/dictationStore";
import { useAutoSend } from "./useAutoSend";
import { resetAutoSendTelemetry } from "./autoSendTelemetry";
import {
  NO_COMPOSE_INTERACTION,
  TYPING_SETTLE_MS,
  noteComposeInteraction,
  type ComposeInteractionKind,
} from "./composeInteraction";

/** A clean sentence — scores `high`, so the un-floored threshold is the ladder's fastest rung. */
const DONE = "Deploy the staging branch.";

type Props = Parameters<typeof useAutoSend>[0];

function setup(overrides: Partial<Props> = {}) {
  const onFire = vi.fn(() => true);
  const base: Props = {
    armed: true,
    autoSend: true,
    micLive: true,
    composedText: DONE,
    composingMention: false,
    attachPickerOpen: false,
    draftGrewSeq: 0,
    composeInteraction: NO_COMPOSE_INTERACTION,
    interim: "",
    targetName: "Concierge",
    onFire,
    onAnnounce: vi.fn(),
  };
  const props = { ...base, ...overrides };
  const view = renderHook((p: Props) => useAutoSend(p), { initialProps: props });
  const update = (next: Partial<Props>) =>
    act(() => {
      Object.assign(props, next);
      view.rerender({ ...props });
    });
  /** The user made a gesture in the compose window. Bumps the seq exactly as the host does. */
  const interact = (kind: ComposeInteractionKind) =>
    update({ composeInteraction: noteComposeInteraction(props.composeInteraction, kind) });
  return { onFire, update, interact, ...view };
}

function speechEnds() {
  act(() => {
    useDictationStore.getState().noteSpeechEnd();
  });
}

async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useDictationStore.setState({ speechEndSeq: 0, onDeviceSpeech: false });
  resetAutoSendTelemetry();
});

afterEach(() => {
  resetAutoSendTelemetry();
  vi.useRealTimers();
});

describe("(1) a deliberate compose-window interaction PAUSES the countdown", () => {
  // THE POSITIVE CONTROL. Every row in this file asserts that something did NOT send, and all of
  // them would pass just as well against a countdown that never fires at all. This is the row that
  // says the clock works when nobody touches it, so the others mean something.
  it("fires on the ORIGINAL schedule when nothing is touched — the control", async () => {
    const { onFire } = setup();
    speechEnds();
    await tick(HIGH + 100);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["TYPING — the founder's report", "edit" as const],
    ["a CARET gesture — arrowing back through the sentence", "caret" as const],
    ["picking a name off the @-mention list", "mention" as const],
  ])("%s freezes it", async (_label, kind) => {
    const { onFire, interact } = setup();
    speechEnds();
    // Deliberately BEFORE the deadline the control above just proved fires at HIGH.
    await tick(HIGH - 200);
    expect(onFire).not.toHaveBeenCalled();
    interact(kind);
    // Sail straight past that deadline. Pre-change, the send went out here mid-edit.
    await tick(400);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("HALTS THE VISIBLE FILL, not merely the send — what he confirms by eye", async () => {
    // The fill and the deadline are one fact (autoSendTimer `clockAt`). A guard on the fire branch
    // alone would leave the bar draining to empty while nothing happened, which reads as a broken
    // countdown rather than a held one — and would send the instant the pause lifted.
    const { result, interact } = setup();
    speechEnds();
    await tick(HIGH / 2);
    interact("edit");
    const frozen = result.current.remainingFraction;
    expect(frozen).toBeGreaterThan(0);
    expect(frozen).toBeLessThan(1);
    await tick(TYPING_SETTLE_MS / 2);
    expect(result.current.remainingFraction).toBe(frozen);
  });

  it("keeps the two PRE-EXISTING triggers working — one predicate, not a replacement", async () => {
    // `composingMention` and `attachPickerOpen` moved into `interactionInFlight` alongside the new
    // term. Folding three terms into one rule is exactly where a working trigger gets dropped.
    for (const term of ["composingMention", "attachPickerOpen"] as const) {
      const { onFire, update } = setup();
      speechEnds();
      await tick(HIGH - 200);
      update({ [term]: true });
      await tick(400);
      expect(onFire, `${term} must still pause`).not.toHaveBeenCalled();
      update({ [term]: false });
    }
  });
});

describe("(2) when typing stops the countdown RE-EVALUATES — it does not resume", () => {
  it("grants a FULL fresh threshold, not the 200ms it was holding", async () => {
    const { onFire, interact } = setup();
    speechEnds();
    // 200ms short of the deadline…
    await tick(HIGH - 200);
    interact("edit");
    // …type, then stop and let the gesture settle.
    await tick(TYPING_SETTLE_MS);
    expect(onFire).not.toHaveBeenCalled();
    // A LITERAL RESUME WOULD FIRE HERE — it had 200ms left and 300 have passed. This is the row
    // that tells re-evaluation from resumption, and the one the founder asked for by name.
    await tick(300);
    expect(onFire).not.toHaveBeenCalled();
    // It is counting a whole fresh threshold instead — floored, because the draft is hand-edited.
    await tick(TYPED_EDIT_MIN_THRESHOLD_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("FLOORS a hand-edited draft at the typed minimum, above the speech ladder's fast lane", async () => {
    // `DONE` ends in a period, so the speech ladder scores it `high` — 1.2s. That rung was earned by
    // Deepgram's own segmentation and is not honest about a sentence somebody just typed a period
    // onto: firing 1.2s after the last keystroke is the original complaint one gesture later.
    expect(HIGH).toBeLessThan(TYPED_EDIT_MIN_THRESHOLD_MS);
    const { onFire, interact } = setup();
    speechEnds();
    interact("edit");
    await tick(TYPING_SETTLE_MS);
    // Past the ladder's rung for this text, and still holding.
    await tick(HIGH + 100);
    expect(onFire).not.toHaveBeenCalled();
    await tick(TYPED_EDIT_MIN_THRESHOLD_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("does NOT floor a draft the user only LOOKED at — a caret move is not an edit", async () => {
    // The paired negative. Without it, "floored" is indistinguishable from "every interaction slows
    // the rail down", and the ladder's fast lane would be quietly dead for dictated messages.
    const { onFire, interact } = setup();
    speechEnds();
    interact("caret");
    await tick(TYPING_SETTLE_MS);
    // Same instant the row above was still holding at — here it must have gone.
    await tick(HIGH + 100);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates against the CURRENT draft, not the one that was dictated", async () => {
    // "Recompute the delay from the current content." A dangling conjunction typed onto the end
    // must earn its own (longer) rung on the way out of the pause, not the one the sentence had.
    const { onFire, interact, update } = setup();
    speechEnds();
    await tick(HIGH - 200);
    update({ composedText: "Deploy the staging branch and" });
    interact("edit");
    await tick(TYPING_SETTLE_MS);
    // `verylow` is 10s x pace; the floored typed minimum is far below it. Neither has elapsed.
    await tick(TYPED_EDIT_MIN_THRESHOLD_MS + 100);
    expect(onFire).not.toHaveBeenCalled();
  });
});

describe("(3) it cannot fire while an interaction is IN FLIGHT", () => {
  it("survives a long burst of typing — every keystroke re-arms the hold", async () => {
    const { onFire, interact } = setup();
    speechEnds();
    // Twelve keystrokes half a settle-window apart: 6s of wall clock, five times the ladder's rung
    // for this text and well past the floored typed minimum. Nothing may go out.
    for (let i = 0; i < 12; i++) {
      interact("edit");
      await tick(TYPING_SETTLE_MS / 2);
    }
    expect(onFire).not.toHaveBeenCalled();
    // And it is HELD, not broken: it still sends once he actually stops. The settle and the
    // countdown are advanced SEPARATELY on purpose — a single `advanceTimersByTime` spanning both
    // never lets React re-render between them, so the resume the settle schedules cannot land and
    // the clock stays frozen for the whole span. That is an artifact of batched fake timers, not of
    // the rail; real time gives React its commit. Rolling them into one call here would assert the
    // artifact and report a working countdown as broken.
    await tick(TYPING_SETTLE_MS);
    await tick(TYPED_EDIT_MIN_THRESHOLD_MS + 100);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("holds indefinitely while a picker is open, then re-evaluates from full on close", async () => {
    // The stateful half of the predicate has no settle window — it is held by an observable edge.
    const { onFire, update } = setup();
    speechEnds();
    update({ attachPickerOpen: true });
    await tick(60_000);
    expect(onFire).not.toHaveBeenCalled();
    update({ attachPickerOpen: false });
    await tick(HIGH + 100);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("a keystroke arriving ONE MILLISECOND before the deadline still wins", async () => {
    // The narrowest margin the pause has to hold: he reaches for the keyboard with 1ms left. Note
    // the deadline itself is not the edge case — a countdown that reaches it with nobody typing
    // SHOULD send, and the control in (1) pins exactly that. What must not happen is the send going
    // out from under a hand that got there first, however late.
    const { onFire, interact } = setup();
    speechEnds();
    await tick(HIGH - 1);
    expect(onFire).not.toHaveBeenCalled();
    interact("edit");
    // Straight through the instant it would have fired, and on to the end of the settle window.
    await tick(TYPING_SETTLE_MS - 1);
    expect(onFire).not.toHaveBeenCalled();
  });
});
