// THE MOUNTED-COMPOSER ROUTING RULE, AND ITS @Sparkle ESCAPE HATCH.
//
// The founder's sentence, which is what every row below is checking one clause of: *"when the
// concierge is mounted to a build agent, what I type goes to THAT AGENT'S TERMINAL — unless I
// @-mention Sparkle, in which case it goes to the concierge instead."*
//
// ══ HOW THESE ROWS AVOID BEING VACUOUS ══════════════════════════════════════════════════════════
// The #1 fleet-wide finding is an assertion that was already true before the change, and this module
// is unusually easy to write those against: "unmounted plain text goes to Sparkle" holds for a
// function that returns `sparkle` unconditionally, and "a leading @Sparkle goes to Sparkle" holds for
// one that ignores mentions entirely. So every claim here is stated as a PAIR that a degenerate
// implementation cannot satisfy at once — the same text mounted and unmounted, or the same name
// leading and mid-sentence. Where a row stands alone, its comment says which prior behaviour it fails
// against.
import { describe, expect, it } from "vitest";

import { addressingSpan, carriesSigil, classifyComposerRoute } from "./composerRoute";
import {
  SPARKLE_MENTION_ID,
  SPARKLE_MENTION_NAME,
  beadMentionId,
  mentionFreeText,
  rosterFromMentions,
} from "./mentions";
import type { ConciergeMention } from "./mentions";

const KRAKEN: ConciergeMention = { agentId: "ag2", name: "Kraken Auth" };
const BLUEPRINT: ConciergeMention = { agentId: "ag1", name: "Blueprint UI/UX" };
const SPARKLE: ConciergeMention = { agentId: SPARKLE_MENTION_ID, name: SPARKLE_MENTION_NAME };

/** The agent the cable is patched to throughout. Distinct from every mentionable id above, so a
 *  verdict naming it can never be confused with a verdict that honoured an address. */
const MOUNT = "mounted-agent";

const route = (text: string, mentions: ConciergeMention[], mountedAgentId: string | null) =>
  classifyComposerRoute({ text, mentions, mountedAgentId });

describe("classifyComposerRoute — clause 1: while MOUNTED, plain text goes to the terminal", () => {
  // THE PAIR IS THE TEST. Before this rule existed the mounted case ALSO resolved to Sparkle (the
  // router's absolute rule means an unaddressed message could never reach an agent), so the second
  // expectation alone would have been green against the unbuilt feature. Asserting both halves of the
  // same text pins the thing that actually changed: the MOUNT is what decides.
  it("routes to the mounted agent, and to Sparkle without a mount", () => {
    expect(route("move the button 5px left", [], MOUNT)).toEqual({
      kind: "agent",
      agentId: MOUNT,
      via: "mount",
    });
    expect(route("move the button 5px left", [], null)).toEqual({
      kind: "sparkle",
      via: "default",
    });
  });

  it("does not need the text to mention anybody, or to look like anything in particular", () => {
    for (const text of ["yes", "ship it", "why?", "run the tests again and tell me what breaks"]) {
      expect(route(text, [], MOUNT)).toMatchObject({ kind: "agent", agentId: MOUNT });
    }
  });
});

describe("classifyComposerRoute — clause 2: @Sparkle is the escape hatch", () => {
  // THE HEADLINE ROW. A leading @Sparkle has to beat the mount, or there is no way to reach the
  // concierge at all while patched to an agent — every word typed in that box would go to a PTY.
  it("beats the mount and sends the message to the concierge instead", () => {
    expect(route("@Sparkle what is the status of the build?", [SPARKLE], MOUNT)).toEqual({
      kind: "sparkle",
      via: "address",
    });
    // The control: the SAME mount, one word different, goes to the terminal. Without this the row
    // above passes against an implementation that never routes to a mount at all.
    expect(route("what is the status of the build?", [], MOUNT)).toMatchObject({
      kind: "agent",
      agentId: MOUNT,
    });
  });

  it("is an address even when it is the whole message", () => {
    expect(route("@Sparkle", [SPARKLE], MOUNT)).toEqual({ kind: "sparkle", via: "address" });
  });

  // Leading is POSITIONAL, not "first character": dictation inserts the pill into a box the user may
  // have already put a space or a newline in, and `insertMention` itself leaves a trailing space.
  it("still leads through whitespace and newlines before it", () => {
    expect(route("  \n @Sparkle what is up", [SPARKLE], MOUNT)).toMatchObject({ kind: "sparkle" });
  });

  // ══ THE DISTINCTION THE FOUNDER NAMED, AND THE ONE THERE IS PRECEDENT FOR GETTING WRONG ═══════
  // This app is CALLED Sparkle, so its own name turns up in ordinary instructions to an agent. Under
  // the ordinal rule this message resolved to `mentions[0]` and would have been yanked out of the
  // terminal it was plainly written for, silently dropping the instruction. The pair is the proof:
  // move the same name to the front and it becomes a redirect.
  it("is NOT a redirect mid-sentence — there it is the sentence's subject", () => {
    const said = "land this first and then ask Sparkle to look at the diff";
    expect(route(`land this first and then ask @${SPARKLE_MENTION_NAME} to look at the diff`, [SPARKLE], MOUNT)).toEqual({
      kind: "agent",
      agentId: MOUNT,
      via: "mount",
    });
    expect(route(`@${SPARKLE_MENTION_NAME} ${said}`, [SPARKLE], MOUNT)).toEqual({
      kind: "sparkle",
      via: "address",
    });
  });

  // The sigil is what must never reach a Claude Code CLI (a leading `@` opens its file-reference
  // autocomplete). A subject mention keeps its NAME — the user wrote it because the instruction
  // depends on it — and loses only the sigil, so the terminal-bound wire is clean and complete.
  it("leaves a subject mention's name in the wire, minus the sigil", () => {
    const text = "land this and then ask @Sparkle to look at the diff";
    const wire = mentionFreeText(text, rosterFromMentions([SPARKLE]));
    expect(wire).toBe("land this and then ask Sparkle to look at the diff");
    expect(carriesSigil(wire)).toBe(false);
  });
});

describe("classifyComposerRoute — clause 3: @OtherAgent addresses without re-mounting", () => {
  it("routes to the named agent, not to the mount", () => {
    expect(route("@Kraken Auth ship the DMG", [KRAKEN], MOUNT)).toEqual({
      kind: "agent",
      agentId: "ag2",
      via: "address",
    });
  });

  // MENTIONING IS NOT RE-MOUNTING. This module cannot move the mount — it returns a verdict and
  // writes nothing — and the row states it as an observable fact rather than a claim about the code:
  // the NEXT message, with no address, still follows the same mount it did before.
  it("leaves the mount where it was for the following message", () => {
    const input = { text: "@Kraken Auth ship the DMG", mentions: [KRAKEN], mountedAgentId: MOUNT };
    classifyComposerRoute(input);
    expect(input.mountedAgentId).toBe(MOUNT);
    expect(route("and now run the tests", [], input.mountedAgentId)).toMatchObject({
      kind: "agent",
      agentId: MOUNT,
      via: "mount",
    });
  });

  // One destination per message. Fanning an irreversible write across every name in a sentence is not
  // something to do behind a comma — the other names are still drawn as pills in the bubble.
  it("takes the leading name only when several are addressed", () => {
    expect(route("@Kraken Auth and @Blueprint UI/UX both ship", [KRAKEN, BLUEPRINT], null)).toEqual({
      kind: "agent",
      agentId: "ag2",
      via: "address",
    });
  });

  // ══ CLOSES THE OPEN HALF OF 898cea330 (bead sparkle-3dbp6) ════════════════════════════════════
  // That commit fixed the TEXT — a mid-sentence mention keeps its name — while routing still read
  // `mentions[0]` by ordinal, so this exact sentence was dispatched INTO Kraken Auth's terminal as a
  // third-person question about itself, and the concierge it was plainly for never saw it. The pair
  // pins the fix without pinning "mentions are ignored": move the name to the front and it routes.
  it("treats a mid-sentence name as a subject, so an unmounted question reaches the concierge", () => {
    expect(route("Why is @Kraken Auth just sitting there?", [KRAKEN], null)).toEqual({
      kind: "sparkle",
      via: "default",
    });
    expect(route("@Kraken Auth why are you just sitting there?", [KRAKEN], null)).toEqual({
      kind: "agent",
      agentId: "ag2",
      via: "address",
    });
  });

  // Under a mount the same subject mention follows the cable rather than the name — which is the
  // whole point: the founder is talking to the agent they are patched into, ABOUT another one.
  it("sends a subject mention's message to the mount, not to the named agent", () => {
    expect(route("check what @Kraken Auth did before you land", [KRAKEN], MOUNT)).toEqual({
      kind: "agent",
      agentId: MOUNT,
      via: "mount",
    });
  });
});

describe("classifyComposerRoute — clause 4: unmounted, everything reaches the concierge", () => {
  it("routes plain text to Sparkle, exactly as before mounts routed anywhere", () => {
    expect(route("what should I do next", [], null)).toEqual({ kind: "sparkle", via: "default" });
  });

  // Same destination as clause 2, DIFFERENT `via` — and the difference is load-bearing downstream:
  // `via: "address"` is what skips the router call, so collapsing the two would start billing a
  // classify on a destination the user stated in words.
  it("records an unmounted @Sparkle as an ADDRESS, not as the default", () => {
    expect(route("@Sparkle what is up", [SPARKLE], null)).toEqual({
      kind: "sparkle",
      via: "address",
    });
    expect(route("what is up", [], null)).toEqual({ kind: "sparkle", via: "default" });
  });

  // A name that matches nobody never becomes a mention at all, so it stays prose. Stated here because
  // the fail-CLOSED direction is the reason `mentions` is the input rather than the raw text.
  it("has no address when the composer resolved no mentions", () => {
    expect(route("@Nobody At All ship it", [], null)).toEqual({ kind: "sparkle", via: "default" });
    expect(route("@Nobody At All ship it", [], MOUNT)).toMatchObject({ kind: "agent", agentId: MOUNT });
  });
});

describe("addressingSpan", () => {
  it("finds the leading span and reports where it sits", () => {
    const span = addressingSpan("@Kraken Auth ship it", [KRAKEN]);
    expect(span).toMatchObject({ agentId: "ag2", start: 0, end: "@Kraken Auth".length });
  });

  it("is null for a name that does not lead, however early it appears", () => {
    expect(addressingSpan("ok @Kraken Auth ship it", [KRAKEN])).toBeNull();
  });

  // The span it returns is exactly the span `mentionFreeText` consumes — that agreement is the whole
  // reason both go through `isAddressingPosition`. A drift here means the message that chose a
  // terminal arrives with a different piece of itself removed.
  it("names the same span mentionFreeText removes", () => {
    const text = "@Kraken Auth ship the DMG";
    const span = addressingSpan(text, [KRAKEN])!;
    expect(mentionFreeText(text, rosterFromMentions([KRAKEN]))).toBe(text.slice(span.end).trim());
  });
});

// ══ CLAUSE 5: A BEAD IS A REFERENT, NEVER A DESTINATION (bead sparkle-1cpomd) ═══════════════════
//
// An @mention is an ADDRESS, and an address writes into a live PTY. Beads joined the roster so the
// founder can name a task or an epic the way he names an agent — and the whole risk of that is the
// `agent` arm below being the DEFAULT arm: anything that is not the concierge sentinel lands in it.
//
// EVERY ROW HERE IS A PAIR, and the pairing is what stops it being vacuous. "A bead does not route"
// is trivially true of an implementation that never routes anything, so each row asserts the SAME
// text with the SAME shape of mention, once naming an AGENT and once naming a BEAD, and the two
// verdicts must differ. A `classifyComposerRoute` that ignored the bead prefix would satisfy the
// agent half and fail the bead half; one that refused every address would do the reverse.
describe("classifyComposerRoute — clause 5: a bead is a subject, in every position", () => {
  const BEAD: ConciergeMention = {
    agentId: beadMentionId("sparkle-1cpomd"),
    name: "Chat button on every bead card",
  };
  /** The same words, opening with a name, differing only in WHAT the name refers to. */
  const LEADING = (who: ConciergeMention) => `@${who.name} can you pick this up?`;

  // THE ONE THAT MATTERS. Under a mount, a leading AGENT name overrules the cable (clause 3) — so if
  // a bead were read the same way, naming a task while patched to a terminal would silently divert
  // the founder's message to the concierge with no receipt. The mount must survive a bead.
  it("does not escape a mount, where a leading AGENT name does", () => {
    expect(route(LEADING(KRAKEN), [KRAKEN], MOUNT)).toEqual({
      kind: "agent",
      agentId: KRAKEN.agentId,
      via: "address",
    });
    expect(route(LEADING(BEAD), [BEAD], MOUNT)).toEqual({
      kind: "agent",
      agentId: MOUNT,
      via: "mount",
    });
  });

  // The unmounted half of the same pair. A bead falls all the way through to the default, which is
  // also what ComposeBox reads to decide whether to paint its terminal face: `kind: "agent"` here
  // would tell the founder his words are going to a PTY when they are going to the concierge.
  it("falls through to the concierge with no mount, where a leading AGENT name would not", () => {
    expect(route(LEADING(KRAKEN), [KRAKEN], null)).toEqual({
      kind: "agent",
      agentId: KRAKEN.agentId,
      via: "address",
    });
    expect(route(LEADING(BEAD), [BEAD], null)).toEqual({ kind: "sparkle", via: "default" });
  });

  // `addressingSpan` is the shared predicate, so pin it directly too — this is the function
  // `mentionFreeText` consults to decide what to DELETE, and the two must agree.
  it("is never an addressing span, where the same span naming an agent is", () => {
    expect(addressingSpan(LEADING(KRAKEN), [KRAKEN])).toMatchObject({ agentId: KRAKEN.agentId });
    expect(addressingSpan(LEADING(BEAD), [BEAD])).toBeNull();
  });

  // THE CONSEQUENCE THE FOUNDER WOULD ACTUALLY SEE. A consumed address is deleted from the wire, so
  // reading a bead as one removes the subject of his sentence — the corruption 898cea330 closed for
  // agents, reintroduced for beads. The agent half of the pair shows the deletion still happens
  // where it should, so this cannot pass by disabling the strip.
  it("keeps its title on the wire — with its id — while a leading agent address is still removed", () => {
    expect(mentionFreeText(LEADING(KRAKEN), rosterFromMentions([KRAKEN]))).toBe(
      "can you pick this up?",
    );
    expect(mentionFreeText(LEADING(BEAD), rosterFromMentions([BEAD]))).toBe(
      "Chat button on every bead card (sparkle-1cpomd) can you pick this up?",
    );
  });

  // The founder's own template. `RE: ` in front means the bead was never in addressing position to
  // begin with — but the row exists because that is the message the Chat button writes, and it must
  // reach the concierge with the reference intact and no sigil on it.
  it("carries the Chat button's own draft to the concierge with the reference intact", () => {
    const text = `RE: @${BEAD.name} what is left here?`;
    expect(route(text, [BEAD], null)).toEqual({ kind: "sparkle", via: "default" });
    const wire = mentionFreeText(text, rosterFromMentions([BEAD]));
    expect(wire).toBe("RE: Chat button on every bead card (sparkle-1cpomd) what is left here?");
    expect(carriesSigil(wire)).toBe(false);
  });
});
