// WHAT THE CONCIERGE IS DOING RIGHT NOW — the observed half of the thinking indicator.
//
// The brain reaches into this app exclusively through `concierge_tool` control calls, and
// services/controlListener dispatches every one of them. That makes this the one place in the
// frontend that KNOWS, first-hand and with no new plumbing through the `claude -p` stream, which
// tool the concierge just reached for and what it aimed it at. This module records that; the
// component (components/Concierge/ThinkingIndicator) shows it.
//
// EVERYTHING HERE IS OBSERVED, never predicted. A call is recorded when dispatch starts it and
// re-recorded when dispatch replies — those are the only two writes. Nothing synthesises activity to
// keep the line moving, so a turn that spends thirty seconds thinking and calls nothing shows the
// plain pulse it always did.
//
// IDS ARE RESOLVED HERE rather than in the component, because this is the layer that may read a
// store. The phrasing (which is a pure decision about English) lives in engine/conciergeActivityLine.
import { create } from "zustand";

import { useProjectStore } from "../stores/projectStore";
import {
  conciergeActivitySubject,
  type ConciergeToolActivity,
} from "../engine/conciergeActivityLine";

interface ConciergeActivityState {
  /** The most recent call, or null when none has been observed this app run.
   *
   *  ONE, not a list. The indicator is a single line in a 360px column, so a history would be
   *  rendered one entry at a time anyway — and keeping only the newest means a concierge that fires
   *  several calls in parallel shows the last one it started rather than an arbitrary earlier one.
   *  Consumers decide for themselves whether it is recent enough to show (see `seq`). */
  latest: ConciergeToolActivity | null;
}

export const useConciergeActivityStore = create<ConciergeActivityState>(() => ({ latest: null }));

/** Monotonic per app run. It is what lets a consumer tell activity from the turn it is watching
 *  apart from a call left over from the previous one, WITHOUT this module having to know about
 *  turns — which it deliberately does not, since a proactive push calls tools too and owns no
 *  typing indicator. Module-level rather than store state: it is a counter, not something anyone
 *  renders. */
let seq = 0;

/** Resolve the subject of a call to something sayable, or null when it cannot be.
 *
 *  Null is a real answer, not a failure: an agent the concierge just closed is gone from the store
 *  by the time its own `close_agent` reply lands, and the honest rendering of that is the indefinite
 *  "an agent" — never a stale name and never the raw id, which means nothing to a human. */
function resolveSubject(args: unknown): string | null {
  const subject = conciergeActivitySubject(args);
  if (!subject) return null;
  // The noun rides with the number ("PR #753") rather than being spelled out in the phrase — see
  // the `PR` constant in engine/conciergeActivityLine for why.
  if (subject.kind === "pr") return `PR #${subject.number}`;
  const projects = useProjectStore.getState().projects;
  if (subject.kind === "project") {
    return projects.find((p) => p.id === subject.projectId)?.name ?? null;
  }
  for (const project of projects) {
    const agent = project.agents.find((a) => a.id === subject.agentId);
    if (agent) return agent.name;
  }
  return null;
}

/**
 * Record that a `concierge_tool` call has STARTED, and return the function that records how it
 * ended. Call the returned function exactly once, in a `finally` — a call whose outcome is never
 * recorded leaves the column saying "Reading …" forever.
 *
 * `settle(ok)` MUST be given the reply's own `ok`, not `true`. `dispatchConciergeTool` is total: a
 * policy denial, an ask-tier tool the human has not approved yet, `bad-args`, `unknown-op` and
 * `internal-error` all come back as ordinary resolved replies. Passing `true` for those made the
 * column report a refused merge as "Merged PR #753".
 *
 * The write is guarded on this call's own `seq`. A newer call has already replaced the line, and
 * settling ITS line would announce an outcome for a call still in flight — the one lie this feature
 * must not tell.
 */
export function noteConciergeToolCall(
  domain: string,
  op: string,
  args: unknown,
): (ok: boolean) => void {
  seq += 1;
  const mySeq = seq;
  useConciergeActivityStore.setState({
    latest: { domain, op, subject: resolveSubject(args), outcome: "running", seq: mySeq },
  });
  return (ok: boolean) => {
    const latest = useConciergeActivityStore.getState().latest;
    if (!latest || latest.seq !== mySeq || latest.outcome !== "running") return;
    useConciergeActivityStore.setState({
      latest: { ...latest, outcome: ok ? "done" : "refused" },
    });
  };
}

/** Test-only: drop the recorded activity and the counter, so cases can't see each other's calls. */
export function _resetConciergeActivityForTests(): void {
  seq = 0;
  useConciergeActivityStore.setState({ latest: null });
}
