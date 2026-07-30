// THE BRIEF WAIT MUST NOT OUTLIVE THE TRANSPORT THAT CARRIES ITS ANSWER.
//
// `spawn_build_agent` is reachable from the sparkle-control MCP server, which bounds every
// `concierge_tool` round trip at `DEFAULT_TIMEOUT_MS` and passes no override. The brief-delivery wait
// was first written at 45s against that 30s bound, which inverted the whole point of the change: any
// briefed spawn slower than 30s killed the socket first, so the caller received a thrown
// `bridge request timeout` for a spawn that HAD created the agent and consumed a capacity slot — and
// the natural response to a timeout is a retry, which duplicates the agent. The honest
// `unconfirmed` / `launch-failed` payloads could never reach an MCP caller at all.
//
// These are two constants in two packages that cannot import each other, so nothing but this test
// stops them drifting back across each other. It reads the bridge's source rather than trusting a
// copied number, because a copied number is exactly what drifts.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BRIEF_DELIVERY_TIMEOUT_MS } from "./agentBrief";

/** Parsed out of the bridge client itself — a duplicated literal here would defeat the purpose. */
function bridgeDefaultTimeoutMs(): number {
  const src = readFileSync(
    resolve(__dirname, "../../../mcp-control/src/bridgeClient.ts"),
    "utf8",
  );
  const m = src.match(/DEFAULT_TIMEOUT_MS\s*=\s*([\d_]+)/);
  if (!m) throw new Error("could not find DEFAULT_TIMEOUT_MS in apps/mcp-control/src/bridgeClient.ts");
  return Number(m[1]!.replace(/_/g, ""));
}

describe("brief-delivery bound vs the MCP bridge bound", () => {
  it("gives up well before the bridge does, so the honest outcome can actually be delivered", () => {
    const bridge = bridgeDefaultTimeoutMs();
    expect(bridge).toBeGreaterThan(0);
    expect(BRIEF_DELIVERY_TIMEOUT_MS).toBeLessThan(bridge);
    // Not merely less — with headroom for the rest of the round trip (spawn work, IPC, serialization).
    // A bound 500ms under the transport's would still time the socket out in practice.
    expect(bridge - BRIEF_DELIVERY_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  });
});
