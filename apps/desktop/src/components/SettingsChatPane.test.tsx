// @vitest-environment jsdom
//
// The Chat settings pane — the ONE surface that can put a row in `sparkle_user_profiles`. Every
// assertion here is on a SIDE EFFECT (a call that went out, the store that ended up holding a
// value, the words that got painted), never on a precondition that was already true before the
// pane existed. Two of them are shaped specifically against the vacuous forms this repo keeps
// producing:
//
//   • "choosing Unavailable saves it" seeds the store to `public` FIRST. `unavailable` is the
//     store's own default, so asserting it after the click without seeding would pass against a
//     pane that does nothing at all.
//   • "409 taken" and "409 username_immutable" are asserted as DIFFERENT text. They share a status,
//     so a single test that accepts either would go green against a mapping that branches on status
//     alone — the exact bug the remedy table exists to prevent.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PARTIAL mock (spreads the real module) so the error CLASSES stay real — the pane branches with
// `instanceof`, and an exhaustive factory would replace them with undefined and make every branch
// unreachable while the suite still looked green.
vi.mock("../services/socialApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/socialApi")>()),
  getUser: vi.fn(),
  getMyProfile: vi.fn(),
  putUsername: vi.fn(),
  putVisibility: vi.fn(),
}));

// The roster loop, mocked so the CALL SITE can be asserted. Without this the save tests fired the
// real `resumeSocialSync()` as an untracked floating promise — harmless only by accident (jsdom's
// `hasToken()` fails closed), and nothing pinned that `save()` calls it at all: deleting the line
// left every suite green while the "stuck until restart" bug returned in full (roborev 60450).
vi.mock("../services/socialSync", () => ({ resumeSocialSync: vi.fn() }));

import { resumeSocialSync } from "../services/socialSync";
import {
  getMyProfile,
  getUser,
  putUsername,
  putVisibility,
  SocialApiError,
  SocialNetworkError,
  type MyProfileResponse,
  type PublicProfile,
} from "../services/socialApi";
import { useSocialStore, EMPTY_PROFILE } from "../stores/socialStore";
import { useAuthStore } from "../stores/authStore";
import type { Visibility } from "../engine/social";
import {
  claimRemedy,
  SettingsChatPane,
  USERNAME_CHECK_DEBOUNCE_MS,
  visibilityRemedy,
} from "./SettingsChatPane";

/** A promise a test resolves by hand — the only way to control REPLY order independently of
 *  REQUEST order, which is the whole subject of the stale-response test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const profile = (username: string): PublicProfile => ({
  socialId: "social-1",
  username,
  displayName: null,
  online: false,
});

const typeUsername = (value: string) =>
  fireEvent.change(screen.getByTestId("chat-username-input"), { target: { value } });

const clickSave = () => fireEvent.click(screen.getByTestId("chat-username-save"));

const checkState = () => screen.getByTestId("chat-username-check").getAttribute("data-check");

const radio = (value: string) => screen.getByTestId(`chat-visibility-${value}`) as HTMLInputElement;

const gateLine = () => screen.queryByTestId("chat-availability-gate")?.textContent ?? null;

/** The state a user who HOLDS a handle is in: the availability group's precondition is satisfied,
 *  so the radios are live. Every pre-existing availability test needs this now — before the gate
 *  landed, `EMPTY_PROFILE` was enough, and that is exactly the state the founder said must not
 *  offer these controls. */
const seedClaimed = (visibility: "public" | "connections" | "unavailable" = "unavailable") =>
  useSocialStore.setState({
    me: { ...EMPTY_PROFILE, username: "ada_l", socialId: "social-1", visibility },
    profileLoaded: true,
    visibilityConfirmed: false,
  });

/** A bare HTTP status anywhere in user-visible copy. Bounded to 1xx–5xx and fenced by digit
 *  boundaries so ordinary numbers in the copy ("At most 30", "At least 3") are not false hits. */
const BARE_HTTP_STATUS = /(?<!\d)[1-5]\d{2}(?!\d)/;

beforeEach(() => {
  // `visibilityConfirmed` too: it is store state that outlives a test. It has no production reader
  // today (see its docstring — it is parked for U1's /me hydration), so the assertions on it below
  // pin the STORE's contract rather than anything a user can see; `me.visibility`, reset on the
  // same line, is the observable half and is what the radio renders from.
  //
  // `profileLoaded: true` is the DEFAULT here so the pane's one hydration call does not fire in
  // every unrelated test — the tests that are about hydration set it false themselves. It also
  // resets the flag between tests: it is store state, `setMyProfile` raises it, and a test that
  // claimed a username would otherwise leave the next one starting from "already looked".
  useSocialStore.setState({ me: EMPTY_PROFILE, visibilityConfirmed: false, profileLoaded: true });
  useAuthStore.setState({ me: null, tokenPresent: true, loading: false });
  vi.mocked(getUser).mockRejectedValue(new SocialApiError(404, null));
  // 404 = "no social identity", the normal answer for a user who has not claimed one (see
  // `getMyProfile`'s docstring). Never an unmocked call: this pane asks on mount, and the real one
  // would reach for a Tauri bearer and then the network from inside jsdom.
  vi.mocked(getMyProfile).mockRejectedValue(new SocialApiError(404, null));
  vi.mocked(putUsername).mockResolvedValue(profile("ada_l"));
  vi.mocked(putVisibility).mockResolvedValue({ visibility: "public" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("SettingsChatPane — claiming a username", () => {
  it("claims a valid username: putUsername is called and the STORE ends up holding it", async () => {
    vi.mocked(putUsername).mockResolvedValue(profile("ada_l"));
    render(<SettingsChatPane />);

    typeUsername("Ada_L");
    clickSave();

    // The call went out with what the user typed (case preserved — the lowercase key is the
    // server's index, not the client's business).
    await waitFor(() => expect(putUsername).toHaveBeenCalledWith("Ada_L"));
    // …and the REST OF THE APP can see it. This is the side effect that matters: without the
    // setMyProfile the request would still have been sent and the feature would still be broken.
    await waitFor(() => expect(useSocialStore.getState().me.username).toBe("ada_l"));
    expect(useSocialStore.getState().me.socialId).toBe("social-1");
  });

  it("a name that fails the LOCAL format check never reaches the network at all", async () => {
    render(<SettingsChatPane />);

    typeUsername("ab"); // one under USERNAME_MIN_LENGTH
    clickSave();

    // Neither the advisory probe nor the commit. The Save button is deliberately NOT disabled for
    // an invalid draft, so this exercises the handler's own guard rather than a greyed-out button
    // (which would prove nothing about the code path).
    await waitFor(() => expect(checkState()).toBe("invalid"));
    expect(getUser).not.toHaveBeenCalled();
    expect(putUsername).not.toHaveBeenCalled();
    expect(screen.getByTestId("chat-username-check").textContent).toContain("At least 3");
  });

  it("a non-ASCII name is refused locally with its OWN remedy, and stays off the network", async () => {
    render(<SettingsChatPane />);
    typeUsername("аdalovelace"); // leading Cyrillic а — the homoglyph class §6.1 rejects outright
    await waitFor(() => expect(checkState()).toBe("invalid"));
    expect(screen.getByTestId("chat-username-check").textContent).toContain("no accents");
    expect(getUser).not.toHaveBeenCalled();
  });

  // THE ORDERING GUARD. Two probes in flight, replies arriving in the OPPOSITE order to the
  // requests. Without the sequence number the first name's verdict paints over the second name's
  // and the field lies about the word currently in it.
  it("drops a STALE probe reply: the painted state follows the LAST request, not the last reply", async () => {
    vi.useFakeTimers();
    const first = deferred<never>(); // "alice" — will answer 200 (taken), LAST
    const second = deferred<never>(); // "bobbie" — will answer 404 (looks free), FIRST
    vi.mocked(getUser)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    render(<SettingsChatPane />);

    await act(async () => {
      typeUsername("alice");
    });
    await act(async () => {
      vi.advanceTimersByTime(USERNAME_CHECK_DEBOUNCE_MS);
    });
    await act(async () => {
      typeUsername("bobbie");
    });
    await act(async () => {
      vi.advanceTimersByTime(USERNAME_CHECK_DEBOUNCE_MS);
    });
    expect(getUser).toHaveBeenCalledTimes(2);
    expect(getUser).toHaveBeenNthCalledWith(1, "alice");
    expect(getUser).toHaveBeenNthCalledWith(2, "bobbie");

    // The NEWER request answers first: "bobbie" looks free.
    await act(async () => {
      second.reject(new SocialApiError(404, null));
      await Promise.resolve();
    });
    expect(checkState()).toBe("available");

    // …then the OLDER one lands, saying "alice" is taken. It must be dropped: the field says
    // "bobbie" and nothing about alice is true of it.
    await act(async () => {
      first.resolve(undefined as never);
      await Promise.resolve();
    });
    expect(checkState()).toBe("available");
    expect(screen.getByTestId("chat-username-check").textContent).not.toContain("Already taken");
  });

  // THE OTHER HALF, and it is a separate test because the two verdicts arrive down DIFFERENT paths:
  // a 200 resolves the promise, every other answer REJECTS it. A stale-reply guard on only one of
  // them leaves the other free to paint over the current name — and a mutation run proved exactly
  // that: removing the guard from the rejection path left the test above green.
  it("drops a stale probe REJECTION too, not just a stale success", async () => {
    vi.useFakeTimers();
    const first = deferred<never>(); // "alice" — will answer 404 (looks free), LAST
    const second = deferred<never>(); // "bobbie" — will answer 200 (taken), FIRST
    vi.mocked(getUser)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    render(<SettingsChatPane />);
    await act(async () => {
      typeUsername("alice");
    });
    await act(async () => {
      vi.advanceTimersByTime(USERNAME_CHECK_DEBOUNCE_MS);
    });
    await act(async () => {
      typeUsername("bobbie");
    });
    await act(async () => {
      vi.advanceTimersByTime(USERNAME_CHECK_DEBOUNCE_MS);
    });

    await act(async () => {
      second.resolve(undefined as never);
      await Promise.resolve();
    });
    expect(checkState()).toBe("taken");

    // "alice" was free. The field says "bobbie", which is not — so a late 404 must NOT relabel it.
    await act(async () => {
      first.reject(new SocialApiError(404, null));
      await Promise.resolve();
    });
    expect(checkState()).toBe("taken");
    expect(screen.getByTestId("chat-username-check").textContent).not.toContain("Looks free");
  });

  // RETREATING FROM A NAME IS ALSO "the field moved on", and these are the two ways to do it that
  // start no new request — which is exactly why they were unguarded: the sequence bump used to sit
  // AFTER the early returns, so it only fired for a draft that was itself probe-worthy. Both leave
  // a live reply pointing at a name the user has already abandoned (roborev 60396).
  const retreat = async (from: string, to: string) => {
    vi.useFakeTimers();
    const inflight = deferred<never>();
    vi.mocked(getUser).mockImplementationOnce(() => inflight.promise);
    render(<SettingsChatPane />);
    await act(async () => {
      typeUsername(from);
    });
    await act(async () => {
      vi.advanceTimersByTime(USERNAME_CHECK_DEBOUNCE_MS);
    });
    expect(getUser).toHaveBeenCalledTimes(1);
    await act(async () => {
      typeUsername(to);
    });
    // The probe for `from` now answers "taken" — late, and about a name that is no longer there.
    await act(async () => {
      inflight.resolve(undefined as never);
      await Promise.resolve();
    });
  };

  it("a probe reply that lands after the field was CLEARED does not paint on the empty field", async () => {
    await retreat("alice", "");
    // Nothing at all: an empty field has no verdict, and "Already taken" over an empty box is the
    // worst version of this bug because there is no name on screen the message could be about.
    expect(screen.queryByTestId("chat-username-check")).toBeNull();
  });

  it("a probe reply that lands after the draft went INVALID does not replace the format remedy", async () => {
    await retreat("alice", "alice_"); // trailing underscore — locally invalid, so no new probe
    expect(checkState()).toBe("invalid");
    expect(screen.getByTestId("chat-username-check").textContent).not.toContain("Already taken");
    expect(getUser).toHaveBeenCalledTimes(1); // …and the invalid draft never asked
  });

  it("a 200 from the probe paints TAKEN; a 404 paints looks-free (never a promise it is free)", async () => {
    vi.mocked(getUser).mockResolvedValueOnce({
      ...profile("taken_one"),
      relationship: "stranger",
    });
    render(<SettingsChatPane />);
    typeUsername("taken_one");
    await waitFor(() => expect(checkState()).toBe("taken"), { timeout: 2000 });

    typeUsername("free_one");
    await waitFor(() => expect(checkState()).toBe("available"), { timeout: 2000 });
    // The words are the point: an "Available ✓" here would be the client promising something only
    // the commit can deliver (§6.6 makes 404 deliberately ambiguous).
    expect(screen.getByTestId("chat-username-check").textContent).toContain("Looks free");
  });
});

describe("SettingsChatPane — the server's answer wins", () => {
  const claimAndRead = async (err: unknown) => {
    vi.mocked(putUsername).mockRejectedValue(err);
    render(<SettingsChatPane />);
    typeUsername("ada_l");
    clickSave();
    await waitFor(() => expect(screen.getByTestId("chat-claim-note")).toBeTruthy());
    return screen.getByTestId("chat-claim-note").textContent ?? "";
  };

  // THE TWO 409s. Same status, opposite meanings — one is about the NAME, the other about the
  // ACCOUNT — so a mapping that read the status alone would tell a user whose handle is already
  // set to "pick a different one", advice that cannot work against an immutable username (§6.1).
  it("409 taken and 409 username_immutable paint DIFFERENT remedies", async () => {
    const taken = await claimAndRead(new SocialApiError(409, "taken"));
    cleanup();
    const immutable = await claimAndRead(new SocialApiError(409, "username_immutable"));

    expect(taken).toContain("already taken");
    expect(immutable).toContain("can’t be changed");
    expect(immutable).not.toContain("already taken");
    expect(taken).not.toBe(immutable);
  });

  // A REMEDY MAY NOT NAME A CONTROL THE READER CANNOT SEE (AGENTS.md; bead `sparkle-8bvh`). The
  // capitalization box is rendered only by the `settled` branch, and `409 username_immutable` on the
  // CLAIM form is by definition an un-settled screen — so "the field above" would send exactly the
  // user who has no such field looking for one. Asserted on the RENDERED note rather than on
  // `claimRemedy`'s argument, because the defect is what the user reads, and a call site that forgot
  // to thread the flag would satisfy an argument-level assertion.
  it("the immutability remedy points at the capitalization field ONLY where that field exists", async () => {
    const fromClaimForm = await claimAndRead(new SocialApiError(409, "username_immutable"));
    expect(fromClaimForm).not.toContain("field above");
    expect(screen.queryByTestId("chat-username-case-input")).toBeNull();

    // The paired positive: on the settled screen the field IS above the note, so the sentence is
    // both true and followable. Without this half, deleting the clause everywhere would pass.
    cleanup();
    useSocialStore.setState({ me: { ...EMPTY_PROFILE, username: "drodio", socialId: "social-1" } });
    vi.mocked(putUsername).mockRejectedValue(new SocialApiError(409, "username_immutable"));
    render(<SettingsChatPane />);
    fireEvent.change(screen.getByTestId("chat-username-case-input"), {
      target: { value: "DROdio" },
    });
    fireEvent.click(screen.getByTestId("chat-username-case-save"));
    await waitFor(() => expect(screen.getByTestId("chat-username-case-note")).toBeTruthy());
    expect(screen.getByTestId("chat-username-case-note").textContent).toContain("field above");
  });

  it("the three 400 codes each get their own remedy, branching on the CODE not the status", async () => {
    const reserved = await claimAndRead(new SocialApiError(400, "reserved"));
    cleanup();
    const impersonation = await claimAndRead(new SocialApiError(400, "impersonation"));
    cleanup();
    const format = await claimAndRead(new SocialApiError(400, "invalid_format"));

    expect(reserved).toContain("reserved");
    expect(impersonation).toContain("protects");
    expect(format).toContain("format");
    expect(new Set([reserved, impersonation, format]).size).toBe(3);
  });

  it("429 asks the user to wait rather than blaming the name", async () => {
    expect(await claimAndRead(new SocialApiError(429, "too_many_attempts"))).toContain(
      "Too many attempts",
    );
  });

  it("a locally-valid name is NOT protected from a server refusal: no claim reaches the store", async () => {
    // The advisory check said this name was fine. The server says no. The store must be untouched —
    // an `ok: true` locally may never suppress or reinterpret a 409.
    await claimAndRead(new SocialApiError(409, "taken"));
    expect(useSocialStore.getState().me.username).toBeNull();
  });

  it("a transport failure reads as unreachable, not as a refusal of the name", async () => {
    expect(await claimAndRead(new SocialNetworkError())).toContain("couldn’t reach the server");
  });
});

describe("SettingsChatPane — the server half may not be live yet", () => {
  it("a 404 from the claim paints the calm not-available-yet line and does not throw", async () => {
    vi.mocked(putUsername).mockRejectedValue(new SocialApiError(404, null));
    render(<SettingsChatPane />);

    typeUsername("ada_l");
    clickSave();

    await waitFor(() => expect(screen.getByTestId("chat-not-live")).toBeTruthy());
    expect(screen.getByTestId("chat-not-live").textContent).toContain("isn’t switched on");
    // Calm means calm: no error line beside it, and the Save button is usable again rather than
    // wedged in its in-flight state.
    expect(screen.queryByTestId("chat-claim-note")).toBeNull();
    expect((screen.getByTestId("chat-username-save") as HTMLButtonElement).disabled).toBe(false);
    // …and nothing is retrying in the background against a route we were told does not exist.
    expect(putUsername).toHaveBeenCalledTimes(1);
  });

  it("a 404 from the visibility write paints the same calm line, and does not claim the change", async () => {
    seedClaimed("public"); // the group is gated on a handle now — see the availability-gate suite
    vi.mocked(putVisibility).mockRejectedValue(new SocialApiError(404, null));
    render(<SettingsChatPane />);

    fireEvent.click(screen.getByTestId("chat-visibility-unavailable"));

    await waitFor(() => expect(screen.getByTestId("chat-not-live")).toBeTruthy());
    // The store must NOT have moved: the server never accepted it.
    expect(useSocialStore.getState().me.visibility).toBe("public");
    expect(putVisibility).toHaveBeenCalledTimes(1);
  });

  // THE FOUNDER'S BUG, VERBATIM: "I tried to send my status to public, but I wouldn't save."
  //
  // The test above pins the pane-level banner, and it passed throughout the entire time the bug was
  // live — because the banner is not what a person clicking a radio at the bottom of the pane reads.
  // A failed write leaves `me` untouched, so the radio snaps back, and the ONLY explanation was ~90
  // lines of JSX further up in calm styling. This asserts the note at the CONTROL, which is the
  // thing that was missing; it fails against the pane as it shipped.
  it("a 404 from the visibility write names the failure AT the control, not only in the pane banner", async () => {
    // Seeded to the DEFAULT and clicking away from it, so the click is a real change that fires
    // `onChange` — and so a pane that merely failed to repaint could not pass by accident.
    //
    // `seedClaimed`, not a bare `me` write: this test arrived from `main` while the availability
    // GATE was being built on this branch, and the two meet here. The gate disables the group until
    // a username exists, so without a claimed handle the click sends nothing, there is no 404, and
    // no note to find — the failure this test reported at the merge. A user reaching a 404 from the
    // visibility write is BY CONSTRUCTION one who holds a handle (that is the only way the control
    // is live), so seeding one is what makes the scenario reachable rather than a way to dodge the
    // gate. Same adaptation every other pre-existing availability test needed — see `seedClaimed`.
    seedClaimed("unavailable");
    vi.mocked(putVisibility).mockRejectedValue(new SocialApiError(404, null));
    render(<SettingsChatPane />);

    fireEvent.click(screen.getByTestId("chat-visibility-public"));

    await waitFor(() => expect(screen.getByTestId("chat-visibility-note")).toBeTruthy());
    const note = screen.getByTestId("chat-visibility-note").textContent ?? "";
    // It must say the save FAILED…
    expect(note).toContain("didn’t save");
    // …and what the setting is NOW, which is the fact a silent revert withholds.
    expect(note).toContain("unchanged");
    // The revert this note is explaining really did happen.
    expect((screen.getByTestId("chat-visibility-public") as HTMLInputElement).checked).toBe(false);
    expect(useSocialStore.getState().me.visibility).toBe("unavailable");
  });
});

describe("SettingsChatPane — availability", () => {
  // SEEDED TO `public` FIRST, on purpose: `unavailable` is the store's default, so the obvious
  // version of this test passes against a pane that renders three inert radios.
  it("choosing Unavailable calls putVisibility('unavailable') and the store reflects it", async () => {
    seedClaimed("public");
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "unavailable" });
    render(<SettingsChatPane />);
    expect(useSocialStore.getState().me.visibility).toBe("public");

    fireEvent.click(screen.getByTestId("chat-visibility-unavailable"));

    await waitFor(() => expect(putVisibility).toHaveBeenCalledWith("unavailable"));
    await waitFor(() => expect(useSocialStore.getState().me.visibility).toBe("unavailable"));
  });

  // THE OPT-IN POSTURE, which is a RULE and not the copy that used to describe it. The explanatory
  // line ("Sparkle starts everyone at Unavailable…") was cut on 2026-08-08; the default it
  // described is `EMPTY_PROFILE.visibility === "unavailable"` and must still hold, or removing prose
  // would have quietly removed a privacy default.
  it("offers the founder's three words, and starts everyone at Unavailable", () => {
    render(<SettingsChatPane />);
    const group = screen.getByRole("radiogroup", { name: "Availability" });
    for (const label of ["Available: Public", "Available: Connections only", "Unavailable"]) {
      expect(within(group).getByText(label)).toBeTruthy();
    }
    expect((screen.getByTestId("chat-visibility-unavailable") as HTMLInputElement).checked).toBe(
      true,
    );
  });

  // A BEHAVIOUR THAT OUTLIVED THE COPY THAT POINTED AT IT. The caveat used to say "choose again
  // here to be sure"; that sentence was cut on 2026-08-08, the silent-no-op bug it worked around
  // was not. The one option a returning user most wants to re-assert — Unavailable — is the one
  // already checked in every un-hydrated session, and a browser fires no `change` for a click on an
  // already-checked radio, so without the onClick handler that click is no request, no spinner and
  // no confirmation, indistinguishable from a successful save.
  it("re-asserting the ALREADY-SELECTED option still calls putVisibility", async () => {
    seedClaimed("unavailable");
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "unavailable" });
    render(<SettingsChatPane />);
    const unavailable = radio("unavailable");
    expect(unavailable.checked).toBe(true); // the un-hydrated default, and the whole problem

    fireEvent.click(unavailable);

    await waitFor(() => expect(putVisibility).toHaveBeenCalledWith("unavailable"));
  });

  it("does NOT double-send when the click actually changes the selection", async () => {
    seedClaimed();
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "public" });
    render(<SettingsChatPane />);
    fireEvent.click(screen.getByTestId("chat-visibility-public"));
    await waitFor(() => expect(putVisibility).toHaveBeenCalledWith("public"));
    // Exactly one: the onChange path and the re-assert path must stay disjoint, or every ordinary
    // choice would issue two writes.
    expect(putVisibility).toHaveBeenCalledTimes(1);
  });

  // THE CHOICE OUTLIVES THE PANE. The pane remounts on every rail click (SettingsDialog mounts only
  // the active pane), so the selection has to come from the store rather than from component state
  // — otherwise navigating away and back would show a returning user a different answer than the
  // one the server just accepted.
  it("keeps the confirmed choice across a REMOUNT", async () => {
    seedClaimed();
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "public" });
    render(<SettingsChatPane />);
    fireEvent.click(screen.getByTestId("chat-visibility-public"));
    await waitFor(() => expect(useSocialStore.getState().me.visibility).toBe("public"));

    // Navigate away and back, which is exactly what the settings rail does to this pane.
    cleanup();
    render(<SettingsChatPane />);

    expect((screen.getByTestId("chat-visibility-public") as HTMLInputElement).checked).toBe(true);
  });

  // …and it must NOT outlive the HUMAN. Per-human state surviving a sign-out is a recurring leak in
  // this app; here `reset()` is what prevents it, so the next account starts at the Unavailable
  // default rather than inheriting the previous one's exposure.
  it("drops the confirmed choice on reset(), so the next account starts Unavailable", async () => {
    seedClaimed();
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "public" });
    render(<SettingsChatPane />);
    fireEvent.click(screen.getByTestId("chat-visibility-public"));
    await waitFor(() => expect(useSocialStore.getState().visibilityConfirmed).toBe(true));

    act(() => useSocialStore.getState().reset());

    expect(useSocialStore.getState().visibilityConfirmed).toBe(false);
    expect(useSocialStore.getState().me.visibility).toBe("unavailable");
    cleanup();
    render(<SettingsChatPane />);
    expect((screen.getByTestId("chat-visibility-unavailable") as HTMLInputElement).checked).toBe(
      true,
    );
  });

  // A FAILED SAVE CONFIRMS NOTHING. `confirmVisibility` is the only writer of both halves and runs
  // only on a 2xx, so a transport failure must leave the store exactly where it was — the paired
  // negative to "choosing Public reaches the store", without which that test is satisfied by a pane
  // that writes the store unconditionally.
  it("a FAILED save moves neither the value nor the confirmation", async () => {
    seedClaimed();
    vi.mocked(putVisibility).mockRejectedValue(new SocialNetworkError());
    render(<SettingsChatPane />);
    fireEvent.click(screen.getByTestId("chat-visibility-public"));
    await waitFor(() => expect(screen.getByTestId("chat-visibility-note")).toBeTruthy());
    expect(useSocialStore.getState().me.visibility).toBe("unavailable");
    expect(useSocialStore.getState().visibilityConfirmed).toBe(false);
  });

  it("choosing Public reaches the server and the store too (the opposite direction)", async () => {
    seedClaimed();
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "public" });
    render(<SettingsChatPane />);
    fireEvent.click(screen.getByTestId("chat-visibility-public"));
    await waitFor(() => expect(putVisibility).toHaveBeenCalledWith("public"));
    await waitFor(() => expect(useSocialStore.getState().me.visibility).toBe("public"));
  });
});

describe("SettingsChatPane — what the user is shown", () => {
  it("renders the user's OWN avatar with their availability dot", () => {
    useSocialStore.setState({
      me: { ...EMPTY_PROFILE, username: "ada_l", visibility: "public" },
    });
    render(<SettingsChatPane />);
    const avatar = screen.getByTestId("person-avatar");
    // The dot reads AVAILABLE because the intent is public and the app is plainly open.
    expect(avatar.getAttribute("aria-label")).toContain("Available");
    expect(
      screen.getByTestId("availability-dot-slot").firstElementChild?.getAttribute(
        "data-availability",
      ),
    ).toBe("available");
  });

  it("the same avatar reads OFFLINE while the user is Unavailable", () => {
    useSocialStore.setState({ me: { ...EMPTY_PROFILE, username: "ada_l" } });
    render(<SettingsChatPane />);
    expect(
      screen.getByTestId("availability-dot-slot").firstElementChild?.getAttribute(
        "data-availability",
      ),
    ).toBe("offline");
  });

  it("does not tell the user their availability is unchanged — it cannot know that", () => {
    render(<SettingsChatPane />);
    // The copy this replaces read "Nothing here changes until you choose it", which is true of the
    // local field and false of the server row it is a picture of.
    expect(document.body.textContent).not.toContain("Nothing here changes until you choose it");
  });

  // ── THE FOUNDER'S COPY CUT, PINNED ────────────────────────────────────────────────────────────
  // On 2026-08-08 the founder removed four blocks of explanatory copy from this pane: it read as
  // four paragraphs of caveats before he could do anything. This is a decision about his own
  // product's copy, and the failure mode it guards against is specific — a later agent reads the
  // rationale still recorded in the PRD and in roborev 60396/60415/60425 (all of which argued FOR
  // this text on real grounds) and puts it back, believing it is restoring a fix.
  //
  // Deliberately asserted on the RENDERED DOCUMENT, not on the deleted testids: a `queryByTestId`
  // returning null is satisfied by re-adding the copy under a different id, which is exactly how it
  // would come back. The distinctive phrase from each block is enough to catch a paste-back.
  it("does not re-add the four blocks of explanatory copy the founder cut", () => {
    useSocialStore.setState({ me: EMPTY_PROFILE, visibilityConfirmed: false });
    render(<SettingsChatPane />);
    const shown = document.body.textContent ?? "";

    for (const phrase of [
      "Pick the handle other people will use to find you", // 1 — username preamble
      "Sparkle may not know it yet", // 2 — other-machine caveat
      "Sparkle starts everyone at", // 3a — availability preamble
      "choose again here to be sure", // 3b — un-hydrated availability caveat
      // 4 — the BEFORE YOU START block, pinned by its HEADING and its closing line rather than by
      // the privacy claim itself. What the founder cut was a four-paragraph wall, not the right to
      // ever disclose this: banning the bare phrase "not end-to-end encrypted" would also reject a
      // one-line link, a shorter sentence or a first-run notice — and the failure would read as
      // "the founder forbade this", which is not what this guard protects. If a compliant
      // disclosure is added back in some other form, that is a product decision to make on its
      // merits, not something this test should pre-empt. (roborev 61542.)
      "Before you start",
      "wouldn’t put in a support ticket",
    ]) {
      expect(shown).not.toContain(phrase);
    }
  });

  // …AND THE RULES THOSE PARAGRAPHS DESCRIBED ARE STILL ENFORCED. The pair matters: the test above
  // alone is satisfied by a pane that dropped the constraints along with the prose, which is the one
  // outcome the founder did NOT ask for ("he is cutting the wall of text, not the guardrails").
  // Each assertion here drives the real code path rather than reading a string.
  it("keeps every rule the cut copy used to explain", async () => {
    // (a) 3–30 characters, still enforced, still surfaced inline where it bites.
    render(<SettingsChatPane />);
    typeUsername("ab");
    clickSave();
    await waitFor(() => expect(checkState()).toBe("invalid"));
    expect(screen.getByTestId("chat-username-check").textContent).toContain("At least 3");
    expect(putUsername).not.toHaveBeenCalled();

    typeUsername("a".repeat(31));
    await waitFor(() =>
      expect(screen.getByTestId("chat-username-check").textContent).toContain("At most 30"),
    );

    // (b) Unavailable by default — the opt-in posture, read off the store the pane renders from.
    expect((screen.getByTestId("chat-visibility-unavailable") as HTMLInputElement).checked).toBe(
      true,
    );

    // (c) A handle claimed on ANOTHER machine is not overwritten: the server's 409 is surfaced and
    //     the store stays empty.
    vi.mocked(putUsername).mockRejectedValue(new SocialApiError(409, "username_immutable"));
    typeUsername("ada_l");
    clickSave();
    await waitFor(() => expect(screen.getByTestId("chat-claim-note")).toBeTruthy());
    expect(screen.getByTestId("chat-claim-note").textContent).toContain("can’t be changed");
    expect(useSocialStore.getState().me.username).toBeNull();

    // (d) Immutability, stated precisely: what is immutable is the KEY, so once a handle is known
    //     there is no field that can RENAME it. There IS one that can re-case it, and asserting only
    //     the absence would read as "a settled pane offers no field", which a later agent could
    //     satisfy by deleting the capitalization editor. Both halves, so neither reading survives.
    cleanup();
    useSocialStore.setState({ me: { ...EMPTY_PROFILE, username: "ada_l" } });
    render(<SettingsChatPane />);
    expect(screen.queryByTestId("chat-username-input")).toBeNull();
    expect(screen.queryByTestId("chat-username-save")).toBeNull();
    expect(screen.getByTestId("chat-username-case-input")).toBeTruthy();
  });

  it("once a username is claimed the CLAIM form is gone — no rename offer", () => {
    useSocialStore.setState({ me: { ...EMPTY_PROFILE, username: "ada_l" } });
    render(<SettingsChatPane />);
    expect(screen.getByTestId("chat-username-settled").textContent).toContain("permanent");
    // The claim field specifically. A settled user must not be offered a box that can only earn
    // them a 409 — which is a different thing from being offered no box at all; see the
    // capitalization suite below for the box they DO get.
    expect(screen.queryByTestId("chat-username-input")).toBeNull();
    expect(screen.queryByTestId("chat-username-save")).toBeNull();
  });
});

// ── Capitalization: the one part of a settled handle that IS editable ────────────────────────────
//
// The settled state used to be a dead end — static copy saying "usernames are permanent", no field
// of any kind. That read the immutability rule as covering the DISPLAY form, which it never did:
// `drodio` and `DROdio` are one key, so re-casing collides with nobody and frees no handle. The
// server applies it as a `recase`; these are the assertions that the UI can actually reach it.
describe("SettingsChatPane — setting the capitalization of a claimed handle", () => {
  const seedHandle = (username: string) =>
    useSocialStore.setState({ me: { ...EMPTY_PROFILE, username, socialId: "social-1" } });

  const caseInput = () => screen.getByTestId("chat-username-case-input") as HTMLInputElement;
  const typeCase = (value: string) => fireEvent.change(caseInput(), { target: { value } });
  const clickCaseSave = () => fireEvent.click(screen.getByTestId("chat-username-case-save"));

  it("seeds the field with the handle as it stands", () => {
    seedHandle("drodio");
    render(<SettingsChatPane />);
    expect(caseInput().value).toBe("drodio");
  });

  it("SENDS the re-cased handle and the STORE ends up holding the new capitalization", async () => {
    // THE FOUNDER'S CASE, end to end through the pane. Both halves are asserted because either
    // alone is passable by a broken pane: a request with no store write leaves every other surface
    // painting the old form, and a store write with no request is a lie that dies on next launch.
    seedHandle("drodio");
    vi.mocked(putUsername).mockResolvedValue(profile("DROdio"));
    render(<SettingsChatPane />);

    typeCase("DROdio");
    clickCaseSave();

    await waitFor(() => expect(putUsername).toHaveBeenCalledWith("DROdio"));
    await waitFor(() => expect(useSocialStore.getState().me.username).toBe("DROdio"));
  });

  it("takes the SERVER's echo, not the typed string, as what was saved", async () => {
    // The pane must not paint a capitalization the database did not accept. Seeding the mock with a
    // form that differs from the input is what makes echo-vs-local distinguishable — asserting on a
    // matching pair would pass either way.
    seedHandle("drodio");
    vi.mocked(putUsername).mockResolvedValue(profile("DRodio"));
    render(<SettingsChatPane />);

    typeCase("DROdio");
    clickCaseSave();

    await waitFor(() => expect(useSocialStore.getState().me.username).toBe("DRodio"));
  });

  it("REFUSES a different handle locally — a re-case is not a rename, and it never hits the network", async () => {
    seedHandle("drodio");
    render(<SettingsChatPane />);

    typeCase("dr0dio"); // a different KEY, however similar it looks
    expect(screen.getByTestId("chat-username-case-differs").textContent).toContain(
      "different handle",
    );
    clickCaseSave();

    await waitFor(() =>
      expect(screen.getByTestId("chat-username-case-note").textContent).toContain("stays"),
    );
    expect(putUsername).not.toHaveBeenCalled();
    // ...and the store is untouched: a refused edit must not repaint the app.
    expect(useSocialStore.getState().me.username).toBe("drodio");
  });

  it("does not warn while the edit is still a pure re-case", () => {
    seedHandle("drodio");
    render(<SettingsChatPane />);
    typeCase("DROdio");
    // The negative half of the test above. Without it, a warning that fired on EVERY keystroke
    // would satisfy the assertion there and still make the field unusable.
    expect(screen.queryByTestId("chat-username-case-differs")).toBeNull();
  });

  it("keeps Save inert until something actually changed", () => {
    seedHandle("drodio");
    render(<SettingsChatPane />);
    const button = screen.getByTestId("chat-username-case-save") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    typeCase("DROdio");
    expect(button.disabled).toBe(false);
  });

  it("surfaces a server refusal instead of claiming success", async () => {
    seedHandle("drodio");
    vi.mocked(putUsername).mockRejectedValue(new SocialApiError(409, "taken"));
    render(<SettingsChatPane />);

    typeCase("DROdio");
    clickCaseSave();

    await waitFor(() => expect(screen.getByTestId("chat-username-case-note")).toBeTruthy());
    // The store must still hold the OLD value — the write failed, so the app must not paint it.
    expect(useSocialStore.getState().me.username).toBe("drodio");
  });
});

// ── The call site that un-sticks the roster ─────────────────────────────────────────────────────
// roborev 60450, third finding. A claim is the ONLY thing that can un-latch a sync silenced by the
// launch 404, and it can happen only once (409 username_immutable) — so if `save()` ever stops
// calling it, the user is stuck on "Looking for people…" until restart with no way back.
describe("claiming a username kicks the roster loop", () => {
  it("calls resumeSocialSync after a SUCCESSFUL claim", async () => {
    vi.mocked(putUsername).mockResolvedValue(profile("ada_l"));
    render(<SettingsChatPane />);

    typeUsername("ada_l");
    clickSave();

    await waitFor(() => expect(vi.mocked(resumeSocialSync)).toHaveBeenCalledTimes(1));
  });

  it("does NOT call it when the claim FAILS", async () => {
    // The paired negative — without it the assertion above is satisfied by calling resume
    // unconditionally, which would re-arm a loop against a surface that just refused us.
    vi.mocked(putUsername).mockRejectedValue(new SocialApiError(409, "taken"));
    render(<SettingsChatPane />);

    typeUsername("ada_l");
    clickSave();

    await waitFor(() => expect(putUsername).toHaveBeenCalled());
    expect(vi.mocked(resumeSocialSync)).not.toHaveBeenCalled();
  });
});

// ── THE AVAILABILITY GATE ───────────────────────────────────────────────────────────────────────
//
// Bead sparkle-3g97m, the founder's own words: "if I'm not able to set that before I've chosen my
// username then that should be grayed out until the username is set. I shouldn't be able to try
// selecting it if the username is a requirement for that to work."
//
// `PUT /account/visibility` answers `409 no_username` with no profile row, so before a handle exists
// every option here is a guaranteed refusal. Each test asserts the SIDE EFFECT — that no request
// went out — and not merely that a `disabled` attribute is present: an attribute is a precondition,
// and a pane that set it while still wiring a click handler to a `<label>` would satisfy it while
// firing the write anyway.
//
// jsdom caveat honoured (docs/jsdom-test-caveats.md): nothing here reads a COLOUR. The stylesheet
// is never loaded under jsdom, so `getComputedStyle` on a class-derived "greyed out" reads empty and
// an assertion on it would pass or fail for reasons unrelated to the gate.
describe("SettingsChatPane — availability is gated on having a username", () => {
  const VALUES = ["public", "connections", "unavailable"] as const;

  it("is DISABLED with a stated reason when we KNOW there is no username", () => {
    useSocialStore.setState({ me: EMPTY_PROFILE, profileLoaded: true });
    render(<SettingsChatPane />);

    for (const value of VALUES) expect(radio(value).disabled).toBe(true);
    expect(gateLine()).toContain("Claim a username first");
    // The group announces its state to a screen reader too — the gate must not be carried by the
    // dimming alone (§10 / WCAG 1.4.1).
    expect(
      screen.getByRole("radiogroup", { name: "Availability" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  // THE ASSERTION THAT MATTERS, and it is a genuinely different assertion from the `disabled`
  // property above — not a restatement of it. `disabled` is the affordance; the HANDLER's own guard
  // is what stops the write, and this is the test that found out they are not the same thing:
  // React declines to dispatch `onClick` for a disabled input but has no such rule for `onChange`,
  // which for a radio is driven by the click, so 2 of these 4 clicks sent a `putVisibility` through
  // a greyed-out control. Mutate either one and exactly one of the two tests goes red.
  it("clicking a disabled radio fires NO request, on any of the three options", async () => {
    useSocialStore.setState({ me: EMPTY_PROFILE, profileLoaded: true });
    render(<SettingsChatPane />);

    for (const value of VALUES) fireEvent.click(radio(value));
    // The already-checked one twice: `Unavailable` is checked in this state, and the re-assert
    // `onClick` path (roborev 60425) exists precisely to write WITHOUT a change event — so it is the
    // one handler a `disabled` that only suppressed `onChange` would leave alive.
    fireEvent.click(radio("unavailable"));

    await Promise.resolve();
    expect(putVisibility).not.toHaveBeenCalled();
    expect(useSocialStore.getState().me.visibility).toBe("unavailable");
    expect(useSocialStore.getState().visibilityConfirmed).toBe(false);
  });

  it("a second choice made WHILE a write is in flight sends only one request", async () => {
    // The in-flight half of the same hole. `disabled={visSaving !== null || …}` held this off with
    // the attribute ALONE, and the attribute is exactly what does not hold for `onChange` — so two
    // writes raced, the first's `finally` cleared the spinner while the second was outstanding, and
    // the LAST reply to land won `confirmVisibility`, which could be the older value. (roborev
    // 61751.) The refusal is a ref, not `visSaving`: both dispatches read the same pre-update
    // render's state, so a state test would be `null` for both and refuse neither.
    seedClaimed("unavailable");
    const inFlight = deferred<{ visibility: Visibility }>();
    vi.mocked(putVisibility).mockReturnValue(inFlight.promise);
    render(<SettingsChatPane />);

    fireEvent.click(radio("public"));
    await waitFor(() => expect(putVisibility).toHaveBeenCalledTimes(1));
    // …and now, before the first reply, ask for a different value.
    fireEvent.click(radio("connections"));
    await Promise.resolve();

    expect(putVisibility).toHaveBeenCalledTimes(1);
    expect(putVisibility).toHaveBeenCalledWith("public");

    // The first write settles, and the value the SERVER accepted is the one that sticks.
    await act(async () => {
      inFlight.resolve({ visibility: "public" });
      await inFlight.promise;
    });
    expect(useSocialStore.getState().me.visibility).toBe("public");
  });

  it("the in-flight refusal LIFTS once the write settles — it does not wedge the group shut", async () => {
    // The paired positive for the ref: a guard that never cleared would also pass the test above,
    // and would leave the group permanently dead after one save.
    seedClaimed("unavailable");
    render(<SettingsChatPane />);

    fireEvent.click(radio("public"));
    await waitFor(() => expect(putVisibility).toHaveBeenCalledTimes(1));

    fireEvent.click(radio("connections"));
    await waitFor(() => expect(putVisibility).toHaveBeenCalledTimes(2));
    expect(putVisibility).toHaveBeenLastCalledWith("connections");
  });

  // THE PAIRED POSITIVE. Without it, "no request went out" is satisfied by a pane whose radios never
  // work at all — the assertion would hold against a feature that is 100% broken.
  it("is ENABLED, with no gate line, once a username is known — and the click DOES write", async () => {
    seedClaimed("unavailable");
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "public" });
    render(<SettingsChatPane />);

    for (const value of VALUES) expect(radio(value).disabled).toBe(false);
    expect(screen.queryByTestId("chat-availability-gate")).toBeNull();
    expect(
      screen.getByRole("radiogroup", { name: "Availability" }).getAttribute("aria-disabled"),
    ).toBeNull();

    fireEvent.click(radio("public"));
    await waitFor(() => expect(putVisibility).toHaveBeenCalledWith("public"));
  });

  // THE TRANSITION, IN ONE SESSION. The founder claims a name and the group has to come alive
  // without a restart — `setMyProfile` raises `profileLoaded` and writes the handle, and the gate
  // reads both.
  it("goes from disabled to ENABLED after a successful save(), with no remount", async () => {
    useSocialStore.setState({ me: EMPTY_PROFILE, profileLoaded: true });
    vi.mocked(putUsername).mockResolvedValue(profile("ada_l"));
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "public" });
    render(<SettingsChatPane />);

    expect(radio("unavailable").disabled).toBe(true);

    typeUsername("ada_l");
    clickSave();
    await waitFor(() => expect(useSocialStore.getState().me.username).toBe("ada_l"));

    await waitFor(() => expect(radio("public").disabled).toBe(false));
    expect(screen.queryByTestId("chat-availability-gate")).toBeNull();
    // Live, not merely un-greyed.
    fireEvent.click(radio("public"));
    await waitFor(() => expect(putVisibility).toHaveBeenCalledWith("public"));
  });

  // A FAILED CLAIM MUST NOT OPEN THE GATE — the paired negative. `me.username` is only written on a
  // 2xx, so a pane that enabled the group on "the user pressed Save" would offer the control again
  // in exactly the state that cannot use it.
  it("a REFUSED claim leaves the group closed", async () => {
    useSocialStore.setState({ me: EMPTY_PROFILE, profileLoaded: true });
    vi.mocked(putUsername).mockRejectedValue(new SocialApiError(409, "taken"));
    render(<SettingsChatPane />);

    typeUsername("ada_l");
    clickSave();
    await waitFor(() => expect(screen.getByTestId("chat-claim-note")).toBeTruthy());

    expect(radio("public").disabled).toBe(true);
    expect(gateLine()).toContain("Claim a username first");
  });
});

// ── THE THIRD STATE: WE HAVE NOT LOOKED YET ─────────────────────────────────────────────────────
//
// `me.username == null` is ALSO what a returning user who holds a handle looks like before their
// profile is read (`socialStore.profileLoaded` exists to tell those apart). Gating on the username
// alone would grey out a working control and tell that user to claim a name they already own — so
// the unknown state is disabled but says something different, and the pane's one `getMyProfile()`
// keeps it brief.
describe("SettingsChatPane — hydrating the profile so the gate is not stuck at 'unknown'", () => {
  const unknownStart = () => useSocialStore.setState({ me: EMPTY_PROFILE, profileLoaded: false });

  it("paints its OWN, non-accusatory line while the answer is unknown", () => {
    unknownStart();
    vi.mocked(getMyProfile).mockReturnValue(new Promise(() => {})); // never settles
    render(<SettingsChatPane />);

    expect(radio("public").disabled).toBe(true);
    const line = gateLine() ?? "";
    expect(line).toContain("Checking your profile");
    // It must NOT accuse: we do not know that there is no username, and saying so to someone who
    // has one is the failure `profileLoaded` exists to prevent.
    expect(line).not.toContain("Claim a username first");
  });

  it("asks ONCE on mount, and a 404 settles it to 'no username' with no error and no second ask", async () => {
    unknownStart();
    vi.mocked(getMyProfile).mockRejectedValue(new SocialApiError(404, null));
    render(<SettingsChatPane />);

    await waitFor(() => expect(gateLine()).toContain("Claim a username first"));
    expect(getMyProfile).toHaveBeenCalledTimes(1);
    // A 404 is the NORMAL answer for someone with no social identity — never an error banner, and
    // never the sticky "chat isn't switched on" line.
    expect(screen.queryByTestId("chat-claim-note")).toBeNull();
    expect(screen.queryByTestId("chat-visibility-note")).toBeNull();
    expect(screen.queryByTestId("chat-not-live")).toBeNull();

    // …and nothing retries. A keystroke re-renders the pane; the request must not go out again.
    typeUsername("ada_l");
    await waitFor(() => expect(getUser).toHaveBeenCalled());
    expect(getMyProfile).toHaveBeenCalledTimes(1);
  });

  it("a RETURNING user's handle arrives from the hydration and the group comes alive", async () => {
    unknownStart();
    vi.mocked(getMyProfile).mockResolvedValue({
      socialId: "social-9",
      username: "ada_l",
      displayName: null,
      visibility: "public",
    } satisfies MyProfileResponse);
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "connections" });
    render(<SettingsChatPane />);

    // The handle reaches the STORE, which is what the rest of the app reads.
    await waitFor(() => expect(useSocialStore.getState().me.username).toBe("ada_l"));
    await waitFor(() => expect(radio("connections").disabled).toBe(false));
    expect(screen.queryByTestId("chat-availability-gate")).toBeNull();
    fireEvent.click(radio("connections"));
    await waitFor(() => expect(putVisibility).toHaveBeenCalledWith("connections"));
  });

  it("a hydration failure that is NOT a 404 leaves the honest 'unknown' line, and does not retry", async () => {
    unknownStart();
    vi.mocked(getMyProfile).mockRejectedValue(new SocialNetworkError());
    render(<SettingsChatPane />);

    await waitFor(() => expect(getMyProfile).toHaveBeenCalledTimes(1));
    // Still unknown: a failed request is not evidence about the user, so telling them to claim a
    // username would be an accusation manufactured out of our own outage.
    expect(gateLine()).toContain("Checking your profile");
    expect(useSocialStore.getState().profileLoaded).toBe(false);
    typeUsername("ada_l");
    await waitFor(() => expect(getUser).toHaveBeenCalled());
    expect(getMyProfile).toHaveBeenCalledTimes(1);
  });

  it("does not ask at all when the profile is already known", async () => {
    // KNOWN, and known to be EMPTY — the state a 404 leaves behind. `profileLoaded` is the whole
    // question, so the pane must not re-ask merely because there is no username; that would be a
    // request per mount for every user who has not claimed one.
    useSocialStore.setState({ me: EMPTY_PROFILE, profileLoaded: true });
    render(<SettingsChatPane />);
    typeUsername("ada_l"); // a re-render, the trigger a naive effect would fire on
    await waitFor(() => expect(checkState()).toBe("checking"));
    expect(getMyProfile).not.toHaveBeenCalled();
  });
});

// ── NO RAW HTTP STATUS CODES REACH THE USER ─────────────────────────────────────────────────────
//
// "The server refused that change (409)." is not a sentence anyone can act on: the number is our
// diagnostic and the remedy is the user's. The server already sends a typed reason; render THAT.
describe("SettingsChatPane — typed reasons, never HTTP status codes", () => {
  it("409 no_username renders the typed sentence — and the copy contains no '409'", async () => {
    // Reached through the real UI, in the race the gate cannot close: this Mac holds a handle
    // (so the group is live) and the server no longer has the row.
    seedClaimed("unavailable");
    vi.mocked(putVisibility).mockRejectedValue(new SocialApiError(409, "no_username"));
    render(<SettingsChatPane />);

    fireEvent.click(radio("public"));

    await waitFor(() => expect(screen.getByTestId("chat-visibility-note")).toBeTruthy());
    const note = screen.getByTestId("chat-visibility-note").textContent ?? "";
    expect(note).toContain("Claim a username first");
    expect(note).not.toContain("409");
    expect(note).not.toMatch(BARE_HTTP_STATUS);
    // The refusal is not laundered into a success.
    expect(useSocialStore.getState().me.visibility).toBe("unavailable");
  });

  it("an UNRECOGNISED status gets a plain human sentence with no number in it", async () => {
    seedClaimed("unavailable");
    vi.mocked(putVisibility).mockRejectedValue(new SocialApiError(503, null));
    render(<SettingsChatPane />);

    fireEvent.click(radio("public"));

    await waitFor(() => expect(screen.getByTestId("chat-visibility-note")).toBeTruthy());
    const note = screen.getByTestId("chat-visibility-note").textContent ?? "";
    expect(note).not.toMatch(BARE_HTTP_STATUS);
    expect(note.length).toBeGreaterThan(10); // a sentence, not an empty div
  });

  // The remedy tables, driven directly over every status a route can produce. A UI test can only
  // reach the codes it thinks to mock; this is the exhaustive half.
  it.each([400, 401, 403, 409, 418, 429, 500, 502, 503])(
    "visibilityRemedy(%i) never puts the number in the copy",
    (status) => {
      for (const code of [null, "taken", "no_username", "nonsense"]) {
        const { text } = visibilityRemedy(new SocialApiError(status, code));
        expect(text, `status ${status} / code ${code}`).not.toMatch(BARE_HTTP_STATUS);
        expect(text.length).toBeGreaterThan(10);
      }
    },
  );

  it.each([400, 401, 403, 409, 418, 429, 500, 502, 503])(
    "claimRemedy(%i) never puts the number in the copy",
    (status) => {
      for (const code of [null, "reserved", "impersonation", "invalid_format", "nonsense"]) {
        const { text } = claimRemedy(new SocialApiError(status, code));
        expect(text, `status ${status} / code ${code}`).not.toMatch(BARE_HTTP_STATUS);
        expect(text.length).toBeGreaterThan(10);
      }
    },
  );

  // THE WHOLE-PANE SWEEP. Asserted on the RENDERED DOCUMENT rather than on the two functions above,
  // so a THIRD place that interpolates a status — a new branch, a new note, a caught error rendered
  // verbatim — is caught by the same test rather than needing to be remembered.
  it("no Chat-pane copy contains a bare HTTP status, in any error state", async () => {
    const states: { name: string; run: () => Promise<void> }[] = [
      {
        name: "a refused claim",
        run: async () => {
          vi.mocked(putUsername).mockRejectedValue(new SocialApiError(422, "whatever"));
          render(<SettingsChatPane />);
          typeUsername("ada_l");
          clickSave();
          await waitFor(() => expect(screen.getByTestId("chat-claim-note")).toBeTruthy());
        },
      },
      {
        name: "a refused visibility write",
        run: async () => {
          seedClaimed("unavailable");
          vi.mocked(putVisibility).mockRejectedValue(new SocialApiError(500, "boom"));
          render(<SettingsChatPane />);
          fireEvent.click(radio("public"));
          await waitFor(() => expect(screen.getByTestId("chat-visibility-note")).toBeTruthy());
        },
      },
      {
        name: "the not-live-yet banner",
        run: async () => {
          vi.mocked(putUsername).mockRejectedValue(new SocialApiError(404, null));
          render(<SettingsChatPane />);
          typeUsername("ada_l");
          clickSave();
          await waitFor(() => expect(screen.getByTestId("chat-not-live")).toBeTruthy());
        },
      },
      {
        name: "a failed availability probe",
        run: async () => {
          vi.mocked(getUser).mockRejectedValue(new SocialApiError(429, null));
          render(<SettingsChatPane />);
          typeUsername("ada_l");
          await waitFor(() => expect(checkState()).toBe("unknown"), { timeout: 2000 });
        },
      },
      {
        name: "the gate, unknown",
        run: async () => {
          useSocialStore.setState({ me: EMPTY_PROFILE, profileLoaded: false });
          vi.mocked(getMyProfile).mockReturnValue(new Promise(() => {}));
          render(<SettingsChatPane />);
          await waitFor(() => expect(screen.getByTestId("chat-availability-gate")).toBeTruthy());
        },
      },
    ];

    for (const state of states) {
      await state.run();
      const shown = document.body.textContent ?? "";
      const hit = shown.match(BARE_HTTP_STATUS);
      expect(hit, `"${state.name}" leaked "${hit?.[0]}" into the copy: ${shown}`).toBeNull();
      cleanup();
      useSocialStore.setState({
        me: EMPTY_PROFILE,
        profileLoaded: true,
        visibilityConfirmed: false,
      });
    }
  });
});

// ── THE RESERVED CHECK, BEFORE SAVE ─────────────────────────────────────────────────────────────
//
// The probe painted "Looks free — the server decides when you save." for `admin`. The server's
// RESERVED_USERNAMES is hardcoded and frozen, so the client can say better than that — while staying
// ADVISORY: it changes the words, never the gate.
describe("SettingsChatPane — names the client can already tell are reserved", () => {
  it.each(["admin", "support", "sparkle"])(
    "%s paints RESERVED before Save, and costs no round trip",
    async (name) => {
      render(<SettingsChatPane />);
      typeUsername(name);

      await waitFor(() => expect(checkState()).toBe("invalid"));
      expect(screen.getByTestId("chat-username-check").textContent).toContain("reserved");
      // The old lie, gone.
      expect(screen.getByTestId("chat-username-check").textContent).not.toContain("Looks free");
      // A name we already know the answer to is not worth asking about.
      expect(getUser).not.toHaveBeenCalled();
    },
  );

  // ⚠️ THE ONE THAT WOULD SILENTLY RE-BREAK THE HEADLINE FIX. The orchestration half exempts the
  // OWNER of `drodio` so the founder can claim his own handle. If this client list carried it, the
  // pane would tell the very person being unblocked "That username is reserved." — before Save,
  // with no server round trip to correct it. Both casings, because the check runs on the key.
  it.each(["drodio", "DROdio"])(
    "%s does NOT paint reserved — it has an owner, and the server decides",
    async (name) => {
      render(<SettingsChatPane />);
      typeUsername(name);

      await waitFor(() => expect(checkState()).toBe("available"), { timeout: 2000 });
      expect(screen.getByTestId("chat-username-check").textContent).toContain("Looks free");
      expect(screen.getByTestId("chat-username-check").textContent).not.toContain("reserved");
      // It reached the network like any other name — the advisory list did not intercept it.
      expect(getUser).toHaveBeenCalledWith("drodio");
    },
  );

  // ADVISORY MEANS ADVISORY. The header is emphatic that the Save button is gated on nothing, and a
  // client list that silently stopped a claim would be the local check becoming the authority — the
  // one thing this module forbids.
  it("does NOT disable Save, and the claim still reaches the server", async () => {
    vi.mocked(putUsername).mockRejectedValue(new SocialApiError(400, "reserved"));
    render(<SettingsChatPane />);
    typeUsername("admin");
    await waitFor(() => expect(checkState()).toBe("invalid"));

    expect((screen.getByTestId("chat-username-save") as HTMLButtonElement).disabled).toBe(false);
    clickSave();

    await waitFor(() => expect(putUsername).toHaveBeenCalledWith("admin"));
  });

  it("does NOT suppress or reinterpret the server's own refusal", async () => {
    vi.mocked(putUsername).mockRejectedValue(new SocialApiError(400, "reserved"));
    render(<SettingsChatPane />);
    typeUsername("admin");
    clickSave();

    // The server's answer is what the user is told, arriving through `claimRemedy` exactly as it
    // would for a name the client had no opinion about.
    await waitFor(() => expect(screen.getByTestId("chat-claim-note")).toBeTruthy());
    expect(screen.getByTestId("chat-claim-note").textContent).toContain("reserved");
    expect(useSocialStore.getState().me.username).toBeNull();
  });

  it("an ordinary name is unaffected — the check is a list, not a mood", async () => {
    render(<SettingsChatPane />);
    typeUsername("admin1");
    await waitFor(() => expect(checkState()).toBe("available"), { timeout: 2000 });
    expect(getUser).toHaveBeenCalledWith("admin1");
  });
});
