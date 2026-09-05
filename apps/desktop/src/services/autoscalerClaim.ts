// autoscalerClaim — the TypeScript half of the backlog autoscaler's DURABLE CLAIM (Phase 3 of the
// never-idle epic `sparkle-n2feho`, bead `sparkle-n2feho.10`).
//
// ══ WHAT THIS IS FOR ════════════════════════════════════════════════════════════════════════════
// `backlogAutoscaler.ts` picks ONE next ready bead per pass and, when armed, starts an agent on it.
// Phase 2's de-duplication was a `Set<string>` in this module's own heap. A second Sparkle window
// runs its own module instance on its own 60s tick, and so does the same window after a restart, so
// that set cannot see a peer deciding on the same board a second later: two windows both select the
// top ready bead and both spawn. A duplicate here is two agents on two worktrees on two branches
// doing identical work, discovered at merge time.
//
// The lock itself lives in Rust (`src-tauri/src/autoscaler_claim.rs`) because it needs a real
// compare-and-set — a process mutex plus an advisory `flock` over an atomically-replaced file. This
// module is the wire, and its whole job is to keep the three-state discipline intact across it:
// FREE, HELD, and — the one that gets lost — UNKNOWN.
//
// ── UNKNOWN IS NOT FREE, AND THIS FILE IS WHERE IT WOULD BE LOST ────────────────────────────────
// `invoke` REJECTS on a backend error, and the tempting shape is `.catch(() => [])`. That turns "I
// could not read the claim store" into "nothing is claimed", which is precisely the double-spawn
// the Rust module refuses to allow — laundered back in on the TS side. So `listAutoscalerClaims`
// returns a READING with a `readable` flag rather than a bare array, and the sweep spawns nothing
// at all when it is false.
//
// ── WIRE CASING ─────────────────────────────────────────────────────────────────────────────────
// `BeadClaim` carries `#[serde(rename_all = "camelCase")]`, so the wire says `beadId` / `claimantId`
// / `agentId` / `claimedAtMs` / `heartbeatAtMs`. AGENTS.md's rule: a snake_case interface over that
// reads `undefined` for every field with NOTHING logged, and the sibling lease shipped exactly that
// for months (`sparkle-rk0k8o`). `autoscalerClaim.test.ts` reads the Rust source and pins it.
// `agentId` is a Rust `Option` with no `skip_serializing_if`, so it crosses as `null`, never as an
// absent key — hence `string | null`, not `agentId?: string`.
import { invoke } from "@tauri-apps/api/core";
import { log } from "../logger";

/** One window's claim on one bead, as `autoscaler_claim.rs` serializes it. */
export interface BeadClaim {
  beadId: string;
  /** The AUTOSCALER instance that holds it, not the agent it starts — the claim is taken before
   *  the spawn, so at acquire time there is no agent to name yet. */
  claimantId: string;
  /** The agent this claim was spent on, recorded by the first heartbeat after a successful spawn.
   *  `null` between acquire and that heartbeat, which is a real and short-lived state. */
  agentId: string | null;
  claimedAtMs: number;
  heartbeatAtMs: number;
  epoch: string;
}

/** Whether a stored claim still binds. Computed in Rust, in one place, and handed over. */
export type ClaimStanding = "live" | "dead-epoch" | "dead-stale";

export interface BeadClaimView {
  claim: BeadClaim;
  standing: ClaimStanding;
  heartbeatAgeMs: number;
}

/**
 * WHY AN ACQUIRE FAILED. Branched on, never substring-matched.
 *
 * `held-live` is the ordinary one-agent-per-bead outcome. `unknown` says the store could not be
 * read and the next 60s tick should ask again. `invalid` says these arguments will never be
 * accepted and retrying is a busy-loop — a different instruction, which is why it is a separate
 * value rather than a flavour of `unknown`.
 */
export type ClaimRefusal = "held-live" | "unknown" | "invalid";

/**
 * WHY A HEARTBEAT OR A RELEASE FAILED — the `CLAIM_ERR_*` vocabulary, carried across the wire
 * intact rather than flattened into a boolean.
 *
 * THE FLATTENING IS THE DEFECT, and it is worth spelling out because a `boolean` looks like the
 * obvious return type here. `lost` and `absent` mean STOP — somebody else holds this bead, or there
 * is nothing to renew. `unknown` means RETRY — the store was momentarily unreadable or the lock was
 * contended, and the next 60s pass is the right response. `invalid` means the call was malformed
 * and will never succeed as written. Rust goes to the trouble of making these branchable
 * (`autoscaler_claim.rs`, `LEASE`-style typed errors) precisely because "stop" and "retry" are
 * opposite instructions, and a wire that returns `false` for all four hands the caller one word for
 * both — which is the UNKNOWN-collapsed-into-a-known-state defect the list path exists to prevent,
 * reintroduced on renewal. A single transient `unknown` read as "stop renewing" leaves a claim
 * ageing out under a live agent, and thirty minutes later a peer takes it over and starts a SECOND
 * agent on a bead already staffed.
 */
export type ClaimErrorReason = "lost" | "absent" | "unknown" | "invalid";

/** One heartbeat or release attempt. `ok` is the happy path; `reason` is why not. */
export interface ClaimWriteResult {
  ok: boolean;
  /** `null` iff `ok`. */
  reason: ClaimErrorReason | null;
  /** The backend's elaboration, for the log. Never branched on. */
  message: string;
}

const CLAIM_ERROR_REASONS: readonly string[] = ["lost", "absent", "unknown", "invalid"];

/**
 * Read a rejected `invoke` as a typed `ClaimError`.
 *
 * `String(e)` is WRONG for these two commands and right for `acquire`: `autoscaler_claim_acquire`
 * returns `Result<_, String>`, so stringifying is faithful there, while heartbeat and release reject
 * with a `{ reason, message }` OBJECT — which `String()` renders as `"[object Object]"`, dropping
 * both the branchable word and the human explanation. The failure this whole design cites
 * (`sparkle-2hsrlz`) is a silently-always-`invalid` id with "not one log line naming the cause", and
 * `invalid` is exactly one of the reasons that would arrive here anonymised.
 *
 * AN UNPARSEABLE REJECTION DEFAULTS TO `unknown`, the RETRY word — never to `lost`. We could not
 * establish that we no longer hold the claim, and asserting that we do not is the direction that
 * abandons a live agent's claim.
 */
export function claimErrorOf(e: unknown): { reason: ClaimErrorReason; message: string } {
  if (typeof e === "object" && e !== null && "reason" in e) {
    const bag = e as Record<string, unknown>;
    const raw = bag["reason"];
    const message = typeof bag["message"] === "string" ? bag["message"] : "";
    if (typeof raw === "string" && CLAIM_ERROR_REASONS.includes(raw)) {
      return { reason: raw as ClaimErrorReason, message };
    }
    return { reason: "unknown", message: message === "" ? String(raw) : message };
  }
  return { reason: "unknown", message: String(e) };
}

export interface ClaimOutcome {
  acquired: boolean;
  claim: BeadClaim | null;
  /** Who holds it instead. `null` when acquired, AND `null` when the reason is `unknown` — we could
   *  not read the store, so we do not know who, and must not imply nobody. */
  heldBy: BeadClaim | null;
  reason: ClaimRefusal | null;
  tookOver: boolean;
  previousHolder: BeadClaim | null;
  detail: string | null;
}

/**
 * WHAT THE STORE SAYS RIGHT NOW — or that it could not be read.
 *
 * `readable: false` is not "no claims". It is the state in which the autoscaler must spawn nothing,
 * because a spawn issued against an unreadable claim store is a spawn that cannot know whether
 * another window is already on this bead.
 */
export interface BeadClaimsReading {
  readable: boolean;
  claims: readonly BeadClaimView[];
}

/**
 * THIS WINDOW'S CLAIMANT ID, minted once and reused for the life of the module instance.
 *
 * SHAPE MATTERS MORE THAN IT LOOKS. The Rust side validates every id against
 * `[A-Za-z0-9_-]{1,128}` and returns `invalid` for anything else — and the sibling babysit lease
 * shipped a mint whose `:`, `/` and `#` that same validator rejected, so its dispatcher ran 49,381
 * sweeps and dispatched nothing, with no log line naming the cause (`sparkle-2hsrlz`). A claim that
 * is silently always `invalid` is a spawner with NO de-duplication at all, which is worse than
 * having built none.
 *
 * So the id carries nothing user-controlled: a fixed prefix and 16 hex characters. There is no repo
 * slug, no timestamp with a colon in it, nothing that a board or a filesystem can put a character
 * into. `apps/desktop/shared/autoscaler-claim-id.fixture.json` pins this shape on BOTH sides.
 */
let claimantId: string | null = null;
export function mintAutoscalerClaimantId(): string {
  if (claimantId !== null) return claimantId;
  claimantId = `autoscaler-${randomHex16()}`;
  return claimantId;
}

/** 16 lowercase hex characters. `crypto` where it exists — every browser and every WebView this
 *  app ships in has it — and `Math.random` only so a test environment without one still mints a
 *  well-shaped id rather than throwing inside a 60s timer. */
function randomHex16(): string {
  const c = globalThis.crypto;
  if (c !== undefined && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(8));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let out = "";
  while (out.length < 16) out += Math.floor(Math.random() * 16).toString(16);
  return out.slice(0, 16);
}

/** Test seam: the mint memoizes for the life of the window, which would otherwise leak between
 *  cases. Not a production path. */
export function _resetAutoscalerClaimantIdForTests(): void {
  claimantId = null;
}

/**
 * TAKE THE CLAIM on `beadId`, or find out why not.
 *
 * NEVER THROWS. A rejected `invoke` becomes `reason: "unknown"` with `acquired: false`, because the
 * caller is a 60s timer and an exception there is indistinguishable from a refusal it must handle
 * anyway — and folding it into the typed vocabulary is what keeps the "unknown is not free" rule
 * true across the wire rather than only inside Rust.
 */
export async function acquireBeadClaim(beadId: string): Promise<ClaimOutcome> {
  try {
    return await invoke<ClaimOutcome>("autoscaler_claim_acquire", {
      beadId,
      claimantId: mintAutoscalerClaimantId(),
    });
  } catch (e) {
    log.warn("autoscaler-claim", "acquire failed — treating as UNKNOWN, not as a free bead", {
      bead: beadId,
      error: String(e),
    });
    return {
      acquired: false,
      claim: null,
      heldBy: null,
      reason: "unknown",
      tookOver: false,
      previousHolder: null,
      detail: String(e),
    };
  }
}

/**
 * REFRESH a claim we hold, and record the agent it was spent on.
 *
 * `agentId` is optional because the claim is taken BEFORE the spawn: the first renewal after a
 * successful spawn names the agent and every later one repeats it. Passing nothing refreshes
 * without disturbing an agent already recorded — it never clears one.
 *
 * RESOLVES THE REASON, NOT A BOOLEAN. `unknown` means renew again on the next pass — the store was
 * momentarily unreadable or its lock was contended, and neither is evidence we lost the claim.
 * `lost` and `absent` mean stop: somebody else holds this bead now, or there is nothing to renew.
 * Collapsing those into one `false` is what lets a single transient failure age a live agent's claim
 * out at the expiry backstop and hand its bead to a second agent.
 */
export async function heartbeatBeadClaim(
  beadId: string,
  agentId?: string,
): Promise<ClaimWriteResult> {
  try {
    await invoke("autoscaler_claim_heartbeat", {
      beadId,
      claimantId: mintAutoscalerClaimantId(),
      agentId: agentId ?? null,
    });
    return { ok: true, reason: null, message: "" };
  } catch (e) {
    const { reason, message } = claimErrorOf(e);
    log.info("autoscaler-claim", "heartbeat did not land", { bead: beadId, reason, message });
    return { ok: false, reason, message };
  }
}

/**
 * GIVE UP a claim. The normal end of a claim's life: the bead left the ready column, or the agent
 * we started on it is gone.
 *
 * NEVER THROWS. Every failure mode here (the store was unreadable, somebody else already holds it)
 * is one the expiry backstop resolves on its own, and a release that threw out of a 60s timer would
 * abort the rest of the pass over the least consequential call in it. The REASON is still returned
 * and logged rather than stringified away — a release that keeps failing `lost` says something
 * different from one failing `unknown`, and a log reading `[object Object]` says neither.
 */
export async function releaseBeadClaim(beadId: string): Promise<ClaimWriteResult> {
  try {
    await invoke("autoscaler_claim_release", { beadId, claimantId: mintAutoscalerClaimantId() });
    return { ok: true, reason: null, message: "" };
  } catch (e) {
    const { reason, message } = claimErrorOf(e);
    log.info("autoscaler-claim", "release did not land — the claim will expire instead", {
      bead: beadId,
      reason,
      message,
    });
    return { ok: false, reason, message };
  }
}

/**
 * EVERY STORED CLAIM, with its standing — or the fact that we could not look.
 *
 * The `readable` flag is the whole point of the return type. `.catch(() => [])` here would report
 * an unreadable store as an empty one, and the autoscaler would then spawn against a bead another
 * window may already hold. That is the exact defect the Rust module returns `Result` to prevent,
 * and this is the one place it could be quietly undone.
 */
export async function listAutoscalerClaims(): Promise<BeadClaimsReading> {
  try {
    const claims = await invoke<BeadClaimView[]>("autoscaler_claims");
    // A backend that answered with something other than an array is not evidence of an empty store.
    if (!Array.isArray(claims)) return { readable: false, claims: [] };
    return { readable: true, claims };
  } catch (e) {
    log.warn("autoscaler-claim", "claim store unreadable — the autoscaler will spawn nothing", {
      error: String(e),
    });
    return { readable: false, claims: [] };
  }
}
