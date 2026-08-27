// The `preview` control op — an agent showing its OWN work in a pane (bead sparkle-3475b.6).
//
// A SEPARATE FILE from controlListener.test.ts on purpose: that file is 6k lines and several agents
// are building Preview Phase 2 concurrently, so a new suite there is a merge conflict waiting to
// happen. Nothing here re-tests the listener's shared machinery (expiry, receipts, the tier gate's
// own behaviour) — only what this op decides.
//
// WHAT IS ACTUALLY ASSERTED IS THE SIDE EFFECT: which `services/preview` wrapper ran, and with which
// arguments. A reply-only assertion would pass against a handler that refused a worker and started
// the dev server anyway, and against one that answered `list` from every agent's servers while
// claiming to be scoped.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useProjectStore } from "../stores/projectStore";
import type { PreviewState, PreviewStatus } from "../stores/previewStore";
import {
  startControlListener,
  CONCIERGE_CALLER_AGENT_ID,
  type ControlRequest,
} from "./controlListener";

// --- the Tauri event layer: capture the handler so a test can fire a control:request. ---
let firedHandler: ((e: { payload: unknown }) => void) | undefined;
const unlistenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, cb: (e: { payload: unknown }) => void) => {
    firedHandler = cb;
    return Promise.resolve(unlistenMock);
  }),
}));

const controlResponds: Array<{ reqId: string; result: unknown }> = [];
const invokeMock = vi.fn(async (cmd: string, args?: unknown) => {
  switch (cmd) {
    case "start_control_bridge":
      return { socketPath: "/tmp/control.sock", token: "tok" };
    case "control_mcp_paths":
      return { nodePath: "/node", serverPath: "/srv/control.js" };
    case "control_respond":
      controlResponds.push(args as { reqId: string; result: unknown });
      return undefined;
    case "get_config":
      return { config: {}, warnings: [] };
    default:
      return undefined;
  }
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invokeMock(...(a as [string, unknown])),
}));

// --- the preview supervisor's wrappers. Mocked so this file tests the HANDLER's decisions — which
//     wrapper it reaches for and what it hands it — rather than the Rust side, which has its own
//     suite. `importOriginal` keeps every other export real, so a sibling adding one to preview.ts
//     does not break this file. ---
interface OpenArgs {
  agentId: string;
  projectId: string;
  worktree: string;
  path?: string | null;
}
// `state` widened to the full `PreviewState` union (not just its own default) so
// `mockResolvedValueOnce` below can supply "installing"/"starting"/"listening" without a cast.
//
// The default is `ready` — the DISCOVERED state a re-attach to a live server reports — and it used
// to be `"running"`, which is not a member of `PreviewState` at all and only compiled because of
// the cast. That is the fixture equivalent of typing a wire field into a shape the producer cannot
// emit: every test resting on this default was exercising a state Rust never sends. `ready` also
// keeps those tests honest about the settle wait below, since a discovered address is precisely the
// one that passes through without a poll.
const openPreviewServerMock = vi.fn(async (_args: OpenArgs) => ({
  id: "pv1",
  url: "http://127.0.0.1:5199",
  port: 5199,
  state: "ready" as PreviewState,
}));
const stopPreviewMock = vi.fn(async (_id: string) => "stopped" as const);
const stopPreviewForAgentMock = vi.fn(async (_agentId: string) => "stopped" as const);
// Typed to the full `PreviewStatus | null` (not just its own `null` default) so the settle tests
// below can supply a DISCOVERED status via `mockResolvedValueOnce` without a cast.
const fetchPreviewStatusMock = vi.fn(async (_agentId: string): Promise<PreviewStatus | null> => null);
const listPreviewsMock = vi.fn(async () => []);
vi.mock("./preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./preview")>();
  return {
    ...actual,
    openPreviewServer: (...a: unknown[]) => openPreviewServerMock(...(a as [OpenArgs])),
    stopPreview: (...a: unknown[]) => stopPreviewMock(...(a as [string])),
    stopPreviewForAgent: (...a: unknown[]) => stopPreviewForAgentMock(...(a as [string])),
    fetchPreviewStatus: (...a: unknown[]) => fetchPreviewStatusMock(...(a as [string])),
    listPreviews: () => listPreviewsMock(),
  };
});

const fire = (req: ControlRequest) => firedHandler!({ payload: req });
const flush = () => new Promise((r) => setTimeout(r, 0));
const lastReply = () => controlResponds.at(-1)!.result as Record<string, unknown>;

describe("control op: preview", () => {
  let cleanup: (() => void) | undefined;
  let projectId: string;
  let buildId: string;
  let workerId: string;
  const WORKTREE = "/tmp/demo-worktrees/build-1";
  // A DIFFERENT path from the build agent's, deliberately: the worker tests below assert WHICH
  // checkout the supervisor was handed, and two agents sharing one string would make "served the
  // caller's own worktree" and "served the other agent's" indistinguishable.
  const WORKER_WORKTREE = "/tmp/demo-worktrees/worker-1";

  beforeEach(async () => {
    firedHandler = undefined;
    controlResponds.length = 0;
    invokeMock.mockClear();
    openPreviewServerMock.mockClear();
    stopPreviewMock.mockClear();
    stopPreviewForAgentMock.mockClear();
    fetchPreviewStatusMock.mockClear();
    listPreviewsMock.mockClear();
    useProjectStore.setState({ projects: [], selectedProjectId: null } as never);
    const store = useProjectStore.getState();
    projectId = store.addProject("Demo", "/tmp/demo");
    buildId = store.addAgent(projectId, { kind: "build" })!;
    workerId = store.addAgent(projectId, { kind: "worker", parentId: buildId })!;
    useProjectStore.getState().setAgentWorktree(projectId, buildId, WORKTREE, "sparkle/demo");
    useProjectStore
      .getState()
      .setAgentWorktree(projectId, workerId, WORKER_WORKTREE, "sparkle/w");
    cleanup = await startControlListener();
  });
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("open → starts the dev server in the CALLER's own worktree, ignoring anything the payload names", async () => {
    fire({
      reqId: "p1",
      op: "preview",
      callerAgentId: buildId,
      payload: {
        previewOp: "open",
        path: "/dashboard",
        // Everything a confused-deputy attempt would supply. `preview_open` spawns a real dev
        // server in a real checkout, so a payload-named target is the one thing that must never
        // reach it — the identity is the one the Rust bridge stamped.
        agentId: workerId,
        projectId: "another-project",
        worktree: "/etc",
      },
    });
    await flush();
    expect(openPreviewServerMock).toHaveBeenCalledTimes(1);
    expect(openPreviewServerMock).toHaveBeenCalledWith({
      agentId: buildId,
      projectId,
      worktree: WORKTREE,
      path: "/dashboard",
      target: null,
    });
    expect(lastReply()).toMatchObject({
      ok: true,
      preview: { id: "pv1", url: "http://127.0.0.1:5199", port: 5199, state: "ready" },
    });
  });

  // `target` must reach the supervisor SPELLED THE SAME as mcp-control puts it on the wire.
  // Nothing else executes both sides — mcp-control mocks Bridge and this suite calls dispatch
  // directly — so a key spelled differently in the two files is lost in transit with both suites
  // green. That is how `concierge_tool` shipped inert in v0.55.0.
  it("open with a target → forwards it to the supervisor under that exact key", async () => {
    fire({
      reqId: "pt1",
      op: "preview",
      callerAgentId: buildId,
      payload: { previewOp: "open", target: "apps/web" },
    });
    await flush();
    expect(openPreviewServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: buildId, target: "apps/web" }),
    );
  });

  // A Rust `Option<String>` crosses this bridge as an explicit `null`, never as an absent key
  // (bead `sparkle-16y6h`), so a caller mirroring that shape must be treated as "not chosen"
  // rather than refused — and must NOT reach the supervisor as the string "null".
  it("open with target: null → treated as absent, not as a choice", async () => {
    fire({
      reqId: "pt2",
      op: "preview",
      callerAgentId: buildId,
      payload: { previewOp: "open", target: null },
    });
    await flush();
    expect(openPreviewServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: buildId, target: null }),
    );
  });

  // A non-string target is refused BY NAME and starts nothing. Asserting the side effect (no
  // spawn), not just the reply: a handler that answered a refusal and still spawned would pass a
  // reply-only assertion.
  it("open with a non-string target → refused, and no dev server is started", async () => {
    fire({
      reqId: "pt3",
      op: "preview",
      callerAgentId: buildId,
      payload: { previewOp: "open", target: 42 },
    });
    await flush();
    expect(openPreviewServerMock).not.toHaveBeenCalled();
    expect(lastReply()).toMatchObject({ ok: false, code: "preview_bad_target" });
  });

  it("open without a path → opens the dev server root", async () => {
    fire({ reqId: "p2", op: "preview", callerAgentId: buildId, payload: { previewOp: "open" } });
    await flush();
    expect(openPreviewServerMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: buildId, path: null }),
    );
  });

  // A WORKER MAY NOW CALL THIS OP (beads `sparkle-q3b4c6` / `sparkle-wnnye0`). This block replaces
  // the two refusal tests that pinned the founder's 2026-08-08 interactive-only rule, which was a
  // RESOURCE bound explicitly scoped "until `[preview] idle_grace_min` lands" — it landed, and
  // `CONTROL_OP_TIERS.preview` is now `free`.
  //
  // WHAT IS ASSERTED IS THE SIDE EFFECT, not the reply: that the supervisor wrapper RAN, and ran
  // against the WORKER'S OWN worktree. A reply-only assertion would pass against a handler that
  // answered `ok` and started nothing, and against one that served the wrong checkout — which is
  // the thing that could actually go wrong here. NOTE the op DOES now take a `target`
  // parameter (bead `sparkle-eqbtqg`) — it selects among enumerated candidates and can never name
  // another agent's checkout, so the worktree assertion below is still what guards this.
  it("open from a WORKER → starts the dev server in the WORKER's own worktree", async () => {
    fire({
      reqId: "p3",
      op: "preview",
      callerAgentId: workerId,
      payload: { previewOp: "open", path: "/x" },
    });
    await flush();
    expect(openPreviewServerMock).toHaveBeenCalledTimes(1);
    expect(openPreviewServerMock).toHaveBeenCalledWith({
      agentId: workerId,
      projectId,
      worktree: WORKER_WORKTREE,
      path: "/x",
      target: null,
    });
    expect(lastReply()).toMatchObject({ ok: true, preview: { id: "pv1" } });
  });

  // The confused-deputy case for the kind that just gained access. Reaching the handler must not
  // mean reaching ANOTHER agent's checkout: a worker is the caller most likely to know a sibling's
  // id, and `open` spawns a real dev server in a real tree.
  it("open from a WORKER naming another agent → still its OWN worktree, never the named one", async () => {
    fire({
      reqId: "p3b",
      op: "preview",
      callerAgentId: workerId,
      payload: { previewOp: "open", agentId: buildId, worktree: WORKTREE, projectId: "elsewhere" },
    });
    await flush();
    expect(openPreviewServerMock).toHaveBeenCalledWith({
      agentId: workerId,
      projectId,
      worktree: WORKER_WORKTREE,
      path: null,
      target: null,
    });
  });

  it("close/list from a WORKER → reach the supervisor, scoped to the worker itself", async () => {
    fetchPreviewStatusMock.mockResolvedValueOnce({
      agentId: workerId,
      id: "pv-w",
      state: "running",
      url: "http://127.0.0.1:5200",
      port: 5200,
      error: null,
    } as never);
    fire({ reqId: "p5", op: "preview", callerAgentId: workerId, payload: { previewOp: "list" } });
    await flush();
    expect(fetchPreviewStatusMock).toHaveBeenCalledWith(workerId);
    expect(listPreviewsMock).not.toHaveBeenCalled();
    expect(lastReply()).toMatchObject({
      ok: true,
      previews: [expect.objectContaining({ agentId: workerId, id: "pv-w" })],
    });

    fire({ reqId: "p4", op: "preview", callerAgentId: workerId, payload: { previewOp: "close" } });
    await flush();
    // BY AGENT, and by the CALLER's agent — `stopPreview(id)` is never reached, so "stop a
    // sibling's server" stays unrepresentable rather than merely refused.
    expect(stopPreviewForAgentMock).toHaveBeenCalledWith(workerId);
    expect(stopPreviewMock).not.toHaveBeenCalled();
    expect(lastReply()).toMatchObject({ ok: true, outcome: "stopped" });
  });

  // THE OTHER HALF OF THE EVIDENCE. Reachability alone would also be produced by deleting the tier
  // gate outright, or by `callerMayAdminister` starting to admit workers — both of which would hand
  // an unattended worker the human's global UI and machine-wide config. So the SAME worker id, in
  // the SAME suite, must still be refused the ops that stayed `privileged`, and the assertion is
  // again the side effect: the config write command is never issued, the selection never moves.
  it("the same WORKER is still refused set_config — no config write is issued", async () => {
    invokeMock.mockClear();
    fire({
      reqId: "p3c",
      op: "set_config",
      callerAgentId: workerId,
      payload: { path: "preview.agent_eagerness", value: "always" },
    });
    await flush();
    expect(lastReply().ok).toBe(false);
    expect(String(lastReply().error)).toMatch(/interactive \(non-worker\) agents/);
    const configWrites = invokeMock.mock.calls.filter(
      ([cmd]) => cmd === "set_config_value" || cmd === "set_config_values",
    );
    expect(configWrites).toEqual([]);
  });

  it("the same WORKER is still refused navigate — the human's selection does not move", async () => {
    const selectedBefore = useProjectStore
      .getState()
      .projects.find((p) => p.id === projectId)?.selectedAgentId;
    fire({
      reqId: "p3d",
      op: "navigate",
      callerAgentId: workerId,
      payload: { view: "agent", agentId: buildId },
    });
    await flush();
    expect(lastReply().ok).toBe(false);
    expect(
      useProjectStore.getState().projects.find((p) => p.id === projectId)?.selectedAgentId,
    ).toBe(selectedBefore);
  });

  // THE SCOPING DECISION, PINNED. `preview_list` (preview.rs) returns EVERY live preview across
  // every agent, and this op deliberately does not expose that: the tool's own contract is "open /
  // close / list THIS AGENT's live browser preview", and every other per-agent op on this bridge
  // scopes strictly to the bridge-stamped caller. So `list` reads the caller's own status and the
  // all-agents read is never reached — a URL + port for another agent's worktree is exactly the
  // cross-agent leak the missing `agentId` parameter exists to prevent.
  it("list → reports the CALLER's own preview only, never the all-agents read", async () => {
    fetchPreviewStatusMock.mockResolvedValueOnce({
      agentId: buildId,
      id: "pv1",
      state: "running",
      url: "http://127.0.0.1:5199",
      port: 5199,
      error: null,
    } as never);
    fire({ reqId: "p6", op: "preview", callerAgentId: buildId, payload: { previewOp: "list" } });
    await flush();
    expect(fetchPreviewStatusMock).toHaveBeenCalledWith(buildId);
    expect(listPreviewsMock).not.toHaveBeenCalled();
    expect(lastReply()).toMatchObject({
      ok: true,
      previews: [expect.objectContaining({ agentId: buildId, id: "pv1" })],
    });
  });

  it("list with nothing running → an empty list, not an error", async () => {
    fire({ reqId: "p7", op: "preview", callerAgentId: buildId, payload: { previewOp: "list" } });
    await flush();
    expect(lastReply()).toMatchObject({ ok: true, previews: [] });
  });

  // Same reasoning as `list`, one step sharper: `stopPreview(id)` takes a server id, and a server id
  // is not proof of ownership. Routing close through `stopPreviewForAgent(callerAgentId)` makes
  // "stop someone else's preview" unrepresentable rather than refused.
  it("close → stops the CALLER's own server, and a payload-supplied id is ignored", async () => {
    fire({
      reqId: "p8",
      op: "preview",
      callerAgentId: buildId,
      payload: { previewOp: "close", id: "someone-elses-server", agentId: workerId },
    });
    await flush();
    expect(stopPreviewForAgentMock).toHaveBeenCalledWith(buildId);
    expect(stopPreviewMock).not.toHaveBeenCalled();
    expect(lastReply()).toMatchObject({ ok: true, outcome: "stopped" });
  });

  it("a missing or unknown sub-op → a refusal that names the accepted ones", async () => {
    // `{}` is what a request whose sub-op was spelled `op` actually arrives as: the envelope
    // overwrites it with "preview" and the bridge strips it as reserved. So this is not a
    // hypothetical malformed call — it is what the pre-fix client produced.
    for (const payload of [{}, { previewOp: "restart" }, { previewOp: 7 }, { op: "open" }]) {
      controlResponds.length = 0;
      fire({ reqId: "p9", op: "preview", callerAgentId: buildId, payload });
      await flush();
      const reply = lastReply();
      expect(reply.ok).toBe(false);
      expect(String(reply.error)).toMatch(/open.*close.*list/);
    }
    expect(openPreviewServerMock).not.toHaveBeenCalled();
    expect(stopPreviewForAgentMock).not.toHaveBeenCalled();
  });

  // A SECOND COPY of the client's route guard, and the duplication is deliberate — same reasoning as
  // `isLoopbackPreviewUrl` being reimplemented in TS beside the Rust gate. The Zod refinement in
  // apps/mcp-control lives in a different process's build; "the client already checked" is a claim
  // about someone else's binary, and the path ends up in a URL this window resolves.
  it.each(["//evil.example/x", "/\\evil.example", "/\t/evil.example", "http://evil.example", "dashboard"])(
    "open with %s as a path → refused before the dev server starts",
    async (bad) => {
      fire({
        reqId: "p10",
        op: "preview",
        callerAgentId: buildId,
        payload: { previewOp: "open", path: bad },
      });
      await flush();
      expect(openPreviewServerMock).not.toHaveBeenCalled();
      expect(lastReply().ok).toBe(false);
    },
  );

  it("open with a path on a caller with no worktree → a refusal that says why", async () => {
    const bare = useProjectStore.getState().addAgent(projectId, { kind: "build" })!;
    fire({ reqId: "p11", op: "preview", callerAgentId: bare, payload: { previewOp: "open" } });
    await flush();
    expect(openPreviewServerMock).not.toHaveBeenCalled();
    expect(String(lastReply().error)).toMatch(/worktree/i);
  });

  // The concierge clears the tier gate (it is the human's own front-of-house), so the refusal has to
  // come from the handler. It is a headless `claude -p` child with no roster row and no checkout, so
  // there is no worktree to serve — the same reason `send_peer_message` refuses it.
  it("the concierge is refused — it has no worktree to preview", async () => {
    fire({
      reqId: "p12",
      op: "preview",
      callerAgentId: CONCIERGE_CALLER_AGENT_ID,
      payload: { previewOp: "list" },
    });
    await flush();
    expect(lastReply().ok).toBe(false);
    expect(fetchPreviewStatusMock).not.toHaveBeenCalled();
  });

  // roborev 63997 on `80618aa6f`: `PreviewManager::reserve_or_reattach` (preview.rs) sends
  // `url: ""` / `port: 0` for a re-attach to a server with no port allocated yet — reachable not
  // only while `state === "installing"` but also during the ordinary `starting` window before the
  // spawn's port lands (the map entry starts life at `state: "starting", port: None` for every
  // open, deps-wait or not). The handler must strip the address on EITHER state, keyed on the
  // address being empty rather than on which state produced it — an earlier draft keyed on
  // `state === "installing"` alone and missed the `starting` case entirely.
  it.each(["installing", "starting"] as const)(
    "open reattaching to a server with no port yet (state %s) → strips the fake url/port",
    async (state) => {
      openPreviewServerMock.mockResolvedValueOnce({ id: "pv1", url: "", port: 0, state });
      fire({ reqId: "p14", op: "preview", callerAgentId: buildId, payload: { previewOp: "open" } });
      await flush();
      expect(lastReply()).toEqual({ ok: true, preview: { id: "pv1", state } });
    },
  );

  // A POST-DISCOVERY state passes straight through, and must NOT be made to wait. Each of these is
  // only reached from `supervise`'s `discover_port` (preview.rs), so its address is already the
  // BOUND one — polling again would add a round trip to every re-attach for an answer we hold.
  //
  // `starting` deliberately does NOT appear in these rows; see the settle tests below for why its
  // address is the one thing that must never pass through. That split is also what still
  // discriminates roborev 64017's state-keyed strip: a guard keyed on the STATE alone would strip
  // these replies' real addresses too, and these rows go red if anyone reintroduces one.
  //
  // ── WHY THIS IS A MATRIX AND NOT ONE ROW (bead `sparkle-ym3bh5`) ──────────────────────────────
  //
  // Both axes are here because a single row could be satisfied without the handler reading
  // anything:
  //
  //   * THE ADDRESS AXIS. The previous version asserted `port: 5199` against a mock that returned
  //     5199 — the value that happened to come back, which is exactly the shape that let this
  //     suite pin the PREDICTED port as correct for a `starting` reply and protect the bug with
  //     its own green test. Two distinct addresses leave no constant that passes both rows, so the
  //     only implementation that satisfies them is one that actually forwards what it was given.
  //   * THE STATE AXIS. `PREVIEW_DISCOVERED_STATES` in controlListener.ts has THREE members and
  //     this row covered one. That set is deliberately not exported (an export whose only importer
  //     is a test is its own defect), so the list below is a hand-kept mirror: adding a member
  //     there without adding a row here leaves the new state's fast path unexercised.
  const DISCOVERED_ADDRESSES = [
    [5199, "http://127.0.0.1:5199"],
    [4173, "http://127.0.0.1:4173"],
  ] as const;
  const DISCOVERED_STATES = ["listening", "ready", "serving"] as const;
  it.each(
    DISCOVERED_STATES.flatMap((state) =>
      DISCOVERED_ADDRESSES.map(([port, url]) => [state, port, url] as const),
    ),
  )(
    "open with an already-DISCOVERED port (state %s, port %i) → that exact url/port pass through, unpolled",
    async (state, port, url) => {
      openPreviewServerMock.mockResolvedValueOnce({ id: "pv1", url, port, state });
      fire({ reqId: "p15", op: "preview", callerAgentId: buildId, payload: { previewOp: "open" } });
      await flush();
      const preview = lastReply().preview as { url: string; port: number; state: string; id: string };
      expect(preview).toEqual({ id: "pv1", url, port, state });
      // THE CAPABILITY, not the value: the link the caller is handed must name the port the caller
      // is told about. A reply that paired one row's url with the other's port would satisfy the
      // equality above only by accident of the fixture, and would still be an address nothing
      // serves — which is the whole class of defect this file exists to keep out.
      expect(preview.url).toContain(String(preview.port));
      // …and it is not the OTHER row's address, so a constant is unsatisfiable in both directions.
      const other = DISCOVERED_ADDRESSES.find(([p]) => p !== port)!;
      expect(preview.port).not.toBe(other[0]);
      expect(preview.url).not.toContain(String(other[0]));
      expect(fetchPreviewStatusMock).not.toHaveBeenCalled();
    },
  );

  // ─── THE BOUND PORT, NOT THE REQUESTED ONE ────────────────────────────────────────────────────
  //
  // `preview_open` returns BEFORE the dev server has listened: `open_reserved`'s tail is
  // `PreviewOpened { url: preview_url_for(port), port, state: Starting }` where `port` is the one
  // SPARKLE ASKED FOR. That address is a PREDICTION, and the prediction is wrong exactly when it
  // matters: `Framework::Unknown` gets no port flag at all (`port_args`'s `_ => Vec::new()` arm),
  // and a framework free to hop off a taken port does so silently. `supervise` then discovers the
  // REAL port and `transition`s the manager onto it — but that correction only ever reached the
  // pane, over the `preview:state` event. The agent that called this op got the guess, reported it
  // to the human, and the link opened a port nothing was serving.
  //
  // THIS IS THE ROW THAT FAILS IF A CONSTANT PORT IS USED, and BOTH of its numbers vary for exactly
  // that reason (bead `sparkle-ym3bh5`). The requested port and the bound port are different in
  // every row, so an implementation that echoes `opened.port` cannot satisfy any of them — but a
  // single row asserting `port: 3000` would also be satisfied by a hardcoded 3000, which is the
  // same defect wearing the answer as a costume. TWO different bound ports leave no constant that
  // passes both.
  //
  // THE REQUESTED PORT VARIES TOO, which the earlier version held fixed at 5199. A fixed prediction
  // cannot discriminate "forwards the observed port" from "special-cases the one number this
  // fixture always predicts" — the second is not a real implementation, but it is exactly the
  // reasoning a fixture teaches the next reader, and the whole bead is about a suite teaching the
  // wrong thing with a green tick.
  it.each([
    [5199, 3000, "http://127.0.0.1:3000"],
    [5200, 4321, "http://127.0.0.1:4321"],
  ])(
    "open → the reply carries the port the dev server actually BOUND (%i predicted → %i bound), not the one Sparkle asked for",
    async (requestedPort, boundPort, boundUrl) => {
      openPreviewServerMock.mockResolvedValueOnce({
        id: "pv1",
        url: `http://127.0.0.1:${requestedPort}`,
        port: requestedPort,
        state: "starting",
      });
      fetchPreviewStatusMock.mockResolvedValueOnce({
        id: "pv1",
        agentId: buildId,
        projectId,
        url: boundUrl,
        port: boundPort,
        state: "ready",
        error: null,
      });
      fire({ reqId: "p16", op: "preview", callerAgentId: buildId, payload: { previewOp: "open" } });
      await flush();
      expect(fetchPreviewStatusMock).toHaveBeenCalledWith(buildId);
      const preview = lastReply().preview as { url: string; port: number; state: string; id: string };
      expect(preview).toEqual({ id: "pv1", url: boundUrl, port: boundPort, state: "ready" });
      expect(preview.port).not.toBe(requestedPort);
      expect(preview.url).not.toContain(String(requestedPort));
      // THE CAPABILITY THE CALLER ACTUALLY HAS: the link it is handed points at the port the dev
      // server is on. Asserting the url and the port agree is what makes "the link opens the
      // running server" a property of the reply rather than a coincidence of the fixture.
      expect(preview.url).toContain(String(preview.port));
    },
  );

  // The settle wait is bounded by an ANSWER as well as by its deadline. A server that died before
  // listening will never produce a port, so waiting out the full budget would hold the op open for
  // twenty seconds to return the same "no address" it can already give.
  it.each(["failed", "crashed", "stopped"] as const)(
    "open whose server reaches a terminal state (%s) → gives up at once with no address",
    async (state) => {
      openPreviewServerMock.mockResolvedValueOnce({
        id: "pv1",
        url: "http://127.0.0.1:5199",
        port: 5199,
        state: "starting",
      });
      fetchPreviewStatusMock.mockResolvedValueOnce({
        id: "pv1",
        agentId: buildId,
        projectId,
        url: null,
        port: null,
        state,
        error: "the dev server exited before it started listening.",
      });
      fire({ reqId: "p17", op: "preview", callerAgentId: buildId, payload: { previewOp: "open" } });
      await flush();
      expect(fetchPreviewStatusMock).toHaveBeenCalledTimes(1);
      expect(lastReply()).toEqual({ ok: true, preview: { id: "pv1", state } });
    },
  );

  // `fetchPreviewStatus` is keyed by AGENT, not by preview id, and one agent holds one preview. So a
  // concurrent stop-and-reopen inside the settle window replaces the entry under us, and the status
  // we read then describes a DIFFERENT server than the one this call opened. Pairing that server's
  // port with our own preview's id would report an address the id does not name — a quieter version
  // of the same defect this whole function exists to remove, since the caller would be told a
  // specific preview is reachable somewhere it is not.
  //
  // The honest answer is that OUR preview has no address, plus the freshest state observed.
  it("open whose preview is REPLACED mid-wait → reports no address, never the replacement's port", async () => {
    openPreviewServerMock.mockResolvedValueOnce({
      id: "pv1",
      url: "http://127.0.0.1:5199",
      port: 5199,
      state: "starting",
    });
    // A different id: the entry this agent holds is no longer the one we opened.
    fetchPreviewStatusMock.mockResolvedValueOnce({
      id: "pv2",
      agentId: buildId,
      projectId,
      url: "http://127.0.0.1:3000",
      port: 3000,
      state: "ready",
      error: null,
    });
    fire({ reqId: "p19", op: "preview", callerAgentId: buildId, payload: { previewOp: "open" } });
    await flush();
    const reply = lastReply();
    expect(reply).toEqual({ ok: true, preview: { id: "pv1", state: "ready" } });
    // The replacement's address must not be attributed to our preview.
    expect(JSON.stringify(reply)).not.toContain("3000");
    expect(JSON.stringify(reply)).not.toContain("pv2");
  });

  // A fresh open whose address never settles must report NO address rather than the guess. The
  // `{ id, state }` shape is the contract this op already defines for "started, nothing to point a
  // browser at yet" — the caller watches the pane, which the `preview:state` event still populates.
  it("open that never discovers a port → reports no address rather than the requested one", async () => {
    openPreviewServerMock.mockResolvedValueOnce({
      id: "pv1",
      url: "http://127.0.0.1:5199",
      port: 5199,
      state: "starting",
    });
    // `null` = the supervisor has no entry for this agent, so there is nothing left to wait for.
    fetchPreviewStatusMock.mockResolvedValueOnce(null);
    fire({ reqId: "p18", op: "preview", callerAgentId: buildId, payload: { previewOp: "open" } });
    await flush();
    const reply = lastReply();
    expect(reply).toEqual({ ok: true, preview: { id: "pv1", state: "starting" } });
    expect(JSON.stringify(reply)).not.toContain("5199");
  });

  it("a failing supervisor call is reported as a refusal, not as a thrown op", async () => {
    openPreviewServerMock.mockRejectedValueOnce(new Error("already-starting"));
    fire({ reqId: "p13", op: "preview", callerAgentId: buildId, payload: { previewOp: "open" } });
    await flush();
    const reply = lastReply();
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toMatch(/already-starting/);
  });
});
