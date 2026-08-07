// The staged quote, owned where the SEND is — the host — for the same reason `useConciergeAttachments`
// owns staged files: `ComposeBox.onSend`'s arity is part of its contract, so anything that has to
// reach the wire without being typed lives on the host and is read at send time rather than threaded
// through as another parameter.
//
// KEYED BY DRAFT, not global. `ComposeBox` keeps one draft per conversation (its `draftsRef`,
// swapped on `draftKey`), and a quote is part of a draft: staging one against the concierge and then
// patching the cable to an agent must not carry the concierge's words into the agent's message. A
// single slot would do exactly that, silently, and only the founder's eye would catch it.
import { useCallback, useMemo, useRef, useState } from "react";
import { makeQuote, type ComposeQuote } from "../components/Concierge/composeQuote";
import type { PendingQuote } from "../components/Concierge/useQuoteOnSelection";

export interface ConciergeQuoteApi {
  /** The quote staged against the CURRENT draft, or null. */
  quote: ComposeQuote | null;
  /** Stage a selection reported by the chiclet. Silently no-ops on a selection with no words in it
   *  (`makeQuote` refuses those), so the caller never has to pre-validate. */
  stage(pending: PendingQuote): void;
  /** The × was pressed. */
  remove(): void;
  /** Read the current quote WITHOUT clearing it — for building the outgoing prompt. Synchronous, so
   *  a send that runs in the same tick as a stage cannot miss it (React state would still be stale). */
  peek(): ComposeQuote | null;
  /** The send went out: drop it, the way attachments are dropped. */
  clear(): void;
  /**
   * The send FAILED (or its countdown was cancelled) and the draft is coming back: put the quote
   * back, so a message that never went out does not silently lose what it was replying to
   * (`ComposeBox.submit` restores text and pills the same way).
   *
   * IT WILL NOT OVERWRITE A QUOTE THE FOUNDER STAGED SINCE THE SEND, and that rule lives here, with
   * the slot that owns it, rather than at the call site (roborev 59805).
   *
   * "The founder staged one" — NOT merely "the slot is occupied" (roborev 59808). Several sends can
   * be outstanding, and each cancel restores its own quote, so an occupant may be an EARLIER send's
   * restore. That one is not newer: cancels arrive in arm order, so a later send's quote supersedes
   * it. Yielding on bare occupancy would leave the older passage on screen and discard the newer.
   *
   * The window is real and can be long: an armed countdown, or an intent held while the founder is
   * Away, sits for as long as it sits — and the box clears on send, so he is free to select a new
   * fragment for his NEXT message in the meantime. A plain write would then destroy that newer quote
   * when he cancelled the older send, losing a `sourceId` he cannot recover without going back to
   * find the passage again.
   *
   * ── WHAT THIS COSTS, STATED PLAINLY (roborev 59807) ────────────────────────────────────────────
   * THE OLDER QUOTE IS DISCARDED. A draft holds ONE quote, so when the slot is occupied there is
   * nowhere for the incoming one to go, and the newer wins. This is NOT what the other two restores
   * do, and an earlier version of this comment wrongly claimed it was: `restoreDraft`'s text half
   * INSERTS (keeping both), and `useConciergeAttachments.restore` MERGES (`[...atts, ...cur]`, keeping
   * both batches). Only a quote has a single slot, so only a quote can be dropped.
   *
   * RETURNS whether the quote actually came back, so a caller is not obliged to guess — the same
   * shape `restoreDraft` itself uses to tell `retractSend` whether the words got back. The residual
   * gap is a UX one, tracked rather than hidden: on a decline the restored TEXT is left against the
   * newer quote, so a founder who presses Send without looking pairs the cancelled message's words
   * with a different passage's `sourceId`. Both are on screen — the chip is visible above the draft —
   * but nothing yet SAYS the older quote was dropped.
   *
   * Restoring into an EMPTY slot is the case this exists for and is unaffected.
   */
  restore(quote: ComposeQuote | null): boolean;
}

/**
 * A slot's occupant, plus HOW IT GOT THERE.
 *
 * The provenance is what makes `restore`'s decline rule correct rather than merely plausible
 * (roborev 59808). "The slot is occupied" is not the same question as "the founder has chosen
 * something newer": several sends can be outstanding at once (`armIntent` keeps a map, and an
 * intent held while he is Away survives until he returns), and each one's cancel calls `restore`
 * with its own quote — so an occupant may be an EARLIER send's restore rather than a fresh choice.
 * Yielding to that would leave the composer showing the older passage while the newer one is thrown
 * away, which is the inverse of the rule and exactly the crossed pairing this all exists to prevent.
 */
interface Slot {
  quote: ComposeQuote;
  /** True when the founder chose this by selecting text; false when a cancelled send handed it back. */
  userStaged: boolean;
}

export function useConciergeQuote(draftKey: string): ConciergeQuoteApi {
  const [byKey, setByKey] = useState<Record<string, Slot>>({});
  // Mirrors `byKey` for `peek`. The send path reads the quote in the same turn the user may have
  // staged it, and React state is not yet updated there.
  const ref = useRef<Record<string, Slot>>({});

  // THE REF IS THE SOURCE OF TRUTH; the state exists only to re-render. Written eagerly and
  // synchronously, because `peek` can be called in the same turn as a stage — a `setByKey` updater
  // has not run by then, so reading through state would hand the send path the PREVIOUS quote.
  const write = useCallback((key: string, next: ComposeQuote | null, userStaged: boolean) => {
    const out = { ...ref.current };
    if (next) out[key] = { quote: next, userStaged };
    else delete out[key];
    ref.current = out;
    setByKey(out);
  }, []);

  const stage = useCallback(
    (pending: PendingQuote) => {
      const q = makeQuote({
        text: pending.text,
        sourceId: pending.sourceId,
        source: pending.source,
        agentName: pending.agentName,
      });
      if (!q) return;
      write(draftKey, q, true);
    },
    [draftKey, write],
  );

  const remove = useCallback(() => write(draftKey, null, false), [draftKey, write]);
  const clear = remove;
  const peek = useCallback(() => ref.current[draftKey]?.quote ?? null, [draftKey]);
  const restore = useCallback(
    (quote: ComposeQuote | null): boolean => {
      // YIELDS ONLY TO THE FOUNDER'S OWN CHOICE. A quote he selected while this send was in flight is
      // newer than what is being handed back, so it stands. An occupant that is itself an earlier
      // send's restore is NOT newer — cancels arrive in arm order, so the later send's quote is the
      // more recent one and must supersede it, or the composer ends up showing the older passage
      // while the newer is discarded (roborev 59808).
      if (ref.current[draftKey]?.userStaged) return false;
      write(draftKey, quote, false);
      return true;
    },
    [draftKey, write],
  );

  const quote = byKey[draftKey]?.quote ?? null;

  return useMemo(
    () => ({ quote, stage, remove, peek, clear, restore }),
    [quote, stage, remove, peek, clear, restore],
  );
}
