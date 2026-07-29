// The @-mention rules, as data. No React here — see MentionPicker.test.tsx for the overlay,
// ComposeBox.mentions.test.tsx for the composer wiring, and ConciergeHost.mention.test.tsx for what
// a mention actually DOES to a send.
import { describe, expect, it } from "vitest";
import {
  backspaceMention,
  findMentionSpans,
  insertMention,
  isCompletedMention,
  matchScore,
  MATCH_NONE,
  mentionFreeText,
  mentionQuery,
  mentionsIn,
  orderMentionAgents,
  mentionRoster,
  withMentionLabels,
  splitMentionText,
  type MentionAgent,
} from "./mentions";

function agent(over: Partial<MentionAgent> & { id: string; name: string }): MentionAgent {
  return {
    projectId: "p1",
    projectName: "web",
    band: "running",
    canAcceptInput: true,
    ...over,
  };
}

const BLUEPRINT = agent({ id: "a1", name: "Blueprint UI/UX" });
const KRAKEN = agent({ id: "a2", name: "Kraken Auth" });
const FLEET = [BLUEPRINT, KRAKEN];

describe("findMentionSpans — a mention is the literal, bounded like a token", () => {
  it("finds a mention mid-sentence and reports its exact span", () => {
    const text = "Tell @Kraken Auth to ship it";
    expect(findMentionSpans(text, FLEET)).toEqual([
      { agentId: "a2", name: "Kraken Auth", start: 5, end: 17 },
    ]);
    expect(text.slice(5, 17)).toBe("@Kraken Auth");
  });

  it("matches a mention that IS the whole message", () => {
    expect(findMentionSpans("@Kraken Auth", FLEET)).toHaveLength(1);
  });

  // THE WRONG-AGENT BUG. A fleet holding both "Blue" and "Blueprint UI/UX" must not resolve
  // "@Blueprint UI/UX" to "Blue" — the user would read one name and the message would be delivered
  // to another, which is the one failure this module's whole design exists to make unreachable.
  it("does not find a SHORTER name inside a longer one", () => {
    const blue = agent({ id: "a3", name: "Blue" });
    const spans = findMentionSpans("ping @Blueprint UI/UX now", [blue, BLUEPRINT]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.agentId).toBe("a1");
  });

  it("prefers the LONGER name when one is a prefix of the other", () => {
    const short = agent({ id: "a4", name: "Blueprint UI" });
    const spans = findMentionSpans("@Blueprint UI/UX go", [short, BLUEPRINT]);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("Blueprint UI/UX");
  });

  // An email address is not a mention, and typing one must not aim a message at an agent.
  it("ignores an @ that does not START a token", () => {
    expect(findMentionSpans("mail me at me@Kraken Auth", FLEET)).toEqual([]);
    expect(findMentionSpans("@@Kraken Auth", FLEET)).toEqual([]);
  });

  it("finds several mentions in first-appearance order", () => {
    const spans = findMentionSpans("@Kraken Auth and @Blueprint UI/UX", FLEET);
    expect(spans.map((s) => s.agentId)).toEqual(["a2", "a1"]);
  });

  it("never matches an agent with an empty name", () => {
    expect(findMentionSpans("say @ something", [agent({ id: "x", name: "" })])).toEqual([]);
  });

  // roborev 54551. The boundary class used to be alphanumerics only, so a "/" did not count as
  // continuing a name: typing the full "@Blueprint UI/UX" against a fleet holding only the SHORTER
  // "Blueprint UI" matched that shorter agent and left "/UX" dangling for its terminal. No aim beats
  // the wrong aim.
  it("refuses a match that a name-ish character runs past", () => {
    const short = agent({ id: "s", name: "Blueprint UI" });
    expect(findMentionSpans("@Blueprint UI/UX", [short])).toEqual([]);
  });

  it("still matches that name when nothing runs past it", () => {
    const short = agent({ id: "s", name: "Blueprint UI" });
    expect(findMentionSpans("@Blueprint UI ship it", [short])).toHaveLength(1);
  });

  it("treats a hyphen and a dot as name characters too", () => {
    const dash = agent({ id: "d", name: "Auth" });
    expect(findMentionSpans("@Auth-v2", [dash])).toEqual([]);
    expect(findMentionSpans("@Auth.old", [dash])).toEqual([]);
  });

  // roborev 54555. Widening the boundary class to catch "@Blueprint UI/UX" made ordinary sentence
  // punctuation terminate nothing, so a mention ending a sentence silently lost its aim — and the
  // founder DICTATES, so a trailing full stop is the common case, not a corner one. What decides it
  // is whether something name-ish FOLLOWS the punctuation.
  it("resolves a mention that ends a sentence", () => {
    expect(findMentionSpans("please look at this, @Kraken Auth.", FLEET)).toHaveLength(1);
  });

  it("resolves a mention followed by other sentence punctuation", () => {
    for (const tail of ["!", "?", ",", ";", ")", '"', "…"]) {
      expect(findMentionSpans(`ping @Kraken Auth${tail} now`, FLEET)).toHaveLength(1);
    }
  });

  it("still refuses a longer name however much punctuation it stacks", () => {
    const dash = agent({ id: "d", name: "Auth" });
    expect(findMentionSpans("@Auth--v2", [dash])).toEqual([]);
  });

  it("strips a sentence-final mention without eating the full stop", () => {
    expect(mentionFreeText("ship it, @Kraken Auth.", FLEET)).toBe("ship it,.");
  });

  // An UNLABELLED duplicate still resolves by array order — this function has no opinion about
  // relevance and never did (roborev 54551 caught it claiming to). Nothing in the app reaches it in
  // that state: `mentionRoster` labels duplicates first, which is what makes each one addressable
  // (see withMentionLabels). Pinned so the raw behaviour is stated rather than assumed.
  it("resolves a duplicate name to whichever agent the caller ordered first", () => {
    const web = agent({ id: "w", name: "Docs", projectName: "web" });
    const mobile = agent({ id: "m", name: "Docs", projectName: "mobile" });
    expect(findMentionSpans("@Docs ship", [web, mobile])[0]!.agentId).toBe("w");
    expect(findMentionSpans("@Docs ship", [mobile, web])[0]!.agentId).toBe("m");
  });
});

describe("mentionRoster — the one list every other function is handed", () => {
  it("keeps every agent", () => {
    expect(mentionRoster(FLEET)).toHaveLength(2);
  });

  it("puts the agent in view first", () => {
    expect(mentionRoster(FLEET, "a2")[0]!.id).toBe("a2");
  });

  // Ordering AND labelling in one call, so a consumer cannot do half of it. This is the whole
  // reason it exists (roborev 54555): the contract used to be a comment naming someone else.
  it("labels duplicates as well as ordering them", () => {
    const web = agent({ id: "w", name: "Docs", projectName: "web" });
    const mobile = agent({ id: "m", name: "Docs", projectName: "mobile" });
    expect(mentionRoster([web, mobile]).map((a) => a.label).sort()).toEqual([
      "Docs (mobile)",
      "Docs (web)",
    ]);
  });
});

describe("withMentionLabels — a duplicate name is not an address", () => {
  it("leaves a unique name alone", () => {
    expect(withMentionLabels(FLEET).every((a) => a.label === undefined)).toBe(true);
  });

  it("suffixes the project onto each of two same-named agents", () => {
    const web = agent({ id: "w", name: "Docs", projectName: "web" });
    const mobile = agent({ id: "m", name: "Docs", projectName: "mobile" });
    const [a, b] = withMentionLabels([web, mobile]);
    expect(a!.label).toBe("Docs (web)");
    expect(b!.label).toBe("Docs (mobile)");
  });

  // THE BUG (roborev 54557): picking the SECOND "Docs" row used to insert a bare "@Docs", which
  // re-resolved to the FIRST agent — a silent wrong-agent aim, with the bubble drawing the same
  // pill either way. Each label is now its own literal, so each resolves to exactly one agent.
  it("makes each duplicate separately addressable", () => {
    const roster = withMentionLabels([
      agent({ id: "w", name: "Docs", projectName: "web" }),
      agent({ id: "m", name: "Docs", projectName: "mobile" }),
    ]);
    expect(findMentionSpans("@Docs (mobile) ship", roster)[0]!.agentId).toBe("m");
    expect(findMentionSpans("@Docs (web) ship", roster)[0]!.agentId).toBe("w");
  });

  // A bare "@Docs" no longer names an agent, and that is correct rather than a regression: it does
  // not identify one. The send falls through to the auto-router, the recoverable direction.
  it("resolves a bare ambiguous name to NOTHING", () => {
    const roster = withMentionLabels([
      agent({ id: "w", name: "Docs", projectName: "web" }),
      agent({ id: "m", name: "Docs", projectName: "mobile" }),
    ]);
    expect(findMentionSpans("@Docs ship", roster)).toEqual([]);
  });

  it("inserts, matches and strips the disambiguated address end to end", () => {
    const roster = withMentionLabels([
      agent({ id: "w", name: "Docs", projectName: "web" }),
      agent({ id: "m", name: "Docs", projectName: "mobile" }),
    ]);
    const { text } = insertMention("@Docs", 0, 5, roster[1]!);
    expect(text).toBe("@Docs (mobile) ");
    const found = mentionsIn(`${text}ship it`, roster);
    expect(found).toEqual([{ agentId: "m", name: "Docs (mobile)" }]);
    expect(mentionFreeText(`${text}ship it`, roster)).toBe("ship it");
  });
});

describe("mentionsIn — what a send carries", () => {
  it("de-duplicates the same agent named twice", () => {
    expect(mentionsIn("@Kraken Auth then @Kraken Auth again", FLEET)).toEqual([
      { agentId: "a2", name: "Kraken Auth" },
    ]);
  });

  it("is empty when nothing matches a known agent", () => {
    expect(mentionsIn("@Nobody at all", FLEET)).toEqual([]);
  });

  // The fail-CLOSED direction: one deleted character and the aim is gone, rather than a pill that
  // still points somewhere while showing a corrupted name.
  it("drops the mention the moment the literal is corrupted", () => {
    expect(mentionsIn("@Kraken Aut", FLEET)).toEqual([]);
  });
});

describe("mentionFreeText — the @ must never reach the PTY", () => {
  it("strips the address and collapses the gap it leaves", () => {
    expect(mentionFreeText("Tell @Kraken Auth to ship it", FLEET)).toBe("Tell to ship it");
  });

  it("strips a leading mention and trims", () => {
    expect(mentionFreeText("@Kraken Auth ship it", FLEET)).toBe("ship it");
  });

  it("leaves text with no mentions exactly alone", () => {
    expect(mentionFreeText("ship it  now", FLEET)).toBe("ship it  now");
  });

  it("keeps the user's own newlines", () => {
    expect(mentionFreeText("@Kraken Auth do this:\n- one\n- two", FLEET)).toBe(
      "do this:\n- one\n- two",
    );
  });

  // roborev 54551. The gap left by the removal used to be closed with a GLOBAL `[ \t]{2,}` collapse,
  // which flattened every run of whitespace in the message — so a pasted code block, a diff or a
  // nested list reached the agent's terminal re-indented. Only the seam is closed now.
  it("preserves indentation in a pasted block", () => {
    expect(mentionFreeText("@Kraken Auth run this:\n    npm test\n    npm run lint", FLEET)).toBe(
      "run this:\n    npm test\n    npm run lint",
    );
  });

  it("leaves the user's own double spaces alone", () => {
    expect(mentionFreeText("@Kraken Auth ship  it  now", FLEET)).toBe("ship  it  now");
  });

  // One space, not both sides — otherwise "a @X b" would lose the word break between a and b.
  it("keeps the word break when a mention sits between two words", () => {
    expect(mentionFreeText("a @Kraken Auth b", FLEET)).toBe("a b");
  });

  it("eats the space BEFORE a mention that ends the message", () => {
    expect(mentionFreeText("tell @Kraken Auth", FLEET)).toBe("tell");
  });

  it("is empty when the message was nothing but an address", () => {
    expect(mentionFreeText("@Kraken Auth", FLEET)).toBe("");
  });

  // roborev 54569. This used to delete EVERY mention span, which destroys the sentence for any name
  // that is not the envelope: the agent received an instruction with its referenced party silently
  // removed, written irreversibly into a terminal. Only the address goes; the rest lose the sigil
  // (which is the whole reason the stripping exists) and keep the name, which is content.
  it("keeps a SECOND agent's name, minus the sigil", () => {
    expect(
      mentionFreeText(
        "@Kraken Auth please coordinate with @Blueprint UI/UX before you land this",
        FLEET,
      ),
    ).toBe("please coordinate with Blueprint UI/UX before you land this");
  });

  it("de-sigils every mention after the first, wherever they sit", () => {
    expect(mentionFreeText("@Kraken Auth ask @Blueprint UI/UX and @Blueprint UI/UX again", FLEET)).toBe(
      "ask Blueprint UI/UX and Blueprint UI/UX again",
    );
  });

  // The point of the whole function: no "@" survives to the wire, because a leading "@" opens the
  // Claude Code CLI's own file-reference autocomplete.
  it("leaves no sigil anywhere in the wire text", () => {
    const wire = mentionFreeText("@Kraken Auth tell @Blueprint UI/UX to wait", FLEET);
    expect(wire).not.toContain("@");
  });
});

describe("mentionQuery — is the caret inside a mention being typed?", () => {
  it("reports an empty query for a bare @", () => {
    expect(mentionQuery("@", 1)).toEqual({ anchor: 0, query: "" });
  });

  it("reports what has been typed after the sigil", () => {
    expect(mentionQuery("tell @Bl", 8)).toEqual({ anchor: 5, query: "Bl" });
  });

  // Agent names have spaces, so the query cannot stop at the first one — "@Kraken " has to keep
  // matching while "Auth" is typed.
  it("keeps running across a space", () => {
    expect(mentionQuery("@Kraken Au", 10)).toEqual({ anchor: 0, query: "Kraken Au" });
  });

  it("stops at a newline — a mention does not span lines", () => {
    expect(mentionQuery("@Kraken\nsomething", 17)).toBeNull();
  });

  it("is null when the caret is before the sigil", () => {
    expect(mentionQuery("tell @Bl", 4)).toBeNull();
  });

  it("is null for an email address", () => {
    expect(mentionQuery("me@example", 10)).toBeNull();
  });

  it("gives up once the query is implausibly long", () => {
    expect(mentionQuery(`@${"x".repeat(60)}`, 61)).toBeNull();
  });

  it("clamps a caret past the end rather than throwing", () => {
    expect(mentionQuery("@Bl", 999)).toEqual({ anchor: 0, query: "Bl" });
  });
});

describe("matchScore — prefix beats word-prefix beats subsequence", () => {
  it("matches everything on an empty query", () => {
    expect(matchScore("Blueprint UI/UX", "")).toBeGreaterThan(MATCH_NONE);
  });

  it("scores a leading prefix highest", () => {
    expect(matchScore("Blueprint UI/UX", "Bl")).toBeGreaterThan(
      matchScore("Blueprint UI/UX", "UI"),
    );
  });

  it("matches a later WORD, which is often what the agent is called", () => {
    expect(matchScore("Kraken Auth", "auth")).toBeGreaterThan(MATCH_NONE);
  });

  it("treats a slash as a word break", () => {
    expect(matchScore("Blueprint UI/UX", "ux")).toBeGreaterThan(MATCH_NONE);
  });

  it("falls back to a subsequence, below both prefix tiers", () => {
    const sub = matchScore("Blueprint UI/UX", "bpui");
    expect(sub).toBeGreaterThan(MATCH_NONE);
    expect(sub).toBeLessThan(matchScore("Blueprint UI/UX", "Blue"));
  });

  it("ignores spaces in a fuzzy query", () => {
    expect(matchScore("Blueprint UI", "bp ui")).toBeGreaterThan(MATCH_NONE);
  });

  it("is case-insensitive", () => {
    expect(matchScore("Kraken Auth", "KRAKEN")).toBe(matchScore("Kraken Auth", "kraken"));
  });

  it("scores nothing for a miss", () => {
    expect(matchScore("Kraken Auth", "zzz")).toBe(MATCH_NONE);
  });
});

describe("orderMentionAgents", () => {
  it("narrows as the query grows", () => {
    expect(orderMentionAgents(FLEET, "").map((a) => a.id)).toHaveLength(2);
    expect(orderMentionAgents(FLEET, "Bl").map((a) => a.id)).toEqual(["a1"]);
  });

  it("puts the agent already in view first", () => {
    expect(orderMentionAgents(FLEET, "", "a2")[0]!.id).toBe("a2");
  });

  it("puts an agent that needs you above one that is merely running", () => {
    const needy = agent({ id: "n", name: "Nightly Deploy", band: "needs_you" });
    expect(orderMentionAgents([BLUEPRINT, needy], "")[0]!.id).toBe("n");
  });

  it("breaks a tie on the user's most recent touch", () => {
    const older = agent({ id: "o", name: "Older One", since: 100 });
    const newer = agent({ id: "n", name: "Newer One", since: 900 });
    expect(orderMentionAgents([older, newer], "")[0]!.id).toBe("n");
  });

  it("sorts a never-touched agent BELOW a touched one, not above it", () => {
    const touched = agent({ id: "t", name: "Zzz Touched", since: 5 });
    const never = agent({ id: "u", name: "Aaa Untouched" });
    expect(orderMentionAgents([never, touched], "")[0]!.id).toBe("t");
  });

  // Listed, not hidden: "no such agent" and "that one is a cloud agent" are different answers and
  // the user is owed the second one.
  it("still LISTS an agent that cannot take input, but sorts it last", () => {
    const cloud = agent({ id: "c", name: "Cloud Runner", canAcceptInput: false, band: "needs_you" });
    const ordered = orderMentionAgents([cloud, BLUEPRINT], "");
    expect(ordered.map((a) => a.id)).toEqual(["a1", "c"]);
  });

  it("does not reorder the caller's array", () => {
    const list = [BLUEPRINT, KRAKEN];
    orderMentionAgents(list, "");
    expect(list[0]).toBe(BLUEPRINT);
  });
});

describe("isCompletedMention — the picker has to close over its own pill", () => {
  // The bug this exists for: insertMention leaves `@Kraken Auth `, and matchScore TRIMS, so that
  // query still prefix-matches "Kraken Auth" and the list re-opens over the pill it just inserted.
  it("is true once a complete name is followed by a space", () => {
    expect(isCompletedMention("Kraken Auth ", FLEET)).toBe(true);
  });

  // A name can be a prefix of a sibling's. Closing on the bare exact match would put "/UX" out of
  // reach of anyone typing "@Blueprint UI" by hand.
  it("is false for an exact name with nothing after it", () => {
    const short = agent({ id: "a4", name: "Blueprint UI" });
    expect(isCompletedMention("Blueprint UI", [short, BLUEPRINT])).toBe(false);
  });

  it("is false mid-name, so a space inside a name keeps the list open", () => {
    expect(isCompletedMention("Kraken ", FLEET)).toBe(false);
  });

  it("is false for a query that names nobody", () => {
    expect(isCompletedMention("Nobody ", FLEET)).toBe(false);
  });

  it("is false for whitespace alone", () => {
    expect(isCompletedMention("  ", FLEET)).toBe(false);
  });

  it("ignores case, like every other match here", () => {
    expect(isCompletedMention("kraken auth ", FLEET)).toBe(true);
  });

  // The exact shape roborev 54551 described: mentionQuery has no notion of a completed mention, so
  // straight after a pick it still reports an open query that matchScore trims and scores at the top
  // tier. isCompletedMention is what closes the list; without it the next Enter re-picks the agent
  // instead of sending. Pinned here on the composed pair, not on either half alone.
  it("closes the list on the exact text insertMention produces", () => {
    const { text, caret } = insertMention("tell @Kra", 5, 9, KRAKEN);
    const q = mentionQuery(text, caret);
    expect(q).not.toBeNull();
    expect(matchScore(KRAKEN.name, q!.query)).toBeGreaterThan(MATCH_NONE);
    // …and yet the picker must be shut, which is the whole point of the helper.
    expect(isCompletedMention(q!.query, FLEET)).toBe(true);
  });

  // A few words past a completed mention the query stops matching anything at all, so the list
  // stays shut on its own rather than re-opening until MAX_MENTION_QUERY runs out.
  it("leaves nothing matching once the user types on past the pill", () => {
    const text = "@Kraken Auth move it 5px";
    const q = mentionQuery(text, text.length)!;
    expect(orderMentionAgents(FLEET, q.query)).toEqual([]);
  });
});

describe("insertMention", () => {
  it("replaces the in-progress query and leaves the caret past a trailing space", () => {
    const { text, caret } = insertMention("tell @Bl", 5, 8, BLUEPRINT);
    expect(text).toBe("tell @Blueprint UI/UX ");
    expect(caret).toBe(text.length);
  });

  it("keeps whatever followed the caret", () => {
    const { text } = insertMention("tell @Bl to ship", 5, 8, BLUEPRINT);
    expect(text).toBe("tell @Blueprint UI/UX  to ship");
  });

  it("produces text the matcher then reads back as a mention", () => {
    const { text } = insertMention("@K", 0, 2, KRAKEN);
    expect(mentionsIn(text, FLEET)).toEqual([{ agentId: "a2", name: "Kraken Auth" }]);
  });
});

describe("backspaceMention — the whole pill, never half a name", () => {
  it("removes the entire mention when the caret sits after its trailing space", () => {
    const text = "@Kraken Auth ";
    expect(backspaceMention(text, text.length, FLEET)).toEqual({ text: "", caret: 0 });
  });

  it("removes the entire mention when the caret sits right at its edge", () => {
    const text = "@Kraken Auth";
    expect(backspaceMention(text, 12, FLEET)).toEqual({ text: "", caret: 0 });
  });

  it("keeps the rest of the message", () => {
    const text = "tell @Kraken Auth ship it";
    expect(backspaceMention(text, 18, FLEET)).toEqual({ text: "tell ship it", caret: 5 });
  });

  it("declines when the caret is in ordinary text", () => {
    expect(backspaceMention("just words", 10, FLEET)).toBeNull();
  });

  it("declines mid-name, so the textarea's own Backspace still works there", () => {
    expect(backspaceMention("@Kraken Auth", 8, FLEET)).toBeNull();
  });
});

describe("splitMentionText — how a sent bubble draws its pills", () => {
  const mentions = [{ agentId: "a2", name: "Kraken Auth" }];

  it("splits text around the pill", () => {
    expect(splitMentionText("Tell @Kraken Auth to ship", mentions)).toEqual([
      { kind: "text", text: "Tell " },
      { kind: "mention", text: "@Kraken Auth", agentId: "a2" },
      { kind: "text", text: " to ship" },
    ]);
  });

  it("returns one plain run when the message has no mentions", () => {
    expect(splitMentionText("just words", [])).toEqual([{ kind: "text", text: "just words" }]);
  });

  it("returns nothing for empty text", () => {
    expect(splitMentionText("", [])).toEqual([]);
  });

  // History outlives the roster: a message sent to an agent that has since been closed must still
  // render as the pill the user addressed, because the record travels ON the message.
  it("draws a pill for an agent that no longer exists anywhere", () => {
    const parts = splitMentionText("@Ghost Agent hi", [{ agentId: "gone", name: "Ghost Agent" }]);
    expect(parts[0]).toEqual({ kind: "mention", text: "@Ghost Agent", agentId: "gone" });
  });
});
