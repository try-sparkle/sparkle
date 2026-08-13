// AgentInboxBadge — the agent row's "someone has queued instructions for this agent" mark.
//
// THE BUG (sparkle-zm0c8). The concierge's inbox is its PRIMARY channel to agents — a terminal write
// refuses with `alternate-screen` whenever Claude Code is busy (sparkle-v7k3y) — and a queued message
// was rendered NOWHERE: not in the agent's terminal, not in its thread, not on its row, not in the
// concierge transcript. So "the concierge sent it" and "the concierge imagined it" looked identical.
// The founder asked twice whether a message had really gone; both times it had, and both times he had
// no way to find out for himself.
//
// WHY A ROW BADGE AND NOT ONLY THE THREAD. The thread is the surface he looked at, and it is fixed
// separately (MountedAgentThread) — but it shows ONE agent at a time. The question "which of my
// agents are holding instructions right now" is a COLUMN question, and the column is what he scans.
// Two agents were holding pending instructions when the bead was filed and neither row said so.
//
// PENDING ONLY. A delivered message has been handed to the agent and belongs to its conversation from
// then on; a badge that kept counting it would turn a transient "waiting" mark into a permanent
// decoration, which is how a signal stops being read. The popover still shows the delivered ones,
// because "did the one you sent actually land" is exactly what someone opening this wants to know.
//
// SEPARATE FILE, deliberately: `AgentSidebar.tsx` is 6k lines and is edited on several branches at
// once, so this lands as a one-line render there and every mistake in this component is confined to
// a file nobody else is touching.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiInbox } from "react-icons/fi";

import { C, FONT_WEIGHT } from "../theme/colors";
import { FONT_MONO, RADIUS, TYPE } from "../theme/scale";
import { SIDEBAR_OVERLAY_Z } from "./layers";
import { DELIVERY_A11Y, DELIVERY_LABEL, pendingBadgeLabel, pendingBadgeTitle } from "./inboxCopy";
import { pendingCount, useAgentInbox } from "../stores/inboxStore";
import type { InboxEntry } from "../services/conciergeTools/fleet";
import {
  MIXED_QUEUE_HEADER,
  anyPeer,
  isPeerSender,
  peerAttributionLine,
} from "../services/peerAttribution";

export const INBOX_BADGE_TESTID = "row-inbox";
export const INBOX_POPOVER_TESTID = "row-inbox-popover";
export const INBOX_POPOVER_MESSAGE_TESTID = "row-inbox-message";
export const INBOX_POPOVER_HEADER_TESTID = "row-inbox-header";
export const INBOX_POPOVER_PEER_TESTID = "row-inbox-peer";

/** How wide the popover is allowed to get. The column is narrow and the panel is anchored to a chip
 *  inside it, so it deliberately overhangs into the terminal area rather than wrapping a queued
 *  instruction to three characters a line. */
const POPOVER_WIDTH = 320;

/**
 * The panel's OUTLINE — a floating surface's edge, deliberately not a field's rule.
 *
 * Named rather than inlined for the same reason `Concierge/MentionPicker` names its own: the two
 * read identically as CSS and mean opposite things. `modalChrome.test.ts` ratchets the population of
 * FIELDS that borrow the shell's tokens, and its heuristic — a `C.hairline` border within four lines
 * of a shell-plane fill — cannot tell a text input from a floating panel. Its own comment says so:
 * *"a bordered panel on a plane is correct and must not be counted."* Naming the constant states
 * which of the two this is, at the one place a reader would otherwise have to guess.
 *
 * `deepForest` + `hairline` + a drop shadow is what every other floating picker in the app already
 * wears (MentionPicker, the command palette), so this reads as the same kind of object rather than
 * a third look invented for one badge.
 */
const PANEL_EDGE = `1px solid ${C.hairline}`;

export function AgentInboxBadge({ agentId }: { agentId: string }) {
  const entries = useAgentInbox(agentId);
  const pending = pendingCount(entries);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  // Close on Escape and on any pointer-down outside the panel. Registered only while OPEN, so a
  // column of forty rows adds no listeners at all in the common case.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      // The anchor's own click toggles; letting this handler ALSO see it would close and reopen in
      // the same gesture, so the chip would never appear to respond.
      if (t !== null && anchorRef.current?.contains(t) === true) return;
      if (t !== null && (t as Element).closest?.(`[data-testid="${INBOX_POPOVER_TESTID}"]`) !== null)
        return;
      setOpen(false);
    };
    // …and on any SCROLL, because the panel is `position: fixed` at the anchor's rect AT CLICK TIME.
    // The column scrolls under it, so a scrolled panel is a floating box pointing at a row that has
    // moved — which on a column of agents is worse than no panel at all, since it invites the reader
    // to attribute one agent's queue to whichever row is now underneath it. Capture phase: the scroll
    // that matters is the column's own, and scroll does not bubble.
    const onScroll = () => setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  // A ROW WHOSE LAST PENDING MESSAGE JUST DELIVERED MUST NOT STRAND AN OPEN PANEL. The badge
  // unmounts when the count reaches zero, which would leave a portal with no way back to it.
  useEffect(() => {
    if (pending === 0) setOpen(false);
  }, [pending]);

  if (pending === 0) return null;

  return (
    <>
      <span
        ref={anchorRef}
        data-testid={INBOX_BADGE_TESTID}
        data-pending-count={pending}
        role="button"
        tabIndex={0}
        title={pendingBadgeTitle(pending, anyPeer(entries))}
        aria-label={pendingBadgeLabel(pending)}
        aria-expanded={open}
        onClick={(e) => {
          // The row's own click SELECTS the agent. Reading what is queued must not also switch the
          // pane out from under the reader — the same rule the epic and feedback pills follow.
          e.stopPropagation();
          const r = anchorRef.current?.getBoundingClientRect() ?? null;
          setRect(r);
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.stopPropagation();
          e.preventDefault();
          setRect(anchorRef.current?.getBoundingClientRect() ?? null);
          setOpen((v) => !v);
        }}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 3,
          // NEVER SHRINKS. Its content is an icon and a one-or-two digit count; a shrink factor would
          // clip the one mark this component exists to make visible, to save about fifteen pixels.
          flex: "0 0 auto",
          lineHeight: 1.4,
          fontSize: 10,
          fontWeight: FONT_WEIGHT.semibold,
          whiteSpace: "nowrap",
          cursor: "pointer",
          // AMBER, the token for "this is waiting on something" (packages/ui/tokens.ts) — the same
          // ink the stall chip uses, and for the same reason. NOT danger: a queued message is the
          // system working as designed (non-interrupting delivery), not a fault. NOT muted either;
          // muted is what the row already says about a queued message, which is nothing.
          color: C.amberInk,
        }}
      >
        <FiInbox size={10} style={{ flex: "0 0 auto" }} />
        {pending}
      </span>
      {open && rect !== null && createPortal(<Popover anchor={rect} entries={entries} />, document.body)}
    </>
  );
}

/**
 * The queued text itself — the thing that makes "I sent it" checkable rather than a thing to trust.
 *
 * Shows EVERY live message with its stage, not just the pending ones the badge counts: someone
 * opening this has just been told a message was sent, and "it is already delivered" is as much of an
 * answer as "it is still queued". Acknowledged ones are here too, and they are the strongest answer
 * available — the agent confirmed in writing.
 */
function Popover({ anchor, entries }: { anchor: DOMRect; entries: readonly InboxEntry[] }) {
  // Anchored under the chip, and FLIPPED to its left when the panel would run off the right edge —
  // a column can sit at either side of the window (see SPARKLE_PANE_SIDE), so a fixed direction is
  // wrong half the time.
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - POPOVER_WIDTH - 8));
  return (
    <div
      data-testid={INBOX_POPOVER_TESTID}
      role="dialog"
      aria-label="Queued messages for this agent"
      style={{
        position: "fixed",
        left,
        top: anchor.bottom + 6,
        width: POPOVER_WIDTH,
        maxHeight: "50vh",
        overflowY: "auto",
        zIndex: SIDEBAR_OVERLAY_Z,
        background: C.deepForest,
        border: PANEL_EDGE,
        borderRadius: RADIUS.sm,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 10,
        boxShadow: "0 6px 20px rgba(0,0,0,0.28)",
      }}
    >
      <div
        data-testid={INBOX_POPOVER_HEADER_TESTID}
        style={{ fontFamily: FONT_MONO, fontSize: TYPE.micro, color: C.muted }}
      >
        {/* THE HEADER CANNOT CLAIM THE CONCIERGE UNCONDITIONALLY. This popover is the surface a
            human opens precisely to check "did the concierge really send it", so stating it of a
            queue that contains a peer's message is not a silent omission — it is an affirmative
            untruth on the one surface built to answer that question. */}
        {anyPeer(entries)
          ? MIXED_QUEUE_HEADER
          : "Queued by the concierge · delivered at this agent's next turn boundary"}
      </div>
      {entries.map((e) => (
        <div
          key={e.id}
          data-testid={INBOX_POPOVER_MESSAGE_TESTID}
          data-delivery-state={e.state}
          aria-label={DELIVERY_A11Y[e.state]}
          style={{ display: "flex", flexDirection: "column", gap: 3 }}
        >
          <div
            style={{
              fontSize: TYPE.body,
              color: C.cream,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {isPeerSender(e.from) && (
              <div
                data-testid={INBOX_POPOVER_PEER_TESTID}
                style={{ fontFamily: FONT_MONO, fontSize: TYPE.micro, color: C.muted }}
              >
                {peerAttributionLine(e.from)}
              </div>
            )}
            {e.text}
          </div>
          <div style={{ fontFamily: FONT_MONO, fontSize: TYPE.micro, color: C.muted }}>
            {/* The SEVERITY is shown because it changes what the agent is expected to do with the
                message — ACT means "handle this before you continue" — so a human reading the queue
                needs to know which kind they queued as much as whether it arrived. */}
            {e.severity === "act" ? "ACT" : "FYI"} · {DELIVERY_LABEL[e.state]}
          </div>
        </div>
      ))}
    </div>
  );
}
