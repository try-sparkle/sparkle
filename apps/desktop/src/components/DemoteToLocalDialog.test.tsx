// @vitest-environment jsdom
//
// THE LAST SCREEN BEFORE A SANDBOX IS DESTROYED.
//
// Demotion is the mirror of promotion, and spec Decision 1 makes its copy load-bearing in a way
// promotion's is not: there is NO "leave it behind" option, because there is nowhere to leave it —
// a sandbox does not survive this. So the dialog has to STATE, before the confirm button can be
// reached, that (a) anything uncommitted is committed and pushed, (b) the sandbox is destroyed and
// nothing outside git survives it, and (c) the conversation is downloaded through Sparkle onto this
// machine. These tests assert what is RENDERED and what confirm actually DOES, never that the
// component mounted.
//
// The plan is handed in as a value rather than derived, so every case is a pure statement about the
// dialog: given this plan, the user sees this. `planDemotion` has its own tests (§W3).
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  DemoteToLocalDialog,
  demoteDialogDeps,
  type DemoteToLocalDeps,
} from "./DemoteToLocalDialog";
import * as demoteModule from "../services/agentDemotion/demote";
import { useProjectStore } from "../stores/projectStore";
import type { Project, AgentTab } from "../types";
import { CLOUD_WIP_COMMIT_MESSAGE, type DemotionPlan } from "../services/agentDemotion/plan";
import type { DemoteResult } from "../services/agentDemotion/demote";

const AGENT = { id: "tab-1", name: "Retry Hardening" };

function okPlan(over: Partial<Extract<DemotionPlan, { ok: true }>> = {}): DemotionPlan {
  return { ok: true as const, branch: "sparkle/agent-42", warnings: [], ...over };
}

const landed = (over: Partial<Extract<DemoteResult, { ok: true }>> = {}): DemoteResult => ({
  ok: true,
  worktree: "/tmp/wt/agent-42",
  transcriptMoved: true,
  createdWorktree: false,
  // Required, not optional, on the real DemoteResult: a transcript that MOVED can still have been
  // truncated. The contract stub this test was written against had it optional, which let the
  // default silently omit the case. Defaulted false here, with the true case driven explicitly
  // below — a default that covers a case is a case nothing tests.
  transcriptTruncated: false,
  ...over,
});

function mount(plan: DemotionPlan, demote?: DemoteToLocalDeps["demote"], repairOk = true) {
  const calls: Array<{ steps: string[] }> = [];
  const deps: DemoteToLocalDeps = {
    loadPlan: () => Promise.resolve(plan),
    repairRuntime: () => repairOk,
    demote:
      demote ??
      (async () => {
        calls.push({ steps: [] });
        return landed();
      }),
  };
  const onClose = vi.fn();
  render(<DemoteToLocalDialog agent={AGENT} deps={deps} onClose={onClose} />);
  return { calls, onClose };
}

afterEach(cleanup);

describe("what the user is told before they can confirm", () => {
  it("names the branch the work comes back on", async () => {
    mount(okPlan());
    expect((await screen.findByTestId("demote-branch")).textContent).toBe("sparkle/agent-42");
  });

  // Decision 1, first half: the dirty state is committed and PUSHED, and the dialog says so rather
  // than offering a choice it cannot honour.
  it("states that uncommitted sandbox work is committed and pushed, with no leave-it-behind option", async () => {
    mount(okPlan());
    const text = (await screen.findByTestId("demote-commits-everything")).textContent!;
    expect(text).toMatch(/committed and pushed/i);
    expect(text).toMatch(/no option to leave it behind/i);
    // And it names the branch it pushes to — "pushed somewhere" is not a disclosure.
    expect(text).toContain("sparkle/agent-42");
  });

  it("shows the exact commit message it will write, so nothing appears in history unannounced", async () => {
    mount(okPlan());
    expect((await screen.findByTestId("demote-wip-message")).textContent).toBe(
      CLOUD_WIP_COMMIT_MESSAGE,
    );
  });

  // Decision 1, second half. This is the sentence that distinguishes demotion from promotion: the
  // machine on the other end is about to cease to exist.
  it("says the sandbox is destroyed and nothing outside git survives it", async () => {
    mount(okPlan());
    const text = (await screen.findByTestId("demote-sandbox-destroyed")).textContent!;
    expect(text).toMatch(/destroyed/i);
    expect(text).toMatch(/nothing outside git survives/i);
    expect(text).toMatch(/gitignore/i);
  });

  // Decision 4: the exposure runs the other way from promotion's and is smaller, but the download
  // onto the user's own machine — through Sparkle's servers — is still stated.
  it("says the conversation is downloaded onto this machine, and what happens when it can't be", async () => {
    mount(okPlan());
    const text = (await screen.findByTestId("demote-conversation")).textContent!;
    expect(text).toMatch(/downloads this agent's Claude Code conversation onto this machine/i);
    expect(text).toMatch(/Sparkle's servers/i);
    expect(text).toMatch(/briefing/i);
  });

  // Rendered, not counted or summarised — the plan puts the situational truths here.
  it("renders EVERY warning the plan produced", async () => {
    mount(
      okPlan({
        warnings: [
          "this agent has no local worktree yet",
          "3 commits are already on origin",
          "the conversation may be truncated",
        ],
      }),
    );
    await waitFor(() => expect(screen.getAllByTestId("demote-warning")).toHaveLength(3));
    const text = screen
      .getAllByTestId("demote-warning")
      .map((n) => n.textContent)
      .join(" ");
    expect(text).toContain("this agent has no local worktree yet");
    expect(text).toContain("the conversation may be truncated");
  });

  // The whole ordering rule in one assertion: everything above is on screen at the moment the
  // confirm button becomes usable, and using it actually starts the demotion.
  it("has all three disclosures on screen when the confirm button is live, and confirming runs it", async () => {
    const { calls } = mount(okPlan({ warnings: ["workers stay where they are"] }));
    const button = (await screen.findByTestId("demote-confirm")) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.getByTestId("demote-commits-everything")).toBeTruthy();
    expect(screen.getByTestId("demote-sandbox-destroyed")).toBeTruthy();
    expect(screen.getByTestId("demote-conversation")).toBeTruthy();
    expect(screen.getAllByTestId("demote-warning")).toHaveLength(1);

    fireEvent.click(button);
    await waitFor(() => expect(calls).toHaveLength(1));
  });
});

describe("refusals and failures", () => {
  it("renders a refusal instead of a confirm button", async () => {
    mount({
      ok: false,
      refusal: "no_branch",
      message: "This cloud agent has no branch recorded, so there is nothing to bring down.",
    });
    expect((await screen.findByTestId("demote-refusal")).textContent).toContain(
      "nothing to bring down",
    );
    expect(screen.queryByTestId("demote-confirm")).toBeNull();
  });

  // The single most important sentence on a failure: their agent is fine, and still in the cloud.
  it("names the failed step and says the CLOUD agent is still running", async () => {
    mount(okPlan(), async () => ({
      ok: false,
      step: "land",
      message: "dirty: src/a.ts, src/b.ts",
    }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    const err = await screen.findByTestId("demote-error");
    // The step is named in WORDS, not as the raw enum tag — a user cannot act on "land".
    expect(err.textContent).toContain("Bringing the branch down to this Mac");
    // …and a dirty/diverged refusal keeps its file list rather than being flattened.
    expect(err.textContent).toContain("src/a.ts");
    expect(screen.getByTestId("demote-failure-cloud-note").textContent).toMatch(
      /cloud agent is still running/i,
    );
  });

  // "Nothing has been shut down" is NOT "nothing happened": the handoff push runs before `land`, so
  // by then the sandbox's work is on the user's remote. A panel that denied the very commit the
  // confirm screen promised would send them looking for work that is already pushed.
  it("says the work was already pushed when the failure came after the handoff", async () => {
    mount(okPlan(), async () => ({ ok: false, step: "land", message: "dirty: src/a.ts" }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    const pushed = await screen.findByTestId("demote-failure-pushed");
    expect(pushed.textContent).toContain("origin/sparkle/agent-42");
    expect(screen.queryByTestId("demote-failure-maybe-pushed")).toBeNull();
  });

  it("says the push may or may not have happened when the HANDOFF itself failed", async () => {
    mount(okPlan(), async () => ({ ok: false, step: "handoff", message: "remote rejected" }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    expect((await screen.findByTestId("demote-failure-maybe-pushed")).textContent).toMatch(
      /may or may not/i,
    );
    expect(screen.queryByTestId("demote-failure-pushed")).toBeNull();
  });

  it("claims nothing about a push when the failure came before the handoff ran", async () => {
    mount(okPlan(), async () => ({ ok: false, step: "preflight", message: "no git" }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    await screen.findByTestId("demote-error");
    expect(screen.queryByTestId("demote-failure-pushed")).toBeNull();
    expect(screen.queryByTestId("demote-failure-maybe-pushed")).toBeNull();
  });

  // The new failure mode demotion invents: a DELETE that failed after the local agent came up
  // leaves a paying sandbox with no tab. Naming its id is the orphan contract.
  it("surfaces an orphaned session id when the sandbox could not be shut down", async () => {
    mount(okPlan(), async () => ({
      ok: false,
      step: "cutover",
      message: "the delete failed",
      orphanedSessionId: "sess-abc",
    }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    const orphan = await screen.findByTestId("demote-orphan");
    expect(orphan.textContent).toContain("sess-abc");
    expect(orphan.textContent).toMatch(/still be billing/i);
  });

  // …and it must REPLACE the "you can try again" note, not sit beside it. An orphan means the cut
  // already happened on this side: the local agent is live on this branch, so a second demotion
  // would land the same work twice. Two contradictory sentences with the actionable one wrong is
  // worse than either alone.
  it("tells the user NOT to retry after an orphan, instead of 'you can try again'", async () => {
    mount(okPlan(), async () => ({
      ok: false,
      step: "cutover",
      message: "the delete failed",
      orphanedSessionId: "sess-abc",
    }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    const note = await screen.findByTestId("demote-failure-orphan-note");
    expect(note.textContent).toMatch(/don't try again/i);
    expect(note.textContent).toMatch(/local agent is up/i);
    expect(screen.queryByTestId("demote-failure-cloud-note")).toBeNull();
  });

  // The step in the panel must be the step that was IN FLIGHT. Read from render state it is always
  // "preflight" — the one step whose contract is that nothing has happened yet — so a throw during
  // the cut would be narrated as "nothing was touched" while the delete may already have fired.
  it("names the step that was actually running when demote THREW", async () => {
    mount(okPlan(), async ({ onStep }) => {
      onStep("cutover");
      throw new Error("socket died");
    });
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    const err = await screen.findByTestId("demote-error");
    expect(err.textContent).toContain("Handing over — shutting the sandbox down");
    expect(err.textContent).toContain("socket died");
    expect(err.textContent).not.toContain("Checking this project and branch");
  });

  // …and naming the step is only half of it. A THROW during the cut means the delete may already
  // have fired while the local agent is live on this branch, so the retry advice is as wrong here
  // as it is for an orphan — even though nothing hands us an orphan id to key on.
  it("refuses to say 'try again' when demote THREW during the cut", async () => {
    mount(okPlan(), async ({ onStep }) => {
      onStep("cutover");
      throw new Error("socket died");
    });
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    const note = await screen.findByTestId("demote-failure-indeterminate");
    expect(note.textContent).toMatch(/can't tell you whether the sandbox was shut down/i);
    expect(note.textContent).toMatch(/don't just try again/i);
    expect(screen.queryByTestId("demote-failure-cloud-note")).toBeNull();
    expect((await screen.findByTestId("demote-cut-unknown")).textContent).toMatch(
      /cloud roster/i,
    );
  });

  // The OTHER cutover failure, and it is the opposite advice: a structured refusal at `cutover` is
  // the HEAD guard deciding NOT to cut because the sandbox committed after its work was pushed.
  // Nothing was deleted, that commit is safe, and the plan's own remedy is "demote again". Same
  // step as the case above, so keying on the step alone would give exactly the wrong answer to one
  // of them.
  it("keeps the retry advice for a HEAD-guard refusal, and explains why", async () => {
    mount(okPlan(), async () => ({
      ok: false,
      step: "cutover",
      message: "the sandbox committed after the push",
    }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    expect((await screen.findByTestId("demote-cut-guard-note")).textContent).toMatch(
      /bring it down again/i,
    );
    expect(screen.getByTestId("demote-failure-cloud-note")).toBeTruthy();
    expect(screen.queryByTestId("demote-failure-indeterminate")).toBeNull();
  });

  // ccgz8: the HEAD-guard refusal fires BECAUSE the cloud agent is still committing, so a bare
  // "bring it down again" can lose the same race. The remedy the user reads must tell them to wait
  // for the agent to be idle first — a remedy that is safe under the condition that triggered it.
  it("tells the user to wait for the cloud agent to be idle before retrying a HEAD-guard refusal", async () => {
    mount(okPlan(), async () => ({
      ok: false,
      step: "cutover",
      message: "the sandbox committed after the push",
    }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    const note = (await screen.findByTestId("demote-cut-guard-note")).textContent!;
    expect(note).toMatch(/idle/i);
    expect(note).toMatch(/race/i);
  });
});

// s6vsf: the confirm button doubles as the retry affordance, and a full-emphasis "Bring down to
// local" is UNSAFE under the two failures whose copy says not to retry — an orphan (the cut already
// happened here) and a throw mid-cut (the delete may already have fired). Following it re-runs a
// partially-applied, destructive move. In those states the button must become a Close action; in
// genuinely retry-safe states it must stay a retry. These assert the actual rendered control, not a
// flag.
describe("the retry button is offered only where retry is safe (s6vsf)", () => {
  const orphanFailure = async () =>
    ({
      ok: false,
      step: "cutover",
      message: "the delete failed",
      orphanedSessionId: "sess-abc",
    }) as DemoteResult;

  const thrownDuringCut: DemoteToLocalDeps["demote"] = async ({ onStep }) => {
    onStep("cutover");
    throw new Error("socket died");
  };

  it("replaces retry with a Close action after an ORPHAN, and Close dismisses the dialog", async () => {
    const { onClose } = mount(okPlan(), orphanFailure);
    // The button starts as the retry/confirm control; clicking it starts the run that then fails.
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    // After the non-retryable failure the retry control is GONE — not merely disabled — and a Close
    // action stands in its place.
    const dismiss = (await screen.findByTestId("demote-dismiss")) as HTMLButtonElement;
    expect(dismiss.textContent).toMatch(/close/i);
    expect(dismiss.disabled).toBe(false);
    expect(screen.queryByTestId("demote-confirm")).toBeNull();
    // And it is a real dismiss, not a relabelled retry: pressing it closes the dialog.
    fireEvent.click(dismiss);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("replaces retry with a Close action after a THROW during the cut", async () => {
    mount(okPlan(), thrownDuringCut);
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    // The indeterminate note is the one that says "don't just try again"; the button under it must
    // not be a retry.
    await screen.findByTestId("demote-failure-indeterminate");
    expect((await screen.findByTestId("demote-dismiss")).textContent).toMatch(/close/i);
    expect(screen.queryByTestId("demote-confirm")).toBeNull();
  });

  it("KEEPS the retry button for a structured HEAD-guard cutover refusal (retry is safe there)", async () => {
    mount(okPlan(), async () => ({
      ok: false,
      step: "cutover",
      message: "the sandbox committed after the push",
    }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    // This refusal's own remedy is to demote again, so the retry control must survive it…
    expect((await screen.findByTestId("demote-confirm")).textContent).toMatch(/bring down to local/i);
    // …and NOT be swapped for a Close.
    expect(screen.queryByTestId("demote-dismiss")).toBeNull();
  });

  it("KEEPS the retry button for an ordinary post-handoff failure", async () => {
    mount(okPlan(), async () => ({ ok: false, step: "land", message: "dirty: src/a.ts" }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    await screen.findByTestId("demote-error");
    expect(screen.getByTestId("demote-confirm").textContent).toMatch(/bring down to local/i);
    expect(screen.queryByTestId("demote-dismiss")).toBeNull();
  });
});

describe("progress and success", () => {
  it("names the step it is on, and keeps saying the sandbox is still up until the cut", async () => {
    let release: (r: DemoteResult) => void = () => {};
    mount(okPlan(), ({ onStep }) => {
      onStep("land");
      return new Promise<DemoteResult>((res) => {
        release = res;
      });
    });
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("demote-current-step").textContent).toContain(
        "Bringing the branch down to this Mac",
      ),
    );
    expect(screen.getByTestId("demote-cloud-note").textContent).toMatch(
      /still running.*until the last step/is,
    );
    release(landed());
  });

  it("says the sandbox is being shut down only once the cut is actually happening", async () => {
    let release: (r: DemoteResult) => void = () => {};
    mount(okPlan(), ({ onStep }) => {
      onStep("cutover");
      return new Promise<DemoteResult>((res) => {
        release = res;
      });
    });
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    await waitFor(() =>
      expect(screen.getByTestId("demote-cloud-note").textContent).toMatch(/being shut down/i),
    );
    release(landed());
  });

  it("reports where the work landed, and that the sandbox stopped billing", async () => {
    mount(okPlan(), async () => landed({ worktree: "/tmp/wt/agent-42" }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    const done = await screen.findByTestId("demote-success");
    expect(done.textContent).toContain(AGENT.name);
    expect(done.textContent).toMatch(/no longer billing/i);
    // Which of the two landings happened is a real difference to the user: a brand-new directory on
    // their disk, or their existing one moved forward.
    expect(screen.getByTestId("demote-success-worktree").textContent).toMatch(
      /fast-forwarded.*\/tmp\/wt\/agent-42/is,
    );
  });

  it("says a worktree was CREATED when the agent was born in the cloud", async () => {
    mount(okPlan(), async () => landed({ createdWorktree: true, worktree: "/tmp/wt/new" }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    expect((await screen.findByTestId("demote-success-worktree")).textContent).toMatch(
      /fresh worktree was created.*\/tmp\/wt\/new/is,
    );
  });

  // A transcript that did not travel is not a failure (spec Decision 4) — but it changes what the
  // local agent knows, so it is reported rather than silently swallowed.
  it("tells the user the local agent starts from a briefing when the conversation did not travel", async () => {
    mount(okPlan(), async () => landed({ transcriptMoved: false }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    expect((await screen.findByTestId("demote-success-no-transcript")).textContent).toMatch(
      /briefing/i,
    );
  });

  it("says nothing about a briefing when the conversation DID travel", async () => {
    mount(okPlan());
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    await screen.findByTestId("demote-success");
    expect(screen.queryByTestId("demote-success-no-transcript")).toBeNull();
  });
});

describe("a transcript that moved but was TRUNCATED", () => {
  // The silent case. A truncated-but-moved transcript gets no briefing (the briefing only fires
  // when nothing moved at all), so without its own line it is indistinguishable on screen from a
  // complete demotion — and the user discovers it when the agent has forgotten how the work began.
  it("says the oldest turns were dropped", async () => {
    mount(okPlan(), async () => landed({ transcriptMoved: true, transcriptTruncated: true }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    const note = await screen.findByTestId("demote-success-truncated");
    expect(note.textContent).toMatch(/oldest turns were dropped/i);
    // It is NOT the no-transcript copy: the conversation did travel, just not all of it.
    expect(screen.queryByTestId("demote-success-no-transcript")).toBeNull();
  });

  it("stays silent when the whole conversation came down", async () => {
    mount(okPlan(), async () => landed({ transcriptMoved: true, transcriptTruncated: false }));
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    await screen.findByTestId("demote-success");
    expect(screen.queryByTestId("demote-success-truncated")).toBeNull();
  });
});

describe("demoteDialogDeps — the seam that has now drifted twice", () => {
  // These install a MODULE-NAMESPACE spy, the only one in this file. Restoring it as the last
  // statement of each test would skip restoration whenever an expect above it throws — and the
  // suite runs with retry, so a leaked spy survives into the retry and the next test with its
  // mock.calls intact, turning one real failure into a cascade of misattributed ones.
  afterEach(() => vi.restoreAllMocks());

  // tsc caught the LAST break because a field was renamed. It cannot catch the semantic half:
  // passing a path where `null` was meant routes a born-in-the-cloud agent down the
  // fast-forward-an-existing-worktree path instead of the create-one path, and typechecks fine.
  // So assert the exact DemoteInput, not that the call was made.
  const project = { id: "proj-1", rootPath: "/repo" } as unknown as Project;
  const cloudAgent = (over: Partial<AgentTab> = {}) =>
    ({
      id: "tab-1",
      runtime: "cloud",
      kind: "build",
      worktreePath: null,
      branch: "sparkle/cloud-abcd1234",
      name: "Retry Hardening",
      goal: { text: "harden the retry" },
      ...over,
    }) as unknown as AgentTab;

  it("passes the EXISTING worktree for a previously promoted agent", async () => {
    const spy = vi.spyOn(demoteModule, "demoteAgentToLocal").mockResolvedValue(landed());
    await demoteDialogDeps({
      project,
      agent: cloudAgent({ worktreePath: "/repo/.wt/agent-42" }),
    }).demote({ onStep: () => {} });

    const input = spy.mock.calls.at(-1)![0];
    expect(input.existingWorktree).toBe("/repo/.wt/agent-42");
  });

  it("passes NULL — not an empty string — for an agent born in the cloud, and no branch/baseBranch", async () => {
    const spy = vi.spyOn(demoteModule, "demoteAgentToLocal").mockResolvedValue(landed());
    await demoteDialogDeps({ project, agent: cloudAgent({ worktreePath: null }) }).demote({
      onStep: () => {},
    });

    const input = spy.mock.calls.at(-1)![0] as unknown as Record<string, unknown>;
    // null selects the cut-a-fresh-worktree path in Rust; "" would read as a path and send it down
    // the fast-forward path against nothing.
    expect(input.existingWorktree).toBeNull();
    // The branch is the SERVER's answer (what the handoff actually pushed), never a client guess —
    // one fact, one source.
    expect(input.branch).toBeUndefined();
    expect(input.baseBranch).toBeUndefined();
    expect(input.agentId).toBe("tab-1");
    expect(input.root).toBe("/repo");
  });
});

describe("the store flip failed after the sandbox was already deleted", () => {
  // The one success case where the panel's headline is false to what the sidebar will show.
  it("says the tab is stuck on cloud, and that demoting again is the WRONG move", async () => {
    mount(okPlan(), async () => landed({ runtimeFlipFailed: true }), false); // repair also fails
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    const note = await screen.findByTestId("demote-success-runtime-stuck");
    expect(note.textContent).toMatch(/still shows as a cloud agent/i);
    // The remedy must be an action that EXISTS, and it must forbid the unsafe one.
    expect(note.textContent).toMatch(/close this tab/i);
    expect(note.textContent).toMatch(/don't use|don’t use/i);
  });

  it("stays silent on an ordinary success", async () => {
    mount(okPlan());
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    await screen.findByTestId("demote-success");
    expect(screen.queryByTestId("demote-success-runtime-stuck")).toBeNull();
  });
});

describe("the runtime repair is attempted, not merely described", () => {
  it("repairs the stuck tab itself and says nothing when the repair works", async () => {
    const repair = vi.fn(() => true);
    const deps: DemoteToLocalDeps = {
      loadPlan: () => Promise.resolve(okPlan()),
      demote: async () => landed({ runtimeFlipFailed: true }),
      repairRuntime: repair,
    };
    render(<DemoteToLocalDialog agent={AGENT} deps={deps} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    await screen.findByTestId("demote-success");

    // The SIDE EFFECT: the repair ran. Not that a note was worded a particular way.
    expect(repair).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("demote-success-runtime-stuck")).toBeNull();
  });

  it("does not attempt a repair when the flip already succeeded", async () => {
    const repair = vi.fn(() => true);
    const deps: DemoteToLocalDeps = {
      loadPlan: () => Promise.resolve(okPlan()),
      demote: async () => landed(),
      repairRuntime: repair,
    };
    render(<DemoteToLocalDialog agent={AGENT} deps={deps} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("demote-confirm"));
    await screen.findByTestId("demote-success");
    expect(repair).not.toHaveBeenCalled();
  });
});

describe("the production repairRuntime, not a stand-in for it", () => {
  // The previous tests injected vi.fn(() => true), so they proved only that the dialog calls a dep.
  // They would pass against a repair that flips the wrong project or returns true unconditionally —
  // and a false success shows the user no note at all, the exact failure the repair exists to end.
  const seed = (runtime: "cloud" | "local") => {
    useProjectStore.setState({
      projects: [
        {
          id: "proj-1",
          rootPath: "/repo",
          agents: [{ id: "tab-1", runtime, kind: "build", name: "A" }],
        },
      ],
    } as never);
  };
  const project = { id: "proj-1", rootPath: "/repo" } as unknown as Project;
  const agent = { id: "tab-1", runtime: "cloud", kind: "build", name: "A" } as unknown as AgentTab;

  it("actually flips the row it names, and reports true", () => {
    seed("cloud");
    const ok = demoteDialogDeps({ project, agent }).repairRuntime();
    expect(ok).toBe(true);
    const row = useProjectStore
      .getState()
      .projects.find((p) => p.id === "proj-1")!
      .agents.find((a) => a.id === "tab-1")!;
    expect(row.runtime).toBe("local");
  });

  it("reports FALSE when the row isn't there, rather than a silent false success", () => {
    seed("cloud");
    const missing = { ...agent, id: "nope" } as unknown as AgentTab;
    expect(demoteDialogDeps({ project, agent: missing }).repairRuntime()).toBe(false);
  });
});

describe("a repair that throws is a failed repair, not a failed demotion", () => {
  it("still shows the success panel, with the stuck note", async () => {
    const deps: DemoteToLocalDeps = {
      loadPlan: () => Promise.resolve(okPlan()),
      demote: async () => landed({ runtimeFlipFailed: true }),
      repairRuntime: () => {
        throw new Error("store exploded");
      },
    };
    render(<DemoteToLocalDialog agent={AGENT} deps={deps} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("demote-confirm"));

    await screen.findByTestId("demote-success");
    expect(await screen.findByTestId("demote-success-runtime-stuck")).toBeTruthy();
    // And emphatically NOT the failure panel, which would claim the sandbox is still running.
    expect(screen.queryByTestId("demote-error")).toBeNull();
  });
});
