// apps/desktop/src/services/beads.epicIndex.test.ts
//
// ══ WHY THIS FILE EXISTS SEPARATELY FROM beads.test.ts ════════════════════════════════════════
//
// `beads.test.ts` cross-checks `buildEpicIndex` against `childrenOf` / `isEpic`. That check was
// load-bearing when those two were an independent naive scan — and it is CIRCULAR NOW, because
// `childrenOf` and `isEpic` are themselves read out of the index. Both sides would agree even if
// the index were completely wrong; the assertion is true before and after any change to the shared
// implementation, which is exactly the vacuous shape AGENTS.md warns about.
//
// So the reference implementation lives HERE, pasted verbatim from the pre-index bodies of
// `childrenOf` / `isEpic` / `openChildCount` / `parentEpicOf` (git 4121fc18d,
// services/beads.ts:598/621/667/685). Nothing in this file imports the production membership rule
// to check the production membership rule. If the index changes an answer, these go red.
import { describe, it, expect } from "vitest";

import {
  buildEpicIndex,
  childrenOf,
  childrenOfIndexed,
  isEpic,
  isEpicIndexed,
  openChildCount,
  openChildCountIndexed,
  parentEpicOf,
  parentEpicOfIndexed,
  type Bead,
} from "./beads";

// ── The ORIGINAL naive bodies, verbatim. The reference, not a paraphrase. ─────────────────────

function naiveChildrenOf(beads: readonly Bead[], epicId: string): Bead[] {
  const prefix = `${epicId}.`;
  return beads.filter((b) => b.id !== epicId && (b.parent === epicId || b.id.startsWith(prefix)));
}

function naiveIsEpic(beads: readonly Bead[], bead: Pick<Bead, "id" | "type">): boolean {
  // `isTypedEpic` inlined so this file re-derives NOTHING from the module under test.
  return (bead.type ?? "").toLowerCase() === "epic" || naiveChildrenOf(beads, bead.id).length > 0;
}

function naiveOpenChildCount(beads: readonly Bead[], epicId: string): number {
  return naiveChildrenOf(beads, epicId).filter((b) => b.status !== "closed").length;
}

function naiveParentEpicOf(
  beads: readonly Bead[],
  bead: Pick<Bead, "id" | "parent">,
): Bead | null {
  const candidates: string[] = [];
  if (bead.parent) candidates.push(bead.parent);
  const parts = bead.id.split(".");
  for (let i = parts.length - 1; i > 0; i--) candidates.push(parts.slice(0, i).join("."));
  for (const id of candidates) {
    if (id === bead.id) continue;
    const found = beads.find((b) => b.id === id);
    if (found && naiveIsEpic(beads, found)) return found;
  }
  return null;
}

// ── Fixture ──────────────────────────────────────────────────────────────────────────────────

const mk = (id: string, extra: Partial<Bead> = {}): Bead => ({
  id,
  title: id,
  description: "",
  status: "open",
  labels: [],
  parent: null,
  ...extra,
});

/** Deterministic LCG — a fixture that reshuffles per run cannot be debugged when it goes red. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const STATUSES: Bead["status"][] = ["open", "in_progress", "closed"];

/**
 * A synthetic store hitting every branch of the two-clause membership match AT ONCE — that is the
 * point, since each shape below broke a different plausible index implementation:
 *
 *   flat parent edge          a child whose id shares no prefix with its parent
 *   dotted id, no parent      bd's display form of the same edge
 *   nested dotted (a.b.c)     a child of BOTH prefixes — the case "index b.parent" gets wrong
 *   REPARENTED                a dotted id under one epic plus an explicit `parent` naming another;
 *                             the bead is a child of BOTH, counted once for each
 *   parent === dotted prefix  the double-count case a naive `filter` counts once
 *   self-referential          `b.parent === b.id`, which must make it nobody's child
 *   dotted, prefix not a bead the existence-filter divergence (C) — `orphan.7` with no `orphan`
 *   duplicate id             two rows with one id, so `byId`'s first-wins matches `Array.find`
 *   typed epic, childless     the union half of `isEpic`
 *   empty-string parent       `childrenOf(beads, "")` matches it; a truthiness test would not
 */
function syntheticStore(count: number): Bead[] {
  const rnd = lcg(0xbeadf00d);
  const out: Bead[] = [];
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length]!;

  const epicIds: string[] = [];
  for (let e = 0; e < Math.max(4, Math.floor(count / 40)); e++) {
    const id = `ep-${e}`;
    epicIds.push(id);
    out.push(mk(id, { type: e % 5 === 0 ? "epic" : "feature", status: pick(STATUSES) }));
  }

  let n = 0;
  while (out.length < count) {
    const epic = epicIds[n % epicIds.length];
    const status = pick(STATUSES);
    switch (n % 11) {
      case 0: // flat child, parent edge only
        out.push(mk(`flat-${n}`, { parent: epic, status }));
        break;
      case 1: // dotted id, no parent field
        out.push(mk(`${epic}.${n}`, { status }));
        break;
      case 2: // dotted id AND the same parent — the double-count case
        out.push(mk(`${epic}.${n}`, { parent: epic, status }));
        break;
      case 3: // GRANDCHILD — child of `ep-x` and of `ep-x.<n-2>` alike
        out.push(mk(`${epic}.${n - 2}.${n}`, { status }));
        break;
      case 4: // REPARENTED — dotted under `epic`, explicit parent elsewhere
        out.push(mk(`${epic}.${n}`, { parent: epicIds[(n + 1) % epicIds.length], status }));
        break;
      case 5: // self-referential
        out.push(mk(`self-${n}`, { parent: `self-${n}`, status }));
        break;
      case 6: // dotted, but `orphan-<n>` is not a bead — the existence-filter case
        out.push(mk(`orphan-${n}.7`, { status }));
        break;
      case 7: // parent naming a bead that does not exist
        out.push(mk(`ghosted-${n}`, { parent: `nowhere-${n}`, status }));
        break;
      case 8: // typed epic with nothing under it
        out.push(mk(`typed-${n}`, { type: n % 2 === 0 ? "Epic" : "epic", status }));
        break;
      case 9: // plain loose task
        out.push(mk(`loose-${n}`, { status }));
        break;
      default: // empty-string parent (bd can emit one; `normalizeBead` keeps it)
        out.push(mk(`blankparent-${n}`, { parent: "", status }));
        break;
    }
    n++;
  }
  // Duplicate id, appended LAST so first-wins is observable: `byId` must resolve to the earlier row.
  out.push(mk("ep-0", { title: "DUPLICATE — must never win", type: "task", status: "closed" }));
  // ── THE EMPTY-ID BEAD, and why it is not a curiosity (roborev 65596) ────────────────────────
  // `normalizeBead` yields `id: ""` for a bd row whose id key is missing or empty, and it PRESERVES
  // `parent: ""` (`asString` returns `""`, not undefined). The fixture already emits
  // `blankparent-<n>` beads, but with no bead whose id is `""` there was nothing for them to be
  // children OF — so the two halves of the index could disagree on `""` and every differential
  // below still passed. That is exactly the "fixture lost a shape" vacuity the integrity test
  // above exists to prevent, so the shape is added here and asserted there.
  //
  // It also gives `parentEpicOf` a bead whose candidate prefix is `""` to resolve: an id beginning
  // with a dot splits to `["", "rest"]`.
  //
  // ⚠ THIS SHARED FIXTURE CANNOT PROVE THE `""` EQUIVALENCE, and the reason is worth stating so
  // nobody deletes the focused test below believing this covers it. `.dotted-under-blank` supplies
  // `""` to the FILTERED half through the dotted-prefix loop, which never had the truthiness bug —
  // so it MASKS the parent-edge divergence it looks like it should expose. Measured: with the two
  // halves' conditions deliberately un-unified, this whole file still passes 20/20. The isolating
  // case is `the empty-string id` describe block, whose store has no dotted bead at all.
  out.push(mk("", { parent: null, status: "open" }));
  out.push(mk(".dotted-under-blank", { status: "open" }));
  // A deep chain, so `parentEpicOf`'s nearest-first ordering has more than one candidate to sort.
  out.push(mk("ep-1.deep", { status: "open" }));
  out.push(mk("ep-1.deep.er", { status: "in_progress" }));
  out.push(mk("ep-1.deep.er.est", { status: "closed", parent: "ep-2" }));
  return out;
}

// ══ (1) DIFFERENTIAL — the test with real power ═══════════════════════════════════════════════

describe("epic index — agrees BEAD-BY-BEAD with the original naive scan", () => {
  const store = syntheticStore(2400);

  it("the fixture actually contains every shape it claims to", () => {
    // A differential test over a fixture that lost a shape passes vacuously, so the shapes are
    // asserted rather than assumed.
    const ids = store.map((b) => b.id);
    expect(store.length).toBeGreaterThan(2400);
    expect(ids.filter((i) => i.startsWith("flat-")).length).toBeGreaterThan(0);
    expect(ids.filter((i) => /^ep-\d+\.\d+\.\d+$/.test(i)).length).toBeGreaterThan(0); // grandchild
    expect(store.filter((b) => b.parent === b.id).length).toBeGreaterThan(0); // self-referential
    expect(ids.filter((i) => i.startsWith("orphan-")).length).toBeGreaterThan(0);
    expect(store.filter((b) => b.parent === "").length).toBeGreaterThan(0);
    // The empty-id bead, plus something dotted under it. Without BOTH, the `""` divergence between
    // the filtered and unfiltered halves is unobservable and every differential passes vacuously.
    expect(ids.filter((i) => i === "").length).toBe(1);
    expect(ids.filter((i) => i.startsWith(".")).length).toBeGreaterThan(0);
    expect(store.filter((b) => (b.type ?? "").toLowerCase() === "epic").length).toBeGreaterThan(0);
    expect(ids.filter((i) => i === "ep-0").length).toBe(2); // duplicate id
    // Reparented: a dotted id whose explicit parent is a DIFFERENT epic.
    expect(
      store.filter((b) => b.parent && b.id.includes(".") && !b.id.startsWith(`${b.parent}.`)).length,
    ).toBeGreaterThan(0);
  });

  it("childrenOfIndexed returns the same beads in the same order as the naive childrenOf", () => {
    const index = buildEpicIndex(store);
    const mismatches: string[] = [];
    for (const b of store) {
      const want = naiveChildrenOf(store, b.id).map((c) => c.id);
      const got = childrenOfIndexed(index, b.id).map((c) => c.id);
      if (JSON.stringify(want) !== JSON.stringify(got)) mismatches.push(b.id);
    }
    expect(mismatches).toEqual([]);
  });

  it("isEpicIndexed matches the naive isEpic for every bead", () => {
    const index = buildEpicIndex(store);
    const mismatches = store
      .filter((b) => isEpicIndexed(index, b) !== naiveIsEpic(store, b))
      .map((b) => b.id);
    expect(mismatches).toEqual([]);
  });

  it("openChildCountIndexed matches the naive openChildCount for every bead", () => {
    const index = buildEpicIndex(store);
    const mismatches = store
      .filter((b) => openChildCountIndexed(index, b.id) !== naiveOpenChildCount(store, b.id))
      .map((b) => b.id);
    expect(mismatches).toEqual([]);
  });

  it("parentEpicOfIndexed resolves the same epic (by identity) as the naive parentEpicOf", () => {
    const index = buildEpicIndex(store);
    const mismatches: string[] = [];
    for (const b of store) {
      // Object identity, not id: `byId` must return the SAME row `Array.find` would, which is what
      // makes the duplicate-id case observable at all.
      if (parentEpicOfIndexed(index, b) !== naiveParentEpicOf(store, b)) mismatches.push(b.id);
    }
    expect(mismatches).toEqual([]);
  });

  // The four EXPORTED legacy signatures are what ~10 untouched call sites actually invoke, so they
  // are checked against the naive reference too, not just the `*Indexed` pair.
  it("the legacy childrenOf/isEpic/openChildCount/parentEpicOf are unchanged observably", () => {
    const mismatches: string[] = [];
    for (const b of store) {
      if (childrenOf(store, b.id).map((c) => c.id).join() !== naiveChildrenOf(store, b.id).map((c) => c.id).join())
        mismatches.push(`childrenOf:${b.id}`);
      if (isEpic(store, b) !== naiveIsEpic(store, b)) mismatches.push(`isEpic:${b.id}`);
      if (openChildCount(store, b.id) !== naiveOpenChildCount(store, b.id))
        mismatches.push(`openChildCount:${b.id}`);
      if (parentEpicOf(store, b) !== naiveParentEpicOf(store, b))
        mismatches.push(`parentEpicOf:${b.id}`);
    }
    expect(mismatches).toEqual([]);
  });

  // ── (C) THE EXISTENCE-FILTER DIVERGENCE, PINNED ────────────────────────────────────────────
  //
  // `buildEpicIndex` links a parent only when it EXISTS as a bead; `childrenOf` never had that
  // requirement. The resolution is that `childrenByParent` is UNFILTERED so `childrenOfIndexed`
  // answers for a non-existent id exactly as `childrenOf` did, while `hasChildren` /
  // `statusesByParent` keep the filter `epicBoard.ts` shipped with. Both halves are pinned, and the
  // assertion is on the answer, not on which map happens to hold it.
  it("childrenOfIndexed ANSWERS for an id that is not a bead, exactly like childrenOf", () => {
    const orphaned = store.find((b) => b.id.startsWith("orphan-"));
    expect(orphaned).toBeDefined();
    const missingId = orphaned!.id.slice(0, orphaned!.id.lastIndexOf("."));
    expect(store.some((b) => b.id === missingId)).toBe(false); // it really is not a bead

    const index = buildEpicIndex(store);
    expect(childrenOfIndexed(index, missingId).map((b) => b.id)).toEqual(
      naiveChildrenOf(store, missingId).map((b) => b.id),
    );
    expect(childrenOfIndexed(index, missingId).length).toBeGreaterThan(0);
    expect(childrenOf(store, missingId).map((b) => b.id)).toEqual([orphaned!.id]);

    // …and the existence-filtered half deliberately does NOT, which is why the two are separate
    // fields rather than one. Nothing asks `hasChildren` about a non-bead — it is only ever
    // consulted with a bead's own id — so the divergence is unreachable in production.
    expect(index.hasChildren.has(missingId)).toBe(false);
    expect(index.statusesByParent.has(missingId)).toBe(false);
  });

  it("hasChildren and childrenByParent agree on every id that IS a bead", () => {
    const index = buildEpicIndex(store);
    const mismatches = store
      .filter((b) => index.hasChildren.has(b.id) !== index.childrenByParent.has(b.id))
      .map((b) => b.id);
    expect(mismatches).toEqual([]);
  });

  it("byId resolves the FIRST row for a duplicated id, matching Array.prototype.find", () => {
    const index = buildEpicIndex(store);
    expect(index.byId.get("ep-0")).toBe(store.find((b) => b.id === "ep-0"));
    expect(index.byId.get("ep-0")?.title).not.toBe("DUPLICATE — must never win");
  });

  it("childrenOfIndexed returns ONE shared frozen empty array for a childless id", () => {
    const index = buildEpicIndex(store);
    const a = childrenOfIndexed(index, "no-such-bead-at-all");
    const b = childrenOfIndexed(index, "another-nonexistent-id");
    expect(a).toEqual([]);
    expect(a).toBe(b); // shared, not allocated per call
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("childrenOf hands back a COPY the caller may mutate without corrupting the index", () => {
    const kids = childrenOf(store, "ep-1");
    expect(kids.length).toBeGreaterThan(1);
    const before = kids.map((b) => b.id);
    kids.sort((x, y) => x.id.localeCompare(y.id));
    kids.push(mk("injected"));
    // The next reader of the same snapshot must be unaffected — this is the assertion that would
    // go red if `childrenOf` handed out `childrenByParent`'s own bucket.
    expect(childrenOf(store, "ep-1").map((b) => b.id)).toEqual(before);
  });
});

// ══ (2) CACHE CORRECTNESS ═════════════════════════════════════════════════════════════════════

describe("the WeakMap index cache", () => {
  const epic = mk("cache-ep", { type: "feature" });
  const kid = mk("cache-ep.1", { status: "open" });

  it("gives the same answers on a second call with the same array", () => {
    const beads = [epic, kid];
    expect(isEpic(beads, epic)).toBe(true);
    expect(childrenOf(beads, "cache-ep").map((b) => b.id)).toEqual(["cache-ep.1"]);
    expect(isEpic(beads, epic)).toBe(true);
    expect(childrenOf(beads, "cache-ep").map((b) => b.id)).toEqual(["cache-ep.1"]);
    expect(openChildCount(beads, "cache-ep")).toBe(1);
  });

  // THE KEY-CORRECTNESS ASSERTION. If the cache were keyed on anything other than the array's own
  // identity — a length, a first id, a module-level singleton — the second array's answers would
  // come back as the first array's. Two arrays, same ids, DIFFERENT content.
  it("does not leak one array's answers to a different array", () => {
    const withKid = [epic, kid];
    const withoutKid = [mk("cache-ep", { type: "feature" })];
    expect(isEpic(withKid, epic)).toBe(true);
    expect(isEpic(withoutKid, epic)).toBe(false);
    expect(isEpic(withKid, epic)).toBe(true); // and back again — neither poisons the other
    expect(childrenOf(withoutKid, "cache-ep")).toEqual([]);
    expect(childrenOf(withKid, "cache-ep").map((b) => b.id)).toEqual(["cache-ep.1"]);
  });

  it("also distinguishes two arrays whose contents differ only in a child's status", () => {
    const openKid = [epic, mk("cache-ep.1", { status: "open" })];
    const closedKid = [epic, mk("cache-ep.1", { status: "closed" })];
    expect(openChildCount(openKid, "cache-ep")).toBe(1);
    expect(openChildCount(closedKid, "cache-ep")).toBe(0);
    expect(openChildCount(openKid, "cache-ep")).toBe(1);
  });

  // THE LENGTH GUARD. A `push` keeps the array's identity, so a cache that trusted identity alone
  // would keep answering from the pre-push index forever.
  it("picks up an in-place push that changes the array's length", () => {
    const growEp = mk("grow-ep", { type: "feature" });
    const growKid = mk("grow-ep.1");
    const beads: Bead[] = [growEp];
    expect(isEpic(beads, growEp)).toBe(false); // index built here, with no children
    expect(childrenOf(beads, "grow-ep")).toEqual([]);

    beads.push(growKid); // same array object, new length

    expect(isEpic(beads, growEp)).toBe(true);
    expect(childrenOf(beads, "grow-ep").map((b) => b.id)).toEqual(["grow-ep.1"]);
    expect(openChildCount(beads, "grow-ep")).toBe(1);
    expect(parentEpicOf(beads, growKid)).toBe(growEp);
  });

  it("picks up an in-place pop as well", () => {
    // Typed `epic` deliberately: after the pop the structural half is gone, so the last assertion
    // is checking that the UNION half still answers rather than that the pop was ignored.
    const shrinkEp = mk("shrink-ep", { type: "epic" });
    const beads: Bead[] = [shrinkEp, mk("shrink-ep.1")];
    expect(childrenOf(beads, "shrink-ep").map((b) => b.id)).toEqual(["shrink-ep.1"]);
    beads.pop();
    expect(childrenOf(beads, "shrink-ep")).toEqual([]);
    expect(isEpic(beads, shrinkEp)).toBe(true); // still a TYPED epic — the union half survives
  });

  // ── THE DOCUMENTED BLIND SPOT, STATED RATHER THAN DISCOVERED ────────────────────────────────
  // A field edit at CONSTANT LENGTH is not detected, and cannot be cheaply: noticing it needs the
  // per-element scan this cache exists to remove. The contract is that callers pass a fresh array
  // per snapshot (`beadsStore` maps a new array each poll).
  //
  // This pins the trade-off honestly AND asserts the capability that protects it — a fresh array
  // with the same edit gives the right answer. If someone later makes the index detect field edits,
  // the first expectation here should be UPDATED, not deleted: it is a statement of scope, not a
  // defect anyone wants to keep.
  it("does NOT see an in-place field edit at constant length — but a fresh array does", () => {
    const mutEp = mk("mut-ep", { type: "feature" });
    const mutRow = mk("orphan-row");
    const beads: Bead[] = [mutEp, mutRow];
    expect(isEpic(beads, mutEp)).toBe(false);

    mutRow.parent = "mut-ep"; // same array identity, same length

    expect(isEpic(beads, mutEp)).toBe(false); // stale, by documented design
    expect(isEpic([...beads], mutEp)).toBe(true); // the contract: one fresh array per snapshot
  });
});

// ══ (2b) THE SHARED INDEX IS NOT MUTABLE THROUGH A READ ═══════════════════════════════════════
//
// `childrenOfIndexed` returns the index's own bucket BY REFERENCE — that zero-copy read is what
// makes it O(1), and it is also what makes a mutating caller dangerous in a way the old
// `childrenOf` was not: that one handed back a defensive `.slice()`, so a `sort()` hurt one caller.
// The index lives in a module-level WeakMap shared by every reader of the snapshot, so the same
// `sort()` would corrupt child order and counts for the WHOLE render tree until the array identity
// changed (roborev 65662).
//
// The guarantee is in the TYPE, so this is a COMPILE-TIME test: `@ts-expect-error` fails the build
// if the mutation ever starts compiling again. A runtime assertion cannot express this — nothing
// throws, the corruption is silent, and by the time it is observable the cause is far away.
describe("epic index — read-only by construction", () => {
  it("refuses mutation through the public surface, and still reads zero-copy", () => {
    const index = buildEpicIndex(syntheticStore(200));

    // ── EVERY POSITIVE ASSERTION RUNS FIRST, AND THE ORDER IS THE POINT ──────────────────────
    // `@ts-expect-error` suppresses the TYPE error only; vitest strips types, so the mutation
    // lines below genuinely EXECUTE. An earlier version of this block asserted
    // `index.byId.size > 0` AFTER them, which the injected `"nope"` entry satisfied on its own --
    // it would have passed against a `buildEpicIndex` that returned entirely empty maps. It also
    // probed `childrenOfIndexed(index, "no-such-id")`, which returns the module-level frozen
    // `NO_CHILDREN` regardless of what the index holds, so it could not fail either
    // (roborev 65714). Both are now real reads against an id the fixture actually contains.
    const kids = childrenOfIndexed(index, "ep-0");
    expect(kids.length).toBeGreaterThan(0);
    // THE ZERO-COPY CLAIM ITSELF: the read hands back the index's own bucket, not a copy. This is
    // what makes it O(1), and it is exactly why the type has to forbid mutation.
    expect(kids).toBe(index.childrenByParent.get("ep-0"));
    const sizeBefore = index.byId.size;
    expect(sizeBefore).toBeGreaterThan(0);

    // ── AND THE COMPILE-TIME HALF ────────────────────────────────────────────────────────────
    // These are pinned by `tsc`, not by this run: if any of them starts compiling again, the build
    // fails with TS2578 "Unused '@ts-expect-error' directive". They target `ep-0` -- a bucket that
    // really exists -- so each directive sits on a line describing a real mutation rather than a
    // no-op on `undefined`.
    // @ts-expect-error childrenByParent is a ReadonlyMap of readonly arrays — no push.
    index.childrenByParent.get("ep-0")?.push({} as Bead);
    // @ts-expect-error ...and no set on the map itself.
    index.childrenByParent.set("ep-0", []);
    // @ts-expect-error statusesByParent is readonly too.
    index.statusesByParent.get("ep-0")?.push("open");
    // @ts-expect-error byId is a ReadonlyMap.
    index.byId.set("nope", {} as Bead);
    // @ts-expect-error hasChildren is a ReadonlySet.
    index.hasChildren.add("nope");
  });
});

// ══ (3) COMPLEXITY — COUNTED, not timed. This block FAILS before the change ═══════════════════
//
// ── WHY NOT A STOPWATCH AT ALL (roborev 65596, then measured again) ──────────────────────────
// This started as an absolute millisecond ceiling, which was correctly rejected: this file is in
// the REQUIRED desktop correctness gate, and CI runs it instrumented under v8 coverage, sharded,
// on a self-hosted runner that has already OOM-killed shards. A stopwatch there is a timing bound
// wearing a correctness bound's clothes.
//
// It was then a RATIO — time n against 4n and require the ratio to stay near-linear — on the
// reasoning that both halves pay the same machine tax, so load cancels out. That reasoning is
// wrong, and it was measured failing 1 run in 3 on an otherwise-idle machine (tBig 69.9 ms
// against a bar of 18.4 ms, ~30x for 4x the input, on an implementation that is genuinely
// index-backed). Load does NOT cancel: `childrenOf` returns a defensive `.slice()` copy of its
// bucket and the sweep calls it TWICE per bead, so the work is linear in EDGES while the
// allocation churn — and therefore GC — grows faster than the input on the 4n side alone. A
// ratio cannot separate "linear with allocation churn" from "quadratic", so it flakes in the
// direction that reds CI for everyone.
//
// So COUNT the thing the change is actually about instead of timing a proxy for it. The defect
// was that every resolver walked the whole array on EVERY call; the fix is that the array is
// walked once to build a cached index and never again. That is a discrete, machine-independent
// fact, and a Proxy counting numeric index reads on the store array measures it exactly:
//
//   indexed   -> ~one pass to build the index, then O(1) map reads   => O(n) total reads
//   quadratic -> six resolutions x n cards x n elements scanned      => O(n^2) total reads
//
// At n=2000 that is thousands versus tens of millions, so the bar can sit an order of magnitude
// above the honest cost and still fail instantly on any reintroduced scan. Absolute durations
// belong in `scripts/bench/board-perf.mts`, which exists for that and runs against the real store
// — it measured this same sweep at 43,501 ms before and 91.8 ms after on the founder's 7,494-bead
// dump.

describe("whole-store epic resolution is sub-quadratic", () => {
  const N = 2000;

  /**
   * The store array, wrapped so every numeric element read is counted.
   *
   * A whole-store scan (`beads.filter`, `beads.find`, `for (const b of beads)`) reads every index
   * and so costs `n` here; an index lookup reads none. `epicIndexFor` caches on ARRAY IDENTITY, so
   * the proxy is what must be passed to the resolvers — handing them the raw array instead would
   * measure a different cache entry and count nothing.
   */
  const counted = (store: Bead[]) => {
    const stats = { reads: 0 };
    const proxy = new Proxy(store, {
      get(target, prop, recv) {
        if (typeof prop === "string" && prop.length > 0 && /^\d+$/.test(prop)) stats.reads++;
        return Reflect.get(target, prop, recv);
      },
    }) as Bead[];
    return { proxy, stats };
  };

  /**
   * Ten reads per bead. The honest cost is ~1-2 passes (the index build), so this is ~5x headroom
   * for implementation detail — while a single reintroduced whole-store scan inside a per-card
   * resolver costs `n` reads per card and blows through it by three orders of magnitude.
   */
  const MAX_READS_PER_BEAD = 10;

  it("beads.filter((b) => isEpic(beads, b)) does not re-scan the store per bead", () => {
    const { proxy, stats } = counted(syntheticStore(N));
    const epics = proxy.filter((b) => isEpic(proxy, b)).length;
    expect(epics).toBeGreaterThan(0); // it did real work, not an early bail

    // The `filter` itself reads all n, which is the caller's own sweep and not the defect. What
    // must NOT scale with n is what `isEpic` does per call.
    const budget = N * MAX_READS_PER_BEAD;
    expect(stats.reads).toBeLessThan(budget);
    // Before the index this same call took 2,584 ms on the founder's real 7,364-bead store (53.7M
    // string comparisons to find 43 epics) and produced a 4.5 s renderer hang whose heaviest
    // sampled leaves were `JSC::stringProtoFuncStartsWith` and `operationCompareStringEq`. In
    // reads, that shape is n per call x n calls = 4,000,000 here.
    expect(stats.reads).toBeLessThan(N * N);
  });

  it("BoardView's six-scans-per-card sequence does not re-scan the store per card", () => {
    const { proxy, stats } = counted(syntheticStore(N));
    let sink = 0;
    for (const b of proxy) {
      const beadIsEpic = isEpic(proxy, b);
      sink += beadIsEpic ? 1 : 0;
      sink += parentEpicOf(proxy, b) ? 1 : 0;
      sink += openChildCount(proxy, b.id);
      sink += childrenOf(proxy, b.id).length;
      sink += isEpic(proxy, b) ? 1 : 0;
      sink += childrenOf(proxy, b.id).length;
    }
    expect(sink).toBeGreaterThan(0); // the sweep resolved real parent/child edges

    // Six resolutions per card over n cards. Unindexed that is ~6n^2 reads; indexed it is the one
    // build plus the `for...of` walk.
    expect(stats.reads).toBeLessThan(N * MAX_READS_PER_BEAD);
    expect(stats.reads).toBeLessThan(N * N);
  });

  it("buildEpicIndex itself is one linear walk", () => {
    const { proxy, stats } = counted(syntheticStore(N));
    const index = buildEpicIndex(proxy);
    expect(index.byId.size).toBeGreaterThan(0);
    // UNCACHED by contract, so this is the build's own cost and nothing else: a couple of passes,
    // never a pass per bead.
    expect(stats.reads).toBeLessThan(N * MAX_READS_PER_BEAD);
  });
});

// ══ (5) THE EMPTY-STRING ID — an isolated store, because the big fixture masks it ══════════════
//
// roborev 65596 caught a real divergence between the index's two halves: `linkChild` tested
// `parent != null` while `link` tested `b.parent` for TRUTHINESS, so a bead parented to `""` was
// linked into `childrenByParent` but not into `hasChildren`. `normalizeBead` makes both shapes
// reachable from real bd output — it yields `id: ""` for a row with a missing or empty id, and
// `asString` preserves `parent: ""` rather than dropping it to undefined.
//
// THE STORE HERE HAS NO DOTTED BEAD, and that is the entire point. Any id containing a dot feeds
// `""` to the filtered half through the prefix loop, which never had the bug — so a fixture that
// happens to contain one reports this as covered while the parent-edge path stays broken. That is
// what the big `syntheticStore` does, which is why this cannot be folded into it.
describe("epic index — a bead whose id is the empty string", () => {
  // The minimal store that makes the parent edge the ONLY supplier of `""`.
  const store: Bead[] = [mk("", { parent: null }), mk("blank-parented", { parent: "" })];

  it("both halves agree that '' has children — the equivalence parentEpicOfIndexed relies on", () => {
    const index = buildEpicIndex(store);
    expect(index.childrenByParent.has("")).toBe(true);
    // The half that used to disagree. This is the assertion that goes red on the truthiness test.
    expect(index.hasChildren.has("")).toBe(true);
  });

  it("isEpicIndexed matches the naive isEpic for the empty-id bead", () => {
    const index = buildEpicIndex(store);
    const blank = store[0]!;
    // Naive says epic (childrenOf("") matches the parent === "" bead); indexed must say the same.
    expect(naiveIsEpic(store, blank)).toBe(true);
    expect(isEpicIndexed(index, blank)).toBe(true);
  });

  it("childrenOfIndexed still matches the naive scan here", () => {
    const index = buildEpicIndex(store);
    for (const b of store) {
      expect(childrenOfIndexed(index, b.id).map((c) => c.id)).toEqual(
        naiveChildrenOf(store, b.id).map((c) => c.id),
      );
    }
  });

  it("parentEpicOfIndexed resolves a dotted-under-blank id the way the naive one does", () => {
    // A dotted bead is ADDED here deliberately — this case is about resolution, not about the
    // masking described above, and the paired assertion is that both implementations agree.
    const withDotted = [...store, mk(".under-blank")];
    const index = buildEpicIndex(withDotted);
    const dotted = withDotted[2]!;
    expect(parentEpicOfIndexed(index, dotted)?.id).toBe(naiveParentEpicOf(withDotted, dotted)?.id);
  });
});
