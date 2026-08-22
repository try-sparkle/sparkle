// The loopback gate and the wire→store fold. No Tauri bridge is exercised here on purpose: the
// point of routing every invoke through this module is that everything ELSE can be tested without
// one, and the two pieces worth pinning are the pure predicate and the null-handling of the fold.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { invoke } from "@tauri-apps/api/core";
import {
  applyPreviewStatus,
  decidePreviewOpen,
  isLoopbackPreviewUrl,
  openPreviewServer,
  refreshPreviewCapability,
  resolvePreviewOpenTarget,
} from "./preview";
import { usePreviewStore, type PreviewStatus } from "../stores/previewStore";

describe("isLoopbackPreviewUrl", () => {
  // ACCEPTED — the three spellings a dev server actually binds, over plain http.
  it.each([
    "http://127.0.0.1:5199/",
    "http://localhost:3000",
    "http://[::1]:5199/",
    "http://127.0.0.1:5199/some/path?q=1",
  ])("accepts %s", (url) => {
    expect(isLoopbackPreviewUrl(url)).toBe(true);
  });

  // REFUSED, and each row is a distinct way of being wrong rather than four spellings of one:
  //  - `127.0.0.1.evil.com` — a REMOTE host that merely starts with the loopback literal. This is
  //    what kills any substring/startsWith check.
  //  - `evil.com/#127.0.0.1` — the loopback token in a fragment, i.e. the same trick from the other
  //    end. Kills a naive `includes`.
  //  - `https://127.0.0.1/` — right host, wrong scheme. Nothing loopback here serves https, and the
  //    CSP directive names http only, so accepting it would let this side and the engine disagree.
  //  - `192.168.1.5` / `0.0.0.0` — a LAN-reachable bind. Framing one would show (and, over a shared
  //    network, could leak) a dev server that is not ours.
  //  - `file:` / `tauri:` — the local-resource schemes `frame-src` exists to keep out.
  it.each([
    "http://127.0.0.1.evil.com/",
    "http://evil.com/#127.0.0.1",
    "http://evil.com/?to=http://127.0.0.1:5199",
    "https://127.0.0.1/",
    "http://192.168.1.5:3000",
    "http://0.0.0.0:5199/",
    "http://localhost.evil.com/",
    "file:///etc/passwd",
    "tauri://localhost/",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(isLoopbackPreviewUrl(url)).toBe(false);
  });

  it("refuses null and undefined", () => {
    expect(isLoopbackPreviewUrl(null)).toBe(false);
    expect(isLoopbackPreviewUrl(undefined)).toBe(false);
  });
});

describe("applyPreviewStatus", () => {
  beforeEach(() => usePreviewStore.setState({ byAgent: {}, capability: {} }));

  // THE FIXTURE CARRIES EXPLICIT `null`s, because that is what serde emits for `Option::None` — a
  // fixture with the keys omitted would be testing a payload the wire cannot produce (bead
  // sparkle-16y6h). This is the common case, not an edge one: a server that has not bound a port
  // yet sends exactly this.
  it("folds a starting status whose optional fields are all null", () => {
    applyPreviewStatus({
      id: "srv-1",
      agentId: "a1",
      projectId: "p1",
      url: null,
      port: null,
      state: "starting",
      error: null,
    });

    const e = usePreviewStore.getState().byAgent.a1;
    expect(e).toBeDefined();
    expect(e?.status).toBe("starting");
    expect(e?.url).toBeNull();
    expect(e?.port).toBeNull();
    expect(e?.id).toBe("srv-1");
  });

  it("folds a serving status and keeps the url and port", () => {
    applyPreviewStatus({
      id: "srv-1",
      agentId: "a1",
      projectId: "p1",
      url: "http://127.0.0.1:5199/",
      port: 5199,
      state: "serving",
      error: null,
    });
    expect(usePreviewStore.getState().byAgent.a1?.url).toBe("http://127.0.0.1:5199/");
    expect(usePreviewStore.getState().byAgent.a1?.port).toBe(5199);
  });

  it("folds a failure, carrying the error text the pane shows instead of a blank frame", () => {
    applyPreviewStatus({
      id: "srv-1",
      agentId: "a1",
      projectId: "p1",
      url: null,
      port: null,
      state: "failed",
      error: "Error: Cannot find module 'vite'",
    });
    expect(usePreviewStore.getState().byAgent.a1?.status).toBe("failed");
    expect(usePreviewStore.getState().byAgent.a1?.error).toContain("Cannot find module");
  });

  // ══ THE WIRE PATH IS WHAT FEEDS THE IDLE CLOCK ═══════════════════════════════════════════════
  // `previewIdleGrace` times a preview off `lastActivityAt`, and the honest entry point for that is
  // this function — the one every `preview:state` event and every `listPreviews()` reconciliation
  // goes through. Asserted HERE rather than only on the store because a repeat status is precisely
  // what `listPreviews()` produces after a window reload, and the setter's unchanged-value bail
  // used to discard it whole. Both halves again: the timestamp moves AND the entry is not
  // reallocated, since a re-render on every redundant event is what the bail exists to prevent.
  it("moves lastActivityAt on a REPEAT status without reallocating the entry", () => {
    const STATUS = {
      id: "srv-1",
      agentId: "a1",
      projectId: "p1",
      url: "http://127.0.0.1:5199/",
      port: 5199,
      state: "serving",
      error: null,
    } as const;

    vi.useFakeTimers();
    try {
      applyPreviewStatus({ ...STATUS });
      const entryBefore = usePreviewStore.getState().byAgent.a1!;
      expect(entryBefore.lastActivityAt).toBe(Date.now());

      vi.advanceTimersByTime(120_000);
      applyPreviewStatus({ ...STATUS }); // a freshly-deserialized twin, as the wire always sends

      expect(usePreviewStore.getState().byAgent.a1).toBe(entryBefore);
      expect(usePreviewStore.getState().byAgent.a1!.lastActivityAt).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("openPreviewServer — the wire shape preview_open ACTUALLY returns", () => {
  beforeEach(() => usePreviewStore.setState({ byAgent: {}, capability: {} }));

  // Drives the REAL Rust payload, which is the whole point: `preview_open` returns
  // `PreviewOpened { id, url, port, state }` and carries NO agentId. The previous version typed
  // the reply as a PreviewStatus and folded it through applyPreviewStatus, which keys the store on
  // `status.agentId` — so this exact payload wrote `byAgent["undefined"]` and the agent that had
  // just started a preview got nothing. Both suites were green: the Rust side tested its own
  // struct, and this file only ever fed applyPreviewStatus a hand-built PreviewStatus that
  // already had the field. That is the cross-process shape mismatch AGENTS.md calls out by name.
  it("writes the entry under the CALLER'S agentId, never under \"undefined\"", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      id: "p1",
      url: "http://127.0.0.1:5199/",
      port: 5199,
      state: "ready",
      // deliberately NO agentId / projectId / error — this is the real payload
    });

    await openPreviewServer({
      agentId: "a1",
      projectId: "proj",
      worktree: "/w",
      path: null,
    });

    const byAgent = usePreviewStore.getState().byAgent;
    expect(byAgent.a1?.url).toBe("http://127.0.0.1:5199/");
    expect(byAgent.a1?.status).toBe("ready");
    expect(byAgent.a1?.port).toBe(5199);
    // The phantom row the bug produced. Asserted by name because it is the failure mode, and it
    // renders as "the pane just never populates" rather than as an error.
    expect(Object.keys(byAgent)).not.toContain("undefined");
  });

  it("returns null and writes nothing when the command answers null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    const out = await openPreviewServer({
      agentId: "a1",
      projectId: "proj",
      worktree: "/w",
    });
    expect(out).toBeNull();
    expect(Object.keys(usePreviewStore.getState().byAgent)).toHaveLength(0);
  });
});

// ══ WHO ASKED — the one input to the auto-open conjunction that this module owns ═══════════════
//
// `openPreviewServer` is the ONLY place condition 2 ("the user has opened a preview for this
// project at least once this session") is written, and it has two callers with opposite meanings:
// the hover-card button, which is a person, and `controlListener.handlePreview`, which is an AGENT
// opening its own preview through the control bridge. Getting this backwards is not cosmetic — it
// would let an agent manufacture the signal that licenses a pane to open unasked, in a project the
// founder has never previewed, which is the exact interruption design §10 exists to prevent.
describe("openPreviewServer — only a USER-initiated open marks the session flag", () => {
  beforeEach(() =>
    usePreviewStore.setState({ byAgent: {}, capability: {}, openedProjects: {} } as never),
  );

  it('marks the project when the caller says initiator: "user"', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      id: "p1", url: "http://127.0.0.1:5199/", port: 5199, state: "ready",
    });
    await openPreviewServer({
      agentId: "a1", projectId: "proj", worktree: "/w", initiator: "user",
    });
    expect(usePreviewStore.getState().openedProjects.proj).toBe(true);
  });

  it('does NOT mark it for initiator: "agent"', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      id: "p1", url: "http://127.0.0.1:5199/", port: 5199, state: "ready",
    });
    await openPreviewServer({
      agentId: "a1", projectId: "proj", worktree: "/w", initiator: "agent",
    });
    expect(usePreviewStore.getState().openedProjects.proj).toBeUndefined();
  });

  it("FAILS CLOSED for a caller that names no initiator at all", async () => {
    // `controlListener.handlePreview` is exactly this call. An absent initiator must read as "not
    // attributable to a person", never as the permissive default.
    vi.mocked(invoke).mockResolvedValueOnce({
      id: "p1", url: "http://127.0.0.1:5199/", port: 5199, state: "ready",
    });
    await openPreviewServer({ agentId: "a1", projectId: "proj", worktree: "/w" });
    expect(usePreviewStore.getState().openedProjects.proj).toBeUndefined();
  });

  it("marks it even when the server fails to start — it records INTENT, not success", async () => {
    // A dev server that dies on boot does not retract the fact that the user asked for a preview
    // here. Written BEFORE the round trip for that reason.
    vi.mocked(invoke).mockRejectedValueOnce(new Error("spawn failed"));
    await expect(
      openPreviewServer({
        agentId: "a1", projectId: "proj", worktree: "/w", initiator: "user",
      }),
    ).rejects.toThrow();
    expect(usePreviewStore.getState().openedProjects.proj).toBe(true);
  });
});

// "WE COULD NOT LOOK" IS NOT "WE LOOKED AND THE ANSWER IS NO", and conflating them cost the whole
// feature for a session. The only caller gates on `capability[id] !== undefined`, so a recorded
// failure satisfies the gate and the probe is never asked again — one transient miss (bridge not up
// yet, a momentarily unreadable directory, a spawn_blocking task error) disabled every preview
// affordance until relaunch, while the function's own comment claimed the verdict was re-askable.
describe("refreshPreviewCapability — a failed probe must stay re-askable", () => {
  beforeEach(() => usePreviewStore.setState({ byAgent: {}, capability: {} }));

  it("records NOTHING when the probe throws, so the gate asks again", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("preview: invalid project path"));
    const out = await refreshPreviewCapability("p1", "/some/project");

    expect(out).toBeNull();
    // The assertion is `undefined`, not `previewable === false`: both hide the affordance, but only
    // one of them is a value the caller's `!== undefined` gate will ask about again.
    expect(usePreviewStore.getState().capability.p1).toBeUndefined();
  });

  // THE PAIR, so the test above cannot be satisfied by a function that never records anything.
  it("records the answer when the probe succeeds", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ previewable: true, target: null, declineReason: null });
    const out = await refreshPreviewCapability("p1", "/some/project");

    expect(out?.previewable).toBe(true);
    expect(usePreviewStore.getState().capability.p1?.previewable).toBe(true);
  });

  // A genuine "no" IS recorded — that is the sticky verdict we want, and it is what makes the
  // distinction above meaningful rather than a blanket refusal to write.
  it("records a decline, which is an answer", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      previewable: false,
      target: null,
      declineReason: "no dev script",
    });
    await refreshPreviewCapability("p1", "/some/project");

    expect(usePreviewStore.getState().capability.p1?.previewable).toBe(false);
    expect(usePreviewStore.getState().capability.p1?.declineReason).toBe("no dev script");
  });
});


// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE CLICK-TIME OWNERSHIP CHECK — decidePreviewOpen / resolvePreviewOpenTarget
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// A preview card was clicked and a DIFFERENT agent's app answered. `lsof` found exactly one dev
// server in the whole allocation range at that moment — on the port the card named, owned by
// another agent's worktree — and minutes later it was gone too. The card was holding an address
// whose server had died and whose port had since been recycled, and nothing on screen could say so.
//
// Distinct ports per agent narrow that window; they cannot close it, because the mechanism is REUSE
// OVER TIME rather than collision at one instant. What closes it is refusing to act on a stamped
// value: ask this agent's own live status at the moment of the click, and open only if it agrees.
// Every row below is a way the two can disagree, and each one must REFUSE rather than pick a side.
describe("decidePreviewOpen — an address is only openable while it is provably this agent's", () => {
  const AGENT = "a1";
  /** The live status Rust would answer for `a1`, healthy. Explicit `null`s throughout, per the
   *  `T | null` wire contract — a fixture with keys omitted tests a payload serde cannot emit. */
  function live(over: Partial<PreviewStatus> = {}): PreviewStatus {
    return {
      id: "srv-1",
      agentId: AGENT,
      projectId: "p1",
      url: "http://127.0.0.1:5199/",
      port: 5199,
      state: "serving",
      error: null,
      ...over,
    };
  }
  const held = { url: "http://127.0.0.1:5199/", port: 5199 };

  it("allows the open when the live status still matches what the card holds", () => {
    // The PRESENT twin of every refusal below. Without it each of them would be satisfied by a
    // function that refuses unconditionally — which passes seven rows and ships a dead card.
    const d = decidePreviewOpen(AGENT, held, live());
    expect(d).toEqual({ ok: true, url: "http://127.0.0.1:5199/", port: 5199 });
  });

  it("refuses when this agent has no preview at all any more", () => {
    // The measured case: the server died, and its port is now free for the next allocation.
    expect(decidePreviewOpen(AGENT, held, null)).toMatchObject({ ok: false, reason: "gone" });
  });

  it("refuses when the live status names a DIFFERENT agent", () => {
    // Unreachable if the read below is keyed correctly — asserted anyway, because it is the literal
    // shape of the incident and a gate that only holds while the layer beneath it is right is not
    // a gate. Checked BEFORE anything else is read off the status: a status about someone else is
    // not weaker evidence about this agent, it is evidence about someone else.
    expect(decidePreviewOpen(AGENT, held, live({ agentId: "a2" }))).toMatchObject({
      ok: false,
      reason: "wrong-agent",
    });
  });

  // NOT SERVING — the same two gates the card strip applies at render time, re-asked at click time.
  // `crashed` and `stopped` are the ones that matter: a dead process leaves its address behind, and
  // that address is exactly what gets reused. `listening` is the third: a port is bound before the
  // first compile finishes.
  it.each(["crashed", "stopped", "failed", "listening", "starting"] as const)(
    "refuses a live status in %s",
    (state) => {
      expect(decidePreviewOpen(AGENT, held, live({ state }))).toMatchObject({
        ok: false,
        reason: "not-live",
      });
    },
  );

  it("refuses when the live status is serving but has no address", () => {
    expect(decidePreviewOpen(AGENT, held, live({ url: null, port: null }))).toMatchObject({
      ok: false,
      reason: "not-live",
    });
  });

  it("refuses when the live address is no longer loopback http", () => {
    // The security gate re-asked against the FRESH url rather than the one the card was born with —
    // a preview that came back bound to a LAN address must not be opened just because it once was
    // loopback.
    expect(decidePreviewOpen(AGENT, held, live({ url: "http://192.168.1.42:5199/" }))).toMatchObject(
      { ok: false, reason: "unsafe" },
    );
  });

  it("refuses when the agent's server has moved to another port", () => {
    // THE HEADLINE ROW. The card says 5199; this agent is now on 5203, so 5199 is somebody else's
    // or nobody's. Both addresses are carried on the refusal so a caller can log what disagreed.
    const d = decidePreviewOpen(AGENT, held, live({ url: "http://127.0.0.1:5203/", port: 5203 }));
    expect(d).toMatchObject({
      ok: false,
      reason: "moved",
      heldUrl: "http://127.0.0.1:5199/",
      liveUrl: "http://127.0.0.1:5203/",
    });
  });

  it("refuses when the url agrees but the PORT the card carries does not", () => {
    // Not redundant with the row above, and not reachable through a well-formed wire payload — it
    // is the card's own two facts contradicting each other, which is not a state to act on either.
    expect(
      decidePreviewOpen(AGENT, { url: "http://127.0.0.1:5199/", port: 5173 }, live()),
    ).toMatchObject({ ok: false, reason: "moved" });
  });

  it("does NOT quietly redirect to the address it just discovered", () => {
    // The tidier code and the worse product. The reader clicked a card naming a specific address;
    // opening a different one is a second destination from one gesture, and it hides the very fact
    // worth knowing — that the card, and the screenshot above it, describe a page that is gone.
    const d = decidePreviewOpen(AGENT, held, live({ url: "http://127.0.0.1:5203/", port: 5203 }));
    expect(d.ok).toBe(false);
    expect(d).not.toHaveProperty("url");
  });
});

describe("resolvePreviewOpenTarget — the read that makes the decision fresh", () => {
  beforeEach(() => {
    usePreviewStore.setState({ byAgent: {}, capability: {}, openedProjects: {} });
    vi.mocked(invoke).mockReset();
  });

  it("asks the supervisor for THIS agent's status, and folds what it read into the store", () => {
    // The fold is what makes a refusal self-correcting: the card re-renders onto the real address,
    // so the copy's "click again" is a promise the mechanism can keep.
    const fresh: PreviewStatus = {
      id: "srv-1",
      agentId: "a1",
      projectId: "p1",
      url: "http://127.0.0.1:5203/",
      port: 5203,
      state: "serving",
      error: null,
    };
    vi.mocked(invoke).mockResolvedValue(fresh);

    return resolvePreviewOpenTarget("a1", { url: "http://127.0.0.1:5199/", port: 5199 }).then((d) => {
      expect(invoke).toHaveBeenCalledWith("preview_status", { agentId: "a1" });
      expect(d).toMatchObject({ ok: false, reason: "moved" });
      // THE SIDE EFFECT that makes the second click work.
      expect(usePreviewStore.getState().byAgent.a1?.url).toBe("http://127.0.0.1:5203/");
      expect(usePreviewStore.getState().byAgent.a1?.port).toBe(5203);
    });
  });

  it("FAILS CLOSED when the live read itself throws", () => {
    // "We could not check" is not "it is fine". An unreachable bridge is precisely when a held
    // address is least trustworthy, and falling back to it here would undo every branch above:
    // one failed read and the stale-address path is back, silently.
    vi.mocked(invoke).mockRejectedValue(new Error("bridge is down"));
    return resolvePreviewOpenTarget("a1", { url: "http://127.0.0.1:5199/", port: 5199 }).then((d) => {
      expect(d).toMatchObject({ ok: false, reason: "unreadable", heldUrl: "http://127.0.0.1:5199/" });
      expect(d).not.toHaveProperty("url");
    });
  });
});
