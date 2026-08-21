// EpicGoalRow — the epic's goal, ON the epic's row. The visible half of bead `sparkle-wab4lm`.
//
// ── THE TWO THINGS THE FOUNDER ACTUALLY ASKED FOR ─────────────────────────────────────────────
//
//   1. AN AUTO-WRITTEN GOAL MUST BE VISIBLY DISTINGUISHABLE FROM ONE HE WROTE. `source === "auto"`
//      paints a badge; `source === "human"` paints NOTHING. The asymmetry is the design, not an
//      omission: his own words are the default reading of the field, and a badge on them would be
//      noise on every row he has ever touched — which is exactly how a provenance mark stops being
//      read at all. So the mark appears only where it carries information.
//   2. THE EPIC GOAL MUST NOT LOOK ACHIEVED BECAUSE THE HARD PARTS WERE DROPPED. `engine/
//      epicGoalRollup` already refuses to let that happen to `readyToClose` — it counts BEADS, so
//      retiring an agent cannot move it. This row is the other half of that promise: it SHOWS the
//      dropped and stranded counts in warning ink rather than quietly reporting "3 of 7 done" and
//      letting the reader assume the other four are in flight.
//
// ── WHY THE EDITOR IS PORTALED, AND THE ROW ITSELF IS ALL <span> ──────────────────────────────
//
// This mounts INSIDE `EpicsColumn`'s `EpicRow`, which is a `<button>` — see that component. Two
// consequences follow and neither is stylistic:
//
//   • NOTHING HERE MAY BE A `<button>` OR AN INPUT IN THE NORMAL FLOW. A form control inside a
//     `<button>` is not merely an invalid content model — the button swallows the activation, so a
//     textarea rendered there is unreachable with a mouse in a real browser while looking perfectly
//     fine in jsdom. That is a feature that ships 100% broken with a green suite. The collapsed row
//     is therefore built from `<span role="button">`, the same accommodation `BeadCard/
//     PriorityPill` makes for rendering inside `<Markdown>`'s `<p>`.
//   • THE TEXTAREA IS PORTALED TO `document.body`, positioned over the row. That escapes the
//     button, and it also escapes the 280px column's clipping and stacking context — the exact two
//     reasons `PriorityPill` portals its menu.
//
// The portal etiquette is carried across from `PriorityPill` where it applies, with ONE deliberate
// divergence, called out here because it looks like a missing case:
//
//   • ESCAPE WITH CABLE ETIQUETTE — bail on `e.defaultPrevented`, then `preventDefault()`. One
//     press peels this editor and leaves whatever is behind it open.
//   • `data-circuit` + `data-dismissible-open="true"` on the portaled layers, because the cable's
//     probes walk the DOM and cannot reach a body-level portal from the row it belongs to.
//   • SCROLL AND RESIZE REPOSITION; THEY DO NOT DISMISS. `PriorityPill` closes its menu on scroll
//     because re-picking a priority costs nothing. Throwing away half a typed sentence because the
//     column moved under it is hostile, so this recomputes the anchor instead.
import { FiZap } from "react-icons/fi";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { C } from "../theme/colors";
import { FONT_UI, RADIUS, SPACE, TYPE } from "../theme/scale";
import {
  epicGoalTextRejection,
  hasEpicGoalText,
  type EpicGoal,
  type EpicGoalSource,
} from "../engine/epicGoal";
import { rollUpEpicGoal, type EpicGoalRollup } from "../engine/epicGoalRollup";
import { agentsForEpicSlices } from "../services/epicLadder";
import { childrenOf, type Bead } from "../services/beads";
import { useBeadsStore } from "../stores/beadsStore";
import { useProjectStore } from "../stores/projectStore";
import { log } from "../logger";
import {
  epicGoalGenDeps,
  requestEpicGoal,
  type EpicGoalGenOutcome,
} from "../services/epicGoalGen";

/** The editor paints above the column and its seam; both live well below the modal tier. */
const BACKDROP_Z = 60;
const EDITOR_Z = 61;

/** The goal text, normalised the way `newEpicGoal` normalises it, so an edit that changes only
 *  whitespace is recognised as a no-op instead of costing a write and a poll round-trip. */
function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * One epic's goal: read it, edit it in place, and see how far the slices under it have got.
 *
 * PURE — no store, no clock, no bead lookups. `rollup` arrives already computed (see
 * {@link EpicGoalRowForEpic}) so every branch below is reachable from a test at a chosen instant.
 */
export function EpicGoalRow({
  projectId,
  epicId,
  goal,
  rollup,
  onSetGoal,
  onGenerate,
}: {
  projectId: string;
  epicId: string;
  goal: EpicGoal | undefined;
  /** Omitted when the caller has no snapshot to roll up — the goal still reads and edits. */
  rollup?: EpicGoalRollup;
  /**
   * Write the goal. `source` is an AUTHORITY statement, not a label — see `projectStore.setEpicGoal`
   * — and every call from this component passes `"human"`, because every edit here IS a person
   * typing. That stamps the permanent latch that stops the machine ever overwriting his wording.
   */
  onSetGoal: (text: string, source: EpicGoalSource) => void | Promise<void>;
  /** Offered ONLY beside a recorded generation failure. Absent means no retry affordance. */
  onGenerate?: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // THE OPTIMISTIC VALUE, on the `BeadCard.pickPriority` pattern: the store write lands immediately
  // but the epic goal is read back through a poll-shaped path, so clearing this on success would
  // snap the row back to the old text and forward again. The effect below clears it when the truth
  // catches up; a failed write rolls it back.
  const [optimistic, setOptimistic] = useState<string | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number; width: number } | null>(null);

  const storedText = hasEpicGoalText(goal) ? goal.text : "";
  const shown = optimistic ?? storedText;

  useEffect(() => {
    if (optimistic !== null && storedText === optimistic) setOptimistic(null);
  }, [optimistic, storedText]);

  const measure = useCallback(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    setAnchor(r ? { top: r.top, left: r.left, width: r.width } : null);
  }, []);

  const openEditor = useCallback(() => {
    if (busy) return;
    measure();
    setDraft(shown);
    setErr("");
    setEditing(true);
  }, [busy, measure, shown]);

  const cancel = useCallback(() => {
    // RESTORES BY DISCARDING. `draft` is the only thing an edit ever changed, so dropping it is the
    // whole of the restore — and nothing is written, which is what the Escape test asserts.
    setEditing(false);
    setDraft("");
    setErr("");
  }, []);

  const commit = useCallback(
    async (next: string) => {
      const rejection = epicGoalTextRejection(next);
      if (rejection !== null) {
        // REFUSED, AND THE EDITOR STAYS OPEN. Closing it here would discard what he typed while
        // telling him why it was no good, which is the worst of both — he loses the text AND has to
        // retype it to act on the reason.
        setErr(`not saved — ${rejection}`);
        return;
      }
      const normalized = normalize(next);
      if (normalized === shown) {
        setEditing(false);
        setErr("");
        return;
      }
      const previous = optimistic;
      setErr("");
      setOptimistic(normalized);
      setEditing(false);
      setBusy(true);
      try {
        await onSetGoal(normalized, "human");
      } catch (e) {
        // ROLL BACK to what the epic still says, next to a sentence naming why it did not change.
        setOptimistic(previous);
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [onSetGoal, optimistic, shown],
  );

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      // CABLE ETIQUETTE, both halves: honour a prior consumer, then consume, so one press peels
      // this editor only.
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      cancel();
    };
    // REPOSITION, never dismiss — see this file's header.
    const onMove = () => measure();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [cancel, editing, measure]);

  // Every clickable thing here sits inside `EpicRow`'s <button>, whose onClick selects the epic and
  // narrows the build column beside it. A click meant for the goal must not also do that.
  const swallow = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const activate = (run: () => void) => ({
    role: "button" as const,
    tabIndex: 0,
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      run();
    },
    onMouseDown: swallow,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      run();
    },
  });

  const atRisk = (rollup?.dropped ?? 0) + (rollup?.stranded ?? 0);
  const atRiskTitles = (rollup?.slices ?? [])
    .filter((s) => s.state === "dropped" || s.state === "stranded")
    .map((s) => `${s.state}: ${s.title}`)
    .join("\n");

  return (
    <span
      data-testid="epic-goal-row"
      data-project-id={projectId}
      data-epic-id={epicId}
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 5,
        flex: "1 1 auto",
        minWidth: 0,
        fontFamily: FONT_UI,
        fontSize: TYPE.micro,
      }}
    >
      <span ref={anchorRef} style={{ display: "flex", minWidth: 0, flex: "1 1 auto" }}>
        {shown !== "" ? (
          <span
            data-testid="epic-goal"
            data-goal-source={goal?.source}
            // The full text as a tooltip, because one line in a 280px column is always a truncation.
            title={`${shown}\n\nClick to edit this epic's goal`}
            {...activate(openEditor)}
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: C.muted,
              cursor: busy ? "default" : "text",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {shown}
          </span>
        ) : (
          <span
            data-testid="epic-goal-empty"
            title="This epic has no goal yet — click to write one"
            {...activate(openEditor)}
            style={{
              color: C.muted,
              cursor: "text",
              fontStyle: "italic",
              opacity: 0.8,
              whiteSpace: "nowrap",
            }}
          >
            Set a goal
          </span>
        )}
      </span>

      {/* PROVENANCE. `auto` only — and suppressed the moment an optimistic human edit is on screen,
          because at that instant the text being read is HIS, whatever the store still says. */}
      {goal?.source === "auto" && optimistic === null && shown !== "" && (
        <span
          data-testid="epic-goal-auto"
          title="Sparkle wrote this goal. Edit it and it becomes yours — after that, Sparkle never rewrites it."
          style={{
            flex: "0 0 auto",
            color: C.muted,
            border: `1px solid ${C.hairline}`,
            borderRadius: RADIUS.sm,
            padding: "0 3px",
            opacity: 0.85,
          }}
        >
          <FiZap aria-hidden size={9} style={{ verticalAlign: "-1px" }} /> auto
        </span>
      )}

      {/* A RECORDED FAILURE IS NOT AN UNTRIED ONE. Quiet, one line, and never a placeholder goal —
          an empty field is honest and an invented objective is worse than nothing. */}
      {shown === "" && goal?.generationFailedAt !== undefined && (
        <>
          <span
            data-testid="epic-goal-failure"
            title={goal.generationFailureReason ?? "goal generation failed"}
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: C.muted,
              opacity: 0.8,
            }}
          >
            {goal.generationFailureReason ?? "generation failed"}
          </span>
          {onGenerate !== undefined && (
            <span
              data-testid="epic-goal-generate"
              title="Try generating a goal for this epic again"
              {...activate(() => void onGenerate())}
              style={{ flex: "0 0 auto", color: C.tealInk, cursor: "pointer" }}
            >
              Generate
            </span>
          )}
        </>
      )}

      {rollup !== undefined && (
        <span
          data-testid="epic-goal-ladder"
          style={{ flex: "0 0 auto", color: C.muted }}
        >{`${rollup.done} of ${rollup.slices.length} slices done`}</span>
      )}

      {/* THE FOUNDER'S MOST-CARED-ABOUT FAILURE MODE, MADE VISIBLE. Dropped and stranded slices are
          the two ways an epic quietly stops being worked while still counting as "open", so they are
          never folded into the plain count above. Warning ink, and the titles are in the tooltip —
          a number with no names is not actionable. */}
      {rollup !== undefined && atRisk > 0 && (
        <span
          data-testid="epic-goal-at-risk"
          title={atRiskTitles}
          style={{ flex: "0 0 auto", color: C.amberInk }}
        >{`${atRisk} at risk`}</span>
      )}

      {/* A NOTICE, NEVER AN ACTION. Nothing here closes anything — see `rollUpEpicGoal`. */}
      {rollup?.readyToClose === true && (
        <span
          data-testid="epic-goal-ready"
          title="Every slice under this epic is closed. Closing the epic is still yours to do."
          style={{ flex: "0 0 auto", color: C.successInk }}
        >
          ready to close
        </span>
      )}

      {err !== "" && !editing && (
        <span
          data-testid="epic-goal-error"
          title={err}
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: C.dangerInk,
          }}
        >
          {err}
        </span>
      )}

      {editing &&
        createPortal(
          <>
            <div
              data-testid="epic-goal-editor-backdrop"
              // PART OF THE LIVE CIRCUIT. Portaled to `document.body`, so the cable's ancestry walk
              // cannot reach it from the row it belongs to.
              data-circuit
              // The backdrop does NOT commit on click. The textarea's own blur does that, and it
              // fires first — committing here as well would run the write twice.
              onMouseDown={swallow}
              onClick={swallow}
              style={{ position: "fixed", inset: 0, zIndex: BACKDROP_Z }}
            />
            <div
              data-testid="epic-goal-editor"
              data-circuit
              // While the editor is up it owns Escape. Without this marker the cable's DOM probe
              // finds nothing dismissible, so the press that cancels the edit also unbinds the
              // concierge.
              data-dismissible-open="true"
              onMouseDown={swallow}
              onClick={swallow}
              style={{
                position: "fixed",
                top: anchor?.top ?? 8,
                left: anchor?.left ?? 8,
                width: Math.max(anchor?.width ?? 0, 240),
                zIndex: EDITOR_Z,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              <textarea
                data-testid="epic-goal-input"
                autoFocus
                rows={2}
                value={draft}
                placeholder="What does finishing this epic mean?"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    // Enter SAVES; Shift+Enter is a newline, which the store normalises away but
                    // which people type while thinking.
                    e.preventDefault();
                    e.stopPropagation();
                    void commit(e.currentTarget.value);
                    return;
                  }
                  // Escape is handled by the window listener above (cable etiquette lives there, and
                  // it must fire whether or not the textarea still holds focus). Stop it here so the
                  // keystroke does not also reach `EpicRow`'s button.
                  e.stopPropagation();
                }}
                onBlur={(e) => void commit(e.target.value)}
                style={{
                  width: "100%",
                  resize: "vertical",
                  // The FIELD tokens, not the shell's — `modalChrome`'s ratchet counts styles that
                  // borrow `deepForest`/`hairline` for an input surface, and it is a ceiling that
                  // only ever goes down.
                  background: C.inputSurface,
                  border: `1px solid ${C.inputEdge}`,
                  borderRadius: RADIUS.input,
                  color: C.cream,
                  fontFamily: FONT_UI,
                  fontSize: TYPE.small,
                  padding: `${SPACE.xs}px ${SPACE.sm}px`,
                }}
              />
              {err !== "" && (
                <span
                  data-testid="epic-goal-error"
                  style={{ color: C.dangerInk, fontFamily: FONT_UI, fontSize: TYPE.micro }}
                >
                  {err}
                </span>
              )}
            </div>
          </>,
          document.body,
        )}
    </span>
  );
}

/**
 * Which project's snapshot IS this bead array?
 *
 * IDENTITY, not a search. `EpicsColumn` hands its rows the very array it read out of
 * `beadsStore.byProject[id].beads`, so the owning project is found by comparing references across
 * the handful of open projects — no scan of the store's thousands of beads, and no guess.
 *
 * The obvious alternative, `selectedProjectId`, is WRONG here and not merely slower: the left and
 * right pairs can show different projects at once, so a row in the left column would write its goal
 * onto whatever the right column happens to have selected. Returning `null` when nothing matches is
 * the fail-closed half of that — a goal written to the wrong project is worse than one not written.
 */
function projectIdForBeads(
  byProject: Record<string, { beads: Bead[] } | undefined>,
  beads: readonly Bead[],
): string | null {
  for (const [id, snapshot] of Object.entries(byProject)) {
    if (snapshot !== undefined && snapshot.beads === beads) return id;
  }
  return null;
}

/**
 * {@link EpicGoalRow} wired to the stores, so mounting it costs ONE line in `EpicsColumn`.
 *
 * That matters beyond tidiness: `EpicsColumn.tsx` is being rewritten in parallel by another branch,
 * and every extra line here is a merge conflict there. `EpicRow` has no `projectId` to hand down,
 * so this resolves it from the bead array it already receives — see {@link projectIdForBeads}.
 */
/** What to put on the card for each outcome, or `null` for the two that write their own record.
 *
 *  ⚠️ TOTAL, NOT `Partial` (roborev 65880). The whole point of reading the outcome is that the
 *  three non-writing ones must SAY something — a button that quietly does nothing is worse than one
 *  that refuses. Under `Partial`, adding a sixth outcome that writes nothing would compile
 *  unchanged, yield `undefined` here, and restore the silent no-op for exactly that state: the
 *  defect this map exists to remove, reintroduced invisibly. A total `Record` makes a new outcome a
 *  COMPILE ERROR, which is the only enforcement that survives someone editing the union.
 *
 *  `generated` and `failed` are `null` deliberately: the generator has already written the goal or
 *  a real failure reason, and writing over it here would replace either with something generic. */
const GENERATE_OUTCOME_COPY: Record<EpicGoalGenOutcome, string | null> = {
  generated: null,
  failed: null,
  "ai-off": "AI features are switched off, so no goal was written",
  "in-flight": "a goal is already being written for this epic",
  latched: "this goal was written by hand, so it was not overwritten",
};

export function EpicGoalRowForEpic({ epicId, beads }: { epicId: string; beads: readonly Bead[] }) {
  const byProject = useBeadsStore((s) => s.byProject);
  const projects = useProjectStore((s) => s.projects);
  const setEpicGoal = useProjectStore((s) => s.setEpicGoal);
  const noteEpicGoalFailure = useProjectStore((s) => s.noteEpicGoalFailure);

  const projectId = projectIdForBeads(byProject, beads);
  const project = projects.find((p) => p.id === projectId);

  const rollup = useMemo(() => {
    if (project === undefined) return undefined;
    // `Date.now()` at render rather than a ticking clock: the only time-dependent input is whether
    // an agent's goal has expired, which moves on the scale of hours. A poll or any other render
    // re-samples it, and nothing here is a countdown.
    const agents = agentsForEpicSlices(project.agents, beads, epicId);
    return rollUpEpicGoal(childrenOf(beads, epicId), agents, Date.now());
  }, [beads, epicId, project]);

  if (projectId === null || project === undefined) return null;
  return (
    <EpicGoalRow
      projectId={projectId}
      epicId={epicId}
      goal={project.epicGoals?.[epicId]}
      rollup={rollup}
      onSetGoal={(text, source) => setEpicGoal(projectId, epicId, text, source)}
      // NOT CURRENTLY MOUNTED ANYWHERE. This wrapper's only call site was `EpicsColumn`'s
      // `EpicRow`, and that mount was removed (bead `sparkle-huw924.3`) because the goal was
      // swallowing the click that opens the epic card. Everything below still describes what this
      // button does and why it must exist — it is re-mounted on the epic CARD by bead
      // `sparkle-huw924.4` — but until then a failed generation has NO way back in the UI at all,
      // which is strictly worse than what this paragraph was written to prevent. Do not read the
      // next sentence as a description of shipped behaviour.
      //
      // THE ONLY SHIPPED WAY BACK FROM A FAILED GENERATION (roborev 65858). Every failure —
      // including a purely transient one: the provider down, a rate limit, the 25s timeout, a `bd`
      // read that lost the Dolt lock — records `generationFailedAt`, and `mayAutoGenerate` then
      // refuses that epic forever. That refusal is correct (nothing should retry a paid call on a
      // timer), but it needs an exit, or one network blip at create time leaves an epic
      // permanently goal-less with a stale reason nothing can clear.
      //
      // `force: true` is that exit, and it is legitimate precisely because a PERSON pressed this:
      // the latch's contract is that an explicit human ask is the one thing that beats it. The
      // generator still writes `source: "auto"` — they chose to spend the call, they did not write
      // the words.
      //
      // THE OUTCOME IS READ, NOT DISCARDED (roborev 65867). Three of the five outcomes write
      // nothing to the store — `ai-off`, `in-flight`, `latched` — so a fire-and-forget click was a
      // SILENT no-op in exactly the states a person presses it repeatedly: with AI features off,
      // the stale failure reason sits on the card forever and every press does nothing observable.
      // `generatePlanGoal` was written on the principle that a tool which quietly does nothing is
      // worse than one that refuses; the UI must not drop that distinction. `noteEpicGoalFailure`
      // is the surface that already exists for saying why there is no goal, so the reason lands
      // there — and it cannot destroy a goal that is in force, since a failure record now keeps the
      // prior text.
      //
      // The `.catch` matches the sibling call site in `plans.ts`: an unhandled rejection in the
      // renderer is not an acceptable way to learn the generator threw.
      onGenerate={async () => {
        try {
          const outcome = await requestEpicGoal(epicGoalGenDeps, {
            projectId,
            projectPath: project.rootPath,
            epicId,
            force: true,
          });
          const said = GENERATE_OUTCOME_COPY[outcome];
          if (said !== null) noteEpicGoalFailure(projectId, epicId, said);
        } catch (e) {
          log.error("epicGoalRow", `epic-goal generation crashed for ${epicId}`, e);
          noteEpicGoalFailure(projectId, epicId, "the goal generator crashed — try again");
        }
      }}
    />
  );
}
