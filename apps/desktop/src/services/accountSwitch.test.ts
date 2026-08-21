import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import {
  isSafeToSwitch,
  planSwitch,
  planSwitchToAccount,
  readyToMove,
  advanceSwitch,
  moveAgent,
  isSwitchComplete,
  revalidateSwitchTarget,
  planHelperRescue,
  type SwitchPlan,
} from "./accountSwitch";
import { getPin, setPin, clearAllPins } from "./accountStore";
import type { Account, Usage, Identity } from "./accountStore";
import type { Ceiling } from "./headroom";
import type { AgentTabStatus } from "../types";

beforeEach(() => clearAllPins());

describe("isSafeToSwitch", () => {
  it("refuses to switch an agent that is mid-turn", () => {
    // `working` = Claude Code actively producing output. Re-spawning here loses in-flight work and
    // can interrupt a tool call — the exact risk that made Phase 1 decline to switch at all.
    expect(isSafeToSwitch("working")).toBe(false);
  });

  it("allows every status where the turn is over", () => {
    const safe: AgentTabStatus[] = [
      "idle",
      "waiting",
      "approval",
      "blocked",
      "errored",
      "unmerged",
      "done",
      "stopped",
    ];
    for (const s of safe) expect(isSafeToSwitch(s)).toBe(true);
  });

  it("treats an unknown status as safe (no pane / not reporting)", () => {
    expect(isSafeToSwitch(undefined)).toBe(true);
  });
});

describe("planSwitch", () => {
  it("enrolls only agents on the account being left", () => {
    const plan = planSwitch("a", "b", { one: "a", two: "b", three: "a", four: undefined });
    expect(plan.pending.sort()).toEqual(["one", "three"]);
    expect(plan.moved).toEqual([]);
    expect(plan.fromAccountId).toBe("a");
    expect(plan.toAccountId).toBe("b");
  });

  it("produces an already-complete plan when nothing is on that account", () => {
    const plan = planSwitch("a", "b", { one: "b" });
    expect(plan.pending).toEqual([]);
    expect(isSwitchComplete(plan)).toBe(true);
  });

  it("DOES enrol an unpinned sticky consumer — the banner rescues it from an exhausting account", () => {
    // The deliberate asymmetry with planSwitchToAccount below. The banner is raised because this
    // account is out of headroom, and nothing else re-spawns an Improve Sparkle pane on headroom
    // grounds — so excluding it here would strand it on the exhausting account holding its
    // spawn-time CLAUDE_CONFIG_DIR, and when it is the ONLY pane there the accept becomes a no-op
    // the banner re-raises every 120s forever. Stickiness protects these two from a PREFERENCE, not
    // from a rate limit. The `-win-` variant is here because a satellite window's own pane map holds
    // it (sparkleAgentIdFor), so it is a shape this path really sees.
    const plan = planSwitch("a", "b", {
      one: "a",
      __sparkle_self__: "a",
      "__sparkle_self__-win-6f2c": "a",
    });
    expect(plan.pending.sort()).toEqual(["__sparkle_self__", "__sparkle_self__-win-6f2c", "one"]);
  });

  it("…but never one a PERSON pinned, however out of headroom the account is", () => {
    // PAIRED with the rescue above. A pin outranks every judgement selection makes, including this
    // one: a user who parked Improve Sparkle on an account with the modal's own control keeps it
    // there, which is exactly what a pin promises. Same rule for an ordinary agent.
    setPin("__sparkle_self__", "a");
    setPin("hand-pinned", "a");
    const plan = planSwitch("a", "b", { one: "a", __sparkle_self__: "a", "hand-pinned": "a" });
    expect(plan.pending).toEqual(["one"]);
  });
});

describe("planSwitchToAccount — the manual activation's plan", () => {
  it("enrols every agent not KNOWN to be on the target already, whatever account it is on", () => {
    // `four` has no recorded account, and it is enrolled — the rule is "enrol unless we can show it
    // is already home", not "enrol only what we can place". A mounted pane whose account never got
    // recorded is one we cannot prove is on the target, and leaving it behind is precisely what
    // makes the control look broken.
    const plan = planSwitchToAccount("b", { one: "a", two: "c", three: "b", four: undefined });
    expect(plan.pending.sort()).toEqual(["four", "one", "two"]);
    expect(plan.fromAccountId).toBeNull();
    expect(plan.toAccountId).toBe("b");
  });

  it("never enrols a sticky consumer — activation must not move the two that are sticky", () => {
    // The PAIRED half of the planSwitch case above: the manual path is the one that sweeps EVERY
    // account, so it is the one most likely to catch a sticky pane, and the modal promises in so
    // many words that activating an account does not move these two.
    const plan = planSwitchToAccount("b", {
      one: "a",
      __sparkle_self__: "a",
      "__sparkle_self__-win-6f2c": "c",
      "sparkle:concierge": "a",
    });
    expect(plan.pending).toEqual(["one"]);
  });
});

describe("readyToMove / advanceSwitch — each agent switches at its OWN safe moment", () => {
  const base: SwitchPlan = { fromAccountId: "a", toAccountId: "b", pending: ["x", "y", "z"], moved: [] };

  it("moves only the agents that are currently idle, leaving busy ones pending", () => {
    const statuses: Record<string, AgentTabStatus> = { x: "idle", y: "working", z: "waiting" };
    expect(readyToMove(base, statuses).sort()).toEqual(["x", "z"]);

    const restart = vi.fn(() => true);
    const { plan, movedNow } = advanceSwitch(base, statuses, restart);
    expect(movedNow.sort()).toEqual(["x", "z"]);
    expect(plan.pending).toEqual(["y"]); // still busy — deliberately not yanked
    expect(plan.moved.sort()).toEqual(["x", "z"]);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(isSwitchComplete(plan)).toBe(false);
  });

  it("finishes the straggler on a later pass, once it goes idle", () => {
    const restart = vi.fn(() => true);
    const first = advanceSwitch(base, { x: "idle", y: "working", z: "idle" }, restart).plan;
    const second = advanceSwitch(first, { y: "idle" }, restart);
    expect(second.movedNow).toEqual(["y"]);
    expect(isSwitchComplete(second.plan)).toBe(true);
    expect(second.plan.moved.sort()).toEqual(["x", "y", "z"]);
  });

  it("is a no-op pass when every pending agent is busy", () => {
    const restart = vi.fn(() => true);
    const { plan, movedNow } = advanceSwitch(base, { x: "working", y: "working", z: "working" }, restart);
    expect(movedNow).toEqual([]);
    expect(plan).toBe(base); // unchanged reference — nothing to rewrite
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("moveAgent", () => {
  it("pins BEFORE restarting, so the re-spawn picks up the new account", () => {
    // Order is load-bearing: the spawn path reads the pin while building the exec, so pinning after
    // the restart would re-spawn onto the OLD account and silently do nothing.
    const order: string[] = [];
    const restart = vi.fn((id: string) => {
      order.push(`restart:${id}`);
      order.push(`pin-at-restart:${getPin(id)}`);
      return true;
    });
    moveAgent("x", "b", restart);
    expect(order).toEqual(["restart:x", "pin-at-restart:b"]);
    expect(getPin("x")).toBe("b");
  });

  it("still records the pin when no pane is mounted to restart", () => {
    // A closed agent has no pane; it must still come back on the new account next time it spawns.
    const restart = vi.fn(() => false);
    expect(moveAgent("gone", "b", restart)).toBe(false);
    expect(getPin("gone")).toBe("b");
  });

  it("rescues a sticky consumer by re-spawning it WITHOUT writing a pin", () => {
    // Only the banner reaches a sticky key here, and there the job is to get it off an account at
    // its ceiling — which the re-spawn alone does, because it re-resolves through
    // chooseAccountForAgent and an OBSERVED exhaustion is exactly what may move a sticky selection.
    // Writing a pin instead does two harms: it launders a machinery choice into the slot the modal
    // renders back as the user's own, and on a `-win-` variant it lands on a key `stickyPin` PREFERS
    // over the base one, detaching that window from the modal's control after the limit resets.
    const restart = vi.fn(() => true);
    expect(moveAgent("__sparkle_self__", "b", restart)).toBe(true);
    expect(restart).toHaveBeenCalledWith("__sparkle_self__");
    expect(getPin("__sparkle_self__")).toBeUndefined();

    moveAgent("__sparkle_self__-win-6f2c", "b", restart);
    expect(getPin("__sparkle_self__-win-6f2c")).toBeUndefined();
  });

  it("…and CLEARS a sticky consumer's existing human pin, because it points at the walled account", () => {
    // ⚠️ THIS TEST ASSERTED THE OPPOSITE UNTIL 8829eaebc, and the reversal is deliberate — see the
    // rationale on `accountSwitch.ts`'s `isStickyAccountKey` branch, which states it directly: "a
    // pin promising 'run here' is meaningless when 'here' is a walled account… Without the clear,
    // the re-spawn re-reads the pin (`chooseAccountForAgent` → `stickyPin`) and bounces straight
    // back to the walled account."
    //
    // The old name ("leaves … exactly as the user set it") described the banner path, which can
    // never hand a hand-pinned sticky key here (`unpinnedRunning` drops it first). The HELPER
    // RESCUE deliberately does, which is what made the clear necessary. The commit changed the
    // behaviour and left this test describing the old one, turning main red for every open PR.
    setPin("__sparkle_self__", "personal");
    moveAgent("__sparkle_self__", "b", vi.fn(() => true));
    expect(getPin("__sparkle_self__")).toBeUndefined();
  });

  it("…and clears the BASE key's pin when a satellite VARIANT is the one being rescued", () => {
    // roborev 65980. `clearPin(agentId)` deletes the pin for that exact key, but `stickyPin`
    // (accountSelection.ts) falls back from a `__sparkle_self__-win-<uuid>` variant to the pin on
    // the BASE `__sparkle_self__`. So rescuing a satellite window cleared a variant pin that almost
    // never exists, left the human pin that is actually READ, and the re-spawn re-read it and
    // bounced straight back to the walled account — precisely the failure the clear was added to
    // prevent, for every satellite window.
    setPin("__sparkle_self__", "personal");
    moveAgent("__sparkle_self__-win-6f2c", "b", vi.fn(() => true));
    expect(getPin("__sparkle_self__")).toBeUndefined();
  });
});

describe("a switch actually changes the account the agent runs under", () => {
  // REGRESSION GUARD for the highest-severity defect found in review of this branch.
  //
  // The first implementation registered `Terminal.restart()` as the pane's switch lever. That only
  // bumps Terminal's internal `attempt`; its spawn effect is keyed on [agentId, attempt] and
  // re-reads the `args` PROP, which still held the exec string built by the last prepare() — with
  // the OLD account's CLAUDE_CONFIG_DIR baked in. So every "switch" re-spawned onto the same
  // account while reporting success, the pane re-registered the old account, and the next poll
  // re-issued the same recommendation — accepting repeatedly would churn the whole fleet while the
  // quota kept draining on the account it was supposed to leave.
  //
  // The invariant that makes a switch real: the pin must be readable BEFORE the exec is rebuilt,
  // and the rebuilt exec must carry the new config dir. This test pins exactly that.
  it("the exec rebuilt after a move carries the NEW account's config dir", async () => {
    const { buildClaudeExec } = await import("./claudeSpawn");
    const dirFor: Record<string, string> = { a: "/cfg/old-account", b: "/cfg/new-account" };

    // Stand-in for AgentPane's prepare(): reads the pin, then builds the exec from it — the same
    // order the real path uses (chooseAccountForAgent → getPin → buildClaudeExec).
    const rebuildExec = (agentId: string) => {
      const pinned = getPin(agentId) ?? "a";
      return buildClaudeExec("/bin/claude", false, { configDir: dirFor[pinned] });
    };

    expect(rebuildExec("x")).toContain("/cfg/old-account");

    // A restart lever that RE-PREPARES (rebuilds the exec) rather than merely re-spawning.
    let lastExec = "";
    const reprepare = (agentId: string) => {
      lastExec = rebuildExec(agentId);
      return true;
    };

    moveAgent("x", "b", reprepare);

    expect(lastExec).toContain("/cfg/new-account");
    expect(lastExec).not.toContain("/cfg/old-account");
    // And a fresh rebuild keeps landing on the new account, so the pane re-registers it.
    expect(rebuildExec("x")).toContain("/cfg/new-account");
  });
});

// ── revalidateSwitchTarget — re-plan when a switch target goes invalid mid-migration ─────────────
describe("revalidateSwitchTarget", () => {
  const NOW = 1_000_000;
  const WALL = NOW + 3_600_000; // an observed rate-limit wall an hour out
  const a = (id: string): Account => ({
    id,
    nickname: id,
    configDir: `/cfg/${id}`,
    isDefault: false,
    createdAt: 0,
  });
  const u = (id: string, exhaustedUntil: number | null = null): Usage => ({
    id,
    tokens5h: 0,
    tokens7d: 0,
    exhaustedUntil,
  });
  const ident = (id: string): Identity => ({
    id,
    email: `${id}@example.com`,
    organization: null,
    accountUuid: `uuid-${id}`,
  });
  const plan = (toAccountId: string, fromAccountId: string | null = "from"): SwitchPlan => ({
    fromAccountId,
    toAccountId,
    pending: ["agent-1", "agent-2"],
    moved: [],
  });
  const noCeil: Ceiling[] = [];

  it("leaves a still-healthy target untouched", () => {
    const accounts = [a("from"), a("to"), a("other")];
    const idents = [ident("from"), ident("to"), ident("other")];
    const p = plan("to");
    const r = revalidateSwitchTarget(p, accounts, [u("to")], noCeil, idents, NOW, []);
    expect(r.kind).toBe("ok");
    expect(r.plan).toBe(p); // same object — nothing re-planned
  });

  it("re-targets to a healthy account when the target has hit its OWN wall mid-migration", () => {
    const accounts = [a("from"), a("to"), a("other")];
    const idents = [ident("from"), ident("to"), ident("other")];
    const r = revalidateSwitchTarget(
      plan("to"),
      accounts,
      [u("to", WALL)], // the chosen target is now walled
      noCeil,
      idents,
      NOW,
      [],
    );
    expect(r.kind).toBe("retargeted");
    expect(r.plan.toAccountId).toBe("other");
    expect(r.plan.pending).toEqual(["agent-1", "agent-2"]); // pending redirected, not dropped
  });

  it("re-targets when the target was REMOVED mid-migration (gone from accounts)", () => {
    const accounts = [a("from"), a("other")]; // "gone" no longer registered
    const idents = [ident("from"), ident("other")];
    const r = revalidateSwitchTarget(plan("gone"), accounts, [], noCeil, idents, NOW, []);
    expect(r.kind).toBe("retargeted");
    expect(r.plan.toAccountId).toBe("other");
  });

  it("re-targets when the target's LOGIN expired mid-migration (no longer signed in)", () => {
    const accounts = [a("from"), a("to"), a("other")];
    const idents = [ident("from"), ident("other")]; // "to" lost its login
    const r = revalidateSwitchTarget(plan("to"), accounts, [u("to")], noCeil, idents, NOW, []);
    expect(r.kind).toBe("retargeted");
    expect(r.plan.toAccountId).toBe("other");
  });

  it("HOLDS — moves nobody — when the target is dead and nothing healthy remains", () => {
    const accounts = [a("from"), a("to"), a("other")];
    const idents = [ident("from"), ident("to"), ident("other")];
    const p = plan("to");
    const r = revalidateSwitchTarget(
      p,
      accounts,
      [u("to", WALL), u("other", WALL)], // both the target and the only alternative are walled
      noCeil,
      idents,
      NOW,
      [],
    );
    expect(r.kind).toBe("held");
    expect(r.plan).toBe(p);
  });

  it("never re-targets back to the account being VACATED, even when it is the only healthy one", () => {
    // The whole point of the switch is to get OFF `from`; sending agents back would undo it. With the
    // target walled and `from` the only other signed-in account, the correct answer is HOLD, not from.
    const accounts = [a("from"), a("to")];
    const idents = [ident("from"), ident("to")];
    const r = revalidateSwitchTarget(
      plan("to"),
      accounts,
      [u("to", WALL)], // to walled; from perfectly healthy
      noCeil,
      idents,
      NOW,
      [],
    );
    expect(r.kind).toBe("held");
  });

  it("folds ALREADY-MOVED agents back into pending on a re-target, so none is left on the dead target", () => {
    // A retarget must not leave the agents that already reached the (now-dead) target stranded on it:
    // nothing else moves them (the exhaustion auto-switch judges the busiest account, which after a
    // retarget is the NEW target, not the dead one). Fold `moved` into `pending` under the new target.
    const accounts = [a("from"), a("to"), a("other")];
    const idents = [ident("from"), ident("to"), ident("other")];
    const inFlight: SwitchPlan = {
      fromAccountId: "from",
      toAccountId: "to",
      pending: ["still-pending"],
      moved: ["already-moved-1", "already-moved-2"],
      revalidate: true,
      ownsPreference: true,
    };
    const r = revalidateSwitchTarget(inFlight, accounts, [u("to", WALL)], noCeil, idents, NOW, []);
    expect(r.kind).toBe("retargeted");
    expect(r.plan.toAccountId).toBe("other");
    expect(r.plan.pending.sort()).toEqual(["already-moved-1", "already-moved-2", "still-pending"]);
    expect(r.plan.moved).toEqual([]);
  });
});

// ── plan target-ownership flags — who may re-validate, who owns the fleet preference ─────────────
describe("plan target-ownership flags", () => {
  it("planSwitch (auto/accept) may re-validate AND owns the fleet preference", () => {
    const p = planSwitch("a", "b", { one: "a" });
    expect(p.revalidate).toBe(true);
    expect(p.ownsPreference).toBe(true);
  });

  it("planSwitchToAccount (manual activation) may NOT be re-validated — the user chose the target", () => {
    const p = planSwitchToAccount("b", { one: "a" });
    expect(p.revalidate).toBe(false);
    expect(p.ownsPreference).toBe(false);
  });

  it("planHelperRescue may re-validate but does NOT own the fleet preference (it only relocates the pair)", () => {
    const p = planHelperRescue("a", "b", { __sparkle_self__: "a" });
    expect(p.revalidate).toBe(true);
    expect(p.ownsPreference).toBe(false);
  });
});
