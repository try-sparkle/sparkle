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
// ONE FACE, TWO SHAPES. The whole mounted thread renders in the TERMINAL's face — `TERM_BODY_FONT` at
// `TERM_BODY_BASE_SIZE`, set once on the scroll container and inherited by every turn:
//   • YOUR words: a right-aligned bubble over the flooded terminal plane.
//   • THE AGENT: flush left, no bubble, full width.
//   • TOOL MACHINERY collapses into one expandable ActivityChip per stretch of work.
// Shape and alignment are what make the two voices legible apart — NOT a second typeface.
//
// ══ THIS PARAGRAPH USED TO SAY THE OPPOSITE, AND THAT IS WHY THE BUG SURVIVED TWICE ══════════════
// It described a "SPLIT REGISTER (Preview E, locked with the founder 2026-07-30)" in which the
// founder's own words stayed in the chat face while only the agent spoke in mono. The founder asked
// for the mounted thread to match the terminal at least three separate times AFTER that, and each
// time an agent opened this file, read a header attributing the split to him, and correctly declined
// to touch it. A contract comment narrating a superseded decision is not documentation — it is a
// lock, and it outlived the decision it recorded.
//
// Two things follow, and both are load-bearing:
//   1. The founder's ask is UNIFORM: the mounted column should read as the terminal beside it. If a
//      future change wants to reintroduce a typographic split, that needs a fresh decision recorded
//      with a fresh date — not a revert to this note.
//   2. NEITHER `FONT_MONO` NOR `TERM_TYPE` (theme/scale) IS THE TERMINAL'S. `--k-mono` is
//      `ui-monospace, "SF Mono", …` and `--t-term` is 12px; xterm is built with `TERM_BODY_FONT`
//      (`"Source Code Pro", …`) at 13. They are all monospace, so a surface set in the wrong pair
//      looks plausible, matches nothing, and goes red nowhere. Import from `../terminalChrome` for
//      anything meant to match the terminal. (Beware also that `TERM_TYPE` is exported TWICE with two
//      different types — a number from `theme/scale`, an object from `../terminalChrome`.)
import { useLayoutEffect, useMemo, useRef } from "react";

import { ActivityChip } from "./ActivityChip";
import { Markdown } from "../Markdown";
import type { TranscriptEntry } from "../../services/agentTranscript";
import type { InboxEntry } from "../../services/conciergeTools/fleet";
import type { MountedThread } from "../../stores/mountedThreadStore";
import { inFlight, useAgentInbox } from "../../stores/inboxStore";
import { DELIVERY_A11Y, DELIVERY_LABEL, QUEUED_BLOCK_HEADING } from "../inboxCopy";
import { useAutoFollow } from "../../hooks/useAutoFollow";
import { useQuoteOnSelection, type PendingQuote } from "./useQuoteOnSelection";
import { QuoteChiclet } from "./QuoteChiclet";
import { TERM_BODY_BASE_SIZE, TERM_BODY_FONT, termMuted } from "../terminalChrome";
import { useResolvedTheme, type ResolvedTheme } from "../../theme/theme";
// `TYPE.micro` and `FONT_MONO` here are for CHROME ONLY — timestamps, provenance marks, the
// queued-block heading — which is deliberately smaller-than-body furniture rather than conversation.
// Nothing that renders a TURN may read from this module: see the header on why `--k-mono` / `--t-term`
// are not the terminal's face and size.
import { FONT_MONO, TYPE } from "../../theme/scale";

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
  onQuote,
}: {
  thread: MountedThread;
  /** Whose inbox to show alongside the transcript. Empty string = no agent, and nothing is queried. */
  agentId: string;
  /** The agent's display name, for the empty state. Never used as an authorship label on turns —
   *  the typographic register carries authorship, exactly as it does in ConciergeThread. */
  agentName: string;
  onReachTop: () => void;
  /** A fragment of THIS agent's transcript was quoted into the compose box. Same contract as
   *  ConciergeThread's: absent → the affordance is not mounted at all. */
  onQuote?: (quote: PendingQuote) => void;
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

  // "Quote in response" over a BUILD AGENT's transcript — the same hook ConciergeThread mounts, on
  // this thread's own scroller. Both scrollers already carry `data-concierge-scroller`, and the
  // affordance follows: the founder asked to be able to quote an agent's claim back at the concierge.
  const { pending: pendingQuote, dismiss: dismissQuote } = useQuoteOnSelection(scrollRef, {
    enabled: !!onQuote,
  });

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={scrollRef}
        data-testid={MOUNTED_THREAD_TESTID}
        // ══ THE THREAD IS SET IN THE TERMINAL'S FACE (bead sparkle-wj3ya) ═══════════════════════
        // The founder, twice: *"I want the font in the concierge pane — both the font of the text
        // that I'm writing in the prompt compose box, AS WELL AS THE FONT IN THE THREAD — to be the
        // same font as the terminal window … to help make it clear to me that I'm speaking to the
        // agent."*
        //
        // PR #1054 shipped the COMPOSER in this face and stopped there, which is why he has asked
        // twice and seen it half-work: the box he types into changed, the conversation above it did
        // not. From where he sits that reads as the feature not working.
        //
        // ON THE SCROLL CONTAINER, so it CASCADES to the message bodies rather than being applied
        // per bubble — a per-bubble list is what drifts when a new row type is added. The chrome
        // inside (activity chips, timestamps, the queued-block heading) sets `FONT_MONO`/`TYPE.micro`
        // explicitly and is therefore untouched; only the prose inherits, which is exactly "the font
        // in the thread".
        //
        // UNCONDITIONAL, because this component only exists while mounted — `ConciergeThread` is what
        // renders when the cable is off. So there is no state here in which the terminal face would
        // be wrong, and no flag to keep in step with the composer's.
        //
        // IMPORTED, NEVER RE-TYPED. `TERM_BODY_FONT` is the literal stack xterm is constructed with
        // and `TERM_BODY_BASE_SIZE` is what it gets at zoom 1. A second copy is the silent drift
        // `terminalChrome`'s header exists to prevent — the terminal is themeable and per-column zoom
        // is landing, so a duplicate would diverge within a week and no test would go red, because
        // nothing would be WRONG, only different. Same constants the composer already imports, so
        // the two surfaces cannot disagree about what "the terminal's font" means.
        //
        // THE BACKGROUND IS NOT DONE HERE. The bead asks for that too; it is deliberately left for a
        // follow-up that can be screenshot-verified in a running build, since picking the wrong plane
        // is a change I cannot check from a jsdom test.
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
          fontFamily: TERM_BODY_FONT,
          fontSize: TERM_BODY_BASE_SIZE,
        }}
      >
        {thread.paging && <Notice mode={mode}>Loading earlier…</Notice>}
        {!thread.hasMore && entries.length > 0 && <Notice mode={mode}>Start of this agent's history</Notice>}

        {entries.map((e) => (
          <Entry key={e.id} entry={e} mode={mode} muted={muted} agentName={agentName} />
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
      {/* Portalled to `document.body`, so the terminal-flooded scroller's overflow cannot clip it. */}
      {onQuote && pendingQuote && (
        <QuoteChiclet
          x={pendingQuote.x}
          y={pendingQuote.y}
          onQuote={() => {
            onQuote(pendingQuote);
            dismissQuote();
          }}
          onDismiss={dismissQuote}
        />
      )}
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
          // Same register as the settled bubble it becomes (see `Entry`'s human turn): face inherited
          // from the scroller, size named from the terminal's own constant. A queued message that
          // changed typeface on delivery would make "it delivered" read as a different object.
          fontSize: TERM_BODY_BASE_SIZE,
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
  agentName,
}: {
  entry: TranscriptEntry;
  mode: ResolvedTheme;
  muted: string;
  /** Captions a quote taken from this agent's words (see composeQuote.quoteLabel). */
  agentName: string;
}) {
  if (entry.kind === "activity") return <ActivityChip entry={entry} mode={mode} />;

  if (entry.kind === "human") {
    const provenance = provenanceLabel(entry.promptSource);
    return (
      // `data-message-id` + `data-quote-source` are what make this row QUOTABLE — the founder asked
      // for build-agent messages to be in scope alongside the concierge's own (see
      // useQuoteOnSelection.quoteSourceOf, which reads exactly these two attributes). An activity
      // chip deliberately carries neither: it is chrome the app generated about state, not words
      // anyone said.
      <div
        data-message-id={entry.id}
        data-quote-source="you"
        style={{ maxWidth: "92%", alignSelf: "flex-end", textAlign: "right" }}
      >
        <div
          data-testid={MOUNTED_HUMAN_TESTID}
          style={{
            display: "inline-block",
            textAlign: "left",
            // NO FACE DECLARED — the scroller's terminal font cascades in here too, and that is
            // correct: the founder asked for the WHOLE mounted thread in the terminal's face, his own
            // words included. What separates his voice from the agent's is the BUBBLE and the
            // right-alignment, not a second typeface.
            //
            // The comment that used to sit here claimed this bubble was set in "the UI face, NOT the
            // mono face". It never was: declaring only a size leaves the family to inherit, so the
            // stated split was already defeated by the cascade and the note was describing an
            // intention rather than the render. Naming the terminal's own size constant now, so this
            // bubble cannot drift from the plane it sits on.
            fontSize: TERM_BODY_BASE_SIZE,
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
      // See the `human` arm above: this is the build-agent half of the founder's quote scope. The
      // agent's NAME rides along so the chip is captioned with who said it rather than a generic
      // "Agent" — `quoteSourceOf` reads it, `quoteLabel` falls back if it is ever empty.
      data-message-id={entry.id}
      data-quote-source="agent"
      data-quote-label={agentName}
      style={{
        maxWidth: "100%",
        alignSelf: "flex-start",
        // NO FACE AND NO SIZE DECLARED HERE, DELIBERATELY — the scroller's `TERM_BODY_FONT` /
        // `TERM_BODY_BASE_SIZE` cascade in, which is the entire reason they are set on the container
        // (see the block above the scroller's `style`).
        //
        // THIS DIV IS WHY THE FOUNDER KEPT ASKING FOR A FIX THAT HAD ALREADY SHIPPED. It used to
        // override BOTH with `FONT_MONO` at `TERM_TYPE`, and neither is the terminal's:
        // `--k-mono` resolves to `ui-monospace, "SF Mono", Menlo` (SF Mono on macOS) while xterm is
        // constructed with `"Source Code Pro", …` at 13px — a different typeface at 12px. The agent's
        // prose is the BULK of what this column shows, so the one element that ignored the cascade was
        // also the one he was reading. The container was right; its child overrode it.
        //
        // The looser line-height stays: it keeps mono prose readable at length, and it is a spacing
        // decision rather than a face decision, so it does not fight the cascade.
        lineHeight: 1.62,
        width: "100%",
      }}
    >
      {/* Markdown still renders — the agent writes lists, code and links.
          `face="terminal"` IS THE FIX, and it is not redundant with the cascade above: `Markdown`
          hardcodes `FONT_UI` on its own root, so it overrides any inherited face. Three earlier
          attempts set the thread's container correctly and were defeated exactly here. */}
      <Markdown text={entry.text} face="terminal" />
    </div>
  );
}
