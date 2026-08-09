// @vitest-environment jsdom
//
// THE OTHER HALF OF THE SEAM — bead `sparkle-mf501`.
//
// `OpenPrMenu.readinessPublish.test.tsx` proves the PR menu writes what GitHub said into
// `prReadinessStore`. This proves the concierge READS it: that the store's contents reach
// `buildDigest`, and that the sentence the founder actually looked at changes as a result.
//
// WITHOUT THIS FILE THE WIRING IS UNTESTED BY CONSTRUCTION. Delete the third argument from the
// `buildDigest(accountedUnmerged(feed), "unmerged", prReadiness)` call in `ConciergeHost` and every
// other test in this change still passes: the pure suite builds its own readiness object, and the
// publish suite only asserts what lands in the store. The one assertion that can fail is a rendered
// line read out of a mounted host with the store seeded — which is what this is.
//
// WHAT HE SAW, restated because the fixture is it: a row reading "4 need merge in sparkle", clicked
// through to four pull requests of which NONE could be merged (three red on CI, one conflicting).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../services/openProjectTab", () => ({ openProjectTab: vi.fn() }));
// THE WRITER IS STUBBED OUT SO THE READER CAN BE TESTED — and the reason is worth stating, because
// leaving it in made every case here silently green-but-wrong. `ConciergeHost` mounts
// `ConciergePrChip` in its own header, and that chip IS the publisher: on mount, with no probe
// answered, it correctly publishes an EMPTY snapshot — which overwrote the seed these tests set and
// left the line reading as if nothing had ever been read. That is right in production (one writer,
// always the truth) and useless in a test whose subject is what the host does with a NON-empty
// store. `OpenPrMenu.readinessPublish.test.tsx` covers the real writer against the real probe.
vi.mock("./Concierge/ConciergePrChip", () => ({
  ConciergePrChip: () => null,
  prChipScopes: () => [],
}));

import { ConciergeHost } from "./ConciergeHost";
import { useUiStore } from "../stores/uiStore";
import { usePrReadinessStore } from "../stores/prReadinessStore";
import type { ConciergeFeed } from "../useConciergeFeed";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

/** Four agents whose committed work has not reached `main` — the founder's exact fleet shape.
 *
 *  `unmerged` bands `done` (engine/buildSections) and is GRAY, not an alarm: that is the standing
 *  position in `engine/agentStall` this change had to preserve rather than overturn. */
function unmergedFeed(ids: string[]): ConciergeFeed {
  const agents = ids.map((id) => ({
    id,
    name: id,
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status: "unmerged",
    statusColor: "#8a8a8a",
    statusLabel: "Needs merge",
    band: "done",
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
  }));
  const counts = { needs_you: 0, questions: 0, running: 0, done: agents.length };
  return {
    projects: [{ id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents }],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

const FOUR = ["a1581", "a1560", "a1535", "a1308"];
const line = () => screen.getByTestId("concierge-unmerged-digest").textContent ?? "";

beforeEach(() => {
  enableAiEnhancementsForTests();
  useUiStore.getState().showAllStatusBands();
  usePrReadinessStore.setState({ probedProjectIds: [], readyAgentIds: [] });
});
afterEach(cleanup);

describe("the 'need merge' line reports what a click can actually do", () => {
  // THE REPRODUCTION. Four agents, the project probed, not one of their PRs mergeable.
  it("says none are ready when GitHub would refuse all four", () => {
    usePrReadinessStore.setState({ probedProjectIds: ["p1"], readyAgentIds: [] });
    render(<ConciergeHost feed={unmergedFeed(FOUR)} />);
    expect(line()).toContain("4 need merge in sparkle · none ready yet");
  });

  // AND THE OUTSTANDING WORK IS STILL THERE. His literal ask was to hide the row until everything is
  // green; doing that would have deleted three real pull requests from the one surface that reports
  // what he owes. The count stays four — only the promise is qualified.
  it("still reports all four, rather than filtering the red ones away", () => {
    usePrReadinessStore.setState({ probedProjectIds: ["p1"], readyAgentIds: [] });
    render(<ConciergeHost feed={unmergedFeed(FOUR)} />);
    expect(line()).toContain("4 need merge");
    expect(line()).not.toContain("0 need merge");
  });

  it("names how many are ready once some go green", () => {
    usePrReadinessStore.setState({
      probedProjectIds: ["p1"],
      readyAgentIds: ["a1581", "a1560"],
    });
    render(<ConciergeHost feed={unmergedFeed(FOUR)} />);
    expect(line()).toContain("4 need merge in sparkle · 2 ready");
  });

  // NO PROBE, NO CLAIM. Before the first three-minute poll — or on a machine with no `gh` — the line
  // falls back to the sentence it always had. Saying "none ready yet" there would be a denial we
  // cannot support, which is the same defect as the promise, wearing the opposite sign.
  it("says nothing about readiness before a probe has answered", () => {
    render(<ConciergeHost feed={unmergedFeed(FOUR)} />);
    expect(line()).toContain("4 need merge in sparkle");
    expect(line()).not.toContain("ready");
  });

  // The readiness set is keyed by AGENT, so a green PR belonging to someone this line does not count
  // cannot inflate its actionable half.
  it("ignores a ready agent that is not in this line", () => {
    usePrReadinessStore.setState({ probedProjectIds: ["p1"], readyAgentIds: ["someone-else"] });
    render(<ConciergeHost feed={unmergedFeed(FOUR)} />);
    expect(line()).toContain("4 need merge in sparkle · none ready yet");
  });
});
