// ChatSectionHeader — "CHAT", a count, and the `[+]` that adds a person. Design:
// docs/superpowers/specs/2026-08-05-social-coding-design.md §10 "Key UI design calls".
//
// ══ WHY THIS IS NOT `StageSectionHeader` WITH AN `action` PROP ══════════════════════════════════
// Three reasons, none of them taste, and all three are in the spec:
//
//   1. `StageSectionHeader` is `memo`'d on `{meta, count}` and its docstring says that memo is
//      load-bearing. A React-node `action` prop is a FRESH IDENTITY on every render, so adding one
//      would silently defeat the memo for EVERY stage header in the ladder, not just for Chat.
//   2. Its prop type is `BuildSectionMeta` — the build-stage ladder. A person has no
//      `WorkflowStageId`, so satisfying that type means inventing a fake rung.
//   3. Every stage header is rendered inside `<div aria-hidden>` (a tree may not own a heading), and
//      **an interactive control inside an aria-hidden subtree is unreachable**. This header carries
//      a button, so it may never be wrapped that way — and it isn't: it sits OUTSIDE
//      `[data-chat-tree]` entirely, so it is neither inside the tree nor inside an aria-hidden box.
//
// The TREATMENT is deliberately identical to `StageSectionHeader`'s — label · rule · count, in
// `SECTION_LABEL` — because the Chat block has to read as another rung of the same instrument. What
// differs is the structure, not the look.
//
// ══ THE `[+]` IS ALWAYS VISIBLE, NEVER A HOVER REVEAL ══════════════════════════════════════════
// It is the ONLY way to add the first person, so with zero people it is the only live control in
// the block. A `visibility: hidden` box is neither a hit-test target nor sequentially focusable —
// the trap `build-column-header` already documents — so a hover-reveal here would make the feature
// unreachable by keyboard and invisible to the one user who most needs it: the one with no people.
//
// ══ THE `[+]` DISPATCHES AN EVENT; IT IMPORTS NOTHING FROM SETTINGS ════════════════════════════
// `window.dispatchEvent(new CustomEvent(OPEN_SOCIAL_SETTINGS_EVENT))` is the agreed decoupling
// seam. The Settings side is a separate stage landing in parallel, and a direct import (or a
// `CATEGORIES` entry added from here) would couple two files that are being edited at once — the
// collision this feature's file split exists to avoid. The event is a no-op until a listener
// exists, which is the honest state of the world right now.

import { memo } from "react";
import { FiPlus } from "react-icons/fi";

import { C } from "../theme/colors";
import { RADIUS } from "../theme/scale";
import { COUNT, SECTION_LABEL } from "./labelTreatment";
import { ROW_PAD_X } from "../engine/rowGeometry";

/** The one event name, exported so the Settings listener binds to a constant rather than to a
 *  re-typed string literal. A typo in either half is a button that silently does nothing. */
export const OPEN_SOCIAL_SETTINGS_EVENT = "sparkle:open-social-settings";

/** What the `[+]` is called to assistive tech and on hover. One constant so the two agree. */
export const ADD_PERSON_LABEL = "Add a person";

export const CHAT_HEADER_TESTID = "chat-header";
export const CHAT_ADD_PERSON_TESTID = "chat-add-person";

/** Ask the app to open the social settings. Exported so a test drives the same call the button
 *  does, rather than a hand-built event that could differ in name or in bubbling. */
export function requestOpenSocialSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SOCIAL_SETTINGS_EVENT));
}

/** `React.memo`'d on two numbers — a person's availability flip re-renders their row, not this. */
export const ChatSectionHeader = memo(function ChatSectionHeader({
  count,
  unread = 0,
}: {
  /** How many people have a row. Painted even at 0: the block renders unconditionally, so the
   *  header's job at zero is to say the section exists and offer the `[+]`. */
  count: number;
  /** Total unread across everyone (`totalUnread` from socialStore). 0 → no badge. */
  unread?: number;
}) {
  return (
    <div
      data-testid={CHAT_HEADER_TESTID}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 7,
        // The stage headers' own `7px 10px 4px` — tight above, looser below, so the header reads as
        // belonging to the rows under it. The 10 is `ROW_PAD_X`, so the label starts on the rows'
        // text column rather than near it.
        padding: `7px ${ROW_PAD_X}px 4px`,
        ...SECTION_LABEL,
        lineHeight: 1,
        userSelect: "none",
      }}
    >
      <span style={{ flex: "0 1 auto", minWidth: 0, whiteSpace: "nowrap" }}>Chat</span>
      {/* THE RULE — the mark that ties the label to the count and makes the ladder read as a drawn
          instrument rather than two loose spans. Same `pillFill` the stage headers use. */}
      <span
        aria-hidden
        data-testid="chat-header-rule"
        style={{ flex: 1, minWidth: 0, height: 1, background: C.pillFill }}
      />
      {unread > 0 && (
        <span
          data-testid="chat-header-unread"
          aria-label={`${unread} unread`}
          style={{ flex: "0 0 auto", ...COUNT, color: C.accentInk }}
        >
          {unread}
        </span>
      )}
      <span data-testid="chat-header-count" style={{ flex: "0 0 auto", ...COUNT }}>
        {count}
      </span>
      <button
        type="button"
        data-testid={CHAT_ADD_PERSON_TESTID}
        aria-label={ADD_PERSON_LABEL}
        title={ADD_PERSON_LABEL}
        onClick={requestOpenSocialSettings}
        style={{
          flex: "0 0 auto",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 18,
          height: 18,
          padding: 0,
          // No `visibility` and no opacity gate — see the header. It is drawn at rest.
          border: `1px solid ${C.hairline}`,
          borderRadius: RADIUS.sm,
          background: "transparent",
          color: C.muted,
          cursor: "pointer",
          lineHeight: 0,
        }}
      >
        {/* react-icons/fi (Feather). No emoji — house rule. */}
        <FiPlus size={12} aria-hidden />
      </button>
    </div>
  );
});
