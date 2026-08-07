// Social Coding — the PURE half. No React, no IO, no store. Design:
// docs/superpowers/specs/2026-08-05-social-coding-design.md §5, §6.1, §6.3.
//
// Two things live here, and they are here rather than in a component or the store because both are
// answers a dozen surfaces will need and neither may be re-derived a second way:
//
//   (1) THE `person:` NAMESPACE. A human you chat with is mounted through the SAME `agentId`
//       plumbing a build agent is — `mountedThreadStore` keying, `draftKey`,
//       `routableMountedAgentId`. That only works if a person's id can never be mistaken for an
//       agent's, so the id carries a prefix and only the namespace decides what it is. This is the
//       exact device `services/sparkleAgent` uses for `__sparkle_self__`, whose own comment says the
//       double-underscore namespace "exists precisely so it cannot collide with a real agent UUID"
//       — and `services/knownAgents` is built on top of that promise. `person:<social_id>` makes the
//       same promise for the same reason: a UUID contains no colon, and `__sparkle_self__` does not
//       start with `person:`, so the three id spaces are disjoint by construction rather than by
//       convention. Both directions are provided (`personAgentId` / `socialIdFromPersonAgentId`) so
//       no caller ever slices the string itself.
//
//       `social_id` is the id in play here and NOT the clerk user id — per §5 the clerk id is the
//       partition key of every user-scoped table and may never leave the server. `social_id` is an
//       opaque uuid with no other role: safe to hand a client, stable across a username rename
//       (which is why the mount key is not the username — a rename would orphan every thread).
//
//   (2) THE USERNAME FORMAT CHECK, which is ADVISORY. See {@link validateUsernameFormat}.
//
// Deliberately NOT here: anything about whether the human is at the keyboard. That is
// `stores/presenceStore`, a different fact with a different lifetime, and this module's word for its
// own concept is **availability** precisely so the two can never be confused.

/** The one prefix. Every read and write of a person mount id goes through the helpers below rather
 *  than re-typing this literal, so there is exactly one place the namespace is defined. */
export const PERSON_ID_PREFIX = "person:";

/** The desktop mount id for a person (§6.1: "The desktop mount id is `person:<social_id>`"). */
export function personAgentId(socialId: string): string {
  return `${PERSON_ID_PREFIX}${socialId}`;
}

/**
 * True for any id in the `person:` namespace.
 *
 * FALSE for a bare agent UUID and FALSE for `__sparkle_self__` — those are the two other id spaces
 * the app addresses, and a surface that gates on "is this a person?" must not answer yes for
 * either. The bare prefix with nothing after it is also false: `person:` names nobody, and treating
 * it as a person would hand `socialIdFromPersonAgentId` an empty key to hang a thread off.
 */
export function isPersonAgentId(id: string): boolean {
  return id.startsWith(PERSON_ID_PREFIX) && id.length > PERSON_ID_PREFIX.length;
}

/** The `social_id` inside a person mount id, or null when `id` is not one. Null rather than a
 *  throw or an empty string: callers hold ids of all three kinds and the common shape is a guard. */
export function socialIdFromPersonAgentId(id: string): string | null {
  return isPersonAgentId(id) ? id.slice(PERSON_ID_PREFIX.length) : null;
}

/**
 * How a person reads on screen. **Never called "presence"** — `stores/presenceStore` already owns
 * that word for "is the human at the keyboard", read from the non-React dispatch path, and the
 * collision would be both easy to make and damaging.
 *
 * `away` is a LOCAL-ONLY state and is never derived from a peer's wire payload: per §5 the server
 * emits a coarse online boolean and nothing finer, because a finer signal is a behavioural
 * surveillance feed. It exists in the union for the self view, where the app already knows the
 * difference between "connected" and "connected but idle/blurred" from `presenceStore` without
 * asking the network. See {@link availabilityFromWire} for what a PEER may ever be.
 */
export type Availability = "available" | "away" | "offline";

/** The user's own discoverability INTENT (§6.3), durable server-side and independent of whether a
 *  socket happens to be open. `unavailable` is the default: social is opt-in, nobody becomes
 *  discoverable by upgrading. */
export type Visibility = "public" | "connections" | "unavailable";

/**
 * A peer's availability, from the two facts §6.3 deliberately refuses to merge server-side:
 * their durable `visibility` intent and their live socket `online`.
 *
 * Green = `visibility !== "unavailable" && online`. A person is routinely "Available: Public" AND
 * offline and the directory shows that state rather than hiding them. Note the asymmetry that makes
 * `unavailable` "invisible" rather than "unreachable": it reports offline, it does not sever the
 * conversation.
 *
 * Only ever returns `available` or `offline` — a peer is never `away`; see {@link Availability}.
 */
export function availabilityFromWire(input: { visibility: Visibility; online: boolean }): Availability {
  return input.visibility !== "unavailable" && input.online ? "available" : "offline";
}

// ── Username format (ADVISORY — see below) ──────────────────────────────────────────────────────

/** Inclusive bounds on `username_key.length` (§6.1). Checked SEPARATELY from the pattern — see
 *  {@link USERNAME_FORMAT_RE}. */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 30;

/**
 * The format pattern, applied to the normalized KEY (NFKC + lowercase), never to the raw input —
 * that is what lets `username` keep the case the user typed while one lowercase rule governs.
 *
 * `_?[a-z0-9]` as the repeated unit is what forbids CONSECUTIVE underscores; the flat
 * `[a-z0-9_]{1,28}` form does not (`a__b` matches it). The first character is separately anchored
 * as alphanumeric and the unit ends alphanumeric, so a leading or trailing `_` is impossible.
 *
 * **It carries NO length bound on purpose.** With an optional `_` inside the repeated unit a
 * quantifier counts UNITS, not characters, so any bound written into it is wrong by up to 2×
 * (`{2,29}` units admits a 58-character name). Length is {@link USERNAME_MIN_LENGTH} …
 * {@link USERNAME_MAX_LENGTH} measured on the key, in its own check.
 */
export const USERNAME_FORMAT_RE = /^[a-z0-9](?:_?[a-z0-9])+$/;

/** Why a username was refused. One token per rule so a caller can render the specific remedy
 *  instead of a generic "invalid" — §10 requires five states each carried by icon + text. */
export type UsernameRejection = "empty" | "non_ascii" | "too_short" | "too_long" | "invalid_format";

/** The normalized key a username is stored and uniquely indexed under (§6.1: NFKC + lowercase). */
export function usernameKey(raw: string): string {
  return raw.trim().normalize("NFKC").toLowerCase();
}

export type UsernameCheck =
  | { ok: true; key: string }
  | { ok: false; reason: UsernameRejection };

/**
 * Validate a username's FORMAT locally.
 *
 * ⚠️ **THIS IS ADVISORY AND IT IS NOT THE GATE.** The server re-checks on commit — the unique index
 * on `username_key`, the reserved and protected-handle lists, the confusable-skeleton check and the
 * rename cooldown all live there and none of them are knowable here. This function exists for
 * exactly one reason: so an obviously malformed string never costs a network round trip. It is a
 * classic TOCTOU — a name that passes here can be taken a millisecond later — and **a client that
 * disagrees with the server always loses.** Never treat an `ok: true` as "this name is mine", never
 * let it suppress or reinterpret a server `400`/`409`, and never re-implement any server-side rule
 * here in the hope of getting ahead of it.
 *
 * Order matters. The raw input is rejected for any non-ASCII byte BEFORE normalization, so
 * normalization can never *create* a legal name out of an illegal one (NFKC folds a great many
 * Unicode characters onto ASCII). Rejecting non-ASCII outright kills the whole
 * Unicode/Cyrillic homoglyph class in one line rather than shipping a fold we patch forever.
 */
export function validateUsernameFormat(raw: string): UsernameCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  // Raw, pre-normalization. ` `-`~` is printable ASCII; anything outside it (including
  // control bytes and every astral code point) is refused before NFKC gets a chance to fold it.
  if (!/^[\x20-\x7e]+$/.test(trimmed)) return { ok: false, reason: "non_ascii" };
  const key = usernameKey(trimmed);
  if (key.length < USERNAME_MIN_LENGTH) return { ok: false, reason: "too_short" };
  if (key.length > USERNAME_MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (!USERNAME_FORMAT_RE.test(key)) return { ok: false, reason: "invalid_format" };
  return { ok: true, key };
}
