// shippedDeploy — the PROVENANCE layer between `scripts/deploy-url-for-pr.sh` and a preview card
// (bead ``, increment 2).
//
// ══ WHAT THIS IS FOR ═══════════════════════════════════════════════════════════════════════════
// A localhost preview dies with its dev server and cannot be forwarded to anyone. The thing a
// non-technical person actually wants is a link they can open on their phone and send to somebody
// else. `scripts/deploy-url-for-pr.sh` (increment 1, PR #3072) resolves a finished agent's pull
// request to exactly that — or refuses by name — and nothing in the app read it back. This module
// is the app-side half: it decides which claimed url may become a card, and re-asks that question
// at the moment the card is clicked.
//
// ══ THE GATE IS PROVENANCE, NOT THE URL TEST, AND THE DIFFERENCE IS THE WHOLE DESIGN ═══════════
// `services/previewCards` used to refuse any non-loopback url outright (`isLoopbackPreviewUrl`),
// which is why no public url could reach a human. The obvious widening — "accept any https url" —
// is the wrong one, and increment 1 measured why on a real pull request:
//
//   • Vercel's status-context `targetUrl` is `https://vercel.com/<org>/<project>/<id>`. It is a
//     perfectly ordinary public https url and it is the login-walled INSPECTOR dashboard, on a team
//     the recipient is not a member of.
//   • The `vercel[bot]` comment advertises a `previewUrl` that is a BRANCH ALIAS — it resolves to
//     whatever was last built for the branch, or to nothing — for a deployment the same comment's
//     own table calls "Skipped".
//
// No test on the STRING can separate either of those from a real one, because there is nothing
// wrong with the string. What separates them is where the url came from: a GitHub `deployment_status`
// with `state: "success"` and a non-empty `environment_url` is the provider asserting that THIS
// commit is what is being served. So the card gate is {@link SHIPPED_DEPLOY_PROVENANCE} — the token
// the resolver stamps on its own exit-0 answer — and {@link isShareableDeployUrl} is a FLOOR
// underneath it, never a substitute for it.
//
// ══ WHY A WRONG URL IS WORSE THAN NO CARD ══════════════════════════════════════════════════════
// The asymmetry is what makes every refusal here fail closed. A missing card costs someone a click
// through to the PR. A wrong one sends a non-technical user to a login wall, or to last week's
// build, having been told in so many words that this is their finished work — which is the precise
// false promise this bead exists to avoid making.
import {
  usePreviewStore,
  type ShippedDeploy,
} from "../stores/previewStore";

/**
 * The ONE provenance token `services/previewCards` will surface as a card.
 *
 * It is the literal `source` value `scripts/deploy-url-for-pr.sh --json` prints on verdict 0, and
 * it names the source rather than the script — a second resolver reading the same GitHub
 * Deployments API would be just as trustworthy, and a rewrite of that script under a new name would
 * not become less so. Both of the traps above have a url and neither can ever carry this token,
 * because the script never prints a verdict-0 document for them.
 */
export const SHIPPED_DEPLOY_PROVENANCE = "github-deployments";

/** Hosts that are public, https, and are NOT the work — they are the provider's own console, behind
 *  a login on a team the recipient is not on. This is the one place a suffix allowlist would be
 *  exactly backwards, so it is a DENYlist: a project served on its own custom domain (the ordinary
 *  case for anything a person would actually share) has no provider suffix at all, and an allowlist
 *  would refuse precisely the best answers. Mirrors the `du_is_public_url` dashboard clause in
 *  `scripts/deploy-url-for-pr.sh`; the two are asserted against each other in this module's suite. */
const DASHBOARD_HOSTS: ReadonlySet<string> = new Set([
  "vercel.com",
  "app.netlify.com",
  "dash.cloudflare.com",
  "github.com",
]);

/** Reserved / non-public suffixes. `.local` and `.internal` resolve inside somebody's own network,
 *  which is the exact failure a "public url" is supposed to have stopped being. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".test", ".invalid"];

/**
 * Is this a url that could honestly be sent to another person?
 *
 * THE FLOOR, NOT THE GATE — see this module's header. Passing this says only "nothing about this
 * address is disqualifying"; it says nothing at all about whether anything is deployed there.
 *
 * PARSED, NEVER STRING-MATCHED, for the reason `isLoopbackPreviewUrl` gives for the same decision:
 * `https://evil.com/#vercel.com` and `https://127.0.0.1.evil.com/` both defeat a substring test and
 * neither survives a real `URL`. Note in particular the userinfo clause — `https://vercel.app@evil`
 * renders as the trustworthy half in most surfaces a person would paste it into.
 *
 * @param url the candidate. `null`/`undefined`/unparseable are all `false`, never a throw: this is
 *            asked from a projection that must not be able to take the card strip down.
 */
export function isShareableDeployUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  // https ONLY. A plain-http public url is a link that can be read and rewritten in transit, and
  // every provider this reads from serves https — so admitting http buys nothing and costs the one
  // guarantee a shared link has.
  if (parsed.protocol !== "https:") return false;
  // `URL` puts userinfo in `username`/`password`, so this cannot be smuggled past by encoding.
  if (parsed.username !== "" || parsed.password !== "") return false;
  const host = parsed.hostname.toLowerCase();
  // A bare host with no dot cannot be a public name.
  if (!host.includes(".")) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return false;
  if (PRIVATE_SUFFIXES.some((s) => host.endsWith(s))) return false;
  // IPv6 literals arrive from `URL.hostname` in brackets. A raw address is never something a
  // provider hands out as a shareable deploy url, so refusing the whole class costs nothing.
  if (host.startsWith("[")) return false;
  if (isPrivateIPv4(host)) return false;
  if (DASHBOARD_HOSTS.has(host)) return false;
  // A SUBDOMAIN of a dashboard host is the same console — `vercel.com` and `www.vercel.com` both.
  if ([...DASHBOARD_HOSTS].some((d) => host.endsWith(`.${d}`))) return false;
  return true;
}

/** RFC1918 / link-local / this-host, as a dotted-quad. A "public url" that resolves to the
 *  recipient's own machine is the exact failure this whole module exists to replace. */
function isPrivateIPv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return false;
  const a = nums[0] as number;
  const b = nums[1] as number;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/** Why a claimed shipped url was not recorded. Each one is a different fact and each one is
 *  reported to the caller by name, because the caller is an AGENT and "it did not work" is not
 *  something an agent can act on. */
export type ShippedRecordRefusal =
  /** No url at all, or not a string. */
  | "no-url"
  /** The url is not one that could be sent to another person — see {@link isShareableDeployUrl}. */
  | "not-shareable"
  /** The claim did not carry {@link SHIPPED_DEPLOY_PROVENANCE}. */
  | "unproven";

/** What a caller hands in. Everything but `url` and `provenance` is optional context for the card's
 *  caption — a missing pr number costs a caption, a missing provenance costs the card. */
export interface ShippedDeployClaim {
  url: unknown;
  provenance: unknown;
  prNumber?: unknown;
  sha?: unknown;
  environment?: unknown;
}

export type ShippedRecordResult =
  | { ok: true; deploy: ShippedDeploy }
  | { ok: false; reason: ShippedRecordRefusal };

/**
 * Validate a claimed deploy url and, if it survives, put it where the card projection reads.
 *
 * THE ONE WRITER of `previewStore.shippedByAgent`, so every card on that surface has been through
 * both gates in this file. It is a pure-ish function of its arguments plus one store write, which
 * is what lets the refusal branches be tested without a bridge.
 *
 * `at` is injected rather than read from the clock so a test can pin `recordedAt` — the card's sort
 * key and its caption both come from it, and a value the suite cannot vary is a value no test can
 * say anything about (AGENTS.md, the vacuous-fixture rule).
 */
export function recordShippedDeploy(
  agentId: string,
  claim: ShippedDeployClaim,
  at: number = Date.now(),
): ShippedRecordResult {
  const url = typeof claim.url === "string" ? claim.url.trim() : "";
  if (!url) return { ok: false, reason: "no-url" };
  // PROVENANCE BEFORE THE URL TEST, so the refusal a caller sees names the thing that actually
  // disqualified it. A url that is both unproven and unshareable is unproven first: telling an
  // agent its url is malformed when the real problem is that nothing proved it was deployed would
  // send it off to find a different url rather than to run the resolver.
  if (claim.provenance !== SHIPPED_DEPLOY_PROVENANCE) return { ok: false, reason: "unproven" };
  if (!isShareableDeployUrl(url)) return { ok: false, reason: "not-shareable" };
  const deploy: ShippedDeploy = {
    url,
    provenance: SHIPPED_DEPLOY_PROVENANCE,
    prNumber: typeof claim.prNumber === "number" && Number.isInteger(claim.prNumber) && claim.prNumber > 0
      ? claim.prNumber
      : null,
    sha: typeof claim.sha === "string" && /^[0-9a-f]{40}$/i.test(claim.sha) ? claim.sha : null,
    environment:
      typeof claim.environment === "string" && claim.environment.trim() !== ""
        ? claim.environment.trim()
        : null,
    recordedAt: at,
  };
  usePreviewStore.getState().setShippedDeploy(agentId, deploy);
  return { ok: true, deploy };
}

/** Retire this agent's shipped card. Separate from `clearPreview`, which is the DEV SERVER's
 *  teardown — an idle dev server being reclaimed says nothing about whether the work is still
 *  deployed, and wiring the two together would let the idle clock silently retire a live link. */
export function clearShippedDeploy(agentId: string): void {
  usePreviewStore.getState().clearShippedDeploy(agentId);
}

/** Why a click on a shipped card did not open anything.
 *
 *  A NARROWER SET THAN `PreviewOpenRefusal`, and the absences are the interesting part. There is no
 *  `wrong-agent` (the store is keyed by agent, so a shipped url cannot be another agent's), no
 *  `not-live` (there is no state machine to fall out of), and no `unreadable` (the answer is a
 *  synchronous store read, so "we could not check" is unreachable — which is why this decision is
 *  not async and does not need the fail-closed branch its loopback twin does). */
export type ShippedOpenRefusal =
  /** The store no longer holds a shipped url for this agent — it was retired under the card. */
  | "gone"
  /** The store holds a DIFFERENT url than the card is showing. */
  | "moved"
  /** What the store holds no longer clears the provenance/url gates. */
  | "unsafe";

export type ShippedOpenDecision =
  | { ok: true; url: string }
  | { ok: false; reason: ShippedOpenRefusal; heldUrl: string; liveUrl: string | null };

/**
 * Is the url this shipped card is showing still the one the store holds for this agent?
 *
 * ══ WHY THE QUESTION IS RE-ASKED AT ALL ════════════════════════════════════════════════════════
 * A card is rendered once and clicked later, and the two gates in this file are the only thing
 * standing between "a proven deploy" and "a link to somewhere else". Re-asking is what makes them
 * gates rather than a one-time filter — the same reasoning `decidePreviewOpen` gives for the
 * loopback card, minus the round trip, because here the store IS the live answer.
 *
 * ══ A DISAGREEMENT REFUSES RATHER THAN FOLLOWING THE FRESH VALUE ═══════════════════════════════
 * Following it would open a SECOND destination from one gesture and hide the fact that the card had
 * gone stale — which is the fact worth knowing, since a re-recorded deploy is a different build.
 * The refusal costs one click and the card is already showing the new url by the time it is read.
 *
 * PURE, so every branch is testable without a store or a bridge.
 */
export function decideShippedOpen(
  held: { url: string },
  live: ShippedDeploy | null | undefined,
): ShippedOpenDecision {
  if (!live) return { ok: false, reason: "gone", heldUrl: held.url, liveUrl: null };
  // THE GATES, RE-ASKED — provenance first, for the same ordering reason `recordShippedDeploy`
  // gives. A store entry can only have got here through that writer today, but this decision must
  // not depend on that being true forever: it is the last thing between a stored url and a browser.
  if (live.provenance !== SHIPPED_DEPLOY_PROVENANCE || !isShareableDeployUrl(live.url)) {
    return { ok: false, reason: "unsafe", heldUrl: held.url, liveUrl: live.url ?? null };
  }
  if (live.url !== held.url) {
    return { ok: false, reason: "moved", heldUrl: held.url, liveUrl: live.url };
  }
  return { ok: true, url: live.url };
}

/** {@link decideShippedOpen} against the live store — the form a click handler calls. */
export function resolveShippedOpenTarget(
  agentId: string,
  held: { url: string },
): ShippedOpenDecision {
  return decideShippedOpen(held, usePreviewStore.getState().shippedByAgent[agentId] ?? null);
}
