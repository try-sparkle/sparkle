// @vitest-environment jsdom
//
// The data layer behind the in-app What's New panel. Everything pinned here is a rule that, when
// broken, produces a panel that looks FINE and says nothing:
//
//   • a lexicographic version compare ("v0.99.0" > "v0.102.0") puts the wrong release on top and
//     makes the auto-open fire on a downgrade;
//   • an all-or-nothing parser that chokes on `"releaseVersion": null` — the value serde actually
//     sends for a Rust `Option::None` — renders an EMPTY list forever with nothing logged;
//   • a fetch failure that doesn't fall back to the cache is an error wall.
//
// Each assertion below is on the OUTPUT (which rows come back, in which order, in which section),
// never on a precondition like "fetch was called".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock("../logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  CHANGELOG_API_URL,
  CHANGELOG_CACHE_KEY,
  autoOpenDecision,
  changelogUrl,
  compareVersions,
  displayVersion,
  isNewerVersion,
  loadChangelog,
  parseChangelogEntry,
  parseChangelogPayload,
  partitionEntries,
  readCachedChangelog,
  writeCachedChangelog,
  type ChangelogEntry,
} from "./changelogService";

/** A full wire-shaped row, per the frozen ChangelogEntryView contract. */
function wireEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "e1",
    slug: "abc1234-a-title",
    shippedAt: "2026-08-12T21:53:18-07:00",
    title: "A title",
    summary: "A summary.",
    bullets: ["one", "two"],
    changeType: "feature",
    categories: ["desktop"],
    links: [],
    surfaces: ["desktop"],
    releaseVersion: "v0.102.0",
    ...over,
  };
}

function entry(over: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    id: "e1",
    slug: "s1",
    shippedAt: "2026-08-12T21:53:18-07:00",
    title: "A title",
    summary: "A summary.",
    bullets: [],
    changeType: "feature",
    categories: [],
    links: [],
    surfaces: [],
    releaseVersion: "v0.102.0",
    ...over,
  };
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("compareVersions — SEMANTIC, which a string sort gets backwards", () => {
  it("orders v0.102.0 AFTER v0.99.0 (the exact compare a lexicographic sort inverts)", () => {
    // "v0.102.0" < "v0.99.0" as strings. If this passes lexicographically the whole panel is wrong.
    expect("v0.102.0" < "v0.99.0").toBe(true); // the trap, stated
    expect(compareVersions("v0.102.0", "v0.99.0")).toBe(1);
    expect(compareVersions("v0.99.0", "v0.102.0")).toBe(-1);
    expect(isNewerVersion("v0.102.0", "v0.99.0")).toBe(true);
  });

  it("tolerates both the v-prefixed and the bare form, in either position", () => {
    expect(compareVersions("0.102.0", "v0.102.0")).toBe(0);
    expect(compareVersions("v0.102.0", "0.101.9")).toBe(1);
    expect(compareVersions("0.100.0", "V0.100.1")).toBe(-1);
  });

  it("treats a missing segment as zero, so 1.2 and 1.2.0 are the same release", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBe(1);
  });

  it("stops at the first non-numeric segment rather than shifting a prerelease into patch", () => {
    // "0.103.0-beta.1" must not read as 0.103.0.beta.1 → its numeric prefix is 0.103.0.
    expect(compareVersions("0.103.0-beta.1", "0.103.0")).toBe(0);
    expect(compareVersions("0.103.0-beta.1", "0.102.0")).toBe(1);
  });

  it("is safe on null / empty / garbage rather than throwing", () => {
    expect(compareVersions(null, "1.0.0")).toBe(-1);
    expect(compareVersions("", "")).toBe(0);
    expect(compareVersions("nonsense", "1.0.0")).toBe(-1);
  });
});

describe("displayVersion", () => {
  it("always v-prefixes, and names an unstamped entry rather than rendering blank", () => {
    expect(displayVersion("0.102.0")).toBe("v0.102.0");
    expect(displayVersion("v0.102.0")).toBe("v0.102.0");
    expect(displayVersion(null)).toBe("Unreleased");
  });
});

describe("parseChangelogEntry — a null releaseVersion is the COMMON case, not an error", () => {
  it("keeps an entry whose releaseVersion is an explicit null", () => {
    const parsed = parseChangelogEntry(wireEntry({ releaseVersion: null }));
    expect(parsed).not.toBeNull();
    expect(parsed?.releaseVersion).toBeNull();
    expect(parsed?.title).toBe("A title");
  });

  it("normalises an ABSENT releaseVersion key to null too", () => {
    const raw = wireEntry();
    delete raw.releaseVersion;
    expect(parseChangelogEntry(raw)?.releaseVersion).toBeNull();
  });

  it("carries the whole row through: bullets, links, categories, change type", () => {
    const parsed = parseChangelogEntry(
      wireEntry({
        bullets: ["a", "b", "c"],
        links: [{ label: "PR", href: "https://example.test/pr" }],
        categories: ["desktop", "performance"],
        changeType: "bug_fix",
      }),
    );
    expect(parsed?.bullets).toEqual(["a", "b", "c"]);
    expect(parsed?.links).toEqual([{ label: "PR", href: "https://example.test/pr" }]);
    expect(parsed?.categories).toEqual(["desktop", "performance"]);
    expect(parsed?.changeType).toBe("bug_fix");
  });

  it("degrades a bad field instead of dropping the row", () => {
    const parsed = parseChangelogEntry(
      wireEntry({ bullets: "not an array", changeType: "wat", links: [{ label: "x" }] }),
    );
    expect(parsed?.bullets).toEqual([]);
    expect(parsed?.changeType).toBe("enhancement");
    expect(parsed?.links).toEqual([]); // a link with no href is unusable, the row is not
  });

  it("drops only a row with no id or no title", () => {
    expect(parseChangelogEntry(wireEntry({ title: "" }))).toBeNull();
    expect(parseChangelogEntry(wireEntry({ id: "", slug: "" }))).toBeNull();
    expect(parseChangelogEntry(null)).toBeNull();
    // ...but an id can be recovered from the slug.
    expect(parseChangelogEntry(wireEntry({ id: "" }))?.id).toBe("abc1234-a-title");
  });
});

describe("parseChangelogPayload — the endpoint's exact wrapper shape is not agreed yet", () => {
  it("accepts a BARE ARRAY of entries", () => {
    const { entries } = parseChangelogPayload([wireEntry({ id: "a" }), wireEntry({ id: "b" })]);
    expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("accepts an OBJECT wrapping them under `entries`", () => {
    const { entries } = parseChangelogPayload({ entries: [wireEntry({ id: "a" })] });
    expect(entries.map((e) => e.id)).toEqual(["a"]);
  });

  it("surfaces a degradation flag the server tacked on, without requiring it", () => {
    expect(parseChangelogPayload({ entries: [wireEntry()], degraded: true }).degraded).toBe(true);
    expect(parseChangelogPayload({ entries: [wireEntry()], databaseUnavailable: true }).degraded).toBe(
      true,
    );
    expect(parseChangelogPayload({ entries: [wireEntry()] }).degraded).toBe(false);
    expect(parseChangelogPayload([wireEntry()]).degraded).toBe(false);
  });

  it("keeps the GOOD rows when one row is malformed — never all-or-nothing", () => {
    const { entries } = parseChangelogPayload({
      entries: [wireEntry({ id: "a" }), { nonsense: true }, wireEntry({ id: "c" })],
    });
    expect(entries.map((e) => e.id)).toEqual(["a", "c"]);
  });

  it("returns an empty list, not a throw, on a shape it cannot read at all", () => {
    expect(parseChangelogPayload("nope").entries).toEqual([]);
    expect(parseChangelogPayload(null).entries).toEqual([]);
  });
});

describe("partitionEntries", () => {
  const v100 = entry({ id: "v100", releaseVersion: "v0.100.0", shippedAt: "2026-08-12T15:13:28-07:00" });
  const v101 = entry({ id: "v101", releaseVersion: "v0.101.0", shippedAt: "2026-08-12T18:42:09-07:00" });
  const v102 = entry({ id: "v102", releaseVersion: "v0.102.0", shippedAt: "2026-08-12T21:53:18-07:00" });
  const v99 = entry({ id: "v99", releaseVersion: "v0.99.0", shippedAt: "2026-08-11T21:08:45-07:00" });

  it("FIRST RUN (lastSeen seeded to current): highlights ONLY the running release", () => {
    const { highlighted, history } = partitionEntries([v99, v100, v101, v102], "0.102.0", "0.102.0");
    expect(highlighted.map((e) => e.id)).toEqual(["v102"]);
    // The rest are still readable — scrollable history, not hidden.
    expect(history.map((e) => e.id)).toEqual(["v101", "v100", "v99"]);
  });

  it("first run with NO stored version behaves the same way", () => {
    const { highlighted } = partitionEntries([v99, v100, v101, v102], "0.102.0", null);
    expect(highlighted.map((e) => e.id)).toEqual(["v102"]);
  });

  it("CATCH-UP: a user who skipped releases gets every one in the gap, not just the newest", () => {
    // Was on v0.99.0, is now on v0.102.0 → three releases are new to them.
    const { highlighted, history } = partitionEntries([v99, v100, v101, v102], "0.102.0", "0.99.0");
    expect(highlighted.map((e) => e.id)).toEqual(["v102", "v101", "v100"]);
    expect(history.map((e) => e.id)).toEqual(["v99"]); // the one they were already on
  });

  it("never highlights a release NEWER than the one running", () => {
    const v103 = entry({ id: "v103", releaseVersion: "v0.103.0", shippedAt: "2026-08-14T00:00:00Z" });
    const { highlighted, history } = partitionEntries([v103, v102, v101], "0.102.0", "0.101.0");
    expect(highlighted.map((e) => e.id)).toEqual(["v102"]);
    expect(history.map((e) => e.id)).toContain("v103");
  });

  it("orders SEMANTICALLY — v0.102.0 above v0.99.0, which a string sort inverts", () => {
    // Fed in the inverted order, with shippedAt deliberately absent so version is the only signal.
    const bare102 = entry({ id: "v102", releaseVersion: "v0.102.0", shippedAt: "" });
    const bare99 = entry({ id: "v99", releaseVersion: "v0.99.0", shippedAt: "" });
    const bare100 = entry({ id: "v100", releaseVersion: "v0.100.0", shippedAt: "" });
    const { history } = partitionEntries([bare99, bare100, bare102], "0.5.0", "0.5.0");
    // Nothing matches the running version, so the newest is pulled up; the rest must still descend.
    expect(history.map((e) => e.id)).toEqual(["v100", "v99"]);
  });

  it("a NULL releaseVersion does not blank the list — the entry renders, at the top of history", () => {
    const unstamped = entry({ id: "next", releaseVersion: null, shippedAt: "2026-08-13T09:00:00Z" });
    const { highlighted, history } = partitionEntries(
      [v100, unstamped, v101, v102],
      "0.102.0",
      "0.102.0",
    );
    expect(highlighted.map((e) => e.id)).toEqual(["v102"]);
    expect(history.map((e) => e.id)).toEqual(["next", "v101", "v100"]);
    // The whole set survived — 4 in, 4 out.
    expect(highlighted.length + history.length).toBe(4);
  });

  it("an ALL-null-version payload still renders every row", () => {
    const a = entry({ id: "a", releaseVersion: null, shippedAt: "2026-08-13T09:00:00Z" });
    const b = entry({ id: "b", releaseVersion: null, shippedAt: "2026-08-12T09:00:00Z" });
    const { highlighted, history } = partitionEntries([b, a], "0.102.0", "0.102.0");
    expect([...highlighted, ...history].map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("leads with SOMETHING when no entry matches the running version", () => {
    const { highlighted } = partitionEntries([v100, v101], "0.102.0", "0.102.0");
    expect(highlighted.map((e) => e.id)).toEqual(["v101"]);
  });

  it("returns two empty sections for an empty payload rather than throwing", () => {
    expect(partitionEntries([], "0.102.0", null)).toEqual({ highlighted: [], history: [] });
  });
});

describe("autoOpenDecision — once per new version, and never a backlog dump", () => {
  it("SEEDS (does not open) when nothing has ever been recorded", () => {
    expect(autoOpenDecision("0.102.0", null)).toBe("seed");
    expect(autoOpenDecision("0.102.0", "")).toBe("seed");
  });

  it("OPENS when the running version is newer than the last one shown", () => {
    expect(autoOpenDecision("0.102.0", "0.99.0")).toBe("open");
    expect(autoOpenDecision("v0.102.0", "0.101.0")).toBe("open");
  });

  it("does NOTHING on the same version — the once-per-version half of the contract", () => {
    expect(autoOpenDecision("0.102.0", "0.102.0")).toBe("none");
    expect(autoOpenDecision("v0.102.0", "0.102.0")).toBe("none");
  });

  it("does NOTHING on a downgrade (a lexicographic compare would open here)", () => {
    expect(autoOpenDecision("0.99.0", "0.102.0")).toBe("none");
  });

  it("does NOTHING before the version has resolved from Rust", () => {
    expect(autoOpenDecision("", "0.99.0")).toBe("none");
    expect(autoOpenDecision(null, null)).toBe("none");
  });
});

describe("changelogUrl", () => {
  it("is the public sparkle.ai endpoint and never GitHub (the repo is private)", () => {
    expect(CHANGELOG_API_URL).toBe("https://sparkle.ai/api/changelog/entries");
    expect(changelogUrl()).toBe(CHANGELOG_API_URL);
    expect(changelogUrl()).not.toContain("github");
  });

  it("appends an encoded ?since when one is given, and omits it when blank", () => {
    expect(changelogUrl("v0.99.0")).toBe(`${CHANGELOG_API_URL}?since=v0.99.0`);
    expect(changelogUrl("")).toBe(CHANGELOG_API_URL);
    expect(changelogUrl(null)).toBe(CHANGELOG_API_URL);
  });
});

describe("the cache", () => {
  it("round-trips entries and refuses a corrupt blob rather than throwing", () => {
    const e = parseChangelogEntry(wireEntry())!;
    writeCachedChangelog([e], 1234);
    expect(readCachedChangelog()?.entries.map((x) => x.id)).toEqual(["e1"]);
    expect(readCachedChangelog()?.fetchedAt).toBe(1234);

    localStorage.setItem(CHANGELOG_CACHE_KEY, "{not json");
    expect(readCachedChangelog()).toBeNull();
  });

  it("never writes an empty list over a good cache", () => {
    const e = parseChangelogEntry(wireEntry())!;
    writeCachedChangelog([e], 1234);
    writeCachedChangelog([], 9999);
    expect(readCachedChangelog()?.entries).toHaveLength(1);
  });
});

describe("loadChangelog — fail OPEN, never an error wall", () => {
  it("returns the fetched rows and caches them", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [wireEntry({ id: "fresh" })] }));
    const snap = await loadChangelog();
    expect(snap.entries.map((e) => e.id)).toEqual(["fresh"]);
    expect(snap.stale).toBe(false);
    expect(readCachedChangelog()?.entries.map((e) => e.id)).toEqual(["fresh"]);
  });

  it("hits the sparkle.ai endpoint, not GitHub", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([wireEntry()]));
    await loadChangelog();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(CHANGELOG_API_URL);
  });

  it("falls back to the CACHE when the network throws, flagged stale", async () => {
    writeCachedChangelog([parseChangelogEntry(wireEntry({ id: "cached" }))!], 4242);
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const snap = await loadChangelog();
    expect(snap.entries.map((e) => e.id)).toEqual(["cached"]);
    expect(snap.stale).toBe(true);
    expect(snap.fetchedAt).toBe(4242);
  });

  it("falls back to the CACHE on a non-ok status too", async () => {
    writeCachedChangelog([parseChangelogEntry(wireEntry({ id: "cached" }))!], 7);
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [] }, false, 500));
    const snap = await loadChangelog();
    expect(snap.entries.map((e) => e.id)).toEqual(["cached"]);
    expect(snap.stale).toBe(true);
  });

  it("does not EVICT a good cache when the server answers with an empty list", async () => {
    writeCachedChangelog([parseChangelogEntry(wireEntry({ id: "cached" }))!], 7);
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [] }));
    const snap = await loadChangelog();
    expect(snap.entries.map((e) => e.id)).toEqual(["cached"]);
    expect(readCachedChangelog()?.entries.map((e) => e.id)).toEqual(["cached"]);
  });

  it("carries the server's degradation flag through to the snapshot", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [wireEntry()], degraded: true }));
    const snap = await loadChangelog();
    expect(snap.degraded).toBe(true);
    expect(snap.entries).toHaveLength(1); // degraded still RENDERS — it is a note, not a wall
  });

  it("resolves to an empty snapshot (not a rejection) with no network and no cache", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(loadChangelog()).resolves.toEqual({
      entries: [],
      stale: true,
      degraded: false,
      fetchedAt: null,
    });
  });
});

// ── The G/H seam: the REAL endpoint's degradation signal ────────────────────────────────────────
// Regression guard for an integration defect that neither side's suite could see. The API answers
// `{ ok: true, source: "unavailable", entries: [] }` when it cannot reach its database — a string
// VALUE, not a flag key. The client's original probe tested truthy KEYS only, and no key named
// `unavailable` exists in that payload, so the probe could never fire against the real server: an
// unreachable database rendered a confident "nothing new" and the offline cache was never used.
//
// These assert the SIDE EFFECT (degraded is true for the real payload shape), and each would have
// failed against the client as it was before the fix.
describe("parseChangelogPayload — degradation as the endpoint actually reports it", () => {
  it("treats source:'unavailable' as degraded even though no such KEY exists", () => {
    const r = parseChangelogPayload({ ok: true, source: "unavailable", count: 0, entries: [] });
    expect(r.degraded).toBe(true);
  });

  it("does NOT treat the healthy source:'database' as degraded", () => {
    const r = parseChangelogPayload({ ok: true, source: "database", count: 0, entries: [] });
    expect(r.degraded).toBe(false);
  });

  it("treats the endpoint's error shape (ok:false) as degraded", () => {
    const r = parseChangelogPayload({ ok: false, error: "invalid since", entries: [], count: 0 });
    expect(r.degraded).toBe(true);
  });

  it("still parses entries out of a degraded response rather than discarding them", () => {
    const r = parseChangelogPayload({
      ok: true,
      source: "unavailable",
      entries: [
        {
          id: "1",
          slug: "abc1234-x",
          shippedAt: "2026-08-12T21:53:18-07:00",
          title: "T",
          summary: "S",
          bullets: [],
          changeType: "feature",
          categories: [],
          links: [],
          surfaces: [],
          releaseVersion: "v0.102.0",
        },
      ],
    });
    expect(r.degraded).toBe(true);
    expect(r.entries).toHaveLength(1);
  });
});
