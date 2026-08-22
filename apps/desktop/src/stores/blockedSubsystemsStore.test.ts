import { afterEach, describe, expect, it, vi } from "vitest";
import {
  selectAiEnhancedBlocked,
  selectAnyBlocked,
  useBlockedSubsystemsStore,
} from "./blockedSubsystemsStore";
import { AI_ENHANCED_KEY } from "../engine/blockedSubsystems";

afterEach(() => useBlockedSubsystemsStore.setState({ blocked: [] }));

describe("blockedSubsystemsStore change-guard", () => {
  it("does NOT notify subscribers when set with an equal list (steady-state poll must not churn re-renders)", () => {
    const list = [{ key: "ai-enhanced", label: "AI Enhancement Features" }];
    useBlockedSubsystemsStore.setState({ blocked: list });

    const sub = vi.fn();
    const unsub = useBlockedSubsystemsStore.subscribe(sub);
    // A fresh array with the SAME keys/labels — the shape a poll produces every tick.
    useBlockedSubsystemsStore.getState().setBlocked([
      { key: "ai-enhanced", label: "AI Enhancement Features" },
    ]);
    expect(sub).not.toHaveBeenCalled();
    // And the stored reference is untouched, so React bails out of re-rendering.
    expect(useBlockedSubsystemsStore.getState().blocked).toBe(list);
    unsub();
  });

  it("DOES notify when the list actually changes", () => {
    useBlockedSubsystemsStore.setState({ blocked: [] });
    const sub = vi.fn();
    const unsub = useBlockedSubsystemsStore.subscribe(sub);
    useBlockedSubsystemsStore.getState().setBlocked([
      { key: "ai-enhanced", label: "AI Enhancement Features" },
    ]);
    expect(sub).toHaveBeenCalledTimes(1);
    unsub();
  });
});

describe("selectors", () => {
  it("selectAnyBlocked reflects whether anything is blocked", () => {
    expect(selectAnyBlocked(useBlockedSubsystemsStore.getState())).toBe(false);
    useBlockedSubsystemsStore.setState({ blocked: [{ key: "agent:a1", label: "Some Agent" }] });
    expect(selectAnyBlocked(useBlockedSubsystemsStore.getState())).toBe(true);
  });

  it("selectAiEnhancedBlocked is true ONLY when AI-Enhanced is in the list, not for an unrelated block", () => {
    useBlockedSubsystemsStore.setState({ blocked: [{ key: "agent:a1", label: "Some Agent" }] });
    expect(selectAiEnhancedBlocked(useBlockedSubsystemsStore.getState())).toBe(false);
    useBlockedSubsystemsStore.setState({
      blocked: [{ key: AI_ENHANCED_KEY, label: "AI Enhancement Features" }],
    });
    expect(selectAiEnhancedBlocked(useBlockedSubsystemsStore.getState())).toBe(true);
  });
});
