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
    canFastForward: true,
    remedy: "fast-forward",
    cause: "Clean and on main.",
    autoSafe: true,
    unknown: false,
    ...over,
  };
}

/** Mount the hook with a huge poll interval so exactly ONE pass runs per test. */
function Harness({ targets }: { targets: StalenessTarget[] }) {
  useProjectStaleness(targets, 10_000_000);
  return null;
}

beforeEach(() => {
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

afterEach(cleanup);

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
    // asserting before anything ran, which is the vacuous shape of a negative test.
    await waitFor(() => expect(diagnoseStale).toHaveBeenCalledWith("/repos/sparkle"));
    await waitFor(() => expect(autoFastForwardEnabled).not.toHaveBeenCalled());
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
