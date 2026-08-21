// The PUBLISH domain, driven through its PRODUCTION seam (bead `sparkle-131ms.6`).
//
// EVERY REFUSAL TEST HERE ASSERTS THE SIDE EFFECT, NOT THE VERDICT: that `update_content` /
// `publish_content` was NEVER CALLED, not merely that `ok` came back false. AGENTS.md's #1
// fleet-wide finding is the vacuous test, and a refusal suite is the easiest place in this codebase
// to write one — `expect(res.ok).toBe(false)` passes for a function that refuses everything,
// including one whose guard has been deleted and which now fails for an unrelated reason.
//
// AND EVERY "IT REFUSES" TEST IS PAIRED WITH ONE PROVING THE SAME SETUP DOES REACH THE WRITE when
// the post really is a draft. One test proving absence is ambiguous — an earlier gate could be
// short-circuiting the path (bead `sparkle-rvf6n`, seen 6×) — and the pair is what pins the cause.
//
// THE HANDLERS RUN WITH THEIR DEFAULT DEPS (`LIVE_PUBLISH_DEPS`) over a mocked
// `@tauri-apps/api/core`, so the lines that wire `invoke` into the domain are themselves under
// test rather than replaced. That is the "defaulted seam" trap AGENTS.md records (bead
// `sparkle-lgbwf`, seen 4×): when every test injects its own `deps`, the production call site is
// covered by nothing and deleting it leaves the suite green.
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── A fake destination, stateful enough that a write can be OBSERVED ─────────────────────────────
//
// Keyed by tool name, returning the JSON text the Rust decoder would have handed back. `calls`
// records every tool that was actually invoked, which is what the refusal assertions read.
type ToolFn = (args: Record<string, unknown>) => string;
const tools = new Map<string, ToolFn>();
const calls: { tool: string; args: Record<string, unknown> }[] = [];

let publishSection: unknown = {
  active: "drodio",
  destinations: {
    drodio: { name: "drodio.com", url: "https://drodio.com/api/mcp", has_credential_in_keychain: true },
  },
};

const invoke = vi.fn(async (cmd: string, args: Record<string, unknown>) => {
  if (cmd === "get_config") return { config: { publish: publishSection }, warnings: [] };
  if (cmd === "destination_call_tool") {
    const tool = args.tool as string;
    calls.push({ tool, args: (args.args ?? {}) as Record<string, unknown> });
    const fn = tools.get(tool);
    // A missing entry stands for the destination REFUSING — which reaches the TS side as a
    // rejected `invoke`, because `publish_client.rs`'s decoder turns HTTP-200-plus-`isError` into a
    // typed `Err`. That is the ordinary failure path, so the fake has to reproduce it.
    if (!fn) throw new Error(`no such tool ${tool}`);
    return fn((args.args ?? {}) as Record<string, unknown>);
  }
  if (cmd === "destination_probe") {
    return {
      valid: true,
      missingRequired: [],
      presentOptional: ["unpublish_content"],
      missingOptional: [],
      argShapeProblems: [],
      affordances: ["project-picker", "take-down"],
    };
  }
  if (cmd === "destination_list_tools") return [{ name: "create_content", description: "", inputSchema: {} }];
  throw new Error(`unexpected command ${cmd}`);
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...a: unknown[]) => invoke(...(a as [string, Record<string, unknown>])),
}));

import {
  CONCIERGE_TOOL_CATALOG,
  DEFAULT_DECISION_BY_RISK,
  SUMMARY_BY_TOOL,
  defaultDecisionFor,
} from "./policy";
import {
  MAX_PUBLISH_TAGS,
  PUBLISH_OPS,
  PUBLISH_RISK,
  clearPublishSnapshots,
  contentHash,
  createDraft,
  describeDiff,
  diffSummary,
  getPost,
  goLive,
  guardApprovedCall,
  listDestinations,
  publishApprovalGuard,
  readPublishSnapshot,
  readVisibility,
  summarizePublishArgLines,
  takeDown,
  updateDraft,
  updateLive,
  type PublishOp,
} from "./publish";
import { clearConciergeApprovals, useConciergeApprovals } from "../../stores/conciergeApprovals";

/** A content object as the destination echoes it. */
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

/** Point the fake destination at a fixed post, and let `update_content`/`publish_content` mutate it
 *  the way the real endpoint does — so a write is observable in the NEXT read, not just in `calls`. */
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
  tools.set("unpublish_content", () => {
    state.current = { ...state.current, visibility: "draft" };
    return JSON.stringify(state.current);
  });
  tools.set("create_content", (a) => JSON.stringify({ ...post({ id: "p-new" }), ...a }));
  tools.set("list_projects", () => JSON.stringify({ projects: [{ id: "proj1", name: "Writing" }] }));
  tools.set("list_content", () => JSON.stringify({ content: [] }));
  return state;
}

const wrote = () => calls.filter((c) => c.tool === "update_content");
const published = () => calls.filter((c) => c.tool === "publish_content");

beforeEach(() => {
  tools.clear();
  calls.length = 0;
  invoke.mockClear();
  clearPublishSnapshots();
  clearConciergeApprovals();
  publishSection = {
    active: "drodio",
    destinations: {
      drodio: { name: "drodio.com", url: "https://drodio.com/api/mcp", has_credential_in_keychain: true },
    },
  };
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE POLARITY: prove it is a DRAFT, do not refuse if it looks public
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("readVisibility — every permissive path a naive check leaves open is closed", () => {
  it("accepts a known draft literal, case- and whitespace-insensitively", () => {
    expect(readVisibility({ visibility: "draft" })).toEqual({ ok: true, visibility: "draft" });
    expect(readVisibility({ visibility: "  DRAFT " })).toEqual({ ok: true, visibility: "draft" });
  });

  // EVERY ONE OF THESE IS A VALUE `if (visibility === "public") refuse` WOULD HAVE WAVED THROUGH.
  it.each(["public", "PUBLIC", "published", "live", "scheduled", "unlisted", "archived"])(
    "refuses %s as not-a-draft",
    (v) => {
      expect(readVisibility({ visibility: v })).toEqual({ ok: false, reason: "post-is-live", seen: v });
    },
  );

  it.each([
    ["a missing field", {}],
    ["null", { visibility: null }],
    ["a number", { visibility: 3 }],
    ["a renamed field", { status: "draft" }],
    ["an unknown literal", { visibility: "embargoed" }],
    ["not an object at all", "draft"],
  ])("refuses %s rather than guessing", (_label, input) => {
    const r = readVisibility(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unknown-visibility");
  });

  it("names what it saw, so whoever adds the next literal knows what to add", () => {
    const r = readVisibility({ visibility: "embargoed" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.seen).toBe("embargoed");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE HOST REFUSAL — the entire load-bearing member of the live-edit split
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("publish_update_draft refuses a post that is not provably a draft", () => {
  // THE PAIRED POSITIVE. Without it, every refusal below is satisfied by a function that refuses
  // unconditionally — or by an earlier gate short-circuiting the path before the check runs.
  it("DOES write when the post really is a draft", async () => {
    const state = serve(post({ visibility: "draft" }));

    const res = await updateDraft("p1", undefined, { bodyMarkdown: "a new body" });

    expect(res.ok).toBe(true);
    // THE SIDE EFFECT, not the verdict: the write reached the destination and changed the post.
    expect(wrote()).toHaveLength(1);
    expect(wrote()[0]!.args).toMatchObject({ contentId: "p1", bodyMarkdown: "a new body" });
    expect(state.current.bodyMarkdown).toBe("a new body");
  });

  it("refuses a LIVE post, names publish_update_live, and never writes", async () => {
    const state = serve(post({ visibility: "public", bodyMarkdown: "the live body" }));

    const res = await updateDraft("p1", undefined, { bodyMarkdown: "a new body" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("post-is-live");
    // NAMING THE GATED OP IS PART OF THE CONTRACT: a model that dead-ends here retries the same
    // call forever, while one told the gated name funnels into the approval card.
    expect(res.message).toContain("publish_update_live");
    // THE SIDE EFFECT: nothing was written, and the live post is untouched.
    expect(wrote()).toHaveLength(0);
    expect(state.current.bodyMarkdown).toBe("the live body");
  });

  it.each(["PUBLIC", "live", "scheduled", "unlisted", "archived"])(
    "refuses %s too — the literals a naive equality check misses — and never writes",
    async (visibility) => {
      serve(post({ visibility }));

      const res = await updateDraft("p1", undefined, { bodyMarkdown: "x" });

      expect(res.ok).toBe(false);
      expect(wrote()).toHaveLength(0);
    },
  );

  it("refuses an UNKNOWN literal, saying what it saw, and never writes", async () => {
    serve(post({ visibility: "embargoed" }));

    const res = await updateDraft("p1", undefined, { bodyMarkdown: "x" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("unknown-visibility");
    expect(res.message).toContain("embargoed");
    expect(wrote()).toHaveLength(0);
  });

  it("refuses a MISSING visibility field and never writes", async () => {
    serve(post());
    tools.set("get_content", () => JSON.stringify({ id: "p1", title: "t" }));

    const res = await updateDraft("p1", undefined, { bodyMarkdown: "x" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("unknown-visibility");
    expect(wrote()).toHaveLength(0);
  });

  // THE PERMISSIVE PATH THAT WILL ACTUALLY HAPPEN — a timeout, a 5xx, a revoked token.
  it("refuses when the LOOKUP FAILS, and never writes", async () => {
    serve(post());
    tools.delete("get_content");

    const res = await updateDraft("p1", undefined, { bodyMarkdown: "x" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("visibility-unreadable");
    expect(wrote()).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TOCTOU WINDOW 1 — read the update's own response back
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("window 1 — the post went public between the check and the write", () => {
  it("surfaces a LOUD notice with a revert offer rather than swallowing it", async () => {
    serve(post({ visibility: "draft", bodyMarkdown: "the original" }));
    // The echoed response says the post is live — the race this cannot prevent, only detect.
    tools.set("update_content", () =>
      JSON.stringify(post({ visibility: "public", bodyMarkdown: "a new body" })),
    );

    const res = await updateDraft("p1", undefined, { bodyMarkdown: "a new body" });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.notice).toContain("went public between my check and my write");
    // THE REVERT OFFER CARRIES THE PREVIOUS TEXT, so the concierge can offer it rather than telling
    // the human to reconstruct what was there.
    expect(res.data.revert).toEqual({
      contentId: "p1",
      op: "publish_update_live",
      title: "A post",
      bodyMarkdown: "the original",
    });
  });

  it("says nothing when the post was and stayed a draft", async () => {
    serve(post({ visibility: "draft" }));

    const res = await updateDraft("p1", undefined, { bodyMarkdown: "a new body" });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.notice).toBeUndefined();
    expect(res.data.revert).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE RECEIPT — settled from the DECODED result, never from "the call didn't throw"
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("publish_go_live settles from the decoded result", () => {
  it("reports the post live only when the answer says it IS", async () => {
    serve(post({ visibility: "draft" }));
    await getPost("p1", undefined); // the host snapshot the approval guard is built from

    const res = await goLive("p1", undefined, { toolCallId: "c1", tier: "allow" });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.visibility).toBe("public");
    expect(res.data.url).toBe("https://drodio.com/p/a-post");
    expect(published()).toHaveLength(1);
  });

  // THE `content:publish` SCOPE CASE, in the shape it actually arrives in: the call is accepted and
  // the post stays a draft. Reporting that as a publish tells the founder his post is live when it
  // is not — the single worst outcome this domain can produce.
  it("refuses `publish-unconfirmed` when the answer still reads as a draft", async () => {
    serve(post({ visibility: "draft" }));
    tools.set("publish_content", () => JSON.stringify(post({ visibility: "draft" })));

    const res = await goLive("p1", undefined, { toolCallId: "c1", tier: "allow" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("publish-unconfirmed");
    expect(res.message).toContain("content:publish");
  });

  it("refuses `publish-unconfirmed` when the answer's visibility is unreadable", async () => {
    serve(post({ visibility: "draft" }));
    tools.set("publish_content", () => JSON.stringify({ id: "p1", title: "t" }));

    const res = await goLive("p1", undefined, { toolCallId: "c1", tier: "allow" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("publish-unconfirmed");
  });

  // BELT TO THE RUST DECODER'S BRACES. Today the endpoint sets `isError` and the decoder rejects;
  // a destination that stopped doing so would otherwise have its failure read as a success.
  it("refuses an `{error, status}` payload that arrived WITHOUT isError", async () => {
    serve(post({ visibility: "draft" }));
    tools.set("publish_content", () => JSON.stringify({ error: "Unauthorized", status: 401 }));

    const res = await goLive("p1", undefined, { toolCallId: "c1", tier: "allow" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("destination-refused");
    expect(res.message).toContain("Unauthorized");
    expect(res.message).toContain("401");
  });

  it("refuses when the destination itself rejects the call", async () => {
    serve(post({ visibility: "draft" }));
    tools.delete("publish_content");

    const res = await goLive("p1", undefined, { toolCallId: "c1", tier: "allow" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("destination-refused");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// TOCTOU WINDOW 2 — the approval snapshot, re-checked at EXECUTION
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** Put an approved entry in the ledger the way the raise path would have, carrying the guard that
 *  `publishApprovalGuard` computed from the host's own snapshot. */
function seedApproval(id: string, guard: ReturnType<typeof publishApprovalGuard>): void {
  useConciergeApprovals.getState().replace([
    {
      id,
      domain: "publish",
      op: "publish_go_live",
      summary: "",
      riskClass: "irreversible",
      riskNote: "",
      args: [],
      rawArgs: { contentId: "p1" },
      configPath: "concierge.tools.publish_go_live",
      fingerprint: "f",
      ...(guard ? { publishGuard: guard } : {}),
      requestedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
      outcome: "approved",
      resolvedAt: 0,
      spent: true,
    },
  ]);
}

describe("window 2 — the post moved between the card and the click", () => {
  it("runs when nothing changed", async () => {
    serve(post({ visibility: "draft" }));
    await getPost("p1", undefined);
    seedApproval("c1", publishApprovalGuard("publish", "publish_go_live", { contentId: "p1" }));

    const res = await goLive("p1", undefined, { toolCallId: "c1", tier: "ask" });

    expect(res.ok).toBe(true);
    expect(published()).toHaveLength(1);
  });

  it("refuses `post-changed-since-approval` when the BODY changed, and never publishes", async () => {
    const state = serve(post({ visibility: "draft" }));
    await getPost("p1", undefined);
    const guard = publishApprovalGuard("publish", "publish_go_live", { contentId: "p1" });
    seedApproval("c1", guard);
    // The founder edited it on the web while the card sat there.
    state.current = { ...state.current, bodyMarkdown: "he rewrote it himself" };

    const res = await goLive("p1", undefined, { toolCallId: "c1", tier: "ask" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("post-changed-since-approval");
    expect(published()).toHaveLength(0);
  });

  it("refuses when the VISIBILITY changed — the card now overstates what would happen", async () => {
    const state = serve(post({ visibility: "draft" }));
    await getPost("p1", undefined);
    seedApproval("c1", publishApprovalGuard("publish", "publish_go_live", { contentId: "p1" }));
    state.current = { ...state.current, visibility: "public" };

    const res = await goLive("p1", undefined, { toolCallId: "c1", tier: "ask" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("post-changed-since-approval");
    expect(published()).toHaveLength(0);
  });

  it("refuses an approved call carrying NO snapshot — fail closed, never permission", async () => {
    serve(post({ visibility: "draft" }));
    seedApproval("c1", null);

    const res = await goLive("p1", undefined, { toolCallId: "c1", tier: "ask" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("unverified-since-approval");
    expect(published()).toHaveLength(0);
  });

  // THE `allow` CASE IS NOT A HOLE. With no card there is no ten-minute window for anything to
  // change in, so there is nothing to re-check — and requiring a snapshot there would break the
  // human's own explicit "Allow".
  it("does not require a snapshot when the human set the tool to Allow", () => {
    const snap = {
      destinationId: "drodio",
      contentId: "p1",
      visibility: "draft",
      updatedAt: "t",
      contentHash: contentHash("a", "b", "draft"),
      title: "a",
      body: "b",
      readAt: 0,
    };
    expect(guardApprovedCall("publish_go_live", { toolCallId: "c1", tier: "allow" }, snap)).toBeNull();
    expect(guardApprovedCall("publish_go_live", { toolCallId: "c1", tier: "ask" }, snap)).not.toBeNull();
  });

  it("covers take_down and update_live too, not only go_live", async () => {
    const state = serve(post({ visibility: "public" }));
    await getPost("p1", undefined);
    seedApproval("c1", publishApprovalGuard("publish", "publish_take_down", { contentId: "p1" }));
    state.current = { ...state.current, title: "renamed on the web" };

    const down = await takeDown("p1", undefined, { toolCallId: "c1", tier: "ask" });
    expect(down.ok).toBe(false);
    if (down.ok) throw new Error("unreachable");
    expect(down.reason).toBe("post-changed-since-approval");

    seedApproval("c2", publishApprovalGuard("publish", "publish_update_live", { contentId: "p1" }));
    state.current = { ...state.current, title: "renamed AGAIN" };
    const edit = await updateLive("p1", undefined, { bodyMarkdown: "x" }, { toolCallId: "c2", tier: "ask" });
    expect(edit.ok).toBe(false);
    if (edit.ok) throw new Error("unreachable");
    expect(edit.reason).toBe("post-changed-since-approval");
    expect(wrote()).toHaveLength(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CARD — a diff summary, not the first 220 characters of a post
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("the approval card shows what CHANGED", () => {
  it("computes the magnitude and the location of the change", () => {
    const d = diffSummary("hello world", "hello brave world");
    expect(d.firstChangeAt).toBe(6);
    expect(d.added).toBe(6);
    expect(d.wasNear).toContain("world");
    expect(d.nowNear).toContain("brave");
  });

  // A SAME-LENGTH REWRITE MUST NOT READ AS "NOTHING HAPPENED" — that is the one sentence this card
  // can least afford to print.
  it("reports a same-length rewrite as a change, not as zero", () => {
    const d = diffSummary("aaaa", "abba");
    expect(d.firstChangeAt).toBe(1);
    expect(d.added).toBeGreaterThan(0);
    expect(d.removed).toBeGreaterThan(0);
  });

  it("says so when the body is unchanged", () => {
    expect(describeDiff(diffSummary("same", "same"))).toBe("the body is unchanged");
  });

  it("replaces the raw body arg line with the summary, leaving every other line alone", async () => {
    serve(post({ visibility: "public", bodyMarkdown: "the original body" }));
    await getPost("p1", undefined);
    const guard = publishApprovalGuard("publish", "publish_update_live", {
      contentId: "p1",
      bodyMarkdown: "a completely different body, much longer than the original one",
    });

    const lines = summarizePublishArgLines(
      [
        { key: "contentId", value: "p1" },
        { key: "bodyMarkdown", value: "a completely different body, much…" },
      ],
      guard,
    );

    expect(lines[0]).toEqual({ key: "contentId", value: "p1" });
    expect(lines[1]!.key).toBe("bodyMarkdown");
    expect(lines[1]!.value).toContain("chars, first change at");
  });

  it("leaves every line alone for a non-publish call", () => {
    const lines = [{ key: "text", value: "hello" }];
    expect(summarizePublishArgLines(lines, null)).toBe(lines);
  });

  it("stamps nothing for a call this app has never read the post for", () => {
    expect(publishApprovalGuard("publish", "publish_go_live", { contentId: "never-read" })).toBeNull();
    expect(publishApprovalGuard("workflow", "merge_pr", { contentId: "p1" })).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// SNAPSHOTS — taken by the HOST, from responses the host decoded
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("host snapshots", () => {
  it("are recorded by a read", async () => {
    serve(post({ visibility: "draft" }));
    await getPost("p1", undefined);
    expect(readPublishSnapshot("drodio", "p1")).toMatchObject({ visibility: "draft", title: "A post" });
  });

  // WHY THE NATURAL COMPOSE LOOP ALWAYS HAS ONE: `create_content` echoes the object, so a draft
  // created and then published never needs the model to remember to read it back.
  it("are recorded by a CREATE, so create → go live needs no extra round trip", async () => {
    serve();
    const res = await createDraft(undefined, { title: "New", projectId: "proj1" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(readPublishSnapshot("drodio", res.data.contentId)).toBeDefined();
  });

  it("refuse a create whose answer carries no id — an un-editable post is not a success", async () => {
    serve();
    tools.set("create_content", () => JSON.stringify({ ok: true }));
    const res = await createDraft(undefined, { title: "New", projectId: "proj1" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("unreadable-response");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// DESTINATIONS — refuse rather than guess
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("destination resolution", () => {
  it("lists what is configured without touching the network", async () => {
    const res = await listDestinations();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(res.data.active).toBe("drodio");
    expect(res.data.destinations).toEqual([
      {
        id: "drodio",
        name: "drodio.com",
        url: "https://drodio.com/api/mcp",
        hasCredential: true,
        active: true,
      },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("refuses when nothing is configured", async () => {
    publishSection = { active: null, destinations: {} };
    const res = await getPost("p1", undefined);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("no-destination");
    expect(calls).toHaveLength(0);
  });

  // The config's own doc: with more than one row and no stated choice, an app that picks one is
  // publishing to a site nobody named.
  it("refuses to guess between two destinations with none active", async () => {
    publishSection = {
      active: null,
      destinations: {
        a: { name: "A", url: "https://a.test/mcp", has_credential_in_keychain: true },
        b: { name: "B", url: "https://b.test/mcp", has_credential_in_keychain: true },
      },
    };
    const res = await getPost("p1", undefined);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("no-destination");
    expect(calls).toHaveLength(0);
  });

  it("refuses a NAMED destination that is not configured", async () => {
    const res = await getPost("p1", "somewhere-else");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("no-destination");
    expect(res.message).toContain("somewhere-else");
  });

  // A BACKEND WITHOUT `[publish]` MUST READ AS "CAN PUBLISH NOWHERE", never as "find a destination".
  it("refuses when the backend sent no [publish] section at all", async () => {
    publishSection = undefined;
    const res = await getPost("p1", undefined);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("no-destination");
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE CLASSIFICATION — and why each row's WORD is load-bearing rather than decorative
// ═════════════════════════════════════════════════════════════════════════════════════════════

describe("the policy catalog", () => {
  // `SUMMARY_BY_TOOL` is `Partial<>`, so a missing row is SILENT: `entryFor` falls back to the risk
  // note and the row survives having merely lost its words. For the two public acts the fallback is
  // "Permanently destroys something that cannot be recovered", which describes deletion — the wrong
  // headline on a card asking whether a model may post to the founder's public site.
  it.each(PUBLISH_OPS)("%s has its own summary, and it reaches the catalog verbatim", (op) => {
    const summary = SUMMARY_BY_TOOL[op];
    expect(summary, `${op} has no SUMMARY_BY_TOOL row`).toBeTruthy();
    const entry = CONCIERGE_TOOL_CATALOG.find((t) => t.name === op);
    expect(entry?.summary).toBe(summary);
  });

  it("puts every publish op in the Publishing domain, and nowhere else", () => {
    for (const op of PUBLISH_OPS) {
      expect(CONCIERGE_TOOL_CATALOG.find((t) => t.name === op)?.domain).toBe("publish");
    }
  });

  // DERIVED, never hand-listed: the decisions come from the risk word through
  // `DEFAULT_DECISION_BY_RISK`, so an unclassified op is a typecheck failure by construction.
  it.each([
    ["publish_list_destinations", "allow"],
    ["publish_probe", "allow"],
    ["publish_list_projects", "allow"],
    ["publish_get", "allow"],
    ["publish_list", "allow"],
    ["publish_create_draft", "allow"],
    ["publish_update_draft", "allow"],
    ["publish_update_live", "ask"],
    ["publish_go_live", "ask"],
    ["publish_take_down", "ask"],
  ] as const)("%s derives to %s", (op, decision) => {
    expect(defaultDecisionFor(op)).toBe(decision);
    expect(DEFAULT_DECISION_BY_RISK[PUBLISH_RISK[op as PublishOp] as never]).toBe(decision);
  });

  // ⚠️ THE MECHANICAL REASON THE TWO PUBLIC ACTS ARE `irreversible` AND NOT `outward-facing`.
  // `ConciergeToolsPane` derives its bulk-allow warning by filtering the CATALOG on
  // `riskClass === "irreversible"` — it reads `outward-facing` NOWHERE. So an `outward-facing`
  // publish op is invisible to the one dialog that exists to name what a single click hands over,
  // and one stray Enter would grant unprompted publishing of the founder's public site. This test
  // asserts the pane's OWN derivation, not the risk map, so re-classing these rows goes red here.
  it("makes the two public acts visible to the bulk-allow dialog's named warnings", () => {
    const named = CONCIERGE_TOOL_CATALOG.filter((t) => t.riskClass === "irreversible").map(
      (t) => t.name as string,
    );
    expect(named).toContain("publish_update_live");
    expect(named).toContain("publish_go_live");
  });

  // The user-facing copy the approval card renders. Publishing is the third case, and the sentence
  // used to name only the two git ones — so a publish approval would have described posting to a
  // public site as "a pull request".
  it("no longer describes reaching the outside world as only a push or a pull request", () => {
    const entry = CONCIERGE_TOOL_CATALOG.find((t) => t.riskClass === "outward-facing");
    expect(entry?.summary ?? "").not.toBe("Reaches the outside world (a push or a pull request).");
  });

  it("caps tags where the destination does", () => {
    expect(MAX_PUBLISH_TAGS).toBe(12);
  });
});
