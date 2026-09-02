// The PURE half of the concierge preview projections — asserted without rendering anything.
//
// `PreviewCards.test.tsx` drives the real store through `applyPreviewStatus` and asserts what
// reaches the DOM, which is the test that matters. This file covers the rules that are cheaper to
// pin exhaustively as functions: WHICH states get which projection, that the two projections are
// disjoint, and how the stderr tail is clamped.
//
// THE ONE THING IT MUST NOT LET DRIFT: `livePreviewCards` is not merely "the card list" — it is the
// app's definition of "a preview the human can OPEN", and `previewIdleGrace` reads that definition
// to decide which dev servers nothing is watching. So the first row below asserts that adding the
// notice states did NOT widen it, which is the regression this whole split exists to prevent.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractTopLevelFunctionBody } from "@sparkle/core/testing/sourceGuards";

import {
  clampNoticeDetail,
  isPreviewNoticeState,
  livePreviewCards,
  pendingPreviewNotices,
  renderablePreviewNotices,
  PREVIEW_NOTICE_DETAIL_MAX,
} from "./previewCards";
import { isSurfacingState } from "../stores/previewStore";
import type { PreviewEntry, PreviewState } from "../stores/previewStore";

const ALL_STATES: PreviewState[] = [
  "installing",
  "starting",
  "listening",
  "ready",
  "serving",
  "failed",
  "crashed",
  "stopped",
];

function entry(over: Partial<PreviewEntry> & { status: PreviewState }): PreviewEntry {
  return {
    id: "srv-1",
    url: "http://127.0.0.1:5173",
    port: 5173,
    error: null,
    startedAt: 1_000,
    reloadNonce: 0,
    surfacedAt: null,
    ...over,
  };
}

describe("the two projections partition the state machine", () => {
  it("gives EVERY state exactly one of: a card, a notice, or nothing — and only `stopped` gets nothing", () => {
    // ONE MAP HOLDING ALL EIGHT STATES AT ONCE, so this is a partition claim rather than eight
    // independent yes/no answers that could all be satisfied by a function returning nothing.
    const byAgent: Record<string, PreviewEntry> = {};
    for (const status of ALL_STATES) byAgent[`ag-${status}`] = entry({ status });

    const cards = livePreviewCards(byAgent).map((c) => c.agentId).sort();
    const notices = pendingPreviewNotices(byAgent).map((n) => n.agentId).sort();

    expect(cards).toEqual(["ag-ready", "ag-serving"]);
    expect(notices).toEqual([
      "ag-crashed",
      "ag-failed",
      "ag-installing",
      "ag-listening",
      "ag-starting",
    ]);
    // DISJOINT — nothing may be both openable and merely noteworthy.
    expect(cards.filter((id) => notices.includes(id))).toEqual([]);
    // AND TOTAL, bar the one state that is where the surface retires.
    const covered = new Set([...cards, ...notices]);
    expect(ALL_STATES.filter((s) => !covered.has(`ag-${s}`))).toEqual(["stopped"]);
  });

  it("did NOT widen `livePreviewCards`, which `previewIdleGrace` reads as 'openable'", () => {
    // The regression this split exists to prevent: broadening the openable set would silently
    // change which dev servers the idle-grace clock reclaims.
    for (const status of ALL_STATES) {
      const only = { a1: entry({ status }) };
      expect(livePreviewCards(only).length).toBe(status === "ready" || status === "serving" ? 1 : 0);
    }
  });

  it("agrees with `isPreviewNoticeState` for every state, given a url the card can render", () => {
    // THE QUALIFIER IS THE POINT (roborev 65679). `isPreviewNoticeState` is now a statement about
    // the STATE alone — every state but `stopped` — while whether a notice is actually PRODUCED
    // also depends on the entry: a surfacing state yields a card instead, unless the card cannot
    // render its url, in which case it falls back to a notice. `entry()` seeds a loopback http url,
    // so this row asserts the card-wins half; the fallback half has its own describe block below.
    for (const status of ALL_STATES) {
      const produced = pendingPreviewNotices({ a1: entry({ status }) }).length === 1;
      const cardWins = status === "ready" || status === "serving";
      expect(produced).toBe(isPreviewNoticeState(status) && !cardWins);
    }
  });

  it("`stopped` is the ONLY state that is never noteworthy", () => {
    // Pinned separately because it is the one thing `isPreviewNoticeState` still decides on its
    // own, and it is what keeps retirement derived rather than scheduled.
    for (const status of ALL_STATES) {
      expect(isPreviewNoticeState(status)).toBe(status !== "stopped");
    }
  });
});

describe("what a notice carries", () => {
  it("carries the stderr tail verbatim, and marks failures apart from stages", () => {
    const tail = "the dev server exited before it started listening. Last output: EADDRINUSE";
    const [n] = pendingPreviewNotices({ a1: entry({ status: "failed", error: tail }) });
    expect(n).toBeDefined();
    expect(n!.detail).toBe(tail);
    expect(n!.fullDetail).toBe(tail);
    expect(n!.failed).toBe(true);
    expect(n!.status).toBe("failed");

    const [stage] = pendingPreviewNotices({ a1: entry({ status: "installing", error: null }) });
    expect(stage).toBeDefined();
    expect(stage!.detail).toBeNull();
    expect(stage!.failed).toBe(false);
  });

  it("carries NO url — the non-clickability is structural, not styled", () => {
    const [n] = pendingPreviewNotices({
      a1: entry({ status: "failed", url: "http://127.0.0.1:5173", error: "boom" }),
    });
    expect(n).toBeDefined();
    expect(Object.keys(n!)).not.toContain("url");
    expect(JSON.stringify(n!)).not.toContain("127.0.0.1");
  });

  it("orders newest first, with a total order on ties", () => {
    const notices = pendingPreviewNotices({
      old: entry({ status: "failed", startedAt: 10 }),
      newB: entry({ status: "starting", startedAt: 99 }),
      newA: entry({ status: "installing", startedAt: 99 }),
    });
    expect(notices.map((n) => n.agentId)).toEqual(["newA", "newB", "old"]);
  });

  it("resolves the owning agent's name and drops one the roster cannot resolve", () => {
    const byAgent = {
      known: entry({ status: "failed", error: "boom" }),
      ghost: entry({ status: "failed", error: "boom" }),
    };
    const named = renderablePreviewNotices(byAgent, [
      { agents: [{ id: "known", name: "Kraken Auth" }] },
    ]);
    expect(named.map((n) => [n.agentId, n.name])).toEqual([["known", "Kraken Auth"]]);
  });
});

describe("clampNoticeDetail", () => {
  it("returns null for absent or whitespace-only text", () => {
    expect(clampNoticeDetail(null)).toBeNull();
    expect(clampNoticeDetail(undefined)).toBeNull();
    expect(clampNoticeDetail("   \n\t ")).toBeNull();
  });

  it("leaves text at the limit untouched and keeps the TAIL of anything longer", () => {
    const exact = "y".repeat(PREVIEW_NOTICE_DETAIL_MAX);
    expect(clampNoticeDetail(exact)).toBe(exact);

    const over = `HEAD${"y".repeat(PREVIEW_NOTICE_DETAIL_MAX)}TAIL`;
    const clamped = clampNoticeDetail(over)!;
    // THE TAIL, because the last line a dev server printed is the one that says why it died.
    expect(clamped.endsWith("TAIL")).toBe(true);
    expect(clamped.includes("HEAD")).toBe(false);
    expect(clamped.startsWith("…")).toBe(true);
    expect(clamped.length).toBe(PREVIEW_NOTICE_DETAIL_MAX + 1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE PARTITION IS OVER ENTRIES, NOT OVER STATES — roborev 65679
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The original partition test seeded every entry with `url: "http://127.0.0.1:5173"`, so "total,
// bar `stopped`" was only ever proven for loopback-http entries. `livePreviewCards` also drops a
// `ready`/`serving` entry whose url is null or is not loopback http, and notices used to exclude
// those states unconditionally — so a preview that was RUNNING fell through both projections and
// produced nothing at all, which is precisely the silence this surface exists to end.
describe("a running preview the card cannot render still says something", () => {
  const running = (url: string | null): Record<string, PreviewEntry> => ({
    a1: {
      id: "srv-a1",
      agentId: "a1",
      projectId: "p1",
      url,
      port: 5173,
      status: "serving",
      error: null,
      startedAt: 1_000,
      surfacedAt: 1_000,
      reloadNonce: 0,
    } as PreviewEntry,
  });

  // Each of these is a real shape the wire can deliver: a `serving` payload whose port was never
  // resolved into a url, and a dev server on https (Vite's `server.https`), which the loopback
  // predicate refuses because it parses the scheme rather than string-matching the host.
  for (const [label, url] of [
    ["a null url", null],
    ["an https dev server", "https://localhost:5173"],
  ] as const) {
    it(`falls through to a NOTICE when the card refuses ${label}`, () => {
      const byAgent = running(url);
      expect(livePreviewCards(byAgent)).toHaveLength(0);
      const notices = pendingPreviewNotices(byAgent);
      expect(notices).toHaveLength(1);
      // Not painted as a failure — nothing failed. The address is what cannot be offered.
      expect(notices[0]!.failed).toBe(false);
      expect(notices[0]!.status).toBe("serving");
    });
  }

  it("does NOT double-count a serving preview the card CAN render", () => {
    // The other half of the partition: exactly one surface, never both. Without this the fix above
    // would read as correct while every healthy preview grew a redundant status line under it.
    const byAgent = running("http://127.0.0.1:5173");
    expect(livePreviewCards(byAgent)).toHaveLength(1);
    expect(pendingPreviewNotices(byAgent)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE ENGINE'S ACTUAL BEHAVIOUR, PINNED — because a comment claiming otherwise already shipped
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// `previewCardShot`'s header used to assert "a dev server re-emits `serving` on every hot reload",
// `previewStore`'s `surfacedAt` note leaned on the same sentence for a DIFFERENT decision, and a
// task brief inherited it verbatim as a settled premise — a fix designed on it would have shipped a
// timer with no signal to time off (bead `sparkle-l7cihu`). Nothing was red, because prose is not
// executable and the refutation was sitting 36 lines further down the same file.
//
// WHY A FIXTURE CANNOT GUARD THIS. Every other test in this file and in `PreviewCards.test.tsx`
// feeds `"serving"` in BY HAND, which is exactly how a state with no production writer came to look
// thoroughly exercised. Asserting anything about a `"serving"` fixture would restate the mistake.
// The only thing that can go red is a claim about the ENGINE, so this reads `preview.rs` from disk
// — READ, never written; the Rust half of this bead belongs to another worker — and asserts the
// three properties the corrected comments now rest on:
//
//   1. `supervise` never constructs `PreviewState::Serving`, and neither does anything else in
//      preview.rs's production half. The variant is live in three predicates and dead as an output.
//   2. The DISCOVERY block is guarded by `if bound.is_none()`, so it runs AT MOST ONCE, and the
//      only `transition(` inside it is the one to `listening`.
//   3. The HTTP probe sits OUTSIDE that block and inside the loop, so it RETRIES (bead
//      `sparkle-dlrqb8.2` — it used to be inside, which made one failing probe final and left a
//      slow-to-answer server at `listening` forever). `ready` is emitted through `ReadyWatch::tick`,
//      which returns a state AT MOST ONCE — so a healthy preview still emits nothing at all once it
//      has reached `ready`, which is the property the corrected comments actually rest on.
//
// Precedent for reading Rust source from a vitest file, including the scoping discipline copied
// here: `previewSeam.test.ts`, which pins the other Rust↔TS seam this feature has.
//
// FAILS CLOSED EVERYWHERE. Every anchor below throws — naming what it could not find — rather than
// letting a slice silently degrade to the whole file or to nothing, which is the shape that turns a
// guard into a test that cannot fail.
describe("preview.rs's supervise loop, as the corrected comments describe it", () => {
  const RUST_SOURCE = fileURLToPath(new URL("../../src-tauri/src/preview.rs", import.meta.url));

  /** Everything before the test module. Scanning the whole file would let a Rust TEST FIXTURE —
   *  and preview.rs's tests do construct `PreviewState::Serving` — satisfy a claim about
   *  production, which is the precise confusion this whole block exists to end. */
  function productionHalf(whole: string): string {
    const cut = whole.indexOf("mod tests");
    if (cut < 0) {
      throw new Error(
        "preview.rs no longer carries its `mod tests` marker — this guard cannot scope itself to " +
          "the production half, and an unscoped scan is satisfied by preview.rs's own test fixtures",
      );
    }
    return whole.slice(0, cut);
  }

  /** One deep-body marker per function this file slices: an identifier that appears only well
   *  inside the body, never in the signature and never in the first statement.
   *
   *  THIS IS THE ANTI-VACUITY ANCHOR (bead `sparkle-7uh1v5`) and it is the half that a `!== ""`
   *  check cannot do: a slice truncated into the SIGNATURE is perfectly non-empty, so every
   *  assertion built on it goes quietly green. Each marker below also survives the two in-memory
   *  MUTATIONS further down — the mutations must be caught by the assertions they target, not by
   *  the anchor, or the negative controls would be proving the wrong thing. */
  const DEEP_BODY_ANCHORS: Record<string, readonly string[]> = {
    supervise: ["discover_port(", "std::thread::sleep("],
    live_for_reattach: ["PreviewState::Crashed"],
  };

  /** One top-level `fn`'s body, via the ONE shared extractor
   *  (`@sparkle/core/testing/sourceGuards`).
   *
   *  It skips the whole parameter list by balancing parens and bounds the body on the brace whose
   *  match sits in COLUMN 0 on a line of its own, so `format!("… {}s. {}", …)` — braces inside a
   *  STRING — is not structure it has to reason about, and neither is a defaulted parameter or an
   *  inline return type. It THROWS, naming the function, rather than degrading to "" or to the rest
   *  of the file: an empty slice is what turns a guard into a test that cannot fail. */
  function topLevelFn(prod: string, name: string): string {
    const anchors = DEEP_BODY_ANCHORS[name];
    if (!anchors) {
      throw new Error(
        `no deep-body anchor is recorded for \`${name}\` — add one to DEEP_BODY_ANCHORS rather ` +
          "than slicing without it, or this guard can go green on a truncated body",
      );
    }
    return extractTopLevelFunctionBody(prod, name, { anchors });
  }

  /** The `if bound.is_none() { … }` block, bounded the same way one indent level in. */
  function onceOnlyBlock(body: string): { block: string; after: string } {
    const guard = "        if bound.is_none() {\n";
    const start = body.indexOf(guard);
    if (start < 0) {
      throw new Error(
        "supervise no longer opens `if bound.is_none() {` at its expected indent — the whole claim " +
          "that discovery runs AT MOST ONCE rests on that guard, so this cannot be assumed",
      );
    }
    const rest = body.slice(start);
    const close = rest.indexOf("\n        }\n");
    if (close < 0) {
      throw new Error("the `if bound.is_none()` block has no matching close at its own indent");
    }
    return { block: rest.slice(0, close), after: rest.slice(close) };
  }

  function count(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  const whole = readFileSync(RUST_SOURCE, "utf8");

  it("scoped itself to the production half of a file it actually read", () => {
    // Both bounds are properties the slice does NOT guarantee (see `previewSeam.test.ts`): a
    // `mod tests` occurring early would truncate the scan to nearly nothing and every assertion
    // below would pass vacuously, while one near EOF would leave it covering the tests anyway.
    const prod = productionHalf(whole);
    expect(prod.length).toBeGreaterThan(1000);
    expect(whole.length - prod.length).toBeGreaterThan(1000);
  });

  it("never constructs `PreviewState::Serving` in production — the variant is dead as an output", () => {
    const prod = productionHalf(whole);
    // EXACTLY ONE occurrence, and it is a `match` arm in `live_for_reattach` — a READER. Counting
    // rather than pattern-matching a call is deliberate: `finish(` and `transition(` are wrapped
    // across several lines in this file, so any same-line test for "is this a writer" would miss
    // the writer it exists to catch and report a clean bill of health.
    const sites = count(prod, "PreviewState::Serving");
    expect(
      sites,
      "a new `PreviewState::Serving` site appeared in preview.rs's production half. If it WRITES " +
        "the state, the comments in previewCards.ts, previewStore.ts and PreviewCards.tsx that say " +
        "`serving` has no production writer are now false and must be corrected in the same change. " +
        "If it is another predicate READING it, widen this expectation and say so here.",
    ).toBe(1);
    const reader = topLevelFn(prod, "live_for_reattach");
    expect(
      reader,
      "the one `PreviewState::Serving` site must be `live_for_reattach`'s match arm",
    ).toContain("PreviewState::Serving");
  });

  it("runs DISCOVERY at most once, and `listening` is the only transition inside that block", () => {
    const body = topLevelFn(productionHalf(whole), "supervise");
    const { block, after } = onceOnlyBlock(body);

    // Two state ADVANCES in the whole loop, and exactly one of them is inside the once-only guard.
    expect(count(body, ".transition(")).toBe(2);
    expect(count(block, ".transition(")).toBe(1);
    expect(block).toContain("PreviewState::Listening");
    expect(count(after, ".transition(")).toBe(1);

    // The one outside is `ready`, and it is gated by `ReadyWatch::tick` rather than by the guard.
    // That is what keeps "a healthy bound preview emits NOTHING once it is ready" true even though
    // the probe now runs every tick: `tick` hands back a state at most once per server, so there is
    // still nothing to debounce a re-capture off and nothing to stamp a clock from.
    expect(after).toContain("ready.tick(|| http_probe(port), started.elapsed())");
    expect(after).toContain("std::thread::sleep(");
    expect(
      after,
      "a TERMINAL state appeared after the once-only discovery block. The only thing that ends a " +
        "bound server is still the `crashed`/`failed` exit check at the TOP of the loop — giving " +
        "up on the readiness probe must not have become terminal.",
    ).not.toContain("finish(");
  });

  it("probes HTTP outside the once-only block and inside the loop, so it RETRIES", () => {
    const body = topLevelFn(productionHalf(whole), "supervise");
    const { block, after } = onceOnlyBlock(body);

    // ONE call site, and it is not in the discovery block. This is the whole of `sparkle-dlrqb8.2`:
    // inside that block the probe ran exactly once and a single `false` was final, so a dev server
    // that binds its socket before it can answer HTTP (a cold compile, a loaded machine) never
    // reached `ready` and its card never became openable.
    expect(count(body, "http_probe(")).toBe(1);
    expect(count(block, "http_probe(")).toBe(0);
    expect(count(after, "http_probe(")).toBe(1);

    // ...and still inside the loop body, i.e. before the per-tick sleep. Outside it there is no
    // second tick and the "retry" would be a retry in name only.
    expect(after.indexOf("http_probe(")).toBeLessThan(after.indexOf("std::thread::sleep("));
  });

  // ── THE NEGATIVE CONTROL ───────────────────────────────────────────────────────────────────
  // Proof that the assertions above are not vacuous, WITHOUT editing preview.rs: the same bytes are
  // mutated IN MEMORY back into the engine that shipped before `sparkle-dlrqb8.2` — probe once,
  // inside the discovery block, never again — and the checks are re-run against that. This is a
  // stronger control than a hypothetical mutation, because it is the exact regression the fix
  // removes: if someone folds the probe back into the once-only block, these are the assertions
  // that must go red.
  it("would go red if the probe were folded back inside the once-only discovery block", () => {
    const regressed = whole
      .replace(
        "        if let Some(port) = bound {\n" +
          "            if let Some(state) = ready.tick(|| http_probe(port), started.elapsed()) {\n" +
          "                app.state::<PreviewManager>().transition(&app, &id, state, Some(port), None);\n" +
          "            }\n" +
          "        }\n",
        "",
      )
      .replace(
        "                    mark_bound(&app_data, &id, port);",
        "                    if http_probe(port) {\n" +
          "                        app.state::<PreviewManager>().transition(&app, &id, PreviewState::Ready, Some(port), None);\n" +
          "                    }\n" +
          "                    mark_bound(&app_data, &id, port);",
      );
    expect(regressed, "the retry block this mutation removes must still exist verbatim").not.toBe(whole);
    expect(regressed, "…and `mark_bound` must still be where the probe gets folded back in").toContain(
      "if http_probe(port) {",
    );

    const body = topLevelFn(productionHalf(regressed), "supervise");
    const { block, after } = onceOnlyBlock(body);

    // Each of the three claims, now false, and each detected by the assertion that guards it.
    expect(count(block, "http_probe(")).not.toBe(0); // the probe is back inside the guard
    expect(count(after, "http_probe(")).not.toBe(1); // ...and gone from the loop body
    expect(count(block, ".transition(")).not.toBe(1); // both transitions are inside again
  });

  // And the OTHER direction: a supervisor that re-emits while the server is healthy — the engine
  // the false comment described — is still caught, because `ReadyWatch::tick` is what bounds the
  // emissions and a raw `transition(` after the block is not it.
  it("would go red if the engine were changed into the one the false comment described", () => {
    const mutated = whole.replace(
      "        std::thread::sleep(if bound.is_some() { LIVENESS_INTERVAL } else { DISCOVERY_INTERVAL });",
      "        if bound.is_some() {\n" +
        "            app.state::<PreviewManager>().transition(&app, &id, PreviewState::Serving, bound, None);\n" +
        "        }\n" +
        "        std::thread::sleep(if bound.is_some() { LIVENESS_INTERVAL } else { DISCOVERY_INTERVAL });",
    );
    expect(mutated, "the sleep line this mutation targets must still exist").not.toBe(whole);

    const prod = productionHalf(mutated);
    const body = topLevelFn(prod, "supervise");
    const { block, after } = onceOnlyBlock(body);

    expect(count(prod, "PreviewState::Serving")).not.toBe(1);
    expect(count(body, ".transition(")).not.toBe(2);
    expect(count(after, ".transition(")).not.toBe(1);
    expect(block).not.toBe("");
  });
});

// The other direction of bead `sparkle-l7cihu`, and a deliberate NON-change: `serving` is dead as
// an output but must stay live as an INPUT. The wire type still admits it, so a build on the other
// side of the IPC boundary can send it and a frontend that had quietly dropped the state would
// paint a live preview as nothing at all. This is recorded, not acted on — see `SURFACING_STATES`.
describe("`serving` stays handled even though nothing produces it", () => {
  it("keeps `serving` in the surfacing set and in the card projection", () => {
    expect(isSurfacingState("serving")).toBe(true);
    expect(livePreviewCards({ "ag-1": entry({ status: "serving" }) }).map((c) => c.agentId)).toEqual([
      "ag-1",
    ]);
  });
});
