// The PUBLISH domain — the concierge's reach OUT of Sparkle, onto the founder's own public site
// (epic `sparkle-131ms`, bead `sparkle-131ms.6`; closes `sparkle-8swuls`, "the publish MCP client
// is dead code, no agent can reach it").
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE COMPOSE SURFACE IS THE CONCIERGE CHAT. There is no compose UI.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Confirmed by the founder 2026-08-13: a post is written by TALKING to the concierge, which
// gathers the structure fields, creates a draft, hands back the destination's own preview URL, and
// iterates. Everything here is that loop's backend.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE DESTINATION MCP IS NEVER MERGED INTO THE CONCIERGE'S `--mcp-config`.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// It would be the obvious shape and it is the one that cannot be gated. `--allowedTools` does NOT
// gate MCP tools (measured against Claude Code 2.1.220; recorded at `src-tauri/src/concierge.rs`
// lines 56-68), so merging the destination's server into the concierge's config would make
// `publish_content` model-reachable with NO gate at all — the founder's public site, one tool call
// away, with nothing in front of it. Every call in this file goes through a host-side Tauri command
// instead, where the app-side policy gate in `controlListener.dispatch` is the real gate.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS IS A REGISTRY DISPATCH DOMAIN, NOT A CONTROL OP — and that is a SAFETY decision.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// The written design said to follow the Chief pattern (a `chief_call`-style control op). Verified
// on `origin/main`, that pattern would make an approved publish APPROVABLE AND NEVER RUNNABLE:
// `conciergeApprovalResume.ts`'s `isReplayable` is `CONCIERGE_TOOL_DOMAINS.includes(entry.domain)`,
// and `registry.ts`'s `CONCIERGE_TOOL_DOMAINS` omits `chief` and `app`. So an approved CONTROL op
// is never replayed — the grant just sits there and the MODEL has to retype every argument
// byte-identically inside `APPROVAL_GRANT_TTL_MS` (5 minutes) to match `approvalFingerprint`. For a
// multi-paragraph post body that is not a hard case, it is an impossible one.
//
// So `publish` is wired into `registry.ts`, and as a registry domain it needs no `policyBinding.ts`
// change at all. That is the point.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE TWO PUBLIC ACTS ARE `irreversible` AND NOT `outward-facing`.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// It is defensible on the merits — a published URL is scraped, RSS'd and archived within seconds,
// and `unpublish_content` does not un-send that. But the LOAD-BEARING reason is mechanical.
// `components/ConciergeToolsPane.tsx:230` derives `IRREVERSIBLE_TOOLS` from
// `riskClass === "irreversible"` and `:252` derives `PRIVACY_TOOLS` from `"privacy-sensitive"`.
// **Nothing reads `outward-facing`.** An `outward-facing` publish op is therefore INVISIBLE to the
// bulk-allow dialog's named warnings, so one stray Enter on that dialog's primary button would hand
// the model unprompted publishing of the founder's public site while the dialog named only agent
// teardown. Classing it `irreversible` earns the warning by construction — the same by-construction
// blindness that made `search_history`'s and `chief_call`'s floors necessary (roborev 61894-H1,
// 63041).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE LIVE-EDIT SPLIT, AND THE ONE THING THAT MAKES IT A GATE.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Visibility is SERVER state, not a tool argument, so a static risk table cannot see it. Hence two
// ops over one destination verb: `publish_update_draft` (`routine`, auto-allowed) and
// `publish_update_live` (`irreversible`, asks).
//
// `PER_CALL_RISK`/`perCallRiskFor` cannot do this and the reason is worth recording, because it is
// the first thing a reader will propose. `perCallRiskFor` is a pure SYNCHRONOUS function of
// model-supplied arguments — `policy.ts` advertises "reads no store, calls no network", and
// `evaluateToolPolicy` is synchronous — so an async `get_content` cannot live there. The
// alternatives are worse: reading a store from `policy.ts` breaks its stated contract, and a STALE
// CACHED visibility is worse than none; trusting a model-supplied `visibility` argument is the model
// approving itself, which that file forbids twice.
//
// ⚠️ THE HOST REFUSAL IN {@link updateDraft} IS THE ENTIRE LOAD-BEARING MEMBER OF THIS SPLIT. Do not
// delete it as belt-and-braces. `policy.ts` objects to op-splitting in general and it is right to:
// of `search_history` it says a gated sibling "would key off the name again … but the model chooses
// which tool it calls, so the gate would be exactly as strong as the model's willingness to pick the
// gated name, i.e. not a gate." The split here survives that objection ONLY because choosing the
// cheap name against a live post is REFUSED BY THE HOST. Take the refusal out and the model's choice
// widens its own authority, and this file becomes decoration.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PROVE IT IS A DRAFT. Do not refuse if it looks public.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// A naive `if (visibility === "public") refuse` ALLOWS on `"PUBLIC"`, `"live"`, `"scheduled"`,
// `"unlisted"`, `"archived"`, `null`, a missing field, a RENAMED field, and — worst — a FAILED
// LOOKUP. Every one of those errs permissive, and the failed lookup is the one that will actually
// happen. {@link readVisibility} therefore refuses unless the value parses into a closed `Draft`
// variant from a known literal; an unknown literal refuses NAMING WHAT IT SAW, and a lookup error or
// timeout refuses.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// TWO TOCTOU WINDOWS. One is unclosable; the other is on the approval REPLAY path.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// WINDOW 1 — `get_content` → `update_content`. UNCLOSABLE CLIENT-SIDE, and this file does not
// pretend otherwise: the verified tool list has no `expectedVisibility`, no `If-Match` and no
// version precondition. **Asking the endpoint owner to add `expectedVisibility` to `update_content`
// is the only true fix, and it is a DEPENDENCY of this work, not a nice-to-have** (recorded in
// `PRD/sparkle/publish-concierge-domain.md`). What is done here instead, in order of value:
// (ii) the visibility is read inside the SAME host call immediately before the write, never carried
// across a turn; (iii) the update's OWN response — which echoes the content object, so this costs
// zero extra round trips — is read back, and a mismatch is surfaced as a LOUD notice with a revert
// offer rather than being swallowed.
//
// WINDOW 2 — the approval replay path, and it is the bigger one. `APPROVAL_REQUEST_TTL_MS` is TEN
// MINUTES (`stores/conciergeApprovals.ts:75`) and `conciergeApprovalResume` replays `rawArgs`
// VERBATIM, matching by id, so the grant authorises unconditionally. In those ten minutes the post
// can be unpublished (the card now overstates what is about to happen) or edited by the founder on
// the web (the approved text silently clobbers work the human never saw). So a snapshot of
// `{visibility, updatedAt, contentHash}` is stamped onto the approval at RAISE time
// ({@link publishApprovalGuard}) and re-checked at EXECUTION ({@link guardApprovedCall}), refusing
// with a named `post-changed-since-approval`.
//
// ⚠️ THE RE-CHECK IS IN THE DOMAIN HANDLER, NOT IN `policyBinding`/`resolveAskTier`. The handler runs
// on BOTH entry points; anything in the policy binding is BYPASSED by the resume path
// (`resumeApprovedCall` goes straight to `dispatchConciergeTool`, whose ask-tier branch is satisfied
// by the claim). Checking only at raise time is a silent hole by construction.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE CARD WILL TRUNCATE THE POST, AND FOR THIS OP CLASS THE HUMAN'S READING *IS* THE GATE.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `ARG_VALUE_MAX_CHARS` is 220 (`stores/conciergeApprovals.ts:93`). Approving a live-post edit while
// seeing the first 220 characters of a new body is consent to something unread. So the raise path
// computes a DIFF SUMMARY ({@link summarizePublishArgLines}) and shows that instead of the raw body:
// how much was added and removed, and where the change starts.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// SETTLE THE RECEIPT FROM THE DECODED RESULT, NEVER FROM "THE CALL DIDN'T THROW".
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// `publish_content` needs the `content:publish` scope, which `content:write` does NOT imply.
// Without it the failure arrives as HTTP 200 + `isError: true` with the real status buried in a JSON
// STRING inside `content[0].text`. `src-tauri/src/publish_client.rs`'s `decode_tool_result` turns
// that into a typed `Err`, so an `invoke` rejection is the ordinary failure path here — but
// {@link callDestinationTool} ALSO refuses a decoded body that parses to an `{error, status}`
// object, because a destination that stops setting `isError` must not read as a successful publish.
// And {@link goLive} refuses to report a post as published unless the echoed content object parses
// into a PUBLIC visibility variant: the same closed-literal discipline as the draft proof, in the
// other direction.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS NOT.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// Nothing here touches `engine/social.ts`, `services/socialApi.ts`, `stores/socialStore.ts` or
// `ChatSection.tsx`. That is SOCIAL CODING — user-to-user chat inside Sparkle behind
// `SOCIAL_ENABLED`, with no posting, no destination and no outward path. The build plan names the
// overlap in naming as "the single most likely way this build goes wrong".
import { invoke } from "@tauri-apps/api/core";

import { getConfig } from "../config";
import { findApproval } from "../../stores/conciergeApprovals";
import type { ApprovalArgLine } from "../../stores/conciergeApprovals";

// ---------------------------------------------------------------------------------------------
// The capability shapes — OWNED BY `services/publishCapabilities.ts` (peer bead `sparkle-131ms.5`)
// ---------------------------------------------------------------------------------------------

/**
 * The probe's answers, declared here ONLY until `services/publishCapabilities.ts` lands.
 *
 * That module is a peer's (bead `sparkle-131ms.5`) and is cut after this branch, so these
 * declarations exist so this file can typecheck before the merge; the orchestrator reconciles them
 * at merge time by deleting this block and importing from there. They are re-exported below so
 * every reader in this branch already has ONE import site to re-point.
 *
 * ⚠️ EVERY FIELD IS TOTAL — no `?:` and no `| null` beyond what Rust's own `Option` produces. That
 * is deliberate and it is the seam AGENTS.md warns about: serde's derive emits the KEY WITH A `null`
 * VALUE for `Option::None` and omits it only under `skip_serializing_if`, while TypeScript's
 * `field?: T` means `T | undefined`, which does not include `null`. A `field?: T` parser therefore
 * describes a shape the wire CANNOT PRODUCE — and an all-or-nothing parser that rejects one field
 * discards the whole payload and falls back to its "we did not look" default, silently, forever.
 * None of these fields is a Rust `Option`, so none of them is optional here.
 */
// RE-EXPORTED, NOT REDECLARED. These three types describe the wire shape of
// `publish_capabilities.rs`, and `services/publishCapabilities.ts` is where that shape is written
// down — it is generated against the same Rust structs and carries the field-by-field notes.
//
// This file declared its own copies while the two halves were built in parallel (the capability
// module did not exist in this worktree yet). Two hand-written copies of ONE wire shape is exactly
// the seam AGENTS.md warns about: they agree today, they drift on the first edit, and the failure
// is SILENT — an all-or-nothing parser that rejects one field discards the whole payload and falls
// back to its "we did not look" default, forever, with nothing logged. One declaration, one place
// to change.
//
// `export type { … } from` alone re-exports the names WITHOUT binding them in this module's own
// scope, so the annotations below stop resolving. Import them as well — the import is what this
// file uses, the re-export is what its existing consumers keep importing from here.
import type {
  PublishAffordance,
  DestinationCapabilities,
  ToolDescriptorDto,
} from "../publishCapabilities";

export type { PublishAffordance, DestinationCapabilities, ToolDescriptorDto };

// ---------------------------------------------------------------------------------------------
// The operation surface
// ---------------------------------------------------------------------------------------------

/**
 * Every publish operation the concierge can name: five reads, two draft writes, then the three
 * that a human rules on.
 *
 * ⚠️ EVERY NAME CARRIES A `publish_` PREFIX, AND THAT IS NOT STYLE. Op names are CONFIG KEYS the
 * human types into `[concierge.tools]`, so they must be unique across the whole catalog —
 * `policy.test.ts` pins that with a duplicate check. The destination's own vocabulary collides
 * head-on: `list_projects` is ALREADY TAKEN (a workspace op, and again as `chief_list_projects`),
 * and bare `list`/`get` are research ops. The prefix is also what a human reading their own config
 * file needs in order to tell "list the projects on this machine" from "list the sections of my
 * public site".
 *
 * THE NAMES ARE CHOSEN, NOT MIRRORED. `publish_go_live` rather than `publish_publish`, because the
 * name a human reads on an approval card should say what happens to them, not what the endpoint
 * calls its verb.
 */
export const PUBLISH_OPS = [
  // Reads.
  "publish_list_destinations",
  "publish_probe",
  "publish_list_projects",
  "publish_get",
  "publish_list",
  // Draft writes — the drafting loop stays free-flowing, which is the founder's explicit call.
  "publish_create_draft",
  "publish_update_draft",
  // The three a human rules on.
  "publish_update_live",
  "publish_go_live",
  "publish_take_down",
] as const;

export type PublishOp = (typeof PUBLISH_OPS)[number];

/**
 * Four words, all members of the vocabulary the `workspace` domain already publishes, so `policy.ts`
 * reuses that translation rather than declaring a table identical to it. Adding a fifth word here
 * fails to compile there until someone decides what it means in the shared vocabulary.
 */
export type PublishRisk = "read-only" | "routine" | "disruptive" | "irreversible";

/**
 * EXHAUSTIVE by construction — `Record<PublishOp, PublishRisk>`, so an op added to
 * {@link PUBLISH_OPS} without a classification fails `tsc` rather than arriving at the policy layer
 * unclassified. The decisions are DERIVED from these words through `DEFAULT_DECISION_BY_RISK`
 * (`policy.ts:961`); nothing hand-lists a per-tool default anywhere.
 *
 *   read-only    → allow    the five reads
 *   routine      → allow    the two DRAFT writes: local to the founder, invisible to anyone else,
 *                           and one `update_content` from undone. Asking about each keystroke of a
 *                           draft is how the compose loop stops being a conversation.
 *   irreversible → ask      `publish_update_live` and `publish_go_live` — see the header for why
 *                           this word and not `outward-facing`.
 *   disruptive   → ask      `publish_take_down`. It stops something that is live and being read.
 *                           Not `irreversible`: the post itself survives as a draft and
 *                           `publish_go_live` genuinely puts it back, so calling it irreversible
 *                           would overstate the damage while landing on the same decision — the
 *                           same reasoning `review.ts` gives for `close_finding`.
 */
export const PUBLISH_RISK: Record<PublishOp, PublishRisk> = {
  publish_list_destinations: "read-only",
  publish_probe: "read-only",
  publish_list_projects: "read-only",
  publish_get: "read-only",
  publish_list: "read-only",
  publish_create_draft: "routine",
  publish_update_draft: "routine",
  publish_update_live: "irreversible",
  publish_go_live: "irreversible",
  publish_take_down: "disruptive",
};

// ---------------------------------------------------------------------------------------------
// Results — the board/memory convention
// ---------------------------------------------------------------------------------------------

export interface PublishOk<T> {
  ok: true;
  op: PublishOp;
  risk: PublishRisk;
  data: T;
}

export interface PublishRefusal {
  ok: false;
  op: PublishOp;
  risk: PublishRisk;
  /** Machine-readable; forwarded verbatim as the registry reply's `code`. */
  reason: PublishRefusalCode;
  message: string;
}

export type PublishResult<T> = PublishOk<T> | PublishRefusal;

/**
 * Why a publish op did not do what it was asked.
 *
 * Every one of these is FORWARDED as the wire `code`, so a caller that must tell "you aimed a draft
 * edit at a live post" apart from "I could not read the post at all" can branch on the word rather
 * than on prose. `post-is-live` and `post-changed-since-approval` are the two the tests pin.
 */
export type PublishRefusalCode =
  /** No `[publish] active` destination, or the named id is not configured. */
  | "no-destination"
  /** The target is not a draft — the caller wants `publish_update_live`. THE MUTATION ANCHOR. */
  | "post-is-live"
  /** The destination answered, but its `visibility` was a literal this build does not know. */
  | "unknown-visibility"
  /** The pre-write read failed, timed out, or came back unreadable. Refuse; never assume draft. */
  | "visibility-unreadable"
  /** The post changed between the approval card being raised and the human's click being executed. */
  | "post-changed-since-approval"
  /** An approved call reached execution with no snapshot to compare against. Fail closed. */
  | "unverified-since-approval"
  /** The destination refused the call, or returned an error payload. Its own words are forwarded. */
  | "destination-refused"
  /** `publish_content` returned without the post reading as public. Never settle this as success. */
  | "publish-unconfirmed"
  /** The destination's answer was not a content object we can read. */
  | "unreadable-response";

function ok<T>(op: PublishOp, data: T): PublishOk<T> {
  return { ok: true, op, risk: PUBLISH_RISK[op], data };
}

function refuse(op: PublishOp, reason: PublishRefusalCode, message: string): PublishRefusal {
  return { ok: false, op, risk: PUBLISH_RISK[op], reason, message };
}

// ---------------------------------------------------------------------------------------------
// The destination's wire vocabulary — named ONCE
// ---------------------------------------------------------------------------------------------

/**
 * The destination's own tool names, verified live 2026-08-17 against `drodio-publishing v1.0.0`.
 *
 * Held as a frozen object rather than typed at each call site for the reason `chief.ts` gives about
 * `CHIEF_CALL_TOOL_ARG`: two readers written at different times drift, and a drift here is silent —
 * a misspelled tool name comes back as the destination's own "unknown tool" error, which reads like
 * an outage rather than like our bug.
 *
 * The safety-relevant facts about these three, all verified: `create_content` is ALWAYS a draft and
 * cannot publish; `update_content` CANNOT change visibility; `publish_content` is the only public
 * act. The server enforces draft-first server-side — the guards in this file are the second copy,
 * not the only one.
 */
export const DESTINATION_TOOLS = {
  listProjects: "list_projects",
  createContent: "create_content",
  getContent: "get_content",
  listContent: "list_content",
  updateContent: "update_content",
  publishContent: "publish_content",
  unpublishContent: "unpublish_content",
} as const;

/**
 * The argument key the destination identifies one post by.
 *
 * ⚠️ THE ONE UNVERIFIED VALUE IN THIS FILE, and it is named as a constant precisely so that fixing
 * it is a one-line change rather than a grep. The 2026-08-17 probe recorded the TOOL NAMES and the
 * content fields (`title`, `bodyMarkdown`, `kind`, `projectId`, `tags`) but not the id key. The
 * authority is the destination's own `inputSchema`, which `publish_probe` returns —
 * `PRD/sparkle/publish-concierge-domain.md` records this as an open item to settle against a live
 * token.
 */
export const DESTINATION_CONTENT_ID_ARG = "contentId";

/**
 * The `kind` enum — the "Format" field the concierge asks the human for.
 *
 * A FIXED enum on the destination (verified), so it is a closed union here too: a `kind` the server
 * will reject is better refused by our own schema, inside the turn, than sent and bounced.
 */
export const PUBLISH_KINDS = ["article", "musing", "short_video", "tutorial"] as const;
export type PublishKind = (typeof PUBLISH_KINDS)[number];

/** The destination caps `tags` at 12 (verified). Enforced client-side so the failure names its own
 *  cause instead of arriving as an unexplained refusal. */
export const MAX_PUBLISH_TAGS = 12;

// ---------------------------------------------------------------------------------------------
// Visibility — a CLOSED parse, in the direction that fails safe
// ---------------------------------------------------------------------------------------------

/** The only two states this build claims to understand. Anything else is not a variant, it is a
 *  refusal — see {@link readVisibility}. */
export type PostVisibility = "draft" | "public";

/** Literals that PROVE a draft. Compared after trim + lowercase: a server that shouts `"DRAFT"`
 *  still means draft, and widening the DRAFT-PROVING set is the direction that cannot hurt — the
 *  danger is the opposite one, a public post read as a draft. */
const DRAFT_LITERALS = new Set(["draft"]);

/**
 * Literals this build recognises as NOT-A-DRAFT.
 *
 * Every one of these is a value a naive `=== "public"` check would have WAVED THROUGH. They are
 * listed so the refusal can say something useful ("it is live"), NOT so that anything outside the
 * list is treated as safe: {@link readVisibility}'s fallthrough refuses.
 */
const PUBLIC_LITERALS = new Set([
  "public",
  "published",
  "live",
  "scheduled",
  "unlisted",
  "archived",
]);

/** What a visibility read produced. `ok: false` carries WHAT WAS SEEN, because a refusal that does
 *  not name the unknown literal cannot be acted on by whoever adds the next one. */
export type VisibilityReading =
  | { ok: true; visibility: PostVisibility }
  | { ok: false; reason: "post-is-live" | "unknown-visibility"; seen: string };

/**
 * Read a post's visibility out of a decoded content object, refusing unless it PROVES a draft.
 *
 * TOTAL over arbitrary JSON. Every permissive path a naive check leaves open is closed here:
 * a missing key, `null`, a number, a renamed field, and an unknown literal ALL refuse. The one
 * thing that returns `{visibility: "draft"}` is a known draft literal in the `visibility` key.
 *
 * DELIBERATELY READS EXACTLY ONE KEY. Falling back to `status` or `state` if `visibility` were
 * absent would be a guess about which of two fields is authoritative — and a guess in the
 * permissive direction, since the fallback would most often be absent too and could then be read as
 * "nothing says it is public".
 */
export function readVisibility(content: unknown): VisibilityReading {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return { ok: false, reason: "unknown-visibility", seen: describeSeen(content) };
  }
  const raw = (content as Record<string, unknown>).visibility;
  if (typeof raw !== "string") {
    return { ok: false, reason: "unknown-visibility", seen: describeSeen(raw) };
  }
  const word = raw.trim().toLowerCase();
  if (DRAFT_LITERALS.has(word)) return { ok: true, visibility: "draft" };
  if (PUBLIC_LITERALS.has(word)) return { ok: false, reason: "post-is-live", seen: raw };
  return { ok: false, reason: "unknown-visibility", seen: raw };
}

/** A short, safe rendering of a value we are refusing over. Never throws — this runs inside a
 *  refusal path, and a throw here would turn a clean refusal into an `internal-error`. */
function describeSeen(v: unknown): string {
  if (v === undefined) return "(no `visibility` field)";
  if (v === null) return "null";
  if (typeof v === "string") return v;
  try {
    return String(JSON.stringify(v)).slice(0, 80);
  } catch {
    return "(unreadable)";
  }
}

// ---------------------------------------------------------------------------------------------
// Host snapshots — the "before" reading, taken by the HOST and never by the model
// ---------------------------------------------------------------------------------------------

/**
 * What the host last saw of one post, from a response the host itself decoded.
 *
 * ⚠️ NEVER WRITTEN FROM MODEL ARGUMENTS. Every field comes from a destination response that came
 * back through {@link callDestinationTool}. That is the whole reason this can be used to authorise
 * anything: a snapshot the model could seed would be the model approving itself, exactly what
 * `policy.ts` forbids.
 */
export interface PublishSnapshot {
  destinationId: string;
  contentId: string;
  /** The literal the server sent, verbatim — not the parsed variant. An unknown literal is worth
   *  keeping so a mismatch can say what changed to what. */
  visibility: string;
  /** The server's own modification stamp, verbatim, or `""` when it sent none. */
  updatedAt: string;
  /** Over title + body + visibility. See {@link contentHash} for why not over the whole object. */
  contentHash: string;
  title: string;
  body: string;
  /** When the host took this reading. */
  readAt: number;
}

/**
 * The host's snapshot cache — one entry per `destination/content`, last write wins.
 *
 * A MODULE-LEVEL MAP, not a store: nothing renders off it and nothing persists it. It exists so
 * that a synchronous raise path ({@link publishApprovalGuard}, called from `resolveAskTier`, which
 * cannot await) has a "before" reading to stamp onto the approval.
 *
 * STALENESS HERE FAILS CLOSED, which is why this is not the "stale cached visibility is worse than
 * none" mistake the header warns about. That warning is about using a cache to DECIDE RISK — a
 * stale "draft" would wave a live post through. This cache never decides risk; it only detects
 * CHANGE, and a stale entry makes {@link guardApprovedCall} MORE likely to refuse, never less.
 */
const snapshots = new Map<string, PublishSnapshot>();

function snapshotKey(destinationId: string, contentId: string): string {
  return `${destinationId}\u0000${contentId}`;
}

/** Read the host's last reading of one post, or undefined. Pure. */
export function readPublishSnapshot(
  destinationId: string,
  contentId: string,
): PublishSnapshot | undefined {
  return snapshots.get(snapshotKey(destinationId, contentId));
}

/** Drop every snapshot. Tests, and the identity reset. */
export function clearPublishSnapshots(): void {
  snapshots.clear();
}

/**
 * A cheap, stable content fingerprint — FNV-1a over title + body + visibility, hex.
 *
 * NOT A SECURITY PRIMITIVE and not claimed to be one: this detects whether a human edited the post
 * on the web between the card and the click, and the adversary in that story is a race, not a
 * forger. A synchronous hash is required because the raise path cannot await, which rules out
 * `crypto.subtle`.
 *
 * OVER THREE FIELDS, NOT THE WHOLE OBJECT. Hashing every key would trip on a view counter or a
 * server-side render stamp, and a change detector that cries wolf is one that gets deleted.
 */
export function contentHash(title: string, body: string, visibility: string): string {
  let h = 0x811c9dc5;
  const s = `${title}\u0000${body}\u0000${visibility}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // FNV prime, via shifts so this stays in 32-bit integer arithmetic.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Pull a string field off a decoded content object, defaulting to `""`. Total over arbitrary
 *  JSON — every caller here is holding something a network peer produced. */
function str(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

/**
 * Record what the host just read, if the decoded payload really is a content object.
 *
 * Called from EVERY host path that decodes a response carrying a post — the reads, and the writes
 * too, since `create_content`/`update_content` echo the object. That is what makes the natural
 * compose loop (create → iterate → go live) always have a snapshot by the time an approval is
 * raised, with no extra round trip and nothing for the model to remember to do.
 *
 * Returns the snapshot it stored, or null when the payload named no id — a listing, a bare
 * acknowledgement, or something we simply cannot read. Null is never an error: it means "there was
 * nothing here to remember".
 */
export function absorbContent(destinationId: string, decoded: unknown, now = Date.now()): PublishSnapshot | null {
  const o = contentObject(decoded);
  if (!o) return null;
  const contentId = str(o, "id") || str(o, DESTINATION_CONTENT_ID_ARG);
  if (!contentId) return null;
  const title = str(o, "title");
  const body = str(o, "bodyMarkdown") || str(o, "body");
  const visibility = str(o, "visibility");
  const snap: PublishSnapshot = {
    destinationId,
    contentId,
    visibility,
    updatedAt: str(o, "updatedAt"),
    contentHash: contentHash(title, body, visibility),
    title,
    body,
    readAt: now,
  };
  snapshots.set(snapshotKey(destinationId, contentId), snap);
  return snap;
}

/** The content object inside a decoded response, whether the destination returned it bare or under
 *  a `content` wrapper. Total; returns null for anything that is not an object. */
export function contentObject(decoded: unknown): Record<string, unknown> | null {
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const o = decoded as Record<string, unknown>;
  const nested = o.content;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return o;
}

// ---------------------------------------------------------------------------------------------
// The host seam — three Tauri commands, and nothing else reaches the network
// ---------------------------------------------------------------------------------------------

/**
 * The three host commands (peer bead `sparkle-131ms.5`), as ONE injectable object.
 *
 * ⚠️ THE SEAM IS ON THE DEPS OBJECT THE CALLS ALREADY USE, not written inline at each call site.
 * AGENTS.md's "defaulted seam" finding (bead `sparkle-lgbwf`, seen 4×) is exactly this shape: when
 * every test injects its own `deps`, the line that supplies the REAL value is covered by nothing —
 * delete it and the suite stays green while the bug comes back. Here the default is
 * {@link LIVE_PUBLISH_DEPS}, and `publish.test.ts` drives the handlers with their DEFAULT deps over
 * a mocked `@tauri-apps/api/core`, so the production wiring is itself under test.
 */
export interface PublishDeps {
  probe: (destinationId: string) => Promise<DestinationCapabilities>;
  listTools: (destinationId: string) => Promise<ToolDescriptorDto[]>;
  /** Returns the DECODED tool result text. Rejects on any typed `PublishError` — including the
   *  HTTP-200 + `isError` shape, which is the whole reason the decoder is in Rust. */
  callTool: (destinationId: string, tool: string, args: unknown) => Promise<string>;
  /** The effective `[publish]` section. */
  readConfig: () => Promise<PublishConfigView>;
  /** The approval ledger, read at execution time to re-check the raise-time snapshot. */
  findApproval: typeof findApproval;
  now: () => number;
}

export const LIVE_PUBLISH_DEPS: PublishDeps = {
  probe: (destinationId) => invoke("destination_probe", { destinationId }),
  listTools: (destinationId) => invoke("destination_list_tools", { destinationId }),
  callTool: (destinationId, tool, args) =>
    invoke("destination_call_tool", { destinationId, tool, args }),
  readConfig: async () => {
    const eff = await getConfig(null);
    const p = (eff.config as { publish?: PublishConfigView }).publish;
    return p ?? { active: null, destinations: {} };
  },
  findApproval,
  now: () => Date.now(),
};

/**
 * The `[publish]` section as it crosses the wire.
 *
 * `active` is `string | null`, NOT `active?: string`. It is a Rust `Option<String>` and serde's
 * derive emits the key with a `null` value — a `?:` parser would describe a shape the wire cannot
 * produce. See {@link PublishAffordance}'s note.
 */
export interface PublishConfigView {
  active: string | null;
  destinations: Record<string, { name: string; url: string; has_credential_in_keychain: boolean }>;
}

/** One configured destination, as `publish_list_destinations` reports it. */
export interface PublishDestinationView {
  id: string;
  name: string;
  url: string;
  /** Whether a bearer token is present in the keychain for this id. NOT the token. */
  hasCredential: boolean;
  /** Whether this is the id publish ops act on when the caller names none. */
  active: boolean;
}

/**
 * Which destination a call acts on: the caller's explicit id, else `[publish] active`.
 *
 * REFUSES rather than guessing when nothing is configured or the named id is unknown — the config's
 * own doc says so, and it is the right failure: with more than one row and no stated choice, an
 * app that picks one is publishing to a site nobody named.
 */
async function resolveDestination(
  op: PublishOp,
  deps: PublishDeps,
  requested: string | undefined,
): Promise<{ ok: true; id: string } | { ok: false; refusal: PublishRefusal }> {
  let cfg: PublishConfigView;
  try {
    cfg = await deps.readConfig();
  } catch (e) {
    return {
      ok: false,
      refusal: refuse(op, "no-destination", `I couldn't read your publish settings: ${errText(e)}`),
    };
  }
  const ids = Object.keys(cfg.destinations ?? {});
  if (ids.length === 0) {
    return {
      ok: false,
      refusal: refuse(
        op,
        "no-destination",
        "No publish destination is configured, so there is nowhere to post. Add one under " +
          "`[publish.destinations]` in Settings first.",
      ),
    };
  }
  const id = requested?.trim() || cfg.active || "";
  if (!id) {
    return {
      ok: false,
      refusal: refuse(
        op,
        "no-destination",
        `You have ${ids.length} publish destinations configured (${ids.join(", ")}) but none is ` +
          "marked active, so I won't guess which one you meant. Set `[publish] active`, or name a " +
          "destination in the call.",
      ),
    };
  }
  if (!Object.prototype.hasOwnProperty.call(cfg.destinations, id)) {
    return {
      ok: false,
      refusal: refuse(
        op,
        "no-destination",
        `There is no publish destination called "${id}". The configured ones are: ${ids.join(", ")}.`,
      ),
    };
  }
  return { ok: true, id };
}

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
}

/**
 * Call one destination tool and DECODE its answer, refusing on anything that is not plainly a
 * success.
 *
 * TWO REFUSAL SHAPES, and the second is the belt to the Rust decoder's braces:
 *
 *  1. The `invoke` REJECTS. That is the ordinary failure path — `publish_client.rs`'s
 *     `decode_tool_result` turns HTTP-200-plus-`isError` into a typed `Err`, so a failed publish
 *     arrives here as a rejection carrying the destination's own words.
 *  2. The call RESOLVES but the decoded text parses into an `{error, …}` object. The verified
 *     endpoint sets `isError` today; a destination that stops doing so would otherwise have its
 *     failure read as a successful publish, which is the one wrong answer this whole layer exists
 *     to prevent. Cheap to check, and it can only ever turn a false success into a refusal.
 *
 * The decoded text is returned PARSED when it is JSON and as a `{ text }` wrapper when it is not,
 * so callers never re-parse and never have to decide whether a bare string was meant to be JSON.
 */
async function callDestinationTool(
  op: PublishOp,
  deps: PublishDeps,
  destinationId: string,
  tool: string,
  args: unknown,
): Promise<{ ok: true; decoded: unknown } | { ok: false; refusal: PublishRefusal }> {
  let text: string;
  try {
    text = await deps.callTool(destinationId, tool, args);
  } catch (e) {
    return {
      ok: false,
      refusal: refuse(op, "destination-refused", `${destinationId} refused ${tool}: ${errText(e)}`),
    };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    // Not JSON. Legitimate for an acknowledgement; wrapped so callers have one shape to read.
    return { ok: true, decoded: { text } };
  }
  const asError = errorPayload(decoded);
  if (asError) {
    return {
      ok: false,
      refusal: refuse(
        op,
        "destination-refused",
        `${destinationId} refused ${tool}: ${asError}. (It answered without setting \`isError\`, ` +
          "so this was caught by reading the payload rather than the flag.)",
      ),
    };
  }
  return { ok: true, decoded };
}

/** The destination's own error sentence, when a decoded payload is really a failure wearing a
 *  success's clothes. Null when the payload carries no error. */
function errorPayload(decoded: unknown): string | null {
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const o = decoded as Record<string, unknown>;
  if (typeof o.error !== "string" || o.error.trim() === "") return null;
  const status = typeof o.status === "number" ? ` (status ${o.status})` : "";
  return `${o.error}${status}`;
}

// ---------------------------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------------------------

/** Every configured destination, and which one is active. Reads config only — it does NOT reach
 *  the network, so it answers even when the destination is down or the token is missing. */
export async function listDestinations(
  deps: PublishDeps = LIVE_PUBLISH_DEPS,
): Promise<PublishResult<{ destinations: PublishDestinationView[]; active: string | null }>> {
  const op: PublishOp = "publish_list_destinations";
  let cfg: PublishConfigView;
  try {
    cfg = await deps.readConfig();
  } catch (e) {
    return refuse(op, "no-destination", `I couldn't read your publish settings: ${errText(e)}`);
  }
  const active = cfg.active ?? null;
  const destinations = Object.entries(cfg.destinations ?? {}).map(([id, d]) => ({
    id,
    name: d.name,
    url: d.url,
    hasCredential: d.has_credential_in_keychain,
    active: id === active,
  }));
  return ok(op, { destinations, active });
}

/** The capability probe — what the destination can do, and which affordances to offer. */
export async function probe(
  destinationId: string | undefined,
  deps: PublishDeps = LIVE_PUBLISH_DEPS,
): Promise<PublishResult<{ destinationId: string; capabilities: DestinationCapabilities; tools: ToolDescriptorDto[] }>> {
  const op: PublishOp = "publish_probe";
  const dest = await resolveDestination(op, deps, destinationId);
  if (!dest.ok) return dest.refusal;
  try {
    const [capabilities, tools] = await Promise.all([
      deps.probe(dest.id),
      deps.listTools(dest.id),
    ]);
    return ok(op, { destinationId: dest.id, capabilities, tools });
  } catch (e) {
    return refuse(op, "destination-refused", `I couldn't probe ${dest.id}: ${errText(e)}`);
  }
}

/** The destination's projects — REQUIRED before a draft can be created (`create_content` demands a
 *  `projectId` and has no default), which is why this is a first-class op rather than a detail. */
export async function listProjects(
  destinationId: string | undefined,
  deps: PublishDeps = LIVE_PUBLISH_DEPS,
): Promise<PublishResult<{ destinationId: string; projects: unknown }>> {
  const op: PublishOp = "publish_list_projects";
  const dest = await resolveDestination(op, deps, destinationId);
  if (!dest.ok) return dest.refusal;
  const res = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.listProjects, {});
  if (!res.ok) return res.refusal;
  return ok(op, { destinationId: dest.id, projects: res.decoded });
}

/** One post in full. Records a host snapshot as a side effect — see {@link absorbContent}. */
export async function getPost(
  contentId: string,
  destinationId: string | undefined,
  deps: PublishDeps = LIVE_PUBLISH_DEPS,
): Promise<PublishResult<{ destinationId: string; content: unknown; visibility: string }>> {
  const op: PublishOp = "publish_get";
  const dest = await resolveDestination(op, deps, destinationId);
  if (!dest.ok) return dest.refusal;
  const res = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.getContent, {
    [DESTINATION_CONTENT_ID_ARG]: contentId,
  });
  if (!res.ok) return res.refusal;
  const snap = absorbContent(dest.id, res.decoded, deps.now());
  return ok(op, {
    destinationId: dest.id,
    content: res.decoded,
    visibility: snap?.visibility ?? "",
  });
}

/** The destination's posts. */
export async function listPosts(
  destinationId: string | undefined,
  args: Record<string, unknown>,
  deps: PublishDeps = LIVE_PUBLISH_DEPS,
): Promise<PublishResult<{ destinationId: string; content: unknown }>> {
  const op: PublishOp = "publish_list";
  const dest = await resolveDestination(op, deps, destinationId);
  if (!dest.ok) return dest.refusal;
  const res = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.listContent, args);
  if (!res.ok) return res.refusal;
  return ok(op, { destinationId: dest.id, content: res.decoded });
}

// ---------------------------------------------------------------------------------------------
// The draft writes
// ---------------------------------------------------------------------------------------------

/** What a draft write carries. Every field is the destination's own, verified 2026-08-17. */
export interface DraftFields {
  title?: string;
  subtitle?: string;
  slug?: string;
  bodyMarkdown?: string;
  kind?: PublishKind;
  projectId?: string;
  tags?: string[];
}

/**
 * Create a draft. `create_content` is ALWAYS a draft and cannot publish, by the destination's own
 * design — so this is `routine` and auto-allowed, and there is no way for it to make anything
 * public even if the model asked it to.
 */
export async function createDraft(
  destinationId: string | undefined,
  fields: DraftFields,
  deps: PublishDeps = LIVE_PUBLISH_DEPS,
): Promise<PublishResult<{ destinationId: string; content: unknown; contentId: string }>> {
  const op: PublishOp = "publish_create_draft";
  const dest = await resolveDestination(op, deps, destinationId);
  if (!dest.ok) return dest.refusal;
  const res = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.createContent, fields);
  if (!res.ok) return res.refusal;
  const snap = absorbContent(dest.id, res.decoded, deps.now());
  if (!snap) {
    return refuse(
      op,
      "unreadable-response",
      `${dest.id} accepted the draft but its answer carried no post id, so I can't tell you which ` +
        "post it made or edit it afterwards. Nothing was published.",
    );
  }
  return ok(op, { destinationId: dest.id, content: res.decoded, contentId: snap.contentId });
}

/**
 * Edit a DRAFT — and REFUSE if the target is not one.
 *
 * ⚠️ THE REFUSAL BELOW IS THE LOAD-BEARING MEMBER OF THE ENTIRE LIVE-EDIT SPLIT. Read the module
 * header before deleting it as redundant with the risk table: the risk table classifies
 * `publish_update_draft` as `routine` (auto-allowed) on the strength of THIS check being here. Take
 * it out and the model can edit the founder's live post, unprompted, by choosing the cheap name.
 *
 * THE REFUSAL NAMES `publish_update_live`, deliberately: a model that dead-ends here retries the
 * same call, while a model that is told the gated name funnels into the approval card, which is the
 * outcome we want.
 *
 * THE PRE-WRITE READ HAPPENS INSIDE THIS CALL, never from a value carried across a turn — window 1
 * in the header. It is still not airtight, and this file does not claim it is.
 */
/*
 * WINDOW 2 IS NOT CHECKED HERE, AND IT DOES NOT NEED TO BE. `publish_update_draft` is `routine`,
 * so it auto-allows and the handler runs inside the turn that made the call — there is no card and
 * therefore no ten-minute window. A human who tightens the row to "Ask first" DOES create one, and
 * the dangerous half of it is covered anyway: if the post went live while the card sat there, the
 * pre-write read below refuses `post-is-live` on the replay. What is left uncovered is "the draft
 * changed", which is the founder's own draft changing under his own approval — the low-stakes half.
 */
export async function updateDraft(
  contentId: string,
  destinationId: string | undefined,
  fields: DraftFields,
  deps: PublishDeps = LIVE_PUBLISH_DEPS,
): Promise<PublishResult<{ destinationId: string; content: unknown; notice?: string; revert?: RevertOffer }>> {
  const op: PublishOp = "publish_update_draft";
  const dest = await resolveDestination(op, deps, destinationId);
  if (!dest.ok) return dest.refusal;

  // ── (ii) READ IMMEDIATELY BEFORE THE WRITE, IN THIS SAME HOST CALL ─────────────────────────
  const before = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.getContent, {
    [DESTINATION_CONTENT_ID_ARG]: contentId,
  });
  if (!before.ok) {
    // A LOOKUP FAILURE REFUSES. This is the permissive path a naive check leaves open, and it is
    // the one that will actually happen — a timeout, a 5xx, a revoked token.
    return refuse(
      op,
      "visibility-unreadable",
      `I couldn't read ${contentId} on ${dest.id} to check whether it is still a draft, so I did ` +
        `not edit it: ${before.refusal.message}`,
    );
  }
  const beforeSnap = absorbContent(dest.id, before.decoded, deps.now());
  const reading = readVisibility(contentObject(before.decoded));
  // ⚠️ ONE LINE, AND IT IS THE GATE. Kept as a single guarded return rather than an inline
  // if/else block so that `scripts/mutation-check.sh --line` can mutate it in isolation and prove
  // the suite goes red without it. A gate whose deletion cannot be simulated is a gate nobody can
  // show is doing anything.
  if (!reading.ok) return draftProofRefusal(op, dest.id, contentId, reading);

  const res = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.updateContent, {
    [DESTINATION_CONTENT_ID_ARG]: contentId,
    ...fields,
  });
  if (!res.ok) return res.refusal;
  absorbContent(dest.id, res.decoded, deps.now());

  // ── (iii) READ THE UPDATE'S OWN RESPONSE, WHICH ECHOES THE CONTENT OBJECT ───────────────────
  // Zero extra round trips, and it is the only after-the-fact detection available for window 1.
  // A mismatch is surfaced LOUDLY with a revert offer rather than swallowed: the human has to be
  // told that a post they believed was a draft was public when it was rewritten.
  const after = readVisibility(contentObject(res.decoded));
  if (!after.ok && after.reason === "post-is-live") {
    return ok(op, {
      destinationId: dest.id,
      content: res.decoded,
      notice:
        `WARNING — ${contentId} was a draft when I checked, but ${dest.id}'s reply says it is now ` +
        `"${after.seen}" — so it went public between my check and my write, and the edit landed on ` +
        "a live post that the human never approved. TELL THEM THIS PLAINLY, before anything else.",
      ...(beforeSnap ? { revert: revertOffer(beforeSnap) } : {}),
    });
  }
  return ok(op, { destinationId: dest.id, content: res.decoded });
}

/**
 * The refusal for a post that did not PROVE it was a draft.
 *
 * Split out from {@link updateDraft} so its gate is a single mutatable line — and because the two
 * arms say genuinely different things to a model. `post-is-live` names the op that WILL work;
 * `unknown-visibility` cannot promise that, so it says what it saw and leaves the judgement with
 * whoever reads it.
 */
function draftProofRefusal(
  op: PublishOp,
  destinationId: string,
  contentId: string,
  reading: Extract<VisibilityReading, { ok: false }>,
): PublishRefusal {
  if (reading.reason === "post-is-live") {
    return refuse(
      op,
      "post-is-live",
      `${contentId} is not a draft — ${destinationId} reports it as "${reading.seen}", so it is ` +
        "live and people can read it. I won't edit a live post on the quiet path. Use " +
        "`publish_update_live` instead: it puts the change in front of the human for approval " +
        "before anything is rewritten in public.",
    );
  }
  return refuse(
    op,
    "unknown-visibility",
    `I can't tell whether ${contentId} is a draft: ${destinationId} reported its visibility as ` +
      `${reading.seen}, which this build does not recognise. Refusing rather than guessing — an ` +
      "unrecognised value could just as easily mean it is live. Use `publish_update_live` if you " +
      "know it is public.",
  );
}

/** What it would take to put the previous text back. Carried in the reply so the concierge can
 *  OFFER the revert rather than telling the human to reconstruct it. */
export interface RevertOffer {
  contentId: string;
  op: "publish_update_live";
  title: string;
  bodyMarkdown: string;
}

function revertOffer(snap: PublishSnapshot): RevertOffer {
  return {
    contentId: snap.contentId,
    op: "publish_update_live",
    title: snap.title,
    bodyMarkdown: snap.body,
  };
}

// ---------------------------------------------------------------------------------------------
// The three a human rules on
// ---------------------------------------------------------------------------------------------

/**
 * What the approval carries so execution can tell whether the world moved under it.
 *
 * STAMPED AT RAISE TIME by {@link publishApprovalGuard}, for the same reason `relayedFounderWords`
 * and `subject` are stamped there: approving RUNS the call from a click handler, arbitrarily long
 * after the requesting turn ended, and the "before" reading cannot be recovered at that point.
 */
export interface PublishApprovalGuard {
  destinationId: string;
  contentId: string;
  visibility: string;
  updatedAt: string;
  contentHash: string;
  /** When the host took the reading this guard was built from. */
  readAt: number;
  /** Present when the call would rewrite the body — see {@link summarizePublishArgLines}. */
  diff?: PublishDiffSummary;
}

/** What changed, in a form that fits on a card. */
export interface PublishDiffSummary {
  added: number;
  removed: number;
  /** Character offset where the two texts first differ, or -1 when they are identical. */
  firstChangeAt: number;
  /** A short window of the OLD text at the change point. */
  wasNear: string;
  /** A short window of the NEW text at the change point. */
  nowNear: string;
}

/** The ops whose approval carries a snapshot — the three that act on an EXISTING post. */
const SNAPSHOT_GUARDED_OPS = new Set<string>([
  "publish_update_live",
  "publish_go_live",
  "publish_take_down",
]);

/**
 * The guard to stamp onto an approval being raised, or null when this call needs none.
 *
 * SYNCHRONOUS AND PURE APART FROM THE SNAPSHOT READ — it is called from `policyBinding`'s
 * `resolveAskTier`, which cannot await. That constraint is the whole reason the snapshot cache
 * exists: there is no way to fetch the post here.
 *
 * A CALL WITH NO SNAPSHOT YIELDS NULL, and {@link guardApprovedCall} then REFUSES at execution. That
 * is fail-closed and it is deliberate, but it is not a trap in practice: every host path that
 * decodes a post records a snapshot, so the ordinary compose loop (create → iterate → go live) and
 * the ordinary edit loop (get → update) both always have one. What it rules out is publishing a post
 * this app has never read, which is exactly the case where nobody can say what is about to happen.
 */
export function publishApprovalGuard(
  domain: string,
  op: string,
  args: unknown,
): PublishApprovalGuard | null {
  if (domain !== "publish" || !SNAPSHOT_GUARDED_OPS.has(op)) return null;
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  const contentId = typeof a.contentId === "string" ? a.contentId : "";
  if (!contentId) return null;
  const destinationId = typeof a.destinationId === "string" ? a.destinationId.trim() : "";
  const snap = destinationId
    ? readPublishSnapshot(destinationId, contentId)
    : findSnapshotByContentId(contentId);
  if (!snap) return null;
  const nextBody = typeof a.bodyMarkdown === "string" ? a.bodyMarkdown : null;
  return {
    destinationId: snap.destinationId,
    contentId: snap.contentId,
    visibility: snap.visibility,
    updatedAt: snap.updatedAt,
    contentHash: snap.contentHash,
    readAt: snap.readAt,
    ...(nextBody === null ? {} : { diff: diffSummary(snap.body, nextBody) }),
  };
}

/** The host's snapshot for a post whose destination the caller left implicit. Unambiguous in
 *  practice (v1 has one destination) and simply returns nothing when two destinations both hold a
 *  post with this id — an ambiguous match must not authorise anything. */
function findSnapshotByContentId(contentId: string): PublishSnapshot | undefined {
  const hits = [...snapshots.values()].filter((s) => s.contentId === contentId);
  return hits.length === 1 ? hits[0] : undefined;
}

/** How much text moved, and where. Not a real diff algorithm and not claimed to be — the card needs
 *  a magnitude and a location, and a character-level LCS would cost more than the answer is worth. */
export function diffSummary(oldText: string, newText: string): PublishDiffSummary {
  let i = 0;
  while (i < oldText.length && i < newText.length && oldText[i] === newText[i]) i++;
  const identical = i === oldText.length && i === newText.length;
  const grew = Math.max(0, newText.length - oldText.length);
  const shrank = Math.max(0, oldText.length - newText.length);
  // A same-length rewrite changes text without changing length, so "0 added, 0 removed" would read
  // as "nothing happened" on the one card where that is the most dangerous sentence to print.
  const changedTail = identical ? 0 : Math.max(oldText.length, newText.length) - i;
  return {
    added: grew || (identical ? 0 : changedTail),
    removed: shrank || (identical ? 0 : changedTail),
    firstChangeAt: identical ? -1 : i,
    wasNear: window(oldText, i),
    nowNear: window(newText, i),
  };
}

const DIFF_WINDOW_CHARS = 60;

function window(text: string, at: number): string {
  if (at >= text.length) return "(end of text)";
  const slice = text.slice(at, at + DIFF_WINDOW_CHARS);
  return slice.length < text.length - at ? `${slice}…` : slice;
}

/** One line of card copy for a diff summary. */
export function describeDiff(d: PublishDiffSummary): string {
  if (d.firstChangeAt < 0) return "the body is unchanged";
  return (
    `+${d.added} / −${d.removed} chars, first change at ${d.firstChangeAt}. ` +
    `Was: “${d.wasNear}” → now: “${d.nowNear}”`
  );
}

/**
 * Replace a publish call's raw body on the approval card with its DIFF SUMMARY.
 *
 * `ARG_VALUE_MAX_CHARS` is 220, so rendering `bodyMarkdown` shows the human the first 220 characters
 * of a multi-paragraph post and calls that consent — for the one op class where THEIR READING IS THE
 * GATE. Showing what changed and where is strictly more information in the same space.
 *
 * The raw body is untouched on `rawArgs`, which is what the replay executes, so this changes what is
 * DISPLAYED and nothing about what runs.
 */
export function summarizePublishArgLines(
  lines: readonly ApprovalArgLine[],
  guard: PublishApprovalGuard | null,
): readonly ApprovalArgLine[] {
  if (!guard?.diff) return lines;
  const note = describeDiff(guard.diff);
  return lines.map((l) => (l.key === "bodyMarkdown" ? { key: "bodyMarkdown", value: note } : l));
}

/**
 * RE-CHECK THE APPROVAL'S SNAPSHOT AGAINST THE WORLD AS IT IS NOW.
 *
 * ⚠️ THIS RUNS IN THE DOMAIN HANDLER, WHICH IS THE ONLY PLACE IT CAN. `conciergeApprovalResume`
 * dispatches the approved call straight into `dispatchConciergeTool`, whose ask-tier branch is
 * satisfied by `claimApproval` — so `policyBinding`/`resolveAskTier` are BYPASSED on the replay
 * path. A check placed there would fire only on the first (refused) call and never on the one that
 * actually publishes: a silent hole by construction.
 *
 * NOT APPLICABLE TO A NON-APPROVAL CALL, and that is not a gap. When the human has set
 * `[concierge.tools] publish_go_live = "allow"`, the decision tier is `allow` and there is no ten-
 * minute window between a card and a click for anything to change in — the call runs inside the
 * turn that made it. Window 1's pre-write read still applies there and is not waived.
 */
export function guardApprovedCall(
  op: PublishOp,
  ctx: { toolCallId: string; tier: string },
  current: PublishSnapshot,
  deps: PublishDeps = LIVE_PUBLISH_DEPS,
): PublishRefusal | null {
  if (ctx.tier !== "ask") return null;
  const entry = deps.findApproval(ctx.toolCallId);
  const guard = entry?.publishGuard;
  if (!guard) {
    return refuse(
      op,
      "unverified-since-approval",
      `You approved ${op} for ${current.contentId}, but I have no record of what the post looked ` +
        "like at the moment you were asked, so I can't show that it hasn't changed since. I did " +
        "not run it. Ask me to read the post first (`publish_get`) and I'll put a fresh approval " +
        "in front of you.",
    );
  }
  const changed: string[] = [];
  if (guard.visibility !== current.visibility) {
    changed.push(`it is now “${current.visibility || "(none)"}”, not “${guard.visibility || "(none)"}”`);
  }
  if (guard.updatedAt !== current.updatedAt) {
    changed.push(`it was edited at ${current.updatedAt || "(unstamped)"}`);
  }
  if (guard.contentHash !== current.contentHash) {
    changed.push("its title or body is different from the one you approved");
  }
  if (changed.length === 0) return null;
  return refuse(
    op,
    "post-changed-since-approval",
    `${current.contentId} changed between the approval and now: ${changed.join("; ")}. I did not ` +
      "run it — the thing you approved is not the thing that is there. Ask me again and I'll " +
      "re-read the post and put a fresh approval in front of you.",
  );
}

/**
 * Edit a post that IS live. The gated sibling of {@link updateDraft}.
 *
 * Ask-tier, so the human has read the diff summary on the card before this ever runs. Both TOCTOU
 * windows are covered here: the pre-write read (window 1) and the approval snapshot re-check
 * (window 2), in that order — the re-check needs a fresh reading to compare against, and the
 * pre-write read is what produces it, so one host call serves both.
 *
 * A NOTE ON THE CASE THAT LOOKS MISSING: this does NOT refuse when the target turns out to be a
 * DRAFT. That is deliberate and it is the safe direction — `publish_update_live` is the gated
 * sibling, so choosing it against a draft is STRICTLY MORE RESTRICTIVE than choosing the cheap
 * name, and there is no laxer path to escape into by picking it. Same reasoning `policy.ts`'s
 * RISK_OVERRIDES gives for leaving `retire_agent` out of the disruptive tier. The gate that has to
 * hold runs in the other direction, in {@link updateDraft}.
 */
export async function updateLive(
  contentId: string,
  destinationId: string | undefined,
  fields: DraftFields,
  ctx: { toolCallId: string; tier: string },
  deps: PublishDeps = LIVE_PUBLISH_DEPS,
): Promise<PublishResult<{ destinationId: string; content: unknown }>> {
  const op: PublishOp = "publish_update_live";
  const dest = await resolveDestination(op, deps, destinationId);
  if (!dest.ok) return dest.refusal;

  const before = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.getContent, {
    [DESTINATION_CONTENT_ID_ARG]: contentId,
  });
  if (!before.ok) {
    return refuse(
      op,
      "visibility-unreadable",
      `I couldn't read ${contentId} on ${dest.id} before editing it, so I did not edit it: ` +
        before.refusal.message,
    );
  }
  const snap = absorbContent(dest.id, before.decoded, deps.now());
  if (!snap) {
    return refuse(
      op,
      "unreadable-response",
      `${dest.id} answered for ${contentId} with something I can't read as a post, so I did not ` +
        "edit it.",
    );
  }
  const changed = guardApprovedCall(op, ctx, snap, deps);
  if (changed) return changed;

  const res = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.updateContent, {
    [DESTINATION_CONTENT_ID_ARG]: contentId,
    ...fields,
  });
  if (!res.ok) return res.refusal;
  absorbContent(dest.id, res.decoded, deps.now());
  return ok(op, { destinationId: dest.id, content: res.decoded });
}

/**
 * PUBLISH. The only public act, and the only op in this domain that cannot be undone by the
 * destination's own verbs — `unpublish_content` takes the post down, it does not un-send the RSS
 * item, the scrape or the archive.
 *
 * ⚠️ THE RECEIPT IS SETTLED FROM THE DECODED RESULT, NEVER FROM "THE CALL DIDN'T THROW".
 * `publish_content` needs the `content:publish` scope, which `content:write` does NOT imply, and
 * without it the failure arrives as HTTP 200 + `isError`. Two layers catch that — the Rust decoder
 * rejects, and {@link callDestinationTool} refuses an `{error}` payload — and then this function
 * adds the third: it refuses to REPORT the post as published unless the echoed content object
 * parses into a PUBLIC visibility variant. Telling the founder his post is live when it is not is
 * the single worst outcome this domain can produce.
 */
export async function goLive(
  contentId: string,
  destinationId: string | undefined,
  ctx: { toolCallId: string; tier: string },
  deps: PublishDeps = LIVE_PUBLISH_DEPS,
): Promise<PublishResult<{ destinationId: string; content: unknown; visibility: string; url: string }>> {
  const op: PublishOp = "publish_go_live";
  const dest = await resolveDestination(op, deps, destinationId);
  if (!dest.ok) return dest.refusal;

  const before = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.getContent, {
    [DESTINATION_CONTENT_ID_ARG]: contentId,
  });
  if (!before.ok) {
    return refuse(
      op,
      "visibility-unreadable",
      `I couldn't read ${contentId} on ${dest.id} before publishing it, so I did not publish it: ` +
        before.refusal.message,
    );
  }
  const snap = absorbContent(dest.id, before.decoded, deps.now());
  if (!snap) {
    return refuse(
      op,
      "unreadable-response",
      `${dest.id} answered for ${contentId} with something I can't read as a post, so I did not ` +
        "publish it.",
    );
  }
  const changed = guardApprovedCall(op, ctx, snap, deps);
  if (changed) return changed;

  const res = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.publishContent, {
    [DESTINATION_CONTENT_ID_ARG]: contentId,
  });
  if (!res.ok) return res.refusal;
  const after = absorbContent(dest.id, res.decoded, deps.now());
  const o = contentObject(res.decoded) ?? {};
  const unconfirmed = publishUnconfirmed(op, dest.id, contentId, readVisibility(o));
  if (unconfirmed) return unconfirmed;
  return ok(op, {
    destinationId: dest.id,
    content: res.decoded,
    // The literal the DESTINATION sent, read back off its own answer — not a word this side chose.
    // `publishUnconfirmed` has already established it is a known public one, so there is nothing
    // left to fall back to and nothing to invent.
    visibility: after?.visibility ?? str(o, "visibility"),
    url: str(o, "url") || str(o, "publicUrl") || str(o, "previewUrl"),
  });
}

/**
 * PROVE IT WENT PUBLIC — the third layer of "settle from the decoded result".
 *
 * `reading.ok` means the answer parsed into a KNOWN literal, and the only known literal that is a
 * draft is `draft` — so an accepted call whose answer still reads as a draft published NOTHING.
 * That is the `content:publish`-scope failure in the shape it actually arrives in.
 *
 * Split out so each check is a single line a mutation can delete independently: a guard that
 * cannot be simulated away is a guard nobody can show is load-bearing. Returns null when the post
 * really is public.
 */
function publishUnconfirmed(
  op: PublishOp,
  destinationId: string,
  contentId: string,
  reading: VisibilityReading,
): PublishRefusal | null {
  const stillDraft =
    `${destinationId} accepted the publish for ${contentId} but its answer still reports the post ` +
    "as a draft, so I will NOT tell you it went live. Check the destination, and check that the " +
    "token holds the `content:publish` scope — `content:write` does not imply it.";
  if (reading.ok) return refuse(op, "publish-unconfirmed", stillDraft);
  const unreadable =
    `${destinationId} accepted the publish for ${contentId}, but I can't confirm the post is ` +
    `actually public: its answer reported visibility as ${reading.seen}. I will not report a post ` +
    "as published on the strength of the call not failing.";
  if (reading.reason !== "post-is-live") return refuse(op, "publish-unconfirmed", unreadable);
  return null;
}

/** Take a live post down. `disruptive`, so it asks — see {@link PUBLISH_RISK} for why not
 *  `irreversible`. */
export async function takeDown(
  contentId: string,
  destinationId: string | undefined,
  ctx: { toolCallId: string; tier: string },
  deps: PublishDeps = LIVE_PUBLISH_DEPS,
): Promise<PublishResult<{ destinationId: string; content: unknown }>> {
  const op: PublishOp = "publish_take_down";
  const dest = await resolveDestination(op, deps, destinationId);
  if (!dest.ok) return dest.refusal;

  const before = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.getContent, {
    [DESTINATION_CONTENT_ID_ARG]: contentId,
  });
  if (!before.ok) {
    return refuse(
      op,
      "visibility-unreadable",
      `I couldn't read ${contentId} on ${dest.id} before taking it down, so I did nothing: ` +
        before.refusal.message,
    );
  }
  const snap = absorbContent(dest.id, before.decoded, deps.now());
  if (!snap) {
    return refuse(
      op,
      "unreadable-response",
      `${dest.id} answered for ${contentId} with something I can't read as a post, so I did nothing.`,
    );
  }
  const changed = guardApprovedCall(op, ctx, snap, deps);
  if (changed) return changed;

  const res = await callDestinationTool(op, deps, dest.id, DESTINATION_TOOLS.unpublishContent, {
    [DESTINATION_CONTENT_ID_ARG]: contentId,
  });
  if (!res.ok) return res.refusal;
  absorbContent(dest.id, res.decoded, deps.now());
  return ok(op, { destinationId: dest.id, content: res.decoded });
}
