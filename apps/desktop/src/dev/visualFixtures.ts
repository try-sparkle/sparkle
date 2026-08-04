// DEV-ONLY seeded fixture data for the visual-fidelity harness (scripts/visual/).
//
// WHY THIS EXISTS. The auth bypass (devBypassAuth.ts) gets a headless browser past the paywall, but
// it lands on an EMPTY workspace: every backend read goes through Tauri `invoke`, which no-ops in a
// plain browser, so the sidebar says "Create a project to add agents". You cannot measure the
// fidelity of an agent row that isn't rendered.
//
// WHY IT IS SEEDED RATHER THAN REAL. A screenshot diff is only a measurement if the same input
// produces the same pixels. Real data fails that on three axes at once: uuids differ per run,
// `lastOpenedAt`/`createdAt` are `Date.now()`, and every "3m ago" in the sidebar is a subtraction
// against the wall clock. So everything here is a CONSTANT — fixed ids, fixed names, fixed
// statuses, and timestamps expressed as offsets from FIXTURE_NOW, which the harness pins
// `Date.now()` to (scripts/visual/serve.mjs, FROZEN_CLOCK). Change one and you change the baseline;
// that is the point.
//
// SAFETY. Gated on devBypassAuthEnabled(), which is itself gated on `import.meta.env.DEV` — FALSE
// in any `vite build` artifact. So this can never seed a shipped bundle, regardless of env vars.
//
// SAFETY, PART TWO — WHAT THE GATE DOES *NOT* BUY. Both stores seeded here are `persist`-backed by
// localStorage, so a plain `setState` writes THROUGH to disk. The two gates are the dev bypass flag
// and `?visual=1`, and a developer who keeps VITE_SPARKLE_DEV_BYPASS_AUTH=1 in their environment
// and opens their own dev server with `?visual=1` — to reproduce a capture by hand, say — satisfies
// both. That would have overwritten their real project list and their removal tombstones, with no
// undo. detachPersistence() below stops the write at the storage layer, so reloading without
// `?visual=1` restores their session. (roborev 54701)
//
// THE PRECISE GUARANTEE IS "no STORE write reaches disk", not "memory-only". detachPersistence only
// covers zustand `persist` storage. Code that writes localStorage directly is unaffected — notably
// capture/LastFocusedProjectTracker, which stamps `sparkle-last-focused-project` with the selected
// project on mount/focus and will therefore record the fixture project id, outliving the tab. That
// key degrades benignly (lastFocusedProject falls back to the first project), so it is left alone
// rather than special-cased; what is NOT acceptable is a comment claiming a guarantee wider than
// the mechanism delivers. (roborev 54756)

import { createJSONStorage } from "zustand/middleware";
import type { AgentTab, Project } from "../types";
import type { AgentTabStatus } from "@sparkle/ui";
import type { WorkflowStageId } from "../engine/workflowStage";
import type { BranchStatus } from "../services/branchStatus";
import type { AgentGoal } from "../engine/agentGoal";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useCableStore } from "../stores/cableStore";
import { useUiStore } from "../stores/uiStore";
import { useDictationStore } from "../stores/dictationStore";
import { useInboxStore } from "../stores/inboxStore";
// THE APP'S OWN KEYS AND FLOOR, imported rather than re-spelled. `engine/columnResize` is a true
// leaf (no imports at all), so this costs nothing at module scope and keeps this file — and its
// node-environment test — clear of the Workspace graph. See `visualConciergeWidth` for why a
// re-spelled key is not a cosmetic issue here but a silently mislabelled screenshot.
import {
  CONCIERGE_WIDTH_KEY,
  CONCIERGE_WIDTH_KEY_PAIRED,
  acceptsStoredConciergeWidth,
} from "../engine/columnResize";
import { devBypassAuthEnabled } from "./devBypassAuth";

/** The query parameter that turns fixtures on: `?visual=1`. */
export const VISUAL_FIXTURES_PARAM = "visual";

/**
 * The pinned instant, as epoch ms — 2026-07-28T17:00:00Z.
 *
 * MUST equal FROZEN_CLOCK's FIXED in scripts/visual/serve.mjs. They are asserted equal by
 * visualFixtures.test.ts, because a drift between them silently reintroduces exactly the
 * wall-clock dependence this file exists to remove.
 */
export const FIXTURE_NOW = Date.UTC(2026, 6, 28, 17, 0, 0);

const MINUTE = 60_000;

/** `?visual=1` / `?visual=true`. Pure so the parse is testable without a browser. */
export function visualFixturesRequested(search: string): boolean {
  const v = new URLSearchParams(search).get(VISUAL_FIXTURES_PARAM);
  return v === "1" || v === "true";
}

export const FIXTURE_PROJECT_ID = "visual-fixture-project";

/**
 * The primary project's root path.
 *
 * A CONSTANT RATHER THAN A LITERAL because it is now a KEY as well as a field: `project_open_prs`
 * is answered per root path (see {@link FIXTURE_PRS_BY_ROOT}), so the string the project carries and
 * the string the lookup is keyed on are the same fact. Spelled twice, a one-character drift makes
 * the probe resolve to `null` — "we could not ask" — and the menu renders NOTHING, which
 * photographs as a perfectly plausible empty header rather than as a failure.
 */
export const FIXTURE_PROJECT_ROOT = "/Users/dev/Projects/sparkle";

/** The second project, seeded onto the LEFT pair only when `?pairs=2` is asked for. */
export const FIXTURE_LEFT_PROJECT_ID = "visual-fixture-project-left";

/** The second OPEN-TAB project, seeded only when `?projects=2` is asked for. */
export const FIXTURE_SECOND_PROJECT_ID = "visual-fixture-project-website";

/** Its root path — the second key in {@link FIXTURE_PRS_BY_ROOT}. See {@link FIXTURE_PROJECT_ROOT}. */
export const FIXTURE_SECOND_PROJECT_ROOT = "/Users/dev/Projects/drodio-website";

/** The left project's selected row — the one whose seam a left-pair capture is taken to inspect. */
const LEFT_SELECTED_ROW_ID = "vfx-left-agent-1";

/** The query parameter that opens the SECOND pair: `?pairs=2`. */
export const VISUAL_PAIRS_PARAM = "pairs";

/**
 * How many pairs the capture wants. Default 1 — the single-pair cockpit every existing surface is
 * baselined against, which must not move.
 *
 * OPT-IN, and that is the whole design constraint. `workspace-wired-left` needs a project on the
 * left pair (`useEffectiveWired` refuses to project a side whose far end has no selected agent), but
 * seeding one unconditionally opens a second pair and re-lays-out EVERY other surface — so the
 * fixture would fix one capture by invalidating the baselines of all the rest. A parameter keeps the
 * default seed byte-identical and lets exactly the surfaces that need two pairs ask for them.
 */
export function visualPairCount(search: string): 1 | 2 {
  return new URLSearchParams(search).get(VISUAL_PAIRS_PARAM) === "2" ? 2 : 1;
}

/** The query parameter that narrows the concierge column: `?concierge=<px>`. */
export const VISUAL_CONCIERGE_WIDTH_PARAM = "concierge";

/**
 * The concierge width a capture asks for, or null for "this surface names no width".
 *
 * NULL DOES NOT MEAN "the app's own default" BY ITSELF — it did not, for as long as this docblock
 * said so. `localStorage` is origin-scoped and survives navigation, and the harness runs every
 * surface in one browser, so a width-less surface inherited whatever the last one wrote. Under the
 * harness (`visualCaptureRun`) the seeder now CLEARS the keys on this path, which is what finally
 * makes null mean the default; outside it, null still means "leave the developer's own width alone"
 * (roborev 57717).
 *
 * OPT-IN for the reason every parameter here is (see {@link visualPairCount}): the width is the
 * layout's biggest lever, so seeding one unconditionally would re-lay-out and invalidate every
 * existing surface's baseline.
 *
 * WHY A CAPTURE WOULD WANT THIS AT ALL — a whole class of chrome bug is INVISIBLE at a comfortable
 * width and only appears when a column is squeezed. The open-PR menu shipped clipped to its column
 * (bead sparkle-8g4qh) and no capture could have caught it, because every surface photographs the
 * concierge at its 380px default where the panel still looks fine.
 *
 * BOUNDED BY THE APP'S OWN PREDICATE, not by constants this file compares for itself.
 * `acceptsStoredConciergeWidth` is what `Workspace`'s state initialiser calls on exactly these two
 * keys, so "a width the initialiser will keep" has ONE definition and this cannot drift out of step
 * with it. Bounding on the COLUMN constants — even imported ones, as this did — was not enough:
 * `Workspace` validates against the CONCIERGE's bounds, which merely alias them today, and that
 * ceiling was 560 until recently. Tighten either and a value accepted here is rejected there, the
 * app silently falls back to `CONCIERGE_DEFAULT_WIDTH`, and `open-pr-menu-narrow` files a 360px
 * capture under a name claiming otherwise. Sharing the bounds would still leave two call sites free
 * to compare them differently; sharing the predicate leaves nothing to drift (roborev 57514).
 *
 * ONLY THE SINGLE-PAIR ARM, and the reasoning is worth spelling out because two earlier versions of
 * this paragraph got it wrong in opposite directions (roborev 57533, 57534). The seeder writes both
 * keys, so requiring both ceilings looks right. It is not, and the reason is the initialiser's
 * fallback chain: `paired = accepts(rawPaired, {paired:true}) ? rawPaired : single`. A rejected
 * PAIRED value falls back to the SINGLE width rather than to the default, so a width the single
 * ceiling accepts and the paired one refuses is still KEPT at that width by the initialiser in both
 * layouts. Refusing it here instead writes NO key, which lands on `CONCIERGE_DEFAULT_WIDTH` — a 360px
 * capture under a name claiming otherwise, i.e. the guard causing the very failure it exists to
 * prevent.
 *
 * KEPT IS NOT PAINTED, and that distinction is the whole of what this bound does not cover. In the
 * two-pair layout the paint ceiling is `conciergePairedMax`, which never exceeds
 * `CONCIERGE_PAIRED_HARD_MAX` — so once the two ceilings part, a `pairs=2` surface asking for a `W`
 * between them is stored at `W` and PAINTED at the paired cap. That is a real hazard and it is
 * simply not this function's to catch: the backstop is the per-surface paint guard in
 * `Workspace.resize.test.tsx`, which mounts each surface in ITS OWN layout (which is exactly why it
 * replays the surface's whole query rather than the width alone). See also the scope note below.
 *
 * The reverse direction really does diverge at the initialiser — a width above the single ceiling
 * but under the paired one gives `single = DEFAULT` and `paired = W` — and that is the case the
 * `{paired: false}` arm refuses. One arm, because one of the two is this function's problem.
 *
 * THE CEILING WAS A LITERAL `1400` AND THAT WAS THE SAME BUG AT THE OTHER END (roborev 57518). The
 * shell's real cap is `COLUMN_HARD_MAX`, so 1400 rejected widths the app accepts and persists —
 * including the founder's ~1920 cockpit layout, which is described in `CONCIERGE_WIDTH_KEY_PAIRED`'s
 * own docblock. A surface asking for `?concierge=1920` parsed to null, wrote no key, and would have
 * photographed the default column under a filename claiming a wide one. A bound that is a second
 * spelling of the app's bound is a bound that can silently disagree with it.
 *
 * ── WHAT THIS DOES *NOT* GUARANTEE, stated plainly because an earlier version of this note claimed
 * otherwise (roborev 57522) ──────────────────────────────────────────────────────────────────────
 * The predicate answers the STORED-WIDTH half only: will the initialiser keep this number. The
 * shell clamps again at PAINT time — `renderedConciergeWidth = min(width, conciergeMax)`, and
 * `conciergeMax` is window-aware — so a width accepted here can still photograph NARROWER than the
 * filename claims once it exceeds what the capture viewport can paint. At the harness's 1600px
 * viewport that ceiling is ~1234, far below the 8000 this predicate allows.
 *
 * That is deliberately NOT fixed by a branch here. It would make this parser viewport-dependent for
 * a case no surface is anywhere near — the parameter exists to photograph NARROW columns, which is
 * the opposite end — and it is a surface-authoring mistake rather than a runtime condition. It is
 * guarded where it can be observed instead: `Workspace.resize.test.tsx` mounts the real shell at
 * the real capture viewport for every surface that asks for a width, and fails if the painted width
 * is not the one requested.
 */
export function visualConciergeWidth(search: string): number | null {
  const raw = new URLSearchParams(search).get(VISUAL_CONCIERGE_WIDTH_PARAM);
  if (raw === null) return null;
  const n = Number(raw);
  // Integers only — a fractional or exponent-suffixed width is a typo, not a state to photograph.
  // This is a query-string concern rather than a stored-width one, so it stays here.
  if (!Number.isInteger(n)) return null;
  return acceptsStoredConciergeWidth(n, { paired: false }) ? n : null;
}

/** The query parameter the CAPTURE HARNESS adds to every surface: `?capture=1`. */
export const VISUAL_CAPTURE_PARAM = "capture";

/**
 * Whether the visual-capture harness is driving this page, as opposed to a developer who typed
 * `?visual=1` at their own dev server.
 *
 * A SEPARATE CLAIM FROM `?visual=1`, and the difference decides whether the fixture may RESET state
 * rather than only seed it. The harness gives each surface a fresh page but runs them all in ONE
 * browser, and `localStorage` is origin-scoped — so anything a surface does not set is inherited
 * from whichever surface ran before it, and a capture's meaning comes to depend on the order the
 * run happened to take. Clearing the keys the fixture owns fixes that.
 *
 * It is gated on this rather than on `?visual=1` because the concierge widths are NOT
 * zustand-persisted, so `detachPersistence` does not cover them: they are a real preference on a
 * real machine, and wiping them because someone opened their own dev server with `?visual=1` would
 * be the fixture destroying user data. The harness's own profile is a throwaway user-data-dir, so
 * there it costs nothing.
 */
export function visualCaptureRun(search: string): boolean {
  const v = new URLSearchParams(search).get(VISUAL_CAPTURE_PARAM);
  return v === "1" || v === "true";
}

/** The query parameter that seeds open pull requests: `?prs=1`. */
export const VISUAL_PRS_PARAM = "prs";

/** Whether this capture wants the PR chip populated. Opt-in — see {@link FIXTURE_PRS}. */
export function visualPrsRequested(search: string): boolean {
  const v = new URLSearchParams(search).get(VISUAL_PRS_PARAM);
  return v === "1" || v === "true";
}

/** The query parameter that opens a SECOND project tab: `?projects=2`. */
export const VISUAL_PROJECTS_PARAM = "projects";

/**
 * How many projects the capture wants OPEN AS TABS. Default 1 — the single-project workspace every
 * existing surface is baselined against, which must not move.
 *
 * OPT-IN for the same reason {@link visualPairCount} is, and it is a genuinely different axis from
 * that one. `?pairs=2` opens a second COLUMN PAIR (a project projected onto the left side of the
 * cockpit, which is how the wired-left cable reaches a far end); this opens a second TAB in the one
 * pair that is already there. A capture can ask for both, or for either alone.
 *
 * WHY A CAPTURE WOULD WANT THIS — the open-PR menu is a MULTI-REPO surface the moment more than one
 * project is open: two repos' PR lists have to be told apart by section, and PR numbers are only
 * unique within a repo, so `#1088` can legitimately name two different pull requests at once. None
 * of that is photographable against a workspace holding a single project, which is why the fixture
 * seeds a second one with a DIFFERENT PR list (see {@link FIXTURE_PRS_BY_ROOT}) rather than a second
 * copy of the same rows.
 *
 * A COUNT rather than a boolean, mirroring `visualPairCount`, because the parameter's value IS a
 * count and the two read as a pair at every call site. Only `2` turns it on; anything else — absent,
 * `1`, `3`, a typo — leaves the default single-project seed untouched, so a malformed parameter can
 * never half-apply.
 */
export function visualProjectCount(search: string): 1 | 2 {
  return new URLSearchParams(search).get(VISUAL_PROJECTS_PARAM) === "2" ? 2 : 1;
}

/**
 * The rows `project_open_prs` answers with under `?prs=1`.
 *
 * CHOSEN TO EXERCISE THE THINGS THAT TRUNCATE, not to look tidy. The bug this exists to photograph
 * was reported as four separate elisions, and a fixture of three short green PRs would reproduce
 * none of them. So: a long real-world subject, a long branch name, a red PR whose blocking reason
 * is a multi-word string ("3 checks failing"), and enough green rows that the primary action reads
 * "Merge all ready (2)" rather than a narrow "Merge all ready".
 *
 * `mergeStateStatus: "blocked"` on the failing row keeps it out of the two-step override path, so
 * the row renders the disabled Merge rather than an armed "Merge anyway?" — deterministic either
 * way, but the disabled form is the one the founder screenshotted.
 */
export const FIXTURE_PRS = [
  {
    number: 1095,
    title: "feat(concierge): give the header its own quiet state and keep goals visible",
    headRefName: "sparkle/header-quiet-and-goals-visible",
    url: "https://github.com/o/r/pull/1095",
    checks: "passing",
    mergeable: "mergeable",
  },
  {
    number: 1088,
    title: "fix(pr-menu): stop clipping the merge panel to the concierge column",
    headRefName: "sparkle/pr-menu-spans-the-window",
    url: "https://github.com/o/r/pull/1088",
    checks: "failing",
    mergeable: "mergeable",
    mergeStateStatus: "blocked",
    failingChecks: ["CI / test (node)", "CI / typecheck", "secret-scan"],
    pendingChecks: [],
  },
  {
    number: 1072,
    title: "chore(ci): gate the shell-syntax check on the changed files only",
    headRefName: "sparkle/shell-syntax-gate",
    url: "https://github.com/o/r/pull/1072",
    checks: "pending",
    mergeable: "mergeable",
    failingChecks: [],
    pendingChecks: ["CI / build (macos)"],
  },
  {
    number: 1070,
    title: "fix(voice): plumb the push-to-talk held state through to the tray",
    headRefName: "sparkle/voice-fill-and-kbd",
    url: "https://github.com/o/r/pull/1070",
    checks: "passing",
    mergeable: "mergeable",
  },
  {
    // ── THE NO-MERGE-RIGHTS ROW (bead sparkle-j881r) ─────────────────────────────────────────
    //
    // GREEN BY EVERY OTHER MEASURE — passing checks, mergeable, clean — and still un-mergeable,
    // which is the entire point of putting it in a picture. This is the founder's reported case: a
    // pull request into an open-source repo he does not control, where the app used to draw a
    // confident one-click Merge whose only possible outcome was `GraphQL: <user> does not have the
    // correct permissions to execute MergePullRequest`.
    //
    // A row whose checks were also red could not photograph it: the reader would have no way to
    // tell whether the button is disabled because of the checks or because of the rights, and the
    // capture would score the same whether the pre-check works or not.
    number: 39,
    title: "feat(upstream): contribute the retry backoff we needed downstream",
    headRefName: "sparkle/upstream-retry-backoff",
    url: "https://github.com/o/upstream/pull/39",
    checks: "passing",
    mergeable: "mergeable",
    mergeStateStatus: "clean",
    headRefOid: "5f3a1c2",
    viewerCanMerge: false,
  },
  {
    // ── THE DISMISSED ROW ────────────────────────────────────────────────────────────────────
    //
    // Seeded as dismissed by {@link FIXTURE_DISMISSALS}, so the capture shows the Dismissed section
    // populated rather than an empty affordance. It must NOT appear in the ready list above, and
    // its fingerprint below matches this row exactly — a mismatched SHA would revive it on the
    // first poll and the section would photograph as empty for reasons no reader could see.
    number: 21,
    title: "wip(docs): rework the footer — superseded by #1095",
    headRefName: "sparkle/footer-rework",
    url: "https://github.com/o/r/pull/21",
    checks: "passing",
    mergeable: "mergeable",
    mergeStateStatus: "clean",
    headRefOid: "9b0d4e7",
    viewerCanMerge: true,
  },
] as const;

/**
 * The SECOND project's rows — a different repo, answered under `?projects=2`.
 *
 * DELIBERATELY SHORT, AND DELIBERATELY COLLIDING. Short because its job is not to re-photograph the
 * truncation cases {@link FIXTURE_PRS} already covers: two lists of four look like one long list and
 * would make the section boundary the hardest thing in the picture to find. Three rows against four
 * makes the grouping legible at a glance.
 *
 * The collision is the load-bearing part. `#1088` is ALSO a pull request in the primary project's
 * list, and that is not an accident to be tidied away: a PR number is unique within a repo and
 * nowhere else, so a grouped menu that keys anything — a row, a selection, a merge, a React `key` —
 * on the number alone is silently wrong the moment two repos are open. A fixture without a collision
 * cannot photograph that mistake; with one, the picture either shows two distinct rows or shows the
 * bug. Its title, branch and URL all differ from #1088's in the other list, so the two are
 * distinguishable BY EYE in the capture rather than only in the DOM.
 *
 * AND THEIR STATUSES ARE OPPOSITE, which is what makes the picture decisive rather than merely
 * suggestive. #1088 in the primary list is the RED, blocked row; #1088 here is green and ready. A
 * menu that resolves a row by number alone therefore renders a wrong DOT and a wrong merge
 * affordance — visible at a glance in a screenshot — instead of a subtly wrong link that a reader
 * would have to open to catch.
 *
 * Two greens here, on top of the primary list's two, also make any cross-repo "Merge all ready (N)"
 * count read 4 rather than 2 — a number that is wrong in a visible way if the grouping mis-scopes it.
 */
export const FIXTURE_SECOND_PRS = [
  {
    // THE COLLIDING NUMBER. Same `number` as a row in FIXTURE_PRS, different everything else.
    number: 1088,
    title: "feat(pricing): rebuild the credits table around the new tiers",
    headRefName: "site/pricing-credits-table",
    url: "https://github.com/o/site/pull/1088",
    checks: "passing",
    mergeable: "mergeable",
  },
  {
    number: 964,
    title: "chore(deps): take the security patch for the markdown renderer",
    headRefName: "site/markdown-security-patch",
    url: "https://github.com/o/site/pull/964",
    checks: "passing",
    mergeable: "mergeable",
  },
  {
    number: 42,
    title: "fix(nav): keep the mobile menu open while a submenu has focus",
    headRefName: "site/mobile-nav-focus",
    url: "https://github.com/o/site/pull/42",
    checks: "pending",
    mergeable: "mergeable",
    failingChecks: [],
    pendingChecks: ["Preview / build"],
  },
] as const;

/**
 * The dismissals `pr_dismissals` answers with, per PROJECT ID.
 *
 * Keyed on the project id rather than the root path because that is what the command is invoked
 * with — and because dismissals are per-project by design: PR numbers collide across repositories,
 * so a dismissal keyed on a bare number would hide a stranger's pull request.
 *
 * The fingerprint here has to MATCH the row it names in {@link FIXTURE_PRS}. `isRevived`
 * compares the two on every probe, so a stale `headRefOid` would mean the fixture un-dismisses its
 * own dismissal a beat after the capture starts — leaving a screenshot of an empty Dismissed
 * section that looks like a rendering bug and is really a fixture that disagrees with itself.
 */
export const FIXTURE_DISMISSALS: Record<string, readonly Record<string, unknown>[]> = {
  [FIXTURE_PROJECT_ID]: [
    {
      number: 21,
      headRefOid: "9b0d4e7",
      tone: "ready",
      viewerCanMerge: true,
      dismissedAt: Math.floor(FIXTURE_NOW / 1000) - 3600,
    },
  ],
};

/**
 * `project_open_prs`, ANSWERED PER ROOT PATH.
 *
 * The shim used to answer every call with one array regardless of its `root` argument, which was
 * fine while exactly one project existed and becomes a lie the moment two do: a grouped menu asking
 * "what is open in THIS repo" would get the same four rows for both and photograph a state the app
 * can never actually be in — two sections, identical contents, identical PR numbers throughout. The
 * capture would look like working grouping and prove nothing.
 *
 * Keyed on the ROOT PATH rather than the project id because `root` is what the command is invoked
 * with (`invoke("project_open_prs", { root, projectId })`) — `fetchOpenPrs`'s first argument is the
 * project's `rootPath`. Keying on the id would mean reading a field the command does not promise to
 * carry.
 */
export const FIXTURE_PRS_BY_ROOT = {
  [FIXTURE_PROJECT_ROOT]: FIXTURE_PRS,
  [FIXTURE_SECOND_PROJECT_ROOT]: FIXTURE_SECOND_PRS,
} as const;

/**
 * The rows for one root, or `null` for a root the fixture has never heard of.
 *
 * NULL IS "UNKNOWN", NOT "EMPTY", and preserving that distinction is the whole reason this is a
 * function rather than an index expression. `fetchOpenPrs` collapses every failure — no `gh`,
 * unauthed, offline, no remote — into `null`, and `OpenPrMenu` deliberately renders nothing for both
 * null and `[]` while treating them differently everywhere else: a confident "no PRs" on a probe
 * that never ran is exactly the false reassurance the badge exists to prevent. An unknown root here
 * is the same fact, so it answers the same way the shim it wraps does.
 *
 * `hasOwnProperty` rather than `in` / a bare index: `root` arrives from the caller, and every
 * `Object.prototype` member ("toString", "constructor") is otherwise a "known" key that resolves to
 * a function the menu would try to iterate.
 */
export function fixturePrsForRoot(root: unknown): readonly unknown[] | null {
  if (typeof root !== "string") return null;
  if (!Object.prototype.hasOwnProperty.call(FIXTURE_PRS_BY_ROOT, root)) return null;
  return (FIXTURE_PRS_BY_ROOT as Record<string, readonly unknown[]>)[root] ?? null;
}

/** One agent row's worth of fixture, flattened so the table below reads as a spec. */
interface Row {
  id: string;
  name: string;
  kind: AgentTab["kind"];
  parentId: string | null;
  status: AgentTabStatus;
  /** Minutes since this agent's last turn — the `.el` elapsed readout in the mock. */
  elapsedMin: number;
  stage: WorkflowStageId;
  activity?: string;
  lastPrompt: string;
  /** This row's goal, if it has one. See {@link GOAL_STATES}. */
  goal?: AgentGoal;
  /**
   * This row's WORKTREE reading, seeded into `runtimeStore.branchStatus`.
   *
   * Omitted means "never polled", which is what the fixture used to be for every row — and that is
   * exactly why the stage ladder's `local_none` rung could not be photographed (sparkle-biezi):
   * `sectionOfRow` keeps an UNREAD row in `local_uncommitted` on purpose, so with no branchStatus
   * seeded at all, a capture looked identical with the split present and absent.
   *
   * `dirtyFiles` is what lets a capture show the row NAMING what it holds rather than just
   * asserting that it holds something.
   */
  worktree?: { dirty: boolean; dirtyFiles?: string[] };
}

/**
 * A goal in each of the four states a row can render, so a capture PROVES the row treatment for all
 * of them rather than one happy path.
 *
 * This exists because the roster carried no goals at all, and that made the agent-sidebar capture
 * unable to answer the founder's question — "if every agent had a goal, I would see it on the row"
 * (bead sparkle-6kz9q). A screenshot of six goal-less agents looks identical before and after a fix
 * to how goals are shown, so it could never have caught the regression, and could never demonstrate
 * the fix either.
 *
 * Every timestamp is an offset from {@link FIXTURE_NOW} for the same reason every other one here is:
 * `goalStateOf` and the "3h 20m left" readout are both `now`-relative, so a wall-clock goal would
 * make the row's own text change between two runs of the same capture.
 */
const HOUR = 60 * MINUTE;

const GOAL_STATES = {
  /** Live, with time on the clock — the common case, and the one that reads as invisible today. */
  unmet: {
    text: "Land the concierge column on the left edge",
    setAt: FIXTURE_NOW - 40 * MINUTE,
    ttlMs: 4 * HOUR,
    continues: 0,
    totalContinues: 0,
  },
  /** Achieved. `metAt` is what makes an idle agent legitimately done (see engine/agentGoal). */
  met: {
    text: "Fix the seam between the sidebar and the terminal",
    setAt: FIXTURE_NOW - 3 * HOUR,
    ttlMs: 4 * HOUR,
    metAt: FIXTURE_NOW - 20 * MINUTE,
    continues: 0,
    totalContinues: 2,
  },
  /** Past its TTL and never met — unfinished work whose auto-continue mandate ran out. */
  expired: {
    text: "Group the sidebar rows by workflow stage",
    setAt: FIXTURE_NOW - 5 * HOUR,
    ttlMs: 4 * HOUR,
    continues: 3,
    totalContinues: 6,
  },
  /** Auto-continue gave up and handed the agent back. The loudest state on the row. */
  escalated: {
    text: "Re-skin the settings dialog against rev4",
    setAt: FIXTURE_NOW - 90 * MINUTE,
    ttlMs: 4 * HOUR,
    continues: 20,
    totalContinues: 20,
    escalatedAt: FIXTURE_NOW - 10 * MINUTE,
    escalationReason: "no progress in 20 restarts",
  },
} satisfies Record<string, AgentGoal>;

/**
 * The roster. Chosen to light up every band the sidebar can group into — a red row that needs you,
 * a green working row, workers nested under a build parent, and a landed row — so a capture
 * exercises the group headers (`.grp`) and the status dot's full colour range rather than one
 * happy path. Names are deliberately mundane and of varied length: name truncation is a real
 * fidelity risk and a roster of equal-length names would hide it.
 *
 * GOALS ARE SPREAD THE SAME WAY, and the rows LEFT WITHOUT ONE are as deliberate as the four that
 * have one. The founder's test for the row treatment is "tell a goal-bearing agent from a
 * goal-less one at a glance" (bead sparkle-6kz9q), so a roster where every row carried a goal could
 * not photograph the distinction it exists to prove.
 *
 * THE CONTROL IS SAME-KIND, and that is the whole subtlety (roborev 57331). The first cut left the
 * two nested WORKERS goal-less while every goal sat on a top-level BUILD row — so "has a goal" was
 * perfectly confounded with "is a top-level build row", and a capture could not show which of the
 * two a visible difference came from. A control has to differ in the ONE variable under test, so
 * `vfx-agent-7` is a goal-less TOP-LEVEL BUILD row, matched against the four that carry goals.
 *
 * It is a seventh row rather than a demotion of one of the four because all four states have to stay
 * PHOTOGRAPHABLE: a worker under a collapsed head renders as a one-line peek (AgentSidebar's "THE
 * PEEK"), not a row, so a goal moved onto one would vanish from the very capture this table exists
 * to feed — trading a confounded control for an invisible state.
 */
const SELECTED_ROW_ID = "vfx-agent-1";

const ROWS: Row[] = [
  {
    id: SELECTED_ROW_ID,
    name: "Concierge column layout",
    kind: "build",
    parentId: null,
    status: "waiting",
    elapsedMin: 3,
    stage: "building_unsaved",
    activity: "Asking which side the pull tab belongs on",
    lastPrompt: "Move the concierge to the left edge and make it full height",
    goal: GOAL_STATES.unmet,
  },
  {
    id: "vfx-agent-2",
    name: "Wire the connection badge",
    kind: "worker",
    parentId: "vfx-agent-1",
    status: "working",
    elapsedMin: 1,
    stage: "building_unsaved",
    activity: "Drawing the cable between the row and the column",
    lastPrompt: "Render the wired badge only when data-wired is set",
  },
  {
    id: "vfx-agent-3",
    name: "Blueprint grid",
    kind: "worker",
    parentId: "vfx-agent-1",
    status: "approval",
    elapsedMin: 7,
    stage: "building_saved",
    activity: "Waiting on approval to touch index.css",
    lastPrompt: "Add the 26px blueprint grid behind the workspace",
  },
  {
    id: "vfx-agent-4",
    name: "Agent sidebar group headers",
    kind: "build",
    parentId: null,
    status: "idle",
    elapsedMin: 24,
    stage: "pull_request",
    lastPrompt: "Group the sidebar rows by workflow stage with a rule and a count",
    goal: GOAL_STATES.expired,
  },
  {
    id: "vfx-agent-5",
    name: "Settings dialog pass",
    kind: "build",
    parentId: null,
    status: "unmerged",
    elapsedMin: 96,
    stage: "merged_local",
    lastPrompt: "Re-skin the settings dialog against rev4",
    goal: GOAL_STATES.escalated,
  },
  {
    id: "vfx-agent-6",
    name: "Terminal seam",
    kind: "build",
    parentId: null,
    status: "done",
    elapsedMin: 240,
    stage: "shipped",
    lastPrompt: "Fix the seam between the sidebar and the terminal",
    goal: GOAL_STATES.met,
  },
  {
    // THE `sparkle-biezi` ROW: merged, finished, and its goal's TTL simply ran out.
    //
    // WHY IT HAD TO BE A NEW ROW rather than a tweak to `vfx-agent-4` (which is also idle with an
    // expired goal). That one sits at stage `pull_request`, so `hasUnmergedCommittedWork` is true and
    // it carries the `unlanded-work` cause — it renders red on the strength of the WORK and would go
    // on doing so whatever the expiry rule said. It therefore cannot photograph the expiry fix: the
    // shot would look identical before and after, which is the vacuous-capture failure the harness's
    // own history is full of. This row's ONLY stall cause is `expired-goal`, so its colour is a
    // direct readout of `stallEscalation.OUTSTANDING` membership.
    //
    // Modelled on the live agent in the founder's screenshot (11a52157, "Babysit PR 1104"): idle,
    // calm, asking nothing, work merged to main, goal expired — and painted red. It must render GRAY.
    id: "vfx-agent-8",
    name: "Babysit the release PR",
    kind: "build",
    parentId: null,
    status: "idle",
    elapsedMin: 310,
    stage: "merged",
    lastPrompt: "Watch PR 1104 through review and reply to anything that comes back",
    goal: GOAL_STATES.expired,
  },
  {
    // THE `Local: Nothing Yet` ROW — agent 11a52157 itself, the one the founder asked about.
    //
    // "I don't know why it's still in local uncommitted." Spotless worktree, zero commits of its
    // own, whole job was babysitting somebody else's PR. It demonstrates BOTH bugs on ONE row:
    // `gitDerivedStage` maps its `ahead === 0` to `building_unsaved` (so it filed under a heading
    // claiming its work was one close away from being lost), and its expired goal painted it red.
    // After the fix it must render GRAY, under "Local: Nothing Yet".
    id: "vfx-agent-9",
    name: "Watch the roborev queue",
    kind: "build",
    parentId: null,
    status: "idle",
    elapsedMin: 140,
    stage: "building_unsaved",
    lastPrompt: "Keep an eye on the roborev queue and triage anything that lands",
    goal: GOAL_STATES.expired,
    worktree: { dirty: false },
  },
  {
    // THE CONTROL FOR THAT SPLIT, and the row that photographs the other half of BUG 2. Same stage,
    // same idle status — the ONE variable that differs is whether the tree actually holds anything.
    // It must stay under "Local: Uncommitted" AND name what it is holding, so the capture shows the
    // founder the difference he could not previously see without opening a terminal.
    id: "vfx-agent-10",
    name: "Retune the credit pill",
    kind: "build",
    parentId: null,
    status: "idle",
    elapsedMin: 12,
    stage: "building_unsaved",
    lastPrompt: "Nudge the credit pill's contrast against the flooded column",
    worktree: { dirty: true, dirtyFiles: ["apps/desktop/src/components/CreditPill.tsx", "apps/desktop/src/theme/tokens.ts"] },
  },
  {
    // THE GOAL-LESS CONTROL, and it is a TOP-LEVEL BUILD row on purpose (roborev 57331). A control
    // has to differ from the rows it is compared against in the ONE variable under test, and every
    // goal above sits on a build row — so a goal-less WORKER could not serve: "has a goal" would be
    // confounded with "is a top-level build row" and the capture could not say which difference the
    // eye was seeing. The two nested workers stay goal-less as well, but they are not the control
    // and nothing rests on them; a worker under a collapsed head renders as a one-line PEEK, not a
    // row, so a goal parked there could not be photographed at all.
    id: "vfx-agent-7",
    name: "Credit pill contrast",
    kind: "build",
    parentId: null,
    status: "idle",
    elapsedMin: 52,
    stage: "building_saved",
    lastPrompt: "Check the credit pill against the flooded column in both themes",
  },
];

function toAgent(r: Row): AgentTab {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    parentId: r.parentId,
    runtime: "local",
    worktreePath: `/tmp/sparkle-visual/${r.id}`,
    branch: `sparkle/${r.id}`,
    baseBranch: "main",
    lastPrompt: r.lastPrompt,
    promptHistory: [
      {
        id: `${r.id}-p1`,
        text: r.lastPrompt,
        // The elapsed readout is `now - at`; with Date.now() pinned to FIXTURE_NOW this is exact.
        at: FIXTURE_NOW - r.elapsedMin * MINUTE,
        source: "composer",
      },
    ],
    activity: r.activity,
    // Spread conditionally so a goal-less row has NO `goal` key rather than an explicit
    // `undefined` — the control rows must be indistinguishable from an agent that never had one.
    ...(r.goal ? { goal: r.goal } : {}),
    task: r.parentId ? r.lastPrompt : undefined,
    parentBranch: r.parentId ? "sparkle/vfx-agent-1" : undefined,
    namePinned: false,
    autoNameBasis: r.lastPrompt,
    autoNameVariants: { title: r.name, description: r.lastPrompt },
    shellCommand: null,
    createdAt: FIXTURE_NOW - r.elapsedMin * MINUTE,
  };
}

/** The seeded project. Pure — no clock, no randomness, no store access. */
export function buildVisualFixture(): {
  project: Project;
  status: Record<string, AgentTabStatus>;
  workflowStage: Record<string, WorkflowStageId>;
  /** Per-row worktree readings, for the rows that declare one. See `Row.worktree`. */
  branchStatus: Record<string, BranchStatus>;
} {
  const iso = new Date(FIXTURE_NOW).toISOString();
  const project: Project = {
    id: FIXTURE_PROJECT_ID,
    name: "sparkle",
    // The constant, not the string — it is also the key `project_open_prs` is answered on.
    rootPath: FIXTURE_PROJECT_ROOT,
    defaultBranch: "main",
    createdAt: iso,
    lastOpenedAt: iso,
    agents: ROWS.map(toAgent),
    // The first row is selected so a capture shows the SELECTED-row geometry (the mouth/fillet at
    // the junction) — the single most-reviewed detail in MAPPING.md's geometry section.
    selectedAgentId: SELECTED_ROW_ID,
    freshBuildAgentId: SELECTED_ROW_ID,
  };
  const status: Record<string, AgentTabStatus> = {};
  const workflowStage: Record<string, WorkflowStageId> = {};
  const branchStatus: Record<string, BranchStatus> = {};
  for (const r of ROWS) {
    status[r.id] = r.status;
    workflowStage[r.id] = r.stage;
    if (r.worktree) branchStatus[r.id] = fixtureBranchStatus(r.worktree);
  }
  return { project, status, workflowStage, branchStatus };
}

/** A minimal `BranchStatus` for a fixture row: only the fields the ladder and the chip read.
 *
 *  `worktreeOnBranch: true` is REQUIRED, not decoration — `uncommittedWorkEvidence` returns
 *  `undefined` for a parked tree, so leaving it off would make every seeded row read "not looked up"
 *  and put the fixture right back where it started. `ahead: 0` matches `building_unsaved`, the only
 *  stage whose section this reading can change. */
function fixtureBranchStatus(w: { dirty: boolean; dirtyFiles?: string[] }): BranchStatus {
  return {
    ahead: 0,
    behind: 0,
    dirty: w.dirty,
    filesChanged: 0,
    insertions: 0,
    deletions: 0,
    worktreeOnBranch: true,
    dirtyFiles: w.dirtyFiles ?? [],
    dirtyCount: w.dirtyFiles?.length ?? 0,
  };
}

/**
 * The LEFT pair's project. Deliberately small — three rows, one selected — because its job is to
 * make the left pair REAL (a project with a selected agent, so the cable can seat there), not to
 * re-photograph the whole sidebar from the other side.
 *
 * Ids are prefixed so they cannot collide with the right project's; a duplicate agent id would put
 * two rows in the roster under one key and make the capture quietly wrong rather than fail.
 */
export function buildLeftPairFixture(): {
  project: Project;
  status: Record<string, AgentTabStatus>;
  workflowStage: Record<string, WorkflowStageId>;
} {
  const iso = new Date(FIXTURE_NOW).toISOString();
  const rows: Row[] = ROWS.slice(0, 3).map((r, i) => ({
    ...r,
    id: `vfx-left-agent-${i + 1}`,
    // Workers point at the RIGHT project's ids otherwise, which would orphan them in this project.
    parentId: null,
    kind: "build",
  }));
  const project: Project = {
    id: FIXTURE_LEFT_PROJECT_ID,
    name: "mobile",
    rootPath: "/Users/dev/Projects/mobile",
    defaultBranch: "main",
    createdAt: iso,
    lastOpenedAt: iso,
    agents: rows.map(toAgent),
    selectedAgentId: LEFT_SELECTED_ROW_ID,
    freshBuildAgentId: LEFT_SELECTED_ROW_ID,
  };
  const status: Record<string, AgentTabStatus> = {};
  const workflowStage: Record<string, WorkflowStageId> = {};
  for (const r of rows) {
    status[r.id] = r.status;
    workflowStage[r.id] = r.stage;
  }
  return { project, status, workflowStage };
}

/**
 * The SECOND OPEN TAB's project — a different repo, seeded under `?projects=2`.
 *
 * Its `name` and its `rootPath` are both load-bearing rather than flavour. The name is what a
 * grouped open-PR menu renders as a SECTION HEADER, so it is in the photograph: "sparkle" and
 * "drodio-website" are two words a reader can tell apart at a glance and at any width, which two
 * near-identical fixture names would not be. The rootPath is the KEY the per-root PR lookup answers
 * on — {@link FIXTURE_SECOND_PROJECT_ROOT} is used here and there, so they cannot drift into a
 * project whose PR probe silently resolves to "unknown".
 *
 * Two rows, and small on purpose for the same reason {@link buildLeftPairFixture} is: this project's
 * job is to be REAL (a project with agents, so its tab and its pane are not degenerate), not to
 * re-photograph a sidebar that the primary project already covers in full.
 *
 * Ids are prefixed so they cannot collide with either other project's. A duplicate AGENT id would
 * put two rows in the roster under one key and make the capture quietly wrong rather than fail —
 * note the deliberate contrast with the PR NUMBERS, which collide on purpose (see
 * {@link FIXTURE_SECOND_PRS}): a PR number is unique per repo and an agent id is unique globally,
 * so a collision is a fixture bug in one case and the thing under test in the other.
 */
export function buildSecondProjectFixture(): {
  project: Project;
  status: Record<string, AgentTabStatus>;
  workflowStage: Record<string, WorkflowStageId>;
} {
  const iso = new Date(FIXTURE_NOW).toISOString();
  const rows: Row[] = [
    {
      id: "vfx-web-agent-1",
      name: "Pricing page credits table",
      kind: "build",
      parentId: null,
      status: "idle",
      elapsedMin: 12,
      stage: "pull_request",
      lastPrompt: "Rebuild the credits table around the new tiers",
    },
    {
      id: "vfx-web-agent-2",
      name: "Mobile nav focus trap",
      kind: "build",
      parentId: null,
      status: "working",
      elapsedMin: 4,
      stage: "building_saved",
      activity: "Keeping the submenu open while it holds focus",
      lastPrompt: "Keep the mobile menu open while a submenu has focus",
    },
  ];
  const project: Project = {
    id: FIXTURE_SECOND_PROJECT_ID,
    name: "drodio-website",
    rootPath: FIXTURE_SECOND_PROJECT_ROOT,
    defaultBranch: "main",
    createdAt: iso,
    lastOpenedAt: iso,
    agents: rows.map(toAgent),
    selectedAgentId: rows[0]!.id,
    freshBuildAgentId: rows[0]!.id,
  };
  const status: Record<string, AgentTabStatus> = {};
  const workflowStage: Record<string, WorkflowStageId> = {};
  for (const r of rows) {
    status[r.id] = r.status;
    workflowStage[r.id] = r.stage;
  }
  return { project, status, workflowStage };
}

/**
 * Seed the stores. No-op unless the dev auth bypass is on, so a normal dev session can never be
 * clobbered by fixtures just because the URL carried a stray parameter.
 *
 * Returns whether it seeded, so the caller (and the test) can assert rather than guess.
 */
/** A storage backend that forgets everything — reads empty, swallows writes. */
const NOOP_STORAGE = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

/** The persist API zustand attaches to a persisted store. Narrowed to the one method used here. */
interface PersistApi {
  persist?: { setOptions: (o: { storage: ReturnType<typeof createJSONStorage> }) => void };
}

/**
 * Point the seeded stores' persist middleware at a no-op backend, so seeding cannot reach disk.
 *
 * Called BEFORE any setState below — rehydration has already happened by then, so the developer's
 * real blob is intact on disk and merely shadowed in memory for this page's lifetime.
 */
export function detachPersistence(): void {
  const noop = createJSONStorage(() => NOOP_STORAGE);
  // useDictationStore IS IN THIS LIST, and it is the one entry that is not obvious.
  //
  // `useCableStore` is absent because it is genuinely in-memory — there is nothing to detach. The
  // dictation store is NOT: it persists under DICTATION_PERSIST_KEY with
  // `partialize: (s) => ({ enabled: s.enabled, phase: s.phase })`, so the `__sparkleMic` handle
  // below writing `enabled: true` would go straight through the live middleware to localStorage and
  // OUTLIVE THE TAB — the exact clobber this function's header promises it prevents.
  //
  // Two consequences, neither cosmetic. The store defaults to `enabled: false` so a cold start does
  // not prompt for microphone permission or kick off the ~482 MB model download; a persisted `true`
  // makes the developer's next ordinary launch do both. And DICTATION_PERSIST_KEY is watched by the
  // cross-window sync service on the browser `storage` event, so a harness tab could arm the mic in
  // another window the developer has open right now. (roborev 56045)
  //
  // useUiStore IS IN THIS LIST FOR THE SAME KIND OF REASON. It persists under "sparkle-ui" with a
  // partialize that keeps everything except a short transient list — `openProjectIds`,
  // `pairAssignment` and `leftProjectId` are all on the persisted side, and all three are written
  // below whenever a capture asks for a second pair or a second tab. Undetached, `?pairs=2` or
  // `?projects=2` would rewrite a developer's real OPEN-TAB SET on disk: their tab strip comes back
  // holding two projects they have never opened and missing the ones they had, which reads as data
  // loss rather than as a fixture. It has no exported persist-key constant, so the test that proves
  // this reads the key off the store's own persist options rather than re-spelling it.
  for (const store of [useProjectStore, useRuntimeStore, useDictationStore, useUiStore]) {
    (store as unknown as PersistApi).persist?.setOptions({ storage: noop });
  }
}

/** The shim's own signature, so wrapping it below stays typed rather than casting to `any`. */
type InvokeFn = (cmd: string, args?: unknown) => Promise<unknown>;

export function applyVisualFixtures(
  search: string = window.location.search,
  // Injectable for the same reason devBypassAuthEnabled's is: a test must be able to exercise the
  // enabled branch without stubbing Vite's import.meta.env.
  env?: Record<string, unknown>,
): boolean {
  if (!devBypassAuthEnabled(env)) return false;
  if (!visualFixturesRequested(search)) return false;

  const { project, status, workflowStage, branchStatus } = buildVisualFixture();
  // The second pair is OPT-IN (`?pairs=2`); see `visualPairCount` for why it cannot be the default.
  const left = visualPairCount(search) === 2 ? buildLeftPairFixture() : null;
  // The second TAB is a separate opt-in (`?projects=2`) on a separate axis — see
  // `visualProjectCount`. A capture may ask for both, so everything below composes them as a LIST
  // rather than branching on one or the other.
  const second = visualProjectCount(search) === 2 ? buildSecondProjectFixture() : null;
  const extras = [left, second].filter((x): x is NonNullable<typeof x> => x !== null);

  // FIRST — before a single write. See "SAFETY, PART TWO" at the top of this file.
  detachPersistence();

  // setState, not addProject/addAgent: those mint uuids and stamp Date.now(), which is precisely
  // the non-determinism the fixture exists to avoid. Replaces `projects` outright so a persisted
  // localStorage profile from an earlier run can't leak extra rows into the capture.
  useProjectStore.setState({
    // The PRIMARY project stays first and stays `selectedProjectId`, so the single-project,
    // single-pair layout — and every surface baselined against it — is untouched when neither
    // `?pairs=2` nor `?projects=2` is asked for.
    projects: [project, ...extras.map((e) => e.project)],
    selectedProjectId: project.id,
    removedIds: {},
  });

  // ── THE TAB SET AND THE PAIR ASSIGNMENT — WRITTEN UNCONDITIONALLY ───────────────────────────
  //
  // `openProjectIds` is what gates which projects get a TAB (engine/openProjects: `null` means
  // "every project is open", an array means exactly these). For `?projects=2` it is the whole
  // mechanism: a second project sitting in the store with no tab is invisible to the tab strip, and
  // a grouped open-PR menu that scopes itself to the OPEN set would then have exactly one group to
  // render — the fixture would look like it worked and photograph the single-project state.
  //
  // NOT GATED ON THE OPT-INS, and that is the correction rather than the tidy-up (roborev 57710).
  // Written only on the second-project path, the DEFAULT path left all three keys exactly as
  // rehydrated from `sparkle-ui` — which is the more consequential case: a persisted
  // `openProjectIds` that is a real array NOT containing the fixture project gives the seeded
  // project no tab at all (`isProjectOpen` is false for a non-null set that omits it), and a stale
  // `pairAssignment` opens a second pair under a filename claiming a single-pair layout. `projects`
  // is replaced outright one block above for precisely this reason; these are the same fact about
  // the same capture. In the single-project case `[project.id]` is behaviourally identical to the
  // `null` the store starts at, so no existing baseline moves.
  //
  // `pairAssignment` is what `pairCountFor` reads to decide there are two pairs at all, and
  // `leftProjectId` is what `useEffectiveWired` resolves the LEFT side's selected agent through —
  // without it, `patch("left")` is a no-op as far as the shell is concerned and the capture silently
  // photographs an unwired app. That is the exact bug that let `workspace-wired-left` score the
  // wrong state for its whole life; the harness's `cable` step now verifies `data-wired` agrees, so
  // this being wrong fails loudly instead. They belong to the PAIR opt-in alone: a capture that did
  // not ask for a second pair gets them CLEARED, never inherited.
  useUiStore.setState({
    openProjectIds: [project.id, ...extras.map((e) => e.project.id)],
    ...(left
      ? { pairAssignment: { [left.project.id]: "left" }, leftProjectId: left.project.id }
      : { pairAssignment: {}, leftProjectId: null }),
  });

  // `status` is the only live-only key here — it is never persisted, so it must be written on every
  // boot or the rows render with no dot at all. `workflowStage` and `openAgentIds` ARE persisted
  // (runtimeStore's partialize covers openAgentIds, workflowStage and workflowShipped), and writing
  // them is only safe because detachPersistence() ran above. Do NOT drop useRuntimeStore from that
  // loop on the strength of a "live-only" reading of this line — that restores the clobber, this
  // time of the developer's stage watermarks. (roborev 54756)
  useRuntimeStore.setState({
    status: extras.reduce<Record<string, AgentTabStatus>>((all, e) => ({ ...all, ...e.status }), {
      ...status,
    }),
    // SEEDED so the stage ladder can tell "holds nothing" from "we never looked" — without it
    // `uncommittedWorkEvidence` answers `undefined` for every row and the `local_none` rung is
    // unreachable in a capture (sparkle-biezi). Live-only, like `status`: branchStatus is not
    // persisted, so it must be written on every boot.
    branchStatus: { ...branchStatus },
    workflowStage: extras.reduce<Record<string, WorkflowStageId>>(
      (all, e) => ({ ...all, ...e.workflowStage }),
      { ...workflowStage },
    ),
    openAgentIds: [],
  });

  // ── A QUEUED INBOX, SO THE PENDING BADGE IS ACTUALLY ON SCREEN ──────────────────────────────
  //
  // WHY THIS FIXTURE EXISTS AT ALL. The pending-instruction badge (components/AgentInboxBadge) and
  // the mounted thread's queued bubbles were shipped for bead sparkle-zm0c8 — a queued concierge
  // message that appeared NOWHERE, which made "I sent it" impossible for the founder to check. They
  // were verified in jsdom, and jsdom neither lays out nor paints (docs/jsdom-test-caveats.md), so
  // nothing in the repo could show that the fix he asked for is VISIBLE. That is a poor place to
  // leave a fix whose entire purpose is being seen.
  //
  // WHY A STORE WRITE AND NOT A MOCKED COMMAND. `inboxStore` reads through `invoke("inbox_peek")`,
  // which no-ops in a plain browser — the exact reason this whole file exists. Seeding the store is
  // the same move every other fixture here makes, and it exercises the real components: the badge
  // derives its count with `pendingCount`, the thread filters with `inFlight`, and both read the
  // shared copy in `components/inboxCopy`. Nothing is stubbed but the transport.
  //
  // NOT IN `detachPersistence`'s LIST, and that is correct rather than an omission: `inboxStore` is
  // deliberately live-only (no `persist` middleware — the queue's truth is a JSONL file under
  // app-data, and a cached copy that outlived the tab would be the stale-badge failure the store's
  // own header argues against). There is therefore nothing to detach and no developer state to
  // clobber.
  //
  // THREE MESSAGES ON ONE ROW, ONE PER STAGE, on purpose: the badge must be shown counting ONLY the
  // pending one (a mark that never goes away stops being read), while the popover and the thread
  // show all three — so a capture proves the count rule and the three-stage vocabulary at once. The
  // timestamps are offsets from FIXTURE_NOW like everything else here, because a wall-clock `ts`
  // would move the 12h expiry boundary between runs and make the baseline unstable.
  useInboxStore.setState({
    byAgent: {
      [SELECTED_ROW_ID]: Object.freeze([
        {
          id: "vfx-inbox-1",
          ts: FIXTURE_NOW - 2 * MINUTE,
          from: "concierge",
          text: "main has moved — rebase onto origin/main before you verify, or you will chase failures that are already fixed.",
          severity: "act" as const,
          state: "pending" as const,
          ackedAt: null,
          ackNote: null,
        },
        {
          id: "vfx-inbox-2",
          ts: FIXTURE_NOW - 9 * MINUTE,
          from: "concierge",
          text: "The picker spec settled on option B; the addressed-at column is authoritative.",
          severity: "fyi" as const,
          state: "delivered" as const,
          ackedAt: null,
          ackNote: null,
        },
        {
          id: "vfx-inbox-3",
          ts: FIXTURE_NOW - 21 * MINUTE,
          from: "concierge",
          text: "Another agent owns src/theme/colors.ts this pass — leave it alone.",
          severity: "act" as const,
          state: "acknowledged" as const,
          ackedAt: FIXTURE_NOW - 19 * MINUTE,
          ackNote: "read",
        },
      ]),
    },
    polledAgents: { [SELECTED_ROW_ID]: true },
    error: null,
  });

  // The offline banner is real UI that pushes the whole workspace down, and a headless browser
  // with no reachable probe endpoint always shows it. The mock has no such banner, so leaving it
  // in would score as a layout-wide diff on every surface. Forced online.
  useConnectionStore.setState({ isOnline: true, browserOnline: true, probeOk: true });

  // ── A NARROWED CONCIERGE, FOR THE SURFACES THAT NEED ONE ────────────────────────────────────
  //
  // Written to LOCALSTORAGE rather than to a store, because that is where `Workspace` reads it:
  // `conciergeWidths` is a `useState` initialiser over `sparkle-concierge-width`, and an initialiser
  // runs ONCE at first render. This file is called from main.tsx before `createRoot`, so the value
  // is in place in time — a store write after mount would be re-clobbered by nothing, but would
  // also never be read, since nothing re-runs that initialiser.
  //
  // Deliberately NOT routed through `detachPersistence`: that turns off the zustand stores' own
  // persistence so the fixture cannot overwrite a developer's real profile, and this key is not a
  // zustand-persisted one. It IS a developer's real key, so it is only ever touched under the gates
  // above, and the capture harness always launches with a fresh user-data-dir.
  //
  // ── THE ELSE BRANCH IS THE LOAD-BEARING HALF (roborev 57717) ────────────────────────────────
  //
  // Writing only when a width is asked for looks harmless and is not. The harness gives each
  // surface a fresh PAGE but ONE BROWSER, and `localStorage` is origin-scoped — so it survives
  // every navigation in the run. A surface that wrote nothing therefore did not get "the app's own
  // default"; it INHERITED whatever the previously-captured surface left behind, which made a
  // capture's meaning depend on the order it happened to be taken in.
  //
  // That was not hypothetical. `THEMES` is the outer loop with the surfaces nested inside, so every
  // width-less surface — `workspace-unwired`, both `workspace-wired-*`, `agent-sidebar`,
  // `concierge-column`, `settings-dialog` — booted its DARK capture carrying the last light-pass
  // width. And `selectSurfaces` preserves argument order, so `--surfaces=open-pr-menu-narrow,
  // concierge-column` reproduced it on demand. The grouped PR pair hit the visible version of this
  // (two byte-identical PNGs, one of them filed as "wide"), but patching those two surfaces to name
  // their widths only moved the inherited value from 190 to 360; it did not stop the inheriting.
  //
  // Clearing makes "no `?concierge=`" mean the app's own default, and makes every capture
  // independent of the order the run happened to take.
  //
  // WHAT PROTECTS THE DEVELOPER HERE IS `capture=1`, NOT `?visual=1`. These two keys are not
  // zustand-persisted, so `detachPersistence` does not cover them — they are a real preference on a
  // real machine, and a developer who opens their own dev server with `?visual=1` (to reproduce a
  // capture by hand) satisfies every other gate in this file. Only the harness marker keeps the
  // clear off their profile, which is why the `visualCaptureRun(search)` condition below is
  // load-bearing rather than redundant, and why collapsing it would destroy user data.
  const conciergeWidth = visualConciergeWidth(search);
  if (typeof localStorage !== "undefined") {
    if (conciergeWidth !== null) {
      localStorage.setItem(CONCIERGE_WIDTH_KEY, String(conciergeWidth));
      localStorage.setItem(CONCIERGE_WIDTH_KEY_PAIRED, String(conciergeWidth));
    } else if (visualCaptureRun(search)) {
      // ONLY UNDER THE HARNESS — see `visualCaptureRun`. A developer's own `?visual=1` must leave
      // these alone; a capture run must not inherit the previous surface's column.
      localStorage.removeItem(CONCIERGE_WIDTH_KEY);
      localStorage.removeItem(CONCIERGE_WIDTH_KEY_PAIRED);
    }
  }

  // ── OPEN PULL REQUESTS, ANSWERED AT THE IPC BOUNDARY ────────────────────────────────────────
  //
  // The ONE fixture here that cannot be a store write. `OpenPrMenu` has no store — it calls
  // `invoke("project_open_prs")` on mount and on a 3-minute poll — so seeding it means answering
  // the command. The transport shim (scripts/visual/serve.mjs) resolves every unknown command to
  // null, which is why the PR chip is absent from every existing capture.
  //
  // WRAPPING the shim rather than editing it keeps the opt-in property: the shim is installed for
  // every page, so an answer added there would put a PR chip in the concierge header of EVERY
  // surface and invalidate all of their baselines. This is behind `?prs=1` like the rest.
  //
  // It also stays inside this file's gates (DEV build AND auth-bypass AND `?visual=1`), which the
  // shim is not, so it cannot exist in a shipped app.
  //
  // ANSWERED PER `root`, NOT WITH ONE LIST FOR EVERYONE. The command is invoked as
  // `invoke("project_open_prs", { root, projectId })` and `root` is the project's `rootPath`, so a
  // workspace with two projects open asks this twice with two different roots. Replying with the
  // same rows both times would photograph a state the app cannot reach — two sections, identical
  // contents, identical PR numbers — i.e. a picture that looks like working multi-repo grouping
  // whatever the component actually does. `fixturePrsForRoot` also keeps the shim's own null
  // behaviour for a root the fixture does not know: NULL IS "we could not ask", not "no PRs".
  if (visualPrsRequested(search) && typeof window !== "undefined") {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: InvokeFn } })
      .__TAURI_INTERNALS__;
    const inner = internals?.invoke;
    if (internals && inner) {
      internals.invoke = (cmd: string, args?: unknown) => {
        if (cmd === "project_open_prs") {
          return Promise.resolve(
            fixturePrsForRoot((args as { root?: unknown } | undefined)?.root) as unknown,
          );
        }
        // THE DISMISSAL COMMANDS, answered from the same in-memory seed so the capture can show a
        // populated Dismissed section. Read-only by design: `dismiss_pr`/`restore_pr` answer with
        // the CURRENT set rather than mutating it, because a capture drives the app through a fixed
        // script and a fixture that accumulated state would make each surface depend on which ones
        // ran before it — the exact cross-surface bleed the `capture=1` reset exists to stop.
        if (cmd === "pr_dismissals" || cmd === "dismiss_pr" || cmd === "restore_pr") {
          const projectId = (args as { projectId?: unknown } | undefined)?.projectId;
          return Promise.resolve(
            (typeof projectId === "string" ? (FIXTURE_DISMISSALS[projectId] ?? []) : []) as unknown,
          );
        }
        return inner(cmd, args);
      };
    }
  }

  // ── A HANDLE ON THE CABLE, FOR THE CAPTURE HARNESS ──────────────────────────────────────────
  //
  // The harness reached the wired states by setting `data-wired` on the shell root as a DOM
  // ATTRIBUTE. That never wired anything: the attribute is BOUND to the cable store
  // (`data-wired={wired}` in Workspace), so React owns it, and every surface that actually paints
  // the connection — the concierge's flood and lift are inline styles off `useCableStore` — kept
  // reading "off". The only thing that responded was the handful of `[data-wired]` rules in
  // index.css, which key off the raw attribute. So `workspace-wired-left` came out BYTE-IDENTICAL
  // to `workspace-unwired`, and the two wired surfaces have been scoring the unwired app since they
  // were added.
  //
  // Exposing the store's own action is what makes those surfaces real. Behind the same two gates as
  // everything above (DEV build AND the auth-bypass flag AND `?visual=1`), so it cannot exist in a
  // shipped app.
  // `typeof window` guarded: this module's own suite runs in the NODE environment (it is pure
  // store logic), where a bare `window` reference throws and would take the seeding tests down with
  // it — the fixtures are the thing under test there, not the browser handle.
  if (typeof window !== "undefined") {
    (window as unknown as { __sparkleCable?: (side: "off" | "left" | "right") => void }).__sparkleCable =
      (side) => {
        if (side === "off") useCableStore.getState().unbind();
        else useCableStore.getState().patch(side);
      };

    // ── AND A HANDLE ON THE MIC, FOR THE SAME REASON ──────────────────────────────────────────
    //
    // The voice states (armed-and-listening, focus-paused, preparing, error) are real UI with real
    // copy and NO visual coverage, because reaching them needs a backend: arming the mic opens a
    // device and downloads a model, neither of which exists in a headless browser. This writes the
    // two OBSERVATIONS the state derives from and lets the app's own derivation do the rest.
    //
    // Deliberately NOT a way to set the pause REASON. `focusOwner` stays the focus tracker's to
    // write (voice/dictationFocusTracker, installed in App): a harness that set the reason directly
    // would capture a notice the real focus path can no longer produce — which is how a surface
    // ends up "verified" in a state the app cannot actually reach. Focus a terminal-marked element
    // and the tracker classifies it, exactly as it does for a real xterm pane.
    // `status` and `phase` are OPTIONAL and default to the disarmed-looking pair this started with,
    // so every existing caller keeps its exact meaning. They are here because without them the mic
    // can only ever be photographed PAUSED: `status` only becomes "listening" when a real backend
    // opens a device, so the live captions — the ones the wake-word retirement rewrote — had no way
    // to be captured at all.
    //
    // It RETURNS the resulting snapshot rather than void, so the harness step can assert the state
    // it asked for actually landed instead of only that this function was called. That distinction
    // is the one the `cable` step had to learn the hard way (see stepToExpression): calling the
    // setter is a precondition, not the effect.
    // `interim` and `voiceSurface` are here for the ONE state that had no picture at all: the live
    // Deepgram preview, painted italic at the end of the draft (Concierge/MentionMirror). It is the
    // most-reported voice surface and the least photographable — it exists only for the fraction of
    // a second between a partial arriving and the segment settling, and only while a cloud relay is
    // streaming, so no capture could ever land on it by timing. Seeding the store is the only way to
    // hold it still.
    //
    // `voiceSurface` matters as much as the text: the concierge only paints the ghost while it OWNS
    // dictation (useConciergeDictation gates on `micLive`, which is `enabled && phase === "active"
    // && voiceSurface === "concierge"`), so a seed that set `interim` alone would photograph an
    // empty box and read as "the italics are broken" when it only meant "nobody claimed the mic".
    // That is the exact confusion this surface exists to settle, so the handle must be able to
    // express the whole state a push-to-talk hold produces, not half of it.
    (
      window as unknown as {
        __sparkleMic?: (s: {
          enabled: boolean;
          status?: "idle" | "listening" | "error";
          phase?: "passive" | "active";
          interim?: string;
          voiceSurface?: "concierge" | "agent";
        }) => {
          enabled: boolean;
          status: string;
          phase: string;
          interim: string;
          voiceSurface: string;
        };
      }
    ).__sparkleMic = (s) => {
      useDictationStore.setState({
        enabled: s.enabled,
        status: s.status ?? "idle",
        ...(s.phase ? { phase: s.phase } : {}),
        ...(s.interim === undefined ? {} : { interim: s.interim }),
        ...(s.voiceSurface ? { voiceSurface: s.voiceSurface } : {}),
        // The tracker writes this too, but only on a window transition — and a headless page may
        // never see one, which would leave the pause reading as "window" and mask the terminal case.
        windowFocused: true,
        error: null,
        modelProgress: null,
      });
      const d = useDictationStore.getState();
      return {
        enabled: d.enabled,
        status: d.status,
        phase: d.phase,
        interim: d.interim,
        voiceSurface: d.voiceSurface,
      };
    };
  }

  return true;
}
