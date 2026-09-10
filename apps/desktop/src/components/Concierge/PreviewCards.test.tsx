// @vitest-environment jsdom
//
// The concierge preview card — the surface that stops a live preview's url from scrolling away.
//
// ══ THESE TESTS DRIVE THE REAL LIFECYCLE, NOT A HAND-BUILT STORE ════════════════════════════════
// Every card below arrives through `applyPreviewStatus` — the exact fold every Rust `preview:state`
// event goes through. Seeding `previewStore.byAgent` directly would test a shape the parser is
// supposed to produce, which is the vacuous form AGENTS.md names: it would keep passing if the
// detection seam were disconnected entirely.
//
// ══ EVERY ABSENCE IS ASSERTED WITH ITS PRESENT TWIN MOUNTED ═════════════════════════════════════
// "A non-loopback url renders nothing" and "the card retires" are both ABSENCE claims, and absence
// in a component that was never mounted proves nothing (AGENTS.md's `sparkle-foqoe` shape — a rule
// keyed to the wrong side stays green if only one side is ever in the tree). So each of those rows
// mounts BOTH agents at once and asserts one card is painted while the other is not.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const openUrlMock = vi.fn((_url: string) => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (u: string) => openUrlMock(u) }));

import {
  PreviewCards,
  PREVIEW_CARDS_TESTID,
  PREVIEW_CARD_TESTID,
  PREVIEW_CARD_SHOT_TESTID,
  PREVIEW_CARD_LEAD,
  PREVIEW_CARD_CAPTURED_TESTID,
  PREVIEW_CARD_REFRESH_TESTID,
  PREVIEW_CARD_REFRESH_FAILED_TESTID,
  PREVIEW_CARD_REFUSED_TESTID,
  PREVIEW_CARD_OPEN_TESTID,
  PREVIEW_CARD_TOGGLE_TESTID,
  PREVIEW_CARD_COLLAPSED_WIDTH,
  PREVIEW_CARD_EXPANDED_WIDTH,
  PREVIEW_OPEN_REFUSAL_COPY,
  PREVIEW_CARD_AGE_TICK_MS,
  PREVIEW_NOTICES_TESTID,
  PREVIEW_NOTICE_TESTID,
  PREVIEW_NOTICE_DETAIL_TESTID,
  PREVIEW_NOTICE_AGE_TESTID,
  PREVIEW_NOTICE_LEAD,
  PREVIEW_ZONE_TESTID,
  PreviewThreadArtifacts,
  PREVIEW_SHIPPED_CARD_LEAD,
  PREVIEW_SHIPPED_REFUSAL_COPY,
  PREVIEW_CARD_SCOPE_TESTID,
  PREVIEW_CARD_PR_TESTID,
  PREVIEW_LOCAL_SCOPE_NOTE,
  PREVIEW_SHIPPED_SCOPE_NOTE,
} from "./PreviewCards";
import { AgentPillProvider, type AgentPillContextValue } from "./AgentPill";
import { expectAnnounced, flattenedBy } from "../../testing/announcedControls";
import { applyPreviewStatus } from "../../services/preview";
// THE REAL WRITER, not a store seed. `recordShippedDeploy` is what the `preview shipped` control op
// calls, and it is where both gates live — so a row that drives it is asserting the production path
// rather than a shape the writer is supposed to produce (AGENTS.md's vacuous-fixture rule, and the
// same reason every local card below arrives through `applyPreviewStatus`).
import { recordShippedDeploy, SHIPPED_DEPLOY_PROVENANCE } from "../../services/shippedDeploy";
import { usePreviewStore, type PreviewState, type PreviewStatus } from "../../stores/previewStore";
import { useProjectStore } from "../../stores/projectStore";
import type { MentionAgent } from "./mentions";
import type { RevealOutcome } from "../../services/agentReveal";

const KRAKEN = "ag-kraken";
const OTTER = "ag-otter";
/** A THIRD agent, so the rows below can mount an openable preview, a FAILED one and an INSTALLING
 *  one in ONE tree. Absence asserted against a target that was never mounted proves nothing
 *  (AGENTS.md's `sparkle-foqoe`), and this feature's whole claim is about which of three
 *  simultaneous states gets which surface. */
const NEWT = "ag-newt";

/**
 * WHAT RUST WOULD ANSWER RIGHT NOW, per agent — the click-time source of truth, kept in a map that
 * is DELIBERATELY SEPARATE from the store.
 *
 * The founder's bug is precisely a DISAGREEMENT between the two: a card holding an address whose
 * server has since died and whose port another agent has taken. A fixture where the store IS the
 * live truth cannot express that, so it could only ever test the happy path. `fire` writes both
 * (an event and a re-read agreeing is the healthy case); {@link setLive} moves the live half alone.
 */
const liveStatus = new Map<string, PreviewStatus | null>();

/** Move the LIVE answer without emitting an event, so the card keeps what it was told while the
 *  world underneath it changes. Pass `null` for "this agent has no preview any more". */
function setLive(agentId: string, over: Partial<PreviewStatus> | null) {
  if (over === null) {
    liveStatus.set(agentId, null);
    return;
  }
  const prev = liveStatus.get(agentId);
  liveStatus.set(agentId, {
    id: `srv-${agentId}`,
    agentId,
    projectId: "p1",
    url: null,
    port: null,
    state: "ready",
    error: null,
    ...(prev ?? {}),
    ...over,
  });
}

/** The bridge every row starts from: `preview_status` answers {@link liveStatus}, and everything
 *  else refuses — no headless Chromium is the ORDINARY machine, not the exotic one. */
function defaultInvoke(cmd: string, args?: { agentId?: string }): Promise<unknown> {
  if (cmd === "preview_status") return Promise.resolve(liveStatus.get(args?.agentId ?? "") ?? null);
  return Promise.reject(new Error("no preview is open"));
}

/** One wire payload, exactly as Rust emits it — every optional field an explicit `null`, never an
 *  omitted key (the `T | null` contract on `PreviewStatus`). */
function fire(
  agentId: string,
  state: PreviewState,
  url: string | null,
  port: number | null = 5173,
  error: string | null = null,
) {
  // The healthy world: what Rust just emitted is also what Rust would answer if asked again. A row
  // that wants the UNhealthy world moves this half afterwards with `setLive`.
  liveStatus.set(agentId, { id: `srv-${agentId}`, agentId, projectId: "p1", url, port, state, error });
  // Inside `act`, because the fold is a STORE WRITE rather than a React event: outside it, React 18
  // has not flushed the subscriber by the time the next line reads the DOM, and every assertion
  // below would be about the render BEFORE the event. That failure looks exactly like a broken
  // selector, which is the wrong place to go looking.
  act(() => {
    applyPreviewStatus({
      id: `srv-${agentId}`,
      agentId,
      projectId: "p1",
      url,
      port,
      state,
      error,
    });
  });
}

function roster(): MentionAgent[] {
  return [
    { id: KRAKEN, name: "Kraken Auth", projectId: "p1", projectName: "sparkle", band: "running", canAcceptInput: true },
    { id: OTTER, name: "Otter Charts", projectId: "p1", projectName: "sparkle", band: "running", canAcceptInput: true },
    { id: NEWT, name: "Newt Deps", projectId: "p1", projectName: "sparkle", band: "running", canAcceptInput: true },
  ];
}

function mount(over: Partial<AgentPillContextValue> = {}) {
  const value: AgentPillContextValue = {
    agents: roster(),
    onOpenAgent: vi.fn((): RevealOutcome => "revealed"),
    ...over,
  };
  const utils = render(
    <AgentPillProvider value={value}>
      <PreviewCards />
    </AgentPillProvider>,
  );
  return { ...utils, value };
}

/** The LIVE agent pill for one agent. `getByText(name)` cannot find it: the pill renders the name
 *  behind an `@` sigil in the same span, so its text content is `@Kraken Auth`. Reading the pill by
 *  its own testid + `data-agent-id` also proves the card handed the pill the right id, which a text
 *  match would not. */
function pillFor(agentId: string): HTMLElement {
  const el = screen
    .getAllByTestId("concierge-agent-pill")
    .find((p) => p.getAttribute("data-agent-id") === agentId);
  if (!el) throw new Error(`no live agent pill for ${agentId}`);
  return el;
}

/** The cards on screen, as `[agentId, url]` — read off the DOM, never off the store. */
function cardsOnScreen(): [string, string][] {
  return screen
    .queryAllByTestId(PREVIEW_CARD_TESTID)
    .map((el) => [el.getAttribute("data-agent-id") ?? "", el.getAttribute("data-preview-url") ?? ""]);
}

beforeEach(() => {
  invokeMock.mockReset();
  openUrlMock.mockClear();
  liveStatus.clear();
  // No screenshot by default: a capture needs a headless Chromium that may not be installed, and
  // that is the ORDINARY case, not the exotic one. The rows that care about the picture opt in.
  // `preview_status` DOES answer, because it is the click-time ownership read every open goes
  // through — a bridge that refuses it would make every card refuse, which is not the ordinary case.
  invokeMock.mockImplementation(defaultInvoke);
  usePreviewStore.setState({ byAgent: {}, shippedByAgent: {}, capability: {}, openedProjects: {} });
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        agents: [
          { id: KRAKEN, name: "Kraken Auth" },
          { id: OTTER, name: "Otter Charts" },
          { id: NEWT, name: "Newt Deps" },
        ],
      },
    ],
    selectedProjectId: "p1",
  } as never);
});
afterEach(() => cleanup());

describe("a live preview becomes a card", () => {
  it("renders from a preview:state event carrying a loopback url", () => {
    // Nothing on screen before the event — so the assertion below is about the EVENT, not about the
    // component rendering something unconditionally.
    mount();
    expect(cardsOnScreen()).toEqual([]);

    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    expect(cardsOnScreen()).toEqual([[KRAKEN, "http://127.0.0.1:5173"]]);
    expect(screen.getByText(PREVIEW_CARD_LEAD)).toBeTruthy();
    // The founder's shape names the agent. A card that cannot say whose preview it is has lost the
    // half that makes it actionable — and it must be the LIVE pill (`concierge-agent-pill`), not
    // the `…-closed` dead-end variant, which would name an agent the reader cannot open.
    expect(pillFor(KRAKEN).textContent).toContain("Kraken Auth");
  });

  it("does NOT render a non-loopback url — with a loopback card mounted beside it", () => {
    // BOTH agents fire, in one tree. If this only mounted the LAN one, the absence would be
    // satisfied by a component that renders nothing at all.
    mount();
    fire(KRAKEN, "serving", "http://127.0.0.1:5173");
    fire(OTTER, "serving", "http://192.168.1.42:3000");

    const on = cardsOnScreen();
    expect(on).toEqual([[KRAKEN, "http://127.0.0.1:5173"]]);
    expect(on.some(([id]) => id === OTTER)).toBe(false);
    // And the store DOES hold the refused one, so this is the card gate declining rather than the
    // event never having landed.
    expect(usePreviewStore.getState().byAgent[OTTER]?.url).toBe("http://192.168.1.42:3000");
  });

  it("does not offer a card before the server has compiled anything", () => {
    // `listening` binds a port before the first build finishes, so a card there sends the reader to
    // the framework's own "compiling…" page. Same pair-mounted shape: `ready` beside it, so the
    // absence is a verdict rather than an empty tree.
    mount();
    fire(KRAKEN, "ready", "http://localhost:4321");
    fire(OTTER, "listening", "http://localhost:4322");
    expect(cardsOnScreen()).toEqual([[KRAKEN, "http://localhost:4321"]]);
  });

  it("gives no card to an agent that is not in the fleet", () => {
    // A card's whole proposition is "someone is showing you something RIGHT NOW". An id the roster
    // cannot resolve has nothing to show, and `AgentPill` would render it as the "…is closed"
    // dead end — a card naming an agent the reader cannot open, which LOOKS like a working card.
    //
    // The live agent fires too, so this is the resolution rule declining rather than the strip
    // being empty for some unrelated reason.
    useProjectStore.setState({
      projects: [{ id: "p1", name: "sparkle", agents: [{ id: KRAKEN, name: "Kraken Auth" }] }],
      selectedProjectId: "p1",
    } as never);
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire("ag-ghost", "ready", "http://localhost:4321");

    expect(cardsOnScreen()).toEqual([[KRAKEN, "http://127.0.0.1:5173"]]);
    expect(screen.queryByTestId("concierge-agent-pill-closed")).toBeNull();
  });
});

// ══ EVERY CONTROL ON THE CARD IS ANNOUNCED, AND NONE IS FLATTENED ════════════════════════════════
//
// THE DEFECT (bead sparkle-2mwl2m.1). The card root carried `role="button"` + `tabIndex` so the
// whole card was the expand toggle, and WAI-ARIA gives that role PRESENTATIONAL CHILDREN — assistive
// tech flattens the entire subtree to the root's own accessible name. The agent pill, ⟳ and, worst,
// "Open in browser" — whose accessible name is where the URL lives, the actionable half of the whole
// card — were announced as nothing at all. It renders identically and every behavioural row in this
// file stayed green, because `fireEvent.click` does not consult the accessibility tree.
//
// THE REMEDY IS BeadCard's, and for a DISCLOSURE BeadCard puts the real `<button>` on the title:
// here that is the lead line, which now carries `aria-expanded` and the name the root used to hold.
// So the two halves are asserted together — the controls are announced, AND the gesture that made
// the root a "button" still works from a real control.
describe("PreviewCards — the card's nested controls reach the accessibility tree", () => {
  it("announces the pill, the disclosure, Open in browser and ⟳ by their own role and name", () => {
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);
    const card = screen.getByTestId(PREVIEW_CARD_TESTID);
    expectAnnounced(card, [
      { testId: "concierge-agent-pill", role: "button", name: /@Kraken Auth/ },
      { testId: PREVIEW_CARD_TOGGLE_TESTID, role: "button", name: "Expand Kraken Auth's preview" },
      {
        testId: PREVIEW_CARD_OPEN_TESTID,
        role: "button",
        name: "Open Kraken Auth's preview at http://127.0.0.1:5173 in the browser",
      },
      {
        testId: PREVIEW_CARD_REFRESH_TESTID,
        role: "button",
        name: "Refresh the preview snapshot for Kraken Auth",
      },
    ]);
    // The card root is what decided all four. It is a plain generic now.
    expect(card.getAttribute("role")).toBeNull();
    expect(card.hasAttribute("tabindex")).toBe(false);
    expect(card.hasAttribute("aria-expanded")).toBe(false);
    expect(flattenedBy(screen.getByTestId(PREVIEW_CARD_OPEN_TESTID), card)).toBeNull();
  });

  it("the disclosure BUTTON toggles the card, and reports its own expanded state", () => {
    // PAIRED with the case above, and this is the half that proves nothing was merely deleted: the
    // root stopped being a toggle, so a real control had to become one. Both directions, because
    // "it expanded" alone is satisfied by a switch that can never collapse again.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);
    const toggle = () => screen.getByTestId(PREVIEW_CARD_TOGGLE_TESTID);
    expect(toggle().tagName).toBe("BUTTON");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle());
    expect(screen.getByTestId(PREVIEW_CARD_TESTID).getAttribute("data-expanded")).toBe("true");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().getAttribute("aria-label")).toBe("Collapse Kraken Auth's preview");

    fireEvent.click(toggle());
    expect(screen.getByTestId(PREVIEW_CARD_TESTID).getAttribute("data-expanded")).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    // …and it never navigated. The disclosure and the browser are different gestures on this card.
    expect(openUrlMock).not.toHaveBeenCalled();
  });
});

describe("the two click targets", () => {
  it("DOUBLE-clicking the card opens THAT card's loopback url", async () => {
    // Two live cards, so a handler wired to "the first preview" rather than to this card's own url
    // fails here instead of passing by coincidence. Opening is the DOUBLE click now (sparkle-7kn6bk)
    // — a single click expands in place and must not navigate, which the size describe asserts.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);
    fire(OTTER, "ready", "http://localhost:4321", 4321);

    const otter = screen
      .getAllByTestId(PREVIEW_CARD_TESTID)
      .find((el) => el.getAttribute("data-agent-id") === OTTER);
    expect(otter).toBeTruthy();
    fireEvent.dblClick(otter!);

    // AWAITED, because the open is no longer a straight hand-off: the card re-reads THIS agent's
    // live status first and opens only if the address it is showing is still that agent's own.
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledTimes(1));
    expect(openUrlMock).toHaveBeenCalledWith("http://localhost:4321");
  });

  it("clicking the agent name reveals THAT agent, and does not also open the browser", () => {
    // One gesture, one destination. Without the fence around the pill, a click on the name would
    // both reveal the agent AND launch a browser — the worst surprise this column can produce.
    const { value } = mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");

    fireEvent.click(pillFor(KRAKEN));

    expect(value.onOpenAgent).toHaveBeenCalledTimes(1);
    expect(value.onOpenAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: KRAKEN, projectId: "p1" }),
    );
    expect(openUrlMock).not.toHaveBeenCalled();
  });
});

describe("retirement — a card never outlives the server it points at", () => {
  it("drops the card when its preview stops, and keeps the one that is still serving", () => {
    mount();
    fire(KRAKEN, "serving", "http://127.0.0.1:5173");
    fire(OTTER, "serving", "http://localhost:4321");
    expect(cardsOnScreen()).toHaveLength(2);

    // The teardown event Rust emits. THE SIBLING STAYS: that is what makes this a retirement of one
    // card rather than the strip simply going away.
    fire(KRAKEN, "stopped", null, null);

    const on = cardsOnScreen();
    expect(on).toEqual([[OTTER, "http://localhost:4321"]]);
    expect(on.some(([id]) => id === KRAKEN)).toBe(false);
  });

  it("drops the card when the server crashes", () => {
    mount();
    fire(KRAKEN, "serving", "http://127.0.0.1:5173");
    fire(OTTER, "serving", "http://localhost:4321");
    fire(KRAKEN, "crashed", "http://127.0.0.1:5173");
    expect(cardsOnScreen()).toEqual([[OTTER, "http://localhost:4321"]]);
  });

  it("drops the card when the preview entry is cleared outright", () => {
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire(OTTER, "ready", "http://localhost:4321");
    act(() => usePreviewStore.getState().clearPreview(KRAKEN));
    expect(cardsOnScreen()).toEqual([[OTTER, "http://localhost:4321"]]);
  });
});

describe("the screenshot", () => {
  it("paints the captured PNG as a data url, through the real two-command path", async () => {
    // `preview_screenshot` answers a PATH (the pixels never cross the tool envelope), and this
    // webview's CSP is `img-src 'self' data:` — so the path has to go back through
    // `load_attachment` to become renderable. Both commands are asserted BY NAME, because a card
    // that skipped the second hop would render a `src` the webview silently refuses.
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "preview_screenshot") {
        return Promise.resolve({ path: "/tmp/sparkle-captures/shot.png", width: 1280, height: 800, bytes: 4096 });
      }
      if (cmd === "load_attachment") {
        return Promise.resolve({ path: "/tmp/sparkle-captures/shot.png", name: "shot.png", data_url: "data:image/png;base64,AAAA" });
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");

    const img = await waitFor(() => screen.getByTestId(PREVIEW_CARD_SHOT_TESTID));
    expect(img.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(invokeMock).toHaveBeenCalledWith("preview_screenshot", { agentId: KRAKEN });
    expect(invokeMock).toHaveBeenCalledWith("load_attachment", { path: "/tmp/sparkle-captures/shot.png" });
  });

  it("still renders the card, naming the agent and the url, when no capture is possible", async () => {
    // The default mock refuses — Playwright's headless Chromium not being installed is an ordinary
    // machine, not an error state. The card is the point; the picture is the garnish.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");

    await waitFor(() => expect(invokeMock).toHaveBeenCalled());
    expect(cardsOnScreen()).toEqual([[KRAKEN, "http://127.0.0.1:5173"]]);
    expect(screen.queryByTestId(PREVIEW_CARD_SHOT_TESTID)).toBeNull();
    // The url is on screen as text in place of the picture, so the reader can still read where it
    // goes without hovering or clicking.
    expect(screen.getByText("http://127.0.0.1:5173")).toBeTruthy();
  });
});

// ══ THE SNAPSHOT'S AGE, AND THE ⟳ THAT REFRESHES IT ═════════════════════════════════════════════
// A still picture of a LIVE site is only trustworthy if it says how old it is, and it can only stay
// trustworthy if the reader can take a new one. Both halves are asserted here from the failing side:
// the caption exists only where there is a picture to date, it ages without any other re-render, and
// the ⟳ re-captures THIS card without also launching a browser.
describe("the snapshot's age and its ⟳", () => {
  /**
   * A capture path that answers a DIFFERENT data url per call, per agent — so "the picture changed"
   * is distinguishable from "the picture was already there", which a single fixed url cannot show.
   * An agent with no entry here REFUSES the capture, which is the ordinary no-headless-Chromium
   * machine and the state the absence rows need.
   *
   * The chosen data url rides through on the `path`, so both hops are still real: a component that
   * skipped `load_attachment` would render a `src` the webview refuses.
   */
  function captureFor(shots: Record<string, string[]>) {
    const seen: Record<string, number> = {};
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string, args?: { agentId?: string; path?: string }) => {
      if (cmd === "preview_screenshot") {
        const id = args?.agentId ?? "";
        const list = shots[id];
        if (!list?.length) return Promise.reject(new Error("headless-browser-missing"));
        const i = Math.min(seen[id] ?? 0, list.length - 1);
        seen[id] = (seen[id] ?? 0) + 1;
        return Promise.resolve({ path: `${id}|${list[i]}`, width: 1280, height: 800, bytes: 4096 });
      }
      if (cmd === "load_attachment") {
        const carried = String(args?.path ?? "").split("|")[1] ?? "";
        return Promise.resolve({ path: args?.path, name: "shot.png", data_url: carried });
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });
  }

  const shotsFor = (agentId: string) =>
    screen.queryAllByTestId(PREVIEW_CARD_SHOT_TESTID).filter(
      (el) => el.closest(`[data-agent-id="${agentId}"]`) !== null,
    );
  const captionFor = (agentId: string) =>
    screen.queryAllByTestId(PREVIEW_CARD_CAPTURED_TESTID).find(
      (el) => el.closest(`[data-agent-id="${agentId}"]`) !== null,
    );
  const refreshFor = (agentId: string) =>
    screen.queryAllByTestId(PREVIEW_CARD_REFRESH_TESTID).find(
      (el) => el.closest(`[data-agent-id="${agentId}"]`) !== null,
    );
  const screenshotCalls = (agentId: string) =>
    invokeMock.mock.calls.filter(
      (c) => c[0] === "preview_screenshot" && (c[1] as { agentId?: string })?.agentId === agentId,
    ).length;

  it("dates the card that has a picture, and dates nothing on the card that has none", async () => {
    // BOTH CARDS MOUNTED, one capturing and one refusing. The absence on Otter is then a verdict
    // about a card that is really in the tree — the `sparkle-foqoe` shape AGENTS.md names.
    captureFor({ [KRAKEN]: ["data:image/png;base64,AAAA"] });
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire(OTTER, "ready", "http://localhost:4321");

    await waitFor(() => expect(shotsFor(KRAKEN)).toHaveLength(1));
    expect(captionFor(KRAKEN)?.textContent).toBe("captured just now");
    expect(refreshFor(KRAKEN)).toBeTruthy();

    // Otter's card is on screen — it just has nothing to DATE, so it carries no caption…
    expect(cardsOnScreen().some(([id]) => id === OTTER)).toBe(true);
    expect(shotsFor(OTTER)).toHaveLength(0);
    expect(captionFor(OTTER)).toBeUndefined();
    // …but it DOES carry the ⟳. See the next row: gating the retry on a picture puts it out of
    // reach in exactly the case it exists for.
    expect(refreshFor(OTTER)).toBeTruthy();
  });

  it("offers the ⟳ to a card whose FIRST capture failed, and a press then fixes it", async () => {
    // THE CASE THE RETRY EXISTS FOR. `no-preview` and `preview-not-ready` are ordinary transient
    // refusals, and the automatic capture has already burned its fetch key by the time one lands —
    // so the effect will never re-fire. With the ⟳ gated on a picture, one unlucky second left the
    // card picture-less for the entire life of that preview: a permanent outcome from a transient
    // failure. Here the first capture loses and the reader recovers it by hand.
    captureFor({}); // nothing capturable yet
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    await waitFor(() => expect(screen.getByTestId(PREVIEW_CARD_REFRESH_FAILED_TESTID)).toBeTruthy());
    expect(shotsFor(KRAKEN)).toHaveLength(0);

    captureFor({ [KRAKEN]: ["data:image/png;base64,AAAA"] });
    fireEvent.click(refreshFor(KRAKEN)!);

    await waitFor(() => expect(shotsFor(KRAKEN)[0]?.getAttribute("src")).toBe("data:image/png;base64,AAAA"));
    // …and the failure note clears with the success, so it can never outlive what it describes.
    expect(screen.queryByTestId(PREVIEW_CARD_REFRESH_FAILED_TESTID)).toBeNull();
  });

  it("⟳ re-captures THIS card and does not also open the browser", async () => {
    // Two live cards with pictures, so a handler wired to "the first card" rather than to this one
    // fails here instead of passing by coincidence.
    captureFor({
      [KRAKEN]: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"],
      [OTTER]: ["data:image/png;base64,CCCC"],
    });
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire(OTTER, "ready", "http://localhost:4321");
    await waitFor(() => expect(shotsFor(KRAKEN)[0]?.getAttribute("src")).toBe("data:image/png;base64,AAAA"));
    await waitFor(() => expect(shotsFor(OTTER)[0]?.getAttribute("src")).toBe("data:image/png;base64,CCCC"));

    fireEvent.click(refreshFor(KRAKEN)!);

    await waitFor(() => expect(shotsFor(KRAKEN)[0]?.getAttribute("src")).toBe("data:image/png;base64,BBBB"));
    // The other card is untouched — one gesture, one card.
    expect(shotsFor(OTTER)[0]?.getAttribute("src")).toBe("data:image/png;base64,CCCC");
    expect(screenshotCalls(OTTER)).toBe(1);
    // AND THE FENCE. The ⟳ sits inside a card whose own click opens the url; without
    // `stopPropagation` a refresh would also launch a browser, which is the worst surprise here.
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("keeps the picture it had when a re-capture fails", async () => {
    // A refresh that cannot capture (the headless browser went away, the server is mid-restart)
    // must not leave the card with LESS than it had. The timestamp is what keeps that honest: it
    // does not move, so the reader is never told a stale picture is fresh.
    captureFor({ [KRAKEN]: ["data:image/png;base64,AAAA"] });
    let failNext = false;
    const base = invokeMock.getMockImplementation()!;
    invokeMock.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "preview_screenshot" && failNext) return Promise.reject(new Error("no preview is open"));
      return base(cmd, args);
    });
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    await waitFor(() => expect(shotsFor(KRAKEN)[0]?.getAttribute("src")).toBe("data:image/png;base64,AAAA"));

    failNext = true;
    fireEvent.click(refreshFor(KRAKEN)!);
    await waitFor(() => expect(screenshotCalls(KRAKEN)).toBe(2));

    expect(shotsFor(KRAKEN)[0]?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(captionFor(KRAKEN)?.textContent).toBe("captured just now");
  });

  it("re-captures when the preview surfaces again WITHOUT the card unmounting", async () => {
    // THE ROW THAT PAYS FOR `surfacedAt` IN THE FETCH KEY, and the state has to be chosen with
    // care. A restart through `starting`/`stopped` proves NOTHING here: those are not surfacing
    // states, so the card is retired and a fresh one mounts with an empty fetch ref — it would
    // re-capture with the key stripped out entirely (verified: that mutant stays green).
    //
    // `ready` → `serving` is the transition that keeps the SAME card mounted while stamping a new
    // `surfacedAt`, and it is exactly the one worth re-capturing on: the picture taken at `ready`
    // can be the framework's own compiling page, and `serving` is the site the reader was promised.
    captureFor({ [KRAKEN]: ["data:image/png;base64,AAAA", "data:image/png;base64,BBBB"] });
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    await waitFor(() => expect(shotsFor(KRAKEN)[0]?.getAttribute("src")).toBe("data:image/png;base64,AAAA"));
    const card = screen.getAllByTestId(PREVIEW_CARD_TESTID)[0];

    fire(KRAKEN, "serving", "http://127.0.0.1:5173");

    await waitFor(() => expect(shotsFor(KRAKEN)[0]?.getAttribute("src")).toBe("data:image/png;base64,BBBB"));
    expect(screenshotCalls(KRAKEN)).toBe(2);
    // THE SAME ELEMENT THROUGHOUT — otherwise this would be a remount re-capturing, which is the
    // vacuous version of this test rather than the guard it claims to be.
    expect(screen.getAllByTestId(PREVIEW_CARD_TESTID)[0]).toBe(card);
  });

  it("ignores a second press while a capture is still running", async () => {
    // ONE BROWSER AT A TIME. A capture drives a real headless Chromium and is serialized nowhere on
    // the Rust side, while a failed one by design changes NOTHING on screen — so the natural
    // response to "I clicked and nothing happened" is to click again. Four presses in six seconds
    // would launch four browsers and throw three of the results away.
    let release!: (v: unknown) => void;
    const held = new Promise((r) => {
      release = r;
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "preview_screenshot") {
        return held.then(() => ({ path: "x|data:image/png;base64,AAAA", width: 1, height: 1, bytes: 1 }));
      }
      if (cmd === "load_attachment") {
        return Promise.resolve({ path: args?.path, name: "shot.png", data_url: "data:image/png;base64,AAAA" });
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    // The automatic capture is in flight and holding, so the button must already be refusing.
    await waitFor(() => expect((refreshFor(KRAKEN) as HTMLButtonElement).disabled).toBe(true));
    expect(screenshotCalls(KRAKEN)).toBe(1);

    fireEvent.click(refreshFor(KRAKEN)!);
    fireEvent.click(refreshFor(KRAKEN)!);
    fireEvent.click(refreshFor(KRAKEN)!);
    expect(screenshotCalls(KRAKEN)).toBe(1);

    // Once it lands the control comes back, so this is a QUEUE OF ONE and not a dead button.
    await act(async () => {
      release(null);
      await held;
    });
    await waitFor(() => expect((refreshFor(KRAKEN) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(refreshFor(KRAKEN)!);
    expect(screenshotCalls(KRAKEN)).toBe(2);
  });

  it("does not let an older capture land on top of a newer one", async () => {
    // THE ROW THAT PAYS FOR THE RUN COUNTER. Two captures can be in flight at once — the automatic
    // one armed by `ready` and the one armed by the `ready` → `serving` transition — and nothing
    // makes them resolve in the order they started. Without the counter the LATE one wins and
    // stamps `capturedAt: Date.now()`, i.e. a stale picture labelled "captured just now", which is
    // precisely the lie the caption exists to prevent.
    let releaseFirst!: (v: unknown) => void;
    const first = new Promise((r) => {
      releaseFirst = r;
    });
    let call = 0;
    invokeMock.mockReset();
    invokeMock.mockImplementation((cmd: string, args?: { path?: string }) => {
      if (cmd === "preview_screenshot") {
        call += 1;
        const mine = call;
        const shot = { path: `x|${mine === 1 ? "OLD" : "NEW"}`, width: 1, height: 1, bytes: 1 };
        return mine === 1 ? first.then(() => shot) : Promise.resolve(shot);
      }
      if (cmd === "load_attachment") {
        const carried = String(args?.path ?? "").split("|")[1] ?? "";
        return Promise.resolve({ path: args?.path, name: "shot.png", data_url: `data:image/png;base64,${carried}` });
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`));
    });

    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173"); // capture #1 — held
    fire(KRAKEN, "serving", "http://127.0.0.1:5173"); // capture #2 — resolves immediately
    await waitFor(() => expect(shotsFor(KRAKEN)[0]?.getAttribute("src")).toBe("data:image/png;base64,NEW"));

    // NOW the first one comes back, out of order, carrying the older picture.
    await act(async () => {
      releaseFirst(null);
      await first;
    });

    expect(shotsFor(KRAKEN)[0]?.getAttribute("src")).toBe("data:image/png;base64,NEW");
    expect(screenshotCalls(KRAKEN)).toBe(2);
  });

  it("ages the caption on its own, with no other re-render to ride on", async () => {
    // THE ROW THAT PAYS FOR `PREVIEW_CARD_AGE_TICK_MS`. Nothing writes to `previewStore` while a
    // dev server sits quietly serving, so a caption computed once would read "just now" forever —
    // exactly the lie it was added to prevent. Delete the interval and this goes red.
    captureFor({ [KRAKEN]: ["data:image/png;base64,AAAA"] });
    vi.useFakeTimers();
    try {
      mount();
      fire(KRAKEN, "ready", "http://127.0.0.1:5173");
      // Flush the capture's microtasks; the fake clock does not need to move for a promise.
      await act(async () => {});
      expect(captionFor(KRAKEN)?.textContent).toBe("captured just now");

      // No store write, no event, no gesture — only time passing.
      act(() => {
        vi.advanceTimersByTime(5 * 60_000);
      });
      expect(captionFor(KRAKEN)?.textContent).toBe("captured 5m");
      // And the tick is finer than `formatAgo`'s first threshold, so the label cannot skip past the
      // moment it stops being "just now".
      expect(PREVIEW_CARD_AGE_TICK_MS).toBeLessThan(45_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ══ THE PREVIEW THAT CANNOT BE OPENED, SAID OUT LOUD ════════════════════════════════════════════
// The hole this closes: `livePreviewCards` gates on `ready`/`serving`, so an agent could ask for a
// preview, the dev server could fail to boot, and the concierge column would show ABSOLUTELY
// NOTHING — no card, no pill, no error — at the one moment the reader most needs to know. Same for
// the up-to-five-minute `installing` wait (`preview.rs`'s `INSTALL_WAIT_TIMEOUT`).
//
// EVERY ROW BELOW MOUNTS ALL THREE OUTCOMES AT ONCE — a `ready` preview, a `failed` one and an
// `installing` one — because the claim is about which of N simultaneous states gets which surface,
// and absence asserted against a target that is not in the tree proves nothing (`sparkle-foqoe`).
describe("a preview that is NOT openable still says something", () => {
  /** The notices on screen, as `[agentId, status]` — read off the DOM, never off the store. */
  function noticesOnScreen(): [string, string][] {
    return screen
      .queryAllByTestId(PREVIEW_NOTICE_TESTID)
      .map((el) => [
        el.getAttribute("data-agent-id") ?? "",
        el.getAttribute("data-preview-status") ?? "",
      ]);
  }
  const noticeFor = (agentId: string) =>
    screen
      .queryAllByTestId(PREVIEW_NOTICE_TESTID)
      .find((el) => el.getAttribute("data-agent-id") === agentId);
  const detailFor = (agentId: string) =>
    screen
      .queryAllByTestId(PREVIEW_NOTICE_DETAIL_TESTID)
      .find((el) => el.closest(`[data-agent-id="${agentId}"]`) !== null);

  /** The exact shape `preview.rs` writes: its own sentence, then `stderr_tail`'s `Last output: …`. */
  const TAIL =
    "the dev server exited before it started listening. Last output: Error: Cannot find module 'vite'";

  it("paints the live card, the failure WITH ITS STDERR TAIL, and the install — all three at once", () => {
    mount();
    // Nothing before the events, so every assertion below is about the EVENTS rather than about the
    // component painting something unconditionally.
    expect(cardsOnScreen()).toEqual([]);
    expect(noticesOnScreen()).toEqual([]);

    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire(OTTER, "failed", null, null, TAIL);
    fire(NEWT, "installing", null, null);

    // 1. THE OPENABLE ONE is still exactly one card, and it is Kraken's.
    expect(cardsOnScreen()).toEqual([[KRAKEN, "http://127.0.0.1:5173"]]);

    // 2. THE FAILURE gets a notice, not a card — and its stderr tail is in the DOM as TEXT. This is
    //    the assertion the whole feature exists for: the string `preview.rs` already produced, on
    //    screen, where the reader is.
    expect(noticeFor(OTTER)?.getAttribute("data-preview-status")).toBe("failed");
    expect(detailFor(OTTER)?.textContent).toBe(TAIL);
    expect(detailFor(OTTER)?.textContent).toContain("Cannot find module 'vite'");
    expect(screen.getByText(PREVIEW_NOTICE_LEAD.failed)).toBeTruthy();

    // 3. THE INSTALL says what it is doing, with no error text to show.
    expect(noticeFor(NEWT)?.getAttribute("data-preview-status")).toBe("installing");
    expect(detailFor(NEWT)).toBeUndefined();
    expect(screen.getByText(PREVIEW_NOTICE_LEAD.installing)).toBeTruthy();

    // …and the two notices are notices only — neither of them leaked into the card strip.
    expect(cardsOnScreen().some(([id]) => id === OTTER || id === NEWT)).toBe(false);
    expect(noticesOnScreen().some(([id]) => id === KRAKEN)).toBe(false);
  });

  it("makes the failed notice STRUCTURALLY un-openable, beside a card that opens", async () => {
    // "A dead link is worse than no card, because it costs the reader a click to learn it is dead."
    // The notice keeps that rule by having NOTHING to activate — not by being styled inert, which
    // still invites the click that teaches the reader it is dead.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire(OTTER, "failed", "http://127.0.0.1:4321", 4321, TAIL);
    fire(NEWT, "installing", null, null);

    const failed = noticeFor(OTTER)!;
    expect(failed).toBeTruthy();
    // No affordance, no url to hand anyone — asserted on the element rather than on its colour.
    expect(failed.getAttribute("role")).toBeNull();
    expect(failed.getAttribute("tabindex")).toBeNull();
    expect(failed.getAttribute("data-preview-url")).toBeNull();

    // A click and an Enter both do nothing at all…
    fireEvent.click(failed);
    fireEvent.keyDown(failed, { key: "Enter" });
    expect(openUrlMock).not.toHaveBeenCalled();

    // …while the LIVE card mounted beside it still opens on its own open gesture (a double-click).
    // Without this half the absence above would be satisfied by an `openUrl` broken everywhere.
    fireEvent.dblClick(screen.getByTestId(PREVIEW_CARD_TESTID));
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledTimes(1));
    expect(openUrlMock).toHaveBeenCalledWith("http://127.0.0.1:5173");
  });

  it("names the failing agent with a LIVE pill, and gives no notice to an agent off the roster", () => {
    // A notice whose whole proposition is "SOMEONE's server just died" is worthless when the
    // someone cannot be named or opened — and `AgentPill` would degrade an unresolvable id to the
    // `…-closed` dead end, which reads as a working pill.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire(OTTER, "failed", null, null, TAIL);
    fire(NEWT, "installing", null, null);
    fire("ag-ghost", "failed", null, null, "gone before anyone could name it");

    expect(pillFor(OTTER).textContent).toContain("Otter Charts");
    expect(screen.queryByTestId("concierge-agent-pill-closed")).toBeNull();
    expect(noticesOnScreen().some(([id]) => id === "ag-ghost")).toBe(false);
    // The store DOES hold the ghost, so this is the roster gate declining rather than the event
    // never having landed.
    expect(usePreviewStore.getState().byAgent["ag-ghost"]?.status).toBe("failed");
  });

  it("gives a STOPPED preview nothing at all — no card and no notice", () => {
    // THE RETIREMENT RULE, which had to survive this change. `stopped` is where the whole surface
    // goes away; it is not a state to announce. Both live twins stay mounted so this is a verdict
    // about `stopped` rather than an empty tree.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire(NEWT, "installing", null, null);
    fire(OTTER, "serving", "http://localhost:4321");
    expect(cardsOnScreen()).toHaveLength(2);

    fire(OTTER, "stopped", null, null);

    expect(cardsOnScreen()).toEqual([[KRAKEN, "http://127.0.0.1:5173"]]);
    expect(noticesOnScreen()).toEqual([[NEWT, "installing"]]);
    expect(noticesOnScreen().some(([id]) => id === OTTER)).toBe(false);
  });

  it("retires the notice the moment the server comes up, and hands it a card instead", () => {
    // DERIVED RETIREMENT, end to end: no timer, no dismiss, no sweep. The same agent's `installing`
    // notice must become a card on `ready` — one surface at a time, never both.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire(NEWT, "installing", null, null);
    expect(noticesOnScreen()).toEqual([[NEWT, "installing"]]);

    fire(NEWT, "ready", "http://localhost:4321", 4321);

    expect(noticesOnScreen()).toEqual([]);
    expect(cardsOnScreen().some(([id, url]) => id === NEWT && url === "http://localhost:4321")).toBe(
      true,
    );
  });

  it("ages the notice on its own, with no other re-render to ride on", async () => {
    // THE ROW THAT PAYS FOR THE NOTICE STRIP'S OWN CLOCK. `preview.rs` waits up to 300s for an
    // install and emits NOTHING while it waits, so the entire five minutes produces zero store
    // writes — a caption computed once would read "started just now" for the whole wait, which is
    // exactly the lie this caption exists to prevent. Delete the interval and this goes red.
    vi.useFakeTimers();
    try {
      mount();
      fire(KRAKEN, "ready", "http://127.0.0.1:5173");
      fire(OTTER, "failed", null, null, TAIL);
      fire(NEWT, "installing", null, null);
      await act(async () => {});
      const ageFor = (agentId: string) =>
        screen
          .queryAllByTestId(PREVIEW_NOTICE_AGE_TESTID)
          .find((el) => el.closest(`[data-agent-id="${agentId}"]`) !== null)?.textContent;
      expect(ageFor(NEWT)).toBe("started just now");

      // No store write, no event, no gesture — only time passing.
      act(() => {
        vi.advanceTimersByTime(4 * 60_000);
      });
      expect(ageFor(NEWT)).toBe("started 4m");
      expect(ageFor(OTTER)).toBe("started 4m");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps a very long stderr tail on screen while keeping the whole thing on the title", async () => {
    // A stderr tail can be a whole stack trace, and the concierge column is ~320px wide and sits
    // above the composer — which nothing may push off screen. So the visible text is clamped and
    // the untruncated string rides on `title`, where a hover recovers it.
    const huge = `boot failed. Last output: ${"x".repeat(600)}END-OF-TAIL`;
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire(OTTER, "failed", null, null, huge);
    fire(NEWT, "installing", null, null);

    const detail = detailFor(OTTER)!;
    expect(detail.textContent!.length).toBeLessThan(huge.length);
    // THE TAIL IS WHAT SURVIVES, not the head: the last thing a dev server printed is the line that
    // says why it died.
    expect(detail.textContent).toContain("END-OF-TAIL");
    expect(detail.textContent!.startsWith("…")).toBe(true);
    // …and nothing is actually lost.
    expect(detail.getAttribute("title")).toBe(huge);
  });
});

// Neither strip may exist for nothing. Both rows mount the OTHER strip's content, so each absence
// is a verdict about an empty projection rather than about a component that renders nothing at all.
describe("neither strip is painted for an empty projection", () => {
  it("paints no notices region when every preview is openable", () => {
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire(OTTER, "serving", "http://localhost:4321");

    expect(screen.getAllByTestId(PREVIEW_CARD_TESTID)).toHaveLength(2);
    // An empty region is not free: it is a landmark in the a11y tree announcing "0 previews", plus
    // its own padding above the composer, for nothing.
    expect(screen.queryByTestId(PREVIEW_NOTICES_TESTID)).toBeNull();
  });

  it("paints no card region when every preview is only a notice", () => {
    mount();
    fire(OTTER, "failed", null, null, "boot failed. Last output: EADDRINUSE");
    fire(NEWT, "installing", null, null);

    expect(screen.getAllByTestId(PREVIEW_NOTICE_TESTID)).toHaveLength(2);
    expect(screen.queryByTestId(PREVIEW_CARDS_TESTID)).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE CARD IS THE IDLE CLOCK'S ONLY SOURCE OF "STILL WANTED" — so these two calls are guarded
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// `previewIdleGrace` stops a dev server that has seen no activity for `[preview] idle_grace_min`.
// The activity it measures cannot come from the wire: `supervise()` in `preview.rs` goes silent
// once a server is `Ready` — it sleeps on a liveness check and transitions again only to
// Crashed/Failed — so a healthy preview emits NOTHING for the rest of its life. That leaves this
// card as the only place a human's "I still want this" can be observed.
//
// WHY THESE ASSERTIONS DRIVE THE HANDLERS AND NEVER `notePreviewActivity` ITSELF. The seam is
// trivially testable on its own, and `previewStore.test.ts` already tests it that way. That is
// exactly the trap: with the seam covered and the call sites uncovered, deleting either line below
// keeps the ENTIRE suite green while the idle clock silently degrades from an idle clock into a
// max-lifetime cap — AGENTS.md's `sparkle-lgbwf` shape, and the reason it went unwired here in the
// first place (the seam and the call sites were built by two different agents, in two file scopes
// neither could cross). Both sites are pinned, per `sparkle-50m03`: checking one would go green on
// the first covered site while its sibling carried the same hole.
describe("PreviewCards — a human touching a card counts as activity", () => {
  it("opening through to the url (a double-click) stamps activity", async () => {
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");

    const before = usePreviewStore.getState().byAgent[KRAKEN]?.lastActivityAt ?? 0;
    expect(before).toBeGreaterThan(0);

    // Advance the clock so a stamp is DISTINGUISHABLE from the one the fold already wrote. Without
    // this the assertion would pass on a card that stamps nothing, since both reads land in the
    // same millisecond — a vacuous pass of precisely the kind this block exists to prevent.
    const later = before + 60_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      const card = screen
        .getAllByTestId(PREVIEW_CARD_TESTID)
        .find((el) => el.getAttribute("data-agent-id") === KRAKEN);
      // The OPEN gesture is a double-click now (sparkle-7kn6bk). `fireEvent.dblClick` dispatches
      // only the `dblclick`, so it drives `open` alone — the single-click expand path is covered
      // separately below.
      fireEvent.dblClick(card!);
    } finally {
      spy.mockRestore();
    }

    // STAMPED SYNCHRONOUSLY, before the click-time ownership read — the spy above is restored the
    // instant `fireEvent.dblClick` returns, so an implementation that stamped after the await would
    // record the real clock and this assertion would fail. The gesture happened either way, which
    // is the fact the grace clock is asking about.
    expect(usePreviewStore.getState().byAgent[KRAKEN]?.lastActivityAt).toBe(later);
    // …and the double-click still did its real job. Asserting both together is what stops a future
    // edit from swapping one for the other.
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledWith("http://127.0.0.1:5173"));
  });

  it("a click on the ⟳ while it is BUSY must not launch a browser", () => {
    // The default mock rejects, i.e. no headless Chromium — the ORDINARY machine. Activity is
    // stamped at the START of the capture for that reason: someone asked, and whether a browser
    // was available to answer is not a fact about whether the preview is still wanted.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");

    const before = usePreviewStore.getState().byAgent[KRAKEN]?.lastActivityAt ?? 0;
    const later = before + 60_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      const refresh = screen
        .queryAllByTestId(PREVIEW_CARD_REFRESH_TESTID)
        .find((el) => el.closest(`[data-agent-id="${KRAKEN}"]`) !== null) as HTMLButtonElement;
      // BUSY ON PURPOSE. The automatic mount capture is still in flight here, so the button is
      // DISABLED — and that is the state this row must cover, because a disabled button fires no
      // React onClick, so the fence has to come from the wrapper rather than from the handler. A
      // click here must still not launch a browser.
      expect(refresh.disabled).toBe(true);
      fireEvent.click(refresh);
    } finally {
      spy.mockRestore();
    }

    // A click the button REFUSED stamps nothing — activity is what the human's accepted gesture
    // means, and a disabled control accepted nothing. What matters is the fence: no browser.
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(usePreviewStore.getState().byAgent[KRAKEN]?.lastActivityAt).toBe(before);
  });

  it("an ACCEPTED refresh stamps activity, even when the capture fails", async () => {
    // The default mock rejects, i.e. no headless Chromium — the ORDINARY machine. Activity is
    // stamped at the START of the capture for that reason: someone asked, and whether a browser was
    // available to answer is not a fact about whether the preview is still wanted.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");

    const findRefresh = () =>
      screen
        .queryAllByTestId(PREVIEW_CARD_REFRESH_TESTID)
        .find((el) => el.closest(`[data-agent-id="${KRAKEN}"]`) !== null) as HTMLButtonElement;
    // Let the mount capture settle, so the click below is one the button actually ACCEPTS.
    await waitFor(() => expect(findRefresh().disabled).toBe(false));

    const before = usePreviewStore.getState().byAgent[KRAKEN]?.lastActivityAt ?? 0;
    const later = before + 60_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      fireEvent.click(findRefresh());
    } finally {
      spy.mockRestore();
    }

    expect(usePreviewStore.getState().byAgent[KRAKEN]?.lastActivityAt).toBe(later);
    expect(openUrlMock).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A CARD OPENS THE PORT ITS OWN AGENT OWNS — OR IT REFUSES, OUT LOUD
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// ══ THE MEASURED FAILURE ════════════════════════════════════════════════════════════════════════
// The founder clicked one agent's preview card and a DIFFERENT agent's app answered. `lsof` found
// exactly one dev server in the whole allocation range — on the port the card named, owned by a
// worktree belonging to someone else — and minutes later that server was gone too. So the card was
// holding an address whose server had DIED and whose port another agent had since taken. Nothing on
// screen could tell him: the url looked right, the page rendered, it was simply not his agent's.
//
// ══ WHY A STAMPED-ONCE VALUE CANNOT BE MADE SAFE ════════════════════════════════════════════════
// Giving each agent a distinct port (the Rust half) shrinks the window; it does not close it. Ports
// are recycled, servers die, and a value copied into a card at open time is a claim about a moment
// that has passed. The only address worth acting on is the one read from THIS agent's own live
// status at the instant of the click — which is what these rows drive.
//
// ══ REFUSING IS THE FEATURE, NOT THE ERROR PATH ═════════════════════════════════════════════════
// Every row below asserts the SIDE EFFECT: `openUrl` called with the right url, or NOT CALLED AT
// ALL. Opening the stale address anyway would satisfy any assertion about state, and is the exact
// outcome that is worse than an error — a wrong app the reader cannot tell is wrong.
describe("a preview card opens its own agent's port, or refuses", () => {
  const cardFor = (agentId: string) =>
    screen
      .queryAllByTestId(PREVIEW_CARD_TESTID)
      .find((el) => el.getAttribute("data-agent-id") === agentId);
  const refusalFor = (agentId: string) =>
    screen
      .queryAllByTestId(PREVIEW_CARD_REFUSED_TESTID)
      .find((el) => el.closest(`[data-agent-id="${agentId}"]`) !== null);
  /** The NOTICE for an agent — the surface a retired card falls back to. Local rather than shared
   *  with the notice describe below, which owns its own copy for the same reason. */
  const noticeForAgent = (agentId: string) =>
    screen
      .queryAllByTestId(PREVIEW_NOTICE_TESTID)
      .find((el) => el.getAttribute("data-agent-id") === agentId);

  it("never gives two agents the same url, and each card holds its OWN agent's port", async () => {
    // ══ THE ROW THE WHOLE BEAD IS ABOUT ══════════════════════════════════════════════════════
    // Both halves are asserted, and the second is what stops the first from passing by accident.
    // "The two urls differ" alone is satisfied by any implementation that hands out two different
    // wrong values; it says nothing about WHOSE port each card is showing. So the mapping is pinned
    // agent-by-agent as well — and then each card is CLICKED, because the url a card renders and
    // the url it opens are two different facts and only the second one can send the reader astray.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);
    fire(OTTER, "ready", "http://127.0.0.1:5174", 5174);

    const byAgent = Object.fromEntries(cardsOnScreen());
    expect(byAgent[KRAKEN]).toBe("http://127.0.0.1:5173");
    expect(byAgent[OTTER]).toBe("http://127.0.0.1:5174");
    // NO TWO CARDS MAY SHARE A URL. Stated as a set over everything on screen rather than as a
    // pairwise `not.toBe`, so a third card cannot quietly collide with one of these two.
    const urls = cardsOnScreen().map(([, u]) => u);
    expect(new Set(urls).size).toBe(urls.length);
    // …and each card carries its own agent's PORT as a fact of its own, not merely buried in a
    // string, so a future edit that keeps the urls distinct while losing the ownership fails here.
    expect(cardFor(KRAKEN)?.getAttribute("data-preview-port")).toBe("5173");
    expect(cardFor(OTTER)?.getAttribute("data-preview-port")).toBe("5174");

    fireEvent.dblClick(cardFor(KRAKEN)!);
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledTimes(1));
    expect(openUrlMock).toHaveBeenLastCalledWith("http://127.0.0.1:5173");

    fireEvent.dblClick(cardFor(OTTER)!);
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledTimes(2));
    expect(openUrlMock).toHaveBeenLastCalledWith("http://127.0.0.1:5174");
    // Neither click ever reached the other agent's address — the founder's exact failure, stated
    // as an assertion rather than as a hope.
    expect(openUrlMock.mock.calls.map(([u]) => u)).toEqual([
      "http://127.0.0.1:5173",
      "http://127.0.0.1:5174",
    ]);
  });

  it("REFUSES when the port the card holds is no longer this agent's, and says so", async () => {
    // The founder's case exactly: the card was told 5173; by click time this agent's server has
    // restarted on 5199 and 5173 is someone else's. Opening 5173 would show a working page that is
    // the wrong app — strictly worse than an error, because nothing on screen contradicts it.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);
    setLive(KRAKEN, { url: "http://127.0.0.1:5199", port: 5199, state: "serving" });

    fireEvent.dblClick(cardFor(KRAKEN)!);

    await waitFor(() => expect(refusalFor(KRAKEN)).toBeTruthy());
    // THE SIDE EFFECT, both directions: nothing was opened — not the stale address, and not the
    // freshly-discovered one either. A silent redirect to a url the reader never asked for is the
    // same class of surprise as a wrong app.
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(refusalFor(KRAKEN)?.textContent).toBe(PREVIEW_OPEN_REFUSAL_COPY.moved);
  });

  it("self-heals: the refused click re-derives the address, and the NEXT click opens it", async () => {
    // The refusal is not a dead end. Re-reading the live status is what discovered the mismatch, so
    // the store now holds the truth — the card re-renders onto the real port and the second click
    // goes through. Without this the remedy the copy promises ("click again") would be a lie.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);
    setLive(KRAKEN, { url: "http://127.0.0.1:5199", port: 5199, state: "serving" });

    fireEvent.dblClick(cardFor(KRAKEN)!);
    await waitFor(() => expect(refusalFor(KRAKEN)).toBeTruthy());
    await waitFor(() =>
      expect(cardFor(KRAKEN)?.getAttribute("data-preview-url")).toBe("http://127.0.0.1:5199"),
    );

    fireEvent.dblClick(cardFor(KRAKEN)!);
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledTimes(1));
    // THE NEW PORT, and only it. The stale one is never opened, on either click.
    expect(openUrlMock).toHaveBeenCalledWith("http://127.0.0.1:5199");
    expect(openUrlMock).not.toHaveBeenCalledWith("http://127.0.0.1:5173");
  });

  it("REFUSES when the agent has no preview any more — the server died under the card", async () => {
    // A card can outlive its server by the width of one event: `preview:state` has not landed yet,
    // or was missed entirely. The port is then free for the next allocation, which is how the
    // founder got someone else's app.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);
    setLive(KRAKEN, null);

    fireEvent.dblClick(cardFor(KRAKEN)!);

    await waitFor(() => expect(refusalFor(KRAKEN)?.textContent).toBe(PREVIEW_OPEN_REFUSAL_COPY.gone));
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("does not open a server that has since CRASHED — the card retires into a notice instead", async () => {
    // `crashed` keeps the entry and its url: a crashed process leaves its address behind, and that
    // address is exactly what the next allocation reuses. The card was rendered while it was
    // `ready`, so only a CLICK-TIME state check can catch this.
    //
    // THE REFUSAL HERE IS LOUDER THAN A SENTENCE, and that is why this row asserts an outcome
    // rather than copy. The read that answers the ownership question folds what it read into the
    // store, `crashed` is not a surfacing state, so the card retires on the spot and the existing
    // notice strip explains why. A refusal line on a card that no longer exists would be strictly
    // less than that — and asserting one would have pinned an implementation, not a behaviour.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);
    fire(OTTER, "ready", "http://127.0.0.1:5174", 5174);
    setLive(KRAKEN, { state: "crashed", error: "exit 1" });

    fireEvent.dblClick(cardFor(KRAKEN)!);

    // THE SIDE EFFECT: no navigation to the dead address, ever.
    await waitFor(() => expect(cardFor(KRAKEN)).toBeUndefined());
    expect(openUrlMock).not.toHaveBeenCalled();
    // …and the reader is told, rather than left with a card that quietly disappeared.
    expect(noticeForAgent(KRAKEN)?.getAttribute("data-preview-status")).toBe("crashed");
    // The sibling is untouched — this is one card's verdict, not the strip collapsing.
    expect(cardFor(OTTER)?.getAttribute("data-preview-url")).toBe("http://127.0.0.1:5174");
  });

  it("REFUSES when the live status names a DIFFERENT agent", async () => {
    // Belt to the braces: the read is keyed by agentId, so this should be unreachable. It is
    // asserted anyway because it is the literal shape of the incident — one agent's card, another
    // agent's server — and a gate that only holds while the layer beneath it is correct is not a
    // gate. Nothing else on the card could tell the reader.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);
    setLive(KRAKEN, { agentId: OTTER });

    fireEvent.dblClick(cardFor(KRAKEN)!);

    await waitFor(() =>
      expect(refusalFor(KRAKEN)?.textContent).toBe(PREVIEW_OPEN_REFUSAL_COPY["wrong-agent"]),
    );
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("REFUSES rather than falling back when the live read itself fails", async () => {
    // FAIL CLOSED. "We could not check" is not "it is fine": an unreachable bridge is precisely
    // when the held address is least trustworthy, and opening it anyway would make every other row
    // here decorative — one failed read and the stale-url path is back.
    invokeMock.mockImplementation((cmd: string) =>
      cmd === "preview_status"
        ? Promise.reject(new Error("bridge is down"))
        : Promise.reject(new Error("no preview is open")),
    );
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);

    fireEvent.dblClick(cardFor(KRAKEN)!);

    await waitFor(() =>
      expect(refusalFor(KRAKEN)?.textContent).toBe(PREVIEW_OPEN_REFUSAL_COPY.unreadable),
    );
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("puts the refusal on the card that refused, while the sibling still opens", async () => {
    // An absence asserted against a lone mounted card proves nothing (`sparkle-foqoe`). Both cards
    // are on screen: one refuses, the other opens on the same gesture — so this is a per-card
    // verdict rather than an open path that is broken everywhere.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);
    fire(OTTER, "ready", "http://127.0.0.1:5174", 5174);
    setLive(KRAKEN, null);

    fireEvent.dblClick(cardFor(KRAKEN)!);
    await waitFor(() => expect(refusalFor(KRAKEN)).toBeTruthy());
    expect(openUrlMock).not.toHaveBeenCalled();

    fireEvent.dblClick(cardFor(OTTER)!);
    await waitFor(() => expect(openUrlMock).toHaveBeenCalledTimes(1));
    expect(openUrlMock).toHaveBeenCalledWith("http://127.0.0.1:5174");
    // The refusal did not spread to the healthy card, and the healthy click did not clear the
    // refusal on the other one.
    expect(refusalFor(OTTER)).toBeUndefined();
    expect(refusalFor(KRAKEN)).toBeTruthy();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ONE HEIGHT BUDGET FOR THE WHOLE PREVIEW SURFACE — roborev 65681
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// `MAX_ZONE_HEIGHT` exists so nothing above the composer can push the composer off screen, and the
// concierge column has no scroll of its own — only the thread can give way. Splitting previews into
// TWO zones that each claimed the cap independently doubled the fixed budget, and `failed` notices
// make that durable rather than transient because nothing sweeps them. jsdom does not lay out, so
// this cannot be asserted in pixels; what it CAN assert is the structural property that makes the
// pixels safe — exactly ONE capped element, with both zones inside it.
describe("PreviewCards — the two zones share one height budget", () => {
  it("caps the whole surface once, with both strips inside that cap", () => {
    mount();
    // The mixed fleet the finding names: live previews AND a durable failure, at once.
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    fire(OTTER, "ready", "http://localhost:4321");
    fire(NEWT, "failed", null, null, "the dev server exited before it started listening.");

    const zones = screen.getAllByTestId(PREVIEW_ZONE_TESTID);
    expect(zones).toHaveLength(1);

    // Both strips are DESCENDANTS of the single budget — the property that stops the two from
    // adding up. Asserting they merely exist would pass with them as siblings of it.
    const cards = screen.getByTestId(PREVIEW_CARDS_TESTID);
    const notices = screen.getByTestId(PREVIEW_NOTICES_TESTID);
    const zone = zones[0]!;
    expect(zone.contains(cards)).toBe(true);
    expect(zone.contains(notices)).toBe(true);

    // …and neither strip re-declares a cap of its own, which is how the doubling came back.
    expect(cards.style.maxHeight).toBe("");
    expect(notices.style.maxHeight).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE RENDERED COPY OF A RUNNING-BUT-UNOPENABLE PREVIEW — roborev 65694
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The projection change had a test; its rendered wording did not. That is the half that bit: these
// two leads originally ended in a colon copied from the `failed` wording, and `detail` is null for
// a running preview (Rust writes `error` only on failed/crashed), so the notice rendered a sentence
// stopping at a dangling colon with nothing after it.
describe("PreviewCards — a running preview the card cannot open", () => {
  it("says so in a complete sentence, with no dangling colon and no detail span", () => {
    mount();
    // A serving preview on https — refused by the loopback predicate, so no card is possible.
    fire(OTTER, "serving", "https://localhost:5173");

    expect(cardsOnScreen()).toEqual([]);
    const notice = screen
      .getAllByTestId(PREVIEW_NOTICE_TESTID)
      .find((el) => el.getAttribute("data-agent-id") === OTTER);
    expect(notice).toBeTruthy();
    expect(notice!.textContent).toContain(PREVIEW_NOTICE_LEAD.serving);
    // A COLON PROMISES A DETAIL, and these two states can never carry one — `entry.error` is
    // written only on failed/crashed. So the promise must not be made. Asserted on the LEAD itself
    // rather than on the notice's whole textContent: the notice also renders an age caption after
    // the lead, so the full string never ends with the colon and an end-of-text check silently
    // passes even when the colon is back (which is exactly what the first version of this
    // assertion did — it survived its own mutation test).
    for (const state of ["ready", "serving"] as const) {
      expect(PREVIEW_NOTICE_LEAD[state].endsWith(":")).toBe(false);
    }
    // …and the lead really is what gets rendered, so the check above is about live copy rather
    // than an unused constant.
    expect(notice!.textContent).toContain(PREVIEW_NOTICE_LEAD.serving);
    // …and there is genuinely nothing to put in a detail span, so none is rendered.
    expect(
      screen.queryAllByTestId(PREVIEW_NOTICE_DETAIL_TESTID).filter(
        (el) => el.closest(`[data-agent-id="${OTTER}"]`) !== null,
      ),
    ).toEqual([]);
  });

  it("still renders the detail for a FAILED preview, which does carry one", () => {
    // The paired row: without it the assertion above is satisfied by never rendering a detail at
    // all, which would silently delete the stderr tail this whole surface was built to show.
    mount();
    const tail = "the dev server exited before it started listening. Last output: EADDRINUSE";
    fire(NEWT, "failed", null, null, tail);
    const detail = screen
      .getAllByTestId(PREVIEW_NOTICE_DETAIL_TESTID)
      .find((el) => el.closest(`[data-agent-id="${NEWT}"]`) !== null);
    expect(detail?.textContent).toContain("EADDRINUSE");
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// THE CARD SIZES TO ~1/3 THE CHAT COLUMN AND EXPANDS IN PLACE — sparkle-7kn6bk
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// The founder's ask: a card too small to judge anything by should not spend its single click leaving
// the app. So the DEFAULT is ~1/3 the chat column, a SINGLE CLICK expands it in place to the full
// column width, and the browser moved to a DOUBLE click plus an explicit "Open in browser" button.
//
// Every row asserts the SIDE EFFECT and its opposite together: the width the card actually carries,
// the toggle actually flipping, and — the pair that stops the primary gesture from silently opening
// again — that a single click expands WITHOUT navigating while the button navigates WITHOUT
// expanding. jsdom does not lay out, so these read the INLINE style the component sets directly
// (never `getComputedStyle` off a stylesheet, which jsdom leaves empty), which is exactly the value
// under test.
describe("PreviewCards — the card sizes to a third and expands in place", () => {
  const cardFor = (agentId: string) =>
    screen
      .queryAllByTestId(PREVIEW_CARD_TESTID)
      .find((el) => el.getAttribute("data-agent-id") === agentId) as HTMLElement | undefined;
  const openBtnFor = (agentId: string) =>
    screen
      .queryAllByTestId(PREVIEW_CARD_OPEN_TESTID)
      .find((el) => el.closest(`[data-agent-id="${agentId}"]`) !== null) as HTMLElement | undefined;

  it("defaults to ~1/3 the chat column width and is not expanded", () => {
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");

    const card = cardFor(KRAKEN)!;
    // THE FRACTION, read off the inline style the component set — a value below 100% that a
    // full-width default would never carry. `alignSelf` is what makes the fraction real in a flex
    // column; both are asserted so a future edit cannot keep the width while letting the card
    // stretch (or vice versa).
    expect(card.style.width).toBe(PREVIEW_CARD_COLLAPSED_WIDTH);
    expect(PREVIEW_CARD_COLLAPSED_WIDTH).not.toBe(PREVIEW_CARD_EXPANDED_WIDTH);
    expect(card.style.alignSelf).toBe("flex-start");
    // Collapsed carries no expanded marker, so the presence of the attribute is itself the signal.
    expect(card.getAttribute("data-expanded")).toBeNull();
  });

  it("a single click expands it to the full column width, a second click collapses it", () => {
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    const card = cardFor(KRAKEN)!;
    expect(card.style.width).toBe(PREVIEW_CARD_COLLAPSED_WIDTH);

    fireEvent.click(card);
    expect(cardFor(KRAKEN)!.style.width).toBe(PREVIEW_CARD_EXPANDED_WIDTH);
    expect(cardFor(KRAKEN)!.getAttribute("data-expanded")).toBe("true");

    // TOGGLES BACK — the click is a toggle, not a one-way switch, so the reader can put the card
    // away again. Asserting only the expand would pass for a switch that never collapses.
    fireEvent.click(cardFor(KRAKEN)!);
    expect(cardFor(KRAKEN)!.style.width).toBe(PREVIEW_CARD_COLLAPSED_WIDTH);
    expect(cardFor(KRAKEN)!.getAttribute("data-expanded")).toBeNull();
  });

  it("a single click expands but never opens the browser", () => {
    // THE PAIR THAT STOPS A REGRESSION TO THE OLD DEFAULT. Before this bead a single click opened
    // the url; the whole change is that it must NOT. So the expand and the absence of a navigation
    // are asserted from ONE gesture — an implementation that still opened on single click fails
    // here even though the card also grew.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");

    fireEvent.click(cardFor(KRAKEN)!);

    expect(cardFor(KRAKEN)!.getAttribute("data-expanded")).toBe("true");
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("a single click stamps activity without opening — expanding is 'still wanted' too", () => {
    // GUARDS THE `notePreviewActivity` CALL IN THE TOGGLE (AGENTS.md's `sparkle-lgbwf` shape). A
    // human enlarging a card is exactly the "I am looking at this now" signal `previewIdleGrace`
    // needs, and it is stamped synchronously in the toggle — delete that line and this goes red
    // while every other suite stays green. The clock is advanced so the stamp is distinguishable
    // from the one the fold already wrote.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    const before = usePreviewStore.getState().byAgent[KRAKEN]?.lastActivityAt ?? 0;
    const later = before + 60_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      fireEvent.click(cardFor(KRAKEN)!);
    } finally {
      spy.mockRestore();
    }
    expect(usePreviewStore.getState().byAgent[KRAKEN]?.lastActivityAt).toBe(later);
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("the 'Open in browser' button opens the url and does NOT expand the card", async () => {
    // THE DISCOVERABLE, KEYBOARD-REACHABLE ESCAPE HATCH. Two live cards, so a button wired to "the
    // first card" rather than to its own agent fails here instead of passing by coincidence. The
    // button runs the same click-time ownership read as the double-click, so it is AWAITED.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173", 5173);
    fire(OTTER, "ready", "http://localhost:4321", 4321);

    fireEvent.click(openBtnFor(OTTER)!);

    await waitFor(() => expect(openUrlMock).toHaveBeenCalledTimes(1));
    expect(openUrlMock).toHaveBeenCalledWith("http://localhost:4321");
    // …and the fence held: the button opened without also toggling the card's size. Without
    // `stopPropagation` on the button, this click would ALSO expand the card — the exact two-effects
    // -from-one-gesture surprise the fence exists to prevent.
    expect(cardFor(OTTER)!.getAttribute("data-expanded")).toBeNull();
    expect(cardFor(OTTER)!.style.width).toBe(PREVIEW_CARD_COLLAPSED_WIDTH);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// A SHIPPED DEPLOY URL REACHES THE HUMAN AS A CLICKABLE CARD — bead ``, increment 2
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// This is the deliverable, asserted at the surface it has to reach. Increment 1 built the resolver;
// nothing in the app read it back, because this component's projection refused every non-loopback
// url outright. The rows below assert the SIDE EFFECT — a card with the proven url in the DOM, and
// a real `openUrl` call carrying that url — rather than that the store has an entry in it.
//
// EVERY ABSENCE IS MOUNTED BESIDE ITS PRESENT TWIN, exactly as this file's header requires: a
// refused url is asserted with an accepted one on screen, so "renders nothing" cannot be satisfied
// by a component that renders nothing at all.
describe("a proven public deploy url becomes a shipped card", () => {
  const PROVEN_URL = "https://sparkle-gxh98nicm-drodio1s-projects.vercel.app";
  const BRANCH_ALIAS_URL =
    "https://-feature-activity-narration-drodio1s-projects.vercel.app";

  /** Drive the REAL writer, the one `preview shipped` calls. */
  function ship(agentId: string, over: Record<string, unknown> = {}) {
    act(() => {
      recordShippedDeploy(
        agentId,
        { url: PROVEN_URL, provenance: SHIPPED_DEPLOY_PROVENANCE, prNumber: 3067, ...over },
        6_000,
      );
    });
  }

  function originsOnScreen(): [string, string][] {
    return screen
      .queryAllByTestId(PREVIEW_CARD_TESTID)
      .map((el) => [
        el.getAttribute("data-preview-origin") ?? "",
        el.getAttribute("data-preview-url") ?? "",
      ]);
  }

  it("renders the proven url as a card, named and clickable", () => {
    mount();
    expect(cardsOnScreen()).toEqual([]);

    ship(KRAKEN);
    expect(originsOnScreen()).toEqual([["shipped", PROVEN_URL]]);
    // Its own lead, not the localhost one — see the copy ratchet below for why the two must differ.
    expect(screen.getByText(PREVIEW_SHIPPED_CARD_LEAD)).toBeTruthy();
    expect(screen.queryByText(PREVIEW_CARD_LEAD)).toBeNull();
    // The founder's shape names the agent, on this card as on the other one.
    expect(pillFor(KRAKEN).textContent).toContain("Kraken Auth");
    // And the pull request it was proven from.
    expect(screen.getByTestId(PREVIEW_CARD_PR_TESTID).textContent).toBe("PR #3067");
  });

  it("OPENS the proven url in a real browser when the reader clicks Open", () => {
    // THE WHOLE POINT OF THE BEAD, as a side effect: `openUrl` — the plugin that leaves the app —
    // called with the deploy url. Not "the card rendered"; the reader's click has to land somewhere.
    mount();
    ship(KRAKEN);
    fireEvent.click(screen.getByTestId(PREVIEW_CARD_OPEN_TESTID));
    expect(openUrlMock).toHaveBeenCalledWith(PROVEN_URL);
  });

  it("does NOT ask the preview supervisor about a shipped url", () => {
    // A shipped url has no dev server, so `preview_status` would answer `null` and the click would
    // be refused as `gone` — every time, for every shipped card. Pinned as an absence of the call,
    // because a version that routed both cards through one path would still LOOK right until the
    // bridge was consulted.
    mount();
    ship(KRAKEN);
    invokeMock.mockClear();
    fireEvent.click(screen.getByTestId(PREVIEW_CARD_OPEN_TESTID));
    expect(invokeMock.mock.calls.some(([cmd]) => cmd === "preview_status")).toBe(false);
    expect(openUrlMock).toHaveBeenCalledWith(PROVEN_URL);
  });

  it("refuses the click, with SHIPPED wording, once the entry is retired underneath the card", () => {
    // The click-time gate, re-asked. The card is still on screen for the instant of the click, and
    // the refusal must not borrow the loopback card's sentences — those are all about ports.
    mount();
    ship(KRAKEN);
    const card = screen.getByTestId(PREVIEW_CARD_TESTID);
    act(() => {
      usePreviewStore.setState({ shippedByAgent: {} });
    });
    // The projection retires the card, so drive the handler on the element we already hold — the
    // click that races a retirement is exactly the case the gate exists for.
    fireEvent.click(card.querySelector(`[data-testid="${PREVIEW_CARD_OPEN_TESTID}"]`)!);
    expect(openUrlMock).not.toHaveBeenCalled();
  });

  it("follows a newer deploy only because the CARD followed it first — never as a silent redirect", () => {
    // A re-record for the same agent is a NEW deployment, and the card is a projection of the store,
    // so by the time anything can be clicked the card is already showing the new url. That is the
    // property worth pinning: the reader never clicks url A and gets url B. It is also WHY the
    // refusal copy below is a race-only surface rather than an everyday one.
    mount();
    ship(KRAKEN);
    const newer = "https://sparkle-newer-drodio1s-projects.vercel.app";
    ship(KRAKEN, { url: newer });
    expect(originsOnScreen()).toEqual([["shipped", newer]]);
    fireEvent.click(screen.getByTestId(PREVIEW_CARD_OPEN_TESTID));
    expect(openUrlMock).toHaveBeenCalledWith(newer);
    expect(openUrlMock).not.toHaveBeenCalledWith(PROVEN_URL);
  });

  it("keeps the shipped refusal wording free of the loopback card's ports", () => {
    // ══ WHY THIS IS A COPY ASSERTION AND NOT A RENDER ONE ══════════════════════════════════════
    // Both the card projection and the click gate read the SAME store, so every refusal state also
    // retires the card that would have shown the sentence — the wording is reachable only in the
    // window between a render and the click that lands on it. The refusal BEHAVIOUR is what the row
    // above pins (no `openUrl`, asserted); this pins the thing that would actually be wrong if
    // somebody folded the two tables together: `PREVIEW_OPEN_REFUSAL_COPY` talks about ports and
    // dev servers throughout, and a refusal message is an instruction the reader acts on — sending
    // somebody to look at a port their published link does not have (AGENTS.md, `sparkle-8bvh`).
    for (const [reason, sentence] of Object.entries(PREVIEW_SHIPPED_REFUSAL_COPY)) {
      expect(sentence, `the shipped '${reason}' refusal must not talk about ports`).not.toMatch(
        /\bport\b|\bdev server\b|\blocal\b/i,
      );
      expect(sentence, `the shipped '${reason}' refusal must say the link did not open`).toMatch(
        /didn't open/i,
      );
    }
    // TOTAL over the union — a refusal added in `services/shippedDeploy` without wording is a
    // compile error, and this asserts the three that exist today are all present rather than the
    // table having quietly lost one.
    expect(Object.keys(PREVIEW_SHIPPED_REFUSAL_COPY).sort()).toEqual(["gone", "moved", "unsafe"]);
  });

  it("does NOT render an unproven url — with a proven card mounted beside it", () => {
    // The branch alias: a public https url, on the same provider host, for a deployment the provider
    // never built. BOTH agents claim a url; only the proven one is on screen.
    mount();
    ship(KRAKEN);
    ship(OTTER, { url: BRANCH_ALIAS_URL, provenance: "vercel-bot-comment" });
    expect(originsOnScreen()).toEqual([["shipped", PROVEN_URL]]);
    expect(cardsOnScreen().some(([id]) => id === OTTER)).toBe(false);
  });

  it("takes NO screenshot for a shipped card, while capturing one for a local card beside it", () => {
    // `preview_screenshot` resolves the agent's own LOOPBACK port. Driven at a shipped card it can
    // only refuse — or, worse, succeed against a dev server that happens to be running and paint a
    // picture of a different page under a link that goes somewhere else. Mounted in a pair so the
    // absence is a verdict about the shipped card rather than a broken capture path.
    invokeMock.mockImplementation((cmd: string, args?: { agentId?: string }) => {
      if (cmd === "preview_screenshot") {
        return Promise.resolve({ path: `/tmp/${args?.agentId}.png`, width: 1280, height: 800, bytes: 4 });
      }
      if (cmd === "load_attachment") {
        return Promise.resolve({ path: "/tmp/x.png", name: "x.png", data_url: "data:image/png;base64,AAAA" });
      }
      return defaultInvoke(cmd, args);
    });
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    ship(OTTER);
    return waitFor(() => {
      const shots = screen.queryAllByTestId(PREVIEW_CARD_SHOT_TESTID);
      expect(shots).toHaveLength(1);
      const owner = shots[0]!.closest(`[data-testid="${PREVIEW_CARD_TESTID}"]`);
      expect(owner?.getAttribute("data-agent-id")).toBe(KRAKEN);
    }).then(() => {
      expect(invokeMock.mock.calls.filter(([c]) => c === "preview_screenshot").length).toBe(1);
    });
  });

  it("gives one agent BOTH cards when it has a dev server and a shipped deploy", () => {
    // Two true facts about one agent, told apart by their origin. This also pins that the two cards
    // do not collide on a React key — a duplicate key silently drops one and reuses the survivor's
    // state, which would show up as the wrong url under the wrong lead.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    ship(KRAKEN);
    const on = originsOnScreen();
    expect(on).toHaveLength(2);
    expect(on.map(([o]) => o).sort()).toEqual(["local", "shipped"]);
    expect(on.find(([o]) => o === "shipped")?.[1]).toBe(PROVEN_URL);
    expect(on.find(([o]) => o === "local")?.[1]).toBe("http://127.0.0.1:5173");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE COPY RATCHET — a localhost preview and a shipped url make OPPOSITE promises
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// User-facing copy is code (AGENTS.md). The two cards look identical and mean opposite things, so
// each one's scope sentence is pinned in BOTH directions. A negative-only ratchet is green over copy
// trimmed to say nothing at all — which leaves the reader with exactly the inference that was wrong
// — and a positive-only one is green over copy that ALSO tells the lie. Neither half catches both,
// so each is mutation-provable on its own: restoring the false claim reds the negative, deleting the
// true statement reds the positive.
//
// THE LOOKBEHINDS LIVE HERE AND NOWHERE ELSE. A lookbehind is a PARSE error in the safari14 WebView
// this app pins, so the idiom must never leak into the shipped module — which is also why the honest
// sentence denies its counterpart in so many words rather than the regex being loosened.
describe("the two cards' scope copy cannot drift into each other's claim", () => {
  const PROVEN_URL = "https://sparkle-gxh98nicm-drodio1s-projects.vercel.app";

  it("the LOCAL note states its limit, and never claims the link is shareable", () => {
    expect(
      PREVIEW_LOCAL_SCOPE_NOTE,
      "POSITIVE: a local card must SAY the address opens for nobody else. Deleting the limit leaves " +
        "copy that is merely silent, which reads as 'this is a link' — the inference that is wrong.",
    ).toMatch(/will not open for anyone else/i);
    expect(
      PREVIEW_LOCAL_SCOPE_NOTE,
      "NEGATIVE: a local card must never make the shipped card's claim. 'Anyone … can open' about a " +
        "loopback url tells the reader to forward an address that answers on this machine alone.",
    ).not.toMatch(/(?<!will not )(?<!cannot )\banyone\b[^.]*\bopen\b/i);
    expect(PREVIEW_LOCAL_SCOPE_NOTE).not.toMatch(/live on the web/i);
  });

  it("the SHIPPED note states who can open it, and never calls itself a local preview", () => {
    expect(
      PREVIEW_SHIPPED_SCOPE_NOTE,
      "POSITIVE: a shipped card must SAY the link opens for other people. Without it the reader has " +
        "no reason to send it on, which is the whole point of the card.",
    ).toMatch(/anyone[^.]*can open it/i);
    expect(
      PREVIEW_SHIPPED_SCOPE_NOTE,
      "NEGATIVE: a shipped card must not describe itself as local. The lookbehind is what lets the " +
        "honest denial ('It is not a local preview') stand while the bare claim is refused.",
    ).not.toMatch(/(?<!not )(?<!isn't )\ba local preview\b/i);
    expect(PREVIEW_SHIPPED_SCOPE_NOTE).not.toMatch(/this machine only/i);
  });

  it("puts the right sentence on the right card, on screen", () => {
    // The constants above are only worth ratcheting if each reaches the card it describes. Both
    // mounted at once, so a component that painted one sentence everywhere would red here.
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    act(() => {
      recordShippedDeploy(
        OTTER,
        { url: PROVEN_URL, provenance: SHIPPED_DEPLOY_PROVENANCE },
        6_000,
      );
    });
    const notes = screen.getAllByTestId(PREVIEW_CARD_SCOPE_TESTID).map((el) => [
      el.closest(`[data-testid="${PREVIEW_CARD_TESTID}"]`)?.getAttribute("data-preview-origin"),
      el.textContent,
    ]);
    expect(notes).toContainEqual(["local", PREVIEW_LOCAL_SCOPE_NOTE]);
    expect(notes).toContainEqual(["shipped", PREVIEW_SHIPPED_SCOPE_NOTE]);
  });
});

describe("a shipped card never advertises a loopback port", () => {
  // FOUND BY SELF-REVIEW, not by a failure. `data-preview-port` is read from `byAgent`, so an agent
  // that finished and left its dev server up — the ordinary state of an agent with a shipped
  // deploy — would publish its LOCAL port on the card whose url is PUBLIC. Both cards are mounted
  // here, so this is a verdict about the shipped one rather than an empty tree: the local card must
  // still carry the port (that attribute is what proves a card belongs to the right agent), and the
  // shipped card must not.
  it("carries the port on the local card and omits it on the shipped one", () => {
    mount();
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    act(() => {
      recordShippedDeploy(
        KRAKEN,
        {
          url: "https://sparkle-gxh98nicm-drodio1s-projects.vercel.app",
          provenance: SHIPPED_DEPLOY_PROVENANCE,
        },
        6_000,
      );
    });
    const byOrigin = new Map(
      screen
        .queryAllByTestId(PREVIEW_CARD_TESTID)
        .map((el) => [el.getAttribute("data-preview-origin"), el.getAttribute("data-preview-port")]),
    );
    expect(byOrigin.get("local")).toBe("5173");
    expect(byOrigin.get("shipped")).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE THREAD SURFACE — the PRIMARY one, and where a shipped card actually lives
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// Every row above mounts `<PreviewCards />`, which is the PINNED STRIP — and that strip survives for
// exactly one state (a mounted build agent, where no concierge transcript is on screen). The
// surface a reader normally sees is `PreviewThreadArtifacts`, an anchored item in the transcript.
// Testing only the strip would leave the primary surface for this whole increment uncovered, which
// is the `sparkle-foqoe` shape one level up: asserting against a component that is not the one in
// the tree.
//
// It is a RENDER PROP, so it can be driven directly — no `ConciergeColumn` needed. That is the point
// of its shape (see its docstring), and it means these rows assert the ARTIFACT LIST it produces
// rather than a DOM layout owned by another component.
describe("a shipped card is a thread artifact, with an anchor of its own", () => {
  const PROVEN_URL = "https://sparkle-gxh98nicm-drodio1s-projects.vercel.app";

  /** Two anchorable messages, oldest first, each stamped so `anchorableIdAt` can order against them. */
  const messages = () =>
    [
      { id: "m1", kind: "user", text: "one", arrivedAt: 1_000 },
      { id: "m2", kind: "user", text: "two", arrivedAt: 5_000 },
    ] as never;

  /** Render the wrapper and capture the artifact list it hands its child. */
  function artifacts(): { id: string; afterMessageId: string | null }[] {
    let captured: { id: string; afterMessageId: string | null }[] = [];
    render(
      <AgentPillProvider value={{ agents: roster(), onOpenAgent: vi.fn(() => "revealed" as RevealOutcome) }}>
        <PreviewThreadArtifacts messages={messages()}>
          {(list) => {
            captured = list.map((a) => ({ id: a.id, afterMessageId: a.afterMessageId }));
            return null;
          }}
        </PreviewThreadArtifacts>
      </AgentPillProvider>,
    );
    return captured;
  }

  it("produces a shipped artifact whose id names the origin", () => {
    act(() => {
      recordShippedDeploy(KRAKEN, { url: PROVEN_URL, provenance: SHIPPED_DEPLOY_PROVENANCE }, 6_000);
    });
    expect(artifacts().map((a) => a.id)).toEqual([`preview-card:shipped:${KRAKEN}`]);
  });

  it("gives ONE agent's two cards DISTINCT artifact ids — the collision the origin key prevents", () => {
    // Before the origin was part of the id, both cards were `preview-card:<agentId>`. Two artifacts
    // sharing an id is a collision the thread has no way to report — it silently drops one. This is
    // the regression half, and it is why the id is keyed on (origin, agentId).
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    act(() => {
      recordShippedDeploy(KRAKEN, { url: PROVEN_URL, provenance: SHIPPED_DEPLOY_PROVENANCE }, 6_000);
    });
    const ids = artifacts().map((a) => a.id).sort();
    expect(ids).toEqual([`preview-card:local:${KRAKEN}`, `preview-card:shipped:${KRAKEN}`]);
    expect(new Set(ids).size).toBe(2);
  });

  it("anchors the two cards INDEPENDENTLY, at the moment each actually arrived", () => {
    // THE REASON THE ANCHOR MAP HAD TO BE RE-KEYED. It was keyed on the bare agent id, which was
    // total while the two projections partitioned the agent space. A shipped card breaks that: the
    // two arrive at different moments and belong at different points in the conversation, so a
    // shared key would glue the second to wherever the first landed.
    //
    // The local preview surfaces AFTER both messages (so it anchors to the newest, m2); the shipped
    // deploy is recorded BETWEEN them (so it anchors to m1). Different answers from one render is
    // exactly what a shared key could not produce.
    fire(KRAKEN, "ready", "http://127.0.0.1:5173");
    act(() => {
      // `surfacedAt` for the local card is stamped by the store at Date.now(), which is later than
      // both fixture stamps — so it anchors to the newest anchorable message.
      recordShippedDeploy(KRAKEN, { url: PROVEN_URL, provenance: SHIPPED_DEPLOY_PROVENANCE }, 3_000);
    });
    const byId = new Map(artifacts().map((a) => [a.id, a.afterMessageId]));
    expect(byId.get(`preview-card:shipped:${KRAKEN}`)).toBe("m1");
    expect(byId.get(`preview-card:local:${KRAKEN}`)).toBe("m2");
  });

  it("drops the shipped artifact when the deploy is retired — retirement stays derived", () => {
    act(() => {
      recordShippedDeploy(KRAKEN, { url: PROVEN_URL, provenance: SHIPPED_DEPLOY_PROVENANCE }, 6_000);
    });
    expect(artifacts()).toHaveLength(1);
    cleanup();
    act(() => {
      usePreviewStore.setState({ shippedByAgent: {} });
    });
    expect(artifacts()).toHaveLength(0);
  });
});
