// @vitest-environment jsdom
//
// The cloud-agent creation flow. Two properties matter more than the form itself and are pinned
// here: (1) a blocked precondition is stated honestly AND offers the fix (deep-link to the right
// Settings section / sign-in), and (2) no tab is ever created unless a session really started.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startSession = vi.fn();
const listProjects = vi.fn();
const createProject = vi.fn();
const getClaudeAuth = vi.fn();
vi.mock("../services/cloudAgents/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/cloudAgents/api")>()),
  cloudApi: {
    startSession: (...a: unknown[]) => startSession(...a),
    listProjects: (...a: unknown[]) => listProjects(...a),
    createProject: (...a: unknown[]) => createProject(...a),
    getClaudeAuth: (...a: unknown[]) => getClaudeAuth(...a),
  },
}));
const projectRepoUrl = vi.fn();
vi.mock("../services/cloudAgents/repoUrl", () => ({
  projectRepoUrl: (...a: unknown[]) => projectRepoUrl(...a),
}));
const openSignIn = vi.fn();
vi.mock("../services/sparkleApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/sparkleApi")>()),
  openSignIn: () => openSignIn(),
}));

import { NewCloudAgentDialog } from "./NewCloudAgentDialog";
import { useAuthStore } from "../stores/authStore";
import { useUiStore } from "../stores/uiStore";
import { useCloudAuthStore } from "../stores/cloudAuthStore";
import { useProjectStore } from "../stores/projectStore";
import { CloudApiError } from "../services/cloudAgents/api";
import type { Project } from "../types";

const me = (
  over: Partial<{
    cloudAgentsEnabled: boolean;
    entitled: boolean;
    balanceCents: number;
    /** `null` models an OLDER orchestration server, which sends no price at all. */
    centsPerMinute: number | null;
  }> = {},
) => ({
  clerkUserId: "u",
  entitled: over.entitled ?? true,
  balanceCents: over.balanceCents ?? 5000,
  tokenVersion: 1,
  cloudAgentsEnabled: over.cloudAgentsEnabled ?? true,
  ...(over.centsPerMinute === null
    ? {}
    : { cloudAgentPricing: { centsPerMinute: over.centsPerMinute ?? 0.9, minStartCents: 100 } }),
});

function seedProject(): Project {
  const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  useProjectStore.getState().setCloudProjectId(pid, "srv-1");
  return useProjectStore.getState().projects.find((p) => p.id === pid)!;
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  // Stub `refresh`: the dialog re-reads /me on open (so a running agent's debits are reflected),
  // and the REAL one would clear the `me` these tests just seeded.
  useAuthStore.setState({ me: me(), tokenPresent: true, loading: false, refresh: vi.fn(async () => {}) });
  useUiStore.setState({ settingsRequest: null });
  // "Claude auth saved" is the default so the form (not a block) renders; individual tests override.
  useCloudAuthStore.setState({ method: "byok", loaded: true, busy: false, error: null });
  startSession.mockReset().mockResolvedValue({ sessionId: "sess-1" });
  listProjects.mockReset().mockResolvedValue([]);
  createProject.mockReset();
  getClaudeAuth.mockReset().mockResolvedValue({ method: "byok" });
  projectRepoUrl.mockReset().mockResolvedValue("https://github.com/acme/repo");
  openSignIn.mockReset();
});
afterEach(cleanup);

const typeGoal = (text: string) =>
  fireEvent.change(screen.getByTestId("cloud-goal"), { target: { value: text } });
const clickStart = () => fireEvent.click(screen.getByRole("button", { name: /Start cloud agent/i }));

// THE PRICE, BEFORE THE BUTTON. The founder's ask was "I need to know what the cost of it is" — and
// the honest form of that, for a per-minute meter with an unknown run length, is a rate plus a
// runway rather than a total nobody can compute.
describe("NewCloudAgentDialog — the cost estimate", () => {
  it("states the hourly rate and what the balance funds, from the SERVER's price", () => {
    useAuthStore.setState({ me: me({ balanceCents: 1240 }), tokenPresent: true });
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);

    const line = screen.getByTestId("cloud-cost-estimate").textContent!;
    expect(line).toContain("$0.54/hour");
    expect(line).toContain("23 hours");
  });

  it("follows the server's rate rather than a number baked into the client", () => {
    // The regression that matters if the markup ever changes: a client that kept its own copy of
    // 0.9¢ would still render $0.54 here and quietly lie about what the user is about to be charged.
    useAuthStore.setState({ me: me({ centsPerMinute: 4.5, balanceCents: 1240 }), tokenPresent: true });
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);

    expect(screen.getByTestId("cloud-cost-estimate").textContent).toContain("$2.70/hour");
  });

  // The silent-failure case. `/me` reaches JS through Rust, and before this change the Rust `Me`
  // struct had no pricing field, so serde DROPPED the key and the estimate would have rendered
  // nothing forever while every test that seeded it directly still passed.
  it("renders NOTHING when the server stated no price — never a guessed one", () => {
    useAuthStore.setState({ me: me({ centsPerMinute: null }), tokenPresent: true });
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);

    expect(screen.queryByTestId("cloud-cost-estimate")).toBeNull();
    // And the form is still usable — an unknown price must not become a block.
    expect(screen.getByTestId("cloud-goal")).toBeTruthy();
  });

  // THE FLOOR, AS THIS DIALOG RESOLVES IT. Below the server's `minStartCents` there is no run to
  // quote, and the gate now reads that same number — so what this surface owes the user is the
  // BLOCK with its deep link, not a runway and not a price sentence under a dead button. The floor
  // SENTENCE itself is `cloudCostLine`'s contract and is pinned in its own unit tests; it still has
  // a live consumer in the promote dialog, whose plan captures its gate once at load and can be
  // outlived by a refresh that drops the balance under the floor.
  it("shows the credits BLOCK, not a cost line, below the server's floor", () => {
    useAuthStore.setState({ me: me({ balanceCents: 50 }), tokenPresent: true });
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);

    expect(screen.getByTestId("cloud-gate-block").textContent).toMatch(/credits/i);
    expect(screen.queryByTestId("cloud-cost-estimate")).toBeNull();
  });

  // A running cloud agent debits the ledger every minute and nothing pushes that back to the
  // desktop, so a persisted `me` quotes runtime the user has already spent. Opening the dialog must
  // re-read it. Without this the fix is present but unguarded — the assertion is the ONLY thing
  // standing between "we refresh" and "we used to refresh".
  it("re-reads /me on open, so the quote is not a pre-debit balance", () => {
    const refresh = vi.fn(async () => {});
    useAuthStore.setState({ me: me(), tokenPresent: true, refresh });
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);

    expect(refresh).toHaveBeenCalled();
  });
});

describe("NewCloudAgentDialog — gating UX", () => {
  it("blocks with a deep-link to Claude auth when no credential is saved", () => {
    useCloudAuthStore.setState({ method: null, loaded: true });
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);

    expect(screen.getByTestId("cloud-gate-block").textContent).toMatch(/Claude authentication/i);
    expect(screen.queryByTestId("cloud-goal")).toBeNull(); // nothing useful to type yet
    fireEvent.click(screen.getByRole("button", { name: /Add Claude auth/i }));
    expect(useUiStore.getState().settingsRequest).toBe("cloudauth");
  });

  it("blocks with a deep-link to Credits when the balance can't cover a run", () => {
    useAuthStore.setState({ me: me({ balanceCents: 0 }), tokenPresent: true });
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);
    expect(screen.getByTestId("cloud-gate-block").textContent).toMatch(/credits/i);
    fireEvent.click(screen.getByRole("button", { name: /Open credits/i }));
    expect(useUiStore.getState().settingsRequest).toBe("credits");
  });

  // THE BUTTON AND THE SENTENCE ANSWER TO ONE NUMBER. The cost line quotes the server's
  // `minStartCents`, so a balance under it reads "You need $1.00 to start" — and before the gate was
  // fed the same number it said that under a LIVE Start button, whose start the server then refused.
  // 50¢ clears the client's own "obviously empty" 1¢ floor, so only the server's floor can block it.
  it("blocks below the SERVER's start floor, not just an obviously-empty wallet", () => {
    useAuthStore.setState({ me: me({ balanceCents: 50 }), tokenPresent: true });
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);

    expect(screen.getByTestId("cloud-gate-block").textContent).toMatch(/credits/i);
    expect(screen.queryByTestId("cloud-goal")).toBeNull(); // no form to fill, no start to refuse
  });

  // …and the fallback stays open: an older `/me` carries no floor, so nothing narrows and a balance
  // the server might well accept is not refused locally on a number we never received.
  it("does not invent a floor when the server stated none", () => {
    useAuthStore.setState({ me: me({ balanceCents: 50, centsPerMinute: null }), tokenPresent: true });
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);

    expect(screen.queryByTestId("cloud-gate-block")).toBeNull();
    expect(screen.getByTestId("cloud-goal")).toBeTruthy();
  });

  it("offers sign-in (not Settings) when the block is a signed-out session", () => {
    useAuthStore.setState({ me: me(), tokenPresent: false });
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Sign in/i }));
    expect(openSignIn).toHaveBeenCalledOnce();
  });
});

describe("NewCloudAgentDialog — start", () => {
  it("starts the session with the goal + resolved repo, creates the cloud tab, and closes", async () => {
    const project = seedProject();
    const onClose = vi.fn();
    render(<NewCloudAgentDialog project={project} onClose={onClose} />);

    typeGoal("  Fix the flaky test  ");
    fireEvent.change(screen.getByTestId("cloud-name"), { target: { value: "Flake hunt" } });
    clickStart();

    await waitFor(() => expect(startSession).toHaveBeenCalledOnce());
    expect(startSession).toHaveBeenCalledWith({
      projectId: "srv-1", //           the SERVER project id, not the local one
      goal: "Fix the flaky test", //   trimmed
      repoUrl: "https://github.com/acme/repo",
      name: "Flake hunt",
    });
    // The tab lands in the LOCAL project, keyed by the server session id, runtime cloud.
    await waitFor(() => {
      const agents = useProjectStore.getState().projects[0]!.agents;
      expect(agents.map((a) => [a.id, a.runtime])).toEqual([["sess-1", "cloud"]]);
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("refuses to start when the project's repo can't be resolved — and starts nothing", async () => {
    projectRepoUrl.mockResolvedValue(null);
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);
    typeGoal("do the thing");
    clickStart();

    const err = await screen.findByTestId("cloud-start-error");
    expect(err.textContent).toMatch(/GitHub repository/i);
    expect(startSession).not.toHaveBeenCalled();
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
  });

  it("surfaces the SERVER's refusal with its own fix — 402 → credits, and no tab", async () => {
    startSession.mockRejectedValue(new CloudApiError(402, "insufficient_credits", "no credits"));
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);
    typeGoal("do the thing");
    clickStart();

    const err = await screen.findByTestId("cloud-start-error");
    expect(err.textContent).toMatch(/out of credits/i);
    expect(useProjectStore.getState().projects[0]!.agents).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Open credits/i }));
    expect(useUiStore.getState().settingsRequest).toBe("credits");
  });

  it("routes a server-side missing-auth refusal to the Claude-auth section", async () => {
    startSession.mockRejectedValue(new CloudApiError(400, "claude_auth_required", "no auth"));
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);
    typeGoal("do the thing");
    clickStart();

    await screen.findByTestId("cloud-start-error");
    fireEvent.click(screen.getByRole("button", { name: /Add Claude auth/i }));
    expect(useUiStore.getState().settingsRequest).toBe("cloudauth");
  });

  it("says you're offline (not 'unavailable') when the start can't reach the server", async () => {
    startSession.mockRejectedValue(new Error("Failed to fetch"));
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);
    typeGoal("do the thing");
    clickStart();
    expect((await screen.findByTestId("cloud-start-error")).textContent).toMatch(/offline/i);
  });

  // The session IS running and billing at this point; re-offering Start would spawn a SECOND
  // sandbox for the same goal (roborev 46383).
  it("disables Start after a started-but-untracked create, and says it's already running", async () => {
    const project = seedProject();
    render(<NewCloudAgentDialog project={project} onClose={vi.fn()} />);
    // The project disappears from this window while the start call is in flight (multi-window
    // close), so the store refuses the tab insert.
    useProjectStore.setState({ projects: [], selectedProjectId: null });

    typeGoal("do the thing");
    clickStart();

    const err = await screen.findByTestId("cloud-start-error");
    expect(err.textContent).toMatch(/already running/i);
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /Start cloud agent/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    // …and a second click can't get through to the API.
    clickStart();
    expect(startSession).toHaveBeenCalledOnce();
  });

  it("won't start on an empty goal", () => {
    render(<NewCloudAgentDialog project={seedProject()} onClose={vi.fn()} />);
    typeGoal("   ");
    clickStart();
    expect(startSession).not.toHaveBeenCalled();
  });
});
