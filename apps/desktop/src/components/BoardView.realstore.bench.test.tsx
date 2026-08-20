// @vitest-environment jsdom
//
// ══ A REACT-LEVEL MEASUREMENT OF THE FOUNDER'S CLICK, AGAINST HIS REAL STORE ══════════════════
//
// `scripts/bench/board-perf.mts` measures the RESOLVER layer — how long the epic lookups take —
// which is where the 5-30 s stall actually lives. It does not measure React. This measures the
// thing the founder physically does: clicking the Tasks toggle to show/hide the task cards, with
// a real `bd list --json` dump loaded, and reports the wall-clock of that click.
//
// ── WHY THIS IS A `.bench.test.tsx` AND IS SKIPPED BY DEFAULT ─────────────────────────────────
// It is a STOPWATCH, and the file that taught this repo not to put stopwatches in the required
// gate is `beads.epicIndex.test.ts` (its complexity block is a read COUNTER for exactly that
// reason). A wall-clock number is the right output for a benchmark and the wrong output for a
// correctness gate, so this runs only when pointed at a dump:
//
//   SPARKLE_BENCH_STORE=/path/to/store.json pnpm --filter @sparkle/desktop exec vitest run \
//     src/components/BoardView.realstore.bench.test.tsx
//
// With no dump it SKIPS rather than fabricating a fixture — a synthetic store would answer a
// different question than the one asked, and answering it in milliseconds would look authoritative.
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bucketBeads, normalizeBead, type Bead, type Board } from "../services/beads";

const STORE = process.env.SPARKLE_BENCH_STORE;

const startPolling = vi.fn();
const stopPolling = vi.fn();
let snapshot: { beads: Bead[]; board: Board; loadedAt: number } | undefined;

function buildState() {
  return {
    byProject: { p1: snapshot } as Record<string, typeof snapshot>,
    loading: {} as Record<string, boolean>,
    error: {} as Record<string, string | undefined>,
    startPolling,
    stopPolling,
  };
}

vi.mock("../stores/beadsStore", () => {
  const useBeadsStore = ((selector?: (s: ReturnType<typeof buildState>) => unknown) => {
    const state = buildState();
    return selector ? selector(state) : state;
  }) as unknown as { (sel?: unknown): unknown; getState: () => ReturnType<typeof buildState> };
  useBeadsStore.getState = () => buildState();
  return { useBeadsStore };
});

vi.mock("../services/deliveryMonitor", () => ({
  startDeliveryMonitor: vi.fn(),
  stopDeliveryMonitor: vi.fn(),
}));

// ── THE SHAPE HERE IS LOAD-BEARING, AND GETTING IT WRONG DELETES WORK SILENTLY ────────────────
// BoardView does `getConfig(root).then((eff) => apply(eff.config))`, and `apply` calls
// `readStageDef(cfg, "done")`, which dereferences `cfg.done`. An earlier version of this mock
// resolved `{ effective: {} }` with no `config` key: the dereference threw, BoardView's own
// `.catch()` swallowed it, `defs` stayed `{}` for the whole run, and every Card rendered with
// `nextStageKey={null}` — so the CardCriteria subtree never mounted for a single card and the
// benchmark timed a strictly cheaper card than the real board, with nothing in the output saying
// so (roborev 65703). Defined criteria are the expensive case, so this seeds them.
// INLINE inside the factory: `vi.mock` is hoisted above every top-level binding, so a `const`
// declared here and referenced in the factory dies with "Cannot access before initialization".
vi.mock("../services/config", () => {
  const stage = {
    description: "Shipped to production.",
    criteria: [{ text: "Deployed", kind: "manual", signal: null }],
  };
  return {
    getConfig: vi.fn().mockResolvedValue({ config: { done: stage, delivered: stage } }),
    // RESOLVES to an unsubscribe function — returning the function directly dies on `.then`.
    onConfigChanged: vi.fn().mockResolvedValue(() => {}),
  };
});

import { BoardView } from "./BoardView";
import { useProjectStore } from "../stores/projectStore";
import { useUiStore } from "../stores/uiStore";
import { PLAN_KINDS_ALL } from "../services/epicBoard";
import type { Project } from "../types";

const project: Project = {
  id: "p1",
  name: "demo",
  rootPath: "/tmp/demo",
  agents: [],
} as unknown as Project;

function loadStore(path: string): Bead[] {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  const rows = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>).issues ??
       (raw as Record<string, unknown>).beads ??
       (raw as Record<string, unknown>).results ??
       (raw as Record<string, unknown>).data);
  if (!Array.isArray(rows)) throw new Error("unrecognised dump shape");
  return rows.map((r) => normalizeBead(r as never));
}

afterEach(() => {
  cleanup();
  snapshot = undefined;
});

describe.skipIf(!STORE)("BoardView — real-store click latency", () => {
  it("times a show/hide Tasks click", async () => {
    const beads = loadStore(STORE!);
    const board = bucketBeads(beads);
    snapshot = { beads, board, loadedAt: Date.now() };
    useProjectStore.setState({ projects: [project], selectedProjectId: project.id });
    // SEEDED EXPLICITLY, because `useUiStore` is persist-wrapped and is not reset between runs. If
    // the persisted state ever had `tasks` off, the hide/show labels below would silently SWAP and
    // still print confident numbers (roborev 65703). These timings get pasted into commit messages,
    // so a mislabelled measurement is worse than a failing test.
    useUiStore.setState({
      planKindsBySide: { left: PLAN_KINDS_ALL, right: PLAN_KINDS_ALL },
    } as never);

    const mounted = () =>
      document.querySelectorAll('[data-testid^="board-card-"]').length;

    const t0 = performance.now();
    render(<BoardView project={project} side="right" />);
    const mountMs = performance.now() - t0;

    // Let the config promise land INSIDE act, so the criteria subtree is mounted before anything is
    // timed and its `setDefs` is not an untimed extra render after the test body.
    await act(async () => { await Promise.resolve(); });

    const toggle = screen.getByTestId("board-plan-kind-tasks");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    const mountedBefore = mounted();
    expect(mountedBefore).toBeGreaterThan(0);

    // HIDE, then SHOW. Not symmetric: hiding unmounts the cards, showing re-mounts them, and it is
    // the re-mount the founder waits on.
    const t1 = performance.now();
    fireEvent.click(toggle);
    const hideMs = performance.now() - t1;
    // THE CLICK DID SOMETHING. Without this, a toggle that stopped filtering entirely would still
    // emit fast, confident numbers under both labels.
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    const mountedHidden = mounted();
    expect(mountedHidden).toBeLessThan(mountedBefore);

    const t2 = performance.now();
    fireEvent.click(toggle);
    const showMs = performance.now() - t2;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(mounted()).toBe(mountedBefore);

    const bucketed =
      board.backlog.length + board.blocked.length + board.inProgress.length +
      board.done.length + board.delivered.length + board.archived.length;

    // BUCKETED AND MOUNTED ARE DIFFERENT NUMBERS AND BOTH ARE PRINTED. Only `mounted_cards` is the
    // DOM these milliseconds paid for: the terminal columns are render-capped and Archived starts
    // collapsed at zero, so on the founder's store bucketed is ~6,800 while mounted is a few
    // hundred. Printing only the first invites normalising ms/card against a denominator an order
    // of magnitude too large — which is exactly the claim this harness was used to make and could
    // not support (roborev 65703).
     
    console.log(
      `\nREAL-STORE CLICK LATENCY\n` +
        `beads\t${beads.length}\n` +
        `bucketed_cards\t${bucketed}\n` +
        `mounted_cards\t${mountedBefore}\n` +
        `mounted_after_hide\t${mountedHidden}\n` +
        `mount_ms\t${mountMs.toFixed(1)}\n` +
        `hide_ms\t${hideMs.toFixed(1)}\n` +
        `show_ms\t${showMs.toFixed(1)}\n`,
    );
    expect(beads.length).toBeGreaterThan(0);
  }, 600_000);
});
