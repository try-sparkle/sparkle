import { beforeEach, describe, expect, it } from "vitest";

import { useAuthStore } from "../../stores/authStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { clearConciergeApprovals, pendingApprovals, useConciergeApprovals } from "../../stores/conciergeApprovals";
import { conciergeToolAuthority } from "../dispatchAuthority";
import { evaluateToolPolicy, NO_TOOL_POLICY_OVERRIDES } from "./policy";
import { appOpPolicy, conciergeAiEnabled, configuredToolPolicy } from "./policyBinding";

/**
 * THE AI-ENHANCEMENTS GATE (bead sparkle-4562).
 *
 * The concierge's two expensive halves — the `claude -p` turn behind the chat and the whole tool
 * surface it drives — are available only when AI enhancements are live. Its STATUS readout is not
 * gated: that is derived from local app state and costs nothing, so a build with enhancements off
 * still tells the human what needs them.
 *
 * The case most likely to rot is the OPEN-SOURCE build, because nobody runs it in CI: someone
 * compiles from the public mirror, gets no Sparkle backend and therefore no signed-in `me`, and the
 * concierge must decline cleanly rather than spawn a paid child or half-work. It is covered here as
 * a first-class case rather than left to be inferred from the signed-out one.
 */

const query = (op: string, write = true) => ({
  domain: "workspace" as const,
  op,
  write,
  toolCallId: "call-1",
  args: {},
});

const pending = () => pendingApprovals(useConciergeApprovals.getState().entries);

/** A signed-in human with credits: the gate is open. */
function enhancementsOn() {
  useSettingsStore.setState({
    aiConcierge: true,
    conciergeToolPolicy: {},
    conciergeToolPolicyHydrated: true,
  });
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
    creditFloorCents: 0,
  } as never);
}

describe("the AI-enhancements gate on the concierge tool surface", () => {
  beforeEach(() => {
    clearConciergeApprovals();
    enhancementsOn();
  });

  it("is open for a signed-in user with credits and the feature on", () => {
    expect(conciergeAiEnabled()).toBe(true);
    expect(configuredToolPolicy(query("list_projects", false))).toEqual({ tier: "allow" });
  });

  it("refuses EVERY tool when the human turns the feature off", () => {
    useSettingsStore.setState({ aiConcierge: false });
    expect(conciergeAiEnabled()).toBe(false);

    // Across domains, and regardless of how the tool would otherwise resolve.
    for (const op of ["list_projects", "spawn_build_agent", "merge_pr", "quit_app"]) {
      const d = configuredToolPolicy(query(op));
      expect(d.tier, op).toBe("deny");
      expect(conciergeToolAuthority("call-1", d), op).toBeNull();
    }
    // The legacy control ops go through the same gate.
    expect(appOpPolicy("navigate").tier).toBe("deny");
  });

  // REVERSED with the move to the user's own Claude Code subscription. The concierge turn spends
  // no Sparkle money now (concierge.rs shells out to their authenticated `claude`), so a zero
  // Sparkle balance cannot be what decides whether it may run — and with the vendor key retired it
  // would be a gate no top-up could satisfy. The FLAG still gates it (asserted above).
  it("runs on a zero credit balance — the concierge spends the user's own subscription", () => {
    useAuthStore.setState({
      me: { clerkUserId: "u1", entitled: true, balanceCents: 0, tokenVersion: 1 },
    } as never);
    expect(conciergeAiEnabled()).toBe(true);
    expect(configuredToolPolicy(query("list_projects", false)).tier).not.toBe("deny");
  });

  // THE OPEN-SOURCE BUILD. No Sparkle backend, so no `me` ever arrives — neither entitlement nor a
  // credit balance — and the concierge still declines. The VERDICT is unchanged; what changed is the
  // REASON, and it is worth being precise about which gate is doing the work now: it is the paywall,
  // not the old credit check. An entitled user sitting at a zero balance now gets the concierge
  // (asserted above), because the turn runs on their own Claude Code subscription and costs Sparkle
  // nothing. One rule still covers all three refusal cases; it is just a different rule.
  it("refuses in a build with no Sparkle backend (no signed-in user at all)", () => {
    useAuthStore.setState({ me: null } as never);
    expect(conciergeAiEnabled()).toBe(false);
    expect(configuredToolPolicy(query("spawn_build_agent")).tier).toBe("deny");
  });

  it("says ONE thing, not fifty — the reason names the gate, not the tool", () => {
    useSettingsStore.setState({ aiConcierge: false });
    const e = evaluateToolPolicy("merge_pr", {
      overrides: NO_TOOL_POLICY_OVERRIDES,
      aiEnabled: false,
    });
    expect(e.source).toBe("ai-disabled");
    expect(e.reason).toMatch(/AI enhancements are off/);
    // A settings pane can therefore render one banner and grey the rows, rather than repeating a
    // per-tool error nobody can act on individually.
    expect(e.decision).toBe("deny");
  });

  it("does not put an approval prompt on screen for a gated tool", () => {
    useSettingsStore.setState({ aiConcierge: false });
    // `merge_pr` is ask-tier when the gate is open. With it shut there is nothing to approve —
    // asking the human to authorise a call that cannot run would be a prompt with no good answer.
    configuredToolPolicy(query("merge_pr"));
    expect(pending()).toEqual([]);
  });

  it("PRESERVES the human's saved rules while the gate is shut", () => {
    useSettingsStore.setState({
      aiConcierge: false,
      conciergeToolPolicy: { merge_pr: "allow" },
      conciergeToolPolicyHydrated: true,
    });
    const e = evaluateToolPolicy("merge_pr", {
      overrides: { merge_pr: "allow" },
      aiEnabled: false,
    });
    // Refused because of the gate — but the rule they set is still recorded, so turning
    // enhancements back on restores their configuration rather than silently resetting it.
    expect(e.decision).toBe("deny");
    expect(e.source).toBe("ai-disabled");
    expect(e.overridden).toBe(true);
    expect(useSettingsStore.getState().conciergeToolPolicy).toEqual({ merge_pr: "allow" });
  });

  it("still reports the tool's risk class while gated, so the pane can render a full row", () => {
    const e = evaluateToolPolicy("discard_agent", {
      overrides: NO_TOOL_POLICY_OVERRIDES,
      aiEnabled: false,
    });
    expect(e.riskClass).toBe("irreversible");
    expect(e.domain).toBe("lifecycle");
    expect(e.defaultDecision).toBe("ask");
  });

  it("defaults to ON when no gate is supplied, so existing callers keep their meaning", () => {
    const e = evaluateToolPolicy("list_projects", { overrides: NO_TOOL_POLICY_OVERRIDES });
    expect(e.source).not.toBe("ai-disabled");
    expect(e.decision).toBe("allow");
  });
});
