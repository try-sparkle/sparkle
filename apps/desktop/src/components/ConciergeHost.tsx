// ConciergeHost — the integration layer (bead sparkle-qd80 / CM-U7) that turns the presentational
// ConciergeColumn (CM-U1) into the live, cross-project concierge: it builds the view-model from the
// real priority feed (CM-U3), streams the headless brain (CM-U2) into the thread, and routes the
// user's answers into the right agent's terminal via the dispatch relay (CM-U4).
//
// Mounted UNCONDITIONALLY as the persistent left column of the workspace — the concierge IS the
// experience, not a flagged addition to an older UI (PRD/sparkle/concierge-mode.md §6). It owns
// all concierge state; the column stays a pure renderer. The priority feed is built ONCE by
// Workspace (it drives the tab badges too) and passed in, so there is a single subscription, a
// single tray-roster fetch, and no chance of the tab counts and the vitals line disagreeing.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ConciergeColumn,
  deriveWordmarkMode,
  type ConciergeMessage,
  type ConciergeNudge,
  type ConciergeNudgeAction,
  type ConciergeViewModel,
} from "./Concierge";
import type { ConciergeAgent, ConciergeFeed } from "../useConciergeFeed";
import { oneLine } from "./promptHistory";
import { openProjectTab } from "../services/openProjectTab";
import {
  onConciergeDelta,
  onConciergeDone,
  onConciergeError,
  startConciergeTurn,
} from "../services/concierge";
import { dispatchConciergeAnswer, onDeferredSendOutcome } from "../services/conciergeDispatch";
import { useSparklePrefsStore } from "../stores/sparklePrefsStore";
import { useSpendPill } from "../stores/spendStore";

let seq = 0;
const nextId = (p: string) => `${p}-${(seq += 1)}`;

/** What the concierge says when the server has refused the send: the free trial is spent. The
 *  dispatch path gates BEFORE delivery (services/trialMeter.trialSendAllowed), so nothing reached
 *  the agent — say so plainly rather than leaving the user waiting on a reply that isn't coming. */
const TRIAL_SPENT_TEXT =
  "Your free trial is used up, so that didn't send. Upgrade and I'll pass it straight through.";

/** Flatten every agent across the feed (used to resolve a nudge back to its source agent). */
function allAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return feed.projects.flatMap((p) => p.agents);
}

/** The agents the concierge should surface right now: in scope, un-muted, needing attention. */
function surfacedAgents(feed: ConciergeFeed): ConciergeAgent[] {
  return allAgents(feed).filter((a) => a.inScope && !a.muted && a.priority < 2);
}

function actionsFor(a: ConciergeAgent): ConciergeNudgeAction[] {
  const show: ConciergeNudgeAction = { id: "show", label: "Show me" };
  const mute: ConciergeNudgeAction = { id: "mute", label: "Mute", kind: "ghost" };
  // The primary (gold) action is Approve when the agent is blocked on an approval prompt (one-tap
  // relay into its terminal); otherwise it's Show me. Show me is plain when Approve is the primary.
  if (a.status === "approval") {
    return [{ id: "approve", label: "Approve", kind: "primary" }, show, mute];
  }
  return [{ ...show, kind: "primary" }, mute];
}

function agentToNudge(a: ConciergeAgent): ConciergeNudge {
  return {
    id: a.id, // the source agent id — resolved back via the feed on click/action
    kind: "nudge",
    priority: a.priority === 0 ? "p0" : "p1",
    projectName: a.projectName,
    agentName: a.name,
    text: `${a.statusLabel} — ${a.name} in ${a.projectName}.`,
    actions: actionsFor(a),
  };
}

/** Compact context handed to the headless brain so its reply is grounded in what's actually happening. */
function buildSnapshot(feed: ConciergeFeed, userText: string): string {
  const surfaced = surfacedAgents(feed);
  const lines = surfaced.map(
    (a) => `- [${a.projectName}] ${a.name}: ${a.statusLabel} (P${a.priority})`,
  );
  // Keep the project count SCOPED to what's actually surfaced so it can't misstate scope (e.g. say
  // "5 projects" while only counting in-scope agents).
  const scopedProjects = new Set(surfaced.map((a) => a.projectId)).size;
  const state =
    surfaced.length > 0
      ? `${feed.scopedCounts.p0} P0 and ${feed.scopedCounts.p1} P1 need attention across ${scopedProjects} project(s):\n${lines.join("\n")}`
      : `All projects are calm right now.`;
  return `${state}\n\nThe user says: ${userText}\n\nReply briefly and recommend the next action.`;
}

/** The agent a compose-box send would reach when the target is "agent": the selected tab's
 *  selected agent. Null when there's no project open or no agent selected. */
export interface ConciergePromptTarget {
  projectId: string;
  agentId: string;
  name: string;
}

export function ConciergeHost({
  feed,
  promptTarget = null,
  width,
  searchSlot,
}: {
  /** The cross-project priority feed, built once by Workspace (see the file header). */
  feed: ConciergeFeed;
  /** The agent the compose box can prompt directly; null → the box only talks to Sparkle. */
  promptTarget?: ConciergePromptTarget | null;
  width?: number;
  /** The shell's ⌘K palette trigger, rendered under the scope/vitals line (PRD §4). */
  searchSlot?: ReactNode;
}) {
  // Latest feed for the event handlers (send/nudge actions), which run after render.
  const feedRef = useRef(feed);
  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);

  const [chat, setChat] = useState<ConciergeMessage[]>([]);
  const [typing, setTyping] = useState(false);
  const [micLive, setMicLive] = useState(false);
  // Where the compose box aims. The AGENT IS PINNED at the moment the user flips the toggle, not
  // resolved at send time: selection moves for reasons that have nothing to do with the box (a
  // nudge's "Show me", a notification reveal, a tab click), so a live lookup would deliver a
  // paragraph the user typed for one agent into whichever agent happened to be selected when they
  // pressed Send. Null = talking to Sparkle.
  const [aimedAt, setAimedAt] = useState<ConciergePromptTarget | null>(null);
  // The aim, DROPPED when the agent it names is gone (closed, deleted, its project removed). The
  // feed carries every project's every agent, so absence from it IS "no longer exists" — and
  // leaving a pinned name on the pill for an agent that can't receive anything would be a lie.
  // Derived rather than cleared in an effect: an effect would paint one frame with the dead aim
  // still on the pill, and a send in that frame would route at a corpse.
  const aim = useMemo(
    () => (aimedAt && allAgents(feed).some((a) => a.id === aimedAt.agentId) ? aimedAt : null),
    [aimedAt, feed],
  );
  // Latest aim for the handlers, which are memoized on stable deps and run after render (same
  // pattern as feedRef above).
  const targetRef = useRef(promptTarget);
  const aimedAtRef = useRef(aim);
  useEffect(() => {
    targetRef.current = promptTarget;
    aimedAtRef.current = aim;
  }, [promptTarget, aim]);

  // Stream the brain into the thread: deltas append to a bubble keyed by the turn id; done finalizes.
  useEffect(() => {
    const key = (id: string) => `brain-${id}`;
    const upsert = (id: string, text: string, replace: boolean) =>
      setChat((prev) => {
        const k = key(id);
        const i = prev.findIndex((m) => m.id === k);
        if (i === -1) return [...prev, { id: k, kind: "sparkle", text }];
        const next = prev.slice();
        const cur = next[i]!;
        next[i] = { ...cur, kind: "sparkle", text: replace ? text : (cur.text ?? "") + text };
        return next;
      });
    const offDelta = onConciergeDelta((e) => upsert(e.id, e.text, false));
    const offDone = onConciergeDone((e) => {
      setTyping(false);
      if (e.text) upsert(e.id, e.text, true);
    });
    const offError = onConciergeError(() => {
      setTyping(false);
      setChat((prev) => [
        ...prev,
        { id: nextId("err"), kind: "sparkle", text: "I couldn't reach my brain just now — try me again in a moment." },
      ]);
    });
    return () => {
      offDelta();
      offDone();
      offError();
    };
  }, []);

  const resolveAgent = useCallback(
    (id: string) => allAgents(feedRef.current).find((a) => a.id === id) ?? null,
    [],
  );

  const postSparkle = useCallback((text: string) => {
    setChat((prev) => [...prev, { id: nextId("sparkle"), kind: "sparkle", text }]);
  }, []);

  // Relay an Approve into the agent's terminal and ALWAYS give the user feedback — a silent failure
  // (dead terminal, an ambiguous prompt) would leave them waiting. Also swallows the throwing path.
  //
  // userPrompt: FALSE — "approve" is machine-authored. When the picker has scrolled off this falls
  // through to the free-text path, and a one-word non-prompt must not enter the prompt history,
  // debit a free-trial prompt, or become the agent's auto-name (see services/conciergeDispatch).
  const approve = useCallback(
    async (a: ConciergeAgent) => {
      try {
        const r = await dispatchConciergeAnswer(a.id, "approve", { userPrompt: false });
        // "queued" is ok:true but NOT delivered — say so rather than claiming it was sent.
        if (r.path === "queued") postSparkle(`${a.name} is still starting up — I'll approve as soon as it's ready.`);
        else if (r.ok) postSparkle(`Approved — sent to ${a.name}.`);
        else if (r.path === "pty-gone") postSparkle(`${a.name}'s terminal has closed — I couldn't send the approval.`);
        else if (r.path === "agent-failed") postSparkle(`${a.name} couldn't start, so I couldn't send the approval — open its pane and hit Retry.`);
        else if (r.path === "cloud-agent") postSparkle(`${a.name} runs in the cloud — I can't relay the approval from here yet; answer it in its own pane.`);
        else if (r.path === "ambiguous-picker") postSparkle(`${a.name} is asking something I can't answer with a plain "approve" — open it to choose.`);
        else if (r.path === "trial-spent") postSparkle(TRIAL_SPENT_TEXT);
        else postSparkle(`I couldn't send the approval to ${a.name}.`);
      } catch {
        postSparkle(`I couldn't reach ${a.name}'s terminal to approve.`);
      }
    },
    [postSparkle],
  );

  // The composer's job, re-homed: deliver a USER-authored prompt into the PINNED agent's terminal,
  // with every side-effect the old AgentPane composer had (history, the pinned breadcrumb's
  // marker, ghost suggestions, the auto-name ladder, the trial meter) — that's what
  // `userPrompt: true` turns on. Every outcome is reported back into the thread, because this box
  // is the only place the user can see that a send didn't land.
  //
  // Resolves TRUE when the text is safely in the agent's hands (delivered or held) and FALSE when
  // it isn't, so the compose box can put the user's draft back rather than making them retype it —
  // exactly what the removed composer's restoreDraft did.
  const promptAgent = useCallback(
    async (target: ConciergePromptTarget, text: string): Promise<boolean> => {
      try {
        const r = await dispatchConciergeAnswer(target.agentId, text, { userPrompt: true });
        if (r.path === "queued") {
          postSparkle(`${target.name} is still starting up — I'll send that the moment it's ready.`);
          return true;
        }
        if (r.ok && r.path === "picker-option") {
          postSparkle(`${target.name} was asking something — I answered "${r.matchedLabel}".`);
          return true;
        }
        if (r.ok) {
          postSparkle(`Sent to ${target.name}.`);
          return true;
        }
        if (r.path === "trial-spent") postSparkle(TRIAL_SPENT_TEXT);
        else if (r.path === "agent-failed") postSparkle(`${target.name} couldn't start, so that didn't send — open its pane and hit Retry (or finish installing Claude Code), then send again.`);
        else if (r.path === "cloud-agent") postSparkle(`${target.name} runs in the cloud, and prompting cloud agents from here isn't wired up yet — use its own pane for now.`);
        else if (r.path === "pty-gone") postSparkle(`${target.name}'s terminal has closed — that didn't send. Start it again and I'll pass it along.`);
        else if (r.path === "ambiguous-picker") postSparkle(`${target.name} is waiting on a choice I can't map that to — open it and pick, or answer with just the option.`);
        else postSparkle(`I couldn't send that to ${target.name}.`);
        return false;
      } catch {
        postSparkle(`I couldn't reach ${target.name}'s terminal.`);
        return false;
      }
    },
    [postSparkle],
  );

  // Reconcile the promise made when a prompt was QUEUED: the pane flushes it later (or the hold
  // ages out), and without this the user is told "I'll send it when it's ready" and then never
  // hears another word. Names the agent from the feed so the message reads like the others.
  useEffect(
    () =>
      onDeferredSendOutcome((r) => {
        const name = allAgents(feedRef.current).find((a) => a.id === r.agentId)?.name ?? "that agent";
        const quoted = r.sent ? ` ("${oneLine(r.sent)}")` : "";
        // Each non-delivery says what actually happened; a wrong reason is its own small lie
        // (roborev 46485-M — `abandoned` used to be reported as "the terminal closed", which is
        // false when the spawn failed and no terminal ever opened).
        if (r.ok) postSparkle(`${name} is up — I sent your message${quoted}.`);
        else if (r.path === "expired") postSparkle(`${name} never came up, so I dropped the message I was holding${quoted}. Send it again when it's running.`);
        else if (r.path === "abandoned") postSparkle(`${name} couldn't take the message I was holding${quoted}. Send it again once it's running.`);
        else postSparkle(`${name}'s terminal closed before I could send the message I was holding${quoted}.`);
      }),
    [postSparkle],
  );

  const controller = useMemo(
    () => ({
      onSend: (text: string): void | Promise<boolean> => {
        setChat((prev) => [...prev, { id: nextId("you"), kind: "you" as const, text }]);
        // The PINNED aim (set when the toggle was flipped), read live from the ref because the
        // memo's deps are stable. Not `promptTarget` — see the aimedAt comment.
        const aim = aimedAtRef.current;
        if (aim) return promptAgent(aim, text);
        setTyping(true);
        void startConciergeTurn(buildSnapshot(feedRef.current, text));
      },
      // Flip ON pins the CURRENTLY selected agent; flip OFF goes back to Sparkle. Pinning at flip
      // time is what makes the aim honest — nothing that moves the selection afterwards can
      // redirect a prompt the user typed for this agent.
      // Reads the LIVE (derived) aim, not the raw state: an aim whose agent has gone is already
      // showing as "Sparkle", so the next flip must PIN — not clear a pin nobody can see.
      onToggleSendTarget: () => setAimedAt(aimedAtRef.current ? null : targetRef.current),
      onMicToggle: () => setMicLive((v) => !v),
      onAttach: () => {
        // Attach flows (screenshot/image/files) are a follow-up; the affordance is wired, the
        // pickers are not yet implemented.
      },
      // PRD §3 (cross-project surfacing): clicking a nudge card "opens that project's tab,
      // switches to Build, and selects the referenced agent". openProjectTab does all three — the
      // tab select plus the shared reveal — so a nudge from a background project lands correctly.
      onNudgeClick: (n: ConciergeNudge) => {
        const a = resolveAgent(n.id);
        if (a) openProjectTab(a.projectId, a.id);
      },
      onNudgeAction: (n: ConciergeNudge, actionId: string) => {
        const a = resolveAgent(n.id);
        if (!a) return;
        if (actionId === "show") {
          openProjectTab(a.projectId, a.id);
        } else if (actionId === "approve") {
          void approve(a);
        } else if (actionId === "mute") {
          useSparklePrefsStore.getState().setInterruptPreference(a.id, "mute");
        }
      },
    }),
    [resolveAgent, approve, promptAgent],
  );

  const pinnedProjectName = useMemo(() => {
    if (!feed.pinnedProjectId) return undefined;
    return feed.projects.find((p) => p.id === feed.pinnedProjectId)?.name;
  }, [feed]);

  // Live cross-project spend "today" (CM-U8): a shared 60s poll + focus refresh, pre-formatted as
  // "$X.XX" (or "$—" until the first read). See stores/spendStore.ts.
  const spendText = useSpendPill();

  const model: ConciergeViewModel = useMemo(() => {
    const nudges = surfacedAgents(feed).map(agentToNudge);
    return {
      scope: { pinnedProjectName },
      vitals: { p0: feed.scopedCounts.p0, p1: feed.scopedCounts.p1 },
      spend: { amountText: spendText },
      messages: [...chat, ...nudges],
      typing,
      // While aimed, the pill names the PINNED agent (the one a send actually reaches), not
      // whatever is selected right now. Un-aimed, it offers the current selection as the thing the
      // toggle would pin — and renders inert when there is nothing to pin.
      send: {
        target: aim ? ("agent" as const) : ("sparkle" as const),
        agentName: aim?.name ?? promptTarget?.name,
      },
    };
  }, [feed, chat, typing, pinnedProjectName, spendText, promptTarget, aim]);

  return (
    <ConciergeColumn
      model={model}
      controller={controller}
      micLive={micLive}
      wordmarkMode={deriveWordmarkMode(micLive, typing)}
      width={width}
      searchSlot={searchSlot}
    />
  );
}
