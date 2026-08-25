// THE DELEGATION ROSTER, FOLDED INTO EVERY CONCIERGE TURN — the delivery half of the ledger.
//
// ══ WHY THIS EXISTS AT ALL, WHEN A PERSONA RULE ALREADY TOLD IT TO LOOK ═════════════════════════
//
// On 2026-08-22 the founder asked the concierge about making preview cards inline in chat. It
// answered as if it had never heard of the work and dispatched fresh research — EIGHT MINUTES after
// it had itself spawned an agent ("Sparkle Preview Card Inline") to do exactly that.
//
// The concierge already had a durable memory tool AND a persona paragraph telling it to use it. It
// simply did not think to look. So a rule saying "check your delegations first" is not the fix —
// that is the thing that already failed. The fix is that the answer is ALREADY IN FRONT OF IT: an
// eight-minute-old delegation is line 1 of the prompt, before the founder's message, on every turn.
// Under that arrangement the observed failure is not merely unlikely, it is unreachable.
//
// This is the same seam and the same shape as `stores/conciergeMemoryStore` (durable facts) and
// `services/research/drain` (finished findings): a pure preamble builder plus a `with…Preamble`
// wrapper that is IDENTITY when there is nothing, composed at the two places a concierge turn is
// assembled — `ConciergeHost.dispatchTurn` (user turns) and `conciergeProactive.fire` (unprompted
// turns). It is a SIBLING of those, not a modification of them.
//
// ══ AND WHY THERE IS NO CACHE HERE, UNLIKE THE MEMORY STORE ═════════════════════════════════════
//
// `conciergeMemoryStore` keeps a zustand cache because reading it costs a `bd` subprocess against a
// Dolt store under lock contention — hundreds of ms, sometimes seconds — and a memory that is a few
// seconds stale is still a true memory. NEITHER half of that holds here:
//
//   • The read is a bounded SQLite scan over `history.db` (services/dispatchRecall.openDispatches),
//     already sized for the turn path by its own contract: "it must stay cheap enough that nobody is
//     ever tempted to cache it".
//   • A roster that lags by one turn is WRONG IN EXACTLY THE MEASURED CASE. The concierge spawns an
//     agent and the founder asks about that work on the very next turn; a cache refreshed off the
//     turn path would still be holding the roster from before the spawn, and would answer "we have
//     nothing running on that" — which is the original bug wearing the fix's clothes.
//
// More generally: the bug class this whole feature lives inside is STATE STAMPED ONCE AND NEVER
// RE-DERIVED (services/dispatchLedger's load-bearing rule). A cached roster is a fresh instance of
// it. So the roster is read live, and the preamble — ages included — is rebuilt from `Date.now()`,
// on the turn that is about to run.
import { openDispatches, type RecalledDispatch } from "../services/dispatchRecall";
import { log } from "../logger";

/**
 * The opening line of the section, exported so a test asserts the SHIPPED string rather than its own
 * copy of it. Written as an INSTRUCTION for the same reason `MEMORY_PREAMBLE_HEADER` is: the failure
 * being prevented is a concierge that has the fact in front of it and answers as if it did not, so
 * the header has to say "you already know this" rather than merely presenting a list.
 */
export const DISPATCH_PREAMBLE_HEADER =
  "WORK YOU'VE ALREADY DELEGATED — agents and research tasks you dispatched that are still open, " +
  "NEWEST FIRST. You already know about these: if the user asks about something on this list, say " +
  "what is already running on it and check on it — do NOT treat it as new work and do NOT dispatch " +
  "it again. The id at the end of each line is the handle you use to reach that target.";

/**
 * How many delegations the preamble renders.
 *
 * A COUNT cap, not a size cap, because every line is already bounded (see {@link MAX_ASK_CHARS}) —
 * the runaway direction here is quantity, since delegations arrive forever and never expire on their
 * own. Ten is the founder's working-set size; past that the list stops being scannable and starts
 * being a wall the model skims, which is the failure mode the header is fighting.
 */
export const MAX_DISPATCH_LINES = 10;

/**
 * How much of each delegation's ask the line carries. One line, ~100 chars: enough for the SUBJECT
 * to be recognisable ("make the preview cards inline in chat") which is the only thing recall has to
 * work from, and short enough that ten of them are a paragraph rather than a page. The full brief is
 * one recall away.
 */
export const MAX_ASK_CHARS = 100;

/**
 * How many open delegations the live read pulls before {@link MAX_DISPATCH_LINES} clips them.
 *
 * Deliberately well above the render cap: the "and N more" disclosure can only be honest about rows
 * we actually counted, and fetching exactly the number we render would make every truncation read as
 * "N = 0", i.e. as a complete list. That is precisely the false statement this feature exists to
 * prevent, so the fetch is sized so the count is right for any fleet a human is actually running.
 */
export const DISPATCH_FETCH_LIMIT = 40;

/** Flatten to one line and clip, disclosing the clip — a truncated ask must never read as the whole
 *  ask (the same rule `clipValue` holds in the memory store). */
function clipAsk(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_ASK_CHARS ? flat : `${flat.slice(0, MAX_ASK_CHARS - 1).trimEnd()}…`;
}

/**
 * Age in the units a human thinks in. The founder's question is "is that still going?", and the
 * answer that matters is the ORDER OF MAGNITUDE — "8m ago" versus "2d ago" — never a timestamp he
 * would have to subtract from the current time himself.
 */
export function humanAge(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * One delegation, one line.
 *
 * ── THE NAME IS THE LIVE ONE, AND A RENAME IS SAID OUT LOUD ──────────────────────────────────────
 * `d.name` is re-derived at read time by `dispatchRecall`; `d.nameAtDispatch` is the historical
 * stamp. When they differ we lead with the LIVE name, because that is the one the founder can see on
 * screen, and mention the old one only as an aside. His own correction, verbatim: *"Build 17 is not
 * the name of the agent right now … that doesn't mean anything to me because I can't see it."*
 *
 * ── THE ID IS LAST, AND IT IS NEVER OMITTED ──────────────────────────────────────────────────────
 * It is the handle `inbox_send` / `send_to_agent_terminal` take, and the founder explicitly asked
 * that "go check on that agent" be actionable rather than a thing the concierge has to go hunt for.
 * Last on the line so the readable part (name, subject, age) is what the eye lands on first and the
 * machine handle sits where a trailing token belongs.
 */
function renderLine(d: RecalledDispatch): string {
  const name = d.name ?? "(unnamed)";
  const renamed = d.renamedSince && d.nameAtDispatch !== null ? ` (dispatched as "${d.nameAtDispatch}")` : "";
  // The ask is the founder's own words and is what recall works from; the brief is the fallback for
  // the write sites that had no ask (the "+ New Build Agent" button, the Plan board's "Start").
  const subject = clipAsk(d.ask ?? d.brief);
  const subjectPart = subject === "" ? "" : ` — "${subject}"`;
  // WHETHER THE ID CAN ACTUALLY BE MESSAGED, when it cannot. `addressable` is reported by
  // `dispatchRecall` precisely so the concierge stops offering a channel that does not exist — among
  // OPEN rows that is a research task, which has no inbox and whose findings are read rather than
  // asked for. Omitted in the common case: a marker on every line would be noise, and this list's
  // whole job is to stay scannable.
  const reach = d.addressable ? "" : " · no inbox";
  return `- ${name}${renamed}${subjectPart} · ${humanAge(d.ageMs)} · ${d.status}${reach} · ${d.targetId}`;
}

/**
 * Render the open delegations into the section that carries them.
 *
 * ── RECENCY ORDER, NEVER ALPHABETICAL, AND THIS IS NOT A STYLE CHOICE ────────────────────────────
 * `openDispatches` already returns newest-first and this function PRESERVES that order — it does not
 * sort. The sibling memory store demonstrates the cost of the alternative: `shapeMemories` applies
 * its 25-item cap AFTER an alphabetical key sort, which is measured to hide 17 of the founder's 42
 * facts (40%) from the prompt, `oauth-token-p0-blocker` among them. Under any ordering but recency
 * the eight-minute-old delegation this feature exists to surface can be the one that falls off the
 * end. Do not add a sort here.
 *
 * ── AND A TRUNCATED LIST MUST SAY SO ─────────────────────────────────────────────────────────────
 * A silently clipped roster reads as a complete one, and "we have nothing else running" is exactly
 * the false statement this feature was built to prevent. So the overflow is DISCLOSED with a count.
 *
 * ── THE HEADER'S CLAIM IS ENFORCED HERE, NOT ASSUMED OF THE CALLER ───────────────────────────────
 * The header says these delegations are STILL OPEN and prints a count of them, so a closed one
 * reaching this function would make the prompt state a falsehood — and the specific falsehood is
 * the original bug INVERTED: the concierge confidently telling the founder that work is running
 * when it finished. Today's only production caller (`dispatchPreambleNow` → `openDispatches`)
 * already filters, so this is belt to that braces; it is here anyway because a contract held only
 * by a caller's discipline is the kind this repo has repeatedly watched break, and because the
 * obvious future caller — some "recent delegations" surface that reasonably passes closed rows —
 * would otherwise inherit the lie silently rather than loudly.
 *
 * Caught by `services/dispatchLedger.seam.test.ts`, which is the only suite that crosses all three
 * halves of this feature; each half's own unit suite was green with this defect present.
 *
 * `""` when there is nothing open — see {@link withDispatchPreamble}.
 */
export function buildDispatchPreamble(dispatches: readonly RecalledDispatch[], nowMs: number): string {
  // Filtered BEFORE the count and before the cap, so `N open` counts what it says it counts and a
  // closed delegation can never consume one of the ten lines an open one needed.
  const open = dispatches.filter((d) => d.status !== "closed");
  if (open.length === 0) return "";
  // NO SORT — the input order is the answer. See above.
  const shown = open.slice(0, MAX_DISPATCH_LINES);
  const hidden = open.length - shown.length;
  // AGE IS RE-DERIVED HERE, from this one fixed clock, rather than reused from the `ageMs` the read
  // path stamped. Two reasons, and the second is the load-bearing one: one clock means two
  // delegations dispatched together can never print as different ages, and re-deriving is what keeps
  // the age honest on a prompt built some time after the roster was read. `dispatchedAtMs` is the
  // immutable fact; `ageMs` is a derivation, and this file makes its own.
  const lines = shown.map((d) =>
    renderLine({ ...d, ageMs: Math.max(0, nowMs - d.dispatchedAtMs) }),
  );
  const note = hidden > 0 ? [`(and ${hidden} more open delegation(s) not shown.)`] : [];
  return [
    `${DISPATCH_PREAMBLE_HEADER} ${open.length} open:`,
    "",
    ...lines,
    ...note,
  ].join("\n");
}

/**
 * Put the delegation roster in front of a prompt. IDENTITY WHEN THERE IS NOTHING — the same prompt
 * string, never a prompt carrying a blank header — so the seam can call this unconditionally.
 *
 * ══ EMPTY IS A REAL ANSWER, AND IT IS SPELT `""` ═══════════════════════════════════════════════
 * A standing "Delegations: (none)" block on every turn is prompt tax on the common case, and worse:
 * a section that is usually empty teaches the model that the section is noise, which is how the
 * turn that DOES carry a delegation gets skimmed. The same contract `withMemoryPreamble` and
 * `withResearchPreamble` publish, for the same reason.
 */
export function withDispatchPreamble(preamble: string, prompt: string): string {
  return preamble === "" ? prompt : `${preamble}\n\n${prompt}`;
}

/**
 * The live read: the open delegations RIGHT NOW, rendered for the turn about to run.
 *
 * NOT CACHED, ON PURPOSE — see this file's header. `openDispatches` never throws (an unreadable
 * ledger yields `[]`), and this adds a second belt anyway: a concierge turn must never fail because
 * the roster could not be read. The degraded answer is "no section", which costs the founder the
 * re-grounding but not the turn.
 */
export async function dispatchPreambleNow(
  read: (limit: number) => Promise<RecalledDispatch[]> = openDispatches,
  now: () => number = Date.now,
): Promise<string> {
  try {
    const open = await read(DISPATCH_FETCH_LIMIT);
    return buildDispatchPreamble(open, now());
  } catch (e) {
    log.warn("conciergeDispatch", "could not read open delegations for the turn preamble", e);
    return "";
  }
}
