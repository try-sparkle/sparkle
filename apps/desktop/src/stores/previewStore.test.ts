// @vitest-environment jsdom
//
// jsdom for ONE reason, and it is the reason the last test in this file exists: `localStorage` has
// to be a real thing that can be read back. "The store has no `persist` option" is a vacuous
// assertion — it is true of the code as written and stays true if someone adds one badly — so the
// test reads the storage the bug would actually land in.
import { beforeEach, describe, expect, it } from "vitest";
import { usePreviewStore, type PreviewUpdate } from "./previewStore";

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
  // number is a control that looks fine and does nothing. (The DOM half of this claim is asserted
  // in PreviewSlot.test.tsx against a real element.)
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
