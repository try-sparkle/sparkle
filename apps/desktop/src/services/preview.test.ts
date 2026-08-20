// The loopback gate and the wire→store fold. No Tauri bridge is exercised here on purpose: the
// point of routing every invoke through this module is that everything ELSE can be tested without
// one, and the two pieces worth pinning are the pure predicate and the null-handling of the fold.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { invoke } from "@tauri-apps/api/core";
import {
  applyPreviewStatus,
  isLoopbackPreviewUrl,
  openPreviewServer,
  refreshPreviewCapability,
} from "./preview";
import { usePreviewStore } from "../stores/previewStore";

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
