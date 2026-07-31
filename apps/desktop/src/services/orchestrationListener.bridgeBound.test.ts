// THE SPAWN QUEUE MUST GIVE UP BEFORE THE TRANSPORT THAT CARRIES ITS ANSWER — WITH ROOM TO SPEAK.
//
// An over-cap `spawn_worker` is queued rather than refused, and `expireStaleQueuedSpawns` exists so
// the caller gets an explicit "this unit was NOT started" instead of a bare socket timeout. That
// distinction is load-bearing: the explicit reply PROVES the entry never reached `runSpawn`, so
// re-spawning the unit is safe. A bare `bridge request timeout` proves nothing about what the
// desktop did, so the orchestrator has to go check `list_workers` first — and the natural response
// to a timeout is a retry, which duplicates the agent (the same failure agentBrief.bridgeBound.test
// guards, and the one orchestrationListener's own header documents).
//
// So the budget must clear TWO things, not one:
//   1. the client's socket bound, and
//   2. the SWEEP GRANULARITY — on a quiet store, delivery comes from the reap tick, which is
//      anchored to listener start, not to enqueue. An entry queued just after a tick expires on
//      time but waits up to another REAP_INTERVAL_MS to be noticed.
//
// At the original 600_000 that was a dead heat: 600 + 60 = 660 = the socket bound exactly, leaving
// nothing for the reply's own round trip (roborev 56222). The previous test proved the reap path
// sweeps AT ALL; nothing proved the sweep lands inside the margin. This does.
//
// Like agentBrief.bridgeBound.test.ts, this reads the bridge's constant out of its source rather
// than restating it here — these are constants in two packages that cannot import each other, and a
// copied number is exactly what drifts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SPAWN_QUEUE_MAX_WAIT_MS, REAP_INTERVAL_MS } from "./orchestrationListener";

/** Parsed out of the orchestrator bridge client itself — a duplicated literal would defeat the point. */
function bridgeDefaultTimeoutMs(): number {
  const rel = "../../../mcp-orchestrator/src/bridgeClient.ts";
  const src = readFileSync(resolve(__dirname, rel), "utf8");
  const m = src.match(/DEFAULT_TIMEOUT_MS\s*=\s*([\d_]+)/);
  if (!m) throw new Error(`could not find DEFAULT_TIMEOUT_MS in apps/mcp-orchestrator/src/bridgeClient.ts`);
  return Number(m[1]!.replace(/_/g, ""));
}

describe("spawn-queue expiry vs the orchestrator bridge bound", () => {
  it("expires, is swept, and still has time to reply before the socket gives up", () => {
    const bridge = bridgeDefaultTimeoutMs();
    expect(bridge).toBeGreaterThan(0);

    // The worst case a caller can actually experience: queued just after a reap tick, so it waits
    // the full expiry AND the full tick before anything notices.
    const worstCaseDelivery = SPAWN_QUEUE_MAX_WAIT_MS + REAP_INTERVAL_MS;
    expect(worstCaseDelivery).toBeLessThan(bridge);

    // Not merely less — with headroom for `respond`'s own round trip (invoke → Rust → socket write).
    // A bound that lands 1s under the transport's would still lose the race in practice, and losing
    // it hands the orchestrator the ambiguous timeout instead of the definitive error.
    expect(bridge - worstCaseDelivery).toBeGreaterThanOrEqual(30_000);
  });

  it("keeps the expiry meaningfully longer than one sweep, so the queue still functions", () => {
    // The opposite failure: an expiry so short that ordinary queueing gets cancelled. The queue is a
    // feature — a spawn should be able to wait out a busy patch. Several sweeps' worth of room keeps
    // "expired" meaning "nobody is coming", not "you were unlucky with tick phase".
    expect(SPAWN_QUEUE_MAX_WAIT_MS).toBeGreaterThanOrEqual(REAP_INTERVAL_MS * 5);
  });
});
