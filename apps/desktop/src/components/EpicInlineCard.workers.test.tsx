// @vitest-environment jsdom
//
// THE PRODUCTION SEAM for item 25 — does the epic card actually PAINT the workers?
//
// `planView.workersInEpic.test.ts` proves the resolver answers the right question. It cannot prove
// the card ASKS it: the whole defect was a card calling a correct function with the wrong argument,
// and a unit test of either function is blind to that. Swap `workersInEpic` back to
// `workersForBead` here and the resolver's suite stays green while the card goes blank again —
// this file is what makes that swap red.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null) }));

const { EpicInlineCard } = await import("./EpicInlineCard");
const { useProjectStore } = await import("../stores/projectStore");
type Bead = import("../services/beads").Bead;
type AgentTab = import("../types").AgentTab;

const PROJECT = "p1";
const EPIC_ID = "sparkle-huw924";

function beadOf(id: string, over: Partial<Bead> = {}): Bead {
  return { id, title: id, description: "", status: "open", labels: [], ...over } as Bead;
}

const EPIC = beadOf(EPIC_ID, { type: "epic" });
const CHILD = beadOf(`${EPIC_ID}.1`);
const OTHER_EPIC_CHILD = beadOf("sparkle-elsewhere.1", { parent: "sparkle-elsewhere" });
const BEADS = [EPIC, CHILD, OTHER_EPIC_CHILD];

function seed(agents: Partial<AgentTab>[]) {
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT,
        name: "repo",
        rootPath: "/repo",
        defaultBranch: null,
        createdAt: new Date(0).toISOString(),
        selectedAgentId: null,
        agents,
      },
    ],
  } as never);
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function mount() {
  return render(
    <EpicInlineCard
      bead={EPIC}
      projectId={PROJECT}
      rootPath="/repo"
      allBeads={BEADS}
      onClose={() => {}}
    />,
  );
}

const WORKERS = "epics-bead-card-workers";

describe("the epic card shows the build agents working inside the epic", () => {
  it("PAINTS a worker bound to a CHILD bead — the case that used to render blank", async () => {
    // Nothing is bound to the epic's own id here, which is the normal shape: workers are
    // dispatched against children. Under the old wiring this card showed no Workers field at all.
    seed([{ name: "nightwatch-1", kind: "worker", beadId: CHILD.id }]);
    mount();

    const line = await waitFor(() => screen.getByTestId(WORKERS));
    expect(line.textContent).toContain("nightwatch-1");
  });

  it("leaves out a worker on a DIFFERENT epic's child, with both in the same roster", async () => {
    // Both mounted at once: asserting absence with only the stranger seeded would pass for a card
    // that renders no workers under any circumstances.
    seed([
      { name: "mine", kind: "worker", beadId: CHILD.id },
      { name: "theirs", kind: "worker", beadId: OTHER_EPIC_CHILD.id },
    ]);
    mount();

    const line = await waitFor(() => screen.getByTestId(WORKERS));
    expect(line.textContent).toContain("mine");
    expect(line.textContent).not.toContain("theirs");
  });

  it("renders no Workers field when nothing in the epic is being built", async () => {
    // The field is gated on a non-empty list, so this pins that an EMPTY epic still reads as empty
    // rather than growing a bare label.
    seed([{ name: "theirs", kind: "worker", beadId: OTHER_EPIC_CHILD.id }]);
    const { container } = mount();

    // Wait for the card itself, so "absent" is a statement about the field and not about a card
    // that had not rendered yet.
    await waitFor(() => expect(container.querySelector('[data-testid="epics-bead-card"]')).not.toBeNull());
    expect(screen.queryByTestId(WORKERS)).toBeNull();
  });
});
