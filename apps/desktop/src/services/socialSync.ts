// socialSync — the DATA LOOP behind the Chat section. Design:
// docs/superpowers/specs/2026-08-05-social-coding-design.md §5, §6.3, §6.6, §6.7.
//
// ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────────────────────────
// `services/socialApi` was complete and typed. `stores/socialStore` was complete and tested. The
// sidebar's Chat section was written against that store. And NOTHING CALLED EITHER OF THEM — the
// client had zero consumers, so the column was a component that would render beautifully if only it
// had data. This is the ~200 lines that fetch it. Same shape of gap `services/pusherMount` closed
// for the Pusher, and it is worth naming, because a store with no writer and a component with no
// store both type-check forever.
//
// ── WHY A 404 IS QUIET, AND WHY THAT IS THE COMMON CASE TODAY ────────────────────────────────────
// The social plugins are registered only behind `SOCIAL_ENABLED=1` (§6.7) and that is NOT set in
// production, so against the deployed service today EVERY path here answers 404. The identical 404
// is also the honest answer for a signed-in user who has simply never claimed a username. Neither
// is an error, neither is worth a log line per minute, and neither is fixed by trying again — so a
// 404 stops this loop for the session rather than backing off. "The whole feature is dark" must be
// an ordinary, silent, expected state; a client that retries a route that does not exist every
// minute for the lifetime of the app is the failure mode this rule exists to prevent.
//
// A 401 is different in kind: the viewer is gone, and everything in the store is another account's
// view of other people (see the store header). That resets and stops.
//
// A 5xx, a 429 or an offline transport is different again — those are transient, so the pass keeps
// whatever roster it already had and the next tick retries. The rule the three share: this module
// NEVER throws to its caller. It is mounted in a `useEffect`; a rejection there is an unhandled
// rejection in the app shell, for a feature that is off.
//
// ── WHY ONE `setPeople` PER PASS ─────────────────────────────────────────────────────────────────
// `setPeople` REPLACES the roster. Three sources feed it — the self row, accepted connections, the
// public directory — so calling it once per source would leave only the last one standing. They are
// merged here first, and a person seen twice keeps the STRONGER relationship (self > connected >
// pending > stranger): the directory lists everyone public, including people you are already
// connected to, and a connection must not be demoted to a stranger by the second sighting.

import { availabilityFromWire, type Availability, type Visibility } from "../engine/social";
import { hasToken } from "./sparkleApi";
import {
  useSocialStore,
  DEFAULT_AVAILABILITY,
  type ConnectionRequest,
  type Person,
  type Relationship,
} from "../stores/socialStore";
import {
  getConnections,
  getDirectory,
  getMyProfile,
  SocialApiError,
  SocialNetworkError,
  type ConnectionRow,
  type MyProfileResponse,
  type PublicProfile,
} from "./socialApi";

/** How often a healthy loop re-reads the roster. A minute, matching `LIMIT_POLL_MS` and the other
 *  ambient sweeps: presence deltas arrive over the socket (`peer_presence`, §6.5), so this poll is
 *  the slow correction, not the live channel. */
export const SOCIAL_POLL_MS = 60_000;

/** Server caps a directory page at 50 (§6.6); ask for the cap so a full page costs one round trip. */
export const DIRECTORY_PAGE_LIMIT = 50;

/**
 * How many directory pages one pass will walk. **A bound, not a page size** — the directory is every
 * public user on the service and it grows without limit, so an unbounded `while (nextCursor)` is a
 * loop whose cost is set by strangers. Three pages is ~150 people, far more than the column can show
 * at once, and the exact-username lookup (`getUser`) is the intended path to anyone past it.
 */
export const MAX_DIRECTORY_PAGES = 3;

/** How many CONSECUTIVE unusable profile bodies it takes to stop the loop. Not 1: a body that
 *  failed to parse is a transport fault and self-heals. Not unbounded: a route that has nothing to
 *  say has nothing to poll for. See the strike counter in `onePass`. */
export const UNUSABLE_PROFILE_LIMIT = 3;

/** Precedence when two sources describe the same `socialId`. Lower wins. `pending_in` and
 *  `pending_out` tie deliberately: they are opposite directions of the same "not connected yet"
 *  state and no sighting can produce both for one person. */
const RELATIONSHIP_RANK: Record<Relationship, number> = {
  self: 0,
  connected: 1,
  pending_in: 2,
  pending_out: 2,
  stranger: 3,
};

/** Lower is "more reachable". Used to pick between two sightings' availability — see
 *  {@link mergePerson} for why the more-available one wins and why that is not fail-open. */
const AVAILABILITY_RANK: Record<Availability, number> = { available: 0, away: 1, offline: 2 };

/**
 * A directory row AS IT MAY ACTUALLY ARRIVE. `PublicProfile` (§5) carries `online` and no
 * `visibility`, which is correct — visibility is the peer's own intent and not the viewer's
 * business. We read one anyway, optionally, because `socialApi`'s JSON parse is an unchecked cast
 * and §6.3's rule ("`unavailable` reports offline even when the socket is open") must hold the
 * moment the server ever sends one, not the release after.
 */
type DirectoryUser = PublicProfile & { visibility?: Visibility };

// ── One pass ────────────────────────────────────────────────────────────────────────────────────

/** The self row's availability. `online: true` is not an assumption — this code is running inside
 *  the app that holds the socket. So the only thing that can make the user's own dot dark is their
 *  own `unavailable` intent, which is exactly what §6.3 says it should do. */
function selfPerson(me: MyProfileResponse): Person {
  return {
    socialId: me.socialId,
    username: me.username,
    displayName: me.displayName ?? null,
    availability: availabilityFromWire({ visibility: me.visibility, online: true }),
    relationship: "self",
  };
}

/** A person from a connection row. `ConnectionRow` carries no liveness at all, so this is
 *  {@link DEFAULT_AVAILABILITY} — never "available" on the strength of a field that is not there.
 *  A directory sighting of the same person in the same pass supplies the real dot; the socket
 *  supplies it afterwards. */
function connectionPerson(row: ConnectionRow, relationship: Relationship): Person {
  return {
    socialId: row.socialId,
    username: row.username,
    displayName: row.displayName ?? null,
    availability: DEFAULT_AVAILABILITY,
    relationship,
  };
}

/**
 * A person from a directory row.
 *
 * The `?? "public"` is the one defaulted fact in this file and it is load-bearing, so: a user whose
 * visibility is `unavailable` is NOT IN THE DIRECTORY AT ALL (§6.3 — they answer 404 even to an
 * exact lookup), so directory membership already carries "this person is discoverable". Defaulting
 * the other way — treating a missing visibility as unavailable — would force every stranger's dot to
 * offline forever and delete the one row §6.3's table says a stranger may see live ("public:
 * stranger sees real liveness"). The server's `online` is already viewer-scoped (§5: a viewer not
 * entitled to liveness is sent `false`), so it, not this default, is what actually gates the dot.
 */
function directoryPerson(user: DirectoryUser): Person {
  return {
    socialId: user.socialId,
    username: user.username,
    displayName: user.displayName ?? null,
    availability: availabilityFromWire({
      visibility: user.visibility ?? "public",
      online: user.online === true,
    }),
    relationship: "stranger",
  };
}

function requestOf(row: ConnectionRow): ConnectionRequest {
  return {
    id: row.id,
    socialId: row.socialId,
    username: row.username,
    displayName: row.displayName ?? null,
  };
}

/**
 * Fold two sightings of one `socialId` into one row.
 *
 * Relationship: the stronger one, per {@link RELATIONSHIP_RANK}.
 *
 * Availability: the more available of the two, and that is NOT the fail-open direction it looks
 * like. No source in this module ever *defaults* to available — a connection row with no liveness
 * field yields `offline`, and the directory's `available` comes from the server's own viewer-scoped
 * `online`. So "take the more available" means "take the sighting that had evidence", never "assume
 * reachable because one source was silent".
 */
function mergePerson(a: Person, b: Person): Person {
  const strong = RELATIONSHIP_RANK[a.relationship] <= RELATIONSHIP_RANK[b.relationship] ? a : b;
  const weak = strong === a ? b : a;
  return {
    ...strong,
    displayName: strong.displayName ?? weak.displayName,
    availability:
      AVAILABILITY_RANK[a.availability] <= AVAILABILITY_RANK[b.availability]
        ? a.availability
        : b.availability,
  };
}

function mergeAll(people: readonly Person[]): Person[] {
  const byId = new Map<string, Person>();
  for (const person of people) {
    if (!person.socialId || !person.username) continue; // a row with no key cannot be addressed
    const existing = byId.get(person.socialId);
    byId.set(person.socialId, existing ? mergePerson(existing, person) : person);
  }
  return [...byId.values()];
}

/** Walk the directory to {@link MAX_DIRECTORY_PAGES}, following the opaque cursor. The cursor is
 *  keyed on `username_key` server-side and is never constructed or parsed here (§6.6). */
async function loadDirectory(): Promise<DirectoryUser[]> {
  const out: DirectoryUser[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_DIRECTORY_PAGES; page++) {
    const res = await getDirectory({ cursor, limit: DIRECTORY_PAGE_LIMIT });
    out.push(...((res?.users ?? []) as DirectoryUser[]));
    if (!res?.nextCursor) break;
    cursor = res.nextCursor;
  }
  return out;
}

/**
 * Run one roster call, turning a SURVIVABLE failure into `null`.
 *
 * 404 and 401 are not survivable and rethrow to the single handler in {@link syncSocialRoster}: the
 * first means the surface is not there, the second means the viewer is not, and both are decisions
 * about the whole loop rather than about this one call. Everything else — a 5xx, a 429, an offline
 * transport — yields `null`, which downgrades the pass from "replace the roster" to "merge in what
 * we did get" (see {@link syncSocialRoster}).
 */
async function attempt<T>(work: Promise<T>): Promise<T | null> {
  try {
    return await work;
  } catch (e) {
    if (e instanceof SocialApiError && (e.status === 404 || e.status === 401)) throw e;
    if (e instanceof SocialApiError || e instanceof SocialNetworkError) return null;
    throw e;
  }
}

/**
 * ONE pass: profile, connections, directory → one roster.
 *
 * The profile is first and its failures are NOT softened, because it is the canary: with the flag
 * off it 404s exactly like every other path, and there is no point asking for a directory that
 * cannot exist. Once it succeeds, the other two are soft — a pass that got some of the roster is
 * worth more than one that threw it away.
 */
async function onePass(): Promise<void> {
  // NO BEARER, NO REQUEST — and this guard, not the mount point, is what keeps the 401 latch below
  // from being spent on a user who was never signed in. `AuthGate` renders its children on the
  // anonymous TRIAL branch too, where the bearer is null; the request would go out unauthed
  // (`socialApi.request` simply omits the header), earn a perfectly correct 401, reset a store that
  // was already empty, and stop the loop for the session — and converting to a paid account does
  // NOT remount this component, so it would stay stopped until the app restarted. Skipping the pass
  // instead leaves the timer running, so the minute a token exists the next tick just works.
  //
  // `hasToken()` — the REAL keychain answer — and deliberately not `authStore.tokenPresent`, which
  // is optimistic: its persist `merge` sets it true from a valid cached entitlement before
  // `hasToken()` has ever run, so on cold launch the flag says yes while the bearer may not be
  // there at all. Gating on the flag would have left the exact hole this guard exists to close.
  // It fails CLOSED (its own `catch` returns false), so a keychain that cannot be read means no
  // request rather than an unauthed one.
  //
  // What this buys the 401 branch below: a pass only runs when a bearer really exists, so a 401 is
  // genuinely "the server rejected my bearer" and latching on it is honest.
  if (!(await hasToken())) return;

  const store = useSocialStore.getState();

  // `getMyProfile`'s return type says this cannot be null. It can: `socialApi`'s parse is an
  // unchecked `as T`, and `readJson` deliberately answers `null` for a 2xx whose body is not JSON —
  // an empty body, a 204, a proxy's HTML. Reading `.socialId` off that throws a TypeError once a
  // minute forever while the roster silently never populates, so the shape is checked here rather
  // than trusted.
  // A 404 HERE IS A COMPLETED READ, not a failure to read, and recording it is what makes
  // "Pick a username to join." reachable at all.
  //
  // `/account/profile` answers 404 for exactly one product reason: row existence IS "has a social
  // identity" (§6.1), so no row means you have none. That is an ANSWER — the route ran and told us
  // something true about you — and without writing it down `profileLoaded` stays false forever for
  // every user who has not claimed a handle, which is the one group the "pick a username" line is
  // written for. They would sit on "Looking for people…" permanently instead.
  //
  // Harmless when the whole feature is dark (the route is unregistered, so it 404s the same way):
  // `socialEnabled` is then not `true`, and `chatEmptyDetail`'s first rung wins before the handle
  // is ever consulted. Rethrown either way, so the existing 404 policy (go quiet for the session)
  // is unchanged — this only records the fact on the way past.
  let raw: MyProfileResponse | null;
  try {
    raw = (await getMyProfile()) as MyProfileResponse | null;
  } catch (e) {
    // ONLY when nothing better is already known. `onePass` runs once a minute, so a 404 can arrive
    // AFTER a successful read — a mid-session deploy unregistering the route, an edge/proxy 404,
    // the social row removed. Writing unconditionally would erase a known-good handle, and because
    // `setMyProfile` MERGES it would leave `me` a chimera: `username: null` beside a stale
    // `socialId`/`displayName`/`visibility` from the good read. The user-visible damage is real —
    // `hasHandle` flips false, so someone who HAS a handle is told "Pick a username to join." and
    // `SettingsChatPane` re-renders the claim form for a name whose save can only answer
    // `409 username_immutable`. When a handle is already stored `profileLoaded` is necessarily
    // already true, so skipping the write loses nothing.
    // `useSocialStore.getState()` HERE, not the `store` snapshot taken at the top of the pass.
    // That snapshot predates an awaited request bounded at 15s, and `SettingsChatPane.save()`
    // writes a freshly claimed handle into the same store from a different async path. So: pass
    // starts with no handle → request goes out → the user claims one → the in-flight request
    // (issued before the row existed) answers 404 → a snapshot read still sees `null` and erases
    // the handle that was just claimed. Worse than the case the guard was added for, because the
    // same 404 also latches `goQuiet`, so no later pass re-reads the profile and the user is stuck
    // on "Pick a username to join." for the session. Read the state at the moment of the decision.
    if (e instanceof SocialApiError && e.status === 404) {
      if (useSocialStore.getState().me.username == null) {
        store.setMyProfile({ username: null });
      } else {
        // A HANDLE WE ALREADY HOLD CONTRADICTS THIS 404, so it is transient and this pass simply
        // ends — it is NOT rethrown, so nothing latches quiet and the next tick retries.
        //
        // `save()` resumes the instant `putUsername` returns, so the resumed pass races the
        // write's own propagation (a read replica, an edge cache) and can 404 on a row that
        // exists. Latching there would kill the session for a user who has a handle and did
        // everything right, and there is NO SECOND KICK: a username can be claimed only once
        // (`409 username_immutable`), so nothing would ever call `resumeSocialSync` again.
        //
        // Scoped to the PROFILE read on purpose. A 404 from a ROSTER route is a different animal —
        // a half-registered surface where the profile is served and `/social/*` is not — and that
        // still latches, which `startSocialSync`'s "goes quiet when a ROSTER route 404s" case pins.
        //
        // BOUNDED, exactly like the unusable-body case below, because "not immediately permanent"
        // is not the same as "retry forever". The replica-lag race this serves resolves in seconds;
        // the states that do NOT are a half-registered surface (`PUT /account/username` served,
        // `GET /account/profile` not), a mid-session deploy that unregisters the route, and the
        // social row being deleted. In all three an unbounded retry polls a dead route once a
        // minute for the life of the app while the user sits on "Looking for people…" — the precise
        // failure this module's header says the quiet rule exists to prevent (roborev 60452).
        transientProfile404s += 1;
        if (transientProfile404s === 1) {
          // Warn on the FIRST strike, matching the 5xx branch: by the time it goes quiet the
          // interesting information is that it kept happening, and one line then is too late.
          console.warn("[social] profile 404 despite a known handle — treating as transient");
        }
        if (transientProfile404s >= UNUSABLE_PROFILE_LIMIT) {
          goQuiet(`the profile route answered 404 ${transientProfile404s}× running despite a known handle`);
        }
        return;
      }
    }
    throw e;
  }
  if (!raw?.socialId || !raw.username) {
    // NOT immediately permanent, and the distinction matters: `readJson` answers `null` for any
    // 2xx whose body failed to parse — a connection dropped mid-body, a truncated response, an
    // edge/proxy page during a deploy. Those are transport faults, which this module's own policy
    // says fix themselves on the next tick; latching on the first one would let a single dropped
    // body disable the Chat roster until the app restarts. But retrying forever is the other
    // failure — a route that keeps answering "no identity" is a route with nothing to poll for.
    // So: N consecutive strikes, then quiet. One bad body costs a minute, not a session.
    unusableProfiles += 1;
    if (unusableProfiles >= UNUSABLE_PROFILE_LIMIT) {
      goQuiet(`the profile response carried no social identity ${unusableProfiles}× running`);
    }
    return;
  }
  unusableProfiles = 0;
  transientProfile404s = 0;
  const me: MyProfileResponse = {
    socialId: raw.socialId,
    username: raw.username,
    displayName: raw.displayName ?? null,
    // FAIL CLOSED on a missing visibility. `unavailable` is `EMPTY_PROFILE`'s default and it is the
    // only safe guess: defaulting the other way would hand `availabilityFromWire` an `undefined`
    // that is `!== "unavailable"`, and the user's own dot would read AVAILABLE on a field the
    // server never sent — the exact fail-open direction this module refuses everywhere else.
    visibility: raw.visibility ?? "unavailable",
  };
  store.setMyProfile({
    socialId: me.socialId,
    username: me.username,
    displayName: me.displayName,
    visibility: me.visibility,
  });

  const connections = await attempt(getConnections());
  const directory = await attempt(loadDirectory());

  const candidates: Person[] = [];

  // THE SELF ROW. The one row that can be real for a solo user with no connections and an empty
  // directory, and therefore the only evidence a human has that any of this is wired up at all.
  candidates.push(selfPerson(me));

  if (connections) {
    const incoming = (connections.incoming ?? []).map(requestOf);
    const outgoing = (connections.outgoing ?? []).map(requestOf);
    store.setRequests({ incoming, outgoing });
    for (const row of connections.accepted ?? []) candidates.push(connectionPerson(row, "connected"));
    // Pending people get a row too. Not decoration: the directory lists every public user, so
    // someone who has asked to connect would otherwise appear in the column as an ordinary
    // STRANGER — a worse answer than the truth, and the merge above is what makes the pending
    // sighting win over the directory one.
    for (const row of connections.incoming ?? []) candidates.push(connectionPerson(row, "pending_in"));
    for (const row of connections.outgoing ?? []) candidates.push(connectionPerson(row, "pending_out"));
  }

  if (directory) for (const user of directory) candidates.push(directoryPerson(user));

  const people = mergeAll(candidates);

  if (connections && directory) {
    // A COMPLETE pass owns the roster: `setPeople` replaces it, so someone who was disconnected,
    // blocked, or went `unavailable` since the last pass disappears — which is the point.
    store.setPeople(people);
  } else {
    // A PARTIAL pass may only ADD. Replacing here would blank a populated column because a Wi-Fi
    // hiccup ate one of two requests, and "everyone you know vanished" is a far worse lie than a
    // row that is 60 seconds stale. `upsertPerson` merges and never removes.
    for (const person of people) store.upsertPerson(person);
  }
}

// ── The loop ────────────────────────────────────────────────────────────────────────────────────

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
/** Latched by a 404 or a 401 — "there is nothing here to poll for, this session". */
let quiet = false;
/**
 * True while a pass is running, and a tick that lands on it is DROPPED rather than queued.
 *
 * Not defensive tidying — arithmetic. One pass makes up to five sequential requests (profile,
 * connections, three directory pages), each bounded at `SOCIAL_REQUEST_TIMEOUT_MS` = 15s, so a
 * worst case of 75s against a 60s poll. Without this, a slow server makes passes overlap and pile
 * up tick after tick, and two complete passes race on the single `setPeople` REPLACE: the older,
 * slower one can land last and resurrect people who were disconnected or blocked in between.
 * Dropping the tick is right rather than queueing it — the next one is 60 seconds away and this is
 * a poll, not a command.
 */
let inFlight = false;
/**
 * Bumped whenever something changes the answer a pass could give — today, a username claim.
 *
 * A pass captures this when it starts. If it has moved by the time the pass fails with a 404, that
 * 404 was issued about a world that no longer exists, so it may not latch the loop quiet.
 */
let worldGeneration = 0;
/** A resume arrived while a pass was running: run one more as soon as that pass finishes. */
let passOwed = false;
/** Consecutive passes whose profile body carried no usable identity. Reset by any usable one. */
let unusableProfiles = 0;
/** Consecutive profile 404s that were treated as transient because a handle was already known.
 *  Bounded for the same reason {@link UNUSABLE_PROFILE_LIMIT} is — see the branch that raises it. */
let transientProfile404s = 0;

function stopTimer(): void {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

function goQuiet(reason: string): void {
  if (!quiet) {
    quiet = true;
    // ONE line, once, ever — not once a minute. See the header: with the flag off this is the
    // normal state of the whole feature, and a log that fires on the normal state is noise that
    // trains the reader to skip the abnormal one.
    console.info(`[social] sync stopped for this session: ${reason}`);
  }
  stopTimer();
}

/**
 * One pass, guaranteed not to throw. Exported so the loop's behaviour is testable without timers.
 *
 * Every exit is deliberate and they are not interchangeable — see the module header for why 404,
 * 401 and "transient" are three different answers rather than three flavours of failure.
 */
export async function syncSocialRoster(): Promise<void> {
  // A re-entrant call is DROPPED, and that is still the rule for the dominant caller — the poll
  // tick. Only `resumeSocialSync` defers, and it does so by setting `passOwed` ITSELF before
  // calling here, never from inside this early return. Queueing every re-entrant caller was a real
  // regression (roborev 60451): a pass can run ~75s against a 60s poll, so a tick landing mid-pass
  // would queue, the `finally` would launch it immediately, the next tick would land mid-THAT one,
  // and the 60s poll would become a back-to-back loop hammering an already-degraded server for as
  // long as it stayed slow.
  if (inFlight) return;
  inFlight = true;
  // The world this pass speaks for. `resumeSocialSync` bumps it, so a pass ISSUED BEFORE a username
  // claim can no longer report "no identity" about the world AFTER it.
  const generation = worldGeneration;
  try {
    await onePass();
  } catch (e) {
    if (e instanceof SocialApiError) {
      if (e.status === 404) {
        // Feature dark (§6.7) or no username claimed. Both mean nothing to show and nothing to
        // retry. The store keeps whatever it had, which for the dark case is nothing.
        //
        // UNLESS THE WORLD CHANGED UNDER US. This request was issued before the claim, so its 404
        // describes an account that no longer exists as it did; latching on it would silence the
        // loop for the session and strand the user on "Looking for people…" until restart — the
        // dead-end `resumeSocialSync` exists to close, reopened by ordering alone (roborev 60450).
        if (generation === worldGeneration) goQuiet("the social surface is not available");
        return;
      }
      if (e.status === 401) {
        // Signed out. Everything in this store is another account's view of other people.
        useSocialStore.getState().reset();
        goQuiet("signed out");
        return;
      }
      // 5xx / 429 / anything else the server said: transient by assumption, retried next tick.
      console.warn("[social] roster sync failed; retrying next tick", e.status, e.code);
      return;
    }
    if (e instanceof SocialNetworkError) {
      // Offline, captive portal, or the 15s abort. Silent — this is the single most common
      // failure on a laptop and it fixes itself.
      return;
    }
    // A bug in this module, not a server or transport answer. Loud, but still not thrown: the
    // caller is a `useEffect`.
    console.warn("[social] roster sync threw unexpectedly", e);
  } finally {
    // `finally`, not a line at the end of the try — every branch of that catch returns early, and
    // a latch that only clears on the happy path is a loop that stops after its first failure.
    inFlight = false;
    // Drain a resume that arrived mid-pass. Cleared BEFORE the re-entry so the recursion is one
    // deep at most: the nested call sets it again only if yet another resume lands.
    if (passOwed) {
      passOwed = false;
      void syncSocialRoster();
    }
  }
}

/**
 * Start the loop. Returns its teardown, and is idempotent under StrictMode and HMR double-mounts —
 * a second call is a no-op returning a no-op, so the first mount's teardown stays the one that
 * matters (the same contract `startAuthRecovery` keeps).
 *
 * The timer is armed BEFORE the first pass rather than after it, so there is no window in which a
 * pass that goes quiet is followed by a timer nobody clears.
 */
/**
 * Un-latch the loop and read again, NOW. Call this after something changes the answer the loop
 * gave up on — today that is exactly one thing: claiming a username.
 *
 * WHY IT HAS TO EXIST. `goQuiet` is permanent for the session by design: a 404 means "no identity,
 * or the feature is dark", and polling a route with nothing behind it once a minute forever is
 * waste. But a username claim CHANGES that answer, and nothing else could re-arm the loop —
 * `startSocialSync` is the only other writer of `quiet` and it is `started`-guarded behind an
 * `App.tsx` mount effect that runs once. So the ordinary first-run path dead-ended: launch with no
 * handle → the first pass 404s → quiet → claim a username in Settings → the roster never loads and
 * the Chat column sits on "Looking for people…" until the app is restarted. That is the whole
 * feature failing closed for precisely the user who just opted into it (roborev 60447).
 *
 * Deliberately does NOT touch `started`: the timer's ownership stays with the mount that created
 * it. If the loop was never started this re-arms nothing and simply runs one pass, which is the
 * honest behaviour for a caller that just wants the roster re-read.
 */
export function resumeSocialSync(): void {
  // BEFORE anything else. A pass already in flight captured the old value, so bumping here is what
  // strips its right to latch quiet on a 404 it asked for in the previous world.
  worldGeneration += 1;
  quiet = false;
  unusableProfiles = 0;
  transientProfile404s = 0;
  if (started && timer === null) {
    timer = setInterval(() => void syncSocialRoster(), SOCIAL_POLL_MS);
  }
  // Set HERE, not inside `syncSocialRoster`'s early return, so only a resume defers and an
  // ordinary poll tick is still dropped. If a pass is running the call below is a no-op and the
  // running pass's `finally` drains this; otherwise it runs now and `passOwed` stays false.
  // Dropping it outright was the whole defect: the resume looked like it worked, then the stale
  // pass landed and re-silenced everything.
  passOwed = inFlight;
  void syncSocialRoster();
}

export function startSocialSync(): () => void {
  if (started) return () => {};
  started = true;
  quiet = false;
  unusableProfiles = 0;
  transientProfile404s = 0;
  timer = setInterval(() => void syncSocialRoster(), SOCIAL_POLL_MS);
  void syncSocialRoster();
  return () => {
    started = false;
    stopTimer();
  };
}
