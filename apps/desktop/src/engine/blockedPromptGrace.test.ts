// The grace window's rules, driven through the real `notePromptEpisodes` → `withBlockedPromptGrace`
// pair rather than by hand-building ledgers — a ledger written by the test is a ledger the production
// stamper never has to agree with, and the stamping rule (when an episode opens, when it is burned)
// is the half most likely to be wrong.
import { describe, expect, it } from "vitest";

import {
  BLOCKED_PROMPT_GRACE_MS,
  answerOutcomeForPath,
  emptyPromptGraceLedger,
  notePromptAnswerOutcome,
  notePromptEpisodes,
  nextPromptGraceExpiry,
  promptEpisodeKey,
  withBlockedPromptGrace,
  type PromptAsk,
  type PromptGraceLedger,
} from "./blockedPromptGrace";
import type { AgentTabStatus } from "../types";

const T0 = 1_700_000_000_000;
const AGENT = [{ id: "a" }];
/** The engine's generous ceiling, for an open that follows a reported `handled`. Mirrored so the
 *  bound test asserts the real number rather than "some finite amount". */
const ANSWERED_CAP = 6;
/** The per-agent burn cap in the engine. Mirrored here because the eviction test has to assert the
 *  set actually SITS at it — a flood that never reaches the cap tests nothing. */
const BURN_CAP = 64;
/** Just past {@link BURN_CAP}, so the eviction loop runs — each open costs a whole budget window of
 *  simulated time now, so there is no point flooding further. */
const BURN_FLOOD = 70;
/** The engine's rolling budget window, for spacing that flood. */
const HOLD_BUDGET_WINDOW_MS = 5 * 60_000;
const PROMPT = "Bash command\n\n  git status\n\nDo you want to proceed?\n 1. Yes\n 2. No";

/** Explicit "the caller captured no screen at all". A bare `undefined` argument would select the
 *  default below rather than overriding it, which is how this test first passed vacuously. */
const NO_ASK = "no-ask" as const;

/** Run one tick of the production pair and return the published status for `a`. */
function tick(
  ledger: PromptGraceLedger,
  status: AgentTabStatus,
  now: number,
  ask: PromptAsk | typeof NO_ASK = { text: PROMPT, at: T0 },
  agents: readonly { id: string }[] = AGENT,
): AgentTabStatus | undefined {
  const map: Record<string, AgentTabStatus> = Object.fromEntries(agents.map((a) => [a.id, status]));
  notePromptEpisodes(
    ledger,
    map,
    () => (ask === NO_ASK ? undefined : ask),
    now,
    agents.map((a) => a.id),
  );
  return withBlockedPromptGrace(agents, map, ledger, now)["a"];
}

describe("the hold itself", () => {
  it("hides a fresh approval prompt, and the un-held map is red — so this is not vacuous", () => {
    const ledger = emptyPromptGraceLedger();
    // The SAME status through an EMPTY ledger stays red. Without this the assertion below would pass
    // against a build where the overlay does nothing at all.
    expect(withBlockedPromptGrace(AGENT, { a: "approval" }, emptyPromptGraceLedger(), T0)["a"]).toBe(
      "approval",
    );
    expect(tick(ledger, "approval", T0 + 1_000)).toBe("idle");
  });

  it("holds `waiting` too, and never `blocked`", () => {
    expect(tick(emptyPromptGraceLedger(), "waiting", T0 + 1_000)).toBe("idle");
    // `blocked` is a quota limit or a stall timer — no answerer is coming, so it must stay red.
    expect(tick(emptyPromptGraceLedger(), "blocked", T0 + 1_000)).toBe("blocked");
  });

  it("returns the SAME map reference when nothing is held (no render churn)", () => {
    const map: Record<string, AgentTabStatus> = { a: "approval" };
    expect(withBlockedPromptGrace(AGENT, map, emptyPromptGraceLedger(), T0)).toBe(map);
  });

  it("refuses to hold a prompt it cannot identify — an unreadable screen goes straight to red", () => {
    expect(tick(emptyPromptGraceLedger(), "approval", T0 + 1_000, { text: "   \n\n  ", at: T0 })).toBe(
      "approval",
    );
    expect(tick(emptyPromptGraceLedger(), "approval", T0 + 1_000, NO_ASK)).toBe("approval");
  });
});

describe("the three things that END a hold", () => {
  it("1. UNREACHABLE surfaces it immediately", () => {
    const ledger = emptyPromptGraceLedger();
    expect(tick(ledger, "approval", T0 + 1_000)).toBe("idle");
    notePromptAnswerOutcome("a", "unreachable", T0 + 2_000, ledger);
    expect(tick(ledger, "approval", T0 + 2_500)).toBe("approval");
  });

  it("2. DECLINED surfaces it immediately", () => {
    const ledger = emptyPromptGraceLedger();
    expect(tick(ledger, "approval", T0 + 1_000)).toBe("idle");
    notePromptAnswerOutcome("a", "declined", T0 + 2_000, ledger);
    expect(tick(ledger, "approval", T0 + 2_500)).toBe("approval");
  });

  it("3. the CEILING is real — a silent answerer cannot hide it past the window", () => {
    const ledger = emptyPromptGraceLedger();
    // Nothing is ever reported. This is the wedged/dead-answerer case, and the clock is the only
    // thing standing between the founder and an invisible prompt.
    expect(tick(ledger, "approval", T0 + BLOCKED_PROMPT_GRACE_MS - 1)).toBe("idle");
    expect(tick(ledger, "approval", T0 + BLOCKED_PROMPT_GRACE_MS)).toBe("approval");
  });

  it("`handled` is NOT an end condition — a delivered answer keeps the hold", () => {
    const ledger = emptyPromptGraceLedger();
    notePromptAnswerOutcome("a", "handled", T0 + 500, ledger);
    expect(tick(ledger, "approval", T0 + 1_000)).toBe("idle");
  });

  it("ignores an outcome that predates the episode — it described a different prompt", () => {
    const ledger = emptyPromptGraceLedger();
    notePromptAnswerOutcome("a", "unreachable", T0 - 5_000, ledger);
    expect(tick(ledger, "approval", T0 + 1_000)).toBe("idle");
  });
});

describe("NEVER SUPPRESS THE SAME PROMPT TWICE", () => {
  it("a re-raised identical prompt goes red on sight", () => {
    const ledger = emptyPromptGraceLedger();
    expect(tick(ledger, "approval", T0 + 1_000)).toBe("idle"); // first sighting: held
    // The answerer failed and the pane redrew: leave the ask (episode closes) …
    expect(tick(ledger, "working", T0 + 2_000)).toBe("working");
    // … and draw the very same question again. It must NOT be held.
    expect(tick(ledger, "approval", T0 + 3_000, { text: PROMPT, at: T0 + 3_000 })).toBe("approval");
  });

  it("a DIFFERENT prompt on the same agent is still held", () => {
    const ledger = emptyPromptGraceLedger();
    expect(tick(ledger, "approval", T0 + 1_000)).toBe("idle");
    expect(tick(ledger, "working", T0 + 2_000)).toBe("working");
    expect(
      tick(ledger, "approval", T0 + 3_000, { text: "Write file src/x.ts?\n 1. Yes\n 2. No", at: T0 + 3_000 }),
    ).toBe("idle");
  });

  it("the loop cannot be re-armed by cycling: held once, red on every later appearance", () => {
    const ledger = emptyPromptGraceLedger();
    const seen: (AgentTabStatus | undefined)[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(tick(ledger, "approval", T0 + i * 10_000, { text: PROMPT, at: T0 + i * 10_000 }));
      tick(ledger, "working", T0 + i * 10_000 + 1);
    }
    expect(seen).toEqual(["idle", "approval", "approval", "approval"]);
  });

  it("burns the identity even when the hold never rendered (already-lapsed ceiling)", () => {
    const ledger = emptyPromptGraceLedger();
    // Drawn long ago: the episode opens already past its ceiling, so it is never actually hidden …
    expect(tick(ledger, "approval", T0 + 60_000, { text: PROMPT, at: T0 })).toBe("approval");
    tick(ledger, "working", T0 + 60_001);
    // … and it still must not get a window on its next appearance. Erring toward showing the founder.
    expect(tick(ledger, "approval", T0 + 70_000, { text: PROMPT, at: T0 + 70_000 })).toBe("approval");
  });
});

describe("prompt identity", () => {
  it("ignores ANSI colour and moving spinners/counters — a redraw is the same question", () => {
    const plain = "Do you want to proceed?\n 1. Yes\n 2. No";
    expect(promptEpisodeKey(`\x1b[1;32m${plain}\x1b[0m`)).toBe(promptEpisodeKey(plain));
    expect(promptEpisodeKey("⠋ building\nProceed?")).toBe(promptEpisodeKey("⠹ building\nProceed?"));
    expect(promptEpisodeKey("(3/9) Proceed?")).toBe(promptEpisodeKey("(7/9) Proceed?"));
  });

  it("distinguishes questions that differ only in the command being approved", () => {
    expect(promptEpisodeKey("Bash: git status\nProceed?")).not.toBe(
      promptEpisodeKey("Bash: rm -rf build/\nProceed?"),
    );
  });

  it("has NO identity for an empty screen — never a global constant every agent collides on", () => {
    expect(promptEpisodeKey("")).toBe("");
    expect(promptEpisodeKey("  \n \n")).toBe("");
  });

  it("a spinner redraw does not open a second episode (which would re-arm the window)", () => {
    const ledger = emptyPromptGraceLedger();
    tick(ledger, "approval", T0 + 1_000, { text: `⠋ ${PROMPT}`, at: T0 });
    tick(ledger, "approval", T0 + 2_000, { text: `⠹ ${PROMPT}`, at: T0 + 2_000 });
    // Still measured from the ORIGINAL draw, so the ceiling still lands where it should.
    expect(tick(ledger, "approval", T0 + BLOCKED_PROMPT_GRACE_MS, { text: `⠸ ${PROMPT}`, at: T0 })).toBe(
      "approval",
    );
  });
});

// The two defects roborev 62838 found in the first draft. Both were INVISIBLE to the suite as first
// written: the churn test used a braille spinner (which IS normalised), and nothing ever ticked with
// a partial status map. Each of these fails against that draft.
describe("regressions the first draft shipped", () => {
  it("HIGH: a key that churns EVERY tick cannot hold the prompt indefinitely", () => {
    const ledger = emptyPromptGraceLedger();
    // `esc to interrupt · 12s` is a real Claude Code footer, and `steady` does not normalise a bare
    // seconds readout. The first draft measured the ceiling off the EPISODE and had no budget, so
    // every re-capture opened a new episode, restarted the 30s, and hid the prompt forever.
    const screenAt = (s: number): PromptAsk => ({
      text: `${PROMPT}\n  esc to interrupt · ${s}s · ↑ ${s}.4k tokens · ${s * 7} files`,
      at: T0 + s * 1_000,
    });
    const seen = Array.from({ length: 8 }, (_, s) => tick(ledger, "approval", T0 + s * 1_000, screenAt(s)));
    // The hold budget is spent by the second distinct key and cannot be replenished by churning:
    // two windows, then red, however long the chrome keeps moving.
    expect(seen).toEqual(["idle", "idle", "approval", "approval", "approval", "approval", "approval", "approval"]);
    // …and still red a long way past any single window, which is the property that was broken. The
    // guarantee is a DUTY CYCLE, not a one-shot: at most MAX_HOLDS_PER_WINDOW windows per rolling
    // HOLD_BUDGET_WINDOW_MS, so however long the chrome keeps moving the founder sees the question
    // for the great majority of the ask. "Bounded", not "hidden forever", is the whole claim.
    expect(tick(ledger, "approval", T0 + 4 * BLOCKED_PROMPT_GRACE_MS, screenAt(300))).toBe("approval");
  });

  it("MEDIUM: a SECOND distinct question in one continuous ask gets its own window", () => {
    const ledger = emptyPromptGraceLedger();
    // The burst this feature exists for — `git status` then `cargo check` — where the intermediate
    // `working` is never sampled by a feed rebuild. An ask-scoped clock gave the second question only
    // the remainder of the first's window (usually none), so only the first prompt was ever held.
    expect(tick(ledger, "approval", T0, { text: "Bash: git status\nProceed?", at: T0 })).toBe("idle");
    expect(
      tick(ledger, "approval", T0 + 29_000, { text: "Bash: cargo check\nProceed?", at: T0 + 29_000 }),
    ).toBe("idle");
    // Its own window, measured from ITS capture — not the remains of the first question's.
    expect(
      tick(ledger, "approval", T0 + 29_000 + BLOCKED_PROMPT_GRACE_MS, {
        text: "Bash: cargo check\nProceed?",
        at: T0 + 29_000,
      }),
    ).toBe("approval");
  });

  it("MEDIUM: an ANSWERED question does not disqualify the next one in the same ask", () => {
    const ledger = emptyPromptGraceLedger();
    expect(tick(ledger, "approval", T0, { text: "Bash: git status\nProceed?", at: T0 })).toBe("idle");
    // A was answered, so A is gone and B is genuinely the next question.
    notePromptAnswerOutcome("a", "handled", T0 + 500, ledger);
    expect(tick(ledger, "approval", T0 + 1_000, { text: "Bash: cargo check\nProceed?", at: T0 + 1_000 })).toBe(
      "idle",
    );
  });

  it("MEDIUM: a GAVE-UP outcome is not thrown away by the next redraw", () => {
    // The paired opposite, and the one that used to leak. `declined`/`unreachable` mean the question
    // is STILL ON SCREEN unanswered, so anything appearing next is that question redrawn — and the
    // episode re-opening moved `startedAt` past the outcome, which discarded it and re-hid the
    // prompt for another window. Rule 2 says declining surfaces it immediately; this is what makes
    // that hold for longer than one frame.
    const ledger = emptyPromptGraceLedger();
    expect(tick(ledger, "approval", T0, { text: "Bash: git status\nProceed?", at: T0 })).toBe("idle");
    notePromptAnswerOutcome("a", "declined", T0 + 500, ledger);
    expect(tick(ledger, "approval", T0 + 600, { text: "Bash: git status\nProceed?", at: T0 })).toBe(
      "approval",
    );
    // A redraw whose key churns (file counts are not normalised) must NOT win the hold back — and
    // NOR MAY THE ONE AFTER IT. Comparing the outcome against the episode's own `startedAt` made the
    // rule survive exactly one redraw: the ineligible re-open re-stamped `startedAt` past the
    // outcome, so the next churn read "nothing decided" and fell back to the budget, which still had
    // room (roborev 62886). The third tick is the one that fails against that.
    // …AND A BLANK REPAINT MUST NOT ERASE IT EITHER. The give-up used to live on the episode, and a
    // capture with no readable question deletes the episode — a SCREEN event this module expects
    // mid-ask. One of those wiped the flag and the next churn hid the declined prompt again
    // (roborev 62894). It lives on the ledger now, cleared only by the agent leaving the ask.
    expect(tick(ledger, "approval", T0 + 1_500, { text: "   \n  ", at: T0 + 1_500 })).toBe("approval");
    const churn = ["7 files", "14 files", "21 files", "28 files"];
    const after = churn.map((tail, i) =>
      tick(ledger, "approval", T0 + 2_000 + i * 1_000, {
        text: `Bash: git status\nProceed?\n${tail}`,
        at: T0 + 2_000 + i * 1_000,
      }),
    );
    expect(after).toEqual(["approval", "approval", "approval", "approval"]);
  });

  it("MEDIUM: a stream of `handled`s cannot buy an UNBOUNDED run of holds", () => {
    // `handled` is weaker evidence than "the question is gone": answerOutcomeForPath maps `queued`
    // to it, and the auto-approver reports it when the WRITE RESOLVES — the bytes were sent, not that
    // the picker accepted them. So an agent in a retry loop, drawing a slightly different prompt each
    // cycle so the burn set never matches, must not be able to hide behind a stream of them. The
    // uncharged bypass this replaces made that run unbounded (roborev 62886).
    const ledger = emptyPromptGraceLedger();
    const seen: (AgentTabStatus | undefined)[] = [];
    for (let i = 0; i < 10; i++) {
      const at = T0 + i * 1_000;
      seen.push(tick(ledger, "approval", at, { text: `retry ${i}\nProceed?`, at }));
      notePromptAnswerOutcome("a", "handled", at + 1, ledger);
    }
    // Finite, and the tail is red — the founder gets the question back inside one budget window.
    expect(seen.filter((v) => v === "idle").length).toBe(ANSWERED_CAP);
    expect(seen[seen.length - 1]).toBe("approval");
  });

  it("MEDIUM: an unrelated `handled` cannot ERASE a give-up and re-hide the row", () => {
    // `outcome` is per-agent and latest-wins, and the dispatcher reports on EVERY send — a free-text
    // message, a queued send flushing, a recovery ping — all `handled`. Without the latch a later
    // one overwrote the decline that had already surfaced the row and put it back into hiding until
    // the ceiling, on an event that said nothing about the prompt (roborev 62848).
    const ledger = emptyPromptGraceLedger();
    expect(tick(ledger, "approval", T0)).toBe("idle");
    notePromptAnswerOutcome("a", "declined", T0 + 500, ledger);
    expect(tick(ledger, "approval", T0 + 600)).toBe("approval");
    // Something entirely unrelated is delivered to this agent.
    notePromptAnswerOutcome("a", "handled", T0 + 700, ledger);
    expect(tick(ledger, "approval", T0 + 800)).toBe("approval");
  });

  it("MEDIUM: a give-up that arrives while the screen is UNREADABLE is still recorded", () => {
    // The mirror ordering, and the LIKELIER one for `unreachable`: the screen states that make a
    // capture unreadable (alternate-screen, pty-gone, a full-screen app owning the grid) are the
    // same ones that produce it. Recording used to need an open episode, and an unreadable capture
    // deletes the episode — so this ordering lost the give-up entirely (roborev 62897).
    const ledger = emptyPromptGraceLedger();
    expect(tick(ledger, "approval", T0)).toBe("idle");
    // The grid goes unreadable: the episode is dropped …
    expect(tick(ledger, "approval", T0 + 400, { text: "   \n ", at: T0 + 400 })).toBe("approval");
    // … and only THEN does the answerer report it could not reach the pane.
    notePromptAnswerOutcome("a", "unreachable", T0 + 500, ledger);
    // The question comes back readable. It must NOT be held again.
    expect(tick(ledger, "approval", T0 + 600, { text: PROMPT, at: T0 + 600 })).toBe("approval");
  });

  it("MEDIUM: LEAVING the ask clears the give-up — it is sticky for the ask, not for the agent", () => {
    // The other side of making it sticky. If leaving the ask did not clear it, one decline would
    // permanently disable the hold for that agent — the feature quietly inert for anyone who ever
    // hit a prompt the answerer declined, which is most agents.
    const ledger = emptyPromptGraceLedger();
    expect(tick(ledger, "approval", T0, { text: "Bash: git status\nProceed?", at: T0 })).toBe("idle");
    notePromptAnswerOutcome("a", "declined", T0 + 500, ledger);
    expect(tick(ledger, "approval", T0 + 600, { text: "Bash: git status\nProceed?", at: T0 })).toBe(
      "approval",
    );
    // The agent goes back to work — the one event that ends the ask …
    expect(tick(ledger, "working", T0 + 1_000)).toBe("working");
    // … and a later, different question is held normally again.
    expect(tick(ledger, "approval", T0 + 2_000, { text: "Bash: cargo check\nProceed?", at: T0 + 2_000 })).toBe(
      "idle",
    );
  });

  it("MEDIUM: a burst of ANSWERED prompts stays covered past the churn budget", () => {
    // The budget bounds CHURN, not coverage. Four routine prompts in two minutes — the exact
    // sequence the module header names — must all be held; charging every open put prompts 3 and 4
    // straight into needs_you, auto-answered a second later, which is the noise this removes.
    const ledger = emptyPromptGraceLedger();
    const asks = ["git status", "ls", "cargo check", "gh pr view"];
    const seen = asks.map((cmd, i) => {
      const at = T0 + i * 20_000;
      const held = tick(ledger, "approval", at, { text: `Bash: ${cmd}\nProceed?`, at });
      notePromptAnswerOutcome("a", "handled", at + 500, ledger); // the answerer disposed of it
      return held;
    });
    expect(seen).toEqual(["idle", "idle", "idle", "idle"]);
  });

  it("MEDIUM: one agent overflowing its burn cap cannot evict ANOTHER agent's burn", () => {
    // THE FLOOD HAS TO BE REAL. A first version of this looped 600 times inside one second, but the
    // churn budget made only the first two opens eligible — so agent `a` minted TWO burns, nothing
    // came near the cap, and the assertion passed identically against the old flat Set with a global
    // FIFO. It named the per-agent keying and exercised none of it (roborev 62856).
    //
    // Reporting `handled` between opens is what makes each one eligible without spending the churn
    // budget, so `a`'s burn set genuinely crosses BURN_PER_AGENT and the eviction loop runs.
    const ledger = emptyPromptGraceLedger();
    const two = [{ id: "a" }, { id: "b" }];
    const askB = (text: string, at: number) => {
      const map: Record<string, AgentTabStatus> = { a: "working", b: "approval" };
      notePromptEpisodes(ledger, map, (id) => (id === "b" ? { text, at } : undefined), at, ["a", "b"]);
      return withBlockedPromptGrace(two, map, ledger, at)["b"];
    };
    // `b` burns its prompt by being held once, then leaves the ask.
    expect(askB(PROMPT, T0)).toBe("idle");
    expect(askB("", T0 + 1)).toBe("approval");

    // `a` now opens more distinct questions than its own burn cap holds. ONE PER BUDGET WINDOW: every
    // hold is charged now, so a flood packed into one window is capped at six and never reaches the
    // eviction path — which is the same way this test was vacuous the first time, in a new disguise.
    for (let i = 0; i < BURN_FLOOD; i++) {
      const at = T0 + 1_000 + i * (HOLD_BUDGET_WINDOW_MS + 1_000);
      const map: Record<string, AgentTabStatus> = { a: "approval", b: "working" };
      notePromptEpisodes(ledger, map, () => ({ text: `q${i}\nProceed?`, at }), at, ["a", "b"]);
      notePromptAnswerOutcome("a", "handled", at + 1, ledger);
    }
    // The flood is real: `a` is at its cap, which is the state the old test never reached …
    expect(ledger.burned.get("a")!.size).toBe(BURN_CAP);
    // … its own oldest burn HAS been evicted (that identity can be held again) …
    const at = T0 + 1_000 + (BURN_FLOOD + 2) * (HOLD_BUDGET_WINDOW_MS + 1_000);
    const mapA: Record<string, AgentTabStatus> = { a: "approval", b: "working" };
    notePromptEpisodes(ledger, mapA, () => ({ text: "q0\nProceed?", at }), at, ["a", "b"]);
    expect(ledger.episode.get("a")!.eligible).toBe(true);
    // … and `b`'s burn survived it all, which is the whole point of keying per agent.
    expect(ledger.burned.get("b")!.size).toBe(1);
    expect(askB(PROMPT, at + 60_000)).toBe("approval");
  });

  it("MEDIUM: an agent MISSING from a partial status map keeps its hold", () => {
    const ledger = emptyPromptGraceLedger();
    expect(tick(ledger, "approval", T0 + 1_000)).toBe("idle");
    // A consumer whose cross-window roster has not arrived yet has no entry for this agent. That is
    // an absence of evidence, not evidence the agent stopped asking — closing the episode here would
    // burn the identity and permanently disable the hold for this question.
    notePromptEpisodes(ledger, {}, () => ({ text: PROMPT, at: T0 }), T0 + 2_000, ["a"]);
    expect(ledger.episode.get("a")?.eligible).toBe(true);
    expect(tick(ledger, "approval", T0 + 3_000)).toBe("idle");
  });
});

describe("the wake-up clock", () => {
  it("reports when the held prompt is due to surface, and nothing once it is not held", () => {
    const ledger = emptyPromptGraceLedger();
    const map: Record<string, AgentTabStatus> = { a: "approval" };
    notePromptEpisodes(ledger, map, () => ({ text: PROMPT, at: T0 }), T0 + 1_000, ["a"]);
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + 1_000)).toBe(T0 + BLOCKED_PROMPT_GRACE_MS);
    notePromptAnswerOutcome("a", "declined", T0 + 2_000, ledger);
    expect(nextPromptGraceExpiry(AGENT, ledger, T0 + 2_500)).toBeNull();
  });

  it("is null when nothing is held at all — no timer gets armed", () => {
    expect(nextPromptGraceExpiry(AGENT, emptyPromptGraceLedger(), T0)).toBeNull();
  });
});

describe("the ledger prunes with the fleet", () => {
  it("drops an agent's episode, outcome and burn once it leaves — and a fresh agent is held again", () => {
    const ledger = emptyPromptGraceLedger();
    expect(tick(ledger, "approval", T0 + 1_000)).toBe("idle");
    notePromptAnswerOutcome("a", "declined", T0 + 1_500, ledger);
    // Observe the give-up, so the prune below has something to drop rather than trivially passing.
    tick(ledger, "approval", T0 + 1_600);
    expect(ledger.gaveUp.size).toBe(1);
    // A tick in which the fleet no longer contains `a`.
    notePromptEpisodes(ledger, {}, () => undefined, T0 + 2_000, []);
    expect(ledger.episode.size).toBe(0);
    expect(ledger.burned.size).toBe(0);
    expect(ledger.outcome.size).toBe(0);
    expect(ledger.gaveUp.size).toBe(0);
  });
});

describe("answerOutcomeForPath", () => {
  it("files a delivered or in-flight answer as handled", () => {
    expect(answerOutcomeForPath("picker-option")).toBe("handled");
    expect(answerOutcomeForPath("free-text")).toBe("handled");
    expect(answerOutcomeForPath("queued")).toBe("handled");
  });

  it("separates a DECISION not to answer from an inability to reach the pane", () => {
    for (const p of ["ambiguous-picker", "addressed-at-picker", "unauthorized", "trial-spent", "cloud-agent", "empty"] as const) {
      expect(answerOutcomeForPath(p)).toBe("declined");
    }
    // The founder's named case: these are COMMON, and every one of them must surface the prompt.
    for (const p of ["pty-gone", "alternate-screen", "blocked-prompt", "agent-failed", "cloud-offline", "queue-full", "expired", "abandoned"] as const) {
      expect(answerOutcomeForPath(p)).toBe("unreachable");
    }
  });

  it("never files a refusal as handled — the arm that would hide a prompt forever", () => {
    const refusals = [
      "ambiguous-picker", "addressed-at-picker", "unauthorized", "trial-spent", "cloud-agent",
      "empty", "pty-gone", "alternate-screen", "blocked-prompt", "agent-failed", "cloud-offline",
      "queue-full", "expired", "abandoned",
    ] as const;
    for (const p of refusals) expect(answerOutcomeForPath(p)).not.toBe("handled");
  });
});
