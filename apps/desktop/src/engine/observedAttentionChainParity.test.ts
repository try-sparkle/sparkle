// THE PARITY GUARD FOR A CONSTRAINT NO BEHAVIOURAL TEST CAN SEE.
//
// `withObservedAttention` is applied in TWO parallel chains — `useAttentionNotifications`'s
// `composeRollup` (which feeds the dock badge, the TopBar cluster and the concierge feed) and
// `hooks/useOverlaidStatus` (which paints the Build column AND, since bead `sparkle-l06ax7`, the
// Epics column's health squares). They must
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
// ── WHERE THE SIDEBAR CHAIN LIVES NOW ──────────────────────────────────────────────────────────
// It was inline in `components/AgentSidebar.tsx` until the Epics column needed the same map and the
// five steps moved to `hooks/useOverlaidStatus` (bead `sparkle-l06ax7`). That extraction UNIFIED the
// two UI columns — they now share one derivation and cannot drift from each other — but it did NOT
// unify them with `composeRollup`, which still carries its own copy. So this guard still has a job;
// only the file it reads changed. `hooks/useOverlaidStatus.test.tsx` additionally pins the ordering
// BEHAVIOURALLY now that there is an exported seam to call, which the component memo never offered.
//
// If the remaining two are ever unified behind one exported prelude that both call, DELETE THIS
// FILE — a structural guarantee needs no guard. Until then this is what stops the regression
// recurring silently.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

const SIDEBAR = read("../hooks/useOverlaidStatus.ts");
const ROLLUP = read("../useAttentionNotifications.ts");

/** Index of the first call to `name(`, or -1. */
const callAt = (src: string, name: string) => src.indexOf(`${name}(`);

describe("both status chains apply the observed-attention overlay at the same position", () => {
  it("each chain calls it exactly once — a second call would make the order ambiguous", () => {
    for (const [label, src] of [["useOverlaidStatus", SIDEBAR], ["composeRollup", ROLLUP]] as const) {
      const calls = src.match(/withObservedAttention\(/g) ?? [];
      expect(calls.length, `${label} should call withObservedAttention exactly once`).toBe(1);
    }
  });

  it("applies it BEFORE the new-agent calm in the sidebar chain", () => {
    // Non-vacuity: both anchors must actually be present, or an ordering assertion over two -1s
    // passes while neither call exists.
    const overlay = callAt(SIDEBAR, "withObservedAttention");
    const calm = callAt(SIDEBAR, "useNewAgentCalm");
    expect(overlay, "useOverlaidStatus no longer calls withObservedAttention").toBeGreaterThan(-1);
    expect(calm, "useOverlaidStatus no longer calls useNewAgentCalm").toBeGreaterThan(-1);
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
    expect(SIDEBAR).toMatch(/withObservedAttention\(agents, liveStatus,/);
    expect(ROLLUP).toMatch(/withObservedAttention\(agents, status, observed,/);
  });
});

// ── THE SAME CONSTRAINT, FOR THE OVERLAY THAT WAS MISSING FROM ONE CHAIN ENTIRELY ───────────────
//
// The guard above catches the two chains applying an overlay at DIFFERENT positions. This one
// catches the sharper case: an overlay present in one chain and ABSENT from the other.
//
// `withDeadSessionCalm` renders a resurrectable death (an upstream 529 → `transport-transient`, an
// expired session → `wall-session`, a reaped process → `process-gone`) as amber `lapsed` rather than
// red, because the resurrection sweep — not the founder — is the actor that clears it. It was wired
// into `composeRollup` only. `useOverlaidStatus` never called it, so for the entire life of that
// asymmetry the dock badge read a 529-killed agent as amber while the Build row painted it RED:
// `errored` is not in `stallEscalation.GRAY_STATUSES`, so `grayFloorFor` declines, `dotFillFor`
// returns `undefined`, and `StatusDot` falls back to `AGENT_STATUS.errored.color`. One upstream wave
// put ~40 rows in that state in a night, each of them showing the loudest signal the app has for a
// thing no human could act on.
//
// ── WHY A SOURCE TEST RATHER THAN A BEHAVIOURAL ONE ────────────────────────────────────────────
// Exactly the reason given at the top of this file, and it applies harder here: `deadSessionRecovery
// .test.ts` already exercises `withDeadSessionCalm` thoroughly — 20+ cases, including the paired
// negative and the `working` refusal — and every one of them passed throughout, because they call
// the overlay DIRECTLY. A test of a function cannot witness a chain that never calls it. That is the
// same blindness `publishedRollupAgreement.test.ts` has, from the other side.
//
// The behavioural half lives with the wiring, in the sidebar chain's own test. This half is what
// makes a future deletion from either chain fail loudly instead of silently re-opening the gap.
describe("both status chains apply the dead-session calm, at the same position", () => {
  it("each chain calls it exactly once — presence in BOTH is the whole point", () => {
    for (const [label, src] of [
      ["useOverlaidStatus", SIDEBAR],
      ["composeRollup", ROLLUP],
    ] as const) {
      const calls = src.match(/withDeadSessionCalm\(/g) ?? [];
      expect(
        calls.length,
        `${label} should call withDeadSessionCalm exactly once — a chain that omits it paints a ` +
          `recovering dead session RED while the other reads it amber`,
      ).toBe(1);
    }
  });

  it("applies it BEFORE the worker bubbles, in both chains", () => {
    // ORDER IS LOAD-BEARING, not tidiness. `withRedWorkerAttention` bubbles any red worker onto its
    // orchestrator, and once bubbled an inherited red is indistinguishable from an own red (the trap
    // `rollupDotAccessor` documents on `ownStatusOf`). Calm the dead worker first and the head never
    // inherits an alarm about a session the app is already restarting; calm it after and the head
    // stays red with nothing on it to explain why.
    for (const [label, src] of [
      ["useOverlaidStatus", SIDEBAR],
      ["composeRollup", ROLLUP],
    ] as const) {
      const calm = callAt(src, "withDeadSessionCalm");
      const bubble = callAt(src, "withRedWorkerAttention");
      // Non-vacuity, the same way the guard above earns it: two -1s would satisfy `<` while neither
      // call exists, which is precisely the state this test is written to reject.
      expect(calm, `${label} no longer calls withDeadSessionCalm`).toBeGreaterThan(-1);
      expect(bubble, `${label} no longer calls withRedWorkerAttention`).toBeGreaterThan(-1);
      expect(calm, `${label} must calm dead sessions before bubbling worker reds`).toBeLessThan(
        bubble,
      );
    }
  });
});

// ── AND THE SAME GUARD FOR THE LANDED VETO, WRITTEN WITH THE OVERLAY RATHER THAN AFTER IT ───────
//
// `withLandedRedVeto` is new on this branch, so it has no divergence history of its own. That is
// exactly why the guard ships WITH it: the dead-session overlay had none either, right up until it
// spent months applied in one chain and not the other. The cost of writing this now is three
// assertions; the cost of not writing it is measured in the 40 rows that wave reddened.
describe("both status chains apply the landed veto, at the same position", () => {
  it("each chain calls it exactly once", () => {
    for (const [label, src] of [
      ["useOverlaidStatus", SIDEBAR],
      ["composeRollup", ROLLUP],
    ] as const) {
      const calls = src.match(/withLandedRedVeto\(/g) ?? [];
      expect(calls.length, `${label} should call withLandedRedVeto exactly once`).toBe(1);
    }
  });

  it("applies it AFTER the dead-session calm and BEFORE the worker bubbles, in both chains", () => {
    // The full ordering constraint in one assertion per chain. After the dead-session calm because
    // a landing is the stronger fact and should win the paint on a row where both hold; before the
    // bubbles for the reason the guard above gives.
    for (const [label, src] of [
      ["useOverlaidStatus", SIDEBAR],
      ["composeRollup", ROLLUP],
    ] as const) {
      const dead = callAt(src, "withDeadSessionCalm");
      const landed = callAt(src, "withLandedRedVeto");
      const bubble = callAt(src, "withRedWorkerAttention");
      // Non-vacuity: three -1s would satisfy both `<` comparisons while no call existed at all.
      for (const [name, at] of [
        ["withDeadSessionCalm", dead],
        ["withLandedRedVeto", landed],
        ["withRedWorkerAttention", bubble],
      ] as const) {
        expect(at, `${label} no longer calls ${name}`).toBeGreaterThan(-1);
      }
      expect(landed, `${label}: the landed veto must follow the dead-session calm`).toBeGreaterThan(
        dead,
      );
      expect(landed, `${label}: the landed veto must precede the worker bubbles`).toBeLessThan(
        bubble,
      );
    }
  });
});
