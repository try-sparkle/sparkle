import { describe, expect, it } from "vitest";
import { parseMentionTokens } from "./parseMentionTokens";

const tokens = (text: string, names: string[] = []) =>
  parseMentionTokens(text, names).map((t) => t.token);

describe("parseMentionTokens", () => {
  it("finds a bare handle", () => {
    expect(tokens("hey @improve look at this")).toEqual(["improve"]);
  });

  it("keeps an unknown handle rather than dropping it", () => {
    // The whole reason this does not reuse `mention.rs::parse_mentions`: that one silently discards
    // anything it cannot resolve, which makes an unroutable mention indistinguishable from no
    // mention at all. An unknown token must survive so it can be REPORTED.
    expect(tokens("@who-is-this ping")).toEqual(["who-is-this"]);
  });

  it("captures a uuid agent id, dashes included", () => {
    expect(tokens("@3cdd5adc-ef60-4b66-bc41-b2079b0a8613 hi")).toEqual([
      "3cdd5adc-ef60-4b66-bc41-b2079b0a8613",
    ]);
  });

  it("matches a MULTI-WORD display name when it is known", () => {
    // A word-run scan yields "Backstop" and the agent is unaddressable. This is the case that makes
    // most of the fleet reachable at all.
    expect(tokens("@Backstop Agent stand down", ["Backstop Agent"])).toEqual(["Backstop Agent"]);
  });

  it("prefers the LONGEST known name so a prefix cannot shadow it", () => {
    expect(tokens("@Bead Mention Doorbell go", ["Bead Mention", "Bead Mention Doorbell"])).toEqual([
      "Bead Mention Doorbell",
    ]);
  });

  it("falls back to the word run when no known name matches", () => {
    expect(tokens("@Backstop Agent hi", ["Someone Else"])).toEqual(["Backstop"]);
  });

  it("does not fold case — matching mirrors the resolver exactly", () => {
    // If this folded case it would hand the resolver a token the resolver then refuses, turning a
    // working mention into an unknown-handle report for an invisible reason.
    expect(tokens("@backstop agent hi", ["Backstop Agent"])).toEqual(["backstop"]);
  });

  it("de-duplicates, preserving first-seen order", () => {
    expect(tokens("@a then @b then @a again")).toEqual(["a", "b"]);
  });

  describe("boundaries — the difference between noise and a MIS-DELIVERY", () => {
    it("a known name may not win as the PREFIX of a longer word", () => {
      // The sharp one. With an agent named `Ship`, an unbounded dictionary match turns `@Shipyard`
      // into `Ship` — which resolves cleanly and wakes an agent nobody mentioned. The word-run
      // fallback produces `Shipyard`, which is unknown and gets REPORTED. So the bug is not noise:
      // it silently converts a reportable miss into a delivery to the wrong agent.
      expect(tokens("@Shipyard now", ["Ship"])).toEqual(["Shipyard"]);
    });

    it("an @ embedded in a word is not a mention — an email address names nobody", () => {
      expect(tokens("ask daniel@danielodio.com about it")).toEqual([]);
      expect(tokens("a@b")).toEqual([]);
    });

    it("a package scope in quoted shell is not a mention", () => {
      // Bead comments here routinely quote pnpm invocations. Without this, every one of them posts a
      // NOT DELIVERED comment onto a founder-visible bead — and would deliver a real doorbell if a
      // live agent happened to be named `sparkle`.
      expect(tokens("run `pnpm --filter @sparkle/desktop test`", ["sparkle"])).toEqual([]);
    });

    it("@@ is not a mention", () => {
      expect(tokens("@@improve")).toEqual([]);
    });

    it("still matches a handle that opens the text or follows punctuation", () => {
      expect(tokens("@improve please")).toEqual(["improve"]);
      expect(tokens('("@improve")')).toEqual(["improve"]);
    });
  });

  it("yields nothing for an @ with nothing addressable after it", () => {
    expect(tokens("email me @ the address")).toEqual([]);
    expect(tokens("trailing @")).toEqual([]);
    expect(tokens("@!!! punctuation")).toEqual([]);
  });

  it("finds several distinct handles in one comment", () => {
    expect(tokens("@improve and @sparkle please")).toEqual(["improve", "sparkle"]);
  });

  it("consumes a matched name WHOLE, so an @ inside it is not re-read as a second handle", () => {
    // A display name is free text and may itself contain an `@` ("Ship @Edge"). If the scanner did
    // not advance past the name it matched, it would re-enter the middle of that name and emit the
    // tail as a second, bogus handle — which then gets reported to the writer as an unknown agent.
    // This is the case that pins the cursor advance; every other name shape passes without it.
    expect(tokens("@Ship @Edge now", ["Ship @Edge"])).toEqual(["Ship @Edge"]);
  });

  it("does not run past the end of a known name into the next word", () => {
    expect(tokens("@Backstop Agent and @improve", ["Backstop Agent"])).toEqual([
      "Backstop Agent",
      "improve",
    ]);
  });
});
