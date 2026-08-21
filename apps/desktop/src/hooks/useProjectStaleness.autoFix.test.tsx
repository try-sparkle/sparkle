// @vitest-environment jsdom
//
// UNATTENDED FAST-FORWARD, AND THE GUARD THAT KEEPS IT UNATTENDED-SAFE (bead sparkle-7h01z).
//
// The founder's ruling is that this poll may fix a stale checkout with no click ONLY where doing so
// is provably lossless — clean tree, on the default branch, a strict ancestor of the base — which is
// exactly what the backend's `autoSafe` names. Everything else, including the offerable-but-dirty
// case, waits for a human to press something.
//
// So the load-bearing test in this file is the NEGATIVE one: a not-`autoSafe` project must not have
// `remedyStale` called against it. A test that only checked the happy path would stay green against
// an implementation that fast-forwards every stale checkout it finds, which is the one behaviour
// this feature is not allowed to have.
//
// `toBadge`'s fail-closed rule is asserted in `useProjectStaleness.test.ts` and is untouched here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { StaleDiagnosis } from "../services/staleness";
import type { RootStaleness } from "./useProjectStaleness";

const invoke = vi.fn();
const diagnoseStale = vi.fn<(root: string) => Promise<StaleDiagnosis>>();
const remedyStale = vi.fn();
const autoFastForwardEnabled = vi.fn<(root: string) => Promise<boolean>>();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../services/staleness", () => ({
  diagnoseStale: (root: string) => diagnoseStale(root),
  // FORWARD EVERY ARGUMENT. This used to be `(root: string) => remedyStale(root)`, which silently
  // dropped the options object — so the unattended policy could not be asserted here at all, and a
  // hook that stopped passing it would have kept this suite green.
  remedyStale: (...a: unknown[]) => remedyStale(...a),
  autoFastForwardEnabled: (root: string) => autoFastForwardEnabled(root),
}));

import {
  DECLINES_BEFORE_ESCALATION,
  noteStaleDecline,
  resetStalenessEscalation,
  stalenessDeclines,
  subscribeStalenessNotices,
  subscribeStalenessResolved,
  type StalenessNotice,
} from "../services/stalenessEscalation";

import { useProjectStaleness, type StalenessTarget } from "./useProjectStaleness";

function reading(over: Partial<RootStaleness> = {}): RootStaleness {
  return {
    behind: 1935,
    stale: true,
    threshold: 25,
    headBranch: "main",
    base: "origin/main",
    unknown: false,
    ...over,
  };
}

function diag(over: Partial<StaleDiagnosis> = {}): StaleDiagnosis {
  return {
    behind: 1935,
    base: "origin/main",
    headBranch: "main",
    defaultBranch: "main",
    detached: false,
    linkedWorktree: false,
    heldBy: "",
    dirtyCount: 0,
    dirtySample: [],
    blockingPaths: [],
    blockersKnown: true,
    canFastForward: true,
    remedy: "fast-forward",
    cause: "Clean and on main.",
    autoSafe: true,
    unknown: false,
    ...over,
  };
}

/** Mount the hook with a huge poll interval so exactly ONE pass runs per test — unless a test is
 *  specifically about what happens over SEVERAL passes, which is what `pollMs` is for. */
function Harness({ targets, pollMs = 10_000_000 }: { targets: StalenessTarget[]; pollMs?: number }) {
  useProjectStaleness(targets, pollMs);
  return null;
}

beforeEach(() => {
  resetStalenessEscalation();
  invoke.mockReset();
  diagnoseStale.mockReset();
  remedyStale.mockReset();
  autoFastForwardEnabled.mockReset();
  autoFastForwardEnabled.mockResolvedValue(true);
  remedyStale.mockResolvedValue({
    ok: true,
    reason: "Fast-forwarded.",
    action: "merge --ff-only",
    beforeBehind: 1935,
    afterBehind: 0,
  });
});

afterEach(() => {
  cleanup();
  resetStalenessEscalation();
  vi.restoreAllMocks();
});

describe("unattended fast-forward", () => {
  it("fast-forwards a stale project the backend calls autoSafe", async () => {
    invoke.mockResolvedValue(reading());
    diagnoseStale.mockResolvedValue(diag({ autoSafe: true }));

    render(<Harness targets={[{ id: "sparkle", rootPath: "/repos/sparkle" }]} />);

    // WITH THE UNATTENDED POLICY, not merely with the root. The `autoSafe` check above this call is
    // already at least one await old by the time the merge runs, and `remedy_at` re-classifies and
    // acts on its OWN fresh reading — so this flag is the only thing that applies the automation
    // rule to the reading that actually decides (knightwatch 5207191879#1, 5209038072#1).
    await waitFor(() =>
      expect(remedyStale).toHaveBeenCalledWith("/repos/sparkle", { unattended: true }),
    );
  });

  // ── THE GUARD ─────────────────────────────────────────────────────────────────────────────────
  // A dirty checkout is OFFERABLE (the panel draws it a button) and never AUTOMATIC. Asserting the
  // absence of the call is the whole point: this is what keeps an unattended timer from touching a
  // tree with uncommitted work in it.
  it("does NOT touch a stale project that is not autoSafe", async () => {
    invoke.mockResolvedValue(reading());
    diagnoseStale.mockResolvedValue(
      diag({ autoSafe: false, remedy: "fast-forward-dirty", dirtyCount: 3 }),
    );

    render(<Harness targets={[{ id: "sparkle", rootPath: "/repos/sparkle" }]} />);

    // Wait for the pass to have actually REACHED the decision — otherwise this would pass simply by
    // asserting before anything ran, which is the vacuous shape of a negative test. The switch read
    // is that evidence now: it sits ABOVE the `autoSafe` guard so a decline can be told apart from a
    // repo that opted out (see the hook), so reaching it proves the pass got as far as deciding.
    await waitFor(() => expect(diagnoseStale).toHaveBeenCalledWith("/repos/sparkle"));
    await waitFor(() => expect(autoFastForwardEnabled).toHaveBeenCalledWith("/repos/sparkle"));
    expect(remedyStale).not.toHaveBeenCalled();
  });

  // The per-repo switch is consulted ONLY on this path — a click-driven remedy is a deliberate act
  // and is never gated by it.
  it("respects the repo's auto-fast-forward switch being off", async () => {
    invoke.mockResolvedValue(reading());
    diagnoseStale.mockResolvedValue(diag({ autoSafe: true }));
    autoFastForwardEnabled.mockResolvedValue(false);

    render(<Harness targets={[{ id: "sparkle", rootPath: "/repos/sparkle" }]} />);

    await waitFor(() => expect(autoFastForwardEnabled).toHaveBeenCalledWith("/repos/sparkle"));
    expect(remedyStale).not.toHaveBeenCalled();
  });

  // ONLY STALE PROJECTS ARE DIAGNOSED — that is what keeps this affordable on a 60s timer. A fresh
  // checkout must cost nothing beyond the `repo_root_staleness` call it was already paying.
  it("does not diagnose a project that is not stale", async () => {
    invoke.mockImplementation((_cmd: string, args: { root: string }) =>
      Promise.resolve(
        args.root === "/repos/fresh" ? reading({ behind: 0, stale: false }) : reading(),
      ),
    );
    diagnoseStale.mockResolvedValue(diag({ autoSafe: false }));

    render(
      <Harness
        targets={[
          { id: "sparkle", rootPath: "/repos/sparkle" },
          { id: "fresh", rootPath: "/repos/fresh" },
        ]}
      />,
    );

    await waitFor(() => expect(diagnoseStale).toHaveBeenCalledWith("/repos/sparkle"));
    expect(diagnoseStale).not.toHaveBeenCalledWith("/repos/fresh");
  });

  // A remedy that could not be applied leaves the badge exactly where it was — this runs unattended,
  // so a throw must not escape and must not stop the other projects being handled.
  it("stays silent when the diagnosis itself fails", async () => {
    invoke.mockResolvedValue(reading());
    diagnoseStale.mockRejectedValue(new Error("no such command"));

    render(<Harness targets={[{ id: "sparkle", rootPath: "/repos/sparkle" }]} />);

    await waitFor(() => expect(diagnoseStale).toHaveBeenCalled());
    expect(remedyStale).not.toHaveBeenCalled();
  });

  // ── THE REFUSAL IS NO LONGER SILENT (bead sparkle-v38y1n) ───────────────────────────────────
  //
  // This poll declined every 60 seconds for ten days and said nothing, so the shared checkout
  // reached 1,175 commits behind with no escalation ever produced. `services/stalenessEscalation`
  // holds the counter; these assert the POLL actually reaches it, which is the half that was
  // missing — a module nobody calls is the same silence with more code in it.

  it("escalates once after N consecutive declines on a project it cannot fix", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: StalenessNotice[] = [];
    const off = subscribeStalenessNotices((n) => seen.push(n));
    invoke.mockResolvedValue(reading());
    diagnoseStale.mockResolvedValue(
      diag({
        autoSafe: false,
        remedy: "fast-forward-dirty",
        dirtyCount: 5,
        blockingPaths: [".sparkle/config.toml"],
        cause: "1935 commit(s) behind origin/main; blocked by .sparkle/config.toml",
      }),
    );

    render(<Harness targets={[{ id: "sparkle", rootPath: "/repos/sparkle" }]} pollMs={1} />);

    await waitFor(() => expect(seen).toHaveLength(1), { timeout: 3000 });
    // THE NAMED PATH, from the poll's own diagnosis. A notice that only said "this is stale" would
    // be the badge again, which was never the missing signal.
    expect(seen[0]!.message).toContain(".sparkle/config.toml");
    expect(seen[0]!.declines).toBe(DECLINES_BEFORE_ESCALATION);

    // ...and it keeps declining without saying it again. Asserted after the counter has demonstrably
    // moved past the threshold, so this is not just "we looked too early".
    await waitFor(() =>
      expect(stalenessDeclines("/repos/sparkle")).toBeGreaterThan(DECLINES_BEFORE_ESCALATION + 2),
      { timeout: 3000 },
    );
    expect(seen).toHaveLength(1);
    off();
  });

  // A REFUSAL FROM THE BACKEND IS A DECLINE TOO, and its reason is git's own words — the one text a
  // person most needs unedited, since it names the file. An `ok: false` that returned quietly was
  // the other half of the silence.
  it("records a backend refusal as a decline, carrying its reason", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: StalenessNotice[] = [];
    const off = subscribeStalenessNotices((n) => seen.push(n));
    invoke.mockResolvedValue(reading());
    diagnoseStale.mockResolvedValue(diag({ autoSafe: true }));
    remedyStale.mockResolvedValue({
      ok: false,
      reason: "error: Your local changes to the following files would be overwritten by merge: f.txt",
      action: "merge --ff-only origin/main",
      beforeBehind: 1935,
      afterBehind: 1935,
    });

    render(<Harness targets={[{ id: "sparkle", rootPath: "/repos/sparkle" }]} pollMs={1} />);

    await waitFor(() => expect(seen).toHaveLength(1), { timeout: 3000 });
    expect(seen[0]!.message).toContain("would be overwritten by merge: f.txt");
    off();
  });

  // A diagnosis that THROWS is the quietest failure of all — an IPC error every 60 seconds looks
  // exactly like nothing happening. It must still reach the counter.
  it("records a thrown diagnosis as a decline", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockResolvedValue(reading());
    diagnoseStale.mockRejectedValue(new Error("no such command"));

    render(<Harness targets={[{ id: "sparkle", rootPath: "/repos/sparkle" }]} pollMs={1} />);

    await waitFor(() => expect(stalenessDeclines("/repos/sparkle")).toBeGreaterThan(0), {
      timeout: 3000,
    });
  });

  // A SUCCESS ENDS THE STREAK. Without this a checkout that wedges, clears, and wedges again would
  // escalate on the first decline of the second wedge — or, worse, never again.
  it("clears the decline streak when the fast-forward succeeds", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockResolvedValue(reading());
    // Decline twice, then succeed.
    let calls = 0;
    diagnoseStale.mockImplementation(async () => {
      calls += 1;
      return diag({ autoSafe: calls > 2, blockingPaths: calls > 2 ? [] : ["f.txt"] });
    });

    render(<Harness targets={[{ id: "sparkle", rootPath: "/repos/sparkle" }]} pollMs={1} />);

    await waitFor(() => expect(remedyStale).toHaveBeenCalled(), { timeout: 3000 });
    await waitFor(() => expect(stalenessDeclines("/repos/sparkle")).toBe(0), { timeout: 3000 });
  });

  // The switch being OFF is the user's own decision, not a decline. Escalating there would be
  // telling them about a setting they chose — the fastest way to have the notice muted.
  it("does not count a repo that opted out of auto-fast-forward as a decline", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    invoke.mockResolvedValue(reading());
    diagnoseStale.mockResolvedValue(diag({ autoSafe: false, blockingPaths: ["f.txt"] }));
    autoFastForwardEnabled.mockResolvedValue(false);

    render(<Harness targets={[{ id: "sparkle", rootPath: "/repos/sparkle" }]} pollMs={1} />);

    await waitFor(() => expect(autoFastForwardEnabled).toHaveBeenCalled(), { timeout: 3000 });
    // Give several more passes the chance to count one, so this is not an early read.
    await waitFor(() => expect(autoFastForwardEnabled.mock.calls.length).toBeGreaterThan(3), {
      timeout: 3000,
    });
    expect(stalenessDeclines("/repos/sparkle")).toBe(0);
  });

  // …AND OPTING OUT ENDS A STREAK THAT WAS ALREADY STANDING (roborev 66891). The test above only
  // covers a repo that was opted out from the start, so it stayed green against a hook that left an
  // EXISTING counter primed — and that is the case that misleads: the panel goes on saying Sparkle
  // could not fast-forward this checkout, about a checkout Sparkle has been told to leave alone.
  // Non-vacuous by construction: the counter is asserted non-zero before the hook ever mounts.
  it("clears a standing decline streak when the repo opts out of auto-fast-forward", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const wedged = diag({ autoSafe: false, blockingPaths: ["f.txt"] });
    for (let i = 0; i < DECLINES_BEFORE_ESCALATION; i++) {
      noteStaleDecline("/repos/sparkle", { diagnosis: wedged });
    }
    expect(stalenessDeclines("/repos/sparkle")).toBe(DECLINES_BEFORE_ESCALATION);
    // The subscriber a renderer uses to STOP showing the notice has to be told too, or the panel
    // keeps painting a wedge that is no longer being worked on.
    const resolved: string[] = [];
    const off = subscribeStalenessResolved((r) => resolved.push(r));

    invoke.mockResolvedValue(reading());
    diagnoseStale.mockResolvedValue(wedged);
    autoFastForwardEnabled.mockResolvedValue(false);

    render(<Harness targets={[{ id: "sparkle", rootPath: "/repos/sparkle" }]} />);

    await waitFor(() => expect(stalenessDeclines("/repos/sparkle")).toBe(0), { timeout: 3000 });
    expect(resolved).toContain("/repos/sparkle");
    // ...and the remedy was still never attempted — clearing the streak is not permission to merge.
    expect(remedyStale).not.toHaveBeenCalled();
    off();
  });

  // After a successful fix the badge has to be re-read through the SAME fail-closed mapping, or the
  // tab keeps saying "1,935 behind" about a checkout that is now current.
  it("re-reads staleness after a successful fast-forward", async () => {
    invoke.mockResolvedValue(reading());
    diagnoseStale.mockResolvedValue(diag({ autoSafe: true }));

    render(<Harness targets={[{ id: "sparkle", rootPath: "/repos/sparkle" }]} />);

    await waitFor(() => expect(remedyStale).toHaveBeenCalled());
    // Once for the initial poll, once after the remedy.
    await waitFor(() =>
      expect(invoke.mock.calls.filter((c) => c[0] === "repo_root_staleness").length).toBe(2),
    );
  });
});
