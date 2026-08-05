// @vitest-environment jsdom
//
// THE REMEDY HAS TO BE REACHABLE. The auth headline says "sign in again" — a remedy string is an
// instruction the user will follow (AGENTS.md), so a bubble that says it without offering it puts
// the user exactly where the founder was: told what to do, with no way to do it. These pin that the
// control exists on an auth failure, is ABSENT on every other failure, and actually publishes the
// signal the gate listens for.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConciergeMessageRow, FAILURE_REAUTH_TESTID } from "./ConciergeMessageRow";
import {
  onClaudeAuthFailed,
  resetClaudeAuthSignalForTests,
} from "../../services/claudeAuthSignal";
import type { ConciergeMessage } from "./types";

const noop = () => {};

function renderFailure(over: Partial<ConciergeMessage> = {}) {
  const message = {
    id: "err-1",
    kind: "failure",
    headline: "Your Claude sign-in has expired",
    evidence: "Failed to authenticate: OAuth session expired and could not be refreshed",
    ...over,
  } as ConciergeMessage;
  return render(
    <ConciergeMessageRow
      message={message}
      wired={false}
      shownAsText={false}
      onOpenPayload={noop}
      onNudgeClick={noop}
      onNudgeAction={noop}
      onAnswerCopied={noop}
      onMessageCopied={noop}
    />,
  );
}

beforeEach(() => resetClaudeAuthSignalForTests());
afterEach(() => cleanup());

describe("concierge failure bubble — in-place re-authentication", () => {
  it("offers Sign in to Claude when the failure was an auth failure", () => {
    renderFailure({ canReauth: true } as Partial<ConciergeMessage>);
    expect(screen.getByTestId(FAILURE_REAUTH_TESTID)).toBeTruthy();
  });

  // A quota failure must NOT offer sign-in: the credential is fine, and re-authenticating would not
  // clear a spend limit. Offering it there would send the user down a path that cannot work — the
  // same class of wrong advice as "try me again in a moment".
  it("does NOT offer it on a failure that is not about credentials", () => {
    renderFailure({
      headline: "Your Claude plan is out of room",
      evidence: "You've hit your session limit · resets 8:40am",
    });
    expect(screen.queryByTestId(FAILURE_REAUTH_TESTID)).toBeNull();
  });

  // The click has to reach the gate. Asserting the SIDE EFFECT (a subscriber fired), not that a
  // handler prop was called — the button wires itself to the module, so a test asserting its own
  // mock would prove nothing about whether the gate ever hears it.
  it("clicking it publishes to the auth signal the gate subscribes to", () => {
    const heard = vi.fn();
    onClaudeAuthFailed(heard);
    renderFailure({ canReauth: true } as Partial<ConciergeMessage>);
    expect(heard).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(FAILURE_REAUTH_TESTID));
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
