// A line the APP writes into the concierge thread — composed so that naming an agent without its
// id is a COMPILE ERROR rather than a thing someone has to remember.
//
// ══ WHY A TYPE AND NOT TWENTY-FIVE FIXED CALL SITES ═════════════════════════════════════════════
// The concierge's own bookkeeping lines ("<Name> is up — I sent your message", every refusal, every
// deferred-send outcome) interpolated `${a.name}` as bare text. The reader sees an agent named in a
// sentence and cannot click it, while the same name written by the concierge's BRAIN one line above
// is a pill — because the brain is instructed to emit `[@Name](sparkle-agent:<id>)` and the app was
// instructed nothing. Fixing the call sites one at a time fixes today's twenty-five and none of
// tomorrow's: the next `postSparkle(\`${a.name} …\`)` compiles perfectly and ships the bug back.
//
// So the rule is enforced by the type system in TWO places, and both are load-bearing:
//
//   1. `postSparkle` (and anything else drawing app-authored prose) accepts a `Line`, never a
//      `string`. A bare template literal does not typecheck.
//   2. Inside the `line` tagged template, an interpolation slot accepts only a `Slot` — so
//      `${a.name}` does not typecheck either, because `string` is not a `Slot`.
//
// Together those mean the ONLY way to get an agent's name into a concierge line is `ref(agent)`,
// which cannot be constructed without an id. `plain(text)` remains for genuinely id-less text (a
// quoted payload, a project name, an error string from elsewhere) — it is deliberately explicit and
// greppable, so `plain(a.name)` reads as the deliberate act it would have to be.
//
// ══ THE THIRD CONSUMER, PAID UP FRONT ═══════════════════════════════════════════════════════════
// `agentRefs.ts` opens by counting the consumers of concierge markdown — the renderer and the
// clipboard — and warns that a THIRD (a notification body, a router payload, an export) either pays
// the flattening cost again or reintroduces the bug. This module adds that third consumer knowingly:
// `postSparkle` announces every line to the screen reader, and a live region handed
// `[@Kraken Auth](sparkle-agent:9f3c…)` reads a uuid aloud with no way to scroll past it.
//
// It is paid HERE rather than at the announcer, by carrying both renderings on the value itself. A
// `Line` is not a string that must be remembered to be flattened; it is a pair, and the announcer
// takes `.spoken` because that is the only field it is offered. `.spoken` is exactly the sentence
// the app used to produce, so what a screen-reader user hears is unchanged by this feature.
import { AGENT_REF_SCHEME, agentRefHref } from "./agentRefs";
import { beadRefHref, isWellFormedBeadId } from "./beadRefs";

/** The minimum an agent must be to be referenced: an id to open, a name to read. Structural so a
 *  feed agent, a roster agent and a test fixture all satisfy it without a shared nominal type. */
export interface ReferencableAgent {
  id: string;
  name: string;
}

/**
 * The two renderings of one composed line.
 *
 * `md` is markdown for `<Markdown>` (pills). `spoken` is the flat sentence for the live region.
 * Both are produced together, from the same slots, so they cannot drift.
 */
export interface Line {
  readonly md: string;
  readonly spoken: string;
}

const AGENT_SLOT = Symbol("agent-slot");
const PLAIN_SLOT = Symbol("plain-slot");

interface AgentSlot {
  readonly kind: typeof AGENT_SLOT;
  readonly md: string;
  readonly spoken: string;
}
interface PlainSlot {
  readonly kind: typeof PLAIN_SLOT;
  readonly text: string;
}

/** What `line` will interpolate. `string` is deliberately NOT a member — that exclusion is the
 *  whole mechanism, so widening this type reopens the bug.
 *
 *  A BEAD reference reuses `AgentSlot`'s shape rather than adding a third variant, because the two
 *  carry the same thing: markdown for the renderer and a flat sentence for the live region. The
 *  slot's kind is about what `renderSlot` must DO, and it does the same thing to both. */
export type Slot = AgentSlot | PlainSlot;

/**
 * What an id must look like to be worth emitting as a reference.
 *
 * Mirrors `agentRefs.AGENT_ID_RE` on purpose. That one is the PARSER's trust boundary (untrusted
 * model text coming in); this one is the WRITER's, and a reference the parser would reject must
 * never be written, or the clipboard carries `[@Name](sparkle-agent:bad id)` — a dead link with an
 * internal id in it, which `stripAgentRefs` cannot flatten precisely because the parser rejects it.
 * An id that fails here degrades to plain text: the reader loses a click, never the name.
 */
const WRITABLE_AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The bead equivalent, and note it is the PARSER's own predicate rather than a mirrored literal.
 *
 *  Mirroring is what `WRITABLE_AGENT_ID` above does, and it is a standing hazard: two regexes that
 *  must agree, in two files, with nothing failing when they drift. Bead ids admit a `.` that agent
 *  ids refuse (`sparkle-hiju.4` is real), so the two classes are genuinely different and a copied
 *  literal here would be a third spelling of a rule that already has two. `isWellFormedBeadId` is
 *  exported from `./beadRefs` for exactly this — the writer asks the parser what it will accept. */
const isWritableBeadId = isWellFormedBeadId;

/**
 * Escape a display name for use as a markdown link LABEL.
 *
 * Agent names are user- and model-authored ("Build [5]", "auth *v2*"), and an unescaped `]` closes
 * the label early — which does not merely look wrong, it splits the link so the trailing text and
 * the href leak into the sentence as literal syntax. Emphasis and code marks are escaped for
 * fidelity rather than safety: `linkText` in Markdown.tsx flattens nested elements, so a name that
 * italicised would still READ correctly, but it would render in a different face than its neighbours.
 *
 * ══ `<` AND `>` ARE HERE FOR SAFETY, NOT FIDELITY ═══════════════════════════════════════════════
 * This function is also what `renderSlot` runs over `plain(...)` text, and brackets are NOT the only
 * way to make a link. CommonMark AUTOLINKS — `<scheme:rest>` — produce a real `link` node with no
 * bracket syntax at all, and `sparkle-agent` is a well-formed scheme. `Markdown.tsx` decides
 * pill-ness purely from `parseAgentRefHref(href)`, and `AgentPill` then prefers the LIVE ROSTER NAME
 * over the label — so untrusted text containing `<sparkle-agent:ag9>` rendered as an ordinary-looking
 * pill naming and opening an agent the app never vouched for. Reachable from `plain(r.matchedLabel)`
 * (a value read off an agent's own terminal picker) and from `plain(quoted)` on relayed payloads.
 *
 * The module's test asserted "a quoted payload cannot forge a reference" while covering only the
 * `[label](url)` form, so the invariant read as proven when it was not (roborev 56060).
 */
function escapeLabel(name: string): string {
  return name.replace(/[\\[\]`*_~<>]/g, (c) => `\\${c}`);
}

/**
 * Reference an agent — the only way to put an agent's name into a concierge line.
 *
 * The `@` sigil is written into the label because that is the form the persona emits and the form
 * `stripMentionSigil` expects; the pill draws its own `@`, so the reader sees exactly one.
 */
export function ref(agent: ReferencableAgent): Slot {
  const name = agent.name.trim();
  // A nameless agent would render as a bare `@`. There is nothing to click TO that is worth a pill
  // the reader cannot identify, so it degrades to the same words the app used before pills existed.
  if (name === "" || !WRITABLE_AGENT_ID.test(agent.id)) {
    return { kind: PLAIN_SLOT, text: name === "" ? "that agent" : name };
  }
  return {
    kind: AGENT_SLOT,
    md: `[@${escapeLabel(name)}](${agentRefHref(agent.id)})`,
    spoken: name,
  };
}

/**
 * Reference a BEAD — the unit of work, rather than the agent doing it.
 *
 * ══ WHY THIS EXISTS WHEN THE LINKIFIER WOULD HAVE CAUGHT IT ANYWAY ══════════════════════════════
 * `remarkBeadRefs` finds bare ids in prose, so `flat(\`recorded on \${id}\`)` would already render a
 * pill. Two things it cannot do, and both are the reason this is here:
 *
 *   • THE SPOKEN RENDERING. `postSparkle` announces every line through the column's ONE live region,
 *     and the linkifier never touches `.spoken` — it operates on the parsed markdown tree, which the
 *     announcer does not read. A bare id therefore gets read aloud CHARACTER BY CHARACTER
 *     ("s-p-a-r-k-l-e dash one seven h m one") with no way to scroll past it. Passing the title lets
 *     the sentence say what the bead IS and keep the id for the eye. This is the third-consumer tax
 *     `agentRefs.ts` warns about, paid here for the same reason it is paid there for agents.
 *   • THE WRITER'S TRUST BOUNDARY. An id the parser would reject must never be written, or the
 *     clipboard carries a dead `[…](sparkle-bead:bad id)`. An id that fails degrades to plain text:
 *     the reader loses a click, never the id.
 *
 * `title` is optional because the caller often has only an id — a bead it just filed, a bead named
 * in a tool result. Without one the spoken form is the id, which is exactly what the app said before
 * this existed, so nothing regresses by omitting it.
 */
export function bead(target: { id: string; title?: string }): Slot {
  const id = target.id.trim();
  if (!isWritableBeadId(id)) return { kind: PLAIN_SLOT, text: id };
  const title = target.title?.trim();
  return {
    kind: AGENT_SLOT,
    md: `[${escapeLabel(id)}](${beadRefHref(id)})`,
    // The id LAST when there is a title, so a listener hears the meaning before the handle and can
    // stop attending once they have it.
    spoken: title === undefined || title === "" ? id : `${title} (${id})`,
  };
}

/**
 * Text that is NOT an agent name — a quoted payload, a project name, a count, an error from
 * elsewhere. Explicit so that the absence of a pill is a decision someone made, not one they forgot.
 */
export function plain(text: string): Slot {
  return { kind: PLAIN_SLOT, text };
}

/** Both renderings of a slot. */
function renderSlot(s: Slot): { md: string; spoken: string } {
  if (s.kind === AGENT_SLOT) return { md: s.md, spoken: s.spoken };
  // A literal `[` or `]` in interpolated plain text would otherwise be read as link syntax by the
  // renderer — the quoted relay payload is arbitrary user prose and routinely contains both.
  return { md: escapeLabel(s.text), spoken: s.text };
}

/**
 * Compose a concierge line.
 *
 * The STATIC parts are trusted markdown authored in this repo (they may legitimately contain
 * emphasis); only the interpolated slots are escaped, because only they carry outside text.
 */
export function line(strings: TemplateStringsArray, ...slots: Slot[]): Line {
  let md = "";
  let spoken = "";
  strings.forEach((chunk, i) => {
    md += chunk;
    spoken += chunk;
    const slot = slots[i];
    if (slot === undefined) return;
    const r = renderSlot(slot);
    md += r.md;
    spoken += r.spoken;
  });
  return { md, spoken };
}

/**
 * A line with no interpolation at all — "Working on it…".
 *
 * Exists so a fixed sentence does not have to go through the tagged template just to satisfy the
 * type, and so that reading `flat(` at a call site tells you immediately that no agent is named.
 */
export function flat(text: string): Line {
  return { md: text, spoken: text };
}

/** True when `md` contains an agent reference. For tests and for the lint of last resort. */
export function hasAgentRef(md: string): boolean {
  return md.includes(AGENT_REF_SCHEME);
}
