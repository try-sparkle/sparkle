// @vitest-environment jsdom
//
// THE LAST SCREEN BEFORE SOMEONE WALKS AWAY.
//
// Promotion is the "I'm closing the laptop" move, so this dialog is the only place the user finds
// out what travels and what does not. Its copy is not decoration — spec Decision 1 makes the
// uncommitted-file disclosure load-bearing ("silently dropping uncommitted work is the failure mode
// to design against"), and Decision 2 makes the conversation + secrets disclosure load-bearing too.
// So these tests assert what is RENDERED and what the confirm actually SENDS, not that the
// component mounted.
//
// The plan is handed in as a value rather than derived, so every case here is a pure statement
// about the dialog: given this plan, the user sees this. `planPromotion` has its own tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../services/sparkleApi", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, openSignIn: vi.fn(async () => true), lastSignInUrl: vi.fn(() => null) };
});

vi.mock("../stores/uiStore", () => ({
  useUiStore: (sel: (s: { openSettings: (c?: string) => void }) => unknown) =>
    sel({ openSettings: vi.fn() }),
}));

import { PromoteToCloudDialog, type PromoteToCloudDeps } from "./PromoteToCloudDialog";
import { lastSignInUrl, openSignIn } from "../services/sparkleApi";
import { useAuthStore } from "../stores/authStore";
import { WIP_COMMIT_MESSAGE } from "../services/agentPromotion/plan";
import type { PromotionPlan } from "../services/agentPromotion/plan";
import type { PromoteResult } from "../services/agentPromotion/promote";

const AGENT = { id: "tab-1", name: "Retry Hardening" };

function okPlan(over: Partial<Extract<PromotionPlan, { ok: true }>> = {}) {
  return {
    ok: true as const,
    branch: "sparkle/agent-42",
    dirtyCount: 0,
    dirtyFiles: [],
    unpushed: 0,
    warnings: [],
    workerCount: 0,
    ...over,
  };
}

function mount(plan: PromotionPlan, promote?: PromoteToCloudDeps["promote"]) {
  const calls: Array<{ dirtyPolicy: string }> = [];
  const deps: PromoteToCloudDeps = {
    loadPlan: () => Promise.resolve(plan),
    promote:
      promote ??
      (async (a) => {
        calls.push({ dirtyPolicy: a.dirtyPolicy });
        return { ok: true, sessionId: "s-1", transcriptMoved: true, transcriptTruncated: false, committed: 0 } as PromoteResult;
      }),
  };
  const onClose = vi.fn();
  render(<PromoteToCloudDialog agent={AGENT} deps={deps} onClose={onClose} />);
  return { calls, onClose };
}

const confirm = () => screen.getByTestId("promote-confirm");

/** `/me` as the server sends it. `centsPerMinute: null` models an OLDER server: no price at all. */
const me = (over: { balanceCents?: number; centsPerMinute?: number | null } = {}) => ({
  clerkUserId: "u",
  entitled: true,
  balanceCents: over.balanceCents ?? 5000,
  tokenVersion: 1,
  ...(over.centsPerMinute === null
    ? {}
    : { cloudAgentPricing: { centsPerMinute: over.centsPerMinute ?? 0.9, minStartCents: 100 } }),
});

beforeEach(() => {
  // The dialog re-reads /me on open; the real refresh would clear what a test seeded.
  useAuthStore.setState({ refresh: vi.fn(async () => {}) } as never);
  // The dialog also SUBSCRIBES to `tokenPresent`, so a token leaked from a previous test would seed
  // the next one already signed in and silently skip the refusal it means to assert.
  vi.mocked(openSignIn).mockClear();
  vi.mocked(lastSignInUrl).mockClear();
  useAuthStore.setState({ tokenPresent: false } as never);
});

afterEach(() => {
  cleanup();
  // The store is module-global; a price left behind would leak into the suites that assert its
  // ABSENCE, which is the assertion most easily made vacuous here.
  useAuthStore.setState({ me: null, tokenPresent: false } as never);
});

// THE SECOND CONSUMER OF THE PRICE, and it needs its own proof. `cloudCostEstimate.test.ts` proves
// the SENTENCE and `NewCloudAgentDialog.test.tsx` proves that ONE dialog is wired to it — neither
// says anything about this one. Before these cases existed, `me` was null in every test here, so the
// whole estimate block was inert: a wrong selector path, a `costLine` accidentally placed inside the
// refusal branch, or a dropped `data-testid` would all have shipped with the suite green. That is
// the same vacuity the Rust round-trip test exists to prevent, one layer up.
describe("the cost estimate", () => {
  it("states the server's rate and what the balance funds", async () => {
    useAuthStore.setState({ me: me({ balanceCents: 1240 }), tokenPresent: true } as never);
    mount(okPlan());

    const line = (await screen.findByTestId("promote-cost-estimate")).textContent!;
    expect(line).toContain("$0.54/hour");
    expect(line).toContain("23 hours");
  });

  it("follows the server's rate rather than a number baked into the client", () => {
    useAuthStore.setState({
      me: me({ centsPerMinute: 4.5, balanceCents: 1240 }),
      tokenPresent: true,
    } as never);
    mount(okPlan());

    return waitFor(() =>
      expect(screen.getByTestId("promote-cost-estimate").textContent).toContain("$2.70/hour"),
    );
  });

  it("renders NOTHING when the server stated no price — never a guessed one", async () => {
    useAuthStore.setState({ me: me({ centsPerMinute: null }), tokenPresent: true } as never);
    mount(okPlan());

    // Wait for the plan to land, so this is "the dialog rendered and chose not to show a price"
    // rather than "the dialog had not rendered yet" — the difference between a real assertion and
    // one that passes because nothing exists yet.
    await screen.findByTestId("promote-confirm");
    expect(screen.queryByTestId("promote-cost-estimate")).toBeNull();
  });

  it("is absent on a REFUSAL — there is no run to price", async () => {
    useAuthStore.setState({ me: me(), tokenPresent: true } as never);
    mount({ ok: false, refusal: "no_remote", message: "This project has no `origin` remote." });

    await screen.findByTestId("promote-refusal");
    expect(screen.queryByTestId("promote-cost-estimate")).toBeNull();
  });

  // Below the server's floor `canStartCloudAgent` refuses outright, so a runway would state a
  // runtime the user cannot buy.
  it("says what it takes to START rather than a runway, below the server's floor", async () => {
    useAuthStore.setState({ me: me({ balanceCents: 50 }), tokenPresent: true } as never);
    mount(okPlan());

    const line = (await screen.findByTestId("promote-cost-estimate")).textContent!;
    expect(line).toContain("You need $1.00 to start.");
    expect(line).not.toMatch(/funds/);
  });

  // This dialog is the MORE exposed of the two to a stale balance: the user is promoting precisely
  // because something has been running and burning credits.
  it("re-reads /me on open, so the quote is not a pre-debit balance", () => {
    const refresh = vi.fn(async () => {});
    useAuthStore.setState({ me: me(), tokenPresent: true, refresh } as never);
    mount(okPlan());

    expect(refresh).toHaveBeenCalled();
  });
});

describe("what the user is told before they can confirm", () => {
  it("names the branch the work will travel on", async () => {
    mount(okPlan());
    expect((await screen.findByTestId("promote-branch")).textContent).toBe("sparkle/agent-42");
  });

  // The disclosure Decision 1 exists for. Not a count — the actual paths, so the user can see what
  // the WIP commit is about to sweep up.
  it("lists the uncommitted files by name, and says how many more it did not list", async () => {
    mount(
      okPlan({
        dirtyCount: 12,
        dirtyFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts", "src/f.ts", "src/g.ts", "src/h.ts", "src/i.ts"],
      }),
    );
    const list = await screen.findByTestId("promote-dirty-files");
    expect(list.textContent).toContain("src/a.ts");
    expect(screen.getByTestId("promote-dirty-more").textContent).toMatch(/more/);
  });

  it("shows the exact commit message it will write, so nothing appears in history unannounced", async () => {
    mount(okPlan({ dirtyCount: 1, dirtyFiles: ["src/a.ts"] }));
    expect((await screen.findByTestId("promote-wip-message")).textContent).toBe(WIP_COMMIT_MESSAGE);
  });

  it("says plainly that a clean tree has nothing uncommitted", async () => {
    mount(okPlan());
    expect(await screen.findByTestId("promote-clean")).toBeTruthy();
  });

  // Decision 1: .gitignore'd files and stashes are local-machine state and do not travel.
  it("names what never travels", async () => {
    mount(okPlan());
    expect((await screen.findByTestId("promote-never-travels")).textContent).toMatch(
      /gitignore|stash/i,
    );
  });

  // Decision 2: the conversation is the other half of the move, and its exposure is the honest
  // counterweight to refusing to carry .env files.
  it("says whether the conversation travels", async () => {
    mount(okPlan());
    expect((await screen.findByTestId("promote-conversation")).textContent!.length).toBeGreaterThan(0);
  });

  // Rendered, not counted or summarised — the plan puts the situational truths here (workers stay
  // local, unpushed commits get pushed, the transcript can carry secrets).
  it("renders EVERY warning the plan produced", async () => {
    mount(okPlan({ warnings: ["workers stay local", "3 commits will be pushed", "secrets may ride along"] }));
    await waitFor(() => expect(screen.getAllByTestId("promote-warning")).toHaveLength(3));
    const text = screen.getAllByTestId("promote-warning").map((n) => n.textContent).join(" ");
    expect(text).toContain("workers stay local");
    expect(text).toContain("secrets may ride along");
  });
});

describe("the dirty-state choice", () => {
  // Decision 1 again: commit is the default because the failure being designed against is losing
  // work, and a commit loses nothing.
  it("defaults to committing, and sends that policy on confirm", async () => {
    const { calls } = mount(okPlan({ dirtyCount: 2, dirtyFiles: ["a.ts", "b.ts"] }));
    fireEvent.click(await screen.findByTestId("promote-confirm"));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.dirtyPolicy).toBe("commit");
  });

  it("sends `leave` only after the user picks it, and shows what that costs them", async () => {
    const { calls } = mount(okPlan({ dirtyCount: 2, dirtyFiles: ["a.ts", "b.ts"] }));
    const leave = await screen.findByTestId("promote-policy-leave");
    // The option must SAY that these files do not travel — choosing it is meant to require having
    // read that, so a bare radio with no consequence stated would defeat the disclosure. The
    // testId sits on the input, so the wording lives on its label.
    expect(leave.closest("label")!.textContent).toMatch(/NOT travel|never sees them/i);
    fireEvent.click(leave);
    // The acknowledgement is the whole point of offering the option at all.
    expect(screen.getByTestId("promote-leave-ack").textContent).toMatch(/2/);
    fireEvent.click(confirm());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.dirtyPolicy).toBe("leave");
  });
});

describe("refusals and failures", () => {
  it("renders a refusal instead of a confirm button", async () => {
    mount({ ok: false, refusal: "no_remote", message: "This project has no `origin` remote." });
    expect((await screen.findByTestId("promote-refusal")).textContent).toContain("no `origin` remote");
    expect(screen.queryByTestId("promote-confirm")).toBeNull();
  });

  // THE DEAD END THIS DIALOG SHIPPED. It rendered `deepLink` but ignored `needsSignIn`, and
  // `signed_out` is the one cloud-gate reason that carries no deepLink — so the most common blocked
  // state showed "Sign in to run agents in the cloud" beside no control whatsoever. NewAgentButtons
  // had handled the identical gate correctly all along.
  it("offers Sign in for a signed-out refusal, which carries NO deep link", async () => {
    mount({
      ok: false,
      refusal: "cloud_gate",
      message: "Sign in to run agents in the cloud.",
      needsSignIn: true,
    });
    await screen.findByTestId("promote-refusal");
    expect(screen.getByRole("button", { name: /sign in/i })).toBeTruthy();
  });

  it("offers the Settings hand-off for a deep-linked refusal", async () => {
    mount({
      ok: false,
      refusal: "cloud_gate",
      message: "Add your Claude authentication to run agents in the cloud.",
      deepLink: "cloudauth",
    });
    await screen.findByTestId("promote-refusal");
    // The label comes from the shared `deepLinkActionLabel`, so this also pins that the dialog no
    // longer carries its own copy of the cloudauth/credits ternary.
    expect(screen.getByRole("button", { name: "Add Claude auth" })).toBeTruthy();
  });

  // The single most important sentence on a failure: their agent is fine.
  it("says the local agent is still running when a step fails", async () => {
    mount(okPlan(), async () => ({
      ok: false,
      step: "push",
      message: "remote rejected the push",
    }));
    fireEvent.click(await screen.findByTestId("promote-confirm"));
    const err = await screen.findByTestId("promote-error");
    expect(err.textContent).toContain("remote rejected the push");
    expect(screen.getByTestId("promote-failure-local-note")).toBeTruthy();
  });

  // A session running server-side that we could not clean up is billing. Naming its id is the
  // orphan contract; an unnamed orphan is the bug.
  it("surfaces an orphaned session id when the cleanup could not remove it", async () => {
    mount(okPlan(), async () => ({
      ok: false,
      step: "await_live",
      message: "the sandbox never streamed",
      orphanedSessionId: "sess-abc",
    }));
    fireEvent.click(await screen.findByTestId("promote-confirm"));
    expect((await screen.findByTestId("promote-orphan")).textContent).toContain("sess-abc");
  });
});

describe("the sign-in refusal has to be able to END", () => {
  // `openSignIn()` resolving true means the BROWSER opened — not that anyone signed in. That
  // completes seconds-to-minutes later when the sparkle:// deep link updates the auth store. The
  // plan loads once and the dialog stays mounted across the hand-off, so without a re-read the user
  // returns to the identical refusal with no confirm button and close-and-reopen as the only exit.
  const REFUSAL: PromotionPlan = {
    ok: false,
    refusal: "cloud_gate",
    message: "Sign in to run agents in the cloud.",
    needsSignIn: true,
  };
  // Reads the LIVE auth signal rather than returning a scripted sequence: a re-read at the wrong
  // moment then returns the same refusal, exactly as it would in the app. A hand-scripted
  // "second call succeeds" encodes the assumption under test instead of exercising it.
  const gateBacked = (): PromoteToCloudDeps => ({
    loadPlan: async () => (useAuthStore.getState().tokenPresent ? okPlan() : REFUSAL),
    promote: async () =>
      ({ ok: true, sessionId: "s-1", transcriptMoved: true, transcriptTruncated: false, committed: 0 }) as PromoteResult,
  });

  it("does NOT resolve the refusal merely because the browser opened", async () => {
    render(<PromoteToCloudDialog agent={AGENT} deps={gateBacked()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("promote-sign-in"));
    await waitFor(() => expect(openSignIn).toHaveBeenCalled());
    expect(await screen.findByTestId("promote-refusal")).toBeTruthy();
    expect(screen.queryByTestId("promote-confirm")).toBeNull();
  });

  it("re-reads when SIGN-IN COMPLETES, so the refusal becomes the confirm screen", async () => {
    render(<PromoteToCloudDialog agent={AGENT} deps={gateBacked()} onClose={vi.fn()} />);
    expect(await screen.findByTestId("promote-refusal")).toBeTruthy();
    await act(async () => {
      useAuthStore.setState({ tokenPresent: true } as never); // the real signal, from elsewhere
    });
    expect(await screen.findByTestId("promote-confirm")).toBeTruthy();
  });

  it("also re-reads on window FOCUS — driven by a signal the component cannot observe", async () => {
    // `tokenPresent` stays FALSE throughout, so the auth effect cannot be what answers; only focus
    // can. (Flipping the token and THEN firing focus passes with the listener deleted.)
    let account: "out" | "in" = "out";
    const deps: PromoteToCloudDeps = {
      loadPlan: async () => (account === "in" ? okPlan() : REFUSAL),
      promote: async () => ({ ok: true }) as PromoteResult,
    };
    render(<PromoteToCloudDialog agent={AGENT} deps={deps} onClose={vi.fn()} />);
    expect(await screen.findByTestId("promote-refusal")).toBeTruthy();
    account = "in";
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(await screen.findByTestId("promote-confirm")).toBeTruthy();
    expect(useAuthStore.getState().tokenPresent).toBe(false);
  });

  it("surfaces the copy/paste URL when the browser could not be launched", async () => {
    // `openSignIn()` RESOLVES false (never rejects) on a launch failure; discarding it leaves a
    // button that visibly does nothing.
    vi.mocked(openSignIn).mockResolvedValueOnce(false);
    vi.mocked(lastSignInUrl).mockReturnValueOnce("https://sparkle.ai/sign-in?state=abc");
    render(<PromoteToCloudDialog agent={AGENT} deps={gateBacked()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("promote-sign-in"));
    const fb = await screen.findByTestId("promote-sign-in-fallback");
    expect(fb.textContent).toContain("https://sparkle.ai/sign-in?state=abc");
  });

  it("still says so when the launch failed before a URL even existed", async () => {
    // `lastSignInUrl()` is null when the URL was never built; a bare `string | null` state cannot
    // tell that from "no failure", so the fallback would render nothing — the dead button again.
    vi.mocked(openSignIn).mockResolvedValueOnce(false);
    vi.mocked(lastSignInUrl).mockReturnValueOnce(null);
    render(<PromoteToCloudDialog agent={AGENT} deps={gateBacked()} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("promote-sign-in"));
    expect((await screen.findByTestId("promote-sign-in-fallback")).textContent).toMatch(
      /Couldn't start sign-in/i,
    );
  });
});

describe("a reload must never erase what the user needs", () => {
  // `promote-progress`, the failure panel and `failure.orphanedSessionId` ALL render inside the
  // `plan.ok` branch, so any reload landing a not-ok plan erases the id needed to stop a sandbox
  // that is still billing — and nothing re-derives it.
  const REFUSED: PromotionPlan = {
    ok: false,
    refusal: "cloud_gate",
    message: "Sign in to run agents in the cloud.",
    needsSignIn: true,
  };

  it("a token flip MID-PROMOTION does not swap the progress screen, and the orphan id still lands", async () => {
    let account: "ok" | "refused" = "ok";
    let finish: ((r: PromoteResult) => void) | null = null;
    const deps: PromoteToCloudDeps = {
      loadPlan: async () => (account === "ok" ? okPlan() : REFUSED),
      promote: ({ onStep }) => {
        onStep("await_live");
        return new Promise<PromoteResult>((r) => {
          finish = r;
        });
      },
    };
    render(<PromoteToCloudDialog agent={AGENT} deps={deps} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("promote-confirm"));
    expect(await screen.findByTestId("promote-progress")).toBeTruthy();
    account = "refused";
    await act(async () => {
      useAuthStore.setState({ tokenPresent: true } as never);
    });
    expect(screen.getByTestId("promote-progress")).toBeTruthy();
    await act(async () => {
      finish?.({ ok: false, step: "await_live", message: "never streamed", orphanedSessionId: "sess-abc" } as PromoteResult);
      await Promise.resolve();
    });
    expect((await screen.findByTestId("promote-orphan")).textContent).toContain("sess-abc");
  });

  it("a RESOLVED refusal cannot replace a good plan the user is reading", async () => {
    // roborev 59544, and the symmetric twin of the rejection case below. `loadPlan` swallows a
    // failed `promotion_preflight` with `.catch(() => null)` and `planPromotion` turns a null
    // preflight into a `no_worktree` REFUSAL — so a transient failure arrives as a RESOLVED not-ok
    // plan, not a rejection. Unguarded, one flaky Tauri invoke while the user alt-tabs replaced the
    // confirm screen (branch, dirty-file list, policy radios) with "there is no worktree to
    // promote". Guarding only the reject path left exactly this hole, which is why the pair was
    // asymmetric.
    let degraded = false;
    const deps: PromoteToCloudDeps = {
      loadPlan: async () =>
        degraded
          ? ({ ok: false, refusal: "no_worktree", message: "This agent has no worktree." } as PromotionPlan)
          : okPlan(),
      promote: async () => ({ ok: true }) as PromoteResult,
    };
    render(<PromoteToCloudDialog agent={AGENT} deps={deps} onClose={vi.fn()} />);
    expect(await screen.findByTestId("promote-confirm")).toBeTruthy();

    degraded = true;
    await act(async () => {
      fireEvent.focus(window);
    });

    expect(screen.getByTestId("promote-confirm")).toBeTruthy();
    expect(screen.queryByTestId("promote-refusal")).toBeNull();
  });

  it("two concurrent reloads settle last-CALLED-wins, not last-to-resolve", async () => {
    // Reachable while the plan is NOT ok: focus and the token flip can both fire, and `loadPlan`
    // shells out to Tauri and `gh`, so the first can resolve after the second. Unordered,
    // last-write-wins would put the stale refusal back over the good plan with nothing left to
    // correct it. (This replaces an in-flight-during-promotion test that the `plan.ok` guard above
    // made unreachable — with that guard, a reload is never issued while a promotion can start, so
    // the old test passed with the ordering removed.)
    const REFUSAL: PromotionPlan = {
      ok: false,
      refusal: "cloud_gate",
      message: "Sign in to run agents in the cloud.",
      needsSignIn: true,
    };
    let releaseStale: (() => void) | null = null;
    let call = 0;
    const deps: PromoteToCloudDeps = {
      loadPlan: () => {
        call += 1;
        if (call === 1) return Promise.resolve(REFUSAL); // mount: not ok, so reloads stay enabled
        if (call === 2) {
          return new Promise<PromotionPlan>((resolve) => {
            releaseStale = () => resolve(REFUSAL); // the focus reload, held open
          });
        }
        return Promise.resolve(okPlan()); // the auth reload, resolves immediately
      },
      promote: async () => ({ ok: true }) as PromoteResult,
    };
    render(<PromoteToCloudDialog agent={AGENT} deps={deps} onClose={vi.fn()} />);
    expect(await screen.findByTestId("promote-refusal")).toBeTruthy();

    await act(async () => {
      fireEvent.focus(window); // reload A — in flight
    });
    await act(async () => {
      useAuthStore.setState({ tokenPresent: true } as never); // reload B — wins by being newer
    });
    expect(await screen.findByTestId("promote-confirm")).toBeTruthy();

    await act(async () => {
      releaseStale?.(); // A finally answers, with the stale refusal
      await Promise.resolve();
    });

    expect(screen.getByTestId("promote-confirm")).toBeTruthy();
    expect(screen.queryByTestId("promote-refusal")).toBeNull();
  });

  it("a TRANSIENT load failure is not permanent — a later good load clears it", async () => {
    // `loadError` pre-empts the plan branch and had one writer and no clearer, so one throw wedged
    // the dialog forever: every recovery trigger fired, passed its guards, set a good plan, and the
    // user saw none of it.
    let ok = false;
    const deps: PromoteToCloudDeps = {
      loadPlan: () => (ok ? Promise.resolve(okPlan()) : Promise.reject(new Error("preflight blew up"))),
      promote: async () => ({ ok: true }) as PromoteResult,
    };
    render(<PromoteToCloudDialog agent={AGENT} deps={deps} onClose={vi.fn()} />);
    expect((await screen.findByTestId("promote-load-error")).textContent).toContain("preflight blew up");
    ok = true;
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(await screen.findByTestId("promote-confirm")).toBeTruthy();
    expect(screen.queryByTestId("promote-load-error")).toBeNull();
  });

  it("a FAILED background reload does not tear down an already-good plan", async () => {
    // The symmetric case: a rejection is the ABSENCE of an answer, not a verdict, so it must not
    // replace a confirm screen the user has already read. The error panel carries no button.
    let fail = false;
    const deps: PromoteToCloudDeps = {
      loadPlan: () => (fail ? Promise.reject(new Error("gh resolve blew up")) : Promise.resolve(okPlan())),
      promote: async () => ({ ok: true }) as PromoteResult,
    };
    render(<PromoteToCloudDialog agent={AGENT} deps={deps} onClose={vi.fn()} />);
    expect(await screen.findByTestId("promote-confirm")).toBeTruthy();
    fail = true;
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(screen.getByTestId("promote-confirm")).toBeTruthy();
    expect(screen.queryByTestId("promote-load-error")).toBeNull();
  });
});

describe("progress and success", () => {
  it("names the step it is on while promotion runs", async () => {
    let release: (r: PromoteResult) => void = () => {};
    mount(okPlan(), ({ onStep }) => {
      onStep("push");
      return new Promise<PromoteResult>((res) => {
        release = res;
      });
    });
    fireEvent.click(await screen.findByTestId("promote-confirm"));
    await waitFor(() => expect(screen.getByTestId("promote-current-step")).toBeTruthy());
    // …and it keeps saying the local agent is alive until the cut actually happens.
    expect(screen.getByTestId("promote-local-note")).toBeTruthy();
    release({ ok: true, sessionId: "s", transcriptMoved: true, transcriptTruncated: false, committed: 0 });
  });

  it("reports the move as done, on the same agent", async () => {
    mount(okPlan());
    fireEvent.click(await screen.findByTestId("promote-confirm"));
    const done = await screen.findByTestId("promote-success");
    expect(done.textContent).toContain(AGENT.name);
  });
});
