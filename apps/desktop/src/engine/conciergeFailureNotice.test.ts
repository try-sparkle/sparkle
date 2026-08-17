// The failure classifier. Most of these cases are about the evidence, not the headline: the
// headline is our guess at the cause and can be wrong, the evidence is the machine's own words and
// must survive untouched.
import { describe, expect, it } from "vitest";

import {
  AUTH_FAILURE_HEADLINE,
  FAILURE_EVIDENCE_MAX,
  QUOTA_FAILURE_HEADLINE,
  UNKNOWN_FAILURE_HEADLINE,
  bubbleFailureHeadline,
  conciergeFailureNotice,
  mountedFailureHeadline,
  type ConciergeFailureKind,
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

// ══ THE MOUNTED VARIANTS (bead sparkle-voudj7, roborev 64319/64327) ═══════════════════════════
// PINNED HERE, not through a rendered tree, because that is this module's whole reason for being
// pure and React-free — and because the bug that prompted these rows was invisible to the one
// component test that touched them: it covered `auth` only, so `quota` and `unknown` shipped
// violating both contracts the map declares.
//
// ══ THE KIND LIST IS EXHAUSTIVE BY CONSTRUCTION, NOT BY HAND ══════════════════════════════════
// A first cut wrote `const KINDS: ConciergeFailureKind[] = ["quota", "auth", "unknown"]` and claimed
// a kind added later would inherit the rules. It would not: `ConciergeFailureKind[]` is satisfied by
// any SUBSET of the union, so a fourth kind type-checked with zero failures — while
// `MOUNTED_HEADLINES` is a total `Record` and would force it to have an ENTRY. An entry that
// violates every contract here IS the shipped defect (`unknown` had one and broke two rules).
//
// So the list is derived from a total `Record`: omitting a member is a COMPILE error, and the row
// below pins the membership EXPLICITLY so growing the union reds this file and makes a reviewer
// confirm the new kind against the three contracts rather than inheriting a pass.
const KIND_SET: Record<ConciergeFailureKind, true> = { quota: true, auth: true, unknown: true };
const KINDS = Object.keys(KIND_SET) as ConciergeFailureKind[];

describe("mountedFailureHeadline", () => {
  // ══ THIS ROW REPLACED A VACUOUS ONE (roborev 64334) ═════════════════════════════════════════
  // It used to assert `KINDS.length >= 3` and that the keys were unique — both GUARANTEED by the
  // compiler and by `Object.keys`, so no mutation could turn it red, and its comment claimed to
  // catch a "stale hand-written list" that no longer existed. Pinning the membership is the thing
  // the type system does NOT do: a fourth kind fails here, which is the point — the contracts below
  // then have to be read for it deliberately.
  it("pins the kind membership, so growing the union forces a review of the new kind", () => {
    expect([...KINDS].sort()).toEqual(["auth", "quota", "unknown"]);
  });

  for (const kind of KINDS) {
    it(`${kind}: names an action reachable from a mounted column`, () => {
      const line = mountedFailureHeadline(kind);
      expect(line.length).toBeGreaterThan(0);
      // THE CONTRACT THE `unknown` ENTRY BROKE. A mounted column renders no `failure` bubble, so a
      // line offering only "try again" leaves the reader with no route to what the machine said —
      // and `unknown` is the lossy bucket that carries that text, so it needs the route most.
      expect(line).toMatch(/unmount/i);
    });

    it(`${kind}: is a whole sentence, with no colon dangling into absent evidence`, () => {
      // The bubble's `auth` and `quota` headlines END IN A COLON introducing the evidence block
      // beneath them. The notice row carries no evidence, so a mirrored colon dangles mid-sentence.
      expect(mountedFailureHeadline(kind)).not.toMatch(/:\s*$/);
    });

    // …AND IT IS NOT THE BUBBLE'S STRING. Copying those verbatim is the defect this map exists to
    // prevent, so a regression to a passthrough has to fail rather than merely look different.
    //
    // READ THROUGH `bubbleFailureHeadline`, not a test-local copy of `HEADLINES` (roborev 64334). A
    // second hand-maintained map is forced by its `Record` type to have an entry but not a correct
    // one — map a new kind to `""` and this assertion passes emptily for exactly the kind it exists
    // to cover — and it would also go inert if the module repointed a headline underneath it.
    it(`${kind}: is not a passthrough of the bubble headline`, () => {
      const bubble = bubbleFailureHeadline(kind);
      // The comparison is only meaningful against a real sentence, so pin that too.
      expect(bubble.length).toBeGreaterThan(0);
      expect(mountedFailureHeadline(kind)).not.toBe(bubble);
    });

    // AND THE BUBBLE SIDE IS THE ONE THE PRODUCT ACTUALLY RENDERS.
    //
    // WHAT THIS GRIPS, STATED HONESTLY: the ACCESSOR, not the strings. Both sides resolve through
    // the module's own `HEADLINES`, so repointing an entry moves both and this equality holds —
    // verified by mutation, and it is why the row is not claimed as a check on the copy itself.
    // What it does catch is `bubbleFailureHeadline` coming to read a DIFFERENT map than the one the
    // host renders, which is the drift that would quietly hollow out the passthrough guard above
    // (mutating the accessor to return `MOUNTED_HEADLINES` reds both rows, for every kind). The
    // `notice.kind` assertion is the independent half: it pins that this detail really classifies as
    // this kind, so the pair below is not testing the classifier against itself.
    it(`${kind}: bubbleFailureHeadline agrees with what conciergeFailureNotice emits`, () => {
      const detail = { quota: "You've hit your session limit", auth: "Invalid API key · Please run /login", unknown: "some other failure" }[kind];
      const notice = conciergeFailureNotice(detail);
      expect(notice.kind).toBe(kind);
      expect(notice.headline).toBe(bubbleFailureHeadline(kind));
    });
  }

  // The quota line drops the bubble's "not something Sparkle can route around:" tail, which only
  // makes sense immediately above the evidence it introduces.
  it("quota keeps the fact and drops the evidence-introducing tail", () => {
    const line = mountedFailureHeadline("quota");
    expect(line).toMatch(/out of room/i);
    expect(line).not.toMatch(/route around/i);
  });
});
