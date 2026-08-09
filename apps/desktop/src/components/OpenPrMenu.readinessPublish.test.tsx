// @vitest-environment jsdom
// THE SEAM, DRIVEN FROM THE PRODUCTION CALL SITE — bead `sparkle-mf501`.
//
// `services/prReadyPromise.test.ts` proves the RULE: a PR with failing checks or a conflict is never
// counted as ready, and the concierge line splits its number rather than filtering it. That test
// hands `buildDigest` a readiness object it constructs itself — so it would stay green if nothing in
// the app ever built one. This file covers the half it cannot see: the real `OpenPrMenu`, mounted,
// probing, and PUBLISHING what GitHub said into the store the concierge reads.
//
// WHY THAT NEEDS ITS OWN FILE RATHER THAN A LINE IN THE PURE ONE (AGENTS.md, "a defaulted seam every
// test injects"). The store write is one `useEffect` at one call site. Delete it and every pure test
// above still passes, because each supplies its own `DigestReadiness` — the suite would be green
// while the concierge line went back to promising four merges over four red pull requests. The only
// assertion that can fail on that deletion is one taken from the store after a real mount.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => h.invoke(...a) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { OpenPrMenu } from "./OpenPrMenu";
import { usePrReadinessStore } from "../stores/prReadinessStore";
import type { PrRow } from "../services/openPrs";
import type { PrScope } from "../services/fleetPrs";

const SCOPES: readonly PrScope[] = [
  { projectId: "sparkle", projectName: "sparkle", rootPath: "/sparkle" },
];

/** The founder's #1581 — `mergeable: MERGEABLE` beside red checks. The trap, at the seam. */
const UNSTABLE_RED: PrRow = {
  number: 1581,
  title: "unstable",
  headRefName: "sparkle/one",
  url: "https://github.com/drodio/sparkle/pull/1581",
  checks: "failing",
  mergeable: "mergeable",
  mergeStateStatus: "unstable",
  failingChecks: ["CI"],
  agentId: "a1581",
};
const CONFLICTING: PrRow = {
  number: 1308,
  title: "conflicting",
  headRefName: "sparkle/two",
  url: "https://github.com/drodio/sparkle/pull/1308",
  checks: "failing",
  mergeable: "conflicting",
  mergeStateStatus: "dirty",
  agentId: "a1308",
};
const GREEN: PrRow = {
  number: 1600,
  title: "green",
  headRefName: "sparkle/three",
  url: "https://github.com/drodio/sparkle/pull/1600",
  checks: "passing",
  mergeable: "mergeable",
  mergeStateStatus: "clean",
  agentId: "a1600",
};

function mount(rows: PrRow[] | null) {
  h.invoke.mockImplementation((cmd: string) =>
    Promise.resolve(cmd === "project_open_prs" ? rows : null),
  );
  return render(
    <OpenPrMenu
      compact
      scopes={SCOPES}
      // The join `ConciergePrChip` supplies, reduced to the durable owner Rust records.
      resolveAgent={(pr) =>
        pr.agentId
          ? {
              agentId: pr.agentId,
              agentName: pr.agentId,
              projectId: "sparkle",
              isCurrentProject: true,
            }
          : null
      }
      onOpenAgent={() => {}}
    />,
  );
}

beforeEach(() => {
  h.invoke.mockReset();
  usePrReadinessStore.setState({ probedProjectIds: [], readyAgentIds: [] });
});
afterEach(cleanup);

describe("OpenPrMenu publishes merge-readiness for the concierge", () => {
  it("marks the project probed and credits NO agent when every PR is red", async () => {
    mount([UNSTABLE_RED, CONFLICTING]);
    await waitFor(() =>
      expect(usePrReadinessStore.getState().probedProjectIds).toEqual(["sparkle"]),
    );
    // THE ASSERTION THAT FAILS IF `mergeable: MERGEABLE` IS EVER TRUSTED ON ITS OWN. #1581 carries
    // it while its checks are red; a publisher reading that field would credit `a1581` here.
    expect(usePrReadinessStore.getState().readyAgentIds).toEqual([]);
  });

  it("credits only the agent whose PR is genuinely green", async () => {
    mount([UNSTABLE_RED, CONFLICTING, GREEN]);
    await waitFor(() =>
      expect(usePrReadinessStore.getState().readyAgentIds).toEqual(["a1600"]),
    );
  });

  // "PROBED" IS THE HALF THAT LETS THE CONCIERGE SAY "none ready" AT ALL, so a failed probe must not
  // set it. Without this, a machine with no `gh` would publish an empty ready set that reads exactly
  // like "we looked and nothing is mergeable" — a confident denial over a question never answered.
  it("does not mark a project probed when the probe fails", async () => {
    mount(null);
    // Give the fetch a chance to settle before asserting on an absence.
    await waitFor(() => expect(h.invoke).toHaveBeenCalled());
    await Promise.resolve();
    expect(usePrReadinessStore.getState().probedProjectIds).toEqual([]);
    expect(usePrReadinessStore.getState().readyAgentIds).toEqual([]);
  });

  // An answered-but-empty repo IS probed. "No open PRs here" and "we could not ask" are different
  // facts and the store is where the concierge tells them apart.
  it("marks an empty-but-answered project probed", async () => {
    mount([]);
    await waitFor(() =>
      expect(usePrReadinessStore.getState().probedProjectIds).toEqual(["sparkle"]),
    );
  });
});

describe("the publish is idempotent", () => {
  // The poll re-confirms the same answer every three minutes and the component re-renders far more
  // often than that. A publish that swapped array identities each time would repaint the entire
  // concierge view model for news that did not change; `sameSnapshot` is what stops it.
  it("does not swap identities when the answer has not moved", async () => {
    const view = mount([UNSTABLE_RED, GREEN]);
    await waitFor(() =>
      expect(usePrReadinessStore.getState().readyAgentIds).toEqual(["a1600"]),
    );
    const before = usePrReadinessStore.getState();
    view.rerender(
      <OpenPrMenu
        compact
        scopes={SCOPES}
        // A FRESH FUNCTION IDENTITY, which is what `ConciergePrChip` hands over on every render —
        // so this rerender re-runs the publish effect and is exactly the case the guard is for.
        resolveAgent={(pr) =>
          pr.agentId
            ? {
                agentId: pr.agentId,
                agentName: pr.agentId,
                projectId: "sparkle",
                isCurrentProject: true,
              }
            : null
        }
        onOpenAgent={() => {}}
      />,
    );
    const after = usePrReadinessStore.getState();
    expect(after.readyAgentIds).toBe(before.readyAgentIds);
    expect(after.probedProjectIds).toBe(before.probedProjectIds);
  });
});
