/**
 * THE DELEGATION LEDGER — one durable row per act of delegating, written AT SPAWN.
 *
 * ── THE FAILURE THIS EXISTS TO FIX (measured, 2026-08-22) ────────────────────────────────────────
 * The founder asked the concierge about making preview cards inline / one-third width in chat. It
 * answered as if it had never heard of the work and dispatched fresh research — EIGHT MINUTES after
 * it had itself spawned agent `8f590b78…` ("Sparkle Preview Card Inline") to do exactly that. His
 * words: *"you should definitely be able to remember the work that you dispatched out to agents."*
 *
 * The diagnosis is narrower than "the concierge has no memory". It HAS a durable memory
 * (`sparkle_memory`, 42 facts at the time of writing) and that memory worked. Every one of those 42
 * facts was a fact ABOUT THE WORLD, and not one recorded an act of delegation — because DISPATCH WAS
 * NOT A REMEMBERED CATEGORY. The only record of a spawn was the concierge's own context window, and
 * when that rolled the delegation vanished while the agent it created kept running.
 *
 * ── WHY THIS IS AUTOMATIC AND NOT A THING THE CONCIERGE REMEMBERS TO DO ──────────────────────────
 * The founder's instruction, and it is correct: *"anything that depends on the concierge choosing to
 * save it will fail exactly when the concierge is busy — which is precisely when it is spawning
 * agents."* So the write lives at the SPAWN SITES, not in a tool the model may or may not call, and
 * the model cannot opt out of it. It is also why the write sites are the shared helpers rather than
 * the concierge's tool wrappers: the human's own "+ New Build Agent" button and the Plan board's
 * "Start" both create delegations the founder will later ask about, and neither passes through a
 * concierge tool at all.
 *
 * ── WHY NOT `sparkle_memory`, WHICH ALREADY EXISTS ───────────────────────────────────────────────
 * Measured against the live store, it is the wrong tenant for a GROWING list:
 *   • `shapeMemories` sorts by key and slices to `MAX_RECALL_MEMORIES = 25` — an ALPHABETICAL cut,
 *     so 17 of the founder's 42 facts (40%) never reach the prompt at all, `oauth-token-p0-blocker`
 *     among them. Delegations arrive forever; they would spend most of their life past that slice.
 *   • Every folded value is clipped to `MAX_MEMORY_VALUE_CHARS = 300`. The concierge's own manual
 *     stopgap after the incident — a `dispatch-log-…` memory — is 3,168 chars, so the 300 visible
 *     characters are its apology and not one agent name.
 * `history.db` already holds every dispatch brief, verbatim, in an FTS5 index, keyed by agent id and
 * time. The ledger is that substrate with a retention tier that does not delete it at 24h.
 *
 * ── WHAT A ROW MAY CONTAIN, AND THIS IS THE LOAD-BEARING RULE ────────────────────────────────────
 * ONLY WHAT WAS TRUE AT DISPATCH: the ask, the brief, the time, the ids. Nothing that can change
 * afterwards — no status, no "still running", no branch, no PR. Those are DERIVED at read time by
 * services/dispatchRecall.ts.
 *
 * That is not fastidiousness. The bug class this whole feature exists inside is STATE STAMPED ONCE
 * AND NEVER RE-DERIVED, and a ledger that stamped a status would be a fresh instance of the very
 * pattern it was built to fix — a record that is right for a minute and quietly wrong forever after.
 * Even the NAME obeys it: three agents have been observed simultaneously named "Worker 13"
 * (`13d6c218`, `a9d39862`, `fc882a27`), so a stamped name identifies nobody. `agentId` is the handle;
 * the name in the row is a historical fact, reported alongside the live one so a rename is VISIBLE
 * rather than silently papered over.
 */
import { recordHistory, type HistoryEntry } from "./history";
import { log } from "../logger";

/**
 * WHICH KIND of delegation this was. Persisted inside the row text, so members are only ever ADDED —
 * an old row carrying a channel a new build does not know falls back to `unknown` in the parser
 * rather than making the row unreadable.
 *
 * `plan` is the Plan board's "Start"/"Build It" hand-off (services/sendToBuild), which reaches
 * `projectStore.addAgent` directly and never passes through `spawnBuildAgentInProject` — so it needs
 * its own write site and is genuinely a different provenance, not a synonym for `build`.
 */
export const DISPATCH_CHANNELS = ["build", "cloud-build", "research", "plan"] as const;
export type DispatchChannel = (typeof DISPATCH_CHANNELS)[number] | "unknown";

/** Who pulled the trigger. Reported because "did I ask for this?" and "did the machine start it on a
 *  timer?" are different questions, and the founder asks both. */
export const DISPATCH_ACTORS = ["concierge", "human", "machine"] as const;
export type DispatchActor = (typeof DISPATCH_ACTORS)[number] | "unknown";

/**
 * The first line of every row. FTS5 tokenizes on non-alphanumerics, so this is one indexed term —
 * which is what lets a future reader find the whole ledger with a single query even if the `source`
 * column were ever lost in a migration. It is belt AND braces: the authoritative narrowing is
 * `source = 'dispatch'`, applied in SQL (services/history.ts `HistorySearchOpts.sources`).
 */
export const DISPATCH_MARKER = "DISPATCH";

/**
 * How much of the brief the row keeps.
 *
 * Long enough that the SUBJECT is always inside it — the recall path matches on subject, and the
 * founder says "the inline preview work", not an agent id — and short enough that 20,000 rows
 * (`DISPATCH_HISTORY_MAX`) is a few tens of MB rather than a few hundred. Briefs longer than this
 * are truncated with an explicit marker, never silently: a brief that merely STOPS reads as the
 * whole ask, and acting on half an ask is worse than knowing you have half of one.
 */
export const DISPATCH_BRIEF_CHARS = 1500;

/** Same bound for the ASK, which is a sentence or two of the founder's own words, not a brief. */
export const DISPATCH_ASK_CHARS = 600;

export interface DispatchRecord {
  /** The id of the thing this delegation created — an agent id, or a research task id. THE handle:
   *  it is the only field that is still true after a rename, a retirement or a restart. */
  targetId: string;
  channel: Exclude<DispatchChannel, "unknown">;
  /** The name at dispatch. A HISTORICAL FACT, not a handle — see the header. */
  nameAtDispatch?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  /** The brief the target was actually given. Empty for an unbriefed spawn ("+ New Build Agent"),
   *  which is a real and deliberate state — the row still gets written, because "we opened an empty
   *  agent for that project" is an answer to "did we ever start on this". */
  brief?: string | null;
  /** The founder's own words that prompted this, when the caller has them. The concierge does; the
   *  "+ New Build Agent" button does not, and passes nothing rather than inventing one. */
  ask?: string | null;
  /** Bead / epic ids this delegation serves. */
  beads?: readonly string[];
  mode?: "plan" | "build" | null;
  by: Exclude<DispatchActor, "unknown">;
  /** Epoch ms. Injectable for tests; defaults to now. */
  atMs?: number;
  /** Injectable for tests; defaults to `crypto.randomUUID()`. */
  id?: string;
}

/** One parsed row. Everything here is a FACT AT DISPATCH — see the header for what is deliberately
 *  absent. `services/dispatchRecall.ts` is what joins this to live state. */
export interface ParsedDispatch {
  targetId: string;
  channel: DispatchChannel;
  nameAtDispatch: string | null;
  projectId: string | null;
  projectName: string | null;
  brief: string;
  briefTruncated: boolean;
  ask: string | null;
  beads: string[];
  mode: "plan" | "build" | null;
  by: DispatchActor;
  atMs: number;
}

const TRUNCATION_MARK = "… [brief truncated in the ledger]";

/** Collapse newlines out of a one-line field so the row's line structure survives the value. A
 *  literal newline inside `ASK:` would otherwise make the rest of the ask parse as a new field. */
function oneLine(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

function clip(v: string, max: number): { text: string; truncated: boolean } {
  if (v.length <= max) return { text: v, truncated: false };
  return { text: `${v.slice(0, max).trimEnd()}${TRUNCATION_MARK}`, truncated: true };
}

/**
 * Render one row's text. PURE, and exported so the format is testable without a database.
 *
 * The format is prose-with-prefixes rather than JSON on purpose. This text IS the FTS5 document —
 * it is what "preview cards" has to match — and a JSON blob buries the searchable words among keys
 * and punctuation that the tokenizer then indexes as noise. It is also what a human sees if they
 * ever open the row in the history search UI, and `{"targetId":"8f59…"}` is not that.
 *
 * The brief goes LAST because it is the only unbounded field: every structured field is above it, so
 * a parser reading line-by-line has them all before it reaches free text, and the brief may then
 * contain anything at all — including lines that look like field prefixes — without confusing it.
 */
export function formatDispatchText(rec: DispatchRecord): string {
  const at = rec.atMs ?? Date.now();
  const name = rec.nameAtDispatch?.trim() || "(unnamed at dispatch)";
  const meta = [
    `target ${rec.targetId}`,
    `channel ${rec.channel}`,
    `by ${rec.by}`,
    rec.mode ? `mode ${rec.mode}` : null,
    rec.projectId ? `project ${rec.projectId}` : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");
  const lines = [`${DISPATCH_MARKER} — ${oneLine(name)}`, meta];
  if (rec.projectName?.trim()) lines.push(`PROJECT: ${oneLine(rec.projectName)}`);
  if (rec.beads && rec.beads.length > 0) lines.push(`BEADS: ${rec.beads.join(" ")}`);
  lines.push(`AT: ${new Date(at).toISOString()}`);
  if (rec.ask?.trim()) lines.push(`ASK: ${clip(oneLine(rec.ask), DISPATCH_ASK_CHARS).text}`);
  // Always emitted, even empty — its ABSENCE would be indistinguishable from an old row written
  // before the field existed, and "we opened an empty agent" is a different answer from "we don't
  // know what it was asked".
  lines.push(`BRIEF: ${clip((rec.brief ?? "").trim(), DISPATCH_BRIEF_CHARS).text}`);
  return lines.join("\n");
}

function fieldAfter(line: string, prefix: string): string | null {
  return line.startsWith(prefix) ? line.slice(prefix.length).trim() : null;
}

function asChannel(v: string): DispatchChannel {
  return (DISPATCH_CHANNELS as readonly string[]).includes(v) ? (v as DispatchChannel) : "unknown";
}

function asActor(v: string): DispatchActor {
  return (DISPATCH_ACTORS as readonly string[]).includes(v) ? (v as DispatchActor) : "unknown";
}

/**
 * Read one row's text back. Returns `null` only when the text is not a dispatch row at all.
 *
 * FORGIVING BY CONSTRUCTION, and that is a retention decision rather than a style one. These rows
 * are kept for a year and read by builds written after them, so a row carrying a field this build
 * does not recognise, or missing one it expects, must still yield everything it CAN — the id, the
 * time and the ask. An all-or-nothing parser here would silently empty the ledger the first time
 * the format grew a line, which is precisely the "the feature never once ran" failure AGENTS.md
 * records for the Rust/TS wire contract (bead sparkle-16y6h).
 *
 * `atMs` falls back to the row's own `created_at`, which the caller passes in: the `AT:` line is a
 * convenience for a human reading the text, and the column is the authority.
 */
export function parseDispatchText(text: string, createdAtMs: number): ParsedDispatch | null {
  if (!text.startsWith(`${DISPATCH_MARKER} — `) && !text.startsWith(`${DISPATCH_MARKER} `)) {
    return null;
  }
  const lines = text.split("\n");
  const headline = lines[0] ?? "";
  const rawName = headline.slice(headline.indexOf("—") + 1).trim();
  const out: ParsedDispatch = {
    targetId: "",
    channel: "unknown",
    nameAtDispatch: rawName && rawName !== "(unnamed at dispatch)" ? rawName : null,
    projectId: null,
    projectName: null,
    brief: "",
    briefTruncated: false,
    ask: null,
    beads: [],
    mode: null,
    by: "unknown",
    atMs: createdAtMs,
  };
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // The brief is the LAST field and is free text, so everything from here to the end belongs to
    // it — including any line that happens to look like a prefix. Stop scanning.
    const brief = fieldAfter(line, "BRIEF:");
    if (brief !== null) {
      const rest = [brief, ...lines.slice(i + 1)].join("\n");
      out.briefTruncated = rest.endsWith(TRUNCATION_MARK);
      out.brief = out.briefTruncated ? rest.slice(0, -TRUNCATION_MARK.length) : rest;
      break;
    }
    const ask = fieldAfter(line, "ASK:");
    if (ask !== null) {
      out.ask = ask || null;
      continue;
    }
    const project = fieldAfter(line, "PROJECT:");
    if (project !== null) {
      out.projectName = project || null;
      continue;
    }
    const beads = fieldAfter(line, "BEADS:");
    if (beads !== null) {
      out.beads = beads.split(/\s+/).filter(Boolean);
      continue;
    }
    if (fieldAfter(line, "AT:") !== null) continue;
    // The meta line: ` · `-joined `key value` pairs. Parsed by scanning for the keys rather than by
    // position, so adding a pair never shifts the meaning of the others.
    for (const part of line.split("·")) {
      const [key, ...rest] = part.trim().split(/\s+/);
      const value = rest.join(" ");
      if (!value) continue;
      if (key === "target") out.targetId = value;
      else if (key === "channel") out.channel = asChannel(value);
      else if (key === "by") out.by = asActor(value);
      else if (key === "mode") out.mode = value === "plan" || value === "build" ? value : null;
      else if (key === "project") out.projectId = value;
    }
  }
  return out;
}

/** Build the `history.db` row for one delegation. Exported for the seam test. */
export function dispatchEntry(rec: DispatchRecord): HistoryEntry {
  return {
    id: rec.id ?? crypto.randomUUID(),
    // `prompt`, not `response`: a delegation is something that was ASKED FOR. The distinction is
    // what keeps the existing prompt-only reads (the scrubber rail, `promptsInRange`) coherent if
    // they are ever pointed at this source.
    kind: "prompt",
    source: "dispatch",
    projectId: rec.projectId ?? null,
    // The columns are populated as well as the text, even though the parser reads the text. They are
    // what an operator querying the table by hand will filter on, and what a future indexed read
    // would use — the text parse exists because `entriesInRange` returns no columns, not because the
    // columns are redundant.
    agentId: rec.targetId,
    projectName: rec.projectName ?? null,
    agentName: rec.nameAtDispatch ?? null,
    text: formatDispatchText(rec),
    createdAt: rec.atMs ?? Date.now(),
  };
}

/**
 * Write one delegation to the ledger. Resolves `true` iff a row landed.
 *
 * ── NEVER THROWS, AND NEVER BLOCKS THE SPAWN ─────────────────────────────────────────────────────
 * Every call site is inside the act of creating an agent. A ledger that could fail a spawn would
 * trade a real agent for a bookkeeping row, which is the wrong direction by a wide margin: an
 * unrecorded delegation costs the concierge one round of re-research, while a refused spawn costs
 * the founder the work itself. So a failure here is logged at WARN and swallowed.
 *
 * It is logged rather than ignored because a ledger that is silently empty is worse than no ledger:
 * the concierge would then answer "we never did that work" with confidence, which is exactly the
 * false negative the whole feature exists to remove.
 */
export async function recordDispatch(rec: DispatchRecord): Promise<boolean> {
  try {
    const outcome = await recordHistory(dispatchEntry(rec));
    if (!outcome.inserted) {
      log.warn("dispatch-ledger", "delegation row did not land", {
        targetId: rec.targetId,
        channel: rec.channel,
        collided: outcome.collided,
      });
    }
    return outcome.inserted;
  } catch (e) {
    log.warn("dispatch-ledger", "delegation row failed to write", e);
    return false;
  }
}
