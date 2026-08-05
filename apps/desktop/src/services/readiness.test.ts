import { describe, expect, it } from "vitest";
import { prereqsAllInstalled, readinessComplete, readinessStage } from "./readiness";
import type { PrereqsReport, ClaudeAuthStatus, AuthStatusSource } from "../preflight";

/** Build a report with per-prereq installed flags (paths don't affect the predicate). */
function report(over: Partial<Record<"git" | "node" | "claude", boolean>> = {}): PrereqsReport {
  const f = (installed: boolean) => ({ installed, path: installed ? "/x" : null });
  return {
    git: f(over.git ?? true),
    node: f(over.node ?? true),
    claude: f(over.claude ?? true),
  };
}

function auth(loggedIn: boolean, source: AuthStatusSource = "cli"): ClaudeAuthStatus {
  return {
    loggedIn,
    source,
    email: loggedIn ? "me@example.com" : null,
    authMethod: null,
    subscriptionType: null,
  };
}

describe("readiness predicate", () => {
  it("prereqsAllInstalled is true only when git, node AND claude are all present", () => {
    expect(prereqsAllInstalled(report())).toBe(true);
    expect(prereqsAllInstalled(report({ git: false }))).toBe(false);
    expect(prereqsAllInstalled(report({ node: false }))).toBe(false);
    expect(prereqsAllInstalled(report({ claude: false }))).toBe(false);
  });

  it("all prereqs present AND authenticated → ready (gate stays INVISIBLE)", () => {
    expect(readinessStage(report(), auth(true))).toBe("ready");
    expect(readinessComplete(report(), auth(true))).toBe(true);
  });

  // THE STAGE THAT DID NOT EXIST BEFORE, and the reason the founder's expiry went unannounced.
  // Everything is installed — this machine is not in onboarding — and the live probe says the
  // session is dead. That must produce its own blocking stage, not "ready" and not the install
  // checklist.
  it("everything installed but NOT authenticated → the AUTH stage, not install and not ready", () => {
    expect(readinessStage(report(), auth(false))).toBe("auth");
    expect(readinessComplete(report(), auth(false))).toBe(false);
  });

  it("a missing dependency → the INSTALL stage, whatever auth says", () => {
    // Install is checked first on purpose: with claude absent there is nothing to authenticate
    // against, so an auth screen there would offer a Sign in button that cannot run.
    expect(readinessStage(report({ claude: false }), auth(true))).toBe("install");
    expect(readinessStage(report({ claude: false }), auth(false))).toBe("install");
    expect(readinessStage(report({ node: false }), auth(true))).toBe("install");
    expect(readinessStage(report({ git: false }), auth(true))).toBe("install");
  });

  it("an unanswered probe is `probing` — never `ready`", () => {
    // Both nulls mean "no answer yet". Reporting `ready` here would paint the app and then yank it
    // away when the probe lands, and would let the user type at a concierge about to be gated.
    expect(readinessStage(null, null)).toBe("probing");
    expect(readinessStage(null, auth(true))).toBe("probing");
    // Prereqs answered, auth still outstanding — still probing, for the same reason.
    expect(readinessStage(report(), null)).toBe("probing");
  });

  // FAIL-OPEN, carried through from the Rust probe. `source: "recorded"` means the live probe could
  // not speak and we fell back to the remembered identity. That must NOT gate: a broken probe
  // locking a working user out of the whole app is a worse dead end than the one being prevented.
  it("a fail-open `recorded` yes is treated as ready", () => {
    expect(readinessStage(report(), auth(true, "recorded"))).toBe("ready");
  });

  // The genuine first-run case: no live answer AND nothing recorded. This one SHOULD gate — there is
  // nothing to lock the user out of, since they could not run an agent either.
  it("`absent` gates, because nobody has ever signed in on this machine", () => {
    expect(readinessStage(report(), auth(false, "absent"))).toBe("auth");
  });
});
