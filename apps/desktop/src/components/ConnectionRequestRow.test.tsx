// @vitest-environment jsdom
//
// The inbound-connection-request banner. Assertions are on side effects — the call that went out,
// the store that ended up holding a value, the words that got painted.
//
// Two shapes here are deliberate answers to vacuous forms:
//
//   • "renders nothing when there is nothing" is PAIRED with a seeded case in the same file. On its
//     own it passes against a component that renders nothing ever, which is exactly the regression
//     it is supposed to catch pointed the other way.
//   • "accepting removes the row" seeds TWO requests and asserts the OTHER one survives. Asserting
//     only that the accepted row went would pass against a handler that clears the whole list.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/socialApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/socialApi")>()),
  getConnections: vi.fn(),
  acceptConnection: vi.fn(),
  declineConnection: vi.fn(),
}));

import { acceptConnection, declineConnection, getConnections } from "../services/socialApi";
import { useSocialStore, type ConnectionRequest } from "../stores/socialStore";
import {
  ACCEPT_LABEL,
  CONNECTION_ACCEPT_TESTID,
  CONNECTION_DENY_TESTID,
  CONNECTION_REQUEST_ITEM_TESTID,
  CONNECTION_REQUEST_TESTID,
  ConnectionRequestRow,
  DENY_LABEL,
  requestBannerLabel,
  requestName,
} from "./ConnectionRequestRow";
import { pendingCount } from "../stores/inboxStore";

const mockGetConnections = vi.mocked(getConnections);
const mockAccept = vi.mocked(acceptConnection);
const mockDecline = vi.mocked(declineConnection);

const req = (id: string, username: string, displayName: string | null = null): ConnectionRequest => ({
  id,
  socialId: `s-${username}`,
  username,
  displayName,
});

/** Seed the store the way `socialSync` does. `username` on `me` is what licenses the poll. */
function seed(incoming: ConnectionRequest[], hasHandle = true) {
  useSocialStore.setState({
    incoming,
    me: { ...useSocialStore.getState().me, username: hasHandle ? "me" : null },
  });
}

beforeEach(() => {
  useSocialStore.getState().reset();
  mockGetConnections.mockReset();
  mockAccept.mockReset();
  mockDecline.mockReset();
  mockGetConnections.mockResolvedValue({ accepted: [], incoming: [], outgoing: [] });
  mockAccept.mockResolvedValue(undefined);
  mockDecline.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  useSocialStore.getState().reset();
});

describe("requestBannerLabel", () => {
  it("NAMES the one person when there is one", () => {
    expect(requestBannerLabel([req("c1", "ada")])).toBe("ada wants to connect");
    expect(requestBannerLabel([req("c1", "ada", "Ada Lovelace")])).toBe(
      "Ada Lovelace wants to connect",
    );
  });

  it("COUNTS instead when there are several — eleven names do not fit a 200px banner", () => {
    expect(requestBannerLabel([req("c1", "ada"), req("c2", "grace")])).toBe(
      "2 connection requests",
    );
  });

  it("prefers the display name but never a blank one", () => {
    expect(requestName(req("c1", "ada", "   "))).toBe("ada");
    expect(requestName(req("c1", "ada", "Ada"))).toBe("Ada");
  });
});

describe("ConnectionRequestRow — the conditional banner", () => {
  it("renders NOTHING when nobody has asked", () => {
    seed([]);
    const { container } = render(<ConnectionRequestRow />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByTestId(CONNECTION_REQUEST_TESTID)).toBeNull();
  });

  it("…and DOES render once a request arrives — the other half of the pair", () => {
    seed([req("c1", "ada")]);
    render(<ConnectionRequestRow />);
    const banner = screen.getByTestId(CONNECTION_REQUEST_TESTID);
    expect(banner.textContent).toContain("ada wants to connect");
    expect(banner.getAttribute("data-request-count")).toBe("1");
    // ONE request opens straight to the decision — no expander to press first.
    expect(screen.getByLabelText(`${ACCEPT_LABEL} — ada`)).toBeTruthy();
    expect(screen.getByLabelText(`${DENY_LABEL} — ada`)).toBeTruthy();
  });

  it("expands into a list when there are several, and not before", () => {
    seed([req("c1", "ada"), req("c2", "grace")]);
    render(<ConnectionRequestRow />);
    // Collapsed: the count is the headline and no per-person row is painted yet.
    expect(screen.queryAllByTestId(CONNECTION_REQUEST_ITEM_TESTID)).toHaveLength(0);
    expect(screen.getByTestId(CONNECTION_REQUEST_TESTID).textContent).toContain(
      "2 connection requests",
    );

    fireEvent.click(screen.getByTestId(CONNECTION_REQUEST_TESTID).firstElementChild!);
    const items = screen.getAllByTestId(CONNECTION_REQUEST_ITEM_TESTID);
    expect(items.map((i) => i.getAttribute("data-username"))).toEqual(["ada", "grace"]);
  });
});

describe("ConnectionRequestRow — accept and deny", () => {
  it("accepts by the CONNECTION ROW ID, not the person's socialId", async () => {
    seed([req("conn-1", "ada")]);
    render(<ConnectionRequestRow />);
    fireEvent.click(screen.getByLabelText(`${ACCEPT_LABEL} — ada`));
    await waitFor(() => expect(mockAccept).toHaveBeenCalledWith("conn-1"));
    // `POST /social/connections/:id/accept` takes the connection row's uuid. Passing `s-ada` would
    // 404 forever, and both strings are "an id on the request", which is why this is pinned.
    expect(mockDecline).not.toHaveBeenCalled();
  });

  it("removes ONLY the answered request from the store, and refetches behind it", async () => {
    // The refetch NEVER SETTLES here, deliberately. With a mock that resolves, the list this test
    // asserts on could equally have come from the reconciliation — so the assertion would pass
    // against a handler that writes nothing itself, which is precisely the code being pinned.
    mockGetConnections.mockReturnValue(new Promise(() => {}));
    seed([req("conn-1", "ada"), req("conn-2", "grace")]);
    render(<ConnectionRequestRow />);
    fireEvent.click(screen.getByTestId(CONNECTION_REQUEST_TESTID).firstElementChild!);

    fireEvent.click(screen.getByLabelText(`${ACCEPT_LABEL} — ada`));
    await waitFor(() =>
      expect(useSocialStore.getState().incoming.map((r) => r.id)).toEqual(["conn-2"]),
    );
    // …and the reconciliation was still asked for: the optimistic write is a bridge to the
    // server's answer, not a replacement for it.
    expect(mockGetConnections).toHaveBeenCalled();
  });

  it("denies through the DECLINE endpoint — the user's word and the wire's word differ", async () => {
    seed([req("conn-1", "ada")]);
    render(<ConnectionRequestRow />);
    fireEvent.click(screen.getByLabelText(`${DENY_LABEL} — ada`));
    await waitFor(() => expect(mockDecline).toHaveBeenCalledWith("conn-1"));
    expect(mockAccept).not.toHaveBeenCalled();
    await waitFor(() => expect(useSocialStore.getState().incoming).toHaveLength(0));
  });

  it("LEAVES A FAILED DECISION IN PLACE — an unanswered request has not been answered", async () => {
    mockAccept.mockRejectedValue(new Error("boom"));
    seed([req("conn-1", "ada")]);
    render(<ConnectionRequestRow />);
    fireEvent.click(screen.getByLabelText(`${ACCEPT_LABEL} — ada`));
    await waitFor(() => expect(mockAccept).toHaveBeenCalled());
    // Re-enabled (the in-flight latch cleared) AND still listed: telling someone they accepted a
    // stranger they did not accept is the one wrong answer this path can give.
    await waitFor(() =>
      expect((screen.getByTestId(CONNECTION_ACCEPT_TESTID) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(useSocialStore.getState().incoming.map((r) => r.id)).toEqual(["conn-1"]);
  });

  it("disables both buttons for the row with a decision in flight, and only that row", async () => {
    let settle!: () => void;
    mockAccept.mockReturnValue(new Promise<void>((res) => (settle = res)));
    seed([req("conn-1", "ada"), req("conn-2", "grace")]);
    render(<ConnectionRequestRow />);
    fireEvent.click(screen.getByTestId(CONNECTION_REQUEST_TESTID).firstElementChild!);
    fireEvent.click(screen.getByLabelText(`${ACCEPT_LABEL} — ada`));

    const accepts = screen.getAllByTestId(CONNECTION_ACCEPT_TESTID) as HTMLButtonElement[];
    const denies = screen.getAllByTestId(CONNECTION_DENY_TESTID) as HTMLButtonElement[];
    await waitFor(() => expect(accepts[0]!.disabled).toBe(true));
    expect(denies[0]!.disabled).toBe(true);
    // The OTHER person's row is untouched — a single boolean would have frozen it too.
    expect(accepts[1]!.disabled).toBe(false);
    settle();
  });
});

describe("ConnectionRequestRow — it does not borrow the agent inbox", () => {
  it("reads socialStore.incoming, and inboxStore stays empty throughout", async () => {
    seed([req("conn-1", "ada")]);
    render(<ConnectionRequestRow />);
    expect(screen.getByTestId(CONNECTION_REQUEST_TESTID)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(`${ACCEPT_LABEL} — ada`));
    await waitFor(() => expect(mockAccept).toHaveBeenCalled());
    // `inboxStore` is the per-AGENT Rust `inbox_peek` channel. A human asking to connect must never
    // land there: `pendingCount` would then answer for two unrelated things and every agent row in
    // the column would badge a queued instruction that does not exist.
    expect(pendingCount([])).toBe(0);
    const inbox = (await import("../stores/inboxStore")).useInboxStore.getState();
    expect(Object.keys(inbox.byAgent ?? {})).toHaveLength(0);
  });
});

describe("ConnectionRequestRow — the poll is gated on having a handle", () => {
  it("does not poll for an account with no social identity", async () => {
    vi.useFakeTimers();
    try {
      seed([req("conn-1", "ada")], false);
      render(<ConnectionRequestRow />);
      vi.advanceTimersByTime(180_000);
      // Every `/social/*` path 404s without a row server-side, so a poll here is a request a minute
      // for a route with nothing to say.
      expect(mockGetConnections).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("polls on the interval once there IS a handle", async () => {
    vi.useFakeTimers();
    try {
      seed([req("conn-1", "ada")], true);
      render(<ConnectionRequestRow />);
      expect(mockGetConnections).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60_000);
      expect(mockGetConnections).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
