import { useEffect, useState } from "react";
import { C } from "../theme/colors";
import type { Account } from "../services/accountStore";
import { buildClaudeExec, SHELL } from "../services/claudeSpawn";
import { checkClaude } from "../preflight";
import { Terminal } from "./Terminal";

// The integrator seam for AccountsScreen's `onLogin` (multi Claude Max design, Task 4). After
// "Add account" creates an empty config dir, the user must complete a normal `claude login` (browser
// OAuth) INTO that dir so the genuine binary stores its own credentials there — Sparkle never sees
// them. We do that by spawning the user's real `claude` interactively in a PTY with
// CLAUDE_CONFIG_DIR pointed at the new account's dir, surfaced in a terminal the user can drive.
//
// This is the one place AccountsScreen's "must NOT import the spawn path" rule is satisfied from the
// outside: the modal (mounted by TopBar) owns the PTY; AccountsScreen just hands back the Account.

export function AccountLoginModal({ account, onClose }: { account: Account; onClose: () => void }) {
  // Resolve the user's claude binary (same preflight AgentPane uses). null = still checking;
  // false = not installed.
  const [claudePath, setClaudePath] = useState<string | null | false>(null);

  useEffect(() => {
    let alive = true;
    void checkClaude()
      .then((c) => {
        if (alive) setClaudePath(c.installed && c.path ? c.path : false);
      })
      .catch(() => {
        if (alive) setClaudePath(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Interactive `claude` (no resume, no mission prompt) under the new account's CLAUDE_CONFIG_DIR.
  // The user runs the normal login flow inside it; closing the modal kills the PTY.
  const spawn =
    typeof claudePath === "string"
      ? {
          command: SHELL,
          args: ["-l", "-c", buildClaudeExec(claudePath, false, { configDir: account.configDir })],
          cwd: account.configDir,
        }
      : null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 120,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 760,
          maxWidth: "92vw",
          height: 520,
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          background: C.deepForest,
          border: `1px solid ${C.forest}`,
          borderRadius: 12,
          padding: 16,
          color: C.cream,
          fontFamily: '"IBM Plex Sans", sans-serif',
          boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Log in to “{account.nickname}”</div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: `1px solid ${C.muted}`,
              borderRadius: 6,
              color: C.cream,
              fontSize: 12,
              padding: "4px 10px",
              cursor: "pointer",
            }}
          >
            Done
          </button>
        </div>
        <p style={{ fontSize: 12, color: C.muted, marginTop: 0, lineHeight: 1.4 }}>
          Complete the normal Claude login below (it opens your browser). Sparkle never sees your
          credentials — they’re stored in this account’s own config folder. Close when you’re done.
        </p>
        <div style={{ flex: 1, minHeight: 0, border: `1px solid ${C.forest}`, borderRadius: 8, overflow: "hidden", padding: 6 }}>
          {spawn ? (
            <Terminal
              agentId={`account-login-${account.id}`}
              projectId="account-login"
              projectRootPath={account.configDir}
              command={spawn.command}
              args={spawn.args}
              cwd={spawn.cwd}
              active
              onStatus={() => {}}
              onExit={onClose}
            />
          ) : (
            <div style={{ padding: 20, color: C.muted, fontSize: 13 }}>
              {claudePath === false
                ? "Couldn’t find your claude binary. Install Claude Code, then try again."
                : "Preparing login…"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
