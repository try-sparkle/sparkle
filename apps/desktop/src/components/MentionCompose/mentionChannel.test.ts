import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the ONE Tauri dependency, so this test exercises the PRODUCTION channel's real invoke call
// site (not a test double) — the seam the panel and the hook would otherwise leave uncovered.
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { createMentionChannel } from "./mentionChannel";

afterEach(() => {
  invoke.mockReset();
});

describe("createMentionChannel — the production Tauri call site", () => {
  it("send() invokes mention_send with the camelCase envelope the backend expects", async () => {
    invoke.mockResolvedValueOnce("msg-123");
    const ch = createMentionChannel();

    const ack = await ch.send({
      target: "improve",
      body: "why is CI red?",
      threadRef: "compose-window",
      from: "founder",
    });

    // The SIDE EFFECT: the backend command name + args, camelCased as every other invoke in the app.
    expect(invoke).toHaveBeenCalledWith("mention_send", {
      targetHandle: "improve",
      threadRef: "compose-window",
      body: "why is CI red?",
      from: "founder",
    });
    expect(ack).toEqual({ messageId: "msg-123" });
  });

  it("awaitReply() invokes mention_reply with the message id and returns the body", async () => {
    invoke.mockResolvedValueOnce("CI is red because a runner was saturated.");
    const ch = createMentionChannel();

    const reply = await ch.awaitReply("msg-123");

    expect(invoke).toHaveBeenCalledWith("mention_reply", { messageId: "msg-123" });
    expect(reply).toEqual({ body: "CI is red because a runner was saturated." });
  });

  it("propagates a backend rejection rather than swallowing it", async () => {
    invoke.mockRejectedValueOnce(new Error("no such agent"));
    const ch = createMentionChannel();
    await expect(
      ch.send({ target: "sparkle", body: "hi", threadRef: "t", from: "founder" }),
    ).rejects.toThrow("no such agent");
  });
});
