// A LIVE PREVIEW, AS A CARD IN THE CONCIERGE COLUMN — the founder's shape, verbatim:
// *"[dot color] [build agent name] has a preview for you to review: [localhost preview card image
// screenshot]"*, where *"clicking on the preview card would take me out to the actual localhost URL
// and I could click on the builder agent name to go into that builder agent."*
//
// ══ THE GESTURES WERE SPLIT LATER (sparkle-7kn6bk) ══════════════════════════════════════════════
// The card first shipped at a small fixed size whose single click opened the browser — and that was
// the wrong default for a card too small to judge anything by: the reader's first instinct is to
// make it bigger, not to leave the app. So now the card is ~1/3 the chat column and a SINGLE CLICK
// EXPANDS it in place to full width; the browser is a DOUBLE CLICK, plus an explicit "Open in
// browser" button so the gesture is discoverable and keyboard-reachable rather than resting on a
// double-click nobody guesses. The founder quote above still describes the destination; only which
// gesture reaches it has moved.
//
// ══ WHAT WAS ACTUALLY BROKEN ════════════════════════════════════════════════════════════════════
// Not the preview subsystem — that works. The url. It is printed once into a terminal that keeps
// scrolling, so the one fact worth acting on ("there is something to LOOK at, right now") is gone
// within seconds. This surface is the fix, and its whole job is to be the place that does not
// scroll.
//
// ══ WHY THE COLUMN AND NOT A PANE ═══════════════════════════════════════════════════════════════
// See `services/previewCards`' header for the full argument. In one line: a preview PANE during
// planning is blocked three independent ways (mutually-exclusive work modes, a concierge with no
// worktree, and `preview_open` needing a real dev server), and a concierge ROW is not a work mode,
// so it sidesteps all three by only ever RENDERING a url another agent already owns.
//
// ══ RETIREMENT IS DERIVED, NOT SCHEDULED ════════════════════════════════════════════════════════
// There is no dismiss, no timer and no dead-link sweep, because the cards are a projection of
// `previewStore.byAgent` — the same store `preview:state` folds into. A preview that stops leaves
// its surfacing state (or its entry entirely), the projection stops producing a card, and the card
// is gone on the next render. A card can therefore never outlive the server it points at, which is
// a property of the shape rather than a rule someone has to remember.
//
// ══ THIS COMPONENT READS ITS OWN STORES ═════════════════════════════════════════════════════════
// `ConciergeColumn` is a pure renderer and must stay one, so this follows `MountedAgentNotices`
// (a component that asks the stores itself) rather than growing the view model. The one thing it
// does NOT own is the reveal: the agent name is an `AgentPill`, which resolves the live name, the
// live status dot and the click-through from the `AgentPillProvider` the pinned strip already
// wraps — so a renamed agent's card renames itself and there is no second roster to go stale.
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { FiExternalLink, FiRefreshCw } from "react-icons/fi";

import { AgentPill } from "./AgentPill";
// The SAME "time ago" the prompt-history dropdown uses. It takes `nowMs` as an argument rather than
// reading the clock, which is what lets this card own WHEN the age is recomputed — see
// `PREVIEW_CARD_AGE_TICK_MS`, because nothing else re-renders a card while a server sits quiet.
import { formatAgo } from "../promptHistory";
import { C } from "../../theme/colors";
import { FONT_MONO, RADIUS, TYPE } from "../../theme/scale";
import {
  renderablePreviewCards,
  renderablePreviewNotices,
  previewCardShot,
  type NamedPreviewNoticeModel,
  type PreviewNoticeState,
} from "../../services/previewCards";
// The CLICK-TIME ownership read. See `resolvePreviewOpenTarget`: the address a card is showing was
// true when the event that made the card landed, and a dev server's port outlives the server —
// which is how one agent's card came to open another agent's app. Nothing about the card can be
// trusted to notice, so the question is re-asked at the instant of the click.
import { resolvePreviewOpenTarget, type PreviewOpenRefusal } from "../../services/preview";
// `notePreviewActivity` is imported for the reason `previewStore` spells out at its definition:
// `supervise()` in preview.rs goes SILENT once a server is `Ready` (it sleeps on a liveness check
// and transitions again only to Crashed/Failed), so a healthy preview produces no further wire
// events at all. That makes this card the ONLY place a "still wanted" signal can come from, and
// without these two call sites the idle-grace clock degrades from an idle clock into a plain
// max-lifetime cap — silently, with every unit test green, because the seam is perfectly testable
// on its own. That is the `sparkle-lgbwf` shape, and it is why these calls are guarded by a test
// that drives the HANDLERS rather than calling the seam.
import { notePreviewActivity, usePreviewStore } from "../../stores/previewStore";
import { useProjectStore } from "../../stores/projectStore";

/** The strip. */
export const PREVIEW_CARDS_TESTID = "concierge-preview-cards";
/** The ONE element that caps how much vertical space the whole preview surface may take. Exported
 *  so a test can assert there is exactly one such budget rather than one per zone — see
 *  `PreviewCards` for why two independent caps put the composer off screen. */
export const PREVIEW_ZONE_TESTID = "concierge-preview-zone";
/** One card — carries `data-agent-id` and `data-preview-url` so a test/probe can read both facts. */
export const PREVIEW_CARD_TESTID = "concierge-preview-card";
/** The screenshot, once one has arrived. Absent until then, and absent forever if none can be
 *  taken — see `previewCardShot` for why a missing picture must not cost the card. */
export const PREVIEW_CARD_SHOT_TESTID = "concierge-preview-shot";
/** The "captured Xm ago" caption. Present only when there is a picture to date. */
export const PREVIEW_CARD_CAPTURED_TESTID = "concierge-preview-captured";
/** The ⟳ control. Re-captures THIS card's snapshot; never opens the url. Present whenever the card
 *  is — see the component for why it must NOT be gated on there already being a picture. */
export const PREVIEW_CARD_REFRESH_TESTID = "concierge-preview-refresh";
/** The "couldn't refresh" note. A capture that fails changes nothing else on screen, so without it
 *  the only signal is silence — and silence reads as a dead button. */
export const PREVIEW_CARD_REFRESH_FAILED_TESTID = "concierge-preview-refresh-failed";

/** The "didn't open, and here is why" line. Present ONLY after a click this card refused — see
 *  {@link PREVIEW_OPEN_REFUSAL_COPY} for why a refusal has to be visible rather than silent. */
export const PREVIEW_CARD_REFUSED_TESTID = "concierge-preview-refused";

/** The explicit "Open in browser" control. The card's PRIMARY click now expands in place rather
 *  than navigating (bead sparkle-7kn6bk), so the escape hatch to a real browser has to be a
 *  discoverable, keyboard-reachable button of its own — a double-click is a gesture nobody guesses
 *  and no keyboard can make. */
export const PREVIEW_CARD_OPEN_TESTID = "concierge-preview-open";

/**
 * THE TWO WIDTHS A CARD OCCUPIES, exported so a test can assert the SIZE rather than eyeballing it.
 *
 * The founder's ask (sparkle-7kn6bk): a card is ~1/3 the chat column collapsed and the full column
 * expanded, expanding IN PLACE on a single click. These are `width` values on a card that also sets
 * `alignSelf: "flex-start"`, so the collapsed card does NOT stretch to fill the flex column — the
 * fraction is real, not merely a max. `100%` is the whole column, not a modal: the shared chat-thread
 * contract on this bead is "collapsed = identity, expand in place, never a modal".
 */
export const PREVIEW_CARD_COLLAPSED_WIDTH = "33%";
export const PREVIEW_CARD_EXPANDED_WIDTH = "100%";

/**
 * WHAT THE CARD SAYS WHEN IT WILL NOT OPEN, in the reader's language rather than the wire's.
 *
 * ══ WHY THERE IS COPY HERE AT ALL ═══════════════════════════════════════════════════════════════
 * The failure this whole path exists to prevent is SILENT: a card whose port has been recycled
 * opens a page that renders perfectly and belongs to somebody else. The reader cannot tell. So a
 * refusal that produced nothing on screen would be only half a fix — the wrong app would be gone
 * and "I clicked and nothing happened" would take its place, which is the second-worst outcome and
 * the one people work around by clicking again.
 *
 * ══ A MAP RATHER THAN A TERNARY, same rule as `PREVIEW_NOTICE_LEAD` ═════════════════════════════
 * Adding a refusal reason in `services/preview` without giving it wording is a TYPE ERROR here,
 * rather than a blank line under a card at the moment someone most needs a sentence.
 *
 * ══ EACH LINE NAMES THE REMEDY IT ACTUALLY HAS ══════════════════════════════════════════════════
 * `moved` is the only one that can promise "click again", and it can because the read that found
 * the mismatch also corrected the card. The others end where they end on purpose: inventing a
 * remedy a refusal message cannot honour is how a remedy becomes the unsafe path (AGENTS.md,
 * `sparkle-8bvh`).
 */
export const PREVIEW_OPEN_REFUSAL_COPY: Record<PreviewOpenRefusal, string> = {
  moved: "Didn't open — this agent's preview moved to a different port. The card is updated; click again.",
  gone: "Didn't open — this agent's preview server is gone. That port may belong to another agent now.",
  "not-live": "Didn't open — this agent's preview is no longer serving.",
  "wrong-agent": "Didn't open — that address is answering for a different agent.",
  unsafe: "Didn't open — this preview's address is no longer a local one.",
  unreadable: "Didn't open — couldn't confirm this port is still this agent's.",
};

/** The NOTICE strip — the second, separate zone this component paints. See the block comment above
 *  {@link PreviewNotices} for why it is a zone of its own rather than more cards. */
export const PREVIEW_NOTICES_TESTID = "concierge-preview-notices";
/** One notice. Carries `data-agent-id` and `data-preview-status` so a test/probe can read WHICH
 *  agent and WHICH state without matching on prose. There is deliberately no `data-preview-url`:
 *  a notice has no url to hand anyone. */
export const PREVIEW_NOTICE_TESTID = "concierge-preview-notice";
/** The stderr tail / failure text, when the state carries one. */
export const PREVIEW_NOTICE_DETAIL_TESTID = "concierge-preview-notice-detail";
/** The "started 4m" caption. Present on every notice — an install can legitimately take five
 *  minutes, and "how long has this been going" is the whole question the reader is asking. */
export const PREVIEW_NOTICE_AGE_TESTID = "concierge-preview-notice-age";

/**
 * What each non-openable state says, reading directly after the agent pill's `@Name`.
 *
 * A MAP RATHER THAN A TERNARY, so adding a state to `NOTICE_STATES` without giving it wording is a
 * TYPE ERROR rather than a blank line in the column.
 *
 * ══ THE PUNCTUATION RULE, STATED ONCE FOR ALL SEVEN ENTRIES (roborev 65701) ═════════════════════
 * A colon PROMISES a detail, and the detail span renders only when `detail` is non-null — which
 * comes from `entry.error`, which `preview.rs` writes only on `failed`/`crashed`. So:
 *
 *   • end in a COLON only where `entry.error` is GUARANTEED non-null — today exactly `failed` and
 *     `crashed`, the two outcomes;
 *   • end in an ELLIPSIS for a stage still in progress — `installing`, `starting`, `listening`;
 *   • end in a FULL STOP where there is no detail and never will be — `ready`/`serving`, which
 *     reach this table only when the card cannot render the url (see `pendingPreviewNotices`).
 *
 * This is written here rather than beside the entries because the compile error a new state
 * triggers demands WORDING and says nothing about which punctuation is legal — which is exactly how
 * the colon got copied onto `ready`/`serving` and rendered a sentence stopping at a dangling colon.
 */
export const PREVIEW_NOTICE_LEAD: Record<PreviewNoticeState, string> = {
  installing: "is installing dependencies for a preview…",
  starting: "is starting a preview…",
  listening: "is compiling a preview…",
  failed: "could not start a preview:",
  crashed: "had a preview crash:",
  // REACHED ONLY WHEN THE CARD CANNOT RENDER THE PREVIEW — see `pendingPreviewNotices`. A running
  // server whose url is null or is not loopback http gets no card, and used to get nothing at all.
  // The wording says the preview is up and that the ADDRESS is the thing that cannot be offered,
  // rather than implying a failure that has not happened.
  // NO TRAILING COLON, unlike `failed`/`crashed` (roborev 65694). A colon promises a detail, and
  // `detail` comes from `entry.error`, which the Rust side writes only on `failed`/`crashed` — so
  // for exactly the case these two exist to cover it is null, the detail span is not rendered, and
  // the sentence would stop mid-thought and read as truncated output. These leads are complete
  // sentences instead, because they are all the reader is going to get.
  ready: "has a preview running, but not at an address this can open.",
  serving: "has a preview running, but not at an address this can open.",
};

/**
 * How often a card re-reads the clock so its "captured …" caption ages.
 *
 * IT NEEDS ITS OWN TICK, and that is the whole reason this constant exists. The strip re-renders on
 * `previewStore` writes, and a healthy dev server that nobody is touching produces NONE — so a
 * caption computed once at capture time would read "just now" for an hour, which is precisely the
 * lie the caption was added to prevent. 30s is under `formatAgo`'s first threshold (45s), so the
 * label can never skip the moment it stops being "just now".
 */
export const PREVIEW_CARD_AGE_TICK_MS = 30_000;

/** The sentence between the name and the picture. A CONSTANT because two tests and one probe read
 *  it, and because it is the founder's own wording — not a string to improve in passing. */
export const PREVIEW_CARD_LEAD = "has a preview for you to review:";

/** Roughly two cards. Past that the strip scrolls INSIDE itself rather than growing, exactly as
 *  `PinnedBlockers` does and for the same non-negotiable reason: nothing above the composer may
 *  push the composer off screen. */
const MAX_ZONE_HEIGHT = 260;

const card = (expanded: boolean): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  gap: 6,
  minWidth: 0,
  // ~1/3 THE CHAT COLUMN COLLAPSED, THE WHOLE COLUMN EXPANDED (sparkle-7kn6bk). `alignSelf` is the
  // half that makes the fraction real: the strip is a flex column, so without it a `width` below
  // 100% is still stretched to fill by `align-items: stretch`, and the card would read full-width
  // whatever the number said. Anchored to the start so the collapsed card sits where the reader's
  // eye already is rather than centring itself.
  width: expanded ? PREVIEW_CARD_EXPANDED_WIDTH : PREVIEW_CARD_COLLAPSED_WIDTH,
  alignSelf: "flex-start",
  padding: "7px 9px",
  borderRadius: RADIUS.sm,
  border: `1px solid ${C.hairline}`,
  background: "transparent",
  cursor: "pointer",
  // CLIP RATHER THAN ESCAPE, the containment floor every narrow surface in this column shares: the
  // concierge column is user-dragged and can be squeezed below what any of these children want.
  overflow: "hidden",
});

const shot = (expanded: boolean): CSSProperties => ({
  display: "block",
  width: "100%",
  // COLLAPSED: the picture is a CUE, not the artefact — capped and top-cropped so the card stays a
  // recognisable thumbnail the reader can tell apart from a sibling's at a glance.
  // EXPANDED: height follows the preview's OWN aspect ratio (`height: auto`, no crop), which is the
  // founder's ask — the expanded card is the closest thing to the real page short of the browser.
  maxHeight: expanded ? undefined : 150,
  height: expanded ? "auto" : undefined,
  objectFit: expanded ? "contain" : "cover",
  objectPosition: "top",
  borderRadius: RADIUS.sm,
  border: `1px solid ${C.hairline}`,
});

/**
 * One card. Split out from the strip so the screenshot effect is keyed by MOUNT rather than by an
 * index into a list — a card that is retired unmounts, which cancels its own fetch, and a new
 * agent's card cannot inherit the previous occupant's picture.
 */
function PreviewCard({
  agentId,
  url,
  name,
  surfacedAt,
}: {
  agentId: string;
  url: string;
  name: string;
  surfacedAt: number;
}) {
  /**
   * THIS AGENT'S PORT, subscribed BY AGENT ID rather than passed down with the url.
   *
   * The card model carries the url and nothing else, so a port threaded through it would be a
   * second copy of the same fact stamped at the same moment — and the whole bug is that a stamped
   * value goes stale. Reading it out of the store keyed on `agentId` means the card can never hold
   * a port belonging to a different agent, whatever else drifts: there is exactly one row it can
   * read, and it is this agent's own. It is also what `data-preview-port` publishes, so a test can
   * assert the OWNERSHIP of what is on screen rather than only that two urls happen to differ.
   *
   * It is still a value read at RENDER time — which is why it is checked again below. See `open`.
   */
  const heldPort = usePreviewStore((s) => s.byAgent[agentId]?.port ?? null);
  /** EXPANDED IN PLACE, per this card's own id and ephemeral (bead sparkle-7kn6bk + the shared
   *  chat-thread contract on it: expanded state is per-item and does not survive a remount). A
   *  single click toggles it; the card grows to the full chat-column width and the screenshot to the
   *  preview's own height, with scroll position untouched — it is never a modal. */
  const [expanded, setExpanded] = useState(false);
  const [shotState, setShotState] = useState<{ dataUrl: string; capturedAt: number } | null>(null);
  /** Why the last click did not open anything. Null until a click is refused, and deliberately NOT
   *  cleared when the url changes — the `moved` refusal's whole point is that the card corrected
   *  itself, and wiping the sentence on that very re-render would leave the reader with a card that
   *  silently changed under them and no idea why nothing opened. */
  const [refusal, setRefusal] = useState<PreviewOpenRefusal | null>(null);
  /** ONE OWNERSHIP READ IN FLIGHT AT A TIME. A refused click shows a sentence and nothing else
   *  moves, which is exactly the shape that invites a second and third click — and each one is a
   *  round trip to the supervisor. A ref rather than state: it must be read and set inside the same
   *  handler invocation, before React has re-rendered anything. */
  const openingRef = useRef(false);
  // ONE FETCH PER (agent, url, surfacing), and the guard is a ref rather than a dependency array
  // because the point is to survive re-renders the dependency array cannot see — every unrelated
  // store tick re-renders this strip, and a capture drives a real headless browser.
  const fetchedRef = useRef<string | null>(null);
  // ONE ALIVE FLAG FOR THE COMPONENT, not one per capture, because a capture can now be started by
  // the ⟳ as well as by the effect — and a per-effect `live` local cannot cancel a manual one, which
  // is how a click seconds before the card retires writes into an unmounted tree.
  const aliveRef = useRef(true);
  // AND A RUN COUNTER, so the LAST capture wins rather than the last to RESOLVE. A ⟳ pressed while
  // an automatic re-capture is still in flight would otherwise let the older picture land on top of
  // the newer one, with a timestamp saying it is fresh.
  const runRef = useRef(0);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    [],
  );

  // IN FLIGHT — one capture at a time, and this is not cosmetic. Every press drives a REAL headless
  // Chromium (`previewCardShot` → `preview_screenshot` → `launch_browser`), which takes seconds and
  // is serialized nowhere on the Rust side either. A failed capture by design changes nothing on
  // screen, so the natural response to "I clicked and nothing happened" is to click again — four
  // presses in six seconds would launch four browsers and throw three of the results away.
  const [busy, setBusy] = useState(false);
  // …and a capture that failed says so. See the note above: silence is indistinguishable from a
  // dead button, and this is the only thing on the card that moves when a re-capture loses.
  const [failed, setFailed] = useState(false);

  const capture = useCallback(() => {
    // Same reasoning as `open`: asking for a fresh snapshot is a person saying this preview still
    // matters. Stamped at the START of the capture rather than on success, because a capture that
    // fails (no headless Chromium, server mid-restart) is still someone asking.
    notePreviewActivity(agentId);
    const run = ++runRef.current;
    setBusy(true);
    setFailed(false);
    void previewCardShot(agentId).then((d) => {
      // The alive check stops a late capture from writing into a card that has since been retired —
      // React warns about it, but the real cost is a picture of a preview that is gone.
      //
      // A SUPERSEDED RUN RETURNS WITHOUT CLEARING `busy`, deliberately: the run that superseded it
      // is still in flight and will clear it. Clearing here would re-enable the button while a
      // browser is still running, which is the state this flag exists to prevent.
      if (!aliveRef.current || run !== runRef.current) return;
      setBusy(false);
      // A FAILED RE-CAPTURE KEEPS THE OLD PICTURE, and that is deliberate: the alternative is a
      // card that had a snapshot, was refreshed, and now shows none — strictly less than it had.
      // The caption's timestamp is what stops that from being a lie, since it does not move.
      if (d !== null) setShotState({ dataUrl: d, capturedAt: Date.now() });
      else setFailed(true);
    });
  }, [agentId]);

  useEffect(() => {
    // KEYED ON `surfacedAt` AS WELL, so a preview that goes away and comes back — a restart, or a
    // rebuild that dropped out of `serving` and returned — re-captures instead of showing the
    // picture of a page that no longer exists. A same-state hot reload is invisible here by
    // construction; `previewCardShot`'s header says why, and the ⟳ is the answer to it.
    const key = `${agentId}|${url}|${surfacedAt}`;
    if (fetchedRef.current === key) return;
    fetchedRef.current = key;
    capture();
  }, [agentId, url, surfacedAt, capture]);

  // THE CAPTION'S OWN CLOCK. See `PREVIEW_CARD_AGE_TICK_MS`: nothing else re-renders a card while a
  // dev server sits quietly serving, so without this the age freezes at whatever it was when the
  // picture landed. Armed only while there IS a picture — a card with none has nothing to date, and
  // an interval running for it would be a wake-up with no possible visible effect.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!shotState) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), PREVIEW_CARD_AGE_TICK_MS);
    return () => clearInterval(id);
  }, [shotState]);

  /**
   * OPEN THIS AGENT'S PREVIEW — OR REFUSE, AND SAY SO.
   *
   * ══ WHY THIS IS NOT A STRAIGHT `openUrl(url)` ANY MORE ════════════════════════════════════════
   * It was, and it opened another agent's app. A card is rendered from an event that was true when
   * it landed; a dev server can die seconds later and its port be handed to the next agent that
   * asks. The url still parses, the page still renders, and there is nothing on screen for the
   * reader to disbelieve. Distinct ports per agent (the supervisor's half) narrow that window —
   * they cannot close it, because reuse over time is the mechanism, not collision at one instant.
   *
   * So the address is RE-DERIVED here, from this agent's own live status, at the moment of the
   * click. `resolvePreviewOpenTarget` does the read and the comparison; this handler only decides
   * what the reader sees.
   *
   * ══ REFUSING IS THE POINT, AND THERE IS NO FALLBACK ═══════════════════════════════════════════
   * Every non-`ok` branch ends here, with a sentence and no navigation. Opening the held url anyway
   * "because we could not check" would restore the exact defect for the exact case that is most
   * likely to hit it. Opening the FRESH url instead would be a silent redirect — a second
   * destination from one gesture, hiding the fact that the card (and the screenshot above it) had
   * gone stale.
   */
  const open = () => {
    // A human opening the preview is the strongest "still wanted" signal there is — stamped FIRST
    // and synchronously, so neither a slow ownership read nor a refusal can cost the signal. The
    // click happened either way, which is the fact the grace clock is asking about.
    notePreviewActivity(agentId);
    if (openingRef.current) return;
    openingRef.current = true;
    void resolvePreviewOpenTarget(agentId, { url, port: heldPort })
      .then((decision) => {
        if (!decision.ok) {
          // The card may have retired while the read was in flight — a retired card has no reader,
          // and writing to it is a React warning for no benefit. The absence of a navigation is
          // what matters, and that has already happened by not calling `openUrl`.
          if (aliveRef.current) setRefusal(decision.reason);
          console.warn(
            "preview card: refusing to open",
            agentId,
            decision.reason,
            decision.heldUrl,
            decision.liveUrl,
          );
          return;
        }
        // NOT GATED ON `aliveRef`. The verdict is about the SERVER, not about this component: a
        // click that was answered "yes, this address is this agent's" has earned its navigation
        // even if the strip re-rendered the card away underneath it in the meantime.
        if (aliveRef.current) setRefusal(null);
        void openUrl(decision.url).catch((e) =>
          console.warn("preview card: open url failed", decision.url, e),
        );
      })
      .finally(() => {
        openingRef.current = false;
      });
  };

  /**
   * THE PRIMARY GESTURE NOW: expand the card in place, or collapse it again — never navigate.
   *
   * A single click used to open the browser, which is the wrong default for a card too small to
   * judge anything by (sparkle-7kn6bk): the reader's first instinct is to make it bigger, not to
   * leave the app. So a click grows the card to the full chat-column width at the preview's own
   * height, and a second click puts it back.
   *
   * IT STAMPS ACTIVITY, exactly as `open`/`capture` do. Expanding a card is a human saying "I am
   * looking at this right now", which is the one signal `previewIdleGrace` has to keep the dev
   * server alive — see the block comment on `notePreviewActivity`'s import. Synchronous and first,
   * so nothing about the toggle can cost the signal.
   */
  const toggleExpanded = () => {
    notePreviewActivity(agentId);
    setExpanded((v) => !v);
  };

  return (
    <div
      data-testid={PREVIEW_CARD_TESTID}
      data-agent-id={agentId}
      data-preview-url={url}
      // THE PORT, PUBLISHED AS ITS OWN FACT. `data-preview-url` already contains it, but a test
      // that can only read the url can assert two cards DIFFER — never that each belongs to the
      // right agent, which is the claim that actually failed. Absent rather than `"null"` when
      // there is none, so "no port" and the string "null" cannot be confused.
      data-preview-port={heldPort === null ? undefined : String(heldPort)}
      // WHICH SIZE THIS CARD IS, published as a fact so a test asserts the expand SIDE EFFECT rather
      // than eyeballing a width. Absent rather than `"false"` when collapsed, so the attribute's
      // presence is itself the signal.
      data-expanded={expanded ? "true" : undefined}
      role="button"
      tabIndex={0}
      // THE CARD IS A TOGGLE NOW, so it announces its expanded state and what activating it does.
      // The url is NOT in this name any more — a single click no longer navigates there; the
      // "Open in browser" button below carries the url in its own accessible name instead.
      aria-expanded={expanded}
      aria-label={`${expanded ? "Collapse" : "Expand"} ${name}'s preview`}
      // SINGLE CLICK EXPANDS, DOUBLE CLICK OPENS (sparkle-7kn6bk). React fires `onDoubleClick` from
      // the browser's own `dblclick`, which arrives AFTER the two clicks — so a double-click toggles
      // twice (a no-op, back to where it started) and then opens, which is the intended net effect.
      onClick={toggleExpanded}
      onDoubleClick={open}
      onKeyDown={(e) => {
        // ONLY THE CARD ITSELF — a keydown on the nested pill, the ⟳ or the open button bubbles
        // here, and preventDefault would cancel their own Enter/Space activation. Same rule as
        // `PinnedBlockers`/`NudgeCard`. Enter/Space EXPANDS (the primary gesture); the keyboard path
        // to the browser is the focusable "Open in browser" button, since a double-click has no
        // keyboard equivalent.
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggleExpanded();
      }}
      style={card(expanded)}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
        {/* A FENCE around the pill's own click, exactly as the pinned blocker row does it. Without
            it, one click on the agent name would BOTH open the agent and launch the browser — two
            destinations from one gesture, which is the worst kind of surprise this column can
            produce. The fence sinks the bubble and nothing else; every other pixel of the card
            still reaches the card's own handler. */}
        <span
          style={{ display: "inline-flex", minWidth: 0, overflow: "hidden" }}
          onClick={(e) => e.stopPropagation()}
          role="presentation"
        >
          <AgentPill agentId={agentId} fallbackName={name} />
        </span>
        <span style={{ color: C.conciergeMuted, fontSize: TYPE.small, minWidth: 0 }}>
          {PREVIEW_CARD_LEAD}
        </span>
      </div>
      {shotState ? (
        <img
          data-testid={PREVIEW_CARD_SHOT_TESTID}
          src={shotState.dataUrl}
          alt={`Preview of ${name}`}
          style={shot(expanded)}
        />
      ) : (
        // NO SPINNER, and no empty box holding a place. A capture needs a headless Chromium that
        // may simply not be installed, so "no picture" is a steady state rather than a moment —
        // and the url, which is the actionable half, is worth more on screen than a placeholder.
        <span
          style={{
            color: C.conciergeMuted,
            fontSize: TYPE.small,
            // THE TOKEN, never a retyped stack — `fontTokens.test.ts` ratchets that at zero.
            fontFamily: FONT_MONO,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {url}
        </span>
      )}
      {refusal && (
        // THE ONE THING ON THE CARD THAT SAYS A CLICK WAS REFUSED. Without it the fix trades a
        // wrong app for a dead-looking card, and a dead-looking card gets clicked again.
        //
        // ══ ITS OWN LINE, NOT A CHILD OF THE FOOTER ROW ═══════════════════════════════════════
        // The footer is a nowrap flex row beside the ⟳, inside a card that CLIPS its overflow —
        // so a sentence put there would be silently cut off in a narrow column, which is the one
        // failure mode this element exists to prevent. Here it wraps instead.
        //
        // `role="status"` for the reason `MountedNotice` states for its own refusal: this is
        // information the reader needs and cannot otherwise get — nothing else on the card moves
        // when a click is refused. It is mounted only WHILE there is something to say, so the
        // column's "exactly one live region" budget is untouched in every other state.
        <div
          data-testid={PREVIEW_CARD_REFUSED_TESTID}
          role="status"
          style={{
            color: C.conciergeMuted,
            fontSize: TYPE.micro,
            minWidth: 0,
            whiteSpace: "normal",
            overflowWrap: "anywhere",
          }}
        >
          {PREVIEW_OPEN_REFUSAL_COPY[refusal]}
        </div>
      )}
      {/* THE FOOTER ROW — always present, and its two halves are gated DIFFERENTLY on purpose.
          ══ THE CAPTION IS WHAT MAKES A SNAPSHOT HONEST, and it needs a picture to date. A still
          picture of a live site is only trustworthy if it says how old it is: without this, a card
          that has been on screen for an hour looks exactly like one captured a second ago. An age
          caption over a card that never got a picture would be dating nothing, so it stays gated.
          ══ THE ⟳ IS NOT GATED ON ONE, and that is the correction: gating it there put the retry
          out of reach in exactly the case it was written for. `previewCardShot` lists `no-preview`
          ("it stopped between the store read and the capture") and `preview-not-ready` as ORDINARY
          TRANSIENT refusals — and a card whose automatic capture hits one has already burned its
          fetch key, so the effect never re-fires either. Without a button there, one unlucky second
          left the card picture-less for the whole life of that preview. */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {shotState && (
          <span
            data-testid={PREVIEW_CARD_CAPTURED_TESTID}
            style={{ color: C.conciergeMuted, fontSize: TYPE.micro, minWidth: 0 }}
          >
            {`captured ${formatAgo(nowMs, shotState.capturedAt)}`}
          </span>
        )}
        {failed && (
          <span
            data-testid={PREVIEW_CARD_REFRESH_FAILED_TESTID}
            style={{ color: C.conciergeMuted, fontSize: TYPE.micro, minWidth: 0 }}
          >
            couldn&apos;t refresh
          </span>
        )}
        {/* THE ESCAPE HATCH TO A REAL BROWSER — the discoverable half of "double-click opens".
            The card's own click expands rather than navigates now (sparkle-7kn6bk), so opening the
            preview externally needs a control a reader can see and a keyboard can reach; a
            double-click satisfies neither. FENCED on its own span for the exact reason the ⟳ is:
            a click here must open the url and NOT also toggle the card's size. `marginLeft: auto`
            pushes both controls to the trailing edge, clear of the caption. It runs the SAME `open`
            path the double-click does — the click-time ownership re-derivation and every refusal are
            shared, so this button can never open a stale or wrong-agent address either. */}
        <span
          onClick={(e) => e.stopPropagation()}
          style={{ display: "inline-flex", marginLeft: "auto" }}
        >
          <button
            type="button"
            data-testid={PREVIEW_CARD_OPEN_TESTID}
            aria-label={`Open ${name}'s preview at ${url} in the browser`}
            title="Open in browser"
            onClick={(e) => {
              e.stopPropagation();
              open();
            }}
            style={{
              appearance: "none",
              border: "none",
              background: "transparent",
              color: C.conciergeMuted,
              cursor: "pointer",
              padding: 0,
              display: "inline-flex",
              alignItems: "center",
              flex: "0 0 auto",
            }}
          >
            <FiExternalLink size={11} />
          </button>
        </span>
        {/* FENCED, like the pill: a click here must re-capture and NOT also launch a browser.
            DISABLED WHILE ONE IS IN FLIGHT — see `busy`; a capture is a whole browser process.

            THE FENCE IS ON THIS SPAN, NOT ONLY ON THE BUTTON, AND THAT IS THE WHOLE POINT OF IT.
            A DISABLED button fires no React onClick at all, so the `stopPropagation` inside the
            button's own handler does not run — while the DOM click still bubbles to the card, whose
            handler opens the url. So the fence held in exactly the state nobody tests by hand
            (idle) and failed in the state the button spends its busy window in: press ⟳, and
            because a capture was already running you got a browser window instead. Wrapping the
            control means the bubble is stopped whether or not the button itself is interactive. */}
        <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex" }}>
        <button
          type="button"
          data-testid={PREVIEW_CARD_REFRESH_TESTID}
          aria-label={`Refresh the preview snapshot for ${name}`}
          title={busy ? "Capturing…" : "Refresh this snapshot"}
          disabled={busy}
          onClick={(e) => {
            e.stopPropagation();
            if (busy) return;
            capture();
          }}
          style={{
            appearance: "none",
            border: "none",
            background: "transparent",
            color: C.conciergeMuted,
            cursor: busy ? "default" : "pointer",
            opacity: busy ? 0.4 : 1,
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
            flex: "0 0 auto",
          }}
        >
          <FiRefreshCw size={10} />
        </button>
        </span>
      </div>
    </div>
  );
}

/**
 * ONE PREVIEW THAT CANNOT BE OPENED, SAID OUT LOUD — the other half of this surface.
 *
 * ══ WHY IT IS NOT A CARD ════════════════════════════════════════════════════════════════════════
 * "A dead link is worse than no card, because it costs the reader a click to learn it is dead" is
 * the rule that kept `failed`/`installing` off screen entirely, and it is still right — about
 * LINKS. It was never an argument for silence. So a notice keeps the rule and drops the link: it is
 * a STATUS LINE, and the difference is structural rather than styled.
 *
 * NOTHING HERE IS CLICKABLE, and that is the assertion this component's shape has to survive: no
 * `role="button"`, no `tabIndex`, no `onClick`, no `onKeyDown`, and `openUrl` is never reached from
 * this subtree. A greyed-out card would have been the cosmetic version of the same idea and would
 * have failed at exactly the moment that matters — an inert-LOOKING card still invites the click
 * that teaches the reader it is dead. There is also no fence around the pill, because a fence
 * exists to stop a click bubbling to a parent handler and there is no parent handler to stop.
 *
 * ══ THE TWO THINGS IT SAYS ══════════════════════════════════════════════════════════════════════
 *   1. WHOSE, and WHAT STATE — the pill plus one sentence from `PREVIEW_NOTICE_LEAD`.
 *   2. WHY, when the store has a why. `preview.rs` already writes a stderr tail into the `error`
 *      field of every `failed`/`crashed` transition ("the dev server exited before it started
 *      listening. Last output: …"); this is the first thing that renders it. MONOSPACE, because it
 *      is program output and proportional type makes a stack trace unreadable, and CLAMPED by
 *      `clampNoticeDetail`, with the full text on `title` so nothing is actually lost.
 */
function PreviewNotice({ notice, nowMs }: { notice: NamedPreviewNoticeModel; nowMs: number }) {
  const { agentId, name, status, failed, detail, fullDetail, startedAt } = notice;
  return (
    <div
      data-testid={PREVIEW_NOTICE_TESTID}
      data-agent-id={agentId}
      data-preview-status={status}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
        padding: "6px 9px",
        borderRadius: RADIUS.sm,
        border: `1px solid ${C.hairline}`,
        background: "transparent",
        // CLIP RATHER THAN ESCAPE — the containment floor every narrow surface in this column
        // shares; the concierge column is user-dragged and can be squeezed below what this wants.
        overflow: "hidden",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", minWidth: 0, overflow: "hidden" }}>
          <AgentPill agentId={agentId} fallbackName={name} />
        </span>
        <span
          style={{
            // THE ONLY COLOUR DIFFERENCE between a stage and an outcome. A failure earns the danger
            // ink; "installing…" is ordinary progress and must not read as an alarm.
            color: failed ? C.dangerInk : C.conciergeMuted,
            fontSize: TYPE.small,
            minWidth: 0,
          }}
        >
          {PREVIEW_NOTICE_LEAD[status]}
        </span>
      </div>
      {detail && (
        <span
          data-testid={PREVIEW_NOTICE_DETAIL_TESTID}
          // THE UNCLAMPED TEXT, so the clamp costs nothing but width. A hover gives the whole tail.
          title={fullDetail ?? undefined}
          style={{
            color: C.conciergeMuted,
            fontSize: TYPE.micro,
            // THE TOKEN, never a retyped stack — `fontTokens.test.ts` ratchets that at zero. Mono
            // because this is program output, not prose.
            fontFamily: FONT_MONO,
            minWidth: 0,
            // WRAPS rather than ellipsising to one line: a stderr tail's value is in the whole
            // sentence, and the clamp above is what keeps the wrap from growing without bound.
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {detail}
        </span>
      )}
      <span
        data-testid={PREVIEW_NOTICE_AGE_TESTID}
        style={{ color: C.conciergeMuted, fontSize: TYPE.micro, minWidth: 0 }}
      >
        {`started ${formatAgo(nowMs, startedAt)}`}
      </span>
    </div>
  );
}

/**
 * The strip of NON-openable previews. Separate from the card strip, and separate all the way down
 * to `services/previewCards`' own projection — see that module's second header for why.
 *
 * ══ THE AGE CAPTION NEEDS ITS OWN CLOCK, exactly as the card's does ═════════════════════════════
 * `preview.rs` waits up to `INSTALL_WAIT_TIMEOUT` (300s) for an install, and emits NOTHING while it
 * waits. So the whole five minutes produces zero `previewStore` writes and therefore zero
 * re-renders — a caption computed once would read "started just now" for the entire wait, which is
 * the precise lie this caption exists to prevent. ONE interval for the strip rather than one per
 * notice.
 *
 * ══ THE EMPTY CASE IS THE CALLER'S, NOT THIS COMPONENT'S ════════════════════════════════════════
 * There is deliberately no `if (notices.length === 0) return null` here. {@link PreviewCards} only
 * MOUNTS this when there is something to say, exactly as it does for the card strip — so an
 * internal empty guard would be an inert line no test could ever turn red, which is precisely the
 * shape `mutation-check` flags. Keeping the emptiness decision in one place also keeps the interval
 * honest: this component never exists without a notice to age, so the timer never runs for nothing.
 */
function PreviewNotices({ notices }: { notices: NamedPreviewNoticeModel[] }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), PREVIEW_CARD_AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <div
      data-testid={PREVIEW_NOTICES_TESTID}
      // A LANDMARK, not a log — same reasoning as the card strip and the pinned blockers zone.
      // `aria-live` would be wrong: this content persists rather than arriving, and the column
      // already has exactly one live region.
      role="region"
      aria-label={`${notices.length} preview${notices.length === 1 ? "" : "s"} not yet openable`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "0 12px 6px",
        flex: "0 0 auto",
      }}
    >
      {notices.map((n) => (
        <PreviewNotice key={n.agentId} notice={n} nowMs={nowMs} />
      ))}
    </div>
  );
}

/**
 * The strip of live preview cards. Renders nothing when there are none, which is the ordinary
 * state — so this costs an empty render and no layout at all until a preview actually surfaces.
 */
export function PreviewCards() {
  const byAgent = usePreviewStore((s) => s.byAgent);
  const projects = useProjectStore((s) => s.projects);
  // BOTH GATES IN ONE PLACE — the store's (`ready`/`serving` on a loopback url) and the roster's
  // (an agent that is not in the fleet has nothing to show). The roster half used to be inline
  // here, which made this component's answer to "is this preview on screen?" differ from
  // `previewIdleGrace`'s, and the disagreement leaked a dev server. See `renderablePreviewCards`.
  const named = renderablePreviewCards(byAgent, projects);
  // THE SECOND PROJECTION, kept separate all the way down. Broadening `renderablePreviewCards` to
  // cover these states would have changed which dev servers `previewIdleGrace` reclaims — a
  // lifecycle change wearing the costume of a UI change. See `services/previewCards`' second header.
  const notices = renderablePreviewNotices(byAgent, projects);
  if (named.length === 0 && notices.length === 0) return null;
  // TWO REGIONS, NOT ONE, and the order is the column's usual rule: the thing that needs the reader
  // (a dev server that just died) sits nearest the composer, under the invitations.
  return (
    // ONE SHARED HEIGHT BUDGET FOR BOTH ZONES (roborev 65681, Medium). `MAX_ZONE_HEIGHT` is the
    // per-zone cap that keeps anything above the composer from pushing it off screen, and splitting
    // the preview surface into TWO zones that each claimed it independently doubled the fixed
    // budget: 132 (blockers) + 260 + 260 = 652 instead of 392. The concierge column is a plain
    // flex column with no scroll of its own, so only `ConciergeThread` can give way — and with a
    // mixed fleet (two live previews, two installing/failed) in a short window the thread collapses
    // to nothing and the composer leaves the screen. `failed` notices make that durable rather than
    // transient, because nothing sweeps them.
    //
    // So the cap lives on ONE wrapper and the two zones inside are uncapped: the preview surface
    // costs exactly what it cost before notices existed, and the scroll is shared rather than one
    // per zone — which is also better to read, since two independent scrollbars stacked in a 320px
    // column is its own small horror.
    <div
      data-testid={PREVIEW_ZONE_TESTID}
      style={{ maxHeight: MAX_ZONE_HEIGHT, overflowY: "auto", flex: "0 0 auto" }}
    >
      {named.length > 0 && <PreviewCardStrip named={named} />}
      {notices.length > 0 && <PreviewNotices notices={notices} />}
    </div>
  );
}

/** The openable half, unchanged. Split out of {@link PreviewCards} only so the strip's own region —
 *  whose `aria-label` counts LIVE previews — keeps meaning exactly what it meant before notices
 *  existed. */
function PreviewCardStrip({ named }: { named: ReturnType<typeof renderablePreviewCards> }) {
  return (
    <div
      data-testid={PREVIEW_CARDS_TESTID}
      // A LANDMARK, not a log — same reasoning as the pinned blockers zone. `aria-live` would be
      // wrong: this content persists rather than arriving, and the column already has exactly one
      // live region.
      role="region"
      aria-label={`${named.length} live preview${named.length === 1 ? "" : "s"}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "0 12px 6px",
        flex: "0 0 auto",
      }}
    >
      {named.map((c) => (
        <PreviewCard
          key={c.agentId}
          agentId={c.agentId}
          url={c.url}
          name={c.name}
          surfacedAt={c.surfacedAt}
        />
      ))}
    </div>
  );
}
