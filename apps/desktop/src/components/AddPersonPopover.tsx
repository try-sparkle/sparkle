// AddPersonPopover — the panel behind the Chat header's `[+]`. Design:
// docs/superpowers/specs/2026-08-05-social-coding-design.md §5 (the privacy position),
// §10 "Key UI design calls". Bead `sparkle-xnjil.12`.
//
// It is modelled on `AgentInboxBadge`'s portal panel, deliberately and almost line for line:
// `createPortal` to `document.body`, `deepForest` + a hairline outline + a drop shadow,
// `SIDEBAR_OVERLAY_Z`, and a fixed 320px width that OVERHANGS the terminal because the Build column
// is narrow and a username wrapped to four characters a line is not a directory.
//
// ══ TWO ATTRIBUTES ON THE PORTAL ROOT, AND NEITHER IS DECORATION ═══════════════════════════════
//
//   `data-circuit` — the cable's "did this press leave the circuit" test is DOM ANCESTRY
//   (`closest`), and a portalled surface is a React child of the row but a DOM SIBLING of the whole
//   app. Every branch of `CIRCUIT_SELECTOR` that is found by ancestry therefore puts this panel
//   OUTSIDE the circuit, and clicking the wired row's own popover dropped the cable — roborev
//   54821, which is the incident `CIRCUIT_SELECTOR`'s `[data-circuit]` member exists for. Portal
//   roots opt in explicitly; this one opts in.
//
//   `data-dismissible-open="true"` — while this panel is up it OWNS Escape. Without a marker
//   `dismissibleSurfaceOpen` finds nothing and `unbindsOnKey` returns true, so the one press that
//   closes the popover ALSO unmounts the concierge: two state changes for one keystroke, the second
//   invisible until the layout reflows.
//
// ⚠️ DO NOT "IMPROVE" THE ROOT TO `role="dialog"`. `DISMISSIBLE_SELECTOR` is
// `[role="dialog"], [role="menu"], [data-dismissible-open="true"]` — so a dialog role would satisfy
// the Escape probe on its own and make the attribute above REDUNDANT. The attribute would then be
// unfalsifiable: its test could no longer fail if someone deleted it, and the guard would keep
// passing while the next portalled surface copied a panel whose marker turned out to be inert. The
// root is a `role="group"` precisely so `data-dismissible-open` is the thing carrying the weight,
// and `AddPersonPopover.test.tsx` asserts the probe, not the attribute.
//
// ══ ONE INPUT, NOT TWO ═════════════════════════════════════════════════════════════════════════
// The founder asked for both "see all the available and discoverable usernames" and "manually type
// in the name of a user". Those are ONE intent — *name the person you mean* — and two controls for
// one intent is worse than one: the user has to work out which box their case belongs in before
// they can start, and the two can disagree. So a single field filters the listed directory as you
// type AND is the exact-match type-in.
//
// ══ THE PRIVACY BOUNDARY, WHICH IS THE WHOLE POINT OF THIS FILE ════════════════════════════════
// A NON-PUBLIC user is NEVER LISTED — only ever CONFIRMED on an exact-string match. That asymmetry
// is §5's one accepted trade: typing a full username tells you whether that person exists so the
// "Send connection request" button can appear, which is an existence oracle by construction, and it
// is accepted and rate-limited server-side (20/min, 300/day). Substring browsing of non-public
// people is NOT accepted and there is no code path here that could do it: the list renders only
// what `getDirectory` returned, and `getUser` is only ever asked about a string the user typed in
// full. See {@link needsExactLookup}.
//
// Nothing rendered here may leak repo, project, agent name, goal, or anything else about a stranger
// — the sealed four-field projection and nothing beside it (§5). The row below paints
// `personName`-style identity, an availability word, and no fourth thing.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiPlus } from "react-icons/fi";

import { C, FONT_WEIGHT } from "../theme/colors";
import { FONT_MONO, RADIUS, TYPE } from "../theme/scale";
import { SIDEBAR_OVERLAY_Z } from "./layers";
import { PersonAvatar } from "./PersonAvatar";
import { availabilityLabel } from "./AvailabilityDot";
import { availabilityFromWire, usernameKey, validateUsernameFormat } from "../engine/social";
import type { Availability } from "../engine/social";
import {
  getDirectory,
  getUser,
  postConnection,
  type PublicProfile,
  type UserLookup,
} from "../services/socialApi";

export const ADD_PERSON_POPOVER_TESTID = "add-person-popover";
export const ADD_PERSON_INPUT_TESTID = "add-person-input";
export const ADD_PERSON_ROW_TESTID = "add-person-row";
export const ADD_PERSON_EXACT_TESTID = "add-person-exact";
export const ADD_PERSON_EMPTY_TESTID = "add-person-empty";

/** The two action labels, exported so a test asserts the SHIPPED string rather than a paraphrase.
 *  They differ because the two cases differ: a listed public person is someone you can just add,
 *  while a person you had to name in full is someone who has to say yes first. */
export const ADD_LISTED_LABEL = "Add";
export const SEND_REQUEST_LABEL = "Send connection request";

/** What the field says when it is empty. It names BOTH jobs, because the field does both. */
export const ADD_PERSON_PLACEHOLDER = "Find or type a username";

export const ADD_PERSON_NO_MATCH = "No one by that name.";

/** How wide the panel is allowed to get — the same 320 `AgentInboxBadge` uses, and for the same
 *  reason: the column is narrow, the panel is anchored to a control inside it, so it deliberately
 *  overhangs into the terminal rather than wrapping a username to nothing. */
export const ADD_PERSON_WIDTH = 320;

/** How long the exact-username lookup waits after the last keystroke. The same ~400ms the username
 *  field in Settings uses, and it exists for a stronger reason here: every keystroke that reached
 *  the network would spend the account's 20-per-minute exact-lookup budget on prefixes of a name
 *  nobody asked about. */
export const EXACT_LOOKUP_DEBOUNCE_MS = 400;

/** How many public users to pull for the filter list. The server caps a page at 50; one page is
 *  what a type-to-filter box needs, and paging deeper on open would spend a request per launch to
 *  fill a list nobody scrolls. */
export const DIRECTORY_LIMIT = 50;

/**
 * The panel's OUTLINE — a floating surface's edge, deliberately NOT a field's rule.
 *
 * Named rather than inlined for exactly the reason `AgentInboxBadge` names its own: the two read
 * identically as CSS and mean opposite things, and `modalChrome.test.ts` ratchets the population of
 * FIELDS that borrow the shell's tokens on a heuristic that cannot tell a text input from a
 * floating panel. Its own comment says a bordered panel on a plane is correct and must not be
 * counted. The field inside this panel uses `inputSurface`/`inputEdge`, which is the real pair.
 */
const PANEL_EDGE = `1px solid ${C.hairline}`;

/**
 * Everyone in the LISTED directory whose name matches what has been typed.
 *
 * Substring, case- and normalization-insensitive, over the username AND the display name — someone
 * typing a person's real name should find the handle they do not remember. An empty query lists
 * everyone, which is what opening the panel with nothing typed should show.
 *
 * `users` is ALWAYS a `getDirectory` page, i.e. public users only. That is what makes the §5
 * boundary structural rather than a rule someone has to remember: there is no non-public row in
 * here to filter out, because none ever arrives.
 */
export function filterDirectory(
  users: readonly PublicProfile[],
  query: string,
): PublicProfile[] {
  const q = usernameKey(query);
  if (!q) return [...users];
  return users.filter(
    (u) =>
      usernameKey(u.username).includes(q) ||
      (u.displayName != null && usernameKey(u.displayName).includes(q)),
  );
}

/**
 * Should this string be sent to the exact-username endpoint?
 *
 * THREE conditions, and each one is a bound on the existence oracle §5 accepted:
 *
 *   1. It must pass the local format check. A malformed string cannot name anyone, so asking is a
 *      round trip that can only answer 404 — and it would still spend a slot in the rate budget.
 *   2. It must not already be LISTED. If the directory answered with that person we know what we
 *      need; asking again learns nothing and costs a lookup.
 *   3. …and that is all. In particular this is NOT called per keystroke — the caller debounces —
 *      so browsing prefixes of a name never reaches the endpoint.
 *
 * The comparison is on {@link usernameKey}, never on the raw strings: `Ada` and `ada` are the same
 * person, and treating them as different would ask the server about someone already on screen.
 */
export function needsExactLookup(query: string, listed: readonly PublicProfile[]): boolean {
  const key = usernameKey(query);
  if (!key) return false;
  if (!validateUsernameFormat(query).ok) return false;
  return !listed.some((u) => usernameKey(u.username) === key);
}

/**
 * Does the panel collapse to the single "Send connection request" row?
 *
 * True exactly when a lookup RESOLVED for the string currently typed and that person is not in the
 * listed directory — i.e. they exist and are not public. That is the one row the founder asked for,
 * and it REPLACES the list rather than joining it: the user typed a full name, so they have already
 * said which person they mean, and showing eleven other people underneath the answer is noise.
 *
 * The `lookup.username` re-check is what makes a stale reply harmless. Replies do not arrive in
 * request order, so a slow answer for `ada` can land after the user has typed `adam`; keying the
 * collapse on the CURRENT text means such a reply renders nothing rather than confirming the
 * existence of a person the user is no longer asking about.
 */
export function collapsesToExact(
  query: string,
  listed: readonly PublicProfile[],
  lookup: UserLookup | null,
): boolean {
  if (lookup == null) return false;
  const key = usernameKey(query);
  if (!key || usernameKey(lookup.username) !== key) return false;
  return !listed.some((u) => usernameKey(u.username) === key);
}

/** What a person is CALLED here — display name when they set one, else the username. The same rule
 *  `personName` applies in the store, restated over the WIRE shape (which has no `availability`)
 *  rather than adapting one to the other for a label. */
function nameOf(p: { username: string; displayName: string | null }): string {
  return p.displayName?.trim() || p.username;
}

/** How a wire row reads as a dot. A directory row is a public user by construction, so the
 *  visibility that {@link availabilityFromWire} needs is `public` — the one place this file knows
 *  something the four fields do not carry, and it knows it from WHICH ENDPOINT answered. */
function availabilityOf(online: boolean): Availability {
  return availabilityFromWire({ visibility: "public", online });
}

/** Per-username send state. `sent` is terminal on purpose: `POST /social/connections` answers 202
 *  ALWAYS — including for a person who does not exist or who has blocked you — so the response
 *  tells you nothing about them and there is nothing further to report. */
type SendState = "idle" | "sending" | "sent" | "failed";

export function AddPersonPopover({
  anchor,
  onClose,
}: {
  /** The `[+]`'s rect, captured at click time. Null falls back to the viewport corner. */
  anchor: DOMRect | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [listed, setListed] = useState<readonly PublicProfile[]>([]);
  const [lookup, setLookup] = useState<UserLookup | null>(null);
  const [send, setSend] = useState<Record<string, SendState>>({});
  const panelRef = useRef<HTMLDivElement>(null);

  // ── The directory, read ONCE per open ─────────────────────────────────────────────────────────
  // Not per keystroke: filtering is local, so a second page fetch would buy nothing and spend a
  // request. A failure leaves the list EMPTY rather than stale — this panel is a disclosure
  // surface, and rendering people from a previous account or a previous visibility setting is a
  // §5 problem, not a stale-UI annoyance.
  useEffect(() => {
    let alive = true;
    getDirectory({ limit: DIRECTORY_LIMIT })
      .then((page) => {
        if (alive) setListed(page.users ?? []);
      })
      .catch(() => {
        if (alive) setListed([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // ── The exact lookup, debounced and sequence-guarded ──────────────────────────────────────────
  // The sequence number is what drops a stale reply. Without it a slow answer for an earlier
  // prefix can land after a later one and confirm the existence of somebody the user is no longer
  // asking about — which on THIS surface is not a cosmetic race but a false statement about a
  // person. `collapsesToExact` re-checks the text as a second, independent guard.
  const seq = useRef(0);
  useEffect(() => {
    const mine = ++seq.current;
    if (!needsExactLookup(query, listed)) {
      setLookup(null);
      return;
    }
    const timer = window.setTimeout(() => {
      getUser(query.trim())
        .then((row) => {
          if (seq.current === mine) setLookup(row);
        })
        .catch(() => {
          // 404 is the DELIBERATE no-oracle answer for a nonexistent user, an `unavailable` one, a
          // service account and anyone blocking you — all indistinguishable on purpose. Every one
          // of them renders as "no one by that name", which is the only honest thing to say.
          if (seq.current === mine) setLookup(null);
        });
    }, EXACT_LOOKUP_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, listed]);

  // ── Escape and click-away ─────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // CABLE ETIQUETTE, both halves: honour a prior consumer, then consume. One press peels THIS
      // layer and leaves whatever is behind it alone.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (t !== null && panelRef.current?.contains(t) === true) return;
      // The `[+]` itself TOGGLES. Letting this handler also see that press would close and reopen
      // in one gesture, so the button would never appear to respond.
      if (t !== null && (t as Element).closest?.(`[data-add-person-anchor]`) != null) return;
      onClose();
    };
    // …and on any SCROLL, because the panel is `position: fixed` at the anchor's rect AT CLICK
    // TIME. Capture phase: the scroll that matters is the column's own, and scroll does not bubble.
    const onMove = () => onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [onClose]);

  const rows = useMemo(() => filterDirectory(listed, query), [listed, query]);
  const exact = collapsesToExact(query, listed, lookup) ? lookup : null;

  function request(username: string) {
    setSend((s) => ({ ...s, [username]: "sending" }));
    postConnection(username)
      .then(() => setSend((s) => ({ ...s, [username]: "sent" })))
      .catch(() => setSend((s) => ({ ...s, [username]: "failed" })));
  }

  // Anchored under the `[+]` and clamped into the viewport — a Build column can sit on either side
  // of the window (SPARKLE_PANE_SIDE), so a fixed direction is wrong half the time.
  const left = Math.max(
    8,
    Math.min(anchor?.left ?? 8, window.innerWidth - ADD_PERSON_WIDTH - 8),
  );

  return createPortal(
    <div
      ref={panelRef}
      data-testid={ADD_PERSON_POPOVER_TESTID}
      // PART OF THE LIVE CIRCUIT — see the header. Portalled to `document.body`, so the cable's
      // ancestry walk cannot reach it from the row it belongs to.
      data-circuit
      // THIS PANEL OWNS ESCAPE while it is up — see the header, including why the root is a
      // `group` and not a `dialog`.
      data-dismissible-open="true"
      role="group"
      aria-label="Add a person"
      // React bubbles portal events through the JSX tree, not the DOM one, so without this a press
      // in here re-emerges at whatever contains the portal — the Chat header, and above it the
      // sidebar's own click handling.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        left,
        top: (anchor?.bottom ?? 8) + 6,
        width: ADD_PERSON_WIDTH,
        maxHeight: "50vh",
        overflowY: "auto",
        zIndex: SIDEBAR_OVERLAY_Z,
        background: C.deepForest,
        border: PANEL_EDGE,
        borderRadius: RADIUS.sm,
        padding: 8,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        boxShadow: "0 6px 20px rgba(0,0,0,0.28)",
      }}
    >
      {/* THE ONE CONTROL. It filters and it is the type-in; see the header for why there is not a
          second box beside it. `autoFocus` because the panel was opened by a deliberate press and
          the next thing anyone does is type. */}
      <input
        data-testid={ADD_PERSON_INPUT_TESTID}
        aria-label={ADD_PERSON_PLACEHOLDER}
        placeholder={ADD_PERSON_PLACEHOLDER}
        value={query}
        autoFocus
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        onChange={(e) => setQuery(e.target.value)}
        style={{
          // The FIELD pair, not the shell's — a text input is the thing `inputSurface`/`inputEdge`
          // exist for, and borrowing `deepForest` + `hairline` here is the drift
          // `modalChrome.test.ts` ratchets.
          background: C.inputSurface,
          border: `1px solid ${C.inputEdge}`,
          borderRadius: RADIUS.input,
          color: C.cream,
          fontSize: TYPE.body,
          padding: "6px 8px",
          outline: "none",
          width: "100%",
          boxSizing: "border-box",
        }}
      />

      {exact !== null ? (
        // ONE ROW. See `collapsesToExact`: the user named a person in full, so this is the answer
        // and the list is not.
        <PersonLine
          testId={ADD_PERSON_EXACT_TESTID}
          username={exact.username}
          displayName={exact.displayName}
          // WHATEVER THE SERVER SENT, unexamined — and for a non-public person that is `false` by
          // construction, because §5 gives a viewer not entitled to liveness `online: false` rather
          // than an omitted key (an absent field is itself a signal). So this row reads "Offline",
          // which is exactly what the projection is designed to say and NOT a claim this file is
          // making on its own. Do not special-case it into a blank or a third state: that would
          // re-create the distinction §5 removed, and tell a reader which people are non-public.
          online={exact.online}
          action={SEND_REQUEST_LABEL}
          state={send[exact.username] ?? "idle"}
          onAction={() => request(exact.username)}
        />
      ) : rows.length === 0 ? (
        <div
          data-testid={ADD_PERSON_EMPTY_TESTID}
          style={{ fontFamily: FONT_MONO, fontSize: TYPE.micro, color: C.muted, padding: "4px 2px" }}
        >
          {ADD_PERSON_NO_MATCH}
        </div>
      ) : (
        rows.map((u) => (
          <PersonLine
            key={u.socialId}
            testId={ADD_PERSON_ROW_TESTID}
            username={u.username}
            displayName={u.displayName}
            online={u.online}
            action={ADD_LISTED_LABEL}
            state={send[u.username] ?? "idle"}
            onAction={() => request(u.username)}
          />
        ))
      )}
    </div>,
    document.body,
  );
}

/**
 * ONE person, and EXACTLY the sealed projection (§5).
 *
 * What it paints: the avatar (a letter derived from the name), the name, the `@handle`, an
 * availability word, and one button. What it does NOT paint, and has no prop to receive: repo,
 * project, agent name or count, goal, branch, worktree, device, email, account age, or a last-seen
 * timestamp. A row that cannot express those is a row that cannot leak them — the same argument
 * `socialApi`'s header makes about `clerkUserId`, applied to the render.
 */
function PersonLine({
  testId,
  username,
  displayName,
  online,
  action,
  state,
  onAction,
}: {
  testId: string;
  username: string;
  displayName: string | null;
  online: boolean;
  action: string;
  state: SendState;
  onAction: () => void;
}) {
  const availability = availabilityOf(online);
  const name = nameOf({ username, displayName });
  // ICON ONLY WHILE IDLE, WORDS THE MOMENT ANYTHING HAPPENS. A `[+]` that merely greys out says
  // nothing about whether the request went — and "did it actually go" is the one question a person
  // who just pressed it has. The exact-match row is words throughout: it carries a whole sentence.
  const iconOnly = action === ADD_LISTED_LABEL && state === "idle";
  return (
    <div
      data-testid={testId}
      data-username={username}
      style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
    >
      <PersonAvatar name={name} availability={availability} size={18} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        <span
          style={{
            fontSize: TYPE.body,
            color: C.cream,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </span>
        <span style={{ fontFamily: FONT_MONO, fontSize: TYPE.micro, color: C.muted }}>
          {/* The availability IN WORDS, never colour alone (WCAG 1.4.1) — the dot on the avatar is
              `aria-hidden` beneath the avatar's own name, so this line is where a sighted reader
              gets it too. */}
          @{username} · {availabilityLabel(availability)}
        </span>
      </div>
      <button
        type="button"
        data-testid={`${testId}-action`}
        disabled={state === "sending" || state === "sent"}
        // The accessible name NAMES THE PERSON. A column of eleven buttons all called "Add" is a
        // list of identical controls to anyone navigating by button.
        aria-label={`${action} — ${username}`}
        title={`${action} — ${username}`}
        onClick={onAction}
        style={{
          flex: "0 0 auto",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          padding: iconOnly ? 0 : "3px 7px",
          width: iconOnly ? 20 : undefined,
          height: 20,
          border: `1px solid ${C.inputEdge}`,
          borderRadius: RADIUS.sm,
          background: "transparent",
          color: state === "failed" ? C.dangerInk : C.muted,
          fontSize: TYPE.micro,
          fontWeight: FONT_WEIGHT.semibold,
          whiteSpace: "nowrap",
          cursor: state === "idle" || state === "failed" ? "pointer" : "default",
          lineHeight: 0,
        }}
      >
        {/* react-icons/fi (Feather). No emoji — house rule. */}
        {iconOnly ? <FiPlus size={12} aria-hidden /> : <span>{actionText(action, state)}</span>}
      </button>
    </div>
  );
}

/** The button's own words as the send progresses. Exported-by-behaviour through the row's label;
 *  kept here so "Requested" is one string rather than three call sites guessing at a tense. */
export function actionText(action: string, state: SendState): string {
  if (state === "sending") return "Sending…";
  if (state === "sent") return "Requested";
  if (state === "failed") return "Try again";
  return action;
}
