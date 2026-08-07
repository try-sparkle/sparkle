// ── THE STALE-CHECKOUT REMEDY PANEL (bead sparkle-7h01z) ───────────────────────────────────────
//
// The tab badge says a checkout is `⚠ 1,935` behind. This is what happens when you click it.
//
// WHAT IT IS NOT, because these were decided against explicitly and a later reader will otherwise
// try to add them back:
//
//   • NO DIFF, NO COMMIT LIST, NO "WHAT CHANGED". The founder's ruling. A stale checkout is not a
//     thing you want to read about, it is a thing you want to stop being stale — and a commit list
//     is 1,935 rows of other people's work that answers no question the badge raised.
//   • NO "FIX ANYWAY" ON THE BLOCKED CASE. See `remedyAction`.
//
// WHAT IT IS: one row per stale checkout — the one you clicked FIRST, then every other stale
// project — each carrying the backend's own cause sentence and, when there is something safe to do,
// exactly one button that says what it will do. Plus a "Fix all safe" that runs the actionable rows
// SEQUENTIALLY and names, on screen, every row it declined to touch. Half-succeeding silently is
// the failure mode a bulk action has that a per-row button does not, so the bulk action is the one
// that has to account for itself.
//
// The paint, the placement, the click-away backdrop and the in-flight idiom are all `OpenPrMenu`'s
// — deliberately, and by IMPORT where it is code (`panelPlacement`, `PANEL_EDGE_MARGIN`) rather than
// by copy. Two differences from that component, both on purpose:
//
//   • ESCAPE CLOSES THIS. OpenPrMenu has no Escape handler; a panel whose controls mutate a git
//     checkout should have a way out that is not "find the backdrop", so this follows
//     `Concierge/KebabMenu`'s window-level keydown and restores focus to the badge on close.
//   • IT IS PORTALED THROUGH `ModalLayer`. The tab strip is not a stacking context today, but a
//     fixed-position panel whose z-index only works while that stays true is the exact fragility
//     `ModalLayer` exists to remove (see components/layers.ts's "COMPETES AT ROOT" note).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiAlertTriangle } from "react-icons/fi";
import { ModalLayer } from "./ModalLayer";
import { panelPlacement, type PanelPlacement } from "./OpenPrMenu";
import { C, FONT_WEIGHT } from "../theme/colors";
import {
  diagnoseStale,
  remedyStale,
  type RemedyOutcome,
  type StaleDiagnosis,
} from "../services/staleness";

/**
 * WHERE THIS PANEL SITS, and why not in the 22–37 window `components/layers.ts` describes.
 *
 * That window is for surfaces competing INSIDE the ②+③ wrapper. This one is portaled to
 * `document.body`, so it competes at root against the bands that file lists: OpenPrMenu and
 * SettingsDialog own 38–45 (and the file is explicit that tuning to "just below 41" and relying on
 * a DOM-order tie is how that band got broken once already), the row hover card's portal owns 50,
 * and the app-modal band starts at 61.
 *
 * 52/53 clears all of it with room either side. Above the hover card is the correct direction, not
 * an accident: a panel the user deliberately opened should cover a card that merely follows the
 * pointer. Below 61 is equally deliberate — every app-modal dialog still covers this.
 */
export const STALE_PANEL_BACKDROP_Z = 52;
export const STALE_PANEL_Z = 53;

/** One stale checkout the panel should account for. `behind`/`base` are the BADGE's reading, shown
 *  while the fuller diagnosis is still in flight so the row is never blank. */
export interface StaleTarget {
  id: string;
  name: string;
  rootPath: string;
  behind: number;
  base: string;
}

/**
 * The button a diagnosis earns, or `null` for the rows that get none.
 *
 * Pure and exported so the refusals below are pinned as a rule rather than inferred from markup.
 *
 * ── `blocked-held-elsewhere` GETS NO BUTTON, AND THAT IS THE DECISION, NOT AN OVERSIGHT ─────────
 *
 * This is a linked worktree whose branch is checked out in a DIFFERENT worktree. Git allows a
 * branch in exactly one worktree at a time, so the condition is not transient and no sequence of
 * commands run from here clears it — the other worktree has to move first, and this app does not
 * know when or whether that will ever happen.
 *
 * The founder's ruling, verbatim in intent: **a button you must press forever is worse than none.**
 * A "Fix anyway" here would be an affordance whose entire career is failing — press it, read git's
 * refusal, press it again tomorrow, read the same refusal — and each press teaches the user that
 * this panel's buttons do not work, which is a cost paid by the rows where they DO. The row still
 * says exactly what is wrong: `cause` names the holding worktree. That is the actionable part, and
 * the action is not ours to take.
 *
 * DO NOT ADD ONE. If a future change makes the case genuinely recoverable, the backend gets a new
 * `remedy` value for the recoverable shape — it does not get a button bolted onto this one.
 *
 * `blocked-diverged`, `unknown` and `none` are silent for their own reasons (a divergence is a
 * merge/rebase decision that is not this app's to make; `unknown` is fail-closed, on the same rule
 * as the badge — never a confident action over an answer we do not have; `none` has nothing to do).
 */
export function remedyAction(d: StaleDiagnosis): { label: string; busyLabel: string } | null {
  switch (d.remedy) {
    case "fast-forward":
    case "fast-forward-dirty":
      return { label: "Fast-forward", busyLabel: "Fast-forwarding…" };
    default:
      // Every `blocked-*` kind, plus `unknown` and `none`, lands here. `blocked-detached` used to
      // return a "check out the branch and fast-forward" button; it was DELETED (roborev 59436),
      // because that action moves a commit the fast-forwardability check never covered and can
      // claim the branch away from a sibling worktree before failing. Its cause names the step.
      return null;
  }
}

/** Per-row load state. `error` is an IPC failure (the command is missing, the backend died) — a tree
 *  the backend could not read comes back as a successful diagnosis with `unknown: true` instead. */
type RowState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; diag: StaleDiagnosis };

/** Why "Fix all safe" left a row alone, phrased so the SKIP is legible on its own — the cause
 *  sentence is already on the row, so a bulk action that merely re-showed it would be indis-
 *  tinguishable from having done nothing. Naming the project is what makes the line a report. */
function skipReason(
  t: StaleTarget,
  st: RowState | undefined,
  { offeredAtPress }: { offeredAtPress: boolean },
): string {
  // AN UNSETTLED ROW HAS TWO DIFFERENT STORIES, and one sentence for both is false for one of them.
  // "Had not finished" is a claim about the state of the row WHEN THE BUTTON WAS PRESSED, so it can
  // only be said of a row that was not offered. A row that WAS offered is by definition one whose
  // diagnosis had finished — it is unsettled now because something re-ran it (a `targets` change
  // re-diagnoses the whole panel), and telling the user it never finished contradicts the count
  // they just pressed (roborev 59702).
  //
  // PAST TENSE in both, and deliberately so. This branch became reachable once the bulk button
  // stopped being disabled while rows load, and nothing clears a skip when the diagnosis later
  // lands. Phrased in the present, the line then sits above a fully diagnosed row with an enabled
  // Fast-forward button, asserting the panel has not looked at something it plainly has. As a
  // report of what that RUN did, each stays true no matter what arrives afterwards — which is also
  // what the skip list is for (roborev 59486).
  if (!st || st.kind === "loading")
    return offeredAtPress
      ? `Skipped ${t.name} — its diagnosis was being re-run when Fix all safe reached it.`
      : `Skipped ${t.name} — its diagnosis had not finished when Fix all safe ran.`;
  if (st.kind === "error")
    return `Skipped ${t.name} — its checkout could not be diagnosed (${st.message}).`;
  return `Skipped ${t.name} — ${st.diag.cause}`;
}

export function StaleCheckoutPanel({
  anchorEl,
  targets,
  onClose,
}: {
  /** The badge that opened this. The panel hangs off its bottom-right; see `panelPlacement`. */
  anchorEl: HTMLElement | null;
  /** Every stale checkout, THE CLICKED ONE FIRST. Order is the caller's, not re-sorted here. */
  targets: StaleTarget[];
  onClose: () => void;
}) {
  const [placement, setPlacement] = useState<PanelPlacement | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [outcomes, setOutcomes] = useState<Record<string, RemedyOutcome>>({});
  const [skips, setSkips] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [fixingAll, setFixingAll] = useState(false);

  // `fixAllSafe` is a `useCallback` that does not depend on `rows`, so the `rows` it closes over is
  // whatever the render that CREATED it saw — `{}` in practice. A ref mirror is the only way it can
  // read the map as of the PRESS. It reads it once for the offered set and once more per row as a
  // liveness check; see the note on `fixAllSafe` for why those are two different reads and why
  // neither may be replaced by the other.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Nothing may write state after the panel is gone — every path here is async and the panel is
  // closed by a click that can land mid-flight.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // LAYOUT effect, not a passive one — OpenPrMenu:743's reason applies unchanged: measured after
  // paint, the panel flashes at the window's top-left for a frame on every open.
  useLayoutEffect(() => {
    const place = () => {
      if (!anchorEl) return;
      const r = anchorEl.getBoundingClientRect();
      setPlacement(panelPlacement({ right: r.right, bottom: r.bottom }, { width: window.innerWidth }));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchorEl]);

  // ESCAPE CLOSES. OpenPrMenu has none; this panel's buttons move a git checkout, so a keyboard user
  // must be able to leave without hunting for the backdrop. Window-level, exactly as
  // `Concierge/KebabMenu` does it — focus restoration is the CALLER's (it owns the badge).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const diagnoseOne = useCallback(async (t: StaleTarget) => {
    try {
      const diag = await diagnoseStale(t.rootPath);
      if (!aliveRef.current) return;
      setRows((prev) => ({ ...prev, [t.id]: { kind: "ready", diag } }));
    } catch (e) {
      if (!aliveRef.current) return;
      setRows((prev) => ({ ...prev, [t.id]: { kind: "error", message: String(e) } }));
    }
  }, []);

  // ONE DIAGNOSIS PER TARGET, ISSUED CONCURRENTLY on open. Sequential would make the last row's
  // freshness a function of how many projects are stale, and each write touches only its own key.
  const key = targets.map((t) => `${t.id}\u0000${t.rootPath}`).join("");
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  useEffect(() => {
    const list = targetsRef.current;
    setRows(Object.fromEntries(list.map((t) => [t.id, { kind: "loading" } as RowState])));
    void Promise.all(list.map((t) => diagnoseOne(t)));
    // `key` IS the content of `targets`; depending on the array identity would re-diagnose on every
    // parent render, which for this panel means re-running git probes while the user reads it.
    // (No eslint-disable needed — `targetsRef` is a ref, so the rule is already satisfied.)
  }, [key, diagnoseOne]);

  /** Apply one row's remedy, then RE-DIAGNOSE it — whether it succeeded or not. A row that still
   *  says "1,935 behind" after a successful fast-forward is a panel lying about the thing it just
   *  did, and a row that failed needs the diagnosis that failure produced, not the one before it. */
  const runRemedy = useCallback(
    async (t: StaleTarget) => {
      setBusy((prev) => new Set(prev).add(t.id));
      setSkips((prev) => {
        if (!(t.id in prev)) return prev;
        const next = { ...prev };
        delete next[t.id];
        return next;
      });
      try {
        const outcome = await remedyStale(t.rootPath);
        if (!aliveRef.current) return;
        setOutcomes((prev) => ({ ...prev, [t.id]: outcome }));
        await diagnoseOne(t);
      } catch (e) {
        if (!aliveRef.current) return;
        // An IPC rejection is still an outcome the user must see, so it takes the same slot rather
        // than a console line. `String(e)` is the backend's own text — rendered verbatim like every
        // other reason on this panel.
        setOutcomes((prev) => ({
          ...prev,
          [t.id]: { ok: false, reason: String(e), action: "", beforeBehind: 0, afterBehind: 0 },
        }));
      } finally {
        if (aliveRef.current)
          setBusy((prev) => {
            const next = new Set(prev);
            next.delete(t.id);
            return next;
          });
      }
    },
    [diagnoseOne],
  );

  /**
   * "Fix all safe" — SEQUENTIALLY, and it never silently skips.
   *
   * Sequential because these are git commands against checkouts that may share an object store, and
   * because a failure part-way through should leave a legible trail rather than a race. Every row it
   * does not act on gets a NAMED reason written beside it (`skipReason`), which is the whole
   * difference between this and a bulk action that half-succeeds and reports success.
   */
  // TWO GATES, AND A ROW MUST PASS BOTH. They fail in opposite directions, so neither alone is the
  // rule and collapsing them back to one read re-opens whichever hole the other was closing.
  //
  //   • THE OFFERED SET IS FIXED AT PRESS TIME (`atPress`). This used to re-read `rowsRef.current`
  //     when the loop REACHED each row — and every earlier actionable row costs a git merge plus a
  //     re-diagnosis, so a row still loading at the press could be `ready` by its turn and get
  //     fast-forwarded. That is a checkout the user never saw offered: absent from the count the
  //     button names AND from the skips it promises, mutated on the strength of an answer that
  //     arrived after the decision to press (knightwatch probe 2 on PR #1396). The press-time read
  //     is what makes "the N checkouts" and "any row still being diagnosed is skipped" true.
  //   • BUT A SNAPSHOT ALONE GOES STALE THE OTHER WAY (`live`). The panel's rule is that it only
  //     ever acts on `ready` + `remedyAction`, and a map read seconds ago cannot answer that about
  //     NOW: a `targets` change re-runs the diagnosis effect mid-run, resetting rows to `loading`,
  //     and the snapshot would keep fast-forwarding off the pre-reset answers. So the offered set
  //     is an UPPER BOUND — every row is re-checked against live state at its turn, and one that
  //     lost its remedy is skipped with the reason it has NOW, not the one it had at the press.
  //
  // The third window — a per-row Fast-forward pressed DURING the run, which would leave `live`
  // showing the pre-remedy answer while that remedy is still in flight — is closed at the source:
  // `fixingAll` locks the per-row buttons, so there is no second writer to race.
  const fixAllSafe = useCallback(async () => {
    setFixingAll(true);
    const atPress = rowsRef.current;
    const nextSkips: Record<string, string> = {};
    for (const t of targetsRef.current) {
      const st = atPress[t.id];
      const offered = st?.kind === "ready" && !!remedyAction(st.diag);
      const live = rowsRef.current[t.id];
      const stillOffered = live?.kind === "ready" && !!remedyAction(live.diag);
      if (offered && stillOffered) {
        await runRemedy(t);
        if (!aliveRef.current) return;
      } else {
        // A row dropped by the LIVE gate was diagnosed at the press, so its CURRENT state is the
        // honest reason — which is a revised verdict when one has landed, and "being re-run" when
        // the re-diagnosis is still in flight. `offeredAtPress` is what keeps those apart: a row
        // that never passed the offered gate keeps `st` and the "had not finished" line for a
        // diagnosis that landed mid-run. One sentence for both would be false for one of them
        // (roborev 59702).
        nextSkips[t.id] = skipReason(t, offered ? live : st, { offeredAtPress: offered });
      }
    }
    if (!aliveRef.current) return;
    setSkips(nextSkips);
    setFixingAll(false);
  }, [runRemedy]);

  // STILL-DIAGNOSING IS NOT "NOTHING TO DO". On open every row is `loading`, so `actionableCount`
  // is 0 for the whole diagnosis window — and the old copy used that to state as fact that every
  // checkout was blocked, while the rows underneath still said "Diagnosing…". That is the one thing
  // this feature refuses to do everywhere else: assert a verdict it has not looked up (roborev
  // 59437). The definite wording now waits until every row has actually answered.
  const stillDiagnosing = targets.some((t) => !rows[t.id] || rows[t.id]?.kind === "loading");
  const actionableCount = targets.filter((t) => {
    const st = rows[t.id];
    return st?.kind === "ready" && !!remedyAction(st.diag);
  }).length;

  const primary = targets[0];
  const others = targets.slice(1);

  return (
    <ModalLayer>
      {/* The click-away backdrop, OpenPrMenu:1298's idiom: a full-window fixed div whose onClick
          closes, NOT a document listener. It declares NO background on purpose — that is the tell
          `modalLayering.test.ts` reads to tell a scoped dismiss catcher from an app-modal scrim. */}
      <div
        data-testid="stale-panel-backdrop"
        onClick={onClose}
        style={{ position: "fixed", inset: 0, zIndex: STALE_PANEL_BACKDROP_Z }}
      />
      <div
        data-testid="stale-panel"
        role="dialog"
        aria-label="Stale checkouts"
        style={{
          position: "fixed",
          top: placement?.top ?? 0,
          left: placement?.left ?? 0,
          width: placement?.width ?? undefined,
          // Never taller than the window; the list scrolls inside itself when it is longer.
          maxHeight: "min(420px, calc(100vh - 80px))",
          overflowY: "auto",
          background: C.deepForest,
          border: `1px solid ${C.hairline}`,
          borderRadius: 6,
          boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
          padding: 6,
          zIndex: STALE_PANEL_Z,
          color: C.cream,
          fontSize: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px 8px",
            borderBottom: `1px solid ${C.hairline}`,
            marginBottom: 4,
          }}
        >
          <FiAlertTriangle size={12} style={{ flex: "none", color: C.dangerInk }} aria-hidden />
          <span style={{ flex: 1, minWidth: 0, fontWeight: FONT_WEIGHT.semibold }}>
            Stale checkouts
          </span>
          {/* PRESENT EVEN WHEN NOTHING IS ACTIONABLE, and disabled with its reason RENDERED — the
              OpenPrMenu:1533 rule. A control that vanishes when it cannot act takes away the only
              place the reader is told WHY nothing can be done in bulk.

              The reason is a real element below, NOT a `title`. This branch exists partly because
              `disableNativeTooltips()` strips `title` app-wide, and this button has visible text so
              the attribute is dropped with no `aria-label` fallback — putting the only explanation
              there would have made it unreadable AND unannounced (roborev 59437).

              `stillDiagnosing` gates the WORDING below, NEVER this button's `disabled`. Nothing
              bounds a diagnosis — `repo_stale_diagnose` shells out to git, which can block on a
              lock — so gating the control would let ONE wedged project disable the bulk action for
              every other row permanently, under a reassuring "Diagnosing…". `fixAllSafe` already
              writes a named skipReason for a row that is still loading (roborev 59454). */}
          <button
            type="button"
            data-testid="stale-fix-all"
            disabled={actionableCount === 0 || fixingAll || busy.size > 0}
            aria-describedby="stale-fix-all-reason"
            onClick={() => void fixAllSafe()}
            style={{
              flex: "0 0 auto",
              background: actionableCount === 0 ? "transparent" : C.teal,
              color: actionableCount === 0 ? C.muted : C.cream,
              border: `1px solid ${actionableCount === 0 ? C.muted : C.teal}`,
              borderRadius: 6,
              padding: "3px 10px",
              fontSize: 12,
              fontWeight: FONT_WEIGHT.semibold,
              cursor: actionableCount === 0 || fixingAll ? "default" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {fixingAll ? "Fixing…" : "Fix all safe"}
          </button>
        </div>

        {/* The bulk button's reason, as an ELEMENT so it is both visible and announced. FOUR states,
            and the MIXED one is the reason there are four: this element is the button's only
            description (`aria-describedby`), so once the gate came off `disabled` the button became
            pressable while rows were still loading — and a bare "Diagnosing…" then described an
            ENABLED control with a sentence about no action at all, saying nothing about the rows
            `fixAllSafe` will skip and name. A control that can act must describe the act. */}
        <div
          id="stale-fix-all-reason"
          data-testid="stale-fix-all-reason"
          style={{ padding: "0 6px 6px", fontSize: 12, color: C.muted, lineHeight: 1.45 }}
        >
          {/* "that can be moved safely SO FAR", never "diagnosed so far": `actionableCount` counts
              rows that are diagnosed AND actionable, so labelling it the diagnosed count silently
              omits the diagnosed-but-blocked rows sitting right there on screen. The "every other
              row is left alone with its reason shown" clause is kept here too — those rows are
              skipped for a reason the settled wording accounts for and this one must as well
              (roborev 59486). Both promises are literally true only because `fixAllSafe` reads the
              row map ONCE at press time — see the note there before weakening either. */}
          {stillDiagnosing && actionableCount > 0
            ? `Fast-forward the ${actionableCount} checkout${actionableCount === 1 ? "" : "s"} that can be moved safely so far; every other row is left alone with its reason shown, and any row still being diagnosed is skipped and named.`
            : stillDiagnosing
              ? "Diagnosing these checkouts…"
              : actionableCount === 0
                ? "Nothing here can be fixed automatically — every stale checkout is blocked, diverged, or could not be diagnosed. Each row says which."
                : `Fast-forward the ${actionableCount} checkout${actionableCount === 1 ? "" : "s"} that can be moved safely; every other row is left alone with its reason shown.`}
        </div>

        {primary && (
          <StaleRow
            key={primary.id}
            target={primary}
            state={rows[primary.id]}
            outcome={outcomes[primary.id]}
            skip={skips[primary.id]}
            busy={busy.has(primary.id)}
            locked={fixingAll}
            onRemedy={() => void runRemedy(primary)}
          />
        )}

        {others.length > 0 && (
          <>
            <div
              data-testid="stale-others-header"
              style={{
                padding: "8px 8px 4px",
                marginTop: 4,
                borderTop: `1px solid ${C.hairline}`,
                color: C.muted,
                fontSize: 10,
                fontWeight: FONT_WEIGHT.semibold,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              All stale checkouts
            </div>
            {others.map((t) => (
              <StaleRow
                key={t.id}
                target={t}
                state={rows[t.id]}
                outcome={outcomes[t.id]}
                skip={skips[t.id]}
                busy={busy.has(t.id)}
                locked={fixingAll}
                onRemedy={() => void runRemedy(t)}
              />
            ))}
          </>
        )}
      </div>
    </ModalLayer>
  );
}

function StaleRow({
  target,
  state,
  outcome,
  skip,
  busy,
  locked,
  onRemedy,
}: {
  target: StaleTarget;
  state: RowState | undefined;
  outcome: RemedyOutcome | undefined;
  skip: string | undefined;
  busy: boolean;
  /** A bulk run owns every row for its duration — see `fixAllSafe`'s third window. DISTINCT from
   *  `busy`, which is this row's own remedy and is the only thing allowed to say "Fast-forwarding…":
   *  a locked row is not being worked on, it is merely not accepting a second writer. */
  locked: boolean;
  onRemedy: () => void;
}) {
  const diag = state?.kind === "ready" ? state.diag : null;
  const action = diag ? remedyAction(diag) : null;
  // The diagnosis's own count once it lands, the badge's reading until then — so the row never
  // renders a blank where a number belongs, and never a number the backend has since revised.
  const behind = diag ? diag.behind : target.behind;
  const base = (diag ? diag.base : target.base) || target.base;

  return (
    <div
      data-testid={`stale-row-${target.id}`}
      style={{ display: "flex", flexDirection: "column", gap: 4, padding: "6px 8px" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: FONT_WEIGHT.semibold,
          }}
        >
          {target.name}
        </span>
        <span
          data-testid={`stale-behind-${target.id}`}
          style={{
            flex: "0 0 auto",
            color: C.dangerInk,
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {behind.toLocaleString()} behind {base}
        </span>
        {action && (
          <button
            type="button"
            data-testid={`stale-remedy-${target.id}`}
            disabled={busy || locked}
            onClick={onRemedy}
            style={{
              flex: "0 0 auto",
              background: "transparent",
              color: busy || locked ? C.muted : C.teal,
              border: `1px solid ${busy || locked ? C.muted : C.teal}`,
              borderRadius: 6,
              padding: "3px 10px",
              fontSize: 12,
              fontWeight: FONT_WEIGHT.semibold,
              cursor: busy || locked ? "default" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {busy ? action.busyLabel : action.label}
          </button>
        )}
      </div>

      {/* THE BACKEND'S SENTENCE, VERBATIM. Never re-worded here — see services/staleness.ts. */}
      <div data-testid={`stale-cause-${target.id}`} style={{ color: C.muted, lineHeight: 1.4 }}>
        {state?.kind === "loading" || !state
          ? "Diagnosing…"
          : state.kind === "error"
            ? `This checkout could not be diagnosed (${state.message}).`
            : state.diag.cause}
      </div>

      {/* WHAT A FAST-FORWARD WOULD BE STEPPING OVER. Offered anyway (the founder's ruling is that a
          dirty tree is the user's call, not the app's), but never silently: git may still refuse,
          and if it does the refusal lands in the outcome line below. */}
      {diag?.remedy === "fast-forward-dirty" && diag.dirtyCount > 0 && (
        <div data-testid={`stale-dirty-${target.id}`} style={{ color: C.amber, lineHeight: 1.4 }}>
          {diag.dirtyCount} uncommitted change{diag.dirtyCount === 1 ? "" : "s"} in this checkout
          {diag.dirtySample.length > 0 ? `: ${diag.dirtySample.join(", ")}` : ""} — git may refuse
          the fast-forward.
        </div>
      )}

      {outcome && (
        // The backend's `reason` VERBATIM, success or failure. A git refusal is the one text on this
        // panel the user most needs unedited: it names the file or the ref that blocked it.
        <div
          data-testid={`stale-outcome-${target.id}`}
          style={{ color: outcome.ok ? C.muted : C.dangerInk, lineHeight: 1.4 }}
        >
          {outcome.reason}
        </div>
      )}

      {skip && (
        <div
          data-testid={`stale-skip-${target.id}`}
          style={{ color: C.amber, lineHeight: 1.4 }}
        >
          {skip}
        </div>
      )}
    </div>
  );
}
