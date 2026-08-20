import { describe, expect, it } from "vitest";

import { resolveAgentMention, type MentionCandidate } from "./agentMentionResolve";

// These assert WHICH AGENT a token resolves to — the id a caller would go on to deliver a message
// to — not merely that some resolution came back. A test that only checked `kind` would stay green
// while the helper handed the message to the wrong sibling, which is the one failure that matters
// here: `send_peer_message` and the bead-@mention doorbell both act on `id`.

const c = (id: string, name: string): MentionCandidate => ({ id, name });

describe("resolveAgentMention", () => {
  it("prefers an exact id over a DIFFERENT agent whose name is that same string", () => {
    // The precedence is the whole assertion. Both candidates match the token — one by id, one by
    // name — so a resolver that consulted names first would deliver to `b`, and one with no
    // precedence at all would call it ambiguous. Only id-first answers `agent-7`.
    const r = resolveAgentMention([c("agent-7", "Rust Half"), c("b", "agent-7")], "agent-7");

    expect(r).toEqual({ kind: "ok", id: "agent-7", name: "Rust Half" });
  });

  it("resolves a unique display name to that agent's id", () => {
    const r = resolveAgentMention([c("a1", "Rust Half"), c("a2", "TS Half")], "TS Half");

    expect(r).toEqual({ kind: "ok", id: "a2", name: "TS Half" });
  });

  it("names EVERY colliding id, in candidate order, when two agents share a display name", () => {
    // The caller's only remedy is to re-address one of them by id, so a report that named just the
    // first — or only the count — would leave it unable to act.
    const r = resolveAgentMention(
      [c("only-me", "Solo"), c("twin-1", "Twin"), c("twin-2", "Twin")],
      "Twin",
    );

    expect(r).toEqual({ kind: "ambiguous", token: "Twin", ids: ["twin-1", "twin-2"] });
  });

  it("does NOT fold case — a name differing only in case is unknown, not a match", () => {
    // Pins today's shipped behaviour. Loosening this would start DELIVERING messages that are
    // refused today, so it must be a deliberate change with its own test, never a silent one.
    const r = resolveAgentMention([c("a1", "Rust Half")], "rust half");

    expect(r).toEqual({ kind: "unknown", token: "rust half" });
  });

  it("reports an unmatched token as unknown, quoting the token back", () => {
    const r = resolveAgentMention([c("a1", "Rust Half")], "Nobody");

    expect(r).toEqual({ kind: "unknown", token: "Nobody" });
  });

  it("resolves an empty token as unknown even when a candidate's name is empty", () => {
    // An unnamed row must not become the catch-all recipient for every empty address.
    const r = resolveAgentMention([c("a1", ""), c("a2", "Named")], "");

    expect(r).toEqual({ kind: "unknown", token: "" });
  });

  it("matches nothing against an empty candidate list", () => {
    expect(resolveAgentMention([], "Rust Half")).toEqual({ kind: "unknown", token: "Rust Half" });
  });

  it("does not trim on the caller's behalf — a padded token is the caller's to normalise", () => {
    expect(resolveAgentMention([c("a1", "Rust Half")], " Rust Half ")).toEqual({
      kind: "unknown",
      token: " Rust Half ",
    });
  });
});
