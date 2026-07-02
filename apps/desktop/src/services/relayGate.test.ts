import { describe, expect, it } from "vitest";
import {
  authorizeAgentInput,
  authorizeDecision,
  resolveSuggestionClick,
  frameSubmit,
} from "./relayGate";

describe("resolveSuggestionClick (the single click gate, raw value)", () => {
  const lookup = (a: string, b: string) => (a === "a1" && b === "btn1" ? "control:closeAgent" : null);
  it("returns the RAW pushed value (unframed) for a watched, known button", () => {
    expect(
      resolveSuggestionClick(new Set(["a1"]), { agent_id: "a1", button_id: "btn1" }, lookup),
    ).toEqual({ agentId: "a1", value: "control:closeAgent" });
  });
  it("drops unwatched agent / unknown button", () => {
    expect(resolveSuggestionClick(new Set(), { agent_id: "a1", button_id: "btn1" }, lookup)).toBeNull();
    expect(
      resolveSuggestionClick(new Set(["a1"]), { agent_id: "a1", button_id: "x" }, lookup),
    ).toBeNull();
  });
  it("drops an over-long looked-up value", () => {
    const bigLookup = () => "z".repeat(5000);
    expect(
      resolveSuggestionClick(new Set(["a1"]), { agent_id: "a1", button_id: "x" }, bigLookup),
    ).toBeNull();
  });
});

// Submissions terminate with CR (`\r`) — what a physical Enter sends. Raw-mode TUIs (Claude
// Code's Ink pickers) don't treat LF as Enter, so LF-framed answers to a numbered picker vanish;
// canonical-mode prompts still accept CR via ICRNL.
describe("frameSubmit (PTY submission framing)", () => {
  it("adds a trailing CR to a prompt that lacks one", () => {
    expect(frameSubmit("Rebase main, open a PR, and merge.")).toBe(
      "Rebase main, open a PR, and merge.\r",
    );
  });
  it("converts a legacy LF-framed keystroke value to CR (not doubled)", () => {
    expect(frameSubmit("2\n")).toBe("2\r");
  });
  it("leaves a value already ending in CR unchanged", () => {
    expect(frameSubmit("2\r")).toBe("2\r");
  });
  it("collapses a CRLF terminator to a single CR (never a double Enter)", () => {
    expect(frameSubmit("2\r\n")).toBe("2\r");
  });
});

describe("authorizeDecision (the host PTY-write gate)", () => {
  it("injects only for an attention WE raised, framed with a CR (Enter)", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "y", submit: true })).toEqual({
      agentId: "agentA",
      text: "y\r",
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

  it("converts a phone reply's LF framing to CR without doubling", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "2\n", submit: true })?.text).toBe("2\r");
  });

  it("normalizes an LF-terminated reply even without submit (it already carries its Enter)", () => {
    const live = new Map([["att1", "agentA"]]);
    expect(authorizeDecision(live, { attention_id: "att1", reply: "1\n" })?.text).toBe("1\r");
  });
});

describe("authorizeAgentInput (free-type gate)", () => {
  it("injects only for a WATCHED agent, submitting with a CR (Enter)", () => {
    const watched = new Set(["agentA"]);
    expect(authorizeAgentInput(watched, { agent_id: "agentA", text: "ls" })).toEqual({
      agentId: "agentA",
      text: "ls\r",
    });
    // Legacy phone framing (trailing LF) is converted, not doubled.
    expect(authorizeAgentInput(watched, { agent_id: "agentA", text: "1\n" })?.text).toBe("1\r");
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
