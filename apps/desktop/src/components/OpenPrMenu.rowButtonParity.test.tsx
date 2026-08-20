// @vitest-environment jsdom
//
// THE PR ROW'S ACTION CLUSTER IS ONE SYSTEM — pinned by comparing SIBLINGS to each other.
//
// ── WHY THIS FILE REPLACED `OpenPrMenu.chicletParity.test.tsx` (roborev 65621) ────────────────
// The previous pass compared the per-row GitHub button to the CONCIERGE HEADER's chiclet, on the
// reasoning that both are small chips. roborev's objection was correct and is the reason this file
// exists: that button's peers are the four controls in its own row, not a chip 700 lines away in
// another surface. Matching the header made it a 19px squared box wedged between ~24px rounded
// siblings and dropped its click target under the 24×24 minimum `dismiss` beside it still met — it
// removed one drift by creating a worse one, and the old test PINNED THAT OUTCOME as correct.
//
// So the relationship asserted here is sibling-to-sibling, and the reference is measured off a
// sibling rather than off `rowButtonStyle`. Importing the helper and asserting every button equals
// it would never look at the component at all, and would pass against a call site that had reverted
// to inline literals. Read DOM-to-DOM, a revert on ANY ONE of the six call sites is a mismatch —
// which is precisely what a shared helper is for and what six hand-copied literals could not offer.
//
// ── WHAT KEEPS THIS FROM BEING VACUOUS ───────────────────────────────────────────────────────
// A pure "they all agree" assertion has a known weakness: mutate the helper and all six move
// together, so agreement survives. Three groups of cases below have grip on the helper itself
// rather than on the agreement:
//
//   • THE VARIANTS DIFFER, and in a named direction. `action` (the merge family) is WIDER and
//     heavier than `secondary` (the quiet half). Collapsing the two — the obvious "simplification"
//     of a shared helper — is caught, because sameness is asserted WITHIN each variant and
//     difference BETWEEN them.
//   • THE TONE ARGUMENTS REACH THE BOX. Ready-Merge is the cluster's one filled control; a
//     url-less GitHub button paints muted with a resting cursor. Each is an argument the helper
//     could drop while still returning a perfectly consistent box.
//   • STATE DOES NOT MOVE GEOMETRY. Disabled, armed and busy repaint; they must not resize. That
//     is the branch nobody looks at, and it is where the drift came back last time.
//
// jsdom does not lay out (`docs/jsdom-test-caveats.md`), so "the same size" is unmeasurable here.
// The declared box is the available proxy, and it is the honest one: these buttons have no
// stylesheet and no explicit height, so their painted size IS a function of the declared padding
// and font size compared below.
//
// NOT ASSERTED EQUAL: `color`, `background` and `border`. Those carry state and role — teal for the
// primary action, sienna once an override is armed, muted when a control cannot act — and demanding
// they match would pin the opposite of what this surface wants. `borderWidth` is not compared for
// the jsdom reason the old file documented: jsdom's parser rejects a `border` shorthand whose colour
// is a `var()`, so a token-coloured stroke reads empty while a literal one reads `1px`.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
  openUrl: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => h.invoke(...a),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: (u: string) => h.openUrl(u),
}));

import { OpenPrMenu, type PrAgentLink } from "./OpenPrMenu";
import { __resetProbeGateCacheForTests } from "../services/probeGate";
import type { PrRow } from "../services/openPrs";
import type { PrScope } from "../services/fleetPrs";

/** Green and linkable — the row where every control is in its live state. */
const PASS: PrRow = {
  number: 1,
  title: "fix: a thing",
  headRefName: "sparkle/agent-abc",
  url: "https://github.com/o/r/pull/1",
  checks: "passing",
  mergeable: "mergeable",
};

/** No url — the DISABLED GitHub button, and a Merge that cannot fire. */
const NO_URL: PrRow = {
  number: 2,
  title: "wip: no link",
  headRefName: "sparkle/agent-def",
  url: "",
  checks: "pending",
  mergeable: "unknown",
};

/** Failing-but-`unstable` — the only shape that swaps plain Merge for `merge-override`. */
const UNSTABLE: PrRow = {
  number: 3,
  title: "feat: ambiguous",
  headRefName: "sparkle/agent-ghi",
  url: "https://github.com/o/r/pull/3",
  checks: "failing",
  mergeable: "mergeable",
  mergeStateStatus: "unstable",
  failingChecks: ["Node — coverage (shard 3/4)"],
  pendingChecks: [],
};

const SCOPES: readonly PrScope[] = [
  { projectId: "p1", projectName: "repo", rootPath: "/repo" },
];

const LINK: PrAgentLink = {
  agentId: "a1",
  agentName: "Some Agent",
  projectId: "p1",
  isCurrentProject: true,
};

function stubList(rows: PrRow[]) {
  h.invoke.mockImplementation((cmd: string) => {
    if (cmd === "project_open_prs") return Promise.resolve(rows);
    return Promise.resolve(null);
  });
}

/** Rust's refusal for a PR still carrying an unanswered knightwatch `[blocking]` probe. */
const REFUSAL = [
  "PR #1 still carries 1 unanswered knightwatch [blocking] probe.",
  "",
  "1. [blocking] [from: shape] Q: Does the retry loop bound its attempts?",
  "   https://github.com/o/r/pull/1#issuecomment-5182769304",
  "",
  "Answer it on the pull request — reply citing the probe — or merge with a written reason.",
].join("\n");

/**
 * The third arm of the action slot, which no fixture alone can reach: `probe-override-*` renders
 * only after a merge we ATTEMPTED came back refused, so the button has to be earned with a click.
 * Covered because it is a call site of its own — the merge family has three, and a variant
 * assertion that only ever sees two leaves the third free to drift (mutation-check FLAGged exactly
 * that line before this case existed).
 */
async function openPanelWithProbeRefusal() {
  h.invoke.mockImplementation((cmd: string) => {
    if (cmd === "project_open_prs") return Promise.resolve([PASS]);
    if (cmd === "merge_pr") return Promise.reject(new Error(REFUSAL));
    return Promise.resolve(null);
  });
  render(
    <OpenPrMenu
      compact
      scopes={SCOPES}
      resolveAgent={() => LINK}
      onOpenAgent={() => {}}
    />,
  );
  fireEvent.click(await screen.findByTestId("open-pr-badge"));
  fireEvent.click(await screen.findByTestId("merge-1"));
  return await screen.findByTestId("probe-override-1");
}

beforeEach(() => {
  h.invoke.mockReset();
  h.openUrl.mockReset();
  // `openGithub` does `openUrl(url).catch(...)`, so a bare `vi.fn()` returning `undefined` throws
  // an unhandled TypeError out of the click handler — a failure of the mock, not of the component.
  h.openUrl.mockResolvedValue(undefined);
  // Module-level cache, so it outlives a test the way a `vi.fn()` does not.
  __resetProbeGateCacheForTests();
});
afterEach(cleanup);

/** Render the panel open, with an agent resolved so `open-agent-*` is in the tree. */
async function openPanel(rows: PrRow[]) {
  stubList(rows);
  render(
    <OpenPrMenu
      compact
      scopes={SCOPES}
      resolveAgent={() => LINK}
      onOpenAgent={() => {}}
    />,
  );
  fireEvent.click(await screen.findByTestId("open-pr-badge"));
  // Waiting on the LAST control to mount, so no case below can read a half-rendered row.
  await screen.findByTestId(`dismiss-${rows[rows.length - 1]!.number}`);
}

const el = (testid: string) => screen.getByTestId(testid) as HTMLButtonElement;

/** The box every control in the cluster shares, whatever its variant or state. */
const SHARED = [
  "borderRadius",
  "fontSize",
  "flex",
  "whiteSpace",
  "height",
] as const;

/** What separates the two variants. Asserted same-within and different-between. */
const VARIANT = ["padding", "fontWeight"] as const;

const box = (n: HTMLElement, props: readonly string[]) =>
  props
    .map((p) => `${p}=${n.style[p as keyof CSSStyleDeclaration] as string}`)
    .join(" ");

describe("the reference itself", () => {
  it("a sibling declares a real box — otherwise every comparison below is empty-vs-empty", async () => {
    // Stated first and on its own, so "the helper stopped reaching the call sites" names itself
    // instead of surfacing as a confusing pile of green.
    await openPanel([PASS]);
    const dismiss = el("dismiss-1");
    expect(dismiss.style.borderRadius).not.toBe("");
    expect(dismiss.style.fontSize).not.toBe("");
    expect(dismiss.style.padding).not.toBe("");
    // The row's controls are sized by their padding, not pinned to a number. A fixed height is the
    // signature of the header chiclet's box, which is the drift roborev 65621 rejected.
    expect(dismiss.style.height).toBe("");
  });
});

describe("OpenPrMenu — the row's action cluster is one box", () => {
  it("every control in the row agrees on the shared box", async () => {
    await openPanel([PASS]);
    const reference = el("dismiss-1");
    for (const id of ["open-agent-1", "open-github-1", "merge-1"]) {
      expect(`${id}: ${box(el(id), SHARED)}`).toBe(
        `${id}: ${box(reference, SHARED)}`,
      );
    }
  });

  it("the GitHub button is its SIBLING's box, not a chip from another surface", async () => {
    // The finding this file exists for, stated as its own case: `open-github` and `dismiss` are the
    // same kind of control — icon-only, `size={12}` glyph, side by side — so they are the pair that
    // must not diverge. Fails against the pass that pointed this button at the header's `pillStyle`
    // (borderRadius 3px vs 6px, fontSize 10px vs 12px, a pinned 19px height vs none).
    await openPanel([PASS]);
    expect(box(el("open-github-1"), [...SHARED, ...VARIANT])).toBe(
      box(el("dismiss-1"), [...SHARED, ...VARIANT]),
    );
  });

  it("the quiet half shares one variant, and declares no weight of its own", async () => {
    await openPanel([PASS]);
    for (const id of ["open-agent-1", "open-github-1"]) {
      expect(`${id}: ${box(el(id), VARIANT)}`).toBe(
        `${id}: ${box(el("dismiss-1"), VARIANT)}`,
      );
    }
    // Inherited, not restated — see the helper's note on why only the merge family declares one.
    expect(el("dismiss-1").style.fontWeight).toBe("");
  });

  it("the merge family shares one variant, and it is WIDER and heavier than the quiet half", async () => {
    // The hierarchy is deliberate: the row's one control that changes `main` must not read as its
    // neighbours. Asserting the DIFFERENCE is what stops a future "simplification" from collapsing
    // the two variants while leaving every same-ness assertion above perfectly green.
    await openPanel([PASS, UNSTABLE]);
    expect(box(el("merge-override-3"), VARIANT)).toBe(
      box(el("merge-1"), VARIANT),
    );
    expect(el("merge-1").style.padding).not.toBe(el("dismiss-1").style.padding);
    expect(el("merge-1").style.fontWeight).not.toBe("");
    expect(el("merge-1").style.fontWeight).not.toBe(
      el("dismiss-1").style.fontWeight,
    );
    // …and the hierarchy points the right way. The merge family buys emphasis horizontally, because
    // the row is a single flex line whose rule is that the primary action never truncates.
    const width = (v: string) => Number.parseFloat(v.split(" ")[1] ?? "0");
    expect(width(el("merge-1").style.padding)).toBeGreaterThan(
      width(el("dismiss-1").style.padding),
    );
  });

  it("the PROBE override is the merge family's box too — its third call site", async () => {
    // Reached only through a refused merge, which is why it is easy to leave behind: it renders IN
    // PLACE OF the button every other case measures, so nothing else here would ever look at it.
    // Both halves are needed. The first render banks what the merge family's variant actually is;
    // comparing the probe override only to `dismiss` beside it would prove it shares the row's box
    // while saying nothing about which of the two variants it took.
    await openPanel([PASS]);
    const mergeVariant = box(el("merge-1"), VARIANT);
    cleanup();

    const probe = await openPanelWithProbeRefusal();
    expect(box(probe, SHARED)).toBe(box(el("dismiss-1"), SHARED));
    expect(box(probe, VARIANT)).toBe(mergeVariant);
    expect(box(probe, VARIANT)).not.toBe(box(el("dismiss-1"), VARIANT));
  });
});

describe("OpenPrMenu — the tone arguments reach the box", () => {
  it("the ready Merge is the cluster's ONE filled control", async () => {
    // `fill` is an argument the helper could quietly drop while still returning a consistent box.
    await openPanel([PASS]);
    expect(el("merge-1").style.background).not.toBe("transparent");
    expect(el("merge-1").style.background).not.toBe("");
    for (const id of ["open-agent-1", "open-github-1", "dismiss-1"]) {
      expect(`${id}=${el(id).style.background}`).toBe(`${id}=transparent`);
    }
  });

  it("a control that cannot act paints the resting cursor, and one that can does not", async () => {
    // Both directions in one case: asserting only the disabled side would pass against a helper
    // that had hard-coded `default` for everything.
    await openPanel([PASS, NO_URL]);
    expect(el("open-github-2").disabled).toBe(true);
    expect(el("open-github-2").style.cursor).toBe("default");
    expect(el("open-github-1").disabled).toBe(false);
    expect(el("open-github-1").style.cursor).toBe("pointer");
  });
});

describe("OpenPrMenu — state repaints the cluster, it never resizes it", () => {
  it("a disabled GitHub button keeps its sibling's box", async () => {
    await openPanel([PASS, NO_URL]);
    expect(box(el("open-github-2"), [...SHARED, ...VARIANT])).toBe(
      box(el("dismiss-2"), [...SHARED, ...VARIANT]),
    );
  });

  it("a disabled Merge keeps the enabled Merge's box", async () => {
    await openPanel([PASS, NO_URL]);
    expect(el("merge-2").disabled).toBe(true);
    expect(box(el("merge-2"), [...SHARED, ...VARIANT])).toBe(
      box(el("merge-1"), [...SHARED, ...VARIANT]),
    );
  });

  it("ARMING an override relabels and recolours it without moving the box", async () => {
    // The two-step grammar swaps the label for a longer one ("Merge anyway?"). A box that grew with
    // it would be the drift coming back through the one branch nobody looks at.
    await openPanel([PASS, UNSTABLE]);
    const before = box(el("merge-override-3"), [...SHARED, ...VARIANT]);
    const restingInk = el("merge-override-3").style.color;
    fireEvent.click(el("merge-override-3"));
    await waitFor(() =>
      expect(el("merge-override-3").getAttribute("data-armed")).toBe("yes"),
    );
    expect(box(el("merge-override-3"), [...SHARED, ...VARIANT])).toBe(before);
    // …and it DID change, so the case above is not comparing a button to its unchanged self.
    expect(el("merge-override-3").style.color).not.toBe(restingInk);
  });
});

describe("OpenPrMenu — the restyle changes no behaviour", () => {
  it("the GitHub button still opens the PR url, and still refuses when there is none", async () => {
    await openPanel([PASS, NO_URL]);
    fireEvent.click(el("open-github-1"));
    await waitFor(() => expect(h.openUrl).toHaveBeenCalledWith(PASS.url));

    h.openUrl.mockClear();
    fireEvent.click(el("open-github-2"));
    expect(h.openUrl).not.toHaveBeenCalled();
  });

  it("keeps every control's title, label and icon-only content", async () => {
    await openPanel([PASS]);
    expect(el("open-github-1").getAttribute("title")).toBe(
      "View this PR on GitHub",
    );
    expect(el("open-github-1").querySelector("svg")).not.toBeNull();
    expect(el("open-github-1").textContent).toBe("");
    expect(el("dismiss-1").querySelector("svg")).not.toBeNull();
    expect(el("open-agent-1").textContent).toBe("Open agent");
    expect(el("merge-1").textContent).toBe("Merge");
  });
});
