// Tests for the WIRING — the file that has no pure logic and is therefore the one nobody tests.
//
// That is exactly why it needs them. Every module beside it (`parseMentionTokens`,
// `mentionMessages`, `beadMentionRouter`, `specialTargets`) has its own suite and is driven with
// injected seams; this file is the only place where the real store shapes, the real `invoke`
// argument names, and the real cross-tick state handling actually appear. A review of the first
// draft found three defects and ALL THREE lived here, precisely because nothing exercised it: the
// candidate list reached across every project, the persisted ledger outlived the project whose path
// it posts through, and the whole thing was reachable only by reading it.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
const projectState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const beadsState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const openIds = vi.hoisted(() => ({ current: new Set<string>() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("../../stores/projectStore", () => ({
  useProjectStore: { getState: () => projectState.current },
}));
vi.mock("../../stores/beadsStore", () => ({
  useBeadsStore: { getState: () => beadsState.current },
}));
// PARTIAL mock: `specialTargets` pulls in `controlListener`, which uses other exports of this module
// (`findKnownAgent`). Replacing the whole module would break that import chain rather than the one
// function under control here.
vi.mock("../knownAgents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../knownAgents")>()),
  openAgentIdSet: () => openIds.current,
}));
vi.mock("../beadsCommands", () => ({
  beadsDetail: vi.fn(async () => ({ comments: [] })),
  beadsComment: vi.fn(async () => undefined),
}));

import { SPARKLE_AGENT_ID } from "../sparkleAgent";
import { resolveAgentMention } from "../agentMentionResolve";
import {
  createRouterDeps,
  liveMentionCandidates,
  resetMentionStateCache,
  startBeadMentionWatch,
  storageKeyFor,
} from "./beadMentionWatch";
import { beadsComment, beadsDetail } from "../beadsCommands";
import { runMentionTick } from "./beadMentionRouter";

const agent = (id: string, name: string) => ({
  id,
  name,
  namePinned: true,
  selfNamed: false,
  aiTitle: undefined,
  autoNameVariants: null,
});

beforeEach(() => {
  invokeMock.mockReset();
  localStorage.clear();
  resetMentionStateCache();
  vi.mocked(beadsDetail).mockReset();
  // RESET THIS TOO. It was the one mock the suite never cleared, so its `mock.calls` accumulated
  // across every test in the module — making "a comment was posted" satisfiable by an EARLIER test
  // and the assertion order-dependent rather than a statement about the tick under test.
  vi.mocked(beadsComment).mockReset();
  vi.mocked(beadsComment).mockResolvedValue(undefined as never);
  vi.mocked(beadsDetail).mockResolvedValue({ comments: [] } as never);
  openIds.current = new Set(["a-1", "b-1"]);
  projectState.current = {
    selectedProjectId: "proj-a",
    projects: [
      { id: "proj-a", rootPath: "/repo/a", agents: [agent("a-1", "Rust Half")] },
      { id: "proj-b", rootPath: "/repo/b", agents: [agent("b-1", "Rust Half")] },
    ],
  };
  beadsState.current = { byProject: {} };
});

describe("liveMentionCandidates — resolution never leaves the project", () => {
  it("offers only the NAMED project's agents, not every project's", () => {
    expect(liveMentionCandidates("proj-a").map((c) => c.id)).toContain("a-1");
    expect(liveMentionCandidates("proj-a").map((c) => c.id)).not.toContain("b-1");
  });

  it("a name shared across TWO projects is not an ambiguity within one of them", () => {
    // THE FAILURE THIS PINS, asserted through the real resolver rather than by counting the array.
    // Two projects each holding an open agent named "Rust Half" made every `@Rust Half` in project A
    // resolve `ambiguous` — so no doorbell was EVER delivered — and each such comment posted a
    // refusal onto A's bead naming project B's agent id, writing another project's roster into a
    // shared, founder-visible store.
    const verdict = resolveAgentMention(liveMentionCandidates("proj-a"), "Rust Half");
    expect(verdict.kind).toBe("ok");
    expect(verdict.kind === "ok" && verdict.id).toBe("a-1");
  });

  it("excludes an agent whose pane is closed — nothing could deliver to it", () => {
    openIds.current = new Set();
    expect(liveMentionCandidates("proj-a").map((c) => c.id)).not.toContain("a-1");
  });

  it("does NOT fold the reserved handles into the roster list", () => {
    // They are resolved AHEAD of the roster instead (see `createRouterDeps` below). Concatenating
    // them here is what let a roster agent named "Improve Sparkle" collide with the reserved handle
    // and make the app's own address resolve `ambiguous`.
    expect(liveMentionCandidates("proj-a").map((c) => c.name)).not.toContain("improve");
  });

  it("the reserved handles reach the router through their own resolver, case-insensitively", () => {
    const deps = createRouterDeps("proj-a", "/repo/a");
    expect(deps.resolveSpecialHandle?.("improve")?.id).toBe(SPARKLE_AGENT_ID);
    expect(deps.resolveSpecialHandle?.("Sparkle")?.id).toBe("sparkle:concierge");
    // And the parser is told their spellings, or a multi-word one is truncated at the first word.
    expect(deps.specialHandleNames).toContain("Improve Sparkle");
  });

  it("a roster agent named like a reserved handle does not shadow it", () => {
    projectState.current = {
      selectedProjectId: "proj-a",
      projects: [
        { id: "proj-a", rootPath: "/repo/a", agents: [agent("a-1", "Improve Sparkle")] },
      ],
    };
    openIds.current = new Set(["a-1"]);
    const deps = createRouterDeps("proj-a", "/repo/a");
    // Reserved wins; the roster row stays reachable by its id.
    expect(deps.resolveSpecialHandle?.("Improve Sparkle")?.id).toBe(SPARKLE_AGENT_ID);
    expect(resolveAgentMention(liveMentionCandidates("proj-a"), "a-1").kind).toBe("ok");
  });

  it("an unknown project yields no roster agents rather than falling back to all of them", () => {
    expect(liveMentionCandidates("nope").map((c) => c.id)).not.toContain("a-1");
  });
});

/** Let the watcher's immediate first tick run to completion. */
const settle = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

describe("startBeadMentionWatch — the real entry point", () => {
  const beadOnBoard = (commentCount: number) => {
    beadsState.current = {
      byProject: { "proj-a": { beads: [{ id: "sparkle-1", commentCount }] } },
    };
  };

  it("SEEDS on first sight and writes the baseline under THIS project's key", async () => {
    // Asserts the STORED VALUE under the project's own key, not that two key strings differ. The
    // defect lived in load/save/tick reading a module-level constant — reverting those three call
    // sites while leaving `storageKeyFor` exported kept a key-equality test perfectly green.
    beadOnBoard(3);
    const stop = startBeadMentionWatch();
    await settle();
    stop();

    const stored = JSON.parse(localStorage.getItem(storageKeyFor("proj-a")) ?? "{}");
    expect(stored.baselines).toEqual({ "sparkle-1": 3 });
    expect(localStorage.getItem(storageKeyFor("proj-b"))).toBeNull();
    // Seeding routes nothing — the whole point of the seed rule.
    expect(invokeMock).not.toHaveBeenCalledWith("inbox_send", expect.anything());
  });

  it("routes a NEW comment on the next tick, end to end through the real glue", async () => {
    beadOnBoard(0);
    let stop = startBeadMentionWatch();
    await settle();
    stop();

    vi.mocked(beadsDetail).mockResolvedValue({
      comments: [{ id: "c1", author: "Someone", text: "@Rust Half stand down" }],
    } as never);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "inbox_peek" ? [{ agentId: "a-1", entries: [] }] : "msg-1",
    );
    beadOnBoard(1);

    stop = startBeadMentionWatch();
    await settle();
    stop();

    // THE SIDE EFFECT, through the production path: store shapes, project resolution, invoke names.
    expect(invokeMock).toHaveBeenCalledWith(
      "inbox_send",
      expect.objectContaining({ agentId: "a-1", severity: "act" }),
    );
  });

  it("a switch to another project reads NO baseline and seeds rather than routing", async () => {
    beadOnBoard(0);
    let stop = startBeadMentionWatch();
    await settle();
    stop();

    // Same bead id, different project — its baseline must not be inherited.
    projectState.current = {
      ...projectState.current,
      selectedProjectId: "proj-b",
    };
    beadsState.current = {
      byProject: { "proj-b": { beads: [{ id: "sparkle-1", commentCount: 5 }] } },
    };
    vi.mocked(beadsDetail).mockResolvedValue({
      comments: [{ id: "c1", author: "x", text: "@Rust Half hi" }],
    } as never);

    stop = startBeadMentionWatch();
    await settle();
    stop();

    expect(invokeMock).not.toHaveBeenCalledWith("inbox_send", expect.anything());
    const stored = JSON.parse(localStorage.getItem(storageKeyFor("proj-b")) ?? "{}");
    expect(stored.baselines).toEqual({ "sparkle-1": 5 });
  });

  it("keeps routing when localStorage cannot be written", async () => {
    // Storage was briefly the ONLY authority, so one swallowed QuotaExceededError meant every later
    // tick loaded an empty state, re-seeded every bead, and routed NOTHING — forever, silently. The
    // in-memory map is the authority; storage is a write-through cache.
    beadOnBoard(0);
    let stop = startBeadMentionWatch();
    await settle();
    stop();

    // Swap the GLOBAL, don't spy on `Storage.prototype`. `Storage` is a DOM class: it exists under
    // jsdom and is undefined in a plain node environment, so the spy threw `ReferenceError: Storage
    // is not defined` in CI while passing locally — and, locally, a prototype spy never intercepted
    // the node-env memory shim either, so it was inert in both directions.
    //
    // RESTORED IN `finally`, AND THAT IS LOAD-BEARING. A bare restore after the awaits is skipped on
    // ANY non-local exit — a throw out of `startBeadMentionWatch()`/`stop()`, or the test timeout
    // firing inside `settle()` — which leaves the throwing stub installed on `globalThis` for the
    // rest of the FILE: `beforeEach`'s `clear()` becomes a silent no-op, `getItem` always returns
    // null, and every later persistence test fails while naming code that is not at fault. `retry`
    // makes it permanent rather than transient, because the re-run captures the STUB as the
    // "original" and faithfully restores that. Descriptor capture + `finally` is the idiom the
    // sibling `columnResize.test.ts` already uses.
    const realDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
        removeItem: () => undefined,
        clear: () => undefined,
      },
    });
    try {
      vi.mocked(beadsDetail).mockResolvedValue({
        comments: [{ id: "c1", author: "x", text: "@Rust Half hi" }],
      } as never);
      invokeMock.mockImplementation(async (cmd: string) =>
        cmd === "inbox_peek" ? [{ agentId: "a-1", entries: [] }] : "msg-1",
      );
      beadOnBoard(1);

      stop = startBeadMentionWatch();
      await settle();
      stop();
      expect(invokeMock).toHaveBeenCalledWith("inbox_send", expect.anything());

      // A SECOND TICK, and it is the whole point. With only one post-swap tick the assertion is
      // satisfied by call ordering alone — `runMentionTick` dispatches `inbox_send` BEFORE
      // `saveState` is ever reached, so deleting the write-side try/catch, or moving
      // `memory.set(...)` to AFTER the throwing `setItem`, both leave it green. The second of those
      // IS the defect the comment above names: state never reaches memory, `getItem` returns null,
      // and every later tick re-seeds and routes NOTHING. Only a later tick can see it — and with
      // the stub installed, the ONLY way this one can route is if memory carried the baseline.
      vi.mocked(beadsDetail).mockResolvedValue({
        comments: [
          { id: "c1", author: "x", text: "@Rust Half hi" },
          { id: "c2", author: "x", text: "@Rust Half again" },
        ],
      } as never);
      beadOnBoard(2);

      stop = startBeadMentionWatch();
      await settle();
      stop();

      const sends = invokeMock.mock.calls.filter(([c]) => c === "inbox_send");
      expect(sends).toHaveLength(2);
    } finally {
      if (realDescriptor) {
        Object.defineProperty(globalThis, "localStorage", realDescriptor);
      } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
      }
    }
  });
});

describe("END TO END through the PRODUCTION adapter — no stubbed sender", () => {
  // WHY THIS EXISTS. Every reserved-handle test in `beadMentionRouter.test.ts` injects a fake
  // `sendViaMentionChannel`, and a fake accepts whatever it is handed — so it cannot see the caller
  // passing the wrong ARGUMENT. That is exactly how the raw author-typed token reached
  // `wireHandleFor` (which compares against agent ids), returned null, and made every
  // @improve/@sparkle/@concierge mention throw and report as enqueue-failed with no doorbell and no
  // wake, while the whole suite stayed green. Same shape as `inbox_send` returning ok for a message
  // that never arrived: a green suite proved nothing.
  //
  // So this drives the REAL router with the REAL `createRouterDeps`, mocking only `invoke` — the
  // process boundary, the lowest layer reachable from vitest. Everything between the comment text
  // and the Tauri command is production code.
  const seedBead = (commentCount: number) => {
    beadsState.current = {
      byProject: { "proj-a": { beads: [{ id: "sparkle-1", commentCount }] } },
    };
  };

  it("an @improve comment reaches mention_send with the CANONICAL handle", async () => {
    seedBead(1);
    vi.mocked(beadsDetail).mockResolvedValue({
      comments: [{ id: "c1", author: "Someone", text: "@improve stand down" }],
    } as never);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "mention_send") {
        return { round: 1, doorbelled: true, spawned: true, wakeSparkle: false, capped: false, messageId: "m-1" };
      }
      if (cmd === "mention_status") {
        return { round: 1, awaitingAckRound: 1, acked: false, overdue: false };
      }
      return null;
    });

    const { report } = await runMentionTick(
      { baselines: { "sparkle-1": 0 }, accounted: {}, processed: [], ledger: [] },
      [{ id: "sparkle-1", commentCount: 1 }],
      createRouterDeps("proj-a", "/repo/a"),
    );

    const send = invokeMock.mock.calls.find(([c]) => c === "mention_send");
    // THE VALUE THAT ACTUALLY REACHED THE PRODUCTION ADAPTER, resolved through wireHandleFor.
    expect(send, "mention_send was never invoked — the reserved path is inert").toBeDefined();
    expect(send![1]).toMatchObject({ target: "improve", threadRef: "sparkle-1" });
    // WHAT THIS DOES AND DOES NOT PROVE. It proves the send crossed the boundary with the handle
    // Rust accepts, and that the router recorded a doorbell for the right agent — which is what
    // goes red when `wireHandleFor` returns null and the send throws. It does NOT prove a recipient
    // read anything: the recipient is on the far side of the mocked process boundary, and queued
    // is not delivered is not read. Proof of READING is the bead's ACK comment, checked by
    // `readMentionStatus` and covered in the router's own suite.
    expect(report.doorbelled).toEqual([
      expect.objectContaining({ agentId: "__sparkle_self__", beadId: "sparkle-1" }),
    ]);
    expect(report.unresolved).toHaveLength(0);
  });

  it("the multi-word display-name spelling reaches it too", async () => {
    // `SPECIAL_CANDIDATES` registers "Improve Sparkle" so the parser captures it whole; the channel
    // only accepts `improve`. This is the spelling that broke first.
    seedBead(1);
    vi.mocked(beadsDetail).mockResolvedValue({
      comments: [{ id: "c1", author: "x", text: "@Improve Sparkle stand down" }],
    } as never);
    invokeMock.mockImplementation(async (cmd: string) =>
      cmd === "mention_send"
        ? { round: 1, doorbelled: true, spawned: true, wakeSparkle: false, capped: false, messageId: "m-1" }
        : { round: 1, awaitingAckRound: 1, acked: false, overdue: false },
    );

    const { report } = await runMentionTick(
      { baselines: { "sparkle-1": 0 }, accounted: {}, processed: [], ledger: [] },
      [{ id: "sparkle-1", commentCount: 1 }],
      createRouterDeps("proj-a", "/repo/a"),
    );

    expect(invokeMock.mock.calls.find(([c]) => c === "mention_send")![1]).toMatchObject({
      target: "improve",
    });
    expect(report.doorbelled).toHaveLength(1);
  });

  it("@sparkle and @concierge both reach it as `sparkle`", async () => {
    for (const spelling of ["@sparkle", "@concierge"]) {
      invokeMock.mockReset();
      resetMentionStateCache();
      seedBead(1);
      vi.mocked(beadsDetail).mockResolvedValue({
        comments: [{ id: `c-${spelling}`, author: "x", text: `${spelling} look` }],
      } as never);
      invokeMock.mockImplementation(async (cmd: string) =>
        cmd === "mention_send"
          ? { round: 1, doorbelled: true, spawned: false, wakeSparkle: true, capped: false, messageId: "m" }
          : { round: 1, awaitingAckRound: 1, acked: false, overdue: false },
      );

      const { report } = await runMentionTick(
        { baselines: { "sparkle-1": 0 }, accounted: {}, processed: [], ledger: [] },
        [{ id: "sparkle-1", commentCount: 1 }],
        createRouterDeps("proj-a", "/repo/a"),
      );

      const send = invokeMock.mock.calls.find(([c]) => c === "mention_send");
      expect(send, `${spelling} never reached mention_send`).toBeDefined();
      expect(send![1]).toMatchObject({ target: "sparkle" });
      expect(report.doorbelled).toHaveLength(1);
    }
  });

  it("a FAILED send is reported as undelivered on the bead, never swallowed", async () => {
    seedBead(1);
    vi.mocked(beadsDetail).mockResolvedValue({
      comments: [{ id: "c1", author: "x", text: "@improve stand down" }],
    } as never);
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "mention_send") throw new Error("channel refused");
      return { round: 0, awaitingAckRound: 0, acked: false, overdue: false };
    });

    const { report } = await runMentionTick(
      { baselines: { "sparkle-1": 0 }, accounted: {}, processed: [], ledger: [] },
      [{ id: "sparkle-1", commentCount: 1 }],
      createRouterDeps("proj-a", "/repo/a"),
    );

    expect(report.doorbelled).toHaveLength(0);
    expect(report.unresolved).toMatchObject([{ reason: "enqueue-failed" }]);
    // Visible to whoever wrote the comment — a swallowed failure is the bug this feature removes.
    // Asserted on the FULL argument list, not just the text: a report posted through the wrong
    // project's path or onto the wrong bead is the failure the per-project keying note in
    // `beadMentionWatch.ts` exists to prevent, and reading only the text cannot see it.
    expect(vi.mocked(beadsComment)).toHaveBeenCalledTimes(1);
    const [path, bead, posted] = vi.mocked(beadsComment).mock.calls[0]!;
    expect(path).toBe("/repo/a");
    expect(bead).toBe("sparkle-1");
    expect(posted).toContain("NOT DELIVERED");
  });
});

describe("persisted state round-trips every field it needs", () => {
  it("reads `accounted` back out of storage — the slice offset must survive a restart", async () => {
    // `saveState` wrote it, `loadState` rebuilt the state from a literal that omitted it, and
    // nothing read it back — so on every cold start the slice offset fell back to the LIST COUNT,
    // which is precisely the defect `accounted` exists to remove. The other persistence tests only
    // read `stored.baselines`, so none of them covered the shape `loadState` builds.
    beadsState.current = {
      byProject: { "proj-a": { beads: [{ id: "sparkle-1", commentCount: 2 }] } },
    };
    vi.mocked(beadsDetail).mockResolvedValue({
      comments: [{ id: "c1", author: "x", text: "one" }],
    } as never);

    // Tick 1 seeds; tick 2 reads and records what the detail actually returned.
    let stop = startBeadMentionWatch();
    await settle();
    stop();
    beadsState.current = {
      byProject: { "proj-a": { beads: [{ id: "sparkle-1", commentCount: 3 }] } },
    };
    stop = startBeadMentionWatch();
    await settle();
    stop();

    const stored = JSON.parse(localStorage.getItem(storageKeyFor("proj-a")) ?? "{}");
    expect(stored.accounted).toEqual({ "sparkle-1": 1 });

    // A cold start (empty in-memory map) must recover it rather than falling back to the count.
    resetMentionStateCache();
    stop = startBeadMentionWatch();
    await settle();
    stop();
    const after = JSON.parse(localStorage.getItem(storageKeyFor("proj-a")) ?? "{}");
    expect(after.accounted).toEqual({ "sparkle-1": 1 });
  });
});

describe("the persisted state is keyed PER PROJECT", () => {
  it("two projects do not share one ledger", () => {
    // The ledger outlives a project switch, while `postComment` is bound to whichever project is
    // selected NOW. One shared key posts project A's UNDELIVERED report into project B's bd store,
    // where the bead id does not exist — the write fails, nothing latches, and the doomed comment is
    // retried every tick for 13 hours while the guarantee this feature exists for silently lapses.
    expect(storageKeyFor("proj-a")).not.toBe(storageKeyFor("proj-b"));
  });

  it("the key names the project, so a stale global key cannot be read as either", () => {
    expect(storageKeyFor("proj-a")).toContain("proj-a");
  });
});

describe("createRouterDeps — the real invoke shapes", () => {
  it("queues the doorbell through inbox_send with the argument names Rust expects", async () => {
    invokeMock.mockResolvedValue("msg-1");
    const deps = createRouterDeps("proj-a", "/repo/a");

    const id = await deps.enqueueDoorbell("a-1", "ding", "Improve Sparkle");

    expect(id).toBe("msg-1");
    // Asserted by NAME, not shape: a renamed field (agentId vs agent_id) would leave every doorbell
    // undelivered while the router's own suite — fed a fake enqueue — stayed green.
    expect(invokeMock).toHaveBeenCalledWith("inbox_send", {
      agentId: "a-1",
      text: "ding",
      severity: "act",
      from: "Improve Sparkle",
    });
  });

  it("reads delivery state through inbox_peek and flattens it onto message ids", async () => {
    invokeMock.mockResolvedValue([
      {
        agentId: "a-1",
        entries: [
          { id: "m1", state: "pending" },
          { id: "m2", state: "acknowledged" },
        ],
      },
    ]);
    const deps = createRouterDeps("proj-a", "/repo/a");

    const states = await deps.readDoorbellStates("a-1");

    expect(invokeMock).toHaveBeenCalledWith("inbox_peek", { agentIds: ["a-1"] });
    expect(states.get("m1")).toBe("pending");
    expect(states.get("m2")).toBe("acknowledged");
    // A message id nobody reported is NOT delivered — the router reads `undefined` as `missing`.
    expect(states.get("m3")).toBeUndefined();
  });

  it("REFUSES a malformed inbox_peek payload rather than reporting an empty queue", async () => {
    // Fails closed. An empty map would make the router read every outstanding doorbell as `missing`
    // and announce them all undelivered — inventing a verdict for a queue it could not read.
    invokeMock.mockResolvedValue("not-an-array");
    const deps = createRouterDeps("proj-a", "/repo/a");
    await expect(deps.readDoorbellStates("a-1")).rejects.toThrow(/expected an array/);
  });

  it("calls mention_send with the CANONICAL handle, not the token the author typed", async () => {
    // THE SEAM THAT WAS UNTESTED, AND THE BUG IT LET THROUGH. `SPECIAL_CANDIDATES` registers the
    // display-name spelling "Improve Sparkle" so the parser captures it whole, but
    // `mention.rs::resolve_handle` accepts only improve/sparkle/concierge. Forwarding the raw token
    // made the invoke reject, which the caller recorded as an inbox failure that never happened —
    // no doorbell queued at all, and a bead comment blaming the target's inbox.
    invokeMock.mockResolvedValue({
      round: 3,
      doorbelled: true,
      spawned: true,
      wakeSparkle: false,
      capped: false,
      messageId: "m-1",
    });
    const deps = createRouterDeps("proj-a", "/repo/a");

    const out = await deps.sendViaMentionChannel!("__sparkle_self__", "sparkle-1", "Someone");

    expect(out.doorbelled).toBe(true);
    // The ROUND is carried through, or the sweep cannot match a verdict to the entry it describes.
    expect(out.round).toBe(3);
    const [cmd, args] = invokeMock.mock.calls[0]!;
    expect(cmd).toBe("mention_send");
    // Asserted by NAME: a renamed argument leaves the channel rejecting every send while the
    // router's own suite — fed a stubbed sender — stays green.
    expect(args).toMatchObject({
      projectPath: "/repo/a",
      target: "improve",
      threadRef: "sparkle-1",
      from: "Someone",
      provenance: "own",
      bodyOnThread: true,
    });
    // The body must be non-empty (the channel refuses an empty one) but must NOT be the comment
    // text — its rule 1 is that the inbox never carries the message.
    expect(String((args as { body: string }).body)).toContain("sparkle-1");
    // And a finite cap is asked for explicitly, or six mentions retire a bead forever.
    expect((args as { maxRounds: number }).maxRounds).toBeGreaterThan(6);
  });

  it("maps the concierge id to its own canonical handle", async () => {
    invokeMock.mockResolvedValue({
      round: 1,
      doorbelled: true,
      spawned: false,
      wakeSparkle: true,
      capped: false,
      messageId: "m-2",
    });
    const deps = createRouterDeps("proj-a", "/repo/a");
    await deps.sendViaMentionChannel!("sparkle:concierge", "sparkle-1", "x");
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ target: "sparkle" });
  });

  it("refuses to send for an id that has no channel handle", async () => {
    const deps = createRouterDeps("proj-a", "/repo/a");
    await expect(
      deps.sendViaMentionChannel!("agent-ordinary", "sparkle-1", "x"),
    ).rejects.toThrow(/no mention-channel handle/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reads mention_status with the argument names Rust expects", async () => {
    invokeMock.mockResolvedValue({ awaitingAckRound: 4, acked: true, overdue: false });
    const deps = createRouterDeps("proj-a", "/repo/a");

    const st = await deps.readMentionStatus!("sparkle-1");

    expect(invokeMock).toHaveBeenCalledWith("mention_status", {
      projectPath: "/repo/a",
      threadRef: "sparkle-1",
    });
    expect(st).toEqual({ awaitingAckRound: 4, acked: true, overdue: false });
  });

  it("REFUSES an unrecognized delivery state rather than admitting it as a success", async () => {
    // Fails closed on the seam most likely to drift: `DeliveryState` is a serde-renamed Rust enum,
    // so a new or renamed variant produces NO TypeScript error. The router treats anything that is
    // not pending/missing as terminal success, so admitting an unknown string would silently retire
    // every outstanding doorbell unreported.
    invokeMock.mockResolvedValue([
      { agentId: "a-1", entries: [{ id: "m1", state: "expired" }] },
    ]);
    const deps = createRouterDeps("proj-a", "/repo/a");
    await expect(deps.readDoorbellStates("a-1")).rejects.toThrow(/unrecognized delivery state/);
  });

});
