// @vitest-environment jsdom
//
// THE EPIC'S GOAL ON THE OPENED CARD — items 11–14 of the 2026-08-20 self-interview.
//
// ══ WHAT THESE ASSERT, AND WHY IT IS THE SIDE EFFECT ═══════════════════════════════════════════
// The tempting assertions here are all preconditions: "a textarea rendered", "the placeholder
// string is present". Both are true of a field wired to nothing. So every case below asserts what
// the field DID — whether `onSetGoal` was called, with what text, and what the field shows
// afterwards — rather than that it exists.
//
// The colour case (item 14) is the one most at risk of being written vacuously. Asserting
// `color === "#somehex"` would pin the CURRENT teal and pass even if the Build It button moved to
// a different one — which is the entire content of the founder's ask ("the same color text as the
// build it button"). It is asserted as a RELATIONSHIP between the two rendered elements instead,
// so re-theming either one without the other reds it.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeadCard } from "./BeadCard";
import { newEpicGoal, type EpicGoal } from "../../engine/epicGoal";
import type { Bead } from "../../services/beads";

afterEach(() => cleanup());

function bead(over: Partial<Bead> & { id: string }): Bead {
  return {
    title: "Night Watch: a self-hosted reviewer",
    description: "",
    status: "open",
    type: "epic",
    priority: 1,
    labels: [],
    parent: null,
    commentCount: 0,
    ...over,
  };
}

const EPIC = bead({ id: "sparkle-huw924" });
const t = "epics-bead-card";

function goalOf(text: string): EpicGoal {
  return newEpicGoal(text, 1_700_000_000_000, "human");
}

function mount(over: Partial<Parameters<typeof BeadCard>[0]> = {}) {
  return render(
    <BeadCard bead={EPIC} chrome="epics" stage="planned" workers={[]} {...over} />,
  );
}

function field(): HTMLTextAreaElement {
  return screen.getByTestId(`${t}-goal`) as HTMLTextAreaElement;
}

// ── ITEM 11 + 12 — THE GOAL IS ON THE CARD, AS AN EDITABLE INPUT ────────────────────────────────

describe("the goal is visible on the opened card, as a field you can type in", () => {
  it("shows the epic's goal text", () => {
    mount({ goal: goalOf("Ship an unattended reviewer that a human never has to babysit"), onSetGoal: vi.fn() });
    expect(field().value).toBe("Ship an unattended reviewer that a human never has to babysit");
  });

  it("offers 'Set a goal' as a PLACEHOLDER on an epic that has none — not as stored text", () => {
    mount({ goal: undefined, onSetGoal: vi.fn() });
    // BOTH HALVES. A component that put the prompt in `value` would satisfy a naive "the words are
    // on screen" check and then SAVE the string "Set a goal" the first time anyone committed.
    expect(field().value).toBe("");
    expect(field().placeholder).toBe("Set a goal");
  });

  it("is not drawn at all on a surface that cannot write one", () => {
    // Callback-is-the-switch, the convention every other control on this card follows.
    mount({ goal: goalOf("A goal nobody here can edit"), onSetGoal: undefined });
    expect(screen.queryByTestId(`${t}-goal`)).toBeNull();
  });
});

// ── ITEM 12 — IT ACTUALLY WRITES ────────────────────────────────────────────────────────────────

describe("committing the field writes the goal", () => {
  it("saves on Enter, normalised, stamped as written by a HUMAN", () => {
    const onSetGoal = vi.fn();
    mount({ goal: undefined, onSetGoal });

    fireEvent.change(field(), { target: { value: "  Make the   reviewer   unattended  " } });
    fireEvent.keyDown(field(), { key: "Enter" });

    // THE SIDE EFFECT, not "the field changed". Normalisation and the authority stamp are both
    // load-bearing: `"human"` is what latches the text against the auto-generator overwriting it.
    expect(onSetGoal).toHaveBeenCalledTimes(1);
    expect(onSetGoal).toHaveBeenCalledWith("Make the reviewer unattended", "human");
  });

  it("saves on blur too, so clicking away is not a way to lose the edit", () => {
    const onSetGoal = vi.fn();
    mount({ goal: undefined, onSetGoal });

    fireEvent.change(field(), { target: { value: "Land the reviewer behind one arming flag" } });
    fireEvent.blur(field());

    expect(onSetGoal).toHaveBeenCalledWith("Land the reviewer behind one arming flag", "human");
  });

  it("refuses text the goal contract rejects, and KEEPS what was typed", () => {
    const onSetGoal = vi.fn();
    mount({ goal: undefined, onSetGoal });

    fireEvent.change(field(), { target: { value: "no" } });
    fireEvent.keyDown(field(), { key: "Enter" });

    expect(onSetGoal).not.toHaveBeenCalled();
    expect(screen.getByTestId(`${t}-goal-error`).textContent).toContain("not saved");
    // The part that matters more than the message: closing the field here would discard his words
    // while explaining why they were no good.
    expect(field().value).toBe("no");
  });
});

// ── ITEM 13 — YOU CAN GET OUT WITHOUT SAVING ────────────────────────────────────────────────────

describe("the founder can leave a goal he started typing", () => {
  // [13:27] "set a goal where I can't close the dialogue, so that shouldn't be that way."
  // [14:45] "if it doesn't have a goal and somebody starts to type one and then wants to exit out
  //          of there, they should be able to because they didn't have one before."
  it("Escape discards the draft and writes NOTHING, on an epic that had no goal", () => {
    const onSetGoal = vi.fn();
    mount({ goal: undefined, onSetGoal });

    fireEvent.change(field(), { target: { value: "Something I changed my mind about" } });
    fireEvent.keyDown(field(), { key: "Escape" });

    expect(onSetGoal).not.toHaveBeenCalled();
    expect(field().value).toBe("");
  });

  it("Escape also restores the PRIOR goal, so an epic that had one is not trapped either", () => {
    // The gate in the founder's phrasing was "because they didn't have one before". Reverting
    // unconditionally is strictly more permissive and cannot lose anything — but it has to be
    // asserted, because the narrower reading would rebuild the exact trap on this branch.
    const onSetGoal = vi.fn();
    mount({ goal: goalOf("The goal this epic already had"), onSetGoal });

    fireEvent.change(field(), { target: { value: "a half-typed replacement" } });
    fireEvent.keyDown(field(), { key: "Escape" });

    expect(onSetGoal).not.toHaveBeenCalled();
    expect(field().value).toBe("The goal this epic already had");
  });

  it("blurring an UNTOUCHED empty field is not an edit — no write, and no 'empty' refusal", () => {
    // Without the unchanged-check this raises "not saved — empty" for merely clicking into the
    // field of an epic with no goal: a refusal for doing nothing, on the surface he asked to be
    // able to leave.
    const onSetGoal = vi.fn();
    mount({ goal: undefined, onSetGoal });

    fireEvent.focus(field());
    fireEvent.blur(field());

    expect(onSetGoal).not.toHaveBeenCalled();
    expect(screen.queryByTestId(`${t}-goal-error`)).toBeNull();
  });

  // ══ THE TWO CASES ABOVE NEVER FOCUS THE FIELD, AND THAT IS THE WHOLE BUG ═══════════════════════
  // `fireEvent.keyDown` does not move focus, so `ref.current?.blur()` in the Escape branch is a
  // NO-OP in those tests and `onBlur` never runs. A real user is ALWAYS focused — they got a draft
  // in there by typing — so the path they take is the one nothing above exercises.
  //
  // Focused, Escape used to SAVE the draft it exists to discard: `revert()` calls `setDraft(null)`,
  // React state updates are not synchronous, and `blur()` dispatches `onBlur` synchronously in the
  // SAME event — so `commit()` ran holding the stale non-null `draft` and wrote it. The two cases
  // above stayed green throughout, which is exactly the vacuous shape `AGENTS.md` warns about: the
  // assertion was already true before the fix, for a reason unrelated to the fix.
  //
  // These two assert the same side effect with the ONE precondition that makes it meaningful, and
  // they red against the pre-fix component.
  it("Escape discards when the field is FOCUSED — the only state a real user is ever in", () => {
    const onSetGoal = vi.fn();
    mount({ goal: undefined, onSetGoal });

    field().focus();
    // The precondition the two cases above silently lack. Without it `blur()` does nothing and
    // this test degrades into a duplicate of them.
    expect(document.activeElement).toBe(field());

    fireEvent.change(field(), { target: { value: "Something I changed my mind about" } });
    fireEvent.keyDown(field(), { key: "Escape" });

    expect(onSetGoal).not.toHaveBeenCalled();
    expect(field().value).toBe("");
  });

  it("Escape on a FOCUSED field restores the prior goal instead of overwriting it", () => {
    const onSetGoal = vi.fn();
    mount({ goal: goalOf("The goal this epic already had"), onSetGoal });

    field().focus();
    expect(document.activeElement).toBe(field());

    fireEvent.change(field(), { target: { value: "a half-typed replacement" } });
    fireEvent.keyDown(field(), { key: "Escape" });

    // The damaging half: focused, this used to persist "a half-typed replacement" over a goal the
    // founder never meant to touch — and the epic goal is an INPUT TO DISPATCH, so the overwrite
    // would then steer every worker spawned under this epic.
    expect(onSetGoal).not.toHaveBeenCalled();
    expect(field().value).toBe("The goal this epic already had");
  });

  it("a focused field that BLURS normally still commits — the fix must not deafen onBlur", () => {
    // The guard below is a one-shot armed only by Escape. If it leaked, every ordinary
    // click-away would silently discard the founder's text, which is a worse bug than the one
    // being fixed. This is the paired case that pins the guard's scope.
    const onSetGoal = vi.fn();
    mount({ goal: undefined, onSetGoal });

    field().focus();
    fireEvent.change(field(), { target: { value: "A goal I do mean to keep" } });
    fireEvent.blur(field());

    expect(onSetGoal).toHaveBeenCalledWith("A goal I do mean to keep", "human");
  });

  it("Escape then a SECOND edit still commits — the guard does not latch", () => {
    // A one-shot flag that is never cleared would disarm saving for the rest of the field's life.
    //
    // BOTH TEXTS ARE OVER `GOAL_MIN_LEN` (16) ON PURPOSE. The first draft here is discarded, so its
    // length is irrelevant — but the second is the one whose SAVE is the assertion, and a shorter
    // string is refused by `epicGoalTextRejection` before `onSetGoal` is ever reached. That failure
    // renders as "the guard latched" while the guard is fine, which cost a debugging round when a
    // 14-character second draft was used here.
    const onSetGoal = vi.fn();
    mount({ goal: undefined, onSetGoal });

    field().focus();
    fireEvent.change(field(), { target: { value: "a draft I abandoned on purpose" } });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onSetGoal).not.toHaveBeenCalled();

    field().focus();
    fireEvent.change(field(), { target: { value: "the goal I kept the second time" } });
    fireEvent.blur(field());

    expect(onSetGoal).toHaveBeenCalledWith("the goal I kept the second time", "human");
  });

  it("does not let Escape escape the CARD as well as the draft", () => {
    // The card sits in surfaces that also close on Escape. One press must peel one layer.
    const onSetGoal = vi.fn();
    mount({ goal: undefined, onSetGoal });

    fireEvent.change(field(), { target: { value: "typed then abandoned" } });
    const ev = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    field().dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
  });
});

// ── THE TWO ROBOREV MEDIUMS ────────────────────────────────────────────────────────────────────

describe("a goal that fails to save is not thrown away", () => {
  it("keeps the typed text in the field when the write REJECTS, beside the reason", async () => {
    // `commit()` clears the draft BEFORE awaiting `onSetGoal`, so the catch used to restore only
    // `optimistic` (null here) — the field snapped back to the stored goal and the sentence he had
    // just written was gone, with only an error to look at. The component already promises the
    // opposite for a validation rejection ("the field stays open holding what he typed"); a failed
    // write is no different from the typist's side.
    const onSetGoal = vi.fn().mockRejectedValue(new Error("bd write failed"));
    mount({ goal: goalOf("The goal this epic already had"), onSetGoal });

    field().focus();
    fireEvent.change(field(), { target: { value: "the replacement I typed and nearly lost" } });
    fireEvent.blur(field());

    // The error is the easy half. The half that matters is that the words survived.
    await waitFor(() => expect(screen.getByTestId(`${t}-goal-error`)).toBeTruthy());
    expect(field().value).toBe("the replacement I typed and nearly lost");
  });

  it("does not drop FOCUS while the write is in flight", async () => {
    // `disabled` blurs a focused textarea, which both yanks the caret out mid-save and re-enters
    // `onBlur`. `readOnly` refuses edits without touching focus.
    let release: (() => void) | undefined;
    const onSetGoal = vi.fn().mockReturnValue(new Promise<void>((r) => { release = r; }));
    mount({ goal: undefined, onSetGoal });

    field().focus();
    fireEvent.change(field(), { target: { value: "a goal that takes a while to save" } });
    fireEvent.keyDown(field(), { key: "Enter" });

    await waitFor(() => expect(onSetGoal).toHaveBeenCalled());
    expect(field()).toHaveProperty("readOnly", true);
    expect(document.activeElement).toBe(field());

    release?.();
  });
});

describe("a goal too long for one line is not silently clipped", () => {
  // jsdom NEVER LAYS OUT, so every measurement is 0 and the auto-grow effect is inert there by
  // design. Stubbing `scrollHeight` is what makes this assertable at all — without the stub this
  // test would pass against a component that never sizes anything, which is the vacuous shape.
  // A CONSTANT STUB CANNOT TEST SHRINKING, and a first version of this helper was one — which made
  // the shrink case below assert something that was ALREADY TRUE at mount, leaving both the
  // `[value]` dependency and the reset-to-`auto` line unpinned (roborev 66413).
  //
  // So this models the one property of a real measurement that matters here: a browser never
  // reports a `scrollHeight` SMALLER than the box it is already sized to. An explicit height keeps
  // the measurement inflated until something resets it to `auto` — which is precisely what makes
  // that reset line, and re-measurement on edit, observable from a test.
  function withMeasuredScrollHeight(initial: number) {
    let content = initial;
    const proto = window.HTMLTextAreaElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
    Object.defineProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        const explicit = parseFloat(this.style.height) || 0;
        return Math.max(content, explicit);
      },
    });
    return {
      setContent(px: number) {
        content = px;
      },
      restore() {
        if (original) Object.defineProperty(proto, "scrollHeight", original);
        else delete (proto as unknown as Record<string, unknown>).scrollHeight;
      },
    };
  }

  it("sizes the field to its content instead of showing the first line only", () => {
    const m = withMeasuredScrollHeight(72);
    try {
      mount({ goal: goalOf("A goal long enough that it wraps to several lines in a 280px column"), onSetGoal: vi.fn() });
      // 72 MEASURED + 2 BORDER. The box is `box-sizing: border-box`, so the height we write
      // includes the borders while `scrollHeight` excludes them; dropping that term leaves the
      // content 2px taller than its box, which with `overflow: auto` clips the last line forever
      // (roborev 66413). jsdom does report the two 1px widths, so this suite pins the term rather
      // than leaving it to a real-browser check.
      expect(field().style.height).toBe("74px");
    } finally {
      m.restore();
    }
  });

  it("re-measures as the text changes, so the box SHRINKS again too", () => {
    const m = withMeasuredScrollHeight(96);
    try {
      mount({ goal: goalOf("A three-line goal that will shortly be cut down to one"), onSetGoal: vi.fn() });
      expect(field().style.height).toBe("98px"); // 96 measured + 2 border

      // The content is now SHORTER. Both production lines are on trial here: the `[value]`
      // dependency (change it to `[]` and the height stays 96px) and the reset to `auto` (delete it
      // and the stub keeps reporting the stale 96, so the box never comes back down).
      m.setContent(40);
      fireEvent.change(field(), { target: { value: "one short line now" } });

      expect(field().style.height).toBe("42px"); // 40 measured + 2 border
    } finally {
      m.restore();
    }
  });

  it("leaves the field alone where nothing can be measured, rather than collapsing it to 0px", () => {
    // The guard that keeps jsdom (and any real browser where a measurement fails) from getting a
    // zero-height field. Without it every test above renders an invisible textarea.
    mount({ goal: goalOf("A goal on a surface that reports no layout at all"), onSetGoal: vi.fn() });
    expect(field().style.height).toBe("auto");
  });
});

// ── ITEM 14 — THE INK IS BUILD IT'S INK ─────────────────────────────────────────────────────────

describe("the goal text is painted in the Build It button's colour", () => {
  it("matches the button rather than a hard-coded hex", async () => {
    // [06:28] "Let's have the goal be the same color text as the build it button is."
    //
    // BOTH ELEMENTS MOUNTED AT ONCE and compared to each other. Pinning a literal would pass while
    // the two drifted apart, which is the whole failure the ask is about.
    mount({
      goal: goalOf("Ship the reviewer with nobody watching it"),
      onSetGoal: vi.fn(),
      onBuildIt: async () => {},
    });

    const buildIt = await waitFor(() => screen.getByTestId(`${t}-build-it`));
    const buildInk = buildIt.style.background;

    expect(buildInk).not.toBe("");
    expect(field().style.color).toBe(buildInk);
  });
});
