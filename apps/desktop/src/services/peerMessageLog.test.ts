// The peer row's MODEL — what the concierge log is told about a peer message, and which sends it is
// told about at all.
//
// These are pure functions on purpose. Whether a row appears is a correctness question (the founder
// is about to start trusting this column to mean "this is all the cross-agent traffic"), and a
// silently-dropped send is indistinguishable from silence between two agents that never spoke.
import { describe, expect, it } from "vitest";
import { PEER_GIST_MAX_CHARS } from "@sparkle/core";
import {
  peerMessageEntry,
  peerRowBelongsInLog,
  PEER_GIST_FALLBACK_LINES,
} from "./peerMessageLog";

const FROM = { id: "a1", name: "Orchestrator" };
const TO = { id: "a2", name: "Rust Half" };

describe("peerRowBelongsInLog", () => {
  it("shows a send made inside the project the founder is looking at", () => {
    expect(
      peerRowBelongsInLog({ callerProjectId: "p1", selectedProjectId: "p1", appGlobal: false }),
    ).toBe(true);
  });

  it("hides a send made in a project that is not on screen", () => {
    expect(
      peerRowBelongsInLog({ callerProjectId: "p2", selectedProjectId: "p1", appGlobal: false }),
    ).toBe(false);
  });

  it("shows traffic to or from an app-global agent whatever project is selected", () => {
    // The concierge and Improve Sparkle are not rows in any project, so a project comparison can
    // only ever exclude them — and the concierge's own peer traffic is the half the founder is most
    // likely to be reading the column for.
    expect(
      peerRowBelongsInLog({ callerProjectId: null, selectedProjectId: "p1", appGlobal: true }),
    ).toBe(true);
    expect(
      peerRowBelongsInLog({ callerProjectId: "p2", selectedProjectId: "p1", appGlobal: true }),
    ).toBe(true);
  });

  it("hides a project send when no project is selected, rather than showing everything", () => {
    // `null === null` would otherwise read as a match and open the column to every project at once,
    // which is the one shape the scoping decision ruled out.
    expect(
      peerRowBelongsInLog({ callerProjectId: null, selectedProjectId: null, appGlobal: false }),
    ).toBe(false);
  });
});

describe("peerMessageEntry", () => {
  it("clamps to the gist the sender wrote, and keeps the full message for the expansion", () => {
    const m = peerMessageEntry({
      id: "peer-1",
      from: FROM,
      to: TO,
      gist: "taking the parser; you own the codegen",
      message: "I am claiming src/parser.rs and its test.\nDo not edit it.",
    });
    expect(m.kind).toBe("peer");
    expect(m.gist).toBe("taking the parser; you own the codegen");
    expect(m.text).toBe("I am claiming src/parser.rs and its test.\nDo not edit it.");
    expect(m.from).toEqual(FROM);
    expect(m.to).toEqual(TO);
  });

  it("falls back to the message's own opening lines when the sender wrote no gist", () => {
    // A blank clamp would be worse than the invisibility this feature removes: the row would say a
    // message happened and refuse to say anything about it.
    const message = "line one\nline two\nline three\nline four";
    const m = peerMessageEntry({ id: "peer-2", from: FROM, to: TO, message });
    expect(m.gist).toBe("line one\nline two");
    expect(m.text).toBe(message);
  });

  it("treats a whitespace-only gist as no gist at all", () => {
    const m = peerMessageEntry({
      id: "peer-3",
      from: FROM,
      to: TO,
      gist: "   \n  ",
      message: "the real words",
    });
    expect(m.gist).toBe("the real words");
  });

  it("takes exactly PEER_GIST_FALLBACK_LINES lines, so the clamp never hides a third one silently", () => {
    // The CSS clamp is two lines; the fallback must not hand it four and rely on the clamp to hide
    // the rest, or "expand" would be the only way to discover there was more — including for a
    // message whose whole content is those four short lines.
    const message = Array.from({ length: 6 }, (_, i) => `l${i}`).join("\n");
    const m = peerMessageEntry({ id: "peer-4", from: FROM, to: TO, message });
    expect(m.gist.split("\n")).toHaveLength(PEER_GIST_FALLBACK_LINES);
  });

  it("truncates an over-long gist rather than refusing the message it summarises", () => {
    // The asymmetry with `too_long` is the point: the MESSAGE is the payload and an over-long one is
    // refused, but a display concern must never be able to break the delivery channel.
    const m = peerMessageEntry({
      id: "peer-6",
      from: FROM,
      to: TO,
      gist: "x".repeat(PEER_GIST_MAX_CHARS + 50),
      message: "the real words",
    });
    expect([...m.gist]).toHaveLength(PEER_GIST_MAX_CHARS + 1); // + the ellipsis
    expect(m.gist.endsWith("…")).toBe(true);
    expect(m.text).toBe("the real words");
  });

  it("counts a gist in characters, so an emoji is not cut in half", () => {
    // `.length` is UTF-16 code units: a naive slice at the cap can leave a lone surrogate, which
    // renders as a replacement glyph in the row.
    const m = peerMessageEntry({
      id: "peer-7",
      from: FROM,
      to: TO,
      gist: "\u{1F680}".repeat(PEER_GIST_MAX_CHARS + 10),
      message: "body",
    });
    expect(m.gist).not.toContain("\uFFFD");
    expect([...m.gist]).toHaveLength(PEER_GIST_MAX_CHARS + 1);
  });

  it("keeps the message verbatim — it is a machine string, not markdown", () => {
    const message = "use `_foo_` and *not* **bar**";
    const m = peerMessageEntry({ id: "peer-5", from: FROM, to: TO, message });
    expect(m.text).toBe(message);
  });
});
