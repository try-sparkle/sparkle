import { describe, expect, it } from "vitest";
import { parseMentionTokens } from "./parseMentionTokens";
import {
  ROUTER_MARKER,
  buildDoorbell,
  buildUndeliveredComment,
  buildUnresolvedComment,
  isRouterAuthored,
} from "./mentionMessages";

describe("the doorbell", () => {
  it("carries NO router marker — it is an inbox message, not a bead comment", () => {
    // Stamping it bought nothing (inbox messages are never scanned for mentions) while making the
    // doorbell's own wording — which tells the agent to "reply on the bead" — a phrase that, if
    // quoted back onto the bead, could silence the comment quoting it.
    expect(buildDoorbell("x", "sparkle-1")).not.toContain(ROUTER_MARKER);
  });

  it("names the sender and the bead", () => {
    const d = buildDoorbell("Improve Sparkle", "sparkle-jb809e");
    expect(d).toContain("Improve Sparkle");
    expect(d).toContain("sparkle-jb809e");
  });

  it("carries no body — the bead is the message", () => {
    // Pinned as its own test because a future edit that "helpfully" inlines the comment text would
    // otherwise pass everything else: the agent would act on a private copy of a comment that may
    // since have been superseded, and the founder-visible record would diverge from what ran.
    const body = "SUPERSEDED PLAN DETAILS THAT MUST NOT RIDE ALONG";
    expect(buildDoorbell("x", "sparkle-1")).not.toContain(body);
  });

  it("is not phrased as an instruction from the human", () => {
    expect(buildDoorbell("x", "sparkle-1")).toContain("not an instruction");
  });
});

describe("the refusal-loop guard", () => {
  it("does NOT swallow a human comment that merely QUOTES a refusal", () => {
    // A substring test drops the WHOLE comment on a marker hit. Our own refusal ends with "re-comment
    // naming an agent id", so quote-and-correct is the natural reply — and under a substring test
    // that reply is skipped entirely, mentions included: a mention reaching nobody with no report at
    // all, which is strictly worse than the loop the guard exists to prevent.
    const quoted = `> ${ROUTER_MARKER} NOT DELIVERED — "ghost" matches no agent\n\nright, @improve then`;
    expect(isRouterAuthored(quoted)).toBe(false);
    expect(parseMentionTokens(quoted, [])).toEqual([{ token: "improve", matchedKnownName: false }]);
  });

  it("still recognises our own comments, which always LEAD with the marker", () => {
    const own = buildUnresolvedComment("b", [{ token: "ghost", reason: "unknown" }])!;
    expect(isRouterAuthored(own)).toBe(true);
    expect(isRouterAuthored(`   \n${own}`)).toBe(true);
  });

  it("every comment we write LEADS with the marker — do not prepend to it", () => {
    // The anchoring contract, pinned. `isRouterAuthored` is anchored, so a future build that
    // prefixes a timestamp or an author tag to these comments would silently disarm guard 1 and
    // re-open the refusal loop. That edit must fail HERE rather than in production.
    expect(buildUnresolvedComment("b", [{ token: "ghost", reason: "unknown" }])!)
      .toMatch(new RegExp(`^${ROUTER_MARKER.replace(/[[\]]/g, "\\$&")}`));
    expect(buildUndeliveredComment("A", "b", "pending", 200_000).startsWith(ROUTER_MARKER)).toBe(true);
  });

  it("marks every comment this module writes", () => {
    expect(isRouterAuthored(buildUnresolvedComment("b", [{ token: "ghost", reason: "unknown" }])!))
      .toBe(true);
    expect(isRouterAuthored(buildUndeliveredComment("A", "b", "pending", 200_000))).toBe(true);
    expect(isRouterAuthored("an ordinary human comment")).toBe(false);
  });

  it("GUARD 2: a refusal naming a dead handle yields no parseable mention", () => {
    // THE LOOP THIS PREVENTS: our refusal names the handle it could not resolve. If that text still
    // parsed as a mention, the next tick would refuse it again, and again, forever, on a shared
    // store. Asserted by running the REAL parser over the REAL refusal text — not by checking for an
    // "@", which would pass against a builder that emitted one somewhere harmless.
    const text = buildUnresolvedComment("sparkle-1", [
      { token: "@ghost", reason: "unknown" },
      { token: "@twin", reason: "ambiguous", ids: ["a", "b"] },
    ])!;
    expect(parseMentionTokens(text, ["ghost", "twin"])).toEqual([]);
    // BOTH halves are required, and the second is not decoration. "Yields no mention" is satisfied
    // just as well by a builder that dropped the handle entirely — which would be a refusal that
    // does not say WHICH handle failed, i.e. useless to the writer it exists for. The report has to
    // stay legible AND unparseable, so assert it still names them.
    expect(text).toContain("ghost");
    expect(text).toContain("twin");
  });

  it("GUARD 2 holds for the undelivered report too", () => {
    const text = buildUndeliveredComment("@Backstop Agent", "sparkle-1", "pending", 200_000);
    expect(parseMentionTokens(text, ["Backstop Agent"])).toEqual([]);
  });
});

describe("the unresolved report", () => {
  it("is null when nothing failed, so an empty comment cannot be posted", () => {
    expect(buildUnresolvedComment("sparkle-1", [])).toBeNull();
  });

  it("names the colliding ids for an ambiguous handle", () => {
    const t = buildUnresolvedComment("sparkle-1", [
      { token: "Twin", reason: "ambiguous", ids: ["agent-a", "agent-b"] },
    ])!;
    expect(t).toContain("agent-a");
    expect(t).toContain("agent-b");
    expect(t).toContain("2 agents");
  });

  it("says NOT DELIVERED, not something a reader could mistake for success", () => {
    const t = buildUnresolvedComment("sparkle-1", [{ token: "ghost", reason: "unknown" }])!;
    expect(t).toContain("NOT DELIVERED");
    expect(t).toContain(ROUTER_MARKER);
  });
});

describe("the undelivered report", () => {
  it("states the queue's own word for where the message got to", () => {
    const t = buildUndeliveredComment("Backstop Agent", "sparkle-1", "pending", 3 * 60 * 1000);
    expect(t).toContain("UNDELIVERED");
    expect(t).toContain("pending");
    expect(t).toContain("3m");
  });

  it("says explicitly that silence is not agreement", () => {
    // The 2026-08-14 lesson in one assertion: an unacknowledged message must never read as assent.
    const t = buildUndeliveredComment("A", "sparkle-1", "pending", 200_000);
    expect(t).toContain("not as agreement");
  });

  it("never rounds a real wait down to zero minutes", () => {
    expect(buildUndeliveredComment("A", "b", "pending", 1000)).toContain("1m");
  });
});
