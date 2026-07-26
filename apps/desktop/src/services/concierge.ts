// Frontend driver for the Concierge brain (PRD/sparkle/concierge-mode.md §5, bead sparkle-ma6e).
//
// The Rust side (`src-tauri/src/concierge.rs`) runs the user's own headless `claude -p` over a
// snapshot prompt and streams the reply back as Tauri events; this service is the thin,
// never-throwing seam the concierge UI (U1) and the integrator (U7) drive:
//
//   - `startConciergeTurn(prompt)` invokes `concierge_turn`. Session continuity is automatic:
//     the manager below remembers the `sessionId` from each `concierge:done` and passes it as
//     `resume_session_id` on the next turn, so the concierge holds ONE ongoing conversation.
//   - `cancelConciergeTurn()` kills the in-flight turn (whole process group, Rust side).
//   - `onConciergeDelta/Done/Error(cb)` subscribe to the stream; each returns a synchronous
//     unsubscribe. Callbacks are fanned out from ONE internal Tauri listener per event, which
//     is what lets the manager capture the session id even when no UI is subscribed, and lets
//     an invoke failure surface as a normal error event instead of a thrown rejection.
//
// Error posture (mirrors improvementPass.ts): nothing here throws to callers. A failed invoke
// or listen is logged and delivered to `onConciergeError` subscribers as a synthetic event, so
// the concierge column always has something to render.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Incremental assistant text for the turn `id` (`concierge:delta`). */
export interface ConciergeDeltaEvent {
  id: string;
  text: string;
}

/** Final reply for the turn `id` (`concierge:done`). `sessionId` is the Claude Code session to
 *  resume next turn — the manager stores it automatically. */
export interface ConciergeDoneEvent {
  id: string;
  sessionId: string;
  text: string;
}

/** A failed turn (`concierge:error`). `detail` is the most specific reason available (claude's
 *  own error text, stderr, or an exit-status phrase). */
export interface ConciergeErrorEvent {
  id: string;
  detail: string;
}

/** The `id` used for errors synthesized on THIS side of the bridge (a rejected invoke/listen),
 *  where no Rust turn token exists. */
export const CONCIERGE_LOCAL_ERROR_ID = "local";

type Callback<T> = (event: T) => void;

const deltaCallbacks = new Set<Callback<ConciergeDeltaEvent>>();
const doneCallbacks = new Set<Callback<ConciergeDoneEvent>>();
const errorCallbacks = new Set<Callback<ConciergeErrorEvent>>();

/** The concierge's ongoing Claude Code session, captured from the last `concierge:done`.
 *  Module-level (not store state): it mirrors a real process-side resource in THIS webview and
 *  must reset with the page. */
let currentSessionId: string | null = null;

/** Resolves once the internal Tauri listeners are registered; null until first needed. */
let wiring: Promise<void> | null = null;

function dispatch<T>(callbacks: Set<Callback<T>>, event: T): void {
  for (const cb of callbacks) {
    try {
      cb(event);
    } catch (e) {
      // A throwing subscriber must not break the fan-out for the others.
      console.warn("concierge: subscriber threw", e);
    }
  }
}

/** Deliver a locally-synthesized failure (rejected invoke, dead event bus) as a normal error
 *  event, so callers have exactly one error surface to watch. */
function dispatchLocalError(detail: string): void {
  dispatch(errorCallbacks, { id: CONCIERGE_LOCAL_ERROR_ID, detail });
}

/** Register the three Tauri listeners exactly once, lazily. They intentionally live for the
 *  webview's lifetime — the concierge column is persistent, and the manager must see every
 *  `done` to keep `currentSessionId` fresh even while no UI subscription exists. */
function ensureWired(): Promise<void> {
  if (!wiring) {
    const w = (async () => {
      const results = await Promise.allSettled([
        listen<ConciergeDeltaEvent>("concierge:delta", (ev) => dispatch(deltaCallbacks, ev.payload)),
        listen<ConciergeDoneEvent>("concierge:done", (ev) => {
          if (ev.payload.sessionId) currentSessionId = ev.payload.sessionId;
          dispatch(doneCallbacks, ev.payload);
        }),
        listen<ConciergeErrorEvent>("concierge:error", (ev) => {
          // The Rust side already retried a stale --resume once; if the turn still failed, drop the
          // session id so the NEXT turn starts fresh rather than resuming into the same failure.
          currentSessionId = null;
          dispatch(errorCallbacks, ev.payload);
        }),
      ]);
      const rejected = results.find((r) => r.status === "rejected");
      if (rejected) {
        // PARTIAL failure: some listeners registered before another rejected. Unlisten the ones
        // that DID register so a retry starts clean — otherwise the survivors stack and every
        // subsequent event dispatches twice. Then surface the failure (the .catch drops the cache).
        for (const r of results) {
          if (r.status === "fulfilled") {
            try {
              r.value();
            } catch {
              /* already gone */
            }
          }
        }
        throw (rejected as PromiseRejectedResult).reason;
      }
    })();
    // Don't cache a REJECTED wiring promise — a transient listen() failure would otherwise brick
    // the concierge for the webview's life. Drop the cache on rejection so the next call retries.
    w.catch(() => {
      if (wiring === w) wiring = null;
    });
    wiring = w;
  }
  return wiring;
}

/**
 * Run one concierge turn over `prompt` (a snapshot of app state, or the user's message).
 * Continuity is automatic: the session id from the last `done` is passed as the resume target
 * unless `resumeSessionId` explicitly overrides it. Resolves when the turn has been ACCEPTED
 * (the reply streams via the subscriptions); never rejects — failures surface on
 * `onConciergeError`.
 */
export async function startConciergeTurn(prompt: string, resumeSessionId?: string): Promise<void> {
  try {
    // Wire listeners BEFORE the invoke so a fast first delta/done can't slip past the manager.
    await ensureWired();
    const resume = resumeSessionId ?? currentSessionId ?? undefined;
    await invoke("concierge_turn", { prompt, resumeSessionId: resume ?? null });
    // Only advance the session id once the turn was ACCEPTED — a rejected invoke must not leave a
    // resume target (esp. an explicit override) for a turn that never ran.
    if (resume) currentSessionId = resume;
  } catch (e) {
    console.warn("concierge: failed to start turn:", e);
    dispatchLocalError(e instanceof Error ? e.message : String(e));
  }
}

/** Cancel the in-flight turn (harmless no-op when none). Never rejects. */
export async function cancelConciergeTurn(): Promise<void> {
  try {
    await invoke("concierge_cancel");
  } catch (e) {
    console.warn("concierge: cancel failed:", e);
  }
}

/** Subscribe to incremental reply text. Returns a synchronous unsubscribe. */
export function onConciergeDelta(cb: Callback<ConciergeDeltaEvent>): () => void {
  deltaCallbacks.add(cb);
  void ensureWired().catch((e) => console.warn("concierge: event wiring failed:", e));
  return () => deltaCallbacks.delete(cb);
}

/** Subscribe to completed turns. Returns a synchronous unsubscribe. */
export function onConciergeDone(cb: Callback<ConciergeDoneEvent>): () => void {
  doneCallbacks.add(cb);
  void ensureWired().catch((e) => console.warn("concierge: event wiring failed:", e));
  return () => doneCallbacks.delete(cb);
}

/** Subscribe to failed turns (including locally-synthesized invoke failures, id
 *  {@link CONCIERGE_LOCAL_ERROR_ID}). Returns a synchronous unsubscribe. */
export function onConciergeError(cb: Callback<ConciergeErrorEvent>): () => void {
  errorCallbacks.add(cb);
  void ensureWired().catch((e) => console.warn("concierge: event wiring failed:", e));
  return () => errorCallbacks.delete(cb);
}

/** The session id the next turn will resume (null = the next turn starts a fresh session). */
export function getConciergeSessionId(): string | null {
  return currentSessionId;
}

/** Forget the ongoing session so the next turn starts fresh (e.g. a user-requested reset). */
export function resetConciergeSession(): void {
  currentSessionId = null;
}

/** Test-only: drop all module state (subscribers, wiring, session) between vitest cases. */
export function _resetConciergeForTests(): void {
  deltaCallbacks.clear();
  doneCallbacks.clear();
  errorCallbacks.clear();
  currentSessionId = null;
  wiring = null;
}
