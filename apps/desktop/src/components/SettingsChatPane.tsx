import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  FiAlertCircle,
  FiCheckCircle,
  FiInfo,
  FiLoader,
  FiXCircle,
} from "react-icons/fi";

import { C } from "../theme/colors";
import { FONT_UI, LABEL, RADIUS, TYPE, WEIGHT } from "../theme/scale";
import {
  availabilityFromWire,
  validateUsernameFormat,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
  type UsernameRejection,
  type Visibility,
} from "../engine/social";
import {
  getUser,
  putUsername,
  putVisibility,
  SocialApiError,
  SocialNetworkError,
  type PublicProfile,
} from "../services/socialApi";
import { resumeSocialSync } from "../services/socialSync";
import { useSocialStore } from "../stores/socialStore";
import { useAuthStore } from "../stores/authStore";
import { authIdentity } from "../services/entitlement";
import { PersonAvatar } from "./PersonAvatar";

/**
 * The **Chat** settings pane — the ONE place a person joins the social registry. Design:
 * `docs/superpowers/specs/2026-08-05-social-coding-design.md` §5, §6.1, §6.3, §9 (U4), and §10
 * "Key UI design calls" (the two bullets on the new `"chat"` category and the username field).
 *
 * Until this pane existed, `sparkle_user_profiles` could never have a row: nothing in the app could
 * claim a username or set an availability, so the Chat section could never contain anybody —
 * including the founder. Everything else in the feature hangs off the two writes made here.
 *
 * ══ THE LOCAL FORMAT CHECK IS ADVISORY, AND THE SERVER IS THE GATE (a classic TOCTOU) ═══════════
 * {@link validateUsernameFormat} runs FIRST so an obviously malformed string never costs a network
 * round trip — that is its ONLY job. It is not, and can never be, the authority:
 *
 *   • The unique index on `username_key`, the reserved and protected-handle lists, the
 *     confusable-skeleton check and the immutability rule ALL live on the server and none of them
 *     is knowable here.
 *   • A name that is free when we check it can be claimed by someone else a millisecond later. The
 *     window between the check and the commit is real and cannot be closed from a client.
 *
 * So an `ok: true` here means **"worth asking the server"** and NOTHING MORE. It never means "this
 * name is mine", and — the rule that matters most — it may never suppress or reinterpret a server
 * `400`/`409`. That is why {@link claimRemedy} branches on the response alone and why the Save
 * button is gated only on the LOCAL check: the advisory answer decides whether we ask, and the
 * server's answer decides what the user is told. The availability probe below is advisory in the
 * same way and for a second reason — §6.6 makes `404` deliberately ambiguous (nonexistent, an
 * `unavailable` user, a service account, someone blocking you are all indistinguishable), so a
 * `404` means "looks free", never "is free". The copy says exactly that.
 *
 * ══ BOTH `status` AND `code`, NEVER ONE INFERRED FROM THE OTHER ════════════════════════════════
 * `PUT /account/username` answers `400` for three different reasons and `409` for two, and the
 * remedy differs per code within a status. {@link SocialApiError} carries both for that reason;
 * `claimRemedy` reads both. A `409` mapped on status alone would tell a user whose handle is
 * already set to "pick a different one" — advice that cannot work, since the name is IMMUTABLE
 * (§6.1: there is no rename, so a second `PUT` with a different key is `409 username_immutable`).
 *
 * ══ THE SERVER HALF MAY NOT BE LIVE YET ════════════════════════════════════════════════════════
 * S1 is being built in parallel, so an unrouted path answers `404`. That is an EXPECTED state, not
 * a fault: it renders as one calm line and nothing retries in the background. A scary error, or a
 * retry loop against a route that does not exist, would both be wrong.
 *
 * ══ ICON + TEXT, NEVER COLOUR ALONE ════════════════════════════════════════════════════════════
 * Each of the five username states carries a Feather icon AND words (§10; WCAG 1.4.1). Icons are
 * `react-icons/fi` — no emoji, house rule.
 */

/** How long the field settles before the advisory availability probe fires (§10: "debounce ~400ms").
 *  Exported so the test drives the real number rather than a copy of it. */
export const USERNAME_CHECK_DEBOUNCE_MS = 400;

/** The one calm sentence for "the server half isn't switched on yet". One string, because the
 *  username claim and the visibility write can each produce it and two wordings would read as two
 *  different problems. */
export const CHAT_NOT_LIVE_TEXT =
  "Chat isn’t switched on for this account yet. Nothing here is lost — set it again once it is. Sparkle isn’t retrying in the background.";

/** The advisory probe's five painted states.
 *
 *  `unknown` is NOT a sixth optimistic state: it is what "we could not ask" looks like, and it never
 *  claims a name is free. Folding it into `available` would be the exact TOCTOU lie the header
 *  refuses — the state a rate-limited or offline client is in is *ignorance*, not permission. */
export type UsernameCheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "available" }
  | { kind: "taken" }
  | { kind: "invalid"; reason: UsernameRejection }
  | { kind: "unknown"; note: string };

/** Why a locally-rejected name was rejected, in the user's words. One remedy per rule, per §10 —
 *  a single "invalid" would tell someone who typed 30+ characters to check their punctuation. */
export function rejectionText(reason: UsernameRejection): string {
  switch (reason) {
    case "empty":
      return "Type a username first.";
    case "non_ascii":
      return "Letters a–z, digits and underscores only — no accents or other alphabets.";
    case "too_short":
      return `At least ${USERNAME_MIN_LENGTH} characters.`;
    case "too_long":
      return `At most ${USERNAME_MAX_LENGTH} characters.`;
    case "invalid_format":
      return "Start and end with a letter or digit; single underscores in between.";
  }
}

/**
 * What to tell the user about a failed `PUT /account/username`, branching on **both** the HTTP
 * status and the server's machine-readable code.
 *
 * `calm: true` means "this is not the user's fault and there is nothing to fix" — it paints as an
 * informational line rather than an error. Exported so a caller (and the test) reads the real
 * mapping instead of re-deriving it.
 */
export function claimRemedy(err: unknown): { text: string; calm: boolean } {
  if (err instanceof SocialNetworkError) {
    return { text: "Sparkle couldn’t reach the server. Check your connection and try again.", calm: true };
  }
  if (!(err instanceof SocialApiError)) {
    return { text: "Something went wrong claiming that username. Try again.", calm: false };
  }
  // 404 FIRST, and on STATUS alone — the route may simply not exist yet (see the header). Reading
  // a code here would be reading a framework's HTML 404 body for a field it never had.
  if (err.status === 404) return { text: CHAT_NOT_LIVE_TEXT, calm: true };
  if (err.status === 400) {
    switch (err.code) {
      case "reserved":
        return { text: "That username is reserved. Pick a different one.", calm: false };
      case "impersonation":
        return {
          text: "That username is too close to a name Sparkle protects. Pick a different one.",
          calm: false,
        };
      case "invalid_format":
        return {
          text: "The server didn’t accept that format. Letters a–z, digits and single underscores.",
          calm: false,
        };
      default:
        return { text: "The server refused that username. Pick a different one.", calm: false };
    }
  }
  if (err.status === 409) {
    // The two 409s share a status and mean OPPOSITE things — one is about the name, the other about
    // the account — so a mapping on status alone would hand the second user unusable advice.
    if (err.code === "username_immutable") {
      return {
        text: "Your username is already set. A username can’t be changed once it’s claimed.",
        calm: false,
      };
    }
    return { text: "That username is already taken. Pick a different one.", calm: false };
  }
  if (err.status === 429) {
    return { text: "Too many attempts. Wait a minute, then try again.", calm: true };
  }
  return { text: `The server refused that username (${err.status}).`, calm: false };
}

/** The founder's own three words for the availability choice (§1), mapped onto {@link Visibility}. */
const VISIBILITY_CHOICES: readonly { value: Visibility; label: string; hint: string }[] = [
  {
    value: "public",
    label: "Available: Public",
    hint: "You appear in the directory and anyone can start a chat with you.",
  },
  {
    value: "connections",
    label: "Available: Connections only",
    hint: "You’re not in the directory. Someone who knows your exact username can ask to connect.",
  },
  {
    value: "unavailable",
    label: "Unavailable",
    hint: "You’re hidden from search and read as offline. People you already talk to can still reach you — going invisible doesn’t break a conversation.",
  },
];

export function SettingsChatPane() {
  const me = useSocialStore((s) => s.me);
  const setMyProfile = useSocialStore((s) => s.setMyProfile);
  const confirmVisibility = useSocialStore((s) => s.confirmVisibility);
  const authMe = useAuthStore((s) => s.me);

  const [draft, setDraft] = useState("");
  const [check, setCheck] = useState<UsernameCheckState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);
  const [claimNote, setClaimNote] = useState<{ text: string; calm: boolean } | null>(null);
  const [visSaving, setVisSaving] = useState<Visibility | null>(null);
  const [visNote, setVisNote] = useState<{ text: string; calm: boolean } | null>(null);
  /** Set by a 404 from EITHER write. Sticky for the session: nothing here polls, so re-checking
   *  would mean a retry loop against a route we have been told does not exist. */
  const [notLiveYet, setNotLiveYet] = useState(false);

  /**
   * A username is IMMUTABLE once claimed (§6.1), so once we know we hold one there is nothing to
   * edit — offering a field the server will answer `409 username_immutable` to is a form whose only
   * outcome is a refusal.
   *
   * ⚠️ FALSE HERE MEANS "NOT KNOWN IN THIS SESSION", NOT "DEFINITELY UNCLAIMED", and until the
   * hydration lands it is routinely the first. `socialStore` is deliberately not persisted, and
   * **`socialApi` has no read of the SIGNED-IN user's OWN profile** — no `/me`. It has plenty of
   * other reads, `getUser` among them and imported by this very file, but `getUser` is a lookup of
   * ANOTHER handle by name and so cannot stand in for one: the thing that is unknown is the user's
   * own handle, which is the argument it would need. So `me` starts at `EMPTY_PROFILE` on every
   * launch — including for someone who claimed a handle last week — and **nothing writes it except
   * this pane's own two saves.** (Visiting this pane hydrates nothing; if you take one thing from
   * this comment, take that, because "it corrects itself once you look at it" is the wrong mental
   * model and the expensive one.)
   *
   * That is why the claim form appearing is not a promise that the name is free: the probe can
   * report the user's OWN handle as taken, and Save answers `409 username_immutable`, which is
   * exactly the remedy {@link claimRemedy} spells out rather than a generic failure. That remedy is
   * now the ONLY place this is said — the standing caveat that used to sit above the field was cut
   * on 2026-08-08 (founder's call on his own copy), so the honest answer reaches the user at the
   * moment they hit it rather than as a preamble. Nothing about the mechanism changed: `save()`
   * still never overwrites a claimed handle, and a refusal still leaves the store untouched.
   * (roborev 60396, 60415; the fix is U1's `services/socialSync` hydrating `me` from `/me` on
   * connect, which this file must not grow a second copy of.)
   */
  const settled = me.username != null;

  // ── The advisory availability probe ───────────────────────────────────────────────────────────
  //
  // SEQUENCE-NUMBERED, and the guard is on the RESPONSE, not just the timer. Clearing the debounce
  // handles a keystroke that lands before a request goes out; it does nothing about two requests
  // already in flight whose replies arrive out of order — which is the ordinary case on a flaky
  // link, and which would paint the OLD name's verdict over the new name's. A reply whose sequence
  // is not the latest is dropped without touching state.
  const seq = useRef(0);

  useEffect(() => {
    // BUMPED FIRST, BEFORE EVERY EARLY RETURN, and that position is the whole correctness argument.
    // A bump that sat after the guards below only invalidated an in-flight probe when the NEW draft
    // was itself probe-worthy — so the two ways a user retreats from a valid name both left the old
    // reply live: clear the field and a late 200 writes "Already taken" onto an EMPTY box; type one
    // more character into `alice_` and the same 200 replaces that name's format remedy. Advancing
    // the sequence is what "the field has moved on" MEANS, and it has moved on in every one of these
    // cases, not only the ones that start another request. (roborev 60396.)
    const mine = ++seq.current;
    if (settled) return;
    const raw = draft;
    if (!raw.trim()) {
      setCheck({ kind: "idle" });
      return;
    }
    // LOCALLY FIRST: a malformed string never reaches the network (§10).
    const local = validateUsernameFormat(raw);
    if (!local.ok) {
      setCheck({ kind: "invalid", reason: local.reason });
      return;
    }
    setCheck({ kind: "checking" });
    const timer = setTimeout(() => {
      void getUser(local.key)
        .then(() => {
          if (seq.current === mine) setCheck({ kind: "taken" });
        })
        .catch((e: unknown) => {
          if (seq.current !== mine) return; // stale reply — the field has moved on
          if (e instanceof SocialApiError) {
            // 404 is the no-existence-oracle answer (§6.6) and covers several states, so this is
            // "looks free", not "is free". The server decides on commit.
            if (e.status === 404) return setCheck({ kind: "available" });
            if (e.status === 429) {
              return setCheck({
                kind: "unknown",
                note: "Too many name checks for now — Save still works.",
              });
            }
            return setCheck({ kind: "unknown", note: "Couldn’t check that name right now." });
          }
          setCheck({ kind: "unknown", note: "Couldn’t reach the server to check that name." });
        });
    }, USERNAME_CHECK_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, settled]);

  const save = useCallback(async () => {
    // The SAME advisory check, re-run at commit time, and still only to save a round trip. It does
    // not decide anything the server's answer could contradict.
    const local = validateUsernameFormat(draft);
    if (!local.ok) {
      setCheck({ kind: "invalid", reason: local.reason });
      setClaimNote(null);
      return;
    }
    setSaving(true);
    setClaimNote(null);
    try {
      // Widened on purpose: `socialApi.request` casts an absent or unparseable body to `T`, so a
      // 2xx with no JSON arrives here as null. Trust the server's echo when there is one.
      const profile: PublicProfile | null = await putUsername(draft.trim());
      setMyProfile({
        // `draft.trim()` and not the normalized key: `username` keeps the case the user typed,
        // `username_key` is the lowercase index (§6.1), and only the server holds the second one.
        username: profile?.username ?? draft.trim(),
        displayName: profile?.displayName ?? null,
        socialId: profile?.socialId ?? null,
      });
      setDraft("");
      setCheck({ kind: "idle" });
      // KICK THE ROSTER LOOP. Claiming a handle changes the answer the loop gave up on: a user who
      // launched without one had their first pass 404 and `socialSync` latched quiet for the
      // session (correctly — there was nothing to poll for). Without this the Chat column would sit
      // on "Looking for people…" until the app restarted, for exactly the person who just opted in.
      resumeSocialSync();
    } catch (e) {
      const remedy = claimRemedy(e);
      if (e instanceof SocialApiError && e.status === 404) setNotLiveYet(true);
      else setClaimNote(remedy);
    } finally {
      setSaving(false);
    }
  }, [draft, setMyProfile]);

  const chooseVisibility = useCallback(
    async (value: Visibility) => {
      setVisSaving(value);
      setVisNote(null);
      try {
        await putVisibility(value);
        // The value the server just ACCEPTED, not its echo: a 204 carries no body and reading one
        // would crash on the happy path. A 2xx is the confirmation — and `confirmVisibility` is one
        // action for both halves so the value can never be stored while still marked unconfirmed.
        confirmVisibility(value);
      } catch (e) {
        if (e instanceof SocialApiError && e.status === 404) setNotLiveYet(true);
        else if (e instanceof SocialNetworkError) {
          setVisNote({ text: "Sparkle couldn’t reach the server. Try again.", calm: true });
        } else if (e instanceof SocialApiError) {
          setVisNote({ text: `The server refused that change (${e.status}).`, calm: false });
        } else {
          setVisNote({ text: "Something went wrong saving that. Try again.", calm: false });
        }
      } finally {
        setVisSaving(null);
      }
    },
    [confirmVisibility],
  );

  // WHAT OTHERS WILL SEE. `online: true` is not a guess about a socket — this is the SELF view and
  // the app is open in front of the person reading it, so the only variable left is their own
  // intent, which is the thing this pane exists to change. `availabilityFromWire` is reused rather
  // than re-deriving the rule, so the self dot and a peer's dot cannot disagree about what
  // `unavailable` looks like.
  const selfAvailability = availabilityFromWire({ visibility: me.visibility, online: true });
  const selfName = me.displayName?.trim() || me.username || authIdentity(authMe) || "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      {notLiveYet && (
        <div data-testid="chat-not-live" style={calmLine}>
          <FiInfo size={14} aria-hidden style={noteIcon} />
          <span>{CHAT_NOT_LIVE_TEXT}</span>
        </div>
      )}

      {/* ── What everyone else sees ──────────────────────────────────────────────────────────── */}
      <div>
        <div style={subLabel}>How you appear</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <PersonAvatar
            name={selfName}
            availability={selfAvailability}
            size={28}
            ringColor={C.dialogSurface}
          />
          <div style={bodyLine}>
            {settled ? (
              <>
                <span style={{ color: C.cream }}>@{me.username}</span> — this is the dot other people
                see on your avatar.
              </>
            ) : (
              "Claim a username below and this is the dot other people will see on your avatar."
            )}
          </div>
        </div>
      </div>

      {/* ── Username ─────────────────────────────────────────────────────────────────────────── */}
      <div>
        <div style={subLabel}>Username</div>
        {settled ? (
          <div style={bodyLine} data-testid="chat-username-settled">
            Your username is <span style={{ color: C.cream }}>@{me.username}</span>. Usernames are
            permanent — Sparkle doesn’t offer renames, because a freed handle is exactly what an
            impersonator needs.
          </div>
        ) : (
          <>
            {/* NO EXPLANATORY PREAMBLE (founder's call, 2026-08-08). The rules it used to spell out
                are NOT relaxed — they are enforced in code and surfaced by {@link CheckLine} at the
                moment they bite, which is the only moment they are useful:
                  • 3–30 characters / a–z / single underscores → `validateUsernameFormat`, painted
                    per-rule by `rejectionText` under the field as you type and again on Save.
                  • Immutable once claimed → the `settled` branch above replaces this whole form,
                    and a server `409 username_immutable` has its own remedy in `claimRemedy`.
                  • Already claimed on another machine → `save()` never overwrites; the server's
                    `409` is what the user is told. The store is not touched on a refusal. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
              <input
                data-testid="chat-username-input"
                aria-label="Username"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="username"
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                style={field}
              />
              {/* EXPLICIT SAVE, never save-on-blur (§10): claiming a username is irreversible, and
                  an irreversible write must be something the user meant to press.

                  Enabled even when the field is empty or malformed ON PURPOSE. Gating it on the
                  advisory check would make that check the gate — the one thing the header says it
                  must never be — and it would make "an invalid name never hits the network"
                  untestable, since a disabled button proves nothing about the handler. The handler
                  re-runs the local check and refuses; that refusal is the guard. */}
              <button
                type="button"
                data-testid="chat-username-save"
                disabled={saving}
                onClick={() => void save()}
                style={saveButton}
              >
                {saving ? "Saving…" : "Save username"}
              </button>
            </div>
            <CheckLine state={check} />
            {claimNote && (
              <div
                data-testid="chat-claim-note"
                style={claimNote.calm ? calmLine : errorLine}
              >
                {claimNote.calm ? (
                  <FiInfo size={14} aria-hidden style={noteIcon} />
                ) : (
                  <FiAlertCircle size={14} aria-hidden style={noteIcon} />
                )}
                <span>{claimNote.text}</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Availability ─────────────────────────────────────────────────────────────────────── */}
      <div>
        <div style={subLabel}>Availability</div>
        {/* NO PREAMBLE AND NO STALENESS CAVEAT (founder's call, 2026-08-08). The opt-in POSTURE is
            unchanged and is enforced where it belongs: `EMPTY_PROFILE.visibility` is
            `"unavailable"`, so a store that has never been written reads Unavailable and nobody
            becomes discoverable by installing an update. `me.visibility` still moves only on a 2xx.

            The un-hydrated-store caveat this used to carry is gone with the rest of the prose, but
            the BEHAVIOUR it directed people to is deliberately kept: re-asserting the option that
            is already selected still writes (see the radio's `onClick` below), so a user who wants
            to be sure can click Unavailable and get a real save rather than a silent no-op. */}
        <div role="radiogroup" aria-label="Availability" style={choiceStack}>
          {VISIBILITY_CHOICES.map((choice) => {
            const selected = me.visibility === choice.value;
            return (
              <label key={choice.value} style={choiceRow(selected)}>
                <input
                  type="radio"
                  name="sparkle-chat-visibility"
                  data-testid={`chat-visibility-${choice.value}`}
                  value={choice.value}
                  checked={selected}
                  disabled={visSaving !== null}
                  onChange={() => void chooseVisibility(choice.value)}
                  // RE-ASSERTING THE ALREADY-SELECTED OPTION HAS TO WORK. A browser fires no
                  // `change` for a click on a radio that is already checked, and `Unavailable` is
                  // the checked one in every un-hydrated session — so without this, the person who
                  // most wants to be SURE they are hidden clicks "Unavailable", gets no request, no
                  // spinner and no confirmation, and walks away believing they re-confirmed a
                  // setting the server may still hold as `public`. This survived the copy cut on
                  // purpose: the sentence that used to point at it is gone, the silent-no-op bug it
                  // fixes is not. (roborev 60425.)
                  //
                  // No double-send. React's onChange for a radio is itself driven by the click and
                  // fires only when the checkedness actually changed, so the two are disjoint:
                  // clicking an unchecked option takes onChange (and `selected` is still false at
                  // render time, so this guard declines); clicking the checked one takes only this.
                  onClick={() => {
                    if (selected) void chooseVisibility(choice.value);
                  }}
                  style={{ marginTop: 2 }}
                />
                <span>
                  <span style={{ color: C.cream, display: "block" }}>
                    {choice.label}
                    {visSaving === choice.value ? " — saving…" : ""}
                  </span>
                  <span style={{ color: C.muted }}>{choice.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        {visNote && (
          <div data-testid="chat-visibility-note" style={visNote.calm ? calmLine : errorLine}>
            {visNote.calm ? (
              <FiInfo size={14} aria-hidden style={noteIcon} />
            ) : (
              <FiAlertCircle size={14} aria-hidden style={noteIcon} />
            )}
            <span>{visNote.text}</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The advisory probe's one painted line — ICON + TEXT for every state, never colour alone.
 *
 * The words matter as much as the icon: "Looks free" and "Available" are different claims, and only
 * the first one is true (see the module header). A line reading "Available ✓" would be the client
 * quietly promising something only the commit can deliver.
 */
function CheckLine({ state }: { state: UsernameCheckState }) {
  if (state.kind === "idle") return null;
  const { Icon, color, text } = (() => {
    switch (state.kind) {
      case "checking":
        return { Icon: FiLoader, color: C.muted, text: "Checking…" };
      case "available":
        return {
          Icon: FiCheckCircle,
          color: C.successInk,
          text: "Looks free — the server decides when you save.",
        };
      case "taken":
        return { Icon: FiXCircle, color: C.dangerInk, text: "Already taken. Pick a different one." };
      case "invalid":
        return { Icon: FiAlertCircle, color: C.amberInk, text: rejectionText(state.reason) };
      case "unknown":
        return { Icon: FiInfo, color: C.muted, text: state.note };
    }
  })();
  return (
    <div data-testid="chat-username-check" data-check={state.kind} style={{ ...noteBase, color }}>
      <Icon size={14} aria-hidden style={noteIcon} />
      <span>{text}</span>
    </div>
  );
}

// ── styles (inline CSSProperties, matching SettingsDialog's pane convention) ────────────────────

const subLabel: CSSProperties = { ...LABEL, color: C.muted, marginBottom: 8 };

const bodyLine: CSSProperties = {
  fontSize: TYPE.body,
  color: C.muted,
  lineHeight: 1.5,
};

const field: CSSProperties = {
  flex: 1,
  minWidth: 0,
  boxSizing: "border-box",
  background: C.inputSurface,
  color: C.cream,
  border: `1px solid ${C.inputEdge}`,
  borderRadius: RADIUS.input,
  padding: "7px 10px",
  fontSize: TYPE.body,
  fontFamily: FONT_UI,
  outline: "none",
};

const saveButton: CSSProperties = {
  flex: "none",
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.hairline}`,
  borderRadius: RADIUS.input,
  padding: "8px 14px",
  cursor: "pointer",
  fontSize: TYPE.body,
  fontFamily: FONT_UI,
  whiteSpace: "nowrap",
};

const noteBase: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 6,
  fontSize: TYPE.small,
  lineHeight: 1.5,
  marginTop: 2,
};

const noteIcon: CSSProperties = { flex: "none", marginTop: 2 };

const calmLine: CSSProperties = { ...noteBase, color: C.muted };
const errorLine: CSSProperties = { ...noteBase, color: C.dangerInk };

const choiceStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const choiceRow = (selected: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "flex-start",
  gap: 9,
  fontSize: TYPE.small,
  fontFamily: FONT_UI,
  lineHeight: 1.5,
  cursor: "pointer",
  fontWeight: selected ? WEIGHT.med : undefined,
});
