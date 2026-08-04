// @vitest-environment jsdom
//
// THE SURFACE THE FOUNDER ACTUALLY LOOKED AT (bead sparkle-zm0c8).
//
// *"You said you sent this to @Pusher Unsticks The Fleet but I don't see a followup message from you
// in that agent thread with this, just the original instruction."* The message really had been
// queued. This thread renders a projection of DISK — turns that have already happened — so a queued
// message is absent from it by construction until the agent reaches a turn boundary and drains it.
//
// Asserts the SIDE EFFECT: what a reader can see in the column. Before this change the component
// took no agent id and read no inbox, so nothing here could pass against it.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";

import {
  MountedAgentThread,
  MOUNTED_QUEUED_TESTID,
  MOUNTED_QUEUED_BLOCK_TESTID,
  MOUNTED_HUMAN_TESTID,
} from "./MountedAgentThread";
import { __resetInboxForTests, __setInboxPeekForTests, refreshInbox } from "../../stores/inboxStore";
import type { InboxEntry } from "../../services/conciergeTools/fleet";
import type { MountedThread } from "../../stores/mountedThreadStore";
import type { TranscriptEntry } from "../../services/agentTranscript";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../logger", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const EMPTY: MountedThread = {
  entries: [],
  next: null,
  hasMore: false,
  loading: false,
  paging: false,
  tailFile: null,
  tailByte: 0,
  error: null,
};

function human(id: string, text: string): TranscriptEntry {
  return {
    kind: "human",
    id,
    text,
    promptSource: "typed",
    timestamp: "2026-08-04T10:00:00Z",
    sessionId: "s1",
    raw: "{}",
    // The cursor shape is Rust-owned and irrelevant to what this file asserts; the cast keeps the
    // fixture to the fields the component actually reads.
    cursor: { file: "s1", byte: 0 },
  } as unknown as TranscriptEntry;
}

function entry(over: Partial<InboxEntry> & { id: string }): InboxEntry {
  return {
    ts: 1_000,
    from: "concierge",
    text: `text for ${over.id}`,
    severity: "fyi",
    state: "pending",
    ackedAt: null,
    ackNote: null,
    ...over,
  };
}

let restore: () => void = () => {};

async function seed(entries: InboxEntry[]) {
  restore();
  restore = __setInboxPeekForTests(async () => [{ agentId: "agent-1", entries }]);
  await act(async () => {
    await refreshInbox();
  });
}

function mount(thread: Partial<MountedThread> = {}) {
  return render(
    <MountedAgentThread
      thread={{ ...EMPTY, ...thread }}
      agentId="agent-1"
      agentName="Pusher Unsticks The Fleet"
      onReachTop={vi.fn()}
    />,
  );
}

beforeEach(() => __resetInboxForTests());
afterEach(() => {
  restore();
  restore = () => {};
  __resetInboxForTests();
});

describe("MountedAgentThread — queued messages", () => {
  it("shows a QUEUED message that the transcript cannot contain yet", async () => {
    mount();
    await seed([entry({ id: "m1", text: "rebase before you verify" })]);

    const queued = screen.getAllByTestId(MOUNTED_QUEUED_TESTID);
    expect(queued).toHaveLength(1);
    expect(queued[0]!.textContent).toContain("rebase before you verify");
    expect(queued[0]!.getAttribute("data-delivery-state")).toBe("pending");

    // The STAGE is written out, not left to opacity — dimming is invisible to a screen reader and
    // ambiguous to everyone else ("dim" reads equally as "old").
    const block = screen.getByTestId(MOUNTED_QUEUED_BLOCK_TESTID);
    expect(block.textContent).toContain("queued — delivers at the next turn");
    expect(block.textContent).toContain("not in the conversation yet");
    expect(queued[0]!.getAttribute("aria-label")).toBe("Queued message, not yet delivered");
  });

  it("renders nothing at all when the queue is empty", async () => {
    mount();
    await seed([]);
    expect(screen.queryByTestId(MOUNTED_QUEUED_BLOCK_TESTID)).toBeNull();
  });

  it("keeps a DELIVERED message visible until the conversation itself carries it", async () => {
    // Delivery means the text was handed over. Until the transcript shows the turn that carried it,
    // "did it actually land?" is still open — and that open question is the whole bug.
    const { rerender } = mount();
    await seed([entry({ id: "m1", text: "main has moved", state: "delivered" })]);
    expect(screen.getAllByTestId(MOUNTED_QUEUED_TESTID)).toHaveLength(1);
    expect(screen.getByTestId(MOUNTED_QUEUED_TESTID).getAttribute("data-delivery-state")).toBe(
      "delivered",
    );

    // …and once the delivered text arrives in the transcript, the placeholder stands down rather
    // than printing the same instruction twice.
    rerender(
      <MountedAgentThread
        thread={{
          ...EMPTY,
          entries: [
            human("t1", "Sparkle concierge — 1 message(s) queued for you.\n\n[1] (FYI) main has moved"),
          ],
        }}
        agentId="agent-1"
        agentName="Pusher Unsticks The Fleet"
        onReachTop={vi.fn()}
      />,
    );
    expect(screen.queryByTestId(MOUNTED_QUEUED_TESTID)).toBeNull();
    expect(screen.getByTestId(MOUNTED_HUMAN_TESTID).textContent).toContain("main has moved");
  });

  it("keeps a PENDING message visible even if its text appears in an older turn", async () => {
    // Nothing has been typed anywhere for a pending message, so a text match could only ever be a
    // coincidence — and hiding it would restore the exact invisibility this fixes.
    mount({ entries: [human("t1", "rebase before you verify")] });
    await seed([entry({ id: "m1", text: "rebase before you verify", state: "pending" })]);
    expect(screen.getAllByTestId(MOUNTED_QUEUED_TESTID)).toHaveLength(1);
  });

  it("drops an ACKNOWLEDGED message — the agent has confirmed in writing", async () => {
    mount();
    await seed([
      entry({ id: "m1", text: "still queued" }),
      entry({ id: "m2", text: "confirmed", state: "acknowledged", ackedAt: 2_000, ackNote: "read" }),
    ]);
    const queued = screen.getAllByTestId(MOUNTED_QUEUED_TESTID);
    expect(queued.map((q) => q.getAttribute("data-delivery-state"))).toEqual(["pending"]);
    expect(screen.getByTestId(MOUNTED_QUEUED_BLOCK_TESTID).textContent).not.toContain("confirmed");
  });
});
