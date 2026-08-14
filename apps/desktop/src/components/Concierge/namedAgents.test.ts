import { describe, expect, it } from "vitest";
import { namedAgentIds } from "./namedAgents";
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
