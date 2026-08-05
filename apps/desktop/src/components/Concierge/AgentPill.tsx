// The pill an agent NAMED BY THE CONCIERGE draws as: a live status dot, the agent's current name,
// and a click that opens it. The mirror image of the pill a SENT user message draws
// (ConciergeThread's `MentionedText`) — the founder's ask was that mentions be symmetrical, so an
// agent the concierge names reads the same as one the user addressed.
//
// ══ WHY A CONTEXT AND NOT A PROP ════════════════════════════════════════════════════════════════
// The pill is rendered from inside `<Markdown>`, which is `memo`ized on `text` ALONE and
// deliberately so: ReactMarkdown re-parses the entire string on every render, and a concierge reply
// streams in token by token, so every already-settled bubble would re-parse its whole text on every
// tick of the newest one. Handing `<Markdown>` a roster or a click handler would defeat that memo
// on every render (a fresh array/closure identity each time), turning a streaming reply into
// O(bubbles x tokens) markdown parses.
//
// React.memo blocks re-render from PROPS; it does not block a context update from reaching a
// consumer inside the memoized subtree. So the roster travels by context, the memo stays intact,
// and a pill still repaints the instant its agent's status changes.
//
// ══ WHY THE ROSTER IS THE ONE ConciergeHost ALREADY BUILDS ══════════════════════════════════════
// `ConciergeHost` maps the concierge feed into `MentionAgent[]` for the composer's picker. That
// projection already carries a LIVE name and a LIVE band, refreshed by the same feed tick that
// drives the build rows — so binding the pill to it means a renamed agent's pill renames itself,
// and a second roster (with its own staleness) never comes into existence.
//
// ══ EVERY CLICK PRODUCES A VISIBLE RESULT ═══════════════════════════════════════════════════════
// A pill embeds a hard agent id, and agents get closed and discarded underneath it. Two paths used
// to end in nothing at all happening when the reader clicked, and a dead link that fails silently
// is worse than no link — the reader cannot tell whether the agent is gone or whether the click
// registered. Observed on a pill labelled "Remove BYOK".
//
//   • THE ID NO LONGER RESOLVES. The pill rendered a muted span whose only explanation lived in a
//     `title` tooltip — hover-only, so a CLICK did nothing at all.
//   • THE ID RESOLVES BUT THE REVEAL DOES NOT LAND. `openProjectTab` returns early on an unknown
//     project and `selectAndOpen` on a missing agent (`services/agentReveal`). Both are silent, so
//     a pill whose agent was closed after the reply was rendered looks live, is clicked, and does
//     nothing.
//
// ══ WHY THERE IS NO "OPEN IN ANOTHER WINDOW" STATE ══════════════════════════════════════════════
// Worth writing down, because it is the obvious extra state and it is NOT reachable here.
// `buildConciergeFeed` maps exactly `projects[].agents` from projectStore; the cross-window roster
// it merges contributes STATUSES only, never additional agents (`services/conciergeFeed`). And
// projectStore is itself cross-window synced, so it already holds every window's projects. So an id
// that resolves in the roster is always an agent this window can mount, and a pre-click "this lives
// elsewhere" test would come out true only when the agent had actually been CLOSED — which is what
// `HistorySearch` already calls it. Guessing before the attempt would therefore have put a false
// sentence on screen; the failure is detected from the attempt's OUTCOME instead, and named
// honestly (roborev 55522).
import {
  createContext,
  useContext,
  useId,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { C } from "../../theme/colors";
import { bandColor } from "../../engine/statusBandLabels";
import { stripMentionSigil } from "./agentRefs";
import { MENTION_PILL_FILL } from "./MentionPill";
import type { MentionAgent } from "./mentions";
// TYPE ONLY, so this module still pulls in no store at runtime — the rule every component under
// components/Concierge follows. The union lives beside the function that PRODUCES it
// (services/agentReveal.revealOutcomeFor) rather than here, so there is one definition of what a
// reveal can do rather than a copy on each side of the seam.
import type { RevealOutcome } from "../../services/agentReveal";

export interface AgentPillContextValue {
  /** The live roster. Empty means "nothing resolves", which is the correct default. */
  agents: readonly MentionAgent[];
  /** Open this agent, and report WHAT THE READER SAW. Carries the project id too, because the agent
   *  may live in a project that is not the open one and the reveal path needs both.
   *
   *  THE RETURN VALUE IS THE CONTRACT, and it is a three-way `RevealOutcome` rather than a boolean
   *  because a boolean could not tell the two non-navigating cases apart:
   *
   *    • `"revealed"`        — something moved. The pill says nothing; the screen already answered.
   *    • `"already-showing"` — the agent is live and its side was ALREADY showing it, so the reveal
   *                            had nothing left to write. The pill says where it is.
   *    • `"gone"`            — no such agent any more. The pill says it is closed.
   *
   *  IT USED TO BE A BOOLEAN, and that is the bug this shape closes (bead sparkle-ixsb3). `true` was
   *  written here to mean "the screen changed" and produced there to mean "the writes ran" — see the
   *  opposite claims quoted on `RevealOutcome` — so an already-showing agent reported success and the
   *  pill, which says nothing on success, produced a completely invisible click. Every write on the
   *  reveal path is idempotent, so that state is ordinary rather than exotic: it is exactly what the
   *  concierge's own spawn leaves behind before it names the new agent in its reply.
   *
   *  A HANDLER THAT CANNOT FAIL RETURNS `"revealed"`.
   *
   *  OPTIONAL, and its absence is NOT the same as a failed open. "This surface has no reveal path"
   *  is a fact about the surface; "that agent is closed" is a fact about the agent, and rendering
   *  the first as the second would label a live agent closed on any column that did not wire an
   *  opener (roborev 55548). With no opener the pill degrades to inert prose, exactly as it does
   *  with no history route.
   *
   *  AN OBJECT, NOT TWO POSITIONAL STRINGS (roborev 54894). The call crosses into
   *  `openProjectTab(projectId, agentId)`, whose parameters are in the OPPOSITE order and are also
   *  both `string` — so a swap typechecks cleanly, and its only symptom is `openProjectTab` hitting
   *  its unknown-project early return and the click silently doing nothing. Named fields make the
   *  mistake unrepresentable instead of merely tested-for. */
  /** `anchorY` is the CLICK'S OWN viewport Y (`MouseEvent.clientY`) — where the reader was looking
   *  at the moment they asked. The builder column runs past a screenful, so landing on the right
   *  agent is not the same as the reader FINDING it; the row is brought to the cursor instead of to
   *  an arbitrary edge. Optional because a keyboard activation has no meaningful cursor position,
   *  and inventing one would scroll the column to somewhere nobody was looking. */
  onOpenAgent?: (target: { agentId: string; projectId: string; anchorY?: number }) => RevealOutcome;
  /** Search the prompt history of an agent that can no longer be opened. A closed agent's prompts
   *  outlive it (`services/history`), which is exactly how the discarded BYOK agent ids were
   *  recovered — so this is what turns the dead end into a destination.
   *
   *  It is ALSO the opt-in switch for interactivity: with no route to offer, an unresolvable pill
   *  stays plain prose rather than becoming a button wired to nothing, which is the dead link in a
   *  new costume. SupportModal and agent replies render `<Markdown>` without it. */
  onSeeHistory?: (target: { agentId: string; name: string }) => void;
}

/** A STABLE empty default — a module const, not an inline literal, so every `<Markdown>` outside the
 *  concierge column (SupportModal, agent replies) shares one identity and never re-renders on it.
 *
 *  Defaulting to "resolves nothing" is also the safe direction: a surface that has not opted in
 *  renders an agent link as inert prose rather than as a button wired to a no-op. */
const EMPTY: AgentPillContextValue = { agents: [] };

const AgentPillContext = createContext<AgentPillContextValue>(EMPTY);

/** Supplies the roster to every pill below it. Wrap the concierge thread in this; nothing else. */
export const AgentPillProvider = AgentPillContext.Provider;

const dot = (band: MentionAgent["band"]): CSSProperties => ({
  flex: "0 0 auto",
  width: 6,
  height: 6,
  borderRadius: "50%",
  // The SAME call the mention picker's rows and the digest lines make. Never a literal: `bandColor`
  // resolves through AGENT_STATUS, which is also where the build rows' dots get their color, so the
  // pill and the row it points at cannot drift apart.
  background: bandColor(band),
});

/** The shared shape, so the live and inert forms differ only where they must. */
const base: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  borderRadius: 4,
  padding: "1px 5px",
  // A pill broken across two lines stops reading as one object; these are two or three words.
  whiteSpace: "nowrap",
  fontSize: "inherit",
  fontFamily: "inherit",
  lineHeight: "inherit",
  verticalAlign: "baseline",
};

/** The muted form the non-navigating state wears: same words, no teal wash. */
const quiet: CSSProperties = {
  ...base,
  color: C.conciergeMuted,
  background: "transparent",
  padding: "1px 0",
};

/** What a pill that cannot be opened says. One sentence, non-alarming — a closed agent is the
 *  normal end of an agent's life, not an error the reader caused — and it NAMES the agent, because
 *  the reader needs to know which of several pills in a paragraph they just clicked. The wording
 *  matches `HistorySearch`'s existing "This agent was closed", so the app says it one way. */
const closedSentence = (name: string) => `${name} is closed.`;

/** The same sentence for a REPEATED miss, so a retry that fails again is not a silent no-op: the
 *  wording changes on the second attempt, and the notice is re-keyed on every one (see LiveNotice),
 *  which is what makes an identical outcome register as a live-region update at all.
 *
 *  What this does and does not promise, stated because the boundary matters: attempt 2 changes both
 *  the visible text and the announcement; attempts 3+ re-announce and re-render the notice but show
 *  the same words. A running tally in the sentence would make every click textually distinct and is
 *  deliberately not done — "Build 8 is still closed. (4)" reads as an error count the reader is
 *  accumulating, when the fact being reported has not changed. */
const missSentence = (misses: number, name: string) =>
  misses > 1 ? `${name} is still closed.` : closedSentence(name);

/** What a pill says when the agent is LIVE and its column was already showing it.
 *
 *  It NAMES THE PROJECT, and that is the whole value of the sentence. The reader is looking at the
 *  concierge column with one project's pair either side of it; an agent revealed in the pair they
 *  are not watching moved nothing they can see. "Where is it" is the only question they have, and
 *  the project is the answer — the same thing the pill's own tooltip promises ("Open X in Y").
 *
 *  NOT "…is closed", which is the trap this branch exists to avoid: the agent is perfectly alive,
 *  and this pill labelling it dead would be the false claim roborev 55548/55590 already fixed twice
 *  in the other direction. NOT silence either, which is what shipped and is the bug. */
const alreadySentence = (name: string, projectName: string) =>
  `${name} is already open in ${projectName}.`;

/**
 * The always-mounted live region, with the notice inside it.
 *
 * MOUNTED EVEN WHEN EMPTY, deliberately. A `role="status"` element created with its text already
 * inside it is commonly NOT announced — notably by VoiceOver in a WebKit webview, which is what
 * this app renders in. A live region has to exist BEFORE its content changes for the change to be
 * announced, so the region is always here and only its contents appear on click. Getting this wrong
 * would leave "every click produces a visible result" true for sighted readers and false for
 * everyone else (roborev 55522).
 *
 * INLINE ELEMENTS ONLY. This renders inside `<Markdown>`, i.e. inside a `<p>`, where a `<div>` is
 * invalid nesting that React will happily emit and the browser will silently reparent — moving the
 * notice out of the paragraph it explains.
 */
function LiveNotice({
  id,
  open,
  contentKey,
  children,
  action,
}: {
  id: string;
  open: boolean;
  /** Bumped on every fresh attempt. Re-keying REPLACES the region's child rather than updating it
   *  in place, which is what makes a repeated identical outcome register as a change at all — see
   *  the retry contract on the pill's click handler. */
  contentKey?: number;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <span id={id} role="status" data-testid="concierge-agent-pill-live">
      {open && (
        <span
          key={contentKey}
          data-testid="concierge-agent-pill-notice"
          style={{ ...base, marginLeft: 6, color: C.conciergeMuted, whiteSpace: "normal" }}
        >
          {children}
          {action}
        </span>
      )}
    </span>
  );
}

/** The one affordance inside a notice. A `<button>`, not a link: nothing here has an href. */
function NoticeAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid="concierge-agent-pill-notice-action"
      onClick={onClick}
      style={{
        border: "none",
        background: "transparent",
        padding: 0,
        marginLeft: 4,
        cursor: "pointer",
        color: C.cream,
        textDecoration: "underline",
        font: "inherit",
      }}
    >
      {label}
    </button>
  );
}

/**
 * One agent reference.
 *
 * `fallbackName` is what the model WROTE. It is used only when the id resolves to nothing — the
 * live roster name wins whenever there is one, which is what makes a renamed agent's pill update in
 * place instead of preserving whatever it was called when the message was written.
 *
 * That is the opposite of the rule a SENT USER message follows, and deliberately. There, the
 * mention is a record of who the user addressed, so the name is snapshotted and must not change
 * under them. Here, the pill is a live control the reader is about to click — it should describe
 * the agent as it is now, not as it was mentioned.
 */
export function AgentPill({
  agentId,
  fallbackName,
  onOpen,
}: {
  agentId: string;
  fallbackName: string;
  /**
   * A STRONGER reveal than the context's, for a surface that needs one. Overrides `onOpenAgent`
   * entirely (and, being supplied, is itself proof the surface is wired).
   *
   * IT EXISTS FOR THE NUDGE CARD, and the reason is specific rather than a matter of taste. The
   * context's opener is `openProjectTab`, which selects and mounts — enough for a top-level agent,
   * whose row the Build column always draws. It is NOT enough for a WORKER: a missing
   * `collapsedOrchestrators` entry reads as collapsed and a leftover band filter can hide the head
   * entirely, so the click lands on a screen where the named agent is not drawn (roborev
   * 53679/53734). `ConciergeHost.revealAgent` is the path that closes both gates, and since a nudge
   * card now names the WORKER that owns the red — rather than the orchestrator that relayed it —
   * that is the common case here, not the exotic one.
   *
   * ANY VALUE RETURNED IS SILENTLY DISCARDED, and this is the difference between this prop and
   * `onOpenAgent` (roborev 55988). `onOpenAgent` returns a `RevealOutcome` that this pill turns into
   * a visible sentence — "…is closed" for `"gone"`, "…is already open in X" for
   * `"already-showing"`. A caller that owns the reveal has taken over that reporting
   * (`ConciergeHost.revealAgentById` speaks all three outcomes through the column's one announcer),
   * so this pill deliberately renders no notice at all — see `ownsOutcome` below.
   *
   * THE `void` HERE IS A CONVENTION THE COMPILER WILL NOT ENFORCE (roborev 56002). TypeScript's
   * void-return bivariance makes `() => boolean` assignable to `() => void`, so a caller CAN still
   * write `onOpen={() => { …; return false; }}` and typecheck clean — and that `false` would be
   * thrown away exactly as the old `=> boolean` signature threw it away. An earlier version of this
   * comment claimed `void` made the mistake "unrepresentable"; it does not, and asserting a
   * compiler guarantee that does not exist is worse than the signature it was explaining, because
   * the next author trusts the type instead of reading this. The signature is here to say what the
   * component does with the value; the guarantee is this paragraph, not the type.
   */
  onOpen?: (target: { agentId: string; projectId: string }) => void;
}) {
  const { agents, onOpenAgent: contextOpen, onSeeHistory } = useContext(AgentPillContext);
  // Is there ANY route out of this pill? Either opener will do — a supplied `onOpen` is itself proof
  // the surface is wired. The two are deliberately NOT merged into one callable: they have different
  // return contracts (see `onOpen` above), and collapsing them is what would let a caller-owned
  // reveal's outcome be read as a context reveal's.
  const canOpen = onOpen !== undefined || contextOpen !== undefined;
  // TWO SEPARATE STATES, because they mean different things and one counter could not.
  //
  // `attempt` — the LAST NON-NAVIGATING OUTCOME on a resolved pill, and how many times running it
  // has come back. `null` while nothing has been attempted, or after an attempt that DID move the
  // screen (a reveal needs no sentence — the reader just watched it happen).
  //
  // IT CARRIES THE OUTCOME, not just a tally, because there are now two things a click can fail to
  // do and they need different sentences: `"gone"` says the agent is closed and offers its history,
  // `"already-showing"` says the agent is live and names where. Collapsing them back into a counter
  // is how the pill would start calling a live agent closed again.
  //
  // STILL COUNTED, for the reason a boolean could not carry (roborev 55590): setting an identical
  // value is a no-op update React bails out of, so a second click with the same outcome would paint
  // and announce NOTHING. The count is what re-keys the notice (see LiveNotice) and makes an
  // unchanged answer register as a live-region update.
  //
  // `expanded` — whether an UNRESOLVED pill's explanation is showing. Nothing was attempted; it is
  // a pure disclosure toggle.
  //
  // Sharing one counter between them was a false-claim bug (roborev 55618): a pill clicked to
  // expand while unresolved carried `misses = 1` into the resolved branch when a feed tick re-added
  // its agent, and rendered a live, in-roster agent as "…is closed" with no attempt ever made.
  // Per-pill either way, so one explained pill does not open every other pill's notice.
  const [attempt, setAttempt] = useState<{ outcome: "gone" | "already-showing"; n: number } | null>(
    null,
  );
  const [expanded, setExpanded] = useState(false);
  const noticeId = useId();
  const agent = agents.find((a) => a.id === agentId);
  // The LIVE name whenever the id resolves — that is what makes a renamed agent's pill rename
  // itself instead of preserving the label the message was written with. `stripMentionSigil` is
  // applied to the fallback rather than trusted from the caller: the persona ASKS the model for
  // `[@Name](…)`, and an instruction to a language model is a request, not a schema, so a compliant
  // model would otherwise render "@@Name".
  const name = agent ? agent.name : stripMentionSigil(fallbackName);

  const historyAction = onSeeHistory ? (
    <NoticeAction label="See what it did" onClick={() => onSeeHistory({ agentId, name })} />
  ) : undefined;

  // ── THIS SURFACE IS NOT WIRED, SO ITS ROSTER IS NOT AUTHORITATIVE ─────────────────────────────
  // `onOpenAgent` is the signal that a real host is supplying this context. Without it the pill may
  // make NO claim about the agent's lifecycle, because "the id is not in the roster I was given" is
  // only evidence of anything when there was a real roster to look in.
  //
  // THIS IS THE REACHABLE CASE, and it was the one still getting it wrong. SupportModal and agent
  // replies render `<Markdown>` with no provider at all, so they get `EMPTY` (`agents: []`) and
  // EVERY pill fell through to "…is closed" — a false claim about a perfectly live agent, on the
  // only path that actually reaches a reader. The earlier fix guarded the mirror-image
  // configuration (a roster with no opener), which no production surface constructs (roborev 55590).
  if (!canOpen) {
    return (
      <span
        data-testid="concierge-agent-pill-unwired"
        data-agent-id={agentId}
        {...(agent ? { "data-band": agent.band } : {})}
        style={quiet}
      >
        {agent && <span style={dot(agent.band)} aria-hidden />}@{name}
      </span>
    );
  }

  // ── THE ID DOES NOT RESOLVE ───────────────────────────────────────────────────────────────────
  // Known closed before the click, so there is nothing to attempt. Justified here in a way it is
  // not above: the surface IS wired, so its roster is the live fleet and an absence means absence.
  if (!agent) {
    // NOTE FOR THE NEXT PERSON TEMPTED TO SPECIAL-CASE `onOpen` HERE. It was tried, to stop a
    // caller-owned pill mounting a region on a card that is permanently on screen, and it was wrong
    // twice over (roborev 56062):
    //
    //   • `onOpen` does NOT report this outcome. The caller-owned openers resolve the id first
    //     (`ConciergeHost.onRevealAgent` → `resolveAgent` → null → return), so an unresolvable pill
    //     became a button that did nothing at all, with no notice and nothing announced — the exact
    //     dead end `AgentPill.deadEnd.test.tsx` exists to forbid.
    //   • It also dropped the "See what it did" route, which is the whole point of this branch: a
    //     closed agent's prompts outlive it, and that history is the destination.
    //
    // So an unresolvable pill keeps its own disclosure and its own region on EVERY surface. A card
    // naming an agent that has since closed therefore does add a second live region — which is
    // pre-existing behaviour that `NudgeCard` has always had, not something a caller can opt out of,
    // and fixing it belongs with the announcer, not with a branch here that suppresses the message.
    //
    // Without a history route there is nothing a click could usefully do, so the pill stays inert
    // prose rather than becoming a button that does nothing — see `onSeeHistory`'s doc.
    if (!onSeeHistory) {
      return (
        <span
          data-testid="concierge-agent-pill-closed"
          data-agent-id={agentId}
          title={closedSentence(name)}
          style={quiet}
        >
          @{name}
        </span>
      );
    }
    return (
      <span style={{ display: "inline" }}>
        <button
          type="button"
          data-testid="concierge-agent-pill-closed"
          data-agent-id={agentId}
          aria-expanded={expanded}
          aria-controls={noticeId}
          title={closedSentence(name)}
          // A GENUINE DISCLOSURE, unlike the resolved pill below: nothing is attempted, so this
          // toggles its explanation open and shut and `aria-expanded` describes it correctly.
          onClick={() => setExpanded((v) => !v)}
          style={{ ...quiet, border: "none", cursor: "pointer", textDecoration: "underline dotted" }}
        >
          @{name}
        </button>
        <LiveNotice id={noticeId} open={expanded} action={historyAction}>
          {closedSentence(name)}
        </LiveNotice>
      </span>
    );
  }

  // ── IT RESOLVES ───────────────────────────────────────────────────────────────────────────────
  // Attempt the reveal and believe the OUTCOME rather than the roster: an agent can be closed
  // between the render that drew this pill and the click that lands on it, and both early exits on
  // the reveal path are silent.
  const target = { agentId: agent.id, projectId: agent.projectId };
  // A CALLER-OWNED REVEAL REPORTS ITS OWN OUTCOME, so this pill must not also mount a live region.
  //
  // `LiveNotice` is deliberately always mounted (a `role="status"` created with its text already
  // inside it is commonly not announced — see its docstring). That is right for a pill inside a
  // REPLY, which appears once and stays. It is wrong for a pill on a surface that is permanently on
  // screen: the concierge column owns exactly ONE announcer, and a nudge card is derived from the
  // feed and drawn for as long as its agent is red — so a card carrying this region put a second,
  // competing polite region in the column, which is precisely what
  // `ConciergeThread.roleLabels` ("adds no live region of its own") exists to forbid. With several
  // cards up it was several.
  //
  // `onOpen` is the exact signal: a caller that supplies its own reveal has taken responsibility for
  // saying what the reader saw — `ConciergeHost.revealAgentById` posts a line for EVERY
  // non-navigating outcome, which is the ONLY thing that makes this suppression safe. It must cover
  // all three: it enumerated only "does not resolve" and "does not land" and therefore said nothing
  // at all for an already-showing agent, which put the original dead click straight back on the
  // card surfaces (roborev 58643). A fourth outcome added to `RevealOutcome` owes this list an
  // entry too. It was NOT true when the suppression was written: `revealAgent` dropped
  // `openProjectTab`'s boolean, so a pill whose agent closed between render and click did nothing at
  // all on exactly the two surfaces that supply `onOpen` (roborev 56068). If you add a third
  // `onOpen` caller, it owes the reader that sentence too —
  // so there is nothing left here to announce and the miss/retry state is unreachable by
  // construction. The pill degrades to what it is on that path — a button that opens an agent.
  const ownsOutcome = onOpen !== undefined;
  const outcome = ownsOutcome ? null : (attempt?.outcome ?? null);
  // ONLY `"gone"` mutes the pill. An `"already-showing"` agent is LIVE, so it keeps the teal wash and
  // its status dot — dressing it in the closed style would say with colour the thing the sentence
  // deliberately does not say with words.
  const showClosed = outcome === "gone";
  const notice =
    outcome === "gone"
      ? missSentence(attempt?.n ?? 1, name)
      : outcome === "already-showing"
        ? alreadySentence(name, agent.projectName)
        : null;
  return (
    <span style={{ display: "inline" }}>
      <button
        type="button"
        data-testid={showClosed ? "concierge-agent-pill-closed" : "concierge-agent-pill"}
        data-agent-id={agent.id}
        data-band={agent.band}
        // NO `aria-expanded`. This button is a RETRY, not a disclosure: activating it never
        // collapses the notice, so advertising it as expandable would promise assistive tech a
        // control that cannot be un-expanded (roborev 55590). `aria-controls` still holds — it does
        // own that region — and the known-closed pill above, which IS a toggle, keeps both.
        // OMITTED ENTIRELY when the caller owns the outcome: the region is not rendered in that
        // case, and `aria-controls` pointing at an id that is not in the document is a dangling
        // reference assistive tech reports as a broken relationship rather than ignoring.
        {...(ownsOutcome ? {} : { "aria-controls": noticeId })}
        // The bare live name is what the pill SHOWS, even when two agents share it — the id already
        // decides where the click lands, so the disambiguating "(project)" suffix `mentionRoster`
        // adds for the composer would only be chrome here. The project belongs in the tooltip, where
        // it answers "which of these four is this one" without widening every pill to carry it.
        // ONLY THE CLOSED SENTENCE TAKES THE TOOLTIP OVER. An `already-showing` notice is a
        // one-shot answer to one click, but a `title` persists — so substituting it left the pill
        // reading "…is already open in X." forever, including after that pair moved to another
        // project, at which point the tooltip is a false claim and the documented "which of these
        // four is this one" affordance is gone. It fires on the FIRST click of every freshly-spawned
        // agent's pill, so this is the common path, not a rare one (roborev 58643).
        title={showClosed ? notice! : `Open ${agent.name} in ${agent.projectName}`}
        // ALWAYS RE-ATTEMPTS, and derives the state from the FRESH outcome. An earlier version made
        // the first click on an explained pill merely dismiss the notice and return, which meant
        // that after the reader reopened the project the pill still claimed the agent was closed
        // and swallowed the very click meant to retry (roborev 55548). A failed reveal is a fact
        // about one MOMENT, so it is never sticky.
        //
        // COUNTING the misses rather than flagging them is what keeps the RETRY visible too: the
        // second failure changes the sentence ("…is still closed.") and every failure re-keys the
        // notice, so the live region is genuinely updated rather than re-rendered identically and
        // silently dropped (roborev 55590).
        //
        // THE REVEAL RUNS IN THE HANDLER, NEVER INSIDE THE UPDATER. React re-invokes a state
        // updater whenever it discards and replays a render (an interrupted concurrent render, a
        // Suspense retry, StrictMode's double-invoke), so an updater that performs the navigation
        // would run `openProjectTab` TWICE for one click — re-selecting a project tab and tearing
        // down the Sparkle overlay a second time. This codebase already designs around exactly this
        // hazard for dictated sends (voice/useAutoSend: "updaters here stay out of it entirely"),
        // and a version of this handler shipped with the call inline in the updater (roborev 55618).
        // The updater below is pure: it only folds an already-decided outcome.
        onClick={(e) => {
          // The caller-owned path reports its own outcome, so there is nothing to fold here — and
          // nothing that could be folded, since it returns void. The context path keeps the miss
          // ladder it was built for.
          if (onOpen) {
            onOpen(target);
            return;
          }
          // WHERE THE READER IS LOOKING, passed to the reveal so the row lands at the cursor rather
          // than at whatever edge `scrollIntoView` picks.
          //
          // `detail` is the activation's click count: ≥1 for a real pointer press, and 0 for the
          // click Enter/Space synthesise on a focused button — whose `clientY` is 0. Anchoring a
          // keyboard activation to that would yank the column to the top of the viewport, which is
          // both wrong and unrequested, so it passes no anchor and gets the old behaviour.
          const anchorY = e.detail > 0 ? e.clientY : undefined;
          const result = contextOpen!({ ...target, anchorY });
          // The updater stays PURE — it only folds an already-decided outcome (see above). A reveal
          // that moved the screen clears the notice; either non-navigating outcome sets or bumps it,
          // and a CHANGE of outcome restarts the count, because "still closed" must not be said
          // about a fact the reader is hearing for the first time.
          setAttempt((prev) => {
            if (result === "revealed") return null;
            // NORMALISED, not trusted. TypeScript's void-return bivariance lets a handler typed
            // `() => void` satisfy this signature and hand back `undefined` — the same hole the
            // `onOpen` doc above spells out, and a real one: an `undefined` here used to compare
            // equal to `prev?.outcome` on a FIRST click (both `undefined`), taking the increment
            // branch and reading `.n` off `null`. Anything that is not a known non-navigating
            // outcome degrades to `"gone"`, which is exactly what the old boolean did with a falsy
            // return, so the fallback is the previous behaviour rather than a new guess.
            const outcome = result === "already-showing" ? "already-showing" : "gone";
            return { outcome, n: prev !== null && prev.outcome === outcome ? prev.n + 1 : 1 };
          });
        }}
        style={
          showClosed
            ? { ...quiet, border: "none", cursor: "pointer", textDecoration: "underline dotted" }
            : {
                ...base,
                border: "none",
                cursor: "pointer",
                // The attachment chip's teal wash — the column's established "something rode along
                // with this message" tint, and the exact fill the sent-message and COMPOSER pills
                // use, so every form of mention reads as one vocabulary. Taken from the constant
                // rather than re-spelled: this was the third copy of the same `color-mix`, and a
                // shade of drift between them fails nothing and is exactly what the founder's "make
                // mentions symmetrical" ask rules out.
                background: MENTION_PILL_FILL,
                color: C.cream,
              }
        }
      >
        {!showClosed && <span style={dot(agent.band)} aria-hidden />}@{agent.name}
      </button>
      {!ownsOutcome && (
        <LiveNotice
          id={noticeId}
          open={notice !== null}
          contentKey={attempt?.n}
          // "See what it did" is a route for a CLOSED agent's surviving prompts. Offering it beside
          // "…is already open in X" would point the reader at history for an agent that is running
          // right now — the wrong destination, and one that implies the agent is over.
          action={outcome === "gone" ? historyAction : undefined}
        >
          {notice}
        </LiveNotice>
      )}
    </span>
  );
}
