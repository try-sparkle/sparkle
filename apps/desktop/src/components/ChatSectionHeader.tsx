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
// ══ THE `[+]` HAS TWO DESTINATIONS, AND WHICH ONE IS NOT A PREFERENCE ══════════════════════════
// With a social identity it opens {@link AddPersonPopover}. WITHOUT one it opens Settings → Chat,
// because there is nothing else it could usefully do: every `/social/*` path 404s for an account
// with no row, so a directory panel would open onto a permanently empty list and the user would
// have no way to learn that picking a username is the missing step. That is the deep-open seam
// §10 names ("the `[+]` flow needs a deep-open seam — `openSettings("chat")` when you have no
// username yet"), and it is why the event below still exists.
//
// `me.username`, NOT `profileLoaded`, is the test — deliberately, and the direction is the safe
// one. Before the profile has been read we do not know whether there is a handle, and sending an
// already-registered user to Settings costs them one click while opening an empty directory panel
// on someone with no identity is a dead end with no signpost out of it.
//
// ══ THE SETTINGS HALF DISPATCHES AN EVENT; IT IMPORTS NOTHING FROM SETTINGS ════════════════════
// `window.dispatchEvent(new CustomEvent(OPEN_SOCIAL_SETTINGS_EVENT))` is the agreed decoupling
// seam. A direct import (or a `CATEGORIES` entry added from here) would couple two files that are
// edited on separate branches — the collision this feature's file split exists to avoid.

import { memo, useCallback, useRef, useState } from "react";
import { FiPlus } from "react-icons/fi";

import { C } from "../theme/colors";
import { RADIUS } from "../theme/scale";
import { COUNT, SECTION_LABEL } from "./labelTreatment";
import { ROW_PAD_X } from "../engine/rowGeometry";
import { AddPersonPopover } from "./AddPersonPopover";
import { useSocialStore } from "../stores/socialStore";

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
  // See the header: which destination the `[+]` has is decided by whether there is a handle.
  const hasHandle = useSocialStore((s) => s.me.username != null);
  // The popover is `position: fixed` at the button's rect AT CLICK TIME, so the rect is captured
  // by the press rather than measured on every render — jsdom returns zeros for it and a real
  // browser would pay a layout read per paint.
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const closePopover = useCallback(() => setAnchor(null), []);

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
        ref={addRef}
        type="button"
        data-testid={CHAT_ADD_PERSON_TESTID}
        // Read by the popover's click-away guard: the press that TOGGLES the panel must not also
        // be seen as a press outside it, or the panel would close and reopen in one gesture and
        // never appear to respond.
        data-add-person-anchor=""
        aria-label={ADD_PERSON_LABEL}
        aria-expanded={anchor !== null}
        title={ADD_PERSON_LABEL}
        onClick={() => {
          if (!hasHandle) {
            requestOpenSocialSettings();
            return;
          }
          setAnchor((open) =>
            open !== null ? null : (addRef.current?.getBoundingClientRect() ?? null),
          );
        }}
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
      {/* The panel itself — portalled to `document.body`, so it is a DOM sibling of the app and
          carries its own `data-circuit` / `data-dismissible-open`. See AddPersonPopover.tsx. */}
      {anchor !== null && <AddPersonPopover anchor={anchor} onClose={closePopover} />}
    </div>
  );
});
