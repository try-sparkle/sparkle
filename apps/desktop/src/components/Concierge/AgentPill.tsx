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
import { createContext, useContext, type CSSProperties } from "react";
import { C } from "../../theme/colors";
import { bandColor } from "../../engine/statusBandLabels";
import { stripMentionSigil } from "./agentRefs";
import type { MentionAgent } from "./mentions";

export interface AgentPillContextValue {
  /** The live roster. Empty means "nothing resolves", which is the correct default. */
  agents: readonly MentionAgent[];
  /** Open this agent. Carries the project id too, because the agent may live in a project that is
   *  not the open one and the reveal path needs both.
   *
   *  AN OBJECT, NOT TWO POSITIONAL STRINGS (roborev 54894). The call crosses into
   *  `openProjectTab(projectId, agentId)`, whose parameters are in the OPPOSITE order and are also
   *  both `string` — so a swap typechecks cleanly, and its only symptom is `openProjectTab` hitting
   *  its unknown-project early return and the click silently doing nothing. Named fields make the
   *  mistake unrepresentable instead of merely tested-for. */
  onOpenAgent: (target: { agentId: string; projectId: string }) => void;
}

/** A STABLE empty default — a module const, not an inline literal, so every `<Markdown>` outside the
 *  concierge column (SupportModal, agent replies) shares one identity and never re-renders on it.
 *
 *  Defaulting to "resolves nothing" is also the safe direction: a surface that has not opted in
 *  renders an agent link as inert prose rather than as a button wired to a no-op. */
const EMPTY: AgentPillContextValue = { agents: [], onOpenAgent: () => {} };

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
export function AgentPill({ agentId, fallbackName }: { agentId: string; fallbackName: string }) {
  const { agents, onOpenAgent } = useContext(AgentPillContext);
  const agent = agents.find((a) => a.id === agentId);
  // Applied here rather than trusted from the caller: the persona ASKS the model for `[@Name](…)`,
  // and an instruction to a language model is a request, not a schema. The pill draws its own
  // sigil, so a compliant model would otherwise render "@@Name".
  const name = stripMentionSigil(fallbackName);

  if (!agent) {
    return (
      <span
        data-testid="concierge-agent-pill-inert"
        data-agent-id={agentId}
        // Named, not silent. The reader is looking at a message that references an agent they can
        // no longer open; "nothing happens when I click" is a worse answer than a sentence.
        title="That agent is no longer open, so this can't be opened."
        style={{ ...base, color: C.conciergeMuted, background: "transparent", padding: "1px 0" }}
      >
        @{name}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid="concierge-agent-pill"
      data-agent-id={agent.id}
      data-band={agent.band}
      // The bare live name is what the pill SHOWS, even when two agents share it — the id already
      // decides where the click lands, so the disambiguating "(project)" suffix `mentionRoster`
      // adds for the composer would only be chrome here. The project belongs in the tooltip, where
      // it answers "which of these four is this one" without widening every pill to carry it.
      title={`Open ${agent.name} in ${agent.projectName}`}
      onClick={() => onOpenAgent({ agentId: agent.id, projectId: agent.projectId })}
      style={{
        ...base,
        border: "none",
        cursor: "pointer",
        // The attachment chip's teal wash — the column's established "something rode along with
        // this message" tint, and the exact fill the sent-message pill uses, so the two forms of
        // mention read as one vocabulary.
        background: `color-mix(in srgb, ${C.teal} 18%, transparent)`,
        color: C.cream,
      }}
    >
      <span style={dot(agent.band)} aria-hidden />@{agent.name}
    </button>
  );
}
