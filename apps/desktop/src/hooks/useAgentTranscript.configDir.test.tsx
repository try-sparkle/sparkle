// @vitest-environment jsdom
//
// THE READ HAS TO LOOK IN THE RIGHT ACCOUNT'S DIRECTORY — the dominant cause of the founder's
// "No conversation with <name> yet." over a visibly live terminal, reported repeatedly.
//
// Sparkle spawns each agent's `claude` with a per-account `CLAUDE_CONFIG_DIR`, exported onto the
// CHILD only. Claude then writes `<accountConfigDir>/projects/<slug>/<session>.jsonl`. This hook's
// reads never carried it: `configDir` was a THIRD PARAMETER that no caller — production or test —
// ever supplied, so both commands went out with `configDir: null`, Rust fell back to
// `$HOME/.claude/projects/<slug>`, that directory does not exist for an account-spawned agent,
// `own_session_files` returned an empty list, and the pane rendered empty. Measured: 42 of 52 live
// worktrees on the founder's machine read empty this way; his failing agent went 0 → 480 records.
//
// ══ WHY THESE TESTS SEED A REGISTRY RATHER THAN PASS AN ARGUMENT ═══════════════════════════════
// Because the argument is GONE. A parameter defaulted at its one production call site and supplied
// by every test is AGENTS.md's "defaulted seam": the single line carrying the real value is covered
// by nothing and can be deleted with the suite still green. THAT IS EXACTLY HOW THIS BUG SURVIVED —
// the line never existed. So the value is read from `agentTranscriptRegistry` inside the hook, and
// these tests write it through `noteAgentConfigDir`, the same writer `AgentPane`'s spawn and hook
// handler use. There is one path, and it is the tested one.
//
// Every row asserts the SIDE EFFECT — the invoke payload that goes over the wire, or the entries
// that land in the store — never that a read was merely attempted.
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

import { useAgentTranscript } from "./useAgentTranscript";
import { useMountedThreadStore } from "../stores/mountedThreadStore";
import {
  forgetAgentTranscriptPath,
  noteAgentConfigDir,
  noteAgentSessionId,
} from "../services/agentTranscriptRegistry";
import type { TranscriptEntry } from "../services/agentTranscript";

/** The founder's own failing agent's only account, and the worktree it works in. */
const ACCOUNT = "/home/u/Library/Application Support/ai.sparkle.desktop/accounts/c7c0d098f53f98d7";
const WORKTREE = "/home/u/wt/ag-1";
const FILE = `${ACCOUNT}/projects/-home-u-wt-ag-1/sess-a1.jsonl`;
const AGENTS = ["a1", "a2"];

function human(id: string, text: string, ts: string): TranscriptEntry {
  return {
    kind: "human",
    id,
    text,
    timestamp: ts,
    sessionId: "sess-a1",
    promptSource: "typed",
    raw: "{}",
    cursor: { file: FILE, line: 0 },
  };
}

function page(entries: TranscriptEntry[], over: Record<string, unknown> = {}) {
  return {
    entries,
    next: { file: FILE, line: 10 },
    hasMore: true,
    sessionsScanned: 1,
    filesOpened: 1,
    tailFile: FILE,
    tailByte: 500,
    ...over,
  };
}

/**
 * A stand-in for Rust's `session_dir` + `own_session_files`, and the fixture that makes this suite
 * able to see the bug at all: it answers ONLY for a read that named the account root. A permissive
 * stub — one that returns the page whatever `configDir` says — could not tell "the config dir
 * reached the command" from "the command ignored it", which is the whole question here.
 */
function fakeAccountDisk(entries: TranscriptEntry[], root: string = ACCOUNT) {
  invoke.mockImplementation(async (cmd: string, args?: unknown) => {
    const dir = (args as { configDir?: string | null }).configDir ?? null;
    const found = dir === root;
    if (cmd === "agent_transcript_page") {
      return found ? page(entries) : page([], { tailFile: null, tailByte: 0, hasMore: false });
    }
    if (cmd === "agent_transcript_tail") {
      return found
        ? { entries: [], file: FILE, nextByte: 500 }
        : { entries: [], file: null, nextByte: 0 };
    }
    return undefined;
  });
}

function Harness({ agentId, worktree }: { agentId: string | null; worktree: string | null }) {
  useAgentTranscript(agentId, worktree);
  return null;
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
};

const entriesOf = (id: string) =>
  (useMountedThreadStore.getState().threads[id]?.entries ?? []).map((e) => e.id);

const callsTo = (cmd: string) => invoke.mock.calls.filter(([c]) => c === cmd);
const lastPayload = (cmd: string) =>
  (callsTo(cmd).pop()?.[1] ?? null) as Record<string, unknown> | null;

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  useMountedThreadStore.setState({ threads: {} });
  localStorage.clear();
  for (const id of AGENTS) {
    forgetAgentTranscriptPath(id);
    noteAgentSessionId(id, `sess-${id}`);
  }
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  for (const id of AGENTS) forgetAgentTranscriptPath(id);
  localStorage.clear();
});

describe("useAgentTranscript — the account config dir reaches BOTH reads", () => {
  it("carries the registered account on the page AND the tail, and renders the turns", async () => {
    noteAgentConfigDir("a1", ACCOUNT);
    fakeAccountDisk([human("h1", "add a test for the retry path", "2026-08-20T10:00:00.000Z")]);

    render(<Harness agentId="a1" worktree={WORKTREE} />);
    await flush();

    // THE FOUNDER'S OUTCOME: the records are reachable. 0 → 1 here stands for his measured 0 → 480.
    expect(entriesOf("a1")).toEqual(["h1"]);
    expect(lastPayload("agent_transcript_page")).toMatchObject({
      worktreePath: WORKTREE,
      configDir: ACCOUNT,
      sessionIds: ["sess-a1"],
    });

    // AND THE TAIL, which is a separate call site and was separately unfixed. Without it the pane
    // would paint once and then never follow the agent — the half a page-only fix would leave.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(lastPayload("agent_transcript_tail")).toMatchObject({
      worktreePath: WORKTREE,
      configDir: ACCOUNT,
      sessionIds: ["sess-a1"],
    });
  });

  // TODAY'S BEHAVIOUR, PRESERVED. An agent with no account override must still read exactly as it
  // does now — `configDir: null`, Rust falls back to `$HOME/.claude`. This fix must never be able to
  // make a currently-working pane worse, and this is the row that says so.
  it("sends null for an agent with no account recorded, and still reads", async () => {
    fakeAccountDisk([human("h1", "default config agent", "2026-08-20T10:00:00.000Z")], null as never);

    render(<Harness agentId="a1" worktree={WORKTREE} />);
    await flush();

    expect(entriesOf("a1")).toEqual(["h1"]);
    expect(lastPayload("agent_transcript_page")).toMatchObject({ configDir: null });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(lastPayload("agent_transcript_tail")).toMatchObject({ configDir: null });
  });

  // THE REAL TIMING, and the reason the value is subscribed rather than read once. The account
  // binding lands at spawn or on the agent's first hook event — routinely AFTER the pane has
  // painted. A first page issued before it arrived reads the wrong directory and comes back empty,
  // and nothing re-pages a mounted pane, so the pane stays empty for the life of the mount.
  it("re-pages when the account arrives AFTER the first render, with no remount", async () => {
    fakeAccountDisk([human("h1", "landed late", "2026-08-20T10:00:00.000Z")]);

    render(<Harness agentId="a1" worktree={WORKTREE} />);
    await flush();

    // The first read went out against the default root and found nothing — the founder's screenshot.
    expect(entriesOf("a1")).toEqual([]);
    expect(lastPayload("agent_transcript_page")).toMatchObject({ configDir: null });

    // The agent's SessionStart hook event lands. NOTHING remounts; the component is untouched.
    await act(async () => {
      noteAgentConfigDir("a1", ACCOUNT);
      await Promise.resolve();
      await Promise.resolve();
    });
    await flush();

    expect(entriesOf("a1")).toEqual(["h1"]);
    expect(lastPayload("agent_transcript_page")).toMatchObject({ configDir: ACCOUNT });
  });

  // AND IT DOES NOT RE-FETCH ON EVERY HOOK EVENT. `noteAgentConfigDir` is called from the spawn and
  // from every hook event; if an unchanged re-registration re-ran the effect, a working agent would
  // re-page several times a second. The value is a plain string, so an unchanged one is `===`.
  it("does not re-page when the same account is re-registered", async () => {
    noteAgentConfigDir("a1", ACCOUNT);
    fakeAccountDisk([human("h1", "steady", "2026-08-20T10:00:00.000Z")]);

    render(<Harness agentId="a1" worktree={WORKTREE} />);
    await flush();
    const after = callsTo("agent_transcript_page").length;

    await act(async () => {
      noteAgentConfigDir("a1", ACCOUNT);
      noteAgentConfigDir("a1", ACCOUNT);
      await Promise.resolve();
    });
    await flush();

    expect(callsTo("agent_transcript_page")).toHaveLength(after);
  });

  // ══ THE FAIL-CLOSED GATE STILL HOLDS ══════════════════════════════════════════════════════════
  // This is the regression guard for the wrong-attribution bug commit c46aae5cd fixed, and it must
  // go red if anyone deletes the `if (!sessionIds)` gate. An agent whose worktree directory is
  // perfectly readable and whose ACCOUNT is perfectly known still reads NOTHING while we do not know
  // whose sessions those are — measured, one agent's own worktree directory held 136 session files
  // of which 97 were foreign, so "the directory is his" is not evidence about the conversation.
  it("reads NOTHING for an unbound agent, even with an account registered", async () => {
    forgetAgentTranscriptPath("a1"); // drops the binding seeded in beforeEach, keeps nothing else
    noteAgentConfigDir("a1", ACCOUNT);
    fakeAccountDisk([human("stranger", "somebody else's turn", "2026-08-20T10:00:00.000Z")]);

    render(<Harness agentId="a1" worktree={WORKTREE} />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(entriesOf("a1")).toEqual([]);
    // ZERO IPC, not merely a discarded result: an unidentified agent must cost no reads at all.
    expect(callsTo("agent_transcript_page")).toEqual([]);
    expect(callsTo("agent_transcript_tail")).toEqual([]);
    // …and no error is painted. An honest empty state is the correct rendering here.
    expect(useMountedThreadStore.getState().threads["a1"]?.error ?? null).toBe(null);
  });
});

// ══ THE FROZEN TAIL ═══════════════════════════════════════════════════════════════════════════
//
// Rust answers `tailFile: null` whenever the filtered file list is empty, and the tail used to bail
// FOREVER on that. So an agent mounted before it had written its first record — or whose first page
// came back empty for any reason, which the account bug made the common case — never live-tailed
// again for the life of the mount, however much it went on to write.
describe("useAgentTranscript — a null tail anchor self-heals", () => {
  it("re-issues the FIRST PAGE on the tick, and the entries appear once the file exists", async () => {
    // The agent is bound and mounted, but Claude has not written its first record yet.
    let written = false;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_transcript_page") {
        return written
          ? page([human("first", "here is my first turn", "2026-08-20T10:00:00.000Z")])
          : page([], { tailFile: null, tailByte: 0, hasMore: false, next: null });
      }
      if (cmd === "agent_transcript_tail") return { entries: [], file: FILE, nextByte: 500 };
      return undefined;
    });

    render(<Harness agentId="a1" worktree={WORKTREE} />);
    await flush();

    // The honest empty state — and, critically, NO tail anchor.
    expect(entriesOf("a1")).toEqual([]);
    expect(useMountedThreadStore.getState().threads["a1"]!.tailFile).toBeNull();

    // Claude writes the first record. Nothing remounts and no hook event fires — the only thing that
    // happens is time passing, which on `origin/main` produced nothing at all.
    written = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
      await Promise.resolve();
    });

    // THE SIDE EFFECT: the turn is on screen, and the pane now has a live edge to follow.
    expect(entriesOf("a1")).toEqual(["first"]);
    expect(useMountedThreadStore.getState().threads["a1"]!.tailFile).toBe(FILE);
    // It healed through a PAGE, not a tail from byte 0 — reading from 0 is what the anchor exists to
    // prevent, and a heal that did it would re-deliver the whole file on every rotation.
    expect(callsTo("agent_transcript_page").length).toBeGreaterThan(1);
  });

  // …AND IT BACKS OFF rather than re-paging at 1 Hz forever for an agent that never writes. A page
  // that still finds no file counts toward the shared failure backoff, so the attempts space out to
  // ~a minute; the row also pins that it does NOT `patch` an unchanged empty state, which would
  // repaint the pane once a second for the life of the mount.
  it("stops re-paging at full rate when the file never appears", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "agent_transcript_page")
        return page([], { tailFile: null, tailByte: 0, hasMore: false, next: null });
      return undefined;
    });

    render(<Harness agentId="a1" worktree={WORKTREE} />);
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // 30 ticks would be 30 pages without a backoff. The exact number is the backoff's business; what
    // this pins is that it is a small fraction of the ticks rather than one per tick.
    const pages = callsTo("agent_transcript_page").length;
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThan(12);
  });

  // The generation drop rule survives the new path: a heal page issued for an agent that has since
  // been unmounted must not land in the store under whatever is mounted now.
  it("drops a heal page for an agent that was unmounted while it was in flight", async () => {
    let release: (v: unknown) => void = () => {};
    invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "agent_transcript_page") {
        const ids = (args as { sessionIds?: string[] }).sessionIds ?? [];
        if (ids[0] === "sess-a1") {
          // The first page resolves immediately with no anchor; the HEAL page hangs.
          if (invoke.mock.calls.filter(([c]) => c === "agent_transcript_page").length > 1) {
            return await new Promise((r) => (release = r));
          }
          return page([], { tailFile: null, tailByte: 0, hasMore: false, next: null });
        }
        return page([human("b-turn", "agent two", "2026-08-20T11:00:00.000Z")]);
      }
      if (cmd === "agent_transcript_tail") return { entries: [], file: FILE, nextByte: 500 };
      return undefined;
    });

    const view = render(<Harness agentId="a1" worktree={WORKTREE} />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });

    // The founder mounts a different agent while a1's heal page is still in flight.
    view.rerender(<Harness agentId="a2" worktree="/home/u/wt/ag-2" />);
    await flush();

    await act(async () => {
      release(page([human("a-late", "a1's late words", "2026-08-20T10:00:00.000Z")]));
      await Promise.resolve();
      await Promise.resolve();
    });

    // a1's late page is DISCARDED — it must not appear under a2's name, nor resurrect a1's thread.
    expect(entriesOf("a1")).toEqual([]);
    expect(entriesOf("a2")).toEqual(["b-turn"]);
  });
});
