// @vitest-environment jsdom
//
// THE END-TO-END CLAIM, and the one the founder actually made: a PR number written ANYWHERE in
// concierge text is clickable — not only in the app-written merge receipt.
//
// The concierge's relay of his standing instruction: "a PR must never appear as a bare number — it
// has to be clickable and attached to the work that owns it… Do it once, in the shared slot, so
// every surface inherits it." The unit tests around `prRefs`, `remarkPrRefs` and `PrPill` each prove
// one link in that chain; this file is the only place that proves the CHAIN — that the plugin is
// actually registered, that `urlTransform` does not blank the scheme it synthesizes, and that
// `ExternalLink` dispatches to the pill. Every one of those three is a place where the machinery
// could be complete and the feature still entirely inert.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Markdown } from "./Markdown";
import { __clearRepoSlugCache, __setRepoSlugForTest } from "../services/conciergeTools/repoSlug";
import { useProjectStore } from "../stores/projectStore";

const launch = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../services/sparkleApi", () => ({ launch }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(() => Promise.resolve()) }));

const ROOT = "/Users/x/Projects/sparkle";

beforeEach(() => {
  launch.mockClear();
  __clearRepoSlugCache();
  __setRepoSlugForTest(ROOT, "drodio/sparkle");
  useProjectStore.setState({
    projects: [{ id: "p1", name: "sparkle", rootPath: ROOT, agents: [] }] as never,
    selectedProjectId: "p1",
  });
});
afterEach(cleanup);

describe("a PR number in ordinary concierge prose", () => {
  it("is a chiclet that opens GitHub — the whole point of the bead", () => {
    render(<Markdown text="#2153 is green, want me to merge it?" />);

    const pill = screen.getByTestId("concierge-pr-pill");
    expect(pill.textContent).toBe("#2153");

    fireEvent.click(pill);
    expect(launch).toHaveBeenCalledWith("https://github.com/drodio/sparkle/pull/2153");
  });

  it("works in the shape an agent retro writes", () => {
    render(<Markdown text="blocked behind #2100 for now" />);
    expect(screen.getByTestId("concierge-pr-pill").textContent).toBe("#2100");
  });

  it("carries the APP-WRITTEN qualified reference to the repo the app named", () => {
    // The merge receipt's form. The selected project resolves elsewhere, and must not win.
    __setRepoSlugForTest(ROOT, "someone/else");
    render(<Markdown text="Merged PR [#2164](sparkle-pr:drodio/sparkle#2164)." />);

    fireEvent.click(screen.getByTestId("concierge-pr-pill"));
    expect(launch).toHaveBeenCalledWith("https://github.com/drodio/sparkle/pull/2164");
  });

  it("survives urlTransform — the sanitizer must not blank a scheme we synthesize", () => {
    // Without the `sparkle-pr:` line in `urlTransform`, react-markdown's default sanitizer strips
    // the href the linkifier just wrote and EVERY PR number silently reverts to prose. The whole
    // feature would be inert with all the unit tests still green.
    render(<Markdown text="see #2153" />);
    expect(screen.queryByTestId("concierge-pr-pill")).not.toBeNull();
  });
});

describe("what it must NOT touch", () => {
  it("leaves a number inside a code span as the command it is", () => {
    render(<Markdown text="run `gh pr merge #2153 --merge`" />);
    expect(screen.queryByTestId("concierge-pr-pill")).toBeNull();
    expect(screen.getByText(/gh pr merge #2153/)).toBeTruthy();
  });

  it("leaves ordinary counting prose alone", () => {
    render(<Markdown text="step #3 of the plan, my #1 priority" />);
    expect(screen.queryByTestId("concierge-pr-pill")).toBeNull();
  });

  it("does not nest itself inside a real link", () => {
    render(<Markdown text="[the #2153 work](https://example.com)" />);
    expect(screen.queryByTestId("concierge-pr-pill")).toBeNull();
    expect(screen.getByRole("link")).toBeTruthy();
  });

  it("renders as PROSE when the project has no GitHub remote — never a dead button", () => {
    __setRepoSlugForTest(ROOT, null);
    render(<Markdown text="#2153 is green" />);
    expect(screen.queryByTestId("concierge-pr-pill")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.body.textContent).toContain("#2153");
  });
});

describe("the other pill vocabularies still work beside it", () => {
  // The linkifiers run in sequence over one tree, so a regression here is a plugin that consumed a
  // node another one needed. Bead ids and PR numbers cannot both match one token, and this is what
  // says so at the level a reader sees.
  it("a bead id in the same sentence is untouched by the PR linkifier", () => {
    render(<Markdown text="filed sparkle-17hm1 for #2153" />);
    expect(screen.getByTestId("concierge-pr-pill").textContent).toBe("#2153");
    expect(document.body.textContent).toContain("sparkle-17hm1");
  });
});
