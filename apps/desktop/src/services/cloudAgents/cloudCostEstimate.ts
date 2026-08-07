// What a cloud agent will cost, in the only terms that are honest before it starts: a RATE and a
// RUNWAY — or, below the server's start floor, what it takes to start at all.
//
// WHY RUNWAY AND NOT A TOTAL. A cloud agent is metered per running minute and nobody knows how long
// a run will last, so "this will cost about $X" would be a number we invented. What IS knowable is
// what an hour costs and how long the balance lasts. The copy says "funds about N" rather than
// "will cost N" for the same reason.
//
// THE CLIENT HOLDS NO PRICE. Every number here is a parameter with no default — the rate, the
// balance, and the floor all come from the server on `/me`. A duplicated pricing rule has already
// shipped a bug in this exact feature: the 50¢ client-side floor that refused every start between
// 5¢ and 49¢ the server would have accepted (see CLOUD_MIN_START_CENTS in ./gating.ts). Passing the
// server's own `minStartCents` through is the opposite of that mistake — it is the same number
// transported, not a second copy of the rule.
//
// ONE FUNCTION, ONE SENTENCE. An earlier cut exported a `CloudCostEstimate` DTO plus a two-stage
// `cloudCostEstimate()` → `cloudCostLine()` API. No caller ever consumed the parts: both dialogs
// render the whole sentence, so the DTO was a public contract every later copy change would have
// had to preserve, for nothing.

import { formatUsd } from "../../components/spendFormat";

/** Round to at most one decimal, dropping a trailing ".0" — "1.5", "22". */
function trim(n: number): string {
  return n.toFixed(1).replace(/\.0$/, "");
}

/**
 * Pluralize against the RENDERED number, not the raw one — that distinction is the whole point.
 *
 * `trim` collapses 1.0 to "1", and it rounds, so every duration from 60 up to (not including) 63
 * minutes renders "1" — 63 min is 1.05 h, which rounds to "1.1". Keying the plural off the raw
 * value would still say "1 hours" for 61 minutes while looking correct in a spot check at exactly
 * 60. The user reads the trimmed string, so the trimmed string decides.
 */
function qty(value: number, singular: string): string {
  const shown = trim(value);
  return `${shown} ${shown === "1" ? singular : `${singular}s`}`;
}

/**
 * Humanize a duration given in MINUTES. Deliberately coarse: "about 3.7 hours" implies a precision
 * the underlying guess does not have, and the quantity it estimates — how long an agent runs — is
 * unknown anyway.
 *
 * Exported (rather than kept private) because its boundaries are where this module has already been
 * wrong: the 60-to-65-minute band that rendered "1 hours" is reachable only through a balance that
 * divides to exactly that window, so testing it through the sentence would mean hand-computing
 * balances and would obscure what is actually being pinned.
 */
export function humanizeMinutes(minutes: number): string | null {
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  // "min" is an abbreviation, not a word, so it does not take a plural — "1 min" is correct.
  if (minutes < 60) return `${Math.floor(minutes)} min`;
  const hours = minutes / 60;
  // Past a couple of days the hour count stops meaning anything to a reader.
  if (hours >= 48) return qty(Math.floor(hours / 24), "day");
  return qty(hours, "hour");
}

/**
 * The one line the creation and promotion dialogs render, or null when there is nothing honest to
 * say — an absent/non-positive rate, which is what an older server (no `cloudAgentPricing` on
 * `/me`) looks like. Showing nothing is correct there; a fallback rate would be the duplicated
 * pricing rule this module exists to avoid.
 *
 * `minStartCents` is the server's START FLOOR, and honouring it is what makes the sentence
 * ACTIONABLE rather than merely arithmetic. Below that floor the balance funds no run at all —
 * `canStartCloudAgent` refuses — so quoting a runway there states a runtime the user cannot buy.
 * Omit it and the runway is unconditional, which is only right when the caller genuinely has no
 * floor to apply.
 */
export function cloudCostLine(
  rateCentsPerMinute: number | undefined,
  balanceCents: number,
  minStartCents?: number,
): string | null {
  if (rateCentsPerMinute === undefined || !Number.isFinite(rateCentsPerMinute)) return null;
  if (rateCentsPerMinute <= 0) return null;

  const perHour = formatUsd((rateCentsPerMinute * 60) / 100);
  // A negative balance is possible in the ledger (it may go below zero on a settle) and funds
  // exactly nothing — clamp rather than rendering a negative runway.
  const affordable = Math.max(0, balanceCents);

  // BELOW THE SERVER'S FLOOR: say what it takes to start, not how long a start we would refuse
  // would last. This is the case the contract-drift probe caught — at 0.9¢/min a 50¢ balance
  // divides to a confident "funds 56 min" for a start the server rejects outright.
  if (minStartCents !== undefined && Number.isFinite(minStartCents) && affordable < minStartCents) {
    return `About ${perHour}/hour of running time. You need ${formatUsd(minStartCents / 100)} to start.`;
  }

  const runway = humanizeMinutes(affordable / rateCentsPerMinute);
  if (!runway) {
    // Rate known, balance empty, and no floor was supplied. Say the rate and stop — "funds 0 min"
    // is noise, and the credits block is already telling this user to top up.
    return `About ${perHour}/hour of running time.`;
  }
  return `About ${perHour}/hour of running time — your balance funds ${runway}.`;
}
