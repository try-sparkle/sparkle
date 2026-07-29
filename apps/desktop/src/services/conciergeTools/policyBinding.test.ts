import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore";

import {
  APPROVAL_GRANT_TTL_MS,
  approveApproval,
  clearConciergeApprovals,
  denyApproval,
  findApproval,
  pendingApprovals,
  useConciergeApprovals,
} from "../../stores/conciergeApprovals";
import { useSettingsStore } from "../../stores/settingsStore";
import { conciergeToolAuthority } from "../dispatchAuthority";
import {
  appOpPolicy,
  configuredToolPolicy,
  readToolPolicyOverrides,
  toDispatchDecision,
} from "./policyBinding";


// The concierge's AI-enhancements gate (bead sparkle-4562) is a real precondition for a turn and
// for every tool call, so these suites — which test the mechanics, not the entitlement — open it
// explicitly. `aiGate.concierge.test.ts` is where the gate's own behaviour is asserted.
function openConciergeAiGate() {
  useSettingsStore.setState({ aiConcierge: true });
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
    creditFloorCents: 0,
  } as never);
}

/**
 * These tests exist for TWO claims:
 *
 *  1. the human's per-tool setting actually reaches the dispatch gate, and
 *  2. an `ask` tool is REACHABLE — a human can approve one specific call and only that call.
 *
 * The policy module, the ledger and the registry are each well covered on their own side. What
 * none of them can prove alone is that they are CONNECTED, and both halves fail silently: an
 * unwired policy fails OPEN (every tool permitted) while an unwired approval fails CLOSED (every
 * ask-tier tool permanently dead, which is what shipped). Every other suite stays green either way.
 */

const query = (op: string, write = true, args: unknown = {}, toolCallId = "call-1") => ({
  domain: "workspace" as const,
  op,
  write,
  toolCallId,
  args,
});

const pending = () => pendingApprovals(useConciergeApprovals.getState().entries);

describe("policy binding — the human's settings reach the dispatch gate", () => {
  beforeEach(() => {
    openConciergeAiGate();
    // Default to a BOOTED app; the unhydrated case gets its own tests below.
    useSettingsStore.setState({ conciergeToolPolicy: {}, conciergeToolPolicyHydrated: true });
    clearConciergeApprovals();
  });

  it("honours an explicit deny", () => {
    useSettingsStore.setState({ conciergeToolPolicy: { quit_app: "deny" }, conciergeToolPolicyHydrated: true });
    const d = configuredToolPolicy(query("quit_app"));
    expect(d.tier).toBe("deny");
    // And a denied decision must yield NO authority — the gate, not just the message.
    expect(conciergeToolAuthority("call-1", d)).toBeNull();
    // A denied tool must not put a question on the human's screen: `deny` is a standing answer, and
    // prompting anyway would be a way to talk a refusal into running.
    expect(pending()).toEqual([]);
  });

  it("honours an explicit allow on a tool that would otherwise default to ask", () => {
    const beforeOverride = configuredToolPolicy(query("remove_project"));
    expect(beforeOverride.tier).toBe("ask");

    useSettingsStore.setState({ conciergeToolPolicy: { remove_project: "allow" }, conciergeToolPolicyHydrated: true });
    const after = configuredToolPolicy(query("remove_project"));
    expect(after.tier).toBe("allow");
    expect(conciergeToolAuthority("call-1", after)).not.toBeNull();
  });

  it("turns `ask` into a decision that grants no authority until a human approves", () => {
    useSettingsStore.setState({ conciergeToolPolicy: { list_projects: "ask" }, conciergeToolPolicyHydrated: true });
    const d = configuredToolPolicy(query("list_projects", false));
    expect(d).toEqual({ tier: "ask", approvedByUser: false });
    // THE POINT: "check with me first" must not act on its own. If a future refactor makes this
    // default to approved, an ask-marked tool would run unasked — the exact failure the per-tool
    // policy exists to prevent.
    expect(conciergeToolAuthority("call-1", d)).toBeNull();
  });

  it("fails CLOSED on a tool name the policy layer does not classify", () => {
    const d = configuredToolPolicy(query("definitely_not_a_real_tool"));
    expect(d.tier).toBe("deny");
    expect(conciergeToolAuthority("call-1", d)).toBeNull();
  });

  it("resolves an unreadable override to ask, never to the tool's default", () => {
    // A hand-edited config.toml with a typo must not silently grant the derived default.
    useSettingsStore.setState({ conciergeToolPolicy: { list_projects: "yes-please" }, conciergeToolPolicyHydrated: true });
    const d = configuredToolPolicy(query("list_projects", false));
    expect(d.tier).toBe("ask");
  });

  it("degrades safely when the store slice is missing entirely", () => {
    // Deliberately corrupting the slice: a store shape we never expect must not throw into the
    // dispatch path, and must not resolve to `allow`.
    useSettingsStore.setState({
      conciergeToolPolicy: undefined as never,
      conciergeToolPolicyHydrated: true,
    });
    expect(readToolPolicyOverrides()).toEqual({ overrides: {}, hydrated: true });
    // A risky tool still defaults to ask, so a failed read cannot widen authority.
    expect(configuredToolPolicy(query("remove_project")).tier).toBe("ask");
  });

  // -------------------------------------------------------------------------------------------
  // THE ROUND-TRIP. Without this, every tool set to "Ask first" is permanently unreachable and the
  // refusal promises a prompt that does not exist.
  // -------------------------------------------------------------------------------------------

  describe("the approval round-trip", () => {
    it("raises a question the human can actually see, quoting the policy layer's own words", () => {
      configuredToolPolicy(query("remove_project", true, { projectId: "p1", confirm: true }));
      const [entry] = pending();
      expect(entry).toBeDefined();
      expect(entry!.id).toBe("call-1");
      expect(entry!.op).toBe("remove_project");
      expect(entry!.domain).toBe("workspace");
      expect(entry!.riskClass).toBe("irreversible");
      // Straight out of policy.ts's CONCIERGE_RISK_NOTE — no second description written by hand.
      expect(entry!.riskNote).toBe("Permanently destroys something that cannot be recovered.");
      // And the settings path, so "stop asking me" is discoverable from the prompt itself.
      expect(entry!.configPath).toBe("concierge.tools.remove_project");
      // The arguments, so the human is approving a verb WITH an object.
      expect(entry!.args).toEqual([
        { key: "projectId", value: "p1" },
        { key: "confirm", value: "true" },
      ]);
    });

    it("reports approvedByUser TRUE once — and only once — after a human approves", () => {
      const q = query("remove_project", true, { projectId: "p1" });
      expect(configuredToolPolicy(q)).toEqual({ tier: "ask", approvedByUser: false });

      approveApproval("call-1");

      const approved = configuredToolPolicy(q);
      expect(approved).toEqual({ tier: "ask", approvedByUser: true, approvedForToolCallId: "call-1" });
      expect(conciergeToolAuthority("call-1", approved)).toEqual({
        kind: "concierge-tool",
        toolCallId: "call-1",
        policy: "approved",
      });
      // Single use. "Approve this removal" is not "may always remove projects".
      const spent = configuredToolPolicy(q);
      expect(spent).toEqual({ tier: "ask", approvedByUser: false });
    });

    it("MARKS a repeat inside the grant window instead of asking as if it were new", () => {
      // A spent grant still inside its window means the call already ran (approving dispatches
      // immediately — services/conciergeApprovalResume). The model does not know that, so it can ask
      // again; the card must SAY so, or the human answers an identical-looking question and the op
      // runs twice.
      const q = query("remove_project", true, { projectId: "p1" });
      configuredToolPolicy(q);
      approveApproval("call-1");
      configuredToolPolicy(q); // spends it

      configuredToolPolicy(query("remove_project", true, { projectId: "p1" }, "call-2"));
      expect(findApproval("call-2")?.ranRecently).toBe(true);
    });

    it("does NOT lock the repeat out — the human can still say yes", () => {
      // An earlier version refused these outright while telling the human to "ask again if you did
      // mean to do it twice", which produced the same fingerprint and the same refusal — a remedy
      // that did not exist (roborev 54729, finding 1). A deliberate repeat must stay reachable.
      const q = query("remove_project", true, { projectId: "p1" });
      configuredToolPolicy(q);
      approveApproval("call-1");
      configuredToolPolicy(q);

      configuredToolPolicy(query("remove_project", true, { projectId: "p1" }, "call-2"));
      approveApproval("call-2");
      expect(
        configuredToolPolicy(query("remove_project", true, { projectId: "p1" }, "call-3")),
      ).toEqual({ tier: "ask", approvedByUser: true, approvedForToolCallId: "call-3" });
    });

    it("shows ONE live question when the same call is asked twice before anyone answers", () => {
      // Ids are minted per call and claimApproval authorises each by id, so two identical PENDING
      // cards would mean two approvals and two runs for one intention (roborev 54729, finding 2).
      configuredToolPolicy(query("remove_project", true, { projectId: "p1" }, "call-1"));
      configuredToolPolicy(query("remove_project", true, { projectId: "p1" }, "call-2"));
      expect(pendingApprovals()).toHaveLength(1);
      expect(findApproval("call-2")).toBeUndefined();
    });

    it("stops marking once the spent grant's window has passed", () => {
      const q = query("remove_project", true, { projectId: "p1" });
      configuredToolPolicy(q);
      approveApproval("call-1");
      configuredToolPolicy(q); // spends it

      // Past APPROVAL_GRANT_TTL_MS the entry is no longer live, so a repeat reads as a fresh
      // intention and is put back in front of the human rather than being refused forever.
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.now() + APPROVAL_GRANT_TTL_MS + 1_000);
        expect(
          configuredToolPolicy(query("remove_project", true, { projectId: "p1" }, "call-later")),
        ).toEqual({
          tier: "ask",
          approvedByUser: false,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    // The concierge is one `claude -p` process per turn, so the approval has to outlive the turn
    // that asked. The MCP server mints a FRESH toolCallId per call, so the retry arrives under a
    // different id — this is the case an id-only ledger could never serve.
    it("lets the NEXT turn's retry spend the approval under a fresh toolCallId", () => {
      const args = { projectId: "p1" };
      configuredToolPolicy(query("remove_project", true, args, "call-1"));
      approveApproval("call-1");

      const retry = configuredToolPolicy(query("remove_project", true, args, "call-2-fresh"));
      // Bound to the RETRY's id — the approval travels by identity, but the authority it mints is
      // still pinned to the one call that spends it.
      expect(retry).toEqual({
        tier: "ask",
        approvedByUser: true,
        approvedForToolCallId: "call-2-fresh",
      });
    });

    it("refuses a retry that quietly changed the arguments", () => {
      configuredToolPolicy(query("remove_project", true, { projectId: "p1" }, "call-1"));
      approveApproval("call-1");
      // Approved: remove p1. Attempted: remove p2. The approval names the call, not the verb.
      const other = configuredToolPolicy(
        query("remove_project", true, { projectId: "p2" }, "call-2"),
      );
      expect(other).toEqual({ tier: "ask", approvedByUser: false });
    });

    it("refuses a retry of a DIFFERENT ask-tier op", () => {
      configuredToolPolicy(query("remove_project", true, { projectId: "p1" }, "call-1"));
      approveApproval("call-1");
      const other = configuredToolPolicy(query("quit_app", true, { projectId: "p1" }, "call-2"));
      expect(other).toEqual({ tier: "ask", approvedByUser: false });
    });

    it("honours a DECLINE, and a retry cannot route around it", () => {
      const args = { projectId: "p1" };
      configuredToolPolicy(query("remove_project", true, args, "call-1"));
      denyApproval("call-1");
      expect(configuredToolPolicy(query("remove_project", true, args, "call-1"))).toEqual({
        tier: "ask",
        approvedByUser: false,
      });
      expect(configuredToolPolicy(query("remove_project", true, args, "call-2"))).toEqual({
        tier: "ask",
        approvedByUser: false,
      });
    });

    it("never treats the MODEL's own confirm flag as consent", () => {
      // `confirm: true` and DISCARD_CONFIRM_TOKEN arrive inside the model's tool arguments. If the
      // gate honoured them the model could approve itself, which is the confused deputy
      // dispatchAuthority exists to prevent.
      const d = configuredToolPolicy(
        query("remove_project", true, { projectId: "p1", confirm: true }),
      );
      expect(d).toEqual({ tier: "ask", approvedByUser: false });
      expect(conciergeToolAuthority("call-1", d)).toBeNull();
    });

    it("cannot raise or spend an approval for a call with no tool-call id", () => {
      const d = configuredToolPolicy(query("remove_project", true, { projectId: "p1" }, ""));
      expect(d).toEqual({ tier: "ask", approvedByUser: false });
      // Nothing to attribute an approval to, so nothing is put on the human's screen either.
      expect(pending()).toEqual([]);
    });

    it("does not duplicate the prompt when the model re-calls the same id", () => {
      const q = query("remove_project", true, { projectId: "p1" });
      configuredToolPolicy(q);
      configuredToolPolicy(q);
      configuredToolPolicy(q);
      expect(pending()).toHaveLength(1);
    });
  });

  // The original sparkle-control ops (roborev 54226, finding 1). Before this, the concierge cleared
  // `callerMayAdminister` outright and could run every one of them with no policy at all — and its
  // input is a snapshot of untrusted TERMINAL output, so that was a prompt-injection path straight
  // into machine-wide config.
  describe("the app domain — the legacy control ops", () => {
    it("does not let the concierge write global config silently", () => {
      const d = appOpPolicy("set_config");
      expect(d).toEqual({ tier: "ask", approvedByUser: false });
    });

    it("still lets it do the routine UI things without nagging", () => {
      // A concierge that must ask before it can put you where the work is would be switched off.
      for (const op of ["navigate", "set_theme", "set_zoom", "unpin_agent", "set_agent_model"]) {
        expect(appOpPolicy(op), op).toEqual({ tier: "allow" });
      }
      expect(appOpPolicy("get_state")).toEqual({ tier: "allow" });
    });

    it("has no row for a RETIRED op", () => {
      // `pin_agent` and `set_agent_ordering` refuse unconditionally and are not registered in the
      // MCP server. Classifying them would put dead rows in the settings pane for tools that can
      // never run (roborev 54255, finding 4). They are exempt from the gate in controlListener, so
      // they keep returning their own "was removed" explanation.
      expect(appOpPolicy("pin_agent").tier).toBe("deny");
      expect(appOpPolicy("set_agent_ordering").tier).toBe("deny");
    });

    it("lets the human deny a control op outright", () => {
      useSettingsStore.setState({ conciergeToolPolicy: { navigate: "deny" }, conciergeToolPolicyHydrated: true });
      expect(appOpPolicy("navigate").tier).toBe("deny");
    });

    it("lets the human opt INTO silent config writes", () => {
      useSettingsStore.setState({ conciergeToolPolicy: { set_config: "allow" }, conciergeToolPolicyHydrated: true });
      expect(appOpPolicy("set_config")).toEqual({ tier: "allow" });
    });

    it("fails closed on an op it has never heard of", () => {
      expect(appOpPolicy("set_everything").tier).toBe("deny");
    });

    it("is approvable per-write once the caller supplies the Rust-minted request id", () => {
      const ctx = { requestId: "req-1", args: { path: "workflow.require_pr", value: false } };
      expect(appOpPolicy("set_config", ctx)).toEqual({ tier: "ask", approvedByUser: false });
      const [entry] = pending();
      expect(entry!.domain).toBe("app");
      expect(entry!.summary).toBe("Write Sparkle's machine-wide configuration.");
      expect(entry!.args).toEqual([
        { key: "path", value: "workflow.require_pr" },
        { key: "value", value: "false" },
      ]);

      approveApproval("req-1");
      expect(appOpPolicy("set_config", ctx)).toEqual({
        tier: "ask",
        approvedByUser: true,
        approvedForToolCallId: "req-1",
      });
      // Approving ONE config write does not approve the next one.
      expect(
        appOpPolicy("set_config", {
          requestId: "req-2",
          args: { path: "workflow.require_pr", value: true },
        }),
      ).toEqual({ tier: "ask", approvedByUser: false });
    });

    it("keeps the app domain distinct from a same-named tool domain op", () => {
      appOpPolicy("set_config", { requestId: "req-1", args: {} });
      approveApproval("req-1");
      expect(findApproval("req-1")?.fingerprint.startsWith("app.set_config")).toBe(true);
    });

    it("raises nothing at all when the caller has no request id to attribute it to", () => {
      expect(appOpPolicy("set_config")).toEqual({ tier: "ask", approvedByUser: false });
      expect(pending()).toEqual([]);
    });
  });

  // roborev 54247, finding 3: `conciergeToolPolicy` is config-mirrored and NOT persisted, so it is
  // an empty map on every boot until hydrateFromConfig runs. During that window a tool the human
  // set to `deny` is indistinguishable from one they never touched.
  describe("before the human's rules have been read", () => {
    beforeEach(() => {
    openConciergeAiGate();
      useSettingsStore.setState({ conciergeToolPolicy: {}, conciergeToolPolicyHydrated: false });
    });

    it("does not assume a write tool is allowed", () => {
      // `navigate` is `allow` by default on a booted app — but we cannot know the human didn't
      // deny it, so it is held rather than run.
      const d = appOpPolicy("navigate");
      expect(d.tier).toBe("deny");
      // A HOLD is not an ASK: it must not put a question on the human's screen. "We haven't read
      // your config yet" is a transient condition to retry, not something to adjudicate.
      expect(pending()).toEqual([]);
      expect(d).toMatchObject({ reason: expect.stringContaining("hasn't finished loading") });
      expect(configuredToolPolicy(query("close_agent")).tier).not.toBe("allow");
    });

    it("still permits pure reads, which cannot change anything", () => {
      // Holding these too would leave the concierge unable to look at the roster during startup,
      // for no safety gain.
      expect(appOpPolicy("get_state")).toEqual({ tier: "allow" });
      expect(configuredToolPolicy(query("list_projects", false))).toEqual({ tier: "allow" });
    });

    // roborev 54260, finding 1 (High). The hold is only defensible because it is BRIEF. The launch
    // path is `getConfig().then(hydrate).catch(warn)` — no retry, no timeout — so a failed config
    // read would keep the flag false for the whole session and permanently refuse navigate,
    // rename_agent, close_agent and every other useful tool, recoverable only by restarting.
    it("does not stay held forever when the config read FAILED", () => {
      expect(appOpPolicy("navigate").tier).toBe("deny"); // held, pre-settle

      // What App.tsx's catch branch does: a read that failed IS an answer — no rules we can see.
      useSettingsStore.getState().markConciergeToolPolicySettled();

      expect(appOpPolicy("navigate")).toEqual({ tier: "allow" });
      // And it fails toward the DEFAULTS, not toward blanket permission: risky tools still ask.
      expect(appOpPolicy("set_config").tier).toBe("ask");
    });

    it("never undoes a real hydrate that lands after a transient failure", () => {
      useSettingsStore.setState({
        conciergeToolPolicy: { navigate: "deny" },
        conciergeToolPolicyHydrated: true,
      });
      useSettingsStore.getState().markConciergeToolPolicySettled();
      // The human's loaded rule must survive — settling is not a reset.
      expect(useSettingsStore.getState().conciergeToolPolicy).toEqual({ navigate: "deny" });
      expect(appOpPolicy("navigate").tier).toBe("deny");
    });

    it("keeps an explicit deny a deny", () => {
      useSettingsStore.setState({
        conciergeToolPolicy: { navigate: "deny" },
        conciergeToolPolicyHydrated: false,
      });
      expect(appOpPolicy("navigate").tier).toBe("deny");
    });
  });

  // roborev 54240: whether the human is consulted before their running agent is killed must not
  // depend on which domain file the op happens to live in.
  it("asks before stopping work in flight, whichever domain owns the op", () => {
    for (const op of ["close_agent", "spin_down_worker", "stop_project_agents"]) {
      expect(configuredToolPolicy(query(op)).tier, op).toBe("ask");
    }
    // The one workspace op that takes a filesystem path from the model and gives it standing.
    expect(configuredToolPolicy(query("add_project_from_folder")).tier).toBe("ask");
    // Genuinely routine work is still silent — the point is calibration, not blanket caution.
    expect(configuredToolPolicy(query("spawn_build_agent")).tier).toBe("allow");
    expect(configuredToolPolicy(query("preview_close")).tier).toBe("allow");
  });

  it("maps decisions without inventing an approval", () => {
    expect(toDispatchDecision("allow", "r")).toEqual({ tier: "allow" });
    expect(toDispatchDecision("deny", "r")).toEqual({ tier: "deny", reason: "r" });
    // PURE. It has no way to reach the ledger, so it cannot produce an approval by accident.
    expect(toDispatchDecision("ask", "r")).toEqual({ tier: "ask", approvedByUser: false });
  });
});
