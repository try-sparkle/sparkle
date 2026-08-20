// @vitest-environment jsdom
//
// The stale-checkout remedy panel (bead sparkle-7h01z).
//
// WHAT THESE ASSERT, AND WHY EACH ONE IS NOT VACUOUS. Every test here is written so that reverting
// the behaviour it guards turns it RED — which for a panel of buttons means asserting what the
// button DID (the service call, with the right root) and what came BACK (the backend's own reason
// text on screen), never merely that a control exists.
//
// The two that carry the most weight are the NEGATIVE ones, because they guard deliberate refusals
// and a refusal is the easiest thing in the world for a later change to "fix":
//
//   • `blocked-held-elsewhere` renders ZERO buttons in its row. A future agent reading that row and
//     thinking "this should have a Fix anyway button" is the exact regression — see the reasoning
//     on `remedyAction`.
//   • "Fix all safe" NAMES every row it declined to touch. A bulk action that quietly half-succeeds
//     reports the same "done" as one that did everything.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { RemedyOutcome, StaleDiagnosis } from "../services/staleness";

const diagnoseStale = vi.fn<(root: string) => Promise<StaleDiagnosis>>();
const remedyStale =
  vi.fn<(root: string, opts?: { unattended?: boolean }) => Promise<RemedyOutcome>>();

vi.mock("../services/staleness", () => ({
  diagnoseStale: (root: string) => diagnoseStale(root),
  // FORWARD EVERY ARGUMENT. A wrapper that names only `root` silently drops the options object, so
  // a panel that started passing a policy would keep this whole suite green while sending nothing.
  remedyStale: (...a: Parameters<typeof remedyStale>) => remedyStale(...a),
  autoFastForwardEnabled: () => Promise.resolve(false),
}));

import { StaleCheckoutPanel, remedyAction, type StaleTarget } from "./StaleCheckoutPanel";

function diag(over: Partial<StaleDiagnosis> = {}): StaleDiagnosis {
  return {
    behind: 1935,
    base: "origin/main",
    headBranch: "main",
    defaultBranch: "main",
    detached: false,
    linkedWorktree: false,
    heldBy: "",
    dirtyCount: 0,
    dirtySample: [],
    canFastForward: true,
    remedy: "fast-forward",
    cause: "This checkout is clean and on main, so it can be fast-forwarded to origin/main.",
    autoSafe: true,
    unknown: false,
    ...over,
  };
}

function outcome(over: Partial<RemedyOutcome> = {}): RemedyOutcome {
  return { ok: true, reason: "Fast-forwarded to origin/main.", action: "merge --ff-only", beforeBehind: 1935, afterBehind: 0, ...over };
}

function target(over: Partial<StaleTarget> = {}): StaleTarget {
  return { id: "sparkle", name: "sparkle", rootPath: "/repos/sparkle", behind: 1935, base: "origin/main", ...over };
}

/** Does this header promise a wider scope than the rows beneath it? A bare universal quantifier
 *  ("all", "every") is honest only when nothing was left out — and this panel is always handed one
 *  tab strip's worth. Anything that names the narrower scope instead is fine, which is why this is
 *  a rule and not an equality against one sentence. */
function claimsEverything(text: string): boolean {
  return /\b(all|every)\b/i.test(text) && !/\b(this|these|here|open)\b/i.test(text);
}

/** Diagnose from a root→diagnosis table, so a multi-row panel gives each row its own answer. */
function byRoot(table: Record<string, StaleDiagnosis>) {
  diagnoseStale.mockImplementation((root: string) => {
    const d = table[root];
    if (!d) throw new Error(`no fixture for ${root}`);
    return Promise.resolve(d);
  });
}

beforeEach(() => {
  diagnoseStale.mockReset();
  remedyStale.mockReset();
});

afterEach(cleanup);

/** The panel diagnoses on mount, so every test waits for the first row's cause to land. */
async function renderPanel(targets: StaleTarget[], onClose = () => {}) {
  const r = render(<StaleCheckoutPanel anchorEl={null} targets={targets} onClose={onClose} />);
  const first = targets[0];
  if (first) await screen.findByTestId(`stale-cause-${first.id}`);
  return r;
}

describe("remedyAction", () => {
  // The RULE, pinned independently of the markup: which remedies earn a control at all.
  it("offers a button for the two remedies that can act", () => {
    expect(remedyAction(diag({ remedy: "fast-forward" }))?.label).toBe("Fast-forward");
    expect(remedyAction(diag({ remedy: "fast-forward-dirty" }))?.label).toBe("Fast-forward");
  });

  // `blocked-detached` USED to earn a "check out <branch> and fast-forward" button. It was removed
  // (roborev 59436): fast-forwardability is measured against the DETACHED head, so that action
  // moves a commit the check never covered, and a diverged local branch lets the checkout succeed —
  // claiming the branch away from every sibling worktree — before the fast-forward fails. A
  // half-landed branch claim is strictly worse than a sentence telling you to run it yourself.
  it("offers NO button for a detached head, however fixable it looks", () => {
    expect(remedyAction(diag({ remedy: "blocked-detached", defaultBranch: "trunk" }))).toBeNull();
  });

  // THE DELIBERATE REFUSALS. `blocked-held-elsewhere` is the one with a founder ruling behind it: a
  // button you must press forever is worse than none, because the branch is held by another
  // worktree and no command run from here can ever change that.
  it("offers NO button for the blocked, diverged, unknown and nothing-to-do cases", () => {
    expect(remedyAction(diag({ remedy: "blocked-held-elsewhere" }))).toBeNull();
    expect(remedyAction(diag({ remedy: "blocked-diverged" }))).toBeNull();
    expect(remedyAction(diag({ remedy: "unknown", unknown: true }))).toBeNull();
    expect(remedyAction(diag({ remedy: "none" }))).toBeNull();
  });
});

describe("StaleCheckoutPanel rows", () => {
  it("renders the backend's cause sentence VERBATIM rather than wording of its own", async () => {
    const cause = "sparkle is a linked worktree and cannot move on its own.";
    byRoot({ "/repos/sparkle": diag({ remedy: "blocked-diverged", cause }) });
    await renderPanel([target()]);
    expect(screen.getByTestId("stale-cause-sparkle").textContent).toBe(cause);
  });

  // ── THE REFUSAL, ASSERTED AS AN ABSENCE ───────────────────────────────────────────────────────
  // Not "the Fast-forward button is missing" but "this row has NO buttons at all", so any control
  // anyone adds to it — however labelled — fails this.
  it("gives a held-elsewhere row its cause and ZERO buttons", async () => {
    const cause =
      "main is checked out in /repos/sparkle-desktop, and git allows a branch in only one worktree — this checkout cannot be moved from here.";
    byRoot({ "/repos/sparkle": diag({ remedy: "blocked-held-elsewhere", linkedWorktree: true, heldBy: "/repos/sparkle-desktop", autoSafe: false, cause }) });
    await renderPanel([target()]);

    const row = screen.getByTestId("stale-row-sparkle");
    expect(within(row).getByTestId("stale-cause-sparkle").textContent).toBe(cause);
    expect(within(row).queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByTestId("stale-remedy-sparkle")).toBeNull();
  });

  it("names the count and the base it is behind", async () => {
    byRoot({ "/repos/sparkle": diag({ behind: 1935, base: "origin/main" }) });
    await renderPanel([target()]);
    expect(screen.getByTestId("stale-behind-sparkle").textContent).toBe("1,935 behind origin/main");
  });

  // A dirty tree is offered anyway (the user's call) but never silently: the count and the sample
  // are what tell them what is at stake before they press.
  it("warns with the dirty count and sample on a fast-forward-dirty row, and still offers the button", async () => {
    byRoot({
      "/repos/sparkle": diag({
        remedy: "fast-forward-dirty",
        autoSafe: false,
        dirtyCount: 2,
        dirtySample: ["src/a.ts", "src/b.ts"],
        cause: "This checkout can be fast-forwarded, but it has uncommitted changes.",
      }),
    });
    await renderPanel([target()]);
    const warn = screen.getByTestId("stale-dirty-sparkle").textContent ?? "";
    expect(warn).toContain("2 uncommitted changes");
    expect(warn).toContain("src/a.ts");
    expect(warn).toContain("src/b.ts");
    expect(screen.getByTestId("stale-remedy-sparkle")).toBeTruthy();
  });
});

describe("running a remedy", () => {
  // THE SIDE EFFECT: the click reaches the backend, with THIS row's root. A test that only asserted
  // the button exists would pass against a button wired to nothing.
  it("calls remedyStale with that project's root", async () => {
    byRoot({ "/repos/sparkle": diag() });
    remedyStale.mockResolvedValue(outcome());
    await renderPanel([target()]);

    fireEvent.click(screen.getByTestId("stale-remedy-sparkle"));
    await waitFor(() => expect(remedyStale).toHaveBeenCalledWith("/repos/sparkle"));
  });

  // git's own refusal text, unedited. This is the one string on the panel a user most needs
  // verbatim — it names the file that blocked the merge.
  it("shows the returned reason VERBATIM when the remedy fails", async () => {
    const reason =
      "error: Your local changes to the following files would be overwritten by merge: src/a.ts";
    byRoot({ "/repos/sparkle": diag({ remedy: "fast-forward-dirty", autoSafe: false, dirtyCount: 1, dirtySample: ["src/a.ts"] }) });
    remedyStale.mockResolvedValue(outcome({ ok: false, reason }));
    await renderPanel([target()]);

    fireEvent.click(screen.getByTestId("stale-remedy-sparkle"));
    expect((await screen.findByTestId("stale-outcome-sparkle")).textContent).toBe(reason);
  });

  // A row that still reads "1,935 behind" after a successful fast-forward is the panel lying about
  // the thing it just did.
  it("re-diagnoses the row after a remedy so the count updates", async () => {
    diagnoseStale
      .mockResolvedValueOnce(diag({ behind: 1935 }))
      .mockResolvedValueOnce(diag({ behind: 0, remedy: "none", cause: "This checkout is current." }));
    remedyStale.mockResolvedValue(outcome());
    await renderPanel([target()]);
    expect(screen.getByTestId("stale-behind-sparkle").textContent).toBe("1,935 behind origin/main");

    fireEvent.click(screen.getByTestId("stale-remedy-sparkle"));
    await waitFor(() =>
      expect(screen.getByTestId("stale-behind-sparkle").textContent).toBe("0 behind origin/main"),
    );
    expect(diagnoseStale).toHaveBeenCalledTimes(2);
  });
});

describe("the clicked project first, then everything else", () => {
  it("puts the clicked project above the section header holding the rest", async () => {
    byRoot({
      "/repos/sparkle": diag(),
      "/repos/website": diag({ behind: 12, cause: "website is 12 behind." }),
    });
    await renderPanel([
      target(),
      target({ id: "website", name: "drodio-website", rootPath: "/repos/website", behind: 12 }),
    ]);
    await screen.findByTestId("stale-cause-website");

    const panel = screen.getByTestId("stale-panel");
    const order = Array.from(panel.querySelectorAll("[data-testid]"))
      .map((el) => el.getAttribute("data-testid"))
      .filter((id): id is string => !!id && (id.startsWith("stale-row-") || id === "stale-others-header"));
    expect(order).toEqual(["stale-row-sparkle", "stale-others-header", "stale-row-website"]);
  });

  // ── THE HEADER MAY NOT PROMISE MORE THAN THE PANEL WAS HANDED ────────────────────────────────
  //
  // `targets` is NOT app-wide, however much the old copy said so. `ProjectTabsBar` measures
  // staleness for `projectsOnSide(openProjectsOf(projects, openProjectIds), pairAssignment, side)`
  // — the OPEN projects on ONE side of the pair — and that narrowed map is the only thing
  // `staleTargetsFor` can draw a row from. So a user whose projects are split across the two sides
  // read "All stale checkouts", saw half of them, and had nothing on screen telling them the other
  // half existed. Underneath that header are buttons that move real git checkouts.
  //
  // THE ASSERTION IS THE RELATION, NOT THE STRING. Checking the new copy against itself would prove
  // nothing (AGENTS.md, "Tests must assert the SIDE EFFECT"): what has power is that the panel is
  // handed a strict SUBSET of the stale checkouts that exist and therefore may not use a bare
  // universal quantifier over it. Restore "All stale checkouts" and this goes red; any honest
  // wording keeps it green, so it constrains the claim rather than pinning one sentence.
  it("does not claim to list every stale checkout when it was handed one strip's worth", async () => {
    // Four stale checkouts exist. Two are open in THIS tab strip and are what the caller passes;
    // two sit on the other side of the pair and never reach the panel — the shipped wiring.
    const universe = [
      target(),
      target({ id: "website", name: "drodio-website", rootPath: "/repos/website", behind: 12 }),
      target({ id: "ledger", name: "ledger", rootPath: "/repos/ledger", behind: 40 }),
      target({ id: "atlas", name: "atlas", rootPath: "/repos/atlas", behind: 7 }),
    ];
    const thisStrip = universe.slice(0, 2);
    byRoot({
      "/repos/sparkle": diag(),
      "/repos/website": diag({ behind: 12, cause: "website is 12 behind." }),
    });
    await renderPanel(thisStrip);
    await screen.findByTestId("stale-cause-website");

    const panel = screen.getByTestId("stale-panel");
    const order = Array.from(panel.querySelectorAll("[data-testid]"))
      .map((el) => el.getAttribute("data-testid") ?? "")
      .filter((id) => id.startsWith("stale-row-") || id === "stale-others-header");
    const under = order.slice(order.indexOf("stale-others-header") + 1);

    // WHAT IT LISTS: one row, out of the three stale checkouts that are not the clicked one — and
    // the clicked one is rendered ABOVE the header, so it is not covered by this label either.
    expect(under).toEqual(["stale-row-website"]);
    expect(under).not.toContain("stale-row-sparkle");
    expect(under.length).toBeLessThan(universe.length - 1);

    // WHAT IT CLAIMS: consequently, not everything. A bare "all"/"every" over a strict subset is
    // the defect; a quantifier that names the narrower scope it really covers is not.
    const claim = screen.getByTestId("stale-others-header").textContent ?? "";
    expect(claimsEverything(claim)).toBe(false);
    // Still a real section label, not blanked out to dodge the rule above.
    expect(claim.trim().length).toBeGreaterThan(0);
  });
});

describe("Fix all safe", () => {
  // ── IT MAY NEVER SILENTLY SKIP ────────────────────────────────────────────────────────────────
  // The mixed set is the whole test: it acts on the actionable row, leaves the other two alone, and
  // writes a NAMED reason beside each one it left. Asserting only "nothing crashed" — or only that
  // the actionable row ran — would pass against a bulk action that reports success for a set it
  // half-processed, which is the failure this control has and a per-row button does not.
  it("acts on the actionable rows and names a reason for each one it skips", async () => {
    const heldCause =
      "main is checked out in /repos/sparkle-desktop, so this worktree cannot be moved from here.";
    const divergedCause = "This checkout has 3 commits origin/main does not, so no fast-forward exists.";
    byRoot({
      "/repos/sparkle": diag(),
      "/repos/held": diag({ remedy: "blocked-held-elsewhere", autoSafe: false, cause: heldCause }),
      "/repos/diverged": diag({ remedy: "blocked-diverged", autoSafe: false, cause: divergedCause }),
    });
    remedyStale.mockResolvedValue(outcome());
    await renderPanel([
      target(),
      target({ id: "held", name: "held-worktree", rootPath: "/repos/held" }),
      target({ id: "diverged", name: "diverged-repo", rootPath: "/repos/diverged" }),
    ]);
    await screen.findByTestId("stale-cause-diverged");

    fireEvent.click(screen.getByTestId("stale-fix-all"));

    // It ACTED on the one row that could be moved…
    await waitFor(() => expect(remedyStale).toHaveBeenCalledWith("/repos/sparkle"));
    // …and on NOTHING else. A bulk action that touched a held or diverged checkout is the bug.
    expect(remedyStale).toHaveBeenCalledTimes(1);

    // …and each skipped row SAYS SO, naming the project and why. The cause sentence alone is
    // already on the row, so the assertion is on the skip line — a report, not a repetition.
    expect((await screen.findByTestId("stale-skip-held")).textContent).toBe(
      `Skipped held-worktree — ${heldCause}`,
    );
    expect(screen.getByTestId("stale-skip-diverged").textContent).toBe(
      `Skipped diverged-repo — ${divergedCause}`,
    );
    // The row that RAN is not reported as skipped.
    expect(screen.queryByTestId("stale-skip-sparkle")).toBeNull();
  });

  // A control that vanishes when it cannot act takes its own explanation with it (OpenPrMenu:1533).
  it("stays present but disabled, with a reason, when nothing is actionable", async () => {
    byRoot({ "/repos/sparkle": diag({ remedy: "blocked-diverged", autoSafe: false }) });
    await renderPanel([target()]);

    const btn = screen.getByTestId("stale-fix-all") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    // The reason must be a RENDERED ELEMENT, never a `title`. `disableNativeTooltips()` strips
    // `title` app-wide, and this button has visible text so the attribute is dropped with no
    // `aria-label` fallback — a `title` assertion would pass in jsdom and show nothing in the app
    // (roborev 59437). Asserting the element is what makes the explanation real.
    expect(screen.getByTestId("stale-fix-all-reason").textContent ?? "").toMatch(
      /blocked, diverged, or could not be diagnosed/i,
    );
    expect(btn.getAttribute("title")).toBeNull();
  });

  // While rows are still being diagnosed we must NOT state a definite negative verdict — the whole
  // feature is built on never asserting what we have not looked up (roborev 59437).
  it("says it is still diagnosing rather than claiming nothing can be fixed", async () => {
    let release!: (d: StaleDiagnosis) => void;
    diagnoseStale.mockReturnValue(new Promise<StaleDiagnosis>((r) => (release = r)));
    await renderPanel([target()]);

    const reason = screen.getByTestId("stale-fix-all-reason").textContent ?? "";
    expect(reason).toMatch(/diagnosing/i);
    expect(reason).not.toMatch(/blocked, diverged, or could not be diagnosed/i);
    release(diag({ remedy: "blocked-diverged", autoSafe: false }));
  });

  // ── ONE WEDGED DIAGNOSIS MAY NOT DISABLE THE BULK ACTION FOR EVERY OTHER ROW ──────────────────
  //
  // Nothing bounds a diagnosis — `repo_stale_diagnose` shells out to git, which can block on an
  // index.lock indefinitely — so gating `disabled` on "any row is still loading" let a single stuck
  // project take the control away from the rows that HAD answered, permanently, under a reassuring
  // "Diagnosing…" (roborev 59454). This is the test that keeps the gate off: it asserts the button
  // is pressable AND that pressing it acts on the ready root, so re-adding `|| stillDiagnosing` to
  // `disabled` turns it red twice over.
  //
  // It also pins the WORDING for this state. The reason element is the button's `aria-describedby`
  // target — its only description — so an enabled control described as "Diagnosing these
  // checkouts…" would announce no action at all, and would not warn that the unfinished rows get
  // skipped. The mixed-state sentence has to say both.
  //
  // ONE test, three rows — actionable + diagnosed-but-blocked + still-loading. It used to be two,
  // and the second was fixture duplication of the first (knightwatch probe 9 on PR #1396): the
  // wording branch and the blocked row are the same production path, so proving them apart cost a
  // whole extra render for one added assertion.
  it("stays pressable when ONE row is wedged, and says what pressing it will and will not do", async () => {
    // DISTINCT cause text per row, never the shared default: the skip line is asserted verbatim
    // below, so two rows carrying the same sentence would let a `skipReason` that read the WRONG
    // row's diagnosis pass. The name alone does not prove the cause was routed per row.
    const divergedCause = "This checkout has 3 commits origin/main does not, so no fast-forward exists.";
    diagnoseStale.mockImplementation((root: string) => {
      if (root === "/repos/sparkle") return Promise.resolve(diag());
      if (root === "/repos/website")
        return Promise.resolve(diag({ remedy: "blocked-diverged", autoSafe: false, cause: divergedCause }));
      return new Promise<StaleDiagnosis>(() => {}); // never resolves: the wedged git call
    });
    remedyStale.mockResolvedValue(outcome());
    await renderPanel([
      target(),
      target({ id: "website", name: "drodio-website", rootPath: "/repos/website" }),
      target({ id: "wedged", name: "wedged-repo", rootPath: "/repos/wedged" }),
    ]);
    await screen.findByTestId("stale-remedy-sparkle");

    const btn = screen.getByTestId("stale-fix-all") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    const reason = screen.getByTestId("stale-fix-all-reason").textContent ?? "";
    // Only ONE row is actionable, and the sentence must not imply only one was DIAGNOSED —
    // `actionableCount` is the diagnosed-AND-actionable count (roborev 59486).
    expect(reason).toMatch(/fast-forward the 1 checkout that can be moved safely so far/i);
    expect(reason).not.toMatch(/diagnosed so far/i);
    // The diagnosed-but-blocked row is accounted for…
    expect(reason).toMatch(/every other row is left alone with its reason shown/i);
    // …and so is the one still in flight. Both kinds, in the button's only description.
    expect(reason).toMatch(/still being diagnosed is skipped and named/i);

    fireEvent.click(btn);

    // It moved the row that answered…
    await waitFor(() => expect(remedyStale).toHaveBeenCalledWith("/repos/sparkle"));
    // …and NOTHING else. Both other rows are reported, by name, with their two DIFFERENT reasons —
    // which is what makes them load-bearing here rather than scenery (roborev 59499).
    expect(remedyStale).toHaveBeenCalledTimes(1);
    expect((await screen.findByTestId("stale-skip-website")).textContent).toBe(
      `Skipped drodio-website — ${divergedCause}`,
    );
    // PAST TENSE: nothing clears this line when the slow diagnosis later lands, so it has to stay
    // true afterwards — a present-tense claim would end up above a fully diagnosed row.
    expect((await screen.findByTestId("stale-skip-wedged")).textContent).toBe(
      "Skipped wedged-repo — its diagnosis had not finished when Fix all safe ran.",
    );
  });

  // ── THE SET IT WILL TOUCH IS FIXED WHEN YOU PRESS IT ──────────────────────────────────────────
  //
  // The run is sequential and each remedy is a git merge plus a re-diagnosis, so it takes seconds.
  // Reading each row's state when the loop REACHED it therefore let a diagnosis that landed DURING
  // the run promote its row into the actionable set — a checkout mutated though it was in neither
  // the count the button names nor the skips it promises (knightwatch probe 2). Nothing else in the
  // suite can see the difference: every other pending row here never resolves at all.
  it("does not act on a row whose diagnosis lands mid-run, and still names it as skipped", async () => {
    let releaseLate!: (d: StaleDiagnosis) => void;
    diagnoseStale.mockImplementation((root: string) =>
      root === "/repos/sparkle"
        ? Promise.resolve(diag())
        : new Promise<StaleDiagnosis>((r) => (releaseLate = r)),
    );
    // The remedy is held open so the late diagnosis lands strictly INSIDE the run — the exact
    // window the old code re-read. Resolving it before the click would prove nothing.
    let finishRemedy!: (o: RemedyOutcome) => void;
    remedyStale.mockReturnValue(new Promise<RemedyOutcome>((r) => (finishRemedy = r)));
    await renderPanel([
      target(),
      target({ id: "late", name: "late-repo", rootPath: "/repos/late" }),
    ]);
    await screen.findByTestId("stale-remedy-sparkle");

    fireEvent.click(screen.getByTestId("stale-fix-all"));
    await waitFor(() => expect(remedyStale).toHaveBeenCalledWith("/repos/sparkle"));

    // Mid-run: the wedged row answers, and answers ACTIONABLE — the tempting case.
    releaseLate(diag());
    await screen.findByTestId("stale-remedy-late");
    finishRemedy(outcome());

    // It is not touched, because it was not in the set the user pressed…
    await screen.findByTestId("stale-skip-late");
    expect(remedyStale).toHaveBeenCalledTimes(1);
    expect(remedyStale).not.toHaveBeenCalledWith("/repos/late");
    // …and the skip line is the run's own report, so it stays true beside the now-diagnosed row.
    expect(screen.getByTestId("stale-skip-late").textContent).toBe(
      "Skipped late-repo — its diagnosis had not finished when Fix all safe ran.",
    );
  });

  // ── …BUT THE SNAPSHOT IS AN UPPER BOUND, NOT THE VERDICT ──────────────────────────────────────
  //
  // The press-time read fixed the "promoted mid-run" hole and opened its mirror image: the offered
  // set is now consulted SECONDS after it was taken, so a row whose diagnosis has since been revised
  // would be fast-forwarded on a verdict the panel no longer holds. The panel's rule is that it acts
  // only on `ready` + a live remedy, so every row is re-checked at its turn. A `targets` change is
  // the reachable trigger: it re-runs the diagnosis effect over the whole panel mid-run.
  it("re-checks each row at its turn and drops one whose diagnosis was revised mid-run", async () => {
    const revised = "This checkout now has 2 commits origin/main does not, so no fast-forward exists.";
    byRoot({ "/repos/sparkle": diag(), "/repos/other": diag() });
    let finishRemedy!: (o: RemedyOutcome) => void;
    remedyStale.mockReturnValue(new Promise<RemedyOutcome>((r) => (finishRemedy = r)));
    const other = target({ id: "other", name: "other-repo", rootPath: "/repos/other" });
    const { rerender } = await renderPanel([target(), other]);
    await screen.findByTestId("stale-remedy-other");

    // BOTH rows are offered at the press — this is not the loading case the test above covers.
    fireEvent.click(screen.getByTestId("stale-fix-all"));
    await waitFor(() => expect(remedyStale).toHaveBeenCalledWith("/repos/sparkle"));

    // Mid-run, while row 1's merge is still open: a third project goes stale, which re-diagnoses
    // the whole panel — and row 2 comes back DIVERGED. The snapshot still says fast-forward.
    byRoot({
      "/repos/sparkle": diag(),
      "/repos/other": diag({ remedy: "blocked-diverged", autoSafe: false, cause: revised }),
      "/repos/third": diag(),
    });
    rerender(
      <StaleCheckoutPanel
        anchorEl={null}
        targets={[target(), other, target({ id: "third", name: "third-repo", rootPath: "/repos/third" })]}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("stale-cause-other").textContent).toBe(revised));

    finishRemedy(outcome());

    // The loop reaches row 2 and does NOT merge it — the live answer outranks the snapshot…
    await screen.findByTestId("stale-skip-other");
    expect(remedyStale).toHaveBeenCalledTimes(1);
    expect(remedyStale).not.toHaveBeenCalledWith("/repos/other");
    // …and it is named with the reason it has NOW. The press-time reason would have said the row
    // was fast-forwardable, i.e. reported a skip while asserting there was nothing to skip for.
    expect(screen.getByTestId("stale-skip-other").textContent).toBe(`Skipped other-repo — ${revised}`);
  });

  // ── THE SAME DROP, ONE ORDERING EARLIER — AND IT NEEDS ITS OWN SENTENCE ────────────────────────
  //
  // The test above releases the remedy only AFTER the revised diagnosis has landed, so it never
  // enters the window the `targets` change opens FIRST: every row is reset to `loading` while the
  // re-diagnosis runs. A row dropped there was offered — its diagnosis plainly HAD finished when
  // the button was pressed — so the "had not finished when Fix all safe ran" line is false of it,
  // and contradicts the count the user just pressed (roborev 59702).
  it("says a re-run diagnosis was re-running, not that it never finished", async () => {
    byRoot({ "/repos/sparkle": diag(), "/repos/other": diag() });
    let finishRemedy!: (o: RemedyOutcome) => void;
    remedyStale.mockReturnValue(new Promise<RemedyOutcome>((r) => (finishRemedy = r)));
    const other = target({ id: "other", name: "other-repo", rootPath: "/repos/other" });
    const { rerender } = await renderPanel([target(), other]);
    await screen.findByTestId("stale-remedy-other");

    fireEvent.click(screen.getByTestId("stale-fix-all"));
    await waitFor(() => expect(remedyStale).toHaveBeenCalledWith("/repos/sparkle"));

    // A third project goes stale mid-run, so the whole panel re-diagnoses — and row 2's re-run is
    // still in flight when the loop reaches it. HELD OPEN on purpose: the settled case is the test
    // above, and resolving it here would collapse this back into that one.
    diagnoseStale.mockImplementation((root: string) =>
      root === "/repos/other" ? new Promise<StaleDiagnosis>(() => {}) : Promise.resolve(diag()),
    );
    rerender(
      <StaleCheckoutPanel
        anchorEl={null}
        targets={[target(), other, target({ id: "third", name: "third-repo", rootPath: "/repos/third" })]}
        onClose={() => {}}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("stale-cause-other").textContent).toBe("Diagnosing…"));

    finishRemedy(outcome());

    // Still not merged — an unsettled row is never acted on…
    await screen.findByTestId("stale-skip-other");
    expect(remedyStale).toHaveBeenCalledTimes(1);
    expect(remedyStale).not.toHaveBeenCalledWith("/repos/other");
    // …and the line says what actually happened. "had not finished when Fix all safe ran" would be
    // a false statement about a row that was counted as fast-forwardable at the press.
    expect(screen.getByTestId("stale-skip-other").textContent).toBe(
      "Skipped other-repo — its diagnosis was being re-run when Fix all safe reached it.",
    );
  });

  // ── A BULK RUN OWNS EVERY ROW FOR ITS DURATION ────────────────────────────────────────────────
  //
  // The per-row buttons were disabled only by their OWN `busy`, so a row could be fast-forwarded by
  // hand while the bulk loop was awaiting an earlier row — two writers on one checkout, and the
  // loop's live re-check cannot see a remedy that is still in flight (nothing has been re-diagnosed
  // yet). Locking them for the run is what makes that window not exist.
  it("locks the per-row buttons for the duration of a bulk run, then releases them", async () => {
    byRoot({ "/repos/sparkle": diag(), "/repos/other": diag() });
    let finishRemedy!: (o: RemedyOutcome) => void;
    remedyStale.mockReturnValue(new Promise<RemedyOutcome>((r) => (finishRemedy = r)));
    await renderPanel([target(), target({ id: "other", name: "other-repo", rootPath: "/repos/other" })]);
    await screen.findByTestId("stale-remedy-other");

    fireEvent.click(screen.getByTestId("stale-fix-all"));
    await waitFor(() => expect(remedyStale).toHaveBeenCalledWith("/repos/sparkle"));

    const rowBtn = screen.getByTestId("stale-remedy-other") as HTMLButtonElement;
    expect(rowBtn.disabled).toBe(true);
    // LOCKED, NOT BUSY. Only the row the run is actually working on may claim the busy label; a row
    // that merely cannot be double-driven must not announce work nobody is doing.
    expect(rowBtn.textContent).toBe("Fast-forward");
    expect((screen.getByTestId("stale-remedy-sparkle") as HTMLButtonElement).textContent).toBe(
      "Fast-forwarding…",
    );

    // Pressing it does nothing — the second writer never starts.
    fireEvent.click(rowBtn);
    expect(remedyStale).toHaveBeenCalledTimes(1);
    expect(remedyStale).not.toHaveBeenCalledWith("/repos/other");

    // The lock is scoped to the run: once it finishes, the row is hand-drivable again.
    finishRemedy(outcome());
    await waitFor(() => expect(remedyStale).toHaveBeenCalledWith("/repos/other"));
    await waitFor(() =>
      expect((screen.getByTestId("stale-remedy-other") as HTMLButtonElement).disabled).toBe(false),
    );
  });
});

describe("dismissal", () => {
  it("closes on the click-away backdrop", async () => {
    byRoot({ "/repos/sparkle": diag() });
    const onClose = vi.fn();
    await renderPanel([target()], onClose);
    fireEvent.click(screen.getByTestId("stale-panel-backdrop"));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    byRoot({ "/repos/sparkle": diag() });
    const onClose = vi.fn();
    await renderPanel([target()], onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
