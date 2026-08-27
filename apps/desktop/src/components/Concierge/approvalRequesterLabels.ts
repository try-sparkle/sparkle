// WHO ASKED, in words, and — the part that is not obvious — words that are DIFFERENT for different
// callers (bead `sparkle-tavx1`).
//
// The approval ledger mints one card per REQUESTER, so two agents making byte-identical calls put
// two cards on the human's column with the same domain, op, summary and argument lines. The "Asked
// by" line on the card is the only thing that tells them apart, and the click it guards now decides
// WHICH agent spends the grant — so a label that names two callers the same thing is worse than no
// label at all: it reads as authoritative while being ambiguous.
//
// AND AGENT NAMES ARE NOT UNIQUE. `defaultAgentName` numbers within ONE project, so every project
// mints its own "Build 1" / "Worker 1", and renaming does not dedupe either. The ledger and the
// column are app-GLOBAL — `requestedBy` is stamped from whichever socket the call arrived on,
// across every project — so the name alone is exactly the collision it was supposed to resolve.
//
// So the labels are resolved over the SET ACTUALLY ON SCREEN, not per agent in isolation: a name
// that is unambiguous among the pending cards is left alone (the common case, and the readable
// one), and only a genuine collision is qualified. That keeps the noise where the ambiguity is.
import type { ConciergeApproval } from "../../stores/conciergeApprovals";
import type { Project } from "../../types";

/** What an unattributed entry is called. Not a name we invented for it — the ledger genuinely does
 *  not know whose it is (no agent may read it; only the human may answer it), and saying so is the
 *  honest reading. Exported so the card can use the same words when no map was supplied. */
export const UNIDENTIFIED_CALLER = "an unidentified caller";

/** The shortest id fragment worth showing. Long enough to be a discriminator a human can compare,
 *  short enough not to become the label — but it is a FLOOR, not the answer: see {@link shortestDistinct}. */
const ID_SUFFIX_CHARS = 6;

/**
 * The identity of the CALLER, as far as anything can tell.
 *
 * A blank `requestedBy` is deliberately keyed per ENTRY rather than folded into one "unknown"
 * bucket: two unattributed cards are two callers we could not identify, not one caller asking
 * twice, and treating them as the same is the assertion this whole file exists to avoid making.
 */
function callerKey(a: ConciergeApproval): string {
  return (a.requestedBy ?? "").trim() || `entry:${a.id}`;
}

/**
 * The shortest prefix length at which every one of these ids is distinct, never shorter than
 * {@link ID_SUFFIX_CHARS}.
 *
 * A FIXED slice is not good enough, and the failure is not hypothetical: ids that share a prefix
 * (`agent-aaaaaa` / `agent-bbbbbb`, and any id scheme with a constant lead) collapse to the same six
 * characters, so the "discriminator" appended to break a collision reproduces it exactly. This is
 * the one place in the file that must be provably unique, because it is the last fallback.
 */
function shortestDistinct(ids: readonly string[]): number {
  const longest = Math.max(0, ...ids.map((i) => i.length));
  for (let n = ID_SUFFIX_CHARS; n < longest; n += 1) {
    if (new Set(ids.map((i) => i.slice(0, n))).size === ids.length) return n;
  }
  return longest;
}

/**
 * `approval.id` → the label its card should show.
 *
 * KEYED BY APPROVAL, NOT BY AGENT, and that is load-bearing rather than a convenience: two blank
 * requesters share the empty string, so an agent-keyed map cannot give them different labels at all
 * — the collision would survive by construction.
 *
 * Names are qualified in two steps so the readable form wins whenever it is unambiguous:
 *   1. the agent's own name (or its raw id, when no agent by that id is mounted — it can be torn
 *      down while its question is still on screen, and the id still discriminates);
 *   2. on a collision among the cards on screen, the project name if that separates them, and
 *      failing that a short slice of the caller's id, which always does.
 */
export function resolveRequesterLabels(
  approvals: readonly ConciergeApproval[],
  projects: readonly Project[],
): Record<string, string> {
  const byAgent = new Map<string, { name: string; project: string }>();
  for (const p of projects) {
    for (const a of p.agents ?? []) {
      if (a.id) byAgent.set(a.id, { name: a.name?.trim() || a.id, project: p.name?.trim() ?? "" });
    }
  }

  const baseOf = (a: ConciergeApproval): string => {
    const id = (a.requestedBy ?? "").trim();
    if (id === "") return UNIDENTIFIED_CALLER;
    return byAgent.get(id)?.name ?? id;
  };

  // How many DISTINCT callers each base name is standing for among the cards on screen. One caller
  // asking twice is not an ambiguity — the two cards differ by what they are asking — so this
  // counts callers, not cards.
  const callersPerBase = new Map<string, Set<string>>();
  for (const a of approvals) {
    const set = callersPerBase.get(baseOf(a)) ?? new Set<string>();
    set.add(callerKey(a));
    callersPerBase.set(baseOf(a), set);
  }

  const labels: Record<string, string> = {};
  for (const a of approvals) {
    const base = baseOf(a);
    if ((callersPerBase.get(base)?.size ?? 0) < 2) {
      labels[a.id] = base;
      continue;
    }
    // Ambiguous. Try the project first — "Build 1 · Kraken" is still something a human reads.
    const project = byAgent.get((a.requestedBy ?? "").trim())?.project ?? "";
    const qualified = project ? `${base} · ${project}` : "";
    const qualifiedIsUnique =
      qualified !== "" &&
      approvals.every(
        (o) =>
          callerKey(o) === callerKey(a) ||
          baseOf(o) !== base ||
          `${baseOf(o)} · ${byAgent.get((o.requestedBy ?? "").trim())?.project ?? ""}` !== qualified,
      );
    if (qualifiedIsUnique) {
      labels[a.id] = qualified;
      continue;
    }
    // LAST FALLBACK, and the only one that cannot itself collide: the caller's own id, cut at the
    // shortest length that actually separates the callers sharing this name.
    const colliding = [...(callersPerBase.get(base) ?? new Set<string>())];
    const n = shortestDistinct(colliding);
    labels[a.id] = `${base} (${callerKey(a).slice(0, n)})`;
  }
  return labels;
}
