// integrationQueueStore — the ordered merge queue the integration assistant plans, plus each
// branch's gate verdict and merge outcome as they arrive.
//
// ONE WRITER PER FACT. The plan comes from `integration_plan`, a verdict from `integration_gate`,
// an outcome from `integration_merge`; each has its own setter and none of them invents the others.
// That matters most for `landed`, which is ONLY ever what ancestry proved on the Rust side — the
// store must never derive it from "the merge call returned".
//
// WHY A RE-PLAN DROPS STALE VERDICTS. A gate verdict is a statement about a particular diff. When a
// re-plan reports that a branch now changes a different number of files, the branch moved, and the
// verdict was taken against code that is no longer there. Keeping it would let a green chip from
// before a force-push authorize a merge of what came after — so the verdict is cleared and the
// branch has to be gated again. A branch whose diff is unchanged keeps its verdict, because
// re-gating every branch on every re-plan would make a plan of ten branches cost ten `gh`
// round-trips for no new information.
import { create } from "zustand";
import type {
  GateReport,
  MergeOutcome,
  MergePlan,
  OverlapWarning,
  QueueEntry,
  Unplannable,
} from "../services/integrationAssistant";

interface IntegrationQueueState {
  /** The ref the plan was computed against, e.g. `origin/main`. Empty before the first plan. */
  base: string;
  /** In MERGE ORDER. The array order is the plan's order and nothing else may reorder it. */
  entries: QueueEntry[];
  warnings: OverlapWarning[];
  unplannable: Unplannable[];
  /** The last error from a command, shown rather than swallowed. */
  error: string | null;

  setPlan: (plan: MergePlan) => void;
  setGate: (report: GateReport) => void;
  setOutcome: (outcome: MergeOutcome) => void;
  setBusy: (branch: string, busy: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const EMPTY = {
  base: "",
  entries: [] as QueueEntry[],
  warnings: [] as OverlapWarning[],
  unplannable: [] as Unplannable[],
  error: null as string | null,
};

export const useIntegrationQueueStore = create<IntegrationQueueState>((set) => ({
  ...EMPTY,

  setPlan: (plan) =>
    set((state) => {
      const previous = new Map(state.entries.map((e) => [e.branch, e]));
      return {
        base: plan.base,
        warnings: plan.warnings,
        unplannable: plan.unplannable,
        entries: plan.order.map((planned) => {
          const prior = previous.get(planned.branch);
          // The verdict survives only when the branch's diff is the same size it was. See the
          // header: a verdict about a diff that moved is not evidence about the diff that is there.
          const keep = prior !== undefined && prior.changedFiles === planned.changedFiles;
          return {
            ...planned,
            gate: keep ? prior.gate : null,
            // An outcome is a fact about a merge that already happened; a re-plan cannot unmake it.
            outcome: prior?.outcome ?? null,
            busy: prior?.busy ?? false,
          };
        }),
      };
    }),

  // A verdict for a branch the queue no longer holds is DISCARDED, not appended. A late response
  // for a branch a re-plan removed would otherwise resurrect it into the order at the end, where
  // nothing planned it and nothing checked what it collides with.
  setGate: (report) =>
    set((state) => ({
      entries: state.entries.map((e) =>
        e.branch === report.branch ? { ...e, gate: report, busy: false } : e,
      ),
    })),

  setOutcome: (outcome) =>
    set((state) => ({
      entries: state.entries.map((e) =>
        e.branch === outcome.branch ? { ...e, outcome, busy: false } : e,
      ),
    })),

  setBusy: (branch, busy) =>
    set((state) => ({
      entries: state.entries.map((e) => (e.branch === branch ? { ...e, busy } : e)),
    })),

  setError: (error) => set({ error }),

  reset: () => set({ ...EMPTY, entries: [], warnings: [], unplannable: [] }),
}));

/** Every collision this branch is named in, so a row can show its own warnings without scanning. */
export function warningsFor(
  branch: string,
  warnings: readonly OverlapWarning[],
): OverlapWarning[] {
  return warnings.filter((w) => w.a === branch || w.b === branch);
}
