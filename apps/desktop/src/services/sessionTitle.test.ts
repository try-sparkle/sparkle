// Sparkle's own system text must never become an agent's NAME.
//
// THE CHAIN, as the founder hit it. An agent boots with no brief and sits silent. The nudge ladder
// pings it. That ping is written into the PTY, so it lands in the transcript as an ordinary user
// turn — indistinguishable from the founder typing — and it is the ONLY user turn there is. Claude
// Code derives the session `ai-title` from it, and this bridge adopted that title as the agent's
// name. Rows appeared reading "Sparkle-nudge automated ping"; the founder asked three times whether
// the naming system was broken, and reasonably read those rows as orchestrators doing nudge work.
// Measured on one machine: 112 transcripts carry a nudge-derived title.
//
// WHAT THESE TESTS PIN is the SIDE EFFECT — the agent's name in the store — not the fact that some
// predicate was consulted. Every case drives the real `refreshAgentTitle` entry point against the
// real store, and the refusal case is PAIRED with an acceptance case on the same fixture: a test
// that only proves a name did not change is ambiguous (a typo'd command name would pass it just as
// well), so the pair is what shows the refusal is caused by the nudge and by nothing else.
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("./ipc", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
// Fires only on the backfill path and reaches analytics; irrelevant to naming.
vi.mock("./selfReportObservability", () => ({ reportNamingOutcome: vi.fn() }));

import { refreshAgentTitle } from "./sessionTitle";
import { useProjectStore } from "../stores/projectStore";
import { NUDGE_PROMPT_MARKER, RESUME_PROMPT_MARKER } from "../engine/agentOriginated";
import type { AgentTab, Project } from "../types";

const WORKTREE = "/tmp/proj/.sparkle/worktrees/build-18";

/** The provisional name an agent that has done nothing actually carries. */
const PROVISIONAL = "Build 18";

function seed(): void {
  const agent = {
    id: "a1",
    name: PROVISIONAL,
    kind: "build",
    parentId: null,
    runtime: "local",
    worktreePath: WORKTREE,
    branch: null,
    baseBranch: "main",
    lastPrompt: "",
    promptHistory: [],
    namePinned: false, // unpinned + not self-named is exactly when a title WOULD be adopted
    selfNamed: false,
    autoNameBasis: null,
    autoNameVariants: null,
    shellCommand: null,
  } as unknown as AgentTab;
  const project = {
    id: "p1",
    name: "sparkle",
    rootPath: "/tmp/proj",
    defaultBranch: "main",
    createdAt: new Date(0).toISOString(),
    selectedAgentId: "a1",
    agents: [agent],
  } as unknown as Project;
  useProjectStore.setState({ projects: [project] } as never);
}

function nameOf(): string | undefined {
  return useProjectStore
    .getState()
    .projects.find((p) => p.id === "p1")
    ?.agents.find((a) => a.id === "a1")?.name;
}

/**
 * The real ping, built from the marker the Rust ladder anchors on rather than a retyped copy.
 * `agentOriginated.test.ts` already pins `NUDGE_PROMPT_MARKER` character-for-character against
 * `nudge_ladder.rs`, so a reword on the Rust side fails there instead of silently blinding this.
 */
const NUDGE_PING =
  `${NUDGE_PROMPT_MARKER}1 · no output for 4m 5s] Automated ping, not a new task. Resume your ` +
  `goal. Reply with ONE line: blocked-on-human | not-blocked | no-task-assigned — plus the exact ` +
  `command or permission you need.`;

beforeEach(() => {
  invoke.mockReset();
  seed();
});

describe("a title derived from Sparkle's own text is refused", () => {
  it("keeps the provisional name when the only transcript turn is a NUDGE", async () => {
    invoke.mockResolvedValue({
      // The real shape the founder saw on the row.
      title: "Sparkle-nudge automated ping",
      firstPrompt: NUDGE_PING,
    });

    await refreshAgentTitle("p1", "a1", WORKTREE);

    // "Build 18" is honest about having done nothing; the ping text actively misleads.
    expect(nameOf()).toBe(PROVISIONAL);
  });

  it("ADOPTS the very same title when a human opened the transcript — the paired case", async () => {
    // Identical title, identical everything, one field different. Without this the test above
    // would pass just as well against a broken IPC call or a store that never updates.
    invoke.mockResolvedValue({
      title: "Sparkle-nudge automated ping",
      firstPrompt: "Fix the nudge ladder so it stops pinging agents whose goal is met",
    });

    await refreshAgentTitle("p1", "a1", WORKTREE);

    expect(nameOf()).toBe("Sparkle-nudge automated ping");
  });

  it("refuses a title whose WORDING is innocent — 39 measured sessions look like this", async () => {
    // The tell is never the title. Claude Code often summarizes the ping into ordinary prose, and a
    // fix that matched nudge-looking titles would miss every one of these.
    invoke.mockResolvedValue({ title: "Resume Task Progress", firstPrompt: NUDGE_PING });

    await refreshAgentTitle("p1", "a1", WORKTREE);

    expect(nameOf()).toBe(PROVISIONAL);
  });

  it("does NOT rename an agent that is legitimately WORKING ON the nudge ladder", async () => {
    // 19 measured sessions carry a nudge-ish title from a real first turn. Matching the title text
    // would have stripped the honest name off exactly these agents.
    invoke.mockResolvedValue({
      title: "Fix sparkle-nudge loop for completed goals",
      firstPrompt: "You own bead sparkle-pgkbn4. The founder hit a concrete instance of this…",
    });

    await refreshAgentTitle("p1", "a1", WORKTREE);

    expect(nameOf()).toBe("Fix sparkle-nudge loop for completed goals");
  });

  it("refuses the auto-resume banner too — the rule is system-authored, not nudge-only", async () => {
    invoke.mockResolvedValue({
      title: "Resume Goal Not Met",
      firstPrompt: `${RESUME_PROMPT_MARKER} automatically. Your goal: ship the thing.`,
    });

    await refreshAgentTitle("p1", "a1", WORKTREE);

    expect(nameOf()).toBe(PROVISIONAL);
  });
});

describe("no evidence is not proof of a clean transcript — fail OPEN", () => {
  it("adopts the title when Rust could not read a first turn", async () => {
    // `firstPrompt: null` means the transcript was unreadable or held no human turn in the sniff
    // window. Refusing here would silently stop naming agents whose transcripts merely read oddly.
    invoke.mockResolvedValue({ title: "Ship The Retry Fix", firstPrompt: null });

    await refreshAgentTitle("p1", "a1", WORKTREE);

    expect(nameOf()).toBe("Ship The Retry Fix");
  });

  it("leaves the name alone when there is no title yet", async () => {
    invoke.mockResolvedValue(null);

    await refreshAgentTitle("p1", "a1", WORKTREE);

    expect(nameOf()).toBe(PROVISIONAL);
  });

  it("survives a backend error without breaking the poll", async () => {
    invoke.mockRejectedValue(new Error("transcript vanished"));

    await expect(refreshAgentTitle("p1", "a1", WORKTREE)).resolves.toBeUndefined();
    expect(nameOf()).toBe(PROVISIONAL);
  });
});
