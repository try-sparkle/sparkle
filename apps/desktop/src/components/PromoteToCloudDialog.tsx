import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  FiAlertTriangle,
  FiCheckCircle,
  FiUploadCloud,
  FiX,
} from "react-icons/fi";
import { C, DANGER, MODAL_SHADOW, ON_BRAND_FILL, SCRIM } from "../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS } from "../theme/scale";
import { FONT_WEIGHT } from "@sparkle/ui";
import type { AgentTab, Project } from "../types";
import { useUiStore } from "../stores/uiStore";
import { useProjectStore } from "../stores/projectStore";
import { useCloudGate } from "../hooks/useCloudAgents";
import { cloudApi } from "../services/cloudAgents/api";
import { deepLinkActionLabel } from "../services/cloudAgents/gating";
import { cloudCostLine } from "../services/cloudAgents/cloudCostEstimate";
import { useAuthStore } from "../stores/authStore";
import { openSignIn } from "../services/sparkleApi";
import { projectRepoUrl } from "../services/cloudAgents/repoUrl";
import { ensureCloudProjectId } from "../services/cloudAgents/projectLink";
import { projectBindingSets } from "../services/cloudAgents/projectBinding";
import { ModalLayer } from "./ModalLayer";
import { invoke } from "@tauri-apps/api/core";
// The contract lives in services/agentPromotion (plan §D) and is imported, never re-declared here:
// a local copy of these shapes would let the UI and the state machine drift silently, which is the
// one failure this feature cannot afford. See the MERGE POINT note on `promoteDialogDeps` below.
import {
  WIP_COMMIT_MESSAGE,
  planPromotion,
  type DirtyPolicy,
  type PromotionPlan,
  type PromotionPlanInput,
} from "../services/agentPromotion/plan";
import {
  promoteAgentToCloud,
  type PromoteDeps,
  type PromoteResult,
  type PromotionStep,
} from "../services/agentPromotion/promote";
import { makePromoteDeps } from "../services/agentPromotion/live";

// ── "I'M CLOSING THE LAPTOP" ────────────────────────────────────────────────────────────────────
//
// This dialog is the user's LAST chance to understand what travels and what does not, and it is
// written for someone who is about to walk away and stop watching. So it states, before the button
// is reachable:
//
//   • the BRANCH — and that the cloud agent stays on it, rather than cutting its own;
//   • the UNCOMMITTED state — "clean", or the files themselves, by name;
//   • the DIRTY CHOICE — commit (default) with the commit message shown verbatim, or leave behind,
//     worded so that choosing it means having read that those files do not travel. Silently
//     dropping uncommitted work is the failure mode this whole feature is designed against
//     (spec Decision 1), so it is neither buried nor the default;
//   • the CONVERSATION — that Sparkle tries to carry it, and, honestly, what the cloud agent will
//     know instead when it can't (spec Decision 2);
//   • every `plan.warnings[]` entry, RENDERED — not counted, not summarised.
//
// While it runs, it names the step it is on and says the local agent is still running; that is the
// copy-then-cut invariant made visible. On failure it names the step that failed and says, plainly,
// that nothing was stopped.

/** How many dirty paths the list shows before it collapses into "and N more". The plan's
 *  `dirtyFiles` is itself capped (Rust caps at 50) while `dirtyCount` is the TRUE total, so the
 *  overflow line is computed against the count, never against the array length. */
export const DIRTY_LIST_CAP = 8;

/** Every step, in the order the state machine runs them (contract D's `PromotionStep`). Listed here
 *  so the running view can show the whole ladder — a user who is about to close the laptop should
 *  see how much is left, not just a spinner. */
const STEPS: readonly { id: PromotionStep; label: string }[] = [
  { id: "preflight", label: "Reading the worktree" },
  { id: "commit", label: "Committing your uncommitted changes" },
  { id: "push", label: "Pushing the branch" },
  { id: "transcript", label: "Copying the conversation" },
  { id: "start", label: "Starting the cloud sandbox" },
  { id: "await_live", label: "Waiting for the cloud agent to come up" },
  { id: "cutover", label: "Handing over — stopping the local agent" },
];

const stepLabel = (step: PromotionStep): string =>
  STEPS.find((s) => s.id === step)?.label ?? step;

/** The dialog's whole IO surface, injected so the confirm copy can be tested against a hand-built
 *  plan without W3's state machine or a live sandbox. */
export interface PromoteToCloudDeps {
  /** Preflight + `planPromotion` — the refusal-or-plan the dialog renders. */
  loadPlan: () => Promise<PromotionPlan>;
  /** Run the promotion. `onStep` fires as each step begins so the dialog can name it. */
  promote: (args: {
    dirtyPolicy: DirtyPolicy;
    onStep: (step: PromotionStep) => void;
  }) => Promise<PromoteResult>;
}

/** The preflight shape, taken FROM the plan input rather than re-declared — one contract, one
 *  place. (Rust's `PromotionPreflight`, contract C, serialized over the Tauri boundary.) */
type Preflight = NonNullable<PromotionPlanInput["preflight"]>;

/**
 * The real deps: Tauri preflight → the pure plan, and the copy-then-cut state machine.
 *
 * ── MERGE POINT ────────────────────────────────────────────────────────────────────────────────
 * `PromoteInput` and `PromoteDeps` belong to services/agentPromotion (plan §D) and are IMPORTED,
 * never re-declared, so a drift in either shape is a compile error here rather than the dialog and
 * the state machine quietly disagreeing about what promotion does.
 *
 * The deps themselves come from `makePromoteDeps()` — the one place the real transport, store and
 * Tauri commands meet. This dialog deliberately assembles NONE of them by hand: an earlier draft
 * did, and its hand-rolled `awaitFirstFrame` was a bare `onOutput` + timeout that silently no-ops
 * against a null relay socket and never re-emits `watch`, so a promotion whose socket was not up
 * would run out its two-minute clock and then DELETE a perfectly healthy sandbox. The tested
 * implementation in `live.ts` handles both.
 */
export function promoteDialogDeps(args: {
  project: Project;
  agent: AgentTab;
  gate: ReturnType<typeof useCloudGate>;
  workerCount: number;
}): PromoteToCloudDeps {
  const { project, agent, gate, workerCount } = args;
  const baseBranch = agent.baseBranch ?? project.defaultBranch ?? "main";

  // Resolved ONCE and reused: the URL the plan checks against local `origin` must be the very URL
  // the sandbox is told to clone, or the guard can pass while a different repo is cloned — the one
  // failure it exists to prevent. Cached so the confirm click doesn't re-run `gh`.
  let repoUrlOnce: Promise<string | null> | null = null;
  const resolveRepoUrl = () => (repoUrlOnce ??= projectRepoUrl(project.rootPath));

  return {
    loadPlan: async () => {
      // A preflight is only meaningful for an agent that HAS a worktree, and a failed one is not an
      // error to shout about — `planPromotion` turns a null preflight into the honest refusal
      // ("no_worktree"), which is a better answer than a raw git message.
      const [preflight, repoUrl] = await Promise.all([
        agent.worktreePath
          ? invoke<Preflight>("promotion_preflight", {
              root: project.rootPath,
              agentId: agent.id,
              worktree: agent.worktreePath,
              baseBranch,
            }).catch(() => null)
          : Promise.resolve(null),
        resolveRepoUrl().catch(() => null),
      ]);
      return planPromotion({
        agent: {
          id: agent.id,
          runtime: agent.runtime,
          kind: agent.kind,
          worktreePath: agent.worktreePath,
          branch: agent.branch,
          goal: agent.goal,
          name: agent.name,
        },
        preflight,
        gate,
        workerCount,
        projectRepoUrl: repoUrl,
      });
    },

    promote: async ({ dirtyPolicy, onStep }) => {
      // Both of these are resolved BEFORE the state machine starts, so a failure here costs the
      // user nothing: no commit has been made, nothing has been pushed, no session exists.
      const repoUrl = await resolveRepoUrl();
      if (!repoUrl) {
        return {
          ok: false,
          step: "preflight",
          message:
            "Couldn't determine this project's GitHub URL, so the cloud sandbox would have nothing to clone.",
        };
      }
      const cloudProjectId = await ensureCloudProjectId(project, {
        api: cloudApi,
        remember: (localId, cloudId) =>
          useProjectStore.getState().setCloudProjectId(localId, cloudId),
        ...projectBindingSets(project.id),
      });

      return promoteAgentToCloud(
        {
          agentId: agent.id,
          projectId: project.id,
          cloudProjectId,
          root: project.rootPath,
          worktree: agent.worktreePath ?? "",
          branch: agent.branch ?? "",
          baseBranch,
          repoUrl,
          agentName: agent.name,
          goal: agent.goal?.text,
          dirtyPolicy,
        },
        makePromoteDeps({ onStep } satisfies Partial<PromoteDeps>),
      );
    },
  };
}

export function PromoteToCloudDialog({
  agent,
  deps,
  onClose,
}: {
  agent: Pick<AgentTab, "id" | "name">;
  deps: PromoteToCloudDeps;
  onClose: () => void;
}) {
  const openSettings = useUiStore((s) => s.openSettings);
  // Server-stated rate, server-enforced floor, server-held balance; the arithmetic is the shared
  // pure helper. Nothing about the price is decided here.
  const rate = useAuthStore((s) => s.me?.cloudAgentPricing?.centsPerMinute);
  const minStartCents = useAuthStore((s) => s.me?.cloudAgentPricing?.minStartCents);
  const balanceCents = useAuthStore((s) => s.me?.balanceCents ?? 0);
  const refreshMe = useAuthStore((s) => s.refresh);
  const costLine = cloudCostLine(rate, balanceCents, minStartCents);

  // RE-READ THE BALANCE ON OPEN — see the identical note in NewCloudAgentDialog. A running cloud
  // agent debits every minute and nothing pushes that back to the desktop, so a persisted `me`
  // quotes runtime that is already spent. This dialog is the more exposed of the two: the user is
  // promoting BECAUSE something has been running.
  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);
  const [plan, setPlan] = useState<PromotionPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // COMMIT IS THE DEFAULT, and it is the default because the failure this feature exists to prevent
  // is losing work — a commit loses nothing, and `git reset --soft HEAD~1` undoes it (Decision 1).
  const [policy, setPolicy] = useState<DirtyPolicy>("commit");
  const [step, setStep] = useState<PromotionStep | null>(null);
  const [failure, setFailure] = useState<
    { step: PromotionStep; message: string; orphanedSessionId?: string } | null
  >(null);
  const [moved, setMoved] = useState(false);

  // ONE preflight, on open — through a ref so a caller that rebuilds its `deps` object on an
  // unrelated re-render can't re-run a git read (and re-answer a question the user is mid-way
  // through reading). The dialog is short-lived; a stale plan is not a hazard here, a churning one
  // is.
  const depsRef = useRef(deps);
  depsRef.current = deps;
  useEffect(() => {
    let alive = true;
    depsRef.current
      .loadPlan()
      .then((p) => {
        if (alive) setPlan(p);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(String(err instanceof Error ? err.message : err));
      });
    return () => {
      alive = false;
    };
  }, []);

  const agentLabel = agent.name || "this agent";
  const running = step !== null;

  const confirm = async () => {
    if (!plan?.ok || running) return;
    setFailure(null);
    setStep("preflight");
    try {
      const res = await deps.promote({ dirtyPolicy: policy, onStep: setStep });
      if (res.ok) {
        setMoved(true);
        return;
      }
      setFailure({
        step: res.step,
        message: res.message,
        ...(res.orphanedSessionId ? { orphanedSessionId: res.orphanedSessionId } : {}),
      });
    } catch (err) {
      // A throw is not a step-tagged refusal, so it is reported against the step that was running
      // — which is still the honest answer to "where did this stop?".
      setFailure({
        step: step ?? "preflight",
        message: String(err instanceof Error ? err.message : err),
      });
    } finally {
      setStep(null);
    }
  };

  const goToSettings = (cat: Parameters<typeof openSettings>[0]) => {
    openSettings(cat);
    onClose();
  };

  return (
    <ModalLayer>
      <div
        data-testid="promote-backdrop"
        onClick={running ? undefined : onClose}
        style={backdrop}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Move agent to cloud"
        data-testid="promote-dialog"
        style={dialog}
      >
        <div style={titleBar}>
          <div style={titleText}>
            <FiUploadCloud size={16} />
            Move {agentLabel} to the cloud
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            disabled={running}
            style={{ ...closeBtn, opacity: running ? 0.4 : 1 }}
          >
            <FiX size={18} />
          </button>
        </div>

        <div style={body}>
          {moved ? (
            <div style={panel} data-testid="promote-success">
              <div style={{ ...successText, display: "flex", gap: 7, alignItems: "flex-start" }}>
                <FiCheckCircle size={14} style={{ flex: "0 0 auto", marginTop: 2 }} />
                <span>
                  {agentLabel} has moved to the cloud
                  {plan?.ok ? ` and is working on ${plan.branch}` : ""}. It keeps going with your
                  laptop closed.
                </span>
              </div>
              <button type="button" style={primaryBtn} onClick={onClose}>
                Done
              </button>
            </div>
          ) : loadError ? (
            <div style={panel} data-testid="promote-load-error">
              <div style={errorText}>
                Couldn&apos;t read this agent&apos;s worktree, so there is nothing safe to promote
                yet: {loadError}
              </div>
            </div>
          ) : plan === null ? (
            <div style={hint} data-testid="promote-loading">
              Reading {agentLabel}&apos;s branch and working tree…
            </div>
          ) : !plan.ok ? (
            <div style={panel} data-testid="promote-refusal">
              <div style={{ fontSize: 13, color: C.cream, lineHeight: 1.5 }}>{plan.message}</div>
              {/* `needsSignIn` was MISSING here, and it is the one reason that carries no deepLink —
                  so a signed-out user read "Sign in to run agents in the cloud" beside no control at
                  all. NewAgentButtons had handled this for the identical gate all along. */}
              {plan.needsSignIn && (
                <button type="button" style={actionBtn} onClick={() => void openSignIn()}>
                  Sign in
                </button>
              )}
              {plan.deepLink && deepLinkActionLabel(plan.deepLink) && (
                <button
                  type="button"
                  style={actionBtn}
                  onClick={() => goToSettings(plan.deepLink!)}
                >
                  {deepLinkActionLabel(plan.deepLink)}
                </button>
              )}
            </div>
          ) : (
            <>
              <div style={hint}>
                {agentLabel} keeps running here until the cloud copy is live and streaming — nothing
                is stopped before then. Once it&apos;s in the cloud it bills credits for each running
                minute.
              </div>
              {/* The same sentence the creation dialog shows, from the same helper — this is a
                  price, and two hand-written copies of a price is how they drift. Absent when the
                  server stated no rate; the client never invents one. */}
              {costLine && (
                <div style={hint} data-testid="promote-cost-estimate">
                  {costLine}
                </div>
              )}

              <Section title="Branch">
                <div data-testid="promote-branch" style={mono}>
                  {plan.branch}
                </div>
                <div style={note}>
                  The cloud agent checks out this branch and <strong>keeps working on it</strong> —
                  the same branch, the same PR. It does not start a new one.
                  {plan.unpushed > 0
                    ? ` ${plan.unpushed} commit${plan.unpushed === 1 ? "" : "s"} not yet on origin ${
                        plan.unpushed === 1 ? "is" : "are"
                      } pushed first.`
                    : ""}
                </div>
              </Section>

              <Section title="Uncommitted changes">
                {plan.dirtyCount === 0 ? (
                  <div style={note} data-testid="promote-clean">
                    None — this working tree is clean, so everything it has is already on the branch.
                  </div>
                ) : (
                  <>
                    <div style={note}>
                      {plan.dirtyCount} uncommitted{" "}
                      {plan.dirtyCount === 1 ? "file" : "files"} in this worktree:
                    </div>
                    <ul style={fileList} data-testid="promote-dirty-files">
                      {plan.dirtyFiles.slice(0, DIRTY_LIST_CAP).map((f) => (
                        <li key={f} style={{ ...mono, listStyle: "none" }}>
                          {f}
                        </li>
                      ))}
                    </ul>
                    {plan.dirtyCount > Math.min(plan.dirtyFiles.length, DIRTY_LIST_CAP) && (
                      <div style={note} data-testid="promote-dirty-more">
                        and{" "}
                        {plan.dirtyCount - Math.min(plan.dirtyFiles.length, DIRTY_LIST_CAP)} more
                      </div>
                    )}

                    <PolicyOption
                      testId="promote-policy-commit"
                      checked={policy === "commit"}
                      onSelect={() => setPolicy("commit")}
                      disabled={running}
                      title="Commit them first — recommended"
                    >
                      All {plan.dirtyCount} travel with the agent. Sparkle makes one commit in this
                      worktree and pushes it. The commit message is exactly:{" "}
                      <span style={mono} data-testid="promote-wip-message">
                        {WIP_COMMIT_MESSAGE}
                      </span>
                      . Nothing is lost — <span style={mono}>git reset --soft HEAD~1</span> puts it
                      right back.
                    </PolicyOption>

                    <PolicyOption
                      testId="promote-policy-leave"
                      checked={policy === "leave"}
                      onSelect={() => setPolicy("leave")}
                      disabled={running}
                      title={`Leave them behind — these ${plan.dirtyCount} ${
                        plan.dirtyCount === 1 ? "file does" : "files do"
                      } NOT travel`}
                    >
                      They stay in this worktree, on this Mac. The cloud agent never sees them and
                      continues from the branch without them.
                    </PolicyOption>

                    {policy === "leave" && (
                      <div style={errorText} data-testid="promote-leave-ack">
                        <FiAlertTriangle size={12} style={{ marginRight: 6, verticalAlign: -1 }} />
                        {plan.dirtyCount} uncommitted{" "}
                        {plan.dirtyCount === 1 ? "file stays" : "files stay"} on this Mac and will
                        not travel to the cloud.
                      </div>
                    )}
                  </>
                )}
                <div style={note} data-testid="promote-never-travels">
                  Files ignored by <span style={mono}>.gitignore</span> (
                  <span style={mono}>.env.local</span>, build caches) and{" "}
                  <span style={mono}>git stash</span> entries never travel — they are
                  local-machine state, and carrying them would ship secrets into a sandbox.
                </div>
              </Section>

              <Section title="Conversation">
                <div style={note} data-testid="promote-conversation">
                  Sparkle copies this agent&apos;s Claude Code conversation into the sandbox and
                  resumes it there, so it picks up mid-thought; a very long conversation loses its
                  oldest turns. If the transcript can&apos;t be read or sent, the move still goes
                  ahead and the cloud agent starts from a briefing instead —{" "}
                  <strong>its goal, its branch and your most recent prompts</strong>. It will not
                  remember the rest of this conversation.
                </div>
              </Section>

              {plan.warnings.length > 0 && (
                <Section title="Also worth knowing">
                  <ul style={fileList}>
                    {plan.warnings.map((w) => (
                      <li
                        key={w}
                        data-testid="promote-warning"
                        style={{ ...note, listStyle: "none", display: "flex", gap: 7 }}
                      >
                        <FiAlertTriangle
                          size={12}
                          style={{ flex: "0 0 auto", marginTop: 3, color: C.amberInk }}
                        />
                        <span>{w}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {failure && (
                <div style={panel} data-testid="promote-error">
                  <div style={errorText}>
                    Promotion failed at &ldquo;{stepLabel(failure.step)}&rdquo;: {failure.message}
                  </div>
                  <div style={{ ...note, color: C.cream }} data-testid="promote-failure-local-note">
                    <strong>Your local agent is still running and untouched.</strong> Nothing was
                    stopped, and you can try again.
                  </div>
                  {failure.orphanedSessionId && (
                    <div style={note} data-testid="promote-orphan">
                      A cloud session was started and may still be billing. Its id is{" "}
                      <span style={mono}>{failure.orphanedSessionId}</span>.
                    </div>
                  )}
                </div>
              )}

              {running && (
                <div style={panel} data-testid="promote-progress">
                  <ol style={{ ...fileList, gap: 4 }}>
                    {STEPS.map((s) => {
                      const active = s.id === step;
                      return (
                        <li
                          key={s.id}
                          data-testid={active ? "promote-current-step" : `promote-step-${s.id}`}
                          style={{
                            listStyle: "none",
                            fontSize: 12,
                            lineHeight: 1.5,
                            color: active ? C.cream : C.muted,
                            fontWeight: active ? FONT_WEIGHT.semibold : FONT_WEIGHT.regular,
                          }}
                        >
                          {s.label}
                          {active ? "…" : ""}
                        </li>
                      );
                    })}
                  </ol>
                  <div style={{ ...note, color: C.cream }} data-testid="promote-local-note">
                    {step === "cutover"
                      ? "Handing over now — the cloud agent is live, so the local one is being stopped."
                      : "Your local agent is still running. Nothing here is stopped until the last step."}
                  </div>
                </div>
              )}

              <button
                type="button"
                data-testid="promote-confirm"
                style={{ ...primaryBtn, opacity: running ? 0.5 : 1 }}
                onClick={() => void confirm()}
                disabled={running}
              >
                <FiUploadCloud size={13} />
                {running ? "Moving…" : "Move to cloud"}
              </button>
            </>
          )}
        </div>
      </div>
    </ModalLayer>
  );
}

/** A labelled block in the dialog body. Plain structure, no new chrome — the app's dialogs are flat
 *  stacks of labelled text, and this is one. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
      <div style={sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

/**
 * One dirty-policy choice. A real `<input type="radio">` inside its `<label>`, so the whole block is
 * the hit target and the keyboard gets the native radio-group behaviour — the sentence explaining
 * what the choice COSTS is part of the label, not a footnote beside it. That is the requirement:
 * picking "leave them behind" has to mean having read that those files do not travel.
 */
function PolicyOption({
  testId,
  checked,
  onSelect,
  disabled,
  title,
  children,
}: {
  testId: string;
  checked: boolean;
  onSelect: () => void;
  disabled: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <label
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        marginTop: 6,
      }}
    >
      <input
        type="radio"
        name="promote-dirty-policy"
        data-testid={testId}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        style={{ marginTop: 3, flex: "0 0 auto", accentColor: C.teal }}
      />
      <span style={{ minWidth: 0 }}>
        <span style={{ fontSize: 13, color: C.cream, fontWeight: FONT_WEIGHT.semibold }}>
          {title}
        </span>
        <span style={{ ...note, display: "block" }}>{children}</span>
      </span>
    </label>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────
// Deliberately the same vocabulary as NewCloudAgentDialog: same scrim, same card, same panel, same
// primary/action buttons. Promotion is the sibling of "new cloud agent", and a second dialect for
// the same family of decision would read as a different app.

const backdrop: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: SCRIM,
  zIndex: 60,
};

const dialog: CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%, -50%)",
  width: 500,
  maxWidth: "90vw",
  maxHeight: "86vh",
  background: C.dialogSurface,
  border: `1px solid ${C.dialogEdge}`,
  boxShadow: MODAL_SHADOW,
  color: C.cream,
  borderRadius: RADIUS.modal,
  zIndex: 61,
  display: "flex",
  flexDirection: "column",
  fontFamily: FONT_UI,
};

const titleBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 16px",
  borderBottom: `1px solid ${C.hairline}`,
  flex: "0 0 auto",
};

const titleText: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 17,
  fontWeight: FONT_WEIGHT.semibold,
  minWidth: 0,
};

const closeBtn: CSSProperties = {
  display: "grid",
  placeItems: "center",
  background: "transparent",
  border: "none",
  color: C.muted,
  cursor: "pointer",
};

const body: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: 16,
  overflowY: "auto",
  minHeight: 0,
};

const panel: CSSProperties = {
  background: C.forest,
  borderRadius: RADIUS.input,
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  alignItems: "flex-start",
};

const hint: CSSProperties = { fontSize: 12, color: C.muted, lineHeight: 1.5 };

const note: CSSProperties = { fontSize: 12, color: C.muted, lineHeight: 1.5 };

const sectionTitle: CSSProperties = {
  fontSize: 12,
  color: C.cream,
  fontWeight: FONT_WEIGHT.semibold,
};

const mono: CSSProperties = { fontFamily: FONT_MONO, fontSize: 12, color: C.cream };

const fileList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  margin: 0,
  padding: 0,
};

const errorText: CSSProperties = { fontSize: 12, color: DANGER, lineHeight: 1.5 };

const successText: CSSProperties = { fontSize: 13, color: C.successInk, lineHeight: 1.5 };

const actionBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: RADIUS.input,
  padding: "7px 12px",
  cursor: "pointer",
  fontSize: 13,
  fontFamily: FONT_UI,
};

const primaryBtn: CSSProperties = {
  ...actionBtn,
  background: C.teal,
  color: ON_BRAND_FILL,
  border: "none",
  marginTop: 6,
};
