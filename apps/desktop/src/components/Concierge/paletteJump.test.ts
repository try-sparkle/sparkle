// jumpToHit — the palette's routing core. Pure over injected deps: every outcome path is
// pinned (in-place select + scroll correlation, cross-window focus, new-window open, and the
// two non-navigating refusals), mirroring HistorySearch's routing exactly.
import { describe, expect, it, vi } from "vitest";
import { jumpToHit, type JumpDeps } from "./paletteJump";
import type { HistoryHit } from "../../services/history";
import type { PromptHistoryEntry } from "../../types";

const hit = (over: Partial<HistoryHit> = {}): HistoryHit => ({
  id: "h1",
  kind: "prompt",
  source: "build",
  projectId: "p1",
  agentId: "a1",
  projectName: "Demo",
  agentName: "Builder",
  snippet: "loving <b>rust</b> lately",
  createdAt: 1_000_000,
  ...over,
});

function deps(over: Partial<JumpDeps> = {}): JumpDeps {
  return {
    currentProjectId: "p1",
    agentExists: () => true,
    selectAgentHere: vi.fn(),
    focusAgentElsewhere: vi.fn(),
    projectHasWindow: () => false,
    promptHistoryFor: () => [],
    requestScroll: vi.fn(),
    openInWindow: vi.fn(),
    ...over,
  };
}

describe("jumpToHit", () => {
  it("refuses a hit whose project is gone (row would be disabled anyway)", () => {
    const d = deps();
    expect(jumpToHit(hit({ projectId: null }), d)).toEqual({ kind: "project-gone" });
    expect(d.selectAgentHere).not.toHaveBeenCalled();
    expect(d.openInWindow).not.toHaveBeenCalled();
  });

  it("reports agent-closed when the agent id is missing or no longer exists", () => {
    expect(jumpToHit(hit({ agentId: null }), deps())).toEqual({ kind: "agent-closed" });
    const d = deps({ agentExists: () => false });
    expect(jumpToHit(hit(), d)).toEqual({ kind: "agent-closed" });
    expect(d.selectAgentHere).not.toHaveBeenCalled();
  });

  it("selects in place for this window's project and scrolls to the correlated prompt", () => {
    const history: PromptHistoryEntry[] = [
      { id: "ph1", text: "build it", at: 1_000_500 },
    ];
    const d = deps({ promptHistoryFor: () => history });
    expect(jumpToHit(hit(), d)).toEqual({ kind: "jumped-here" });
    expect(d.selectAgentHere).toHaveBeenCalledWith("p1", "a1");
    // 500ms apart — well inside the correlation tolerance, so the scroll intent is queued.
    expect(d.requestScroll).toHaveBeenCalledWith("a1", "ph1");
    expect(d.focusAgentElsewhere).not.toHaveBeenCalled();
    expect(d.openInWindow).not.toHaveBeenCalled();
  });

  it("still jumps here when no prompt correlates — it just doesn't scroll", () => {
    const d = deps(); // empty promptHistory → correlation miss
    expect(jumpToHit(hit(), d)).toEqual({ kind: "jumped-here" });
    expect(d.selectAgentHere).toHaveBeenCalledWith("p1", "a1");
    expect(d.requestScroll).not.toHaveBeenCalled();
  });

  it("focuses the owning window for a different project that's already open", () => {
    const d = deps({ projectHasWindow: () => true });
    expect(jumpToHit(hit({ projectId: "other" }), d)).toEqual({ kind: "focused-elsewhere" });
    expect(d.focusAgentElsewhere).toHaveBeenCalledWith("other", "a1");
    expect(d.openInWindow).not.toHaveBeenCalled();
    // Cross-window navigation never queues a scroll (the intent store is per-window).
    expect(d.requestScroll).not.toHaveBeenCalled();
  });

  it("opens a new window deep-linked to the agent when no window owns the project", () => {
    const d = deps({ projectHasWindow: () => false });
    expect(jumpToHit(hit({ projectId: "other" }), d)).toEqual({ kind: "opened-window" });
    expect(d.openInWindow).toHaveBeenCalledWith("other", "new", "a1");
    expect(d.focusAgentElsewhere).not.toHaveBeenCalled();
  });
});
