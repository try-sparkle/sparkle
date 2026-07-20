import { useCallback, useEffect, useRef, useState } from "react";
import { computeSuggestions, SuggestionOfflineError } from "./engine";
import { getAgentScrollback } from "../terminalScrollback";
import { useAiFeature } from "../aiGate";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { pushSuggestions } from "../relayClient";
import { deriveCta } from "../../engine/agentCta";
import { maybeAutoApprove } from "./approvalsRuntime";
import { log } from "../../logger";
import type { AgentTabStatus } from "../../types";
import type { SuggestionButton } from "./types";
import type { ApprovalCategory } from "./approvalCategories";

// Statuses where it's the user's turn — the agent finished a turn or is blocked on input. We
// compute suggestions on entry to one of these (the "blocked on user" trigger from the spec).
const YOUR_TURN: ReadonlySet<AgentTabStatus> = new Set<AgentTabStatus>([
  "idle",
  "waiting",
  "approval",
  "errored",
  "done",
]);

// djb2 — cheap + stable; only the tail matters for identity, so identical terminal state never
// triggers a recompute (one Haiku call per distinct blocked state, not per render).
export function hashScrollback(s: string): string {
  let h = 5381;
  const tail = s.slice(-4000);
  for (let i = 0; i < tail.length; i++) h = ((h << 5) + h + tail.charCodeAt(i)) | 0;
  return String(h);
}

export function shouldRecompute(a: {
  lastHash: string | null;
  nextHash: string;
  composerEmpty: boolean;
}): boolean {
  if (!a.composerEmpty) return false;
  return a.lastHash !== a.nextHash;
}

// Cap TOTAL attempts (the initial compute plus its retries) for the SAME failing state so a
// persistently-rejecting compute can't self-perpetuate into an unbounded retry loop (the reject
// path bumps retryTick to recover from a transient failure; without a cap that would spin).
// Resets on success or a genuine state change.
export const MAX_COMPUTE_ATTEMPTS = 3;

/** Whether a failing state still has attempt budget left (exported as a pure unit for testing).
 *  `failures` counts attempts already failed, so budget remains while it's below the cap. */
export function withinRetryBudget(failures: number): boolean {
  return failures < MAX_COMPUTE_ATTEMPTS;
}

// Base delay before RETRYING a *failed* compute. The overwhelmingly common failure is a transient
// AI-gateway blip ("ai request failed", HTTP 502) — retrying instantly fires all attempts within a
// few milliseconds, so they land on the SAME blip and the whole state gives up (and hammers a
// struggling gateway with rapid paid calls). A short, growing backoff spaces the attempts out so a
// transient blip has time to clear before the next try. Kept modest so suggestions still feel live.
export const RETRY_BACKOFF_MS = 700;

/** Backoff (ms) before the next retry, given how many attempts have already failed (1 after the
 *  first failure). Grows exponentially and is capped so it never stalls the UI. Pure, for testing. */
export function retryBackoffMs(failures: number): number {
  return Math.min(RETRY_BACKOFF_MS * 2 ** Math.max(0, failures - 1), 4000);
}

// How often the settle-watcher re-hashes the scrollback while the agent is blocked on the user.
// Two consecutive identical hashes = the terminal has finished painting (settled).
export const SETTLE_TICK_MS = 1200;

/**
 * Owns the per-agent suggestion set. Recomputes once when the agent enters a your-turn status with
 * an empty composer and a changed scrollback; caches by scrollback hash so identical state never
 * recomputes. Returns the visible (non-dismissed) buttons plus per-button dismiss + a clear.
 */
export function useSuggestions(agentId: string, composerEmpty: boolean) {
  const [buttons, setButtons] = useState<SuggestionButton[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  // The category we last auto-answered for this agent (drives the inline "Auto-approved {label} ·
  // Manage" note), or null. Cleared whenever normal buttons are shown or the state moves on.
  const [autoApproved, setAutoApproved] = useState<ApprovalCategory | null>(null);
  // Signatures of picker instances already auto-answered, so a re-rendered/settled scrollback can't
  // re-send the keystroke. Per-agent (this hook instance owns one agent). See maybeAutoApprove.
  const handledSigs = useRef<Set<string>>(new Set());
  const lastHash = useRef<string | null>(null);
  // Guards against a duplicate concurrent (paid) compute while one is in flight. `retryTick` lets a
  // discarded compute re-trigger the effect so a state we returned to still gets suggestions.
  const computing = useRef(false);
  const [retryTick, setRetryTick] = useState(0);
  // Pending failure-retry timer (see retryBackoffMs). Held in a ref so the effect cleanup can cancel
  // it when the state moves on before the backoff fires, and so we never stack overlapping timers.
  const retryTimer = useRef<number | null>(null);
  // Consecutive-failure counter (+ the hash it's failing on) to bound retries per failing state.
  const failures = useRef(0);
  const lastFailHash = useRef<string | null>(null);
  // Whether we last pushed a NON-empty set to the phone — so retiring only emits a clearing push
  // when there's actually something to clear (no chatty empty pushes on every status flip).
  const pushedNonEmpty = useRef(false);

  // Retire this agent's buttons on the phone (and drop the host's id→value map) so a phone can't
  // click a suggestion the desktop has stopped showing. No-op if nothing non-empty was pushed.
  // Signature of the last set pushed to the phone; retire() resets it so a set can be re-pushed
  // after a clear. Declared before `retire` (which writes it) though the push effect below reads it.
  const lastPushedRef = useRef<string>("");
  const retire = useCallback(() => {
    lastPushedRef.current = "";
    if (!pushedNonEmpty.current) return;
    pushedNonEmpty.current = false;
    pushSuggestions({ agent_id: agentId, buttons: [] });
  }, [agentId]);
  // useAiFeature already ANDs the per-feature flag with paid entitlement, so this is the real
  // "are learned (Haiku) actions live?" signal. Heuristic buttons show regardless (computeSuggestions
  // returns them before this gate), so passing it as aiEnabled keeps heuristics on when AI is off.
  const learnedOn = useAiFeature("suggestedActions");
  // "Are we actually reachable?" (browser online AND the Rust reachability probe agree). When
  // offline we skip the learned Haiku call, which could only DNS-fail; when it flips back true this
  // is an effect dep, so the deferred compute for the still-blocked state re-runs on reconnect.
  const isOnline = useConnectionStore((s) => s.isOnline);
  const status = useRuntimeStore((s) => s.status[agentId]);
  const isYourTurn = status !== undefined && YOUR_TURN.has(status);
  // The LIVE stage — deliberately NOT `workflowShipped`, which is a latch-once watermark that trips
  // the first time work reaches main and clears only on close. Reading it here is what made an agent
  // that landed an earlier cycle offer "Close Build Agent" over fresh un-landed work. The watermark
  // still exists for the bead lifecycle and the "landed at least once" marker, whose ever-landed
  // semantics are correct — it's just wrong for "what should you do right now".
  const stage = useRuntimeStore((s) => s.workflowStage[agentId]);
  // Select the one PRIMITIVE deriveCta reads (CtaSignals), not the WorkflowState object.
  // `setWorkflowState` builds a fresh object every applied poll, so subscribing to the object would
  // hand this hook a new reference each tick. That identity churn used to reach the compute effect's
  // dep array and abort an in-flight (paid Haiku) compute mid-poll, discarding the result and
  // re-running it — a real cost, since the compute is a metered call.
  const hasRemote = useRuntimeStore((s) => s.workflowState[agentId]?.hasRemote);

  // Suppresses the CTA after `clear()` (the user just acted on it) until the next compute or turn.
  // Without this the render-time merge would immediately re-add the very pill they just clicked.
  const [ctaCleared, setCtaCleared] = useState(false);

  // Stage-derived primary + computed alternates. deriveCta returns null when there's nothing to
  // nudge (no committed work yet), in which case the ordinary suggestions stand on their own.
  // NOTE this is used only at RENDER (see `shown`), never inside the compute effect — keeping it out
  // of that dep array is what stops a poll from cancelling an in-flight paid compute.
  const applyCta = useCallback(
    (computed: SuggestionButton[]): SuggestionButton[] => {
      const cta = stage ? deriveCta(stage, { hasRemote }, computed) : null;
      return cta ? [cta.primary, ...cta.alternates] : computed;
    },
    [stage, hasRemote],
  );

  useEffect(() => {
    if (!isYourTurn) return;
    // A compute for the current state is already in flight — don't fire a duplicate (which, when
    // learned actions are on, is a redundant paid Haiku call). The in-flight one will either apply
    // its result or, if superseded, bump retryTick to re-evaluate.
    if (computing.current) return;
    const scrollback = getAgentScrollback(agentId) ?? "";
    const nextHash = hashScrollback(scrollback);
    if (!shouldRecompute({ lastHash: lastHash.current, nextHash, composerEmpty })) return;
    // A genuinely different state gets a fresh retry budget; retries of the SAME failing state draw
    // down the budget set in .catch below — and once that budget is exhausted, ANY re-trigger for
    // the same hash (composer typed-then-cleared, learnedOn toggled) must bail here too, or each
    // such cycle would buy a fresh paid call the budget already refused (lastHash was never
    // committed for a failing hash, so shouldRecompute alone can't stop it).
    if (nextHash !== lastFailHash.current) failures.current = 0;
    else if (!withinRetryBudget(failures.current)) return;
    computing.current = true;
    let alive = true;
    // Whether the finally block should bump retryTick. The bump must happen AFTER the in-flight
    // guard clears: if the re-render it triggers is processed between .catch and .finally (React
    // is free to flush it on any microtask boundary), the effect re-runs while computing.current
    // is still true, early-returns, and the retry is silently dropped.
    let retryAfter = false;
    // How long to wait before that retry. A superseded compute (composer toggled mid-flight)
    // recomputes the CURRENT state immediately (0); a *failed* compute backs off (retryBackoffMs)
    // so a transient gateway blip can clear before the next attempt.
    let retryDelay = 0;
    log.debug("suggestions", "compute", { agentId, chars: scrollback.length, learnedOn });
    void computeSuggestions({ agentId, scrollback, aiEnabled: learnedOn, entitled: true, online: isOnline })
      .then((set) => {
        // Commit the hash ONLY when we actually apply the result. If the composer went non-empty
        // mid-compute (alive === false), drop the result, leave lastHash unchanged, and bump
        // retryTick so the state we're actually in now recomputes — otherwise the suggestions for
        // that blocked state would be lost until the scrollback or status changed.
        if (!alive) {
          retryAfter = true;
          return;
        }
        failures.current = 0;
        lastFailHash.current = null;
        lastHash.current = nextHash;
        setDismissed(new Set());
        // Sparkle Auto-Approve: if this settled state is a classifiable permission prompt whose
        // effective rule is "always" (and the feature is on), the local classifier types the plain
        // "Yes" ONCE (signature de-duped) INSTEAD of surfacing buttons. Retire any phone copy and
        // show the inline "Auto-approved" note. The keystroke comes only from the local heuristic
        // tier, never the learned tier — the existing raw-keystroke trust boundary is preserved.
        const autoCat = maybeAutoApprove(agentId, scrollback, handledSigs.current);
        if (autoCat) {
          setAutoApproved(autoCat);
          setButtons([]);
          // Use retire() rather than open-coding it: it already no-ops when nothing non-empty was
          // pushed, AND it resets lastPushedRef. Open-coding left that signature stale, so a later
          // compute in the SAME your-turn yielding the same button ids would hit the sig guard and
          // never re-send the phone the set the desktop is showing.
          retire();
          log.debug("suggestions", "auto-approved", { agentId, category: autoCat });
          return;
        }
        setAutoApproved(null);
        setCtaCleared(false); // a fresh state — the CTA is relevant again
        // Store the RAW computed set; the CTA is merged over it at RENDER time (see `shown` below).
        // Storing the merged list here instead would freeze the CTA at compute time: the workflow
        // stage advances on the ~15-30s poll, long after the scrollback settled, and this effect
        // refuses to re-run for an unchanged hash — so a landing agent would keep offering "Land to
        // Main" after it had already reached local main.
        //
        // The relay push does NOT happen here: the render-time effect below is the SINGLE owner of
        // pushes. Pushing from both meant every successful compute relayed two identical events, and
        // a push from here could never cover a CTA that changed with the stage rather than the
        // scrollback.
        setButtons(set.buttons);
        log.debug("suggestions", "computed", { agentId, buttons: set.buttons.length });
      })
      .catch((err: unknown) => {
        // Offline is NOT a failure of THIS state — the same compute will succeed once we reconnect.
        // Leave lastHash unadvanced (so it recomputes) but DON'T spend the retry budget, DON'T warn,
        // and DON'T bump retryTick (which would spin every render while offline). The isOnline effect
        // dep re-runs this compute when connectivity returns.
        if (err instanceof SuggestionOfflineError) {
          log.debug("suggestions", "compute deferred (offline)", { agentId });
          return;
        }
        // The compute rejected — leave lastHash unadvanced and re-trigger so this state can retry,
        // but only up to MAX_COMPUTE_ATTEMPTS for the SAME failing state, so a persistent rejection
        // can't spin into an unbounded loop of paid computes. A genuine state change resets this.
        failures.current += 1;
        lastFailHash.current = nextHash;
        log.warn("suggestions", "compute failed", {
          agentId,
          failures: failures.current,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!alive) return;
        if (withinRetryBudget(failures.current)) {
          retryAfter = true;
          retryDelay = retryBackoffMs(failures.current);
        } else {
          // Budget exhausted: this settled state is known-uncomputable. Keeping the PREVIOUS
          // state's buttons through the transient retries was fine, but past the last retry
          // they're stale on a terminal that shows something else — drop them locally and retire
          // the phone's copy so a phone can't click an action for a state that no longer exists.
          setButtons([]);
          retire();
        }
      })
      .finally(() => {
        // ALWAYS clear the guard, so a rejected compute can never permanently lock out future
        // computes for this agent (the guard at the top of the effect keys off this flag).
        computing.current = false;
        // Bump only now that the guard is clear — see retryAfter above. A failed compute waits out
        // its backoff first (retryDelay); a superseded one (retryDelay 0) re-triggers immediately.
        // The timer id is parked in a ref so the effect cleanup can cancel a pending retry if the
        // state moves on before it fires.
        if (!retryAfter) return;
        if (retryDelay <= 0) {
          setRetryTick((t) => t + 1);
          return;
        }
        retryTimer.current = window.setTimeout(() => {
          retryTimer.current = null;
          setRetryTick((t) => t + 1);
        }, retryDelay);
      });
    return () => {
      alive = false;
      if (retryTimer.current !== null) {
        window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
    };
  }, [agentId, isYourTurn, composerEmpty, learnedOn, retryTick, retire, isOnline]);

  // Settle-watcher. The your-turn status flip (Claude's Stop hook) RACES the final terminal paint
  // into xterm, so the compute above frequently hashes a mid-paint — or, right after a pane mount,
  // empty — scrollback, commits that hash, and (having no scrollback subscription) would never look
  // again: the buttons for the settled state simply never appear. While the agent stays blocked on
  // the user with an empty composer, re-hash the tail on a slow tick; when it has SETTLED (two
  // consecutive identical hashes) on a state we haven't computed, bump retryTick so the compute
  // effect re-runs. The settle requirement keeps mid-stream frames from triggering paid computes,
  // the lastHash gate keeps each distinct settled state to exactly one compute, and the failure
  // budget is honored so the watcher can't resurrect an unbounded retry loop the .catch above
  // deliberately capped.
  useEffect(() => {
    if (!isYourTurn || !composerEmpty) return;
    let prevTickHash: string | null = null;
    const id = window.setInterval(() => {
      if (computing.current) return;
      // Offline: the compute would only defer again — don't bump retryTick every tick. The isOnline
      // effect dep re-runs the compute on reconnect. Read the store live so the running interval
      // (its deps don't include isOnline) sees the current connectivity without restarting.
      if (!useConnectionStore.getState().isOnline) return;
      // A null provider means the terminal is UNMOUNTED, not that the terminal is empty — don't
      // spend a compute on no content (or clobber good buttons with the empty result). Ticks
      // resume once the provider registers, which still covers the mount race.
      const scrollback = getAgentScrollback(agentId);
      if (scrollback == null) return;
      const h = hashScrollback(scrollback);
      const settled = h === prevTickHash;
      prevTickHash = h;
      if (!settled || h === lastHash.current) return;
      if (h === lastFailHash.current && !withinRetryBudget(failures.current)) return;
      setRetryTick((t) => t + 1);
    }, SETTLE_TICK_MS);
    return () => window.clearInterval(id);
  }, [agentId, isYourTurn, composerEmpty]);

  // When the agent goes back to working (no longer the user's turn), drop the stale buttons — the
  // terminal state has moved on, so retire the phone's copy too. The CTA rides on the computed set
  // (it's merged in at render), so clearing here correctly takes the CTA down with it: a working
  // agent shouldn't be offered "Land to Main" mid-turn.
  useEffect(() => {
    if (!isYourTurn) {
      setButtons([]);
      setAutoApproved(null); // the prompt is gone — drop any lingering auto-approved note
      // Reset the auto-answer dedupe when the agent goes back to working: the signature guard is
      // only meant to stop a SINGLE settled screen from re-sending the keystroke while it re-hashes
      // during one your-turn. A later, genuinely-distinct prompt for the same command (e.g. the same
      // `rm -rf build/` run twice) hashes identically, so if the set persisted across turns that
      // second REAL prompt would be suppressed WITHOUT being answered — leaving the agent blocked.
      handledSigs.current.clear();
      lastHash.current = null;
      setCtaCleared(false); // the next your-turn starts with a fresh CTA
      retire();
    }
  }, [isYourTurn, retire]);

  // NOTE: we deliberately do NOT retire() when the desktop composer merely goes non-empty (the user
  // starts typing). The desktop hides its row, but the phone is an independent surface and the agent
  // is still blocked on the SAME prompt — a phone tap is still valid, so it's not a stale injection.
  // Retiring on every keystroke-start would be chatty and would wrongly clear the phone's view; a
  // real send flips the agent off your-turn, which retires through the effect above.
  const dismiss = useCallback((id: string) => setDismissed((d) => new Set(d).add(id)), []);
  const clear = useCallback(() => {
    setButtons([]);
    setAutoApproved(null);
    // The user just acted on the row; the CTA must go down with the rest of it. Without this the
    // render-time merge would re-add the very pill they clicked (buttons is empty, but deriveCta
    // builds its primary from the stage alone). Reset on the next compute or turn change.
    setCtaCleared(true);
    // Commit the CURRENT scrollback hash rather than nulling: the agent often stays your-turn
    // (settled) for a beat after a suggestion click, and a null lastHash would let the settle-
    // watcher immediately recompute — resurrecting the very buttons the user just acted on (and
    // re-pushing them to the phone). The watcher recomputes only once the terminal actually moves.
    lastHash.current = hashScrollback(getAgentScrollback(agentId) ?? "");
    retire();
  }, [agentId, retire]);

  // The CTA is merged HERE, at render, over whatever the last compute produced — not baked into
  // `buttons` — so the pill tracks the live stage as the poll advances it (building_saved →
  // merged_local → merged) without needing the scrollback to change.
  //
  // The `isYourTurn` gate is load-bearing, NOT a shortcut: deriveCta builds its primary from the
  // stage alone, so applyCta([]) is NON-empty. SuggestionRow is gated only on the composer being
  // empty (suggestionRowVisible), not on your-turn — so without this gate a build agent that is
  // actively WORKING with committed work would render a "Land to Main" pill mid-turn. The same gate
  // is what makes `clear()` and the not-your-turn reset actually take the CTA down with them.
  //
  // Suppressed on the auto-approve path too: that state deliberately shows only the inline
  // "Auto-approved" note (the compute path clears the buttons), and a CTA beside it would contradict
  // that. And after `clear()` (the user just clicked the pill) until the next compute or turn.
  const showCta = isYourTurn && !autoApproved && !ctaCleared;
  // Dismissal is applied AFTER the merge: deriveCta unconditionally prepends its primary, so
  // filtering first left the pill's × advertising an action it couldn't perform (click × → the
  // identical pill re-renders). Filtering here lets × drop the CTA and fall back to the alternates.
  const merged = showCta ? applyCta(buttons) : buttons;
  const shown = merged.filter((b) => !dismissed.has(b.id));
  // Computed at render so the push effect can depend on a STABLE string rather than `shown`, which
  // .filter() rebuilds every render — the same identity churn just removed from the compute effect.
  const shownSig = shown.map((b) => b.id).join("|");

  // SINGLE owner of relay pushes. The compute path deliberately doesn't push: two owners meant every
  // successful compute relayed the same set twice, and a compute-time push can't cover a CTA that
  // changes with the STAGE (a 15-30s poll) rather than the scrollback. Keyed on the button-id
  // signature so an unchanged set never re-pushes.
  useEffect(() => {
    // Never push a non-empty set once the turn is over. On the your-turn→working transition React
    // commits a render where isYourTurn is already false but `buttons` still holds the old set
    // (setButtons([]) hasn't flushed). Effects run in declaration order, so the reset effect above
    // retires first — and without this guard THIS effect would immediately re-push that stale set,
    // undoing the retire and re-arming taps on the phone for a turn the agent has moved on from.
    if (!isYourTurn && shown.length > 0) return;
    if (shownSig === lastPushedRef.current) return;
    // Nothing to clear: don't emit a chatty empty `suggestions` event on every your-turn transition
    // that yields no buttons. An empty set AFTER a non-empty one still pushes, to retire the old one.
    if (shown.length === 0 && !pushedNonEmpty.current) return;
    lastPushedRef.current = shownSig;
    pushedNonEmpty.current = shown.length > 0;
    pushSuggestions({
      agent_id: agentId,
      buttons: shown.map(({ id, label, value }) => ({ id, label, value })),
    });
    // `shown` is read through the closure; `shownSig` is the identity-stable trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, shownSig, isYourTurn]);

  return { buttons: shown, dismiss, clear, autoApproved };
}
