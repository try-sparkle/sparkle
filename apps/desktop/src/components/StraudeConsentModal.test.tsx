// @vitest-environment jsdom
//
// The straude consent + sign-in modal. The behavior under test is the CONSENT CONTRACT, because
// this is the second Sparkle feature that publishes something about the user:
//   • dismissing without confirming publishes nothing and leaves the toggle alone;
//   • Confirm is blocked until the user has actually signed in;
//   • Confirm records consent + the device label, THEN turns the flag on;
//   • the disclosure names everything that leaves the machine — and nothing it does not.
// The Rust commands and configActions are mocked (no IPC); the settingsStore is the real one.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/configActions", () => ({
  setToolEnabled: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/straude", () => ({
  STRAUDE_URL: "https://straude.com",
  straudeStatus: vi.fn(),
  straudeLoginBegin: vi.fn(),
  straudeLoginPoll: vi.fn(),
  straudeConsent: vi.fn().mockResolvedValue(undefined),
  forgetStraude: vi.fn().mockResolvedValue(undefined),
  straudeReportNow: vi.fn(),
}));

import { setToolEnabled } from "../services/configActions";
import {
  forgetStraude,
  straudeConsent,
  straudeLoginBegin,
  straudeLoginPoll,
  straudeReportNow,
  straudeStatus,
  type StraudeStatus,
} from "../services/straude";
import { useSettingsStore } from "../stores/settingsStore";
import { StraudeConsentModal } from "./StraudeConsentModal";

const EMPTY_STATUS: StraudeStatus = {
  enabled: false,
  username: "",
  hasToken: false,
  consented: false,
  deviceId: "",
  deviceName: "Sparkle",
  reportDays: 7,
  lastReportAt: null,
  lastStatus: null,
  blockedBy: "straude reporting is off",
  blockedCode: "disabled",
  expiresInDays: null,
  expired: false,
  serverUrl: "https://straude.com",
};

const SIGNED_IN_STATUS: StraudeStatus = {
  ...EMPTY_STATUS,
  hasToken: true,
  username: "drodio",
  deviceId: "abc-123",
  blockedBy: "waiting for consent",
  blockedCode: "no_consent",
};

const CONFIGURED_STATUS: StraudeStatus = {
  ...SIGNED_IN_STATUS,
  enabled: true,
  consented: true,
  lastStatus: "Reported 7 day(s).",
  blockedBy: null,
  blockedCode: null,
};

beforeEach(() => {
  useSettingsStore.setState({ straudeModalOpen: true, straudeEnabled: false });
  vi.mocked(straudeStatus).mockResolvedValue(EMPTY_STATUS);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const title = "Publish your token totals to Straude?";

describe("StraudeConsentModal — the disclosure", () => {
  // This screen is the ONLY thing the user reads before consenting, so a field the reporter starts
  // sending has to appear here in the SAME change. These pin the DISTINGUISHING words rather than
  // whole sentences, so the copy can be reworded without a false red.
  it("itemizes exactly what is published, and what never is", async () => {
    render(<StraudeConsentModal />);
    await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
    expect(screen.getByText(/input \/ output \/ cache token counts/)).toBeTruthy();
    expect(screen.getByText(/names of the models you used/)).toBeTruthy();
    expect(
      screen.getByText(/Never your code, prompts, file paths, project names, or API keys\./),
    ).toBeTruthy();
  });

  // The load-bearing one. `device_name` is the only field in the payload that can carry personal
  // identity, and the whole reason Sparkle sends a constant is that a Mac's default machine name is
  // commonly its owner's real name. If a later change starts sending the hostname, this copy has to
  // change with it — and this test is what makes that loud.
  it("says the device label defaults to a constant and the real machine name is not sent", async () => {
    render(<StraudeConsentModal />);
    const row = await screen.findByText(/A per-machine id, and a device label/);
    expect(row.textContent).toMatch(/Sparkle/);
    expect(row.textContent).toMatch(/real name is never sent/i);
  });

  // The consequence a user is most likely to be surprised by, and it is NOT about data leaving the
  // machine — so it gets its own line rather than hiding in the list.
  it("states plainly that reporting creates a public post", async () => {
    render(<StraudeConsentModal />);
    const row = await screen.findByText(/becomes a public post on straude\.com/);
    expect(row.textContent).toMatch(/what you spent/i);
    expect(row.textContent).toMatch(/leaderboard/i);
  });

  // MEASURED against the operator's public source: device_usage is owner-scoped, the public model
  // has no device column, and the post title is date + models + cost. The copy must not claim the
  // label is published — that claim was written twice and is false both times.
  it("never claims the device label itself is shown publicly", async () => {
    const { container } = render(<StraudeConsentModal />);
    await waitFor(() => expect(screen.getByText(title)).toBeTruthy());
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/label .{0,40}(published|shown) (on|in) the public/i);
    expect(text).not.toMatch(/your device (name|label) is public/i);
  });

  it("says the two destinations are independent", async () => {
    render(<StraudeConsentModal />);
    const row = await screen.findByText(/separate from the Builder Index/);
    expect(row.textContent).toMatch(/either, both, or neither/i);
  });
});

describe("StraudeConsentModal — the consent contract", () => {
  // NAMED for what it actually pins: the button's DISABLED derivation. `confirm()` also carries a
  // `!signedIn` early return, but that is unreachable belt-and-braces — jsdom (like a browser) does
  // not fire a click handler on a disabled button, so removing it changes nothing observable and a
  // test claiming to cover it would be vacuous. Mutation-checked: dropping the `!signedIn` term
  // from `disabled` turns this red; deleting the early return does not.
  it("the confirm button stays disabled until the user has signed in, and writes nothing", async () => {
    render(<StraudeConsentModal />);
    const confirm = await screen.findByRole("button", { name: "Publish my totals" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(confirm);
    expect(vi.mocked(straudeConsent)).not.toHaveBeenCalled();
    expect(vi.mocked(setToolEnabled)).not.toHaveBeenCalled();
  });

  it("the button becomes enabled once signed in — so the test above is not passing on a dead button", async () => {
    vi.mocked(straudeStatus).mockResolvedValue(SIGNED_IN_STATUS);
    render(<StraudeConsentModal />);
    const confirm = await screen.findByRole("button", { name: "Publish my totals" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
  });

  it("dismissing without confirming publishes nothing and leaves the toggle alone", async () => {
    render(<StraudeConsentModal />);
    fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(vi.mocked(straudeConsent)).not.toHaveBeenCalled();
    expect(vi.mocked(setToolEnabled)).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().straudeModalOpen).toBe(false);
    expect(useSettingsStore.getState().straudeEnabled).toBe(false);
  });

  it("records consent and the device label, THEN turns the flag on", async () => {
    vi.mocked(straudeStatus).mockResolvedValue(SIGNED_IN_STATUS);
    render(<StraudeConsentModal />);
    const confirm = await screen.findByRole("button", { name: "Publish my totals" });
    await waitFor(() => expect((confirm as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(vi.mocked(straudeConsent)).toHaveBeenCalledWith("Sparkle", true));
    expect(vi.mocked(setToolEnabled)).toHaveBeenCalledWith("straude", true);
  });

  it("sends a device label the user typed, rather than the default", async () => {
    // The PAIR to the disclosure test above: proving the field is wired is what stops the
    // "hostname is never sent" assertion passing against a field that never works at all.
    vi.mocked(straudeStatus).mockResolvedValue(SIGNED_IN_STATUS);
    render(<StraudeConsentModal />);
    const input = (await screen.findByLabelText(/Device label/)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Loft Studio  " } });
    fireEvent.click(screen.getByRole("button", { name: "Publish my totals" }));
    await waitFor(() =>
      expect(vi.mocked(straudeConsent)).toHaveBeenCalledWith("Loft Studio", true),
    );
  });

  it("an already-on install gets the manage controls instead of a second consent", async () => {
    useSettingsStore.setState({ straudeEnabled: true });
    vi.mocked(straudeStatus).mockResolvedValue(CONFIGURED_STATUS);
    render(<StraudeConsentModal />);
    expect(await screen.findByRole("button", { name: "Report now" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn off and forget" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Publish my totals" })).toBeNull();
  });

  it("turning off and forgetting clears the flag AND the stored sign-in", async () => {
    useSettingsStore.setState({ straudeEnabled: true });
    vi.mocked(straudeStatus).mockResolvedValue(CONFIGURED_STATUS);
    render(<StraudeConsentModal />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off and forget" }));
    await waitFor(() => expect(vi.mocked(setToolEnabled)).toHaveBeenCalledWith("straude", false));
    expect(vi.mocked(forgetStraude)).toHaveBeenCalled();
  });

  // Keying the label off CONSENT rather than the toggle: a consented user who turned the switch off
  // and re-opened to correct their device label would otherwise see "Save" while confirm() silently
  // turns reporting back on.
  it("admits when saving will also turn reporting back on", async () => {
    useSettingsStore.setState({ straudeEnabled: false });
    vi.mocked(straudeStatus).mockResolvedValue({ ...CONFIGURED_STATUS, enabled: false });
    render(<StraudeConsentModal />);
    expect(await screen.findByRole("button", { name: "Save and turn on" })).toBeTruthy();
  });

  it("says so when the settings cannot be read, instead of showing first-run copy", async () => {
    vi.mocked(straudeStatus).mockRejectedValue(new Error("nope"));
    render(<StraudeConsentModal />);
    expect(await screen.findByText(/Couldn’t read your straude settings/)).toBeTruthy();
  });

  it("warns when the sign-in is close to lapsing", async () => {
    useSettingsStore.setState({ straudeEnabled: true });
    vi.mocked(straudeStatus).mockResolvedValue({ ...CONFIGURED_STATUS, expiresInDays: 3 });
    render(<StraudeConsentModal />);
    expect(await screen.findByText(/expires in 3 day\(s\)/)).toBeTruthy();
  });

  it("says a lapsed sign-in needs signing in again", async () => {
    // Keyed on `expired`, not on `expiresInDays === 0`: those are different facts, and the Rust
    // side gives them separate fields precisely so "expires today" cannot render as "already dead".
    useSettingsStore.setState({ straudeEnabled: true });
    vi.mocked(straudeStatus).mockResolvedValue({ ...CONFIGURED_STATUS, expired: true });
    render(<StraudeConsentModal />);
    expect(await screen.findByText(/has expired — sign in again/)).toBeTruthy();
  });
});

// The browser sign-in is the ONE part of this component that is not a copy of
// BuilderIndexConsentModal, and every consent-contract test above starts from a status where
// hasToken is already true — so the entire loop was unexecuted. That is also why the
// dismiss/reopen defect it shipped with was invisible to the suite.
describe("StraudeConsentModal — the concurrency guard outside sign-in", () => {
  // `signIn` was given a generation token; `confirm`, `reportNow` and `turnOffAndForget` were left
  // guarding on `inFlight` alone. Because `close()` clears that ref, a request that outlived its
  // dialog still ran its `finally` and cleared the flag a NEWER request was holding — so a third
  // request could start on top of a second. These pin the generation gate on the non-sign-in
  // handlers, which is where the interleaving damage is: `turnOffAndForget` deletes the token while
  // `confirm` records consent and turns the flag on.
  beforeEach(() => {
    useSettingsStore.setState({ straudeModalOpen: true, straudeEnabled: true });
    vi.mocked(straudeStatus).mockResolvedValue(CONFIGURED_STATUS);
  });

  it("a report that outlived its dialog cannot clear the flag a later report is holding", async () => {
    let releaseFirst: (v: string) => void = () => {};
    const first = new Promise<string>((r) => {
      releaseFirst = r;
    });
    vi.mocked(straudeReportNow).mockReturnValueOnce(first).mockReturnValue(new Promise(() => {}));

    render(<StraudeConsentModal />);
    fireEvent.click(await screen.findByRole("button", { name: "Report now" }));
    await waitFor(() => expect(vi.mocked(straudeReportNow)).toHaveBeenCalledTimes(1));

    // Dismiss while report A is still in flight, then reopen and start report B.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    useSettingsStore.getState().setStraudeModalOpen(true);
    fireEvent.click(await screen.findByRole("button", { name: "Report now" }));
    await waitFor(() => expect(vi.mocked(straudeReportNow)).toHaveBeenCalledTimes(2));

    // A now finishes. Its `finally` belongs to a retired generation and must NOT release B's guard.
    releaseFirst("Reported 7 day(s).");
    await waitFor(() => expect(vi.mocked(straudeReportNow)).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Report now" }));
    // Three concurrent reports is the failure: each one posts and makes a public post.
    expect(vi.mocked(straudeReportNow)).toHaveBeenCalledTimes(2);
  });

  it("a forget that outlived its dialog cannot close a dialog the user reopened", async () => {
    let releaseForget: () => void = () => {};
    vi.mocked(forgetStraude).mockReturnValueOnce(
      new Promise<void>((r) => {
        releaseForget = () => r();
      }),
    );

    render(<StraudeConsentModal />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn off and forget" }));
    await waitFor(() => expect(vi.mocked(forgetStraude)).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    useSettingsStore.getState().setStraudeModalOpen(true);
    await screen.findByText(title);

    // The credential deletion still completes — that write is deliberately not generation-gated —
    // but it must not yank the reopened dialog shut under the user.
    releaseForget();
    await waitFor(() => expect(vi.mocked(forgetStraude)).toHaveBeenCalledTimes(1));
    expect(useSettingsStore.getState().straudeModalOpen).toBe(true);
  });
});

describe("StraudeConsentModal — the browser sign-in", () => {
  const CHALLENGE = { code: "WXYZ-1234", verifyUrl: "https://straude.com/cli/verify?code=WXYZ-1234" };

  /** Advance the fake clock and let the awaits the loop parks on settle.
   *
   *  One iteration is sleep -> poll -> state write, i.e. a timer AND two microtask hops, so a bare
   *  advance leaves React a render behind. The trailing zero-advance is what flushes it. */
  const tick = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
  };

  beforeEach(() => {
    vi.mocked(straudeLoginBegin).mockResolvedValue(CHALLENGE);
    vi.stubGlobal("open", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the device code so the user can confirm they are approving THIS machine", async () => {
    vi.mocked(straudeLoginPoll).mockResolvedValue(null);
    render(<StraudeConsentModal />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Straude" }));
    expect(await screen.findByText(CHALLENGE.code)).toBeTruthy();
    // The whole point of showing it: the instruction to CHECK it has to travel with the code.
    expect(screen.getByText(/Check the code matches/)).toBeTruthy();
    // Retire the poll loop before leaving. These three run on REAL timers, and nothing else stops
    // the loop — unmount does not bump the generation — so without this each test leaks a loop that
    // keeps calling straudeLoginPoll every 3s for the full ten-minute budget, outliving the test.
    // The exact-count assertions in the fake-timer tests below then see the orphans' calls.
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  });

  it("opens the verify URL in a new tab with noopener", async () => {
    vi.mocked(straudeLoginPoll).mockResolvedValue(null);
    render(<StraudeConsentModal />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to Straude" }));
    await waitFor(() => expect(vi.mocked(straudeLoginBegin)).toHaveBeenCalled());
    expect(window.open).toHaveBeenCalledWith(CHALLENGE.verifyUrl, "_blank", "noopener,noreferrer");
    // Retire the poll loop before leaving. These three run on REAL timers, and nothing else stops
    // the loop — unmount does not bump the generation — so without this each test leaks a loop that
    // keeps calling straudeLoginPoll every 3s for the full ten-minute budget, outliving the test.
    // The exact-count assertions in the fake-timer tests below then see the orphans' calls.
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  });

  it("keeps waiting through a null poll, then completes on a username", async () => {
    // FAKE TIMERS: the loop sleeps LOGIN_POLL_MS (3s) between polls, so driving it in real time
    // costs tens of seconds in a suite of 22k tests. Advancing the clock makes it deterministic
    // and instant — and lets the expiry test below reach a ten-minute deadline at all.
    vi.useFakeTimers();
    try {
      // `null` means "not approved yet", NOT an error — the loop has to keep going.
      vi.mocked(straudeLoginPoll).mockResolvedValueOnce(null).mockResolvedValue("drodio");
      vi.mocked(straudeStatus).mockResolvedValueOnce(EMPTY_STATUS).mockResolvedValue(SIGNED_IN_STATUS);

      render(<StraudeConsentModal />);
      await vi.advanceTimersByTimeAsync(0);
      fireEvent.click(screen.getByRole("button", { name: "Sign in to Straude" }));
      await tick(0);
      expect(screen.getByText(CHALLENGE.code)).toBeTruthy();

      // Two poll intervals: the first answers null, the second the username.
      await tick(3000);
      expect(vi.mocked(straudeLoginPoll)).toHaveBeenCalledTimes(1);
      // Still waiting — a null poll is "not approved yet", not an error, so the code stays up.
      expect(screen.getByText(CHALLENGE.code)).toBeTruthy();

      await tick(3000);
      expect(vi.mocked(straudeLoginPoll).mock.calls.length).toBeGreaterThanOrEqual(2);
      // The challenge is cleared once spent, so a stale code is never left on screen.
      expect(screen.queryByText(CHALLENGE.code)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up with a readable message once the sign-in window has expired", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(straudeLoginPoll).mockResolvedValue(null);
      render(<StraudeConsentModal />);
      await tick(0);
      fireEvent.click(screen.getByRole("button", { name: "Sign in to Straude" }));
      await tick(0);

      // Past the ten-minute deadline the server itself enforces. Advanced in poll-sized steps
      // because the loop only re-checks the deadline once per iteration.
      for (let i = 0; i < 205; i++) await tick(3000);
      expect(screen.getByText(/sign-in expired before it was approved/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a second click during an in-flight sign-in does not start a second one", async () => {
    vi.mocked(straudeLoginPoll).mockResolvedValue(null);
    render(<StraudeConsentModal />);
    const btn = await screen.findByRole("button", { name: "Sign in to Straude" });
    fireEvent.click(btn);
    await waitFor(() => expect(vi.mocked(straudeLoginBegin)).toHaveBeenCalledTimes(1));
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(vi.mocked(straudeLoginBegin)).toHaveBeenCalledTimes(1);
    // Retire the poll loop before leaving. These three run on REAL timers, and nothing else stops
    // the loop — unmount does not bump the generation — so without this each test leaks a loop that
    // keeps calling straudeLoginPoll every 3s for the full ten-minute budget, outliving the test.
    // The exact-count assertions in the fake-timer tests below then see the orphans' calls.
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  });

  // THE DEFECT THIS SUITE EXISTS FOR. Dismissing while the poll loop is parked, then reopening,
  // used to resurrect the orphaned loop's cancellation flag — leaving `inFlight` pinned true for
  // the rest of its ten-minute budget while `busy` was cleared, so every button rendered ENABLED
  // and silently did nothing.
  it("dismissing and reopening leaves the dialog able to act again", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(straudeLoginPoll).mockResolvedValue(null);
      render(<StraudeConsentModal />);
      await tick(0);
      fireEvent.click(screen.getByRole("button", { name: "Sign in to Straude" }));
      await tick(0);
      expect(vi.mocked(straudeLoginBegin)).toHaveBeenCalledTimes(1);

      // Dismiss while the loop is parked in its sleep, then reopen before it settles.
      fireEvent.click(screen.getByRole("button", { name: "Not now" }));
      useSettingsStore.getState().setStraudeModalOpen(true);
      await tick(0);

      // A fresh sign-in must actually START. Under the old resurrectable boolean this click was
      // swallowed by the orphaned loop's `inFlight`, with every button rendering enabled.
      fireEvent.click(screen.getByRole("button", { name: "Sign in to Straude" }));
      await tick(0);
      expect(vi.mocked(straudeLoginBegin)).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
