// THE BRIEF WAIT MUST NOT OUTLIVE THE TRANSPORT THAT CARRIES ITS ANSWER.
//
// `spawn_build_agent` is reachable from the sparkle-control MCP server, which bounds every
// `concierge_tool` round trip. The brief-delivery wait was first written at 45s against the bridge's
// 30s DEFAULT, which inverted the whole point of the change: any briefed spawn slower than 30s killed
// the socket first, so the caller received a thrown `bridge request timeout` for a spawn that HAD
// created the agent and consumed a capacity slot — and the natural response to a timeout is a retry,
// which duplicates the agent. The honest `unconfirmed` / `launch-failed` payloads could never reach
// an MCP caller at all.
//
// THE FIX FOR THAT WENT TOO FAR THE OTHER WAY, and this test is why it took an incident to notice:
// the wait was cut to 20s to fit under the DEFAULT, and 20s is under the real launch latency (p90
// 24.5s over 108 measured spawns). This test passed the whole time, because it only ever asked
// "is the wait smaller than the transport?" — never "is the wait big enough to be useful?". Both
// bounds are asserted now.
//
// It reads the ACTUAL timeout passed for a concierge call, not the bridge DEFAULT: raising the
// ceiling for that one op is what lets the wait cover real spawns without squeezing every other
// control op. These are constants in two packages that cannot import each other, so nothing but this
// test stops them drifting across each other — and it parses the source rather than trusting a copied
// number, because a copied number is exactly what drifts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BRIEF_DELIVERY_TIMEOUT_MS } from "./agentBrief";

function readConst(relPath: string, name: string): number {
  const src = readFileSync(resolve(__dirname, relPath), "utf8");
  const m = src.match(new RegExp(`${name}\\s*=\\s*([\\d_]+)`));
  if (!m) throw new Error(`could not find ${name} in ${relPath}`);
  return Number(m[1]!.replace(/_/g, ""));
}

/** The bound a `concierge_tool` round trip actually gets — the override, not the bridge default. */
const conciergeToolTimeoutMs = () =>
  readConst("../../../mcp-control/src/tools.ts", "CONCIERGE_TOOL_TIMEOUT_MS");
const bridgeDefaultTimeoutMs = () =>
  readConst("../../../mcp-control/src/bridgeClient.ts", "DEFAULT_TIMEOUT_MS");
/** The liveness stall threshold, read from its own source for the same anti-drift reason. */
const stalledAfterMs = () => readConst("../engine/conciergeLiveness.ts", "STALLED_AFTER_MS");

describe("brief-delivery bound vs the MCP bridge bound", () => {
  it("gives up well before the transport does, so the honest outcome can actually be delivered", () => {
    const transport = conciergeToolTimeoutMs();
    expect(transport).toBeGreaterThan(0);
    expect(BRIEF_DELIVERY_TIMEOUT_MS).toBeLessThan(transport);
    // Not merely less — with headroom for the rest of the round trip (spawn work, IPC, serialization).
    // A bound 500ms under the transport's would still time the socket out in practice.
    expect(transport - BRIEF_DELIVERY_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });

  // THE OTHER DIRECTION, which is the half that was missing while the bug was live. A wait shorter
  // than the launches it waits on does not report "we could not confirm"; it reports a false alarm
  // about an agent that is briefed and working — 13.9% of spawns on the day this was measured.
  // p90 was 24.5s and the slowest was 39.8s, so anything at or under 25s is known-too-small.
  it("is long enough to cover a realistically slow spawn, not just short enough to fit", () => {
    expect(BRIEF_DELIVERY_TIMEOUT_MS).toBeGreaterThan(25_000);
  });

  // The override has to actually BE an override, or the wait is back under a 30s ceiling it does not
  // fit beneath. Pins the relationship rather than the literal.
  it("raises the ceiling for concierge calls above the bridge default meant for cheap reads", () => {
    expect(conciergeToolTimeoutMs()).toBeGreaterThan(bridgeDefaultTimeoutMs());
  });

  // …AND IT MUST STILL LAND UNDER THE STALL THRESHOLD. The override was first set to exactly
  // `STALLED_AFTER_MS` (60s). A `concierge_tool` dispatch resets the liveness clock once, at
  // dispatch, so a spawn that rides the full bound goes silent for exactly as long as it takes to
  // latch the sticky RED stall — turning a transport timeout into a false "agent stalled". The bound
  // has to sit ABOVE the app-side wait and BELOW the threshold; this is the second half, and without
  // it the constant can drift back onto the threshold while every other assertion here still passes.
  it("stays under the liveness stall threshold, so a slow spawn is not read as a stalled agent", () => {
    expect(conciergeToolTimeoutMs()).toBeLessThan(stalledAfterMs());
  });

  // THE MARGIN MUST BE MEASURED ON THE WORST CASE, WHICH IS THE TRANSPORT — NOT THE APP-SIDE WAIT.
  //
  // `reduceX` resets `silentSince` at tool-call DISPATCH and nothing resets it again until the model
  // emits its next delta AFTER the tool result. So the concierge's worst-case quiet is whichever
  // bound actually answers, plus the MCP return, plus first-token.
  //
  // The first version of this assertion used `STALLED_AFTER_MS - BRIEF_DELIVERY_TIMEOUT_MS` and was
  // measuring the HAPPY path — the case where the app answers inside its own wait. When the app is
  // wedged (the documented `bridge request timeout: concierge_tool` shape) or a cloud start hangs on
  // a network hop, nothing app-side answers at all and the thing that finally does is the TRANSPORT
  // bound. At 55s that left 5s, in a file whose own comment argues ~15s is what an MCP return plus a
  // first token needs under load — so the assertion looked like it covered the margin and did not.
  // `spawn_cloud_build_agent` made it sharper still: its chain has no app-side deadline whatsoever,
  // so the transport is its ONLY bound, and it had gone from 30s of silence to 55s.
  //
  // These three constants are one system, so they are solved together rather than nudged apart:
  //   wait(45s) + 5s ≤ transport(50s) + 10s ≤ stall(60s)
  //
  // Both gaps quoted here are the ones the assertions ENFORCE (≥5s at the top of this file, ≥10s
  // below). An earlier version quoted 8s while the ratchet held only 5s — a prose margin larger
  // than the checked one, which is the exact shape this file exists to stop.
  // Raising the wait pushes the transport up behind it and eats the margin — which is how a fix for
  // one false alarm becomes a different false alarm a layer up. The release valve is to stop counting
  // tool-wait as silence at all, not to keep re-tuning these; bead sparkle-t85dj.
  it("leaves the concierge a margin under the stall threshold on the WORST case, not the happy one", () => {
    const worstCaseSilence = conciergeToolTimeoutMs();
    expect(worstCaseSilence).toBeLessThan(stalledAfterMs());
    // 10s for the MCP return and a first token under load. Moving any of the three constants means
    // re-solving this, deliberately, here — rather than discovering it as a sticky RED in the app.
    expect(stalledAfterMs() - worstCaseSilence).toBeGreaterThanOrEqual(10_000);
    // …and the app-side wait is strictly inside it, so the happy path can never be the binding one.
    expect(BRIEF_DELIVERY_TIMEOUT_MS).toBeLessThan(worstCaseSilence);
  });

  // The wait still has to cover the launches it exists to wait for: the slowest spawn measured on the
  // day this was diagnosed was 39.8s, so a bound under that re-opens the original false `unconfirmed`.
  it("still covers the slowest launch actually observed, so the original bug cannot return", () => {
    expect(BRIEF_DELIVERY_TIMEOUT_MS).toBeGreaterThan(39_800);
  });
});
