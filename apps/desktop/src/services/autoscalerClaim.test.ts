// THE WIRE SHAPE OF AN AUTOSCALER CLAIM, PINNED TO THE RUST SOURCE THAT PRODUCES IT — plus the
// three-state discipline this module could quietly undo.
//
// ══ WHY THE CASING HALF EXISTS ═════════════════════════════════════════════════════════════════
// `autoscaler_claim.rs`'s `BeadClaim` carries `#[serde(rename_all = "camelCase")]`. The sibling
// lease declared the same fields in SNAKE case on the TS side and, because every one of them was
// optional, NOTHING failed: three mechanisms went inert in production behind a green suite, and the
// test written to prove one worked passed only because its hand-written fixture was snake_case too
// (`sparkle-rk0k8o`). Reading the Rust declaration is the cheapest instrument that cannot be wrong
// in the same direction as the code it checks.
//
// ══ WHY THE ID HALF EXISTS ═════════════════════════════════════════════════════════════════════
// The same lease then shipped a MINT whose ':', '/' and '#' its own Rust validator rejected: 49,381
// sweeps, zero dispatches, no log line (`sparkle-2hsrlz`). Hand-written ids on the Rust side, a
// stubbed `invoke` here, and neither suite ever saw the string production sends.
// `apps/desktop/shared/autoscaler-claim-id.fixture.json` is the ONE payload both halves parse.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, never `.pathname`: every worktree on this machine lives under a path containing
// a space, which a URL pathname percent-encodes into a directory that does not exist (AGENTS.md).
const RUST = readFileSync(
  fileURLToPath(new URL("../../src-tauri/src/autoscaler_claim.rs", import.meta.url)),
  "utf8",
);
const FIXTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../shared/autoscaler-claim-id.fixture.json", import.meta.url)),
    "utf8",
  ),
) as {
  beadIds: { id: string; why: string }[];
  claimantIds: { id: string; why: string }[];
  rejectedBeadIds: { id: string; why: string }[];
};

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock("../logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const {
  claimErrorOf,
  acquireBeadClaim,
  heartbeatBeadClaim,
  listAutoscalerClaims,
  mintAutoscalerClaimantId,
  releaseBeadClaim,
  _resetAutoscalerClaimantIdForTests,
} = await import("./autoscalerClaim");

/** The `BeadClaim` declaration and its serde attributes, as source text. */
function claimDecl(): string {
  const i = RUST.indexOf("pub struct BeadClaim {");
  expect(i, "BeadClaim struct not found — did it move or get renamed?").toBeGreaterThan(-1);
  const start = RUST.lastIndexOf("#[derive", i);
  return RUST.slice(start, RUST.indexOf("\n}", i));
}

/** serde's camelCase of a snake_case field name. */
function camel(field: string): string {
  return field.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

describe("the autoscaler claim crosses the wire in camelCase", () => {
  it("the Rust struct still declares rename_all = camelCase", () => {
    // The whole reason the TS names above are camel. If this ever changes they must change WITH it,
    // and this assertion is what makes that a red test rather than six silent `undefined`s.
    expect(claimDecl()).toContain('rename_all = "camelCase"');
  });

  it("every field this module declares is emitted under the name it declares", () => {
    const decl = claimDecl();
    for (const rustField of [
      "bead_id",
      "claimant_id",
      "agent_id",
      "claimed_at_ms",
      "heartbeat_at_ms",
      "epoch",
    ]) {
      expect(decl, `Rust no longer declares ${rustField}`).toContain(`pub ${rustField}:`);
    }
    expect(camel("bead_id")).toBe("beadId");
    expect(camel("claimant_id")).toBe("claimantId");
    expect(camel("agent_id")).toBe("agentId");
    expect(camel("claimed_at_ms")).toBe("claimedAtMs");
    expect(camel("heartbeat_at_ms")).toBe("heartbeatAtMs");
  });

  it("agentId is an Option with NO skip_serializing_if, so it crosses as null and the TS type says so", () => {
    // A Rust `Option` without that attribute emits the KEY WITH A NULL VALUE. `agentId?: string`
    // would describe a shape the wire cannot produce (AGENTS.md's Rust-Option seam).
    const decl = claimDecl();
    expect(decl).toContain("pub agent_id: Option<String>");
    // The ATTRIBUTE, not the word: the field's own doc comment explains why that attribute is
    // absent, so a bare substring test matches the explanation and reds over correct code.
    expect(decl, "adding skip_serializing_if would make the key ABSENT, not null").not.toContain(
      "#[serde(skip_serializing_if",
    );
    const TS = readFileSync(fileURLToPath(new URL("./autoscalerClaim.ts", import.meta.url)), "utf8");
    expect(TS).toContain("agentId: string | null;");
  });

  it("the command names this module invokes are the ones Rust actually registers", () => {
    // A renamed command fails at RUNTIME inside a 60s timer, which is the least visible place for
    // it. `lib.rs` is what wires them up, so that is what is read.
    const LIB = readFileSync(
      fileURLToPath(new URL("../../src-tauri/src/lib.rs", import.meta.url)),
      "utf8",
    );
    for (const cmd of [
      "autoscaler_claim_acquire",
      "autoscaler_claim_heartbeat",
      "autoscaler_claim_release",
      "autoscaler_claims",
    ]) {
      expect(RUST, `Rust no longer defines ${cmd}`).toContain(`pub async fn ${cmd}(`);
      expect(LIB, `${cmd} is not in the invoke_handler`).toContain(`autoscaler_claim::${cmd},`);
    }
  });
});

describe("the claimant id this module mints", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    _resetAutoscalerClaimantIdForTests();
  });

  /** The SAME shape test the Rust `is_actor_id` applies. */
  const ACTOR_ID = /^[A-Za-z0-9_-]{1,128}$/;

  it("passes the shape the Rust validator enforces, so a claim is never silently `invalid`", () => {
    const id = mintAutoscalerClaimantId();
    expect(id, `the store would REFUSE ${id}`).toMatch(ACTOR_ID);
    // The exact production shape, pinned so a rewrite that reintroduces a slug or a timestamp
    // separator reds here rather than in a 60s timer nobody reads.
    expect(id).toMatch(/^autoscaler-[0-9a-f]{16}$/);
  });

  it("is stable for the life of the window — a claim you cannot renew is a claim you lose", () => {
    // Re-minting per call would make every heartbeat and every release read as a DIFFERENT
    // claimant, which the Rust side answers `lost`. The claim would then expire under a live agent
    // and the bead would be double-booked at the backstop.
    expect(mintAutoscalerClaimantId()).toBe(mintAutoscalerClaimantId());
  });

  it("every claimant id in the shared fixture — the payload Rust also validates — matches this shape", () => {
    expect(FIXTURE.claimantIds.length, "the fixture must carry the minted shapes").toBeGreaterThan(0);
    for (const c of FIXTURE.claimantIds) {
      expect(c.id, c.why).toMatch(ACTOR_ID);
      expect(c.id).toMatch(/^autoscaler-[0-9a-f]{16}$/);
    }
  });

  it("the fixture still carries the BEAD ids this module will really send, dotted child included", () => {
    // Only the CARRIAGE is checked here, never the rule: `is_bead_id` lives in Rust and the Rust
    // half feeds every one of these to it. Re-deriving that predicate in TypeScript would be a
    // second, slightly-wrong copy — and the two would then disagree about exactly the ids nobody
    // tests. What this side is uniquely placed to notice is the fixture going EMPTY, which would
    // make the Rust loops vacuously pass.
    expect(FIXTURE.beadIds.length, "an emptied fixture makes the Rust half vacuous").toBeGreaterThanOrEqual(4);
    expect(FIXTURE.rejectedBeadIds.length, "the rejection half must not be emptied either").toBeGreaterThan(0);
    expect(
      FIXTURE.beadIds.some((b) => b.id.includes(".")),
      "a DOTTED child bead is the common case here — an agent-id-shaped validator would reject it",
    ).toBe(true);
  });

  it("sends the bead id and the claimant id under the argument names Rust expects", () => {
    invokeMock.mockResolvedValue({ acquired: true });
    void acquireBeadClaim("sparkle-n2feho.10");
    expect(invokeMock).toHaveBeenCalledWith("autoscaler_claim_acquire", {
      beadId: "sparkle-n2feho.10",
      claimantId: mintAutoscalerClaimantId(),
    });
  });
});

describe("UNKNOWN never collapses into FREE across the wire", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    _resetAutoscalerClaimantIdForTests();
  });

  it("a rejected list is NOT an empty store — it reports unreadable", async () => {
    // `.catch(() => [])` here would report an unreadable store as "nothing is claimed", which is
    // the double-spawn the Rust module returns `Result` to prevent, laundered back in on this side.
    invokeMock.mockRejectedValue(new Error("backend is down"));
    const reading = await listAutoscalerClaims();
    expect(reading.readable).toBe(false);
    expect(reading.claims).toEqual([]);
  });

  it("a genuinely empty store IS readable — an authoritative zero is not a failure", async () => {
    // The opposite direction, and the one a fail-closed mistake breaks: if an empty array reported
    // unreadable, the autoscaler could never spawn its first agent on a fresh machine.
    invokeMock.mockResolvedValue([]);
    const reading = await listAutoscalerClaims();
    expect(reading.readable).toBe(true);
    expect(reading.claims).toEqual([]);
  });

  it("a non-array answer is unreadable, not empty", async () => {
    invokeMock.mockResolvedValue({ oops: true });
    expect((await listAutoscalerClaims()).readable).toBe(false);
  });

  it("a rejected acquire is UNKNOWN and names nobody — it never reports acquired", async () => {
    invokeMock.mockRejectedValue(new Error("store unreadable"));
    const out = await acquireBeadClaim("");
    expect(out.acquired).toBe(false);
    expect(out.reason).toBe("unknown");
    expect(out.heldBy, "unknown must not imply WHO holds it").toBeNull();
  });

  it("a refusal from Rust is passed through verbatim, reason and holder intact", async () => {
    const heldBy = {
      beadId: "",
      claimantId: "autoscaler-1111111111111111",
      agentId: "agent-7",
      claimedAtMs: 1,
      heartbeatAtMs: 2,
      epoch: "e",
    };
    invokeMock.mockResolvedValue({
      acquired: false,
      claim: null,
      heldBy,
      reason: "held-live",
      tookOver: false,
      previousHolder: null,
      detail: "already claimed",
    });
    const out = await acquireBeadClaim("");
    expect(out.reason).toBe("held-live");
    expect(out.heldBy?.claimantId).toBe("autoscaler-1111111111111111");
    expect(out.heldBy?.agentId).toBe("agent-7");
  });
});

describe("the typed refusal survives the wire — STOP and RETRY are opposite instructions", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    _resetAutoscalerClaimantIdForTests();
  });

  it("the TS reason vocabulary is exactly the CLAIM_ERR_* constants Rust defines", () => {
    // A second, slightly-wrong copy of a vocabulary is how the two halves come to disagree about
    // exactly the words nobody tests. Read the constants rather than restating them.
    const declared = [...RUST.matchAll(/pub const CLAIM_ERR_[A-Z]+: &str = (?:"([a-z-]+)"|(\w+))/g)].map(
      (m) => m[1] ?? m[2],
    );
    expect(declared.length, "the CLAIM_ERR_* block moved or was renamed").toBe(4);
    // `CLAIM_ERR_UNKNOWN` and `CLAIM_ERR_INVALID` alias the acquire-side constants, so resolve them.
    const resolved = new Set(
      declared.map((d) =>
        d === "REASON_UNKNOWN" ? "unknown" : d === "REASON_INVALID" ? "invalid" : d,
      ),
    );
    expect(resolved).toEqual(new Set(["lost", "absent", "unknown", "invalid"]));
  });

  it("parses each reason out of the rejected ClaimError object", () => {
    for (const reason of ["lost", "absent", "unknown", "invalid"] as const) {
      expect(claimErrorOf({ reason, message: "because" })).toEqual({ reason, message: "because" });
    }
  });

  it("an UNPARSEABLE rejection defaults to `unknown` — the RETRY word, never `lost`", () => {
    // The direction matters. `unknown` says ask again next pass; `lost` says we no longer hold the
    // claim. Defaulting to `lost` would abandon a live agent's claim on a rejection we could not
    // read, which ages the bead out and hands it to a second agent.
    expect(claimErrorOf(new Error("boom")).reason).toBe("unknown");
    expect(claimErrorOf("a bare string").reason).toBe("unknown");
    expect(claimErrorOf({ reason: "something-new", message: "m" }).reason).toBe("unknown");
    expect(claimErrorOf(null).reason).toBe("unknown");
  });

  it("keeps the message instead of stringifying the object into `[object Object]`", () => {
    // `String(e)` on a `{ reason, message }` object renders "[object Object]" and drops BOTH the
    // branchable word and the human explanation. The cited failure this design guards against is a
    // silently-always-`invalid` id with "not one log line naming the cause".
    expect(String({ reason: "invalid", message: "bad id" })).toBe("[object Object]");
    expect(claimErrorOf({ reason: "invalid", message: "bad id" }).message).toBe("bad id");
  });

  it("a heartbeat distinguishes a transient UNKNOWN from a real LOST", async () => {
    // THE DEFECT THIS REPLACES: both were `false`, and a caller told to stop on `false` would stop
    // renewing a live agent's claim over one momentarily-unreadable store — after which the claim
    // ages out at the backstop and a peer starts a second agent on a staffed bead.
    invokeMock.mockRejectedValueOnce({ reason: "unknown", message: "store locked" });
    const transient = await heartbeatBeadClaim("", "agent-1");
    expect(transient).toEqual({ ok: false, reason: "unknown", message: "store locked" });

    invokeMock.mockRejectedValueOnce({ reason: "lost", message: "taken over" });
    const lost = await heartbeatBeadClaim("", "agent-1");
    expect(lost.reason).toBe("lost");
    expect(lost.reason).not.toBe(transient.reason);
  });

  it("a release reports its reason too", async () => {
    invokeMock.mockRejectedValueOnce({ reason: "lost", message: "not yours" });
    expect(await releaseBeadClaim("")).toEqual({
      ok: false,
      reason: "lost",
      message: "not yours",
    });
  });

  it("the happy path carries no reason at all", async () => {
    invokeMock.mockResolvedValue(undefined);
    expect((await heartbeatBeadClaim("")).reason).toBeNull();
    expect((await releaseBeadClaim("")).reason).toBeNull();
  });
});

describe("heartbeat and release", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    _resetAutoscalerClaimantIdForTests();
  });

  it("a heartbeat carries the agent when there is one and an explicit null when there is not", async () => {
    invokeMock.mockResolvedValue(undefined);
    await heartbeatBeadClaim("", "agent-7");
    expect(invokeMock).toHaveBeenLastCalledWith("autoscaler_claim_heartbeat", {
      beadId: "",
      claimantId: mintAutoscalerClaimantId(),
      agentId: "agent-7",
    });
    await heartbeatBeadClaim("");
    expect(invokeMock).toHaveBeenLastCalledWith("autoscaler_claim_heartbeat", {
      beadId: "",
      claimantId: mintAutoscalerClaimantId(),
      agentId: null,
    });
  });

  it("a failed heartbeat RESOLVES rather than throwing out of the 60s timer", async () => {
    invokeMock.mockRejectedValue(new Error("lost"));
    await expect(heartbeatBeadClaim("")).resolves.toEqual({
      ok: false,
      reason: "unknown",
      message: "Error: lost",
    });
  });

  it("a failed release resolves rather than aborting the rest of the pass", async () => {
    // Every failure mode here is one the expiry backstop resolves on its own, so throwing would
    // cost the pass over its least consequential call.
    invokeMock.mockRejectedValue(new Error("nope"));
    await expect(releaseBeadClaim("")).resolves.toMatchObject({ ok: false });
  });
});
