// ChatSection — the "Chat" block at the top of the Build column. Design:
// docs/superpowers/specs/2026-08-05-social-coding-design.md §9 (U3), §10 "Key UI design calls".
//
// The founder asked for it in these words: *"Above the Local Nothing Yet row in Builder Columns, I
// want there to be a row called 'Chat.' And there is a [+] to the right of Chat where I can add a
// user."* This is that block, and `AgentSidebar` renders it in exactly one line.
//
// ══ CHAT IS NOT A `BUILD_SECTIONS` ENTRY ═══════════════════════════════════════════════════════
// The stage ladder answers "how far toward being safely on remote main did the WORK get"
// (`engine/buildSections.ts`). A person has no `WorkflowStageId`, so `sectionOfStage`'s exhaustive
// switch cannot type one; `groupAgentsByStage` would apply the STATUS-BAND FILTER, so a human would
// vanish behind the Needs-you / Running / Done chips; and `flattenSections` feeds three callers that
// must agree on a flat order. Chat is a FIXED BLOCK ABOVE the tree, and it is deliberately not
// anchored to the "Local · Nothing Yet" header the founder named — that header is data-dependent
// (empty sections are dropped), so anchoring to it would make Chat's position a function of git
// state. "Top of the list, above the first stage header" is what his screen shows.
//
// ══ IT RENDERS AT ZERO PEOPLE — THE ONLY THING THAT REMOVES IT IS AN AFFIRMATIVE `false` ═══════
// The `[+]` is the only way to add the first person, so hiding the block when it is empty hides the
// only control that could ever fill it — and a control that vanishes teaches the user the feature
// was deleted (bead `sparkle-lcx8y`). At zero people it shows one short, HONEST line instead.
//
// EXACTLY ONE condition removes the block: `me.socialEnabled === false`, the server affirmatively
// saying this account may not use Social Coding. An ABSENT flag does NOT — that means only "the
// server predates the field", which is production's state today, and gating on it would hide the
// feature on every build until the deploy lands. See `services/entitlement.ts`'s `socialEnabled`
// docstring, which is the authority on the three-valued reading, and never write `!socialEnabled`.
//
// The empty line itself is not a fixed string and is not a spinner: it escalates through four
// states as the client earns the evidence for each — see `chatEmptyDetail`. "No one else has
// joined yet" is a claim about the DIRECTORY and may only be made once a pass has actually
// succeeded; before that, an empty roster means "unread", not "empty".
//
// ══ PERSON ROWS GET THEIR OWN TREE ═════════════════════════════════════════════════════════════
// `<div role="tree" aria-label="Chats" data-chat-tree>`, NOT the existing `aria-label="Build
// agents"` / `data-agent-tree` tree — whose `tabStopId`, `renderedRowIds` and ArrowDown ring are all
// agent-shaped and keyed on `AgentTab`. Being a separate tree is also what makes the one-line cable
// change work: `CHAT_ROW_SELECTOR` in `engine/cable.ts` is scoped to `[data-chat-tree]`, so a person
// row is a CIRCUIT member (the cable does not drop when you click one) without becoming a build row
// for `isBuildAgentRow`, which answers a different question.
//
// ══ SELECTION IS LOCAL, ON PURPOSE, AND THAT IS TEMPORARY ══════════════════════════════════════
// Clicking a row selects it here and clears its unread. It does NOT mount the concierge into that
// person — that is stage U6, and it lands in `uiStore` (`activeChatUserId` under
// `TRANSIENT_UI_KEYS`) with mutual exclusion enforced inside the actions. Nothing in this file may
// reach for `uiStore`, `cableStore` or `mountedThreadStore`: a second copy of "what is mounted" is
// the single highest-risk mistake this feature can make, and this app has already paid for
// duplicate mount truth twice.

import { useCallback, useState } from "react";

import { C } from "../theme/colors";
import { TYPE } from "../theme/scale";
import { ChatSectionHeader } from "./ChatSectionHeader";
import { PersonRow } from "./PersonRow";
import { ROW_PAD_X, type PairSide } from "../engine/rowGeometry";
import { otherPeopleList, totalUnread, useSocialStore } from "../stores/socialStore";
import { useAuthStore } from "../stores/authStore";

export const CHAT_SECTION_TESTID = "chat-section";
export const CHAT_EMPTY_TESTID = "chat-empty";

/** The zero-people copy. Exported so the test asserts the shipped strings, never a paraphrase. */
export const CHAT_EMPTY_TITLE = "No one here yet";

/** The second line, and there are TWO of them because "empty" has two causes that must not be
 *  narrated with one sentence.
 *
 *  This is the copy-follows-behaviour rule, applied BEFORE the behaviour changes rather than after.
 *  Today every `/social/*` path 404s (the orchestration deploy predates the feature and
 *  `SOCIAL_ENABLED` is unset), so "isn't switched on yet" is simply true. The moment the server is
 *  deployed that sentence becomes a LIE told to a user whose directory is merely empty — and a
 *  string that quietly stops being true is exactly the failure AGENTS.md's "user-facing copy is
 *  code" rule names. Deriving the line from the server's own answer means the copy cannot drift out
 *  of step with the deploy, because nobody has to remember to change it. */
export const CHAT_EMPTY_DETAIL = "Chat isn’t switched on yet.";
export const CHAT_EMPTY_DETAIL_LIVE = "No one else has joined yet.";
export const CHAT_EMPTY_DETAIL_NO_HANDLE = "Pick a username to join.";
export const CHAT_EMPTY_DETAIL_LOADING = "Looking for people…";

/**
 * Which second line to paint — from EVIDENCE THE CLIENT ACTUALLY HOLDS, in this order.
 *
 * The order is the whole design. Each line makes a strictly stronger claim than the one above it,
 * so each is only reachable once the weaker explanations are ruled out:
 *
 *   1. not live         → the feature is off or the server predates it. Says nothing about people.
 *   2. profile unread   → live, but we have not read YOUR profile back, so we cannot yet say
 *                         whether you have a handle. Says nothing about you or anyone else.
 *   3. no handle        → read, and you genuinely have no social identity, so every `/social/*`
 *                         path 404s for you and the roster could never fill regardless of who else
 *                         exists. A real state, not a corner: `socialEnabledFor` returns true for an
 *                         account with no profile row, so "live" and "has a handle" are independent.
 *   4. roster unread    → identified, but no roster pass has SUCCEEDED. Empty means unread.
 *   5. loaded, empty    → the only state in which "no one else has joined" is a thing we know.
 *
 * Rungs 2 and 4 share a string deliberately — both are "we are still looking", and the user has no
 * use for the distinction between which read is outstanding.
 *
 * The last line is a claim about the DIRECTORY, and deriving it from `socialEnabled` alone — a fact
 * about the ACCOUNT's permission — was roborev 60400's second finding: an empty `people` record
 * cannot distinguish "nobody is there" from "we never looked", and those diverge on a first pass,
 * on a 404, and on an offline pass that leaves the previous empty roster in place. Asserting the
 * strongest of the four on the weakest evidence is the same drift this module exists to prevent,
 * pointed the other way.
 */
export function chatEmptyDetail(opts: {
  socialEnabled: boolean | undefined;
  profileLoaded: boolean;
  hasHandle: boolean;
  rosterLoaded: boolean;
}): string {
  if (opts.socialEnabled !== true) return CHAT_EMPTY_DETAIL;
  // BEFORE the handle test, and that order is the fix for roborev 60423's second finding.
  // `me.username` is null both for "no identity" and for "not read yet", so testing the handle
  // first tells an ALREADY-REGISTERED user to go and pick a username during every cold launch —
  // and permanently if the profile read fails out and the sync latches quiet. Only an actual read
  // licenses any statement about whether you have a handle.
  if (!opts.profileLoaded) return CHAT_EMPTY_DETAIL_LOADING;
  if (!opts.hasHandle) return CHAT_EMPTY_DETAIL_NO_HANDLE;
  if (!opts.rosterLoaded) return CHAT_EMPTY_DETAIL_LOADING;
  return CHAT_EMPTY_DETAIL_LIVE;
}

export function ChatSection({
  pairSide,
  jointOpen,
}: {
  /** Which side this pair sits on — passed straight through to every row's shared geometry so a
   *  person row mirrors with the pair exactly as an agent row does. */
  pairSide: PairSide;
  /** Does this pair hold the live cable? Opens each selected row's concierge end.
   *
   *  REQUIRED, WITH NO DEFAULT, and that is deliberate. It had a `= false`, which is the defaulted
   *  seam `sparkle-lgbwf` names: `AgentSidebar` has the real value in scope (`usePairIsLive`) and
   *  passes it to both `AgentRow` and the pinned Sparkle row, but the Chat call site simply omitted
   *  it — so every person row in the SHIPPING app was built `jointOpen: false` forever, keeping a
   *  rounded concierge corner while the agent rows two pixels below it squared theirs and painted
   *  `row-joint-*`. That is exactly the shared-anatomy drift `rowAnatomy` was extracted to stop, and
   *  the suite could not see it: the tests pass their own `jointOpen`, so deleting the prop from the
   *  call site left everything green. Making it required is what forces the production wiring to
   *  exist at compile time rather than be asserted about. */
  jointOpen: boolean;
}) {
  // The RECORD is the selector's result, not `peopleList(...)` — a selector returning a fresh array
  // re-renders this component on every unrelated store touch. The sort happens below, in render.
  const people = useSocialStore((s) => s.people);
  const unread = useSocialStore((s) => s.unread);
  const clearUnread = useSocialStore((s) => s.clearUnread);
  // The server's own verdict on this account (§6.7). See the gate below for why the test is
  // `=== false` and not a truthiness check.
  const socialEnabled = useAuthStore((s) => s.me?.socialEnabled);
  // The two facts that let the empty state say something TRUE rather than something plausible —
  // see `chatEmptyDetail`. `hasHandle` is read off the store's own `me`, not off auth's, because
  // this is the social identity (row existence server-side) and not the Clerk account.
  const hasHandle = useSocialStore((s) => s.me.username != null);
  const profileLoaded = useSocialStore((s) => s.profileLoaded);
  const rosterLoaded = useSocialStore((s) => s.rosterLoaded);
  const [selectedSocialId, setSelectedSocialId] = useState<string | null>(null);

  // ONE handler for the whole list, taking the id as an ARGUMENT — not a fresh arrow per row.
  //
  // `PersonRow` is `memo`'d, and a closure minted in the map defeats that completely: its identity
  // changes on every `ChatSection` render, so a single `setAvailability` or `clearUnread` would
  // re-render every row in the column. The memo would have been inert decoration with a docstring
  // claiming otherwise, which is worse than no memo — a future editor reads the claim and stops
  // looking. `clearUnread` is a zustand action and so is stable for the store's lifetime; nothing
  // else is captured, so this identity never changes.
  const onSelectPerson = useCallback(
    (socialId: string) => {
      setSelectedSocialId(socialId);
      // Opening a conversation is what marks it read. Unconditional: `clearUnread` is a documented
      // no-op for an id with no entry, so there is no count to check first.
      clearUnread(socialId);
    },
    [clearUnread],
  );

  // Everyone BUT you — see `otherPeopleList`. Counting your own row here would make the empty
  // state unreachable, since socialSync always writes it.
  const rows = otherPeopleList(people);

  // HIDE ONLY ON AN AFFIRMATIVE `false`, which is a deliberate reading of the flag and not an
  // oversight. `socialEnabled` folds two different facts into one boolean: the global kill switch
  // and a per-account revocation. `false` means "this account may not use Social Coding" and the
  // block must go — but ABSENT means only that the server predates the field, which is the state of
  // production right now (last deployed before this feature existed). Treating absent as false
  // would keep the whole feature invisible on every build until the deploy lands, which IS the bug
  // being fixed — the founder's "I don't see that in the build". So absence renders the block with
  // honest copy, and only a server that actually says no takes it away.
  if (socialEnabled === false) return null;

  return (
    <div data-testid={CHAT_SECTION_TESTID}>
      <ChatSectionHeader count={rows.length} unread={totalUnread(unread)} />
      <div role="tree" aria-label="Chats" data-chat-tree>
        {rows.map((person) => (
          <PersonRow
            key={person.socialId}
            person={person}
            isActive={person.socialId === selectedSocialId}
            paneSide={pairSide}
            jointOpen={jointOpen}
            // FALSE UNTIL U6, and this is the one place the reason belongs.
            //
            // Selecting a person here changes nothing outside this component: the terminal pane is
            // still showing whatever agent `project.selectedAgentId` names. `ActiveFillets` is not
            // decoration — `rowAnatomy` documents the pane-end mouth as the claim "this row feeds
            // its terminal" — so painting it on a person row would put TWO rows in the column each
            // asserting a junction only one of them owns, and the one telling the truth would be
            // the agent row. The fill and `aria-selected` still say "this is the row you picked",
            // which is all the selection actually is right now. U6 owns the mount (`uiStore`'s
            // `activeChatUserId`) and flips this to true in the same change that makes it true.
            ownsPane={false}
            unread={unread[person.socialId] ?? 0}
            onSelect={onSelectPerson}
          />
        ))}
      </div>
      {rows.length === 0 && (
        // OUTSIDE the tree: a tree may own only `treeitem`s and `group`s, and an empty state is
        // neither. Inside it, AT announces it as a row that cannot be activated.
        <div
          data-testid={CHAT_EMPTY_TESTID}
          style={{ padding: `2px ${ROW_PAD_X}px 8px`, color: C.muted, fontSize: TYPE.micro }}
        >
          <div>{CHAT_EMPTY_TITLE}</div>
          <div style={{ opacity: 0.8 }}>
            {chatEmptyDetail({ socialEnabled, profileLoaded, hasHandle, rosterLoaded })}
          </div>
        </div>
      )}
    </div>
  );
}
