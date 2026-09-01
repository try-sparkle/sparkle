// @vitest-environment jsdom
//
// jsdom for ONE reason, and it is the reason the last test in this file exists: `localStorage` has
// to be a real thing that can be read back. "The store has no `persist` option" is a vacuous
// assertion — it is true of the code as written and stays true if someone adds one badly — so the
// test reads the storage the bug would actually land in.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { notePreviewActivity, usePreviewStore, type PreviewUpdate } from "./previewStore";

const RUNNING: PreviewUpdate = {
  id: "srv-1",
  status: "serving",
  url: "http://127.0.0.1:5199/",
  port: 5199,
  error: null,
};

beforeEach(() => {
  usePreviewStore.setState({ byAgent: {}, capability: {} });
  localStorage.clear();
});

describe("previewStore", () => {
  it("records a wire update under its agent", () => {
    usePreviewStore.getState().setPreview("a1", RUNNING);
    const e = usePreviewStore.getState().byAgent.a1;
    expect(e?.status).toBe("serving");
    expect(e?.url).toBe("http://127.0.0.1:5199/");
    expect(e?.port).toBe(5199);
    expect(e?.reloadNonce).toBe(0);
  });

  // THE BAIL, asserted by IDENTITY rather than by value. A value assertion passes whether or not
  // the setter allocated a new object, so it cannot see the defect: a fresh object on every
  // repeated event wakes every subscriber, which here means re-rendering the tree around a live
  // iframe. `preview:state` repeats — a readiness probe can report `listening` several times — so
  // this is the common path, not an edge case.
  it("returns the SAME entry and the same map when an update says nothing new", () => {
    usePreviewStore.getState().setPreview("a1", RUNNING);
    const mapBefore = usePreviewStore.getState().byAgent;
    const entryBefore = mapBefore.a1;

    // A DIFFERENT object with identical fields — which is what deserialization hands us every time.
    usePreviewStore.getState().setPreview("a1", { ...RUNNING });

    expect(usePreviewStore.getState().byAgent).toBe(mapBefore);
    expect(usePreviewStore.getState().byAgent.a1).toBe(entryBefore);
  });

  // ══ THE BAIL RECORDS ACTIVITY WITHOUT RE-RENDERING — TWO CLAIMS, ONE ROW ═════════════════════
  // "Do not re-render the card" and "do not notice the event" are different things, and the bail
  // used to conflate them: a repeat was thrown away whole, so `previewIdleGrace` had nothing to
  // time a healthy preview off (bead `sparkle-9yck3i`). Both halves are asserted together on
  // purpose — dropping the mutation passes the identity half, and replacing the bail with a fresh
  // object passes the timestamp half, and each alone is the defect the other guards against.
  it("MOVES lastActivityAt on a repeat while keeping the map and entry identical", () => {
    vi.useFakeTimers();
    try {
      usePreviewStore.getState().setPreview("a1", RUNNING);
      const mapBefore = usePreviewStore.getState().byAgent;
      const entryBefore = mapBefore.a1!;
      const stampBefore = entryBefore.lastActivityAt;
      expect(stampBefore).toBe(Date.now());

      vi.advanceTimersByTime(90_000);
      usePreviewStore.getState().setPreview("a1", { ...RUNNING });

      // Nothing woke: same map, same entry object. This is what keeps a redundant event free.
      expect(usePreviewStore.getState().byAgent).toBe(mapBefore);
      expect(usePreviewStore.getState().byAgent.a1).toBe(entryBefore);
      // …and the clock nonetheless moved, by the full 90s.
      expect(usePreviewStore.getState().byAgent.a1!.lastActivityAt).toBe(Date.now());
      expect(usePreviewStore.getState().byAgent.a1!.lastActivityAt).toBe(stampBefore! + 90_000);
    } finally {
      vi.useRealTimers();
    }
  });

  // A CHANGED UPDATE IS ACTIVITY TOO. The bail path is not the only writer, and a preview that just
  // moved `listening` -> `ready` is emphatically not idle.
  it("stamps lastActivityAt on an update that really changed", () => {
    vi.useFakeTimers();
    try {
      usePreviewStore.getState().setPreview("a1", { ...RUNNING, status: "listening" });
      vi.advanceTimersByTime(30_000);
      usePreviewStore.getState().setPreview("a1", RUNNING);
      expect(usePreviewStore.getState().byAgent.a1!.lastActivityAt).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  // ══ THE SEAM FOR EVERYTHING THAT IS NOT A WIRE EVENT ═════════════════════════════════════════
  // `supervise()` stops emitting once a server is Ready, so on a healthy preview the ONLY thing
  // that can say "still wanted" is a human or an agent — the card's refresh, a click through to the
  // url, a `preview_inspect` capture. Same in-place contract as the bail, for the same reason: this
  // is called from click handlers, and waking the subscription that rendered them is a re-render
  // nobody asked for.
  it("notePreviewActivity moves the stamp without allocating a new map or entry", () => {
    vi.useFakeTimers();
    try {
      usePreviewStore.getState().setPreview("a1", RUNNING);
      const mapBefore = usePreviewStore.getState().byAgent;
      const entryBefore = mapBefore.a1!;

      vi.advanceTimersByTime(45_000);
      expect(notePreviewActivity("a1")).toBe(true);

      expect(usePreviewStore.getState().byAgent).toBe(mapBefore);
      expect(usePreviewStore.getState().byAgent.a1).toBe(entryBefore);
      expect(entryBefore.lastActivityAt).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  // Activity on a preview that does not exist is not a fact worth inventing an entry for — the same
  // rule `bumpReload` follows, and for the same reason: a half entry with no status is something
  // every reader would then have to defend against.
  it("notePreviewActivity on an agent with no preview does not invent one", () => {
    expect(notePreviewActivity("ghost")).toBe(false);
    expect(usePreviewStore.getState().byAgent.ghost).toBeUndefined();
    expect("ghost" in usePreviewStore.getState().byAgent).toBe(false);
  });

  it("does allocate when a field really changed", () => {
    usePreviewStore.getState().setPreview("a1", RUNNING);
    const before = usePreviewStore.getState().byAgent.a1;
    usePreviewStore.getState().setPreview("a1", { ...RUNNING, status: "crashed", error: "boom" });
    const after = usePreviewStore.getState().byAgent.a1;
    expect(after).not.toBe(before);
    expect(after?.status).toBe("crashed");
    expect(after?.error).toBe("boom");
    // `startedAt` is OURS and survives a status change — it is when this preview appeared, not when
    // the last event did.
    expect(after?.startedAt).toBe(before?.startedAt);
  });

  // REMOVES THE KEY, and the difference from a tombstone is not stylistic: `agentId in byAgent` is
  // how the pane asks "does this agent have a preview at all", and a key holding `undefined`
  // answers `true`. MUTATION TARGET: `set({byAgent: {...s.byAgent, [agentId]: undefined}})` passes
  // any value-based check and fails this one.
  it("clearPreview deletes the key rather than writing undefined into it", () => {
    usePreviewStore.getState().setPreview("a1", RUNNING);
    usePreviewStore.getState().clearPreview("a1");

    const map = usePreviewStore.getState().byAgent;
    expect("a1" in map).toBe(false);
    expect(Object.keys(map)).toEqual([]);
  });

  it("clearPreview on an unknown agent is a no-op that does not allocate", () => {
    const before = usePreviewStore.getState().byAgent;
    usePreviewStore.getState().clearPreview("nobody");
    expect(usePreviewStore.getState().byAgent).toBe(before);
  });

  // THE RELOAD BUTTON'S ONLY MECHANISM. The nonce is the iframe's `key`; React leaves an element
  // with an unchanged key alone even if you re-render it, so a reload that does not change this
  // number is a control that looks fine and does nothing.
  //
  // (The DOM half of this claim used to be credited to `PreviewSlot.test.tsx`, beside the
  // `PreviewSlot.tsx` it covered. Neither file exists anywhere in the repo — d48af48e5 deleted the
  // Preview segment, its mode and its pane. NOTHING ASSERTS THE DOM HALF TODAY, and nothing in the
  // app reads `reloadNonce` either: every remaining reference is a test fixture. So this suite
  // pins the reducer of a control that currently has no renderer. Read it as the contract a future
  // renderer has to honour, not as a claim that one exists.)
  //                                    # guard-ok — tombstone: names the deleted files on purpose
  it("bumpReload changes the nonce and leaves everything else alone", () => {
    usePreviewStore.getState().setPreview("a1", RUNNING);
    const before = usePreviewStore.getState().byAgent.a1!;
    usePreviewStore.getState().bumpReload("a1");
    const after = usePreviewStore.getState().byAgent.a1!;

    expect(after.reloadNonce).toBe(before.reloadNonce + 1);
    expect(after.url).toBe(before.url);
    expect(after.status).toBe(before.status);
    expect(after.startedAt).toBe(before.startedAt);
  });

  it("bumpReload on an agent with no preview does not invent one", () => {
    usePreviewStore.getState().bumpReload("ghost");
    expect(usePreviewStore.getState().byAgent.ghost).toBeUndefined();
  });

  // `undefined` (not asked) and `{previewable:false}` (asked, and no) are different facts, and the
  // affordance rule depends on the difference — an unasked project must offer nothing rather than
  // rendering a "not previewable" state it has no basis for.
  it("keeps 'not asked yet' distinct from 'asked, and no'", () => {
    expect(usePreviewStore.getState().capability.p1).toBeUndefined();
    usePreviewStore.getState().setCapability("p1", { previewable: false, declineReason: "no dev" });
    expect(usePreviewStore.getState().capability.p1?.previewable).toBe(false);
    expect("p1" in usePreviewStore.getState().capability).toBe(true);
  });

  it("setCapability bails on an unchanged verdict", () => {
    usePreviewStore.getState().setCapability("p1", { previewable: true, declineReason: null });
    const before = usePreviewStore.getState().capability;
    usePreviewStore.getState().setCapability("p1", { previewable: true, declineReason: null });
    expect(usePreviewStore.getState().capability).toBe(before);
  });

  // ── THE ONE THAT READS THE STORAGE, NOT THE SOURCE ────────────────────────────────────────────
  // A persisted preview restores a url naming a port that either answers nothing or now belongs to
  // an unrelated process — and the pane would frame whatever that is. Asserting "there is no
  // persist middleware" would be true of the code as written and blind to a `persist` added later
  // with a partialize that lets these through, so this asserts the OUTCOME: after a real write, no
  // storage key mentions the port or the url.
  it("writes nothing to localStorage — no key contains the port or the url", () => {
    usePreviewStore.getState().setPreview("a1", RUNNING);
    usePreviewStore.getState().setCapability("p1", { previewable: true });

    const dump = Object.keys(localStorage)
      .map((k) => `${k}=${localStorage.getItem(k) ?? ""}`)
      .join("\n");
    expect(dump).not.toContain("5199");
    expect(dump).not.toContain("127.0.0.1");
    expect(dump).not.toContain("srv-1");
  });
});
