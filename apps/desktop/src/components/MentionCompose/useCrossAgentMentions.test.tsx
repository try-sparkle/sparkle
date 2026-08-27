// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { BeadComment } from "../../services/beadsCommands";

// Mock the service so the DEFAULT fetcher's production call site (beadsDetail) is exercised, not faked.
const beadsDetail = vi.hoisted(() => vi.fn());
vi.mock("../../services/beadsCommands", () => ({ beadsDetail }));

import { createBeadCommentsFetcher, useCrossAgentMentions } from "./useCrossAgentMentions";

afterEach(() => {
  beadsDetail.mockReset();
  cleanup();
});

const comments: BeadComment[] = [
  { id: "a", author: "concierge", text: "[request] please review the CI fix", createdAt: "2026-08-19T10:00:00Z" },
  { id: "b", author: "DROdio", text: "human note, must be ignored", createdAt: "2026-08-19T10:01:00Z" },
  { id: "c", author: "Improve Sparkle [x]", text: "[response] agreed", createdAt: "2026-08-19T10:02:00Z" },
];

describe("useCrossAgentMentions", () => {
  it("parses the watched bead's comments into cross-agent mentions, dropping non-agent comments", async () => {
    const fetchComments = vi.fn(async () => comments);
    const { result } = renderHook(() =>
      useCrossAgentMentions({ beadId: "sparkle-hdlhox", projectPath: "/p", fetchComments, intervalMs: 0 }),
    );

    await waitFor(() => expect(result.current.mentions).toHaveLength(2));
    const ms = result.current.mentions;
    // The human comment "b" is gone; the two agent comments carry the bead id + parsed interaction.
    expect(ms.map((m) => m.id)).toEqual(["a", "c"]);
    expect(ms[0]).toMatchObject({ from: "sparkle", interaction: "request", beadId: "sparkle-hdlhox" });
    expect(ms[1]).toMatchObject({ from: "improve", interaction: "response", beadId: "sparkle-hdlhox" });
  });
});

describe("createBeadCommentsFetcher — the production fetch seam", () => {
  it("reads the watched bead's comments through beadsDetail", async () => {
    beadsDetail.mockResolvedValueOnce({ comments });
    const fetcher = createBeadCommentsFetcher("/proj", "sparkle-hdlhox");
    const got = await fetcher();
    expect(beadsDetail).toHaveBeenCalledWith("/proj", "sparkle-hdlhox");
    expect(got).toBe(comments);
  });
});
