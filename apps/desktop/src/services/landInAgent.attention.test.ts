// @vitest-environment jsdom
//
// `landInAgent`'s NEW half: an "auto" hand-off may be declined while the founder's attention is
// held, and a "user" one never may. The split is the whole safety argument for the guard — a veto
// keyed on terminal focus was tried once before over a WIDER surface and had to be reverted because
// it declined things the user had just clicked (services/terminalMidCommand's header). Here the
// default is `"user"`, so a click cannot reach the guard at all, and this file pins that.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { landInAgent } from "./landInAgent";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";
import { useUiStore } from "../stores/uiStore";
import { TERMINAL_SURFACE_ATTR } from "../voice/dictationFocus";

function seed(): { pid: string; a: string; b: string } {
  const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
  const a = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
  const b = useProjectStore.getState().addAgent(pid, { kind: "build" })!;
  return { pid, a, b };
}

const selectionIn = (pid: string) =>
  useProjectStore.getState().projects.find((p) => p.id === pid)?.selectedAgentId;

function focusATerminal(): void {
  const host = document.createElement("div");
  host.setAttribute(TERMINAL_SURFACE_ATTR, "");
  host.innerHTML = `<textarea class="xterm-helper-textarea"></textarea>`;
  document.body.appendChild(host);
  host.querySelector<HTMLTextAreaElement>("textarea")!.focus();
}

beforeEach(() => {
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ branchStatus: {}, workflowStage: {}, openAgentIds: [] });
  useUiStore.setState({ activeSpecial: null, revealAgentId: null });
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("landInAgent — attention intent", () => {
  it("declines an AUTO hand-off while the caret is in a terminal, but still OPENS the agent", () => {
    const { pid, a, b } = seed();
    expect(selectionIn(pid)).toBe(b);
    useUiStore.setState({ activeSpecial: "sparkle" });
    focusATerminal();

    expect(landInAgent(pid, a, { attention: "auto" })).toBe("held");

    // Nothing the founder can see moved…
    expect(selectionIn(pid)).toBe(b);
    expect(useUiStore.getState().revealAgentId).toBeNull();
    expect(useUiStore.getState().activeSpecial).toBe("sparkle");
    // …and the agent is nonetheless in the open set, which is what mounts its pane and launches its
    // PTY. A held hand-off is quiet, never fictional.
    expect(useRuntimeStore.getState().openAgentIds).toContain(a);
  });

  it("A CLICK IS NEVER DECLINED — the default intent ignores the hold entirely", () => {
    // The regression this file exists to prevent. If the guard ever moves from the caller's declared
    // intent to the DOM alone, this is the test that fails.
    const { pid, a, b } = seed();
    expect(selectionIn(pid)).toBe(b);
    focusATerminal();

    expect(landInAgent(pid, a)).toBe("landed");

    expect(selectionIn(pid)).toBe(a);
    expect(useUiStore.getState().revealAgentId).toBe(a);
  });

  it("an explicit `attention: \"user\"` is likewise never declined", () => {
    const { pid, a } = seed();
    focusATerminal();

    expect(landInAgent(pid, a, { attention: "user" })).toBe("landed");
    expect(selectionIn(pid)).toBe(a);
  });

  it("PAIRED: an AUTO hand-off with the caret nowhere lands all four steps", () => {
    const { pid, a, b } = seed();
    expect(selectionIn(pid)).toBe(b);
    useUiStore.setState({ activeSpecial: "sparkle" });

    expect(landInAgent(pid, a, { attention: "auto" })).toBe("landed");

    expect(selectionIn(pid)).toBe(a);
    expect(useRuntimeStore.getState().openAgentIds).toContain(a);
    expect(useUiStore.getState().revealAgentId).toBe(a);
    expect(useUiStore.getState().activeSpecial).toBeNull();
  });

  // ══ THE CALLER-SUPPLIED READING WINS ══════════════════════════════════════════════════════════
  // `buildAgentSpawn` reads the hold ONCE and settles three separate decisions off it (`select:
  // false`, the project switch, this landing). If this seam re-read the live caret instead of using
  // what it was handed, the two could disagree within one spawn — and `addAgent` itself is capable
  // of moving the caret between them.
  it("honours a hold PASSED IN even when the live caret says otherwise", () => {
    const { pid, a, b } = seed();
    expect(selectionIn(pid)).toBe(b);
    // Live DOM: nothing focused. Caller: "I looked a moment ago and he was in a terminal."
    expect(landInAgent(pid, a, { attention: "auto", hold: "terminal" })).toBe("held");
    expect(selectionIn(pid)).toBe(b);
  });

  it("honours an explicit `hold: null` even when the live caret IS in a terminal", () => {
    const { pid, a } = seed();
    focusATerminal();
    // `null` is a real value meaning "I looked and nothing was held" — not the same as omitting it,
    // which means "read it here".
    expect(landInAgent(pid, a, { attention: "auto", hold: null })).toBe("landed");
    expect(selectionIn(pid)).toBe(a);
  });
});
