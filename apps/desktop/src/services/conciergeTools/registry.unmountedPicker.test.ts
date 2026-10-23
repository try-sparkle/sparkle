// A PICKER ON AN AGENT WHOSE PANE LIVES IN ANOTHER WINDOW IS READABLE AND ANSWERABLE
// (bead sparkle-eou3y0.3, fix #1).
//
// THE FIELD SYMPTOM: `read_picker_options` returned `blind: "pane-not-mounted"` for every agent
// whose pane was hosted by a different webview, and `select_picker_option` had nothing to match a
// fingerprint against — four queued permission prompts in one sweep, all four unreachable. The PTY
// host is app-global, so the WRITE could always reach the agent; only the SCREEN was window-local.
//
// THESE ROWS RUN THROUGH `dispatchConciergeTool`, with the REAL scrollback/viewport registries left
// EMPTY in this realm, and a second "window" standing up `startScreenRelayResponder` on a shared
// in-memory event bus. So the positive rows go red without the registry wiring (the handler would
// read an empty registry and report blind) AND without the relay (nobody would answer). The
// negative rows pin the honest refusal when no window can see the agent, and that a relayed
// snapshot never outlives the op that fetched it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── one event bus shared by "both windows" ─────────────────────────────────────────────────────
type Cb = (e: { payload: unknown }) => void;
const listeners = new Map<string, Set<Cb>>();
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, cb: Cb) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(cb);
    return () => listeners.get(event)?.delete(cb);
  },
  emit: async (event: string, payload: unknown) => {
    // Delivered asynchronously, as a real cross-webview event is.
    queueMicrotask(() => {
      for (const cb of [...(listeners.get(event) ?? [])]) cb({ payload });
    });
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("../../pty", async (orig) => ({
  ...(await orig<typeof import("../../pty")>()),
  resizePty: vi.fn(async () => {}),
  writePtyChainedStrict: vi.fn(async () => {}),
  submitPrompt: vi.fn(async () => {}),
}));
vi.mock("../trialMeter", () => ({ trialSendAllowed: () => true, recordTrialSend: vi.fn() }));

import { submitPrompt, writePtyChainedStrict } from "../../pty";
import { dispatchConciergeTool, type ConciergeToolReply } from "./registry";
import { startScreenRelayResponder, type ScreenSnapshot } from "../screenRelay";
import { getAgentScrollback } from "../terminalScrollback";
import { getAgentViewport } from "../terminalViewport";
import { useProjectStore } from "../../stores/projectStore";
import { BASH_PERMISSION_PROMPT } from "../suggestions/planPrompt.fixture";

const AGENT = "ag-unmounted";

/** The read-only reconnaissance prompt the bead measured, on the shape Claude Code renders. */
const PROMPT = BASH_PERMISSION_PROMPT.replace("rm -rf build/", "git fetch origin");
const OTHER_PROMPT = BASH_PERMISSION_PROMPT.replace("rm -rf build/", "gh pr view 70");

/** What the window that HOSTS the pane can see. Mutable so a row can move the agent on. */
let hostScreen: ScreenSnapshot | null = null;
let stopHost: (() => void) | null = null;

function hostWindowShows(text: string | null): void {
  hostScreen = text === null ? null : { scrollback: text, viewport: { text, alternateBuffer: false } };
}

function data<T>(r: ConciergeToolReply): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r.data as T;
}

interface Read {
  present: boolean;
  options: { index: number; label: string }[];
  fingerprint: string;
  blind?: string;
}

const read = async () =>
  dispatchConciergeTool({
    domain: "terminal",
    op: "read_picker_options",
    args: { agentId: AGENT },
    toolCallId: "tc-read",
  });

const select = async (index: number, expectFingerprint: string) =>
  dispatchConciergeTool({
    domain: "terminal",
    op: "select_picker_option",
    args: { agentId: AGENT, index, expectFingerprint },
    toolCallId: "tc-select",
  });

beforeEach(() => {
  vi.clearAllMocks();
  listeners.clear();
  useProjectStore.setState({
    projects: [
      {
        id: "p1",
        name: "sparkle",
        path: "/tmp/p1",
        agents: [{ id: AGENT, name: "Recon", runtime: "local" } as never],
      } as never,
    ],
  } as never);
  hostWindowShows(PROMPT);
  // The OTHER window: it answers from what its own pane shows, which this realm cannot see.
  stopHost = startScreenRelayResponder({ see: (id) => (id === AGENT ? hostScreen : null) });
});

afterEach(() => {
  stopHost?.();
  stopHost = null;
});

describe("an agent whose pane is mounted in ANOTHER window", () => {
  it("this window really cannot see it locally — the precondition every row below depends on", () => {
    expect(getAgentScrollback(AGENT)).toBeNull();
    expect(getAgentViewport(AGENT)).toBeNull();
  });

  it("read_picker_options reads its menu instead of reporting blind", async () => {
    const r = data<Read>(await read());
    expect(r.blind).toBeUndefined();
    expect(r.present).toBe(true);
    expect(r.options.map((o) => o.index)).toEqual([0, 1, 2]);
    expect(r.fingerprint).not.toBe("");
  });

  it("select_picker_option presses the option through the app-global PTY write", async () => {
    const r0 = data<Read>(await read());
    const r = await select(0, r0.fingerprint);
    expect(r.ok, r.ok ? "" : `${r.code}: ${r.message}`).toBe(true);
    // The SIDE EFFECT: the option's keystroke reached that agent's PTY.
    expect(writePtyChainedStrict).toHaveBeenCalledWith(AGENT, expect.stringMatching(/^1/));
    expect(submitPrompt).not.toHaveBeenCalled();
  });

  // The press fetches its OWN snapshot, so the fingerprint guard still bites across windows.
  it("REFUSES when the menu changed in the other window between read and press", async () => {
    const r0 = data<Read>(await read());
    hostWindowShows(OTHER_PROMPT);
    const r = await select(0, r0.fingerprint);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.code).toBe("changed");
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
  });

  it("leaves no relayed screen behind once the op is over", async () => {
    await read();
    expect(getAgentScrollback(AGENT)).toBeNull();
    expect(getAgentViewport(AGENT)).toBeNull();
  });
});

describe("an agent NO window can see", () => {
  beforeEach(() => {
    hostWindowShows(null);
  });

  it("still reports pane-not-mounted honestly", async () => {
    const r = data<Read>(await read());
    expect(r.present).toBe(false);
    expect(r.blind).toBe("pane-not-mounted");
    expect(r.fingerprint).toBe("");
  });

  it("presses nothing", async () => {
    const r = await select(0, "any-fingerprint");
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.code).toBe("no-picker");
    expect(writePtyChainedStrict).not.toHaveBeenCalled();
    expect(submitPrompt).not.toHaveBeenCalled();
  });
});
