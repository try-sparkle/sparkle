// Who a tool refusal is FOR. The founder asked "why am I seeing it? Do I need to be seeing that?"
// about a thread full of internal gate text; the answer was no, and the answer for a lost
// credential would have been yes. Everything here is about keeping those two apart — and, more
// importantly, about which way the module fails when it cannot tell.
import { describe, expect, it } from "vitest";
import { refusalAudience, refusalGist } from "./refusalAudience";

// The three he was actually shown, quoted from his report. If any of these ever reads "founder"
// again, the wall of red is back.
describe("the refusals the founder was shown, verbatim", () => {
  it("withholds the roborev gate paragraph", () => {
    expect(
      refusalAudience(
        'Refused: roborev is the review gate on this machine and its state for ' +
          'sparkle/agent-61b8881b-0000-0000-0000-000000000000 could not be read. That is "I could ' +
          'not find out", not "it is clean". roborev row(s) 59204, 59203, 59177, 59169, 59166, ' +
          "59040 carry no branch.",
      ),
    ).toBe("internal");
  });

  it("withholds the checks-running refusal", () => {
    expect(
      refusalAudience(
        "Refused: Checks running (2): Node — shell and Node — coverage — merging now is merging blind.",
      ),
    ).toBe("internal");
  });

  it("withholds the agent-slot capacity refusal", () => {
    expect(
      refusalAudience(
        "I can't start another agent right now. This machine has 90 of its 81 agent slots taken.",
      ),
    ).toBe("internal");
  });
});

// The half that must not regress. Hiding one of these costs the founder the only message that
// would have told him why his app is stuck, and he has no way to know to go looking for it.
describe("a refusal only the founder can clear always reaches him", () => {
  const founderOnly = [
    "gh auth login required — you are not authenticated",
    "GraphQL: unauthorized",
    "HTTP 401: Bad credentials",
    "GraphQL: someone does not have the correct permissions to execute MergePullRequest",
    "HTTP 403: Resource not accessible by integration",
    "The account has hit its spending cap; billing is blocked",
    "Your plan expired — renew to continue",
    "This needs your approval before I can run it",
  ];
  for (const reason of founderOnly)
    it(`shows: ${reason.slice(0, 44)}…`, () => {
      expect(refusalAudience(reason)).toBe("founder");
    });
});

// THE ORDERING RULE, and the reason it is an ordering rule rather than two independent lists.
describe("a founder signal wins wherever it appears", () => {
  it("does not file an auth failure as the gate whose words it borrowed", () => {
    // Both vocabularies in one string. Read as internal, this is an unauthenticated `gh` silently
    // swallowed for as long as it keeps failing — the expensive direction.
    expect(
      refusalAudience("roborev state could not be read: the gh token is expired"),
    ).toBe("founder");
    expect(
      refusalAudience("Checks running — and you are not authenticated to read them"),
    ).toBe("founder");
    expect(refusalAudience("agent slots taken; also, billing is suspended")).toBe("founder");
  });
});

// The property that makes the allowlist safe to extend: it fails toward NOISE, never toward
// silence.
describe("anything we do not recognise is shown", () => {
  it("defaults an unclassified reason to the founder", () => {
    expect(refusalAudience("nope")).toBe("founder");
    expect(refusalAudience("the flux capacitor declined")).toBe("founder");
    expect(refusalAudience("agentId is required.")).toBe("founder");
    expect(refusalAudience("its terminal is showing a full-screen app")).toBe("founder");
  });

  it("treats an absent or empty reason as the founder's — absence is not evidence", () => {
    expect(refusalAudience(undefined)).toBe("founder");
    expect(refusalAudience(null)).toBe("founder");
    expect(refusalAudience("")).toBe("founder");
    expect(refusalAudience("   ")).toBe("founder");
  });

  it("does not match a gate word that is merely a SUBSTRING of another word", () => {
    // The list is literal on purpose; `\b` anchors keep it from over-reaching into real prose.
    expect(refusalAudience("the quotation was rejected")).toBe("founder"); // not "quota"
    expect(refusalAudience("deforbidden")).toBe("founder"); // not "forbidden"
  });
});

// ── THE GIST REPLACES THE PARAGRAPH; IT DOES NOT REPLACE THE ROW (roborev 63249, Medium) ───────
//
// The first cut dropped the receipt entirely for an internal gate. That removed the only surface
// that can contradict the concierge's own prose — `services/conciergeReceipts.ts` measured 32 of
// 145 past-tense claims with no matching tool call, and a settle once reported a REFUSED merge as
// "Merged PR #753". His complaint was the wall of text, not the line.
describe("refusalGist", () => {
  it("returns a short phrase for a gate, not the tool's paragraph", () => {
    const gist = refusalGist(
      "Refused: Checks running (2): Node — shell and Node — coverage — merging now is merging blind.",
    );
    expect(gist).toBe("waiting on checks");
    // Short enough to sit on one row beside "Didn't merge".
    expect((gist ?? "").length).toBeLessThan(60);
  });

  it("carries no job ids, check names or slot arithmetic into the thread", () => {
    const gist = refusalGist(
      "Refused: sparkle/agent-61b8881b has open FAIL-verdict roborev reviews (jobs 59204, 59203, 59177) that nobody has read or closed.",
    );
    expect(gist).toBe("there are review findings to work through");
    expect(gist).not.toMatch(/59204|roborev|job/i);
  });

  it("is null for anything the founder must read, so his text is shown verbatim", () => {
    expect(refusalGist("GraphQL: unauthorized")).toBeNull();
    expect(refusalGist("agentId is required.")).toBeNull();
    expect(refusalGist(undefined)).toBeNull();
  });

  it("agrees with refusalAudience by construction — one rule, not two", () => {
    for (const reason of [
      "Refused: a roborev review round is still IN FLIGHT on sparkle/x (job 1).",
      "GraphQL: unauthorized",
      "nope",
      undefined,
      "This machine has 90 of its 81 agent slots taken.",
    ])
      expect(refusalAudience(reason) === "internal").toBe(refusalGist(reason) !== null);
  });
});

// ── A DEAD TOOL IS NOT A GATE (roborev 63249, Medium) ──────────────────────────────────────────
//
// `mergeGuard/roborev.ts` splices the raw probe error into "roborev is the gate on this branch and
// this reading cannot be trusted: <error>". A bare `/\broborev\b/` therefore swallowed
// `command not found`, a dead daemon and `connection refused` — every one permanently blocking,
// every one clearable only by a human, and every one hidden forever while all merges refused.
// This is not hypothetical: the daemon went down mid-session and printed exactly the string below.
describe("a roborev that is DOWN reaches the founder", () => {
  const down = [
    "Refused: roborev is the gate on this branch and this reading cannot be trusted: failed to connect to daemon (is it running?)",
    "Refused: roborev is the gate on this branch and this reading cannot be trusted: roborev: command not found",
    "Refused: roborev is the gate on this branch and this reading cannot be trusted: connection refused",
    "Refused: roborev is the gate on this branch and this reading cannot be trusted: no such file or directory",
  ];
  for (const reason of down)
    it(`shows: ${reason.slice(58, 100)}…`, () => {
      expect(refusalAudience(reason)).toBe("founder");
      expect(refusalGist(reason)).toBeNull();
    });

  it("still withholds the roborev gates that are genuinely the concierge's job", () => {
    // The narrow half must keep working, or the noise comes straight back.
    expect(
      refusalAudience("Refused: a roborev review round is still IN FLIGHT on sparkle/x (job 1)."),
    ).toBe("internal");
    expect(
      refusalAudience("Refused: sparkle/x has open FAIL-verdict roborev reviews (job 1) that nobody has read or closed."),
    ).toBe("internal");
    expect(
      refusalAudience("Refused: roborev job 5 on sparkle/x ended without a readable verdict."),
    ).toBe("internal");
  });

  it("does not withhold a roborev sentence it does not recognise", () => {
    // The bare-subsystem match is gone: an unphrased roborev refusal defaults to SHOWING.
    expect(refusalAudience("Refused: roborev did something entirely new")).toBe("founder");
    expect(
      refusalAudience(
        'Refused: roborev is the review gate on this machine and its state for sparkle/x could not be read. That is "I could not find out", not "it is clean".',
      ),
    ).toBe("founder");
  });
});

// ── THE GATES ARE BOUND TO THEIR PRODUCERS, NOT RE-TYPED (roborev 63295, Medium) ───────────────
//
// INTERNAL_GATES matches literal sentences that live in two OTHER modules. Nothing coupled them, so
// a routine copy edit on a refusal message would silently reclassify that gate as "founder" and put
// the wall of text back in the founder's feed — with the whole suite green.
//
// That drift had ALREADY happened when this was written: `/reviews? in flight on this branch/`
// could never match `roborev has 2 review(s) in flight on this branch`, because the parenthesised
// plural sits between "review" and the space. Its blast radius was zero only because `workflow.ts`
// substitutes its own "IN FLIGHT" wording for the same verdict — luck, not coverage.
//
// So these tests take the strings FROM the producers. Reword a refusal and this goes red.
import { roborevRefusalMessage } from "../../services/conciergeTools/workflow";
import { roborevMergeGate } from "../../services/mergeGuard/roborev";
import type {
  RoborevBranchState,
  RoborevGateCode,
  RoborevGateVerdict,
} from "../../services/mergeGuard/types";

describe("every real roborev refusal string classifies as an internal gate", () => {
  const BRANCH = "sparkle/agent-0000";
  const verdict = (code: RoborevGateCode, jobIds: number[]): RoborevGateVerdict => ({
    canMerge: false,
    code,
    reason: null,
    jobIds,
  });

  // `workflow.ts` — what the concierge tool actually hands back.
  const codes: RoborevGateCode[] = [
    "roborev-pending",
    "roborev-unresolved",
    "roborev-unknown",
  ];
  for (const code of codes)
    for (const jobIds of [[], [5], [5, 6]])
      for (const acknowledged of [false, true]) {
        const reason = roborevRefusalMessage(verdict(code, jobIds), BRANCH, acknowledged);
        const label = `${code} ids=${jobIds.length} ack=${acknowledged}`;
        it(`classifies workflow's ${label}`, () => {
          // `roborev-unknown` WITH NO JOB IDS is the "we could not read roborev at all" arm, and
          // that one is deliberately the FOUNDER's — a dead daemon must never be withheld. Every
          // other arm names a condition the concierge itself resolves.
          const expected =
            code === "roborev-unknown" && jobIds.length === 0 ? "founder" : "internal";
          expect(refusalAudience(reason), reason.slice(0, 80)).toBe(expected);
        });
      }

  // `mergeGuard/roborev.ts` — the gate underneath it, whose own `reason` strings differ.
  const branchState = (over: Partial<RoborevBranchState>): RoborevBranchState => ({
    applicable: true,
    known: true,
    inFlight: [],
    errored: [],
    blocking: [],
    openPassing: 0,
    total: 0,
    error: null,
    ...over,
  });
  const job = (id: number) => ({ id }) as unknown as RoborevBranchState["inFlight"][number];

  it("classifies roborevMergeGate's in-flight, unread and open-FAIL reasons", () => {
    const cases: [string, Partial<RoborevBranchState>][] = [
      ["in flight", { inFlight: [job(2), job(3)], total: 2 }],
      ["ended without a verdict", { errored: [job(4)], total: 1 }],
      ["open FAIL", { blocking: [job(5)], total: 1 }],
    ];
    for (const [label, over] of cases) {
      const reason = roborevMergeGate(branchState(over)).reason;
      expect(reason, `${label} must produce a reason`).toBeTruthy();
      // THE ASSERTION THAT WOULD HAVE CAUGHT THE DEAD PATTERN: this is the literal
      // "roborev has 2 review(s) in flight on this branch", straight from the producer.
      expect(refusalAudience(reason), `${label}: ${reason}`).toBe("internal");
      expect(refusalGist(reason), `${label}: ${reason}`).toBeTruthy();
    }
  });

  it("a DEAD roborev still reaches the founder, whatever the gate wraps it in", () => {
    // The same producer, carrying a probe error rather than a job state — the shape that splices a
    // tool failure into the gate's own vocabulary.
    const reason = roborevMergeGate(
      branchState({ known: false, error: "failed to connect to daemon (is it running?)" }),
    ).reason;
    expect(reason).toContain("failed to connect");
    expect(refusalAudience(reason)).toBe("founder");
  });

  it("an unreadable roborev with NO error text also reaches the founder", () => {
    // The generic arm: "its state could not be read". Both a repairable store and a dead daemon
    // produce it, so it is deliberately unmatched and defaults to showing.
    const reason = roborevMergeGate(branchState({ known: false })).reason;
    expect(refusalAudience(reason)).toBe("founder");
  });
});
