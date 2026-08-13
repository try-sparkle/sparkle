// @vitest-environment jsdom
//
// The RESEARCH PILL — a `sparkle-research:` reference the concierge writes, rendered as a clickable
// link into the task's row (bead `sparkle-jce9`). Rendered THROUGH `<Markdown>` rather than mounted
// directly, the way `AgentPill.test.tsx`'s second describe does: the pill only exists because
// `Markdown`'s `ExternalLink` + `urlTransform` route the scheme to it, so testing the seam is
// testing the feature. jsdom: no layout, so every assertion is on rendered text, roles, a data
// attribute, or a store side effect (`docs/jsdom-test-caveats.md`).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
  revealItemInDir: vi.fn(() => Promise.resolve()),
}));

import { Markdown } from "../Markdown";
import { researchRefHref } from "./researchRefs";
import {
  _resetResearchStoreForTests,
  useResearchStore,
} from "../../services/research/store";
import type { ResearchTask } from "../../services/research/types";

const ID = "rsh_1754700004000_0a1b2c3d4e5f6071";

function task(over: Partial<ResearchTask> = {}): ResearchTask {
  return {
    id: ID,
    question: "how does caching work",
    depth: "quick",
    projectId: "p1",
    projectRoot: "/tmp/demo",
    status: "running",
    createdAt: 1_754_700_004_000,
    startedAt: 1_754_700_004_000,
    finishedAt: null,
    findings: null,
    error: null,
    readAt: null,
    ...over,
  };
}

function seed(t: ResearchTask | null) {
  useResearchStore.setState({
    byId: t === null ? {} : { [t.id]: t },
    hydrated: true,
    openTaskId: null,
  });
}

beforeEach(() => _resetResearchStoreForTests());
afterEach(cleanup);

const pill = () => screen.queryByTestId("concierge-research-pill");

describe("ResearchPill — a sparkle-research: reference becomes a clickable pill", () => {
  it("renders a live task as a button carrying the task id and its question", () => {
    seed(task());
    render(<Markdown text={`I sent that off — [how caching works](${researchRefHref(ID)}).`} />);
    const el = pill();
    expect(el).not.toBeNull();
    expect(el!.getAttribute("data-task-id")).toBe(ID);
    // The LIVE question wins over the written label — a pill reads what the task actually asked.
    expect(el!.textContent).toContain("how does caching work");
    // The status rides on the pill so it reads live, not as a snapshot from when the message landed.
    expect(el!.getAttribute("data-status")).toBe("running");
  });

  it("opens the task on click — the SIDE EFFECT that reveals the row", () => {
    seed(task());
    render(<Markdown text={`see [it](${researchRefHref(ID)})`} />);
    expect(useResearchStore.getState().openTaskId).toBeNull();

    fireEvent.click(pill()!);
    // The whole of the click: the store's openTaskId now names this task, which is what
    // ConciergeAgentsRow reads to expand its group and scroll the row into view.
    expect(useResearchStore.getState().openTaskId).toBe(ID);
  });

  it("repaints its status dot as the task moves — it re-reads live state", () => {
    seed(task({ status: "queued" }));
    const { rerender } = render(<Markdown text={`[q](${researchRefHref(ID)})`} />);
    expect(pill()!.getAttribute("data-status")).toBe("queued");

    // A poll lands the running record; the SAME pill, no re-parse of the text, now reads running.
    seed(task({ status: "running" }));
    rerender(<Markdown text={`[q](${researchRefHref(ID)})`} />);
    expect(pill()!.getAttribute("data-status")).toBe("running");
  });

  it("degrades to plain text when the task is RETIRED (told + terminal)", () => {
    // A retired task's row is gone, so a link into it would be dead — it must read as prose instead.
    seed(task({ status: "done", finishedAt: 1_754_700_099_000, findings: "x", readAt: 1_754_700_200_000 }));
    render(<Markdown text={`earlier I found [how caching works](${researchRefHref(ID)}).`} />);
    expect(pill()).toBeNull();
    // The words the reader saw are still there — the reference flattened to readable text (the live
    // question wins over the written label, as it does in the pill), not vanished.
    expect(screen.getByText(/how does caching work/)).toBeTruthy();
  });

  it("degrades to plain text for a task this window has never seen", () => {
    seed(null);
    render(<Markdown text={`see [the caching answer](${researchRefHref(ID)}).`} />);
    expect(pill()).toBeNull();
    expect(screen.getByText(/the caching answer/)).toBeTruthy();
  });

  it("does NOT turn a dangerous scheme into a pill or a live href", () => {
    // The urlTransform exception is narrow: only sparkle-research: is admitted, and only as a button.
    seed(task());
    render(<Markdown text={`[x](javascript:alert(1))`} />);
    expect(pill()).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});
