// MountedAgentThread — the mounted concierge pane's thread: YOUR conversation with THAT agent.
//
// THE BUG THIS FIXES, in the founder's words: *"the mounted concierge is supposed to not show the
// regular chat history but instead show the terminal output when mounted. It's not doing that."*
// The mount was presentationally complete — the column floods to the terminal plane — but it kept
// rendering the general Sparkle conversation, which is a different conversation entirely.
//
// A SIBLING OF ConciergeThread, NOT A MODE INSIDE IT. The two render different vocabularies from
// different sources with different lifecycles: this one reads a projection of disk (see
// services/agentTranscript) and owns backwards paging and a live tail; that one renders a persisted
// message store with nudges, digests and recap cards. Folding them together would put the founder's
// Sparkle history and a transcript read on one code path, which is how the "unmount restores the
// concierge conversation" requirement gets broken by accident. Kept apart, it holds by construction.
//
// THE RENDERING IS "SPLIT REGISTER" (Preview E, locked with the founder 2026-07-30).
// Two voices, two typographic faces, one column:
//   • YOUR words keep the chat register — a right-aligned bubble — because they are the same act of
//     typing they always were, and because the bubble is what tells you at a glance that a line is
//     yours rather than the agent's.
//   • THE AGENT speaks in the terminal register: monospace, flush left, no bubble, over the flooded
//     terminal plane the column already paints.
//   • TOOL MACHINERY collapses into one expandable ActivityChip per stretch of work.
// Which voice is speaking is legible from across the room — the thing a same-face thread cannot do.
import { useLayoutEffect, useMemo, useRef } from "react";

import { ActivityChip } from "./ActivityChip";
import { Markdown } from "../Markdown";
import type { TranscriptEntry } from "../../services/agentTranscript";
import type { InboxEntry } from "../../services/conciergeTools/fleet";
import type { MountedThread } from "../../stores/mountedThreadStore";
import { inFlight, useAgentInbox } from "../../stores/inboxStore";
import { DELIVERY_A11Y, DELIVERY_LABEL, QUEUED_BLOCK_HEADING } from "../inboxCopy";
import { useAutoFollow } from "../../hooks/useAutoFollow";
import { termMuted } from "../terminalChrome";
import { useResolvedTheme, type ResolvedTheme } from "../../theme/theme";
import { FONT_MONO, TERM_TYPE, TYPE } from "../../theme/scale";

export const MOUNTED_THREAD_TESTID = "mounted-agent-thread";
export const MOUNTED_HUMAN_TESTID = "mounted-human-turn";
export const MOUNTED_AGENT_TESTID = "mounted-agent-turn";
export const MOUNTED_EMPTY_TESTID = "mounted-thread-empty";
export const MOUNTED_QUEUED_TESTID = "mounted-queued-message";
export const MOUNTED_QUEUED_BLOCK_TESTID = "mounted-queued-block";

/** The provenance mark under one of your own bubbles.
 *
 *  A merged timeline owes the reader ONE thing: never hide HOW a message got there. `promptSource`
 *  is Claude Code's own classification, and it is honest about its limits — it distinguishes a real
 *  submission from a harness injection, but it CANNOT tell a line typed into the terminal from one
 *  relayed through the concierge, because the relay types into the PTY and is indistinguishable by
 *  construction (see services/agentTranscript).
 *
 *  So when we cannot establish provenance we render NOTHING rather than a guess — the `agentId: null
 *  means UNKNOWN` convention from AGENTS.md, applied to the same class of question. A confident-
 *  looking "· terminal" under a message that actually came through the concierge would be worse than
 *  the blank it replaces. */
function provenanceLabel(promptSource: string | null): string {
  return promptSource === "typed" ? "terminal" : "";
}

export function MountedAgentThread({
  thread,
  agentId,
  agentName,
  onReachTop,
}: {
  thread: MountedThread;
  /** Whose inbox to show alongside the transcript. Empty string = no agent, and nothing is queried. */
  agentId: string;
  /** The agent's display name, for the empty state. Never used as an authorship label on turns —
   *  the typographic register carries authorship, exactly as it does in ConciergeThread. */
  agentName: string;
  onReachTop: () => void;
}) {
  const mode = useResolvedTheme();
  const muted = termMuted(mode);
  const entries = thread.entries;

  // THE MESSAGES THIS THREAD COULD NOT SHOW (bead sparkle-zm0c8). The transcript is a projection of
  // DISK — of turns that have happened — so a message the concierge queued a moment ago is by
  // construction absent from it until the agent reaches a turn boundary and drains it. That is the
  // whole reported bug: *"I don't see a followup message from you in that agent thread with this,
  // just the original instruction."* Both halves were true, and this is the half the thread owed.
  const queued = inFlight(useAgentInbox(agentId));

  // …AND THEN STOP SHOWING ONE ONCE THE THREAD ITSELF CARRIES IT. A delivered message is typed into
  // the agent verbatim by whichever path won the claim (`sparkle-hook.mjs::draftDelivery` at a turn
  // boundary, `fleetWatch.draftIdleDelivery` for an already-idle agent), so Claude Code records it as
  // a human turn and it arrives in this transcript on the next tail read. Leaving the placeholder up
  // would then print the same instruction twice, which is its own small dishonesty — the reader would
  // have no way to tell one message sent once from two sent in a row.
  //
  // MATCHED ON TEXT, NOT ON ID, because only ONE of the two delivery paths writes the id (the hook's
  // ack instruction does; the idle path deliberately asks for no ack at all, see its docstring). The
  // TEXT is what both paths inline. `pending` is never matched — nothing has been typed anywhere yet,
  // so a hit could only ever be a coincidence.
  //
  // THE ERROR IS ASYMMETRIC AND FALLS THE SAFE WAY. A false positive (a short message that happens to
  // appear in an unrelated turn) hides a placeholder for a message the transcript is showing anyway; a
  // false negative keeps a delivered message visible, which is merely redundant. Neither can make a
  // message invisible, which is the failure this whole file is being edited for.
  const visible = useMemo(() => {
    if (queued.length === 0) return queued;
    const said = entries.filter((e) => e.kind === "human").map((e) => e.text);
    const out = queued.filter(
      (q) => q.state === "pending" || !said.some((t) => t.includes(q.text)),
    );
    return out.length === queued.length ? queued : out;
  }, [queued, entries]);

  // The last entry id is enough of a content key here, unlike the concierge thread's: nothing in a
  // transcript grows IN PLACE. Records are appended and immutable — a streaming reply arrives as new
  // records, not as an edit to the last one — so a new id is the only way content can change.
  const lastId = entries.length > 0 ? entries[entries.length - 1]!.id : "";
  const { scrollRef, onScroll, measureBeforePrepend, restoreAfterPrepend } = useAutoFollow({
    contentKey: `${entries.length}:${lastId}`,
    // The re-arm on your own submit is not wired here, and deliberately so: your message reaches this
    // thread only after Claude Code has written it to the JSONL and the tail has read it back, which
    // is a round trip through disk. Re-arming on a message that has ALREADY arrived is what the
    // bottom-threshold check does anyway, so a second mechanism would fire late and buy nothing.
    rearmKey: "",
    onReachTop,
  });

  // Hold the reader's place when a backwards page inserts older entries ABOVE them. Without this the
  // view jumps by the height of everything just prepended, which reads as the app throwing away your
  // position at the exact moment you asked for more. A layout effect (not an effect) so the
  // correction lands in the same frame as the insertion and never paints the jump.
  const prevFirstIdRef = useRef<string>("");
  const prevHeightRef = useRef(0);
  const firstId = entries.length > 0 ? entries[0]!.id : "";
  prevHeightRef.current = measureBeforePrepend();
  useLayoutEffect(() => {
    const grewAtTop = prevFirstIdRef.current !== "" && firstId !== prevFirstIdRef.current;
    prevFirstIdRef.current = firstId;
    if (grewAtTop) restoreAfterPrepend(prevHeightRef.current);
  }, [firstId, restoreAfterPrepend]);

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={scrollRef}
        data-testid={MOUNTED_THREAD_TESTID}
        // THE HANDLE ComposeBox MEASURES ITS DRAG CEILING AGAINST.
        //
        // The composer finds the scrolling thread inside the section to know how tall it may grow.
        // While mounted, `ConciergeThread` is not rendered at all, so a query for that component's
        // testid alone returned null and the measurement fell back to `window.innerHeight` — the
        // exact trap its own comment documents (roborev 53572/53586): the Send row is clipped off the
        // bottom and a persisted dragged height is clamped against a ceiling too large by the whole
        // header. A stable marker, rather than a second testid, keeps the composer's query
        // component-agnostic: it asks for "the thread", and either thread answers.
        data-concierge-scroller="yes"
        onScroll={onScroll}
        // Named for WHOSE conversation this is. The concierge thread's label says "Conversation with
        // Sparkle"; a screen reader that heard the same phrase here would be told the exact untruth
        // this whole feature exists to correct.
        aria-label={`Conversation with ${agentName}`}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "8px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {thread.paging && <Notice mode={mode}>Loading earlier…</Notice>}
        {!thread.hasMore && entries.length > 0 && <Notice mode={mode}>Start of this agent's history</Notice>}

        {entries.map((e) => (
          <Entry key={e.id} entry={e} mode={mode} muted={muted} />
        ))}

        {/* THE QUEUE, AT THE TAIL. Below every real turn because that is where it belongs in time —
            these have not happened yet — and because the tail is where auto-follow already parks the
            reader, so a message queued while they are watching appears under their eyes rather than
            somewhere they have to hunt for. */}
        {visible.length > 0 && (
          <div
            data-testid={MOUNTED_QUEUED_BLOCK_TESTID}
            style={{ display: "flex", flexDirection: "column", gap: 10 }}
          >
            <div
              style={{
                fontFamily: FONT_MONO,
                fontSize: TYPE.micro,
                color: muted,
                textAlign: "center",
                // A hairline in the terminal ink, so the block reads as a section of THIS column
                // rather than a notification pasted over it.
                borderTop: "1px solid color-mix(in srgb, currentColor 15%, transparent)",
                paddingTop: 8,
              }}
            >
              {QUEUED_BLOCK_HEADING}
            </div>
            {visible.map((q) => (
              <QueuedMessage key={q.id} entry={q} muted={muted} />
            ))}
          </div>
        )}

        {entries.length === 0 && !thread.loading && (
          <div
            data-testid={MOUNTED_EMPTY_TESTID}
            style={{ fontFamily: FONT_MONO, fontSize: TYPE.micro, color: muted, padding: "12px 0" }}
          >
            {thread.error !== null
              ? `Could not read ${agentName}'s transcript: ${thread.error}`
              : `No conversation with ${agentName} yet.`}
          </div>
        )}
        {entries.length === 0 && thread.loading && <Notice mode={mode}>Reading transcript…</Notice>}
      </div>
    </div>
  );
}

/**
 * One message that is queued for this agent but not yet in its conversation.
 *
 * IT WEARS THE SAME BUBBLE AS A REAL TURN, DIMMED — not a distinct "notification" shape. The
 * concierge speaks on the founder's behalf and its relays are recorded as human turns (see
 * `provenanceLabel`), so a queued message is a turn that has not happened yet, and drawing it as the
 * same object at lower contrast is what makes "it delivered" legible as the SAME thing arriving
 * rather than one widget being replaced by another. That is the promotion the bead asked for: the
 * transcript's copy takes its place at full contrast, in the same register, in the same column.
 *
 * THE OPACITY IS NOT DECORATION — it is the second channel for the stage, and it is not the only one.
 * The stage is also written out underneath (`DELIVERY_LABEL`) and named for a screen reader
 * (`DELIVERY_A11Y`), because dimming is invisible to a reader who cannot see it and ambiguous to one
 * who can (dim could equally mean "old"). Three channels, one fact.
 */
function QueuedMessage({ entry, muted }: { entry: InboxEntry; muted: string }) {
  const pending = entry.state === "pending";
  return (
    <div style={{ maxWidth: "92%", alignSelf: "flex-end", textAlign: "right" }}>
      <div
        data-testid={MOUNTED_QUEUED_TESTID}
        data-delivery-state={entry.state}
        aria-label={DELIVERY_A11Y[entry.state]}
        style={{
          display: "inline-block",
          textAlign: "left",
          fontSize: TYPE.body,
          background: "color-mix(in srgb, currentColor 10%, transparent)",
          borderRadius: "4px 4px 0 4px",
          padding: "9px 12px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          // A DASHED EDGE ON THE PENDING ONE. Opacity alone put a queued message in the same visual
          // class as a scrolled-away one; a drawn, unfinished boundary says "this is not settled yet"
          // at a glance and survives the two things opacity does not — a dark theme, and a reader who
          // is not comparing it against a neighbouring bubble.
          border: pending
            ? "1px dashed color-mix(in srgb, currentColor 35%, transparent)"
            : "1px solid transparent",
          opacity: pending ? 0.62 : 0.82,
        }}
      >
        {entry.text}
      </div>
      <div style={{ fontFamily: FONT_MONO, fontSize: TYPE.micro, color: muted, marginTop: 2 }}>
        · {DELIVERY_LABEL[entry.state]}
      </div>
    </div>
  );
}

function Notice({ children, mode }: { children: React.ReactNode; mode: ResolvedTheme }) {
  return (
    <div style={{ fontFamily: FONT_MONO, fontSize: TYPE.micro, color: termMuted(mode), textAlign: "center" }}>
      {children}
    </div>
  );
}

function Entry({
  entry,
  mode,
  muted,
}: {
  entry: TranscriptEntry;
  mode: ResolvedTheme;
  muted: string;
}) {
  if (entry.kind === "activity") return <ActivityChip entry={entry} mode={mode} />;

  if (entry.kind === "human") {
    const provenance = provenanceLabel(entry.promptSource);
    return (
      <div style={{ maxWidth: "92%", alignSelf: "flex-end", textAlign: "right" }}>
        <div
          data-testid={MOUNTED_HUMAN_TESTID}
          style={{
            display: "inline-block",
            textAlign: "left",
            // The UI face, NOT the mono face. This is the split register: your words stay in the
            // chat voice while the agent speaks in the terminal voice, which is what makes the two
            // legible apart at a glance.
            fontSize: TYPE.body,
            // `currentColor` is the terminal ink the column set on its section, so the bubble reads
            // as belonging to the flooded plane rather than punching a chat-coloured hole in it.
            // Same treatment ConciergeThread's `wired` bubble already uses.
            background: "color-mix(in srgb, currentColor 10%, transparent)",
            borderRadius: "4px 4px 0 4px",
            padding: "9px 12px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {entry.text}
        </div>
        {provenance !== "" && (
          <div style={{ fontFamily: FONT_MONO, fontSize: TYPE.micro, color: muted, marginTop: 2 }}>
            · {provenance}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid={MOUNTED_AGENT_TESTID}
      style={{
        maxWidth: "100%",
        alignSelf: "flex-start",
        // THE TERMINAL REGISTER. Mono at TERM_TYPE (12px) rather than the 13px the chat face uses —
        // monospace reads visually larger at the same nominal size, so matching the numbers would
        // make the agent's voice louder than the founder's. The looser line-height is what keeps
        // mono prose readable at length, which is the one real cost of this register.
        fontFamily: FONT_MONO,
        fontSize: TERM_TYPE,
        lineHeight: 1.62,
        width: "100%",
      }}
    >
      {/* Markdown still renders — the agent writes lists, code and links — just in the mono face. */}
      <Markdown text={entry.text} />
    </div>
  );
}
