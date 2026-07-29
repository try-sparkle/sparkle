// PR CLAIMS — the frontend half of "I am holding this PR myself".
//
// WHY. On 2026-07-29 the concierge merged PR #806 while its owning agent was deliberately holding
// it for a roborev round. The agent had SAID so, in prose, in a terminal nobody else reads. Nothing
// on the concierge's tool surface could see that intent, so from the outside the PR looked unowned
// and ready. A claim is that intent, moved out of prose and into a place another actor can read.
//
// A CLAIM IS A COURTESY, NOT A LOCK — see `PrClaim` in ./types. It expires, its owner can release
// it, and it stops counting once the claiming agent is gone. `claimStanding` below is where that
// rule actually lives, and it is deliberately PURE: the merge gate has to be able to reason about a
// claim without a round trip, and a rule that can only be exercised through Rust is a rule nobody
// writes the awkward tests for.
//
// The `invoke` wrappers here are thin on purpose. The registry is Rust-side (one per app launch, so
// a claim made in any window is visible from every window); this file is the typed door to it.
import { invoke } from "@tauri-apps/api/core";
import { PR_CLAIM_GRACE_SECONDS } from "./types";
import type { PrClaim, PrClaimStanding, PrClaimView } from "./types";

/**
 * Every live claim in this repo, or `null` when we COULD NOT LOOK.
 *
 * `null` IS NOT "no claims". That distinction is the entire lesson of #806 one layer down: a probe
 * that merely failed to answer must never read as a confident "nobody owns this PR". Callers get an
 * empty array for the real "answered: nothing is claimed" case, and `null` only when the read
 * itself failed — a caller that collapses the two into a benign default has reintroduced the bug.
 *
 * Never throws, because a claim probe is an ADVISORY read on the way to some other decision; a
 * caller must be able to ask without wrapping it, and then decide what an unreadable answer means.
 */
export async function fetchPrClaims(root: string): Promise<PrClaim[] | null> {
  try {
    const rows = await invoke<PrClaim[]>("pr_claims_list", { root });
    // A non-array reply is a Rust/IPC shape we do not understand, which is "could not look" — not
    // an empty registry. Guarding here keeps the null-vs-empty contract true for every caller
    // instead of handing one a value that only looks like an answer.
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

/**
 * Claim a PR for `agentId`. Resolves with the stored claim; REJECTS with the Rust error when the
 * claim is refused (another agent holds an unexpired claim on it).
 *
 * The rejection is propagated rather than swallowed, deliberately: "someone else is holding this"
 * is the single most actionable fact this module produces, and a caller that received a silent
 * `null` would carry on believing it owned the PR. Re-claiming your OWN claim extends it, so the
 * ordinary "I still want this" path is not an error.
 *
 * `agentId` is supplied by the CALL SITE's own identity (controlListener stamps the bridge caller),
 * never by anything a model wrote — see the `claim_pr` handler for why that matters.
 */
export async function setPrClaim(
  root: string,
  number: number,
  agentId: string,
  note?: string | null,
  ttlSeconds?: number,
): Promise<PrClaim> {
  return invoke<PrClaim>("pr_claim_set", {
    root,
    number,
    agentId,
    note: note ?? null,
    // Omitted rather than sent as null so the registry applies its own default TTL. Sending a
    // sentinel would make "I did not choose a TTL" indistinguishable from a caller asking for one.
    ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
  });
}

/**
 * Release `agentId`'s claim on a PR. Resolves `true` when a claim was removed, `false` when there
 * was nothing to remove; REJECTS when the claim belongs to a different agent.
 *
 * Same reasoning as `setPrClaim`: a refused release means the caller does not own what it thinks it
 * owns, and that has to reach it.
 */
export async function releasePrClaim(
  root: string,
  number: number,
  agentId: string,
): Promise<boolean> {
  return invoke<boolean>("pr_claim_release", { root, number, agentId });
}

/** One canonical spelling for a repo path. `/a/b`, `/a/b/` and ` /a/b ` are the same project, and
 *  several layers deliberately tolerate all three — so the comparison has to, or a claim written
 *  under one spelling is invisible under another and the merge gate reports an unclaimed PR. */
function canonicalRoot(root: string): string {
  return (root || "").trim().replace(/[/\\]+$/, "");
}

/** The claim on one PR, out of a repo-wide list. Pure. Claims are scoped per repo AND number, so
 *  both are matched — a bare number would collide across projects opened in the same app.
 *
 *  Both roots are canonicalized before comparing. Rust already canonicalizes on write, so this is
 *  belt-and-braces — but it is the LAST comparison before a merge decides nobody owns the PR, and
 *  that is the wrong place to depend on someone else having normalized. */
export function findClaim(
  claims: readonly PrClaim[],
  root: string,
  number: number,
): PrClaim | null {
  const want = canonicalRoot(root);
  return claims.find((c) => canonicalRoot(c.root) === want && c.number === number) ?? null;
}

/**
 * How a claim reads RIGHT NOW — the whole "a dead agent cannot wedge a PR forever" rule, as one
 * pure function.
 *
 * LIVENESS IS CHECKED BEFORE THE CLOCK, and the order is the interesting part.
 *
 * A dead claimant never blocks, whatever its expiry says (`abandoned`). A LIVE one keeps blocking
 * past its TTL (`lapsed`) until `PR_CLAIM_GRACE_SECONDS` have elapsed. That inversion is deliberate
 * and it fixes a real hazard: an agent deep in a long turn issues no tool calls, so it CANNOT renew
 * — the #806 owner spent one turn draining eleven roborev rounds — and dropping its claim at T+TTL
 * hands the PR to the concierge while the claimant is alive and working. The risk is asymmetric:
 * honouring a stale claim delays a merge, dropping a live one buries findings.
 *
 * The grace ceiling is what keeps that from being permanent, so the anti-wedge property survives:
 * past TTL + grace a claim is `expired` and stops blocking even for a live agent. The Rust registry
 * prunes on the same ceiling, which is what makes `lapsed` observable at all.
 */
export function claimStanding(
  claim: PrClaim | null,
  nowMs: number,
  claimantIsLive: boolean,
): PrClaimStanding {
  if (!claim) return "none";
  // LIVENESS FIRST, then the clock — the inverse of the original ordering, and the fix for a real
  // hazard. A dead claimant never blocks, whatever its clock says. A LIVE one keeps blocking past
  // expiry (`lapsed`) up to the grace ceiling, because an agent inside a long turn issues no tool
  // calls and so cannot renew — dropping its claim at T+TTL is #806 replayed on a timer.
  if (!claimantIsLive) return "abandoned";
  if (nowMs >= claim.expiresAtMs + PR_CLAIM_GRACE_SECONDS * 1000) return "expired";
  if (nowMs >= claim.expiresAtMs) return "lapsed";
  return "live";
}

/** Whether a standing stops another actor from merging. `lapsed` blocks alongside `live`: the
 *  claimant is still around, it just stopped renewing, and dropping a live agent's claim is the
 *  failure mode this whole module exists to prevent. Exported so no caller re-derives it. */
export function claimBlocks(standing: PrClaimStanding): boolean {
  return standing === "live" || standing === "lapsed";
}

/** How the claimant should be named to a human/model: its display name when we have one, else the
 *  raw agent id — never "unknown", which would read as "nobody" in a summary whose whole job is to
 *  say who is holding the PR. */
function claimantLabel(claim: PrClaim, claimantName?: string | null): string {
  return claimantName?.trim() ? claimantName.trim() : claim.agentId;
}

/** What the claiming agent said it was waiting on, quoted, or a plain statement that it said
 *  nothing. The note is the actionable half — "waiting on roborev round 12" is what tells another
 *  actor whether its own bar has been met. */
function noteClause(claim: PrClaim): string {
  return claim.note?.trim() ? `: "${claim.note.trim()}"` : " (it did not say what it is waiting on)";
}

/**
 * A claim as another actor should read it: the record, its standing, whether it BLOCKS, and one
 * line naming who is holding the PR and why.
 *
 * `blocks` is true for `live` AND `lapsed` — i.e. whenever the claimant is still around — and it is
 * DERIVED via `claimBlocks` rather than stored, so it cannot drift out of agreement with
 * `standing`. `expired` (past the grace ceiling) and `abandoned` (claimant gone) are both "this
 * claim is information, not a veto"; they are kept distinct because the remedy differs — an expired
 * claim can be re-made, an abandoned one never will be.
 */
export function viewClaim(
  claim: PrClaim | null,
  nowMs: number,
  claimantIsLive: boolean,
  claimantName?: string | null,
): PrClaimView {
  const standing = claimStanding(claim, nowMs, claimantIsLive);
  // DERIVED, never passed in: `blocks` and `standing` must not be able to disagree.
  return {
    claim,
    standing,
    blocks: claimBlocks(standing),
    summary: summarize(claim, standing, claimantName),
  };
}

function summarize(
  claim: PrClaim | null,
  standing: PrClaimStanding,
  claimantName?: string | null,
): string {
  if (!claim || standing === "none") return "No agent has claimed this PR.";
  const who = claimantLabel(claim, claimantName);
  const pr = `PR #${claim.number}`;
  switch (standing) {
    case "live":
      return `${who} is holding ${pr} and intends to land it itself${noteClause(claim)}.`;
    case "lapsed":
      // "REGISTERED", not "running" — `claimantIsLive` is filled from roster presence, so a tab
      // whose process an app restart killed still reads live. The claim_pr refusal was corrected to
      // say this; leaving the opposite here would have two surfaces describing one predicate in
      // contradictory terms, and this is the one the concierge reads before merging.
      return `${who} is holding ${pr} and is still registered in Sparkle, but its claim went stale — it has not renewed${noteClause(claim)}. It STILL blocks: an agent deep in a long turn cannot renew, and that is exactly when its claim matters. Ask it directly, or let it clear on its own past its TTL plus the two-hour grace window.`;
    case "expired":
      // Says what to DO about it, because "expired" alone reads as an error rather than as the
      // ordinary way a claim ends.
      return `${who}'s claim on ${pr} has expired — it stopped saying it was holding it${noteClause(claim)}. It does not block; ask it to re-claim if it still wants the PR.`;
    case "abandoned":
      return `${who} claimed ${pr} but is no longer registered in Sparkle, so the claim does not block${noteClause(claim)}.`;
  }
}
