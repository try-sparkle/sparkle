// THE EPIC'S GOAL, ON THE OPENED CARD — items 11–14 of the founder's 2026-08-20 self-interview.
//
// ══ WHY THIS IS A NEW COMPONENT AND NOT `EpicGoalRow` ══════════════════════════════════════════
// `EpicGoalRow` is built from inline `<span role="button">`s that call `stopPropagation()`, and a
// PORTALED editor measured against a live anchor. Every one of those choices exists because it
// mounted INSIDE `EpicRow`'s `<button>`: it had to swallow clicks meant for itself, and it could
// not open a box in normal flow without breaking the row's single-line layout.
//
// None of that is true here. The card is not a button, so nothing needs swallowing, and there is
// room in normal flow — so this is simply an input. That difference is also the founder's item 13:
//
//   [13:27] "set a goal where I can't close the dialogue, so that shouldn't be that way."
//
// A portaled editor is a dialogue you can be trapped in. AN INPUT IS NOT A DIALOGUE — there is
// nothing to close, so the trap cannot exist here by construction rather than by remembering to
// wire an escape. Escape and blur still revert, because he also asked to be able to back out of a
// goal he started typing on an epic that had none:
//
//   [14:45] "if it doesn't have a goal and somebody starts to type one and then wants to exit out
//            of there, they should be able to because they didn't have one before."
//
// Reverting is UNCONDITIONAL rather than gated on "had no goal previously". That is strictly more
// permissive than the ask and it cannot lose anything: discarding a draft restores the stored text,
// so an epic that DID have a goal still has it. Gating would mean an epic with a goal traps you in
// the edit — the precise defect above, rebuilt one condition narrower.
//
// ══ THE INK IS BUILD IT'S INK ══════════════════════════════════════════════════════════════════
// [06:28] "Let's have the goal be the same color text as the build it button is."
// That is `C.teal`, and the Chat button already establishes the idiom of quoting it rather than
// picking a second near-teal (see BeadCard's own note). The PLACEHOLDER deliberately does not take
// it: an empty field is not a goal, and painting the prompt in the goal's colour would make "Set a
// goal" read as the goal itself.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { C, FONT_WEIGHT } from "../../theme/colors";
import { FONT_UI, RADIUS, TYPE } from "../../theme/scale";
import {
  epicGoalTextRejection,
  hasEpicGoalText,
  normalizeEpicGoalText,
  type EpicGoal,
  type EpicGoalSource,
} from "../../engine/epicGoal";

export interface EpicCardGoalProps {
  goal: EpicGoal | undefined;
  /**
   * Write the goal. `source` is an AUTHORITY statement, not a label — see
   * `projectStore.setEpicGoal` — and this component always passes `"human"`, because every edit
   * here IS a person typing. That stamps the latch which stops the generator overwriting his words.
   */
  onSetGoal: (text: string, source: EpicGoalSource) => void | Promise<void>;
  /** Prefix for this card's testids, so the epics card and the board card stay addressable apart. */
  testId: string;
}

export function EpicCardGoal({ goal, onSetGoal, testId }: EpicCardGoalProps) {
  const storedText = hasEpicGoalText(goal) ? goal.text : "";

  // THE OPTIMISTIC VALUE, on `EpicGoalRow`'s pattern and for its reason: the store write lands
  // immediately but the goal is read back through a poll-shaped path, so clearing this on success
  // would snap the field to the old text and forward again. A failed write rolls it back.
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const shown = optimistic ?? storedText;

  const [draft, setDraft] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  // ══ ESCAPE MUST NOT BE HEARD AS A BLUR ═════════════════════════════════════════════════════════
  // The Escape branch below reverts the draft and then blurs the field, and `onBlur` commits. Those
  // two facts together used to make Escape SAVE the text it exists to discard, on every press where
  // the field was actually focused — which is every press a real user makes, since typing is how the
  // draft got there.
  //
  // WHY `revert()` DOES NOT ALREADY PREVENT IT. `revert()` calls `setDraft(null)` and `commit()`
  // opens with `if (draft === null) return`, so it reads as self-guarding. It is not: React state
  // updates are not synchronous, and `blur()` dispatches `onBlur` synchronously within the SAME
  // event, so the `commit` closure that runs still captures the OLD non-null `draft`. The guard
  // fires one render too late.
  //
  // A REF, NOT STATE, for exactly that reason — it is readable and writable in the same tick. It is
  // cleared immediately after `blur()` returns rather than inside `onBlur`, because a field that is
  // NOT focused takes no blur at all: clearing only in the handler would leave the flag armed
  // forever and silently swallow the next genuine save. `EpicCardGoal.test.tsx` pins both halves —
  // the discard, and an ordinary blur still committing afterwards.
  const escaping = useRef(false);

  useEffect(() => {
    if (optimistic !== null && storedText === optimistic) setOptimistic(null);
  }, [optimistic, storedText]);

  // EDITING IS `draft !== null`, NOT A SEPARATE BOOLEAN. Two pieces of state for one fact is how a
  // field ends up open with no draft, or holding a draft it will never show.
  const editing = draft !== null;
  const value = draft ?? shown;

  // ══ AUTO-GROW, BECAUSE A ONE-ROW BOX SILENTLY CLIPS THE GOAL ═══════════════════════════════════
  // `rows={1}` with `resize: "none"` was showing the FIRST LINE ONLY of anything that wrapped, with
  // no scrollbar and no drag handle to reveal the rest. Goal text runs to `GOAL_MAX_LEN` (200), and
  // at this type size inside a card column that wraps well before the limit — so item 11 ("the goal
  // is visible on the opened card") was false for most real goals, in the silent direction.
  //
  // MEASURED, NOT GUESSED: reset to `auto` first so the box can SHRINK when text is deleted, then
  // take `scrollHeight`. Reading it without the reset only ever grows.
  //
  // THE `> 0` GUARD IS FOR JSDOM, WHICH DOES NOT LAY OUT (see docs/jsdom-test-caveats.md) — every
  // measurement there is 0, and writing `height: 0px` would collapse the field to nothing in the
  // one environment the suite runs in. Left at `auto`, jsdom renders it exactly as it did before.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = "auto";
    if (el.scrollHeight <= 0) return;
    // THE BORDERS HAVE TO BE ADDED BACK, and leaving them off is not a rounding error. This box is
    // `box-sizing: border-box`, so the `height` we write INCLUDES the borders — while `scrollHeight`
    // is content + padding and EXCLUDES them. Writing the raw number therefore leaves the padding
    // box 2px shorter than the content on every render, and with `overflow: "auto"` the field is
    // then permanently scrollable by those 2px and clips the bottom of its last line — on exactly
    // the multi-line goals this effect exists to reveal.
    const cs = getComputedStyle(el);
    const borders =
      (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    el.style.height = `${el.scrollHeight + borders}px`;
  }, [value]);

  const revert = useCallback(() => {
    setDraft(null);
    setErr("");
  }, []);

  const commit = useCallback(async () => {
    if (draft === null) return;
    const normalized = normalizeEpicGoalText(draft);

    // AN UNCHANGED FIELD IS NOT AN EDIT, and neither is an untouched EMPTY one. Without this,
    // blurring a field he only clicked into would raise "not saved — empty" on every epic that has
    // no goal yet — a refusal for doing nothing, on the exact surface he asked to be able to leave.
    if (normalized === normalizeEpicGoalText(shown)) {
      revert();
      return;
    }

    const rejection = epicGoalTextRejection(draft);
    if (rejection !== null) {
      // REFUSED, AND THE FIELD STAYS OPEN holding what he typed. Closing here would discard the
      // text while explaining why it was no good — he loses it AND has to retype it to act on the
      // reason. Matches `EpicGoalRow.commit`.
      setErr(`not saved — ${rejection}`);
      return;
    }

    const previous = optimistic;
    setErr("");
    setOptimistic(normalized);
    setDraft(null);
    setBusy(true);
    try {
      await onSetGoal(normalized, "human");
    } catch (e) {
      setOptimistic(previous);
      // THE TEXT SURVIVES A FAILED WRITE. `setDraft(null)` above runs BEFORE the await, so without
      // this the field would snap back to the old stored goal and show a reason — losing the
      // sentence he just wrote, unrecoverably. That contradicts the rule this component already
      // states for a validation rejection ("the field stays open holding what he typed"); a write
      // that failed is no different from the typist's side. Restoring the draft re-opens the field
      // with his words in it, beside the error explaining why they are not saved yet.
      setDraft(normalized);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, onSetGoal, optimistic, revert, shown]);

  return (
    <span style={{ display: "block" }}>
      <textarea
        ref={ref}
        data-testid={`${testId}-goal`}
        aria-label="Epic goal"
        // THE PLACEHOLDER IS THE AFFORDANCE. [06:02] "you could say set a goal if there is no goal.
        // Otherwise, it shows the goal." So there is no separate "add a goal" control to find — the
        // field is always here and always writable, which is also why item 12 calls it an input
        // rather than a button that reveals one.
        placeholder="Set a goal"
        value={value}
        // READONLY, NOT DISABLED. `disabled` blurs a focused textarea, so saving would yank the
        // caret out of the field he is still looking at — and that blur re-enters `onBlur`.
        // `readOnly` refuses edits without touching focus.
        readOnly={busy}
        rows={1}
        onChange={(e) => {
          setDraft(e.target.value);
          if (err !== "") setErr("");
        }}
        onBlur={() => {
          if (escaping.current) return;
          void commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // CONSUME IT. An epic card sits inside surfaces that also close on Escape; without
            // this, one press reverts the draft AND shuts the card he was editing in.
            e.preventDefault();
            e.stopPropagation();
            escaping.current = true;
            revert();
            ref.current?.blur();
            // `blur()` has already dispatched `onBlur` synchronously by the time it returns, so the
            // flag has done its job and clearing it here cannot race. Doing it here rather than in
            // the handler is what keeps an UNFOCUSED Escape — where no blur fires at all — from
            // leaving the flag armed against the next real save.
            escaping.current = false;
            return;
          }
          // ENTER COMMITS, SHIFT+ENTER NEWLINES — a goal is one sentence, so the common key does
          // the common thing.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void commit();
          }
        }}
        style={{
          display: "block",
          width: "100%",
          boxSizing: "border-box",
          resize: "none",
          // `auto`, not `hidden`: with the auto-grow above a scrollbar never appears, but if a
          // measurement ever fails the text scrolls instead of vanishing.
          overflow: "auto",
          // READS AS TEXT UNTIL TOUCHED. A permanently-boxed input in a card of plain fields would
          // shout louder than the title above it; the border appears on focus, where it is the
          // feedback that typing will be kept.
          background: editing ? C.dialogSurface : "transparent",
          border: `1px solid ${editing ? C.teal : "transparent"}`,
          borderRadius: RADIUS.input,
          padding: "2px 6px",
          margin: 0,
          color: C.teal,
          fontFamily: FONT_UI,
          fontSize: TYPE.small,
          fontWeight: FONT_WEIGHT.semibold,
          lineHeight: 1.4,
          cursor: busy ? "progress" : "text",
        }}
      />
      {err !== "" && (
        <span
          data-testid={`${testId}-goal-error`}
          role="status"
          style={{ display: "block", color: C.amberInk, fontSize: TYPE.micro, marginTop: 2 }}
        >
          {err}
        </span>
      )}
    </span>
  );
}
