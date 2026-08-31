// TOOL-LEVEL policy for MCP permission prompts — the missing granularity under the `mcp` category.
//
// WHY THIS EXISTS. `[approvals].mcp` is ONE bucket covering every MCP prompt, and the tools inside
// it are nothing like each other: `set_agent_activity` writes a one-line narration string, while
// `sparkle_lifecycle` DISCARDS an agent and `spawn_worker` creates one. A single always/ask rule
// therefore forces a choice between two bad answers — auto-approve the destructive ops along with
// the harmless ones, or keep being asked to approve a status string.
//
// The founder's measured case is exactly that fork: his config carries `bash = "always"` (the most
// dangerous category auto-answered) while `mcp` is unset, so a narration call prompts every time.
// Setting `mcp = "always"` to stop those prompts would, today, also auto-approve agent discards.
//
// So this module splits the bucket by TOOL, with two lists that are deliberately asymmetric:
//
//   • DENY always wins, including over an explicit `mcp = "always"`. A user who asked for "auto-
//     approve tool calls" was not asking to have agents spun down on their behalf while they were
//     away from the desk. This is an override, not a default.
//   • ALLOW is tiny and closed. It carries only tools whose non-mutating character is verified
//     elsewhere in the tree, and it does NOT grow by pattern-matching a name. An unrecognised tool
//     is never allowlisted — it falls through to the ordinary category rule.
//
// THE MODULE-WIDE INVARIANT, and it is the rule to check any change here against: NOTHING THIS
// FILE DOES TO A CANDIDATE MAY UPGRADE A VERDICT FROM "ask" TO "auto". Everything downstream of
// {@link mcpToolFromPrompt} reads TERMINAL SCROLLBACK, which an agent can print in any shape it
// likes, so every heuristic here is defeasible by construction and the only durable property is a
// one-directional one. Three review rounds each replaced a defeated positional rule with another
// positional rule and each introduced a fresh bypass; the fourth states the direction instead —
// see {@link pendingRegion} for the structural proof, and the "Potential concerns" section of
// PRD/mcp-tool-policy-monotonic-invariant.md for what this does NOT fix and why the real remedy
// is at the caller. Read that before adding a fifth special case.
//
// FAIL CLOSED ON AMBIGUITY, in both directions. A prompt whose tool name cannot be parsed yields
// null from {@link mcpToolFromPrompt}, and a null tool is neither denied-with-certainty nor
// allowlisted — the caller must treat it as "ask". Being unable to read the name is a reason to
// involve the human, never a reason to answer for them.
//
// See bead sparkle-eg0o9 for the plan-mode half of the same complaint (annotations, not permissions).

/** A tool that may be auto-answered on the human's behalf without them ever seeing the prompt.
 *
 *  MEMBERSHIP IS EVIDENCE-BASED, not a judgement call made here: these are exactly the tools
 *  `apps/mcp-control/src/server.ts` advertises with `annotations.readOnlyHint: true`
 *  (`PLAN_SAFE_TOOLS`), plus the read-only browser-inspection tools Sparkle already pre-approves in
 *  `worktree.rs::SPARKLE_ALLOWED_TOOLS`. Both lists were vetted for exactly this property — "touches
 *  no file, no repository, no system state" — so this one inherits that review instead of
 *  re-deciding it. `planModeAnnotations.test.ts` guards the first set; adding a tool here that is not
 *  in one of those two places is how this list silently becomes wrong.
 *
 *  NOT INCLUDED, on purpose, though it is adjacent: `set_agent_goal_met`. It is the fleet's terminal
 *  completion latch (a positive `goal.metAt` makes a quiet exit permanently non-resurrectable), and
 *  it is excluded from PLAN_SAFE_TOOLS for that reason. It stays a prompt. */
export const AUTO_ANSWERABLE_TOOLS: readonly string[] = [
  // sparkle-control self-management + inspection (mirrors PLAN_SAFE_TOOLS).
  "get_state",
  "get_config",
  "rename_agent",
  "set_agent_activity",
  "set_agent_goal",
  // Read-only browser inspection (mirrors the read-only half of SPARKLE_ALLOWED_TOOLS).
  "read_page",
  "get_page_text",
  "read_console_messages",
  "read_network_requests",
  "tabs_context_mcp",
];

/** Substrings that mark a tool as never-auto-answerable, matched case-insensitively against the
 *  tool name.
 *
 *  WHY SUBSTRINGS HERE AND EXACT NAMES ABOVE. The two lists have opposite failure modes, so they get
 *  opposite matching rules. A too-narrow ALLOW list costs one extra prompt; a too-narrow DENY list
 *  auto-approves something irreversible. Patterns over-match by construction, which is the safe
 *  direction for a deny list and the unsafe one for an allow list — so DENY is fuzzy and ALLOW is
 *  exact. A new destructive tool named `spawn_replica` or `close_project` is caught the day it
 *  lands, without anyone remembering to update this file. */
export const DENIED_TOOL_PATTERNS: readonly string[] = [
  // Creates or destroys agents / workers.
  "spawn",
  "spin_down",
  "lifecycle",
  "discard",
  "kill",
  "terminate",
  "resurrect",
  // Destroys or rewrites work.
  "delete",
  "remove",
  "destroy",
  "reset",
  "revert",
  "close",
  // Moves code between branches / out to the world.
  "merge",
  "push",
  "commit",
  "land",
  "release",
  "publish",
  "claim_pr",
  // Speaks or acts as the human.
  "send",
  "message",
  "reply",
  "comment",
  "approve",
  "dispatch",
  // Rewrites configuration or drives the UI somewhere the human did not ask to go.
  "set_config",
  "set_theme",
  "set_zoom",
  "set_agent_model",
  "navigate",
  "guideline",
  "terminal",
  "workflow",
  "workspace",
  // The completion latch — see the note on AUTO_ANSWERABLE_TOOLS.
  "goal_met",
  // Anything that writes a file.
  "write",
  "edit",
  "create",
];

/** ONE spelling of a tool name, so neither gate below can be walked past by re-typing the verb.
 *
 *  THIS LIVES HERE, NEXT TO THE SETS IT GUARDS. A set of denied NAMES is only as strong as its
 *  weakest reader's spelling rules, and this module had two readers with two different sets of
 *  rules: {@link isDeniedTool} folded case, {@link isAutoAnswerableTool} compared raw, and
 *  {@link mcpToolFromPrompt} — the one that reads UNTRUSTED terminal scrollback — anchored on a
 *  case-SENSITIVE `mcp__` literal and returned null for anything shouted. A normalizer that lives
 *  one module away from the set it protects is a normalizer that gets applied in one place and
 *  forgotten in the other (bead sparkle-lp0ia; the same finding against `chiefScope.ts` is
 *  `normalizeChiefToolName`, which this deliberately mirrors).
 *
 *  Three reductions, each covering a way one verb reaches us wearing a different coat: padding,
 *  case, and the `mcp__<server>__` wire prefix an MCP name arrives under.
 *
 *  THE WIRE PREFIX IS STRIPPED ONLY FROM A NAME THAT IS EXACTLY `mcp__<server>__<tool>` — three
 *  segments, no more. The one-line `split("__").pop()` this could have been reduces
 *  `mcp__srv__spawn_worker__set_agent_activity` to `set_agent_activity`, which would let a
 *  destructive verb ride into the allow list on a prefix an attacker chose. A normalizer that can
 *  turn a denied name into an allowed one is the bypass, not the fix. */
export function normalizeToolName(tool: string | null | undefined): string {
  const trimmed = (tool ?? "").trim().toLowerCase();
  const parts = trimmed.split("__");
  return parts.length === 3 && parts[0] === "mcp" && parts[1] && parts[2] ? parts[2] : trimmed;
}

/** THE WIRE FORM, matched only where a picker would actually PRINT one — as the header token of its
 *  own line, never from inside an argument list.
 *
 *  Two properties, each closing a measured bypass (roborev 70027, both High):
 *
 *  1. THE SERVER SEGMENT MAY NOT CONTAIN `__`. The old class `[A-Za-z0-9_.-]+` included `_`, so on
 *     `mcp__srv__spawn_worker__set_agent_activity(…)` greedy matching backtracked to the LAST `__`
 *     and captured `set_agent_activity` — the allowlisted name. normalizeToolName's
 *     "exactly three segments" bound was supposed to stop that, but it never saw a four-segment
 *     name, because the parser had already thrown the first three away. Forbidding `__` inside the
 *     server keeps the whole four-segment name intact so the bound can do its job.
 *  2. THE PREFIX OF THE LINE MAY NOT LOOK LIKE AN ARGUMENT LIST — no quote, paren or comma between
 *     the start of the line and the token. Neither branch is preferred by kind, so any wire-shaped
 *     substring ANYWHERE in the ~30-line header region used to be able to rename the pending
 *     prompt: `sparkle-control - sparkle_lifecycle(op: "discard_agent", note:
 *     "mcp__x__get_state")` resolved to `get_state`, was allowlisted, and auto-approved the
 *     discard. Prose is still allowed ahead of the token (`Use tool mcp__playwright__…?`), because
 *     refusing to parse a name we CAN read is its own hazard: a null does not mean "ask" to
 *     `approvalsRuntime`, it means the deny veto is skipped and the prompt falls through to a
 *     category guess.
 *
 *  THAT SECOND PROPERTY IS A SAME-LINE GUARD ONLY, and the input is already-WRAPPED pane text, so
 *  it does not survive on its own — see {@link openArgumentSpans}, which is the cross-line half.
 *
 *  The `d` flag is load-bearing: {@link mcpToolFromPrompt} compares the position of the CAPTURED
 *  NAME, and `m.index` here is the start of the LINE (this pattern is `^`-anchored), which would
 *  make every same-line rival compare as "later". */
const WIRE_HEADER = /^[^"'(),\r\n]*?(mcp__(?:(?!__)[A-Za-z0-9_.-])+__[A-Za-z0-9_]+)/gimd;

/** The display form the picker renders: `<server> - <tool>(args…)`. The server segment may contain
 *  dashes (sparkle-control), so anchor on the SPACED separator rather than splitting on "-".
 *
 *  The trailing "(" is load-bearing, not decoration. Without it this pattern matches ordinary
 *  English containing a spaced dash, and every such match becomes a tool name that the deny veto
 *  then reasons about. Requiring the open paren keys on how the picker actually renders a tool
 *  invocation, which is the thing we are trying to recognise.
 *
 *  IT CARRIES THE SAME HEADER-TOKEN ANCHOR AS {@link WIRE_HEADER}, and that symmetry is a security
 *  property (roborev 71902, High). The anchor was applied to the wire branch alone, which reopened
 *  the very hijack it closed — in the reverse direction. With neither branch preferred by kind, a
 *  DISPLAY-shaped substring inside a WIRE-form prompt's OWN arguments simply matched later and won:
 *  `mcp__sparkle-control__sparkle_lifecycle(op: "discard_agent", note: "srv - get_state(1)")`
 *  resolved to `get_state`, hit the allow list, and auto-approved the discard. A constraint that
 *  only one of two symmetric branches obeys is not a constraint. */
const DISPLAY_HEADER = /^[^"'(),\r\n]*?[A-Za-z0-9_.-]+\s+-\s+([A-Za-z0-9_]+)\s*\(/gimd;

/** Per-character map of "this offset sits inside an OPEN argument list", i.e. inside parentheses
 *  that the text has not yet closed.
 *
 *  WHY A CROSS-LINE SCAN AT ALL (roborev 71902, High). The header regexes above prove a token is
 *  the header of its own LINE, and that property does not survive TERMINAL WRAPPING — which is how
 *  this input is produced. `headerRegion` joins pane lines that the terminal has already broken, so
 *  a long display-form prompt
 *
 *      sparkle-control - sparkle_lifecycle(op: "discard_agent", note: "…mcp__x__get_state…")
 *
 *  arrives as two lines, and the wire token BEGINS the second one — whose prefix contains no quote,
 *  paren or comma, because those bytes are all on the line above. The same-line guard inspects only
 *  the rendered line, so any attacker-controlled argument text long enough to wrap defeats it. This
 *  scan is the half that reads the region as one document: a token that is still inside an
 *  unclosed `(` is a CONTINUATION of somebody else's argument list, whatever its own line looks
 *  like.
 *
 *  QUOTES ARE TRACKED ONLY INSIDE PARENTHESES, on purpose. Their job here is to keep the paren
 *  depth honest — `note: "a (b"` must not open a level and `")"` must not close one — and nothing
 *  more. Tracking them in open prose would let a single apostrophe in agent output ("don't") swallow
 *  the rest of the region, which is exactly the brittleness that would turn this guard into a
 *  parser that stops reading names it can plainly see.
 *
 *  A BACKSLASH AND THE BYTE IT ESCAPES ARE ONE UNIT (roborev 71942, High). The loop used to compare
 *  bytes one at a time, so an ESCAPED quote ended the span the renderer had not ended — and the two
 *  bytes `")` are what a `JSON.stringify`d argument value looks like from inside:
 *
 *      sparkle-control - sparkle_lifecycle(op: "discard_agent", note: "he said \")
 *      mcp__x__get_state(1)")
 *
 *  `\"` closed the quote, the next `)` took the depth back to 0, and the attacker's token began the
 *  next line at depth 0 — a header again, positioned later, and allowlisted. Consuming the escape
 *  with its payload is what makes an escaped quote unable to terminate anything.
 *
 *  AN UNMATCHED `)` POISONS EVERYTHING AFTER IT — the ODD-QUOTE half of the same finding. Escaping
 *  only helps while the renderer escapes; an argument value carrying an ODD number of raw quote
 *  characters desyncs the quote state and lets the very next `)` close the header's own paren:
 *
 *      sparkle-control - sparkle_lifecycle(op: "discard_agent", note: "he said " then ) ")
 *
 *  There is no way to tell that apart from a genuinely closed argument list by looking at the depth
 *  alone — but the break-out leaves the renderer's OWN trailing `)` matching nothing, and
 *  well-formed picker output never does that. So a `)` seen at depth 0 marks the rest of the region
 *  as untrusted. It is deliberately one-directional: like the paren depth itself it can only ever
 *  DEMOTE a candidate, and {@link mcpAutoAnswerable} is built so demotion can never upgrade a
 *  verdict. Prose that ends in `:)` therefore costs at most one extra prompt. */
function openArgumentSpans(text: string): Uint8Array {
  const open = new Uint8Array(text.length);
  let depth = 0;
  let quote = "";
  let stray = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") {
        // Inside a quote the depth is >0 by construction, so both bytes are inside the span.
        open[i] = 1;
        if (i + 1 < text.length) open[++i] = 1;
        continue;
      }
      if (c === quote) quote = "";
    } else if (depth > 0 && (c === '"' || c === "'")) {
      quote = c;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      if (depth > 0) depth--;
      else stray = true;
    }
    open[i] = depth > 0 || stray ? 1 : 0;
  }
  return open;
}

/** One candidate tool name read out of the header region.
 *
 *  `at` is the offset of the CAPTURED NAME, never of the whole match. Both patterns are
 *  `^`-anchored, so `m.index` is the LINE START for either branch — comparing that would collapse
 *  every same-line rivalry to a tie and hand the answer to whichever branch is listed first,
 *  regardless of which token the picker is actually rendering (roborev 71902). The `d` flag is
 *  what makes the captured offset available; `DISPLAY_HEADER`'s capture is not match-final, so it
 *  cannot be recovered by arithmetic on the match length. */
type HeaderCandidate = { name: string; at: number; authoritative: boolean };

function headerCandidates(text: string, re: RegExp, openArgs: Uint8Array): HeaderCandidate[] {
  const out: HeaderCandidate[] = [];
  for (const m of text.matchAll(re)) {
    const name = m[1];
    if (!name) continue;
    const at = m.indices?.[1]?.[0] ?? m.index ?? 0;
    out.push({ name, at, authoritative: openArgs[at] !== 1 });
  }
  return out;
}

/** The tool name from an MCP permission prompt, or null when it cannot be read.
 *
 *  Two shapes reach us and BOTH must work, because they come from different renderers:
 *    • the wire/allowlist form `mcp__sparkle-control__set_agent_activity`, and
 *    • the picker's display form `sparkle-control - set_agent_activity`, which is what the founder
 *      actually saw on screen.
 *  Anything else returns null, which the caller must treat as "ask the human".
 *
 *  THE WIRE FORM IS RETURNED WHOLE, prefix and all — `mcp__spawn-server__get_state`, not
 *  `get_state`. That is the WIDEST spelling, and handing it on is what lets the gates downstream be
 *  asymmetric on purpose: {@link mcpAutoAnswerable} vetoes on the prefix segments before
 *  {@link isAutoAnswerableTool} strips them. Narrowing here instead would destroy the evidence both
 *  gates need before either one has seen it. */
function readHeaderCandidates(text: string): HeaderCandidate[] {
  const openArgs = openArgumentSpans(text);
  // BOTH BRANCHES ARE READ THE SAME WAY — same header-token anchor, same position basis, same
  // continuation test. Asymmetry between them is what roborev 71902 found: whichever branch is
  // unconstrained becomes the hijack, whichever direction that happens to be.
  return [
    ...headerCandidates(text, WIRE_HEADER, openArgs),
    ...headerCandidates(text, DISPLAY_HEADER, openArgs),
  ];
}

/** The candidate the picker is most likely actually rendering.
 *
 *  A CONTINUATION-LINE TOKEN IS NON-AUTHORITATIVE, NOT DISCARDED. Demoting rather than dropping is
 *  what keeps this from becoming a way to return null more often: a null tool does not mean "ask"
 *  to `approvalsRuntime`, it means the deny veto is SKIPPED and the prompt falls through to a
 *  category guess, which under the founder's `bash = "always"` is an auto-approved discard. So a
 *  region whose every candidate sits inside an open argument list still yields the best name we
 *  have — it just cannot outrank a real header.
 *
 *  LAST match wins, and this is a security property, not a preference (roborev 61990, High).
 *  Callers must pass the picker's header region, but defence in depth belongs here too, because the
 *  consequence of getting it wrong is the worst outcome this module has: a scrollback holding an
 *  earlier, already-answered `set_agent_activity(…)` above a PENDING
 *  `sparkle_lifecycle(op: "discard_agent")` parsed as the allowlisted tool under first-match, and
 *  the discard was auto-approved. The prompt being decided is always the LAST one on screen.
 *
 *  WHICHEVER BRANCH MATCHED LATEST DECIDES — the wire branch is not preferred unconditionally
 *  (roborev 70027, High). "Wire first" made the wire branch a hijack: it only had to appear
 *  SOMEWHERE in the region to rename the pending prompt, including from above an already-answered
 *  call, and the display branch never got to speak. Lateness is the same rule the sweep applies
 *  WITHIN a branch, so applying it BETWEEN branches too is the consistent reading. An exact tie
 *  keeps the wire form, which is the wider spelling and therefore the safer one to hand on.
 *
 *  The patterns are CASE-INSENSITIVE, and that was its own bug (bead sparkle-lp0ia). A shouted
 *  `MCP__SPARKLE-CONTROL__…` used to miss the anchor and return null.
 *
 *  THIS PICK IS NOT A SAFETY BOUNDARY ON ITS OWN, and treating it as one is what roborev 71942
 *  found: preferring an authoritative candidate lets an EARLIER one win, so a single stray `(` in
 *  agent prose demoted the pending header and handed the verdict to a stale, already-answered call.
 *  {@link pendingRegion} is the boundary; this only decides WHICH NAME to name. */
function chooseHeader(candidates: HeaderCandidate[]): HeaderCandidate | null {
  if (candidates.length === 0) return null;
  const authoritative = candidates.filter((c) => c.authoritative);
  const pool = authoritative.length > 0 ? authoritative : candidates;
  return pool.reduce((best, c) => (c.at > best.at ? c : best));
}

/** Every candidate that could still BE the pending prompt: those at or after the last authoritative
 *  header.
 *
 *  THIS IS THE MONOTONIC SAFETY BOUNDARY, and it is the whole answer to roborev 71942 (High). The
 *  demotion machinery is a heuristic over attacker-influenced text, so the rule it obeys must be
 *  one no positional subtlety can invert: DEMOTION MUST NEVER UPGRADE A VERDICT FROM "ask" TO
 *  "auto". Stated structurally rather than as a list of blocked shapes:
 *
 *    • With NO demotion at all, every candidate is authoritative, the anchor is the LAST candidate,
 *      and this region is exactly `{last}` — the pre-demotion behaviour, unchanged.
 *    • Demoting anything can only move the anchor EARLIER, so the region only ever GROWS, and it
 *      always still contains the positionally-last candidate.
 *    • {@link mcpAutoAnswerable} answers "auto" only when EVERY candidate in the region does.
 *      A conjunction over a superset can only get weaker, so demotion can turn "auto" into "ask"
 *      and never the reverse. QED — no arrangement of parens, quotes or line breaks can make the
 *      parser MORE permissive than the naive positional read it replaced.
 *
 *  A denied candidate STRICTLY BEFORE the anchor is out of the region on purpose: that is the
 *  already-answered prompt sitting above the pending one, and vetoing on it would refuse every
 *  scrollback that has ever shown a discard — including the pinned case where an allowlisted call
 *  is genuinely the latest header. This is narrower than a blanket "any denied name anywhere in the
 *  region wins", which the previous round analysed and rejected for exactly that reason. */
function pendingRegionStart(candidates: HeaderCandidate[]): number {
  let anchor = Number.NEGATIVE_INFINITY;
  for (const c of candidates) if (c.authoritative && c.at > anchor) anchor = c.at;
  return anchor;
}

function pendingRegion(candidates: HeaderCandidate[]): HeaderCandidate[] {
  const anchor = pendingRegionStart(candidates);
  return candidates.filter((c) => c.at >= anchor);
}

/** True when no `[approvals].mcp` rule of any value could auto-answer this name — the
 *  rule-independent half of {@link mcpAutoAnswerable}'s gate chain.
 *
 *  Factored out because TWO readers need exactly it: the composed verdict, and
 *  {@link mcpToolFromPrompt}, whose result feeds `approvalsRuntime`'s own deny veto — a veto that
 *  runs ahead of the category branch and is the only guard left when the classifier misfiles an MCP
 *  prompt as `bash`. The allow list keeps its precedence here: `read_console_messages` contains the
 *  deny substring `message` and must still be reported as answerable. */
function neverAutoAnswerable(name: string): boolean {
  if (isDeniedWirePrefix(name)) return true;
  if (isAutoAnswerableTool(name)) return false;
  return isDeniedTool(name);
}

export function mcpToolFromPrompt(text: string): string | null {
  if (!text) return null;
  const candidates = readHeaderCandidates(text);
  const chosen = chooseHeader(candidates);
  if (!chosen) return null;
  // A NEVER-AUTO CANDIDATE IN THE PENDING REGION IS THE NAME WE HAND BACK, even when the positional
  // pick landed elsewhere (roborev 71942). `approvalsRuntime` runs `isDeniedTool` on this string as
  // a veto INDEPENDENT of the category it guessed, so returning the stale allowlisted header for a
  // region that visibly contains a pending discard silently disarms a guard living outside this
  // module. It is still a DEMOTION-scoped rule, not the blanket "prefer the denied name" the
  // previous round rejected: outside the pending region an earlier, already-answered discard is
  // ignored exactly as before.
  const blocked = pendingRegion(candidates)
    .filter((c) => neverAutoAnswerable(c.name))
    .reduce<HeaderCandidate | null>((best, c) => (!best || c.at > best.at ? c : best), null);
  return (blocked ?? chosen).name;
}

/** True when `tool` matches the deny list. A null/blank tool is NOT reported as denied — absence of
 *  a name is handled by {@link mcpAutoAnswerable}, which refuses it for the stronger reason that
 *  nothing about it is known. */
export function isDeniedTool(tool: string | null): boolean {
  if (!tool) return false;
  // DELIBERATELY THE WIDEST SPELLING — trimmed and case-folded, but the `mcp__<server>__` prefix is
  // NOT stripped. `mcp__spawn-server__get_state` must stay denied: the verb is only in the server
  // segment, so refusing it costs one prompt, while teaching this gate to read the narrowed name
  // would hand that same reduction to an attacker. The allow gate below reads the NARROWEST
  // spelling for exactly the opposite reason. The asymmetry is the design, not an oversight — and
  // {@link isDeniedWirePrefix} is what makes it true END TO END rather than only inside this one
  // predicate.
  const t = tool.trim().toLowerCase();
  return DENIED_TOOL_PATTERNS.some((p) => t.includes(p));
}

/** True when a denied verb sits in the `mcp__<server>__` segments that {@link normalizeToolName}
 *  STRIPS before the allow list is consulted.
 *
 *  WHY THIS EXISTS AS A SEPARATE PREDICATE, AND WHY IT RUNS FIRST (roborev 70027, High). The file
 *  claimed an asymmetry — deny reads the widest spelling, allow reads the narrowest — and the
 *  claim was false end to end, because {@link mcpAutoAnswerable} consulted the allow gate BEFORE
 *  the deny gate. `mcp__spawn-server__get_state` therefore normalised to `get_state`, hit the
 *  allow list, and returned "auto" while `isDeniedTool` on the same bytes said true and was never
 *  asked. Only the isolated predicate was tested, so a green suite documented a guarantee the
 *  composed policy did not provide.
 *
 *  It is scoped to the PREFIX rather than the whole raw name on purpose. Running the deny list over
 *  the whole raw name ahead of the allow gate would refuse `read_console_messages`, a verified
 *  read-only tool that contains the deny substring `message` — the exact collision the allow list's
 *  precedence exists to resolve. The prefix is the part the allow gate throws away, so it is the
 *  part that needs its own reader. */
export function isDeniedWirePrefix(tool: string | null): boolean {
  if (!tool) return false;
  const parts = tool.trim().toLowerCase().split("__");
  // Not a wire name at all → nothing was stripped → nothing for this gate to say.
  if (parts.length < 3 || parts[0] !== "mcp") return false;
  const prefix = parts.slice(0, -1).join("__");
  return DENIED_TOOL_PATTERNS.some((p) => prefix.includes(p));
}

/** True when `tool` is on the closed allow list — matched EXACTLY, never by substring.
 *
 *  WHY AN EXACT ALLOW-LIST HIT BEATS A DENY PATTERN, which reads backwards until you see the case
 *  that forces it. `read_console_messages` is a read-only browser inspection tool and it contains
 *  the substring `message`, a deny pattern that exists to catch `send_message`. The deny list is a
 *  HEURISTIC over names; the allow list is TEN individually verified tools, each one cross-checked
 *  against `PLAN_SAFE_TOOLS` or `SPARKLE_ALLOWED_TOOLS`. Specific verified evidence outranks a
 *  substring guess, so the exact hit wins.
 *
 *  It does NOT beat a denied verb in the wire PREFIX — see {@link isDeniedWirePrefix}, which
 *  {@link mcpAutoAnswerable} runs ahead of this gate. The precedence above is about the TOOL's own
 *  name; a server segment is not a verified tool and never earned that standing.
 *
 *  This is only safe while the allow list stays exact, closed and small — a substring allow-match
 *  would let `set_agent_activity_and_spawn_worker` inherit the exemption. Both properties are pinned
 *  in mcpToolPolicy.test.ts, including a cap on the list's size so it cannot quietly grow into a
 *  general bypass. */
export function isAutoAnswerableTool(tool: string | null): boolean {
  if (!tool) return false;
  // THROUGH THE NORMALIZER, so this gate and the deny gate stop disagreeing about the same bytes.
  // This used to compare RAW while isDeniedTool folded case, so a verified read-only tool named in
  // its canonical WIRE form — the spelling SPARKLE_ALLOWED_TOOLS and the MCP wire itself use — was
  // not recognised as itself. normalizeToolName strips the prefix only from an exactly-three-segment
  // name, which is what keeps `mcp__srv__spawn_worker__set_agent_activity` OUT of this list — and
  // WIRE_HEADER above is what makes sure a four-segment name still HAS four segments by the time it
  // gets here.
  return AUTO_ANSWERABLE_TOOLS.includes(normalizeToolName(tool));
}

/** What ONE named tool would resolve to under the effective rule.
 *
 *  The rule and the lists compose as: DENY beats everything; then the allow list can auto-answer
 *  even with no rule set (this is what stops the narration prompts without asking the human to
 *  configure anything); then the ordinary `always` rule applies to whatever is left. */
function verdictForTool(
  tool: string,
  effectiveRule: "always" | "never" | undefined,
): "auto" | "ask" {
  // An explicit `never` is a HUMAN DECISION and outranks the built-in allow list, which is only a
  // convenience default for people who never opened the setting. Someone who deliberately set "ask
  // me about tool calls" and then still got them answered silently would be right to call that a
  // bug — and would have no way left to express what they wanted.
  if (effectiveRule === "never") return "ask";
  // The deny gates run AHEAD of the allow gate, because the allow gate is about to throw the wire
  // prefix away — see isDeniedWirePrefix. That ordering, and the allow list's precedence over the
  // deny SUBSTRING heuristic, both live in neverAutoAnswerable so this module has one copy of them.
  if (neverAutoAnswerable(tool)) return "ask";
  // Exact, individually verified name beats the substring heuristic — see isAutoAnswerableTool.
  if (isAutoAnswerableTool(tool)) return "auto";
  return effectiveRule === "always" ? "auto" : "ask";
}

/** What the caller should do with an MCP prompt, given the effective `[approvals].mcp` rule.
 *
 *  - `"auto"`  — answer it; the human never sees it.
 *  - `"ask"`   — surface it.
 *
 *  This is the function the runtime calls, and it is the one the tests must assert on: every
 *  finding this module has ever carried was a case where each isolated predicate answered correctly
 *  and the composed policy was walked past anyway, because the PARSER had already handed the gates
 *  the attacker's name. */
export function mcpAutoAnswerable(
  promptText: string,
  effectiveRule: "always" | "never" | undefined,
): "auto" | "ask" {
  const candidates = promptText ? readHeaderCandidates(promptText) : [];
  const chosen = chooseHeader(candidates);
  // Unreadable name → ask. Stated before everything else because it is a DIFFERENT reason: not "we
  // know this is dangerous" but "we know nothing at all", and both must end at the human.
  if (!chosen) return "ask";
  // THE INVARIANT — see {@link pendingRegion}. "auto" requires EVERY candidate that could still be
  // the pending prompt to be auto-answerable on its own, so demotion can only ever take an answer
  // from "auto" to "ask" and never the reverse. Without this, one unbalanced `(` between an
  // already-answered allowlisted header and the pending denied one demoted ONLY the pending header,
  // and the stale allowlisted name auto-approved a discard (roborev 71942, High) — a REGRESSION the
  // paired-continuation tests could not see, because they only ever placed the demoted token AFTER
  // the real header of the SAME call.
  for (const c of pendingRegion(candidates)) {
    if (verdictForTool(c.name, effectiveRule) === "ask") return "ask";
  }
  return verdictForTool(chosen.name, effectiveRule);
}
