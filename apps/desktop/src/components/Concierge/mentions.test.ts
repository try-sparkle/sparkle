// The @-mention rules, as data. No React here — see MentionPicker.test.tsx for the overlay,
// ComposeBox.mentions.test.tsx for the composer wiring, and ConciergeHost.mention.test.tsx for what
// a mention actually DOES to a send.
import { describe, expect, it } from "vitest";
import {
  backspaceMention,
  dictatedSparkleAddress,
  findMentionSpans,
  insertMention,
  isCompletedMention,
  isComposingMention,
  matchScore,
  MATCH_NONE,
  mentionFreeText,
  mentionQuery,
  MAX_MENTION_QUERY,
  mentionsIn,
  mentionScanStats,
  orderMentionAgents,
  rosterFromMentions,
  scanMentions,
  splitAtMentionSpans,
  type ConciergeMention,
  type MentionSpan,
  mentionRoster,
  withMentionLabels,
  splitMentionText,
  SPARKLE_MENTION_AGENT,
  SPARKLE_MENTION_ID,
  type MentionAgent,
} from "./mentions";
// The APP-OWNED Improve-Sparkle agent's real id and name. Imported rather than spelled as literals
// on purpose: the collision these tests are about exists because that name IS "Sparkle", so a test
// that hardcoded the string would keep passing if the constant were ever renamed — and the bug would
// come back silently (bead sparkle-k5kit).
import { SPARKLE_AGENT_ID, SPARKLE_AGENT_NAME } from "../../services/sparkleAgent";
import { classifyComposerRoute } from "./composerRoute";

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

  it("keeps a sentence-final mention's name, and does not eat the full stop", () => {
    expect(mentionFreeText("ship it, @Kraken Auth.", FLEET)).toBe("ship it, Kraken Auth.");
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
  /** The roster minus the concierge, which every case below is about the AGENTS in. */
  const agentsOf = (r: MentionAgent[]) => r.filter((a) => a.id !== SPARKLE_MENTION_ID);

  it("keeps every agent", () => {
    expect(agentsOf(mentionRoster(FLEET))).toHaveLength(2);
  });

  it("puts the agent in view first", () => {
    expect(mentionRoster(FLEET, "a2")[0]!.id).toBe("a2");
  });

  // Ordering AND labelling in one call, so a consumer cannot do half of it. This is the whole
  // reason it exists (roborev 54555): the contract used to be a comment naming someone else.
  it("labels duplicates as well as ordering them", () => {
    const web = agent({ id: "w", name: "Docs", projectName: "web" });
    const mobile = agent({ id: "m", name: "Docs", projectName: "mobile" });
    expect(agentsOf(mentionRoster([web, mobile])).map((a) => a.label).sort()).toEqual([
      "Docs (mobile)",
      "Docs (web)",
    ]);
  });

  // ── The concierge is a mention target too ─────────────────────────────────────────────────────
  // Here rather than in a composer-local second roster, on purpose: this function exists so that no
  // consumer can resolve against a list the others don't have (see its doc). A `@Sparkle` the picker
  // offers but a send cannot resolve is the silent wrong-aim class of bug.
  it("always offers the concierge, even with no build agents at all", () => {
    expect(mentionRoster([]).map((a) => a.id)).toEqual([SPARKLE_MENTION_ID]);
  });

  it("never lets the concierge outrank a real agent, or the one in view", () => {
    // `band: "done"` and no `since` are a SORT position, not a status claim — a running agent and
    // the preferred agent both come first, so "@" then Enter still aims at what you were looking at.
    expect(mentionRoster(FLEET).at(-1)!.id).toBe(SPARKLE_MENTION_ID);
    expect(mentionRoster(FLEET, "a2")[0]!.id).toBe("a2");
  });

  it("offers it as choosable, since it is the one destination that is never a dead PTY", () => {
    expect(mentionRoster([]).find((a) => a.id === SPARKLE_MENTION_ID)!.canAcceptInput).toBe(true);
  });

  it("resolves `@Sparkle` in the text to it, so a send carries it as an ordinary mention", () => {
    expect(mentionsIn("@Sparkle what broke?", mentionRoster(FLEET))).toEqual([
      { agentId: SPARKLE_MENTION_ID, name: "Sparkle" },
    ]);
  });

  // An agent that shares the concierge's name makes the bare address ambiguous, and the duplicate
  // rule takes over for THE AGENT — it gets a project suffix, so it is still addressable and does
  // not silently swallow the concierge's aim.
  //
  // THE CONCIERGE KEEPS `Sparkle` (bead sparkle-k5kit). It is the reserved address, and relabelling
  // it is what killed the escape hatch: see the pair of tests below, which are the ones that would
  // have caught the founder's screenshot.
  it("suffixes a build agent that shares the concierge's name, and leaves the concierge bare", () => {
    const rival = agent({ id: "r", name: "Sparkle", projectName: "web" });
    expect(
      mentionRoster([rival])
        .map((a) => a.label ?? a.name)
        .sort(),
    ).toEqual(["Sparkle", "Sparkle (web)"]);
  });

  // ══ THE ESCAPE HATCH SURVIVES THE IMPROVE-SPARKLE PANE (bead sparkle-k5kit) ═══════════════════
  // NOT a hypothetical human naming collision. `SPARKLE_AGENT_NAME` IS "Sparkle", so the app's own
  // Improve-Sparkle build agent collides by construction the moment its pane is open — which is the
  // exact state the founder was in. Both rows used to be relabelled, so the bare `@Sparkle` he typed
  // resolved to NOTHING, the message followed the mount into that agent's terminal, and the
  // full-screen refusal came back naming "@Sparkle" because the AGENT is called that.
  it("resolves a bare @Sparkle to the concierge while the Improve Sparkle pane is open", () => {
    const improveSparkle = agent({
      id: SPARKLE_AGENT_ID,
      name: SPARKLE_AGENT_NAME,
      projectName: "Improve Sparkle",
    });
    expect(mentionsIn("@Sparkle what is the status?", mentionRoster([improveSparkle]))).toEqual([
      { agentId: SPARKLE_MENTION_ID, name: "Sparkle" },
    ]);
  });

  // And the pane itself stays reachable by its qualified address — the fix must not cost the founder
  // the ability to address the Improve-Sparkle agent by name. `findMentionSpans` tries the LONGER
  // label first, which is what keeps these two from fighting over the same prefix.
  it("still resolves the qualified address to the Improve Sparkle agent itself", () => {
    const improveSparkle = agent({
      id: SPARKLE_AGENT_ID,
      name: SPARKLE_AGENT_NAME,
      projectName: "Improve Sparkle",
    });
    expect(
      mentionsIn("@Sparkle (Improve Sparkle) ship it", mentionRoster([improveSparkle])),
    ).toEqual([{ agentId: SPARKLE_AGENT_ID, name: "Sparkle (Improve Sparkle)" }]);
  });
});

// ══ SPEAKING AN ADDRESS ══════════════════════════════════════════════════════════════════════════
// You cannot say "@" out loud, so without this there is no spoken way to reach the concierge once the
// column is patched to a terminal. The rule is narrow because "sparkle" is this app's own name and
// turns up in ordinary dictated prose; the position it is scoped to — the head of the message — is
// the same one `mentions[0]` already treats as the envelope.
describe("dictatedSparkleAddress — when a spoken 'sparkle' is an ADDRESS", () => {
  it("takes it at the head of an empty box, dropping the vocative comma", () => {
    expect(dictatedSparkleAddress("", "Sparkle, what is the status?")).toEqual({
      rest: "what is the status?",
    });
  });

  it("takes the bare name on its own", () => {
    expect(dictatedSparkleAddress("", "Sparkle")).toEqual({ rest: "" });
  });

  it("is case-insensitive — a transcript's capitalisation is not a signal", () => {
    expect(dictatedSparkleAddress("", "sparkle ship it")).toEqual({ rest: "ship it" });
  });

  it("treats a whitespace-only box as empty", () => {
    expect(dictatedSparkleAddress("   ", "Sparkle ship it")).toEqual({ rest: "ship it" });
  });

  it("accepts the other sentence punctuation a transcript might put there", () => {
    expect(dictatedSparkleAddress("", "Sparkle. Ship it")).toEqual({ rest: "Ship it" });
    expect(dictatedSparkleAddress("", "Sparkle: ship it")).toEqual({ rest: "ship it" });
    expect(dictatedSparkleAddress("", "Sparkle? ship it")).toEqual({ rest: "ship it" });
  });

  // ── and every way it must DECLINE ────────────────────────────────────────────────────────────
  it("declines mid-sentence — the word is prose there, not an envelope", () => {
    expect(dictatedSparkleAddress("", "the sparkle desktop app keeps crashing")).toBeNull();
  });

  it("declines when anything is already in the box", () => {
    expect(dictatedSparkleAddress("fix the crash", "Sparkle, and tell me when")).toBeNull();
  });

  it("declines a longer word that merely starts with it", () => {
    expect(dictatedSparkleAddress("", "Sparklers are on sale")).toBeNull();
    expect(dictatedSparkleAddress("", "Sparkle's release notes are wrong")).toBeNull();
  });

  it("declines an empty segment", () => {
    expect(dictatedSparkleAddress("", "")).toBeNull();
    expect(dictatedSparkleAddress("", "   ")).toBeNull();
  });

  // The composer feeds the result straight through `insertMention`, so the two have to compose into
  // exactly the literal a PICKED mention produces — that is the whole "speech and typing produce the
  // same artifact" requirement, asserted here on the pure halves.
  it("composes with insertMention into the literal the picker writes", () => {
    const addressed = dictatedSparkleAddress("", "Sparkle, ship it")!;
    const inserted = insertMention("", 0, 0, SPARKLE_MENTION_AGENT);
    expect(`${inserted.text}${addressed.rest}`).toBe("@Sparkle ship it");
    expect(mentionsIn(`${inserted.text}${addressed.rest}`, mentionRoster([]))).toEqual([
      { agentId: SPARKLE_MENTION_ID, name: "Sparkle" },
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
  // ══ AN ADDRESS IS A PREFIX; A NAME IN A SENTENCE IS A SUBJECT ═════════════════════════════════
  // These two rows are the whole rule, and the first one used to assert the BUG — it expected
  // "Tell to ship it", a sentence with its object deleted, written irreversibly into a terminal.
  // The distinction is POSITIONAL, not ordinal: only a mention with nothing but whitespace before
  // it is an envelope. See the founder's two corrupted messages in the block below.
  it("keeps the NAME of a mention that does not lead the message", () => {
    expect(mentionFreeText("Tell @Kraken Auth to ship it", FLEET)).toBe("Tell Kraken Auth to ship it");
  });

  it("strips a leading mention and trims", () => {
    expect(mentionFreeText("@Kraken Auth ship it", FLEET)).toBe("ship it");
  });

  // ══ THE TWO MESSAGES THIS ACTUALLY CORRUPTED, verbatim ════════════════════════════════════════
  // Both reached an agent's terminal as a sentence with a hole in it; the first left the agent
  // stopping to ask what its target was. In each the mention is the SUBJECT of the clause, so
  // deleting it removes the only noun the instruction refers to.
  it("survives as plain text when the mention is the subject, not a routing prefix", () => {
    const findings = agent({ id: "r1", name: "Resolve Stranded Dictation Findings" });
    expect(mentionFreeText("Same issue with @Resolve Stranded Dictation Findings", [findings])).toBe(
      "Same issue with Resolve Stranded Dictation Findings",
    );
  });

  it("survives mid-sentence, with the rest of the sentence intact around it", () => {
    const status = agent({ id: "s1", name: "Status Check (sparkle-desktop)" });
    expect(
      mentionFreeText(
        "Why is @Status Check (sparkle-desktop) just sitting there? It looks like it has unmerged work.",
        [status],
      ),
    ).toBe(
      "Why is Status Check (sparkle-desktop) just sitting there? It looks like it has unmerged work.",
    );
  });

  // The sigil is the ONLY thing that must never survive — it is what opens the CLI's file picker.
  // Asserting the name alone would pass against a rendering that kept "@Kraken Auth" whole.
  it("drops the sigil from a subject mention, keeping nothing but the name", () => {
    const wire = mentionFreeText("Same issue with @Kraken Auth", FLEET);
    expect(wire).not.toContain("@");
    expect(wire).toBe("Same issue with Kraken Auth");
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

  // The space-eating below applies ONLY to a consumed leading address — a mention that survives
  // keeps the spaces around it, because its name is now sitting where the pill was.
  it("keeps both word breaks around a surviving mention", () => {
    expect(mentionFreeText("a @Kraken Auth b", FLEET)).toBe("a Kraken Auth b");
  });

  it("keeps the name of a mention that ends the message", () => {
    expect(mentionFreeText("tell @Kraken Auth", FLEET)).toBe("tell Kraken Auth");
  });

  // A consumed leading address must not leave the wire starting with whitespace — the trim does
  // this, which is why the old per-span space-eating could go. Uses a TAB and extra spaces so the
  // assertion is about the removal's own gap and not about a single tidy space.
  it("leaves no leading whitespace behind when it consumes the address", () => {
    expect(mentionFreeText("@Kraken Auth \t ship it", FLEET)).toBe("ship it");
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

// ══ THE SHARED SCAN ═════════════════════════════════════════════════════════════════════════════
// `scanMentions` is what stopped every consumer of a draft from re-walking it independently — the
// composer, the pill mirror, the auto-send rail and the route classifier were doing the same match
// fourteen times per keystroke over a 60-agent fleet (ConciergeHost.typingCost.test.tsx measures the
// end-to-end number; these rows pin the rules the cache must not break).
//
// EVERY OPTIMISATION HERE IS TESTED AS A PAIR. A cache that never recomputed would satisfy any
// call-count ceiling perfectly while freezing the pills and the destination at whatever the first
// draft said — so for each "it reuses" row below there is an "it recomputes when X really changed"
// row, and the second is the one that would catch a stale answer.
describe("scanMentions — one reading, shared", () => {
  const roster = mentionRoster([BLUEPRINT, KRAKEN]);

  it("agrees with findMentionSpans and mentionsIn", () => {
    const text = "@Kraken Auth ship it, and tell @Blueprint UI/UX too";
    const scan = scanMentions(text, roster);
    expect(scan.spans).toEqual(findMentionSpans(text, roster));
    expect(scan.mentions).toEqual(mentionsIn(text, roster));
  });

  // ── THE REUSE ────────────────────────────────────────────────────────────────────────────────
  // Asserted on the COUNTER, not on object identity: identity would also pass if the function
  // recomputed and happened to return a cached-looking value, and the counter is the thing the
  // typing cost is actually made of.
  it("does not re-scan when the same draft is read again against the same roster", () => {
    const text = "@Kraken Auth ship it";
    scanMentions(text, roster);
    const before = mentionScanStats.spans;
    scanMentions(text, roster);
    scanMentions(text, roster);
    scanMentions(text, roster);
    expect(mentionScanStats.spans).toBe(before);
  });

  // ── AND THE PAIRED HALF: IT MUST STILL RECOMPUTE ─────────────────────────────────────────────
  // A NEW CHARACTER. This is the case that runs on literally every keystroke, and a cache keyed
  // too loosely would leave the pills painting the previous draft.
  it("re-scans, and gives the NEW answer, when one character changes the text", () => {
    scanMentions("@Kraken Auth ship it", roster);
    const before = mentionScanStats.spans;
    // Deleting one character of the name un-resolves the mention — derive-from-text's fail-CLOSED
    // direction. A stale cache would keep drawing a pill over an address that no longer exists.
    const next = scanMentions("@Kraken Aut ship it", roster);
    expect(mentionScanStats.spans).toBe(before + 1);
    expect(next.mentions).toEqual([]);
    expect(next.spans).toEqual([]);
  });

  // A CHANGED FLEET. The agent left, so the aim must leave with it — the roster is a different
  // object and the answer for the SAME text is different.
  it("re-scans, and drops the mention, when the roster no longer holds that agent", () => {
    const text = "@Kraken Auth ship it";
    expect(scanMentions(text, roster).mentions).toEqual([{ agentId: "a2", name: "Kraken Auth" }]);
    const shrunk = mentionRoster([BLUEPRINT]);
    const after = scanMentions(text, shrunk);
    expect(after.mentions).toEqual([]);
  });

  // …and the other direction, which is the one a "roster changes are ignored" bug would show up in
  // first: an agent JOINS, and the text that named nobody a moment ago now addresses them.
  it("re-scans, and FINDS a new mention, when the roster grows", () => {
    const text = "@Kraken Auth ship it";
    expect(scanMentions(text, mentionRoster([BLUEPRINT])).mentions).toEqual([]);
    expect(scanMentions(text, mentionRoster([BLUEPRINT, KRAKEN])).mentions).toEqual([
      { agentId: "a2", name: "Kraken Auth" },
    ]);
  });

  // A RELABEL is a roster change that leaves the id list identical — two agents called "Docs" make
  // the address `@Docs (web)`, and a cache keyed on anything coarser than the roster object would
  // keep resolving a bare `@Docs` that must now match NOTHING.
  it("re-scans when a name collision changes what the address IS", () => {
    const web = agent({ id: "d1", name: "Docs", projectName: "web" });
    const mobile = agent({ id: "d2", name: "Docs", projectName: "mobile" });
    expect(scanMentions("@Docs ship it", mentionRoster([web])).mentions).toEqual([
      { agentId: "d1", name: "Docs" },
    ]);
    // Now ambiguous: the bare name addresses neither, and the qualified one addresses exactly one.
    expect(scanMentions("@Docs ship it", mentionRoster([web, mobile])).mentions).toEqual([]);
    expect(scanMentions("@Docs (web) ship it", mentionRoster([web, mobile])).mentions).toEqual([
      { agentId: "d1", name: "Docs (web)" },
    ]);
  });
});

// ══ ONE ROSTER OBJECT ═══════════════════════════════════════════════════════════════════════════
// The scan cache keys on the roster's IDENTITY, so two callers building "the same" roster from the
// same inputs had to stop producing two different arrays or the cache thrashes between them and
// nothing is shared. This is the property that makes the composer's reading and the host's reading
// of one draft a single computation.
describe("mentionRoster — the same inputs give back the same object", () => {
  it("returns the identical array for the same agents and preferred id", () => {
    const agents = [BLUEPRINT, KRAKEN];
    expect(mentionRoster(agents, "a1")).toBe(mentionRoster(agents, "a1"));
  });

  // PAIRED: it must not hand back a stale roster when the inputs genuinely differ, or the picker
  // orders by the wrong preference and — worse — a departed agent stays addressable.
  it("rebuilds when the preferred id changes", () => {
    const agents = [BLUEPRINT, KRAKEN];
    const first = mentionRoster(agents, "a1");
    const second = mentionRoster(agents, "a2");
    expect(second).not.toBe(first);
    // The preference is what it orders by, so the answer really did change.
    expect(second[0]!.id).toBe("a2");
    expect(first[0]!.id).toBe("a1");
  });

  it("rebuilds when the fleet changes", () => {
    const first = mentionRoster([BLUEPRINT, KRAKEN], null);
    const second = mentionRoster([BLUEPRINT], null);
    expect(second).not.toBe(first);
    expect(second.map((a) => a.id)).not.toContain("a2");
  });
});

// ══ THE SPANS THE COMPOSER HOLDS ARE THE SPANS A RE-MATCH WOULD FIND ════════════════════════════
// Two call sites stopped re-deriving positions they already had — `classifyComposerRoute` (which
// re-matched through `rosterFromMentions` to find the addressing span) and the composer's pill
// mirror (which round-tripped mentions back through `splitMentionText`). Both are only safe because
// scanning the LIVE roster and re-scanning the resolved mentions produce identical spans.
//
// "Obviously equivalent" is how a wrong-agent bug gets in, so these are the cases where it could
// plausibly diverge: a name that is a PREFIX of a sibling's, one agent named twice, and a
// disambiguated collision label.
describe("live-roster spans === re-matched spans", () => {
  const cases: [string, MentionAgent[], string][] = [
    ["a name that is a prefix of a sibling", [BLUEPRINT, agent({ id: "a3", name: "Blueprint UI" })], "@Blueprint UI/UX move it"],
    ["the shorter sibling on its own", [BLUEPRINT, agent({ id: "a3", name: "Blueprint UI" })], "@Blueprint UI move it"],
    ["one agent named twice", [KRAKEN], "@Kraken Auth ping @Kraken Auth again"],
    ["a mid-sentence name", [KRAKEN], "why is @Kraken Auth just sitting there?"],
    ["a sentence-final full stop", [KRAKEN], "please look at @Kraken Auth."],
    [
      "a disambiguated collision",
      [agent({ id: "d1", name: "Docs", projectName: "web" }), agent({ id: "d2", name: "Docs", projectName: "mobile" })],
      "@Docs (web) and @Docs (mobile) both",
    ],
    ["no mention at all", [KRAKEN], "just some words"],
  ];
  for (const [label, fleet, text] of cases) {
    it(`agrees for ${label}`, () => {
      const roster = mentionRoster(fleet);
      const live = scanMentions(text, roster);
      const rematched = findMentionSpans(text, rosterFromMentions(live.mentions));
      expect(rematched).toEqual(live.spans);
      // …and therefore the two splits agree, which is what the composer's mirror relies on.
      expect(splitAtMentionSpans(text, live.spans)).toEqual(splitMentionText(text, live.mentions));
      // …and so does the route, which is what `classifyComposerRoute`'s optional `spans` relies on.
      expect(
        classifyComposerRoute({ text, mentions: live.mentions, mountedAgentId: "m1", spans: live.spans }),
      ).toEqual(classifyComposerRoute({ text, mentions: live.mentions, mountedAgentId: "m1" }));
    });
  }
});

// ══ THE LENGTH ORDERING IS KEPT, NOT REBUILT ════════════════════════════════════════════════════
// `findMentionSpans` needs the roster longest-label-first and used to sort a fresh copy per call.
// The ordering depends on the ROSTER, which changes a few times a minute; the scan it feeds used to
// run on every character. `mentionScanStats.rosterSorts` is what makes the difference assertable,
// and these are its assertions — without them the memo could be deleted and every other row here
// would stay green, because `scanMentions`'s own cache absorbs the repeat calls.
describe("longestLabelFirst — the roster is ordered once per roster", () => {
  it("does not re-sort when the same roster object is scanned again", () => {
    const roster = mentionRoster([BLUEPRINT, KRAKEN]);
    // Distinct texts, so the SCAN cache cannot be what absorbs these — each call really does run
    // the matcher, and the question is only whether it re-orders the roster to do it.
    findMentionSpans("@Kraken Auth a", roster);
    const before = mentionScanStats.rosterSorts;
    findMentionSpans("@Kraken Auth b", roster);
    findMentionSpans("@Kraken Auth c", roster);
    findMentionSpans("@Kraken Auth d", roster);
    expect(mentionScanStats.rosterSorts).toBe(before);
  });

  // ── THE PAIRED HALF, AND IT ASSERTS THE ORDER ACTUALLY MOVED ─────────────────────────────────
  // A memo keyed on anything that survives a roster swap — a length, a count, a stale flag — would
  // pass the row above and then match against the OLD fleet forever. So this asserts both that the
  // sort re-ran and that its RESULT is the new fleet's ordering: "Blueprint UI" alone claims
  // `@Blueprint UI`, and once the longer "Blueprint UI/UX" joins, the longer label must win the
  // same text. That is exactly what longest-first buys, so a stale ordering shows up as a
  // wrong-agent aim rather than as a timing difference.
  it("re-sorts for a new roster, and the LONGER label then wins", () => {
    const short = agent({ id: "b1", name: "Blueprint UI" });
    const long = agent({ id: "b2", name: "Blueprint UI/UX" });
    const onlyShort = mentionRoster([short]);
    const before = mentionScanStats.rosterSorts;
    expect(findMentionSpans("@Blueprint UI move it", onlyShort)[0]?.agentId).toBe("b1");
    expect(mentionScanStats.rosterSorts).toBe(before + 1);

    const both = mentionRoster([short, long]);
    const spans = findMentionSpans("@Blueprint UI/UX move it", both);
    expect(mentionScanStats.rosterSorts).toBe(before + 2);
    // The new fleet's ordering, not the old one's: the longer name claims the span.
    expect(spans[0]?.agentId).toBe("b2");
    expect(spans[0]?.name).toBe("Blueprint UI/UX");
  });
});

// ══ THE SHARED ARRAYS CANNOT BE MUTATED BY A CONSUMER ═══════════════════════════════════════════
// One roster object and one scan result are handed to several consumers at once, so "nothing
// mutates them" had to stop being a comment. A `.sort()` in any consumer would reorder what the
// others read — and roster order is what used to decide which terminal a duplicate name resolved
// to — while a push into the cached mentions would rewrite what an ALREADY-SENT message says it
// was addressed to. Frozen, that throws where it is written instead.
describe("the shared readings are frozen", () => {
  it("refuses an in-place sort of the shared roster", () => {
    const roster = mentionRoster([BLUEPRINT, KRAKEN]);
    expect(() => roster.sort()).toThrow();
  });

  it("refuses a push into the cached scan", () => {
    const scan = scanMentions("@Kraken Auth ship it", mentionRoster([BLUEPRINT, KRAKEN]));
    expect(() => (scan.mentions as ConciergeMention[]).push({ agentId: "x", name: "X" })).toThrow();
    expect(() => (scan.spans as MentionSpan[]).pop()).toThrow();
  });

  // …but `mentionsIn` hands out an array the CALLER owns, because that one escapes into a sent
  // message's stored state and history must not change when the next keystroke evicts a cache.
  it("gives mentionsIn's caller its own array", () => {
    const roster = mentionRoster([BLUEPRINT, KRAKEN]);
    const text = "@Kraken Auth ship it";
    const mine = mentionsIn(text, roster);
    expect(mine).not.toBe(scanMentions(text, roster).mentions);
    expect(() => mine.push({ agentId: "x", name: "X" })).not.toThrow();
    // …and mutating it did not reach the cache.
    expect(scanMentions(text, roster).mentions).toEqual([{ agentId: "a2", name: "Kraken Auth" }]);
  });
});

// ══ A HANDED-IN `spans` THAT DOES NOT FIT THE TEXT IS IGNORED ═══════════════════════════════════
// `classifyComposerRoute`'s optional `spans` is a second representation of what `mentions` already
// implies, and a redundant input that is TRUSTED is how two facts come to disagree. The
// disagreement has one shape and it is the unrecoverable one: a span captured a render earlier is
// an offset into the OLD text, so the route resolves to an agent the CURRENT draft does not
// address and the words are written into that agent's PTY.
//
// The guard falls back to the authoritative re-match, so a caller handing over something wrong can
// only make the answer slower, never different.
describe("classifyComposerRoute ignores spans that do not describe the text", () => {
  const roster = mentionRoster([BLUEPRINT, KRAKEN]);

  it("REGRESSION: a stale span does not aim the message at the agent it used to name", () => {
    const oldText = "@Kraken Auth ship the DMG";
    const stale = scanMentions(oldText, roster).spans;
    // The user deleted the address and typed something else. Under a mount, the correct verdict is
    // the MOUNT — and trusting `stale` would instead hand the words to Kraken Auth.
    const now = "actually never mind, let us wait";
    const route = classifyComposerRoute({
      text: now,
      mentions: mentionsIn(now, roster),
      spans: stale,
      mountedAgentId: "mounted-1",
    });
    expect(route).toEqual({ kind: "agent", agentId: "mounted-1", via: "mount" });
  });

  // The other direction, and the one a "spans[0] exists?" guard would wave straight through: a
  // stale EMPTY array over a draft that DOES open with `@Sparkle`. Trusting it finds no address, so
  // the message follows the mount — swallowing the one send whose entire purpose is escaping a
  // mount.
  it("REGRESSION: a stale EMPTY spans array does not swallow the @Sparkle escape hatch", () => {
    const plain = "move the button 5px left";
    const staleEmpty = scanMentions(plain, roster).spans;
    expect(staleEmpty).toEqual([]);
    const now = "@Sparkle what is the status of the build?";
    const route = classifyComposerRoute({
      text: now,
      mentions: mentionsIn(now, roster),
      spans: staleEmpty,
      mountedAgentId: "mounted-1",
    });
    expect(route).toEqual({ kind: "sparkle", via: "address" });
  });

  // PAIRED: the fast path is still a fast path. Spans that DO describe the text are used, and give
  // the same verdict the re-match would — otherwise the guard would have quietly disabled the
  // optimisation it exists to make safe.
  it("uses spans that do fit, and agrees with the re-match", () => {
    const text = "@Kraken Auth ship the DMG";
    const { spans, mentions } = scanMentions(text, roster);
    const withSpans = classifyComposerRoute({ text, mentions, spans, mountedAgentId: "mounted-1" });
    const without = classifyComposerRoute({ text, mentions, mountedAgentId: "mounted-1" });
    expect(withSpans).toEqual({ kind: "agent", agentId: "a2", via: "address" });
    expect(withSpans).toEqual(without);
  });
});

describe("isComposingMention — what the auto-send countdown pauses on (sparkle-14dtu)", () => {
  // "It doesn't pause until I finish typing the name of the agent, and it often sends before I'm
  // done." So the question this answers is not "which agent is meant" — it is "is the user still
  // writing an address", and it has to be answerable one character in.
  const composing = (text: string, caret = text.length) =>
    isComposingMention(mentionQuery(text, caret), FLEET);

  it("is TRUE for a bare @ with nothing after it", () => {
    // The row the fix exists for. Nothing has resolved and nothing can — that is the point.
    expect(composing("@")).toBe(true);
  });

  it("is true through every partial spelling, matching or not", () => {
    for (const q of ["@K", "@Kraken", "@Kraken ", "@Kraken Aut", "@zzz"]) {
      expect(composing(q), q).toBe(true);
    }
  });

  it("is FALSE once the address is finished — the name plus its trailing space", () => {
    expect(composing("@Kraken Auth ")).toBe(false);
  });

  it("is false with no @ at all, and false for an email", () => {
    expect(composing("deploy the staging branch")).toBe(false);
    expect(composing("mail me at drodio@example.com")).toBe(false);
  });

  it("depends on the CARET, which is why the host cannot derive it from the text", () => {
    expect(composing("@Krak ship it", 5)).toBe(true); // caret inside the query
    expect(composing("@Krak ship it", 0)).toBe(false); // caret before the sigil
  });

  it("gives up past MAX_MENTION_QUERY, so an abandoned @ cannot pause forever", () => {
    expect(composing("@" + "x".repeat(MAX_MENTION_QUERY + 1))).toBe(false);
  });
});
