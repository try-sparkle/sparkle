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

import { noteConciergeProgress } from "./conciergeLiveness";
import { useProjectStore } from "../stores/projectStore";
import {
  conciergeActivityResultSubject,
  conciergeActivitySubject,
  learnsSubjectFromReply,
  type ConciergeActivitySubject,
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

/** What a resolved subject contributes to the line: the words, and — when it is an agent that still
 *  exists — the id those words are a pill for. */
interface ResolvedSubject {
  text: string | null;
  agentId: string | null;
}

/** Nothing sayable and nothing clickable. A module const so the common path allocates nothing. */
const UNRESOLVED: ResolvedSubject = { text: null, agentId: null };

/** Resolve a subject to something sayable, or null when it cannot be.
 *
 *  Null is a real answer, not a failure: an agent the concierge just closed is gone from the store
 *  by the time its own `close_agent` reply lands, and the honest rendering of that is the indefinite
 *  "an agent" — never a stale name and never the raw id, which means nothing to a human.
 *
 *  THE ID RIDES ALONG ONLY WHEN THE LOOKUP SUCCEEDED, and the two are set together on purpose. An
 *  id whose agent is not in the store is precisely the "closed or discarded" case, and the founder's
 *  rule for it is explicit — *"NEVER render a dead link, and never fall back to guessing a different
 *  agent"*. Returning the id anyway would let a caller draw a pill over the word "agent" that opens
 *  nothing; returning them as one unit makes that unrepresentable. */
function resolve(subject: ConciergeActivitySubject): ResolvedSubject {
  if (!subject) return UNRESOLVED;
  // The noun rides with the number ("PR #753") rather than being spelled out in the phrase — see
  // the `PR` constant in engine/conciergeActivityLine for why.
  if (subject.kind === "pr") return { text: `PR #${subject.number}`, agentId: null };
  const projects = useProjectStore.getState().projects;
  if (subject.kind === "project") {
    return { text: projects.find((p) => p.id === subject.projectId)?.name ?? null, agentId: null };
  }
  for (const project of projects) {
    const agent = project.agents.find((a) => a.id === subject.agentId);
    // The LIVE name, read now. It is only the line's opening value — the pill re-resolves the same
    // id against the roster on every render, so a rename after this point still lands (that is the
    // whole point of the pill). This one exists so the plain-text sentence, the accessible name and
    // any consumer that never draws a pill still say something true.
    if (agent) return { text: agent.name, agentId: agent.id };
  }
  return UNRESOLVED;
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
 *
 * ══ `settle` TAKES THE REPLY'S `data`, FOR THE ONE OP THAT CREATES ITS OWN SUBJECT ══════════════
 * A spawn has no agent to name while it is in flight — the call is what makes the agent — so its
 * arguments cannot carry an id and the line honestly reads "Starting a new agent". The id exists
 * for the first time in the REPLY, which is why `data` comes back here: at settle time the subject
 * is re-resolved through `conciergeActivityResultSubject`, and "Starting a new agent…" becomes
 * "Started <that agent>" as a live pill the reader can click and watch rename.
 *
 * It NEVER overwrites a subject the arguments already named. `conciergeActivityResultSubject`
 * answers null for every op but the spawn, and a null leaves the recorded subject exactly as it
 * was — so a reply that echoes a different agent than the call was aimed at cannot silently
 * re-point the sentence. Omitting `data` is always safe.
 */
export function noteConciergeToolCall(
  domain: string,
  op: string,
  args: unknown,
): (ok: boolean, data?: unknown) => void {
  // A DISPATCHED TOOL CALL IS A SIGN OF LIFE, and for some turns it is the only one. A turn can
  // spend a minute reading terminals and checking PRs without emitting a word of assistant text, so
  // a liveness detector fed on deltas alone would call a visibly working concierge offline — the
  // one false claim it must not make. Recorded here rather than in the liveness module because this
  // is already the single place every `concierge_tool` call passes through.
  // "tool", not "text": the brain is alive, but it has not said a word to the user yet. The
  // unanswered-message receipt turns on exactly that difference.
  noteConciergeProgress("tool");
  seq += 1;
  const mySeq = seq;
  const { text, agentId } = resolve(conciergeActivitySubject(args));
  useConciergeActivityStore.setState({
    latest: { domain, op, subject: text, agentId, outcome: "running", seq: mySeq },
  });
  return (ok: boolean, data?: unknown) => {
    const latest = useConciergeActivityStore.getState().latest;
    if (!latest || latest.seq !== mySeq || latest.outcome !== "running") return;
    // ══ AN OP THAT LEARNS ITS SUBJECT FROM ITS REPLY OVERWRITES UNCONDITIONALLY ══════════════════
    // Including with NOTHING. The first cut only wrote when the reply resolved to a name, which
    // left the arguments' subject standing when it did not — and a spawn's arguments are
    // `{ projectId }`, which resolves to the PROJECT. With the past tense `"Started %s"`, a
    // successful spawn whose agent had already been closed rendered "Started web": the project
    // named as though it were the agent just created (roborev 55373). Clearing it is what makes the
    // documented degradation — "Started a new agent" — actually happen.
    //
    // Only a SUCCESSFUL call may name a subject from its reply. A refused spawn created nothing, so
    // there is no agent to point at and `data` carries a refusal rather than a result; the line
    // stays on the present tense ("Tried starting a new agent"), which is the true report.
    const learns = learnsSubjectFromReply(domain, op);
    const fromResult =
      ok && learns ? resolve(conciergeActivityResultSubject(domain, op, data)) : UNRESOLVED;
    useConciergeActivityStore.setState({
      latest: {
        ...latest,
        outcome: ok ? "done" : "refused",
        // Every OTHER op keeps exactly what its arguments named — a reply that echoes a different
        // agent must never silently re-point the sentence.
        ...(learns ? { subject: fromResult.text, agentId: fromResult.agentId } : {}),
      },
    });
  };
}

/** Test-only: drop the recorded activity and the counter, so cases can't see each other's calls. */
export function _resetConciergeActivityForTests(): void {
  seq = 0;
  useConciergeActivityStore.setState({ latest: null });
}
