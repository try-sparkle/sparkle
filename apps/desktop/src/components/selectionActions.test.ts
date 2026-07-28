// apps/desktop/src/components/selectionActions.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// The REAL pty module, stubbed at the Tauri boundary. These actions now go through `submitPrompt`
// and `pasteIntoPty` — the chained, framing-owning primitives (roborev 54387) — so the framing and
// the marker stripping (roborev 2197/2210) are asserted against the shipped code path, chain and
// all, rather than against a hand-written copy in a mock.
const invoke = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

/** Every `pty_write` payload, in order. */
const writes = () =>
  invoke.mock.calls
    .filter((c) => c[0] === "pty_write")
    .map((c) => c[1] as { id: string; data: string });

/** Run `fn` and drain submitPrompt's real paste→CR delay without waiting on the wall clock.
 *
 *  The rejection handler is attached SYNCHRONOUSLY, before the timer drain. `await fn()` after
 *  `await vi.runAllTimersAsync()` looks equivalent and is not: with a mock that rejects on the
 *  first write, the promise settles before anything is listening, and Node reports an unhandled
 *  rejection for the microtasks in between. Vitest fails the whole run on that even when every
 *  assertion passed — which is exactly how it got through locally and failed in CI. */
async function settle(fn: () => Promise<void>): Promise<void> {
  vi.useFakeTimers();
  try {
    let failure: unknown;
    let failed = false;
    const p = fn().catch((e: unknown) => {
      failure = e;
      failed = true;
    });
    await vi.runAllTimersAsync();
    await p;
    if (failed) throw failure;
  } finally {
    vi.useRealTimers();
  }
}

const openUrlMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (...a: unknown[]) => openUrlMock(...a) }));

vi.mock("../services/projectFs", () => ({
  appendNote: vi.fn().mockResolvedValue(undefined),
  createTask: vi.fn().mockResolvedValue("tt-1"),
}));

import {
  searchUrl,
  truncateTitle,
  fixInAgent,
  sendToAgent,
  runAsCommand,
} from "./selectionActions";
import { useProjectStore } from "../stores/projectStore";
import { useRuntimeStore } from "../stores/runtimeStore";

beforeEach(() => {
  invoke.mockClear();
  invoke.mockResolvedValue(undefined);
  useProjectStore.setState({ projects: [], selectedProjectId: null });
  useRuntimeStore.setState({ status: {}, openAgentIds: [], branchStatus: {} });
});

describe("pure helpers", () => {
  it("searchUrl encodes the query for Google", () => {
    expect(searchUrl("a b&c")).toBe("https://www.google.com/search?q=a%20b%26c");
  });

  it("truncateTitle takes the first line and clamps length", () => {
    expect(truncateTitle("first line\nsecond")).toBe("first line");
    expect(truncateTitle("x".repeat(100), 10)).toBe("x".repeat(9) + "…");
  });
});

describe("PTY actions", () => {
  it("fixInAgent brackets the text, frames it, and submits with a carriage return", async () => {
    await settle(() => fixInAgent("agent-1", "boom"));
    expect(writes()).toEqual([
      { id: "agent-1", data: "\x1b[200~I hit this error, please fix it:\n\nboom\x1b[201~" },
      { id: "agent-1", data: "\r" },
    ]);
  });

  it("sendToAgent brackets the text but does NOT submit", async () => {
    await sendToAgent("agent-1", "ls -la");
    expect(writes()).toEqual([{ id: "agent-1", data: "\x1b[200~ls -la\x1b[201~" }]);
  });

  // roborev 2197 — paste-injection hardening
  it("fixInAgent strips embedded PASTE_END markers so they cannot escape bracketed-paste mode early", async () => {
    // Attacker embeds \x1b[201~ in terminal output; user selects and clicks "Fix in Agent".
    // Both PASTE_START and PASTE_END markers are stripped from the untrusted text:
    // "error\x1b[201~rm -rf /\x1b[200~" → stripped → "errorrm -rf /"
    await settle(() => fixInAgent("agent-1", "error\x1b[201~rm -rf /\x1b[200~"));
    const payload = writes()[0]!.data;
    expect(payload).toBe("\x1b[200~I hit this error, please fix it:\n\nerrorrm -rf /\x1b[201~");
    expect(writes()[1]).toEqual({ id: "agent-1", data: "\r" });
    // Exactly one PASTE_END, and it is the trailing wrapper.
    expect(payload.split("\x1b[201~").length - 1).toBe(1);
  });

  it("sendToAgent strips both PASTE_START and PASTE_END markers from untrusted text", async () => {
    await sendToAgent("agent-1", "\x1b[200~injected\x1b[201~evil\x1b[200~more");
    expect(writes()).toEqual([{ id: "agent-1", data: "\x1b[200~injectedevilmore\x1b[201~" }]);
  });

  // roborev 2210 — interleaved marker bypass: a single-pass strip can reconstitute a marker
  // e.g. "\x1b[20\x1b[201~1~" → after stripping PASTE_END → "\x1b[201~" (new marker formed).
  // The loop-until-stable fix must handle this.
  it("stripPasteMarkers (via sendToAgent) handles interleaved markers that reconstitute after one pass", async () => {
    await sendToAgent("agent-1", "\x1b[20\x1b[201~1~");
    const payload = writes()[0]!.data;
    // The only PASTE_END in the payload must be the trailing wrapper — none inside.
    expect(payload.split("\x1b[201~").length - 1).toBe(1);
    expect(payload.endsWith("\x1b[201~")).toBe(true);
  });

  // A dead PTY used to be swallowed here, so a click that reached nothing closed the popup as if it
  // had worked. Both actions are strict now, and SelectionPopup's `act()` toasts what they throw —
  // so the message has to be readable, not the raw "no such pty: agent-1" (roborev 54387).
  it("reports a dead terminal in the user's terms instead of silently doing nothing", async () => {
    invoke.mockRejectedValue(new Error("no such pty"));
    await expect(sendToAgent("agent-1", "ls")).rejects.toThrow(
      "That agent's terminal isn't running any more.",
    );
    await expect(settle(() => fixInAgent("agent-1", "boom"))).rejects.toThrow(
      "That agent's terminal isn't running any more.",
    );
  });
});

describe("runAsCommand", () => {
  it("creates a selected, open shell agent carrying the command", () => {
    const pid = useProjectStore.getState().addProject("Demo", "/tmp/demo");
    runAsCommand(pid, "npm run build");
    const agent = useProjectStore.getState().projects[0]!.agents.find((a) => a.kind === "shell")!;
    expect(agent.shellCommand).toBe("npm run build");
    expect(useProjectStore.getState().projects[0]!.selectedAgentId).toBe(agent.id);
    expect(useRuntimeStore.getState().openAgentIds).toContain(agent.id);
  });
});
