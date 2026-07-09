import { useCallback, useEffect, useRef, useState } from "react";
import { computeSuggestions } from "./engine";
import { getAgentScrollback } from "../terminalScrollback";
import { useAiFeature } from "../aiGate";
import { useRuntimeStore } from "../../stores/runtimeStore";
import { pushSuggestions } from "../relayClient";
import { closeBuildAgentButton } from "./controlButtons";
import { log } from "../../logger";
import type { AgentTabStatus } from "../../types";
import type { SuggestionButton } from "./types";

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
  const retire = useCallback(() => {
    if (!pushedNonEmpty.current) return;
    pushedNonEmpty.current = false;
    pushSuggestions({ agent_id: agentId, buttons: [] });
  }, [agentId]);
  // useAiFeature already ANDs the per-feature flag with paid entitlement, so this is the real
  // "are learned (Haiku) actions live?" signal. Heuristic buttons show regardless (computeSuggestions
  // returns them before this gate), so passing it as aiEnabled keeps heuristics on when AI is off.
  const learnedOn = useAiFeature("suggestedActions");
  const status = useRuntimeStore((s) => s.status[agentId]);
  const isYourTurn = status !== undefined && YOUR_TURN.has(status);
  // Once the agent has shipped/landed, the only action is to close it — show the green control
  // button and skip suggestion compute entirely.
  const shipped = useRuntimeStore((s) => !!s.workflowShipped[agentId]);

  useEffect(() => {
    if (!shipped) {
      // Leaving the shipped state: clear the local Close button and retire the phone's copy so it
      // can't keep showing a stale Close (a subsequent empty compute wouldn't push, so without this
      // the phone would hold the green button). The compute effect then takes over.
      retire();
      return;
    }
    const btn = closeBuildAgentButton();
    setButtons([btn]);
    setDismissed(new Set());
    lastHash.current = null; // so leaving the shipped state recomputes suggestions fresh
    // Push once per entry into shipped (idempotent on the host map); the retire above clears it on
    // exit, so flips never leave a stale button.
    pushSuggestions({
      agent_id: agentId,
      buttons: [{ id: btn.id, label: btn.label, value: btn.value }],
    });
    pushedNonEmpty.current = true;
  }, [shipped, agentId, retire]);

  useEffect(() => {
    if (shipped) return; // the shipped effect owns the button set
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
    void computeSuggestions({ agentId, scrollback, aiEnabled: learnedOn, entitled: true })
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
        setButtons(set.buttons);
        log.debug("suggestions", "computed", { agentId, buttons: set.buttons.length });
        // Mirror the buttons to a watching phone (no-op if the relay isn't connected). Skip an
        // empty push when nothing non-empty was ever pushed — there's nothing to clear, and we
        // don't want a chatty empty `suggestions` event on every your-turn transition that yields
        // no buttons. An empty result AFTER a non-empty one still pushes, to retire the old set.
        if (set.buttons.length > 0 || pushedNonEmpty.current) {
          pushSuggestions({
            agent_id: agentId,
            buttons: set.buttons.map(({ id, label, value }) => ({ id, label, value })),
          });
        }
        pushedNonEmpty.current = set.buttons.length > 0;
      })
      .catch((err: unknown) => {
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
  }, [agentId, isYourTurn, composerEmpty, learnedOn, retryTick, shipped, retire]);

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
    if (shipped || !isYourTurn || !composerEmpty) return;
    let prevTickHash: string | null = null;
    const id = window.setInterval(() => {
      if (computing.current) return;
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
  }, [agentId, isYourTurn, composerEmpty, shipped]);

  // When the agent goes back to working (no longer the user's turn) and hasn't shipped, drop the
  // stale buttons — the terminal state has moved on, so retire the phone's copy too. (When shipped,
  // the shipped effect owns the button set and we keep the Close button.)
  useEffect(() => {
    if (!isYourTurn && !shipped) {
      setButtons([]);
      lastHash.current = null;
      retire();
    }
  }, [isYourTurn, shipped, retire]);

  // NOTE: we deliberately do NOT retire() when the desktop composer merely goes non-empty (the user
  // starts typing). The desktop hides its row, but the phone is an independent surface and the agent
  // is still blocked on the SAME prompt — a phone tap is still valid, so it's not a stale injection.
  // Retiring on every keystroke-start would be chatty and would wrongly clear the phone's view; a
  // real send flips the agent off your-turn, which retires through the effect above.
  const dismiss = useCallback((id: string) => setDismissed((d) => new Set(d).add(id)), []);
  const clear = useCallback(() => {
    setButtons([]);
    // Commit the CURRENT scrollback hash rather than nulling: the agent often stays your-turn
    // (settled) for a beat after a suggestion click, and a null lastHash would let the settle-
    // watcher immediately recompute — resurrecting the very buttons the user just acted on (and
    // re-pushing them to the phone). The watcher recomputes only once the terminal actually moves.
    lastHash.current = hashScrollback(getAgentScrollback(agentId) ?? "");
    retire();
  }, [agentId, retire]);

  return { buttons: buttons.filter((b) => !dismissed.has(b.id)), dismiss, clear };
}
