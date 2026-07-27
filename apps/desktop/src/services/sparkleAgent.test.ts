// The Sparkle improvement agent's persona must BRANCH on the user's consent mode so its actual
// behavior matches what the consent banner promises (bead sparkle-4xwk.1): "always" auto-submits
// after the scrub gate, "case_by_case" never runs `gh pr create` without explicit approval, and
// "never" is chat-only (no log dir, no log-review instructions at all).
import { describe, expect, it } from "vitest";
import {
  ASKABLE_COMMAND_PROHIBITION,
  FINAL_COMMAND_PROHIBITION,
  GH_AUTH_ADVICE_HEADER,
  GH_AUTH_ASK_USER,
  GH_AUTH_ATTENDED_DECLINE,
  GH_MISSING_ATTENDED_DECLINE,
  GH_AUTH_UNATTENDED_STOP,
  GH_SETUP_GIT_AFTER_LOGIN,
  PROPOSE_ONLY_AFTER_ASKING,
  PROPOSE_ONLY_UNCONDITIONAL,
  RETRY_STILL_FAILS_EXIT,
  sparklePersona,
  sparkleMissionPrompt,
  sparkleChatOnlyMissionPrompt,
  sparkleAgentIdFor,
  sparkleOpenSetWhitelist,
  shouldWarmSparkleAtLaunch,
  isSubmitBlocked,
  submitBlockedReason,
  SPARKLE_AGENT_ID,
  type SubmitVerdict,
} from "./sparkleAgent";

// A public user is read-only on the upstream repo, so the agent's last step — `gh pr create` —
// simply cannot work for them. These tests pin the two rules that keeps honest: a blocked machine
// never gets told to submit, and an INCONCLUSIVE probe never downgrades one that can.
describe("submit capability — who may open a PR", () => {
  const BLOCKED: SubmitVerdict[] = ["noPush", "notAuthenticated", "ghMissing"];

  it("blocks only the verdicts that are definitely unable to submit", () => {
    for (const v of BLOCKED) expect(isSubmitBlocked(v)).toBe(true);
    expect(isSubmitBlocked("canSubmit")).toBe(false);
  });

  it('"unknown" is NOT blocked — an offline probe must not mute a maintainer', () => {
    expect(isSubmitBlocked("unknown")).toBe(false);
    expect(submitBlockedReason("unknown", "owner/repo")).toBeNull();
    expect(sparklePersona("/logs", "/repo", "always", "unknown", { attended: false })).not.toContain(
      "SUBMISSION IS NOT AVAILABLE",
    );
  });

  it("every blocked verdict has user-facing copy naming a way forward", () => {
    expect(submitBlockedReason("noPush", "owner/repo")).toContain("owner/repo");
    expect(submitBlockedReason("notAuthenticated", "owner/repo")).toContain("gh auth login");
    expect(submitBlockedReason("ghMissing", "owner/repo")).toContain("isn't installed");
    // Each one promises the same fallback, so the user knows the work isn't lost.
    for (const v of BLOCKED) expect(submitBlockedReason(v, "owner/repo")).toContain("locally");
  });

  // Crossed over ATTENDANCE, which it previously was not. Narrowed to `{ attended: false }`, this
  // was the ONLY test pinning "a blocked machine must not attempt the commands that would 403" —
  // and its assertion string ("Do NOT run", capital D) does not match the attended arm's rewritten
  // bullet at all. So deleting the attended prohibition outright, leaving an agent hammering
  // `gh pr create` at a machine already known to be unauthenticated, left every suite green. That
  // guardrail is the whole reason the permissive askable arm was considered safe, so it is asserted
  // on the exported opener of each arm — neither of which the other arm can satisfy.
  it.each([false, true])("the persona goes propose-only and forbids the commands that would 403 (attended: %s)", (attended) => {
    for (const v of BLOCKED) {
      const persona = sparklePersona("/logs", "/repo", "always", v, { attended });
      expect(persona).toContain("SUBMISSION IS NOT AVAILABLE ON THIS MACHINE");
      // noPush is immutable even with the user present, so it keeps the final arm either way.
      const askable = attended && v !== "noPush";
      expect(persona).toContain(askable ? ASKABLE_COMMAND_PROHIBITION : FINAL_COMMAND_PROHIBITION);
      expect(persona).not.toContain(askable ? FINAL_COMMAND_PROHIBITION : ASKABLE_COMMAND_PROHIBITION);
      // The work still has to happen and still has to be committed — blocked is not "do nothing".
      expect(persona).toContain("COMMIT to a local branch");
      expect(persona).toContain("a complete, successful pass");
    }
  });

  it("the override lands AFTER the consent-mode instructions it has to beat", () => {
    // "always" mode tells the agent to submit automatically; the override must come later in the
    // prompt, or the agent reads the two in the wrong order.
    const persona = sparklePersona("/logs", "/repo", "always", "noPush", { attended: false });
    expect(persona.indexOf("SUBMISSION IS NOT AVAILABLE")).toBeGreaterThan(
      persona.indexOf("WHAT YOU DO"),
    );
  });

  it("a machine that can submit gets the unmodified persona", () => {
    expect(sparklePersona("/logs", "/repo", "always", "canSubmit", { attended: false })).not.toContain(
      "SUBMISSION IS NOT AVAILABLE",
    );
  });
});

// Warming spawns a real claude at app launch, so the gate is the consent contract in code: the
// user who said "Always" gets it unasked; the user who said "Case by case" must have ticked the
// box; "Never" gets nothing. Secondary windows never warm regardless.
describe("shouldWarmSparkleAtLaunch — who may start the agent at app launch", () => {
  const gate = (over: Partial<Parameters<typeof shouldWarmSparkleAtLaunch>[0]> = {}) =>
    shouldWarmSparkleAtLaunch({
      consent: "case_by_case",
      optIn: null,
      isMainWindow: true,
      ...over,
    });

  it('"always" warms without an opt-in — the user already granted standing authority', () => {
    expect(gate({ consent: "always", optIn: null })).toBe(true);
    expect(gate({ consent: "always", optIn: false })).toBe(true);
  });

  it('"case_by_case" warms ONLY on an explicit opt-in; unanswered means opt-out', () => {
    expect(gate({ optIn: null })).toBe(false);
    expect(gate({ optIn: false })).toBe(false);
    expect(gate({ optIn: true })).toBe(true);
  });

  it('"never" never warms, even if the opt-in flag was set under a previous mode', () => {
    expect(gate({ consent: "never", optIn: true })).toBe(false);
  });

  it("a secondary window never warms — one canonical worktree admits one claude", () => {
    expect(gate({ consent: "always", isMainWindow: false })).toBe(false);
    expect(gate({ optIn: true, isMainWindow: false })).toBe(false);
  });
});

describe("sparkleOpenSetWhitelist — cross-window open-set reconcile", () => {
  const MAIN = SPARKLE_AGENT_ID;
  const WIN_A = `${SPARKLE_AGENT_ID}-win-aaaa`;
  const WIN_B = `${SPARKLE_AGENT_ID}-win-bbbb`;

  it("a SECONDARY window preserves every open Sparkle id (never evicts another window's live pane)", () => {
    // Window A boots while the main window AND window B are live — their ids must survive reconcile.
    const kept = sparkleOpenSetWhitelist({
      isMainWindow: false,
      ownId: WIN_A,
      openIds: ["proj-agent-1", MAIN, WIN_B],
    });
    expect(kept).toContain(MAIN); // main window's live pane not evicted
    expect(kept).toContain(WIN_B); // window B's live pane not evicted
    expect(kept).toContain(WIN_A); // own id, even if not yet in the set
    expect(kept).not.toContain("proj-agent-1"); // only Sparkle-namespace ids
  });

  it("own id is included even when absent from the open set (first open)", () => {
    expect(sparkleOpenSetWhitelist({ isMainWindow: false, ownId: WIN_A, openIds: [] })).toEqual([WIN_A]);
  });

  it("the MAIN window's cold boot prunes DEAD secondary ids (only its canonical id survives)", () => {
    // At cold start only the main window is live (multi-window restore deferred), so leftover
    // per-window ids from last session are dead and must be dropped to avoid unbounded growth.
    const kept = sparkleOpenSetWhitelist({
      isMainWindow: true,
      ownId: MAIN,
      openIds: [MAIN, WIN_A, WIN_B],
    });
    expect(kept).toEqual([MAIN]);
    expect(kept).not.toContain(WIN_A);
    expect(kept).not.toContain(WIN_B);
  });
});

describe("sparkleAgentIdFor — per-window identity", () => {
  it("main window uses the canonical id (shared with the hourly pass)", () => {
    expect(sparkleAgentIdFor("main")).toBe(SPARKLE_AGENT_ID);
  });

  it("a secondary window gets a distinct id derived from its label", () => {
    const id = sparkleAgentIdFor("win-abc123");
    expect(id).toBe(`${SPARKLE_AGENT_ID}-win-abc123`);
    expect(id).not.toBe(SPARKLE_AGENT_ID);
  });

  it("distinct windows get distinct ids (so distinct worktrees)", () => {
    expect(sparkleAgentIdFor("win-a")).not.toBe(sparkleAgentIdFor("win-b"));
  });

  it("every id satisfies the Rust worktree validate_id allowlist [A-Za-z0-9_-]", () => {
    // The id is joined into a filesystem path and a git branch name; anything outside this set is
    // rejected by validate_id in worktree.rs. Real labels are "main" / "win-<uuid>".
    for (const label of ["main", "win-01234567-89ab-cdef-0123-456789abcdef"]) {
      expect(sparkleAgentIdFor(label)).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(sparkleAgentIdFor(label).length).toBeLessThanOrEqual(128);
    }
  });
});

const LOG_DIR = "/app-data/logs/sparkle";
const REPO = "/app-data/";

describe("sparklePersona — consent branching", () => {
  it("always: instructs auto-submit via gh pr create with no per-PR approval", () => {
    const p = sparklePersona(LOG_DIR, REPO, "always", "unknown", { attended: false });
    expect(p).toContain(LOG_DIR);
    expect(p).toContain("gh pr create");
    expect(p).toContain("submit automatically");
    expect(p).toContain("no per-PR approval is needed");
  });

  it("case_by_case: forbids unapproved gh pr create and requires present-then-STOP", () => {
    const p = sparklePersona(LOG_DIR, REPO, "case_by_case", "unknown", { attended: false });
    expect(p).toContain(LOG_DIR);
    expect(p).toContain("MUST NOT submit a PR on your own");
    expect(p).toContain("NEVER run");
    expect(p).toContain("`gh pr create` (or `gh pr edit` / `gh pr reopen`)");
    expect(p).toContain("explicitly");
    expect(p).toContain("PRESENT the draft");
    expect(p).toContain("STOP");
  });

  it("never: omits the log dir and every log-review instruction (chat-only)", () => {
    const p = sparklePersona(LOG_DIR, REPO, "never", "unknown", { attended: false });
    expect(p).not.toContain(LOG_DIR);
    expect(p).not.toContain("session logs are available");
    expect(p).not.toContain("Review the logs");
    expect(p).not.toContain("Treat the logs as sensitive");
    expect(p).toContain("CHAT-ONLY");
    // It still works on the app-owned clone and can act on user requests.
    expect(p).toContain(REPO);
  });

  it("never: user-directed PRs still require explicit approval before gh pr create", () => {
    const p = sparklePersona(LOG_DIR, REPO, "never", "unknown", { attended: false });
    expect(p).toContain("explicit go-ahead");
    expect(p).toContain("`gh pr create`");
  });

  it.each(["always", "case_by_case", "never"] as const)(
    "%s: carries the dedupe gate so work already in flight isn't re-filed",
    (mode) => {
      const p = sparklePersona(LOG_DIR, REPO, mode, "unknown", { attended: false });
      expect(p).toContain("DEDUPE GATE");
      // It must name the concrete check, not just gesture at "avoid duplicates".
      expect(p).toContain("gh pr list --state open");
      expect(p).toContain("gh pr list --state merged");
      expect(p).toContain("do NOT open another one");
    },
  );

  it.each(["always", "case_by_case", "never"] as const)(
    "%s: the dedupe gate survives an unauthenticated gh instead of failing open",
    (mode) => {
      const p = sparklePersona(LOG_DIR, REPO, mode, "unknown", { attended: false });
      // `gh pr list` needs an authenticated gh; git does not. Without a stated fallback the gate
      // silently no-ops on such a machine, which is the exact condition under which duplicate
      // work is most likely (nothing else is telling the agent what is already in flight).
      expect(p).toContain("the gate is");
      expect(p).toContain("NOT waived");
      expect(p).toContain("git ls-remote --heads origin");
      expect(p).toContain("git log origin/main --oneline");
      // A branch-name scan alone misses duplicates that describe the same fix differently, so the
      // fallback has to send the agent at the touched files.
      expect(p).toContain("git diff --stat origin/main...origin/<branch>");
    },
  );

  it.each(["always", "case_by_case"] as const)(
    "%s: explains the repeating-pass loop the gate exists to break",
    (mode) => {
      const p = sparklePersona(LOG_DIR, REPO, mode, "unknown", { attended: false });
      expect(p).toContain("You run repeatedly");
      expect(p).toContain("the bottleneck is review, not discovery");
    },
  );

  it("never: the dedupe gate drops its log-mining premise in a chat-only session", () => {
    const p = sparklePersona(LOG_DIR, REPO, "never", "unknown", { attended: false });
    // The check still applies — a requested change may already be in flight...
    expect(p).toContain("DEDUPE GATE");
    expect(p).toContain("already be in flight");
    // ...but nothing may assert this session mines logs on a repeating schedule.
    expect(p).not.toContain("You run repeatedly");
    expect(p).not.toContain("the bottleneck is review, not discovery");
    expect(p).not.toContain("keeps showing up in");
  });

  it.each(["always", "case_by_case"] as const)(
    "%s: gates deduping BEFORE the spec step, not after implementation",
    (mode) => {
      const p = sparklePersona(LOG_DIR, REPO, mode, "unknown", { attended: false });
      expect(p).toContain("Run the DEDUPE GATE below on every candidate");
      // Ordering is the whole point: dedupe has to precede spec-writing, which precedes the PR.
      const dedupeStep = p.indexOf("Run the DEDUPE GATE below on every candidate");
      const specStep = p.indexOf("write a short, well-scoped spec");
      const prStep = p.indexOf("gh pr create");
      expect(dedupeStep).toBeGreaterThan(-1);
      expect(dedupeStep).toBeLessThan(specStep);
      expect(specStep).toBeLessThan(prStep);
    },
  );

  it.each(["always", "case_by_case", "never"] as const)(
    "%s: carries the hard scrub gate before any PR submission",
    (mode) => {
      const p = sparklePersona(LOG_DIR, REPO, mode, "unknown", { attended: false });
      expect(p).toContain("PII SCRUB GATE");
      expect(p).toContain("scripts/sparkle-scrub.sh");
      expect(p).toContain("DO NOT SUBMIT");
      // The baseline privacy contract survives in every mode.
      expect(p).toContain("PRIVACY — THIS IS A HARD DEFAULT");
    },
  );
});

// `gh auth setup-git` cannot authenticate — with no logged-in host it exits 1 ("You are not
// logged into any GitHub hosts"). The persona used to prescribe it as the fix for a push that
// fails on auth, which is a dead end in exactly that case: an unattended pass retried something
// that can never succeed and had no instruction for what to do instead. Every mode that can reach
// a remote must therefore name the interactive `gh auth login` as the real remedy AND give the
// unattended agent a terminal action, so the guidance can't silently regress to the retry loop.
describe("sparklePersona — gh auth failure advice", () => {
  const REMOTE_MODES = ["always", "case_by_case", "never"] as const;

  it.each(REMOTE_MODES)("%s: names gh auth login and does not prescribe a doomed retry", (mode) => {
    const p = sparklePersona(LOG_DIR, REPO, mode, "unknown", { attended: false });
    expect(p).toContain("gh auth status");
    expect(p).toContain("gh auth login");
    // setup-git survives ONLY as the logged-in-but-no-credential-helper case, never as the
    // remedy for being logged out.
    expect(p).toContain("will NOT fix it");
    expect(p).toContain("Do not retry in a loop");
  });

  // ATTENDANCE IS THE AXIS, NOT CONSENT. The interactive pane and the headless hourly pass call
  // sparklePersona with the SAME consent value — `case_by_case` is the default and runs in both —
  // so pinning this to the mode would cement a conflation that hands a headless pass an
  // instruction to ask a user who isn't there. Every mode is therefore exercised on both sides.
  it.each(REMOTE_MODES)("%s UNATTENDED: stops with the work committed, whatever the mode", (mode) => {
    const p = sparklePersona(LOG_DIR, REPO, mode, "unknown", { attended: false });
    // On the exported branch openers, not loose prose: several of these sentences legitimately
    // appear on BOTH sides (the gh-not-found lines say "committed on its branch" either way), so a
    // whole-persona scan would read as strict while discriminating nothing.
    expect(p).toContain(GH_AUTH_UNATTENDED_STOP);
    expect(p).not.toContain(GH_AUTH_ASK_USER);
    expect(p).not.toContain(GH_AUTH_ATTENDED_DECLINE);
  });

  it.each(REMOTE_MODES)("%s ATTENDED: asks the user to authenticate, then retries", (mode) => {
    const p = sparklePersona(LOG_DIR, REPO, mode, "unknown", { attended: true });
    expect(p).toContain(GH_AUTH_ASK_USER);
    expect(p).not.toContain(GH_AUTH_UNATTENDED_STOP);
    expect(p).toContain("retry the push once they confirm");
    // Giving up survives only as the fallback for a user who declines — asserted on this arm's own
    // constant, since the bare phrase "Only if they decline" is a prefix of the gh-missing arm's
    // and was therefore satisfied by the OTHER arm of the same persona.
    expect(p).toContain(GH_AUTH_ATTENDED_DECLINE);
    // Which ARM each fallback lands under, not just that both are present: the gh-missing bullet
    // precedes the not-logged-in one, so moving either constant into the other's block (which would
    // strip an arm of its terminal action) inverts this. Whole-persona membership scans cannot see
    // that — every assertion here runs against one flat string.
    expect(p.indexOf(GH_MISSING_ATTENDED_DECLINE)).toBeLessThan(p.indexOf(GH_AUTH_ATTENDED_DECLINE));
    // The period now lives inside the constants; a call site that re-appends one is invisible to
    // toContain, so catch the ".." it would produce. Both lookarounds are required: the persona
    // legitimately contains `git diff --stat origin/main...origin/<branch>`, and without the
    // LOOKBEHIND this matches the last two dots of that three-dot range.
    expect(p).not.toMatch(/(?<!\.)\.\.(?!\.)/);
    // And the unattended premise must not leak into a session that has a user in it.
    expect(p).not.toContain("cannot complete it unattended");
  });

  it.each(REMOTE_MODES)("%s: names a terminal action when gh is missing entirely", (mode) => {
    // `gh auth status` itself errors with no gh installed, so without this case the branch table
    // sends the agent to a command that cannot answer and leaves it with nowhere to go.
    const unattended = sparklePersona(LOG_DIR, REPO, mode, "unknown", { attended: false });
    expect(unattended).toContain("`gh` not found at all");
    expect(unattended).toContain("report that gh is not installed");

    // Attended, "install it and tell me" is the right action — and it is what submitBlockedReason
    // already tells the UI ("Install it to enable submission"), so the agent must not contradict
    // the pane by giving up in front of the person who can fix it.
    const attended = sparklePersona(LOG_DIR, REPO, mode, "unknown", { attended: true });
    expect(attended).toContain("TELL the user gh is not installed");
    // The decline fallback is the behavior most at risk here: without it the attended arm just
    // stops, waiting on a user who may never install gh — the dead end, moved sides. Asserted on
    // its OWN fragment, since "Only if they decline" is shared with the not-logged-in arm and so
    // discriminates nothing, and held to the attended side by the negative below.
    expect(attended).toContain(GH_MISSING_ATTENDED_DECLINE);
    expect(unattended).not.toContain(GH_MISSING_ATTENDED_DECLINE);
  });

  // Crossed over BOTH axes on purpose: the `blocked ? [] : …` gate is applied at three separate
  // call sites, so a future edit that drops it from one mode would reintroduce the contradiction
  // with a single-mode test still green. Asserted on the exported header rather than a prose
  // fragment, which would pass vacuously the moment someone rewords the line.
  it.each(
    REMOTE_MODES.flatMap((mode) =>
      (["notAuthenticated", "noPush", "ghMissing"] as const).map((verdict) => [mode, verdict] as const),
    ),
  )("%s + %s: the propose-only override is the ONLY story about auth", (mode, verdict) => {
    const p = sparklePersona(LOG_DIR, REPO, mode, verdict, { attended: false });
    expect(p).not.toContain(GH_AUTH_ADVICE_HEADER);
    // The override itself is still there, so the agent is told what it may not do.
    expect(p).toContain("gh auth setup-git");
  });

  it("unknown verdict keeps the advice: a failed probe must not silence it", () => {
    // "unknown" means the capability probe failed (offline, transient), which is explicitly NOT a
    // reason to downgrade a maintainer's agent — so the auth guidance must survive.
    const p = sparklePersona(LOG_DIR, REPO, "always", "unknown", { attended: false });
    expect(p).toContain(GH_AUTH_ADVICE_HEADER);
  });
});

describe("mission prompts", () => {
  it("the standard mission prompt starts a log-review pass", () => {
    expect(sparkleMissionPrompt()).toContain("session logs");
  });

  it("the chat-only mission prompt introduces the agent and notes log evaluation is off", () => {
    const p = sparkleChatOnlyMissionPrompt();
    expect(p).toContain("Introduce yourself");
    expect(p).toContain("log evaluation");
    expect(p).not.toContain("skim");
  });
});

// The blocked-verdict override was attendance-blind, so the affordance this file's auth advice adds
// never reached the verdict it was written for: notAuthenticated sets `blocked`, which suppresses
// the advice, and the override then told the agent this is "not something you can retry your way
// past". For an attended session that is false — the person who can fix it in one command is in the
// chat — so an interactive pass implemented, committed, and reported the PR unsubmittable without
// ever asking.
describe("sparklePersona — blocked verdicts that the present user can clear", () => {
  const FIXABLE = ["notAuthenticated", "ghMissing"] as const;

  it.each(FIXABLE)("%s ATTENDED + always: asks, then may submit once they confirm", (verdict) => {
    const p = sparklePersona(LOG_DIR, REPO, "always", verdict, { attended: true });
    expect(p).toContain("the user IS here");
    expect(p).toContain("try the submission once more rather than treating the");
    expect(p).not.toContain("not something you can retry your way past");
    // Still propose-only until they act, and still a complete pass if they don't.
    expect(p).toContain("COMMIT to a local branch");
  });

  // This block is emitted AFTER the consent instructions and claims to override them, so anything
  // permissive in it must restate the limit it is NOT overriding. Confirming `gh auth login` is not
  // approval of a pull request, and case_by_case is DEFAULT_SPARKLE_CONSENT — so the most common
  // attended configuration is exactly the one where a bare "submit once more" would open a PR
  // against the user's stated consent because they helpfully said "ok, I'm logged in".
  it.each(["case_by_case", "never"] as const)(
    "%s ATTENDED: the unblock does NOT waive per-PR approval",
    (consent) => {
      const p = sparklePersona(LOG_DIR, REPO, consent, "notAuthenticated", { attended: true });
      expect(p).toContain("the user IS here");
      expect(p).toContain("their explicit approval as your consent mode requires");
      expect(p).toContain("logging in is not approval of a PR");
      expect(p).not.toContain("try the submission once more");
    },
  );

  it.each(FIXABLE)("%s ATTENDED: the user runs the login, never the agent", (verdict) => {
    // The dead end this whole branch removes, one layer down: `gh auth login` is an interactive TUI,
    // so an agent that runs it in its own shell hangs until the tool timeout.
    const p = sparklePersona(LOG_DIR, REPO, "always", verdict, { attended: true });
    expect(p).toContain("IN THEIR TERMINAL");
    expect(p).toContain("`gh auth login` YOURSELF");
  });

  it("ghMissing does not claim the INSTALL is interactive — only the login is", () => {
    // `brew install gh` is not interactive and is exactly the kind of command an agent could run;
    // asserting otherwise is the same false-fact-about-the-world defect this branch fixed twice.
    // It is also two commands, not one, and brew is macOS-only.
    const p = sparklePersona(LOG_DIR, REPO, "always", "ghMissing", { attended: true });
    expect(p).toContain("that login is interactive");
    expect(p).toContain("their platform's package manager");
    expect(p).not.toContain("it is one command");
  });

  it.each(FIXABLE)("%s UNATTENDED: keeps the flat, final wording", (verdict) => {
    const p = sparklePersona(LOG_DIR, REPO, "always", verdict, { attended: false });
    expect(p).toContain("not something you can retry your way past");
    expect(p).not.toContain("the user IS here");
  });

  // (a) The ask and the stop cannot sit next to each other unconditionally. The permissive arm ends
  // "…then submit once more"; the propose-only tail used to begin, at the same list level and with
  // no condition at all, "- Work PROPOSE-ONLY instead: … and stop there." Models weight the later,
  // flatter instruction, so the attended agent asked, the user logged in, and it stopped anyway —
  // the exact failure this branch exists to prevent. The old assertion (`"COMMIT to a local
  // branch"`) passed either way and so pinned the contradiction rather than resolving it.
  it.each(FIXABLE)("%s ATTENDED: the propose-only tail is CONDITIONAL, not a flat stop", (verdict) => {
    const p = sparklePersona(LOG_DIR, REPO, "always", verdict, { attended: true });
    expect(p).toContain(PROPOSE_ONLY_AFTER_ASKING);
    expect(p).not.toContain(PROPOSE_ONLY_UNCONDITIONAL);
    // Still reached, just no longer unconditionally: the fallback body is unchanged.
    expect(p).toContain("COMMIT to a local branch");
  });

  it.each(FIXABLE)("%s UNATTENDED: the tail stays unconditional — nobody is here to decline", (verdict) => {
    const p = sparklePersona(LOG_DIR, REPO, "always", verdict, { attended: false });
    expect(p).toContain(PROPOSE_ONLY_UNCONDITIONAL);
    expect(p).not.toContain(PROPOSE_ONLY_AFTER_ASKING);
  });

  // (b) The retry the askable arm newly authorizes has a likely failure with exactly one remedy,
  // and that remedy lived only in ghAuthAdvice — which every blocked verdict suppresses. The
  // askable arm also drops `gh auth setup-git` from its prohibition list, so before this the
  // command was permitted and never prescribed: user runs `gh auth login`, git has no credential
  // helper, the retried push fails on credentials, and nothing in the prompt says what to do.
  it.each(FIXABLE)("%s ATTENDED: names the setup-git remedy for the retry it authorizes", (verdict) => {
    const p = sparklePersona(LOG_DIR, REPO, "always", verdict, { attended: true });
    expect(p).toContain(GH_SETUP_GIT_AFTER_LOGIN);
    // And it is scoped to AFTER the login lands — prescribing it earlier is the dead end this
    // branch removed in the first place (it exits 1 with no authenticated host).
    expect(p).toContain("It works only after their login has landed");
  });

  it.each(FIXABLE)("%s UNATTENDED: setup-git stays forbidden — no login can land", (verdict) => {
    const p = sparklePersona(LOG_DIR, REPO, "always", verdict, { attended: false });
    expect(p).not.toContain(GH_SETUP_GIT_AFTER_LOGIN);
    expect(p).toContain("`gh auth setup-git`");
  });

  // (c) BOTH attended arms must name the tried-but-still-failed exit, not just `always`.
  // case_by_case is DEFAULT_SPARKLE_CONSENT, so the arm that was missing it is the one the most
  // common attended configuration actually reads.
  it.each(["always", "case_by_case", "never"] as const)(
    "%s ATTENDED: names BOTH exits — declined, and tried-but-still-failed",
    (consent) => {
      const p = sparklePersona(LOG_DIR, REPO, consent, "notAuthenticated", { attended: true });
      expect(p).toContain(RETRY_STILL_FAILS_EXIT);
    },
  );

  it("noPush stays final even attended — the account genuinely lacks write access", () => {
    // The distinction that matters: no command the user runs in their terminal grants push rights,
    // so asking them would be a dead end of exactly the kind this branch removes.
    const p = sparklePersona(LOG_DIR, REPO, "always", "noPush", { attended: true });
    expect(p).toContain("not something you can retry your way past");
    expect(p).not.toContain("the user IS here");
  });
});
