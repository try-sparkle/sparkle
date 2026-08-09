// THE ONE CLAUDE SIGN-IN SURFACE. Its two mount points are ReadinessGate's blocking auth stage (both
// first run and a session that later expired) and AccountLoginModal (a named account's own login);
// verify with `grep -rl ClaudeSignIn apps/desktop/src` before trusting that count. SetupChecklist no
// longer signs anyone in at all — its login step was deleted, see setupState.ts. The concierge does
// not mount this directly: its failure bubble publishes to `claudeAuthSignal`, and the gate raises
// this surface, so there is one implementation of "run the real login and confirm it took".
//
// WHY IT IS ONE COMPONENT AND NOT THREE. Before this, the sign-in flow was copy-pasted between
// SetupChecklist's LoginRow and AccountLoginModal, and both built the command `claude login`. That
// is not a subcommand (`claude --help` lists `auth`, and `login` lives under it), so commander read
// `login` as the positional PROMPT and the embedded terminal opened an ordinary Claude REPL and
// asked it the word "login". OAuth never ran. The founder reported it as "the little login window
// in onboarding isn't working" — and it had been broken in both copies simultaneously, which is the
// argument for one copy. `buildClaudeLoginExec` now emits `auth login` and every caller inherits it.
//
// CONFIRMATION IS A READING, NOT AN EXIT CODE. A terminal that closed proves nothing — the user may
// have quit, failed, or hit ⌃C. We verify with `claude auth status`, which is the CLI's own answer
// about its own credentials, and only a live `loggedIn: true` reports success.

import { useCallback, useEffect, useRef, useState } from "react";
import { FiCheckCircle, FiLoader } from "react-icons/fi";
import { C, FONT_WEIGHT } from "../theme/colors";
import { RADIUS } from "../theme/scale";
import { buildClaudeLoginExec, SHELL } from "../services/claudeSpawn";
import { checkClaude, checkClaudeAuthStatus } from "../preflight";
import { Terminal } from "./Terminal";

/** How long the terminal is given, after it exits, before we stop re-probing for a completed login.
 *
 *  `claude auth login` hands off to a BROWSER: the PTY can exit while the user is still on the OAuth
 *  page, and the credential lands seconds later. A single probe at exit therefore reports "not
 *  signed in" for a login that is about to succeed — which is precisely the shape of "I signed in
 *  and it still says I'm signed out". We poll instead. */
const CONFIRM_WINDOW_MS = 90_000;
const CONFIRM_POLL_MS = 1500;

/**
 * `unconfirmed` is its own phase, and that is a bug fix rather than a nicety.
 *
 * The retry control used to render only while `confirming`, and every terminal branch of the confirm
 * window cleared that flag. So when a login genuinely FAILED — the window expired with the CLI still
 * reporting signed-out — the surface dropped to a dead, exited PTY with no spinner, no message and
 * no retry: the affordance disappeared at precisely the moment it was needed, and the only way out
 * was unmounting the whole screen. Since this mounts inside a BLOCKING gate, that is a dead end
 * (roborev 57985).
 */
export type SignInPhase =
  | "resolving"
  | "no-claude"
  | "running"
  | "confirming"
  | "unconfirmed"
  | "done";

/**
 * Runs the genuine `claude auth login` in an embedded PTY and reports when the session is live.
 *
 * `onSignedIn` fires ONLY on a confirmed live credential. There is no "probably worked" path — a
 * caller that gates the app on this must not be dismissed by a login that didn't take.
 */
export function ClaudeSignIn({
  configDir,
  onSignedIn,
  onPhase,
  height = 320,
}: {
  /** Target a specific account's config dir. Omitted = the machine's own `~/.claude` login. */
  configDir?: string;
  onSignedIn: () => void;
  /** Observe the flow (used to swap surrounding copy/controls). Optional. */
  onPhase?: (p: SignInPhase) => void;
  height?: number;
}) {
  // null = still resolving, false = claude binary is missing (nothing to log in WITH).
  const [claudePath, setClaudePath] = useState<string | null | false>(null);
  const [confirming, setConfirming] = useState(false);
  // The confirm window closed without ever seeing a live credential. Distinct from `confirming` so
  // the retry control and an explanation survive the timeout — see SignInPhase.
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [done, setDone] = useState(false);
  // Bumping this remounts the Terminal, which is how "Try again" re-runs the login: a PTY that has
  // already exited cannot be restarted in place.
  const [attempt, setAttempt] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Held in a ref so the poll (frozen at the interval's creation) always calls the CURRENT callback
  // rather than the one captured when confirmation started.
  const onSignedInRef = useRef(onSignedIn);
  onSignedInRef.current = onSignedIn;

  const phase: SignInPhase = done
    ? "done"
    : confirming
      ? "confirming"
      : unconfirmed
        ? "unconfirmed"
        : claudePath === null
          ? "resolving"
          : claudePath === false
            ? "no-claude"
            : "running";

  // Report phase from an effect, not inline: calling a parent's setState during our own render is
  // the classic cross-component update warning, and the parent legitimately re-renders on it.
  useEffect(() => {
    onPhase?.(phase);
  }, [phase, onPhase]);

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

  const stopPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  /** The PTY exited. Start (or restart) the confirmation window — see CONFIRM_WINDOW_MS for why a
   *  single probe here is wrong. */
  const handleExit = useCallback(() => {
    stopPolling();
    setUnconfirmed(false);
    setConfirming(true);
    const startedAt = Date.now();
    /** The window closed without a live credential — surface it and keep the retry reachable. */
    const giveUp = () => {
      stopPolling();
      setConfirming(false);
      setUnconfirmed(true);
    };
    const probe = () => {
      void checkClaudeAuthStatus(configDir)
        .then((s) => {
          // `loggedIn` only — NOT `source`. A `recorded` yes is good enough to dismiss a sign-in
          // surface: it means an identity exists and the live probe couldn't speak, and refusing to
          // proceed on that would strand a user whose login genuinely worked behind a broken probe.
          if (s.loggedIn) {
            stopPolling();
            setConfirming(false);
            setUnconfirmed(false);
            setDone(true);
            onSignedInRef.current();
          } else if (Date.now() - startedAt > CONFIRM_WINDOW_MS) {
            giveUp();
          }
        })
        .catch(() => {
          if (Date.now() - startedAt > CONFIRM_WINDOW_MS) giveUp();
        });
    };
    probe();
    pollRef.current = setInterval(probe, CONFIRM_POLL_MS);
  }, [configDir, stopPolling]);

  const retry = useCallback(() => {
    stopPolling();
    setConfirming(false);
    setUnconfirmed(false);
    setAttempt((n) => n + 1);
  }, [stopPolling]);

  if (claudePath === null) {
    return <Note>Preparing sign-in…</Note>;
  }
  if (claudePath === false) {
    return (
      <Note>
        Couldn’t find your <code>claude</code> binary. Install Claude Code first, then sign in.
      </Note>
    );
  }
  if (done) {
    return (
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, color: C.successInk, fontSize: 13 }}
      >
        <FiCheckCircle size={18} aria-hidden />
        <span style={{ fontWeight: FONT_WEIGHT.medium }}>Signed in to Claude</span>
      </div>
    );
  }

  const exec = buildClaudeLoginExec(claudePath, configDir ? { configDir } : {});

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0, flex: 1 }}>
      <div
        style={{
          height,
          flex: "1 1 auto",
          minHeight: 0,
          border: `1px solid ${C.hairline}`,
          borderRadius: RADIUS.input,
          overflow: "hidden",
          padding: 6,
        }}
      >
        <Terminal
          // `attempt` in the key remounts the PTY for a retry — an exited PTY can't be re-run.
          key={`claude-signin-${attempt}`}
          agentId={`claude-signin-${attempt}`}
          projectId="claude-signin"
          projectRootPath=""
          command={SHELL}
          args={["-l", "-c", exec]}
          // NO cwd, DELIBERATELY — passing one here made every named-account login impossible.
          // `pty_spawn` requires a supplied cwd to resolve inside `<app_data>/worktrees`, and an
          // account's config dir is `<app_data>/accounts/<id>` — a SIBLING of it. So `cwd={configDir}`
          // was rejected on every attempt ("cwd is outside the managed worktrees directory"), the pane
          // painted "Couldn't start the agent.", and its "Start again" re-ran the same doomed spawn.
          // The account is targeted by CLAUDE_CONFIG_DIR inside `exec`; the cwd never carried that and
          // was pure liability. A null cwd is the contract pty.rs documents for the login flows — it
          // falls back to the managed app-data dir. See sparkle-mahbf.
          active
          onStatus={() => {}}
          onExit={handleExit}
        />
      </div>
      {/* The retry is reachable in BOTH post-exit phases. It used to render only while confirming,
          which took it away at the one moment it mattered — see SignInPhase. */}
      {(confirming || unconfirmed) && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              // amberInk, not BRAND.amber: this is TEXT, and the theme reserves the brand value for
              // fills/tints (see theme/colors.ts).
              color: unconfirmed ? C.amberInk : C.muted,
              fontSize: 12,
            }}
          >
            {confirming && <FiLoader size={14} aria-hidden className="setup-spin" />}
            {confirming
              ? "Waiting for your browser to finish signing in…"
              : "We couldn’t confirm the sign-in. If you closed the browser or it didn’t finish, try again."}
          </span>
          <button type="button" onClick={retry} style={secondaryButton}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 16, color: C.muted, fontSize: 13 }}>{children}</div>;
}

const secondaryButton: React.CSSProperties = {
  background: "transparent",
  color: C.cream,
  border: `1px solid ${C.muted}`,
  borderRadius: RADIUS.input,
  padding: "6px 12px",
  fontWeight: FONT_WEIGHT.medium,
  fontSize: 12,
  cursor: "pointer",
};
