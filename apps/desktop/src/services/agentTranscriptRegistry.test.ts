// @vitest-environment jsdom
//
// The SESSION BINDING — writer (3) of the transcript registry, and the piece that decides whether a
// mounted concierge pane renders this agent's conversation or somebody else's.
//
// WHY THIS MATTERS. A Claude Code session DIRECTORY is keyed by WORKTREE, not by agent: every
// `claude` that ever ran in that tree has a `<session-id>.jsonl` in it (1,172 files in one measured
// worktree). The reader used to take the newest by mtime, so a pane whose footer read
// "Chatting with ● Sparkle" rendered an unrelated agent's roborev review. This map is what names
// whose files are whose.
//
// Every test below asserts what a READER would get back — the returned ids, or `undefined` for
// unknown — never merely that a write was accepted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentSessionIds,
  forgetAgentTranscriptPath,
  noteAgentSessionId,
  subscribeAgentSessionIds,
} from "./agentTranscriptRegistry";

const AGENTS = ["ag-1", "ag-2", "ag-restored"];

function clearAll() {
  for (const id of AGENTS) forgetAgentTranscriptPath(id);
  localStorage.clear();
}

beforeEach(clearAll);
afterEach(clearAll);

describe("agentSessionIds — UNKNOWN is a state of its own", () => {
  // THE LOAD-BEARING RETURN VALUE. A reader must be able to tell "I do not know whose sessions these
  // are" from "this agent has no sessions", because the first one must render nothing while the
  // second is already nothing. Collapsing them to `[]` would invite the fallback that IS the defect.
  it("returns undefined, not an empty array, for an agent it has never heard of", () => {
    expect(agentSessionIds("ag-1")).toBeUndefined();
  });

  it("returns undefined again after the agent is forgotten", () => {
    noteAgentSessionId("ag-1", "sess-a");
    expect(agentSessionIds("ag-1")).toEqual(["sess-a"]);
    forgetAgentTranscriptPath("ag-1");
    expect(agentSessionIds("ag-1")).toBeUndefined();
  });
});

describe("noteAgentSessionId — a SET, not a value", () => {
  // THE REQUIREMENT THAT RULES OUT THE CHEAP FIX. An agent spans more than one session id: every
  // resume opens a fresh session with a fresh id and a fresh file. Replacing rather than accumulating
  // would render only the post-resume stretch and silently drop the history before it.
  it("accumulates every session an agent has owned, oldest first", () => {
    noteAgentSessionId("ag-1", "sess-first");
    noteAgentSessionId("ag-1", "sess-second");
    noteAgentSessionId("ag-1", "sess-third");
    expect(agentSessionIds("ag-1")).toEqual(["sess-first", "sess-second", "sess-third"]);
  });

  it("keeps agents apart", () => {
    noteAgentSessionId("ag-1", "sess-mine");
    noteAgentSessionId("ag-2", "sess-theirs");
    expect(agentSessionIds("ag-1")).toEqual(["sess-mine"]);
    expect(agentSessionIds("ag-2")).toEqual(["sess-theirs"]);
  });

  it("ignores blank ids rather than binding an empty session", () => {
    noteAgentSessionId("ag-1", "");
    noteAgentSessionId("ag-1", "   ");
    expect(agentSessionIds("ag-1")).toBeUndefined();
  });

  it("trims the id it stores, so a padded hook payload matches a real filename", () => {
    noteAgentSessionId("ag-1", "  sess-padded  ");
    expect(agentSessionIds("ag-1")).toEqual(["sess-padded"]);
  });

  // A RENDER READS THIS MAP through `useSyncExternalStore`, which throws if `getSnapshot` hands back
  // a fresh object each call. Hook events arrive continuously and nearly all carry an id we already
  // hold, so a re-registration must be identity-stable or the pane re-fetches its first page forever.
  it("returns the SAME array identity when a known id is re-registered", () => {
    noteAgentSessionId("ag-1", "sess-a");
    const first = agentSessionIds("ag-1");
    noteAgentSessionId("ag-1", "sess-a");
    expect(agentSessionIds("ag-1")).toBe(first);
  });

  it("returns a NEW identity when an id is genuinely added", () => {
    noteAgentSessionId("ag-1", "sess-a");
    const first = agentSessionIds("ag-1");
    noteAgentSessionId("ag-1", "sess-b");
    expect(agentSessionIds("ag-1")).not.toBe(first);
  });
});

describe("subscribeAgentSessionIds", () => {
  it("notifies on a genuinely new id and stays silent on a known one", () => {
    const seen = vi.fn();
    const off = subscribeAgentSessionIds(seen);
    try {
      noteAgentSessionId("ag-1", "sess-a");
      expect(seen).toHaveBeenCalledTimes(1);
      // Silence on a repeat is the whole reason the pane does not re-page once a second.
      noteAgentSessionId("ag-1", "sess-a");
      expect(seen).toHaveBeenCalledTimes(1);
      noteAgentSessionId("ag-1", "sess-b");
      expect(seen).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
  });

  it("stops notifying once unsubscribed", () => {
    const seen = vi.fn();
    subscribeAgentSessionIds(seen)();
    noteAgentSessionId("ag-1", "sess-a");
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("persistence — the binding survives a restart", () => {
  // WHY THIS IS PERSISTED AT ALL, when nothing else in this feature is. After a restart the agent
  // resumes under a NEW session id, so an in-memory-only binding would know only the post-restart
  // stretch — and the pane would show the founder a conversation that starts mid-story, which is the
  // exact "drops history on resume" failure the SET exists to prevent.
  it("reloads an agent's ids in a fresh module instance", async () => {
    noteAgentSessionId("ag-restored", "sess-before-restart");
    noteAgentSessionId("ag-restored", "sess-also-before");

    // A fresh import is this process's stand-in for a relaunch: new module state, same localStorage.
    vi.resetModules();
    const fresh = await import("./agentTranscriptRegistry");
    expect(fresh.agentSessionIds("ag-restored")).toEqual([
      "sess-before-restart",
      "sess-also-before",
    ]);

    // AND THE RESUME ACCUMULATES ONTO IT rather than replacing it — the property the whole set exists
    // for. Hydration happens before the write, so the pre-restart ids cannot be clobbered.
    fresh.noteAgentSessionId("ag-restored", "sess-after-restart");
    expect(fresh.agentSessionIds("ag-restored")).toEqual([
      "sess-before-restart",
      "sess-also-before",
      "sess-after-restart",
    ]);
  });

  it("treats a corrupted blob as unknown rather than throwing", async () => {
    localStorage.setItem("sparkle.agentSessionIds.v1", "{not json");
    vi.resetModules();
    const fresh = await import("./agentTranscriptRegistry");
    expect(fresh.agentSessionIds("ag-restored")).toBeUndefined();
    // Still usable afterwards: the binding rebuilds from hook events.
    fresh.noteAgentSessionId("ag-restored", "sess-new");
    expect(fresh.agentSessionIds("ag-restored")).toEqual(["sess-new"]);
  });

  it("ignores non-string entries in a persisted list", async () => {
    localStorage.setItem(
      "sparkle.agentSessionIds.v1",
      JSON.stringify({ "ag-restored": ["sess-ok", 42, null, "", "sess-also"] }),
    );
    vi.resetModules();
    const fresh = await import("./agentTranscriptRegistry");
    expect(fresh.agentSessionIds("ag-restored")).toEqual(["sess-ok", "sess-also"]);
  });

  it("forgetting an agent removes it from the persisted blob too", async () => {
    noteAgentSessionId("ag-restored", "sess-a");
    forgetAgentTranscriptPath("ag-restored");
    vi.resetModules();
    const fresh = await import("./agentTranscriptRegistry");
    expect(fresh.agentSessionIds("ag-restored")).toBeUndefined();
  });

  // A STORE THAT THROWS MUST NOT TAKE DOWN THE REGISTRY. `getItem` can throw where storage is
  // disabled or the frame is sandboxed — and this is a leaf module the project store imports, so an
  // unhandled throw here fails collection for everything downstream of it, which is the failure this
  // module's header is specifically about avoiding.
  it("survives a storage accessor that throws, and still works in memory", async () => {
    const boom = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    try {
      vi.resetModules();
      const fresh = await import("./agentTranscriptRegistry");
      expect(fresh.agentSessionIds("ag-restored")).toBeUndefined();
      fresh.noteAgentSessionId("ag-restored", "sess-in-memory");
      expect(fresh.agentSessionIds("ag-restored")).toEqual(["sess-in-memory"]);
    } finally {
      boom.mockRestore();
    }
  });

  it("survives a storage WRITE that throws (quota), keeping the id in memory", () => {
    const boom = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    try {
      noteAgentSessionId("ag-1", "sess-a");
      expect(agentSessionIds("ag-1")).toEqual(["sess-a"]);
    } finally {
      boom.mockRestore();
    }
  });
});
