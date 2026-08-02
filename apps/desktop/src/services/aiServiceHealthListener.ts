// The RECOVERY half of the AI service-health signal — the half that used to be missing.
//
// `aiServiceHealthStore` accumulates a run of failures and lights the app-shell AiServiceBanner.
// Every AI wrapper reports FAILURES (there is no single JS chokepoint — roborev 54761), but until
// this listener existed only `chatOnce` could report a SUCCESS. `generate_agent_name`,
// `judge_turn_followup` and `summarize_attention` all run `cacheable: true`, and `claude_oneshot`
// serves a cache hit before it acquires a permit or spawns anything — so a success reported from
// one would prove nothing about the CLI's current state and could mask a wedged CLI behind its own
// stale answers indefinitely. They were therefore forbidden from reporting health at all.
//
// That left recovery resting on one wrapper whose only caller is the learned-suggestions tier,
// which the user can switch off. In that configuration a user could drive the banner up through
// naming/judge/attention, fix their CLI, and have nothing left that could clear it — the expiry
// (SERVICE_DEGRADED_MAX_AGE_MS) was the sole way back, and it is a bound on a STALE claim, not a
// recovery signal.
//
// Rust now distinguishes the two cases (`claude_oneshot::OneShotReply.spawned`) and emits this
// event only when a real `claude` child answered. So the cached wrappers report recovery on a real
// spawn and stay silent on a hit — exactly the property that made the blanket ban necessary.
//
// ONE LISTENER AND ONE DECISION — but NOT one call site, and the difference matters to anyone
// adding a caller. The alternative shape (widening four commands' reply types and updating four JS
// wrappers) is what broke this detector once already: roborev 54761, where wiring only some
// wrappers left a wedged CLI producing almost no health input. Routing every command through
// `claude_oneshot::finish_cacheable` means the RULE is written once and cannot half-drift. It does
// NOT mean a new `claude_oneshot::run` caller gets this for free: there is a `finish_cacheable`
// call site per cacheable command, and a new one has to add its own.
import { listen } from "@tauri-apps/api/event";
import { noteAiServiceHealthy } from "./anthropic";
import { safeUnlisten } from "./safeUnlisten";

/** MUST match `claude_oneshot::AI_SPAWN_OK_EVENT`. */
export const AI_SPAWN_OK_EVENT = "ai://spawn-ok";

/** Singleton guard, mirroring orchestrationListener: React StrictMode and HMR both double-mount,
 *  and two listeners would double-report a success (harmless here, but the teardown would then
 *  leave one live). Cleared on failure so a later remount can re-arm. */
let startPromise: Promise<() => void> | undefined;

export function startAiServiceHealthListener(): Promise<() => void> {
  startPromise ??= doStart().catch((e: unknown) => {
    startPromise = undefined;
    throw e;
  });
  return startPromise;
}

async function doStart(): Promise<() => void> {
  const unlisten = await listen(AI_SPAWN_OK_EVENT, () => {
    // The payload carries nothing — the EVENT is the fact, and the fact is exactly: A REAL `claude`
    // CHILD RAN AND ANSWERED. It says nothing about whether the answer was USABLE, and must not:
    // Rust emits it even when post-processing rejected the reply (a SKIP name, unparseable JSON, a
    // summary that cleaned to empty), because a child that answered proves the transport works
    // whatever it said. See `claude_oneshot::finish_cacheable` — emitting only on a usable reply
    // was a real bug, and the common path at that, since every operational prompt returns SKIP.
    noteAiServiceHealthy();
  });
  return () => {
    // Through `safeUnlisten`, never bare — Tauri's real unlisten is ASYNC, so a bare call hands
    // back a REJECTED promise rather than throwing, and the "listeners map already torn down"
    // race becomes an app-level unhandled rejection. Both races that helper documents are live
    // here: Workspace's `if (unmounted) c()` fires on a listen() promise that resolved after
    // unmount, and ordinary teardown runs on window close. (roborev 57507)
    void safeUnlisten(unlisten);
    startPromise = undefined;
  };
}
