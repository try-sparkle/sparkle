import { describe, it, expect } from "vitest";
import { deriveCta } from "./agentCta";
import type { WorkflowState } from "../services/branchStatus";
import type { SuggestionButton } from "../services/suggestions/types";

const ws = (over: Partial<WorkflowState> = {}): WorkflowState => ({
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  prState: null,
  prNumber: null,
  prUrl: null,
  ...over,
});

const suggestion = (label: string): SuggestionButton => ({
  id: `s:${label}`,
  label,
  value: label,
  kind: "prompt",
  source: "learned",
});

describe("deriveCta", () => {
  it("building_unsaved has no CTA — nothing to land yet", () => {
    expect(deriveCta("building_unsaved", ws(), [])).toBeNull();
  });

  it("a planning-only stage has no CTA", () => {
    expect(deriveCta("planned", ws(), [])).toBeNull();
    expect(deriveCta("thought", ws(), [])).toBeNull();
  });

  it.each(["building_saved", "pushed", "pull_request"] as const)(
    "%s offers Land to Main when there is no positive remote evidence",
    (stage) => {
      // `ws()` leaves hasRemote undefined. Even under the default pr_first policy that must fall
      // back to Land: a PR is impossible without a remote, and demanding one would strand the agent.
      expect(deriveCta(stage, ws(), [])?.primary.label).toBe("Land to Main");
    },
  );

  describe("delivery policy", () => {
    const remote = (over: Partial<WorkflowState> = {}) => ws({ hasRemote: true, ...over });

    it("pr_first is the DEFAULT — it mirrors `[workflow] require_pr`, which defaults true", () => {
      // Guards the whole point of this change: the configured default and the implemented
      // behavior were opposites, and nothing read the flag.
      expect(deriveCta("pushed", remote(), [])?.primary.label).toBe("Open Pull Request");
    });

    it("pr_first with an OPEN pr makes merging the primary action", () => {
      const cta = deriveCta("pull_request", remote({ prState: "open", prNumber: 503 }), []);
      expect(cta?.primary.label).toBe("Merge PR #503");
    });

    it("pr_first names the PR number so an agent with several branches is unambiguous", () => {
      const withNum = deriveCta("pull_request", remote({ prState: "open", prNumber: 42 }), []);
      const noNum = deriveCta("pull_request", remote({ prState: "open" }), []);
      expect(withNum?.primary.label).toBe("Merge PR #42");
      expect(noNum?.primary.label).toBe("Merge Pull Request");
    });

    it.each(["building_saved", "pushed"] as const)(
      "pr_first at %s (no PR yet) offers Open Pull Request",
      (stage) => {
        expect(deriveCta(stage, remote(), [])?.primary.label).toBe("Open Pull Request");
      },
    );

    it("pr_first FALLS BACK to Land without positive remote evidence", () => {
      // hasRemote is false both for a genuinely remoteless repo AND for any non-probing fast poll,
      // so absent evidence must never strand the agent at an impossible action.
      expect(deriveCta("pushed", ws({ hasRemote: false }), [])?.primary.label).toBe("Land to Main");
      expect(deriveCta("pushed", ws(), [])?.primary.label).toBe("Land to Main");
      expect(deriveCta("pushed", null, [])?.primary.label).toBe("Land to Main");
    });

    it("a merged/closed PR is not a gate — pr_first offers to open a new one", () => {
      // Re-opened work after a merge starts a NEW cycle; a stale merged PR must not read as the
      // live gate, or the agent would be told to merge something already merged.
      expect(
        deriveCta("pushed", remote({ prState: "merged", prNumber: 7 }), [])?.primary.label,
      ).toBe("Open Pull Request");
      expect(
        deriveCta("pushed", remote({ prState: "closed", prNumber: 7 }), [])?.primary.label,
      ).toBe("Open Pull Request");
    });

    it("direct policy preserves the original behavior at every pre-land stage", () => {
      for (const stage of ["building_saved", "pushed", "pull_request"] as const) {
        const cta = deriveCta(stage, remote({ prState: "open", prNumber: 9 }), [], {
          policy: "direct",
        });
        expect(cta?.primary.label).toBe("Land to Main");
      }
    });

    it("policy does not affect the terminal stages", () => {
      for (const policy of ["pr_first", "direct"] as const) {
        expect(
          deriveCta("merged", remote({ inOriginMain: true }), [], { policy })?.primary.label,
        ).toBe("Close Build Agent");
        expect(
          deriveCta("merged_local", remote({ inLocalMain: true }), [], { policy })?.primary.label,
        ).toBe("Push to Origin Main");
      }
    });

    it("the PR CTAs are prompts, so the agent runs the project's own contracts", () => {
      // Not control actions: the app must not shell out to `gh` and merge blind. `gh pr merge
      // --auto` silently degrades to an immediate merge where auto-merge is disabled, so the
      // check-verification has to happen in the agent, not in a fire-and-forget app action.
      const open = deriveCta("pushed", remote(), [])?.primary;
      const merge = deriveCta("pull_request", remote({ prState: "open" }), [])?.primary;
      expect(open?.kind).toBe("prompt");
      expect(merge?.kind).toBe("prompt");
      expect(merge?.value).toContain("checks");
    });
  });

  // POLICY CHANGE (2026-07-20): this used to assert "an open PR still offers Land, not Merge PR —
  // this repo lands directly". That was the `direct` policy hardcoded into the engine, and it is
  // why open PRs piled up: the primary action routed around them. `require_pr` already defaulted to
  // true in config and nothing read it. Under the default `pr_first` policy an open PR is now the
  // gate. The old behavior is still reachable and still tested — via `policy: "direct"` below.
  it("an open PR under `direct` still offers Land (the pre-2026-07-20 behavior)", () => {
    const cta = deriveCta("pull_request", ws({ prState: "open", hasRemote: true }), [], {
      policy: "direct",
    });
    expect(cta?.primary.label).toBe("Land to Main");
  });

  // REGRESSION — founder screenshot 2, 2026-07-15: "Landed on main — local main now contains all
  // 9 roborev commits... Nothing is pushed yet." The app offered Close.
  it("merged_local WITH a remote offers Push to Origin Main", () => {
    const cta = deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: true }), []);
    expect(cta?.primary.label).toBe("Push to Origin Main");
  });

  it("merged_local with NO remote is terminal and offers Close", () => {
    const cta = deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: false }), []);
    expect(cta?.primary.label).toBe("Close Build Agent");
  });

  it("merged_local with UNKNOWN remote fails safe to Close", () => {
    // hasRemote absent (older Rust build, or a fast poll before any probing tick).
    const cta = deriveCta("merged_local", ws({ inLocalMain: true }), []);
    expect(cta?.primary.label).toBe("Close Build Agent");
  });

  it("a null/absent workflow state still yields a CTA rather than crashing", () => {
    expect(deriveCta("building_saved", null, [])?.primary.label).toBe("Land to Main");
    expect(deriveCta("merged_local", undefined, [])?.primary.label).toBe("Close Build Agent");
  });

  it.each(["merged", "shipped"] as const)("%s offers Close Build Agent", (stage) => {
    const cta = deriveCta(stage, ws({ inOriginMain: true, hasRemote: true }), []);
    expect(cta?.primary.label).toBe("Close Build Agent");
    expect(cta?.primary.kind).toBe("control");
  });

  it("Land/Push are prompts so the agent runs the project's contracts", () => {
    expect(deriveCta("building_saved", ws(), [])?.primary.kind).toBe("prompt");
    expect(
      deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: true }), [])?.primary.kind,
    ).toBe("prompt");
  });

  it("computed suggestions become caret alternates", () => {
    const cta = deriveCta("building_saved", ws(), [suggestion("Cut a DMG")]);
    expect(cta?.alternates.map((b) => b.label)).toContain("Cut a DMG");
  });

  it("merged_local carries Close as its escape hatch alternate", () => {
    const cta = deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: true }), []);
    expect(cta?.alternates.map((b) => b.label)).toContain("Close Build Agent");
  });

  it("no escape hatch is added when Close is already the primary", () => {
    const cta = deriveCta("merged_local", ws({ inLocalMain: true }), []);
    expect(cta?.primary.label).toBe("Close Build Agent");
    expect(cta?.alternates.filter((b) => b.id === cta.primary.id)).toHaveLength(0);
  });

  it("the primary is never duplicated in the alternates", () => {
    const cta = deriveCta("merged", ws({ inOriginMain: true, hasRemote: true }), []);
    expect(cta?.alternates.map((b) => b.id)).not.toContain(cta?.primary.id);
  });

  it("a computed suggestion colliding with the primary id is dropped", () => {
    const collide: SuggestionButton = { ...suggestion("x"), id: "cta:landToMain" };
    const cta = deriveCta("building_saved", ws(), [collide]);
    expect(cta?.alternates.filter((b) => b.id === "cta:landToMain")).toHaveLength(0);
  });

  it("caps the alternates so the caret menu stays glanceable", () => {
    const many = ["a", "b", "c", "d", "e", "f"].map(suggestion);
    const cta = deriveCta("building_saved", ws(), many);
    expect(cta?.alternates.length).toBeLessThanOrEqual(4);
  });

  // ── The agent asked the user something ──────────────────────────────────────────────────────
  // REGRESSION — founder report 2026-07-20, two screenshots:
  //   (1) stage `merged` (landed a previous cycle, now a dirty tree) + "Want me to do that —
  //       commit, then merge main in?" → pill said "Close Build Agent".
  //   (2) stage stuck below merged_local (land.sh left the worktree on main) + "Want me to push?"
  //       → pill said "Land to Main" for work already on main.
  // The stage describes the BRANCH; a pending question describes the MOMENT. The moment wins.
  describe("when the agent is awaiting an answer", () => {
    const q = { questionPending: true };

    it("a computed answer leads instead of the stage action", () => {
      const cta = deriveCta("merged", ws({ inOriginMain: true }), [suggestion("Yes — push")], q);
      expect(cta?.primary.label).toBe("Yes — push");
    });

    it("the stage action is demoted, not lost", () => {
      const cta = deriveCta("merged", ws({ inOriginMain: true }), [suggestion("Yes — push")], q);
      expect(cta?.alternates.map((b) => b.label)).toContain("Close Build Agent");
    });

    it("the demoted stage action sits LAST, behind the answers", () => {
      const answers = ["Yes — push", "No, hold off", "Show me the diff"].map(suggestion);
      const cta = deriveCta("merged", ws({ inOriginMain: true }), answers, q);
      const labels = cta?.alternates.map((b) => b.label) ?? [];
      expect(labels[labels.length - 1]).toBe("Close Build Agent");
    });

    it("screenshot 2: an already-landed branch offers the answer, not Land to Main", () => {
      const cta = deriveCta("building_saved", ws(), [suggestion("Yes — push to origin")], q);
      expect(cta?.primary.label).toBe("Yes — push to origin");
      expect(cta?.alternates.map((b) => b.label)).toContain("Land to Main");
    });

    it("falls back to the stage action when there is no answer to offer", () => {
      // Learned actions off, offline, or the model returned [] — suppressing the CTA here would
      // leave the row empty and strand the user with no way to close the agent.
      expect(deriveCta("merged", ws({ inOriginMain: true }), [], q)?.primary.label).toBe(
        "Close Build Agent",
      );
    });

    it("does not duplicate the stage action when it is already a computed answer", () => {
      const collide: SuggestionButton = { ...suggestion("Close it"), id: "control:closeAgent" };
      const cta = deriveCta("merged", ws({ inOriginMain: true }), [collide], q);
      const ids = [cta?.primary.id, ...(cta?.alternates.map((b) => b.id) ?? [])];
      expect(ids.filter((id) => id === "control:closeAgent")).toHaveLength(1);
    });

    // REGRESSION (roborev, Medium): the question path appended only the demoted stage action and
    // skipped escapeHatchFor. At merged_local the stage action is PUSH, so unless the computed
    // answers happened to include a close, there was no Close anywhere and the agent could not be
    // closed at all. Every other question test uses merged/building_saved, neither of which HAS an
    // escape hatch — so this stage is the only one that can catch it.
    it("merged_local keeps Close reachable even when an answer leads", () => {
      const cta = deriveCta(
        "merged_local",
        ws({ inLocalMain: true, hasRemote: true }),
        [suggestion("Yes — push")],
        q,
      );
      expect(cta?.primary.label).toBe("Yes — push");
      const labels = cta?.alternates.map((b) => b.label) ?? [];
      expect(labels).toContain("Push to Origin Main"); // the demoted stage action
      expect(labels).toContain("Close Build Agent"); // the escape hatch
    });

    it("merged_local's escape hatch survives a full set of answers", () => {
      const many = ["a", "b", "c", "d", "e", "f"].map(suggestion);
      const cta = deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: true }), many, q);
      expect(cta?.alternates.map((b) => b.label)).toContain("Close Build Agent");
    });

    it("does not duplicate Close when an answer already IS the escape hatch", () => {
      const collide: SuggestionButton = { ...suggestion("Close it"), id: "control:closeAgent" };
      const cta = deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: true }), [collide], q);
      const ids = [cta?.primary.id, ...(cta?.alternates.map((b) => b.id) ?? [])];
      expect(ids.filter((id) => id === "control:closeAgent")).toHaveLength(1);
    });

    it("still yields nothing to nudge when the stage has no CTA at all", () => {
      expect(deriveCta("building_unsaved", ws(), [suggestion("Yes")], q)).toBeNull();
    });

    it("keeps the caret menu glanceable", () => {
      const many = ["a", "b", "c", "d", "e", "f", "g"].map(suggestion);
      const cta = deriveCta("merged", ws({ inOriginMain: true }), many, q);
      expect(cta?.alternates.length).toBeLessThanOrEqual(5); // 4 answers + the demoted stage action
    });

    it("no question → the stage action leads, exactly as before", () => {
      const cta = deriveCta("merged", ws({ inOriginMain: true }), [suggestion("Yes — push")], {
        questionPending: false,
      });
      expect(cta?.primary.label).toBe("Close Build Agent");
    });
  });

  it("the escape hatch survives the alternates cap", () => {
    // merged_local's Close is appended AFTER the cap, so a full computed set can't hide the only
    // way to close the agent.
    const many = ["a", "b", "c", "d", "e", "f"].map(suggestion);
    const cta = deriveCta("merged_local", ws({ inLocalMain: true, hasRemote: true }), many);
    expect(cta?.alternates.map((b) => b.label)).toContain("Close Build Agent");
  });
});
