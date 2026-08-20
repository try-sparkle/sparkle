import { describe, expect, it } from "vitest";
import { namedAgentIds } from "./namedAgents";
import { beadMentionId } from "./mentions";
import type { MentionAgent } from "./mentions";

const agent = (id: string, name: string): MentionAgent =>
  ({ id, name, projectId: "p", projectName: "P" }) as unknown as MentionAgent;

const ROSTER = [
  agent("ag-kraken", "Kraken Auth"),
  agent("ag-publishing", "Drodio.com Publishing MCP"),
  agent("ag-eyes", "Eyes"),
  agent("ag-blueprint", "Blueprint UI/UX"),
];

describe("@-mentions", () => {
  it("counts every mention the composer resolved", () => {
    expect(
      namedAgentIds("@Kraken Auth ship it", [{ agentId: "ag-kraken", name: "Kraken Auth" }], ROSTER),
    ).toContain("ag-kraken");
  });

  it("does not duplicate an agent named both ways", () => {
    const ids = namedAgentIds(
      "@Kraken Auth — and tell Kraken Auth again",
      [{ agentId: "ag-kraken", name: "Kraken Auth" }],
      ROSTER,
    );
    expect(ids.filter((i) => i === "ag-kraken")).toHaveLength(1);
  });
});

describe("prose names", () => {
  it("counts an agent named without the picker", () => {
    expect(namedAgentIds("tell Kraken Auth to stop", undefined, ROSTER)).toEqual(["ag-kraken"]);
  });

  it("is case-insensitive", () => {
    expect(namedAgentIds("tell kraken auth to stop", undefined, ROSTER)).toEqual(["ag-kraken"]);
  });

  it("matches a name containing dots and spaces", () => {
    expect(namedAgentIds("ask Drodio.com Publishing MCP about it", undefined, ROSTER)).toEqual([
      "ag-publishing",
    ]);
  });

  it("matches a name containing a slash", () => {
    expect(namedAgentIds("Blueprint UI/UX should take this", undefined, ROSTER)).toEqual([
      "ag-blueprint",
    ]);
  });
});

describe("what must NOT count as naming an agent", () => {
  it("does not match a name inside a longer word", () => {
    // "Kraken Auth" must not be found inside "Kraken Author". A bystander agent silently acquiring
    // permission to receive his words is the failure this boundary exists to prevent.
    expect(namedAgentIds("Kraken Authority is a different thing", undefined, ROSTER)).toEqual([]);
  });

  it("does not let a SHORT agent name be claimed by ordinary English", () => {
    // "Eyes" is a real agent in this roster and an ordinary word in this sentence.
    expect(namedAgentIds("keep your eyes on the build", undefined, ROSTER)).toEqual([]);
  });

  it("names nobody in a message that names nobody — the common case", () => {
    expect(
      namedAgentIds("You should have better memory now. can you tell me if that's true?", [], ROSTER),
    ).toEqual([]);
    expect(
      namedAgentIds("I just updated to v0.107.0. make sure all agents are productive", [], ROSTER),
    ).toEqual([]);
  });

  it("survives an empty roster and an empty message", () => {
    expect(namedAgentIds("anything", undefined, [])).toEqual([]);
    expect(namedAgentIds("", undefined, ROSTER)).toEqual([]);
  });
});

// ══ A BEAD CAN NEVER GRANT RELAY PERMISSION (bead sparkle-1cpomd) ═══════════════════════════════
//
// Beads joined the mention roster so tasks and epics can be @mentioned like agents. This set is the
// PERMISSION half of the relay gate, so a bead leaking into it is a safety question rather than a
// tidiness one — and both paths into the set had to be closed, which is what the pairing below is
// checking. Each row asserts the bead is absent WHILE an agent named the very same way is present,
// so an implementation that simply returned fewer ids cannot pass.
describe("beads are named work, not named recipients", () => {
  const BEAD = beadMentionId("sparkle-1cpomd");
  const BEAD_TITLE = "Chat button on every bead card";
  const WITH_BEAD = [...ROSTER, agent(BEAD, BEAD_TITLE)];

  // THE EASY-TO-MISS PATH. The @-mention loop used to add every resolved id unconditionally, so
  // clicking Chat on a bead card dropped `bead:<id>` straight into the permission set. Harmless only
  // because nothing could match it — the accident-of-lookup this feature refused to rely on.
  it("keeps a bead @mention out of the set, while an agent @mention still counts", () => {
    const ids = namedAgentIds(
      `RE: @${BEAD_TITLE} — @Kraken Auth can you take this?`,
      [
        { agentId: BEAD, name: BEAD_TITLE },
        { agentId: "ag-kraken", name: "Kraken Auth" },
      ],
      WITH_BEAD,
    );
    expect(ids).toContain("ag-kraken");
    expect(ids).not.toContain(BEAD);
  });

  // THE PROSE PATH. `namedInProse` is deliberately generous, and that trade is priced for ~60 short
  // agent names — over a backlog of sentences it inverts, because a bead title is made of the same
  // words the message is.
  it("does not let a bead title in prose grant permission, where an agent name still does", () => {
    const ids = namedAgentIds(
      `the Chat button on every bead card is done — tell Kraken Auth`,
      undefined,
      WITH_BEAD,
    );
    expect(ids).toContain("ag-kraken");
    expect(ids).not.toContain(BEAD);
  });
});
