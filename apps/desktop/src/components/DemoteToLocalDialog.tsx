import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useProjectStore } from "../stores/projectStore";
import { FiAlertTriangle, FiCheckCircle, FiDownloadCloud, FiX } from "react-icons/fi";
import { C, DANGER, MODAL_SHADOW, ON_BRAND_FILL, SCRIM } from "../theme/colors";
import { FONT_MONO, FONT_UI, RADIUS } from "../theme/scale";
import { FONT_WEIGHT } from "@sparkle/ui";
import type { AgentTab, Project } from "../types";
import { ModalLayer } from "./ModalLayer";
// The contract lives in services/agentDemotion (plan §W3) and is IMPORTED, never re-declared here.
// A local copy of these shapes would let the UI and the state machine drift silently — the same
// rule PromoteToCloudDialog follows, for the same reason.
import {
  CLOUD_WIP_COMMIT_MESSAGE,
  planDemotion,
  type DemotionPlan,
} from "../services/agentDemotion/plan";
import {
  demoteAgentToLocal,
  type DemoteDeps,
  type DemoteResult,
  type DemotionStep,
} from "../services/agentDemotion/demote";
import { makeDemoteDeps } from "../services/agentDemotion/live";

// ── "BRING IT BACK DOWN" ────────────────────────────────────────────────────────────────────────
//
// The mirror of PromoteToCloudDialog, and the asymmetry is the whole point (spec Decision 1):
// promotion can offer "leave the dirty files behind", because the local worktree survives the move.
// **A sandbox does not survive.** So there is no choice to make here — dirty state is committed and
// pushed, full stop — and this dialog STATES that rather than asking it. Three facts have to be on
// screen before the confirm button can be reached:
//
//   • anything UNCOMMITTED in the sandbox is committed and pushed to `origin/<branch>`, with the
//     commit message shown verbatim so nothing lands in history unannounced;
//   • the SANDBOX IS DESTROYED, and nothing outside git survives it — untracked/ignored files,
//     installed tools, scratch state;
//   • the CONVERSATION is downloaded through Sparkle onto this machine (the exposure runs the other
//     way from promotion's, and is smaller, but it is still worth one line — spec Decision 4).
//
// Plus every `plan.warnings[]` entry, RENDERED — not counted, not summarised.
//
// While it runs, it names the step and says the CLOUD agent is still running; that is copy-then-cut
// made visible. On failure it names the step and says, plainly, that nothing was stopped.

/** Every step, in the order `demoteAgentToLocal` runs them (plan §W3's `DemotionStep`). Listed so
 *  the running view shows the whole ladder rather than a bare spinner — this move costs credits for
 *  every minute it takes, so "how much is left" is a real question. */
const STEPS: readonly { id: DemotionStep; label: string }[] = [
  { id: "preflight", label: "Checking this project and branch" },
  { id: "handoff", label: "Committing and pushing the sandbox's work" },
  { id: "land", label: "Bringing the branch down to this Mac" },
  { id: "transcript", label: "Downloading the conversation" },
  { id: "spawn", label: "Starting the local agent" },
  { id: "await_live", label: "Waiting for the local agent to come up" },
  { id: "cutover", label: "Handing over — shutting the sandbox down" },
];

const stepLabel = (step: DemotionStep): string => STEPS.find((s) => s.id === step)?.label ?? step;

/**
 * Steps that can only have STARTED because the handoff push already succeeded.
 *
 * This is the whole reason the failure panel cannot reuse promotion's "nothing was touched" line.
 * `handoff` commits the sandbox's dirty state and pushes it to `origin/<branch>`; everything after
 * it ran on the strength of that push. So a failure at `land` or later leaves a new commit on the
 * user's remote — telling them nothing happened would deny the very commit the confirm screen
 * promised. `handoff` itself is deliberately NOT in this set: it IS the commit-and-push, so its
 * failure leaves the answer genuinely unknown, and the copy says so rather than guessing.
 */
const PUSHED_BEFORE: ReadonlySet<DemotionStep> = new Set([
  "land",
  "transcript",
  "spawn",
  "await_live",
  "cutover",
]);

/** The dialog's whole IO surface, injected so the confirm copy can be tested against a hand-built
 *  plan without W3's state machine, a live sandbox, or a Tauri host. */
export interface DemoteToLocalDeps {
  /** `planDemotion` — the refusal-or-plan the dialog renders. */
  loadPlan: () => Promise<DemotionPlan>;
  /** Run the demotion. `onStep` fires as each step begins so the dialog can name it. */
  demote: (args: { onStep: (step: DemotionStep) => void }) => Promise<DemoteResult>;
  /**
   * Re-attempt the store flip the demotion could not finish. Exists because the alternative was a
   * note telling the user to "reopen the project" — a recovery NOTHING implements: `runtime` is
   * persisted on the AgentTab, the only path that flips cloud→local is the very call that failed,
   * and `adoptWorker` is idempotent, so a rehydrate returns the identical broken tab. Remedy copy
   * is an instruction the user will follow; it needs a code path behind it. Returns true on repair.
   */
  repairRuntime: () => boolean;
}

/**
 * The real deps: the pure plan, and the copy-then-cut state machine.
 *
 * ── MERGE POINT ────────────────────────────────────────────────────────────────────────────────
 * The deps themselves come from `makeDemoteDeps()` — the one place the real transport, store and
 * Tauri commands meet. This dialog assembles NONE of them by hand, exactly as `promoteDialogDeps`
 * does not: an earlier promotion draft hand-rolled its `awaitFirstFrame` and would happily DELETE a
 * healthy sandbox on a timeout it caused itself. The tested implementation in `live.ts` is the only
 * one that gets to decide what "the other side is live" means.
 *
 * A cloud agent's SESSION ID IS ITS TAB ID — promotion refuses outright when the server hands back
 * a different one (`promote.ts`'s adoption check), and a born-in-the-cloud agent is created with
 * the tab id as its session id. So the demotion input carries `agent.id` and nothing resolves a
 * second identifier that could disagree with it.
 */
export function demoteDialogDeps(args: { project: Project; agent: AgentTab }): DemoteToLocalDeps {
  const { project, agent } = args;
  return {
    loadPlan: async () =>
      planDemotion({
        agent: {
          id: agent.id,
          runtime: agent.runtime,
          kind: agent.kind,
          worktreePath: agent.worktreePath,
          branch: agent.branch,
          goal: agent.goal,
          name: agent.name,
        },
        project: { id: project.id, rootPath: project.rootPath },
      }),

    demote: async ({ onStep }) =>
      demoteAgentToLocal(
        {
          agentId: agent.id,
          projectId: project.id,
          root: project.rootPath,
          // NULL, not "": "this agent never had a local worktree" is a real state (born in the
          // cloud) and it selects the create-a-worktree path in Rust. An empty string would read as
          // a path and send it down the fast-forward path against nothing.
          //
          // Named `existingWorktree` to match the real module — this dialog was written against a
          // contract stub while agentDemotion/ was being built in parallel, and the stub called it
          // `worktree`. The branch is NOT passed: demote.ts resolves it from the handoff, which is
          // the authoritative answer (the SERVER says which branch it pushed), so passing a
          // client-side guess here would give the state machine two sources for one fact.
          existingWorktree: agent.worktreePath,
          agentName: agent.name,
          goal: agent.goal?.text,
        },
        makeDemoteDeps({ onStep } satisfies Partial<DemoteDeps>),
      ),

    repairRuntime: () => {
      try {
        useProjectStore.getState().setAgentRuntime(project.id, agent.id, "local");
        return useProjectStore
          .getState()
          .projects.find((p) => p.id === project.id)
          ?.agents.some((a) => a.id === agent.id && a.runtime === "local") === true;
      } catch {
        return false;
      }
    },
  };
}

export function DemoteToLocalDialog({
  agent,
  deps,
  onClose,
}: {
  agent: Pick<AgentTab, "id" | "name">;
  deps: DemoteToLocalDeps;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<DemotionPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<DemotionStep | null>(null);
  const [failure, setFailure] = useState<
    {
      step: DemotionStep;
      message: string;
      orphanedSessionId?: string;
      /**
       * TRUE when the state machine THREW rather than returning a step-tagged refusal, and it is
       * load-bearing at exactly one step. A structured `cutover` refusal is the HEAD guard, which
       * is a *decision not to cut*: the sandbox committed after its work was pushed, nothing was
       * deleted, and the plan's own remedy is "demote again". A THROW at `cutover` is the opposite
       * — the cut was in flight and we cannot say whether the delete fired. Same step, opposite
       * advice, so the two must not share copy.
       */
      thrown?: boolean;
    } | null
  >(null);
  const [done, setDone] = useState<Extract<DemoteResult, { ok: true }> | null>(null);
  const [repairFailed, setRepairFailed] = useState(false);

  // ONE plan read, on open — through a ref so a caller that rebuilds its `deps` object on an
  // unrelated re-render can't re-answer a question the user is mid-way through reading.
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

  // THE LIVE STEP, IN A REF, and not for convenience. `confirm`'s `catch` runs inside the closure
  // created at the render where the button was clicked — where `step` is necessarily `null`, since
  // `confirm` returns early when `running`. `setStep` re-renders the component but never updates
  // that captured binding, so reading `step` in the catch reports EVERY throw as "preflight". Here
  // that is not a cosmetic mislabel: "preflight" is the one step whose contract is that nothing has
  // happened yet, so a throw during `cutover` would be narrated as "nothing was touched" while the
  // sandbox delete may already have fired. A ref is written by the same callback that drives the
  // state, so it is always the step actually in flight.
  const stepRef = useRef<DemotionStep>("preflight");
  const advance = (s: DemotionStep) => {
    stepRef.current = s;
    setStep(s);
  };

  const confirm = async () => {
    if (!plan?.ok || running) return;
    setFailure(null);
    advance("preflight");
    try {
      const res = await deps.demote({ onStep: advance });
      if (res.ok) {
        // setDone FIRST, and the repair in its own try — never inside the one whose catch renders
        // the failure panel. res.ok means the demotion is past its point of no return: the sandbox
        // is already destroyed. If the repair threw (or the dep were missing), that TypeError would
        // land in the outer catch, setDone would never run, and the user would be shown "Your cloud
        // agent is still running — nothing has been shut down. You can try again." — false, with
        // the invited retry aimed at a deleted session. A repair that throws is a failed REPAIR,
        // not a failed demotion.
        setDone(res);
        if (res.runtimeFlipFailed) {
          try {
            setRepairFailed(!deps.repairRuntime());
          } catch {
            setRepairFailed(true);
          }
        }
        return;
      }
      setFailure({
        step: res.step,
        message: res.message,
        ...(res.orphanedSessionId ? { orphanedSessionId: res.orphanedSessionId } : {}),
      });
    } catch (err) {
      // A throw is not a step-tagged refusal, so it is reported against the step that was running —
      // still the honest answer to "where did this stop?".
      setFailure({
        step: stepRef.current,
        message: String(err instanceof Error ? err.message : err),
        thrown: true,
      });
    } finally {
      setStep(null);
    }
  };

  return (
    <ModalLayer>
      <div
        data-testid="demote-backdrop"
        onClick={running ? undefined : onClose}
        style={backdrop}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Bring agent down to local"
        data-testid="demote-dialog"
        style={dialog}
      >
        <div style={titleBar}>
          <div style={titleText}>
            <FiDownloadCloud size={16} />
            Bring {agentLabel} down to this Mac
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
          {done ? (
            <div style={panel} data-testid="demote-success">
              <div style={{ ...successText, display: "flex", gap: 7, alignItems: "flex-start" }}>
                <FiCheckCircle size={14} style={{ flex: "0 0 auto", marginTop: 2 }} />
                <span>
                  {agentLabel} is running on this Mac again
                  {plan?.ok ? `, on ${plan.branch}` : ""}. The sandbox has been shut down and is no
                  longer billing.
                </span>
              </div>
              <div style={note} data-testid="demote-success-worktree">
                {done.createdWorktree
                  ? "A fresh worktree was created for it at "
                  : "Its existing worktree was fast-forwarded: "}
                <span style={mono}>{done.worktree}</span>
              </div>
              {!done.transcriptMoved && (
                <div style={note} data-testid="demote-success-no-transcript">
                  The conversation couldn&apos;t be downloaded, so the local agent starts from a
                  briefing — <strong>its goal, its branch and where the work stands</strong> — rather
                  than mid-thought.
                </div>
              )}
              {/* A transcript that MOVED can still have been truncated, and that case gets no
                  briefing (the briefing only fires when nothing moved at all). Unsaid, a demotion
                  that quietly dropped the oldest turns looks identical on screen to a complete one
                  — and the user finds out when the agent has forgotten why it started. */}
              {done.transcriptMoved && done.transcriptTruncated && (
                <div style={note} data-testid="demote-success-truncated">
                  The conversation was long, so only its most recent part came down —{" "}
                  <strong>the oldest turns were dropped</strong>. The agent may not recall how the
                  work began.
                </div>
              )}
              {/* Set PAST the point of no return: the sandbox is already deleted and only the
                  store flip failed, so the tab still reads runtime "cloud". Unsaid, the panel above
                  ("running on this Mac again… no longer billing") is simply false to the sidebar
                  the user is about to look at — and a second "Bring down to local" would run
                  against a session id that no longer exists and fail at handoff with copy claiming
                  their cloud agent is still running. Say it, and say which action is safe. */}
              {done.runtimeFlipFailed && repairFailed && (
                <div style={note} data-testid="demote-success-runtime-stuck">
                  This tab still shows as a cloud agent even though the sandbox is gone, and the
                  automatic repair didn&apos;t take either.{" "}
                  <strong>Close this tab and reopen the agent from its branch</strong> — and
                  don&apos;t use &ldquo;Bring down to local&rdquo; again, there is nothing left up
                  there to bring.
                </div>
              )}
              <button type="button" style={primaryBtn} onClick={onClose}>
                Done
              </button>
            </div>
          ) : loadError ? (
            <div style={panel} data-testid="demote-load-error">
              <div style={errorText}>
                Couldn&apos;t work out what this cloud agent is running, so there is nothing safe to
                bring down yet: {loadError}
              </div>
            </div>
          ) : plan === null ? (
            <div style={hint} data-testid="demote-loading">
              Reading {agentLabel}&apos;s branch…
            </div>
          ) : !plan.ok ? (
            <div style={panel} data-testid="demote-refusal">
              <div style={{ fontSize: 13, color: C.cream, lineHeight: 1.5 }}>{plan.message}</div>
            </div>
          ) : (
            <>
              <div style={hint}>
                {agentLabel} keeps running in the cloud — and keeps billing — until the local copy is
                up and streaming. Nothing is shut down before then.
              </div>

              <Section title="Branch">
                <div data-testid="demote-branch" style={mono}>
                  {plan.branch}
                </div>
                <div style={note}>
                  The work comes back the way it went out: on this branch. This Mac fetches{" "}
                  <span style={mono}>origin/{plan.branch}</span> and the local agent{" "}
                  <strong>keeps working on it</strong> — the same branch, the same PR.
                </div>
              </Section>

              {/* Spec Decision 1: there is no "leave it behind" option, because there is nowhere to
                  leave it. This section STATES the policy; it does not offer one. */}
              <Section title="Uncommitted work in the sandbox">
                <div style={note} data-testid="demote-commits-everything">
                  Anything uncommitted in the sandbox is <strong>committed and pushed</strong> to{" "}
                  <span style={mono}>origin/{plan.branch}</span> before anything is shut down. There
                  is no option to leave it behind — a sandbox does not survive this, so leaving it
                  behind would mean destroying it. The commit message is exactly:{" "}
                  <span style={mono} data-testid="demote-wip-message">
                    {CLOUD_WIP_COMMIT_MESSAGE}
                  </span>
                  . Nothing is lost — <span style={mono}>git reset --soft HEAD~1</span> puts it right
                  back once it&apos;s here.
                </div>
                <div style={note} data-testid="demote-sandbox-destroyed">
                  <FiAlertTriangle size={12} style={{ marginRight: 6, verticalAlign: -1 }} />
                  The sandbox is then <strong>destroyed</strong>, and{" "}
                  <strong>nothing outside git survives it</strong>: files ignored by{" "}
                  <span style={mono}>.gitignore</span>, anything the agent installed, and any scratch
                  state it kept off the branch are all gone.
                </div>
              </Section>

              <Section title="Conversation">
                <div style={note} data-testid="demote-conversation">
                  Sparkle <strong>downloads this agent&apos;s Claude Code conversation onto this
                  machine</strong> — it travels through Sparkle&apos;s servers on the way — and the
                  local agent resumes it, so it picks up mid-thought. A very long conversation loses
                  its oldest turns. If it can&apos;t be downloaded, the move still goes ahead and the
                  local agent starts from a briefing instead: <strong>its goal, its branch and where
                  the work stands</strong>.
                </div>
              </Section>

              {plan.warnings.length > 0 && (
                <Section title="Also worth knowing">
                  <ul style={fileList}>
                    {plan.warnings.map((w) => (
                      <li
                        key={w}
                        data-testid="demote-warning"
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
                <div style={panel} data-testid="demote-error">
                  <div style={errorText}>
                    Bringing it down failed at &ldquo;{stepLabel(failure.step)}&rdquo;:{" "}
                    {failure.message}
                  </div>
                  {/* THREE DIFFERENT STORIES, and telling the wrong one is worse than telling none.
                      "You can try again" is inherited word-for-word from promotion, where it is
                      always true because the local worktree survives; here it is true for most
                      failures and dangerously false for two:

                        • an ORPHAN — the cut already happened on this side, the local agent is up
                          on this branch, and only the sandbox delete failed. Retrying would land
                          the same work twice.
                        • a THROW during `cutover` — the cut was IN FLIGHT and we cannot say whether
                          the delete fired. Not the same as a structured `cutover` refusal, which is
                          the HEAD guard deciding NOT to cut and whose own remedy is "demote again"
                          (plan §W3); that one keeps the retry advice and gets its own explanation.

                      So the first two REPLACE the note rather than appending to it. */}
                  {failure.orphanedSessionId ? (
                    <>
                      <div
                        style={{ ...note, color: C.cream }}
                        data-testid="demote-failure-orphan-note"
                      >
                        <strong>
                          Your local agent is up and running on this branch — don&apos;t try again.
                        </strong>{" "}
                        The move itself finished; the one thing left outstanding is the cloud
                        sandbox, which could not be shut down.
                      </div>
                      <div style={note} data-testid="demote-orphan">
                        It may still be billing. Its id is{" "}
                        <span style={mono}>{failure.orphanedSessionId}</span> — stop it from the
                        cloud roster.
                      </div>
                    </>
                  ) : failure.thrown && failure.step === "cutover" ? (
                    <>
                      <div
                        style={{ ...note, color: C.cream }}
                        data-testid="demote-failure-indeterminate"
                      >
                        <strong>
                          This broke part-way through the handover, so we can&apos;t tell you
                          whether the sandbox was shut down.
                        </strong>{" "}
                        Your local agent had already come up on this branch, so don&apos;t just try
                        again — a second attempt would land the same work twice.
                      </div>
                      <div style={note} data-testid="demote-cut-unknown">
                        Check the cloud roster: if the sandbox is still listed it is still billing,
                        and stopping it there finishes the move.
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ ...note, color: C.cream }} data-testid="demote-failure-cloud-note">
                        <strong>Your cloud agent is still running — nothing has been shut down.</strong>{" "}
                        You can try again.
                      </div>
                      {/* The HEAD guard, and its remedy really IS "demote again" (plan §W3): the
                          sandbox committed after its work was pushed, so the cut was refused rather
                          than attempted and that commit is still safe where it is. */}
                      {failure.step === "cutover" && (
                        <div style={note} data-testid="demote-cut-guard-note">
                          The cloud agent committed something after its work was pushed, so the
                          handover stopped rather than shutting it down. That commit is safe in the
                          sandbox — bring it down again and it comes with everything else.
                        </div>
                      )}
                      {/* …but "nothing has been shut down" is NOT "nothing happened". The handoff
                          push runs first, so by `land` the sandbox's work is already on the user's
                          remote — a commit the confirm screen promised and this panel must not
                          then deny. */}
                      {PUSHED_BEFORE.has(failure.step) && (
                        <div style={note} data-testid="demote-failure-pushed">
                          The sandbox&apos;s uncommitted work was already committed and pushed to{" "}
                          <span style={mono}>origin/{plan.branch}</span> before this step, so that
                          commit is on your remote whether or not you try again.
                        </div>
                      )}
                      {failure.step === "handoff" && (
                        <div style={note} data-testid="demote-failure-maybe-pushed">
                          Committing and pushing is the step that failed, so the sandbox&apos;s work
                          may or may not have reached{" "}
                          <span style={mono}>origin/{plan.branch}</span>. Either way nothing was
                          destroyed — check the branch before you try again.
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}

              {running && (
                <div style={panel} data-testid="demote-progress">
                  <ol style={{ ...fileList, gap: 4 }}>
                    {STEPS.map((s) => {
                      const active = s.id === step;
                      return (
                        <li
                          key={s.id}
                          data-testid={active ? "demote-current-step" : `demote-step-${s.id}`}
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
                  <div style={{ ...note, color: C.cream }} data-testid="demote-cloud-note">
                    {step === "cutover"
                      ? "Handing over now — the local agent is live, so the sandbox is being shut down."
                      : "Your cloud agent is still running. Nothing there is shut down until the last step."}
                  </div>
                </div>
              )}

              <button
                type="button"
                data-testid="demote-confirm"
                style={{ ...primaryBtn, opacity: running ? 0.5 : 1 }}
                onClick={() => void confirm()}
                disabled={running}
              >
                <FiDownloadCloud size={13} />
                {running ? "Bringing it down…" : "Bring down to local"}
              </button>
            </>
          )}
        </div>
      </div>
    </ModalLayer>
  );
}

/** A labelled block in the dialog body — the same flat stack PromoteToCloudDialog uses, because
 *  these two are the same decision in two directions and a second dialect would read as a
 *  different app. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
      <div style={sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────
// Deliberately identical to PromoteToCloudDialog's vocabulary.

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
