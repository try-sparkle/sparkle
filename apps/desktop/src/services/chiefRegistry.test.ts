// Deliberately NOT `@vitest-environment jsdom` — this file needs no DOM. See the persistence case
// at the bottom of the TTL describe for why the one storage assertion here does not need one either.
import { describe, it, expect, vi } from "vitest";
import { createChiefRegistry, chiefCallerFor, isChiefBound, CHIEF_CATALOG_TTL_MS } from "./chiefRegistry";
import { resolveChiefProject, type ChiefClient, type ChiefProject } from "./chiefScope";

const CATALOG: ChiefProject[] = [
  { project_id: "project_p1", name: "Founder Festival" },
  { project_id: "project_p2", name: "Scoring Rubric" },
];

/** A client double that counts calls — the TTL assertions are about whether the CLIENT was hit, not
 *  about what came back, so "same rows" would pass against a cache that never caches. */
function fakeClient(rows: ChiefProject[] = CATALOG) {
  const listProjects = vi.fn(async () => rows);
  const callTool = vi.fn(async () => ({ text: "" }));
  return { listProjects, callTool } as unknown as ChiefClient & {
    listProjects: ReturnType<typeof vi.fn>;
  };
}

/** A fetch whose settling THIS TEST decides. The overwrite bugs below are all about the ORDER two
 *  in-flight fetches resolve in, which a plain `async` double cannot express. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("catalog TTL cache", () => {
  it("serves the second call from cache — the client is hit ONCE", async () => {
    const client = fakeClient();
    let t = 1_000;
    const reg = createChiefRegistry(client, { now: () => t });

    expect(await reg.listProjects()).toEqual(CATALOG);
    t += CHIEF_CATALOG_TTL_MS - 1;
    expect(await reg.listProjects()).toEqual(CATALOG);

    expect(client.listProjects).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has elapsed", async () => {
    const client = fakeClient();
    let t = 0;
    const reg = createChiefRegistry(client, { now: () => t });

    await reg.listProjects();
    t += CHIEF_CATALOG_TTL_MS + 1;
    await reg.listProjects();

    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  it("`force` bypasses a still-fresh cache", async () => {
    const client = fakeClient();
    const reg = createChiefRegistry(client, { now: () => 0 });

    await reg.listProjects();
    await reg.listProjects(); // cached
    expect(client.listProjects).toHaveBeenCalledTimes(1);

    await reg.listProjects(true);
    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  it("`invalidate()` drops the cache", async () => {
    const client = fakeClient();
    const reg = createChiefRegistry(client, { now: () => 0 });
    await reg.listProjects();
    reg.invalidate();
    await reg.listProjects();
    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  it("de-dupes concurrent cold-cache callers into ONE fetch", async () => {
    const client = fakeClient();
    const reg = createChiefRegistry(client, { now: () => 0 });
    await Promise.all([reg.listProjects(), reg.listProjects(), reg.listProjects()]);
    expect(client.listProjects).toHaveBeenCalledTimes(1);
  });

  // The three below replace an earlier "a failed refresh does not poison the cache" test that could
  // not fail: it advanced the clock past the TTL before the follow-up call, so that call refetched
  // and returned the catalog whether or not the cache had been poisoned with `[]`. Advancing the
  // clock was the flaw — NOT, as an intervening commit claimed, that the retained rows are
  // unobservable. They are observable, through the `force` path, and the third test pins them.

  it("a failed refresh REACHES the caller — it is never masked as an empty catalog", async () => {
    const client = fakeClient();
    let t = 0;
    const reg = createChiefRegistry(client, { now: () => t });
    await reg.listProjects();

    client.listProjects.mockRejectedValueOnce(new Error("offline"));
    t += CHIEF_CATALOG_TTL_MS + 1;

    // Settle either way and assert on the OUTCOME, so a resolution can be distinguished from a
    // rejection. Resolving with `[]` is the poisoning this guards against: an empty catalog turns
    // every scope decision into "unknown_project", which reads to the user as "your projects are
    // gone" — a swallowed error would pass a bare `.rejects` test's absence, never this one.
    const outcome = await reg.listProjects().then(
      (rows) => ({ resolvedWith: rows }),
      (e: Error) => ({ rejectedWith: e.message }),
    );
    expect(outcome).toEqual({ rejectedWith: "offline" });
  });

  it("a failure does not WEDGE the registry — the next call retries the client and succeeds", async () => {
    const client = fakeClient();
    // The clock is FROZEN, so an elapsed TTL cannot be what explains the second fetch. That was the
    // flaw in the test this replaces.
    const reg = createChiefRegistry(client, { now: () => 0 });

    client.listProjects.mockRejectedValueOnce(new Error("offline"));
    await expect(reg.listProjects()).rejects.toThrow("offline");

    // Leaking the rejected promise in `inflight` would replay that rejection forever — every later
    // caller would inherit a failure from a fetch that finished long ago.
    expect(await reg.listProjects()).toEqual(CATALOG);
    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  it("a failed FORCED refresh leaves the cache intact — the retained rows are still SERVED", async () => {
    const client = fakeClient();
    // FROZEN. The retained cache is the only thing that can satisfy the last assertion: with the
    // clock never advancing, a refetch would show up as a third call, and a poisoned `cached` would
    // show up as `[]`. That is what the deleted test got wrong by advancing the clock.
    const reg = createChiefRegistry(client, { now: () => 0 });
    expect(await reg.listProjects()).toEqual(CATALOG);

    client.listProjects.mockRejectedValueOnce(new Error("offline"));
    await expect(reg.listProjects(true)).rejects.toThrow("offline");

    // `catch { cached = []; throw }` would make this `[]` — in production, "your 348 projects are
    // gone" on every scope decision for the rest of the TTL.
    expect(await reg.listProjects()).toEqual(CATALOG);
    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  it("a slower in-flight fetch cannot overwrite the rows a NEWER forced one cached", async () => {
    const NEWER: ChiefProject[] = [...CATALOG, { project_id: "project_p3", name: "Just Created" }];
    const client = fakeClient();
    const a = deferred<ChiefProject[]>();
    const b = deferred<ChiefProject[]>();
    client.listProjects.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const reg = createChiefRegistry(client, { now: () => 0 });

    const pa = reg.listProjects(); // an ordinary call, already in flight…
    const pb = reg.listProjects(true); // …when the user creates a project and the UI forces a refresh

    b.resolve(NEWER);
    expect(await pb).toEqual(NEWER);
    a.resolve(CATALOG); // A finally answers, with the PRE-CREATION rows
    await pa;

    // Unguarded, A's `cached = rows` reverts the catalog and the new project disappears again.
    expect(await reg.listProjects()).toEqual(NEWER);
    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  it("…nor stamp the catalog fresh with its own, later timestamp", async () => {
    const client = fakeClient();
    const a = deferred<ChiefProject[]>();
    const b = deferred<ChiefProject[]>();
    client.listProjects.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    let t = 0;
    const reg = createChiefRegistry(client, { now: () => t });

    const pa = reg.listProjects();
    const pb = reg.listProjects(true);
    b.resolve(CATALOG);
    await pb; // the live catalog is stamped at t=0

    t = CHIEF_CATALOG_TTL_MS - 1;
    a.resolve(CATALOG);
    await pa; // an unguarded `fetchedAt = now()` here extends the TTL by nearly a full window

    t = CHIEF_CATALOG_TTL_MS + 1; // past the stamp the LIVE fetch took
    await reg.listProjects();
    expect(client.listProjects).toHaveBeenCalledTimes(3); // …so it must have refetched
  });

  it("`invalidate()` is not undone by a fetch that was already in flight", async () => {
    const client = fakeClient();
    const a = deferred<ChiefProject[]>();
    client.listProjects.mockReturnValueOnce(a.promise);
    const reg = createChiefRegistry(client, { now: () => 0 });

    const pa = reg.listProjects();
    reg.invalidate(); // e.g. the user just deleted a Chief project
    a.resolve(CATALOG);
    await pa;

    // The rows A carries pre-date the invalidation, so they must not become the cache.
    await reg.listProjects();
    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  it("a caller arriving after `invalidate()` is not handed the pre-invalidation rows", async () => {
    const STALE: ChiefProject[] = [{ project_id: "project_gone", name: "Deleted In Chief" }];
    const client = fakeClient();
    const a = deferred<ChiefProject[]>();
    client.listProjects.mockReturnValueOnce(a.promise).mockResolvedValueOnce(CATALOG);
    const reg = createChiefRegistry(client, { now: () => 0 });

    const pa = reg.listProjects(); // in flight when the user deletes a Chief project…
    reg.invalidate();
    // …and this caller lands in the window before it settles. Bumping the generation stops A from
    // WRITING the cache but not from being HANDED over out of the in-flight slot.
    const pb = reg.listProjects();
    a.resolve(STALE);

    expect(await pb).toEqual(CATALOG);
    expect(await pa).toEqual(STALE); // A's own caller still gets its answer; only the sharing stops
    expect(client.listProjects).toHaveBeenCalledTimes(2);
  });

  it("a settling call does not clear a LATER call's in-flight slot — the de-dupe keeps covering", async () => {
    const client = fakeClient();
    const a = deferred<ChiefProject[]>();
    const b = deferred<ChiefProject[]>();
    client.listProjects.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const reg = createChiefRegistry(client, { now: () => 0 });

    const pa = reg.listProjects();
    const pb = reg.listProjects(true);
    // A settles FIRST, and fails — so it leaves no cache behind and the only thing that can spare a
    // later caller a fetch is B's still-live in-flight slot.
    a.reject(new Error("offline"));
    await expect(pa).rejects.toThrow("offline");

    const pc = reg.listProjects(); // arrives while B is still in flight: it must JOIN B
    b.resolve(CATALOG);
    expect(await pc).toEqual(CATALOG);
    await pb;
    expect(client.listProjects).toHaveBeenCalledTimes(2); // an unconditional `inflight = null` makes this 3
  });

  // COUNTS WRITES THROUGH A SUBSTITUTED GLOBAL, not a spy on `Storage.prototype`. Both of the
  // obvious spellings are environment-dependent, and both fail SILENTLY as a pass — which for a
  // `not.toHaveBeenCalled()` assertion means a test that cannot fail at all:
  //   - `vi.spyOn(Storage.prototype, …)` needs the `Storage` CLASS. This package's default vitest
  //     environment is `node`, where Node only exposes it as a built-in from v24 — so it threw
  //     `ReferenceError: Storage is not defined` on CI's Node 22 while passing on a Node 26 laptop.
  //   - Adding `@vitest-environment jsdom` fixes the ReferenceError and breaks the assertion
  //     instead: under jsdom `Object.getPrototypeOf(localStorage)` is `MemoryStorage`, so
  //     `localStorage.setItem !== Storage.prototype.setItem` and the prototype spy NEVER fires.
  // `projectStore.persist.test.ts` ping-ponged between exactly these two before landing on the mock
  // below, which depends on no jsdom/Node storage internals and works on every Node version.
  it("does not persist anything (348 rows stay in memory; one call refills them)", async () => {
    let setItemCalls = 0;
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        setItemCalls += 1;
        store.set(k, v);
      },
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    });
    try {
      const reg = createChiefRegistry(fakeClient(), { now: () => 0 });
      await reg.listProjects();
      // Twice, so a cache HIT is covered too — persisting on the refill path only would otherwise
      // slip through.
      await reg.listProjects();
      expect(setItemCalls).toBe(0);
      expect(store.size).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("binding → ChiefCaller", () => {
  it("maps chiefProjectIds to `allowed` and chiefPrimaryId to `primary` for an agent", () => {
    const caller = chiefCallerFor(
      "agent",
      { name: "sparkle", chiefProjectIds: ["project_p1", "project_p2"], chiefPrimaryId: "project_p2" },
      "agent-7",
    );
    expect(caller).toEqual({
      kind: "agent",
      agentId: "agent-7",
      allowed: ["project_p1", "project_p2"],
      primary: "project_p2",
      sparkleProjectName: "sparkle",
    });
    // …and the pairing actually resolves through the frozen gate.
    expect(resolveChiefProject(caller, null, CATALOG)).toMatchObject({
      ok: true,
      projectId: "project_p2",
      source: "primary",
    });
  });

  it("an absent binding is UNBOUND — a refusal, never a fallback to some project", () => {
    const caller = chiefCallerFor("agent", { name: "sparkle" }, "agent-7");
    expect(caller.allowed).toEqual([]);
    expect(caller.primary).toBeNull();

    // The side effect that matters: the gate refuses, and refuses BOTH with and without a name.
    expect(resolveChiefProject(caller, null, CATALOG)).toMatchObject({ ok: false, reason: "unbound" });
    expect(resolveChiefProject(caller, "Founder Festival", CATALOG)).toMatchObject({
      ok: false,
      reason: "unbound",
    });
  });

  it("an EMPTY id list is unbound too, and a leftover primary does not resurrect it", () => {
    const caller = chiefCallerFor("agent", { chiefProjectIds: [], chiefPrimaryId: "project_p1" });
    expect(caller.allowed).toEqual([]);
    expect(caller.primary).toBeNull();
    expect(resolveChiefProject(caller, null, CATALOG)).toMatchObject({ ok: false, reason: "unbound" });
  });

  it("drops blank ids rather than binding an agent to an empty-string project", () => {
    expect(chiefCallerFor("agent", { chiefProjectIds: ["  ", "project_p1", ""] }).allowed).toEqual([
      "project_p1",
    ]);
  });

  it("passes an INCONSISTENT primary through so the gate can name the store bug", () => {
    const caller = chiefCallerFor("agent", {
      chiefProjectIds: ["project_p1"],
      chiefPrimaryId: "project_p2",
    });
    expect(caller.primary).toBe("project_p2");
    expect(resolveChiefProject(caller, null, CATALOG)).toMatchObject({
      ok: false,
      reason: "out_of_scope",
    });
  });

  it("the concierge reaches everything but still takes its default from the binding", () => {
    const caller = chiefCallerFor("concierge", {
      name: "sparkle",
      chiefProjectIds: ["project_p1"],
      chiefPrimaryId: "project_p1",
    });
    expect(caller.allowed).toBe("all");
    expect(caller.agentId).toBeUndefined();
    // Reaches a project OUTSIDE the Sparkle binding — that is the concierge's whole privilege.
    expect(resolveChiefProject(caller, "project_p2", CATALOG)).toMatchObject({
      ok: true,
      projectId: "project_p2",
    });
    expect(resolveChiefProject(caller, null, CATALOG)).toMatchObject({ projectId: "project_p1" });
  });

  it("an unbound concierge is asked rather than defaulted", () => {
    const caller = chiefCallerFor("concierge", undefined);
    expect(resolveChiefProject(caller, null, CATALOG)).toMatchObject({ ok: false, reason: "ambiguous" });
  });
});

describe("isChiefBound", () => {
  it("is false for absent, empty, and blank-only bindings and true for a real one", () => {
    expect(isChiefBound(undefined)).toBe(false);
    expect(isChiefBound({})).toBe(false);
    expect(isChiefBound({ chiefProjectIds: [] })).toBe(false);
    expect(isChiefBound({ chiefProjectIds: ["  "] })).toBe(false);
    expect(isChiefBound({ chiefProjectIds: ["project_p1"] })).toBe(true);
  });
});
