import { describe, expect, it } from "vitest";
import { categoryEntries, matchesAny, matchesSearch, paneQueryFor } from "./settingsSearch";
import { TOOLS_CATEGORY_KEYWORDS, TOOL_META } from "../components/ToolsPane";
import { TOOLS_CATEGORY } from "../components/SettingsDialog";

describe("matchesSearch", () => {
  it("matches a substring within a term, so a partial word still finds its setting", () => {
    expect(matchesSearch("Notifications banner alerts desktop", "notif")).toBe(true);
    expect(matchesSearch("… vault backup restore seed worktree", "worktree")).toBe(true);
  });

  it("is case-insensitive and ignores surrounding whitespace", () => {
    expect(matchesSearch("Deepgram voice", "  DEEPGRAM  ")).toBe(true);
  });

  it("requires EVERY term, in any order — the substring form required them adjacent", () => {
    const hay = "Voice controls push to talk speak dictation microphone";
    expect(matchesSearch(hay, "push microphone")).toBe(true); // not adjacent, not in order
    expect(matchesSearch(hay, "microphone push")).toBe(true);
    expect(matchesSearch(hay, "push keyboard")).toBe(false); // one term missing → no match
  });

  it("treats an all-whitespace query as no filter at all", () => {
    expect(matchesSearch("anything", "   ")).toBe(true);
  });

  it("cannot match a single TERM across the boundary between two joined entries", () => {
    // A term carries no whitespace, so it can never span the separator a join inserts.
    const joined = ["alpha beta", "gamma delta"].join(" ");
    expect(joined.includes("beta gamma")).toBe(true); // raw substring straddles the join…
    expect(matchesSearch(joined, "betagamma")).toBe(false); // …no term can.
  });

  it("still accepts terms spread across a joined blob — which is why the rail uses matchesAny", () => {
    // The half per-term matching does NOT fix, stated honestly: `matchesSearch` on a concatenation
    // says yes when the terms live in different entries. That is the whole reason the rail matches
    // entry-by-entry instead of matching one blob.
    const joined = ["alpha beta", "gamma delta"].join(" ");
    expect(matchesSearch(joined, "beta gamma")).toBe(true);
    expect(matchesAny(["alpha beta", "gamma delta"], "beta gamma")).toBe(false);
  });
});

describe("matchesAny", () => {
  it("requires every term inside ONE entry", () => {
    const entries = ["Deepgram voice dictation", "Beads plan board"];
    expect(matchesAny(entries, "deepgram dictation")).toBe(true);
    expect(matchesAny(entries, "beads board")).toBe(true);
    expect(matchesAny(entries, "deepgram beads")).toBe(false);
  });

  it("matches nothing when there are no entries, and everything on an empty query", () => {
    expect(matchesAny([], "anything")).toBe(false);
    expect(matchesAny(["x"], "  ")).toBe(true);
  });
});

describe("categoryEntries", () => {
  it("gives a non-row-filtering category ONE entry, label and keywords together", () => {
    expect(categoryEntries("Mobile", ["phone pair devices"])).toEqual(["Mobile phone pair devices"]);
  });

  it("gives a row-filtering category the label alone PLUS one label-prefixed entry per row", () => {
    expect(categoryEntries("Tools", ["Beads bd plan", "GitHub import clone"], true)).toEqual([
      "Tools",
      "Tools Beads bd plan",
      "Tools GitHub import clone",
    ]);
  });
});

describe("paneQueryFor", () => {
  // Exact outputs, not existential ones. The assertions in the invariant suite below all carry a
  // `paneQ === "" ||` escape hatch, so a `paneQueryFor` that returned "" unconditionally — which
  // would show every row for "tools github" — satisfies them. These cannot be satisfied that way.
  it("strips the terms that name the category, and keeps the rest", () => {
    expect(paneQueryFor("Tools", "tools")).toBe("");
    expect(paneQueryFor("Tools", "tools github")).toBe("github");
    expect(paneQueryFor("Tools", "github")).toBe("github");
    expect(paneQueryFor("Tools", "tools deepgram voice")).toBe("deepgram voice");
  });

  it("compares case-insensitively on both sides", () => {
    // Latent in the dialog, which pre-lowercases — but this is exported and generic, and a
    // case-sensitive compare let "Tools BEADS" through the strip so the pane filtered every row away.
    expect(paneQueryFor("Tools", "Tools BEADS")).toBe("beads");
    expect(paneQueryFor("tools", "TOOLS")).toBe("");
  });

  it("drops only PREFIXES of a label word, never arbitrary substrings", () => {
    // The prefix-vs-substring distinction, which nothing else pins: under substring semantics every
    // one of these is swallowed and the pane sits unfiltered while the user types.
    expect(paneQueryFor("Tools", "ol")).toBe("ol");
    expect(paneQueryFor("Tools", "ls")).toBe("ls");
    expect(paneQueryFor("Tools", "oo")).toBe("oo");
    // …and a longer label makes it a real defect rather than a curiosity.
    expect(paneQueryFor("1Password", "1password pass")).toBe("pass");
    expect(paneQueryFor("1Password", "word as")).toBe("word as");
    // Prefixes of a label word ARE dropped, which is the intended behavior: naming the category.
    expect(paneQueryFor("Tools", "t")).toBe("");
    expect(paneQueryFor("Tools", "tool")).toBe("");
  });

  it("leaves a query alone when the label answers none of it", () => {
    expect(paneQueryFor("Credits", "deepgram voice")).toBe("deepgram voice");
  });
});

describe("matchesSearch — the rail and the Tools pane cannot disagree", () => {
  // The invariant the shared matcher exists for: if a query surfaces the Tools CATEGORY, some row
  // in the pane must survive it, and vice versa. Both sides call this same function, so this pins
  // the data rather than the plumbing — every word any row answers to is advertised by the rail.
  // Built by calling the REAL entry builder, not by hand-modelling it. A hand-written
  // `["Tools", ...TOOLS_SEARCH_ENTRIES]` was an exact model right up until the rail started
  // prefixing entries with the label, at which point this suite went on validating strings the rail
  // never emits — and deleting the prefix (reinstating the "tools github" bug) left it fully green.
  // Label, keywords AND flag all come from the production descriptor: hand-writing ("Tools", …,
  // true) is a copy that stays exact until someone renames the label or flips filtersRows.
  const TOOLS_LABEL = TOOLS_CATEGORY.label;
  const railEntries = categoryEntries(
    TOOLS_CATEGORY.label,
    TOOLS_CATEGORY.keywords,
    TOOLS_CATEGORY.filtersRows,
  );
  const rowHaystacks = Object.values(TOOL_META).map((t) => `${t.name} ${t.desc} ${t.keywords}`);

  // Single-row queries: the rail must surface Tools AND a row must survive.
  const shouldMatch = [
    ...new Set(TOOLS_CATEGORY_KEYWORDS.split(/\s+/).filter(Boolean)),
    "deepgram voice",
    "session replay",
    "on-device speech",
    "back up env",
  ];

  it.each(shouldMatch)("query %j lands on both the category and a row", (q) => {
    expect(matchesAny(railEntries, q), `the rail must surface Tools for ${JSON.stringify(q)}`).toBe(true);
    expect(
      rowHaystacks.some((h) => matchesSearch(h, q)),
      `…and a row must survive it, or the pane opens onto "No tools match"`,
    ).toBe(true);
  });

  // CROSS-ROW queries: terms that exist in the pane but never together in one row. The rail must
  // NOT surface Tools for these — it did while it matched one joined blob, and the pane then had
  // nothing to show. This is the direction the earlier suite never exercised, because every
  // multi-word case in it was curated to sit inside a single row.
  const shouldNotMatch = ["deepgram beads", "posthog worktrees", "superpowers github"];

  it.each(shouldNotMatch)("query %j surfaces neither the category nor a row", (q) => {
    expect(
      rowHaystacks.some((h) => matchesSearch(h, q)),
      `${JSON.stringify(q)} is only a cross-row query if no single row matches it`,
    ).toBe(false);
    expect(
      matchesAny(railEntries, q),
      "the rail must not surface a category whose pane would then render an empty state",
    ).toBe(false);
  });

  // THE round trip, which is the invariant itself rather than a proxy for it: whatever the rail
  // accepts, the pane — filtering by the query with the label terms stripped — must keep a row.
  // The two halves are separate functions applied in series, so only running them in series can
  // show they agree. Label forms included, since those are the ones the strip exists for.
  it.each(shouldMatch)("rail accepting %j implies the pane keeps a row", (q) => {
    const paneQ = paneQueryFor(TOOLS_LABEL, q);
    expect(
      rowHaystacks.some((h) => matchesSearch(h, paneQ)) || paneQ === "",
      `the rail accepted ${JSON.stringify(q)} but the pane would filter every row away (pane query: ${JSON.stringify(paneQ)})`,
    ).toBe(true);
  });

  // LABEL FORMS — name the category, then narrow inside it. These must be ACCEPTED, asserted
  // directly rather than through a round trip that skips non-matches: a round trip alone goes green
  // when the label prefix is deleted, because the query it was meant to protect stops matching and
  // gets skipped. That is the exact regression ("tools github" finding nothing) this pins.
  const labelForms = ["tools", "tools github", "tools deepgram", "tools 1password", "Tools BEADS"];

  it.each(labelForms)("the rail accepts %j, and the pane keeps a row once the label is stripped", (q) => {
    expect(
      matchesAny(railEntries, q),
      `the rail must keep Tools for ${JSON.stringify(q)} — dropping the category loses the route to the thing the user just named`,
    ).toBe(true);
    const paneQ = paneQueryFor(TOOLS_LABEL, q);
    expect(
      paneQ === "" || rowHaystacks.some((h) => matchesSearch(h, paneQ)),
      `…and the pane must keep a row for it (pane query: ${JSON.stringify(paneQ)})`,
    ).toBe(true);
  });
});
