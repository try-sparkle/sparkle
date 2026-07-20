// End-to-end over the WHOLE ladder: real-git WorkflowState → deriveLiveStage → deriveCta → the
// button the founder actually sees. The fixtures below are not invented — they are the exact
// `WorkflowState` shape that Rust's agent_workflow_state_at returns when a repo is driven through
// commit → land-on-local-main → push-to-origin.
//
// The Rust half — `workflow_state_walks_committed_then_local_land_then_origin_push` (worktree.rs) —
// pins that whole shape against real git, so a field drifting from its default fails there rather
// than leaving these hand-transcribed fixtures silently stale. This file pins what the UI does with
// those values. (No field list in either header on purpose: a hand-maintained enumeration is what
// went stale twice already. The enumerations live in the two places a compiler checks them.)
//
// Each half is independently compiler-forced against a NEW WorkflowState field: the Rust walk
// destructures with no rest pattern, and `WS_DEFAULTS` below is typed `Required<WorkflowState>`.
// Neither can be silently skipped — though note both force a DECISION, not an assertion: a Rust
// pattern can bind `_new_field: _` and WS_DEFAULTS can take a default. That's the honest guarantee:
// a new field can't land without someone consciously deciding what these fixtures say about it.
//
// Together they close the loop the unit tests leave open: each half could be individually green
// while the seam between them was wrong — which is exactly how the reported bug shipped.
import { describe, it, expect } from "vitest";
import { deriveLiveStage } from "./workflowStage";
import { deriveCta } from "./agentCta";
import type { BranchStatus, WorkflowState } from "../services/branchStatus";
import type { WorkflowStageId } from "./workflowStage";

const bs = (ahead: number): BranchStatus => ({
  ahead,
  behind: 0,
  dirty: false,
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
});

// Typed `Required<WorkflowState>` deliberately: WorkflowState's non-core fields are optional
// (landed?/pushed?/shipped?/hasRemote?), so a plain literal would let a NEW field slip in as another
// optional and leave these fixtures silently stale — the very drift this pair exists to catch.
// Required<> strips the optionality, so every field must be spelled out here and a new one fails
// typecheck until someone decides what these fixtures should say about it. That's the TS-side
// counterpart to the Rust walk's exhaustive destructure.
//
// These values mirror the Rust walk's baseline (`Shape::nothing_landed`) field for field, INCLUDING
// `hasRemote: true` — the fixture repo has a real bare origin. Defaulting it to false would be the
// seam drift in miniature: false is the one value documented as ambiguous ("not known to have a
// remote"), so a future case that omitted the field would inherit "no remote" and quietly assert a
// Close pill where the Rust walk's equivalent step observes an origin and expects Push.
const WS_DEFAULTS: Required<WorkflowState> = {
  inLocalMain: false,
  inOriginMain: false,
  inParent: false,
  aheadOfBase: 0,
  landed: false,
  pushed: false,
  shipped: false,
  hasRemote: true,
  prState: null,
  prNumber: null,
  prUrl: null,
};

const wsOf = (over: Partial<WorkflowState>): WorkflowState => ({ ...WS_DEFAULTS, ...over });

/** The full pipeline the composer runs each poll: git signals → live stage → CTA label. */
function labelFor(ws: WorkflowState, ahead: number, prev: WorkflowStageId | null) {
  const stage = deriveLiveStage({ kind: "build", bs: bs(ahead), ws, prev });
  return { stage, label: deriveCta(stage, ws, [])?.primary.label };
}

describe("e2e: real-git signals → stage → the button the user sees", () => {
  // Step 1 of the Rust walk: ahead_of_base=1, nothing landed, origin exists.
  it("committed on its branch, nothing landed → Land to Main", () => {
    const { stage, label } = labelFor(
      wsOf({ aheadOfBase: 1, landed: false, pushed: false, hasRemote: true }),
      1,
      null,
    );
    expect(stage).toBe("building_saved");
    expect(label).toBe("Land to Main");
  });

  // Step 2 — THE FOUNDER'S SCREENSHOT 2: "Landed on main — local main now contains all 9 roborev
  // commits, and the branch is deleted. Nothing is pushed yet." The app offered Close. It must Push.
  //
  // Two fields here are counter-intuitive and are exactly what the Rust walk pins:
  //   - `landed: true` — a --no-ff merge is reachable, so the squash signal is trivially true too.
  //   - `aheadOfBase: 1`, NOT 0 — the base is `origin/main` when that ref exists, and origin doesn't
  //     have the work yet. "Landed locally, unpushed" still reads 1 ahead of base.
  it("landed on LOCAL main, nothing pushed → Push to Origin Main (was: Close)", () => {
    const { stage, label } = labelFor(
      wsOf({
        inLocalMain: true,
        inOriginMain: false,
        landed: true,
        pushed: false,
        aheadOfBase: 1,
        hasRemote: true,
      }),
      0,
      "building_saved",
    );
    expect(stage).toBe("merged_local");
    expect(label).toBe("Push to Origin Main");
  });

  // Step 3 of the Rust walk: origin/main now contains the tip, so ahead_of_base finally drops to 0.
  it("pushed to origin → Close Build Agent", () => {
    const { stage, label } = labelFor(
      wsOf({
        inLocalMain: true,
        inOriginMain: true,
        landed: true,
        aheadOfBase: 0,
        hasRemote: true,
      }),
      0,
      "merged_local",
    );
    expect(stage).toBe("merged");
    expect(label).toBe("Close Build Agent");
  });

  // FOUNDER'S SCREENSHOT 1: an agent that landed an EARLIER cycle ("like the earlier features") and
  // now has fresh un-landed commits. The old code read the workflowShipped watermark, which had
  // latched on the earlier cycle and could never clear, so it showed Close over un-landed work.
  // deriveLiveStage's new-cycle detection drops the stage back; the CTA follows it.
  it("prior cycle landed + fresh un-landed commits → Land to Main, not Close", () => {
    const { stage, label } = labelFor(
      wsOf({ aheadOfBase: 3, hasRemote: true }),
      3,
      "merged", // the earlier cycle reached origin main
    );
    expect(stage).toBe("building_saved");
    expect(label).toBe("Land to Main");
  });

  // A remoteless repo (Rust: has_remote=false) must never be stranded at Push with Close
  // unreachable — merged_local is terminal there.
  it("remoteless repo landed on local main → Close (never stranded at Push)", () => {
    const { stage, label } = labelFor(
      wsOf({ inLocalMain: true, hasRemote: false }),
      0,
      "building_saved",
    );
    expect(stage).toBe("merged_local");
    expect(label).toBe("Close Build Agent");
  });

  // The whole point of the split, stated as one assertion: local-vs-origin now changes the button.
  // Both arms mirror real git — the local arm keeps aheadOfBase:1 (origin lacks the commit) and the
  // origin arm drops to 0, exactly as the Rust walk's steps 2 and 3 observe. Holding aheadOfBase
  // fixed across the arms would be tidier but would make the local arm a state git never produces.
  it("the ONLY difference between Push and Close is inOriginMain", () => {
    const local = labelFor(
      wsOf({ inLocalMain: true, landed: true, aheadOfBase: 1, hasRemote: true }),
      0,
      "building_saved",
    );
    const origin = labelFor(
      wsOf({ inLocalMain: true, inOriginMain: true, landed: true, aheadOfBase: 0, hasRemote: true }),
      0,
      "building_saved",
    );
    expect(local.label).toBe("Push to Origin Main");
    expect(origin.label).toBe("Close Build Agent");
  });
});
