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
  MOUNTED_QUEUED_PEER_TESTID,
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

describe("MountedAgentThread — a queued PEER message is not the concierge's", () => {
  // THE THIRD RENDERER, and the human-facing one. Per-message attribution was added to both AGENT
  // delivery paths, but `InboxEntry.from` was on the type and read by nothing here — so a peer's
  // message was drawn in the founder/concierge-side bubble, presented to the human as something the
  // concierge queued. That is the same misattribution the agent-facing fix closed, one surface over,
  // and it matters for the same reason: a peer refused something by its own permissions asks a
  // sibling to do it instead, and the request arrives wearing authority it does not have.

  it("attributes a peer message to its sender and moves it out of the founder's column", async () => {
    mount();
    await seed([
      entry({ id: "m1", from: "Relay Builder [abc-123]", text: "taking the Rust half" }),
    ]);

    const queued = screen.getByTestId(MOUNTED_QUEUED_TESTID);
    // Visible attribution — what a reader can actually see, not merely a field on the entry.
    const attribution = screen.getByTestId(MOUNTED_QUEUED_PEER_TESTID);
    expect(attribution.textContent).toContain("Relay Builder [abc-123]");
    expect(attribution.textContent).toMatch(/peer/i);
    expect(attribution.textContent).toMatch(/no human authority/i);
    expect(queued.getAttribute("data-queued-sender")).toBe("Relay Builder [abc-123]");
    // …and named for a reader who cannot see the column it sits in.
    expect(queued.getAttribute("aria-label")).toContain("from peer agent Relay Builder [abc-123]");
    // The bubble leaves the founder's side. Asserted on the inline style rather than a class,
    // because jsdom never loads the stylesheet — a class-derived getComputedStyle reads empty.
    expect((queued.parentElement as HTMLElement).style.alignSelf).toBe("flex-start");
  });

  it("leaves a CONCIERGE message exactly as it was — no banner, still the founder's column", async () => {
    // THE POSITIVE CONTROL. Without it, a component that banners everything passes the test above
    // while destroying the register the concierge's own relays are drawn in.
    mount();
    await seed([entry({ id: "m1", text: "rebase before you verify" })]);

    const queued = screen.getByTestId(MOUNTED_QUEUED_TESTID);
    expect(screen.queryByTestId(MOUNTED_QUEUED_PEER_TESTID)).toBeNull();
    expect(queued.getAttribute("aria-label")).toBe("Queued message, not yet delivered");
    expect((queued.parentElement as HTMLElement).style.alignSelf).toBe("flex-end");
  });

  it("renders an unreadable sender as UNKNOWN, never as the concierge", async () => {
    // The safe direction to fail. Attributing an unverifiable message to the concierge is precisely
    // the laundering the attribution exists to stop; "unknown sender" merely shows the banner.
    mount();
    await seed([entry({ id: "m1", from: "   ", text: "who sent this?" })]);

    const queued = screen.getByTestId(MOUNTED_QUEUED_TESTID);
    expect(queued.getAttribute("data-queued-sender")).toBe("unknown sender");
    expect(screen.getByTestId(MOUNTED_QUEUED_PEER_TESTID).textContent).toContain("unknown sender");
    expect((queued.parentElement as HTMLElement).style.alignSelf).toBe("flex-start");
  });
});
