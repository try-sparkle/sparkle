// @vitest-environment jsdom
//
// WHERE the app's brand chrome lives, asserted from both ends.
//
// Three pieces made the same trip together: the Sparkle.ai logo, the voice waveform under it, and
// the remaining-credit badge. All three used to sit in column two (the builder sidebar) and now top
// column one (the persistent concierge). A move like this is exactly the kind of change that
// half-lands: the new copy gets added and the old one is never deleted, so the mark renders twice
// in one shell and nobody notices until a screenshot. So this file asserts the ABSENCE in the
// sidebar as hard as the presence in the concierge column, and pins the accessibility contract that
// made the logo an anchor in the first place — a bare clickable <img> is unreachable by keyboard
// and announced as an image, not a link.
//
// Two aftershocks of that move are pinned here too: the header must carry exactly ONE brand mark
// (the star field's own "Sparkle" text was a second one, 8px from the logo, left-aligned above
// centered, both named "Sparkle"), and the row the logo left behind in the builder must not render
// when its last remaining child renders nothing.
//
// The star field is now DELETED outright and the mark sits top-left on the credit pill's row. Its
// absence is asserted here rather than in a test of its own, because "the component is gone" and
// "the canvas it mounted is gone" are separable failures and this file's whole subject is the
// half-landed move.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
// A STAND-IN, not a null: this file's job is to say where the waveform renders, so the double has
// to be findable. Mocked at all because the real one drives a rAF loop off the mic stores — that is
// LogoWaveform.render.test's subject, not this file's.
vi.mock("./LogoWaveform", () => ({
  LogoWaveform: () => <div data-testid="logo-waveform" />,
}));
vi.mock("./StatusBar", () => ({ StatusBar: () => null }));
vi.mock("./HistorySearch", () => ({ HistorySearch: () => null }));
vi.mock("../services/branchStatus", () => ({
  refreshAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  landAgentBranch: vi.fn(() => Promise.resolve({ ok: true })),
  // The sidebar's mount effect polls this; stubbing it keeps the run free of a rejected-promise
  // log that has nothing to do with what's asserted here.
  projectAgentsStatus: vi.fn(() => Promise.resolve([])),
}));

import { openUrl } from "@tauri-apps/plugin-opener";
import { AgentSidebar } from "./AgentSidebar";
import { ConciergeColumn } from "./Concierge";
import type { ConciergeController, ConciergeViewModel } from "./Concierge";
import { useHelperPrefs } from "../helper/helperPrefs";
import { useAuthStore } from "../stores/authStore";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { GOLD_SHEEN, LOGO_SRC, SparkleWordmark } from "./SparkleWordmark";
import { wordmarkRamp } from "./Concierge/wordmarkRamp";
import { BLUEPRINT } from "../theme/blueprintSpec";
import { C } from "../theme/colors";
import { prefixedStyle } from "./statusDotTestUtils";
import type { AgentTab, AgentTabStatus, Project } from "../types";

function mkAgent(id: string, name: string): AgentTab {
  return {
    id, name, kind: "build", parentId: null, runtime: "local",
    worktreePath: null, branch: null, baseBranch: null, lastPrompt: "",
    promptHistory: [], namePinned: true, autoNameBasis: null,
    autoNameVariants: null, shellCommand: null, pinnedIndex: null,
  } as AgentTab;
}

function seed(): Project {
  const project: Project = {
    id: "p1", name: "Demo", rootPath: "/tmp/demo", defaultBranch: "main",
    createdAt: new Date(0).toISOString(), selectedAgentId: null,
    agents: [mkAgent("a1", "Builder")],
  };
  useProjectStore.setState({ projects: [project] } as never);
  useRuntimeStore.setState({
    branchStatus: {},
    workflowStage: {},
    status: { a1: "idle" } as Record<string, AgentTabStatus>,
    openAgentIds: ["a1"],
    open: vi.fn(),
    pollBranchStatus: vi.fn(() => Promise.resolve()),
  } as never);
  return project;
}

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 0, running: 0, done: 0 },
  messages: [],
};

/** The badge renders `me.balanceCents` and calls `refresh()` on mount. Stub the refresh — the real
 *  one reaches the orchestration server, and what's under test here is placement, not the fetch. */
const REMAINING_CENTS = 15_387;
function seedBalance(balanceCents = REMAINING_CENTS) {
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents, tokenVersion: 1 },
    refresh: vi.fn(async () => {}),
  } as never);
}

function controller(): ConciergeController {
  return {
    onSend: vi.fn(),
    onAttach: vi.fn(),
    onNudgeClick: vi.fn(),
    onNudgeAction: vi.fn(),
  };
}

beforeEach(() => {
  useUiStore.setState({ collapsedOrchestrators: {}, activeSpecial: null } as never);
  // The island's shipped default, restored per test. Nothing in the sidebar reads these prefs any
  // more (see "the builder sidebar's brand row is gone"); this keeps the last describe's deliberate
  // stale-key write from being the ambient state every other test runs under.
  useHelperPrefs.setState({ mode: "island", enabled: undefined } as never);
  seedBalance();
});
afterEach(cleanup);

describe("the Sparkle.ai logo lives in column one, the concierge", () => {
  it("renders the mark in the concierge column header", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    // The mark is a MASKED box, not an <img> — the wordmark asset carries its own cyan→blue
    // gradient and is used as an alpha mask over the themed gold ink (see SparkleWordmark). The
    // ACCESSIBLE NAME, which is the part that must not change, comes through the img role; the
    // asset is read off the mask that is ACTUALLY APPLIED rather than a data- mirror of it, since a
    // mask that doesn't load paints a solid gold rectangle with no fallback (roborev 54019).
    const logo = screen.getByRole("img", { name: "Sparkle" });
    expect(logo.style.maskImage).toBe(`url(${LOGO_SRC})`);
    // BOTH spellings, and the size with them (roborev 54033). The shipped WebView is WebKit-based,
    // so `-webkit-mask-image` is the property that actually paints in production — asserting only
    // the unprefixed one lets its deletion through, and a mask with no `contain` size degrades to
    // the same solid block. `prefixedStyle` records where jsdom actually keeps those two.
    expect(prefixedStyle(logo, "WebkitMaskImage")).toBe(`url(${LOGO_SRC})`);
    expect(logo.style.maskSize).toBe("contain");
    expect(prefixedStyle(logo, "WebkitMaskSize")).toBe("contain");
    // THE PAINT BEHIND THE MASK — the Blueprint WORDMARK RAMP, dark → light left to right, since
    // the cockpit port. It was a gold SHEEN ("make the logo sparklier", 2026-07-27) and before that
    // the flat `C.goldInk`; Blueprint retired gold entirely, so a gold glint here was the last gold
    // left on screen. What every one of those changes must not do is reintroduce the asset's own
    // cyan→blue gradient, which is the entire reason the mark is a mask over a themed fill rather
    // than an <img>; so this asserts the composition, not just "some background is set".
    //
    // The ramp's two ends are a per-theme token PAIR rather than a fixed order of `ink` and
    // `primary`, because which of those is the darker one flips between themes — see
    // theme/blueprintSpec.ts and the assertions in theme/blueprintSpec.test.ts. jsdom resolves to
    // dark here (systemPrefersDark defaults true with no matchMedia).
    expect(logo.style.background).toBe(wordmarkRamp("dark"));
    expect(logo.style.background).toContain(BLUEPRINT.dark.wmDark);
    expect(logo.style.background).toContain(BLUEPRINT.dark.wmLit);
    // GOLD_SHEEN is still exported and still correct for anything that wants it; it is simply no
    // longer this header's paint. Asserted so a revert has to be deliberate.
    expect(logo.style.background).not.toBe(GOLD_SHEEN);
    // The decorative hue, in either spelling the asset uses. A "sparklier" fill that reached for it
    // would undo the token decision by the back door.
    expect(logo.style.background.toLowerCase()).not.toContain("34e0f0");
    expect(logo.style.background.toLowerCase()).not.toContain("3e7bff");
  });

  // The capture takeover and every other caller still get the FLAT fill: the sheen is opt-in, so
  // this header's taste can't silently repaint a window that pins its own theme (CaptureApp.test
  // holds the other end).
  it("leaves the wordmark's default fill flat — the sheen is the concierge header's own choice", () => {
    render(<SparkleWordmark />);
    expect(screen.getByRole("img", { name: "Sparkle" }).style.background).toBe(C.goldInk);
  });

  it("ships the asset the mask points at — the one thing the mask itself cannot prove", () => {
    // Reading the applied `maskImage` fixed the data- MIRROR problem; it did not fix the PATH
    // problem, since both the component and the assertion resolve the same constant. Rename or move
    // the file and every DOM assertion stays green while both windows paint a solid gold rectangle
    // with no fallback. This is the only check that fails on that (roborev 54033).
    // Built with path.resolve rather than `new URL(..., import.meta.url)`: Vite rewrites that
    // pattern as an ASSET reference at transform time, and a template it cannot statically resolve
    // comes out `undefined`, i.e. a check that passes for the wrong reason.
    const asset = resolve(dirname(fileURLToPath(import.meta.url)), "../../public", LOGO_SRC.slice(1));
    expect(
      existsSync(asset),
      `${asset} is missing — the wordmark mask has nothing to mask`,
    ).toBe(true);
  });

  it("keeps it a focusable LINK to sparkle.ai, not a bare clickable image", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    // getByRole("link") only matches an <a href> — an <img> with an onClick would fail here, which
    // is the whole point of the assertion.
    const link = screen.getByRole("link", { name: "Sparkle" });
    expect(link.getAttribute("href")).toBe("https://sparkle.ai");
    expect(link.contains(screen.getByRole("img", { name: "Sparkle" }))).toBe(true);
  });

  // THE OTHER HALF OF THE CONTRACT SparkleLogoLink EXISTS FOR (roborev 53557).
  //
  // Its own header says it lives in its own file because "the accessibility contract below is the
  // kind of thing that quietly regresses when it is one anonymous <a> nested three levels inside a
  // layout block" — and then nothing asserted the behavioural half of it. `href` was pinned above;
  // what the click DOES was not, in a file that already installs the opener mock.
  //
  // All three clauses matter and each fails differently. We are in a WebView: without
  // preventDefault a real navigation REPLACES THE RUNNING APP. Without `openUrl` the link goes
  // nowhere at all. And a swallowed rejection means a broken opener looks exactly like a working
  // one — the comment specifically calls for "a surfaced opener failure rather than a swallowed
  // promise", which is a claim about the `.catch`, not about the happy path.
  it("opens sparkle.ai through the Tauri opener instead of navigating the WebView", async () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    const link = screen.getByRole("link", { name: "Sparkle" });
    // `cancelable` so the return value of dispatch actually reports preventDefault — fireEvent.click
    // defaults to cancelable already, but stating it keeps the assertion from depending on that.
    const notPrevented = fireEvent.click(link, { cancelable: true });
    expect(notPrevented).toBe(false); // the WebView navigation was cancelled
    expect(openUrl).toHaveBeenCalledWith("https://sparkle.ai");
  });

  it("SURFACES an opener failure rather than swallowing the promise", async () => {
    const boom = new Error("no opener");
    vi.mocked(openUrl).mockRejectedValueOnce(boom);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<ConciergeColumn model={model} controller={controller()} />);
    fireEvent.click(screen.getByRole("link", { name: "Sparkle" }));
    // Flush the rejection's microtask — without this the .catch has not run and the test passes
    // whether or not one exists.
    await Promise.resolve();
    expect(err).toHaveBeenCalledWith("Failed to open sparkle.ai:", boom);
    err.mockRestore();
  });

  it("does NOT render it in the builder sidebar any more", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(screen.queryByRole("img", { name: "Sparkle" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Sparkle" })).toBeNull();
  });

  it("is the header's ONLY mark — no second brand wordmark under it", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    // The star field used to paint the literal word "Sparkle" directly beneath the logo: two brand
    // marks inside ~80px, left-aligned above centered, two neighbors both named "Sparkle".
    expect(screen.queryAllByText("Sparkle")).toHaveLength(0);
    expect(screen.getAllByRole("img", { name: "Sparkle" })).toHaveLength(1);
  });

  // IT NO LONGER SHARES A ROW WITH THE CREDIT PILL. That pairing was the pre-cockpit header: mark
  // hard left, pill hard right, `space-between` doing the pushing. The header has since
  // CONSOLIDATED to one row carrying wordmark · grip · scope · needs-you · PR · avatar · kebab
  // (the founder's explicit ask), and the credit badge is not on that list — it moved to the strip
  // below, with the waveform. See ConciergeColumn.header.test.tsx for the full row's contract; what
  // this file still owns is that the mark leads it and the badge did not get lost in the move.
  it("leads the consolidated header row, with the credit pill no longer beside it", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    const head = screen.getByTestId("concierge-header");
    // By role rather than alt — §1 turned the mark into an alpha-masked box (`role="img"` +
    // `aria-label`) instead of a painted <img>, so the accessible name survives but the element
    // is no longer an image.
    const logo = screen.getByRole("img", { name: "Sparkle" });
    const pill = screen.getByRole("button", { name: "Open credits" });
    expect(head.contains(logo)).toBe(true);
    expect(head.contains(pill)).toBe(false);
    // The mark is the row's FIRST element — nothing may be inserted to its left.
    expect(head.firstElementChild?.contains(logo)).toBe(true);
    // The badge still renders, still below the mark, and is still the shell's one money pill (the
    // last clause is asserted in its own describe further down).
    expect(logo.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // ── SEARCH SITS BESIDE THE MARK ──────────────────────────────────────────────────────────────
  // The founder's ask, verbatim: "I want the search to be up next to the Sparkle.ai logo." Before
  // this, the slot rendered OUTSIDE the header entirely — below the row and below the voice strip
  // (`{searchSlot && <div style={{ padding: "10px 16px 0" }}>` in ConciergeColumn) — which put the
  // app's only global search behind the one strip nobody scrolls past.
  //
  // ADJACENCY IS THE ASSERTION, not mere containment. "Next to" is the whole instruction, so a
  // future change that keeps the slot in the row but parks it after the spacer (i.e. hard right,
  // by the kebab) has to fail here — containment alone would call that a pass.
  describe("the search sits next to the wordmark", () => {
    const searchSlot = <div data-testid="search-slot">stub</div>;

    it("renders the search INSIDE the header row, not in a strip below it", () => {
      render(
        <ConciergeColumn model={model} controller={controller()} searchSlot={searchSlot} />,
      );
      const head = screen.getByTestId("concierge-header");
      expect(head.contains(screen.getByTestId("search-slot"))).toBe(true);
    });

    it("puts it IMMEDIATELY after the mark — nothing between them", () => {
      render(
        <ConciergeColumn model={model} controller={controller()} searchSlot={searchSlot} />,
      );
      const head = screen.getByTestId("concierge-header");
      const logo = screen.getByRole("img", { name: "Sparkle" });
      const search = screen.getByTestId("concierge-header-search");
      // The mark still LEADS the row (pinned above); the search is the very next child of it.
      expect(head.firstElementChild?.contains(logo)).toBe(true);
      expect(head.firstElementChild?.nextElementSibling).toBe(search);
      expect(search.contains(screen.getByTestId("search-slot"))).toBe(true);
    });

    it("does not grow, so the right-hand cluster stays on the right", () => {
      render(
        <ConciergeColumn model={model} controller={controller()} searchSlot={searchSlot} />,
      );
      const head = screen.getByTestId("concierge-header");
      const search = screen.getByTestId("concierge-header-search");
      // `flex: 0 0 auto` — the spacer must remain the row's ONE growing child, or the search
      // splits the slack and drags the avatar/kebab back toward the mark (roborev 57364).
      expect(search.style.flex).toBe("0 0 auto");
      const growing = [...head.children].filter(
        (el) => !/^0/.test((el as HTMLElement).style.flex || "0") && (el as HTMLElement).style.flex,
      );
      expect(growing).toEqual([screen.getByTestId("concierge-header-spacer")]);
    });

    it("still renders when the column is the only thing the host hands a slot", () => {
      // The slot is OPTIONAL — a column with no search must not render an empty box beside the
      // mark, which would open a gap the row's `gap: 7` then doubles.
      render(<ConciergeColumn model={model} controller={controller()} />);
      expect(screen.queryByTestId("concierge-header-search")).toBeNull();
    });
  });

  it("has no star field left anywhere in the column", () => {
    const { container } = render(<ConciergeColumn model={model} controller={controller()} />);
    // The field was a <canvas> painting drifting particles behind the mark. Deleting the component
    // but leaving a canvas mounted — or the reverse — are both half-landings of exactly the kind
    // this file exists to catch, so this asserts the absence of the ELEMENT, not of an import.
    expect(container.querySelector("canvas")).toBeNull();
  });
});

// What's left of the builder's old brand row, once the logo/waveform/badge moved out: nothing.
//
// The row's last child was "Show Helper", which existed only to undo the island's right-click →
// Hide Helper. Both were deleted together (§6) — deleting the button alone would have stranded
// anyone already in the hidden state with no way back. This used to be a PAIR of tests, the second
// asserting the row came back when the island was hidden; there is no longer a hidden state to
// bring it back for, so what is left is the unconditional absence of both.
describe("the builder sidebar's brand row is gone", () => {
  it("renders no row and no Show Helper button, in any state", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(screen.queryByTestId("show-helper")).toBeNull();
    expect(screen.queryByTestId("builder-helper-row")).toBeNull();
  });

  // `enabled` is back in the store (§15 — the island is dismissable again, with the native menu
  // bar as the guaranteed way back), but the SIDEBAR row is gone for good: the way back must live
  // somewhere that cannot itself be hidden, which a sidebar button never was. If any of that were
  // still wired up here, a hidden island would resurrect the row.
  it("stays gone even with a stale `enabled: false` left in the persisted prefs", () => {
    useHelperPrefs.setState({ enabled: false } as never);
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(screen.queryByTestId("builder-helper-row")).toBeNull();
    expect(screen.queryByTestId("show-helper")).toBeNull();
  });
});

describe("the voice waveform followed the logo into column one", () => {
  it("renders under the mark in the concierge header", () => {
    const { container } = render(<ConciergeColumn model={model} controller={controller()} />);
    const wave = screen.getByTestId("logo-waveform");
    // "Directly under the mark", asserted as document order rather than as pixels: the logo's row
    // must precede the waveform. DOCUMENT_POSITION_FOLLOWING is set on b when b comes after a.
    const logo = screen.getByRole("img", { name: "Sparkle" });
    expect(logo.compareDocumentPosition(wave) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and both are inside the header block, not stranded further down the column.
    expect(container.querySelector("section")?.contains(wave)).toBe(true);
  });

  it("is GONE from the builder sidebar", () => {
    const project = seed();
    render(<AgentSidebar project={project} />);
    expect(screen.queryByTestId("logo-waveform")).toBeNull();
  });
});

describe("the credit badge shows REMAINING credits, in column one", () => {
  it("renders the remaining balance from me.balanceCents in the concierge header", () => {
    render(<ConciergeColumn model={model} controller={controller()} />);
    // 15_387¢ → "$153.87". Read off the entitlement the server reports, NOT off any locally
    // derived spend figure: this number counts DOWN as credits are consumed.
    expect(screen.getByText("$153.87")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open credits" })).toBeTruthy();
  });

  it("tracks the balance rather than pinning a constant", () => {
    const { rerender } = render(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.getByText("$153.87")).toBeTruthy();
    seedBalance(9_900);
    rerender(<ConciergeColumn model={model} controller={controller()} />);
    expect(screen.getByText("$99.00")).toBeTruthy();
    expect(screen.queryByText("$153.87")).toBeNull();
  });

  it("refreshes the entitlement on mount in its new home", () => {
    const refresh = vi.fn(async () => {});
    useAuthStore.setState({
      me: { clerkUserId: "u1", entitled: true, balanceCents: REMAINING_CENTS, tokenVersion: 1 },
      refresh,
    } as never);
    render(<ConciergeColumn model={model} controller={controller()} />);
    // The badge's whole reason for calling refresh is that a top-up done elsewhere must show here.
    expect(refresh).toHaveBeenCalled();
  });

  it("is the ONLY money pill in the shell — the spend pill is gone from both columns", () => {
    const project = seed();
    const { unmount } = render(<ConciergeColumn model={model} controller={controller()} />);
    // Exactly one dollar figure in column one. The deleted SpendPill rendered a second one on this
    // same corner (a trailing-24h total counting UP), which is the confusion this move resolved.
    expect(screen.getAllByText(/^\$\d/).length).toBe(1);
    unmount();
    render(<AgentSidebar project={project} />);
    expect(screen.queryByText(/^\$\d/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open credits" })).toBeNull();
  });
});
