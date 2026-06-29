import { describe, expect, it } from "vitest";
import { authorizeAgentInput, authorizeDecision } from "./relayGate";

describe("authorizeDecision (the host PTY-write gate)", () => {
  it("injects only for an attention WE raised, framed with a newline", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "y", submit: true })).toEqual({
      agentId: "agentA",
      text: "y\n",
    });
  });

  it("drops a decision for an unknown attention_id (no arbitrary PTY injection)", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "nope", reply: "y", submit: true })).toBeNull();
    // A bare agent id must NOT be accepted as an attention id.
    expect(authorizeDecision(live, { attention_id: "agentA", reply: "y", submit: true })).toBeNull();
  });

  it("is single-use: a replay of the same attention_id is dropped", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "y", submit: true })).not.toBeNull();
    expect(authorizeDecision(live, { attention_id: "att1", reply: "y", submit: true })).toBeNull();
  });

  it("rejects an over-long reply (>4000 chars) and a non-string reply", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "x".repeat(4001), submit: true })).toBeNull();
    expect(live.has("att1")).toBe(true); // not consumed on an invalid reply
    expect(authorizeDecision(live, { attention_id: "att1", reply: undefined })).toBeNull();
  });

  it("does not double-add a newline when the reply already ends with one", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "2\n", submit: true })?.text).toBe("2\n");
  });
});

describe("authorizeAgentInput (free-type gate)", () => {
  it("injects only for a WATCHED agent, submitting with a newline", () => {
    const watched = new Set(["agentA"]);
    expect(authorizeAgentInput(watched, { agent_id: "agentA", text: "ls" })).toEqual({
      agentId: "agentA",
      text: "ls\n",
    });
  });

  it("drops input for an unwatched agent (never an arbitrary PTY)", () => {
    const watched = new Set(["agentA"]);
    expect(authorizeAgentInput(watched, { agent_id: "agentB", text: "rm -rf /" })).toBeNull();
  });

  it("rejects over-long / non-string text", () => {
    const watched = new Set(["agentA"]);
    expect(authorizeAgentInput(watched, { agent_id: "agentA", text: "x".repeat(4001) })).toBeNull();
    expect(authorizeAgentInput(watched, { agent_id: "agentA", text: undefined })).toBeNull();
  });
});
