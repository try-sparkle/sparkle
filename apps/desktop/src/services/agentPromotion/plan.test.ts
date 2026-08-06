import { describe, it, expect } from "vitest";
import {
  planPromotion,
  handoffNudge,
  normalizeRepoUrl,
  WIP_COMMIT_MESSAGE,
  type PromotionPlanInput,
} from "./plan";
import type { PromotionPreflight } from "./rust";
import type { CloudGate } from "../cloudAgents/gating";

const OK_GATE: CloudGate = { ok: true };

function preflight(over: Partial<PromotionPreflight> = {}): PromotionPreflight {
  return {
    branch: "sparkle/agent-42",
    branchExists: true,
    hasRemote: true,
    detached: false,
    dirtyFiles: [],
    dirtyCount: 0,
    unpushed: 0,
    originUrl: "https://github.com/acme/widgets.git",
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ...over,
  };
}

function input(over: Partial<PromotionPlanInput> = {}): PromotionPlanInput {
  return {
    agent: {
      id: "a1",
      runtime: "local",
      kind: "build",
      worktreePath: "/wt/a1",
      branch: "sparkle/agent-42",
      name: "Retry Hardening",
    },
    preflight: preflight(),
    gate: OK_GATE,
    workerCount: 0,
    // Matches the preflight's origin above, so the existing cases exercise what they meant to
    // rather than all short-circuiting on `remote_mismatch`.
    projectRepoUrl: "https://github.com/acme/widgets",
    ...over,
  };
}

/** The plan's ok:true branch, or a failing assertion — keeps every warning test one line. */
function proceed(over: Partial<PromotionPlanInput> = {}) {
  const p = planPromotion(input(over));
  if (!p.ok) throw new Error(`expected a proceeding plan, got refusal ${p.refusal}: ${p.message}`);
  return p;
}

describe("planPromotion — refusals", () => {
  it("refuses an agent that already runs in the cloud", () => {
    const p = planPromotion(input({ agent: { ...input().agent, runtime: "cloud" } }));
    expect(p.ok).toBe(false);
    expect(p.ok === false && p.refusal).toBe("not_local");
  });

  it("does NOT refuse an agent whose runtime is unknown or absent", () => {
    // This repo's convention: an unknown runtime says "no record names the runtime", not "it is
    // remote" (conciergeDispatch; registry normalizes with `?? "local"`, as does addAgent). Testing
    // `!== "local"` would refuse a rehydrated record with the factually false sentence "This agent
    // is already running in the cloud."
    for (const runtime of [undefined, "unknown", ""]) {
      const p = planPromotion(input({ agent: { ...input().agent, runtime } }));
      expect(p.ok, `runtime=${String(runtime)}`).toBe(true);
    }
  });

  it("refuses a shell agent — no conversation and no branch to move", () => {
    const p = planPromotion(input({ agent: { ...input().agent, kind: "shell" } }));
    expect(p.ok === false && p.refusal).toBe("not_local");
    // The shell reason must not be the "already in the cloud" sentence — a shell agent IS local.
    expect(p.ok === false && p.message).toMatch(/shell/i);
    expect(p.ok === false && p.message).not.toMatch(/already running in the cloud/i);
  });

  it("carries the cloud gate's OWN message and deep link rather than writing new copy", () => {
    const gate: CloudGate = {
      ok: false,
      reason: "insufficient_credits",
      message: "You don't have enough credits to start a cloud agent. Add credits to continue.",
      deepLink: "credits",
    };
    const p = planPromotion(input({ gate }));
    expect(p.ok === false && p.refusal).toBe("cloud_gate");
    expect(p.ok === false && p.message).toBe(gate.message);
    expect(p.ok === false && p.deepLink).toBe("credits");
    // The absent key is omitted rather than carried as undefined — a deep-linked gate is not a
    // sign-in gate, and the dialog branches on `"needsSignIn" in p`.
    expect(p.ok === false && "needsSignIn" in p).toBe(false);
  });

  // (A test for "a gate with NEITHER deepLink nor needsSignIn" was deleted with `feature_disabled`:
  // that state is now unreachable, and gating.test.ts asserts it can never come back.)

  it("carries needsSignIn — the signed-out gate is the one with NO deep link", () => {
    // Its remedy is a sign-in hand-off, not a Settings section. Dropping the flag would leave the
    // dialog saying "Sign in to run agents in the cloud" with no route to signing in.
    const gate: CloudGate = {
      ok: false,
      reason: "signed_out",
      message: "Sign in to run agents in the cloud.",
      needsSignIn: true,
    };
    const p = planPromotion(input({ gate }));
    expect(p.ok === false && p.needsSignIn).toBe(true);
    expect(p.ok === false && p.deepLink).toBeUndefined();
  });

  it("refuses when there is no worktree", () => {
    const p = planPromotion(input({ agent: { ...input().agent, worktreePath: null } }));
    expect(p.ok === false && p.refusal).toBe("no_worktree");
  });

  it("refuses when the preflight could not be read at all", () => {
    const p = planPromotion(input({ preflight: null }));
    expect(p.ok === false && p.refusal).toBe("no_worktree");
    expect(p.ok === false && p.message).toMatch(/couldn't read/i);
  });

  it("refuses a detached HEAD", () => {
    const p = planPromotion(input({ preflight: preflight({ detached: true }) }));
    expect(p.ok === false && p.refusal).toBe("detached_head");
  });

  it("refuses when no branch ref exists", () => {
    const p = planPromotion(
      input({ preflight: preflight({ branchExists: false, branch: "" }) }),
    );
    expect(p.ok === false && p.refusal).toBe("no_branch");
  });

  it("refuses when there is no origin remote — nothing for a sandbox to clone", () => {
    const p = planPromotion(input({ preflight: preflight({ hasRemote: false }) }));
    expect(p.ok === false && p.refusal).toBe("no_remote");
    expect(p.ok === false && p.message).toMatch(/origin/);
  });

  it("names the FIRST thing to fix: detached HEAD outranks a missing remote", () => {
    // Both are wrong. A user who adds a remote while still detached has fixed nothing, so the
    // detached state is what must be surfaced.
    const p = planPromotion(
      input({ preflight: preflight({ detached: true, hasRemote: false, branchExists: false }) }),
    );
    expect(p.ok === false && p.refusal).toBe("detached_head");
  });

  it("the gate outranks git problems — an unusable account can't fix a branch into working", () => {
    const gate: CloudGate = { ok: false, reason: "signed_out", message: "Sign in.", needsSignIn: true };
    const p = planPromotion(input({ gate, preflight: preflight({ hasRemote: false }) }));
    expect(p.ok === false && p.refusal).toBe("cloud_gate");
  });
});

describe("planPromotion — warnings the dialog must render", () => {
  it("always warns that .gitignore'd files and stashes do not travel, even on a clean tree", () => {
    const p = proceed();
    expect(p.dirtyCount).toBe(0);
    expect(p.warnings.some((w) => /\.gitignore/.test(w) && /stash/.test(w))).toBe(true);
  });

  it("names the dirty COUNT, the files, and the literal WIP commit message", () => {
    const p = proceed({
      preflight: preflight({ dirtyCount: 3, dirtyFiles: ["src/a.ts", "src/b.ts", "README.md"] }),
    });
    const w = p.warnings.find((x) => /Uncommitted changes/.test(x))!;
    expect(w).toBeTruthy();
    expect(w).toContain("3 files");
    expect(w).toContain("src/a.ts");
    expect(w).toContain("src/b.ts");
    expect(w).toContain("README.md");
    expect(w).toContain(WIP_COMMIT_MESSAGE);
  });

  it("counts the remainder against the TRUE total, not the capped list", () => {
    // The Rust side caps `dirtyFiles` at 50 while `dirtyCount` stays true. A warning that measured
    // the remainder against the list would under-report by the amount that was already dropped.
    const files = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
    const p = proceed({ preflight: preflight({ dirtyCount: 200, dirtyFiles: files }) });
    const w = p.warnings.find((x) => /Uncommitted changes/.test(x))!;
    expect(w).toContain("200 files");
    expect(w).toContain("(+190 more)"); // 200 total − 10 shown
  });

  it("states, separately, that 'leave them behind' means those files do NOT travel", () => {
    const p = proceed({ preflight: preflight({ dirtyCount: 2, dirtyFiles: ["a", "b"] }) });
    const w = p.warnings.find((x) => /Leave them behind/.test(x))!;
    expect(w).toBeTruthy();
    expect(w).toMatch(/do NOT travel/);
    expect(w).toContain("2 files");
  });

  it("emits NO dirty warnings on a clean tree", () => {
    const p = proceed();
    expect(p.warnings.some((w) => /Uncommitted changes/.test(w))).toBe(false);
    expect(p.warnings.some((w) => /Leave them behind/.test(w))).toBe(false);
  });

  it("warns that live workers stay LOCAL, with the count", () => {
    const p = proceed({ workerCount: 3 });
    const w = p.warnings.find((x) => /worker/i.test(x))!;
    expect(w).toContain("3 live workers");
    expect(w).toMatch(/stay LOCAL/);
    expect(p.workerCount).toBe(3);
  });

  it("emits no worker warning when there are none", () => {
    expect(proceed({ workerCount: 0 }).warnings.some((w) => /live worker/.test(w))).toBe(false);
  });

  it("warns that unpushed commits will be pushed to origin, naming the branch", () => {
    const p = proceed({ preflight: preflight({ unpushed: 4 }) });
    const w = p.warnings.find((x) => /pushed to origin/.test(x))!;
    expect(w).toContain("4 commits");
    expect(w).toContain("sparkle/agent-42");
  });

  it("singularizes a lone commit and a lone file", () => {
    const p = proceed({
      preflight: preflight({ unpushed: 1, dirtyCount: 1, dirtyFiles: ["only.ts"] }),
    });
    expect(p.warnings.some((w) => /^1 commit on .+ is not on origin/.test(w))).toBe(true);
    expect(p.warnings.some((w) => /1 file: only\.ts/.test(w))).toBe(true);
  });

  it("passes the preflight's branch/counts through to the dialog", () => {
    const p = proceed({
      preflight: preflight({ branch: "feat/x", dirtyCount: 2, dirtyFiles: ["a"], unpushed: 7 }),
    });
    expect(p.branch).toBe("feat/x");
    expect(p.dirtyCount).toBe(2);
    expect(p.dirtyFiles).toEqual(["a"]);
    expect(p.unpushed).toBe(7);
  });

  it("falls back to the agent's recorded branch when the preflight resolved an empty one", () => {
    const p = proceed({ preflight: preflight({ branch: "" }) });
    expect(p.branch).toBe("sparkle/agent-42");
  });
});

describe("handoffNudge", () => {
  const base = { name: "Retry Hardening", branch: "sparkle/agent-42" };

  it("tells a RESUMED agent its conversation came with it, and not to re-plan", () => {
    const s = handoffNudge({ ...base, hadTranscript: true });
    expect(s).toMatch(/conversation came with you/i);
    expect(s).toMatch(/don't re-plan from scratch/i);
    // Continuity, not a fresh brief: it must not order a re-orientation sweep.
    expect(s).not.toMatch(/no memory/i);
    expect(s).not.toMatch(/Re-orient before you change anything/i);
  });

  it("tells an AMNESIAC agent the conversation did NOT travel, and to re-orient from git first", () => {
    const s = handoffNudge({ ...base, hadTranscript: false });
    expect(s).toMatch(/did NOT come with you/);
    expect(s).toMatch(/no memory/i);
    expect(s).toMatch(/git log --oneline/);
    expect(s).not.toMatch(/conversation came with you/i);
  });

  it("names the agent and its branch in both variants", () => {
    for (const hadTranscript of [true, false]) {
      const s = handoffNudge({ ...base, hadTranscript });
      expect(s).toContain("Retry Hardening");
      expect(s).toContain("sparkle/agent-42");
    }
  });

  it("admits a TRUNCATED transcript instead of presenting it as the whole history", () => {
    // "Your conversation came with you, read back through it" over a tail-capped transcript makes
    // the agent reference decisions that were silently dropped — and confabulate rather than say it
    // can't see them, which is the exact failure the amnesiac variant exists to prevent.
    const s = handoffNudge({ ...base, hadTranscript: true, transcriptTruncated: true });
    expect(s).toMatch(/TRUNCATED/);
    expect(s).toMatch(/oldest turns were dropped/);
    expect(s).toMatch(/say so rather than guessing/);
    expect(handoffNudge({ ...base, hadTranscript: true })).not.toMatch(/TRUNCATED/);
    expect(handoffNudge({ ...base, hadTranscript: true, transcriptTruncated: false })).not.toMatch(
      /TRUNCATED/,
    );
  });

  it("says files were LEFT BEHIND rather than committed, when they were", () => {
    for (const hadTranscript of [true, false]) {
      const left = handoffNudge({ ...base, hadTranscript, leftBehind: 3 });
      expect(left).toMatch(/3 uncommitted files were deliberately left/);
      expect(left).toMatch(/NOT in this clone/);
      expect(left).not.toMatch(/uncommitted work was committed/);

      const kept = handoffNudge({ ...base, hadTranscript, leftBehind: 0 });
      expect(kept).toMatch(/uncommitted work was committed/);
      expect(kept).not.toMatch(/deliberately left/);
    }
  });

  it("singularizes a single left-behind file", () => {
    expect(handoffNudge({ ...base, hadTranscript: true, leftBehind: 1 })).toMatch(
      /1 uncommitted file was deliberately left on the user's Mac and is NOT in this clone/,
    );
  });

  it("carries the goal when there is one, and adds nothing when there isn't", () => {
    expect(handoffNudge({ ...base, hadTranscript: true, goal: "land the retry PR" })).toContain(
      "land the retry PR",
    );
    expect(handoffNudge({ ...base, hadTranscript: true, goal: "   " })).not.toMatch(/Your goal/);
    expect(handoffNudge({ ...base, hadTranscript: true })).not.toMatch(/Your goal/);
  });
});

// ── remote_mismatch ─────────────────────────────────────────────────────────────────────────────
//
// We push to the LOCAL `origin`; the sandbox clones the URL the start request carries. When those
// differ, `git clone --branch <branch>` finds no such branch — and because `startSession` is
// fire-and-forget, the user learns about it as an await-live timeout, long AFTER their work was
// committed and pushed. So it has to be refused before anything is written.
describe("remote_mismatch", () => {
  it("proceeds when origin and the clone URL are the same repo in different clothes", () => {
    // scp-style SSH vs https, one with `.git`, one with a trailing slash: the same repo.
    const p = proceed({
      preflight: preflight({ originUrl: "git@github.com:Acme/Widgets.git" }),
      projectRepoUrl: "https://github.com/acme/widgets/",
    });
    expect(p.branch).toBe("sparkle/agent-42");
  });

  it("refuses when origin points at a different repo than the sandbox would clone", () => {
    const p = planPromotion(
      input({
        preflight: preflight({ originUrl: "https://github.com/acme/widgets" }),
        projectRepoUrl: "https://github.com/acme/gadgets",
      }),
    );
    expect(p.ok).toBe(false);
    if (p.ok) throw new Error("unreachable");
    expect(p.refusal).toBe("remote_mismatch");
  });

  it("refuses a fork whose origin is your copy while the clone URL names upstream", () => {
    const p = planPromotion(
      input({
        preflight: preflight({ originUrl: "git@github.com:me/widgets.git" }),
        projectRepoUrl: "https://github.com/acme/widgets",
      }),
    );
    expect(p.ok).toBe(false);
    if (p.ok) throw new Error("unreachable");
    expect(p.refusal).toBe("remote_mismatch");
  });

  // UNKNOWN is not a match. Either side missing means we cannot prove the sandbox will find the
  // branch, and proceeding would spend the user's commit and push to find out.
  it.each([
    ["the clone URL could not be resolved", { projectRepoUrl: null }],
    ["origin could not be read", { preflight: preflight({ originUrl: null }) }],
  ])("refuses when %s", (_label, over) => {
    const p = planPromotion(input(over as Partial<PromotionPlanInput>));
    expect(p.ok).toBe(false);
    if (p.ok) throw new Error("unreachable");
    expect(p.refusal).toBe("remote_mismatch");
  });
});

describe("normalizeRepoUrl", () => {
  it("folds every equivalent spelling of one repo together", () => {
    const forms = [
      "https://github.com/acme/widgets",
      "https://github.com/acme/widgets.git",
      "https://github.com/Acme/Widgets/",
      "git@github.com:acme/widgets.git",
      "ssh://git@github.com/acme/widgets",
    ].map(normalizeRepoUrl);
    expect(new Set(forms).size).toBe(1);
  });

  it("keeps genuinely different repos and hosts apart", () => {
    expect(normalizeRepoUrl("https://github.com/acme/widgets")).not.toBe(
      normalizeRepoUrl("https://github.com/acme/gadgets"),
    );
    // Same path, different host — an enterprise mirror is not the public repo.
    expect(normalizeRepoUrl("https://github.com/acme/widgets")).not.toBe(
      normalizeRepoUrl("https://git.acme.internal/acme/widgets"),
    );
  });
});
