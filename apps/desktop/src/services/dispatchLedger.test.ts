// The delegation ledger's WRITE half. Everything here is about one property: a row written today
// must still be READABLE, and still mean the same thing, when a build written months later reads it
// back. These rows are kept for a year (`DISPATCH_HISTORY_MAX`), so the format is a wire contract
// with the future and is tested as one.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const recordHistoryMock = vi.hoisted(() => vi.fn());
vi.mock("./history", () => ({ recordHistory: recordHistoryMock }));
vi.mock("../logger", () => ({
  log: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import {
  formatDispatchText,
  parseDispatchText,
  dispatchEntry,
  recordDispatch,
  DISPATCH_MARKER,
  DISPATCH_BRIEF_CHARS,
  type DispatchRecord,
} from "./dispatchLedger";

const AT = Date.parse("2026-08-22T15:24:02.000Z");

function rec(over: Partial<DispatchRecord> = {}): DispatchRecord {
  return {
    targetId: "8f590b78-a474-4572-877e-0380fc7ce2e4",
    channel: "build",
    nameAtDispatch: "Sparkle Preview Card Inline",
    projectId: "ed5d0ece-8a38-4649-9f7c-0ab6203a7467",
    projectName: "sparkle",
    brief: "TWO RELATED PROBLEMS WITH THE PREVIEW CARD in the Sparkle desktop app.",
    ask: "can we make the preview cards inline, one third width, in chat?",
    beads: ["sparkle-abc123"],
    mode: "build",
    by: "concierge",
    atMs: AT,
    id: "row-1",
    ...over,
  };
}

beforeEach(() => {
  recordHistoryMock.mockReset();
  recordHistoryMock.mockResolvedValue({ inserted: true, collided: false });
});
afterEach(() => vi.restoreAllMocks());

describe("formatDispatchText → parseDispatchText round trip", () => {
  it("preserves every dispatch-time fact", () => {
    const r = rec();
    const back = parseDispatchText(formatDispatchText(r), AT);
    expect(back).not.toBeNull();
    expect(back).toMatchObject({
      targetId: r.targetId,
      channel: "build",
      nameAtDispatch: "Sparkle Preview Card Inline",
      projectId: r.projectId,
      projectName: "sparkle",
      ask: r.ask,
      brief: r.brief,
      beads: ["sparkle-abc123"],
      mode: "build",
      by: "concierge",
      briefTruncated: false,
    });
  });

  // THE ONE THAT BREAKS A NAIVE LINE PARSER. A brief is arbitrary user prose and can contain a line
  // that looks exactly like one of our own field prefixes. The format puts BRIEF last and stops
  // scanning there precisely so this cannot corrupt the record; without that rule the second "ASK:"
  // below would overwrite the real ask and the rest of the brief would vanish.
  it("keeps a brief that itself contains field-prefix lines, verbatim", () => {
    const nasty = "Do the thing.\nASK: this is part of the brief, not the ask\nBEADS: not-a-bead\nDone.";
    const back = parseDispatchText(formatDispatchText(rec({ brief: nasty })), AT);
    expect(back?.brief).toBe(nasty);
    expect(back?.ask).toBe("can we make the preview cards inline, one third width, in chat?");
    expect(back?.beads).toEqual(["sparkle-abc123"]);
  });

  // A newline inside a ONE-LINE field would end that field early and make the remainder parse as a
  // new one — so the writer flattens them. Asserted on the round trip, not on the writer's internals.
  it("flattens newlines out of the ask so the row's line structure survives it", () => {
    const back = parseDispatchText(formatDispatchText(rec({ ask: "line one\nBRIEF: hijack" })), AT);
    expect(back?.ask).toBe("line one BRIEF: hijack");
    expect(back?.brief).toBe(rec().brief);
  });

  it("reports an unbriefed spawn as an empty brief, not as a missing one", () => {
    const back = parseDispatchText(formatDispatchText(rec({ brief: "" })), AT);
    expect(back?.brief).toBe("");
    expect(back?.targetId).toBe(rec().targetId);
  });

  it("marks a truncated brief rather than letting it merely stop", () => {
    const long = "x".repeat(DISPATCH_BRIEF_CHARS + 500);
    const back = parseDispatchText(formatDispatchText(rec({ brief: long })), AT);
    expect(back?.briefTruncated).toBe(true);
    expect(back?.brief.length).toBe(DISPATCH_BRIEF_CHARS);
    // The marker itself must not survive into the returned text — a caller rendering it would show
    // our bookkeeping to the founder as if it were part of what he asked for.
    expect(back?.brief).not.toContain("truncated");
  });

  it("uses the row's created_at as the authority for the time, not the AT: line", () => {
    const later = AT + 999_000;
    expect(parseDispatchText(formatDispatchText(rec()), later)?.atMs).toBe(later);
  });
});

describe("forward compatibility — a row outlives the build that wrote it", () => {
  // The retention tier keeps these for a year, so a row written by a LATER build will be read by
  // this one. It must yield everything it can rather than nothing: an all-or-nothing parser here
  // would silently empty the ledger the first time the format grew a field, and the concierge would
  // then answer "we never did that work" with total confidence.
  it("keeps the id, time and ask when the channel is one this build has never heard of", () => {
    const text = formatDispatchText(rec()).replace("channel build", "channel holographic");
    const back = parseDispatchText(text, AT);
    expect(back?.channel).toBe("unknown");
    expect(back?.targetId).toBe(rec().targetId);
    expect(back?.ask).toBe(rec().ask);
  });

  it("keeps everything else when an unrecognised field line appears", () => {
    const text = formatDispatchText(rec()).replace("AT: ", "TENANT: acme\nAT: ");
    const back = parseDispatchText(text, AT);
    expect(back?.targetId).toBe(rec().targetId);
    expect(back?.brief).toBe(rec().brief);
  });

  it("returns null for text that is not a dispatch row at all", () => {
    expect(parseDispatchText("just some concierge chatter about preview cards", AT)).toBeNull();
  });
});

describe("dispatchEntry — the history row", () => {
  it("lands in the dispatch retention tier, keyed by the target id", () => {
    const e = dispatchEntry(rec());
    // `source` is the ONLY thing standing between this row and the 24h build-tier prune, and
    // history.ts warns that the column has no CHECK constraint — a typo here is silent and the row
    // simply disappears overnight. Pinned to the exact literal the SQL matches.
    expect(e.source).toBe("dispatch");
    expect(e.kind).toBe("prompt");
    expect(e.agentId).toBe(rec().targetId);
    expect(e.projectId).toBe(rec().projectId);
    expect(e.agentName).toBe("Sparkle Preview Card Inline");
    expect(e.createdAt).toBe(AT);
    expect(e.text.startsWith(DISPATCH_MARKER)).toBe(true);
  });

  it("makes the subject searchable — the words the founder will actually type are in the text", () => {
    // This is the whole retrieval path in one assertion: FTS5 indexes this string, and "preview
    // cards" is what he says. If the ask and brief were not in the document, the write would be
    // perfect and unfindable.
    const text = dispatchEntry(rec()).text;
    expect(text).toContain("preview cards");
    expect(text).toContain("PREVIEW CARD");
  });
});

describe("recordDispatch never costs a spawn", () => {
  it("writes the row and reports that it landed", async () => {
    await expect(recordDispatch(rec())).resolves.toBe(true);
    expect(recordHistoryMock).toHaveBeenCalledTimes(1);
    expect(recordHistoryMock.mock.calls[0]?.[0]).toMatchObject({ source: "dispatch" });
  });

  // Every call site is INSIDE the act of creating an agent. A ledger that could fail a spawn would
  // trade a real agent for a bookkeeping row — an unrecorded delegation costs one round of
  // re-research, a refused spawn costs the founder the work itself.
  it("swallows a rejecting store rather than failing the spawn around it", async () => {
    recordHistoryMock.mockRejectedValue(new Error("database is locked"));
    await expect(recordDispatch(rec())).resolves.toBe(false);
  });

  it("reports a non-landing write as false so a silently empty ledger is impossible", async () => {
    recordHistoryMock.mockResolvedValue({ inserted: false, collided: true });
    await expect(recordDispatch(rec())).resolves.toBe(false);
  });
});
