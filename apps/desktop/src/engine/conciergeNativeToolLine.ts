// What the concierge is doing when it is NOT driving this app — the plain-Claude-Code half of the
// thinking indicator's vocabulary.
//
// ══ THE GAP THIS FILLS ══════════════════════════════════════════════════════════════════════════
// `conciergeActivityLine` (read it first — this module is its sibling and copies its discipline)
// describes the ~13 `concierge_tool` control-domain calls, and those are the minority of a turn. The
// concierge spends most of its time on ordinary Claude Code tools: `Bash` shelling out to git, gh,
// bd and the test suite; `Read`, `Grep`, `Glob`; a `Task` subagent; a `WebFetch`. None of that was
// sayable, so the column fell back to three animated dots — and three dots look identical whether
// the brain is twenty seconds into a `pnpm test` or wedged. The founder's complaint is precisely
// that: dots cannot distinguish a working concierge from a dead one.
//
// The founder asked for this vocabulary, in these words:
//
//     Reading your message / Checking the fleet / Reading <Agent>'s terminal / Searching the code /
//     Checking git / Checking pull requests / Filing a bead / Starting <Agent> / Sending to <Agent> /
//     Thinking / Composing
//
// — and said to name the subject wherever one exists. The agent-named entries in that list are
// already produced by the control path with resolved names and clickable pills; this module owns
// the rest.
//
// ══ WHY `mcp__*` RETURNS NULL — THE MOST IMPORTANT RULE HERE ════════════════════════════════════
// The concierge's control calls arrive over MCP as `mcp__sparkle-control__*`, and they ALSO arrive
// on the control path (services/controlListener → services/conciergeTools/registry →
// conciergeActivityLine), which is where they are phrased. Describing them here as well would do two
// bad things at once: double-record one call as two activities, and let a generic sentence
// ("Using sparkle_terminal") race the rich one ("Reading Kraken Auth's terminal", with a live pill
// the reader can click). So every `mcp__*` name is declined outright — the ones we own are already
// covered, and the ones we do not own are not ours to narrate.
//
// ══ WHY A PATH NEVER APPEARS IN A PHRASE ════════════════════════════════════════════════════════
// This column is 360px wide and it is a SHARED SURFACE — whatever it says is on screen next to the
// human's own conversation. A filesystem path leaked into a concierge surface once already and had
// to be stripped out (see `buildDisplay` in components/composer/attachments). A path is also not a
// name a reader recognises at a glance, so it costs the width and buys nothing. Phrases here name
// the KIND of thing ("Reading a file"), never the thing itself — no home directory, no env var, no
// token, no URL, and no echo of the raw command.
//
// ══ WHY THE INPUT MAY NOT PARSE ═════════════════════════════════════════════════════════════════
// `input` is a compact JSON serialization of the call's arguments CLAMPED at 512 chars, so a long
// `Bash` command arrives with its tail cut off mid-string: valid-looking, and not valid JSON. Every
// read of it is guarded, and a read that fails degrades to the tool's generic phrase. A throw on
// this path would take out the status line for the whole turn — the failure would look exactly like
// the wedged concierge this feature exists to rule out.
//
// DOM-free and store-free, like every other policy module in this directory. It decides WHAT to call
// a call; the store records and the component paints.
import type { ConciergeActivityIcon } from "./conciergeActivityLine";

/** One Claude Code tool call, as the frontend receives it.
 *
 *  `input` is a compact JSON serialization of the call's arguments, CLAMPED at 512 chars — so it may
 *  be TRUNCATED and therefore NOT valid JSON. Never `JSON.parse` it without guarding. */
export interface ConciergeNativeTool {
  name: string;
  input: string;
}

/** The two tenses of one call, plus its glyph family.
 *
 *  TWO TENSES, ALWAYS — the same rule `conciergeActivityLine` enforces, for the same reason: the
 *  column shows a line while the call is in flight and again once it settled. One present-tense
 *  phrase would leave it claiming to be doing something it finished seconds ago, which is the exact
 *  dishonesty this feature exists to remove. */
export interface ConciergeNativeLine {
  icon: ConciergeActivityIcon;
  /** In flight: "Checking git". */
  present: string;
  /** Settled: "Checked git". */
  past: string;
}

function line(icon: ConciergeActivityIcon, present: string, past: string): ConciergeNativeLine {
  return { icon, present, past };
}

// ── The shared phrases ──────────────────────────────────────────────────────────────────────────
// Named constants rather than repeated literals, because several tools and several `Bash` verbs land
// on the SAME sentence and must land on the same GLYPH too. A reader who sees "Searching the code"
// wearing two different icons on two consecutive lines reads it as two different activities.
const SEARCH_CODE = line("workspace", "Searching the code", "Searched the code");
const RUN_COMMAND = line("terminal", "Running a command", "Ran a command");
const CHECK_GIT = line("workflow", "Checking git", "Checked git");
const CHECK_PRS = line("workflow", "Checking pull requests", "Checked pull requests");
const SWITCH_BRANCH = line("workflow", "Switching branches", "Switched branches");

/**
 * Tool name → its line. The whole vocabulary in one table, so a reader sees it at a glance and
 * adding an entry is one line rather than a new branch in a chain of ifs.
 *
 * `Bash` is in here for its GENERIC phrase only — the honest thing to say when its command cannot be
 * read or its verb is not one we recognise. When the verb IS recognised, {@link BASH_RULES} below
 * refines it.
 *
 * Exported because the tests sweep the entire table for the invariants that matter across it
 * (both tenses present, both non-empty, no path or `~` anywhere in either), which is not something
 * that can be asserted case by case without an entry added later slipping past.
 */
export const CONCIERGE_NATIVE_TOOL_LINES: Readonly<Record<string, ConciergeNativeLine>> = {
  Bash: RUN_COMMAND,
  Grep: SEARCH_CODE,
  Glob: SEARCH_CODE,
  // NEVER the path — see the header. "a file" is what the reader can act on anyway.
  Read: line("workspace", "Reading a file", "Read a file"),
  Edit: line("workspace", "Writing a file", "Wrote a file"),
  MultiEdit: line("workspace", "Writing a file", "Wrote a file"),
  Write: line("workspace", "Writing a file", "Wrote a file"),
  NotebookEdit: line("workspace", "Writing a file", "Wrote a file"),
  // The agents glyph: a subagent IS an agent, even though it is not one of the fleet's rows.
  Task: line("agents", "Researching in the background", "Researched in the background"),
  Agent: line("agents", "Researching in the background", "Researched in the background"),
  // "a page", not the URL. A URL is a path by another name and carries query strings with it.
  WebFetch: line("workspace", "Reading a page", "Read a page"),
  WebSearch: line("workspace", "Searching the web", "Searched the web"),
  TodoWrite: line("workspace", "Planning", "Planned"),
  TaskCreate: line("workspace", "Planning", "Planned"),
  TaskUpdate: line("workspace", "Planning", "Planned"),
  ToolSearch: line("workspace", "Looking up a tool", "Looked up a tool"),
};

/**
 * The same table as a Map, which is what the lookup actually uses.
 *
 * NOT a micro-optimisation — a correctness fix (roborev 57847). `TABLE[name]` with a caller-supplied
 * key reaches the prototype chain, so a tool named `toString`, `valueOf`, `constructor` or
 * `hasOwnProperty` returns a FUNCTION that passes the truthiness check and is handed back as if it
 * were a line. The consumer then reads `line.present` as undefined and `line.present.trim()` throws
 * — breaking both of this module's stated contracts at once (the name is untrusted; nothing here can
 * throw) and skipping the `Using <name>` fallback that is the honest answer.
 */
const TOOL_LINE_BY_NAME = new Map<string, ConciergeNativeLine>(
  Object.entries(CONCIERGE_NATIVE_TOOL_LINES),
);

/**
 * One `Bash` verb and what to call it.
 *
 * `argv` is matched as a TOKEN PREFIX of the sniffed command — whole tokens, never a substring, so
 * a path that merely contains "git" (`/home/x/gitlab/run.sh`) cannot read as git. Longest `argv`
 * wins, so the table can be authored in any order and `git push` cannot be shadowed by `git`.
 */
interface BashRule {
  argv: readonly string[];
  line: ConciergeNativeLine;
}

/**
 * The `Bash` vocabulary — where most of the value in this module is, because most of what the
 * concierge does it does by shelling out.
 *
 * Exported for the same reason the table above is: the invariant sweep in the tests drives every
 * rule through the real function rather than trusting a hand-written list to stay in step.
 */
export const BASH_RULES: readonly BashRule[] = [
  // Grouped by the program, GENERAL CASE FIRST — which is the readable order and is also what makes
  // the longest-first sort below load-bearing rather than decorative. Authored the other way round
  // (`git push` above `git`) the sort could be deleted with every test still green, and the next
  // person to add a rule in reading order would silently lose it.
  //
  // ══ WHY EVERY MUTATING SUBCOMMAND GETS ITS OWN RULE (roborev 57847) ═══════════════════════════
  // A catch-all that reads "Checking git" is true for the read subcommands and a CONFIDENT WRONG
  // CLAIM for the ones that change something. "Checked pull requests" while the concierge merged one
  // is worse than the generic phrase, not better: a vague true sentence costs the reader nothing,
  // and a specific false one is exactly the dishonesty this module exists to remove. So each
  // program's catch-all is kept — it is right for the reads, which are the overwhelming majority —
  // and every write verb the concierge actually uses is named.
  //
  // RESIDUAL, stated rather than papered over: a write verb NOT in this table still falls to its
  // program's catch-all (`git worktree add` reads as "Checking git"). Adding a rule is one line;
  // the alternative — allow-listing the reads and sending everything else to "Running a command" —
  // would demote the common case to say less about the rare one.
  { argv: ["git"], line: CHECK_GIT },
  { argv: ["git", "push"], line: line("workflow", "Pushing to the remote", "Pushed to the remote") },
  { argv: ["git", "commit"], line: line("workflow", "Committing", "Committed") },
  { argv: ["git", "add"], line: line("workflow", "Staging changes", "Staged changes") },
  { argv: ["git", "rebase"], line: line("workflow", "Rebasing", "Rebased") },
  { argv: ["git", "merge"], line: line("workflow", "Merging a branch", "Merged a branch") },
  { argv: ["git", "reset"], line: line("workflow", "Resetting the branch", "Reset the branch") },
  { argv: ["git", "checkout"], line: SWITCH_BRANCH },
  { argv: ["git", "switch"], line: SWITCH_BRANCH },
  // No bare `gh` rule on purpose: `gh auth status` is not about pull requests, and saying it was
  // would be the confident guess the honest generic already covers.
  { argv: ["gh", "pr"], line: CHECK_PRS },
  { argv: ["gh", "run"], line: CHECK_PRS },
  { argv: ["gh", "api"], line: CHECK_PRS },
  // Phrased to match WORKFLOW_PHRASES.open_agent_pr / merge_pr in conciergeActivityLine, so the same
  // act reads the same way whether the concierge did it through the control path or through gh.
  {
    argv: ["gh", "pr", "create"],
    line: line("workflow", "Opening a pull request", "Opened a pull request"),
  },
  {
    argv: ["gh", "pr", "merge"],
    line: line("workflow", "Merging a pull request", "Merged a pull request"),
  },
  // "a bead" is the founder's own word for it, and it is what the board calls these.
  { argv: ["bd"], line: line("workspace", "Reading your task list", "Read your task list") },
  { argv: ["bd", "create"], line: line("workspace", "Filing a bead", "Filed a bead") },
  // Matches BOARD_PHRASES.update_item; `bd close` is the reversible status change AGENTS.md tells
  // agents to prefer over `bd delete`, and it is a write either way.
  { argv: ["bd", "close"], line: line("workspace", "Closing a task", "Closed a task") },
  { argv: ["bd", "update"], line: line("workspace", "Updating a task", "Updated a task") },
  { argv: ["bd", "delete"], line: line("workspace", "Deleting a task", "Deleted a task") },
  // "code review", not "roborev": the reader cares that the code was reviewed, not which daemon did
  // it. Matches REVIEW_PHRASES.list_findings in conciergeActivityLine, deliberately.
  {
    argv: ["roborev"],
    line: line("workflow", "Checking code review findings", "Checked code review findings"),
  },
  { argv: ["vitest"], line: line("terminal", "Running the tests", "Ran the tests") },
  { argv: ["npx", "vitest"], line: line("terminal", "Running the tests", "Ran the tests") },
  { argv: ["pnpm", "test"], line: line("terminal", "Running the tests", "Ran the tests") },
  { argv: ["pnpm", "vitest"], line: line("terminal", "Running the tests", "Ran the tests") },
  { argv: ["npm", "test"], line: line("terminal", "Running the tests", "Ran the tests") },
  { argv: ["yarn", "test"], line: line("terminal", "Running the tests", "Ran the tests") },
  { argv: ["cargo", "test"], line: line("terminal", "Running the tests", "Ran the tests") },
  { argv: ["tsc"], line: line("terminal", "Building", "Built") },
  { argv: ["pnpm", "build"], line: line("terminal", "Building", "Built") },
  { argv: ["pnpm", "tsc"], line: line("terminal", "Building", "Built") },
  { argv: ["npm", "run", "build"], line: line("terminal", "Building", "Built") },
  { argv: ["cargo", "build"], line: line("terminal", "Building", "Built") },
  { argv: ["rg"], line: SEARCH_CODE },
  { argv: ["grep"], line: SEARCH_CODE },
  { argv: ["find"], line: SEARCH_CODE },
];

/** Longest-first, computed once, so {@link BASH_RULES} can be authored in reading order — general
 *  case first — without a two-token rule being shadowed by the one-token rule above it. */
const BASH_RULES_BY_SPECIFICITY = [...BASH_RULES].sort((a, b) => b.argv.length - a.argv.length);

/** Wrappers that stand in FRONT of the real verb and say nothing about it.
 *
 *  `sudo cargo test` is a test run; `env FOO=1 rg x` is a search. Stripping these is what lets the
 *  table stay a table — the alternative is a rule per wrapper per verb. */
const COMMAND_PREFIXES = new Set(["sudo", "env", "nohup", "command", "exec", "time", "builtin"]);

/** `FOO=bar cmd` — a leading assignment, not a verb. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `300`, `5s`, `2m` — the duration argument a timeout wrapper eats before the real command. */
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/** This repo has no GNU `timeout(1)`, so slow commands are wrapped in `scripts/timeout.sh <dur>`
 *  (see AGENTS.md). Unstripped, every wrapped test run would read as the generic "Running a
 *  command" — which is exactly the long call the column most needs to name. */
function isTimeoutWrapper(token: string): boolean {
  return token === "timeout" || token === "gtimeout" || token.endsWith("timeout.sh");
}

/**
 * Read one string argument out of a possibly-TRUNCATED JSON blob.
 *
 * The happy path is `JSON.parse`, guarded. The fallback is the point: `input` is clamped at 512
 * chars, so a long `Bash` command routinely arrives cut off mid-string and `JSON.parse` throws on
 * something whose LEADING bytes — the argv we actually want — are perfectly intact. Scanning for the
 * key and reading forward recovers the verb from a blob that cannot be parsed.
 *
 * This is not guessing (rule 3): it reads the argument that was really sent, and everything
 * downstream degrades to the generic phrase when the tokens are not recognised. It never throws.
 */
function readStringArg(input: unknown, key: string): string | null {
  if (typeof input !== "string" || !input) return null;
  try {
    const parsed: unknown = JSON.parse(input);
    if (parsed && typeof parsed === "object") {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
    return null;
  } catch {
    // Truncated. Recover the prefix by hand.
  }
  const marker = new RegExp(`"${key}"\\s*:\\s*"`).exec(input);
  if (!marker) return null;
  let out = "";
  for (let i = marker.index + marker[0].length; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "\\") {
      const next = input[i + 1];
      if (next === undefined) break;
      out += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i += 1;
      continue;
    }
    if (ch === '"') break;
    out += ch;
  }
  return out || null;
}

/**
 * The leading argv of a shell command, with everything that is not the verb peeled off the front.
 *
 * ROBUSTNESS IS THE WHOLE JOB HERE. Real concierge commands look like
 * `cd /some/path && git status`, `FOO=1 gh pr list`, `sudo cargo test`,
 * `scripts/timeout.sh 300 pnpm test` — and a sniffer that reads the first whitespace-delimited token
 * calls every one of them "a command". Equally, a sniffer that searches for "git" anywhere in the
 * string calls `/home/x/gitlab/run.sh` a git command, which is rule 3's failure: a confident guess
 * where the honest generic was available.
 *
 * Returns [] for anything unreadable, which the caller renders as the generic phrase.
 */
function sniffArgv(command: string | null): string[] {
  if (!command) return [];
  // Split on the shell's sequencing operators. A `&&` inside a quoted argument splits wrongly here
  // — and harmlessly: the worst case is an unrecognised verb, i.e. the generic phrase.
  const segments = command.split(/\s*(?:\|\||&&|;|\||\n)\s*/);
  for (const segment of segments) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    for (let token = tokens[i]; token !== undefined; token = tokens[i]) {
      if (ENV_ASSIGNMENT.test(token) || COMMAND_PREFIXES.has(token)) {
        i += 1;
        continue;
      }
      if (isTimeoutWrapper(token)) {
        i += 1;
        // The wrapper's own flags and its duration, then the real command begins.
        for (let next = tokens[i]; next !== undefined; next = tokens[i]) {
          if (!next.startsWith("-") && !DURATION.test(next)) break;
          i += 1;
        }
        continue;
      }
      // `sudo -E cargo test`: the wrapper is gone, its flags are not.
      if (token.startsWith("-")) {
        i += 1;
        continue;
      }
      break;
    }
    const rest = tokens.slice(i);
    // A `cd` segment is scaffolding for the segment after it, not the thing that ran.
    if (!rest.length || rest[0] === "cd") continue;
    return rest;
  }
  return [];
}

function matchBashRule(argv: readonly string[]): ConciergeNativeLine | null {
  if (!argv.length) return null;
  for (const rule of BASH_RULES_BY_SPECIFICITY) {
    // A rule longer than the command falls out of this comparison on its own: the out-of-range
    // token is `undefined` and no rule token equals that. No length guard needed — and one was
    // removed from here because it could be deleted with every test still green, which is the
    // definition of a line that does nothing.
    if (rule.argv.every((token, i) => token === argv[i])) return rule.line;
  }
  return null;
}

/** Tool names are identifiers, but this string is rendered, so it is treated as untrusted: anything
 *  outside a plain identifier alphabet is dropped and the result is clamped. That is what keeps the
 *  "no path ever reaches the column" invariant true even for a name nobody anticipated. */
function safeToolName(name: string): string {
  return name.replace(/[^A-Za-z0-9_. -]/g, "").slice(0, 40).trim();
}

/**
 * The line for one native tool call, or null when there is nothing honest to say.
 *
 * Null happens in exactly two cases, both deliberate:
 *
 *  1. ANY `mcp__*` tool. The `mcp__sparkle-control__*` ones are already described, better, by the
 *     control path — see the header; reporting them twice would both double-count the call and let
 *     a generic sentence replace a named one with a clickable pill. Other `mcp__*` servers are not
 *     ours to narrate, and inventing a sentence for one would be a guess.
 *  2. A tool whose name is empty or reduces to nothing once sanitised — there is no fact left to
 *     report, and the indicator's plain pulse is the honest rendering of "we don't know".
 *
 * An UNRECOGNISED ordinary tool is different, and deliberately still rendered: its name is a fact,
 * so it is shown verbatim ("Using Foo" / "Used Foo") rather than dressed in a sentence this module
 * made up. That is the same choice `conciergeActivityLine` makes for an un-phrased op, for the same
 * reason — informative, and visibly un-polished so somebody writes it a real phrase.
 */
export function conciergeNativeToolLine(tool: ConciergeNativeTool): ConciergeNativeLine | null {
  const rawName = typeof tool?.name === "string" ? tool.name : "";
  if (rawName.toLowerCase().startsWith("mcp__")) return null;

  if (rawName === "Bash") {
    // Sniffed from the command that ACTUALLY RAN. An unreadable or unrecognised one falls to the
    // generic — never to a confident guess.
    const sniffed = matchBashRule(sniffArgv(readStringArg(tool.input, "command")));
    return sniffed ?? RUN_COMMAND;
  }

  const known = TOOL_LINE_BY_NAME.get(rawName);
  if (known) return known;

  const name = safeToolName(rawName);
  if (!name) return null;
  return line("terminal", `Using ${name}`, `Used ${name}`);
}
