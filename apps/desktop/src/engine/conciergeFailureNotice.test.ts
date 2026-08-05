// The failure classifier. Most of these cases are about the evidence, not the headline: the
// headline is our guess at the cause and can be wrong, the evidence is the machine's own words and
// must survive untouched.
import { describe, expect, it } from "vitest";

import {
  AUTH_FAILURE_HEADLINE,
  FAILURE_EVIDENCE_MAX,
  QUOTA_FAILURE_HEADLINE,
  UNKNOWN_FAILURE_HEADLINE,
  conciergeFailureNotice,
} from "./conciergeFailureNotice";

/** Every distinct `concierge turn failed:` text logged on 2026-07-29, verbatim. These are the
 *  strings the host used to discard; they are the reason this module exists, so they are pinned
 *  here rather than paraphrased. */
const CORPUS_2026_07_29 = [
  "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message",
  "You've hit your session limit · resets 5:50am (America/Bogota)",
  "You've hit your session limit · resets 8:40am (America/Bogota)",
  "You've hit your session limit · resets 11:20am (America/Bogota)",
] as const;

describe("conciergeFailureNotice", () => {
  it.each(CORPUS_2026_07_29)("carries %s through byte for byte", (detail) => {
    const notice = conciergeFailureNotice(detail);
    expect(notice.kind).toBe("quota");
    expect(notice.headline).toBe(QUOTA_FAILURE_HEADLINE);
    // The WHOLE string, not a substring match — the reset time and the settings URL are the
    // actionable half, and a classifier that recognised the sentence but dropped its tail would
    // pass a looser assertion while losing exactly what the user needs.
    expect(notice.evidence).toBe(detail);
  });

  it("keeps the reset CLOCK TIME, which nothing else in the app knows", () => {
    const { evidence } = conciergeFailureNotice(
      "You've hit your session limit · resets 8:40am (America/Bogota)",
    );
    expect(evidence).toContain("resets 8:40am (America/Bogota)");
  });

  // THE RULE THE MODULE EXISTS FOR. An unrecognised failure keeps the sentence the app has always
  // shown — and gains the evidence. Without this, every failure the classifier does not know about
  // is swallowed exactly as before, and the fix would only cover the failures we happened to have
  // logs for.
  it("still carries the evidence when it cannot classify the failure", () => {
    const notice = conciergeFailureNotice("zsh: command not found: claude-nope");
    expect(notice.kind).toBe("unknown");
    expect(notice.headline).toBe(UNKNOWN_FAILURE_HEADLINE);
    expect(notice.evidence).toBe("zsh: command not found: claude-nope");
  });

  it("names an auth failure and points at the CLI that owns the credential", () => {
    const notice = conciergeFailureNotice("Invalid API key · please run `claude` to log in");
    expect(notice.kind).toBe("auth");
    expect(notice.headline).toBe(AUTH_FAILURE_HEADLINE);
  });

  // THE FOUNDER'S ACTUAL FAILURE, verbatim. This string classified as `unknown` and was answered
  // with "try me again in a moment" — advice that cannot work for an expired session, which he then
  // followed. The classifier matched `oauth token expired`; the CLI says `OAuth session expired`.
  // Pinned as its own case (not folded into a loop) because it is the specific regression.
  it("classifies the CLI's real expired-session sentence as auth, not unknown", () => {
    const notice = conciergeFailureNotice(
      "Failed to authenticate: OAuth session expired and could not be refreshed",
    );
    expect(notice.kind).toBe("auth");
    expect(notice.headline).toBe(AUTH_FAILURE_HEADLINE);
    // The headline must not tell the user to wait or retry — that is what made the old copy wrong.
    expect(notice.headline).not.toMatch(/try me again|in a moment/i);
    expect(notice.evidence).toBe(
      "Failed to authenticate: OAuth session expired and could not be refreshed",
    );
  });

  // The neighbouring phrasings the same code path can emit. Each must land on `auth` on its own —
  // written as separate strings rather than one compound sentence so a single alternative going
  // stale can't be masked by another alternative in the same input.
  it.each([
    "OAuth token expired",
    "OAuth session invalid",
    "Refresh token expired",
    "Failed to authenticate",
    "credentials could not be refreshed",
    "Error: Not logged in",
  ])("classifies %j as an auth failure", (detail) => {
    expect(conciergeFailureNotice(detail).kind).toBe("auth");
  });

  // A 429 mentions both rate limiting and authorization. It is a quota fact, and the remedy differs:
  // "run claude to log in" would send a user with a working login to fix a login that isn't broken.
  it("reads a rate limit as quota, not as an auth problem", () => {
    expect(conciergeFailureNotice("429 unauthorized: rate limit exceeded").kind).toBe("quota");
  });

  // THE CAP'S FAILURE MODE. A naive slice(0, N) keeps the FIRST N characters, so a quota sentence
  // that arrives after a wall of stderr is the part that gets cut — the cap would swallow precisely
  // the line the cap exists to protect.
  it("hoists the matched line above stderr noise so the cap can never cut it", () => {
    const noise = Array.from({ length: 40 }, (_, i) => `warn: some stderr line ${i}`).join("\n");
    const notice = conciergeFailureNotice(
      `${noise}\nYou've hit your session limit · resets 8:40am (America/Bogota)`,
    );
    expect(notice.kind).toBe("quota");
    expect(notice.evidence.split("\n")[0]).toBe(
      "You've hit your session limit · resets 8:40am (America/Bogota)",
    );
    expect(notice.evidence.length).toBeLessThanOrEqual(FAILURE_EVIDENCE_MAX);
    // The rest is still there — hoisting reorders, it does not discard. Dropping the remaining
    // stderr would be a second swallow.
    expect(notice.evidence).toContain("warn: some stderr line 0");
  });

  it("keeps the unmatched lines in their original order", () => {
    const { evidence } = conciergeFailureNotice("first\nsecond\nthird");
    expect(evidence).toBe("first\nsecond\nthird");
  });

  it("reports an empty detail as empty evidence rather than inventing one", () => {
    expect(conciergeFailureNotice("   \n  \n ").evidence).toBe("");
  });
});
