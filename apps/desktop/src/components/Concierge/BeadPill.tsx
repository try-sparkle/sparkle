// The pill a BEAD ID draws as, and the card it opens in place. The founder's ask, verbatim: "I want
// to make the beads clickable in the concierge window… it just opens the card up. And then if
// there's a spot on the card where I can click to view it on the board, it opens up the whole plan
// board." (bead sparkle-t6wje.)
//
// The sibling of `AgentPill`, and built to the same three rules, because the founder's standing ask
// for mentions was that they be SYMMETRICAL — what the concierge names should read as one
// vocabulary whether it is an agent or a unit of work:
//
//   1. IT RE-READS LIVE STATE ON EVERY RENDER. Never a snapshot. See below — this is the bead's
//      fourth requirement and the single easiest thing to get wrong.
//   2. EVERY CLICK PRODUCES A VISIBLE RESULT. A reference that cannot do anything is not a control;
//      it is prose, and it renders as prose. `AgentPill.deadEnd.test.tsx` exists to forbid the
//      alternative and this component is held to it.
//   3. INLINE ELEMENTS ONLY. This renders inside `<Markdown>`, i.e. inside a `<p>`, where a `<div>`
//      is invalid nesting that React emits happily and the browser silently reparents — moving the
//      card out of the paragraph that explains it.
//
// ══ WHY A CANDIDATE THAT DOES NOT RESOLVE IS PLAIN TEXT ═════════════════════════════════════════
// The bead is explicit that an id which does not exist must not be linkified, "since a link that
// opens nothing is worse than plain text". The linkifier upstream (`remarkBeadRefs`) deliberately
// does NOT make that test — it cannot, being a parse-time pass inside a `memo`ized renderer — so it
// is made HERE, against the live store, on every render.
//
// That split is what makes the two halves of the requirement true at once. A bare `auto-heal` in
// prose is id-SHAPED, arrives here as a candidate, misses the map, and renders as the two words it
// always was. A bead filed five minutes after the message was written starts resolving on the next
// poll, without the message being re-parsed. Neither behaviour is expressible if existence is
// decided while the text is being read.
//
// ══ WHY THE LIVE STATE TRAVELS BY CONTEXT ═══════════════════════════════════════════════════════
// The same reason `AgentPill` gives, and it is worth not re-deriving: `<Markdown>` is `memo`ized on
// `text` ALONE because ReactMarkdown re-parses the entire string on every render and a concierge
// reply streams in token by token. Handing it a bead list or a click handler would defeat that memo
// on every render, turning a streaming reply into O(bubbles × tokens) markdown parses.
//
// `React.memo` blocks re-render from PROPS. It does not block a context update from reaching a
// consumer inside the memoized subtree. So the board travels by context, the memo stays intact, and
// a pill — AND AN ALREADY-OPEN CARD — repaints the instant the bead's status changes.
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { FiExternalLink } from "react-icons/fi";
import { C } from "../../theme/colors";
import { FONT_MONO, TYPE } from "../../theme/scale";
import { MENTION_PILL_FILL } from "./MentionPill";
import { sideOf } from "../../engine/pairs";
import { useBeadsStore } from "../../stores/beadsStore";
import { useProjectStore } from "../../stores/projectStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import type { Bead, BeadStatus } from "../../services/beads";

/** A resolved bead, and WHICH PROJECT'S board holds it. The project id is not decoration: the
 *  concierge is cross-project by construction ("the concierge is not any project at all",
 *  ConciergeColumn), so the board a bead opens on cannot be inferred from the column. */
export interface ResolvedBead {
  bead: Bead;
  projectId: string;
}

export interface BeadPillContextValue {
  /** The live board, indexed. A MAP rather than the array `BoardView` linear-scans: a concierge
   *  answer can name a dozen beads and the thread holds many answers, so an O(n) scan per pill per
   *  render is the shape that gets slow quietly. Empty means "nothing resolves", which is the
   *  correct default — a surface that has not opted in renders every id as the prose it was. */
  beads: ReadonlyMap<string, ResolvedBead>;
  /** Open the Plan board focused on this bead, and report whether it LANDED.
   *
   *  THE RETURN VALUE IS THE CONTRACT, exactly as it is for `AgentPillContextValue.onOpenAgent`:
   *  `false` means nothing on screen changed, and the card turns that into a sentence rather than
   *  leaving the reader looking at an unchanged screen.
   *
   *  AN OBJECT, NOT TWO POSITIONAL STRINGS (roborev 54894). Both fields are `string`, so a swapped
   *  pair typechecks cleanly and its only symptom is a board that focuses nothing.
   *
   *  OPTIONAL. Its absence means "this surface has no board to open", which is a fact about the
   *  surface — the card still opens and still shows the bead, it simply offers no second step. That
   *  is not a dead end: the click already produced the card. */
  onViewOnBoard?: (target: { beadId: string; projectId: string }) => boolean;
}

/** A STABLE empty default — a module const, not an inline literal, so every `<Markdown>` outside the
 *  concierge column (SupportModal, agent replies) shares one identity and never re-renders on it. */
const EMPTY_BEADS: ReadonlyMap<string, ResolvedBead> = new Map();
const EMPTY: BeadPillContextValue = { beads: EMPTY_BEADS };

const BeadPillContext = createContext<BeadPillContextValue>(EMPTY);

/** Supplies the live board to every pill below it. The raw provider, mirroring `AgentPillProvider`
 *  — `BeadPillHost` below is what production mounts; this is what a test hands a fixture to. */
export const BeadPillProvider = BeadPillContext.Provider;

// ── THE HOST ────────────────────────────────────────────────────────────────────────────────────

/**
 * Wires the live beads store to every pill in the thread, and keeps it polling.
 *
 * ══ IT STARTS THE POLLER ITSELF, AND IT HAS TO ══════════════════════════════════════════════════
 * `beadsStore` is polled by exactly one component today — `BoardView`, on mount. So before this
 * host existed, a bead id could only resolve while a Plan board happened to be open, which is
 * precisely the situation the founder is NOT in when he reads a bead id in the concierge and wants
 * to know what it says. Without this the feature would be dead text most of the time and nobody
 * would be able to say why.
 *
 * `startPolling` is reference-counted (see the store), so this co-exists with a `BoardView` on the
 * same project instead of racing it: whichever unmounts second stops the timer. That counting was
 * added for this and fixes a latent bug it did not cause — two boards on one project (a project can
 * be shown in both pairs) already had the first board's poller killed by the second board's unmount.
 *
 * ══ WHICH PROJECT ═══════════════════════════════════════════════════════════════════════════════
 * The SELECTED one, which is the project the founder is working in and the project whose ids the
 * concierge is overwhelmingly writing. Ids belonging to a project nobody has open resolve to
 * nothing and render as plain text — the safe direction, and the one the bead asks for.
 *
 * RESOLUTION, though, spans every project the store currently holds, not just the polled one. That
 * costs nothing (the snapshots are already there — a board open in either pair contributes one) and
 * it is what lets the click below open the RIGHT board rather than assuming the selected one.
 */
export function BeadPillHost({ children }: { children: ReactNode }) {
  const byProject = useBeadsStore((s) => s.byProject);
  const project = useProjectStore((s) =>
    s.selectedProjectId === null ? null : (s.projects.find((p) => p.id === s.selectedProjectId) ?? null),
  );
  const projectId = project?.id;
  const rootPath = project?.rootPath;

  // A DEPENDENCY, NOT A READ. `startPolling` refuses to arm a timer while beads are off, and it is
  // the SETTING that changes, not this component's props — so without `beadsEnabled` in the deps
  // below, a host that mounted while `[tools].beads` was off would never re-arm when the user
  // switched it on, and every bead id would stay unresolved until some other viewer happened to
  // start polling (roborev 57672). Re-running the effect is balanced: the cleanup releases the old
  // claim before the new one is taken.
  const beadsEnabled = useSettingsStore((s) => s.beadsEnabled);

  useEffect(() => {
    if (projectId === undefined || rootPath === undefined) return;
    // "passive", NOT the default "board". This host is mounted for the whole app session (the
    // concierge always is), and a board-kind claim would leave `runDecomposeWatcherForPoll` — which
    // WRITES beads and reaches the AI gate — running permanently in the background instead of only
    // while someone is looking at a board (roborev 57655). The claim still keeps ids resolving; it
    // just does not vote for the watcher. Released with the SAME kind, or the tally drifts.
    useBeadsStore.getState().startPolling(projectId, rootPath, undefined, "passive");
    return () => useBeadsStore.getState().stopPolling(projectId, "passive");
  }, [projectId, rootPath, beadsEnabled]);

  const value = useMemo<BeadPillContextValue>(
    () => ({ beads: indexBeads(byProject), onViewOnBoard: viewOnBoard }),
    [byProject],
  );
  return <BeadPillProvider value={value}>{children}</BeadPillProvider>;
}

/**
 * Every bead in every polled project, indexed by id.
 *
 * FIRST PROJECT WINS on a collision. Bead ids carry a project prefix (`sparkle-…`, `bd-…`) so a
 * genuine collision across two repos is not reachable in practice; picking deterministically rather
 * than last-wins simply means the answer does not depend on object key order.
 */
function indexBeads(
  byProject: Record<string, { beads: Bead[] } | undefined>,
): ReadonlyMap<string, ResolvedBead> {
  const out = new Map<string, ResolvedBead>();
  for (const [projectId, snapshot] of Object.entries(byProject)) {
    for (const bead of snapshot?.beads ?? []) {
      if (!out.has(bead.id)) out.set(bead.id, { bead, projectId });
    }
  }
  return out;
}

/**
 * Open the Plan board on the bead's own side, focused on the card.
 *
 * ══ THE ORDER IS LOAD-BEARING ═══════════════════════════════════════════════════════════════════
 * `openPlanBoard` FIRST, `setBoardFocusBeadId` SECOND. The focus id is a ONE-SHOT that `BoardView`
 * consumes and clears once the bead is present; set against a board the Sparkle pane is still
 * covering, the handoff is spent on a surface that never renders and the overlay simply never opens
 * (roborev 55887, the same trap the sidebar's epic pill documents).
 *
 * `openPlanBoard`, never a bare `setWorkMode(side, "plan")` — the latter only moves the chevron and
 * leaves the board invisible, which is the identical failure by a different route.
 *
 * ══ WHICH SIDE, AND WHY IT IS DERIVED RATHER THAN PICKED ════════════════════════════════════════
 * This is the real design question in the handoff, and it is worth naming: `boardFocusBeadId` is
 * GLOBAL while its sibling `boardAgentFilterBySide` is keyed by side, and the concierge column has
 * no natural `PairSide` at all — it sits BETWEEN the two pairs and belongs to neither.
 *
 * So the side is not chosen; it is READ from where the bead's project already lives.
 * `sideOf(pairAssignment, projectId)` is total and defaults to `"right"` (the historical single-pair
 * home), so every install answers, including one that has never assigned anything. That beats a
 * hard-coded side on the case that actually matters — a two-pair cockpit, where a fixed choice
 * would open the board in the wrong half of the screen for exactly the projects the second pair
 * exists to hold.
 *
 * The bead's project is also SELECTED first. The board is per-side and shows that side's current
 * project, so focusing a bead in a project the side is not displaying would open a board that never
 * contains it — the handoff would sit unconsumed and the click would look like it did nothing.
 */
function viewOnBoard(target: { beadId: string; projectId: string }): boolean {
  const projects = useProjectStore.getState();
  // Nothing to open a board FOR. Reported rather than assumed: the caller turns `false` into a
  // sentence, which is the whole point of the boolean.
  if (!projects.projects.some((p) => p.id === target.projectId)) return false;
  projects.selectProject(target.projectId);
  const ui = useUiStore.getState();
  ui.openPlanBoard(sideOf(ui.pairAssignment, target.projectId));
  ui.setBoardFocusBeadId(target.beadId);
  return true;
}

// ── PRESENTATION ────────────────────────────────────────────────────────────────────────────────

/** The shared shape, so the pill and its card differ only where they must. Mirrors `AgentPill`'s
 *  `base` — same radius, same padding, same baseline alignment — because a bead reference and an
 *  agent reference sitting in one sentence must read as one vocabulary. */
const base: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  borderRadius: 4,
  padding: "1px 5px",
  // A pill broken across two lines stops reading as one object.
  whiteSpace: "nowrap",
  fontSize: "inherit",
  fontFamily: "inherit",
  lineHeight: "inherit",
  verticalAlign: "baseline",
};

/**
 * The status dot's colour.
 *
 * THE SAME THREE COLOURS `BoardView` ALREADY USES for a unit of work's progress — done is the teal
 * accent, running is full-strength cream, not-started is muted. Written as one function rather than
 * inline so the pill and the board it points at cannot drift apart, which is the failure
 * `MENTION_PILL_FILL` was extracted to prevent for the fill.
 */
function statusColor(status: BeadStatus): string {
  if (status === "closed") return C.teal;
  if (status === "in_progress") return C.cream;
  return C.muted;
}

/** What a reader calls the status. `in_progress` is a wire value, never words on screen. */
function statusLabel(status: BeadStatus): string {
  if (status === "closed") return "closed";
  if (status === "in_progress") return "in progress";
  return "open";
}

const dot = (status: BeadStatus): CSSProperties => ({
  flex: "0 0 auto",
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: statusColor(status),
});

/** How much description the card shows before it scrolls instead of growing.
 *
 *  THE BEAD NAMES THIS AS A REQUIREMENT — "beads carry long descriptions, so the card needs to
 *  handle that without swallowing the conversation". A bead description runs to several screens
 *  (this one does), and a card that grows to fit pushes the sentence the reader was reading off the
 *  top of the thread, which is the context switch the whole feature exists to avoid. */
const DESC_MAX_H = 180;

/** What the card says when the board could not be opened. One sentence, non-alarming, and it names
 *  the bead — a paragraph can hold several cards. Matches `AgentPill`'s `closedSentence` in shape so
 *  the app says this kind of thing one way. */
const noBoardSentence = (beadId: string) => `${beadId} is not on an open board.`;

/**
 * One bead reference.
 *
 * `beadId` is what the linkifier found (or what an explicit `sparkle-bead:` reference carried). The
 * label the author wrote is deliberately NOT used: a pill shows the id, always.
 *
 * That is the opposite of `AgentPill`, which prefers the live roster NAME over the written label,
 * and the asymmetry is deliberate rather than an oversight. An agent's name is what a human calls
 * it and the id is an internal uuid nobody reads; a bead's id is what the FOUNDER types, greps,
 * and asks other agents about — it is the readable handle, and the title is on the card one click
 * away. It also closes a small forgery seam for free: model-authored text can contain
 * `[something reassuring](sparkle-bead:sparkle-17hm1)`, and since the pill renders the id and the
 * live status rather than the label, a misleading label buys nothing.
 */
export function BeadPill({ beadId }: { beadId: string }) {
  const { beads, onViewOnBoard } = useContext(BeadPillContext);
  const [open, setOpen] = useState(false);
  // Consecutive FAILED board opens. A COUNT rather than a boolean for the reason `AgentPill`
  // documents (roborev 55590): setting `true` on an already-`true` state is an identical-value
  // update, React bails out, and the reader's retry click paints and announces nothing.
  const [misses, setMisses] = useState(0);
  const cardId = useId();
  // RE-READ EVERY RENDER — the bead's fourth requirement, and the whole of its implementation. There
  // is deliberately no `useState`/`useRef` holding a bead anywhere in this component: a bead cited
  // as open an hour ago and since closed shows CLOSED, in the pill's dot and in an already-open
  // card alike, because both read from here rather than from anything captured at click time.
  const resolved = beads.get(beadId);

  // ── IT DOES NOT RESOLVE ───────────────────────────────────────────────────────────────────────
  // Ordinary text, with no wrapper element at all. Not a muted span, not a `title` tooltip, not a
  // button that explains itself — the id was prose before this feature and it stays prose, which is
  // the bead's own requirement ("it must not linkify an id that does not exist").
  //
  // THIS IS THE COMMON CASE, not an edge one, and that is why it is written first: the linkifier
  // buys recall on purpose and hands this component every id-SHAPED token in the thread, so most of
  // what arrives here is an ordinary hyphenated word like "auto-heal" that must come out unchanged.
  if (resolved === undefined) return <>{beadId}</>;

  const { bead, projectId } = resolved;
  const showMiss = misses > 0;

  return (
    <span style={{ display: "inline" }}>
      <button
        type="button"
        data-testid="concierge-bead-pill"
        data-bead-id={bead.id}
        data-bead-status={bead.status}
        // A GENUINE DISCLOSURE — the click toggles the card open and shut and nothing is attempted —
        // so `aria-expanded` describes it correctly. (`AgentPill`'s resolved pill deliberately omits
        // it because that one is a RETRY, which can never collapse.)
        aria-expanded={open}
        aria-controls={cardId}
        title={`${bead.id} · ${bead.title || "untitled"} — ${statusLabel(bead.status)}`}
        onClick={() => setOpen((v) => !v)}
        style={{
          ...base,
          border: "none",
          cursor: "pointer",
          // The mention vocabulary's fill, from the constant rather than re-spelled. A fourth
          // hand-copied `color-mix(… teal 18% …)` is exactly the drift `MentionPill`'s header was
          // written to stop, and a shade of difference between a bead pill and an agent pill in the
          // same sentence fails no test while breaking the founder's "make mentions symmetrical" ask.
          background: MENTION_PILL_FILL,
          color: C.cream,
          // A bead id is an identifier the founder greps for, so it is set in the mono face. The
          // SIZE stays `inherit` (from `base`): an `em`-relative nudge here is off-scale sprawl, and
          // theme/scale.test.ts ratchets exactly that — there is no scale step between body and
          // small, so a pill mid-sentence takes the sentence's own size or a TYPE value, never a
          // fraction of one.
          fontFamily: FONT_MONO,
        }}
      >
        <span style={dot(bead.status)} aria-hidden />
        {bead.id}
      </button>
      {open && (
        <BeadCard
          id={cardId}
          bead={bead}
          missSentence={showMiss ? noBoardSentence(bead.id) : undefined}
          missKey={misses}
          // THE NAVIGATION RUNS IN THE HANDLER, NEVER INSIDE THE UPDATER.
          //
          // React re-invokes a state updater whenever it discards and replays a render — an
          // interrupted concurrent render, a Suspense retry, StrictMode's double-invoke — so an
          // updater that performed the jump would run `selectProject` → `openPlanBoard` →
          // `setBoardFocusBeadId` TWICE for one click. The visible cost is not a duplicated no-op:
          // the second `setBoardFocusBeadId` re-arms a ONE-SHOT that `BoardView` has already
          // consumed and cleared, so the overlay can reopen under a reader who has since closed it.
          //
          // This shipped the wrong way round and was caught in review. `AgentPill`'s click handler
          // carries the identical warning (roborev 55618), and `voice/useAutoSend` designs around
          // the same hazard — writing it a third time here because the mistake survived reading
          // both. The updater below is pure: it only folds an outcome that is already decided.
          onViewOnBoard={
            onViewOnBoard === undefined
              ? undefined
              : () => {
                  const landed = onViewOnBoard({ beadId: bead.id, projectId });
                  setMisses((n) => (landed ? 0 : n + 1));
                }
          }
        />
      )}
    </span>
  );
}

/**
 * The card, drawn IN PLACE under the pill.
 *
 * ══ EVERY ELEMENT HERE IS PHRASING CONTENT ══════════════════════════════════════════════════════
 * `<span>`, never `<div>`. This mounts inside `<Markdown>`'s `<p>`, and a `<div>` in a `<p>` is
 * invalid nesting: React emits it without complaint and the browser silently closes the paragraph
 * and reparents the node — moving the card away from the sentence that referenced it. `display:
 * block` on a span gets the layout without the invalidity (HTML validity is a question about the
 * ELEMENT, not about its CSS box), which is the same trick `AgentPill`'s `LiveNotice` uses.
 *
 * ══ IT IS A LIVE REGION, AND IT IS THE CARD ITSELF ══════════════════════════════════════════════
 * `role="status"` here rather than a separate always-mounted announcer: unlike `AgentPill`'s notice,
 * the thing that appears IS the result of the click, so there is nothing to announce separately. The
 * failure sentence is re-keyed on `missKey` so a second failed open registers as a live-region
 * update rather than an identical re-render React drops on the floor (roborev 55590).
 */
function BeadCard({
  id,
  bead,
  onViewOnBoard,
  missSentence,
  missKey,
}: {
  id: string;
  bead: Bead;
  /** Absent when the surface has no board to open. The card is still the result of the click, so
   *  this is a missing SECOND step, not a dead end. */
  onViewOnBoard?: () => void;
  missSentence?: string;
  missKey: number;
}) {
  const meta = [
    statusLabel(bead.status),
    bead.priority === undefined ? null : `P${bead.priority}`,
    bead.type ?? null,
  ].filter((v): v is string => v !== null && v !== "");
  return (
    <span
      id={id}
      role="status"
      data-testid="concierge-bead-card"
      data-bead-id={bead.id}
      style={{
        display: "block",
        margin: "6px 0",
        padding: "8px 10px",
        background: C.forest,
        border: `1px solid ${C.hairline}`,
        borderRadius: 6,
        // The card carries prose, and the pill above it is `nowrap`.
        whiteSpace: "normal",
        // A long title or an unbroken token in a description must not widen the column.
        overflowWrap: "anywhere",
      }}
    >
      <span
        data-testid="concierge-bead-card-title"
        style={{ display: "block", color: C.cream, fontWeight: 600, marginBottom: 2 }}
      >
        {bead.title || bead.id}
      </span>
      <span
        data-testid="concierge-bead-card-meta"
        style={{ display: "block", color: C.conciergeMuted, fontSize: TYPE.small, marginBottom: 6 }}
      >
        <span style={{ ...dot(bead.status), display: "inline-block", marginRight: 5 }} aria-hidden />
        {meta.join(" · ")}
      </span>
      {bead.description !== "" && (
        <span
          data-testid="concierge-bead-card-description"
          style={{
            display: "block",
            // SCROLLS RATHER THAN GROWS — see DESC_MAX_H. The founder is reading a sentence and
            // wants the referent, not a card that pushes the sentence off the screen.
            maxHeight: DESC_MAX_H,
            overflowY: "auto",
            color: C.cream,
            fontSize: TYPE.small,
            lineHeight: 1.5,
            // A bead description is written as plain text with its own line breaks (`bd` stores it
            // verbatim); rendering it as markdown would re-linkify ids inside it and nest this card
            // inside itself.
            whiteSpace: "pre-wrap",
          }}
        >
          {bead.description}
        </span>
      )}
      {onViewOnBoard !== undefined && (
        <span style={{ display: "block", marginTop: 6 }}>
          <button
            type="button"
            data-testid="concierge-bead-card-view-on-board"
            onClick={onViewOnBoard}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              border: "none",
              background: "transparent",
              padding: 0,
              cursor: "pointer",
              color: C.accentInk,
              font: "inherit",
              fontSize: TYPE.small,
              textDecoration: "underline",
            }}
          >
            <FiExternalLink size={12} aria-hidden />
            View on board
          </button>
        </span>
      )}
      {missSentence !== undefined && (
        <span
          key={missKey}
          data-testid="concierge-bead-card-notice"
          style={{ display: "block", marginTop: 4, color: C.conciergeMuted, fontSize: TYPE.small }}
        >
          {missSentence}
        </span>
      )}
    </span>
  );
}
