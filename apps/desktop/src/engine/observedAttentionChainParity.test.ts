// THE PARITY GUARD FOR A CONSTRAINT NO BEHAVIOURAL TEST CAN SEE.
//
// `withObservedAttention` is applied in TWO parallel chains — `useAttentionNotifications`'s
// `composeRollup` (which feeds the dock badge, the TopBar cluster and the concierge feed) and
// `components/AgentSidebar`'s `effectiveStatus` memo (which paints the Build column). They must
// apply it at the SAME position, and they did not for one commit: `composeRollup` ran it on the raw
// map before `withNewAgentCalm` while the sidebar ran it after. A briefless agent inside
// NEW_AGENT_GRACE_MS with status `errored` and verdict `awaiting` then came out `new` (gray, calm)
// from one and `waiting` (red, needs_you) from the other (roborev 67199).
//
// ── WHY THIS IS A SOURCE TEST AND NOT A BEHAVIOURAL ONE ─────────────────────────────────────────
// `publishedRollupAgreement.test.ts` compares `publishedStatusFor` against `rollupViewFor`, but
// BOTH come out of the single `composeRollup` — so it is structurally blind to the sidebar's copy,
// and so is every test that drives those two entry points. The sidebar's composition lives inside a
// component memo that is not exported and depends on hooks that own clocks, so there is no seam to
// call. That leaves the source itself as the only thing that can witness the constraint.
//
// Reading a sibling source file at test time is an established pattern in this repo (see
// `nudge_gate.rs`'s `fn ts(rel: &str)`, which reads these same TypeScript files to pin matcher
// parity across the language boundary).
//
// If the two are ever unified behind one exported prelude that both call, DELETE THIS FILE — a
// structural guarantee needs no guard. Until then this is what stops the regression recurring
// silently.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

const SIDEBAR = read("../components/AgentSidebar.tsx");
const ROLLUP = read("../useAttentionNotifications.ts");

/** Index of the first call to `name(`, or -1. */
const callAt = (src: string, name: string) => src.indexOf(`${name}(`);

describe("both status chains apply the observed-attention overlay at the same position", () => {
  it("each chain calls it exactly once — a second call would make the order ambiguous", () => {
    for (const [label, src] of [["AgentSidebar", SIDEBAR], ["composeRollup", ROLLUP]] as const) {
      const calls = src.match(/withObservedAttention\(/g) ?? [];
      expect(calls.length, `${label} should call withObservedAttention exactly once`).toBe(1);
    }
  });

  it("applies it BEFORE the new-agent calm in the sidebar chain", () => {
    // Non-vacuity: both anchors must actually be present, or an ordering assertion over two -1s
    // passes while neither call exists.
    const overlay = callAt(SIDEBAR, "withObservedAttention");
    const calm = callAt(SIDEBAR, "useNewAgentCalm");
    expect(overlay, "AgentSidebar no longer calls withObservedAttention").toBeGreaterThan(-1);
    expect(calm, "AgentSidebar no longer calls useNewAgentCalm").toBeGreaterThan(-1);
    expect(overlay).toBeLessThan(calm);
  });

  it("applies it BEFORE the new-agent calm in the published chain", () => {
    const overlay = callAt(ROLLUP, "withObservedAttention");
    const calm = callAt(ROLLUP, "withNewAgentCalm");
    expect(overlay, "composeRollup no longer calls withObservedAttention").toBeGreaterThan(-1);
    expect(calm, "composeRollup no longer calls withNewAgentCalm").toBeGreaterThan(-1);
    expect(overlay).toBeLessThan(calm);
  });

  it("feeds each the RAW status map, not a map another overlay has already corrected", () => {
    // The specific regression: passing `s0` (post-calm) instead of `liveStatus` is what made the
    // two chains disagree, and it is a one-word edit that nothing else would catch.
    expect(SIDEBAR).toMatch(/withObservedAttention\(\s*project\?\.agents \?\? NO_AGENTS,\s*liveStatus,/);
    expect(ROLLUP).toMatch(/withObservedAttention\(agents, status, observed,/);
  });
});
