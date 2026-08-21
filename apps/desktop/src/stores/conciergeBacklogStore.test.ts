// conciergeBacklogStore — the pager behind the thread scrubber rail (bead sparkle-7m719).
//
// EVERY ASSERTION IS ON WHAT CAME OUT, never on whether the query was called. "loadBack ran" is a
// precondition; the claim this store makes is that the turns the reader asked for are now in
// `backlog`, deduped against what is already on screen, and bounded. See AGENTS.md's "Tests must
// assert the SIDE EFFECT, not the precondition".
import { beforeEach, describe, expect, it } from "vitest";
import {
  CONCIERGE_BACKLOG_MAX,
  CONCIERGE_BACKLOG_MAX_PAGES,
  CONCIERGE_BACKLOG_PAGE,
  dedupeAgainstLive,
  rowToMessage,
  setConciergeBacklogIo,
  useConciergeBacklogStore,
} from "./conciergeBacklogStore";
import { setConciergeChat, useConciergeThreadStore } from "./conciergeThreadStore";
import { resetConciergeIdentityState } from "../services/conciergeIdentityReset";
import type { HistoryRangeRow } from "../services/history";
import type { ConciergeMessage } from "../components/Concierge/types";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

function row(id: string, atMs: number, kind: "prompt" | "response" = "prompt"): HistoryRangeRow {
  return { id, kind, createdAt: atMs, text: `${kind} ${id}` };
}

/** A query over an in-memory table, applying the SAME oldest-end capping the Rust side documents. */
function tableQuery(rows: HistoryRangeRow[]) {
  const calls: Array<{ fromMs: number; toMs: number; limit?: number }> = [];
  const query = async (
    fromMs: number,
    toMs: number,
    _source: string,
    limit?: number,
  ): Promise<HistoryRangeRow[]> => {
    calls.push({ fromMs, toMs, limit });
    const inRange = rows
      .filter((r) => r.createdAt >= fromMs && r.createdAt <= toMs)
      .sort((a, b) => a.createdAt - b.createdAt);
    // "drops from the OLDEST end, never the newest" — services/history.ts.
    return limit !== undefined && inRange.length > limit ? inRange.slice(inRange.length - limit) : inRange;
  };
  return { query, calls };
}

beforeEach(() => {
  useConciergeBacklogStore.getState().clear();
  setConciergeChat([]);
  setConciergeBacklogIo({ now: () => NOW });
});

describe("rowToMessage", () => {
  // THE JUMP MECHANISM. A prefixed or re-minted id is a rail that silently scrolls to nothing —
  // ConciergeThread's `jumpTo` scans for `[data-message-id]` and matches on the exact string.
  it("carries the row id through verbatim, on both kinds", () => {
    expect(rowToMessage(row("you-17", NOW)).id).toBe("you-17");
    expect(rowToMessage(row("brain-4", NOW, "response")).id).toBe("brain-4");
  });

  it("maps prompt→you and response→sparkle", () => {
    expect(rowToMessage(row("a", NOW)).kind).toBe("you");
    expect(rowToMessage(row("b", NOW, "response")).kind).toBe("sparkle");
  });
});

describe("loadBack", () => {
  it("pages the requested window in, oldest-first", async () => {
    const { query } = tableQuery([
      row("old-1", NOW - 30 * MINUTE),
      row("old-2", NOW - 20 * MINUTE, "response"),
      row("old-3", NOW - 10 * MINUTE),
    ]);
    setConciergeBacklogIo({ entriesInRange: query });

    await useConciergeBacklogStore.getState().loadBack(NOW - 60 * MINUTE);

    expect(useConciergeBacklogStore.getState().backlog.map((m) => m.id)).toEqual([
      "old-1",
      "old-2",
      "old-3",
    ]);
  });

  it("resolves without a query when the target is already inside the loaded window", async () => {
    const { query, calls } = tableQuery([row("old-1", NOW - 30 * MINUTE)]);
    setConciergeBacklogIo({ entriesInRange: query });

    await useConciergeBacklogStore.getState().loadBack(NOW - 60 * MINUTE);
    const after = calls.length;
    await useConciergeBacklogStore.getState().loadBack(NOW - 40 * MINUTE);

    // The SIDE EFFECT of idempotence is that nothing more was fetched — asserted on the query log
    // rather than on `loading`, which is false either way.
    expect(calls.length).toBe(after);
  });

  it("extends an existing window backwards without dropping what it already had", async () => {
    const { query } = tableQuery([
      row("older", NOW - 5 * 60 * MINUTE),
      row("old", NOW - 30 * MINUTE),
    ]);
    setConciergeBacklogIo({ entriesInRange: query });

    await useConciergeBacklogStore.getState().loadBack(NOW - 60 * MINUTE);
    expect(useConciergeBacklogStore.getState().backlog.map((m) => m.id)).toEqual(["old"]);

    await useConciergeBacklogStore.getState().loadBack(NOW - 6 * 60 * MINUTE);
    expect(useConciergeBacklogStore.getState().backlog.map((m) => m.id)).toEqual(["older", "old"]);
  });

  // ── THE TRUNCATION WALK ────────────────────────────────────────────────────────────────────────
  // The SQL cap drops from the OLDEST end, so one page over a wide range comes back WITHOUT the row
  // the reader picked. A single-query pager passes every test above and still fails the only thing
  // the bead is about.
  it("walks back page by page until the picked instant is actually inside what it fetched", async () => {
    const rows = Array.from({ length: CONCIERGE_BACKLOG_PAGE + 50 }, (_, i) =>
      row(`r${i}`, NOW - (CONCIERGE_BACKLOG_PAGE + 50 - i) * MINUTE),
    );
    const target = rows[0]!.createdAt;
    const { query } = tableQuery(rows);
    setConciergeBacklogIo({ entriesInRange: query });

    await useConciergeBacklogStore.getState().loadBack(target);

    const ids = useConciergeBacklogStore.getState().backlog.map((m) => m.id);
    expect(ids).toContain("r0");
    expect(useConciergeBacklogStore.getState().loadedFromMs).toBe(target);
  });

  it("stops after CONCIERGE_BACKLOG_MAX_PAGES and does not claim coverage it never reached", async () => {
    const total = CONCIERGE_BACKLOG_PAGE * (CONCIERGE_BACKLOG_MAX_PAGES + 2);
    const rows = Array.from({ length: total }, (_, i) => row(`r${i}`, NOW - (total - i) * MINUTE));
    const { query, calls } = tableQuery(rows);
    setConciergeBacklogIo({ entriesInRange: query });

    await useConciergeBacklogStore.getState().loadBack(rows[0]!.createdAt);

    expect(calls.length).toBe(CONCIERGE_BACKLOG_MAX_PAGES);
    // It did NOT reach the target, so it must not report the target as loaded — otherwise the next
    // pick in that range resolves instantly and scrolls to nothing.
    expect(useConciergeBacklogStore.getState().loadedFromMs).toBeGreaterThan(rows[0]!.createdAt);
  });

  it("keeps the OLD end when it has to trim, because that is the end the reader picked", async () => {
    const total = CONCIERGE_BACKLOG_MAX + 100;
    const rows = Array.from({ length: total }, (_, i) => row(`r${i}`, NOW - (total - i) * MINUTE));
    const { query } = tableQuery(rows);
    setConciergeBacklogIo({ entriesInRange: query });

    await useConciergeBacklogStore.getState().loadBack(rows[0]!.createdAt);

    const ids = useConciergeBacklogStore.getState().backlog.map((m) => m.id);
    expect(ids.length).toBe(CONCIERGE_BACKLOG_MAX);
    expect(ids[0]).toBe("r0");
    expect(ids).not.toContain(`r${total - 1}`);
  });

  // VADE r3827348136. `loadedToMs` was derived from the newest FETCHED row, but the trim can drop
  // rows that were just fetched — so the claimed window reached PAST the newest turn still held. A
  // pick landing in that gap satisfied the idempotence check, returned without querying, and the
  // rail scrolled to a message that is not in the thread. Silently, which is the whole problem.
  //
  // Asserted on the SIDE EFFECT: a second loadBack for an instant in the gap must actually QUERY.
  it("does not claim the window the trim just threw away", async () => {
    const total = CONCIERGE_BACKLOG_MAX + 100;
    const rows = Array.from({ length: total }, (_, i) => row(`r${i}`, NOW - (total - i) * MINUTE));
    const { query } = tableQuery(rows);
    setConciergeBacklogIo({ entriesInRange: query });

    await useConciergeBacklogStore.getState().loadBack(rows[0]!.createdAt);

    const st = useConciergeBacklogStore.getState();
    const keptIds = new Set(st.backlog.map((m) => m.id));
    // The trim dropped the NEW end, so these rows were fetched and are NOT held.
    const dropped = rows.filter((r) => !keptIds.has(r.id));
    expect(dropped.length).toBeGreaterThan(0);

    // The claimed window must stop at the newest turn actually RETAINED, not at the newest fetched.
    const newestDropped = dropped[dropped.length - 1]!;
    expect(st.loadedToMs!).toBeLessThan(newestDropped.createdAt);

    // …and the behaviour that proves it: picking inside the gap issues a real query rather than
    // resolving instantly against a window the store does not hold.
    let queried = false;
    setConciergeBacklogIo({
      entriesInRange: async (from, to, source, limit) => {
        queried = true;
        return query(from, to, source, limit);
      },
    });
    await useConciergeBacklogStore.getState().loadBack(newestDropped.createdAt);
    expect(queried, "a pick inside the trimmed gap must re-query, not resolve silently").toBe(true);

    // THE SIDE EFFECT THAT MATTERS: the turn the reader picked is now actually HELD, so the rail
    // has something to scroll to. "It queried" alone is satisfied by a load that fetches the turn
    // and then trims it straight back off, which is what a blind trim-the-new-end does here
    // (roborev 66541) — the fetched turn IS the newest on this path.
    const after = useConciergeBacklogStore.getState();
    expect(after.backlog.map((m) => m.id)).toContain(newestDropped.id);

    // …and the window must stay a WINDOW. An inverted from > to can never satisfy covered(), so
    // idempotence would be dead for the rest of the session and every drag would re-query.
    expect(after.loadedFromMs!).toBeLessThanOrEqual(after.loadedToMs!);

    // The backlog renders above the live thread, so it has to BE in order, not merely bounded.
    expect(after.backlogTimes).toEqual([...after.backlogTimes].sort((a, b) => a - b));
  });

  // BOTH ROWS BELOW NEED THE WINDOW'S NEW END TO SIT BELOW THE TARGET, which only the TRIM
  // produces. A first load over a small table claims coverage up to `now`, so any later pick is
  // already covered and `loadBack` returns before doing anything — the first drafts of these tests
  // did exactly that and passed against every defect they name. The MAX+100 table is what makes
  // `loadedToMs` fall below the newest turn and puts the second call on the fresh-walk path.
  function trimmedTable() {
    const total = CONCIERGE_BACKLOG_MAX + 100;
    const rows = Array.from({ length: total }, (_, i) => row(`r${i}`, NOW - (total - i) * MINUTE));
    return { rows, ...tableQuery(rows) };
  }

  it("does not stitch two DISJOINT time ranges into one flat block", async () => {
    const { rows, query } = trimmedTable();
    setConciergeBacklogIo({ entriesInRange: query });
    await useConciergeBacklogStore.getState().loadBack(rows[0]!.createdAt);

    // A turn ABOVE the trimmed window: the walk starts fresh at `now`, so what it fetches is
    // disjoint from what is held, with the trimmed turns missing in between.
    const newest = rows[rows.length - 1]!;
    await useConciergeBacklogStore.getState().loadBack(newest.createdAt);
    const st = useConciergeBacklogStore.getState();

    expect(st.backlogTimes).toEqual([...st.backlogTimes].sort((a, b) => a - b));
    expect(st.loadedFromMs!).toBeLessThanOrEqual(st.loadedToMs!);

    // EVERY HELD TURN INSIDE THE CLAIMED WINDOW. `backlog` and `[from, to]` must describe the same
    // set — otherwise the reader is shown turns the store says it does not have, with silent gaps
    // between them, which reads as a plausible but false history.
    for (const t of st.backlogTimes) {
      expect(t).toBeGreaterThanOrEqual(st.loadedFromMs!);
      expect(t).toBeLessThanOrEqual(st.loadedToMs!);
    }
  });

  // THE HIGH FINDING (roborev 66546): when the dedupe drops EVERY row the fetch returned — the
  // ordinary case for a turn already on screen as a re-minted `restored:` bubble — `from` advanced
  // to the target while `to` kept the stale previous value. `covered()` tests `from <= x <= to`, so
  // an inverted window can never be satisfied again: idempotence dead for the session.
  it("never inverts its window, even when the dedupe drops every row the fetch returned", async () => {
    const { rows, query } = trimmedTable();
    setConciergeBacklogIo({ entriesInRange: query });
    await useConciergeBacklogStore.getState().loadBack(rows[0]!.createdAt);
    const held = new Set(useConciergeBacklogStore.getState().backlog.map((m) => m.id));
    const dropped = rows.filter((r) => !held.has(r.id));
    expect(dropped.length).toBeGreaterThan(0);

    // Everything the next walk can fetch is already on screen, so the dedupe eats all of it.
    setConciergeChat(
      rows.map((r) => ({ id: r.id, kind: "you" as const, text: r.text })) as ConciergeMessage[],
    );
    await useConciergeBacklogStore.getState().loadBack(dropped[dropped.length - 1]!.createdAt);

    const st = useConciergeBacklogStore.getState();
    expect(st.loadedFromMs!, "from must never exceed to").toBeLessThanOrEqual(st.loadedToMs!);
  });

  it("keeps an error instead of rejecting, so the rail's click handler survives it", async () => {
    setConciergeBacklogIo({
      entriesInRange: async () => {
        throw new Error("bridge down");
      },
    });

    await expect(useConciergeBacklogStore.getState().loadBack(NOW - MINUTE)).resolves.toBeUndefined();
    expect(useConciergeBacklogStore.getState().error).toBe("bridge down");
    expect(useConciergeBacklogStore.getState().loading).toBe(false);
  });

  it("serialises overlapping loads so one drag cannot render the same rows twice", async () => {
    const { query } = tableQuery([row("old-1", NOW - 30 * MINUTE), row("old-2", NOW - 20 * MINUTE)]);
    setConciergeBacklogIo({ entriesInRange: query });

    await Promise.all([
      useConciergeBacklogStore.getState().loadBack(NOW - 60 * MINUTE),
      useConciergeBacklogStore.getState().loadBack(NOW - 60 * MINUTE),
    ]);

    expect(useConciergeBacklogStore.getState().backlog.map((m) => m.id)).toEqual(["old-1", "old-2"]);
  });
});

describe("dedupe against the live thread", () => {
  it("drops a paged-in turn the live thread already shows under the same id", async () => {
    setConciergeChat([{ id: "you-9", kind: "you", text: "still on screen" }]);
    const { query } = tableQuery([row("you-9", NOW - 10 * MINUTE), row("you-8", NOW - 11 * MINUTE)]);
    setConciergeBacklogIo({ entriesInRange: query });

    await useConciergeBacklogStore.getState().loadBack(NOW - 60 * MINUTE);

    expect(useConciergeBacklogStore.getState().backlog.map((m) => m.id)).toEqual(["you-8"]);
  });

  // ── THE RESTORED TWIN ─────────────────────────────────────────────────────────────────────────
  // `rehydrateThread` re-ids every persisted bubble `restored:<i>`, so the live bubble and its
  // history row share NO id. An id-only dedupe renders the whole restored window twice.
  it("drops a paged-in turn whose live twin was re-ided by rehydrateThread", () => {
    const live: ConciergeMessage[] = [
      { id: "restored:0", kind: "you", text: "what is the state of the fleet" },
    ];
    const paged = [
      rowToMessage(row("you-3", NOW - MINUTE)),
      { id: "you-4", kind: "you", text: "what is the state of the fleet" } as ConciergeMessage,
    ];

    expect(dedupeAgainstLive(paged, live).map((m) => m.id)).toEqual(["you-3"]);
  });

  it("matches a restored twin whose live copy was clipped by the persist cap", () => {
    const whole = `${"x".repeat(5000)} tail`;
    const clipped = `${whole.slice(0, 4000)}… (truncated)`;
    const live: ConciergeMessage[] = [{ id: "restored:2", kind: "you", text: clipped }];
    const paged = [{ id: "you-7", kind: "you", text: whole } as ConciergeMessage];

    expect(dedupeAgainstLive(paged, live)).toEqual([]);
  });

  it("keeps a restored-looking id whose TEXT differs — same shape, different turn", () => {
    const live: ConciergeMessage[] = [{ id: "restored:0", kind: "you", text: "one thing" }];
    const paged = [{ id: "you-1", kind: "you", text: "a different thing" } as ConciergeMessage];

    expect(dedupeAgainstLive(paged, live).map((m) => m.id)).toEqual(["you-1"]);
  });
});

describe("identity reset", () => {
  // The store holds the human's own words. `conciergeIdentityReset`'s header records that four
  // per-human concierge stores shipped with a clear function nothing called; this asserts the
  // PRODUCTION reset empties this one, not that `clear()` works.
  it("empties the backlog when the human signs out", async () => {
    const { query } = tableQuery([row("old-1", NOW - 30 * MINUTE)]);
    setConciergeBacklogIo({ entriesInRange: query });
    await useConciergeBacklogStore.getState().loadBack(NOW - 60 * MINUTE);
    expect(useConciergeBacklogStore.getState().backlog.length).toBe(1);

    resetConciergeIdentityState();

    expect(useConciergeBacklogStore.getState().backlog).toEqual([]);
    expect(useConciergeBacklogStore.getState().loadedFromMs).toBeNull();
    // …and the live thread it mirrors, so this cannot pass by the reset having become a no-op.
    expect(useConciergeThreadStore.getState().chat).toEqual([]);
  });
});
