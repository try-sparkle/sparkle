// @vitest-environment jsdom
//
// The END-TO-END claim, and the reason this file exists at all: a human clicking Approve in the
// column is what makes an ask-tier tool call succeed. Every layer is covered on its own; this is
// the one test that walks the whole path — policy says `ask`, the prompt appears, and a click
// RUNS THE CALL.
//
// That last clause is the point. It used to read "…and the retry's policy decision comes back
// approved", which was true and yet the feature was broken: approving recorded a grant and
// dispatched nothing, so unless the human separately typed "go ahead" within five minutes AND the
// model retyped every argument byte-identically, the approved call simply never ran. The suite
// passed throughout, because it asserted the grant and never the dispatch. So the first test below
// asserts the dispatch.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useAuthStore } from "../../stores/authStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { configuredToolPolicy } from "../../services/conciergeTools/policyBinding";
import { clearConciergeApprovals, findApproval } from "../../stores/conciergeApprovals";
import { useConciergeThreadStore } from "../../stores/conciergeThreadStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { ConciergeApprovals } from "./ConciergeApprovals";

// The concierge's AI-enhancements gate (bead sparkle-4562) is a real precondition for a turn and
// for every tool call, so these suites — which test the mechanics, not the entitlement — open it
// explicitly. `aiGate.concierge.test.ts` is where the gate's own behaviour is asserted.
function openConciergeAiGate() {
  useSettingsStore.setState({ aiConcierge: true });
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
    creditFloorCents: 0,
  } as never);
}

const setPolicyMock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../services/configActions", () => ({
  setConciergeToolPolicy: (...a: unknown[]) => setPolicyMock(...(a as [])),
}));

// Only the DISPATCH is faked. The policy binding, the ledger and the resume service are all real,
// so what this asserts is the actual authority path a replay takes — not a rehearsal of it.
const dispatchMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/conciergeTools/registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/conciergeTools/registry")>()),
  dispatchConciergeTool: (...a: unknown[]) => dispatchMock(...(a as [])),
}));

/**
 * A stand-in for `dispatchConciergeTool` that CONSULTS THE POLICY the way the real registry does
 * (registry.ts: `const decision = policy({...})` before any handler runs), then returns `reply`.
 *
 * Faking the dispatch without the policy call would quietly break the chain this file is about: the
 * approval is spent inside that consultation, so a fake that skips it would show a grant surviving
 * a run that in production consumes it — a test passing on a fiction.
 */
const registryLike =
  (reply: unknown) =>
  async (
    call: { domain: string; op: string; args: unknown; toolCallId: string },
    opts: { policy: (q: unknown) => unknown },
  ) => {
    opts.policy({
      domain: call.domain,
      op: call.op,
      write: true,
      toolCallId: call.toolCallId,
      args: call.args,
    });
    return reply;
  };

/** The receipts the click wrote into the visible thread. Narrowed to `sparkle` because that is the
 *  kind the receipt is posted as — and because not every `ConciergeMessage` carries `text`. */
const sparkleTexts = (): string[] =>
  useConciergeThreadStore
    .getState()
    .chat.filter((m): m is Extract<typeof m, { kind: "sparkle" }> => m.kind === "sparkle")
    .map((m) => m.text);

const query = (toolCallId: string, args: unknown = { projectId: "p1" }) => ({
  domain: "workspace" as const,
  op: "remove_project",
  write: true,
  toolCallId,
  args,
});

beforeEach(() => {
  openConciergeAiGate();
  clearConciergeApprovals();
  useConciergeThreadStore.setState({ chat: [] });
  useSettingsStore.setState({ conciergeToolPolicy: {} });
  setPolicyMock.mockClear();
  dispatchMock.mockReset();
  dispatchMock.mockImplementation(
    registryLike({ ok: true, domain: "workspace", op: "remove_project", data: {} }),
  );
});
afterEach(() => cleanup());

describe("ConciergeApprovals — the round-trip through a human", () => {
  it("shows nothing while nothing is pending", () => {
    const { container } = render(<ConciergeApprovals />);
    expect(container.innerHTML).toBe("");
  });

  it("surfaces a call the policy stopped, and APPROVING IT RUNS IT", async () => {
    // 1. The concierge tries something the human marked (or the risk map defaults to) "ask first".
    expect(configuredToolPolicy(query("call-1"))).toEqual({ tier: "ask", approvedByUser: false });

    // 2. The question is on the human's screen, naming the tool and what it would act on.
    render(<ConciergeApprovals />);
    expect(screen.getByTestId("approval-card").getAttribute("data-op")).toBe("remove_project");
    expect(screen.getByText("workspace.remove_project")).toBeTruthy();

    // 3. The human says yes. THIS is the gesture — nothing in the tool path can stand in for it.
    fireEvent.click(screen.getByLabelText("Approve workspace.remove_project"));
    expect(findApproval("call-1")?.outcome).toBe("approved");

    // 4. …and the call actually goes out, with the arguments the human was shown, under the id the
    //    approval was given for. THE ASSERTION THE OLD SUITE WAS MISSING.
    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    const [call, opts] = dispatchMock.mock.calls[0] as [
      { domain: string; op: string; args: unknown; toolCallId: string },
      { policy: unknown },
    ];
    expect(call).toEqual({
      domain: "workspace",
      op: "remove_project",
      args: { projectId: "p1" },
      toolCallId: "call-1",
    });
    // Gated by the real policy, so the replay is authorised by the ledger and not by being trusted.
    expect(opts.policy).toBe(configuredToolPolicy);
  });

  it("spends the grant by RUNNING it, so it can't also be redeemed by a later retry", async () => {
    configuredToolPolicy(query("call-1"));
    render(<ConciergeApprovals />);
    fireEvent.click(screen.getByLabelText("Approve workspace.remove_project"));
    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));

    // Single-use is unchanged, and now it is the RUN that consumes it. The grant cannot be redeemed
    // a second time under any tier — approving once ran it exactly once. (Which refusal it gets is
    // the next test's business; what matters here is that it is not authority.)
    const retry = configuredToolPolicy(query("call-2-fresh"));
    expect(retry).not.toMatchObject({ approvedByUser: true });
    expect(retry.tier).not.toBe("allow");
  });

  it("tells the human it ran, rather than leaving the card to vanish in silence", async () => {
    configuredToolPolicy(query("call-1"));
    render(<ConciergeApprovals />);
    fireEvent.click(screen.getByLabelText("Approve workspace.remove_project"));

    await waitFor(() => {
      const texts = sparkleTexts();
      expect(texts).toContain("Approved and ran workspace.remove_project.");
    });
  });

  it("reports a tool that refused, instead of implying it worked", async () => {
    dispatchMock.mockImplementation(
      registryLike({
        ok: false,
        domain: "workspace",
        op: "remove_project",
        code: "unknown-project",
        message: "There's no project with that id.",
      }),
    );
    configuredToolPolicy(query("call-1"));
    render(<ConciergeApprovals />);
    fireEvent.click(screen.getByLabelText("Approve workspace.remove_project"));

    await waitFor(() => {
      const texts = sparkleTexts();
      expect(texts.some((t) => t.includes("There's no project with that id."))).toBe(true);
    });
  });

  it("WARNS on a model retry of a call the click already ran, instead of asking as if it were new", async () => {
    // The duplicate-run path. The model's turn ended in a refusal, so it never learns the click ran
    // anything; a human who says "go ahead" makes it call again. The second card must not be
    // indistinguishable from the first — that is how the same brief gets typed in twice.
    configuredToolPolicy(query("call-1"));
    render(<ConciergeApprovals />);
    fireEvent.click(screen.getByLabelText("Approve workspace.remove_project"));
    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));

    configuredToolPolicy(query("call-2-fresh"));
    const note = await screen.findByTestId("approval-ran-recently");
    expect(note.textContent).toContain("already ran a moment ago");
  });

  it("shows ONE card when the same call is asked about twice before anyone answers", async () => {
    // Ids are minted per call, so a model refused once and retrying before a click would otherwise
    // put two identical cards up — and `claimApproval` authorises each by id, so approving both
    // would run the op TWICE. One live question per identity (roborev 54729, finding 2).
    configuredToolPolicy(query("call-1"));
    configuredToolPolicy(query("call-2"));
    render(<ConciergeApprovals />);

    expect(screen.getAllByTestId("approval-card")).toHaveLength(1);
    fireEvent.click(screen.getByLabelText("Approve workspace.remove_project"));
    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
    // And answering it clears the question entirely — there is no second card behind it.
    expect(screen.queryByTestId("approval-card")).toBeNull();
  });

  it("does not warn on a FIRST request — the note means something", async () => {
    configuredToolPolicy(query("call-1"));
    render(<ConciergeApprovals />);
    expect(screen.getByTestId("approval-card")).toBeTruthy();
    expect(screen.queryByTestId("approval-ran-recently")).toBeNull();
  });

  it("still asks about a DIFFERENT call, so the guard de-duplicates rather than locks out", async () => {
    configuredToolPolicy(query("call-1", { projectId: "p1" }));
    render(<ConciergeApprovals />);
    fireEvent.click(screen.getByLabelText("Approve workspace.remove_project"));
    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));

    // Same op, different target — a genuinely different intention, and still asked about with no
    // "already ran" warning, because it hasn't.
    expect(configuredToolPolicy(query("call-2", { projectId: "p2" }))).toEqual({
      tier: "ask",
      approvedByUser: false,
    });
    // findBy, not getBy: the policy call writes to the ledger outside React's act, so the column
    // re-renders on the next flush rather than synchronously.
    expect(await screen.findByTestId("approval-card")).toBeTruthy();
    expect(screen.queryByTestId("approval-ran-recently")).toBeNull();
  });

  it("says so when a LAPSED card is clicked, rather than vanishing in silence", async () => {
    // Reachable for real: `pending` only recomputes on a ledger write or the 10s expiry tick, so a
    // card whose window closed stays clickable for up to ten seconds. A quiet return here would
    // rebuild the very bug this file is about.
    vi.useFakeTimers();
    try {
      configuredToolPolicy(query("call-1"));
      render(<ConciergeApprovals />);
      // Past APPROVAL_REQUEST_TTL_MS (10 min) but before the tick re-renders the list away.
      vi.setSystemTime(Date.now() + 11 * 60_000);
      fireEvent.click(screen.getByLabelText("Approve workspace.remove_project"));
    } finally {
      vi.useRealTimers();
    }

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(sparkleTexts().some((t) => t.includes("had already lapsed"))).toBe(true);
  });

  it("declining leaves the tool refused, takes the card away, and dispatches NOTHING", () => {
    configuredToolPolicy(query("call-1"));
    render(<ConciergeApprovals />);
    fireEvent.click(screen.getByLabelText("Decline workspace.remove_project"));
    expect(findApproval("call-1")?.outcome).toBe("denied");
    expect(screen.queryByTestId("approval-card")).toBeNull();
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(configuredToolPolicy(query("call-2"))).toEqual({ tier: "ask", approvedByUser: false });
  });

  it("'always allow' writes the SETTINGS override, not an invisible session grant", async () => {
    configuredToolPolicy(query("call-1"));
    render(<ConciergeApprovals />);
    fireEvent.click(screen.getByLabelText("Always allow remove_project without asking"));
    // Visible and revocable in Settings → Concierge tools, which is the whole constraint: a
    // standing permission the human cannot find is a standing permission they cannot take back.
    expect(setPolicyMock).toHaveBeenCalledWith("remove_project", "allow");
    // …and it also answers the call in hand, so the one button that means "yes, and stop asking"
    // does not leave the thing you were asked about still blocked — it RUNS it, same as Approve.
    expect(findApproval("call-1")?.outcome).toBe("approved");
    await waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));
  });

  it("stacks a second request rather than replacing the first", () => {
    configuredToolPolicy(query("call-1", { projectId: "p1" }));
    configuredToolPolicy(query("call-2", { projectId: "p2" }));
    render(<ConciergeApprovals />);
    expect(screen.getAllByTestId("approval-card")).toHaveLength(2);
  });

  it("never renders a resolved request", () => {
    configuredToolPolicy(query("call-1"));
    render(<ConciergeApprovals />);
    fireEvent.click(screen.getByLabelText("Approve workspace.remove_project"));
    expect(screen.queryByTestId("approval-card")).toBeNull();
  });
});
