// The classifier that decides, on five separate surfaces, whether a queued message is shown as
// carrying human authority. These tests exist because the previous version of this logic was a
// hand-written copy on each surface, pinned to nothing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CONCIERGE_SENDER,
  UNKNOWN_SENDER,
  anyPeer,
  isPeerSender,
  peerAttributionLine,
  senderOf,
} from "./peerAttribution";
import { peerLabel } from "./peerMessaging";

const repoFile = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

describe("peerAttribution — the classifier itself", () => {
  it("treats a peer label as a PEER and the concierge's own default as the concierge", () => {
    // DRIVEN BY THE PRODUCERS, not by a hand-written fixture. A test that fed the literal
    // "concierge" and asserted it classifies as the concierge would pass no matter what either
    // producer emits — the "fixture already has the field it checks" shape AGENTS.md names.
    expect(isPeerSender(peerLabel("Relay Builder", "abc-123"))).toBe(true);
    expect(isPeerSender(CONCIERGE_SENDER)).toBe(false);
  });

  it("fails towards LESS authority: an unreadable sender is unknown, never the concierge", () => {
    for (const bad of [undefined, null, "", "   ", 42, {}]) {
      expect(senderOf(bad)).toBe(UNKNOWN_SENDER);
      expect(isPeerSender(bad)).toBe(true);
    }
    expect(senderOf(bad_free_of_padding())).toBe("Relay Builder [abc-123]");
  });

  it("says both halves in the attribution line: who sent it, and that it grants nothing", () => {
    const line = peerAttributionLine(peerLabel("Relay Builder", "abc-123"));
    expect(line).toContain("Relay Builder [abc-123]");
    expect(line).toMatch(/peer/i);
    expect(line).toMatch(/no human authority/i);
  });

  it("anyPeer is true for a MIXED queue, not only an all-peer one", () => {
    // The header case. A queue of nine concierge messages and one peer's is exactly the queue whose
    // header must stop claiming the concierge, so an `every`-shaped bug here is the whole bug.
    expect(anyPeer([{ from: CONCIERGE_SENDER }, { from: "Relay Builder [abc-123]" }])).toBe(true);
    expect(anyPeer([{ from: CONCIERGE_SENDER }, { from: CONCIERGE_SENDER }])).toBe(false);
    expect(anyPeer([])).toBe(false);
  });
});

describe("peerAttribution — pinned to the producers that emit the value", () => {
  // CONCIERGE_SENDER is a trust boundary, and it is written down in three places this module cannot
  // import: the Rust default, and the delivery hook (a plain .mjs run by the agent's own hook
  // process). If any of them drifts, every genuine concierge message moves into the peer register
  // and is labelled "not the concierge" — a user-facing untruth on the trusted path — while every
  // in-process test stays green. These read the other copies as text so the ends fail together.

  it("matches the default `inbox.rs::resolve_from` actually emits", () => {
    const rs = repoFile("src-tauri/src/inbox.rs");
    const decl = /fn resolve_from\(from: Option<String>\) -> String \{[\s\S]*?\n\}/.exec(rs);
    expect(decl, "resolve_from not found — this pin needs updating").not.toBeNull();
    expect(decl![0]).toContain(`"${CONCIERGE_SENDER}"`);
  });

  it("matches the constant the delivery hook compares against", () => {
    const mjs = repoFile("src-tauri/resources/sparkle-hook.mjs");
    expect(mjs).toMatch(new RegExp(`CONCIERGE_SENDER\\s*=\\s*["']${CONCIERGE_SENDER}["']`));
  });
});

/** A label with incidental padding — trimmed, not rejected. */
function bad_free_of_padding(): string {
  return "  Relay Builder [abc-123]  ";
}
