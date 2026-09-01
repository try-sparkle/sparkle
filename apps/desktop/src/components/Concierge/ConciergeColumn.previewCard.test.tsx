// @vitest-environment jsdom
//
// IS THE PREVIEW CARD ACTUALLY MOUNTED, AND IS IT MOUNTED WHERE THE PILL RESOLVES?
//
// `PreviewCards.test.tsx` renders the strip directly and covers every rule it owns. It cannot cover
// the two facts that only the real column can answer, and both have been live bugs in this file's
// neighbours:
//
//   1. THAT IT IS RENDERED AT ALL. A component nothing mounts is the whole feature, inert, with a
//      green suite. The worked example was the preview PANE: `PreviewSlot.tsx` shipped mounted
//      while several sibling surfaces did not. d48af48e5 deleted that file and it exists nowhere
//      in the repo; the example is kept because it is the reason this test exists, not because
//      you can go and read it.       # guard-ok — tombstone: names the deleted file on purpose
//   2. THAT IT SITS INSIDE THE `AgentPillProvider`. Outside it, the pill resolves nothing and
//      renders the `concierge-agent-pill-closed` dead-end variant — a card that names an agent the
//      reader cannot open, which LOOKS like a working pill. That is the exact failure
//      `AgentPill.deadEnd.test.tsx` exists to forbid, and it is invisible to a test that only
//      checks the card is present.
//
// So the assertion below is the LIVE pill testid, not merely "a card appeared".
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.reject(new Error("no preview is open"))) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));
vi.mock("../LogoWaveform", () => ({ LogoWaveform: () => null }));
vi.mock("../BalanceBadge", () => ({ BalanceBadge: () => null }));

import { ConciergeColumn } from "./ConciergeColumn";
import {
  PREVIEW_CARD_TESTID,
  PREVIEW_NOTICE_TESTID,
  PREVIEW_NOTICE_DETAIL_TESTID,
} from "./PreviewCards";
import { applyPreviewStatus } from "../../services/preview";
import { usePreviewStore } from "../../stores/previewStore";
import { useProjectStore } from "../../stores/projectStore";
import { enableAiEnhancementsForTests } from "../../testing/aiEnhancements";
import type { ConciergeController, ConciergeViewModel } from "./types";
import type { MentionAgent } from "./mentions";

const KRAKEN = "ag-kraken";

const model: ConciergeViewModel = {
  scope: {},
  vitals: { needs_you: 0, questions: 0, running: 0, done: 0 },
  messages: [{ id: "m1", kind: "you", text: "Retry the failing one" }],
};

const controller = (): ConciergeController => ({
  onSend: vi.fn(),
  onAttach: vi.fn(),
  onNudgeClick: vi.fn(),
  onNudgeAction: vi.fn(),
});

const ROSTER: MentionAgent[] = [
  { id: KRAKEN, name: "Kraken Auth", projectId: "p1", projectName: "sparkle", band: "running", canAcceptInput: true },
];

beforeEach(() => {
  enableAiEnhancementsForTests();
  usePreviewStore.setState({ byAgent: {}, capability: {}, openedProjects: {} });
  useProjectStore.setState({
    projects: [{ id: "p1", name: "sparkle", agents: [{ id: KRAKEN, name: "Kraken Auth" }] }],
    selectedProjectId: "p1",
  } as never);
});
afterEach(cleanup);

describe("the concierge column surfaces a live preview", () => {
  it("paints a card with a LIVE agent pill once a preview:state event lands", () => {
    render(
      <ConciergeColumn
        model={model}
        controller={controller()}
        mentionAgents={ROSTER}
        onOpenAgent={vi.fn(() => "revealed" as const)}
      />,
    );
    // Before the event: no card. This is what makes the assertion below about the EVENT rather
    // than about the column rendering a card unconditionally.
    expect(screen.queryByTestId(PREVIEW_CARD_TESTID)).toBeNull();

    act(() => {
      applyPreviewStatus({
        id: "srv-1",
        agentId: KRAKEN,
        projectId: "p1",
        url: "http://127.0.0.1:5173",
        port: 5173,
        state: "ready",
        error: null,
      });
    });

    const card = screen.getByTestId(PREVIEW_CARD_TESTID);
    expect(card.getAttribute("data-preview-url")).toBe("http://127.0.0.1:5173");
    // THE LIVE PILL, not the `-closed` dead end — this is the provider-scope half of the test.
    const pill = screen.getByTestId("concierge-agent-pill");
    expect(pill.getAttribute("data-agent-id")).toBe(KRAKEN);
    expect(screen.queryByTestId("concierge-agent-pill-closed")).toBeNull();
  });
});

// ══ AND THE SAME TWO FACTS FOR A PREVIEW THAT FAILED ════════════════════════════════════════════
// The notice strip is a SECOND component in this file, so it needs its own answer to both questions
// above: is it mounted at all, and is it inside the `AgentPillProvider`? Neither is inherited from
// the card strip passing — they are separate elements in the tree, and the notice strip is the one
// that renders in the case the reader most needs (an agent asked for a preview and the dev server
// refused to boot). A component nothing mounts is the whole feature, inert, with a green suite.
describe("the concierge column surfaces a preview that FAILED", () => {
  it("paints a notice carrying the stderr tail, with a LIVE agent pill", () => {
    const tail =
      "the dev server exited before it started listening. Last output: Error: Cannot find module 'vite'";
    render(
      <ConciergeColumn
        model={model}
        controller={controller()}
        mentionAgents={ROSTER}
        onOpenAgent={vi.fn(() => "revealed" as const)}
      />,
    );
    expect(screen.queryByTestId(PREVIEW_NOTICE_TESTID)).toBeNull();

    act(() => {
      applyPreviewStatus({
        id: "srv-1",
        agentId: KRAKEN,
        projectId: "p1",
        url: null,
        port: null,
        state: "failed",
        error: tail,
      });
    });

    const notice = screen.getByTestId(PREVIEW_NOTICE_TESTID);
    expect(notice.getAttribute("data-preview-status")).toBe("failed");
    // THE STRING ITSELF, in the DOM — not merely that an element exists.
    expect(screen.getByTestId(PREVIEW_NOTICE_DETAIL_TESTID).textContent).toBe(tail);
    // A NOTICE, NOT A CARD: nothing here invites a click that would teach the reader it is dead.
    expect(screen.queryByTestId(PREVIEW_CARD_TESTID)).toBeNull();
    // THE LIVE PILL, not the `-closed` dead end — the provider-scope half, for this strip.
    expect(screen.getByTestId("concierge-agent-pill").getAttribute("data-agent-id")).toBe(KRAKEN);
    expect(screen.queryByTestId("concierge-agent-pill-closed")).toBeNull();
  });
});
