// socialStore — WHO you can chat with, keyed by `social_id`. Design:
// docs/superpowers/specs/2026-08-05-social-coding-design.md §5, §6.1, §6.3, §10.
//
// ⚠️ THE NAME. This is `socialStore`, and it may never be renamed to `presenceStore` — that name is
// ALREADY TAKEN, by "is the human at the keyboard", and it is read synchronously from the non-React
// concierge dispatch path where a destructive action queues on it. Two stores called presence, one
// about a peer's socket and one about whether the user can cancel a countdown, is a collision that
// would be both easy to make and damaging. For the same reason the field here is `availability` and
// never `presence`, and the dot is `AvailabilityDot`, never `PresenceDot`.
//
// NOT PERSISTED, deliberately, and each of the three things in it fails differently if it were:
//   • `availability` is socket liveness. A rehydrated dot would assert a peer is online on the
//     strength of a fact from the last time the app ran — the one claim this feature must never
//     make wrongly, since a human decides whether to type based on it.
//   • the roster and the requests are server state with a server-side authz gate on top (a block, a
//     visibility change, a declined request all happen while you are closed). A cached copy would
//     render people you may no longer see, which is a §5 disclosure, not a stale-UI annoyance.
//   • `me` is re-read from `/me` + the profile endpoint on every boot anyway.
// The whole store is repopulated from `services/socialApi` on connect, so persistence would buy a
// flash of possibly-wrong state and nothing else.
//
// WHAT IS DELIBERATELY ABSENT: `clerkUserId`, email, real name, last-seen timestamps, device or
// machine identity. Per §5 none of those may reach a client at all, so there is no field here to
// put them in — a projection you cannot express is a projection that cannot leak.

import { create } from "zustand";

import { personAgentId, type Availability, type Visibility } from "../engine/social";
import type { MentionAgent } from "../components/Concierge/mentions";

/** How the viewer stands to a person. `stranger` is a real, addressable state (§6.1 `state='none'`),
 *  not "unknown" — you can message a stranger; it lands in their request tray. */
export type Relationship = "self" | "connected" | "pending_in" | "pending_out" | "stranger";

/** A person the app knows about — EXACTLY the four fields §5 permits a client to hold, plus the
 *  viewer-derived edge facts (`relationship`, `availability`) which are about the EDGE, not about
 *  the profile row, and so compose without widening the projection. */
export interface Person {
  /** The opaque public uuid. THE key for everything: the row, the mount id, the thread cache. */
  socialId: string;
  username: string;
  /** Optional and user-set; never auto-filled from the account name or email (§5). */
  displayName: string | null;
  availability: Availability;
  relationship: Relationship;
}

/** The signed-in user's own social identity. `username: null` means "has no social identity yet" —
 *  row existence server-side is what means "claimed", so null here is the honest mirror of that. */
export interface MyProfile {
  username: string | null;
  displayName: string | null;
  /** Defaults to `unavailable`: social is opt-in and nobody becomes discoverable by upgrading. */
  visibility: Visibility;
  socialId: string | null;
}

/** One pending connection request, in either direction. `id` is the connection row's uuid — what
 *  `POST /social/connections/:id/accept` takes — and is NOT the peer's `socialId`. */
export interface ConnectionRequest {
  id: string;
  socialId: string;
  username: string;
  displayName: string | null;
}

/**
 * A person row AS IT MAY ACTUALLY ARRIVE, which is not the same thing as {@link Person}.
 *
 * `socialApi`'s JSON read is an unchecked `as T` — there is no runtime validator at that boundary —
 * and the wire shape (§5) carries `online`, not `availability`, so a caller adapting a response can
 * hand this store a row with no availability at all and TypeScript will never have known. Saying so
 * in the type is what lets {@link SocialState.setPeople} normalize rather than *claim* to.
 */
export type IncomingPerson = Omit<Person, "availability"> & { availability?: Availability };

/** A partial update to one person. Only `socialId` is required — that is what makes `upsertPerson`
 *  a merge rather than a replace wearing a merge's docstring. */
export type PersonPatch = Partial<Person> & Pick<Person, "socialId">;

/** The fail-closed default. A peer with no availability evidence is OFFLINE — never "available on
 *  the strength of a missing field". */
export const DEFAULT_AVAILABILITY: Availability = "offline";

const NO_PEOPLE: Readonly<Record<string, Person>> = Object.freeze({});
/** Module-level frozen empties so a selector returns a STABLE reference in the common case; a fresh
 *  `[]` per render re-renders every consumer on every store touch. */
const NO_REQUESTS: readonly ConnectionRequest[] = Object.freeze([]);

export const EMPTY_PROFILE: MyProfile = Object.freeze({
  username: null,
  displayName: null,
  visibility: "unavailable" as Visibility,
  socialId: null,
});

interface SocialState {
  me: MyProfile;
  /** Everyone with a row, keyed by `socialId`. A record, not an array: every write path
   *  (`peer_presence`, an accepted request, an unread bump) arrives keyed by that id. */
  people: Record<string, Person>;
  incoming: readonly ConnectionRequest[];
  outgoing: readonly ConnectionRequest[];
  /** Unread message count per `socialId`. Absent = zero. */
  unread: Record<string, number>;
  /**
   * Has a roster read ever SUCCEEDED this session?
   *
   * It exists because `people` being empty answers two completely different questions with the same
   * value: "the directory really is empty" and "we have never managed to read it". Those diverge
   * constantly — the first pass has not returned, the account has no handle yet so every
   * `/social/*` path 404s, a 5xx or an offline pass left the previous (empty) roster in place — and
   * a surface that narrates the first when the second is true is asserting a fact it does not hold.
   * `setPeople` is the only writer, so this cannot drift from the data it describes.
   */
  rosterLoaded: boolean;
  /**
   * Has YOUR OWN profile been read back this session?
   *
   * The sibling of {@link rosterLoaded}, and it exists for the same reason: `me.username` is `null`
   * both for "you have no social identity" and for "we have not read your profile yet" (and for
   * "the read failed"). Those are opposite instructions to give a user — the first should be told
   * to pick a username, the second must be told nothing at all — so a surface that reads only
   * `username == null` will tell an already-registered user to go and register. `setMyProfile` is
   * the only writer and it runs only on a successful read.
   */
  profileLoaded: boolean;

  /**
   * True once the SERVER has accepted a visibility in this session — i.e. once `me.visibility`
   * stopped being the fail-closed default and became a fact.
   *
   * ⚠️ PARKED — THIS FLAG CURRENTLY HAS NO PRODUCTION READER. It is written (by
   * {@link SocialState.confirmVisibility}), cleared (by {@link SocialState.reset}) and asserted in
   * `SettingsChatPane.test.tsx`, but nothing rendering reads it. Its one consumer was the Chat
   * pane's "this Mac may not know your setting" caveat, and the founder cut that copy on
   * 2026-08-08 along with three other explanatory blocks (PR #1599). Do not read this as live
   * state and do not extend it on the assumption that something depends on it.
   *
   * IT IS KEPT, NOT DELETED, for one named consumer: U1's `/me` hydration
   * (`services/socialSync`). Hydration is precisely the thing that makes "did the SERVER say this,
   * or is it just our default?" answerable, and it is the question this flag exists to answer —
   * so deleting it now means re-deriving it there. **If U1 lands and still does not read this,
   * delete it** along with the second half of `confirmVisibility` (which then collapses to a plain
   * `setVisibility`) and the tests that assert it.
   *
   * Why it lives in the store rather than in the pane that sets it — still true, and the reason it
   * should stay here if it comes back into use:
   *
   *   • LIFETIME. `SettingsDialog` mounts only the ACTIVE pane and is itself conditionally
   *     rendered, so the Chat pane remounts on every rail click. A `useState` flag resets there
   *     while `me.visibility` — which outlives the pane — does not (roborev 60432).
   *   • IDENTITY. This is a fact about a PERSON, and per-human state surviving a sign-out is a
   *     recurring leak in this app. Here it cannot: {@link SocialState.reset} restores `INITIAL`,
   *     which clears this with everything else. A module-level flag in a component file would have
   *     the right lifetime for the first reason and the wrong one for this.
   *
   * FALSE means "not confirmed in this session", NEVER "unavailable" — nothing hydrates `me` from
   * the server yet (`socialApi` has no `/me` read), so a returning user starts false with a
   * server-side visibility that may be anything.
   */
  visibilityConfirmed: boolean;

  setMyProfile: (patch: Partial<MyProfile>) => void;
  /** Record a visibility the server ACCEPTED: writes the value and raises
   *  {@link SocialState.visibilityConfirmed}. One action rather than two calls, so a caller cannot
   *  store the value while leaving it marked unconfirmed (or the reverse). Never call this for a
   *  visibility the user merely picked — a 2xx is what it means. */
  confirmVisibility: (visibility: Visibility) => void;
  /** Replace the whole roster (a directory/connections refetch). Availability defaults to `offline`
   *  for anyone the payload does not carry one for — the fail-CLOSED direction: never assert a peer
   *  is reachable on missing evidence. See {@link IncomingPerson} for why that can happen at all. */
  setPeople: (people: readonly IncomingPerson[]) => void;
  /** Add or merge one person. A genuine MERGE: every field but `socialId` is optional, so a
   *  `peer_presence` frame that arrives before the profile fetch carries only the availability and
   *  cannot blank the name, and a profile fetch that lands after it cannot blank the dot. */
  upsertPerson: (patch: PersonPatch) => void;
  removePerson: (socialId: string) => void;
  /** The `peer_presence` write path. A no-op for an unknown id rather than creating a nameless
   *  ghost row — a person you have no profile for must not appear in the column. */
  setAvailability: (socialId: string, availability: Availability) => void;
  setRequests: (requests: {
    incoming?: readonly ConnectionRequest[];
    outgoing?: readonly ConnectionRequest[];
  }) => void;
  bumpUnread: (socialId: string, by?: number) => void;
  clearUnread: (socialId: string) => void;
  /** Sign-out / account switch. Everything here is another account's view of other people. */
  reset: () => void;
}

const INITIAL = {
  me: EMPTY_PROFILE,
  visibilityConfirmed: false,
  people: NO_PEOPLE as Record<string, Person>,
  incoming: NO_REQUESTS,
  outgoing: NO_REQUESTS,
  unread: {} as Record<string, number>,
  rosterLoaded: false,
  profileLoaded: false,
};

export const useSocialStore = create<SocialState>((set) => ({
  ...INITIAL,

  // Reaching here IS the evidence the profile was read — `socialSync` calls this only on a
  // successful `getMyProfile`, so `profileLoaded` cannot claim a read that did not happen. See the
  // field's docstring for why `me.username == null` alone is not enough to tell a user anything.
  setMyProfile: (patch) => set((s) => ({ me: { ...s.me, ...patch }, profileLoaded: true })),

  confirmVisibility: (visibility) =>
    set((s) => ({ me: { ...s.me, visibility }, visibilityConfirmed: true })),

  setPeople: (people) =>
    set(() => ({
      people: Object.fromEntries(
        people.map((p): [string, Person] => [
          p.socialId,
          { ...p, availability: p.availability ?? DEFAULT_AVAILABILITY },
        ]),
      ),
      // Reaching here IS the evidence: `socialSync` calls this once per COMPLETE pass and never on
      // a failed one, so marking it here rather than asking the caller to remember means the flag
      // cannot claim a load that did not happen. An empty `people` with this true is the honest
      // "we looked, there is nobody" — the state the roster alone cannot express.
      rosterLoaded: true,
    })),

  upsertPerson: (patch) =>
    set((s) => {
      const existing = s.people[patch.socialId];
      // No row and no name is a presence frame for a stranger: a no-op, for the same reason
      // `setAvailability` refuses one. A nameless ghost must not appear in the column.
      if (!existing && patch.username == null) return {};
      // Strip explicit `undefined`s so "field omitted" and "field passed as undefined" mean the
      // same thing. Without this the spread below would blank a name the caller never touched —
      // which is precisely the failure the merge exists to prevent.
      const defined = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      ) as Partial<Person>;
      const base: Person = existing ?? {
        socialId: patch.socialId,
        username: patch.username as string,
        displayName: null,
        availability: DEFAULT_AVAILABILITY,
        relationship: "stranger",
      };
      return { people: { ...s.people, [patch.socialId]: { ...base, ...defined } } };
    }),

  removePerson: (socialId) =>
    set((s) => {
      if (!(socialId in s.people)) return {};
      const { [socialId]: _gone, ...rest } = s.people;
      const { [socialId]: _unread, ...unread } = s.unread;
      return { people: rest, unread };
    }),

  setAvailability: (socialId, availability) =>
    set((s) => {
      const person = s.people[socialId];
      if (!person || person.availability === availability) return {};
      return { people: { ...s.people, [socialId]: { ...person, availability } } };
    }),

  setRequests: ({ incoming, outgoing }) =>
    set((s) => ({
      incoming: incoming ?? s.incoming,
      outgoing: outgoing ?? s.outgoing,
    })),

  bumpUnread: (socialId, by = 1) =>
    set((s) => ({ unread: { ...s.unread, [socialId]: (s.unread[socialId] ?? 0) + by } })),

  clearUnread: (socialId) =>
    set((s) => {
      if (!(socialId in s.unread)) return {};
      const { [socialId]: _gone, ...rest } = s.unread;
      return { unread: rest };
    }),

  reset: () => set(() => ({ ...INITIAL })),
}));

// ── Selectors (pure over a snapshot, so they unit-test without a React tree) ─────────────────────

const AVAILABILITY_RANK: Record<Availability, number> = { available: 0, away: 1, offline: 2 };

/**
 * Sort rank. An unrecognized value ranks **AS `offline`** — not as a fourth tier below it.
 *
 * Said precisely because the obvious phrasing ("fail-closed to last") is *wrong* about what this
 * does: the fallback is `offline`'s own rank, so an unknown value TIES with offline and the
 * display-name tiebreak decides between them. That is deliberate and it is the consistent choice —
 * `setPeople` already defaults a missing availability to `offline`, and `AvailabilityDot`'s
 * `availabilityMeta` degrades an unknown one to the offline MARK, so a person who renders as offline
 * sorting among the offline people is what the user actually sees. A distinct fourth rank would put
 * them somewhere the dot does not explain.
 *
 * The `??` is not dead code even though the parameter is typed: the value can reach here from an
 * unchecked API cast (see {@link IncomingPerson}), and `undefined` would make the subtraction `NaN`.
 * A `NaN` comparator does not sort that row to the end — it makes the WHOLE sort
 * implementation-defined, so one bad row scrambles everyone. Hence the widened index.
 */
function availabilityRank(availability: Availability): number {
  return (
    (AVAILABILITY_RANK as Record<string, number | undefined>)[availability] ??
    AVAILABILITY_RANK.offline
  );
}

/** Everyone with a row, ordered the way the column paints them: available first (the people you can
 *  actually reach right now), then by display name, case-insensitively. Ties broken on `username`
 *  so the order is total and cannot flap between renders. */
/**
 * The people the Chat column LISTS — everyone but you.
 *
 * `socialSync` puts your own row in `people` (relationship `"self"`) deliberately: it is a real
 * member of the roster, it feeds {@link roster} so `@`-mentioning yourself resolves, and it is the
 * one row that exists for a solo user. But it must not be LISTED, for two reasons that point the
 * same way. A row you click to open a chat with yourself is not a thing the founder asked for — the
 * self view is the dot on your own avatar in `AuthStatusButton`, which is where U4 put it. And
 * because the self row is pushed unconditionally, counting it makes `rows.length === 0` unreachable
 * in the shipping app, so the entire empty state — and the "No one **else** has joined yet" line
 * that already presumes this filter — became dead copy the moment the server went live. That was
 * roborev 60423: a flag, a comment and four tests asserting a state no production writer could
 * produce.
 */
export function otherPeopleList(people: Record<string, Person>): Person[] {
  return peopleList(people).filter((p) => p.relationship !== "self");
}

export function peopleList(people: Record<string, Person>): Person[] {
  return Object.values(people).sort(
    (a, b) =>
      availabilityRank(a.availability) - availabilityRank(b.availability) ||
      personName(a).localeCompare(personName(b), undefined, { sensitivity: "base" }) ||
      a.username.localeCompare(b.username),
  );
}

/** What a person is CALLED on screen and in a mention. The display name when they set one, else the
 *  username — one function so the row, the avatar letter and the @mention address can never
 *  disagree about who a message is addressed to. */
export function personName(person: Pick<Person, "username" | "displayName">): string {
  return person.displayName?.trim() || person.username;
}

/**
 * The @MENTION SEAM, and the reason it is here rather than in the stage that needs it: it costs
 * nothing now and retrofitting it costs a second, laxer notion of who is addressable.
 *
 * Returns exactly the {@link MentionAgent} shape `Concierge/mentions` already consumes — the same
 * shape `rosterFromMentions` synthesises — so a person can be dropped into the picker's roster with
 * no adapter and no second matcher. `id` is the `person:` MOUNT id, not the raw `socialId`, because
 * that is the id every downstream consumer of a mention routes on.
 *
 * The filler fields mirror `rosterFromMentions` with ONE deliberate difference: `canAcceptInput` is
 * TRUE. That field means "can receive a prompt at all"; `rosterFromMentions` hardcodes false because
 * its inputs are finished messages, history that addresses nothing. A person can always receive —
 * an offline peer's message is durably written and delivered on reconnect (§6, persist-then-fan-out),
 * so availability is not a routing gate and must not be read as one.
 */
export function roster(people: Record<string, Person>): MentionAgent[] {
  return peopleList(people).map((p) => ({
    id: personAgentId(p.socialId),
    name: personName(p),
    projectId: "",
    projectName: "",
    band: "running" as const,
    canAcceptInput: true,
  }));
}

/** Total unread across everyone — the number the Chat section header badges. */
export function totalUnread(unread: Record<string, number>): number {
  return Object.values(unread).reduce((sum, n) => sum + n, 0);
}
