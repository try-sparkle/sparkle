// @vitest-environment jsdom
//
// THE PUBLISH DOMAIN THROUGH THE REAL SPINE — registry dispatch, the human's real per-tool config,
// the real approval ledger, and the real approval REPLAY path (bead `sparkle-131ms.6`).
//
// `publish.test.ts` covers the domain's own guards. This file exists for the three claims none of
// those can make, because each of them is about a CONNECTION and each fails silently:
//
//   1. THE MUTATION ANCHOR. With `[concierge.tools] publish_update_draft = "allow"` — the human's
//      own standing yes, the strictest thing an override can be — and a post whose SERVER
//      visibility is public, `dispatchConciergeTool` must still refuse with `post-is-live` and the
//      message must NAME `publish_update_live`. That test goes red if the host visibility check is
//      deleted, which is the only thing making the op split a gate rather than a suggestion.
//   2. THE APPROVAL ROUND TRIP ACTUALLY CLOSES. `publish` is a REGISTRY domain, not a control op,
//      and `conciergeApprovalResume.isReplayable` is literally
//      `CONCIERGE_TOOL_DOMAINS.includes(entry.domain)` — which omits `chief` and `app`. Following
//      the Chief pattern would have made `publish_go_live` approvable and never runnable, and
//      nothing but an end-to-end approve-then-replay test can see that.
//   3. THE WINDOW-2 RE-CHECK IS ON THE REPLAY PATH. Asserted specifically there, not on the first
//      call: `resumeApprovedCall` bypasses `policyBinding` entirely, so a check placed in the
//      policy binding would fire on the refused call and never on the one that publishes.
import { beforeEach, describe, expect, it, vi } from "vitest";

type ToolFn = (args: Record<string, unknown>) => string;
const tools = new Map<string, ToolFn>();
const calls: { tool: string; args: Record<string, unknown> }[] = [];

const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  if (cmd === "get_config") {
    return {
      config: {
        publish: {
          active: "drodio",
          destinations: {
            drodio: {
              name: "drodio.com",
              url: "https://drodio.com/api/mcp",
              has_credential_in_keychain: true,
            },
          },
        },
      },
      warnings: [],
    };
  }
  if (cmd === "destination_call_tool") {
    const tool = args.tool as string;
    calls.push({ tool, args: (args.args ?? {}) as Record<string, unknown> });
    const fn = tools.get(tool);
    if (!fn) throw new Error(`no such tool ${tool}`);
    return fn((args.args ?? {}) as Record<string, unknown>);
  }
  return undefined;
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string, Record<string, unknown>])),
}));
// `bd` is not available in a unit test, and the registry's import graph reaches the spawn path.
vi.mock("../tasks", () => ({ createBeadFull: vi.fn(async () => "bd-new") }));

import { useAuthStore } from "../../stores/authStore";
import { useSettingsStore } from "../../stores/settingsStore";
import {
  approveApproval,
  clearConciergeApprovals,
  findApproval,
} from "../../stores/conciergeApprovals";
import { resumeApprovedCall, isReplayable } from "../conciergeApprovalResume";
import { configuredToolPolicy } from "./policyBinding";
import { CONCIERGE_TOOL_DOMAINS, dispatchConciergeTool } from "./registry";
import { clearPublishSnapshots } from "./publish";

/** The concierge's AI-enhancements gate is a real precondition for every tool call; these tests are
 *  about the mechanics, not the entitlement, so they open it explicitly (as policyBinding.test.ts
 *  does). */
function openConciergeAiGate(): void {
  useSettingsStore.setState({ aiConcierge: true });
  useAuthStore.setState({
    me: { clerkUserId: "u1", entitled: true, balanceCents: 5_000, tokenVersion: 1 },
    creditFloorCents: 0,
  } as never);
}

function post(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "p1",
    title: "A post",
    bodyMarkdown: "the body",
    visibility: "draft",
    updatedAt: "2026-08-20T00:00:00Z",
    url: "https://drodio.com/p/a-post",
    ...over,
  };
}

function serve(initial: Record<string, unknown> = post()): { current: Record<string, unknown> } {
  const state = { current: initial };
  tools.set("get_content", () => JSON.stringify(state.current));
  tools.set("update_content", (a) => {
    const { contentId, ...fields } = a;
    void contentId;
    state.current = { ...state.current, ...fields, updatedAt: "2026-08-20T01:00:00Z" };
    return JSON.stringify(state.current);
  });
  tools.set("publish_content", () => {
    state.current = { ...state.current, visibility: "public" };
    return JSON.stringify(state.current);
  });
  return state;
}

const call = (op: string, args: unknown, toolCallId: string) => ({
  domain: "publish",
  op,
  args,
  toolCallId,
});

const wrote = () => calls.filter((c) => c.tool === "update_content");
const published = () => calls.filter((c) => c.tool === "publish_content");

/** The registry + the real bound policy — the two halves whose CONNECTION is under test. The
 *  receipt and audit sinks are stubbed because they are orthogonal to that connection and standing
 *  them up would make a failure in either read as a failure here. */
const resumeDeps = () => ({
  dispatch: dispatchConciergeTool,
  policy: configuredToolPolicy,
  settleReceipt: vi.fn(),
  noteAudit: () => () => {},
});

beforeEach(() => {
  tools.clear();
  calls.length = 0;
  invoke.mockClear();
  clearPublishSnapshots();
  clearConciergeApprovals();
  openConciergeAiGate();
  useSettingsStore.setState({ conciergeToolPolicy: {}, conciergeToolPolicyHydrated: true });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1. THE MUTATION ANCHOR
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("an explicit Allow on publish_update_draft does NOT reach a live post", () => {
  it("refuses `post-is-live`, names publish_update_live, and never writes", async () => {
    useSettingsStore.setState({
      conciergeToolPolicy: { publish_update_draft: "allow" },
      conciergeToolPolicyHydrated: true,
    });
    const state = serve(post({ visibility: "public", bodyMarkdown: "the live body" }));

    const reply = await dispatchConciergeTool(
      call("publish_update_draft", { contentId: "p1", bodyMarkdown: "rewritten" }, "c1"),
      { policy: configuredToolPolicy },
    );

    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error("unreachable");
    expect(reply.code).toBe("post-is-live");
    expect(reply.message).toContain("publish_update_live");
    // THE SIDE EFFECT: the live post was not touched.
    expect(wrote()).toHaveLength(0);
    expect(state.current.bodyMarkdown).toBe("the live body");
  });

  // THE PAIR. Without this, the refusal above is satisfied by a dispatch that refuses everything —
  // an unrelated earlier gate (the AI gate, the policy, the schema) short-circuiting the path.
  it("but DOES write through the same config when the post is a draft", async () => {
    useSettingsStore.setState({
      conciergeToolPolicy: { publish_update_draft: "allow" },
      conciergeToolPolicyHydrated: true,
    });
    const state = serve(post({ visibility: "draft" }));

    const reply = await dispatchConciergeTool(
      call("publish_update_draft", { contentId: "p1", bodyMarkdown: "rewritten" }, "c1"),
      { policy: configuredToolPolicy },
    );

    expect(reply.ok).toBe(true);
    expect(wrote()).toHaveLength(1);
    expect(state.current.bodyMarkdown).toBe("rewritten");
  });

  it("refuses an unrecognised extra field before anything reaches the destination", async () => {
    serve(post({ visibility: "draft" }));

    const reply = await dispatchConciergeTool(
      call("publish_update_draft", { contentId: "p1", visibility: "public" }, "c1"),
      { policy: configuredToolPolicy },
    );

    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error("unreachable");
    // A MODEL MUST NOT BE ABLE TO SEND `visibility` AT ALL. `update_content` cannot change
    // visibility server-side, and forwarding an unrecognised field to a network peer that publishes
    // is exactly what `.strict()` is for.
    expect(reply.code).toBe("bad-args");
    expect(calls).toHaveLength(0);
  });

  it("refuses an edit that names no field to change", async () => {
    serve(post({ visibility: "draft" }));
    const reply = await dispatchConciergeTool(
      call("publish_update_draft", { contentId: "p1" }, "c1"),
      { policy: configuredToolPolicy },
    );
    expect(reply.ok).toBe(false);
    if (reply.ok) throw new Error("unreachable");
    expect(reply.code).toBe("bad-args");
    expect(calls).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2. THE APPROVAL ROUND TRIP CLOSES — the reason this is a registry domain
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("publish_go_live is approvable AND runnable", () => {
  it("is replayable, which a control-op domain would not be", () => {
    expect(CONCIERGE_TOOL_DOMAINS as readonly string[]).toContain("publish");
    expect(isReplayable({ domain: "publish" })).toBe(true);
    // The contrast that makes the point: these two ARE in the settings catalog and are NOT
    // replayable, so an approved one is never run from the click.
    expect(isReplayable({ domain: "chief" })).toBe(false);
    expect(isReplayable({ domain: "app" })).toBe(false);
  });

  it("asks first, then RUNS from the click — not from the model retyping the call", async () => {
    serve(post({ visibility: "draft" }));
    // The host reads the post first, which is what records the snapshot the card is stamped with.
    await dispatchConciergeTool(call("publish_get", { contentId: "p1" }, "c0"), {
      policy: configuredToolPolicy,
    });

    const asked = await dispatchConciergeTool(call("publish_go_live", { contentId: "p1" }, "c1"), {
      policy: configuredToolPolicy,
    });
    expect(asked.ok).toBe(false);
    if (asked.ok) throw new Error("unreachable");
    expect(asked.code).toBe("needs-approval");
    expect(published()).toHaveLength(0);

    const entry = findApproval("c1");
    expect(entry).toBeDefined();
    // THE SNAPSHOT WAS STAMPED AT RAISE — the "before" reading the replay re-checks against.
    expect(entry!.publishGuard).toMatchObject({ contentId: "p1", visibility: "draft" });

    expect(approveApproval("c1")).toBe(true);
    const outcome = await resumeApprovedCall(findApproval("c1")!, resumeDeps());

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") throw new Error("unreachable");
    expect(outcome.reply.ok).toBe(true);
    expect(published()).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3. WINDOW 2 — asserted on the REPLAY path, which is the only path that publishes
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("a post that moved between the card and the click", () => {
  it("refuses `post-changed-since-approval` ON THE REPLAY, and never publishes", async () => {
    const state = serve(post({ visibility: "draft" }));
    await dispatchConciergeTool(call("publish_get", { contentId: "p1" }, "c0"), {
      policy: configuredToolPolicy,
    });
    await dispatchConciergeTool(call("publish_go_live", { contentId: "p1" }, "c1"), {
      policy: configuredToolPolicy,
    });
    expect(findApproval("c1")!.publishGuard).toBeDefined();

    // The founder rewrote it on the web while the card sat in his column.
    state.current = { ...state.current, bodyMarkdown: "he rewrote it himself" };

    expect(approveApproval("c1")).toBe(true);
    const outcome = await resumeApprovedCall(findApproval("c1")!, resumeDeps());

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") throw new Error("unreachable");
    expect(outcome.reply.ok).toBe(false);
    if (outcome.reply.ok) throw new Error("unreachable");
    expect(outcome.reply.code).toBe("post-changed-since-approval");
    // THE SIDE EFFECT: the founder's own newer text was NOT published under an approval given for
    // text he wrote ten minutes earlier.
    expect(published()).toHaveLength(0);
    expect(state.current.visibility).toBe("draft");
  });

  it("refuses on the replay when the post was taken live in the meantime", async () => {
    const state = serve(post({ visibility: "draft" }));
    await dispatchConciergeTool(call("publish_get", { contentId: "p1" }, "c0"), {
      policy: configuredToolPolicy,
    });
    await dispatchConciergeTool(call("publish_go_live", { contentId: "p1" }, "c1"), {
      policy: configuredToolPolicy,
    });
    state.current = { ...state.current, visibility: "public" };

    approveApproval("c1");
    const outcome = await resumeApprovedCall(findApproval("c1")!, resumeDeps());

    expect(outcome.kind).toBe("ran");
    if (outcome.kind !== "ran") throw new Error("unreachable");
    expect(outcome.reply.ok).toBe(false);
    if (outcome.reply.ok) throw new Error("unreachable");
    expect(outcome.reply.code).toBe("post-changed-since-approval");
    expect(published()).toHaveLength(0);
  });
});
