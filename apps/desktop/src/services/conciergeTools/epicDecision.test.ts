// The epic-decision PARSER. Pure, so every case here is the behaviour itself rather than a proxy
// for it — see board.epicGate.test.ts for what the domain does with each verdict.
import { describe, it, expect } from "vitest";
import {
  EPIC_DECISION_MARKER,
  formatEpicDecisionComment,
  parseEpicDecision,
} from "./epicDecision";

describe("parseEpicDecision", () => {
  it("reads `none`, whatever its case, as the first-class answer it is", () => {
    expect(parseEpicDecision("none")).toEqual({ kind: "none" });
    expect(parseEpicDecision("  NONE ")).toEqual({ kind: "none" });
  });

  it("reads a bd id, dotted or flat", () => {
    expect(parseEpicDecision("sparkle-xelans")).toEqual({
      kind: "existing",
      epicId: "sparkle-xelans",
    });
    expect(parseEpicDecision(" sparkle-131ms.2.1 ")).toEqual({
      kind: "existing",
      epicId: "sparkle-131ms.2.1",
    });
  });

  // Case is NOT folded on an id: bd matches ids literally, so lowercasing would invent one.
  it("preserves an id's case", () => {
    expect(parseEpicDecision("Sparkle-AbC")).toEqual({ kind: "existing", epicId: "Sparkle-AbC" });
  });

  it("reads `new:<title>`, tolerating spacing and case", () => {
    expect(parseEpicDecision("new:Concierge epic hygiene")).toEqual({
      kind: "new",
      title: "Concierge epic hygiene",
    });
    expect(parseEpicDecision("NEW : Concierge epic hygiene ")).toEqual({
      kind: "new",
      title: "Concierge epic hygiene",
    });
  });

  // THE CASES THAT MUST NOT PARSE. Each of these is a way the gate could be answered by accident,
  // and each would produce a WRONG parent or a silent default rather than a refusal that teaches.
  it.each([
    [undefined, "omitted entirely"],
    [null, "explicitly null"],
    ["", "blank"],
    ["   ", "whitespace"],
    ["no epic needed", "prose that means none"],
    ["the concierge one", "prose that means an epic"],
    ["new:", "a `new:` with no title"],
    ["new:   ", "a `new:` with a blank title"],
    ["sparkle board", "an id with a space in it"],
    ["nope", "a word that is not `none`"],
  ] as [string | null | undefined, string][])("refuses %j — %s", (raw) => {
    expect(parseEpicDecision(raw)).toBeNull();
  });

  // Not a string at all — the argument crosses from untyped model JSON, so a number or an object
  // must be a refusal rather than a crash.
  it("refuses a non-string", () => {
    expect(parseEpicDecision(42 as unknown as string)).toBeNull();
    expect(parseEpicDecision({} as unknown as string)).toBeNull();
  });
});

describe("formatEpicDecisionComment", () => {
  it("marks every recorded decision so one grep finds them all", () => {
    const line = formatEpicDecisionComment({
      decision: { kind: "none" },
      epicId: null,
      epicCreated: false,
      reason: "  a standalone chore  ",
    });
    expect(line).toBe(`${EPIC_DECISION_MARKER}: no epic — a standalone chore`);
  });

  it("names the existing epic it filed under", () => {
    expect(
      formatEpicDecisionComment({
        decision: { kind: "existing", epicId: "sparkle-board" },
        epicId: "sparkle-board",
        epicCreated: false,
        reason: "the drag half",
      }),
    ).toBe(`${EPIC_DECISION_MARKER}: existing epic sparkle-board — the drag half`);
  });

  it("names both the id and the title of an epic it minted", () => {
    expect(
      formatEpicDecisionComment({
        decision: { kind: "new", title: "Concierge epic hygiene" },
        epicId: "sparkle-fresh",
        epicCreated: true,
        reason: "opens the effort",
      }),
    ).toBe(`${EPIC_DECISION_MARKER}: new epic sparkle-fresh ("Concierge epic hygiene") — opens the effort`);
  });
});
