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
  getUser,
  putUsername,
  putVisibility,
  SocialApiError,
  SocialNetworkError,
  type PublicProfile,
} from "../services/socialApi";
import { useSocialStore, EMPTY_PROFILE } from "../stores/socialStore";
import { useAuthStore } from "../stores/authStore";
import { SettingsChatPane, USERNAME_CHECK_DEBOUNCE_MS } from "./SettingsChatPane";

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

beforeEach(() => {
  // `visibilityConfirmed` too: it is store state that outlives a test, and leaking a `true` into
  // the next one would silently hide the caveat every later test asserts on.
  useSocialStore.setState({ me: EMPTY_PROFILE, visibilityConfirmed: false });
  useAuthStore.setState({ me: null, tokenPresent: true, loading: false });
  vi.mocked(getUser).mockRejectedValue(new SocialApiError(404, null));
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
    useSocialStore.setState({ me: { ...EMPTY_PROFILE, visibility: "public" } });
    vi.mocked(putVisibility).mockRejectedValue(new SocialApiError(404, null));
    render(<SettingsChatPane />);

    fireEvent.click(screen.getByTestId("chat-visibility-unavailable"));

    await waitFor(() => expect(screen.getByTestId("chat-not-live")).toBeTruthy());
    // The store must NOT have moved: the server never accepted it.
    expect(useSocialStore.getState().me.visibility).toBe("public");
    expect(putVisibility).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsChatPane — availability", () => {
  // SEEDED TO `public` FIRST, on purpose: `unavailable` is the store's default, so the obvious
  // version of this test passes against a pane that renders three inert radios.
  it("choosing Unavailable calls putVisibility('unavailable') and the store reflects it", async () => {
    useSocialStore.setState({ me: { ...EMPTY_PROFILE, visibility: "public" } });
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "unavailable" });
    render(<SettingsChatPane />);
    expect(useSocialStore.getState().me.visibility).toBe("public");

    fireEvent.click(screen.getByTestId("chat-visibility-unavailable"));

    await waitFor(() => expect(putVisibility).toHaveBeenCalledWith("unavailable"));
    await waitFor(() => expect(useSocialStore.getState().me.visibility).toBe("unavailable"));
  });

  it("offers the founder's three words, and starts everyone at Unavailable", () => {
    render(<SettingsChatPane />);
    const group = screen.getByRole("radiogroup", { name: "Availability" });
    // Scoped to the group: "Unavailable" also appears in the copy above it, and an unscoped query
    // would match both and fail on the ambiguity rather than on the thing being asserted.
    for (const label of ["Available: Public", "Available: Connections only", "Unavailable"]) {
      expect(within(group).getByText(label)).toBeTruthy();
    }
    expect((screen.getByTestId("chat-visibility-unavailable") as HTMLInputElement).checked).toBe(
      true,
    );
  });

  // THE PATH THE COPY DIRECTS PEOPLE TO. The caveat says "choose again here to be sure", and the
  // one option a returning user most wants to re-assert — Unavailable — is the one already checked
  // in every un-hydrated session. A browser fires no `change` for a click on an already-checked
  // radio, so before the onClick handler this instruction was a silent no-op: no request, no
  // spinner, no confirmation, and nothing to distinguish it from a successful re-assert.
  it("re-asserting the ALREADY-SELECTED option still calls putVisibility", async () => {
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "unavailable" });
    render(<SettingsChatPane />);
    const radio = screen.getByTestId("chat-visibility-unavailable") as HTMLInputElement;
    expect(radio.checked).toBe(true); // the un-hydrated default, and the whole problem

    fireEvent.click(radio);

    await waitFor(() => expect(putVisibility).toHaveBeenCalledWith("unavailable"));
  });

  it("does NOT double-send when the click actually changes the selection", async () => {
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "public" });
    render(<SettingsChatPane />);
    fireEvent.click(screen.getByTestId("chat-visibility-public"));
    await waitFor(() => expect(putVisibility).toHaveBeenCalledWith("public"));
    // Exactly one: the onChange path and the re-assert path must stay disjoint, or every ordinary
    // choice would issue two writes.
    expect(putVisibility).toHaveBeenCalledTimes(1);
  });

  // The caveat states something it can only know BEFORE a save. Afterwards `me.visibility` is the
  // value the server accepted (it is written only on a 2xx), so leaving the line up would tell the
  // user their setting had not landed at the exact moment it had.
  it("drops the 'this Mac may not know' caveat once the server has confirmed a choice", async () => {
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "public" });
    render(<SettingsChatPane />);
    expect(screen.getByTestId("chat-visibility-unknown")).toBeTruthy();

    fireEvent.click(screen.getByTestId("chat-visibility-public"));

    await waitFor(() => expect(screen.queryByTestId("chat-visibility-unknown")).toBeNull());
  });

  // THE FLAG'S LIFETIME, which the four tests above cannot see because they render ONCE. The pane
  // remounts on every rail click (SettingsDialog mounts only the active pane), so a component-local
  // flag would reset while `me.visibility` — which lives in the store — would not, and the caveat
  // would come back over a value the server confirmed a moment ago.
  it("keeps the caveat down across a REMOUNT — the confirmation outlives the pane", async () => {
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "public" });
    render(<SettingsChatPane />);
    fireEvent.click(screen.getByTestId("chat-visibility-public"));
    await waitFor(() => expect(screen.queryByTestId("chat-visibility-unknown")).toBeNull());

    // Navigate away and back, which is exactly what the settings rail does to this pane.
    cleanup();
    render(<SettingsChatPane />);

    expect(screen.queryByTestId("chat-visibility-unknown")).toBeNull();
    expect((screen.getByTestId("chat-visibility-public") as HTMLInputElement).checked).toBe(true);
  });

  // …and it must NOT outlive the HUMAN. Per-human state surviving a sign-out is a recurring leak in
  // this app; here `reset()` is what prevents it, so the next account starts unconfirmed rather
  // than inheriting the previous one's word for it.
  it("drops the confirmation on reset(), so the next account starts unconfirmed", async () => {
    vi.mocked(putVisibility).mockResolvedValue({ visibility: "public" });
    render(<SettingsChatPane />);
    fireEvent.click(screen.getByTestId("chat-visibility-public"));
    await waitFor(() => expect(useSocialStore.getState().visibilityConfirmed).toBe(true));

    act(() => useSocialStore.getState().reset());

    expect(useSocialStore.getState().visibilityConfirmed).toBe(false);
    cleanup();
    render(<SettingsChatPane />);
    expect(screen.getByTestId("chat-visibility-unknown")).toBeTruthy();
  });

  it("KEEPS the caveat when the save failed — nothing was confirmed", async () => {
    vi.mocked(putVisibility).mockRejectedValue(new SocialNetworkError());
    render(<SettingsChatPane />);
    fireEvent.click(screen.getByTestId("chat-visibility-public"));
    await waitFor(() => expect(screen.getByTestId("chat-visibility-note")).toBeTruthy());
    expect(screen.getByTestId("chat-visibility-unknown")).toBeTruthy();
  });

  it("choosing Public reaches the server and the store too (the opposite direction)", async () => {
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

  // BOTH CONTROLS READ AN UN-HYDRATED STORE, so both say which question they are answering. The
  // availability one matters more: the dot under-claims REACHABILITY (fail-closed), but a radio
  // stuck on `Unavailable` for a user the server lists as `public` under-claims EXPOSURE, which on
  // a privacy control is the direction that actually harms someone (roborev 60415).
  it("says out loud that both controls show what THIS MACHINE knows", () => {
    render(<SettingsChatPane />);
    expect(screen.getByTestId("chat-username-unknown").textContent).toContain(
      "may not know it yet",
    );
    expect(screen.getByTestId("chat-visibility-unknown").textContent).toContain("this Mac");
    expect(screen.getByTestId("chat-visibility-unknown").textContent).toContain("choose again");
  });

  it("does not tell the user their availability is unchanged — it cannot know that", () => {
    render(<SettingsChatPane />);
    // The copy this replaces read "Nothing here changes until you choose it", which is true of the
    // local field and false of the server row it is a picture of.
    expect(document.body.textContent).not.toContain("Nothing here changes until you choose it");
  });

  it("STATES that messages are not end-to-end encrypted rather than implying it (§6)", () => {
    render(<SettingsChatPane />);
    expect(screen.getByTestId("chat-encryption-notice").textContent).toContain(
      "not end-to-end encrypted",
    );
  });

  it("once a username is claimed it is shown as SETTLED — no field, no Save, no rename offer", () => {
    useSocialStore.setState({ me: { ...EMPTY_PROFILE, username: "ada_l" } });
    render(<SettingsChatPane />);
    expect(screen.getByTestId("chat-username-settled").textContent).toContain("permanent");
    expect(screen.queryByTestId("chat-username-input")).toBeNull();
    expect(screen.queryByTestId("chat-username-save")).toBeNull();
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
