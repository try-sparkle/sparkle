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

/** The bare tool name from an MCP permission prompt, or null when it cannot be read.
 *
 *  Two shapes reach us and BOTH must work, because they come from different renderers:
 *    • the wire/allowlist form `mcp__sparkle-control__set_agent_activity`, and
 *    • the picker's display form `sparkle-control - set_agent_activity`, which is what the founder
 *      actually saw on screen.
 *  Anything else returns null, which the caller must treat as "ask the human". */
export function mcpToolFromPrompt(text: string): string | null {
  if (!text) return null;
  // LAST match, not first — and this is a security property, not a preference (roborev 61990, High).
  //
  // Callers must pass the picker's header region, but defence in depth belongs here too, because
  // the consequence of getting it wrong is the worst outcome this module has: a scrollback holding
  // an earlier, already-answered `set_agent_activity(…)` above a PENDING
  // `sparkle_lifecycle(op: "discard_agent")` parsed as the allowlisted tool under first-match, and
  // the discard was auto-approved. Verified against the real code before this line changed. The
  // prompt being decided is always the LAST one on screen, so that is the one to read.
  const lastMatch = (re: RegExp): string | null => {
    let found: string | null = null;
    for (const m of text.matchAll(re)) if (m[1]) found = m[1];
    return found;
  };
  // Wire form first: it is unambiguous, so a prompt containing it is never re-read as display form.
  const wire = lastMatch(/mcp__[A-Za-z0-9_.-]+__([A-Za-z0-9_]+)/g);
  if (wire) return wire;
  // Display form: "<server> - <tool>(args…)". The server segment may contain dashes
  // (sparkle-control), so anchor on the SPACED separator rather than splitting on "-".
  //
  // The trailing "(" is load-bearing, not decoration. Without it this pattern matches ordinary
  // English containing a spaced dash, and every such match becomes a tool name that the deny veto
  // then reasons about. Requiring the open paren keys on how the picker actually renders a tool
  // invocation, which is the thing we are trying to recognise.
  return lastMatch(/\b[A-Za-z0-9_.-]+\s+-\s+([A-Za-z0-9_]+)\s*\(/g);
}

/** True when `tool` matches the deny list. A null/blank tool is NOT reported as denied — absence of
 *  a name is handled by {@link mcpAutoAnswerable}, which refuses it for the stronger reason that
 *  nothing about it is known. */
export function isDeniedTool(tool: string | null): boolean {
  if (!tool) return false;
  const t = tool.toLowerCase();
  return DENIED_TOOL_PATTERNS.some((p) => t.includes(p));
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
 *  This is only safe while the allow list stays exact, closed and small — a substring allow-match
 *  would let `set_agent_activity_and_spawn_worker` inherit the exemption. Both properties are pinned
 *  in mcpToolPolicy.test.ts, including a cap on the list's size so it cannot quietly grow into a
 *  general bypass. */
export function isAutoAnswerableTool(tool: string | null): boolean {
  if (!tool) return false;
  return AUTO_ANSWERABLE_TOOLS.includes(tool);
}

/** What the caller should do with an MCP prompt, given the effective `[approvals].mcp` rule.
 *
 *  - `"auto"`  — answer it; the human never sees it.
 *  - `"ask"`   — surface it.
 *
 *  The rule and the lists compose as: DENY beats everything; then the allow list can auto-answer
 *  even with no rule set (this is what stops the narration prompts without asking the human to
 *  configure anything); then the ordinary `always` rule applies to whatever is left. */
export function mcpAutoAnswerable(
  promptText: string,
  effectiveRule: "always" | "never" | undefined,
): "auto" | "ask" {
  const tool = mcpToolFromPrompt(promptText);
  // Unreadable name → ask. Stated before everything else because it is a DIFFERENT reason: not "we
  // know this is dangerous" but "we know nothing at all", and both must end at the human.
  if (!tool) return "ask";
  // An explicit `never` is a HUMAN DECISION and outranks the built-in allow list, which is only a
  // convenience default for people who never opened the setting. Someone who deliberately set "ask
  // me about tool calls" and then still got them answered silently would be right to call that a
  // bug — and would have no way left to express what they wanted.
  if (effectiveRule === "never") return "ask";
  // Exact, individually verified name beats the substring heuristic — see isAutoAnswerableTool.
  if (isAutoAnswerableTool(tool)) return "auto";
  if (isDeniedTool(tool)) return "ask";
  return effectiveRule === "always" ? "auto" : "ask";
}
