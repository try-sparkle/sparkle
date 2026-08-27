// THE FALSE-ABSENCE COVERAGE SUITE (bead sparkle-gazo4a).
//
// The finish line this bead names is one objectively verifiable thing: "a test exists that FAILS if
// a probe which errored or timed out renders as an absence claim, and it passes for each of the six
// instances converted into cases." This file is the TypeScript half of that test, and
// `pipeline_health.rs`'s `false_absence_*` tests are the Rust half. Both read the SAME contract —
// `apps/desktop/shared/false-absence-corpus.json` — so neither half can quietly disagree about what
// the six cases are, and the COVERAGE GUARD at the bottom of each fails if a case in its language
// has no live test.
//
// WHY THE CORPUS IS READ FROM DISK HERE. The lexicon in `probeOutcome.ts` is a hand-written copy,
// exactly as `MERGE_PROTECTED_SLUGS` is a hand-written copy of `merge-protected-repos.json`. A copy
// that is not pinned to the file drifts on the first edit, and the Rust half — which cannot import a
// TypeScript module — needs the identical list. One file, three readers, one pin per reader.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ABSENCE_CLAIM_PATTERNS,
  COULD_NOT_LOOK_FALLBACK,
  absenceClaimIn,
  provenControl,
  renderProbeClaim,
  resolveProbe,
  safeRenderProbeClaim,
  truncatedControl,
  unreachableControl,
} from "./probeOutcome";

interface CorpusCase {
  id: string;
  lang: "ts" | "rust" | "shell";
  surface: string;
  observation: string;
  wrongClaim: string;
  truth: string;
  mechanism: string;
  coveredBy: string;
}

interface Corpus {
  absenceClaims: { patterns: { id: string; re: string; caught: string }[] };
  instances: { cases: CorpusCase[] };
}

const CORPUS: Corpus = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../shared/false-absence-corpus.json", import.meta.url)), "utf8"),
) as Corpus;

describe("the absence-claim lexicon is pinned to the shared contract", () => {
  it("holds exactly the corpus's patterns, in order, with identical sources", () => {
    // ORDER AND SOURCE BOTH, not just the id set. An id set alone goes green while a pattern's
    // regex has been widened or narrowed on one side only — which is the drift that matters, since
    // the pattern is the thing that actually catches a wrong sentence.
    expect(ABSENCE_CLAIM_PATTERNS.map((p) => p.id)).toEqual(CORPUS.absenceClaims.patterns.map((p) => p.id));
    for (const [i, want] of CORPUS.absenceClaims.patterns.entries()) {
      expect(ABSENCE_CLAIM_PATTERNS[i]?.re.source, `pattern "${want.id}" drifted from the contract`).toBe(
        want.re,
      );
      expect(ABSENCE_CLAIM_PATTERNS[i]?.re.flags).toContain("i");
    }
  });

  it("catches the real sentence each pattern was written for", () => {
    // NOT A TAUTOLOGY: `caught` in the contract is the VERBATIM text a shipped surface produced, so
    // this asserts the lexicon against measured production output rather than against itself. A
    // pattern edited until it no longer catches the wrong sentence it exists for fails here.
    // Each pattern is tested against ITS OWN measured text, not through `absenceClaimIn` — that
    // helper returns the FIRST match, so a pattern whose text another pattern also catches would go
    // green while being itself dead. Order-independent is the point.
    for (const [i, p] of CORPUS.absenceClaims.patterns.entries()) {
      const compiled = ABSENCE_CLAIM_PATTERNS[i];
      expect(compiled?.id).toBe(p.id);
      expect(compiled?.re.test(p.caught), `pattern "${p.id}" no longer catches its own measured text`).toBe(true);
    }
  });

  it("does not fire on an honest could-not-look sentence", () => {
    // The inverse direction, which is what keeps the lexicon usable. If these matched, every probe
    // would be forced into `COULD_NOT_LOOK_FALLBACK` and the feature would be a mute button.
    for (const honest of [
      "roborev status did not answer within 8s, and no daemon evidence could be read — diagnose before restarting.",
      "could not read 'sparkle-reviewer' review activity from GitHub; pipeline visibility is degraded.",
      "The releases read covered only published objects, so a draft for v0.140.0 can be neither confirmed nor ruled out.",
      "This agent's progress mark cannot see a running verify, so its stillness is not evidence either way.",
    ]) {
      expect(absenceClaimIn(honest), `false positive on: ${honest}`).toBeNull();
    }
  });
});

describe("resolveProbe: an empty read is COULD-NOT-LOOK unless a control proves otherwise", () => {
  it("is found when the read produced a value", () => {
    expect(resolveProbe({ value: 7, control: null })).toEqual({ kind: "found", value: 7 });
  });

  it("is could-not-look when there is NO control at all", () => {
    // THE DEFAULT IS THE FIX. Today's code paths reach "not found" by falling through, so a
    // forgotten control silently produces the confident wrong answer; here it produces the honest
    // one and a caller that can prove absence has to say so.
    const out = resolveProbe({ value: null, control: null });
    expect(out.kind).toBe("could-not-look");
  });

  it("is could-not-look when the read was UNREACHABLE", () => {
    const out = resolveProbe({ value: null, control: unreachableControl("gh exited 1: HTTP 401") });
    expect(out.kind).toBe("could-not-look");
  });

  it("is could-not-look when the read was reachable but INCOMPLETE — the forgotten half", () => {
    // Four of the six corpus instances are this shape, not the unreachable one: an HTTP 200 that
    // covered part of the population feels like an answer and is not one.
    const out = resolveProbe({
      value: null,
      control: truncatedControl("page was full (100 of 100); oldest entry 15h old, claim spans 48h"),
    });
    expect(out.kind).toBe("could-not-look");
  });

  it("is not-found ONLY when the control proves reachable AND complete", () => {
    const control = provenControl("gh repo view succeeded; unpaginated read returned all 3 objects");
    expect(resolveProbe({ value: null, control })).toEqual({ kind: "not-found", control });
  });
});

describe("renderProbeClaim refuses to let a could-not-look assert absence", () => {
  const phrasing = {
    found: (v: string) => `found ${v}`,
    notFound: () => "we looked everywhere and there is no such thing",
    couldNotLook: (why: string) => `could not read it: ${why}`,
  };

  it("THROWS when the could-not-look sentence carries an absence claim", () => {
    // This is the assertion the bead's finish line names. It fails if a probe which errored or timed
    // out renders as an absence claim.
    expect(() =>
      renderProbeClaim(
        { kind: "could-not-look", why: "timed out", control: null },
        { ...phrasing, couldNotLook: () => "the review daemon is not running" },
      ),
    ).toThrow(/ABSENCE CLAIM \(pattern "is-not-running"\)/);
  });

  it("allows the SAME sentence from a genuine not-found", () => {
    // The lexicon is not a list of banned words — a proven absence is supposed to say so. If this
    // ever fails, the feature has become a mute button rather than a truth gate.
    const control = provenControl("proven");
    expect(renderProbeClaim({ kind: "not-found", control }, phrasing)).toBe(
      "we looked everywhere and there is no such thing",
    );
  });

  it("passes an honest could-not-look sentence through unchanged", () => {
    expect(
      renderProbeClaim({ kind: "could-not-look", why: "HTTP 503", control: null }, phrasing),
    ).toBe("could not read it: HTTP 503");
  });

  it("safeRenderProbeClaim degrades on a live path instead of throwing, and reports why", () => {
    const seen: string[] = [];
    const text = safeRenderProbeClaim(
      { kind: "could-not-look", why: "timed out", control: null },
      { ...phrasing, couldNotLook: () => "there is no such thing" },
      (m) => seen.push(m),
    );
    expect(text).toContain(COULD_NOT_LOOK_FALLBACK);
    expect(absenceClaimIn(text)).toBeNull();
    expect(seen.join(" ")).toMatch(/ABSENCE CLAIM/);
  });
});

describe("COVERAGE GUARD — every TypeScript corpus instance is claimed by a live test", () => {
  // An instance list nobody runs is exactly the false-green this bead is about, so the corpus
  // itself gets a guard. Each `ts` case must name a test file that exists and that mentions the
  // case id, which is what stops a case from being dropped by deleting its assertions.
  const tsCases = CORPUS.instances.cases.filter((c) => c.lang === "ts");

  it("has at least the two TypeScript instances the bead names", () => {
    expect(tsCases.map((c) => c.id).sort()).toEqual(["epic-sweeper-no-change", "resume-ticker-no-progress"]);
  });

  for (const c of tsCases) {
    it(`instance "${c.id}" names a live covering test that references it`, () => {
      const path = fileURLToPath(new URL(`../${c.coveredBy}`, import.meta.url));
      const src = readFileSync(path, "utf8");
      expect(src, `${c.coveredBy} does not mention instance "${c.id}"`).toContain(c.id);
    });
  }

  it("no corpus case's WRONG CLAIM would survive the lexicon", () => {
    // The corpus's own evidence, used as a corpus: every sentence the shipped code actually produced
    // must be catchable. A wrong claim the lexicon cannot see is a hole in the lexicon, and this is
    // the assertion that finds it — for the Rust and shell cases too, which this suite otherwise
    // does not touch.
    for (const c of CORPUS.instances.cases) {
      expect(absenceClaimIn(c.wrongClaim), `instance "${c.id}"'s measured wrong claim escapes the lexicon`).not.toBeNull();
    }
  });
});
