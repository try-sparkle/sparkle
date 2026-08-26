// The stall sweep's restart hands the resumed orchestrator the epic's PRD BY PATH, and that path
// is now resolved structured-first. Driven through the PRODUCTION `restart` seam — `opts.restart`
// is deliberately NOT injected here, because the resolve lives inside that default and a test that
// injects its own restart would leave the line under test executed by nothing.
import { describe, expect, it, vi } from "vitest";

const sendToBuildMock = vi.fn(async (_args: unknown) => ({
  agentId: "agent-1",
  verdict: "restarted" as const,
}));
vi.mock("./sendToBuild", async (orig) => ({
  ...(await orig<typeof import("./sendToBuild")>()),
  sendToBuildAwaited: (args: unknown) => sendToBuildMock(args),
}));

import { sweepEpics } from "./epicSweepRunner";
import type { Bead } from "./beads";
import { EPIC_STALL_MS } from "../engine/epicContinuation";
import type { AgentTab } from "../types";

const NOW = 1_700_000_000_000;
const iso = (t: number) => new Date(t).toISOString();
const STALE = NOW - EPIC_STALL_MS - 60_000;

const PROSE_PATH = "PRD/stale-prose-path.md";
const METADATA_PATH = "PRD/recorded-in-metadata.md";

const bead = (over: Partial<Bead> & { id: string }): Bead => ({
  title: over.id,
  description: "",
  status: "open",
  labels: [],
  parent: null,
  commentCount: 0,
  ...over,
});

const buildAgent = (over: Partial<AgentTab> & { id: string }): AgentTab =>
  ({ name: over.id, kind: "build", ...over }) as AgentTab;

/** One abandoned epic whose body still names an OLD PRD — the case the sweep exists for, in the
 *  one shape where the structured field and the prose line disagree. */
const BEADS: Bead[] = [
  bead({
    id: "e1",
    title: "Ship the thing",
    type: "epic",
    description: `Ship it.\n\nPRD file: ${PROSE_PATH}`,
  }),
  bead({ id: "e1.1", parent: "e1", updatedAt: iso(STALE) }),
];

function sweep(prdIndex: ReadonlyMap<string, string>) {
  sendToBuildMock.mockClear();
  return sweepEpics({
    now: NOW,
    ownsProject: () => true,
    projects: [
      {
        id: "p1",
        rootPath: "/proj",
        agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })],
      },
    ],
    beadsFor: () => BEADS,
    aliveFor: () => false,
    restartEnabled: true,
    prdIndexFor: async () => prdIndex,
    mark: vi.fn(async () => {}),
    setLabel: vi.fn(async () => {}),
    notify: vi.fn(() => true),
    canNotify: () => true,
    audit: vi.fn(async () => {}),
  });
}

describe("sweepEpics — the restart's PRD path", () => {
  it("hands over the METADATA path even though the description names a different one", async () => {
    await sweep(new Map([["e1", METADATA_PATH]]));
    expect(sendToBuildMock).toHaveBeenCalledTimes(1);
    expect(sendToBuildMock.mock.calls[0]?.[0]).toMatchObject({
      epicId: "e1",
      prdPath: METADATA_PATH,
    });
  });

  it("PAIRED NEGATIVE — with no metadata it hands over the PARSED prose path", async () => {
    await sweep(new Map());
    expect(sendToBuildMock.mock.calls[0]?.[0]).toMatchObject({
      epicId: "e1",
      prdPath: PROSE_PATH,
    });
  });

  it("asks the index for THIS project's checkout path", async () => {
    const prdIndexFor = vi.fn(async () => new Map<string, string>());
    sendToBuildMock.mockClear();
    await sweepEpics({
      now: NOW,
      ownsProject: () => true,
      projects: [
        {
          id: "p1",
          rootPath: "/proj",
          agents: [buildAgent({ id: "a1", epicId: "e1", createdAt: STALE - 60_000 })],
        },
      ],
      beadsFor: () => BEADS,
      aliveFor: () => false,
      restartEnabled: true,
      prdIndexFor,
      mark: vi.fn(async () => {}),
      setLabel: vi.fn(async () => {}),
      notify: vi.fn(() => true),
      canNotify: () => true,
      audit: vi.fn(async () => {}),
    });
    expect(prdIndexFor).toHaveBeenCalledWith("/proj");
  });
});
