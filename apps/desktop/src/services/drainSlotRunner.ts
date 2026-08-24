// ONE BACKLOG-DRAIN WORKER — the app-side spawn for a single parallel drain slot.
//
// ── WHY THIS EXISTS BESIDE runImprovementPass ────────────────────────────────────────────────────
// The HOURLY pass is a process-wide singleton by design: it shares ONE worktree with the interactive
// Improve-Sparkle pane (SPARKLE_AGENT_ID), so two `claude` in it would stash each other's work. That
// singleton is the concurrency-1 bottleneck the drainer inherited. Rather than lift it (and risk the
// hourly path's deliberate safety), the drain fleet is a SEPARATE bounded pool: each worker runs in
// its OWN worktree, keyed by a DISTINCT slot agent id (`__sparkle_self__-drain-<n>`), on its OWN
// rotated pool account, under its OWN per-slot latch and the multi-slot Rust manager's own slot. The
// hourly pass is untouched — distinct slots never contend.
//
// ── SAFETY (sensitive autonomous-spawn) ──────────────────────────────────────────────────────────
//  * The kill-switch, cap, dedup and account rotation are the BRIDGE's job (drainerBridge
//    planDrainDispatch) — this function is only reached for a bead the bridge already selected,
//    claimed and bounded. It re-checks consent (never ⇒ no spawn) as defense in depth.
//  * Claim-before-spawn: the per-slot latch (drainSlotLatch) is taken BEFORE the worker starts and
//    released when it settles, so the same slot is never double-run.
//  * Fresh base or refuse: the worktree is parked on origin/<base> before the worker starts; a park
//    that neither moved it nor found it fresh stops the run (never work from an unknown base).
//  * Own process group + slot-scoped cancel/watchdog: a hung worker is killed (whole group) at
//    PASS_TIMEOUT_MS via `sparkle_improve_cancel { slot }`, which never touches a sibling slot.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { checkClaude } from "../preflight";
import { safeUnlisten } from "./safeUnlisten";
import type { SparkleImprovementConsent } from "../stores/settingsStore";
import {
  checkSubmitCapability,
  ensureSparkleRepo,
  sparklePersona,
  SPARKLE_PROJECT_ID,
} from "./sparkleAgent";
import { registerSparkleTranscript } from "./sparkleTranscript";
import { accountConfigDirFor } from "./accountSelection";
import { buildPassControlMcp, drainMissionPrompt, PASS_TIMEOUT_MS, type DrainFocus } from "./improvementPass";
import { sparkleControlProtocol } from "./buildAgent";
import {
  assertWorkspaceIntegrity,
  createAgentWorktree,
  installWorktreeGuard,
  parkWorktreeOnBase,
} from "./worktree";
import { claimDrainSlot, releaseDrainSlot } from "./drainSlotLatch";
import { log } from "../logger";

/** The stable slot AGENT id for drain worker `index` — distinct per slot so each gets its OWN
 *  worktree (createAgentWorktree keys on it), its OWN rotated account (accountConfigDirFor keys on
 *  it), and its OWN Rust manager slot. Derived from SPARKLE_AGENT_ID so it is visibly a Sparkle-self
 *  agent, and NEVER equals it (that empty-suffix id is the hourly/interactive slot). */
export function drainSlotAgentId(index: number): string {
  return `__sparkle_self__-drain-${index}`;
}

/** Whether an id is a drain-slot id (not the hourly `__sparkle_self__`). */
export function isDrainSlotAgentId(id: string): boolean {
  return /^__sparkle_self__-drain-\d+$/.test(id);
}

type DrainOutcome = { ok: boolean; text: string };

/**
 * Run ONE drain worker for `focus.beadId` in slot `slotAgentId`. Resolves to whether a worker
 * actually RAN (reached the child and it reported) — false on every early bail (consent off, slot
 * already busy, no claude, park refused, spawn failed, timeout). The bridge acks the spooled request
 * only when this returns true, so a bailed slot never loses its bead.
 */
export async function runDrainSlot(
  slotAgentId: string,
  focus: DrainFocus,
  consent: SparkleImprovementConsent,
): Promise<boolean> {
  if (consent === "never") return false; // consent kill-switch (defense in depth)
  if (!claimDrainSlot(slotAgentId)) return false; // per-slot dedup — never double-run a slot
  try {
    const claude = await checkClaude();
    if (!claude.installed || !claude.path) return false; // not set up — skip quietly

    const ws = await ensureSparkleRepo();
    const wt = await createAgentWorktree(ws.repoPath, SPARKLE_PROJECT_ID, slotAgentId, ws.defaultBranch);
    // Park on a FRESH origin/<base> before starting; "stash" because this worktree is app-owned end
    // to end. Refuse (don't run) from an unknown base — the same rule the hourly pass follows.
    const park = await parkWorktreeOnBase(
      ws.repoPath,
      SPARKLE_PROJECT_ID,
      slotAgentId,
      ws.defaultBranch,
      "stash",
    );
    if (!park.parked && park.reason !== "already-fresh") {
      log.warn("drain-slot", "refusing to run from an unknown base", { slot: slotAgentId, reason: park.reason });
      return false;
    }

    // The worker's rotated pool account — keyed by the SLOT id, so each slot resolves (and remembers)
    // a DISTINCT account and the fleet spreads across the pool instead of piling onto one, reusing the
    // same pickAccount rotation (lowest-usage, skips exhausted) every agent spawn uses.
    const configDir = (await accountConfigDirFor(slotAgentId)) ?? null;
    registerSparkleTranscript(slotAgentId, wt.path, configDir);

    try {
      await installWorktreeGuard(wt.path);
    } catch (e) {
      log.warn("drain-slot", "guard install failed (relocation still protects)", { slot: slotAgentId, error: String(e) });
    }
    await assertWorkspaceIntegrity(wt.path);

    const submit = await checkSubmitCapability().catch(() => null);
    const persona = sparklePersona(ws.logDir, wt.path, consent, submit?.verdict ?? "unknown", { attended: false });
    const prompt = drainMissionPrompt(focus, consent, submit?.verdict ?? "unknown");

    const outcome = await new Promise<DrainOutcome>((resolve) => {
      const unlisteners: Array<() => void> = [];
      let settled = false;
      const finish = (v: DrainOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const u of unlisteners) void safeUnlisten(u);
        resolve(v);
      };
      // Hung-worker watchdog — kill THIS slot's group (never a sibling's) and settle.
      const timer = setTimeout(() => {
        void invoke("sparkle_improve_cancel", { slot: slotAgentId }).catch(() => {});
        finish({ ok: false, text: `drain slot timed out after ${PASS_TIMEOUT_MS / 60000} minutes and was killed` });
      }, PASS_TIMEOUT_MS);
      const track = (u: () => void) => {
        if (settled) void safeUnlisten(u);
        else unlisteners.push(u);
      };
      // SLOT-SCOPED: the manager broadcasts sparkle_improve:* for every slot, so each listener must
      // ignore any payload whose slot is not THIS worker's — otherwise a sibling's done/error would
      // settle this one.
      const mine = (slot: string | undefined) => slot === slotAgentId;
      Promise.all([
        listen<{ sessionId: string; text: string; slot?: string }>("sparkle_improve:done", (ev) => {
          if (!mine(ev.payload.slot)) return;
          finish({ ok: true, text: ev.payload.text });
        }).then(track),
        listen<{ message: string; sessionId?: string; slot?: string }>("sparkle_improve:error", (ev) => {
          if (!mine(ev.payload.slot)) return;
          finish({ ok: false, text: ev.payload.message });
        }).then(track),
      ]).then(
        () => {
          if (settled) return;
          void buildPassControlMcp().then((mcpConfig) => {
            if (settled) return;
            const controlUp = mcpConfig !== undefined;
            invoke("sparkle_improve_run", {
              cwd: wt.path,
              claudePath: claude.path,
              persona: controlUp ? `${persona}\n\n${sparkleControlProtocol()}` : persona,
              prompt,
              logDir: ws.logDir,
              mcpConfig,
              configDir,
              slot: slotAgentId,
            }).catch((e) => finish({ ok: false, text: String(e) }));
          }, (e) => finish({ ok: false, text: String(e) }));
        },
        (e) => finish({ ok: false, text: String(e) }),
      );
    });

    if (outcome.ok) {
      log.info("drain-slot", "worker finished", { slot: slotAgentId, bead: focus.beadId });
    } else {
      log.warn("drain-slot", "worker did not complete", { slot: slotAgentId, bead: focus.beadId, detail: outcome.text });
    }
    return outcome.ok;
  } catch (e) {
    log.warn("drain-slot", "worker errored during setup", { slot: slotAgentId, error: String(e) });
    return false;
  } finally {
    releaseDrainSlot(slotAgentId);
  }
}
