// @vitest-environment jsdom
//
// The COLUMN half of sparkle-zm0c8: a row must say when instructions are queued for its agent.
//
// Every assertion is on what a reader can SEE — the count on the row, the queued text after a click,
// the stage each message has reached. None of them can pass against the code as it stood, where the
// row rendered no inbox affordance at all and no store held the queue.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import {
  AgentInboxBadge,
  INBOX_BADGE_TESTID,
  INBOX_POPOVER_TESTID,
  INBOX_POPOVER_MESSAGE_TESTID,
} from "./AgentInboxBadge";
import {
  __resetInboxForTests,
  __setInboxPeekForTests,
  refreshInbox,
} from "../stores/inboxStore";
import type { InboxEntry } from "../services/conciergeTools/fleet";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../logger", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

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

/** Seed the store as a real poll would, then let the subscribed component re-render. */
async function seed(agentId: string, entries: InboxEntry[]) {
  restore();
  restore = __setInboxPeekForTests(async () => [{ agentId, entries }]);
  await act(async () => {
    await refreshInbox();
  });
}

beforeEach(() => __resetInboxForTests());
afterEach(() => {
  restore();
  restore = () => {};
  __resetInboxForTests();
});

describe("AgentInboxBadge", () => {
  it("renders NOTHING when no message is queued — a permanent mark stops being read", async () => {
    render(<AgentInboxBadge agentId="agent-1" />);
    await seed("agent-1", []);
    expect(screen.queryByTestId(INBOX_BADGE_TESTID)).toBeNull();
  });

  it("shows the PENDING count on the row, which is what the founder scans", async () => {
    render(<AgentInboxBadge agentId="agent-1" />);
    await seed("agent-1", [
      entry({ id: "m1" }),
      entry({ id: "m2" }),
      // Delivered and acknowledged are NOT waiting on a turn boundary, so they must not inflate the
      // badge into a permanent decoration.
      entry({ id: "m3", state: "delivered" }),
      entry({ id: "m4", state: "acknowledged", ackedAt: 2_000 }),
    ]);

    const badge = screen.getByTestId(INBOX_BADGE_TESTID);
    expect(badge.textContent).toContain("2");
    expect(badge.getAttribute("data-pending-count")).toBe("2");
    // The accessible name carries the number too: the count is a bare digit beside an icon, which is
    // nothing at all to a screen reader.
    expect(badge.getAttribute("aria-label")).toBe("2 queued messages");
  });

  it("shows the QUEUED TEXT and each message's stage on click — the whole point of the badge", async () => {
    // "I sent it" has to be checkable in one click rather than on trust. A count alone cannot be
    // checked against a claim about a specific instruction.
    render(<AgentInboxBadge agentId="agent-1" />);
    await seed("agent-1", [
      entry({ id: "m1", text: "rebase before you verify", severity: "act" }),
      entry({ id: "m2", text: "main has moved", state: "delivered" }),
      entry({ id: "m3", text: "the spec changed", state: "acknowledged", ackedAt: 2_000 }),
    ]);

    expect(screen.queryByTestId(INBOX_POPOVER_TESTID)).toBeNull();
    fireEvent.click(screen.getByTestId(INBOX_BADGE_TESTID));

    const panel = screen.getByTestId(INBOX_POPOVER_TESTID);
    expect(panel.textContent).toContain("rebase before you verify");
    // …including the ones that are no longer pending: "it already arrived" answers the question the
    // reader came with just as well as "it is still queued".
    expect(panel.textContent).toContain("main has moved");
    expect(panel.textContent).toContain("the spec changed");

    const rows = screen.getAllByTestId(INBOX_POPOVER_MESSAGE_TESTID);
    expect(rows.map((r) => r.getAttribute("data-delivery-state"))).toEqual([
      "pending",
      "delivered",
      "acknowledged",
    ]);
    // The three stages are WORDS, not only a colour or an attribute.
    expect(panel.textContent).toContain("queued — delivers at the next turn");
    expect(panel.textContent).toContain("delivered — waiting for the agent to confirm");
    expect(panel.textContent).toContain("acknowledged by the agent");
    // ACT vs FYI changes what the agent is expected to do, so a reader auditing the queue needs it.
    expect(rows[0]!.textContent).toContain("ACT");
    expect(rows[1]!.textContent).toContain("FYI");
  });

  it("does not select the row when it is clicked", async () => {
    // The row's own click switches the pane. Reading what is queued must not move the reader.
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <AgentInboxBadge agentId="agent-1" />
      </div>,
    );
    await seed("agent-1", [entry({ id: "m1" })]);

    fireEvent.click(screen.getByTestId(INBOX_BADGE_TESTID));
    expect(screen.getByTestId(INBOX_POPOVER_TESTID)).toBeTruthy();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("closes on Escape, and drops the panel when the last message is delivered", async () => {
    render(<AgentInboxBadge agentId="agent-1" />);
    await seed("agent-1", [entry({ id: "m1" })]);
    fireEvent.click(screen.getByTestId(INBOX_BADGE_TESTID));
    expect(screen.getByTestId(INBOX_POPOVER_TESTID)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId(INBOX_POPOVER_TESTID)).toBeNull();

    // Reopen, then let the message deliver. The badge unmounts, and an orphaned portal would be a
    // panel on screen with nothing left to close it.
    fireEvent.click(screen.getByTestId(INBOX_BADGE_TESTID));
    expect(screen.getByTestId(INBOX_POPOVER_TESTID)).toBeTruthy();
    await seed("agent-1", [entry({ id: "m1", state: "delivered" })]);
    expect(screen.queryByTestId(INBOX_BADGE_TESTID)).toBeNull();
    expect(screen.queryByTestId(INBOX_POPOVER_TESTID)).toBeNull();
  });

  it("shows one agent's queue and not another's", async () => {
    // Rows are memoized per agent and the store is keyed by id; a leak here would tell the founder a
    // message went to the wrong agent, which is worse than telling him nothing.
    restore = __setInboxPeekForTests(async (ids) =>
      ids.map((agentId) => ({
        agentId,
        entries: agentId === "agent-1" ? [entry({ id: "m1", text: "for one" })] : [],
      })),
    );
    render(
      <>
        <div data-testid="row-1">
          <AgentInboxBadge agentId="agent-1" />
        </div>
        <div data-testid="row-2">
          <AgentInboxBadge agentId="agent-2" />
        </div>
      </>,
    );
    await act(async () => {
      await refreshInbox();
    });

    expect(screen.getByTestId("row-1").querySelector(`[data-testid="${INBOX_BADGE_TESTID}"]`)).toBeTruthy();
    expect(screen.getByTestId("row-2").querySelector(`[data-testid="${INBOX_BADGE_TESTID}"]`)).toBeNull();
  });
});
