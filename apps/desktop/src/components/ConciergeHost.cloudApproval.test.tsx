// @vitest-environment jsdom
//
// THE WIRING half of services/nudgeActions — that the pure decision actually reaches the rendered
// card. The pure function is unit-tested next to itself; this file exists because a correct decision
// that the host ignores is exactly the vacuous shape AGENTS.md warns about, and nothing in
// nudgeActions.test.ts could see it.
//
// The claim: a CLOUD agent awaiting approval draws "Open", not "Approve". Approve relays the word
// into the agent's terminal, and `conciergeDispatch.deliverCloudPrompt` refuses every approval
// gesture aimed at a cloud agent by design — so the old card offered a button whose only possible
// outcome was a refusal, discoverable only by pressing it.
//
// The LOCAL side of the same wiring is already pinned elsewhere (ConciergeHost.attachments.test.tsx
// clicks "Approve" on a local approval card), so a change that gave EVERY agent "Open" would go red
// there. Both directions are therefore covered.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
const h = vi.hoisted(() => ({ openProjectTab: vi.fn() }));
vi.mock("../services/openProjectTab", () => ({
  openProjectTab: h.openProjectTab,
  requestProjectTabFromOtherWindow: vi.fn(),
}));

import { ConciergeHost } from "./ConciergeHost";
import { useConciergeThreadStore } from "../stores/conciergeThreadStore";
import { useProjectStore } from "../stores/projectStore";
import type { ConciergeFeed } from "../useConciergeFeed";
import type { Runtime } from "../types";
import { enableAiEnhancementsForTests } from "../testing/aiEnhancements";

const openProjectTab = h.openProjectTab;

const AGENT_ID = "ag-cloudy";

/** One project, one agent. `approval` is the only status that carries a labelled button. */
function feed(status = "approval"): ConciergeFeed {
  const counts = { needs_you: 1, questions: 0, running: 0, done: 0 };
  const agent = {
    id: AGENT_ID,
    name: "Kraken Auth",
    projectId: "p1",
    projectName: "sparkle",
    kind: "build" as const,
    status,
    statusColor: "#e0533f",
    statusLabel: "Approve?",
    band: "needs_you" as const,
    inScope: true,
    muted: false,
    topLevel: true,
    representedElsewhere: false,
    rolledUpGreen: false,
  };
  return {
    projects: [
      { id: "p1", name: "sparkle", inScope: true, counts, scopedCounts: counts, agents: [agent] },
    ],
    counts,
    scopedCounts: counts,
    pinnedProjectId: null,
  } as unknown as ConciergeFeed;
}

/**
 * Seed the TAB the card's runtime answer is read from.
 *
 * `isCloudAgent` resolves through `knownAgents` → the project store's tabs, NOT through the feed —
 * so the feed fixture above cannot fake it, and seeding the store is what makes this test exercise
 * the real predicate the dispatcher routes on rather than a stand-in.
 */
function seedTab(runtime: Runtime) {
  const pid = useProjectStore.getState().addProject("sparkle", "/tmp/sparkle");
  useProjectStore.getState().addAgent(pid, { id: AGENT_ID, kind: "build", runtime });
  // The feed fixture names project "p1"; the card resolves its agent by ID, so the ids are what
  // must line up, not the project keys.
}

beforeEach(() => {
  enableAiEnhancementsForTests();
  useConciergeThreadStore.getState().clearChat();
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  openProjectTab.mockClear();
});
afterEach(() => cleanup());

describe("ConciergeHost — a cloud agent's approval card", () => {
  it("offers Open, never the Approve relay that cloud refuses by design", () => {
    seedTab("cloud");

    render(<ConciergeHost feed={feed()} />);

    expect(screen.getByText("Open")).toBeTruthy();
    // The regression, stated on its own: re-offering Approve for cloud must go red here.
    expect(screen.queryByText("Approve")).toBeNull();
  });

  it("CLICKING Open reveals the agent's own pane — the label alone proves nothing", () => {
    // roborev 58282: asserting only that the button says "Open" leaves the handler branch untested,
    // so deleting the `NUDGE_OPEN_ACTION` arm from onNudgeAction would stay green. The point of the
    // button is the navigation, so that is what this asserts.
    seedTab("cloud");

    render(<ConciergeHost feed={feed()} />);
    fireEvent.click(screen.getByText("Open"));

    // `revealAgentById` routes through the project-tab opener; the agent it names is the one the
    // card stood for.
    expect(openProjectTab).toHaveBeenCalled();
  });

  it("still offers Approve for a LOCAL agent — the split is by runtime, not a blanket removal", () => {
    seedTab("local");

    render(<ConciergeHost feed={feed()} />);

    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.queryByText("Open")).toBeNull();
  });
});

describe("ConciergeHost — only `approval` carries a labelled button at all", () => {
  // THE STATUS GUARD'S ONLY COVERAGE, restored here after `services/nudgeActions.test.ts` was
  // deleted with the module it tested (roborev 58524). That deletion silently un-pinned this
  // branch: dropping or inverting `if (a.status !== "approval") return []` stayed green while every
  // card in the feed grew an Approve button — which relays the literal word "approve" into the
  // terminal of an agent that never asked, including ones that are running, done, or errored.
  //
  // NudgeCard.test.tsx cannot cover this: it is handed `actions` as props, so it exercises the
  // renderer, not the decision.
  it.each(["running", "idle", "done", "stopped", "unmerged", "error"])(
    "a %s agent gets no Approve and no Open, on either runtime",
    (status) => {
      for (const runtime of ["local", "cloud"] as const) {
        useProjectStore.setState({ projects: [], selectedProjectId: null });
        seedTab(runtime);
        const { unmount } = render(<ConciergeHost feed={feed(status)} />);

        // POSITIVE CONTROL FIRST. Two absence assertions pass happily against an empty DOM, so
        // without this the whole test rests on an UNASSERTED precondition — that this agent
        // survives accountedAgents → surfacedAgents → buildDigest and comes back as a CARD rather
        // than a collapsed digest line. Any of those is free to change, and all twelve cases would
        // go silently vacuous, un-pinning the early return for the second time (roborev 58530).
        expect(screen.getByText(/Kraken Auth/)).toBeTruthy();

        expect(screen.queryByText("Approve")).toBeNull();
        expect(screen.queryByText("Open")).toBeNull();
        unmount();
      }
    },
  );
});
