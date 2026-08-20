// THE bead card. One component, two chromes.
//
// ══ WHY THIS EXISTS ════════════════════════════════════════════════════════════════════════════
// A bead used to be drawn by three components that shared no code — the board's collapsed `Card`,
// the board's `DetailOverlay`, and the concierge's own card — so each showed a DIFFERENT subset of
// the same eight fields. The founder noticed it from the outside: the progress line was on the
// collapsed card, vanished when the card opened, and had never existed in the concierge at all.
// That is not three bugs, it is one missing component. His ask, verbatim: *"I want the card on the
// concierge column to look exactly like the card when it's in an open state on the actual plan
// board, with one exception: it would scroll after a certain height."*
//
// ══ EVERY ELEMENT IS PHRASING CONTENT, IN BOTH CHROMES ═════════════════════════════════════════
// `<span style={{ display: "block" }}>`, never `<div>`. The concierge chrome mounts inside
// `<Markdown>`'s `<p>`, where a `<div>` is invalid nesting: React emits it without complaint and the
// browser closes the paragraph and REPARENTS the node, moving the card away from the sentence that
// referenced it. HTML validity is a question about the ELEMENT, not about its CSS box, so
// `display: block`/`flex` on a span buys the layout without the invalidity.
//
// This is also the whole reason ONE component can serve both surfaces: phrasing content is equally
// valid inside the board's `<div>`, so the concierge's harder constraint is simply the constraint.
// `<button>` is already phrasing content, so the controls need no special handling.
//
// ══ WHAT SCROLLS, AND WHAT MUST NOT ════════════════════════════════════════════════════════════
// Only the DESCRIPTION. Everything above it — title, id, priority, the status line, and the
// View-on-board button — stays pinned outside the scroll region. This is deliberate and follows
// bead `sparkle-qogah`'s rule that a row needing action is never hidden: a card whose whole body
// scrolled would take the priority control and the way out of the card with it.
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { FiExternalLink, FiMessageSquare, FiUsers, FiX } from "react-icons/fi";
import { C, FONT_WEIGHT, ON_BRAND_FILL } from "../../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS, TYPE } from "../../theme/scale";
import { severityOf, type Bead } from "../../services/beads";
import type { BeadComment } from "../../services/beadsCommands";
import type { WorkflowStageId } from "../../engine/workflowStage";
import { PriorityPill } from "./PriorityPill";
import { BeadSeverityBadge } from "./BeadSeverityBadge";
import { CommentThread } from "./CommentThread";
import { StageLine } from "./StageLine";
import { statusDot, statusLabel } from "./beadStatus";

/**
 * Which surface is drawing the card.
 *
 * It governs the SHELL only — surface colour, padding, the testid prefix, and whether the card
 * announces itself as a live region. Type sizes, field order and every control are identical, which
 * is the founder's ask; a `chrome` that could change what is SHOWN would be the drift this
 * component was written to end.
 */
export type BeadCardChrome = "board" | "concierge" | "epics";

interface ChromeSpec {
  testId: string;
  surface: string;
  padding: string;
  /** The concierge card IS the result of clicking a pill, so it announces itself. The board's is
   *  a panel the user navigated into and has nothing to announce. */
  role?: "status";
}

const CHROME: Record<BeadCardChrome, ChromeSpec> = {
  board: { testId: "board-bead-card", surface: C.dialogSurface, padding: "16px 18px" },
  concierge: { testId: "concierge-bead-card", surface: C.forest, padding: "10px 12px", role: "status" },
  // THE EPICS COLUMN'S INLINE CARD. Same fields and same controls as the other two — a `chrome`
  // that changed WHAT is shown would be the drift this component exists to end — differing only in
  // the box: the column is ~280px, so it takes the concierge's tighter padding rather than the
  // board panel's, and `epicCardFill` so the open card reads as the selected row's continuation
  // rather than as a foreign panel dropped into the ladder.
  //
  // `role: "status"` for the same reason the concierge has it: this card IS the result of clicking
  // the row above it, so it announces itself instead of appearing silently mid-list.
  epics: { testId: "epics-bead-card", surface: C.epicCardFill, padding: "10px 12px", role: "status" },
};

export interface BeadCardProps {
  bead: Bead;
  chrome: BeadCardChrome;
  /** The unified Think→Plan→Build stage — `beadStage(status, delivered, workerStages)`. */
  stage: WorkflowStageId;
  /** Names of the workers bound to this bead. Empty renders no row. */
  workers: string[];
  /** The DOM id, so a disclosure trigger can point `aria-controls` at the card. */
  id?: string;
  /** Set only when the bead lives OUTSIDE the reader's selected project. */
  projectName?: string;
  /** Cap the description's height and scroll it instead of growing. Unset means "grow to fit",
   *  which is right for a card that already sits in its own scrolling panel. */
  descMaxHeight?: number;
  /**
   * EVERY OPTIONAL CALLBACK IS ALSO THE SWITCH FOR ITS AFFORDANCE. An absent one renders no
   * control at all, which preserves the property the concierge already had: a surface with no
   * board behind it (a support modal, an agent reply, a test fixture) shows a READ-ONLY card
   * rather than buttons that cannot work.
   */
  onViewOnBoard?: () => void;
  /**
   * Start a concierge chat that already references this bead (bead sparkle-1cpomd). The founder
   * asked for it on EVERY bead card, task or epic — which is why it needs no branching here:
   * nothing in this component keys on `bead.type`, so "task or epic" is already the default.
   *
   * ITS ABSENCE IS THE HIDING MECHANISM, per this block's rule above, and one caller depends on
   * that rather than on any window check: the SATELLITE window mounts no `ConciergeHost` and no
   * composer anywhere in its tree, so a Chat button there would `set()` a draft into a store with
   * no reader and it would be silently DROPPED. `satellite/SatelliteApp.tsx` therefore passes
   * nothing to `BoardView`, and the callback-is-the-switch convention removes the button for free —
   * no window-detection global, and nothing for a future surface to forget to consult.
   * (`windowContext.useIsMainWindow` could not have done it: it is hard-coded `true`.)
   */
  onChat?: () => void;
  onSetPriority?: (priority: number) => Promise<void>;
  onClose?: () => void;
  onBuildIt?: () => Promise<void>;
  onBuildAllPrd?: () => Promise<void>;
  /** How many epics share this bead's PRD. The batch button appears only above 1. */
  prdEpicCount?: number;
  /** The bead's comment thread, read LAZILY by the caller when the card opens (never on the board's
   *  5s poll). `undefined` renders no thread — the concierge and any read-only surface that has not
   *  fetched comments simply omit the section, exactly like every other absent affordance here. An
   *  empty array renders the thread frame with its "no comments yet" state. */
  comments?: BeadComment[];
  /** Post a comment. Like every other callback here, its PRESENCE is the switch for the compose box:
   *  a surface that cannot write (no project path) passes nothing and shows a read-only thread. */
  onComment?: (text: string) => Promise<void>;
  /** A sentence the caller wants under the controls — today, "that board could not be opened". */
  notice?: string;
  /** Bumped by the caller so a REPEAT of the same notice re-registers as a live-region update
   *  rather than an identical re-render React drops on the floor. */
  noticeKey?: number;
}

/** A block-level span. Written once so no call site below can reach for a `<div>` by reflex. */
const block = (extra: CSSProperties = {}): CSSProperties => ({ display: "block", ...extra });

const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };

/** A metadata line — a faint field name followed by its value. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span style={{ display: "flex", gap: 8, fontSize: TYPE.small, lineHeight: 1.4 }}>
      <span style={{ color: C.muted, flex: "0 0 auto", minWidth: 62 }}>{label}</span>
      <span style={{ color: C.cream, minWidth: 0, overflowWrap: "anywhere" }}>{children}</span>
    </span>
  );
}

export function BeadCard({
  bead,
  chrome,
  stage,
  workers,
  id,
  projectName,
  descMaxHeight,
  onViewOnBoard,
  onChat,
  onSetPriority,
  onClose,
  onBuildIt,
  onBuildAllPrd,
  prdEpicCount,
  comments,
  onComment,
  notice,
  noticeKey,
}: BeadCardProps) {
  const spec = CHROME[chrome];
  const t = spec.testId;

  // ── THE PRIORITY WRITE ────────────────────────────────────────────────────────────────────────
  //
  // ══ THE OPTIMISTIC VALUE LIVES HERE, NEVER IN `beadsStore` ══════════════════════════════════
  // That store replaces its whole snapshot on every 5-second poll, so an optimistic priority
  // written into it would be clobbered by the next tick — reverting under the reader's eyes for no
  // reason they could see. Held in component state it survives until the poll delivers the truth,
  // and the effect below retires it the moment `bead.priority` agrees.
  const [optimistic, setOptimistic] = useState<number | null>(null);
  // ══ TWO BUSY FLAGS, NOT ONE ═══════════════════════════════════════════════════════════════════
  // One shared flag made a PRIORITY save relabel the primary action to "Building…" and disable it —
  // telling the reader a build had started when none had. On the board that is a straight
  // regression: `DetailOverlay` had a `buildBusy` only the build handlers touched. A single `err`
  // slot is still right (one control is in flight at a time, and the sentence names its own cause).
  const [priorityBusy, setPriorityBusy] = useState(false);
  const [buildBusy, setBuildBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (optimistic !== null && bead.priority === optimistic) setOptimistic(null);
  }, [bead.priority, optimistic]);

  async function pickPriority(p: number) {
    if (onSetPriority === undefined || priorityBusy) return;
    const previous = optimistic;
    setErr("");
    setOptimistic(p);
    setPriorityBusy(true);
    try {
      await onSetPriority(p);
      // Deliberately NOT clearing `optimistic` here. The write landed in `bd`, but this app's view
      // of `bd` is a poll — up to five seconds behind — so clearing now would snap the pill back to
      // the OLD value and then forward again. The effect above clears it when the truth arrives.
    } catch (e) {
      // ROLL BACK. The pill is the only thing that moved, so the only honest thing to show is the
      // value the bead still has, next to a sentence saying why it did not change.
      setOptimistic(previous);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setPriorityBusy(false);
    }
  }

  async function runBuild(fn: () => Promise<void>) {
    if (buildBusy) return;
    setErr("");
    setBuildBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBuildBusy(false);
    }
  }

  const shownPriority = optimistic ?? bead.priority;
  const meta: ReactNode[] = [];
  meta.push(
    <span key="status" style={{ ...rowStyle, gap: 5 }}>
      <span style={{ ...statusDot(bead.status), display: "inline-block" }} aria-hidden />
      {statusLabel(bead.status)}
    </span>,
  );
  if (onSetPriority !== undefined) {
    meta.push(
      <PriorityPill
        key="priority"
        testId={`${t}-priority`}
        priority={shownPriority}
        disabled={priorityBusy}
        onChange={(p) => void pickPriority(p)}
      />,
    );
  } else if (shownPriority !== undefined) {
    // READ-ONLY, and it must still SAY the priority. A surface with no project path cannot write,
    // but the number is the single most decision-relevant field on the card.
    meta.push(
      <span key="priority" data-testid={`${t}-priority-readonly`}>{`P${shownPriority}`}</span>,
    );
  }
  // SEVERITY — a distinct axis beside priority (the founder asked for both visible), read from the
  // `sev-<N>` label. Renders nothing when the bead carries no score, so it adds a meta item only when
  // there is one to show; `severityOf` returns null otherwise.
  const severity = severityOf(bead);
  if (severity !== null) {
    meta.push(<BeadSeverityBadge key="severity" severity={severity} testId={`${t}-severity`} />);
  }
  if (bead.type) meta.push(<span key="type">{bead.type}</span>);
  // LAST, and only when the bead is somewhere else. "View on board" calls `selectProject`, so this
  // is the line that turns a silent whole-project jump into a choice.
  if (projectName !== undefined && projectName !== "") {
    meta.push(<span key="project">{`in ${projectName}`}</span>);
  }

  // The batch is offered only when there is a batch: one epic sharing a PRD with itself is not one.
  // Narrowed to a callback rather than to a boolean so the JSX below needs no non-null assertion.
  const buildAllPrd = (prdEpicCount ?? 0) > 1 ? onBuildAllPrd : undefined;

  return (
    <span
      id={id}
      role={spec.role}
      data-testid={t}
      data-bead-id={bead.id}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        margin: chrome === "concierge" ? "6px 0" : undefined,
        padding: spec.padding,
        background: spec.surface,
        border: `1px solid ${C.hairline}`,
        borderRadius: RADIUS.modal,
        fontFamily: FONT_UI,
        // The card carries prose, and a pill it may sit beside is `nowrap`.
        whiteSpace: "normal",
        // Bead titles carry paths, branch names and identifiers with no break opportunity at all.
        overflowWrap: "anywhere",
      }}
    >
      {/* ── TITLE ROW ──────────────────────────────────────────────────────────────────────── */}
      <span style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <span
          data-testid={`${t}-title`}
          style={{
            flex: 1,
            minWidth: 0,
            color: C.cream,
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: TYPE.title,
            lineHeight: 1.3,
          }}
        >
          {bead.title || bead.id}
        </span>
        {onChat !== undefined && (
          // ══ THE BLUE IS BUILD IT'S BLUE, THE METRICS ARE THE TITLE ROW'S ═════════════════════
          // `C.teal` / `ON_BRAND_FILL` / `border: none` / `RADIUS.modal` are lifted verbatim from
          // the Build It button below, because the founder asked for "the same blue as Build It"
          // and a second near-teal would read as a different kind of action. Everything else is
          // this ROW's scale — the compact padding and `TYPE.small` its two neighbours use — so it
          // reads as a corner control rather than a second call-to-action shouting over the title.
          //
          // NO POSITIONING. The title span beside it is `flex: 1`, so `flex: "0 0 auto"` is the
          // whole layout: the title takes the slack and this lands top-right. Absolute positioning
          // here would overlap a wrapped title, which is the common case (bead titles are
          // sentences).
          //
          // NOT GATED ON `buildBusy`. That flag exists because ONE shared flag made a priority save
          // relabel the primary action to "Building…" (see the two-busy-flags note above); handing
          // a draft to the composer is synchronous and starts nothing, so it has no busy state of
          // its own to add and no business reading anyone else's.
          <button
            type="button"
            data-testid={`${t}-chat`}
            onClick={onChat}
            title="Chat with Sparkle about this bead — starts a message that references it"
            style={{
              flex: "0 0 auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: C.teal,
              color: ON_BRAND_FILL,
              border: "none",
              borderRadius: RADIUS.modal,
              cursor: "pointer",
              padding: "2px 8px",
              fontFamily: FONT_UI,
              fontSize: TYPE.small,
              lineHeight: 1.4,
            }}
          >
            <FiMessageSquare size={12} aria-hidden />
            Chat
          </button>
        )}
        {onViewOnBoard !== undefined && (
          // A BUTTON, not a fake link. It was an underlined `accentInk` run — which reads as
          // navigation to somewhere else on the page and is the founder's item 3. It performs an
          // action inside the app, so it is drawn as the control it is.
          <button
            type="button"
            data-testid={`${t}-view-on-board`}
            onClick={onViewOnBoard}
            title="Open the Plan board focused on this card"
            style={{
              flex: "0 0 auto",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              background: "transparent",
              border: `1px solid ${C.hairline}`,
              borderRadius: RADIUS.input,
              color: C.accentInk,
              cursor: "pointer",
              padding: "2px 8px",
              fontFamily: FONT_UI,
              fontSize: TYPE.small,
              lineHeight: 1.4,
            }}
          >
            <FiExternalLink size={12} aria-hidden />
            View on board
          </button>
        )}
        {onClose !== undefined && (
          <button
            type="button"
            data-testid={`${t}-close`}
            aria-label="Close"
            title="Close"
            onClick={onClose}
            style={{
              flex: "0 0 auto",
              display: "inline-flex",
              alignItems: "center",
              background: "transparent",
              border: `1px solid ${C.hairline}`,
              borderRadius: RADIUS.input,
              color: C.muted,
              cursor: "pointer",
              padding: "2px 8px",
              fontFamily: FONT_UI,
              fontSize: TYPE.small,
              lineHeight: 1.4,
            }}
          >
            <FiX size={13} aria-hidden />
          </button>
        )}
      </span>

      {/* ── THE ID ─────────────────────────────────────────────────────────────────────────────
          Mono, because a bead id is what the founder types, greps and asks other agents about. The
          concierge card had no id line at all, which made it the one surface where the handle you
          would quote was missing. */}
      <span
        data-testid={`${t}-id`}
        style={block({
          color: C.muted,
          opacity: 0.8,
          fontSize: TYPE.small,
          fontFamily: FONT_MONO,
        })}
      >
        {bead.id}
      </span>

      {/* ── META ─────────────────────────────────────────────────────────────────────────────── */}
      <span
        data-testid={`${t}-meta`}
        style={{ ...rowStyle, color: C.conciergeMuted, fontSize: TYPE.small }}
      >
        {meta.map((node, i) => (
          // A separator BETWEEN items rather than after each: the priority pill is a bordered
          // control, and a trailing interpunct beside it reads as a broken sentence.
          <span key={i} style={{ ...rowStyle, gap: 8 }}>
            {i > 0 && <span aria-hidden style={{ opacity: 0.6 }}>·</span>}
            {node}
          </span>
        ))}
      </span>

      {/* ── THE STATUS LINE — THE POINT OF THE WHOLE COMPONENT ────────────────────────────────
          The founder screenshotted this on the CLOSED board card and asked why it disappears when
          the card opens. It is the answer to "how far along is this?", and it now sits on every
          surface that draws a bead. */}
      <StageLine stage={stage} height={3} testId={`${t}-stage`} />

      {/* ── DESCRIPTION — THE ONLY THING THAT SCROLLS ────────────────────────────────────────── */}
      {bead.description !== "" && (
        <span
          data-testid={`${t}-description`}
          style={block({
            ...(descMaxHeight === undefined
              ? {}
              : { maxHeight: descMaxHeight, overflowY: "auto" as const }),
            color: C.cream,
            fontSize: TYPE.small,
            lineHeight: 1.5,
            // A bead description is plain text with its own line breaks (`bd` stores it verbatim);
            // rendering it as markdown would re-linkify the ids inside it and nest this card in
            // itself.
            whiteSpace: "pre-wrap",
          })}
        >
          {bead.description}
        </span>
      )}

      {/* ── THE REMAINING FIELDS — all three were missing from the concierge card ────────────── */}
      {bead.labels.length > 0 && (
        <Field label="Labels">
          <span data-testid={`${t}-labels`}>{bead.labels.join(", ")}</span>
        </Field>
      )}
      {bead.parent && (
        <Field label="Epic">
          <span data-testid={`${t}-parent`} style={{ fontFamily: FONT_MONO }}>
            {bead.parent}
          </span>
        </Field>
      )}
      {workers.length > 0 && (
        <Field label="Workers">
          <span data-testid={`${t}-workers`} style={{ color: C.tealInk }}>
            <FiUsers size={11} style={{ verticalAlign: "-2px", marginRight: 4 }} aria-hidden />
            {workers.join(", ")}
          </span>
        </Field>
      )}

      {/* ── BUILD ────────────────────────────────────────────────────────────────────────────── */}
      {(onBuildIt !== undefined || buildAllPrd !== undefined) && (
        <span style={rowStyle}>
          {onBuildIt !== undefined && (
            <button
              type="button"
              data-testid={`${t}-build-it`}
              onClick={() => void runBuild(onBuildIt)}
              disabled={buildBusy}
              title="Build It — claim this unit of work and hand it to the Build orchestrator"
              style={{
                background: C.teal,
                color: ON_BRAND_FILL,
                border: "none",
                borderRadius: RADIUS.modal,
                padding: "5px 14px",
                fontSize: TYPE.small,
                fontWeight: FONT_WEIGHT.semibold,
                cursor: buildBusy ? "default" : "pointer",
                opacity: buildBusy ? 0.7 : 1,
                fontFamily: FONT_UI,
              }}
            >
              {buildBusy ? "Building…" : "Build It"}
            </button>
          )}
          {buildAllPrd !== undefined && (
            <button
              type="button"
              data-testid={`${t}-build-all-prd`}
              onClick={() => void runBuild(buildAllPrd)}
              disabled={buildBusy}
              title={`Claim and build all ${prdEpicCount} epics that share this PRD`}
              style={{
                background: "transparent",
                color: C.tealInk,
                border: `1px solid ${C.teal}`,
                borderRadius: RADIUS.modal,
                padding: "5px 14px",
                fontSize: TYPE.small,
                fontWeight: FONT_WEIGHT.semibold,
                cursor: buildBusy ? "default" : "pointer",
                opacity: buildBusy ? 0.7 : 1,
                fontFamily: FONT_UI,
              }}
            >
              {`Build all ${prdEpicCount} epics in this PRD`}
            </button>
          )}
        </span>
      )}

      {/* ── COMMENT THREAD + COMPOSE ─────────────────────────────────────────────────────────────
          The point of the whole feature: humans (and agents) comment on a bead instead of filing a
          near-duplicate. Rendered only when the caller wired EITHER a thread to show or a way to
          write — a bare read-only surface (a test fixture, a board with no project path) omits it.
          Comments are read lazily by the caller on open; nothing here fetches on the 5s poll. */}
      {(comments !== undefined || onComment !== undefined) && (
        <CommentThread
          testId={`${t}-comments`}
          comments={comments}
          onComment={onComment}
        />
      )}

      {/* THE ERROR SITS BESIDE THE CONTROLS, not in a toast — this app has no toast system, and the
          universal pattern is a local `err` next to the thing that failed. */}
      {err !== "" && (
        <span
          data-testid={`${t}-error`}
          role="alert"
          style={block({ color: C.dangerInk, fontSize: TYPE.small })}
        >
          {err}
        </span>
      )}
      {notice !== undefined && (
        <span
          key={noticeKey}
          data-testid={`${t}-notice`}
          style={block({ color: C.conciergeMuted, fontSize: TYPE.small })}
        >
          {notice}
        </span>
      )}
    </span>
  );
}
