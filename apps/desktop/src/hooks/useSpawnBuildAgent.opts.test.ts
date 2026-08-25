// The hook's callback now takes `SpawnBuildAgentOpts` (bead sparkle-f2tzxg — so a UI surface can
// settle the EPIC at spawn rather than in a follow-up write). That opened one hazard worth pinning:
// the same callback is handed straight to a DOM `onClick`, whose first argument is an event.
import { describe, it, expect, beforeEach, vi } from "vitest";

const spawnSpy = vi.fn(() => "agent-1");
vi.mock("../services/buildAgentSpawn", () => ({
  spawnBuildAgentInProject: (...a: unknown[]) => spawnSpy(...(a as [])),
}));

import { useSpawnBuildAgent } from "./useSpawnBuildAgent";
import type { Project } from "../types";

const project = { id: "p1", name: "Demo", rootPath: "/tmp/demo", agents: [] } as unknown as Project;

beforeEach(() => spawnSpy.mockClear());

describe("useSpawnBuildAgent", () => {
  it("forwards the caller's options to the shared spawn", () => {
    useSpawnBuildAgent(project)({ epicId: "sparkle-epic1" });

    expect(spawnSpy).toHaveBeenCalledWith(project, { epicId: "sparkle-epic1" });
  });

  it("passes nothing when called with no options — today's three gestures are unchanged", () => {
    useSpawnBuildAgent(project)();

    expect(spawnSpy).toHaveBeenCalledWith(project, undefined);
  });

  it("DROPS a click event rather than reading spawn options off it", () => {
    // `Workspace` passes this callback to `NewAgentButtons.onLocalClick` → a real `<button>`, and
    // that prop is typed `() => void`, so TypeScript never sees React handing it a SyntheticEvent.
    // Without the guard the event IS the options object — harmless only until a field name
    // collides. React 17+ events are plain objects, so `instanceof Event` would not have caught it;
    // this fixture is that shape deliberately.
    const syntheticClick = {
      preventDefault: () => {},
      stopPropagation: () => {},
      nativeEvent: {},
      type: "click",
    };

    useSpawnBuildAgent(project)(syntheticClick as never);

    expect(spawnSpy).toHaveBeenCalledWith(project, undefined);
  });

  it("returns null with no project open, without spawning", () => {
    expect(useSpawnBuildAgent(null)({ epicId: "sparkle-epic1" })).toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});
