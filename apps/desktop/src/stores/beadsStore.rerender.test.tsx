// @vitest-environment jsdom
//
// THE MEASUREMENT. Counts REAL React re-renders of N memoized rows across repeated polls.
//
// ══ WHY A RENDER COUNT AND NOT A `store.subscribe` COUNT ═══════════════════════════════════════
// zustand notifies every subscriber on every `set`, and `refresh` legitimately flips
// `loading` true→false around each fetch — so raw notification counts stay non-zero after this fix
// and would understate nothing but also prove nothing. What costs the founder time is `AgentRow`
// re-running its ~2,200-line body (`epicForBuild` is O(agents × beads), `epicPillFor` allocates a
// fresh 4-way concatenated array, plus a `beads.filter`, `stallReport`, `thrashReportFor`). That is
// a RENDER, and a render is what this file counts.
//
// ══ THIS FILE IS DELIBERATELY PORTABLE TO THE PRE-FIX STORE ════════════════════════════════════
// It imports ONLY `useBeadsStore` and `__resetBeadsRefreshInFlightForTest`, both of which predate
// the fix, so `git stash push apps/desktop/src/stores/beadsStore.ts && vitest run <this file>`
// produces the BEFORE number from the same assertions rather than from a hand-built model of the
// old code. The PR body quotes both runs.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import type { Bead } from "../services/beads";

const listBeads = vi.fn();
const blockedBeadIdsOrNull = vi.fn();
vi.mock("../services/beads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/beads")>();
  return {
    ...actual,
    listBeads: (...a: unknown[]) => listBeads(...a),
    blockedBeadIdsOrNull: (...a: unknown[]) => blockedBeadIdsOrNull(...a),
    ensureBeadsDb: vi.fn(),
  };
});
vi.mock("../services/epicDecompose", () => ({ runDecomposeWatcherForPoll: vi.fn() }));

import { useBeadsStore, __resetBeadsRefreshInFlightForTest } from "./beadsStore";
import { useSettingsStore } from "./settingsStore";

/** The founder's real fleet size — the number this whole change is about. */
const ROWS = 60;
/** Six polls ≈ 30 seconds of real polling at BEADS_POLL_INTERVAL_MS. */
const POLLS = 6;

function bead(partial: Partial<Bead> & { id: string }): Bead {
  return {
    title: "",
    description: "",
    status: "open",
    labels: [],
    parent: null,
    commentCount: 0,
    ...partial,
  };
}

/** A backlog roughly the size of this repo's real one (~900 beads as of 2026-07). */
function backlog(n: number, salt = ""): Bead[] {
  return Array.from({ length: n }, (_, i) =>
    bead({
      id: `sparkle-${i}`,
      title: `bead ${i}${salt}`,
      description: `body ${i}`,
      status: i % 3 === 0 ? "in_progress" : i % 5 === 0 ? "closed" : "open",
      labels: i % 4 === 0 ? ["agent-feedback"] : [],
    }),
  );
}

let renders = 0;

/**
 * A stand-in for `AgentRow`: `React.memo`'d, selecting exactly the two slices AgentSidebar.tsx
 * selects (~4222 and ~4228). It does no work in its body beyond counting, because the point is
 * WHETHER the body runs at all — the real body's cost is described in the header.
 */
const NO_BEADS: Bead[] = [];
const Row = React.memo(function Row({ projectId }: { projectId: string }) {
  useBeadsStore((s) => s.byProject[projectId]?.beads ?? NO_BEADS);
  useBeadsStore((s) => s.byProject[projectId]?.board ?? null);
  renders++;
  return null;
});

function Fleet({ projectId }: { projectId: string }) {
  return (
    <>
      {Array.from({ length: ROWS }, (_, i) => (
        <Row key={i} projectId={projectId} />
      ))}
    </>
  );
}

/** One successful poll through the real production entry point, flushed into React. */
async function poll(projectId: string, beads: Bead[]): Promise<void> {
  // Fresh objects each time — a real `bd` read never hands back the same array.
  listBeads.mockResolvedValueOnce(beads.map((b) => ({ ...b, labels: [...b.labels] })));
  blockedBeadIdsOrNull.mockResolvedValueOnce(new Set<string>());
  await act(async () => {
    await useBeadsStore.getState().refresh(projectId, "/proj");
  });
}

beforeEach(() => {
  renders = 0;
  listBeads.mockReset();
  blockedBeadIdsOrNull.mockReset();
  blockedBeadIdsOrNull.mockResolvedValue(new Set<string>());
  useBeadsStore.setState({ byProject: {}, loading: {}, error: {} });
  __resetBeadsRefreshInFlightForTest();
});

afterEach(() => {
  cleanup();
  useSettingsStore.setState({ beadsEnabled: true });
});

describe(`${ROWS} memoized rows × ${POLLS} polls`, () => {
  it("re-renders ZERO times when the backlog does not change", async () => {
    const content = backlog(900);
    // Seed + mount, so the mount renders are not counted as poll-driven churn.
    await poll("p1", content);
    render(<Fleet projectId="p1" />);
    expect(renders).toBe(ROWS); // the mount itself
    renders = 0;

    for (let i = 0; i < POLLS; i++) await poll("p1", content);

    // BEFORE this fix: ROWS × POLLS = 360. AFTER: 0.
    expect(renders).toBe(0);
    // The polls really happened — 1 seed + POLLS. Without this a broken mock would make `0` vacuous.
    expect(listBeads).toHaveBeenCalledTimes(POLLS + 1);
  });

  it("PAIRED: re-renders every row on every poll when the backlog DOES change", async () => {
    // The negative that makes the zero above meaningful. A comparator hard-wired to "unchanged"
    // would score 0 here too — and would freeze the sidebar forever.
    await poll("p1", backlog(900, "-v0"));
    render(<Fleet projectId="p1" />);
    renders = 0;

    for (let i = 0; i < POLLS; i++) await poll("p1", backlog(900, `-v${i + 1}`));

    expect(renders).toBe(ROWS * POLLS);
  });

  it("re-renders exactly once per row for a single real change amid unchanged polls", async () => {
    // The founder-visible behaviour in one case: quiet while nothing moves, immediate when it does.
    const stable = backlog(900);
    await poll("p1", stable);
    render(<Fleet projectId="p1" />);
    renders = 0;

    await poll("p1", stable);
    await poll("p1", stable);
    expect(renders).toBe(0);

    await poll("p1", backlog(900, "-moved"));
    expect(renders).toBe(ROWS);

    await poll("p1", backlog(900, "-moved"));
    expect(renders).toBe(ROWS); // and quiet again
  });
});
