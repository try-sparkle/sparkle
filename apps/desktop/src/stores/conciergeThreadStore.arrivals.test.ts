// ARRIVAL STAMPS ON THE TRANSCRIPT — bead sparkle-75fbot.
//
// The thread was ordered by arrival and carried no record of WHEN anything arrived, so a thread
// artifact (the live preview card) could not place itself by time and reconstructed its position
// from a render-time ref instead. `stampArrivals` is the writer; `threadArtifactAnchor.anchorableIdAt`
// is the reader (wired in at `PreviewCards.PreviewThreadArtifacts`).
//
// ══ WHAT THESE TESTS ARE FOR, AND WHAT THEY DELIBERATELY ARE NOT ═══════════════════════════════
// "The field exists" is the vacuous version — it is true of any object literal anyone types. The
// four facts here are the ones a plausible-looking implementation gets WRONG, and each of them is
// load-bearing for the reader:
//
//   1. A stamp is written for a NEW message (there is a writer at all).
//   2. A stamp is NOT re-written on a later pass, so it dates the arrival rather than the newest
//      write — the array is rebuilt on every append and every streamed delta.
//   3. A stamp SURVIVES the persist/restore round trip. This is the entire point of the bead: a ref
//      cannot survive it, and a field whose value is durability has to be asserted across it.
//   4. A message restored WITHOUT a stamp is never back-dated to `now`. Stamping the previous
//      session's conversation with this launch's clock would be worse than the gap, and it would
//      break the reader's fallback (see `ConciergeMessageArrival`).
import { beforeEach, describe, expect, it } from "vitest";
import {
  RESTORED_ID_PREFIX,
  persistableThread,
  rehydrateThread,
  setConciergeChat,
  stampArrivals,
  useConciergeThreadStore,
} from "./conciergeThreadStore";
import type { ConciergeMessage } from "../components/Concierge/types";

const you = (id: string, text = "do the thing"): ConciergeMessage => ({ id, kind: "you", text });
const sparkle = (id: string, text = "done"): ConciergeMessage => ({ id, kind: "sparkle", text });

beforeEach(() => {
  useConciergeThreadStore.setState({ chat: [] });
});

describe("stampArrivals writes an arrival instant exactly once", () => {
  it("stamps a message the thread has not seen", () => {
    const out = stampArrivals([], [you("you-1")], 1_000);
    expect(out[0]!.arrivedAt).toBe(1_000);
  });

  it("does NOT restamp on a later write — the stamp dates the ARRIVAL, not the newest rebuild", () => {
    const first = stampArrivals([], [you("you-1")], 1_000);
    // The shape every call site actually produces: the whole array again, with the old message
    // rebuilt by spread and a new one appended.
    const second = stampArrivals(first, [{ ...first[0]! }, sparkle("brain-1")], 9_000);
    expect(second[0]!.arrivedAt).toBe(1_000);
    expect(second[1]!.arrivedAt).toBe(9_000);
  });

  it("carries the stamp forward when a call site rebuilds a message field by field", () => {
    // A site that does not spread would otherwise drop the stamp, and re-stamping it `now` would
    // date an old bubble from this write. The store knows better than the call site here.
    const first = stampArrivals([], [you("you-1")], 1_000);
    const rebuilt: ConciergeMessage = { id: "you-1", kind: "you", text: "do the thing" };
    expect(stampArrivals(first, [rebuilt], 9_000)[0]!.arrivedAt).toBe(1_000);
  });

  it("returns the input array unchanged when nothing needed stamping", () => {
    const stamped = stampArrivals([], [you("you-1")], 1_000);
    // Identity, not equality: bubbles are memoized on it, so a rebuild here re-renders the thread.
    expect(stampArrivals(stamped, stamped, 9_000)).toBe(stamped);
  });

  it("leaves an unstamped message that the thread already holds unstamped", () => {
    // The restored-from-an-older-build population. `merge` bypasses the stamper, so these reach the
    // store with no stamp; the next send must not date them from this second.
    const restored: ConciergeMessage[] = [you(`${RESTORED_ID_PREFIX}0`)];
    const out = stampArrivals(restored, [...restored, you("you-1")], 9_000);
    expect(out[0]!.arrivedAt).toBeUndefined();
    expect(out[1]!.arrivedAt).toBe(9_000);
    // IDENTITY, and it is the assertion with teeth here. Writing `arrivedAt: undefined` onto a
    // rebuilt copy reads identically to leaving the message alone — every `toBeUndefined` above
    // passes either way — but it replaces the object, and bubbles are memoized on identity, so the
    // whole restored transcript re-renders on every send. Measured: without this line, deleting the
    // carry guard in `stampArrivals` leaves the suite green.
    expect(out[0]).toBe(restored[0]);
  });
});

describe("the store stamps every write, whatever the call site remembered", () => {
  it("stamps through setConciergeChat's updater form", () => {
    const before = Date.now();
    setConciergeChat((prev) => [...prev, you("you-1")]);
    const stamped = useConciergeThreadStore.getState().chat[0]!.arrivedAt;
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it("keeps the first message's stamp when a second one is appended later", () => {
    setConciergeChat([you("you-1")]);
    const first = useConciergeThreadStore.getState().chat[0]!.arrivedAt;
    setConciergeChat((prev) => [...prev, sparkle("brain-1")]);
    const chat = useConciergeThreadStore.getState().chat;
    expect(chat[0]!.arrivedAt).toBe(first);
    expect(chat[1]!.arrivedAt).toBeDefined();
  });
});

describe("the stamp survives the persist/restore round trip", () => {
  it("comes back on every restored message, unchanged", () => {
    // THE PROPERTY THE BEAD IS ABOUT. A render-time ref cannot survive this; a field can, and a
    // reader that derives a position from it therefore reproduces that position after a relaunch.
    const live = stampArrivals([], [you("you-1"), sparkle("brain-1")], 1_000).map((m, i) => ({
      ...m,
      arrivedAt: 1_000 + i,
    }));
    const restored = rehydrateThread(persistableThread(live));
    expect(restored.map((m) => m.arrivedAt)).toEqual([1_000, 1_001]);
    // …and the ids WERE rewritten, so this is a genuine round trip and not the same objects handed
    // back. Without this line the assertion above could pass on a no-op restore.
    expect(restored.map((m) => m.id)).toEqual([`${RESTORED_ID_PREFIX}0`, `${RESTORED_ID_PREFIX}1`]);
  });

  it("survives the write-side caps that rewrite a message on the way to disk", () => {
    // `clip`, `stripDataUrls`, `boundLintMarks` and `boundCollapsedPayloads` each rebuild a message.
    // A rebuild that dropped the stamp would be invisible on a short bubble and would only surface
    // on the long ones, which are the ones a reader scrolls back to.
    const long: ConciergeMessage = {
      id: "brain-1",
      kind: "sparkle",
      text: "x".repeat(9_000),
      arrivedAt: 1_234,
    };
    const persisted = persistableThread([long]);
    const clipped = persisted[0]!;
    // NARROWED, NOT ASSERTED THROUGH. `ConciergeMessage` is a union and the recap variant carries no
    // `text` (see `conciergeThreadStore.test.ts`'s own `textOf` helper), so the kind is asserted on
    // its own line first — folding it into the length check as `kind === "sparkle" && …` would make
    // a wrong kind produce `false`, which is happily less than 9,000 and passes vacuously.
    expect(clipped.kind).toBe("sparkle");
    if (clipped.kind !== "sparkle") throw new Error("unreachable — pinned above");
    expect(clipped.text.length).toBeLessThan(9_000);
    expect(clipped.arrivedAt).toBe(1_234);
  });

  it("restores a thread written before the field existed with no stamp at all", () => {
    // The fallback population, end to end. An absent stamp must stay absent — a restore that
    // invented one would make last week's conversation claim it arrived at this launch.
    const legacy: ConciergeMessage[] = [you("you-1"), sparkle("brain-1")];
    const restored = rehydrateThread(persistableThread(legacy));
    expect(restored.every((m) => m.arrivedAt === undefined)).toBe(true);
  });
});
