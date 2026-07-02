import { describe, it, expect } from "vitest";
import {
  initialSetupState,
  setupReducer,
  allPrereqsInstalled,
  setupComplete,
  anyInstalling,
  type SetupState,
  type SetupEvent,
} from "./setupState";

/** Fold a list of events over the initial state — mirrors how the component dispatches. */
function run(events: SetupEvent[], start: SetupState = initialSetupState()): SetupState {
  return events.reduce(setupReducer, start);
}

describe("setup checklist state machine", () => {
  it("starts with all three rows checking and login locked", () => {
    const s = initialSetupState();
    expect(s.rows.git.phase).toBe("checking");
    expect(s.rows.node.phase).toBe("checking");
    expect(s.rows.claude.phase).toBe("checking");
    expect(s.login).toBe("locked");
    expect(allPrereqsInstalled(s)).toBe(false);
    expect(setupComplete(s)).toBe(false);
  });

  it("all-missing: a detect pass with nothing installed marks every row missing", () => {
    const s = run([
      {
        type: "detected",
        statuses: {
          git: { installed: false, path: null },
          node: { installed: false, path: null },
          claude: { installed: false, path: null },
        },
      },
    ]);
    expect(s.rows.git.phase).toBe("missing");
    expect(s.rows.node.phase).toBe("missing");
    expect(s.rows.claude.phase).toBe("missing");
    expect(s.login).toBe("locked");
  });

  it("installing → installed transitions a single row and streams progress", () => {
    let s = run([
      { type: "detected", statuses: { node: { installed: false, path: null } } },
    ]);
    s = setupReducer(s, { type: "installStart", key: "node" });
    expect(s.rows.node.phase).toBe("installing");
    s = setupReducer(s, { type: "installProgress", key: "node", message: "Unpacking…" });
    expect(s.rows.node.progress).toBe("Unpacking…");
    expect(anyInstalling(s)).toBe(true);
    s = setupReducer(s, { type: "installOk", key: "node", path: "/Users/x/.local/bin/node" });
    expect(s.rows.node.phase).toBe("installed");
    expect(s.rows.node.path).toBe("/Users/x/.local/bin/node");
    expect(anyInstalling(s)).toBe(false);
  });

  it("full happy path: all-missing → install each → login → complete (all green)", () => {
    let s = run([
      {
        type: "detected",
        statuses: {
          git: { installed: false, path: null },
          node: { installed: false, path: null },
          claude: { installed: false, path: null },
        },
      },
    ]);
    // Install git, then node, then claude.
    for (const key of ["git", "node", "claude"] as const) {
      s = setupReducer(s, { type: "installStart", key });
      s = setupReducer(s, { type: "installOk", key, path: `/path/${key}` });
    }
    expect(allPrereqsInstalled(s)).toBe(true);
    // Claude present ⇒ login unlocks.
    expect(s.login).toBe("ready");
    expect(setupComplete(s)).toBe(false); // not signed in yet

    s = setupReducer(s, { type: "loginStart" });
    expect(s.login).toBe("inProgress");
    s = setupReducer(s, { type: "loginDone" });
    expect(s.login).toBe("done");
    expect(setupComplete(s)).toBe(true); // ← all green, proceed into the app
  });

  it("login stays LOCKED until claude is installed", () => {
    let s = run([
      {
        type: "detected",
        statuses: {
          git: { installed: true, path: "/usr/bin/git" },
          node: { installed: true, path: "/n" },
          claude: { installed: false, path: null },
        },
      },
    ]);
    expect(s.login).toBe("locked");
    // loginStart is a no-op while locked.
    s = setupReducer(s, { type: "loginStart" });
    expect(s.login).toBe("locked");
    // Install claude → unlocks to ready.
    s = setupReducer(s, { type: "installOk", key: "claude", path: "/c" });
    expect(s.login).toBe("ready");
  });

  it("an install error surfaces on the row and does not unlock login", () => {
    let s = run([
      { type: "detected", statuses: { claude: { installed: false, path: null } } },
    ]);
    s = setupReducer(s, { type: "installStart", key: "claude" });
    s = setupReducer(s, { type: "installError", key: "claude", error: "network down" });
    expect(s.rows.claude.phase).toBe("error");
    expect(s.rows.claude.error).toBe("network down");
    expect(s.login).toBe("locked");
    expect(setupComplete(s)).toBe(false);
  });

  it("a re-detect that finds a tool present overrides a prior error (install-then-poll race)", () => {
    let s = run([
      { type: "detected", statuses: { git: { installed: false, path: null } } },
    ]);
    s = setupReducer(s, { type: "installError", key: "git", error: "clt install pending" });
    expect(s.rows.git.phase).toBe("error");
    // Polling git_preflight later finds it — the row goes green.
    s = setupReducer(s, { type: "detected", statuses: { git: { installed: true, path: "/usr/bin/git" } } });
    expect(s.rows.git.phase).toBe("installed");
    expect(s.rows.git.error).toBeNull();
  });

  it("a re-detect never regresses a completed login", () => {
    let s = run([
      {
        type: "detected",
        statuses: {
          git: { installed: true, path: "/g" },
          node: { installed: true, path: "/n" },
          claude: { installed: true, path: "/c" },
        },
      },
    ]);
    s = setupReducer(s, { type: "loginStart" });
    s = setupReducer(s, { type: "loginDone" });
    expect(s.login).toBe("done");
    // A later detect pass must keep login done.
    s = setupReducer(s, { type: "detected", statuses: { claude: { installed: true, path: "/c" } } });
    expect(s.login).toBe("done");
    expect(setupComplete(s)).toBe(true);
  });

  it("a detect pass does not clobber an in-flight install", () => {
    let s = run([
      { type: "detected", statuses: { node: { installed: false, path: null } } },
    ]);
    s = setupReducer(s, { type: "installStart", key: "node" });
    // A stale detect that still reports missing must NOT knock node out of `installing`.
    s = setupReducer(s, { type: "detected", statuses: { node: { installed: false, path: null } } });
    expect(s.rows.node.phase).toBe("installing");
  });

  it("loginReset returns to ready when claude present, locked otherwise", () => {
    let s = run([
      { type: "detected", statuses: { claude: { installed: true, path: "/c" } } },
    ]);
    s = setupReducer(s, { type: "loginStart" });
    s = setupReducer(s, { type: "loginReset" });
    expect(s.login).toBe("ready");
  });

  it("loginReset never regresses a completed sign-in (late terminal-exit probe)", () => {
    let s = run([
      {
        type: "detected",
        statuses: {
          git: { installed: true, path: "/g" },
          node: { installed: true, path: "/n" },
          claude: { installed: true, path: "/c" },
        },
      },
    ]);
    s = setupReducer(s, { type: "loginStart" });
    s = setupReducer(s, { type: "loginDone" });
    expect(s.login).toBe("done");
    // A late onExit probe that resolves "not signed in" must NOT flip a done login back.
    s = setupReducer(s, { type: "loginReset" });
    expect(s.login).toBe("done");
    expect(setupComplete(s)).toBe(true);
  });

  it("loginReset from locked stays locked (no claude yet)", () => {
    let s = initialSetupState();
    s = setupReducer(s, { type: "loginReset" });
    expect(s.login).toBe("locked");
  });
});
