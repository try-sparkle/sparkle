// @vitest-environment jsdom
//
// ChatSection × the server's `socialEnabled` verdict.
//
// TWO RULES ARE PINNED HERE AND THEY PULL IN OPPOSITE DIRECTIONS, which is why they are tested
// together rather than beside the rest of the block's coverage:
//
//   • An AFFIRMATIVE `false` — the server saying this account may not use Social Coding — removes
//     the block entirely.
//   • An ABSENT flag — an older server that predates the field, which is production today — does
//     NOT. It renders with honest copy.
//
// The second is the one that would rot silently. `socialEnabled === false` is the obvious guard and
// a truthiness check (`!socialEnabled`) passes every test written against the `false` case while
// quietly hiding the feature on every build until the orchestration deploy lands — i.e. it
// reintroduces the exact bug this whole branch exists to fix ("I don't see that in the build").
// A test that only covered `false` would go green on that regression, so the ABSENT case is
// asserted as its own fact, with a populated roster so "hidden" cannot be confused with "empty".
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
  CHAT_EMPTY_DETAIL,
  CHAT_EMPTY_DETAIL_LIVE,
  CHAT_EMPTY_DETAIL_LOADING,
  CHAT_EMPTY_DETAIL_NO_HANDLE,
  CHAT_EMPTY_TESTID,
  CHAT_SECTION_TESTID,
  ChatSection,
  chatEmptyDetail,
} from "./ChatSection";
import { PERSON_ROW_TESTID } from "./PersonRow";
import { useSocialStore, type Person } from "../stores/socialStore";
import { useAuthStore } from "../stores/authStore";
import type { Me } from "../services/entitlement";

function mkPerson(socialId: string, username: string): Person {
  return {
    socialId,
    username,
    displayName: null,
    availability: "available",
    relationship: "connected",
  };
}

/** Only the fields this component reads; the rest of `Me` is irrelevant to the gate. */
function setMe(over: Partial<Me> | null) {
  useAuthStore.setState({
    me: over === null ? null : ({ clerkUserId: "u1", entitled: true, balanceCents: 0, tokenVersion: 1, ...over } as Me),
  });
}

beforeEach(() => {
  useSocialStore.getState().reset();
  setMe(null);
});

afterEach(() => {
  cleanup();
  useSocialStore.getState().reset();
  setMe(null);
});

it("REMOVES the block when the server affirmatively says the account may not use social", () => {
  // Seeded with people so a passing assertion cannot be satisfied by an empty roster.
  useSocialStore.getState().setPeople([mkPerson("s1", "ada")]);
  setMe({ socialEnabled: false });

  render(<ChatSection pairSide="right" jointOpen={false} />);

  expect(screen.queryByTestId(CHAT_SECTION_TESTID)).toBeNull();
  expect(screen.queryAllByTestId(PERSON_ROW_TESTID)).toHaveLength(0);
});

it("KEEPS the block when the flag is absent — an older server is not a revocation", () => {
  useSocialStore.getState().setPeople([mkPerson("s1", "ada")]);
  setMe({}); // no `socialEnabled` key at all: production today

  render(<ChatSection pairSide="right" jointOpen={false} />);

  expect(screen.getByTestId(CHAT_SECTION_TESTID)).toBeTruthy();
  // The people really render — the block is not merely present-but-inert.
  expect(screen.getAllByTestId(PERSON_ROW_TESTID)).toHaveLength(1);
  expect(screen.getByText("ada")).toBeTruthy();
});

it("KEEPS the block when signed out entirely (`me` null)", () => {
  useSocialStore.getState().setPeople([mkPerson("s1", "ada")]);

  render(<ChatSection pairSide="right" jointOpen={false} />);

  expect(screen.getByTestId(CHAT_SECTION_TESTID)).toBeTruthy();
});

it("blames the DEPLOY when empty and the feature is not live", () => {
  setMe({}); // absent flag

  render(<ChatSection pairSide="right" jointOpen={false} />);

  expect(screen.getByTestId(CHAT_EMPTY_TESTID).textContent).toContain(CHAT_EMPTY_DETAIL);
});

// ── The empty state may only make a claim it has the evidence for ───────────────────────────────
// `people` being empty cannot tell "nobody is there" from "we never looked", so each stronger line
// is gated on one more fact. These three cases are roborev 60400's second finding: without them the
// UI asserts an empty DIRECTORY on the strength of a fact about the ACCOUNT's permission.

it("asks you to claim a handle when live but you have no social identity", () => {
  setMe({ socialEnabled: true });
  useSocialStore.getState().setMyProfile({ username: null });

  render(<ChatSection pairSide="right" jointOpen={false} />);

  const empty = screen.getByTestId(CHAT_EMPTY_TESTID).textContent ?? "";
  expect(empty).toContain(CHAT_EMPTY_DETAIL_NO_HANDLE);
  expect(empty).not.toContain(CHAT_EMPTY_DETAIL_LIVE);
});

it("does NOT claim the directory is empty before a pass has succeeded", () => {
  setMe({ socialEnabled: true });
  useSocialStore.getState().setMyProfile({ username: "ada" });
  // No setPeople has run, so `rosterLoaded` is still false — empty here means UNREAD.

  render(<ChatSection pairSide="right" jointOpen={false} />);

  const empty = screen.getByTestId(CHAT_EMPTY_TESTID).textContent ?? "";
  expect(empty).toContain(CHAT_EMPTY_DETAIL_LOADING);
  expect(empty).not.toContain(CHAT_EMPTY_DETAIL_LIVE);
});

it("blames the EMPTY DIRECTORY only once a pass actually succeeded", () => {
  setMe({ socialEnabled: true });
  useSocialStore.getState().setMyProfile({ username: "ada" });
  // A COMPLETE pass that found nobody. This is the one state the strongest line may be said in.
  useSocialStore.getState().setPeople([]);

  render(<ChatSection pairSide="right" jointOpen={false} />);

  const empty = screen.getByTestId(CHAT_EMPTY_TESTID).textContent ?? "";
  expect(empty).toContain(CHAT_EMPTY_DETAIL_LIVE);
  // Every line is a distinct string, so no single hardcoded sentence can satisfy all four cases.
  expect(empty).not.toContain(CHAT_EMPTY_DETAIL);
  expect(empty).not.toContain(CHAT_EMPTY_DETAIL_LOADING);
});

it("an empty successful pass is what sets rosterLoaded — not merely having people", () => {
  // Pins the store side of the same rule: the flag is evidence of a READ, not of a population.
  expect(useSocialStore.getState().rosterLoaded).toBe(false);
  useSocialStore.getState().setPeople([]);
  expect(useSocialStore.getState().rosterLoaded).toBe(true);
});

it("chatEmptyDetail escalates only as each fact is established", () => {
  const live = { socialEnabled: true, profileLoaded: true, hasHandle: true, rosterLoaded: true };
  expect(chatEmptyDetail(live)).toBe(CHAT_EMPTY_DETAIL_LIVE);
  expect(chatEmptyDetail({ ...live, rosterLoaded: false })).toBe(CHAT_EMPTY_DETAIL_LOADING);
  expect(chatEmptyDetail({ ...live, hasHandle: false })).toBe(CHAT_EMPTY_DETAIL_NO_HANDLE);
  expect(chatEmptyDetail({ ...live, socialEnabled: false })).toBe(CHAT_EMPTY_DETAIL);
  expect(chatEmptyDetail({ ...live, socialEnabled: undefined })).toBe(CHAT_EMPTY_DETAIL);
  // Not-live wins over everything below it: a revoked account is never told to pick a username.
  expect(
    chatEmptyDetail({
      socialEnabled: false,
      profileLoaded: false,
      hasHandle: false,
      rosterLoaded: false,
    }),
  ).toBe(CHAT_EMPTY_DETAIL);
  // Rung 2: an unread profile must NOT be reported as "you have no username" — that is the line
  // that would send an already-registered user off to claim an identity they already hold.
  expect(chatEmptyDetail({ ...live, profileLoaded: false, hasHandle: false })).toBe(
    CHAT_EMPTY_DETAIL_LOADING,
  );
});

// ── The self row must not be LISTED, or the empty state is unreachable ──────────────────────────
// roborev 60423's first finding. `socialSync` pushes your own row into `people` unconditionally, so
// counting it makes `rows.length === 0` impossible in the shipping app — the whole empty block, and
// the "No one ELSE has joined yet" line that already presumes this filter, would be dead copy.

it("does not LIST you — a roster holding only yourself still reads as empty", () => {
  setMe({ socialEnabled: true });
  useSocialStore.getState().setMyProfile({ username: "drodio", socialId: "me-1" });
  // Exactly what a complete pass writes for a solo user: one row, and it is you.
  useSocialStore.getState().setPeople([
    {
      socialId: "me-1",
      username: "drodio",
      displayName: null,
      availability: "available",
      relationship: "self",
    },
  ]);

  render(<ChatSection pairSide="right" jointOpen={false} />);

  expect(screen.queryAllByTestId(PERSON_ROW_TESTID)).toHaveLength(0);
  // …and the empty state is REACHED, which is the part that was impossible before.
  expect(screen.getByTestId(CHAT_EMPTY_TESTID).textContent).toContain(CHAT_EMPTY_DETAIL_LIVE);
});

it("lists a peer alongside a self row, counting only the peer", () => {
  setMe({ socialEnabled: true });
  useSocialStore.getState().setMyProfile({ username: "drodio", socialId: "me-1" });
  useSocialStore.getState().setPeople([
    { socialId: "me-1", username: "drodio", displayName: null, relationship: "self" },
    { socialId: "s2", username: "ada", displayName: null, relationship: "connected" },
  ]);

  render(<ChatSection pairSide="right" jointOpen={false} />);

  expect(screen.getAllByTestId(PERSON_ROW_TESTID)).toHaveLength(1);
  expect(screen.getByText("ada")).toBeTruthy();
  expect(screen.queryByText("drodio")).toBeNull();
  expect(screen.queryByTestId(CHAT_EMPTY_TESTID)).toBeNull();
});

it("tells an already-registered user nothing while their profile is unread", () => {
  // The cold-launch window, and permanently if the profile read fails out. Testing `hasHandle`
  // before `profileLoaded` would tell this user to pick a username they already have.
  setMe({ socialEnabled: true });
  // No setMyProfile has run: profileLoaded is false and username is null for BOTH reasons.

  render(<ChatSection pairSide="right" jointOpen={false} />);

  const empty = screen.getByTestId(CHAT_EMPTY_TESTID).textContent ?? "";
  expect(empty).toContain(CHAT_EMPTY_DETAIL_LOADING);
  expect(empty).not.toContain(CHAT_EMPTY_DETAIL_NO_HANDLE);
});
