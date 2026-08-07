// @vitest-environment jsdom
//
// The staged quote's PER-DRAFT keying, and the binding that keeps a late restore honest.
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useConciergeQuote } from "./useConciergeQuote";
import type { PendingQuote } from "../components/Concierge/useQuoteOnSelection";

afterEach(() => cleanup());

const pending = (over: Partial<PendingQuote> = {}): PendingQuote => ({
  text: "PR 1430 is blocked on the CI check",
  sourceId: "sparkle-15",
  source: "sparkle",
  x: 0,
  y: 0,
  ...over,
});

describe("useConciergeQuote", () => {
  it("stages a selection and reports it, capped and captioned", () => {
    const { result } = renderHook(() => useConciergeQuote("concierge"));
    expect(result.current.quote).toBeNull();

    act(() => result.current.stage(pending()));

    expect(result.current.quote).toMatchObject({
      sourceId: "sparkle-15",
      source: "sparkle",
      label: "Concierge",
    });
  });

  it("ignores a selection with no words in it", () => {
    const { result } = renderHook(() => useConciergeQuote("concierge"));
    act(() => result.current.stage(pending({ text: "   \n " })));
    expect(result.current.quote).toBeNull();
  });

  it("peek() sees a stage from the SAME tick, which React state would not", () => {
    // The send path reads the quote in the turn the user may have staged it. If `peek` went through
    // state it would hand `send` the previous quote (or none) — the whole reason the hook keeps a ref.
    const { result } = renderHook(() => useConciergeQuote("concierge"));
    let seen: string | null = null;
    act(() => {
      result.current.stage(pending());
      seen = result.current.peek()?.sourceId ?? null;
    });
    expect(seen).toBe("sparkle-15");
  });

  it("keeps ONE quote PER DRAFT, so switching conversations does not carry it over", () => {
    const { result, rerender } = renderHook(({ k }) => useConciergeQuote(k), {
      initialProps: { k: "concierge" },
    });
    act(() => result.current.stage(pending()));
    expect(result.current.quote?.sourceId).toBe("sparkle-15");

    rerender({ k: "agent:kraken" });
    // The other conversation has its own slot — the concierge's quote must not appear above it.
    expect(result.current.quote).toBeNull();

    act(() => result.current.stage(pending({ sourceId: "agent-3", source: "agent", agentName: "Kraken" })));
    expect(result.current.quote).toMatchObject({ sourceId: "agent-3", label: "Kraken" });

    // …and going back finds the original still waiting, not overwritten.
    rerender({ k: "concierge" });
    expect(result.current.quote?.sourceId).toBe("sparkle-15");
  });

  it("a restore CAPTURED at send time writes to the send-time draft, not the current one", () => {
    // roborev 59801. `send` clears the quote synchronously but restores it only if the send is
    // REFUSED — which, for a queued send, resolves long afterwards. If the founder patches the cable
    // in between, resolving `restore` at settle time would re-stage the quote above a DIFFERENT
    // conversation, carrying a sourceId that would then ride out with the next message there.
    const { result, rerender } = renderHook(({ k }) => useConciergeQuote(k), {
      initialProps: { k: "concierge" },
    });
    act(() => result.current.stage(pending()));
    const staged = result.current.quote!;
    // What `send` captures in its own tick, before anything is awaited.
    const restoreQuote = result.current.restore;
    act(() => result.current.clear());
    expect(result.current.quote).toBeNull();

    // The cable is patched while the send is in flight…
    rerender({ k: "agent:kraken" });
    // …and the send comes back refused.
    act(() => restoreQuote(staged));

    // The agent's draft must be untouched.
    expect(result.current.quote).toBeNull();
    // The quote belongs to the conversation it was sent from.
    rerender({ k: "concierge" });
    expect(result.current.quote?.sourceId).toBe("sparkle-15");
  });

  it("a restore does NOT clobber a quote staged since the send", () => {
    // roborev 59805. The box clears on send, so during an armed countdown — or an intent held while
    // the founder is Away, which can sit indefinitely — he is free to select a new fragment for his
    // NEXT message. Cancelling the older send must not destroy it: the newer quote carries a
    // sourceId he cannot recover without going back to find the passage again.
    const { result } = renderHook(() => useConciergeQuote("concierge"));
    act(() => result.current.stage(pending()));
    const sent = result.current.quote!;
    const restoreQuote = result.current.restore;
    act(() => result.current.clear());

    // …he stages a NEW one while the countdown runs…
    act(() => result.current.stage(pending({ sourceId: "sparkle-21", text: "a different claim" })));
    // …then cancels the older send.
    act(() => restoreQuote(sent));

    expect(result.current.quote?.sourceId).toBe("sparkle-21");
  });

  it("a LATER send's restore supersedes an earlier send's, rather than yielding to it", () => {
    // roborev 59808. Several sends can be armed at once and each cancel restores its own quote, so
    // "the slot is occupied" is NOT the same question as "the founder chose something newer". Cancels
    // arrive in arm order, so S1 restores first; if S2 then yielded on bare occupancy the composer
    // would show the OLDER passage and throw the newer away — the inverse of the rule.
    const { result } = renderHook(() => useConciergeQuote("concierge"));
    act(() => result.current.stage(pending({ sourceId: "sparkle-1", text: "first claim" })));
    const q1 = result.current.quote!;
    const restore1 = result.current.restore;
    act(() => result.current.clear());

    act(() => result.current.stage(pending({ sourceId: "sparkle-2", text: "second claim" })));
    const q2 = result.current.quote!;
    const restore2 = result.current.restore;
    act(() => result.current.clear());

    // Both cancelled, in arm order.
    act(() => {
      restore1(q1);
    });
    act(() => {
      restore2(q2);
    });

    expect(result.current.quote?.sourceId).toBe("sparkle-2");
  });

  it("REPORTS whether the quote came back, so the drop is not silent", () => {
    // roborev 59807. A draft holds one quote, so a decline DISCARDS the older one — unlike the text
    // restore (which inserts) and the attachments restore (which merges). The caller has to be able
    // to tell, or the loss is invisible to the code as well as to the founder.
    const { result } = renderHook(() => useConciergeQuote("concierge"));
    act(() => result.current.stage(pending()));
    const sent = result.current.quote!;
    const restoreQuote = result.current.restore;
    act(() => result.current.clear());

    let intoEmpty: boolean | null = null;
    act(() => {
      intoEmpty = restoreQuote(sent);
    });
    expect(intoEmpty).toBe(true);

    // A decline can only mean the founder chose something himself — an occupant left by another
    // restore is superseded, not yielded to (see the test above), so the false case is a USER stage.
    act(() => result.current.remove());
    act(() => result.current.stage(pending({ sourceId: "sparkle-21" })));
    let intoUserStaged: boolean | null = null;
    act(() => {
      intoUserStaged = restoreQuote(sent);
    });
    expect(intoUserStaged).toBe(false);
    expect(result.current.quote?.sourceId).toBe("sparkle-21");
  });

  it("a restore into an EMPTY slot still works — the case it exists for", () => {
    const { result } = renderHook(() => useConciergeQuote("concierge"));
    act(() => result.current.stage(pending()));
    const sent = result.current.quote!;
    const restoreQuote = result.current.restore;
    act(() => result.current.clear());

    act(() => restoreQuote(sent));

    expect(result.current.quote?.sourceId).toBe("sparkle-15");
  });

  it("remove() takes the quote back out of the current draft only", () => {
    const { result, rerender } = renderHook(({ k }) => useConciergeQuote(k), {
      initialProps: { k: "concierge" },
    });
    act(() => result.current.stage(pending()));
    rerender({ k: "agent:kraken" });
    act(() => result.current.stage(pending({ sourceId: "agent-3", source: "agent" })));

    act(() => result.current.remove());
    expect(result.current.quote).toBeNull();

    rerender({ k: "concierge" });
    expect(result.current.quote?.sourceId).toBe("sparkle-15");
  });
});
