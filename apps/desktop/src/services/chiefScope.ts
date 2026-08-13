// WHO MAY REACH WHICH CHIEF PROJECT — the whole access-control surface for the Chief integration,
// in one pure module (bead `sparkle-8rr0c`).
//
// WHY THIS IS A SEPARATE MODULE, AND WHY IT IS PURE. The founder's rule is that the CONCIERGE
// reaches all Chief projects while a BUILD AGENT reaches only what it is scoped to. There is exactly
// one mechanism that can enforce that, and it is not the obvious one:
//
//   `--allowedTools` DOES NOT GATE MCP TOOLS. Measured on CLI 2.1.220 (bead `sparkle-xbka`, and see
//   the warning at src-tauri/src/concierge.rs:57-68) — only `--disallowedTools` blocks. So scoping
//   cannot live in a spawn flag, and it certainly cannot live in persona prose, which is a
//   suggestion an agent is free to talk itself out of. It has to be a refusal in the handler, taken
//   against the caller identity the APP stamps (controlListener's `callerAgentId`) rather than any
//   value the caller supplies.
//
// Everything this module needs arrives as a parameter — the caller, the request, the catalog. It
// reads no store, touches no IO, and imports no React, so the security core is unit-testable
// without a socket or a live token, and the call site can supply a fixture without this module
// knowing the difference. (Same reasoning as conciergeTools/policy.ts, which is deliberately pure
// for the identical reason.)
//
// TWO INDEPENDENT GATES, and a request must pass BOTH:
//   1. `resolveChiefProject` — WHICH project. Refuses out-of-scope and refuses to guess.
//   2. `checkChiefTool`      — WHICH verb. Refuses destructive tools for non-concierge callers.
// They are separate because they fail for different reasons and a caller deserves to be told which.
//
// THE DESIGN RULE THROUGHOUT: NEVER SILENTLY SERVE THE WRONG PROJECT. The token reaches 348
// projects, many of them real client work. Every ambiguity here resolves to a refusal that NAMES
// what was asked for and what is reachable — never to a fallback, a nearest match, or a default.

/** A Chief project as returned by the upstream `list_projects` tool / `GET /v1/projects`. */
export interface ChiefProject {
  project_id: string;
  name: string;
  description?: string;
  /** Chief's own "this is the account's default project" flag. Deliberately NOT used as a fallback
   *  — see the design rule above. Carried so the UI can label it. */
  default?: boolean;
}

/** The caller, as resolved by the app from the STAMPED identity — never from the tool payload.
 *  `allowed: "all"` is the concierge's unrestricted reach; an agent always carries a finite list. */
export interface ChiefCaller {
  kind: "concierge" | "agent";
  /** Present for an agent; absent for the concierge, which has an identity but no agent row. */
  agentId?: string;
  /** Chief project ids this caller may reach, or "all" for the concierge. An EMPTY ARRAY means the
   *  caller's Sparkle project has no Chief binding — which is a refusal, not an open door. */
  allowed: string[] | "all";
  /** The project used when the caller names none. Must be a member of `allowed` when that is a
   *  list; `null` means "no default, ask". */
  primary: string | null;
  /** Only for building a legible refusal/attribution message. */
  sparkleProjectName?: string;
}

/** What a Chief tool call returns once it has been through the proxy. `text` is the human/model
 *  readable summary Chief sends; `data` is the `structuredContent` payload when present — Chief's
 *  text is frequently just a count ("3 chat(s) returned"), so the structured half is the useful one
 *  and callers must not parse the prose. */
export interface ChiefToolResult {
  text: string;
  data?: unknown;
  isError?: boolean;
}

/** THE SEAM between the access-control layer and the network. Declared here, with the rest of the
 *  frozen contract, so the tool surface and the proxy can be built and typechecked independently of
 *  each other — and, more importantly, so the handler takes its client as an INJECTED dependency
 *  rather than reaching for a module singleton. A defaulted-at-the-call-site seam is the shape that
 *  leaves the production path untested by construction (bead `sparkle-lgbwf`): put this on the deps
 *  object the handler already receives.
 *
 *  `projectId` is passed per call because that is exactly how the wire works — Chief reads
 *  `X-Project-Id` per REQUEST, not per session (verified 2026-08-12). `null` is only valid for the
 *  handful of tools that take no project, `list_projects` above all. */
export interface ChiefClient {
  listProjects(): Promise<ChiefProject[]>;
  callTool(
    projectId: string | null,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<ChiefToolResult>;
}

export type ChiefRefusalReason =
  | "out_of_scope" // asked for a real project this caller may not reach
  | "unbound" // caller's Sparkle project has no Chief binding
  | "ambiguous" // no project named and no single default to fall back to
  | "unknown_project" // the name/id matches nothing the token can see
  | "ambiguous_name" // the name matches more than one project
  | "destructive_denied"; // the verb is refused for this caller kind

export type ChiefScopeDecision =
  | { ok: true; projectId: string; projectName: string; source: "requested" | "primary" }
  | { ok: false; reason: ChiefRefusalReason; message: string };

/**
 * ONE spelling of a Chief tool name, so the gate below cannot be walked past by re-typing the verb.
 *
 * THIS LIVES HERE, NEXT TO THE SET IT GUARDS, and that placement is the fix rather than a detail
 * (roborev 63036). It used to live only in `conciergeTools/chief.ts`, which normalized before its
 * own floor while this gate compared RAW — so `mcp__chief__delete_asset` and `Delete_Asset` walked
 * straight through the access-control check that the policy layer was carefully folding names for.
 * A normalizer one module away from the set it protects is a normalizer that will be applied in one
 * place and forgotten in the other; `chief.ts` now re-exports this one.
 *
 * Three reductions, each covering a way one verb reaches us wearing a different coat: padding, case,
 * and the `mcp__<server>__` wire prefix an MCP name arrives under.
 */
export function normalizeChiefToolName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return trimmed.startsWith("mcp__") ? (trimmed.split("__").pop() ?? trimmed) : trimmed;
}

/** Tools that DESTROY or mutate shared configuration. Refused for every non-concierge caller.
 *
 *  This is a NAME list checked against the NORMALIZED upstream tool name, which is what lets the
 *  same check cover both a first-class tool and the `chief_call` escape hatch — the hatch passes its
 *  `tool` argument through here, so it cannot be used to reach a denied verb by another route.
 *
 *  IT IS A FLOOR, NOT THE WHOLE GATE — see {@link isDestructiveChiefTool}. On its own a name list is
 *  a DENYLIST over a vocabulary someone else owns, which fails OPEN by construction: Chief shipped
 *  58 tools as of 2026-08-12 and these are thirteen of them. `chief.test.ts`/`chiefScope.test.ts`
 *  pin this membership exactly, so removing a name is a deliberate edit on both sides rather than a
 *  silent widening. */
export const CHIEF_DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set([
  "delete_asset",
  "delete_chat",
  "delete_memory",
  "delete_message",
  "delete_skill",
  "delete_action",
  "delete_label",
  "delete_session",
  "delete_share_link",
  "delete_project_invitation",
  "create_project_invitation",
  // GRANTS OUTSIDE ACCESS, so it belongs here even though it reads like a create. It was named in
  // this file's own design note as one of the two `create_` verbs that stay on the list, and was
  // then absent FROM the list — a comment describing an intent the code did not implement, with
  // both tests encoding the omission (roborev 63136). A build agent could mint a public link to a
  // real client's project, and no prefix rule catches it.
  "create_share_link",
  "update_project",
  "remove_chat_member",
]);

/**
 * The STRUCTURAL half of the verb gate, and the reason the gate now fails closed (roborev 63036,
 * 63043).
 *
 * A thirteen-name denylist over a fifty-eight-tool surface permits everything nobody thought to
 * enumerate — and the misses were not exotic. The set's own doc-comment claimed to cover tools that
 * "DESTROY **or mutate** shared configuration", while `update_memory`, `update_asset`, `update_chat`,
 * `update_skill`, `update_label`, `remove_project_member` and `create_share_link` were all reachable
 * by any build agent through `chief_call`. Worse, a destructive verb Chief ships TOMORROW is
 * permitted until a human edits this file, which is a security posture that decays on its own.
 *
 * So the prefix rule is the gate and the list is the floor: a verb is destructive if it is named
 * OR if it begins with one of the mutating prefixes. That inverts the failure direction — an
 * unrecognised `delete_*` from a future Chief release is refused rather than allowed, and the cost
 * of being wrong is a build agent being told to ask the human, not a client's data being destroyed.
 *
 * `create_` is deliberately NOT a prefix: creating a chat, a memory or an upload is the ordinary
 * work a build agent is here to do. The two `create_` verbs that ARE dangerous (an invitation, a
 * share link) grant OUTSIDE access rather than writing content, and they stay on the explicit list —
 * which is exactly the case a floor under a structural rule exists for.
 */
export function isDestructiveChiefTool(toolName: string): boolean {
  const name = normalizeChiefToolName(toolName);
  return CHIEF_DESTRUCTIVE_TOOLS.has(name) || /^(delete|remove|revoke|archive|update)_/.test(name);
}

/** Verb gate. Separate from the project gate so a refusal can say WHICH rule stopped it. */
export function checkChiefTool(
  caller: ChiefCaller,
  toolName: string,
): { ok: true } | { ok: false; reason: ChiefRefusalReason; message: string } {
  if (caller.kind === "concierge") return { ok: true };
  if (isDestructiveChiefTool(toolName)) {
    return {
      ok: false,
      reason: "destructive_denied",
      message:
        `Refused: \`${toolName}\` destroys or reconfigures Chief data, and build agents are not ` +
        `permitted destructive Chief tools — Chief holds live client work. Read, chat, and upload ` +
        `tools are available. If this genuinely needs to happen, ask the human to do it from the ` +
        `concierge.`,
    };
  }
  return { ok: true };
}

/** Case/whitespace-insensitive comparison for matching a project by NAME. */
function norm(s: string): string {
  return s.trim().toLowerCase();
}

function nameOf(catalog: readonly ChiefProject[], id: string): string {
  return catalog.find((p) => p.project_id === id)?.name ?? id;
}

/** Render an id list for a refusal message, capped so a concierge-sized catalog can't flood a turn. */
function describe(catalog: readonly ChiefProject[], ids: readonly string[]): string {
  const shown = ids.slice(0, 8).map((id) => `${nameOf(catalog, id)} (${id})`);
  const rest = ids.length - shown.length;
  return shown.join(", ") + (rest > 0 ? `, and ${rest} more` : "");
}

/**
 * Finish a refusal with a remedy that is SAFE FOR THIS CALLER to follow.
 *
 * The concierge reaches everything, so "go look at the catalog" costs it nothing it did not already
 * have. A scoped agent is told its own bound set instead — the enumeration suggestion is withheld,
 * not because it would fail, but because it would SUCCEED (`list_projects` is not project-scoped and
 * so never reaches the project gate at all).
 */
function reachableRemedy(
  caller: ChiefCaller,
  catalog: readonly ChiefProject[],
  refusal: string,
): string {
  if (caller.allowed === "all") {
    return `${refusal} Call \`chief_list_projects\` to see what this token can reach.`;
  }
  if (caller.allowed.length === 0) {
    return (
      `${refusal} This agent is not bound to any Chief project, so there is nothing it can ` +
      `reach. Ask the human to bind one.`
    );
  }
  return `${refusal} This agent can reach ${describe(catalog, caller.allowed)}.`;
}

/**
 * Decide which Chief project a call runs against.
 *
 * `requested` may be a project id OR a human-typed name — 348 opaque ids are not something a person
 * or a model reliably quotes, so the name path is a usability requirement, not a convenience. It is
 * also the one place a wrong answer is plausible, so: exact id wins outright, then exact name; a
 * name matching several projects is REFUSED with the candidates listed rather than resolved to the
 * first, and a name matching nothing is refused rather than falling back to a default.
 */
export function resolveChiefProject(
  caller: ChiefCaller,
  requested: string | undefined | null,
  catalog: readonly ChiefProject[],
): ChiefScopeDecision {
  const asked = requested?.trim();

  if (asked) {
    // 1. Exact id, then exact name. Anything else is a refusal, never a guess.
    let hit = catalog.find((p) => p.project_id === asked);
    if (!hit) {
      const byName = catalog.filter((p) => norm(p.name) === norm(asked));
      if (byName.length > 1) {
        return {
          ok: false,
          reason: "ambiguous_name",
          message:
            `Refused: "${asked}" matches ${byName.length} Chief projects — ` +
            `${byName.map((p) => p.project_id).join(", ")}. Re-run naming the project id exactly.`,
        };
      }
      hit = byName[0];
    }
    if (!hit) {
      return {
        ok: false,
        reason: "unknown_project",
        // THE REMEDY IS BRANCHED ON THE CALLER, because a remedy is an INSTRUCTION and it has to be
        // safe under the same conditions that produced the refusal (roborev 63036; AGENTS.md,
        // "User-facing copy is code"). This sentence used to tell EVERY caller to call
        // `chief_list_projects` — so a build agent scoped to one project was being instructed to
        // enumerate all 348, most of them other clients' work, and `checkChiefTool` does not deny
        // `list_projects`, so following the instruction SUCCEEDS. The refusal would have leaked
        // exactly what it was written to protect.
        message: reachableRemedy(caller, catalog, `Refused: no Chief project matches "${asked}".`),
      };
    }

    // 2. Scope. The concierge reaches everything; an agent reaches only its bound set.
    if (caller.allowed !== "all" && !caller.allowed.includes(hit.project_id)) {
      const where = caller.sparkleProjectName ? ` (Sparkle project "${caller.sparkleProjectName}")` : "";
      // DO NOT ECHO A PROJECT THIS CALLER MAY NOT REACH WHEN IT ASKED BY ID (roborev 63036, 63043).
      // Existence is tested before scope, so the two refusals differ observably: a fake id gets
      // `unknown_project` while a REAL one gets `out_of_scope` quoting its name. That turns the gate
      // into an id→name oracle over the whole account — an agent can enumerate 348 client names by
      // probing ids and reading which refusal comes back. Asking by NAME is different in kind: the
      // caller already holds the name, so echoing it back reveals nothing it did not supply.
      const askedById = hit.project_id === asked;
      const subject = askedById ? "that project" : `"${hit.name}"`;
      return {
        ok: false,
        reason: caller.allowed.length === 0 ? "unbound" : "out_of_scope",
        message:
          caller.allowed.length === 0
            ? `Refused: this agent${where} is not bound to any Chief project, so it cannot reach ` +
              `${subject}. Ask the human to bind a Chief project to this Sparkle project.`
            : `Refused: this agent${where} is scoped to ${describe(catalog, caller.allowed)} and ` +
              `asked for ${subject}, which is outside that scope. No Chief call was made.`,
      };
    }
    return { ok: true, projectId: hit.project_id, projectName: hit.name, source: "requested" };
  }

  // 3. No project named — fall back to the binding, or refuse. Never pick one of 348.
  if (caller.primary) {
    // A primary outside `allowed` is a store-consistency bug; refuse rather than honour it.
    if (caller.allowed !== "all" && !caller.allowed.includes(caller.primary)) {
      return {
        ok: false,
        reason: "out_of_scope",
        message:
          `Refused: this agent's default Chief project (${caller.primary}) is not in its allowed ` +
          `set. The binding is inconsistent — ask the human to re-bind this Sparkle project.`,
      };
    }
    // THE DEFAULT PATH MUST CHECK THE CATALOG TOO (roborev 63036). The `requested` path above
    // refuses anything the catalog does not contain; this one used to trust the binding outright,
    // so a STALE primary — a Chief project deleted upstream, or one the token stopped seeing after a
    // credential rotation — resolved `{ ok: true }` with `nameOf` falling back to the raw id. That
    // is the one outcome this module's design rule forbids: the call proceeds, fails opaquely at
    // Chief, and anything rendering `projectName` prints an opaque `project_…` id as a project name.
    // A binding that no longer resolves is a thing to tell the human about, not to half-honour.
    const primaryRow = catalog.find((p) => p.project_id === caller.primary);
    if (!primaryRow) {
      // AN EMPTY CATALOG IS A DIFFERENT FACT FROM A DELETED PROJECT, and saying the wrong one sends
      // the human to un-break a binding that is fine (roborev 63136). The catalog is one
      // `list_projects` call whose rows are parsed out of `structuredContent`, and a shape change,
      // a paged response or a momentarily degraded token yields zero rows — under which EVERY
      // default-path call would otherwise refuse while asserting a specific cause. `chief_gone` is
      // knowable; `chief_degraded` is not, so it says so rather than guessing.
      return catalog.length === 0
        ? {
            ok: false,
            reason: "ambiguous",
            message:
              `Refused: the Chief project catalog came back EMPTY, so this Sparkle project's ` +
              `default (${caller.primary}) cannot be confirmed. That usually means Chief is ` +
              `degraded or the token has lost visibility — not that the binding is wrong. Nothing ` +
              `was called; retry, and if it persists ask the human to check the Chief connection.`,
          }
        : {
            ok: false,
            reason: "unknown_project",
            message:
              `Refused: the default Chief project for this Sparkle project (${caller.primary}) is ` +
              `not in the catalog this token can see — it was deleted upstream, or the token no ` +
              `longer reaches it. Ask the human to re-bind. No Chief call was made.`,
          };
    }
    return {
      ok: true,
      projectId: primaryRow.project_id,
      projectName: primaryRow.name,
      source: "primary",
    };
  }

  if (caller.kind === "concierge") {
    return {
      ok: false,
      reason: "ambiguous",
      message:
        `No Chief project selected. Call \`chief_list_projects\` and ASK the human which project ` +
        `to use before reading or writing anything.`,
    };
  }

  const where = caller.sparkleProjectName ? ` ("${caller.sparkleProjectName}")` : "";
  return {
    ok: false,
    reason: caller.allowed !== "all" && caller.allowed.length === 0 ? "unbound" : "ambiguous",
    message:
      `Refused: no Chief project was named and this agent's Sparkle project${where} has no default ` +
      `Chief binding. Name a project explicitly, or ask the human to bind one.`,
  };
}
