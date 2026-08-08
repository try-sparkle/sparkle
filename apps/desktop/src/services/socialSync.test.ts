// What these assert, and what they deliberately do NOT: every case reads the STORE afterwards —
// `useSocialStore.getState().people` — not "was fetch called". "fetch was called" was already true
// of a loop that dropped every response on the floor, which is the exact bug this module was
// written to end (a complete client and a complete store with nothing between them).
//
// The transport is stubbed at `__setSocialApiDeps`, one layer BELOW `socialApi`, so each test drives
// the real request path and the real 404/401 → `SocialApiError` mapping. Mocking `socialApi` itself
// would have let a wrong status classification pass.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { __setSocialApiDeps } from "./socialApi";
import {
  startSocialSync,
  syncSocialRoster,
  SOCIAL_POLL_MS,
  MAX_DIRECTORY_PAGES,
  UNUSABLE_PROFILE_LIMIT,
  resumeSocialSync,
} from "./socialSync";
import {
  useSocialStore,
  EMPTY_PROFILE,
  otherPeopleList,
  peopleList,
} from "../stores/socialStore";

/** The keychain, driven from the tests. `hasToken()` is `invoke("desktop_has_token")` and the pass
 *  is gated on it — deliberately on the REAL answer rather than `authStore.tokenPresent`, which is
 *  set optimistically from a cached entitlement before the keychain is ever read. */
const keychain = vi.hoisted(() => ({ hasToken: true }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => (cmd === "desktop_has_token" ? keychain.hasToken : null),
}));

function jsonRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** One reply, evaluated per call so a handler can page, hang, or throw. Throwing simulates a
 *  transport failure — `socialApi` turns a rejected `fetch` into a `SocialNetworkError`; returning
 *  an unresolved promise simulates a slow server. */
type Reply = (url: string) => Response | Promise<Response>;

interface Routes {
  profile?: Reply;
  connections?: Reply;
  directory?: Reply;
}

const ME = {
  socialId: "me-1",
  username: "founder",
  displayName: "The Founder",
  visibility: "public",
};

const okProfile: Reply = () => jsonRes(200, ME);
const noConnections: Reply = () => jsonRes(200, { accepted: [], incoming: [], outgoing: [] });
const emptyDirectory: Reply = () => jsonRes(200, { users: [], nextCursor: null });

let fetchMock: ReturnType<typeof vi.fn>;
let restore: () => void;
let stopSync: (() => void) | null = null;

function install(routes: Routes = {}): void {
  const profile = routes.profile ?? okProfile;
  const connections = routes.connections ?? noConnections;
  const directory = routes.directory ?? emptyDirectory;
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes("/account/profile")) return profile(url);
    if (url.includes("/social/connections")) return connections(url);
    if (url.includes("/social/directory")) return directory(url);
    throw new Error(`unrouted in test: ${url}`);
  });
  restore = __setSocialApiDeps({
    fetch: fetchMock as unknown as typeof fetch,
    getToken: async () => "tok-123",
    baseUrl: "https://api.test",
  });
}

const people = () => useSocialStore.getState().people;
const urlsHit = () => fetchMock.mock.calls.map((c) => c[0] as string);

beforeEach(() => {
  useSocialStore.getState().reset();
  // Signed in. Every pass is gated on a real bearer being present — see the "no bearer" case below,
  // which is the one that leaves this false.
  keychain.hasToken = true;
  // The module's own "going quiet" line and its transient-failure warning are deliberate; silence
  // them so a red suite shows only what actually failed.
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  install();
});

afterEach(() => {
  stopSync?.();
  stopSync = null;
  restore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("syncSocialRoster — a healthy pass", () => {
  it("puts the connections and the directory in the store as PEOPLE", async () => {
    install({
      connections: () =>
        jsonRes(200, {
          accepted: [{ id: "c1", socialId: "s-peer", username: "peer", displayName: "Peer Person" }],
          incoming: [{ id: "c2", socialId: "s-in", username: "asker", displayName: null }],
          outgoing: [],
        }),
      directory: () =>
        jsonRes(200, {
          users: [{ socialId: "s-str", username: "stranger", displayName: null, online: true }],
          nextCursor: null,
        }),
    });

    await syncSocialRoster();

    const roster = people();
    expect(roster["s-peer"]).toMatchObject({
      username: "peer",
      displayName: "Peer Person",
      relationship: "connected",
      // A connection row carries no liveness field at all — never green on a missing fact.
      availability: "offline",
    });
    expect(roster["s-str"]).toMatchObject({
      username: "stranger",
      relationship: "stranger",
      availability: "available",
    });
    expect(roster["s-in"]).toMatchObject({ username: "asker", relationship: "pending_in" });
  });

  it("records my own profile and puts ME in the roster as `self`", async () => {
    await syncSocialRoster();

    expect(useSocialStore.getState().me).toMatchObject({
      socialId: "me-1",
      username: "founder",
      displayName: "The Founder",
      visibility: "public",
    });
    // The row that makes the feature visibly alive for a solo user with nobody to talk to.
    expect(people()["me-1"]).toMatchObject({
      username: "founder",
      relationship: "self",
      availability: "available",
    });
  });

  it("shows me as offline when my OWN visibility is `unavailable` (§6.3)", async () => {
    install({ profile: () => jsonRes(200, { ...ME, visibility: "unavailable" }) });

    await syncSocialRoster();

    expect(people()["me-1"]!.availability).toBe("offline");
  });

  it("files pending requests into `incoming` / `outgoing`", async () => {
    install({
      connections: () =>
        jsonRes(200, {
          accepted: [],
          incoming: [{ id: "c2", socialId: "s-in", username: "asker", displayName: null }],
          outgoing: [{ id: "c3", socialId: "s-out", username: "asked", displayName: "Asked" }],
        }),
    });

    await syncSocialRoster();

    expect(useSocialStore.getState().incoming).toEqual([
      { id: "c2", socialId: "s-in", username: "asker", displayName: null },
    ]);
    expect(useSocialStore.getState().outgoing).toEqual([
      { id: "c3", socialId: "s-out", username: "asked", displayName: "Asked" },
    ]);
  });
});

describe("syncSocialRoster — merging the three sources", () => {
  it("collapses a connection ALSO seen in the directory into one CONNECTED person", async () => {
    install({
      connections: () =>
        jsonRes(200, {
          accepted: [{ id: "c1", socialId: "s-both", username: "peer", displayName: "Peer Person" }],
          incoming: [],
          outgoing: [],
        }),
      directory: () =>
        jsonRes(200, {
          users: [{ socialId: "s-both", username: "peer", displayName: "Peer Person", online: true }],
          nextCursor: null,
        }),
    });

    await syncSocialRoster();

    const roster = people();
    // One row, not two — and the directory sighting must not demote a connection to a stranger.
    expect(Object.keys(roster).filter((id) => id !== "me-1")).toEqual(["s-both"]);
    expect(roster["s-both"]!.relationship).toBe("connected");
    // …while still taking the liveness the directory row is the only source of.
    expect(roster["s-both"]!.availability).toBe("available");
  });

  it("stops paging the directory after MAX_DIRECTORY_PAGES even when the cursor keeps coming", async () => {
    let page = 0;
    install({
      directory: () => {
        page += 1;
        return jsonRes(200, {
          users: [{ socialId: `s-${page}`, username: `u${page}`, displayName: null, online: false }],
          nextCursor: `cursor-${page}`, // never null: an unbounded walk would never stop
        });
      },
    });

    await syncSocialRoster();

    expect(urlsHit().filter((u) => u.includes("/social/directory"))).toHaveLength(
      MAX_DIRECTORY_PAGES,
    );
    expect(urlsHit().some((u) => u.includes("cursor=cursor-1"))).toBe(true);
  });
});

describe("syncSocialRoster — availability is never asserted on missing evidence (§6.3)", () => {
  it("reads an offline directory peer as offline", async () => {
    install({
      directory: () =>
        jsonRes(200, {
          users: [{ socialId: "s-off", username: "sleeper", displayName: null, online: false }],
          nextCursor: null,
        }),
    });

    await syncSocialRoster();

    expect(people()["s-off"]!.availability).toBe("offline");
  });

  it("reads an `unavailable` peer as offline EVEN WHEN the socket says online", async () => {
    install({
      directory: () =>
        jsonRes(200, {
          users: [
            {
              socialId: "s-invis",
              username: "ghost",
              displayName: null,
              online: true,
              visibility: "unavailable",
            },
          ],
          nextCursor: null,
        }),
    });

    await syncSocialRoster();

    expect(people()["s-invis"]!.availability).toBe("offline");
  });
});

describe("syncSocialRoster — guards on the way in", () => {
  it("makes NO request at all without a bearer", async () => {
    // `AuthGate` renders its children on the anonymous trial branch too, so this component can be
    // mounted with no token. An unauthed request would earn a correct 401, which would reset the
    // store and latch the loop off for the whole session — and converting to a paid account does
    // not remount it.
    keychain.hasToken = false;

    await expect(syncSocialRoster()).resolves.toBeUndefined();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(useSocialStore.getState().me).toEqual(EMPTY_PROFILE);
  });

  it("keeps polling after a token-less pass, so signing in is picked up on the next tick", async () => {
    keychain.hasToken = false;
    vi.useFakeTimers();
    stopSync = startSocialSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).not.toHaveBeenCalled();

    keychain.hasToken = true;
    await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS);

    expect(people()["me-1"]).toMatchObject({ relationship: "self" });
  });

  it("does not stack passes when the server is slower than the poll", async () => {
    let release: (res: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    install({ profile: () => held });

    // Two overlapping passes — a 15s-per-request pass can outrun the 60s poll, and two complete
    // passes racing on `setPeople` (a REPLACE) can land oldest-last and resurrect people who were
    // disconnected in between.
    const first = syncSocialRoster();
    const second = syncSocialRoster();
    release(jsonRes(200, ME));
    await Promise.all([first, second]);

    expect(urlsHit().filter((u) => u.includes("/account/profile"))).toHaveLength(1);
  });

  it("RECOVERS from one unusable body — a dropped response must not cost the session", async () => {
    // `readJson` answers `null` for a 2xx that is not JSON: an empty body, a 204, a proxy page, or
    // a connection dropped mid-body. That last one is a transport fault, and this module's policy
    // is that transport faults fix themselves on the next tick.
    let calls = 0;
    install({
      profile: () => {
        calls += 1;
        if (calls > 1) return jsonRes(200, ME);
        return {
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token <");
          },
        } as unknown as Response;
      },
    });
    vi.useFakeTimers();

    stopSync = startSocialSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(people()).toEqual({}); // nothing usable arrived, and nothing was invented
    expect(useSocialStore.getState().me).toEqual(EMPTY_PROFILE);

    await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS);

    // Still polling, and the very next body populated the roster.
    expect(people()["me-1"]).toMatchObject({ relationship: "self" });
  });

  it("only counts CONSECUTIVE unusable bodies — a good one wipes the slate", async () => {
    // A flaky link that drops every other body must never accumulate its way to a permanent stop.
    let calls = 0;
    const unusable = {
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    } as unknown as Response;
    install({
      profile: () => {
        calls += 1;
        return calls % 2 === 1 ? unusable : jsonRes(200, ME);
      },
    });
    vi.useFakeTimers();

    stopSync = startSocialSync();
    await vi.advanceTimersByTimeAsync(0);
    // Five more ticks: bad, good, bad, good, bad, good — three bad bodies in all, but never three
    // in a ROW. Without the reset the third one latches and the sixth pass never happens.
    await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS * 5);

    expect(urlsHit().filter((u) => u.includes("/account/profile"))).toHaveLength(6);
    expect(people()["me-1"]).toMatchObject({ relationship: "self" });
  });

  it(`gives up after ${UNUSABLE_PROFILE_LIMIT} unusable bodies rather than polling forever`, async () => {
    install({
      profile: () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token <");
          },
        }) as unknown as Response,
    });
    vi.useFakeTimers();

    stopSync = startSocialSync();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS * 10);

    // QUIET is the assertion, not "the store stayed empty" — dereferencing the null body would
    // ALSO leave it empty, just by throwing a TypeError into the catch-all once a minute forever.
    // Exactly N probes: the strike counter stops the clock, and no later tick lands.
    expect(urlsHit()).toHaveLength(UNUSABLE_PROFILE_LIMIT);
    expect(people()).toEqual({});
    expect(useSocialStore.getState().me).toEqual(EMPTY_PROFILE);
  });

  it("reads a profile with NO visibility as offline — never available on a missing field", async () => {
    install({
      profile: () => jsonRes(200, { socialId: "me-1", username: "founder", displayName: null }),
    });

    await syncSocialRoster();

    expect(useSocialStore.getState().me.visibility).toBe("unavailable");
    expect(people()["me-1"]!.availability).toBe("offline");
  });
});

describe("syncSocialRoster — the failures", () => {
  it("a 404 (feature dark / no username) leaves the store empty and does not throw", async () => {
    install({ profile: () => jsonRes(404, { error: "not_found" }) });

    await expect(syncSocialRoster()).resolves.toBeUndefined();

    expect(people()).toEqual({});
    expect(useSocialStore.getState().me).toEqual(EMPTY_PROFILE);
    // It did not even ask for a roster it now knows cannot exist.
    expect(urlsHit().some((u) => u.includes("/social/"))).toBe(false);
  });

  it("a 401 resets the store — every row in it is another account's view of other people", async () => {
    useSocialStore.getState().setPeople([
      {
        socialId: "s-old",
        username: "someone",
        displayName: null,
        relationship: "connected",
        availability: "available",
      },
    ]);
    useSocialStore.getState().setMyProfile({ username: "founder", socialId: "me-1" });
    install({ profile: () => jsonRes(401, { error: "unauthorized" }) });

    await expect(syncSocialRoster()).resolves.toBeUndefined();

    expect(people()).toEqual({});
    expect(useSocialStore.getState().me).toEqual(EMPTY_PROFILE);
  });

  it("a network error does not throw and does not blank an already-populated roster", async () => {
    useSocialStore.getState().setPeople([
      {
        socialId: "s-old",
        username: "someone",
        displayName: null,
        relationship: "connected",
        availability: "available",
      },
    ]);
    install({
      directory: () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await expect(syncSocialRoster()).resolves.toBeUndefined();

    // The partial pass may only ADD: the person it could not re-confirm is still there, and so is
    // the self row it did learn.
    expect(people()["s-old"]).toMatchObject({ username: "someone", relationship: "connected" });
    expect(people()["me-1"]).toMatchObject({ relationship: "self" });
  });

  it("a 401 from a ROSTER call resets too — even after the profile already landed", async () => {
    useSocialStore.getState().setPeople([
      {
        socialId: "s-old",
        username: "someone",
        displayName: null,
        relationship: "connected",
        availability: "available",
      },
    ]);
    install({ directory: () => jsonRes(401, { error: "unauthorized" }) });

    await expect(syncSocialRoster()).resolves.toBeUndefined();

    // Same route pin as the 404 sibling: the 401 has to have come from the DIRECTORY, or this
    // silently becomes a second copy of the profile-401 case.
    expect(urlsHit()).toEqual([
      expect.stringContaining("/account/profile"),
      expect.stringContaining("/social/connections"),
      expect.stringContaining("/social/directory"),
    ]);
    // `me` was written from a 200 profile earlier in this same pass, so an EMPTY profile here is
    // proof the reset ran afterwards rather than proof it was never populated.
    expect(useSocialStore.getState().me).toEqual(EMPTY_PROFILE);
    expect(people()).toEqual({});
  });

  it("a 500 keeps the roster and does not throw", async () => {
    useSocialStore.getState().setPeople([
      {
        socialId: "s-old",
        username: "someone",
        displayName: null,
        relationship: "connected",
        availability: "offline",
      },
    ]);
    install({ connections: () => jsonRes(500, { error: "boom" }) });

    await expect(syncSocialRoster()).resolves.toBeUndefined();

    expect(people()["s-old"]).toBeDefined();
  });
});

describe("startSocialSync", () => {
  it("keeps polling while the surface answers", async () => {
    vi.useFakeTimers();
    stopSync = startSocialSync();
    await vi.advanceTimersByTimeAsync(0);
    const first = fetchMock.mock.calls.length;
    expect(first).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(first);
  });

  it("GOES QUIET on a 404 — it must not hammer a route that does not exist", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    install({ profile: () => jsonRes(404, { error: "not_found" }) });
    vi.useFakeTimers();

    stopSync = startSocialSync();
    await vi.advanceTimersByTimeAsync(0);
    const afterFirstPass = fetchMock.mock.calls.length;
    expect(afterFirstPass).toBe(1); // the profile probe, and nothing else

    await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS * 5);

    expect(fetchMock.mock.calls.length).toBe(afterFirstPass);
  });

  it("goes quiet when a ROSTER route 404s, not only the profile", async () => {
    // The profile is served but `/social/*` is not — the shape a half-registered surface has, and
    // the one a softened `attempt()` would retry forever.
    install({ connections: () => jsonRes(404, { error: "not_found" }) });
    vi.useFakeTimers();

    stopSync = startSocialSync();
    await vi.advanceTimersByTimeAsync(0);

    // PIN THE ROUTES, not just the count. "It stopped calling" is satisfied by a quiet that came
    // from the PROFILE — so if a route-matcher edit or a reordering of `onePass` ever made the
    // profile probe the thing that failed, this test would stay green while silently degrading
    // into a duplicate of the profile-404 case above, leaving the `attempt()` rethrow uncovered.
    expect(urlsHit()).toEqual([
      expect.stringContaining("/account/profile"),
      expect.stringContaining("/social/connections"),
    ]);
    const afterFirstPass = fetchMock.mock.calls.length;

    await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS * 5);

    expect(fetchMock.mock.calls.length).toBe(afterFirstPass);
  });

  it("is idempotent — a StrictMode/HMR double mount does not double the poll", async () => {
    vi.useFakeTimers();
    stopSync = startSocialSync();
    await vi.advanceTimersByTimeAsync(0);
    const onePass = fetchMock.mock.calls.length;
    expect(onePass).toBe(3); // profile + connections + one directory page

    // ABSOLUTE counts, deliberately. The earlier version of this test compared the first pass with
    // one tick — but an ungated second mount runs its own immediate pass AND arms a second
    // interval, so both quantities double together and the comparison stays true. It could not
    // tell one loop from two, which is the vacuous shape AGENTS.md names.
    const second = startSocialSync();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.length).toBe(onePass); // the second mount ran NO pass of its own

    await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS);

    expect(fetchMock.mock.calls.length).toBe(onePass * 2); // exactly ONE interval fired
    second();
  });

  it("stops polling when torn down", async () => {
    vi.useFakeTimers();
    const stop = startSocialSync();
    await vi.advanceTimersByTimeAsync(0);
    const before = fetchMock.mock.calls.length;
    stop();

    await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS * 3);

    expect(fetchMock.mock.calls.length).toBe(before);
  });
});

// ── The empty state, driven by the PRODUCTION writer ────────────────────────────────────────────
// roborev 60419/60423 asked for exactly this, and it is a stronger test than any store-level one:
// the previous coverage reached the empty branch by calling `setPeople([])` by hand, an input no
// writer in the tree produces. `onePass` always pushes the self row, so what a real solo pass
// writes is `setPeople([self])` — and the column must still read as empty, because it lists
// everyone BUT you.
describe("a solo user's complete pass — the empty state is REACHABLE", () => {
  it("writes exactly the self row, and the Chat column counts it as nobody", async () => {
    install({ profile: okProfile, connections: noConnections, directory: emptyDirectory });

    await syncSocialRoster();

    const state = useSocialStore.getState();
    // The pass SUCCEEDED, so the strongest empty line is licensed…
    expect(state.rosterLoaded).toBe(true);
    expect(state.profileLoaded).toBe(true);
    // …the store holds exactly one row and it is you…
    const all = peopleList(state.people);
    expect(all).toHaveLength(1);
    expect(all[0]!.relationship).toBe("self");
    // …and the column lists nobody, which is what makes CHAT_EMPTY_DETAIL_LIVE reachable at all.
    expect(otherPeopleList(state.people)).toHaveLength(0);
  });

  it("one real peer takes the column out of the empty state", async () => {
    install({
      profile: okProfile,
      connections: () =>
        jsonRes(200, {
          accepted: [{ id: "c1", socialId: "s-peer", username: "peer", displayName: null }],
          incoming: [],
          outgoing: [],
        }),
      directory: emptyDirectory,
    });

    await syncSocialRoster();

    // Paired with the case above: the same setup differing only in whether a peer exists must
    // produce a different answer, or neither test pins anything.
    const listed = otherPeopleList(useSocialStore.getState().people);
    expect(listed.map((p) => p.username)).toEqual(["peer"]);
  });
});

// ── A 404 on the profile is an ANSWER about you, and must be recorded ───────────────────────────
// roborev 60435 (High). Without this, `profileLoaded` stays false for every user who has not
// claimed a handle — the exact group "Pick a username to join." exists for — so they sit on
// "Looking for people…" forever and the no-handle rung is unreachable in the shipping app.
describe("the profile 404 — no social identity", () => {
  it("records the read, so the no-handle line becomes reachable", async () => {
    install({ profile: () => jsonRes(404, { error: "not_found" }) });

    await syncSocialRoster();

    const state = useSocialStore.getState();
    // The read HAPPENED and its answer was "you have none" — both halves matter.
    expect(state.profileLoaded).toBe(true);
    expect(state.me.username).toBeNull();
    // …and the roster was never read, so the two flags do not move together.
    expect(state.rosterLoaded).toBe(false);
  });

  it("a 401 never records a read — asserted at the MOMENT, not after the reset", async () => {
    // Reading `profileLoaded` after the call would be VACUOUS: the 401 path calls reset(), which
    // restores profileLoaded:false anyway, so widening the guard to every SocialApiError — exactly
    // the mutation this test names — would still leave a post-hoc assertion green. Subscribing
    // catches the write at the instant it would happen, before the reset erases the evidence.
    install({ profile: () => jsonRes(401, { error: "unauthorized" }) });
    const seen: boolean[] = [];
    const unsub = useSocialStore.subscribe((s) => seen.push(s.profileLoaded));

    await syncSocialRoster();
    unsub();

    expect(seen.some(Boolean)).toBe(false);
  });

  it("a 500 never records a read — and nothing resets behind it", async () => {
    // The status that genuinely has no safety net: a transient failure does not reset, so a
    // mis-widened guard here would latch a false `profileLoaded: true` for the whole session.
    install({ profile: () => jsonRes(500, { error: "boom" }) });

    await syncSocialRoster();

    expect(useSocialStore.getState().profileLoaded).toBe(false);
    expect(useSocialStore.getState().me.username).toBeNull();
  });

  it("a 404 AFTER a good read does not erase the handle you already have", async () => {
    // A pass runs once a minute, so this is an ordinary sequence: mid-session deploy, edge 404,
    // row removed. Erasing here would tell a user who HAS a handle to pick one, and re-open the
    // claim form for a name whose save can only answer 409 username_immutable.
    install({ profile: okProfile, connections: noConnections, directory: emptyDirectory });
    await syncSocialRoster();
    const claimed = useSocialStore.getState().me.username;
    expect(claimed).not.toBeNull();

    install({ profile: () => jsonRes(404, { error: "not_found" }) });
    await syncSocialRoster();

    const me = useSocialStore.getState().me;
    expect(me.username).toBe(claimed);
    // …and `me` is not left a chimera: the rest of the good read survives with it.
    expect(me.socialId).not.toBeNull();
  });
});

// ── The race the snapshot form could not see ────────────────────────────────────────────────────
// roborev 60446. Every other test drives the store serially, so the pass's opening snapshot and the
// live state are never allowed to differ — which is exactly the window this covers: a handle
// claimed from SettingsChatPane WHILE a profile request is in flight.
it("a handle claimed mid-pass survives the in-flight 404", async () => {
  let release: (() => void) | undefined;
  let requested: (() => void) | undefined;
  // Resolves the instant the profile handler is ENTERED. Awaiting this is what guarantees the pass
  // has already captured its `store` snapshot — a bare `await Promise.resolve()` does not, because
  // the snapshot is taken after an `await hasToken()`, so the claim below would land BEFORE the
  // snapshot and both the correct and the buggy form would pass.
  const inFlight = new Promise<void>((r) => {
    requested = r;
  });
  install({
    profile: () => {
      requested?.();
      return new Promise<Response>((resolve) => {
        release = () => resolve(jsonRes(404, { error: "not_found" }));
      }) as unknown as Response;
    },
  });

  const pass = syncSocialRoster();
  await inFlight; // the snapshot now exists and holds `username: null`

  // The user claims a username while that request is still out.
  useSocialStore.getState().setMyProfile({ username: "founder", socialId: "me-1" });

  // The stale request — issued before the row existed — now answers 404.
  release?.();
  await pass;

  // Reading the pass's opening snapshot here would see `null` and erase the claim.
  expect(useSocialStore.getState().me.username).toBe("founder");
  expect(useSocialStore.getState().me.socialId).toBe("me-1");
});

// ── The loop must survive the state that silenced it ────────────────────────────────────────────
// roborev 60447. `goQuiet` is permanent for the session by design, but claiming a username CHANGES
// the answer it gave up on. Without a way back the ordinary first-run path dead-ends: launch with
// no handle, first pass 404s, quiet, claim a handle, roster never loads until restart.
describe("resumeSocialSync", () => {
  it("re-arms the loop a 404 silenced, so a fresh claim is not stuck until restart", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    install({ profile: () => jsonRes(404, { error: "not_found" }) });
    vi.useFakeTimers();

    // Launch with no handle: the first pass 404s and the poll timer is torn down.
    stopSync = startSocialSync();
    await vi.advanceTimersByTimeAsync(0);
    const afterQuiet = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS * 3);
    expect(fetchMock.mock.calls.length).toBe(afterQuiet); // genuinely silent

    // The user claims a handle in Settings; the route now answers.
    install({ profile: okProfile, connections: noConnections, directory: emptyDirectory });
    resumeSocialSync();
    await vi.advanceTimersByTimeAsync(0);

    // It read immediately…
    expect(useSocialStore.getState().rosterLoaded).toBe(true);
    expect(useSocialStore.getState().me.username).toBe(ME.username);

    // …AND the recurring poll is alive again, which is the half a one-shot re-read would miss.
    const afterResume = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterResume);
  });
});

// ── A resume that lands MID-PASS ────────────────────────────────────────────────────────────────
// roborev 60450. The resume above only covers a settled pass. The dangerous ordering is the other
// one — the launch pass is still waiting on its profile request when the user claims a handle — and
// it defeated the first version of the fix twice over: `syncSocialRoster()` returned early on
// `inFlight` so the read was DROPPED, `timer` was still non-null so the re-arm was skipped, and then
// the stale pass's 404 re-latched quiet with nothing left to undo it.
it("a resume during an in-flight pass is deferred, not dropped, and the 404 cannot re-silence it", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  let release: (() => void) | undefined;
  let requested: (() => void) | undefined;
  const inFlightNow = new Promise<void>((r) => {
    requested = r;
  });
  install({
    profile: () => {
      requested?.();
      return new Promise<Response>((resolve) => {
        release = () => resolve(jsonRes(404, { error: "not_found" }));
      }) as unknown as Response;
    },
  });
  vi.useFakeTimers();

  stopSync = startSocialSync();
  await inFlightNow; // pass A is parked on its profile request

  // The user claims a handle mid-pass, and the route starts answering.
  useSocialStore.getState().setMyProfile({ username: "founder", socialId: "me-1" });
  install({ profile: okProfile, connections: noConnections, directory: emptyDirectory });
  resumeSocialSync();

  // Pass A's stale 404 now lands. It must NOT latch quiet: it was issued about the old world.
  release?.();
  await vi.advanceTimersByTimeAsync(0);

  // The deferred pass ran and actually read the roster…
  await vi.waitFor(() => expect(useSocialStore.getState().rosterLoaded).toBe(true));
  // …and the loop is still alive, which is the half the stale 404 used to kill.
  const settled = fetchMock.mock.calls.length;
  await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS);
  expect(fetchMock.mock.calls.length).toBeGreaterThan(settled);
});

it("a 404 on the RESUMED pass is transient, because a claim cannot be repeated", async () => {
  // roborev 60450. `save()` resumes the moment `putUsername` returns, so the resumed pass races the
  // write's own propagation and can 404 on a row that exists. Latching there would kill the session
  // for a user who has a handle and did everything right — and there is no second kick, because a
  // username can be claimed only once (409 username_immutable).
  vi.spyOn(console, "info").mockImplementation(() => {});
  useSocialStore.getState().setMyProfile({ username: "founder", socialId: "me-1" });
  install({ profile: () => jsonRes(404, { error: "not_found" }) });
  vi.useFakeTimers();

  stopSync = startSocialSync();
  await vi.advanceTimersByTimeAsync(0);

  // The replica catches up and the route starts answering.
  install({ profile: okProfile, connections: noConnections, directory: emptyDirectory });
  await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS);

  // The loop retried rather than latching, so the roster actually loaded.
  await vi.waitFor(() => expect(useSocialStore.getState().rosterLoaded).toBe(true));
});

it("a 404 with NO handle known still latches — the honest dark case is unchanged", async () => {
  // The paired positive. Without it, the fix above could degrade into "never go quiet", which is
  // the once-a-minute poll against a dead route that the whole quiet mechanism exists to prevent.
  vi.spyOn(console, "info").mockImplementation(() => {});
  install({ profile: () => jsonRes(404, { error: "not_found" }) });
  vi.useFakeTimers();

  stopSync = startSocialSync();
  await vi.advanceTimersByTimeAsync(0);
  const afterFirst = fetchMock.mock.calls.length;

  await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS * 5);

  expect(fetchMock.mock.calls.length).toBe(afterFirst);
});

it("a slow pass does NOT turn the poll into a back-to-back loop", async () => {
  // roborev 60451. A pass can run ~75s against a 60s poll, so ticks landing mid-pass are the NORMAL
  // case for a degraded server, not an edge one. Queueing them would make the loop run as fast as a
  // pass completes and hammer the very backend that is already struggling — so a tick that overlaps
  // a pass must still be DROPPED. Only a resume defers.
  let release: (() => void) | undefined;
  let requested: (() => void) | undefined;
  const started = new Promise<void>((r) => {
    requested = r;
  });
  install({
    profile: () => {
      requested?.();
      return new Promise<Response>((resolve) => {
        release = () => resolve(jsonRes(200, ME));
      }) as unknown as Response;
    },
    connections: noConnections,
    directory: emptyDirectory,
  });
  vi.useFakeTimers();

  stopSync = startSocialSync();
  await started;
  const duringPass = fetchMock.mock.calls.length;

  // Two poll intervals elapse while the pass is still parked. No resume happened.
  await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS * 2);
  expect(fetchMock.mock.calls.length).toBe(duringPass); // every tick dropped, none queued

  // The pass finally completes. Its `finally` must NOT launch the ticks that were dropped.
  release?.();
  await vi.advanceTimersByTimeAsync(0);

  // COUNT THE PROFILE READS, not the total calls. A queued follow-up pass starts by reading the
  // profile again, so "exactly one" is the assertion that distinguishes dropped from queued — a
  // raw total is satisfied either way, because the released pass's own connections/directory
  // requests land in the same window.
  const profileReads = urlsHit().filter((u) => u.includes("/account/profile")).length;
  expect(profileReads).toBe(1);
});

it("a PERMANENTLY 404ing profile route goes quiet even with a handle known", async () => {
  // roborev 60452. The transient path serves a replica-lag race that resolves in seconds. The
  // states that never resolve — a half-registered surface, a mid-session deploy, a deleted row —
  // must not poll a dead route once a minute for the life of the app, which is the exact failure
  // this module's header names. Bounded by the same strike counter as the unusable-body case.
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  useSocialStore.getState().setMyProfile({ username: "founder", socialId: "me-1" });
  install({ profile: () => jsonRes(404, { error: "not_found" }) });
  vi.useFakeTimers();

  stopSync = startSocialSync();
  await vi.advanceTimersByTimeAsync(0);

  // Run well past the strike limit.
  await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS * (UNUSABLE_PROFILE_LIMIT + 3));
  const settled = fetchMock.mock.calls.length;

  // It stopped at the limit rather than retrying forever…
  expect(settled).toBe(UNUSABLE_PROFILE_LIMIT);
  await vi.advanceTimersByTimeAsync(SOCIAL_POLL_MS * 3);
  expect(fetchMock.mock.calls.length).toBe(settled);
  // …and said so on the first strike, so the state is diagnosable before it latches.
  expect(vi.mocked(console.warn)).toHaveBeenCalled();
});
