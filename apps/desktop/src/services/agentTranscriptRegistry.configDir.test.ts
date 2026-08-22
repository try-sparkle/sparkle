// @vitest-environment jsdom
//
// WRITER (4) — WHICH ACCOUNT'S `CLAUDE_CONFIG_DIR` AN AGENT'S TRANSCRIPT IS WRITTEN UNDER.
//
// The founder's report, repeatedly: a mounted build agent shows "No conversation with <name> yet."
// while its own terminal is visibly live. Sparkle spawns each agent's `claude` with a per-account
// config dir (Multi Claude Max), so Claude writes the transcript to
// `<accountConfigDir>/projects/<slug>/<session>.jsonl`. Every read omitted that, Rust fell back to
// `$HOME/.claude/projects/<slug>` — a directory that DOES NOT EXIST for an account-spawned agent —
// and the pane rendered empty over a transcript being appended to at that moment. Measured on his
// machine: 42 of 52 live worktrees with a transcript on disk read empty, and his failing agent went
// from 0 reachable records to 480 once the config dir was carried.
//
// A SEPARATE FILE FROM `agentTranscriptRegistry.test.ts` on purpose: these cases hydrate a FRESH
// module instance out of `localStorage`, and module state is per test FILE in vitest. Sharing a file
// with the session-binding suite would let one describe's in-memory map decide another's hydration.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  agentConfigDir,
  configDirFromTranscriptPath,
  forgetAgentTranscriptPath,
  noteAgentConfigDir,
  subscribeAgentConfigDirs,
} from "./agentTranscriptRegistry";

const AGENTS = ["ag-1", "ag-2", "ag-restored"];
/** A real account config dir, spelled the way `accountSelection` hands it to the spawn. */
const ACCOUNT = "/home/u/Library/Application Support/ai.sparkle.desktop/accounts/c7c0d098f53f98d7";

function clearAll() {
  for (const id of AGENTS) forgetAgentTranscriptPath(id);
  localStorage.clear();
}

beforeEach(clearAll);
afterEach(clearAll);

// ── THE PURE DERIVATION ─────────────────────────────────────────────────────────────────────────
//
// This is what the hook handler uses, on every event, to learn the account WITHOUT asking the
// account chooser — which is a chooser, can rotate, and may name an account the agent never spawned
// under. Claude's layout is `<configDir>/projects/<slug>/<session-id>.jsonl`, so the answer is the
// path minus its last three segments. It FAILS CLOSED, and that direction matters: `undefined`
// leaves the reader on `$HOME/.claude` (today's behaviour, correct for a default-config agent),
// whereas a fabricated directory turns a WORKING pane into an empty one.
describe("configDirFromTranscriptPath", () => {
  it("returns the account root for an account-spawned agent's transcript", () => {
    expect(
      configDirFromTranscriptPath(`${ACCOUNT}/projects/-Users-u-wt-ag1/8e78e87c.jsonl`),
    ).toBe(ACCOUNT);
  });

  it("returns the default root for a `~/.claude` transcript", () => {
    expect(
      configDirFromTranscriptPath("/home/u/.claude/projects/-Users-u-wt-ag1/8e78e87c.jsonl"),
    ).toBe("/home/u/.claude");
  });

  // THE FAIL-CLOSED HALF. A path whose grandparent is not `projects` is not a Claude session path,
  // and inventing a "config dir" from it would point every read at a directory that does not exist.
  it("refuses a path whose grandparent segment is not `projects`", () => {
    expect(
      configDirFromTranscriptPath(`${ACCOUNT}/sessions/-Users-u-wt-ag1/8e78e87c.jsonl`),
    ).toBeUndefined();
  });

  it("refuses a path with no room for the three segments", () => {
    expect(configDirFromTranscriptPath("/8e78e87c.jsonl")).toBeUndefined();
    expect(configDirFromTranscriptPath("projects/slug/8e78e87c.jsonl")).toBeUndefined();
  });

  it("refuses anything that is not a `.jsonl`, and the empty cases", () => {
    expect(configDirFromTranscriptPath(`${ACCOUNT}/projects/slug/8e78e87c.log`)).toBeUndefined();
    expect(configDirFromTranscriptPath(`${ACCOUNT}/projects/slug`)).toBeUndefined();
    expect(configDirFromTranscriptPath(null)).toBeUndefined();
    expect(configDirFromTranscriptPath(undefined)).toBeUndefined();
    expect(configDirFromTranscriptPath("   ")).toBeUndefined();
  });

  // Windows-shaped, so a backslash path cannot be mis-sliced into a directory one level off.
  it("handles a backslash-separated path", () => {
    expect(
      configDirFromTranscriptPath("C:\\Users\\u\\.claude\\projects\\-wt-ag1\\8e78e87c.jsonl"),
    ).toBe("C:\\Users\\u\\.claude");
  });
});

// ── THE MAP ─────────────────────────────────────────────────────────────────────────────────────
describe("noteAgentConfigDir / agentConfigDir", () => {
  it("records the account an agent was spawned under, and keeps agents apart", () => {
    noteAgentConfigDir("ag-1", ACCOUNT);
    noteAgentConfigDir("ag-2", "/home/u/.claude");
    expect(agentConfigDir("ag-1")).toBe(ACCOUNT);
    expect(agentConfigDir("ag-2")).toBe("/home/u/.claude");
  });

  // `undefined` HERE IS NOT WRITER (3)'S FAIL-CLOSED UNKNOWN. It means "no account override was
  // recorded", the reader passes `null`, and Rust falls back to `$HOME/.claude` — today's behaviour,
  // and right for a legacy agent. So the absence of a value can never make a working pane worse.
  it("is undefined for an agent it has never heard of, and after a forget", () => {
    expect(agentConfigDir("ag-1")).toBeUndefined();
    noteAgentConfigDir("ag-1", ACCOUNT);
    forgetAgentTranscriptPath("ag-1");
    expect(agentConfigDir("ag-1")).toBeUndefined();
  });

  it("ignores an empty or absent value rather than storing a second spelling of `the default`", () => {
    noteAgentConfigDir("ag-1", "");
    noteAgentConfigDir("ag-1", "   ");
    noteAgentConfigDir("ag-1", null);
    noteAgentConfigDir("ag-1", undefined);
    expect(agentConfigDir("ag-1")).toBeUndefined();
    // …and a real value still lands afterwards.
    noteAgentConfigDir("ag-1", ACCOUNT);
    expect(agentConfigDir("ag-1")).toBe(ACCOUNT);
  });

  it("trims what it stores, so a padded payload names a real directory", () => {
    noteAgentConfigDir("ag-1", `  ${ACCOUNT}  `);
    expect(agentConfigDir("ag-1")).toBe(ACCOUNT);
  });

  // NOTIFY ONLY ON A CHANGE. Hook events arrive continuously and almost all of them re-note the
  // config dir we already hold; re-notifying would re-render the mounted pane on every event and
  // hand `useSyncExternalStore` a fresh snapshot each time.
  it("notifies on a change and stays silent on an unchanged re-registration", () => {
    const seen = vi.fn();
    const off = subscribeAgentConfigDirs(seen);
    try {
      noteAgentConfigDir("ag-1", ACCOUNT);
      expect(seen).toHaveBeenCalledTimes(1);
      noteAgentConfigDir("ag-1", ACCOUNT);
      noteAgentConfigDir("ag-1", ACCOUNT);
      expect(seen).toHaveBeenCalledTimes(1);
      // A genuinely different account (a resume that landed elsewhere) IS a change.
      noteAgentConfigDir("ag-1", "/home/u/.claude");
      expect(seen).toHaveBeenCalledTimes(2);
      expect(agentConfigDir("ag-1")).toBe("/home/u/.claude");
    } finally {
      off();
    }
  });

  it("stops notifying once unsubscribed", () => {
    const seen = vi.fn();
    subscribeAgentConfigDirs(seen)();
    noteAgentConfigDir("ag-1", ACCOUNT);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("persistence — the account binding survives a restart", () => {
  it("reloads an agent's config dir in a fresh module instance", async () => {
    noteAgentConfigDir("ag-restored", ACCOUNT);

    vi.resetModules();
    const fresh = await import("./agentTranscriptRegistry");
    expect(fresh.agentConfigDir("ag-restored")).toBe(ACCOUNT);
  });

  // ITS OWN VERSIONED KEY. A shape change in either map has to be a clean miss for THAT map alone,
  // not a parse failure that takes the session binding down with it.
  it("uses a key of its own, so a corrupt session blob does not lose the account", async () => {
    localStorage.setItem("sparkle.agentSessionIds.v1", "{not json");
    localStorage.setItem(
      "sparkle.agentConfigDirs.v1",
      JSON.stringify({ "ag-restored": ACCOUNT }),
    );
    vi.resetModules();
    const fresh = await import("./agentTranscriptRegistry");
    expect(fresh.agentSessionIds("ag-restored")).toBeUndefined();
    expect(fresh.agentConfigDir("ag-restored")).toBe(ACCOUNT);
  });

  it("treats a corrupted account blob as unknown rather than throwing", async () => {
    localStorage.setItem("sparkle.agentConfigDirs.v1", "{not json");
    vi.resetModules();
    const fresh = await import("./agentTranscriptRegistry");
    expect(fresh.agentConfigDir("ag-restored")).toBeUndefined();
    fresh.noteAgentConfigDir("ag-restored", ACCOUNT);
    expect(fresh.agentConfigDir("ag-restored")).toBe(ACCOUNT);
  });

  it("ignores non-string entries in a persisted blob", async () => {
    localStorage.setItem(
      "sparkle.agentConfigDirs.v1",
      JSON.stringify({ "ag-1": 42, "ag-2": "", "ag-restored": ACCOUNT }),
    );
    vi.resetModules();
    const fresh = await import("./agentTranscriptRegistry");
    expect(fresh.agentConfigDir("ag-1")).toBeUndefined();
    expect(fresh.agentConfigDir("ag-2")).toBeUndefined();
    expect(fresh.agentConfigDir("ag-restored")).toBe(ACCOUNT);
  });

  it("forgetting an agent removes it from the persisted blob too", async () => {
    noteAgentConfigDir("ag-restored", ACCOUNT);
    forgetAgentTranscriptPath("ag-restored");
    vi.resetModules();
    const fresh = await import("./agentTranscriptRegistry");
    expect(fresh.agentConfigDir("ag-restored")).toBeUndefined();
  });

  it("survives a storage WRITE that throws (quota), keeping the value in memory", () => {
    const boom = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    try {
      noteAgentConfigDir("ag-1", ACCOUNT);
      expect(agentConfigDir("ag-1")).toBe(ACCOUNT);
    } finally {
      boom.mockRestore();
    }
  });
});
